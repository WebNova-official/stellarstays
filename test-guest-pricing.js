// Verifies the guest limits and extra-guest pricing (₹1,000 per extra guest PER NIGHT, above 8 guests).
//   1. utils/guestPricing.js — the rules themselves
//   2. POST /api/bookings — the REAL route, called over HTTP, with only the
//      database and the availability check stubbed
//   3. the real Booking schema keeps the new fields
// Run (after `npm install` in backend/):  node test-guest-pricing.js
const Module = require('module');
const path = require('path');

const VILLA_A = 'a'.repeat(24);   // max 12 guests
const VILLA_B = 'b'.repeat(24);   // max 16 guests
const VILLA_NOCAP = 'c'.repeat(24); // no usable `guests` value stored
const UNKNOWN = 'd'.repeat(24);

const PROPS = {
    [VILLA_A]:     { _id: VILLA_A, name: 'Villa A', guests: 12 },
    [VILLA_B]:     { _id: VILLA_B, name: 'Villa B', guests: 16 },
    [VILLA_NOCAP]: { _id: VILLA_NOCAP, name: 'No cap set' },
};

const saved = [];
function chain(result) {
    const o = { select: () => o, lean: () => Promise.resolve(result), then: (r) => Promise.resolve(result).then(r) };
    return o;
}
class StubBooking {
    constructor(doc) { Object.assign(this, doc); }
    async save() { this._id = 'bk' + (saved.length + 1); saved.push(this); }
}
const stubs = {
    '../models/Booking': StubBooking,
    '../models/Property': { findById: (id) => chain(PROPS[id] || null) },
    '../services/availabilityService': { isPropertyAvailable: async () => ({ available: true, reason: null }) },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
    if (stubs[request] && parent && parent.filename.includes('bookingRoutes')) return stubs[request];
    return origLoad.apply(this, arguments);
};

const gp = require('./backend/utils/guestPricing');
const express = require('./backend/node_modules/express');
const bookingRoutes = require('./backend/routes/bookingRoutes');
const { toYMD } = require('./backend/utils/dates');

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${a}\n        want ${e}`}`);
}

// ── 1. The rules ─────────────────────────────────────────────────────────────
const A = PROPS[VILLA_A], B = PROPS[VILLA_B];
const extra = (counts, villa, nights = 1) => { const r = gp.priceGuests(counts, villa, nights); return r.ok ? r.extraGuestAmount : 'REJECTED'; };

console.log('\n— Rules (utils/guestPricing.js) —');
check('policy: Villa A max 12, max extra ₹4,000 per night', [gp.guestPolicyFor(A).maxGuests, gp.guestPolicyFor(A).maxExtraPerNight], [12, 4000]);
check('policy: Villa B max 16, max extra ₹8,000 per night', [gp.guestPolicyFor(B).maxGuests, gp.guestPolicyFor(B).maxExtraPerNight], [16, 8000]);
check('1 guest: no extra',                 extra({ adults: 1 }, A), 0);
check('8 guests (base): no extra',         extra({ adults: 8 }, A), 0);
check('9 guests, 1 night: ₹1,000',         extra({ adults: 9 }, A), 1000);
check('9 guests, 3 nights: ₹3,000',        extra({ adults: 9 }, A, 3), 3000);
check('10 guests: ₹2,000',                 extra({ adults: 10 }, B), 2000);
check('Villa A, 12 guests (max), 1 night: ₹4,000',  extra({ adults: 12 }, A), 4000);
check('Villa A, 12 guests, 5 nights: ₹20,000',      extra({ adults: 12 }, A, 5), 20000);
check('Villa A, 13 guests: rejected',      extra({ adults: 13 }, A), 'REJECTED');
check('Villa B, 16 guests (max), 1 night: ₹8,000',  extra({ adults: 16 }, B), 8000);
check('Villa B, 16 guests, 5 nights: ₹40,000',      extra({ adults: 16 }, B, 5), 40000);
check('Villa B, 17 guests: rejected',      extra({ adults: 17 }, B), 'REJECTED');
check('adults+children both count (6+7=13 on A: rejected)', extra({ adults: 6, children: 7 }, A), 'REJECTED');
check('adults+children both count (6+6=12 on A: ₹4,000)',   extra({ adults: 6, children: 6 }, A), 4000);
check('infants count too (8+1+3=12 on A: ₹4,000)',         extra({ adults: 8, children: 1, infants: 3 }, A), 4000);
check('0 adults: rejected',                extra({ adults: 0, children: 3 }, A), 'REJECTED');
check('2.5 adults: rejected',              extra({ adults: 2.5 }, A), 'REJECTED');
check('negative children: rejected',       extra({ adults: 2, children: -1 }, A), 'REJECTED');
check('non-numeric adults: rejected',      extra({ adults: 'abc' }, A), 'REJECTED');
check('numeric strings accepted ("12" on A: ₹4,000)', extra({ adults: '12' }, A), 4000);
check('missing max falls back to 8 (9 guests rejected)', extra({ adults: 9 }, PROPS[VILLA_NOCAP]), 'REJECTED');
check('missing max falls back to 8 (8 guests fine)',     extra({ adults: 8 }, PROPS[VILLA_NOCAP]), 0);

// ── 2. The real booking route ────────────────────────────────────────────────
function inDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return toYMD(d); }

