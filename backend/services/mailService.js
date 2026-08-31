// services/mailService.js
// Sends our own booking confirmation emails (guest + owner) instead of
// relying on Stayflexi's notifications. Uses Gmail SMTP with an App
// Password — see backend/.env.example for the required vars.

const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.SMTP_USER, // stellarstays.in@gmail.com
        pass: process.env.SMTP_PASS, // Gmail App Password (not the normal login password)
    },
});

const OWNER_EMAIL = process.env.OWNER_NOTIFY_EMAIL || "stellarstays.in@gmail.com";

function inr(n) {
    return "₹" + Number(n || 0).toLocaleString("en-IN");
}

function guestEmailHtml(b) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f1f3d">
        <h2 style="margin-bottom:4px">Booking Confirmed 🎉</h2>
        <p>Hi ${b.guestName},</p>
        <p>Your stay at <b>${b.propertyName}</b> is confirmed. Here are your details:</p>
        <table style="width:100%;font-size:14px;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:4px 0;color:#666">Booking Ref</td><td style="padding:4px 0"><b>${b.bookingRef}</b></td></tr>
            <tr><td style="padding:4px 0;color:#666">Check-in</td><td style="padding:4px 0">${b.checkIn}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Check-out</td><td style="padding:4px 0">${b.checkOut}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Nights</td><td style="padding:4px 0">${b.nights}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Guests</td><td style="padding:4px 0">${b.adults} adult(s)${b.children ? ", " + b.children + " child(ren)" : ""}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-top:1px solid #eee">Total Paid</td><td style="padding:8px 0;border-top:1px solid #eee"><b>${inr(b.totalAmount)}</b></td></tr>
        </table>
        <p>We'll message you on WhatsApp closer to check-in with directions. Safe travels!</p>
        <p style="color:#888;font-size:12px">— Team StellarStays</p>
    </div>`;
}

function ownerEmailHtml(b) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f1f3d">
        <h3 style="margin-bottom:4px">New Paid Booking</h3>
        <p><b>${b.propertyName}</b><br>${b.checkIn} → ${b.checkOut} (${b.nights} night${b.nights !== 1 ? "s" : ""})</p>
        <p>Guest: ${b.guestName}<br>Email: ${b.guestEmail}<br>Phone: ${b.guestPhone}</p>
        <p>Amount paid: <b>${inr(b.totalAmount)}</b><br>Ref: ${b.bookingRef}<br>Razorpay payment ID: ${b.razorpayPaymentId || "—"}</p>
    </div>`;
}

async function sendBookingConfirmation(booking) {
    const from = `"StellarStays" <${process.env.SMTP_USER}>`;

    await Promise.all([
        transporter.sendMail({
            from,
            to:      booking.guestEmail,
            subject: `Booking Confirmed — ${booking.bookingRef} — ${booking.propertyName}`,
            html:    guestEmailHtml(booking),
        }),
        transporter.sendMail({
            from,
            to:      OWNER_EMAIL,
            subject: `New Booking: ${booking.bookingRef} (${booking.propertyName})`,
            html:    ownerEmailHtml(booking),
        }),
    ]);
}

module.exports = { sendBookingConfirmation };
