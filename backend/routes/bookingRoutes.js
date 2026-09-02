const express  = require("express");
const router   = express.Router();
const Booking  = require("../models/Booking");

// ── Date parsing helper ──
// checkIn/checkOut are stored as plain strings (schema type: String), and
// historically come in two different shapes depending on where they were
// written from:
//   "DD-MM-YYYY HH:MM:SS"  (from booking.html, built via fmtSfDate() to
//                           match Stayflexi's expected request format)
//   "YYYY-MM-DD..."        (ISO-style, e.g. from any other integration)
//
// Mongo's $lt/$gt on String fields does plain lexicographic comparison,
// which is only chronologically correct for a fixed-width YEAR-FIRST format.
// "DD-MM-YYYY" breaks the moment two dates fall in different months/years
// (e.g. "01-10-2026" sorts BEFORE "25-09-2026" as a string, even though
// Oct 1 is chronologically after Sep 25). That silently broke the overlap
// check below. Instead of changing the stored format (which other pages —
// confirmation.html, admin.html — and the Stayflexi API calls depend on),
// we parse whatever format is present into a real Date for comparison only.
function parseBookingDate(str) {
    if (!str) return null;
    str = String(str).trim();

    // ISO-ish: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DD HH:MM:SS"
    var isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoMatch) {
        return new Date(
            +isoMatch[1], +isoMatch[2] - 1, +isoMatch[3],
            +(isoMatch[4] || 0), +(isoMatch[5] || 0), +(isoMatch[6] || 0)
        );
    }

    // Day-first: "DD-MM-YYYY" or "DD-MM-YYYY HH:MM:SS" (also tolerate "/")
    var dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmyMatch) {
        return new Date(
            +dmyMatch[3], +dmyMatch[2] - 1, +dmyMatch[1],
            +(dmyMatch[4] || 0), +(dmyMatch[5] || 0), +(dmyMatch[6] || 0)
        );
    }

    // Last resort — let JS try, but this may be unreliable for ambiguous formats.
    var fallback = new Date(str);
    return isNaN(fallback.getTime()) ? null : fallback;
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

        // ── DATE CONFLICT CHECK ──
        // Overlap rule: existing.checkIn < newCheckOut AND existing.checkOut > newCheckIn.
        // Done in JS (not a Mongo date-range query) because the stored strings can be
        // in either date format described above — parseBookingDate() normalises both
        // to real Date objects before comparing, so the comparison is always
        // chronologically correct regardless of which format a given record used.
        const newCheckIn  = parseBookingDate(body.checkIn);
        const newCheckOut = parseBookingDate(body.checkOut);

        if (!newCheckIn || !newCheckOut) {
            return res.status(400).json({
                success: false,
                message: "checkIn/checkOut must be valid dates."
            });
        }

        const existingBookings = await Booking.find({
            property: body.property,
            status: { $nin: ["cancelled", "Cancelled"] }
        });

        const clash = existingBookings.find(function (b) {
            const bCheckIn  = parseBookingDate(b.checkIn);
            const bCheckOut = parseBookingDate(b.checkOut);
            if (!bCheckIn || !bCheckOut) return false;
            return bCheckIn < newCheckOut && bCheckOut > newCheckIn;
        });

        if (clash) {
            return res.status(409).json({
                success: false,
                message: `Property already booked from ${clash.checkIn} to ${clash.checkOut}. Please pick different dates.`
            });
        }
        // ── END CONFLICT CHECK ──

        const booking = new Booking(body);
        await booking.save();

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

// ── GET /api/bookings — list all bookings (admin) ──
router.get("/", async (req, res) => {
    try {
        const bookings = await Booking.find().sort({ createdAt: -1 });
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
