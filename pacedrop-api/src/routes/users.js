const express = require("express");
const { body, validationResult } = require("express-validator");
const { query } = require("../config/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Get user profile
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.created_at, u.last_login_at,
              s.units, s.default_music_mode, s.preferred_genres, s.base_bpm, s.theme
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update profile
router.patch(
  "/me",
  requireAuth,
  [
    body("displayName").optional().trim().isLength({ min: 1, max: 100 }),
    body("avatarUrl").optional().isURL(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { displayName, avatarUrl } = req.body;
    const sets = [];
    const vals = [];
    let idx = 1;

    if (displayName !== undefined) { sets.push(`display_name = $${idx++}`); vals.push(displayName); }
    if (avatarUrl !== undefined) { sets.push(`avatar_url = $${idx++}`); vals.push(avatarUrl); }

    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });

    vals.push(req.user.id);
    await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
    res.json({ message: "Profile updated" });
  }
);

// Update settings
router.put(
  "/me/settings",
  requireAuth,
  [
    body("units").optional().isIn(["metric", "imperial"]),
    body("defaultMusicMode").optional().isIn(["my-taste", "mood", "random", "generic"]),
    body("baseBpm").optional().isInt({ min: 80, max: 220 }),
    body("theme").optional().isIn(["dark", "light"]),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { units, defaultMusicMode, preferredGenres, baseBpm, theme, notifications } = req.body;

    await query(
      `INSERT INTO user_settings (user_id, units, default_music_mode, preferred_genres, base_bpm, theme, notifications)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         units = COALESCE($2, user_settings.units),
         default_music_mode = COALESCE($3, user_settings.default_music_mode),
         preferred_genres = COALESCE($4, user_settings.preferred_genres),
         base_bpm = COALESCE($5, user_settings.base_bpm),
         theme = COALESCE($6, user_settings.theme),
         notifications = COALESCE($7, user_settings.notifications)`,
      [req.user.id, units, defaultMusicMode, preferredGenres, baseBpm, theme, notifications]
    );

    res.json({ message: "Settings updated" });
  }
);

// Get personal performance model (latest)
router.get("/me/model", requireAuth, async (req, res) => {
  const result = await query(
    `SELECT * FROM personal_models WHERE user_id = $1 ORDER BY computed_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(result.rows[0] || null);
});

// Save personal performance model
router.post("/me/model", requireAuth, async (req, res) => {
  const { basePace, gradeCoeff, baseCadence, cadenceGradeCoeff, avgHr, hrZones, vo2maxEst, source } = req.body;

  try {
    // Increment version
    const latest = await query(
      "SELECT COALESCE(MAX(model_version), 0) AS v FROM personal_models WHERE user_id = $1",
      [req.user.id]
    );
    const newVersion = latest.rows[0].v + 1;

    const result = await query(
      `INSERT INTO personal_models (user_id, base_pace, grade_coeff, base_cadence, cadence_grade_coeff, avg_hr, hr_zones, vo2max_est, model_version, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, basePace, gradeCoeff, baseCadence, cadenceGradeCoeff, avgHr, hrZones, vo2maxEst, newVersion, source || "strava"]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Save model error:", err);
    res.status(500).json({ error: "Failed to save model" });
  }
});

module.exports = router;
