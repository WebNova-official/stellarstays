// routes/paymentRoutes.js
// Our own payment flow: create a Razorpay order for a booking already saved
// in our DB, then verify the signature Razorpay Checkout returns and mark
// the booking paid — no Stayflexi payment redirect involved.

const router  = require("express").Router();
const Booking = require("../models/Booking");
const { createOrder, verifySignature } = require("../services/paymentService");
const { sendBookingConfirmation }      = require("../services/mailService");

// POST /api/payments/create-order  { bookingId }
router.post("/create-order", async (req, res) => {
    try {
        const { bookingId } = req.body;
        const booking = await Booking.findById(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

        const amount = booking.totalAmount || booking.amount;
        if (!amount) return res.status(400).json({ success: false, message: "Booking has no amount" });

        const order = await createOrder(amount, booking.bookingRef || booking._id);
        booking.razorpayOrderId = order.id;
        await booking.save();

        res.json({
            success:  true,
            orderId:  order.id,
            amount:   order.amount,   // paise, echoed back for Checkout
            currency: order.currency,
            keyId:    (process.env.RAZORPAY_KEY_ID || "").trim(),
        });
    } catch (err) {
        console.error("Create Razorpay order error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/payments/verify  { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post("/verify", async (req, res) => {
    try {
        const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!bookingId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing payment fields" });
        }

        const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
        if (!valid) {
            return res.status(400).json({ success: false, message: "Payment signature verification failed" });
        }

        const booking = await Booking.findByIdAndUpdate(
            bookingId,
            { paid: true, status: "Confirmed", razorpayPaymentId: razorpay_payment_id },
            { new: true }
        );
        if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

        // Fire-and-forget: don't block the guest's confirmation on email delivery.
        sendBookingConfirmation(booking).catch(e =>
            console.error("Booking confirmation email failed:", e.message)
        );

        res.json({ success: true, booking });
    } catch (err) {
        console.error("Verify payment error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