async function post(base, over) {
    const body = {
        property: VILLA_A, propertyName: 'Villa', guestName: 'Test Guest',
        guestEmail: 't@example.com', guestPhone: '9876543210',
        checkIn: inDays(10), checkOut: inDays(15),         // 5 nights
        adults: 2, children: 0, infants: 0,
        baseAmount: 50000, addonAmount: 0, taxAmount: 0,
        totalAmount: 50000, amount: 50000,
        status: 'Pending', paid: false,
        ...over,
    };
    const res = await fetch(base + '/api/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/bookings', bookingRoutes);
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    console.log('\n— POST /api/bookings (real route) —');
    let r, n;

    r = await post(base, { adults: 12 });
    check('Villa A, 12 guests, 5 nights → 4 extra × ₹1,000 × 5 nights = ₹20,000',
        [r.status, r.json.booking && r.json.booking.extraGuestAmount], [201, 20000]);
    check('   …total = 50,000 + 20,000',
        [r.json.booking.totalAmount, r.json.booking.amount, r.json.booking.nights], [70000, 70000, 5]);

    r = await post(base, { adults: 12, checkOut: inDays(11) });   // 1 night
    check('Villa A, 12 guests, 1 night → ₹4,000',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.nights], [201, 4000, 1]);

    r = await post(base, { adults: 12, checkOut: inDays(40) });   // 30 nights
    check('Villa A, 12 guests, 30 nights → ₹120,000 (scales with nights)',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.nights], [201, 120000, 30]);

    r = await post(base, { adults: 12, nights: 1 });              // client lies about nights
    check('client claims nights:1 for a 5-night stay → server uses its own 5 nights',
        [r.json.booking.nights, r.json.booking.extraGuestAmount], [5, 20000]);

    r = await post(base, { adults: 8 });
    check('8 guests → no extra, total unchanged',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.totalAmount], [201, 0, 50000]);

    r = await post(base, { adults: 9 });
    check('9 guests, 5 nights → ₹1,000 × 5 = ₹5,000, total 55,000',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.totalAmount], [201, 5000, 55000]);

    r = await post(base, { property: VILLA_B, adults: 16 });
    check('Villa B, 16 guests (max), 5 nights → ₹8,000 × 5 = ₹40,000, total 90,000',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.totalAmount], [201, 40000, 90000]);

    n = saved.length;
    r = await post(base, { adults: 13 });
    check('Villa A, 13 guests → rejected 400, nothing saved',
        [r.status, r.json.success, saved.length === n], [400, false, true]);
    console.log('        message:', r.json.message);

    n = saved.length;
    r = await post(base, { property: VILLA_B, adults: 17 });
    check('Villa B, 17 guests → rejected 400, nothing saved',
        [r.status, r.json.success, saved.length === n], [400, false, true]);

    n = saved.length;
    r = await post(base, { adults: 8, children: 5 });
    check('Villa A, 8 adults + 5 children (13) → rejected',
        [r.status, saved.length === n], [400, true]);

    r = await post(base, { adults: 6, children: 6 });
    check('Villa A, 6 adults + 6 children (12), 5 nights → ₹20,000',
        [r.status, r.json.booking.extraGuestAmount], [201, 20000]);

    // A client that lies must not get a discount
    r = await post(base, { adults: 12, extraGuestAmount: 0, extraGuests: 0, totalAmount: 1, amount: 1 });
    check('client sends extraGuestAmount:0, totalAmount:1 → server still charges 70,000',
        [r.status, r.json.booking.extraGuestAmount, r.json.booking.totalAmount], [201, 20000, 70000]);

    r = await post(base, { adults: 12, extraGuestAmount: 999999, totalAmount: 999999 });
    check('client inflates extra → server uses its own ₹20,000',
        [r.json.booking.extraGuestAmount, r.json.booking.totalAmount], [20000, 70000]);

    // Add-ons / tax still add up, with the extra on top
    r = await post(base, { adults: 10, addonAmount: 9000, taxAmount: 1620 });
    check('extra guests stack with add-ons and tax (50,000+9,000+1,620+10,000)',
        r.json.booking.totalAmount, 70620);

    n = saved.length;
    r = await post(base, { adults: 0 });
    check('0 adults → rejected', [r.status, saved.length === n], [400, true]);
    r = await post(base, { adults: 'lots' });
    check('non-numeric guests → rejected', r.status, 400);
    r = await post(base, { property: UNKNOWN });
    check('unknown property → 404', r.status, 404);
    r = await post(base, { property: 'not-an-id' });
    check('malformed property id → 404 (not a 500)', r.status, 404);

    // Date rules still work in front of the new logic
    r = await post(base, { checkIn: inDays(15), checkOut: inDays(10) });
    check('check-out before check-in still rejected', r.status, 400);

    server.close();

    // ── 3. The real schema keeps the new fields ──
    console.log('\n— Booking schema —');
    Module._load = origLoad;
    const Booking = require('./backend/models/Booking');
    const doc = new Booking({
        guestName: 'x', guestEmail: 'x@x.com', guestPhone: '1', checkIn: '2026-11-01', checkOut: '2026-11-03',
        nights: 2, extraGuests: 4, extraGuestAmount: 4000, totalAmount: 54000,
    });
    check('schema validates', doc.validateSync() === undefined, true);
    check('extraGuests / extraGuestAmount persist on the document',
        [doc.toObject().extraGuests, doc.toObject().extraGuestAmount], [4, 4000]);

    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
