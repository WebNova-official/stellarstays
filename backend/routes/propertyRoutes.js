const router    = require("express").Router();
const Property  = require("../models/Property");
const cloudinary = require("cloudinary").v2;

// ── mapUrl validation ──
// mapUrl is rendered directly inside an <iframe src="..."> in admin.html's
// property preview (and was, historically, also read on the booking page).
// A bad value here — non-https, malformed, or pointing at a domain with an
// invalid/self-signed certificate — trips Chrome's "active content with
// certificate errors" flag, which then taints the *entire* stellarstays.in
// origin's security status (admin.html and the public site share a domain),
// not just the one property being previewed. Only accept https:// links to
// known-good map providers; anything else is rejected outright so it never
// reaches the database.
const ALLOWED_MAP_HOSTS = [
    "maps.google.com", "www.google.com", "google.com",
    "maps.app.goo.gl", "goo.gl",
];
function isSafeMapUrl(url) {
    if (!url) return true; // empty is fine — the field is optional
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        return ALLOWED_MAP_HOSTS.some(
            h => parsed.hostname === h || parsed.hostname.endsWith("." + h)
        );
    } catch {
        return false; // not even a valid URL
    }
}

// ── Cloudinary auto-upload helper ──
// Accepts base64 data URL → uploads → returns Cloudinary URL
// If already a https:// URL, returns as-is
async function toCloudinaryUrl(dataOrUrl, resourceType) {
    if (!dataOrUrl) return dataOrUrl;
    if (dataOrUrl.startsWith('https://')) return dataOrUrl; // already hosted securely
    if (dataOrUrl.startsWith('http://')) {
        // Never store plain-http media URLs — causes mixed-content warnings
        // on an https page. Upgrade to https and hope the host supports it;
        // if it doesn't, the resource will simply fail to load (safe failure)
        // rather than silently degrading the whole site's security status.
        return dataOrUrl.replace(/^http:\/\//, 'https://');
    }
    try {
        const result = await cloudinary.uploader.upload(dataOrUrl, {
            resource_type: resourceType || 'image',
            folder: resourceType === 'video' ? 'stellarstays/videos' : 'stellarstays',
            transformation: resourceType === 'video'
                ? [{ quality: 'auto', fetch_format: 'auto' }]
                : [{ width: 1200, height: 900, crop: 'fill', quality: 'auto:good', fetch_format: 'auto' }],
        });
        return result.secure_url;
    } catch (e) {
        console.error('[Cloudinary] upload failed:', e.message);
        return dataOrUrl; // fallback: keep original
    }
}

// Processes all media fields in a property body → uploads base64 to Cloudinary
async function processMediaFields(body) {
    // Main image
    if (body.image) body.image = await toCloudinaryUrl(body.image, 'image');

    // Gallery images
    if (body.gallery && body.gallery.length) {
        body.gallery = await Promise.all(body.gallery.map(u => toCloudinaryUrl(u, 'image')));
    }

    // Videos
    if (body.videos && body.videos.length) {
        body.videos = await Promise.all(body.videos.map(u => toCloudinaryUrl(u, 'video')));
    }

    // Map URL — reject anything that isn't a safe https Google Maps link
    // rather than silently stripping it, so the admin gets clear feedback
    // instead of wondering why the map "disappeared".
    if (body.mapUrl && !isSafeMapUrl(body.mapUrl)) {
        const err = new Error(
            "Invalid Map URL — must be a https:// Google Maps link (e.g. https://maps.google.com/... or https://maps.app.goo.gl/...)."
        );
        err.status = 400;
        throw err;
    }

    return body;
}

// Get all properties
router.get("/", async (req, res) => {
    try {
        const properties = await Property.find();
        res.json(properties);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Get single property
router.get("/:id", async (req, res) => {
    try {
        const property = await Property.findById(req.params.id);
        if (!property) return res.status(404).json({ message: "Property not found" });
        res.json(property);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Add property — auto-upload media to Cloudinary
router.post("/", async (req, res) => {
    try {
        let body = { ...req.body };
        if (!body.weekendRate && body.pricePerNight) body.weekendRate = body.pricePerNight;
        body = await processMediaFields(body);
        const property = new Property(body);
        await property.save();
        res.status(201).json(property);
    } catch (err) {
        console.error("[POST /properties] error:", err.message);
        res.status(400).json({ message: err.message });
    }
});

// Blocked dates patch — before /:id PUT
router.patch("/:id/blocked-dates", async (req, res) => {
    try {
        const { blockedDates } = req.body;
        const property = await Property.findByIdAndUpdate(
            req.params.id,
            { blockedDates: blockedDates || [] },
            { new: true }
        );
        if (!property) return res.status(404).json({ message: "Property not found" });
        res.json({ success: true, blockedDates: property.blockedDates });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Update property — auto-upload any new base64 media to Cloudinary
router.put("/:id", async (req, res) => {
    try {
        let update = { ...req.body };
        if (!update.weekendRate && update.pricePerNight) update.weekendRate = update.pricePerNight;
        if (!update.blockedDates) delete update.blockedDates;
        update = await processMediaFields(update);
        const property = await Property.findByIdAndUpdate(
            req.params.id, update, { new: true, runValidators: true }
        );
        if (!property) return res.status(404).json({ message: "Property not found" });
        res.json(property);
    } catch (err) {
        console.error("[PUT /properties/:id] error:", err.message);
        res.status(400).json({ message: err.message });
    }
});

// Delete property
router.delete("/:id", async (req, res) => {
    try {
        const property = await Property.findByIdAndDelete(req.params.id);
        if (!property) return res.status(404).json({ message: "Property not found" });
        res.json({ message: "Property deleted successfully" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
