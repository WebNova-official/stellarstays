require("dotenv").config();

const express      = require("express");
const mongoose     = require("mongoose");
const cors         = require("cors");
const path         = require("path");
const compression  = require("compression");

const propertyRoutes = require("./routes/propertyRoutes");
const bookingRoutes  = require("./routes/bookingRoutes");
const sfRoutes        = require("./routes/sfRoutes");

const app = express();

// ── Gzip all responses ──
app.use(compression());

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Static assets ──
// HTML files (admin.html, index.html, etc.) are always revalidated so deploys
// show up immediately — these change often and a stale admin.html/booking.js
// after a deploy silently reintroduces already-fixed bugs.
// Everything else (images, fonts, etc.) keeps a 7-day cache since those
// rarely change and benefit from being cached hard.
app.use(express.static(path.join(__dirname, ".."), {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
            res.setHeader("Cache-Control", "no-cache");
        } else {
            res.setHeader("Cache-Control", "public, max-age=604800");
        }
    },
}));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅  MongoDB Connected"))
    .catch(err => console.error("❌  MongoDB connection error:", err));

// ── SF config route (reads from .env) ──
// sfConfigured now does a real live check against Stayflexi instead of just
// checking the env var is non-empty — a present-but-wrong key (exactly what
// caused the 401s) used to still show "Connected".
app.get("/api/config", async (req, res) => {
    res.set("Cache-Control", "no-store");          // never cache secrets
    var sfConfigured = false;
    var sfError = null;
    if (process.env.SF_API_KEY && process.env.SF_GROUP_ID) {
        try {
            var r = await fetch("https://api.stayflexi.com/core/api/v1/beservice/grouphotels?groupId=" + process.env.SF_GROUP_ID, {
                headers: { "X-SF-API-KEY": process.env.SF_API_KEY.trim() }
            });
            var data = await r.json().catch(function() { return {}; });
            sfConfigured = r.ok && !data.code; // Stayflexi returns {code, message} on auth failure
            if (!sfConfigured) sfError = data.message || ("HTTP " + r.status);
        } catch (e) {
            sfError = e.message;
        }
    } else {
        sfError = "SF_API_KEY or SF_GROUP_ID not set";
    }
    res.json({
        sfGroupId:    process.env.SF_GROUP_ID || "",
        sfConfigured: sfConfigured,
        sfError:      sfError, // null when healthy — surface this in admin UI if you want the real reason
    });
});

app.use("/api/properties", propertyRoutes);
app.use("/api/bookings",   bookingRoutes);
app.use("/api/sf",         sfRoutes);

// ── Cloudinary image upload endpoint ──
const cloudinary = require("cloudinary").v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post("/api/upload", async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: "No image data" });
        const result = await cloudinary.uploader.upload(data, {
            folder:         "stellarstays",
            transformation: [
                { width: 1200, height: 900, crop: "fill", quality: "auto:good", fetch_format: "auto" }
            ],
        });
        res.json({ url: result.secure_url });
    } catch (err) {
        console.error("Cloudinary image upload error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ── Cloudinary video upload ──
app.post("/api/upload-video", async (req, res) => {
    try {
        const { data, filename } = req.body;
        if (!data) return res.status(400).json({ error: "No video data" });
        const result = await cloudinary.uploader.upload(data, {
            resource_type: "video",
            folder:        "stellarstays/videos",
            public_id:     filename ? filename.replace(/\.[^.]+$/, "") : undefined,
            transformation: [
                { quality: "auto", fetch_format: "auto" }   // auto compress, auto format (mp4/webm)
            ],
        });
        res.json({
            url:       result.secure_url,
            thumbnail: result.secure_url.replace(/\.[^.]+$/, ".jpg").replace("/video/upload/", "/video/upload/so_0/"),
            duration:  result.duration,
        });
    } catch (err) {
        console.error("Cloudinary video upload error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/{*splat}", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "index.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀  Server running on port ${PORT}`);
});
