// backend/services/availabilityService.js
//
// The single source of truth for "is this villa free on these nights?".
// Three things can make a villa unavailable, and all three are checked:
//
//   1. A booking in our own DB that overlaps the requested nights
//   2. Admin-blocked dates on the property (Property.blockedDates, YYYY-MM-DD)
//   3. Stayflexi's live calendar, for properties with a `stayflexi` hotel id —
//      this is what catches bookings made through OTAs, which never touch our DB
//
// FAILURE POLICY
// A villa is only returned when it has been positively confirmed free. If a
// check can't be completed, the villa is left out — never included by default.
// If Stayflexi fails for EVERY linked property (i.e. SF itself is down, not
// one bad property), the whole request throws so the caller can return 503 and
// the site shows "couldn't check availability" instead of a misleading empty
// grid. That distinction matters: "nothing free" and "we don't know" look the
// same to a guest but mean very different things.

const Property = require('../models/Property');
const Booking  = require('../models/Booking');
const sf       = require('./stayflexiService');

const {
    parseBookingDate,
    startOfDay,
    toSfDate,
    nightsBetween,
    rangesOverlap,
} = require('../utils/dates');

// Statuses that do NOT hold inventory. Everything else blocks the dates,
// including "Pending" — an unpaid booking still holds the room, and treating
// pending as free is how two people end up paying for the same night.
const RELEASED_STATUSES = new Set(['cancelled', 'failed', 'expired', 'refunded']);

function holdsInventory(booking) {
    return !RELEASED_STATUSES.has(String(booking.status || '').toLowerCase());
}

// ── Stayflexi calendar cache ────────────────────────────────────────────────
// The homepage can fire an availability check on every date change, and the
// calendar for a given hotel + window doesn't move second to second. Without
// this, a guest flicking through dates would hammer SF and hit their rate limit.
const SF_CACHE_TTL_MS = Number(process.env.SF_CACHE_TTL_MS) || 60 * 1000;
const sfCache = new Map(); // key -> { expires, value }

function sfCacheGet(key) {
    const hit = sfCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) { sfCache.delete(key); return null; }
    return hit.value;
}

function sfCacheSet(key, value) {
    sfCache.set(key, { expires: Date.now() + SF_CACHE_TTL_MS, value });
    // Cheap bound — this map should never grow past a handful of hotels
    if (sfCache.size > 200) {
        for (const k of sfCache.keys()) { sfCache.delete(k); break; }
    }
}

// Returns a Set of YYYY-MM-DD strings that Stayflexi reports as sold out.
async function sfSoldOutNights(hotelId, start, end) {
    const key = `${hotelId}|${toSfDate(start)}|${toSfDate(end)}`;
    const cached = sfCacheGet(key);
    if (cached) return cached;

    const calendar = await sf.getHotelCalendar(toSfDate(start), toSfDate(end), hotelId);
    const counts = (calendar && calendar.aggregate && calendar.aggregate.availableRoomCount) || [];

    const soldOut = new Set();
    counts.forEach(entry => {
        if (!entry || Number(entry.count) > 0) return;
        // SF returns DD-MM-YYYY; normalise to YYYY-MM-DD for comparison
        const d = parseBookingDate(entry.date);
        if (!d) return;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        soldOut.add(`${y}-${m}-${dd}`);
    });

    sfCacheSet(key, soldOut);
    return soldOut;
}

/**
 * @param {Date}   start     check-in  (local midnight)
 * @param {Date}   end       check-out (local midnight)
 * @param {number} minGuests 0 to skip the guest filter
 * @returns {Promise<{available: Array, checked: number, sfDown: boolean}>}
 * @throws  if availability genuinely could not be determined
 */
