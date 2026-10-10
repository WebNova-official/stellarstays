// services/rateSyncService.js
// Pulls live rates from Stayflexi (lowest bookable night in the next RATE_SYNC_WINDOW_DAYS,
// plus lowest Fri/Sat night) for every property that has
// a Stayflexi Hotel ID linked, and writes them into MongoDB (Property.pricePerNight
// / Property.weekendRate). This is what keeps index.html's displayed prices from
// going stale — index.html only ever reads Property.pricePerNight from the DB,
// it never calls Stayflexi directly, so without this job rates only update when
// someone manually edits a property in admin.html.

const Property = require("../models/Property");
const sf = require("./stayflexiService");
const { nowIST } = require("../utils/dates");

function pad(n) { return String(n).padStart(2, "0"); }
function ymdLocal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function fmt(d, time) {
    return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear() + " " + time;
}
// Same extraction logic as admin.html's checkAllRates(), kept in one place now.
function extractRate(avail) {
    if (!avail) return 0;
    if (avail.rate) return avail.rate;
    if (avail.actualRate) return avail.actualRate;
    if (!avail.roomTypeMap) return 0;
    for (const rtId in avail.roomTypeMap) {
        const room = avail.roomTypeMap[rtId];
        const combo = room && room.combos && room.combos[0];
        const price = combo && combo.rates && combo.rates[0] && combo.rates[0].price;
        if (price) return price;
    }
    return 0;
}

// How many upcoming nights are scanned to find the lowest bookable rate.
// Configurable via RATE_SYNC_WINDOW_DAYS (default 30, clamped to 1-90).
const SCAN_DAYS = Math.min(90, Math.max(1, Number(process.env.RATE_SYNC_WINDOW_DAYS) || 30));
// Parallel StayFlexi calls per hotel. Kept small to stay under SF rate limits.
const SCAN_CONCURRENCY = 4;

function isWeekendNight(date) {
    const dow = date.getDay();
    return dow === 5 || dow === 6; // Fri & Sat — same rule as booking.js / availabilityService
}

// Runs fn over items with at most `limit` in flight, preserving order.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

// Scans the next SCAN_DAYS single nights and returns:
//   weekday = lowest bookable rate across ALL scanned nights  -> "Starting from"
//             (stored in Property.pricePerNight)
//   weekend = lowest bookable rate across Fri/Sat nights      -> Property.weekendRate
// A night StayFlexi returns no sellable rate for (sold out, stop-sell, closed)
// is skipped rather than counted as 0, so it can never drag the price down.
// Nothing is hardcoded or adjusted: every number comes from StayFlexi's own
// per-night response, the same call booking.js uses at checkout.
async function fetchRatesForHotel(hotelId) {
    const today = nowIST();
    today.setHours(0, 0, 0, 0);

    const nights = [];
    for (let i = 0; i < SCAN_DAYS; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        nights.push(d);
    }

    const probes = await mapLimit(nights, SCAN_CONCURRENCY, async (night) => {
        const out = new Date(night); out.setDate(out.getDate() + 1);
        try {
            const resp = await sf.getHotelDetailAdvanced(
                fmt(night, "14:00:00"), fmt(out, "12:00:00"), 0, hotelId
            );
            return { night, rate: extractRate(resp), error: null };
        } catch (e) {
            return { night, rate: 0, error: e.message };
        }
    });

    const result = {
        weekday: 0, weekend: 0,
        weekdayError: null, weekendError: null,
        weekdayNight: null, weekendNight: null,
        nightsScanned: probes.length,
        nightsPriced: 0,
    };

    probes.forEach(({ night, rate }) => {
        if (!rate) return;
        result.nightsPriced++;
        if (!result.weekday || rate < result.weekday) {
            result.weekday = rate;
            result.weekdayNight = night;
        }
        if (isWeekendNight(night) && (!result.weekend || rate < result.weekend)) {
            result.weekend = rate;
            result.weekendNight = night;
        }
    });

    const firstError = (probes.find(p => p.error) || {}).error || null;
    if (!result.weekday) result.weekdayError = firstError || `No sellable rate in the next ${SCAN_DAYS} nights.`;
    if (!result.weekend) result.weekendError = firstError || `No sellable Fri/Sat rate in the next ${SCAN_DAYS} nights.`;

    return result;
}

// Syncs every property that has a Stayflexi Hotel ID linked.
// Only overwrites pricePerNight/weekendRate when Stayflexi actually returned a
// usable rate — a failed/empty response never wipes out a good manually-set price.
async function syncAllRates() {
    const properties = await Property.find({ stayflexi: { $exists: true, $ne: "" } });
    const summary = { checked: properties.length, updated: 0, skipped: 0, results: [] };

    for (const property of properties) {
        const hotelId = property.stayflexi.trim();
        if (!hotelId) { summary.skipped++; continue; }

        const rates = await fetchRatesForHotel(hotelId);
        const row = {
            name: property.name,
            hotelId,
            oldPrice: property.pricePerNight,
            oldWeekendRate: property.weekendRate,
            newPrice: rates.weekday || null,
            newWeekendRate: rates.weekend || null,
            lowestNight: rates.weekdayNight ? ymdLocal(rates.weekdayNight) : null,
            lowestWeekendNight: rates.weekendNight ? ymdLocal(rates.weekendNight) : null,
            nightsScanned: rates.nightsScanned,
            nightsPriced: rates.nightsPriced,
            weekdayError: rates.weekdayError,
            weekendError: rates.weekendError,
            updated: false,
        };

        const updates = {};
        if (rates.weekday) updates.pricePerNight = Math.round(rates.weekday);
        if (rates.weekend) updates.weekendRate = Math.round(rates.weekend);

        if (Object.keys(updates).length) {
            await Property.findByIdAndUpdate(property._id, updates);
            row.updated = true;
            summary.updated++;
        } else {
            summary.skipped++;
        }

        summary.results.push(row);
    }

    return summary;
}

// ── Background scheduler ──
// Simple setInterval loop — no extra npm dependency needed for a job this
// straightforward. Runs once shortly after boot, then on a fixed interval.
let schedulerHandle = null;

function startRateSyncScheduler({ intervalMs = 6 * 60 * 60 * 1000, runOnBoot = true } = {}) {
    if (schedulerHandle) return schedulerHandle; // already running

    const run = async () => {
        try {
            console.log("[RateSync] Starting scheduled Stayflexi rate sync…");
            const summary = await syncAllRates();
            console.log(
                `[RateSync] Done. Checked ${summary.checked}, updated ${summary.updated}, skipped ${summary.skipped}.`
            );
        } catch (err) {
            console.error("[RateSync] Scheduled sync failed:", err.message);
        }
    };

    if (runOnBoot) {
        // Slight delay so this doesn't race the initial MongoDB connection.
        setTimeout(run, 10_000);
    }
    schedulerHandle = setInterval(run, intervalMs);
    return schedulerHandle;
}

module.exports = { syncAllRates, startRateSyncScheduler };
