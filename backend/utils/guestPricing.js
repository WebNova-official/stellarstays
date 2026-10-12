// backend/utils/guestPricing.js
//
// The single source of truth for guest-count rules and the extra-guest charge.
// bookingRoutes.js enforces it on every booking, and propertyRoutes.js sends
// the same numbers to booking.html (as `guestPolicy`) so the page can never
// quote a different price from the one the server charges.
//
// THE RULES
//   • The villa's base price covers up to BASE_OCCUPANCY (8) guests.
//   • Every guest above that costs EXTRA_GUEST_FEE (₹1,000) PER NIGHT.
//     12 guests for 5 nights = 4 extra × ₹1,000 × 5 nights = ₹20,000.
//   • The most a villa can hold is its own `guests` field (Property.guests,
//     editable in admin as "Max Guests"). A booking above it is rejected.
//     Villa A (12) therefore tops out at ₹4,000 extra PER NIGHT, Villa B (16)
//     at ₹8,000 per night, because the per-night cap is (max − 8) × ₹1,000.
//
// Guests are adults + children + infants (the same total admin.html shows).

const BASE_OCCUPANCY  = 8;
const EXTRA_GUEST_FEE = 1000;

// Whole, non-negative integer, or null if the value isn't one. A missing
// value falls back to `fallback`. Rejects 2.5, -1, "abc", NaN, Infinity.
function parseCount(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

// The villa's hard capacity. If the stored value is missing or nonsensical we
// fall back to the base occupancy — the conservative failure (it refuses
// bookings above 8) rather than silently allowing any headcount.
function maxGuestsFor(property) {
    const n = Math.floor(Number(property && property.guests));
    return Number.isFinite(n) && n > 0 ? n : BASE_OCCUPANCY;
}

// What the front end needs to display and enforce the same rules.
function guestPolicyFor(property) {
    const maxGuests = maxGuestsFor(property);
    return {
        baseOccupancy:  BASE_OCCUPANCY,
        extraGuestFee:  EXTRA_GUEST_FEE,
        maxGuests,
        maxExtraPerNight: Math.max(0, maxGuests - BASE_OCCUPANCY) * EXTRA_GUEST_FEE,
    };
}

/**
 * Validates a headcount against a villa and works out the extra-guest charge.
 *
 * @param {{adults?:any, children?:any, infants?:any}} counts  as sent by the client
 * @param {{guests?:number}} property  the villa (needs `guests` = max capacity)
 * @param {number} nights  nights in the stay (the server's own count, never the client's)
 * @returns {{ok:false, message:string}
 *         | {ok:true, adults:number, children:number, infants:number,
 *            totalGuests:number, extraGuests:number, nights:number,
 *            extraGuestPerNight:number, extraGuestAmount:number, policy:object}}
 */
function priceGuests(counts, property, nights) {
    const c = counts || {};
    const adults   = parseCount(c.adults,   1);
    const children = parseCount(c.children, 0);
    const infants  = parseCount(c.infants,  0);

    if (adults === null || children === null || infants === null) {
        return { ok: false, message: "Guest counts must be whole numbers, 0 or more." };
    }
    if (adults < 1) {
        return { ok: false, message: "At least 1 adult is required." };
    }

    const policy      = guestPolicyFor(property);
    const totalGuests = adults + children + infants;

    if (totalGuests > policy.maxGuests) {
        return {
            ok: false,
            message: `This villa allows a maximum of ${policy.maxGuests} guests `
                   + `(you selected ${totalGuests}). Please reduce the guest count.`,
        };
    }

    // Per extra guest, per night.
    const stayNights         = Math.max(1, Math.floor(Number(nights)) || 1);
    const extraGuests        = Math.max(0, totalGuests - policy.baseOccupancy);
    const extraGuestPerNight = extraGuests * policy.extraGuestFee;
    const extraGuestAmount   = extraGuestPerNight * stayNights;

    return {
        ok: true, adults, children, infants, totalGuests, extraGuests,
        nights: stayNights, extraGuestPerNight, extraGuestAmount, policy,
    };
}

module.exports = {
    BASE_OCCUPANCY,
    EXTRA_GUEST_FEE,
    parseCount,
    maxGuestsFor,
    guestPolicyFor,
    priceGuests,
};
