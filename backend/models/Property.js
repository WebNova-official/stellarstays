const mongoose = require("mongoose");

const propertySchema = new mongoose.Schema({
    name:            { type: String, required: true },
    location:        { type: String, required: true },
    pricePerNight:   { type: Number, required: true },
    weekendRate:     { type: Number, default: 0 },
    securityDeposit: { type: Number, default: 0 },
    minStay:         { type: Number, default: 1 },
    description:     { type: String, default: "" },
    pets:            { type: String, default: "No" },
    stayflexi:       { type: String, default: "" },
    bedrooms:        { type: Number, required: true },
    guests:          { type: Number, required: true },
    image:           { type: String, required: true },
    gallery:         { type: [String], default: [] },
    videos:          { type: [String], default: [] },
    amenities:       { type: [String], default: [] },
    rating:          { type: Number, default: 4.8 },
    mapUrl:          { type: String, default: "" },
    status:          { type: String, enum: ["Active", "Inactive", "Pending Review"], default: "Active" },
    type:            { type: String, default: "Villa" },
    hot:             { type: Boolean, default: false },

    // Admin-blocked dates (YYYY-MM-DD strings)
    blockedDates:    { type: [String], default: [] },

    reviews: {
        type: [{
            author: { type: String, default: "" },
            date:   { type: String, default: "" },
            score:  { type: Number, default: 5 },
            text:   { type: String, default: "" }
        }],
        default: []
    },
    faqs: {
        type: [{
            q: { type: String, default: "" },
            a: { type: String, default: "" }
        }],
        default: []
    }
});

// Mongoose 7+ async middleware — no next() callback needed
propertySchema.pre("save", async function() {
    if (!this.weekendRate) this.weekendRate = this.pricePerNight;
});

module.exports = mongoose.model("Property", propertySchema);