// routes/sfRoutes.js
// Proxies Stayflexi BE-service API calls. Keeps SF_API_KEY server-side only.

const router = require("express").Router();
const sf = require("../services/stayflexiService");

function handle(fn) {
    return async (req, res) => {
        try {
            const data = await fn(req);
            res.json(data);
        } catch (err) {
            console.error("[SF API] error:", err.message);
            res.status(err.status || 500).json({ success: false, message: err.message, details: err.data });
        }
    };
}

// GET /api/sf/group-hotels
router.get("/group-hotels", handle(() => sf.getGroupHotels()));

// GET /api/sf/group-locations
router.get("/group-locations", handle(() => sf.getGroupLocations()));

// GET /api/sf/hotels-by-location?location=meppadi, kerala
router.get("/hotels-by-location", handle((req) => sf.getGroupHotelsByLocation(req.query.location)));

// GET /api/sf/hotel-content?hotelId=
router.get("/hotel-content", handle((req) => sf.getHotelContent(req.query.hotelId)));

// GET /api/sf/checkin-times?date=DD-MM-YYYY&hotelId=
router.get("/checkin-times", handle((req) => sf.getCheckinTimes(req.query.date, req.query.hotelId)));

// GET /api/sf/checkout-times?date=DD-MM-YYYY&hotelId=
router.get("/checkout-times", handle((req) => sf.getCheckoutTimes(req.query.date, req.query.hotelId)));

// GET /api/sf/calendar?fromDate=DD-MM-YYYY&toDate=DD-MM-YYYY&hotelId=
router.get("/calendar", handle((req) => sf.getHotelCalendar(req.query.fromDate, req.query.toDate, req.query.hotelId)));

// GET /api/sf/availability?checkin=DD-MM-YYYY HH:mm:ss&checkout=...&discount=0&hotelId=
router.get("/availability", handle((req) =>
    sf.getHotelDetailAdvanced(req.query.checkin, req.query.checkout, req.query.discount, req.query.hotelId)
));

// POST /api/sf/perform-booking
router.post("/perform-booking", handle((req) => sf.performBooking(req.body)));

// POST /api/sf/record-payment
router.post("/record-payment", handle((req) => sf.recordExternalPayment(req.body)));

// GET /api/sf/booking-info?bookingId=
router.get("/booking-info", handle((req) => sf.getBookingInfo(req.query.bookingId)));

// GET /api/sf/booking-cancellation?bookingId=
router.get("/booking-cancellation", handle((req) => sf.cancelBooking(req.query.bookingId)));

// ── Generic passthrough (used by admin.html's sfFetch helper) ──
// Forwards any Stayflexi path+query server-side, key never touches browser.
// GET  /api/sf/raw?path=/core/api/v1/beservice/grouphotels%3FgroupId%3D...
// POST /api/sf/raw?path=/core/api/v1/beservice/perform-booking
async function rawProxy(req, res) {
    try {
        const path = req.query.path;
        if (!path) return res.status(400).json({ message: "path query param required" });
        const url = "https://api.stayflexi.com" + path;
        const headers = { "X-SF-API-KEY": process.env.SF_API_KEY || "" };
        if (req.method === "POST") headers["Content-Type"] = "application/json";
        const r = await fetch(url, {
            method: req.method,
            headers,
            body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
        });
        const data = await r.json().catch(() => ({}));
        res.status(r.status).json(data);
    } catch (err) {
        console.error("[SF raw proxy] error:", err.message);
        res.status(500).json({ message: err.message });
    }
}
router.get("/raw", rawProxy);
router.post("/raw", rawProxy);

module.exports = router;
