// routes/sfRoutes.js
// Proxies Stayflexi BE-service API calls. Keeps SF_API_KEY server-side only.

const router = require("express").Router();
const sf = require("../services/stayflexiService");
const rateSync = require("../services/rateSyncService");

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

// POST /api/sf/create-enquiry-booking
// Creates the booking on Stayflexi as an "enquiry" (isEnquiry: true), which
// holds the room without confirming it. We confirm it ourselves later via
// /api/payments/verify -> recordExternalPayment, once our own Razorpay
// payment succeeds. This is Stayflexi's documented flow for hotels using
// their own/custom payment gateway instead of Stayflexi's hosted redirect.
router.post("/create-enquiry-booking", async (req, res) => {
    try {
        const {
            hotelId, checkin, checkout, roomTypeId, ratePlanId,
            numAdults, numChildren, sellRate,
            firstName, lastName, email, phone,
            country, city, zipcode, address, state,
        } = req.body;

        if (!hotelId || !checkin || !checkout || !roomTypeId || !ratePlanId || !sellRate || !email || !phone) {
            return res.status(400).json({ success: false, message: "Missing required booking fields" });
        }

        const payload = {
            checkin, checkout,
            hotelId: parseInt(hotelId),
            bookingStatus: "CONFIRMED",   // Stayflexi field name is misleading — isEnquiry below is what actually matters
            bookingSource: "STAYFLEXI_OD",
            roomStays: [{
                numAdults: numAdults || 1,
                numChildren: numChildren || 0,
                numChildren1: 0,
                roomTypeId, ratePlanId,
            }],
            ctaId: "",
            customerDetails: {
                firstName, lastName: lastName || "",
                emailId: email,
                phoneNumber: phone,
                country: country || "", city: city || "",
                zipcode: zipcode || "", address: address || "", state: state || "",
            },
            paymentDetails: {
                sellRate, roomRate: sellRate,
                payAtHotel: false,
            },
            promoInfo: {}, specialRequests: "",
            requestToBook: false, isAddOnPresent: true, posOrderList: [],
            isInsured: false, refundableBookingFee: 0,
            appliedPromocode: "", promoAmount: 0, bookingFees: 0,
            isEnquiry: true, isExternalPayment: false,
        };

        const data = await sf.performBooking(payload);
        if (!data.status) {
            return res.status(400).json({ success: false, message: data.message || "Stayflexi booking failed" });
        }

        res.json({ success: true, stayflexiBookingId: data.bookingId });
    } catch (err) {
        console.error("[SF create-enquiry-booking] error:", err.message);
        res.status(err.status || 500).json({ success: false, message: err.message });
    }
});

// POST /api/sf/sync-rates
// Manually triggers the same rate sync the background scheduler runs — pulls
// live weekday/weekend rates from Stayflexi for every linked property and
// writes pricePerNight/weekendRate into MongoDB. Used by the "Sync Rates Now"
// button in admin.html, but also runs automatically on a schedule (see
// server.js / rateSyncService.startRateSyncScheduler).
router.post("/sync-rates", handle(() => rateSync.syncAllRates()));

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
        const headers = { "X-SF-API-KEY": (process.env.SF_API_KEY || "").trim() };
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
