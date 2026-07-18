// services/stayflexiService.js
// Thin wrapper around Stayflexi's BE-service API (https://api.stayflexi.com).
// Auth: X-SF-API-KEY header, credentials come from .env (never exposed to frontend directly).

const BASE_URL = "https://api.stayflexi.com";

function authHeaders(extra = {}) {
    return {
        "X-SF-API-KEY": (process.env.SF_API_KEY || "").trim(),
        ...extra,
    };
}

async function sfRequest(path, { method = "GET", query, body } = {}) {
    const url = new URL(BASE_URL + path);
    if (query) {
        Object.entries(query).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
        });
    }

    const res = await fetch(url.toString(), {
        method,
        headers: body
            ? authHeaders({ "Content-Type": "application/json" })
            : authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `Stayflexi API error (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

const groupId = () => process.env.SF_GROUP_ID || "";
const hotelId = () => process.env.SF_HOTEL_ID || "";

module.exports = {
    // ── Group / hotel discovery ──
    getGroupHotels: () =>
        sfRequest("/core/api/v1/beservice/grouphotels", { query: { groupId: groupId() } }),

    getGroupLocations: () =>
        sfRequest("/core/api/v1/beservice/grouplocations", { query: { groupId: groupId() } }),

    getGroupHotelsByLocation: (location) =>
        sfRequest("/core/api/v1/beservice/grouphotelsbylocation", {
            query: { groupId: groupId(), location },
        }),

    // ── Hotel content / config ──
    getHotelContent: (hId = hotelId()) =>
        sfRequest("/core/api/v1/beservice/hotelcontent", { query: { hotelId: hId } }),

    getCheckinTimes: (date, hId = hotelId()) =>
        sfRequest("/core/api/v1/beservice/hotelcheckin/", { query: { hotelId: hId, date } }),

    getCheckoutTimes: (date, hId = hotelId()) =>
        sfRequest("/core/api/v1/beservice/hotelcheckout/", { query: { hotelId: hId, date } }),

    getHotelCalendar: (fromDate, toDate, hId = hotelId()) =>
        sfRequest("/core/api/v1/beservice/hotelcalendar/", {
            query: { hotelId: hId, fromDate, toDate },
        }),

    // ── Rates / availability ──
    getHotelDetailAdvanced: (checkin, checkout, discount = 0, hId = hotelId()) =>
        sfRequest("/core/api/v1/beservice/hoteldetailadvanced", {
            query: { hotelId: hId, checkin, checkout, discount },
        }),

    // ── Booking lifecycle ──
    performBooking: (payload) =>
        sfRequest("/core/api/v1/beservice/perform-booking", { method: "POST", body: payload }),

    recordExternalPayment: (payload) =>
        sfRequest("/api/v2/payments/recordExternalPayment/", { method: "POST", body: payload }),

    getBookingInfo: (bookingId) =>
        sfRequest("/core/api/v1/beservice/bookinginfo", { query: { bookingId } }),

    cancelBooking: (bookingId) =>
        sfRequest("/core/api/v1/beservice/bookingcancellation", { query: { bookingId } }),
};
