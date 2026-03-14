const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { body, validationResult } = require("express-validator");
const { query, getClient } = require("../config/database");
const { generateTokens, requireAuth, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

// ============================================================
// Email / Password Registration
// ============================================================

router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("displayName").trim().isLength({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, displayName } = req.body;

    try {
      // Check if email already exists
      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await query(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name`,
        [email, passwordHash, displayName]
      );

      const user = result.rows[0];

      // Create default settings
      await query("INSERT INTO user_settings (user_id) VALUES ($1)", [user.id]);

      const tokens = generateTokens(user);

      // Store refresh token hash
      const refreshHash = await bcrypt.hash(tokens.refreshToken, 6);
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, refreshHash]
      );

      // Audit log
      await query(
        `INSERT INTO audit_log (user_id, action, metadata) VALUES ($1, 'register', $2)`,
        [user.id, JSON.stringify({ method: "email" })]
      );

      res.status(201).json({
        user: { id: user.id, email: user.email, displayName: user.display_name },
        ...tokens,
      });
    } catch (err) {
      console.error("Registration error:", err);
      res.status(500).json({ error: "Registration failed" });
    }
  }
);

// ============================================================
// Email / Password Login
// ============================================================

router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    try {
      const result = await query("SELECT * FROM users WHERE email = $1 AND is_active = TRUE", [email]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const user = result.rows[0];
      if (!user.password_hash) {
        return res.status(401).json({ error: "This account uses social login. Please sign in with your linked provider." });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Update last login
      await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);

      const tokens = generateTokens(user);
      const refreshHash = await bcrypt.hash(tokens.refreshToken, 6);
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, refreshHash]
      );

      await query(
        `INSERT INTO audit_log (user_id, action, metadata) VALUES ($1, 'login', $2)`,
        [user.id, JSON.stringify({ method: "email" })]
      );

      res.json({
        user: { id: user.id, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url },
        ...tokens,
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  }
);

// ============================================================
// Token Refresh
// ============================================================

router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token type" });

    const user = await query("SELECT id, email, display_name FROM users WHERE id = $1 AND is_active = TRUE", [payload.sub]);
    if (user.rows.length === 0) return res.status(401).json({ error: "User not found" });

    // Revoke old refresh token
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [payload.sub]
    );

    const tokens = generateTokens(user.rows[0]);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 6);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [payload.sub, refreshHash]
    );

    res.json(tokens);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// ============================================================
// Logout
// ============================================================

router.post("/logout", requireAuth, async (req, res) => {
  await query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [req.user.id]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1, 'logout')`, [req.user.id]);
  res.json({ message: "Logged out" });
});

// ============================================================
// OAuth: Generic handler for SSO callback
// ============================================================

async function handleOAuthLogin(provider, providerUid, profile, tokens) {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Check if this OAuth identity already exists
    let oauthRow = await client.query(
      "SELECT * FROM oauth_identities WHERE provider = $1 AND provider_uid = $2",
      [provider, providerUid]
    );

    let userId;
    if (oauthRow.rows.length > 0) {
      // Existing user — update tokens
      userId = oauthRow.rows[0].user_id;
      await client.query(
        `UPDATE oauth_identities SET access_token = $1, refresh_token = $2, token_expires = $3, profile_data = $4, updated_at = NOW()
         WHERE provider = $5 AND provider_uid = $6`,
        [tokens.accessToken, tokens.refreshToken, tokens.expiresAt, JSON.stringify(profile), provider, providerUid]
      );
      await client.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [userId]);
    } else {
      // Check if email matches an existing user (link accounts)
      const email = profile.email || profile.emails?.[0]?.value;
      let userRow;
      if (email) {
        userRow = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      }

      if (userRow && userRow.rows.length > 0) {
        userId = userRow.rows[0].id;
      } else {
        // Create new user
        const displayName = profile.displayName || profile.name || email?.split("@")[0] || "Runner";
        const avatarUrl = profile.photos?.[0]?.value || profile.avatar || null;
        const newUser = await client.query(
          `INSERT INTO users (email, display_name, avatar_url, last_login_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
          [email, displayName, avatarUrl]
        );
        userId = newUser.rows[0].id;
        await client.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      }

      // Link OAuth identity
      await client.query(
        `INSERT INTO oauth_identities (user_id, provider, provider_uid, access_token, refresh_token, token_expires, profile_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, provider, providerUid, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, JSON.stringify(profile)]
      );
    }

    await client.query("COMMIT");

    // Fetch full user for JWT
    const user = await query("SELECT id, email, display_name FROM users WHERE id = $1", [userId]);
    return user.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
// Google OAuth
// ============================================================

if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${process.env.API_URL}/api/auth/google/callback`,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const user = await handleOAuthLogin("google", profile.id, profile, {
            accessToken,
            refreshToken,
            expiresAt: new Date(Date.now() + 3600 * 1000),
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );

  router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));

  router.get(
    "/google/callback",
    passport.authenticate("google", { session: false, failureRedirect: "/login?error=google_failed" }),
    async (req, res) => {
      const tokens = generateTokens(req.user);
      const refreshHash = await bcrypt.hash(tokens.refreshToken, 6);
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [req.user.id, refreshHash]
      );
      // Redirect to frontend with tokens in URL fragment (not query string for security)
      res.redirect(`${process.env.FRONTEND_URL}/#auth=success&accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`);
    }
  );
}

