// services/rateSyncService.js
// Pulls live weekday/weekend rates from Stayflexi for every property that has
// a Stayflexi Hotel ID linked, and writes them into MongoDB (Property.pricePerNight
// / Property.weekendRate). This is what keeps index.html's displayed prices from
// going stale — index.html only ever reads Property.pricePerNight from the DB,
// it never calls Stayflexi directly, so without this job rates only update when
// someone manually edits a property in admin.html.

const Property = require("../models/Property");
const sf = require("./stayflexiService");

function pad(n) { return String(n).padStart(2, "0"); }
function fmt(d, time) {
    return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear() + " " + time;
}
function nextDow(fromDate, targetDow) {
    const d = new Date(fromDate);
    const diff = (targetDow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
    return d;
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

async function fetchRatesForHotel(hotelId) {
    const today = new Date();
    const weekdayIn = nextDow(today, 2); // next Tuesday
    const weekdayOut = new Date(weekdayIn); weekdayOut.setDate(weekdayOut.getDate() + 1);
    const weekendIn = nextDow(today, 6); // next Saturday
    const weekendOut = new Date(weekendIn); weekendOut.setDate(weekendOut.getDate() + 1);

    const result = { weekday: 0, weekend: 0, weekdayError: null, weekendError: null };

    try {
        const wd = await sf.getHotelDetailAdvanced(
            fmt(weekdayIn, "14:00:00"), fmt(weekdayOut, "12:00:00"), 0, hotelId
        );
        result.weekday = extractRate(wd);
        if (!result.weekday) result.weekdayError = "No sellable rate returned.";
    } catch (e) {
        result.weekdayError = e.message;
    }

    try {
        const we = await sf.getHotelDetailAdvanced(
            fmt(weekendIn, "14:00:00"), fmt(weekendOut, "12:00:00"), 0, hotelId
        );
        result.weekend = extractRate(we);
        if (!result.weekend) result.weekendError = "No sellable rate returned.";
    } catch (e) {
        result.weekendError = e.message;
    }

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
