const express = require("express");
const { body, validationResult } = require("express-validator");
const { query, getClient } = require("../config/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// List user's race plans
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT rp.*, t.name AS trail_name, t.distance_km
       FROM race_plans rp
       LEFT JOIN trails t ON t.id = rp.trail_id
       WHERE rp.user_id = $1
       ORDER BY rp.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch race plans" });
  }
});

// Get single race plan with segments
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const plan = await query(
      `SELECT rp.*, t.name AS trail_name, t.distance_km, t.elevation_profile
       FROM race_plans rp
       LEFT JOIN trails t ON t.id = rp.trail_id
       WHERE rp.id = $1 AND rp.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (plan.rows.length === 0) return res.status(404).json({ error: "Race plan not found" });

    const segments = await query(
      `SELECT * FROM race_plan_segments WHERE race_plan_id = $1 ORDER BY segment_index`,
      [req.params.id]
    );

    res.json({ ...plan.rows[0], segments: segments.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch race plan" });
  }
});

// Save race plan with segments
router.post(
  "/",
  requireAuth,
  [
    body("name").trim().isLength({ min: 1, max: 200 }),
    body("strategy").isIn(["constant_effort", "negative_split", "positive_split", "even_pace"]),
    body("segments").isArray({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, strategy, trailId, modelId, targetTimeMin, estTimeMin, avgPace, segments } = req.body;
    const client = await getClient();

    try {
      await client.query("BEGIN");

      const plan = await client.query(
        `INSERT INTO race_plans (user_id, trail_id, model_id, name, strategy, target_time_min, est_time_min, avg_pace, total_segments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [req.user.id, trailId, modelId, name, strategy, targetTimeMin, estTimeMin, avgPace, segments.length]
      );

      const planId = plan.rows[0].id;

      for (const seg of segments) {
        await client.query(
          `INSERT INTO race_plan_segments
           (race_plan_id, segment_index, distance_m, gradient, elev_gain, target_pace, target_bpm, target_cadence, target_hr, hr_zone, emotional_zone, fatigue_factor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [planId, seg.segmentIndex, seg.distanceM, seg.gradient, seg.elevGain, seg.targetPace, seg.targetBpm, seg.targetCadence, seg.targetHr, seg.hrZone, seg.emotionalZone, seg.fatigueFactor]
        );
      }

      await client.query("COMMIT");
      res.status(201).json(plan.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Save race plan error:", err);
      res.status(500).json({ error: "Failed to save race plan" });
    } finally {
      client.release();
    }
  }
);

// Delete race plan
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await query("DELETE FROM race_plans WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Race plan not found" });
    res.json({ message: "Race plan deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

module.exports = router;
