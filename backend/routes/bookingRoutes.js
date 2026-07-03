const express  = require("express");
const router   = express.Router();
const Booking  = require("../models/Booking");

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
        // Overlap: existing.checkIn < newCheckOut AND existing.checkOut > newCheckIn
        const clash = await Booking.findOne({
            property: body.property,
            status: { $nin: ["cancelled", "Cancelled"] },
            checkIn:  { $lt: body.checkOut },
            checkOut: { $gt: body.checkIn  }
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