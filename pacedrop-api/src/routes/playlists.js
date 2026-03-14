const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { query, getClient } = require("../config/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// List user's playlists (paginated)
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  try {
    const [playlists, countResult] = await Promise.all([
      query(
        `SELECT p.*, t.name AS trail_name, t.distance_km AS trail_distance
         FROM playlists p
         LEFT JOIN trails t ON t.id = p.trail_id
         WHERE p.user_id = $1
         ORDER BY p.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      ),
      query("SELECT COUNT(*) FROM playlists WHERE user_id = $1", [req.user.id]),
    ]);

    res.json({
      playlists: playlists.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch playlists" });
  }
});

// Get single playlist with tracks
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const playlist = await query(
      `SELECT p.*, t.name AS trail_name, t.distance_km AS trail_distance, t.elevation_profile
       FROM playlists p
       LEFT JOIN trails t ON t.id = p.trail_id
       WHERE p.id = $1 AND p.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (playlist.rows.length === 0) return res.status(404).json({ error: "Playlist not found" });

    const tracks = await query(
      `SELECT * FROM playlist_tracks WHERE playlist_id = $1 ORDER BY segment_index`,
      [req.params.id]
    );

    res.json({ ...playlist.rows[0], tracks: tracks.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch playlist" });
  }
});

// Save a new playlist (with tracks)
router.post(
  "/",
  requireAuth,
  [
    body("name").trim().isLength({ min: 1, max: 200 }),
    body("musicMode").isIn(["my-taste", "mood", "random", "generic"]),
    body("tracks").isArray({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, musicMode, trailId, racePlanId, spotifyPlaylistId, spotifyUrl, tracks } = req.body;
    const client = await getClient();

    try {
      await client.query("BEGIN");

      const playlist = await client.query(
        `INSERT INTO playlists (user_id, name, music_mode, trail_id, race_plan_id, spotify_playlist_id, spotify_url, total_tracks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [req.user.id, name, musicMode, trailId, racePlanId, spotifyPlaylistId, spotifyUrl, tracks.length]
      );

      const playlistId = playlist.rows[0].id;

      // Batch insert tracks
      for (const t of tracks) {
        await client.query(
          `INSERT INTO playlist_tracks
           (playlist_id, segment_index, track_name, artist_name, spotify_uri, spotify_id, album_name, album_art_url, bpm, target_bpm, popularity, score, duration_ms, pace_per_km, gradient, terrain_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [playlistId, t.segmentIndex, t.trackName, t.artistName, t.spotifyUri, t.spotifyId, t.albumName, t.albumArtUrl, t.bpm, t.targetBpm, t.popularity, t.score, t.durationMs, t.pacePerKm, t.gradient, t.terrainLabel]
        );
      }

      await client.query("COMMIT");

      await query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES ($1, 'create_playlist', 'playlist', $2, $3)`,
        [req.user.id, playlistId, JSON.stringify({ trackCount: tracks.length, musicMode })]
      );

      res.status(201).json(playlist.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Save playlist error:", err);
      res.status(500).json({ error: "Failed to save playlist" });
    } finally {
      client.release();
    }
  }
);

// Toggle favorite
router.patch("/:id/favorite", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE playlists SET is_favorite = NOT is_favorite WHERE id = $1 AND user_id = $2 RETURNING id, is_favorite`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Playlist not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update" });
  }
});

// Delete playlist
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await query("DELETE FROM playlists WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Playlist not found" });
    res.json({ message: "Playlist deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

module.exports = router;