async function findAvailable(start, end, minGuests = 0) {
    const from = startOfDay(start);
    const to   = startOfDay(end);

    const propertyFilter = { status: 'Active' };
    if (minGuests > 0) propertyFilter.guests = { $gte: minGuests };

    const properties = await Property.find(propertyFilter).lean();
    if (properties.length === 0) return { available: [], checked: 0, sfDown: false };

    const requestedNights = nightsBetween(from, to);

    // ── 1. Our own bookings ──
    // Fetched per property rather than range-queried in Mongo, because the
    // stored dates are strings in two formats and only parseBookingDate() can
    // compare them correctly. Scoped to the candidate properties so this stays
    // a small read.
    const propertyIds = properties.map(p => p._id);
    const bookings = await Booking.find({ property: { $in: propertyIds } })
        .select('property checkIn checkOut status')
        .lean();

    const bookedIds = new Set();
    bookings.forEach(b => {
        if (!holdsInventory(b)) return;
        const bIn  = parseBookingDate(b.checkIn);
        const bOut = parseBookingDate(b.checkOut);
        if (!bIn || !bOut) {
            // An unparseable stored date means we cannot prove this villa is
            // free. Block it and log loudly rather than assume.
            console.warn('[availability] unparseable booking dates, blocking property',
                String(b.property), b.checkIn, b.checkOut);
            bookedIds.add(String(b.property));
            return;
        }
        if (rangesOverlap(from, to, startOfDay(bIn), startOfDay(bOut))) {
            bookedIds.add(String(b.property));
        }
    });

    // ── 2. Admin-blocked dates on the property ──
    const adminBlocked = new Set();
    properties.forEach(p => {
        const blocked = Array.isArray(p.blockedDates) ? p.blockedDates : [];
        if (blocked.length === 0) return;
        const blockedSet = new Set(blocked.map(s => String(s).slice(0, 10)));
        if (requestedNights.some(n => blockedSet.has(n))) {
            adminBlocked.add(String(p._id));
        }
    });

    // ── 3. Stayflexi live calendar, per linked hotel ──
    const sfLinked = properties.filter(p => p.stayflexi);
    const sfBlocked = new Set();
    let sfFailures = 0;

    if (sfLinked.length > 0) {
        const hotelIds = [...new Set(sfLinked.map(p => String(p.stayflexi)))];
        const results = await Promise.allSettled(
            hotelIds.map(async id => ({ id, soldOut: await sfSoldOutNights(id, from, to) }))
        );

        const soldOutByHotel = new Map();
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                soldOutByHotel.set(r.value.id, r.value.soldOut);
            } else {
                sfFailures++;
                console.warn('[availability] Stayflexi calendar failed for hotel',
                    hotelIds[i], r.reason && r.reason.message);
            }
        });

        sfLinked.forEach(p => {
            const soldOut = soldOutByHotel.get(String(p.stayflexi));
            if (!soldOut) {
                // Couldn't reach SF for this hotel — cannot confirm, so exclude.
                sfBlocked.add(String(p._id));
                return;
            }
            if (requestedNights.some(n => soldOut.has(n))) {
                sfBlocked.add(String(p._id));
            }
        });

        // SF is down as a whole, not just one bad hotel. Don't quietly return a
        // short list — let the caller 503 so the UI says "couldn't check".
        if (sfFailures === hotelIds.length && hotelIds.length > 0) {
            const err = new Error('Stayflexi availability is unreachable');
            err.code = 'SF_UNAVAILABLE';
            throw err;
        }
    }

    const available = properties.filter(p => {
        const id = String(p._id);
        return !bookedIds.has(id) && !adminBlocked.has(id) && !sfBlocked.has(id);
    });

    return { available, checked: properties.length, sfDown: sfFailures > 0 };
}

/**
 * Single-property check, for re-validating right before payment.
 * @returns {Promise<{available: boolean, reason: string|null}>}
 */
async function isPropertyAvailable(propertyId, start, end) {
    const from = startOfDay(start);
    const to   = startOfDay(end);

    const property = await Property.findById(propertyId).lean();
    if (!property) return { available: false, reason: 'not_found' };
    if (property.status && property.status !== 'Active') {
        return { available: false, reason: 'inactive' };
    }

    const requestedNights = nightsBetween(from, to);

    const bookings = await Booking.find({ property: propertyId })
        .select('checkIn checkOut status')
        .lean();

    for (const b of bookings) {
        if (!holdsInventory(b)) continue;
        const bIn  = parseBookingDate(b.checkIn);
        const bOut = parseBookingDate(b.checkOut);
        if (!bIn || !bOut) return { available: false, reason: 'booked' };
        if (rangesOverlap(from, to, startOfDay(bIn), startOfDay(bOut))) {
            return { available: false, reason: 'booked' };
        }
    }

    const blocked = new Set((property.blockedDates || []).map(s => String(s).slice(0, 10)));
    if (requestedNights.some(n => blocked.has(n))) {
        return { available: false, reason: 'blocked' };
    }

    if (property.stayflexi) {
        // Any SF error here throws — the caller returns 503. Never assume free.
        const soldOut = await sfSoldOutNights(String(property.stayflexi), from, to);
        if (requestedNights.some(n => soldOut.has(n))) {
            return { available: false, reason: 'booked' };
        }
    }

    return { available: true, reason: null };
}

module.exports = { findAvailable, isPropertyAvailable, holdsInventory };