// ============================================================
// Spotify OAuth (server-side code exchange)
// ============================================================

router.post("/spotify/callback", async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code) return res.status(400).json({ error: "Authorization code required" });

  try {
    // Exchange code for tokens with Spotify
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri || process.env.FRONTEND_URL,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description || tokenData.error });
    }

    // Fetch Spotify profile
    const profileRes = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const user = await handleOAuthLogin("spotify", profile.id, {
      displayName: profile.display_name,
      email: profile.email,
      avatar: profile.images?.[0]?.url,
      spotifyUri: profile.uri,
      product: profile.product,
    }, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    });

    const jwtTokens = generateTokens(user);
    const refreshHash = await bcrypt.hash(jwtTokens.refreshToken, 6);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, refreshHash]
    );

    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      ...jwtTokens,
      spotifyAccessToken: tokenData.access_token,
      spotifyRefreshToken: tokenData.refresh_token,
    });
  } catch (err) {
    console.error("Spotify OAuth error:", err);
    res.status(500).json({ error: "Spotify authentication failed" });
  }
});

// ============================================================
// Strava OAuth (server-side code exchange)
// ============================================================

router.post("/strava/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Authorization code required" });

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.errors) {
      return res.status(400).json({ error: tokenData.message || "Strava auth failed" });
    }

    const athlete = tokenData.athlete;
    const user = await handleOAuthLogin("strava", String(athlete.id), {
      displayName: `${athlete.firstname} ${athlete.lastname}`,
      email: null, // Strava doesn't always provide email
      avatar: athlete.profile,
      city: athlete.city,
      country: athlete.country,
    }, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: new Date(tokenData.expires_at * 1000),
    });

    const jwtTokens = generateTokens(user);
    const refreshHash = await bcrypt.hash(jwtTokens.refreshToken, 6);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, refreshHash]
    );

    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      ...jwtTokens,
      stravaAccessToken: tokenData.access_token,
      stravaRefreshToken: tokenData.refresh_token,
      athlete: tokenData.athlete,
    });
  } catch (err) {
    console.error("Strava OAuth error:", err);
    res.status(500).json({ error: "Strava authentication failed" });
  }
});

// ============================================================
// Apple Sign-In (POST from frontend JS)
// ============================================================

router.post("/apple/callback", async (req, res) => {
  const { identityToken, authorizationCode, user: appleUser } = req.body;
  if (!identityToken) return res.status(400).json({ error: "Identity token required" });

  try {
    // Decode Apple identity token (in production, verify with Apple's public keys)
    const decoded = jwt.decode(identityToken);
    if (!decoded || !decoded.sub) {
      return res.status(400).json({ error: "Invalid Apple identity token" });
    }

    const profile = {
      email: decoded.email || appleUser?.email,
      displayName: appleUser?.name
        ? `${appleUser.name.firstName || ""} ${appleUser.name.lastName || ""}`.trim()
        : decoded.email?.split("@")[0] || "Runner",
    };

    const user = await handleOAuthLogin("apple", decoded.sub, profile, {
      accessToken: authorizationCode,
      refreshToken: null,
      expiresAt: null,
    });

    const jwtTokens = generateTokens(user);
    const refreshHash = await bcrypt.hash(jwtTokens.refreshToken, 6);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, refreshHash]
    );

    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      ...jwtTokens,
    });
  } catch (err) {
    console.error("Apple Sign-In error:", err);
    res.status(500).json({ error: "Apple authentication failed" });
  }
});

// ============================================================
// Get current user (verify token)
// ============================================================

router.get("/me", requireAuth, async (req, res) => {
  const settings = await query("SELECT * FROM user_settings WHERE user_id = $1", [req.user.id]);
  const providers = await query("SELECT provider, created_at FROM oauth_identities WHERE user_id = $1", [req.user.id]);

  res.json({
    user: req.user,
    settings: settings.rows[0] || null,
    linkedProviders: providers.rows.map((p) => p.provider),
  });
});

module.exports = router;
