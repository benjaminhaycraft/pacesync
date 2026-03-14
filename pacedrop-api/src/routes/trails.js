const express = require("express");
const { body, validationResult } = require("express-validator");
const { query } = require("../config/database");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

// List trails — public system trails + user's custom trails
router.get("/", optionalAuth, async (req, res) => {
  try {
    const search = req.query.q;
    const difficulty = req.query.difficulty;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = parseInt(req.query.offset) || 0;

    let sql = `SELECT id, user_id, name, location, distance_km, elevation_gain, elevation_loss, max_elevation, difficulty, terrain_type, tags, is_public, created_at
               FROM trails WHERE (is_public = TRUE`;
    const params = [];
    let idx = 1;

    if (req.user) {
      sql += ` OR user_id = $${idx++}`;
      params.push(req.user.id);
    }
    sql += ")";

    if (search) {
      sql += ` AND to_tsvector('english', name) @@ plainto_tsquery('english', $${idx++})`;
      params.push(search);
    }
    if (difficulty) {
      sql += ` AND difficulty = $${idx++}`;
      params.push(difficulty);
    }

    sql += ` ORDER BY is_public DESC, name ASC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("List trails error:", err);
    res.status(500).json({ error: "Failed to fetch trails" });
  }
});

// Get single trail (with elevation profile)
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM trails WHERE id = $1 AND (is_public = TRUE ${req.user ? "OR user_id = $2" : ""})`,
      req.user ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Trail not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trail" });
  }
});

// Add custom trail (from GPX or manual entry)
router.post(
  "/",
  requireAuth,
  [
    body("name").trim().isLength({ min: 1, max: 200 }),
    body("distanceKm").isFloat({ min: 0.1 }),
    body("elevationProfile").optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, location, distanceKm, elevationGain, elevationLoss, maxElevation,
      difficulty, terrainType, elevationProfile, gpxData, coordinates, tags, isPublic,
    } = req.body;

    try {
      const result = await query(
        `INSERT INTO trails (user_id, name, location, distance_km, elevation_gain, elevation_loss, max_elevation, difficulty, terrain_type, elevation_profile, gpx_data, coordinates, tags, is_public)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [req.user.id, name, location, distanceKm, elevationGain, elevationLoss, maxElevation, difficulty, terrainType, elevationProfile, gpxData, coordinates, tags || [], isPublic || false]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Add trail error:", err);
      res.status(500).json({ error: "Failed to add trail" });
    }
  }
);

// Delete custom trail
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await query("DELETE FROM trails WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Trail not found or not yours" });
    res.json({ message: "Trail deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

module.exports = router;
