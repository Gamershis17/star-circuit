'use strict';

/**
 * Validation helpers: usernames/passwords, save shape, and the server-side
 * anti-cheat check on submitted saves.
 *
 * validateProgress(prevSaveRow, nextState, nowMs):
 *   prevSaveRow = { state, totalEarned, warps, updatedAt } | null (fresh account)
 *   Returns null when the save is acceptable, or an error string.
 *
 * The check is deliberately generous (idle games have bursty income from goal
 * rewards and offline earnings) but bounds totalEarned growth by the
 * theoretical maximum lap income for the elapsed time at 4x boosts, plus any
 * newly-claimed goal rewards and warp allowances.
 */

const Balance = require('../public/js/balance.js');

function validateUsername(username) {
  if (typeof username !== 'string') return 'Username is required.';
  const u = username.trim();
  if (u.length < 3 || u.length > 16)
    return 'Username must be 3-16 characters.';
  if (!/^[A-Za-z0-9_]+$/.test(u))
    return 'Username may only contain letters, numbers and underscore.';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6)
    return 'Password must be at least 6 characters.';
  if (password.length > 128) return 'Password is too long.';
  return null;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Structural sanity check of a submitted state object. */
function validateStateShape(s) {
  if (!s || typeof s !== 'object') return 'Save state must be an object.';
  if (!isFiniteNumber(s.coins) || s.coins < 0 || s.coins > 1e18)
    return 'Bad coins value.';
  if (!isFiniteNumber(s.totalEarned) || s.totalEarned < 0 || s.totalEarned > 1e18)
    return 'Bad totalEarned value.';
  if (!Array.isArray(s.ships) || s.ships.length > 64)
    return 'Bad ships array.';
  if (
    !Number.isInteger(s.rings) ||
    s.rings < 1 ||
    s.rings > 4
  )
    return 'Bad rings value.';
  for (const ship of s.ships) {
    if (!ship || typeof ship !== 'object') return 'Bad ship entry.';
    if (!Number.isInteger(ship.tier) || ship.tier < 0 || ship.tier >= Balance.TIERS)
      return 'Bad ship tier.';
    if (!Number.isInteger(ship.ring) || ship.ring < 0 || ship.ring >= s.rings)
      return 'Bad ship ring.';
    if (!isFiniteNumber(ship.angle)) return 'Bad ship angle.';
  }
  if (s.ships.length > s.rings * Balance.RING_CAPACITY)
    return 'Too many ships for the owned rings.';
  if (!Number.isInteger(s.shipsBought) || s.shipsBought < 2 || s.shipsBought > 1e6)
    return 'Bad shipsBought.';
  if (s.shipsBought < s.ships.length) return 'shipsBought inconsistent';
  if (
    !Number.isInteger(s.circuitLevel) ||
    s.circuitLevel < 0 ||
    s.circuitLevel > Balance.CIRCUIT_MAX
  )
    return 'Bad circuitLevel.';
  for (const k of ['warps', 'warpCores', 'earnedAtLastWarp']) {
    if (!isFiniteNumber(s[k]) || s[k] < 0 || s[k] > 1e9)
      return 'Bad ' + k + ' value.';
  }
  if (!Array.isArray(s.goalsClaimed)) return 'Bad goalsClaimed.';
  for (const g of s.goalsClaimed) {
    if (!Number.isInteger(g) || g < 0 || g >= Balance.GOALS.length)
      return 'Bad goal index.';
  }
  if (!isFiniteNumber(s.lastSeen) || s.lastSeen < 0)
    return 'Bad lastSeen.';
  return null;
}

function goalCoinsTotal() {
  let t = 0;
  for (const g of Balance.GOALS) {
    if (g.reward && g.reward.coins) t += g.reward.coins;
  }
  return t;
}

/** Max coins the previous fleet could legitimately earn in `elapsedSec` at 4x boosts. */
function maxLapIncome(prevState, elapsedSec) {
  if (elapsedSec <= 0) return 0;
  const wm = Balance.warpMult(prevState.warpCores || 0);
  let total = 0;
  for (const ship of prevState.ships) {
    const perLap = Balance.lapValue(ship.tier, prevState.circuitLevel, wm);
    const laps = (elapsedSec / Balance.lapTime(prevState.circuitLevel)) * 4;
    total += perLap * laps;
  }
  return total;
}

function validateProgress(prevRow, next, nowMs) {
  const shapeErr = validateStateShape(next);
  if (shapeErr) return shapeErr;

  // Coins can never exceed lifetime earnings.
  if (next.coins > next.totalEarned + 1e-6)
    return 'Coins exceed lifetime earnings.';

  // Fresh account: nothing to compare against.
  if (!prevRow || !prevRow.state) return null;

  const prev = prevRow.state;
  if (next.totalEarned < prev.totalEarned - 1e-6)
    return 'Lifetime earnings went backwards.';

  const elapsedSec = Math.max(0, (nowMs - (prevRow.updatedAt || nowMs)) / 1000);

  // Newly claimed goal rewards are legitimate lump sums.
  const prevClaimed = new Set(prev.goalsClaimed || []);
  let newGoalCoins = 0;
  for (const g of next.goalsClaimed || []) {
    if (!prevClaimed.has(g)) {
      const reward = Balance.GOALS[g] && Balance.GOALS[g].reward;
      if (reward && reward.coins) newGoalCoins += reward.coins;
    }
  }

  const allowance =
    maxLapIncome(prev, elapsedSec) + newGoalCoins + 1e-9;
  const gained = next.totalEarned - prev.totalEarned;
  if (gained > allowance * 1.5 + 1000) {
    return 'Earnings exceed what is possible in the elapsed time.';
  }

  // Warp rules.
  const prevWarps = Number(prev.warps) || 0;
  const prevCores = Number(prev.warpCores) || 0;
  const nextWarps = Number(next.warps) || 0;
  const nextCores = Number(next.warpCores) || 0;
  if (nextWarps < prevWarps) return 'Warp count went backwards.';
  if (nextCores < prevCores) return 'Warp cores went backwards.';
  if (nextWarps > prevWarps) {
    const warpsAdded = nextWarps - prevWarps;
    const runEarned = next.totalEarned - (Number(prev.earnedAtLastWarp) || 0);
    if (runEarned < Balance.WARP_REQUIRE * warpsAdded)
      return 'Warp Reset requires more run earnings.';
    const allowedCores =
      Balance.warpCoresFor(Math.max(0, runEarned)) + warpsAdded; // +1/goal-10 each
    if (nextCores - prevCores > allowedCores)
      return 'Too many warp cores for the earnings.';
  }

  return null;
}

module.exports = {
  validateUsername,
  validatePassword,
  validateStateShape,
  validateProgress,
};
