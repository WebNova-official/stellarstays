const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
    property:     { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
    propertyName: { type: String },

    // Guest info
    guestName:  { type: String, required: true },
    guestEmail: { type: String, required: true },
    guestPhone: { type: String, required: true },

    // Stay details
    checkIn:    { type: String, required: true },
    checkOut:   { type: String, required: true },
    nights:     { type: Number, required: true },
    adults:     { type: Number, default: 1 },
    children:   { type: Number, default: 0 },
    infants:    { type: Number, default: 0 },

    // Pricing
    pricePerNight: { type: Number, default: 0 },
    baseAmount:    { type: Number, default: 0 },
    addonChef:     { type: Boolean, default: false },
    addonBonfire:  { type: Boolean, default: false },
    addonAmount:   { type: Number, default: 0 },
    taxAmount:     { type: Number, default: 0 },
    totalAmount:   { type: Number, default: 0 },
    amount:        { type: Number, default: 0 },
    addons:        { type: [String], default: [] },

    // Status — accepts both cases from different clients
    status: {
        type: String,
        enum: ["pending", "confirmed", "cancelled", "completed",
               "Pending", "Confirmed", "Cancelled", "Completed"],
        default: "Pending"
    },

    // bookingRef is the human-readable reference (SS-XXXXXX)
    // sparse:true means multiple null values are allowed while
    // still enforcing uniqueness among non-null values
    bookingRef: { type: String, unique: true, sparse: true },

}, { timestamps: true });

bookingSchema.pre("save", async function () {
    if (!this.bookingRef) {
        this.bookingRef = "SS-" + Math.random().toString(36).toUpperCase().slice(2, 8);
    }
    if (!this.totalAmount && this.amount) this.totalAmount = this.amount;
    if (!this.amount && this.totalAmount) this.amount = this.totalAmount;
    if (this.addons && this.addons.length) {
        this.addonChef    = this.addons.includes("Chef");
        this.addonBonfire = this.addons.includes("Bonfire");
    }
});

module.exports = mongoose.model("Booking", bookingSchema);