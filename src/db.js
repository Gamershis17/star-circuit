'use strict';

/**
 * Star Circuit — PostgreSQL access.
 *
 * DATABASE_URL set   -> real Postgres (Neon in production).
 * DATABASE_URL unset -> in-memory pg-mem database (local dev / validation ONLY).
 *                      Nothing persists; the server logs a loud warning.
 *
 * Schema is applied at boot with CREATE TABLE IF NOT EXISTS.
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool;
let usingMemory = false;

if (DATABASE_URL) {
  const isLocal =
    DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
} else {
  usingMemory = true;
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const pg = db.adapters.createPg();
  pool = new pg.Pool();
  console.warn(
    '[warn] DATABASE_URL is not set; using an IN-MEMORY database. ' +
      'Accounts and saves will NOT persist across restarts. ' +
      'Set DATABASE_URL (Neon) for real persistence.'
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase_uidx ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL DEFAULT '{}',
  total_earned DOUBLE PRECISION NOT NULL DEFAULT 0,
  warps INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

async function getUserByUsername(username) {
  const r = await pool.query(
    'SELECT id, username, password_hash, role, created_at FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );
  return r.rows[0] || null;
}

async function getUserById(id) {
  const r = await pool.query(
    'SELECT id, username, role, created_at FROM users WHERE id = $1',
    [id]
  );
  return r.rows[0] || null;
}

async function createUser(username, passwordHash, role) {
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
    [username, passwordHash, role || 'player', Date.now()]
  );
  return r.rows[0];
}

async function setUserRole(userId, role) {
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
}

async function getSave(userId) {
  const r = await pool.query(
    'SELECT state_json, total_earned, warps, updated_at FROM saves WHERE user_id = $1',
    [userId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  let state = null;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    state = null;
  }
  return {
    state,
    totalEarned: Number(row.total_earned) || 0,
    warps: Number(row.warps) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

async function upsertSave(userId, state, totalEarned, warps) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO saves (user_id, state_json, total_earned, warps, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       state_json = EXCLUDED.state_json,
       total_earned = EXCLUDED.total_earned,
       warps = EXCLUDED.warps,
       updated_at = EXCLUDED.updated_at`,
    [userId, JSON.stringify(state), totalEarned, warps, now]
  );
  return now;
}

async function getLeaderboard(limit) {
  const r = await pool.query(
    `SELECT u.username, s.total_earned, s.warps
     FROM saves s JOIN users u ON u.id = s.user_id
     ORDER BY s.total_earned DESC
     LIMIT $1`,
    [Math.min(Math.max(limit || 50, 1), 100)]
  );
  return r.rows.map((row) => ({
    username: row.username,
    totalEarned: Number(row.total_earned) || 0,
    warps: Number(row.warps) || 0,
  }));
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  usingMemory,
  migrate,
  closePool,
  getUserByUsername,
  getUserById,
  createUser,
  setUserRole,
  getSave,
  upsertSave,
  getLeaderboard,
};
