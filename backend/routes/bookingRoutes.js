const express  = require("express");
const router   = express.Router();
const Booking  = require("../models/Booking");

const availability = require("../services/availabilityService");
const { parseBookingDate, startOfDay, nightCount, todayIST } = require("../utils/dates");

// Serialises "check availability -> save" per property inside this process, so
// two guests submitting the same dates at the same moment can't both pass the
// check before either has saved. (Single Node instance only — if you ever run
// several instances, replace with a unique index / transaction.)
const propertyLocks = new Map();
async function withPropertyLock(key, fn) {
    const prev = propertyLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(r => { release = r; });
    const tail = prev.then(() => gate);
    propertyLocks.set(key, tail);
    await prev;
    try { return await fn(); }
    finally {
        release();
        if (propertyLocks.get(key) === tail) propertyLocks.delete(key);
    }
}

// ── POST /api/bookings — create a new booking ──
router.post("/", async (req, res) => {
    try {
        const body = { ...req.body };

        // map propertyId → property (ObjectId ref field in schema)
        if (body.propertyId && !body.property) {
            body.property = body.propertyId;
        }
        delete body.propertyId;

        // normalise amount fields
        if (!body.totalAmount && body.amount) body.totalAmount = body.amount;
        if (!body.amount && body.totalAmount)  body.amount = body.totalAmount;
        if (!body.taxAmount  && body.gst)      body.taxAmount = body.gst;
        if (!body.addonAmount && body.addonsTotal) body.addonAmount = body.addonsTotal;
        if (!body.baseAmount) body.baseAmount = (body.pricePerNight || 0) * (body.nights || 0);

        // ── DATE VALIDATION + CONFLICT CHECK ──
        // Uses the SAME availability logic as the public search and the admin
        // calendar (availabilityService), compared by calendar DAY. The old
        // inline check compared full timestamps, so a guest checking in on the
        // morning another guest checks out ("22-09 00:00" vs "22-09 10:00")
        // was rejected here even though search showed the villa as free.
        const inDate  = parseBookingDate(body.checkIn);
        const outDate = parseBookingDate(body.checkOut);
        if (!inDate || !outDate) {
            return res.status(400).json({ success: false, message: "checkIn/checkOut must be valid dates." });
        }
        const from = startOfDay(inDate);
        const to   = startOfDay(outDate);
        if (to <= from) {
            return res.status(400).json({ success: false, message: "Check-out must be after check-in." });
        }
        if (from < todayIST()) {
            return res.status(400).json({ success: false, message: "Check-in cannot be in the past." });
        }
        if (!body.property) {
            return res.status(400).json({ success: false, message: "property is required." });
        }
        body.nights = nightCount(from, to);   // never trust the client's night count

        const saved = await withPropertyLock(String(body.property), async () => {
            const result = await availability.isPropertyAvailable(body.property, from, to, {
                // The client creates the Stayflexi enquiry BEFORE saving here, and that
                // enquiry holds the room on SF's calendar — asking SF again would flag
                // our own hold as sold out. SF was already checked before the enquiry.
                skipStayflexi: !!body.stayflexiBookingId,
            });
            if (!result.available) {
                const msg = {
                    booked:    "Sorry, these dates were just booked. Please pick different dates.",
                    blocked:   "Sorry, these dates are not available. Please pick different dates.",
                    inactive:  "This property is not currently bookable.",
                    not_found: "Property not found.",
                }[result.reason] || "These dates are no longer available.";
                return { conflict: true, status: result.reason === "not_found" ? 404 : 409, message: msg };
            }
            const booking = new Booking(body);
            await booking.save();
            return { booking };
        });

        if (saved.conflict) {
            return res.status(saved.status).json({ success: false, message: saved.message });
        }
        const booking = saved.booking;
        // ── END CONFLICT CHECK ──

        res.status(201).json({
            success:   true,
            booking,
            bookingId: booking._id,
        });
    } catch (err) {
        console.error("Booking save error:", err);
        res.status(400).json({ success: false, message: err.message });
    }
});

// ── GET /api/bookings — list all bookings (admin panel + booking.html's
// client-side "which nights are taken" check both read this) ──
// no-store: this is the exact list booking.html filters client-side to
// paint the customer calendar red. A cached copy here is how a guest can
// see a night as bookable that was just booked by someone else.
router.get("/", async (req, res) => {
    try {
        const bookings = await Booking.find().sort({ createdAt: -1 });
        res.set("Cache-Control", "no-store");
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /api/bookings/:id — single booking (confirmation page) ──
router.get("/:id", async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: "Not found" });
        res.set("Cache-Control", "no-store");
        res.json(booking);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /api/bookings/:id/status — admin approve/cancel ──
router.patch("/:id/status", async (req, res) => {
    try {
        const { status } = req.body;
        const booking = await Booking.findByIdAndUpdate(
            req.params.id, { status }, { new: true }
        );
        if (!booking) return res.status(404).json({ success: false, message: "Not found" });
        res.json({ success: true, booking });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PUT /api/bookings/:id — admin full update ──
router.put("/:id", async (req, res) => {
    try {
        const booking = await Booking.findByIdAndUpdate(
            req.params.id, req.body, { new: true }
        );
        if (!booking) return res.status(404).json({ success: false, message: "Not found" });
        res.json(booking);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── DELETE /api/bookings/:id — admin delete ──
router.delete("/:id", async (req, res) => {
    try {
        const booking = await Booking.findByIdAndDelete(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: "Not found" });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
