'use strict';

/**
 * Star Circuit — Express server entry point (PostgreSQL backend).
 * Boot order: connect -> run migrations -> listen.
 * Mirrors the proven King of Project stack: helmet, rate-limited auth,
 * PostgreSQL-backed sessions, static frontend.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

const createSessionStore = require('./src/sessionStore');
const { pool, usingMemory, migrate, closePool } = require('./src/db');
const { authRouter } = require('./src/auth');
const { gameRouter } = require('./src/gameApi');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(helmet());
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = 'dev-secret-change-me';
  console.warn(
    '[warn] SESSION_SECRET is not set; using an insecure default. ' +
      'Set SESSION_SECRET in production.'
  );
}
app.use(
  session({
    // Production: PostgreSQL session store. Local dev (pg-mem): fall back to
    // express-session's in-memory store — connect-pg-simple needs real
    // Postgres catalog functions pg-mem doesn't implement.
    store: usingMemory ? undefined : createSessionStore(session, pool),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests. Try again in a minute.' },
});
app.use('/api/auth/', authLimiter);

app.use('/api/auth', authRouter);
app.use('/api', gameRouter);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Body too large.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Server error.' });
});

async function boot() {
  await migrate();
  console.log('[db] migrations applied');
  const server = app.listen(PORT, () => {
    console.log(`[star-circuit] listening on :${PORT} (${NODE_ENV})`);
  });

  const shutdown = async () => {
    console.log('[star-circuit] shutting down');
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

boot().catch((err) => {
  console.error('[fatal] failed to boot:', err);
  process.exit(1);
});
