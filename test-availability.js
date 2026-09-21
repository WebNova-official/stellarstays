// Verifies findAvailable() against the real schema shapes, with Property,
// Booking and Stayflexi stubbed. Run: node test-availability.js
const Module = require('module');
const path = require('path');

const PROPS = [
    { _id: 'A', name: 'Villa A', status: 'Active', guests: 8, location: 'Lonavala', blockedDates: [] },
    { _id: 'B', name: 'Villa B', status: 'Active', guests: 8, location: 'Lonavala', blockedDates: [] },
    { _id: 'C', name: 'Villa C', status: 'Active', guests: 8, location: 'Lonavala', blockedDates: [] },
    { _id: 'D', name: 'Villa D', status: 'Active', guests: 8, location: 'Lonavala', blockedDates: ['2026-09-21'] },
    { _id: 'E', name: 'Villa E', status: 'Active', guests: 4, location: 'Lonavala', blockedDates: [], stayflexi: '9001' },
];

// Villa B booked 19→21 (DD-MM-YYYY format, as booking.html writes it)
// Villa C booked 22→24 — starts on our checkout day, must NOT block
// Villa E sold out on SF for the 20th
const BOOKINGS = [
    { property: 'B', checkIn: '19-09-2026 14:00:00', checkOut: '21-09-2026 11:00:00', status: 'Confirmed' },
    { property: 'C', checkIn: '22-09-2026 14:00:00', checkOut: '24-09-2026 11:00:00', status: 'Confirmed' },
    { property: 'A', checkIn: '20-09-2026 14:00:00', checkOut: '22-09-2026 11:00:00', status: 'Cancelled' },
];

let sfShouldFail = false;
const SF_SOLD_OUT = { '9001': ['20-09-2026'] };

function chain(result) {
    const o = { select: () => o, lean: () => Promise.resolve(result), then: (r) => Promise.resolve(result).then(r) };
    return o;
}

const stubs = {
    '../models/Property': {
        find: (filter) => chain(PROPS.filter(p =>
            (!filter.status || p.status === filter.status) &&
            (!filter.guests || p.guests >= filter.guests.$gte)
        )),
        findById: (id) => chain(PROPS.find(p => p._id === id) || null),
    },
    '../models/Booking': {
        find: (filter) => chain(BOOKINGS.filter(b =>
            filter.property && filter.property.$in
                ? filter.property.$in.includes(b.property)
                : b.property === filter.property
        )),
    },
    './stayflexiService': {
        getHotelCalendar: async (from, to, hotelId) => {
            if (sfShouldFail) throw new Error('SF 401');
            return {
                aggregate: {
                    availableRoomCount: (SF_SOLD_OUT[hotelId] || []).map(d => ({ date: d, count: 0 }))
                }
            };
        },
    },
};

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (stubs[request] && parent && parent.filename.includes('availabilityService')) {
        return stubs[request];
    }
    return origLoad.apply(this, arguments);
};

const svc = require('./backend/services/availabilityService');
const { parseYMD, nightsBetween, rangesOverlap, startOfDay } = require('./backend/utils/dates');

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${a}\n        want ${e}`}`);
}

(async () => {
    // Scenario from the brief: 5 villas, 20 Sep → 22 Sep
    let r = await svc.findAvailable(parseYMD('2026-09-20'), parseYMD('2026-09-22'), 0);
    check('20→22: B booked, D admin-blocked, E sold out on SF',
        r.available.map(p => p._id).sort(), ['A', 'C']);

    // Checkout-day adjacency: C is booked 22→24, must not block a 20→22 stay
    check('checkout day stays bookable (C free for 20→22)',
        r.available.some(p => p._id === 'C'), true);

    // A's only booking is Cancelled — must not hold inventory
    check('cancelled booking releases inventory (A free)',
        r.available.some(p => p._id === 'A'), true);

    // B's booking ends 21st, so a 21→23 stay should be fine
    r = await svc.findAvailable(parseYMD('2026-09-21'), parseYMD('2026-09-23'), 0);
    check('21→23: B frees up, C blocked from 22nd, D blocked on 21st, E SF-free after 20th',
        r.available.map(p => p._id).sort(), ['A', 'B', 'E']);

    // Guest filter: E holds 4, so guests=6 drops it before any SF call
    r = await svc.findAvailable(parseYMD('2026-10-01'), parseYMD('2026-10-03'), 6);
    check('guests=6 excludes the 4-guest villa',
        r.available.map(p => p._id).sort(), ['A', 'B', 'C', 'D']);

    // Admin block only bites on the blocked night
    r = await svc.findAvailable(parseYMD('2026-09-25'), parseYMD('2026-09-27'), 0);
    check('D free once past its blocked date',
        r.available.some(p => p._id === 'D'), true);

    // Stayflexi down entirely -> throw, so the route can 503
    sfShouldFail = true;
    let threw = null;
    try {
        await svc.findAvailable(parseYMD('2026-11-01'), parseYMD('2026-11-03'), 0);
    } catch (e) { threw = e.code; }
    check('SF fully down throws SF_UNAVAILABLE (route 503s, not empty list)',
        threw, 'SF_UNAVAILABLE');
    sfShouldFail = false;

    // Pending bookings still hold the room
    BOOKINGS.push({ property: 'A', checkIn: '2026-12-01', checkOut: '2026-12-03', status: 'Pending' });
    r = await svc.findAvailable(parseYMD('2026-12-01'), parseYMD('2026-12-02'), 0);
    check('pending (unpaid) booking still blocks',
        r.available.some(p => p._id === 'A'), false);

    // Mixed stored formats compare correctly (the DD-MM-YYYY lexicographic trap)
    BOOKINGS.push({ property: 'B', checkIn: '2026-09-28', checkOut: '2026-10-02', status: 'Confirmed' });
    r = await svc.findAvailable(parseYMD('2026-10-01'), parseYMD('2026-10-03'), 0);
    check('ISO-format booking spanning a month boundary blocks correctly',
        r.available.some(p => p._id === 'B'), false);

    // Single-property re-check
    check('single check: B booked for 20→22',
        (await svc.isPropertyAvailable('B', parseYMD('2026-09-20'), parseYMD('2026-09-22'))).available, false);
    check('single check: A free for 20→22',
        (await svc.isPropertyAvailable('A', parseYMD('2026-09-20'), parseYMD('2026-09-22'))).available, true);

    // Night maths
    check('nightsBetween(20,22) = the 20th and 21st',
        nightsBetween(parseYMD('2026-09-20'), parseYMD('2026-09-22')), ['2026-09-20', '2026-09-21']);

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
