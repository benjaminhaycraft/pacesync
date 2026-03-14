require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const passport = require("passport");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const trailRoutes = require("./routes/trails");
const racePlanRoutes = require("./routes/racePlans");
const playlistRoutes = require("./routes/playlists");
const activityRoutes = require("./routes/activities");
const spotifyTasteRoutes = require("./routes/spotifyTaste");

const { pool } = require("./config/database");

const app = express();
const PORT = process.env.PORT || 3001;

// --------------- Middleware ---------------

app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS — allow the frontend origin
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Global rate limiter
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// Passport initialization (strategies registered in auth routes)
app.use(passport.initialize());

// --------------- Routes ---------------

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/trails", trailRoutes);
app.use("/api/race-plans", racePlanRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/spotify-taste", spotifyTasteRoutes);

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      timestamp: result.rows[0].now,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({ status: "error", message: "Database unavailable" });
  }
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// --------------- Start ---------------

app.listen(PORT, () => {
  console.log(`PaceDrop API running on port ${PORT}`);
});

module.exports = app;
