require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  console.log("Seeding PaceDrop database with trail data...\n");

  // System trails (from TRAIL_DATABASE in the frontend)
  const trails = [
    {
      name: "EcoTrail Paris 20km",
      location: "Paris, France",
      distanceKm: 20,
      elevationGain: 350,
      elevationLoss: 340,
      maxElevation: 175,
      difficulty: "moderate",
      terrainType: "mixed",
      isPublic: true,
      elevationProfile: [35, 45, 80, 120, 160, 175, 155, 130, 110, 95, 85, 70, 55, 50, 65, 90, 110, 85, 60, 40, 35],
    },
    {
      name: "UTMB CCC 100km",
      location: "Chamonix, France",
      distanceKm: 100,
      elevationGain: 6100,
      elevationLoss: 6100,
      maxElevation: 2600,
      difficulty: "ultra",
      terrainType: "trail",
      isPublic: true,
      elevationProfile: [1035, 1400, 2000, 2600, 1800, 1200, 1600, 2200, 2500, 1900, 1400, 1000, 1500, 2100, 2400, 1700, 1200, 900, 1100, 1600, 1035],
    },
    {
      name: "Central Park Loop",
      location: "New York, USA",
      distanceKm: 10,
      elevationGain: 60,
      elevationLoss: 60,
      maxElevation: 42,
      difficulty: "easy",
      terrainType: "road",
      isPublic: true,
      elevationProfile: [10, 15, 25, 35, 42, 38, 30, 20, 15, 25, 35, 28, 18, 10],
    },
    {
      name: "Mont Blanc Marathon",
      location: "Chamonix, France",
      distanceKm: 42,
      elevationGain: 2730,
      elevationLoss: 2730,
      maxElevation: 2300,
      difficulty: "hard",
      terrainType: "trail",
      isPublic: true,
      elevationProfile: [1035, 1200, 1500, 1850, 2100, 2300, 2050, 1750, 1400, 1100, 1300, 1650, 1900, 2150, 1850, 1500, 1200, 1035],
    },
    {
      name: "London Hackney Half",
      location: "London, UK",
      distanceKm: 21.1,
      elevationGain: 40,
      elevationLoss: 40,
      maxElevation: 25,
      difficulty: "easy",
      terrainType: "road",
      isPublic: true,
      elevationProfile: [5, 8, 12, 18, 22, 25, 20, 15, 10, 8, 12, 18, 22, 18, 12, 8, 5],
    },
  ];

  for (const t of trails) {
    try {
      await pool.query(
        `INSERT INTO trails (name, location, distance_km, elevation_gain, elevation_loss, max_elevation, difficulty, terrain_type, elevation_profile, is_public)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [t.name, t.location, t.distanceKm, t.elevationGain, t.elevationLoss, t.maxElevation, t.difficulty, t.terrainType, t.elevationProfile, t.isPublic]
      );
      console.log(`  ✔ ${t.name}`);
    } catch (err) {
      console.log(`  ✘ ${t.name}: ${err.message}`);
    }
  }

  console.log("\nSeed complete.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
