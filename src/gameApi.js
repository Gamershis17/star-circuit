'use strict';

/**
 * Game API: saves (with server-side anti-cheat validation), leaderboard,
 * changelog. Saves are otherwise client-simulated; the server bounds
 * lifetime-earnings growth by what the previous fleet could earn.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const Balance = require('../public/js/balance.js');
const { getSave, upsertSave, getLeaderboard } = require('./db');
const { requireAuth } = require('./auth');
const { validateProgress } = require('./validation');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get(
  '/save',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await getSave(req.user.id);
    if (!row || !row.state) {
      return res.json({ state: Balance.freshState() });
    }
    res.json({ state: row.state });
  })
);

router.post(
  '/save',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.body && req.body.state;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'Missing state object.' });
    }
    const now = Date.now();
    const prevRow = await getSave(req.user.id);
    const problem = validateProgress(prevRow, state, now);
    if (problem) {
      return res.status(422).json({ error: problem });
    }
    state.lastSeen = now;
    await upsertSave(
      req.user.id,
      state,
      Number(state.totalEarned) || 0,
      Number(state.warps) || 0
    );
    res.json({ ok: true });
  })
);

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const entries = await getLeaderboard(50);
    res.json({ entries });
  })
);

let changelogCache = null;
router.get('/changelog', (req, res) => {
  if (!changelogCache) {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'changelog.json'),
      'utf8'
    );
    changelogCache = JSON.parse(raw);
  }
  res.json(changelogCache);
});

// Simple liveness probe (also the Render health check path).
router.get('/health', (req, res) => {
  res.json({ ok: true, game: 'star-circuit' });
});

module.exports = { gameRouter: router };
