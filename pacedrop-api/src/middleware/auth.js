const jwt = require("jsonwebtoken");
const { query } = require("../config/database");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// Generate access + refresh token pair
function generateTokens(user) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "15m" }
  );

  const refreshToken = jwt.sign(
    { sub: user.id, type: "refresh" },
    JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d" }
  );

  return { accessToken, refreshToken };
}

// Verify access token and attach user to req
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await query("SELECT id, email, display_name, avatar_url FROM users WHERE id = $1 AND is_active = TRUE", [payload.sub]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "User not found or deactivated" });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Optional auth — attaches user if token present, continues either way
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const result = await query("SELECT id, email, display_name, avatar_url FROM users WHERE id = $1 AND is_active = TRUE", [payload.sub]);
    if (result.rows.length > 0) req.user = result.rows[0];
  } catch {
    // Token invalid/expired — proceed without user
  }
  next();
}

module.exports = { generateTokens, requireAuth, optionalAuth, JWT_SECRET };
