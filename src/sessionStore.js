'use strict';

/** PostgreSQL-backed session store via connect-pg-simple.
 *
 * Pass a null/undefined pool (local dev without DATABASE_URL) and this
 * returns undefined, letting express-session fall back to its in-memory
 * store. Sessions then die with the process — fine for dev, never for
 * production (DATABASE_URL is required there).
 */
module.exports = function createSessionStore(session, pool) {
  if (!pool) return undefined;
  const createPgSession = require('connect-pg-simple');
  const PgStore = createPgSession(session);
  return new PgStore({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true,
  });
};
