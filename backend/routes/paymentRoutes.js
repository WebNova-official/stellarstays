// routes/paymentRoutes.js
// Our own payment flow: create a Razorpay order for a booking already saved
// in our DB, then verify the signature Razorpay Checkout returns and mark
// the booking paid — no Stayflexi payment redirect involved.

const router  = require("express").Router();
const Booking = require("../models/Booking");
const { createOrder, verifySignature } = require("../services/paymentService");
const { sendBookingConfirmation }      = require("../services/mailService");
const sf                               = require("../services/stayflexiService");

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
        // Razorpay SDK errors often don't have a plain .message — the real
        // reason (e.g. "Authentication failed") lives in err.error.description.
        const detail = err?.error?.description || err.message || "Unknown error";
        console.error("Create Razorpay order error:", err?.error || err);
        res.status(500).json({ success: false, message: detail });
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

        // Confirm the Stayflexi enquiry so the dates show as booked on their
        // calendar. The guest's confirmation is never blocked on this — our
        // own DB (updated above) is already the source of truth every part
        // of this app reads from (see availabilityService.js). But a failure
        // here must not be silent: if Stayflexi never gets the confirmation,
        // ITS calendar (and any OTA it feeds) would keep showing the night
        // as free. One retry absorbs a transient blip; if it still fails,
        // the booking is flagged (sfSyncFailed) rather than just logged, so
        // it surfaces in the admin calendar/booking list for manual
        // reconciliation instead of silently drifting out of sync forever.
        if (booking.stayflexiBookingId && booking.stayflexiHotelId) {
            const sfPayload = {
                hotel_id: parseInt(booking.stayflexiHotelId),
                booking_id: booking.stayflexiBookingId,
                booking_source: "CUSTOM_BE",
                module_source: "CUSTOM_BE_PAYMENT",
                amount: booking.totalAmount,
                currency: "INR",
                payment_gateway_id: razorpay_payment_id,
                pg_name: "RAZORPAY",
                requires_post_payment_confirmation: true,
                notes: "",
                gateway_message: "",
                payment_type: "Card",
                payment_issuer: "",
                payment_mode: "ONLINE",
                status: "SUCCESS",
            };

            (async () => {
                try {
                    await sf.recordExternalPayment(sfPayload);
                    if (booking.sfSyncFailed) {
                        await Booking.findByIdAndUpdate(booking._id, { sfSyncFailed: false, sfSyncError: "" });
                    }
                } catch (firstErr) {
                    console.warn(`[SF recordExternalPayment] failed once for ${booking.stayflexiBookingId}, retrying:`, firstErr.message);
                    try {
                        await sf.recordExternalPayment(sfPayload);
                        if (booking.sfSyncFailed) {
                            await Booking.findByIdAndUpdate(booking._id, { sfSyncFailed: false, sfSyncError: "" });
                        }
                    } catch (secondErr) {
                        console.error(`[SF recordExternalPayment] FAILED after retry for booking ${booking._id} `
                            + `(stayflexiBookingId=${booking.stayflexiBookingId}):`, secondErr.message);
                        await Booking.findByIdAndUpdate(booking._id, {
                            sfSyncFailed: true,
                            sfSyncError: secondErr.message || "Unknown error",
                        }).catch(e => console.error("Could not flag sfSyncFailed on booking:", e.message));
                    }
                }
            })();
        } else {
            console.warn(`Booking ${booking._id} has no stayflexiBookingId — dates will NOT block on Stayflexi's calendar.`);
            await Booking.findByIdAndUpdate(booking._id, {
                sfSyncFailed: true,
                sfSyncError: "No Stayflexi enquiry was linked to this booking.",
            }).catch(e => console.error("Could not flag sfSyncFailed on booking:", e.message));
        }

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
