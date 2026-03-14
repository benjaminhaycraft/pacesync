const express = require("express");
const { query } = require("../config/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Get user's cached Spotify taste
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await query("SELECT * FROM spotify_taste WHERE user_id = $1", [req.user.id]);
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Spotify taste" });
  }
});

// Save/update Spotify taste data
router.put("/", requireAuth, async (req, res) => {
  const { topTrackIds, topArtistIds, topGenres, artistAffinity } = req.body;

  try {
    await query(
      `INSERT INTO spotify_taste (user_id, top_track_ids, top_artist_ids, top_genres, artist_affinity)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         top_track_ids = $2, top_artist_ids = $3, top_genres = $4, artist_affinity = $5, fetched_at = NOW()`,
      [req.user.id, topTrackIds || [], topArtistIds || [], topGenres || [], artistAffinity || {}]
    );

    res.json({ message: "Spotify taste updated" });
  } catch (err) {
    console.error("Save Spotify taste error:", err);
    res.status(500).json({ error: "Failed to save Spotify taste" });
  }
});

module.exports = router;
