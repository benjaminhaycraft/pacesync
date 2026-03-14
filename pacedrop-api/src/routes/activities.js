const express = require("express");
const { body, validationResult } = require("express-validator");
const { query } = require("../config/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// List user's activities (paginated)
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;
  const source = req.query.source; // filter by strava, garmin, etc.

  try {
    let sql = `SELECT id, source, external_id, name, activity_type, date, distance_km, duration_sec, elevation_gain, avg_pace, avg_hr, avg_cadence, created_at
               FROM activities WHERE user_id = $1`;
    const params = [req.user.id];
    let idx = 2;

    if (source) {
      sql += ` AND source = $${idx++}`;
      params.push(source);
    }

    sql += ` ORDER BY date DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const [activities, countResult] = await Promise.all([
      query(sql, params),
      query("SELECT COUNT(*) FROM activities WHERE user_id = $1", [req.user.id]),
    ]);

    res.json({
      activities: activities.rows,
      total: parseInt(countResult.rows[0].count),
      page,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activities" });
  }
});

// Get single activity (with full data)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await query("SELECT * FROM activities WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Activity not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// Bulk import activities (from Strava sync or file import)
router.post(
  "/bulk",
  requireAuth,
  [body("activities").isArray({ min: 1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { activities } = req.body;
    let imported = 0;
    let skipped = 0;

    for (const a of activities) {
      const fingerprint = `${a.date}_${Math.round(a.distanceKm * 100)}`;
      try {
        await query(
          `INSERT INTO activities (user_id, source, external_id, name, activity_type, date, distance_km, duration_sec, elevation_gain, avg_pace, avg_hr, max_hr, avg_cadence, calories, suffer_score, splits, grade_pace_pairs, raw_data, fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (user_id, fingerprint) DO NOTHING`,
          [
            req.user.id, a.source || "manual", a.externalId, a.name, a.activityType || "run",
            a.date, a.distanceKm, a.durationSec, a.elevationGain, a.avgPace,
            a.avgHr, a.maxHr, a.avgCadence, a.calories, a.sufferScore,
            a.splits ? JSON.stringify(a.splits) : null,
            a.gradePacePairs ? JSON.stringify(a.gradePacePairs) : null,
            a.rawData ? JSON.stringify(a.rawData) : null,
            fingerprint,
          ]
        );
        imported++;
      } catch (err) {
        skipped++;
      }
    }

    await query(
      `INSERT INTO audit_log (user_id, action, metadata) VALUES ($1, 'import_activities', $2)`,
      [req.user.id, JSON.stringify({ imported, skipped, total: activities.length })]
    );

    res.status(201).json({ imported, skipped, total: activities.length });
  }
);

// Sync from Strava (uses stored OAuth token)
router.post("/sync/strava", requireAuth, async (req, res) => {
  try {
    // Get user's Strava OAuth token
    const oauthRow = await query(
      "SELECT access_token, refresh_token, token_expires FROM oauth_identities WHERE user_id = $1 AND provider = 'strava'",
      [req.user.id]
    );

    if (oauthRow.rows.length === 0) {
      return res.status(400).json({ error: "Strava not connected. Link your Strava account first." });
    }

    let { access_token, refresh_token, token_expires } = oauthRow.rows[0];

    // Refresh token if expired
    if (new Date(token_expires) < new Date()) {
      const refreshRes = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token,
        }),
      });

      const refreshData = await refreshRes.json();
      if (refreshData.access_token) {
        access_token = refreshData.access_token;
        await query(
          `UPDATE oauth_identities SET access_token = $1, refresh_token = $2, token_expires = $3 WHERE user_id = $4 AND provider = 'strava'`,
          [refreshData.access_token, refreshData.refresh_token, new Date(refreshData.expires_at * 1000), req.user.id]
        );
      } else {
        return res.status(401).json({ error: "Strava token refresh failed. Please reconnect." });
      }
    }

    // Fetch recent activities from Strava
    const after = Math.floor(Date.now() / 1000) - 90 * 24 * 3600; // last 90 days
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const stravaActivities = await stravaRes.json();
    if (!Array.isArray(stravaActivities)) {
      return res.status(400).json({ error: "Unexpected Strava response" });
    }

    // Filter runs only and import
    const runs = stravaActivities
      .filter((a) => a.type === "Run" || a.type === "TrailRun")
      .map((a) => ({
        source: "strava",
        externalId: String(a.id),
        name: a.name,
        activityType: a.type.toLowerCase(),
        date: a.start_date_local?.split("T")[0],
        distanceKm: a.distance / 1000,
        durationSec: a.moving_time,
        elevationGain: a.total_elevation_gain,
        avgPace: a.moving_time / 60 / (a.distance / 1000),
        avgHr: a.average_heartrate,
        maxHr: a.max_heartrate,
        avgCadence: a.average_cadence ? a.average_cadence * 2 : null,
        sufferScore: a.suffer_score,
      }));

    let imported = 0;
    for (const a of runs) {
      const fingerprint = `${a.date}_${Math.round(a.distanceKm * 100)}`;
      try {
        await query(
          `INSERT INTO activities (user_id, source, external_id, name, activity_type, date, distance_km, duration_sec, elevation_gain, avg_pace, avg_hr, max_hr, avg_cadence, suffer_score, fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (user_id, fingerprint) DO NOTHING`,
          [req.user.id, a.source, a.externalId, a.name, a.activityType, a.date, a.distanceKm, a.durationSec, a.elevationGain, a.avgPace, a.avgHr, a.maxHr, a.avgCadence, a.sufferScore, fingerprint]
        );
        imported++;
      } catch {
        // skip duplicates
      }
    }

    res.json({ imported, total: runs.length, message: `Synced ${imported} new runs from Strava` });
  } catch (err) {
    console.error("Strava sync error:", err);
    res.status(500).json({ error: "Strava sync failed" });
  }
});

module.exports = router;
