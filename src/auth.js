'use strict';

/**
 * Auth routes: POST /api/auth/register, /login, /logout, GET /api/auth/me.
 * Exports requireAuth middleware. bcrypt-hashed passwords, case-insensitive
 * usernames.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  getUserByUsername,
  getUserById,
  createUser,
} = require('./db');
const { validateUsername, validatePassword } = require('./validation');

const BCRYPT_ROUNDS = 10;
const router = express.Router();

function publicUser(user) {
  return { username: user.username, role: user.role };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function requireAuth(req, res, next) {
  try {
    const userId = req.session && req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const user = await getUserById(userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not signed in.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) return res.status(400).json({ error: usernameError });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const cleanUsername = String(username).trim();
    if (await getUserByUsername(cleanUsername)) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const passwordHash = bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
    const ownerName = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
    const role =
      ownerName && cleanUsername.toLowerCase() === ownerName ? 'owner' : 'player';
    const user = await createUser(cleanUsername, passwordHash, role);

    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password required.' });
    }
    const user = await getUserByUsername(String(username).trim());
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    // Promote to owner if OWNER_USERNAME matches (lets the owner claim the
    // role after registering, without a password ever living in env).
    const ownerName = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
    let role = user.role;
    if (ownerName && user.username.toLowerCase() === ownerName && role !== 'owner') {
      const { setUserRole } = require('./db');
      await setUserRole(user.id, 'owner');
      role = 'owner';
    }
    req.session.userId = user.id;
    res.json({ user: { username: user.username, role } });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { authRouter: router, requireAuth };
