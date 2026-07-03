require("dotenv").config();

const express      = require("express");
const mongoose     = require("mongoose");
const cors         = require("cors");
const path         = require("path");
const compression  = require("compression");

const propertyRoutes = require("./routes/propertyRoutes");
const bookingRoutes  = require("./routes/bookingRoutes");

const app = express();

// ── Gzip all responses ──
app.use(compression());

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Cache static assets 7 days ──
app.use(express.static(path.join(__dirname, ".."), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
}));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅  MongoDB Connected"))
    .catch(err => console.error("❌  MongoDB connection error:", err));

// ── SF config route (reads from .env) ──
app.get("/api/config", (req, res) => {
    res.set("Cache-Control", "no-store");          // never cache secrets
    res.json({
        sfApiKey:  process.env.SF_API_KEY  || "",
        sfGroupId: process.env.SF_GROUP_ID || "",
    });
});

app.use("/api/properties", propertyRoutes);
app.use("/api/bookings",   bookingRoutes);

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
