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
    toYMD,
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
// forceRefresh=true skips the read (but still repopulates) the cache — used
// by the admin calendar's Refresh button, so "refresh" actually means "ask
// Stayflexi again" and not "re-render whatever we already had for up to 60s".
async function sfSoldOutNights(hotelId, start, end, forceRefresh = false) {
    const key = `${hotelId}|${toSfDate(start)}|${toSfDate(end)}`;
    if (!forceRefresh) {
        const cached = sfCacheGet(key);
        if (cached) return cached;
    }

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

    // NOTE: status is filtered in JS below, not in this Mongo query, on purpose.
    // {status:'Active'} as a raw filter only matches documents that literally
    // have that field stored. .lean() skips Mongoose entirely, so any property
    // that predates the `status` field (or was written without it) has no
    // `status` key in the DB at all and would silently disappear from every
    // dated search — while still showing fine on the plain, non-lean
    // `GET /api/properties` list, because Mongoose hydration backfills the
    // schema default there. index.html's own inventory filter already treats
    // a missing status as Active (`!p.status || p.status === 'Active'`); this
    // matches that so a villa can't fail to list here for a reason it wouldn't
    // fail to list on the homepage.
    const mongoFilter = {};
    if (minGuests > 0) mongoFilter.guests = { $gte: minGuests };

    const rawProperties = await Property.find(mongoFilter).lean();
    const properties = rawProperties.filter(p => !p.status || p.status === 'Active');
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

// ── Admin calendar ──────────────────────────────────────────────────────────
// Day-by-day view of one villa for the admin panel: what each night costs and
// who, if anyone, is in it.
//
// Reuses exactly the same three sources as findAvailable() (own bookings,
// Property.blockedDates, Stayflexi's calendar) so the admin calendar can never
// disagree with what the public site will sell. Where it differs is the
// failure policy: findAvailable() hides a villa it can't confirm, but an admin
// staring at a grid needs to know the difference between "free" and "we
// couldn't reach Stayflexi". Those days come back as status 'unknown' and the
// UI paints them differently rather than pretending they're bookable.
//
// Rates come from Property.pricePerNight / weekendRate (kept fresh by
// rateSyncService), with Fri + Sat nights priced at the weekend rate — the
// same rule js/booking.js applies at checkout, so the number shown here is the
// number the guest is charged.

function isWeekendNight(date) {
    const dow = date.getDay();      // 0=Sun … 6=Sat
    return dow === 5 || dow === 6;  // Friday & Saturday
}

// Only fields the admin panel actually needs. Deliberately explicit rather
// than spreading the booking — no reason to ship Razorpay ids to the browser.
function publicBooking(b) {
    return {
        id:           String(b._id),
        bookingRef:   b.bookingRef || null,
        guestName:    b.guestName || '',
        guestEmail:   b.guestEmail || '',
        guestPhone:   b.guestPhone || '',
        checkIn:      b.checkIn,
        checkOut:     b.checkOut,
        nights:       b.nights || 0,
        adults:       b.adults || 0,
        children:     b.children || 0,
        infants:      b.infants || 0,
        status:       b.status || '',
        paid:         !!b.paid,
        totalAmount:  b.totalAmount || b.amount || 0,
        addons:       Array.isArray(b.addons) ? b.addons : [],
        source:       b.source || 'website',
        createdAt:    b.createdAt || null,
    };
}

/**
 * @param {string} propertyId
 * @param {Date}   from  first day shown (inclusive)
 * @param {Date}   to    last day shown  (inclusive)
 * @returns {Promise<{property: object, days: Array, sfLinked: boolean, sfDown: boolean}>}
 */
async function getPropertyCalendar(propertyId, from, to, forceRefresh = false) {
    const start = startOfDay(from);
    const end   = startOfDay(to);

    const property = await Property.findById(propertyId).lean();
    if (!property) {
        const err = new Error('Property not found');
        err.code = 'NOT_FOUND';
        throw err;
    }

    const weekdayRate = Number(property.pricePerNight) || 0;
    const weekendRate = Number(property.weekendRate) || weekdayRate;

    // ── 1. Our own bookings, indexed by night ──
    // Every booking for this villa is read, not just ones inside the window:
    // the collection is small and a stay can straddle the window edge. The
    // stored dates are strings in two formats, so filtering has to happen in
    // JS via parseBookingDate() anyway (see utils/dates.js).
    const bookings = await Booking.find({ property: propertyId }).lean();

    const occupiedBy = new Map();   // 'YYYY-MM-DD' -> [booking]
    const checkoutOn = new Map();   // 'YYYY-MM-DD' -> [booking]
    const unparseable = [];

    bookings.forEach(b => {
        if (!holdsInventory(b)) return;
        const bIn  = parseBookingDate(b.checkIn);
        const bOut = parseBookingDate(b.checkOut);
        if (!bIn || !bOut) {
            console.warn('[calendar] unparseable booking dates for booking',
                String(b._id), b.checkIn, b.checkOut);
            unparseable.push(publicBooking(b));
            return;
        }
        const slim = publicBooking(b);
        nightsBetween(startOfDay(bIn), startOfDay(bOut)).forEach(night => {
            if (!occupiedBy.has(night)) occupiedBy.set(night, []);
            occupiedBy.get(night).push(slim);
        });
        const out = toYMD(startOfDay(bOut));
        if (!checkoutOn.has(out)) checkoutOn.set(out, []);
        checkoutOn.get(out).push(slim);
    });

    // ── 2. Admin-blocked dates ──
    const blocked = new Set((property.blockedDates || []).map(s => String(s).slice(0, 10)));

    // ── 3. Stayflexi, for linked properties ──
    // One call for the whole window. A failure here is reported, not fatal:
    // days we couldn't confirm become 'unknown' so the admin sees the gap.
    const sfLinked = !!property.stayflexi;
    let sfSoldOut = null;
    let sfError = null;

    if (sfLinked) {
        try {
            // +1 day so the last day of the window is itself covered
            const sfEnd = new Date(end);
            sfEnd.setDate(sfEnd.getDate() + 1);
            sfSoldOut = await sfSoldOutNights(String(property.stayflexi), start, sfEnd, forceRefresh);
        } catch (e) {
            sfError = e.message;
            console.warn('[calendar] Stayflexi calendar failed for hotel',
                property.stayflexi, e.message);
        }
    }

    // ── Build the grid ──
    const today = startOfDay(new Date());
    const days = [];
    const cursor = new Date(start);

    while (cursor <= end) {
        const ymd     = toYMD(cursor);
        const weekend = isWeekendNight(cursor);
        const mine    = occupiedBy.get(ymd) || [];
        const leaving = checkoutOn.get(ymd) || [];

        // Precedence matters. A night we've sold is 'booked' even if it's also
        // in blockedDates — the guest details are the more useful truth, and a
        // stale block shouldn't hide a real booking from the admin.
        let status;
        if (mine.length)                       status = 'booked';
        else if (blocked.has(ymd))             status = 'blocked';
        else if (sfLinked && !sfSoldOut)       status = 'unknown';   // SF unreachable
        else if (sfSoldOut && sfSoldOut.has(ymd)) status = 'channel'; // sold on an OTA
        else                                   status = 'available';

        days.push({
            date:      ymd,
            dow:       cursor.getDay(),
            weekend,
            past:      cursor < today,
            today:     ymd === toYMD(today),
            rate:      weekend ? weekendRate : weekdayRate,
            status,
            bookings:  mine,
            checkouts: leaving,
        });

        cursor.setDate(cursor.getDate() + 1);
    }

    return {
        property: {
            id:            String(property._id),
            name:          property.name,
            location:      property.location,
            status:        property.status || 'Active',
            pricePerNight: weekdayRate,
            weekendRate,
            minStay:       property.minStay || 1,
            stayflexi:     property.stayflexi || '',
        },
        days,
        sfLinked,
        sfDown: sfLinked && !sfSoldOut,
        sfError,
        // Surfaced so a booking with corrupt dates isn't silently invisible on
        // the grid — the UI warns instead of quietly dropping it.
        unparseableBookings: unparseable,
    };
}

module.exports = { findAvailable, isPropertyAvailable, holdsInventory, getPropertyCalendar };
