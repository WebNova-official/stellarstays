// services/paymentService.js
// Direct Razorpay integration — no Stayflexi payment redirect involved.
// Credentials come from .env (never exposed to frontend; only the public
// key_id is sent to the client so it can open the Checkout modal).

const Razorpay = require("razorpay");
const crypto   = require("crypto");

const razorpay = new Razorpay({
    key_id:     (process.env.RAZORPAY_KEY_ID || "").trim(),
    key_secret: (process.env.RAZORPAY_KEY_SECRET || "").trim(),
});

// amount is in rupees; Razorpay expects the smallest currency unit (paise).
async function createOrder(amountInRupees, receipt) {
    return razorpay.orders.create({
        amount:   Math.round(Number(amountInRupees) * 100),
        currency: "INR",
        receipt:  String(receipt || "").slice(0, 40), // Razorpay caps receipt length
    });
}

// Verifies the signature Razorpay Checkout returns after a successful payment.
// This is the standard HMAC-SHA256(order_id + "|" + payment_id) check —
// without it anyone could call /verify with fake IDs and mark a booking paid.
function verifySignature(orderId, paymentId, signature) {
    const expected = crypto
        .createHmac("sha256", (process.env.RAZORPAY_KEY_SECRET || "").trim())
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
    return expected === signature;
}

module.exports = { razorpay, createOrder, verifySignature };
