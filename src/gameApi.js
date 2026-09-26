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

// In-flight claim locks (single process): closes the double-POST race where
// two concurrent claims could both read lastDailyClaim != today.
const dailyClaimLocks = new Set();

// Daily login reward (server-authoritative, UTC calendar days).
// 7-day cycle: day N pays 1000*N coins, day 7 also grants a warp core.
// Missing a calendar day resets the streak to 1.
router.post(
  '/daily/claim',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (dailyClaimLocks.has(req.user.id)) {
      return res.status(409).json({ error: 'Claim already in progress.' });
    }
    dailyClaimLocks.add(req.user.id);
    try {
      const now = Date.now();
      const row = await getSave(req.user.id);
      const state =
        row && row.state && typeof row.state === 'object'
          ? row.state
          : Balance.freshState();
      const info = Balance.dailyClaimInfo(
        state.lastDailyClaim,
        state.dailyStreak,
        now
      );
      if (!info.claimable) {
        return res.status(409).json({
          error: 'Daily reward already claimed — come back tomorrow.',
          nextClaimIn: info.nextClaimInSec,
        });
      }
      const rw = Balance.dailyReward(info.day);
      state.coins = (Number(state.coins) || 0) + rw.coins;
      state.totalEarned = (Number(state.totalEarned) || 0) + rw.coins;
      if (rw.cores) state.warpCores = (Number(state.warpCores) || 0) + rw.cores;
      state.lastDailyClaim = info.date;
      state.dailyStreak = info.streak;
      await upsertSave(
        req.user.id,
        state,
        Number(state.totalEarned) || 0,
        Number(state.warps) || 0
      );
      res.json({
        ok: true,
        streak: info.streak,
        day: info.day,
        reward: { coins: rw.coins, cores: rw.cores },
        date: info.date,
        nextClaimIn: Balance.secsUntilUtcMidnight(Date.now()),
      });
    } finally {
      dailyClaimLocks.delete(req.user.id);
    }
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
