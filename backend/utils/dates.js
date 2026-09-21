// backend/utils/dates.js
// Shared date handling for availability + booking conflict checks.
//
// Booking.checkIn / Booking.checkOut are schema type String, and two formats
// are already in the collection:
//   "DD-MM-YYYY HH:MM:SS"  — written by booking.html via fmtSfDate(), to match
//                            what the Stayflexi API expects
//   "YYYY-MM-DD..."        — ISO-style, from other integrations
//
// Mongo's $lt/$gt on a String field is lexicographic, which is only
// chronologically correct for a fixed-width year-first format. "01-10-2026"
// sorts before "25-09-2026" as a string even though October is after
// September. So every comparison must go through parseBookingDate() first.
// This logic already exists inline in routes/bookingRoutes.js — it lives here
// now so the booking conflict check and the availability check can never drift
// apart. Two different overlap implementations is how a villa ends up visible
// in search but rejected at checkout.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseBookingDate(str) {
    if (!str) return null;
    str = String(str).trim();

    // ISO-ish: "YYYY-MM-DD" / "YYYY-MM-DDTHH:MM:SS" / "YYYY-MM-DD HH:MM:SS"
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
        return new Date(
            +iso[1], +iso[2] - 1, +iso[3],
            +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)
        );
    }

    // Day-first: "DD-MM-YYYY" / "DD-MM-YYYY HH:MM:SS" (also tolerate "/")
    const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmy) {
        return new Date(
            +dmy[3], +dmy[2] - 1, +dmy[1],
            +(dmy[4] || 0), +(dmy[5] || 0), +(dmy[6] || 0)
        );
    }

    const fallback = new Date(str);
    return isNaN(fallback.getTime()) ? null : fallback;
}

// Strict YYYY-MM-DD only — used for query params coming off index.html's
// flatpickr, which always emits that format. Anything else is a client bug
// and should 400 rather than be guessed at.
function parseYMD(value) {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
}

// Midnight local, so date-only comparisons aren't skewed by a time component
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Stayflexi wants DD-MM-YYYY
function toSfDate(date) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${d}-${m}-${date.getFullYear()}`;
}

// The nights actually occupied by [checkIn, checkOut).
// A 20 Sep → 22 Sep stay occupies the nights of the 20th and 21st. The 22nd is
// a checkout day and stays bookable — the guest leaves by 10 AM, the next
// checks in from 1 PM.
function nightsBetween(start, end) {
    const out = [];
    const cursor = startOfDay(start);
    const last = startOfDay(end);
    while (cursor < last) {
        out.push(toYMD(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return out;
}

function nightCount(start, end) {
    return Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS);
}

// The one overlap rule, used everywhere.
//   [aStart, aEnd) overlaps [bStart, bEnd)  iff  aStart < bEnd && aEnd > bStart
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
}

module.exports = {
    DAY_MS,
    parseBookingDate,
    parseYMD,
    startOfDay,
    toYMD,
    toSfDate,
    nightsBetween,
    nightCount,
    rangesOverlap,
};