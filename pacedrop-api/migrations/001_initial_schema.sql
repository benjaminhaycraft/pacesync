-- PaceDrop Database Schema
-- PostgreSQL 15+
-- Migration 001: Initial Schema

BEGIN;

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS & AUTHENTICATION
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE,
    password_hash   VARCHAR(255),          -- bcrypt hash; NULL for SSO-only users
    display_name    VARCHAR(100) NOT NULL,
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_users_email ON users (email);

-- Linked OAuth identities (one user can have multiple providers)
CREATE TABLE oauth_identities (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'spotify', 'strava', 'apple')),
    provider_uid    VARCHAR(255) NOT NULL,  -- provider's user ID
    access_token    TEXT,
    refresh_token   TEXT,
    token_expires   TIMESTAMPTZ,
    profile_data    JSONB DEFAULT '{}',     -- raw profile from provider
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_uid)
);

CREATE INDEX idx_oauth_user ON oauth_identities (user_id);
CREATE INDEX idx_oauth_provider ON oauth_identities (provider, provider_uid);

-- Refresh tokens for JWT rotation
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL UNIQUE,
    device_info     VARCHAR(255),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- ============================================================
-- USER PREFERENCES & PERFORMANCE MODEL
-- ============================================================

CREATE TABLE user_settings (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    units               VARCHAR(10) NOT NULL DEFAULT 'metric' CHECK (units IN ('metric', 'imperial')),
    default_music_mode  VARCHAR(20) DEFAULT 'my-taste',
    preferred_genres    TEXT[] DEFAULT '{}',
    base_bpm            INT DEFAULT 160,
    theme               VARCHAR(20) DEFAULT 'dark',
    notifications       BOOLEAN DEFAULT TRUE,
    extra               JSONB DEFAULT '{}',     -- future-proof catch-all
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE personal_models (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_pace       REAL NOT NULL,              -- min/km at 0% grade
    grade_coeff     REAL NOT NULL,              -- pace sensitivity to grade
    base_cadence    REAL NOT NULL,              -- steps/min at 0% grade
    cadence_grade_coeff REAL NOT NULL,          -- cadence sensitivity to grade
    avg_hr          REAL,
    hr_zones        JSONB,                      -- { z1: [100,120], z2: [120,140], ... }
    vo2max_est      REAL,
    training_load   REAL,
    model_version   INT NOT NULL DEFAULT 1,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source          VARCHAR(20) DEFAULT 'strava' CHECK (source IN ('strava', 'garmin', 'manual')),
    UNIQUE (user_id, model_version)
);

CREATE INDEX idx_personal_models_user ON personal_models (user_id);

-- ============================================================
-- TRAILS & RACE LIBRARY
-- ============================================================

-- System trails (global library) + user-added custom trails
CREATE TABLE trails (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system trail
    name            VARCHAR(200) NOT NULL,
    location        VARCHAR(200),
    distance_km     REAL NOT NULL,
    elevation_gain  REAL,                       -- meters
    elevation_loss  REAL,
    max_elevation   REAL,
    difficulty      VARCHAR(20) CHECK (difficulty IN ('easy', 'moderate', 'hard', 'ultra')),
    terrain_type    VARCHAR(50),                -- trail, road, mixed
    elevation_profile REAL[] DEFAULT '{}',      -- array of elevation points
    gpx_data        TEXT,                       -- raw GPX XML for re-parsing
    coordinates     JSONB,                      -- [[lat,lng], ...] polyline
    tags            TEXT[] DEFAULT '{}',
    is_public       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trails_user ON trails (user_id);
CREATE INDEX idx_trails_public ON trails (is_public) WHERE is_public = TRUE;
CREATE INDEX idx_trails_name ON trails USING GIN (to_tsvector('english', name));

-- ============================================================
-- RACE PLANS
-- ============================================================

CREATE TABLE race_plans (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trail_id        UUID REFERENCES trails(id) ON DELETE SET NULL,
    model_id        UUID REFERENCES personal_models(id) ON DELETE SET NULL,
    name            VARCHAR(200) NOT NULL,
    strategy        VARCHAR(30) NOT NULL DEFAULT 'constant_effort'
                    CHECK (strategy IN ('constant_effort', 'negative_split', 'positive_split', 'even_pace')),
    target_time_min REAL,                       -- target finish in minutes
    est_time_min    REAL,                       -- estimated finish
    avg_pace        REAL,                       -- min/km
    total_segments  INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_race_plans_user ON race_plans (user_id);
CREATE INDEX idx_race_plans_trail ON race_plans (trail_id);

CREATE TABLE race_plan_segments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    race_plan_id    UUID NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
    segment_index   INT NOT NULL,
    distance_m      REAL NOT NULL,
    gradient        REAL NOT NULL,              -- fraction: 0.05 = 5%
    elev_gain       REAL,
    target_pace     REAL NOT NULL,              -- min/km
    target_bpm      INT NOT NULL,
    target_cadence  INT,
    target_hr       INT,
    hr_zone         INT,
    emotional_zone  VARCHAR(30),                -- 'warm_up', 'push', 'cruise', 'finish_strong'
    fatigue_factor  REAL DEFAULT 1.0,
    UNIQUE (race_plan_id, segment_index)
);

CREATE INDEX idx_race_segments_plan ON race_plan_segments (race_plan_id);

-- ============================================================
-- PLAYLISTS & TRACKS
-- ============================================================

CREATE TABLE playlists (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    race_plan_id    UUID REFERENCES race_plans(id) ON DELETE SET NULL,
    trail_id        UUID REFERENCES trails(id) ON DELETE SET NULL,
    name            VARCHAR(200) NOT NULL,
    music_mode      VARCHAR(20) NOT NULL DEFAULT 'my-taste'
                    CHECK (music_mode IN ('my-taste', 'mood', 'random', 'generic')),
    total_tracks    INT NOT NULL DEFAULT 0,
    total_duration  INT,                        -- seconds
    spotify_playlist_id VARCHAR(50),            -- if saved to Spotify
    spotify_url     TEXT,
    cover_image_url TEXT,
    is_favorite     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_playlists_user ON playlists (user_id);
CREATE INDEX idx_playlists_trail ON playlists (trail_id);
CREATE INDEX idx_playlists_favorite ON playlists (user_id, is_favorite) WHERE is_favorite = TRUE;

CREATE TABLE playlist_tracks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    playlist_id     UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    segment_index   INT NOT NULL,
    track_name      VARCHAR(300) NOT NULL,
    artist_name     VARCHAR(300) NOT NULL,
    spotify_uri     VARCHAR(100),
    spotify_id      VARCHAR(50),
    album_name      VARCHAR(300),
    album_art_url   TEXT,
    bpm             INT,
    target_bpm      INT,                        -- what we asked for
    popularity      INT,
    score           REAL,                       -- algorithm score (0-100)
    duration_ms     INT,
    preview_url     TEXT,
    pace_per_km     REAL,                       -- the pace this segment targets
    gradient        REAL,
    terrain_label   VARCHAR(10),                -- 'uphill', 'downhill', 'flat'
    UNIQUE (playlist_id, segment_index)
);

CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks (playlist_id);

-- ============================================================
-- ACTIVITIES (Strava / Garmin imports)
-- ============================================================

CREATE TABLE activities (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source              VARCHAR(20) NOT NULL CHECK (source IN ('strava', 'garmin', 'manual', 'gpx')),
    external_id         VARCHAR(100),           -- Strava activity ID, etc.
    name                VARCHAR(200),
    activity_type       VARCHAR(30) DEFAULT 'run',
    date                DATE NOT NULL,
    distance_km         REAL,
    duration_sec        INT,
    elevation_gain      REAL,
    avg_pace            REAL,                   -- min/km
    avg_hr              REAL,
    max_hr              REAL,
    avg_cadence         REAL,
    calories            INT,
    suffer_score        INT,
    splits              JSONB,                  -- per-km splits from Strava
    grade_pace_pairs    JSONB,                  -- [[grade, pace], ...] for model building
    raw_data            JSONB,                  -- full API response for future use
    fingerprint         VARCHAR(50),            -- date+distance dedup key
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, fingerprint)
);

CREATE INDEX idx_activities_user ON activities (user_id);
CREATE INDEX idx_activities_date ON activities (user_id, date DESC);
CREATE INDEX idx_activities_source ON activities (source);

-- ============================================================
-- LISTENING HISTORY & SPOTIFY TASTE
-- ============================================================

CREATE TABLE spotify_taste (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    top_track_ids   TEXT[] DEFAULT '{}',
    top_artist_ids  TEXT[] DEFAULT '{}',
    top_genres      TEXT[] DEFAULT '{}',
    artist_affinity JSONB DEFAULT '{}',         -- { artistId: avgPopularity }
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)
);

CREATE INDEX idx_spotify_taste_user ON spotify_taste (user_id);

-- ============================================================
-- AUDIT LOG (lightweight)
-- ============================================================

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50) NOT NULL,           -- 'login', 'generate_playlist', 'save_plan', etc.
    entity_type VARCHAR(30),
    entity_id   UUID,
    metadata    JSONB DEFAULT '{}',
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log (user_id);
CREATE INDEX idx_audit_action ON audit_log (action);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Auto-update updated_at on modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_oauth_updated BEFORE UPDATE ON oauth_identities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_trails_updated BEFORE UPDATE ON trails
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_race_plans_updated BEFORE UPDATE ON race_plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_playlists_updated BEFORE UPDATE ON playlists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
