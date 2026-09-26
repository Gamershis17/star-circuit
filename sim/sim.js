'use strict';

/**
 * Balance simulator: plays Star Circuit with a greedy bot and reports
 * progression. Target: ~100K lifetime coins within ~15 min of active play.
 *
 * Bot: taps every 2s (tap boost), buys the cheapest affordable upgrade
 * (ship / circuit / ring), auto-merges all pairs, claims goals.
 * Run: node sim/sim.js
 */

const B = require('../public/js/balance.js');

function fmt(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.floor(n).toString();
}

function newSim() {
  const s = B.freshState();
  return {
    state: s,
    // per-ship lap progress in laps (float)
    progress: s.ships.map(() => 0),
    boostLeft: 0, // seconds of tap boost remaining
    x2Left: 0,
    x2Cd: 0,
    t: 0,
    nextTap: 0,
  };
}

function activeMult(sim) {
  let m = 1;
  if (sim.boostLeft > 0) m *= B.TAP_BOOST_MULT;
  if (sim.x2Left > 0) m *= B.X2_MULT;
  return m;
}

function earn(sim, amount) {
  sim.state.coins += amount;
  sim.state.totalEarned += amount;
}

function tryMerge(sim) {
  // Greedy: lowest tier first. Returns true if anything merged.
  let merged = true;
  let any = false;
  while (merged) {
    merged = false;
    const byTier = new Map();
    sim.state.ships.forEach((sh, i) => {
      if (!byTier.has(sh.tier)) byTier.set(sh.tier, []);
      byTier.get(sh.tier).push(i);
    });
    const tiers = [...byTier.keys()].sort((a, b) => a - b);
    for (const tier of tiers) {
      const idx = byTier.get(tier);
      if (tier >= B.TIERS - 1) continue; // max tier: pairs cannot merge
      while (idx.length >= 2) {
        const a = idx.pop();
        const b = idx.pop();
        const sa = sim.state.ships[a];
        const sb = sim.state.ships[b];
        const na = { tier: tier + 1, ring: sa.ring, angle: (sa.angle + sb.angle) / 2 };
        // remove higher index first
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        sim.state.ships.splice(hi, 1);
        sim.progress.splice(hi, 1);
        sim.state.ships.splice(lo, 1);
        sim.progress.splice(lo, 1);
        sim.state.ships.push(na);
        sim.progress.push(0);
        merged = true;
        any = true;
        break;
      }
      if (merged) break;
    }
  }
  return any;
}

function claimGoals(sim) {
  for (let i = 0; i < B.GOALS.length; i++) {
    if (sim.state.goalsClaimed.includes(i)) continue;
    if (B.GOALS[i].check(sim.state)) {
      sim.state.goalsClaimed.push(i);
      const r = B.GOALS[i].reward;
      if (r.coins) earn(sim, r.coins);
      if (r.cores) sim.state.warpCores += r.cores;
    }
  }
}

function cheapestUpgrade(sim) {
  const s = sim.state;
  const cands = [];
  const ringShips = s.ships.length;
  if (ringShips < s.rings * B.RING_CAPACITY) {
    cands.push({ kind: 'ship', cost: B.shipCost(s.shipsBought) });
  }
  if (s.circuitLevel < B.CIRCUIT_MAX) {
    cands.push({ kind: 'circuit', cost: B.circuitCost(s.circuitLevel) });
  }
  if (s.rings < 4) {
    cands.push({ kind: 'ring', cost: B.RING_COSTS[s.rings] });
  }
  cands.sort((a, b) => a.cost - b.cost);
  return cands[0] || null;
}

function buy(sim, kind) {
  const s = sim.state;
  if (kind === 'ship') {
    const cost = B.shipCost(s.shipsBought);
    if (s.coins < cost) return false;
    s.coins -= cost;
    // place on the ring with fewest ships
    const counts = new Array(s.rings).fill(0);
    for (const sh of s.ships) counts[sh.ring]++;
    let ring = 0;
    for (let i = 1; i < s.rings; i++) if (counts[i] < counts[ring]) ring = i;
    s.ships.push({ tier: 0, ring, angle: Math.random() * Math.PI * 2 });
    sim.progress.push(0);
    s.shipsBought++;
    return true;
  }
  if (kind === 'circuit') {
    const cost = B.circuitCost(s.circuitLevel);
    if (s.coins < cost || s.circuitLevel >= B.CIRCUIT_MAX) return false;
    s.coins -= cost;
    s.circuitLevel++;
    return true;
  }
  if (kind === 'ring') {
    if (s.rings >= 4) return false;
    const cost = B.RING_COSTS[s.rings];
    if (s.coins < cost) return false;
    s.coins -= cost;
    s.rings++;
    return true;
  }
  return false;
}

function tick(sim, dt) {
  const s = sim.state;
  const wm = B.warpMult(s.warpCores);
  const mult = activeMult(sim);
  const lt = B.lapTime(s.circuitLevel);
  for (let i = 0; i < s.ships.length; i++) {
    const sh = s.ships[i];
    sh.angle += (dt * Math.PI * 2) / lt;
    sim.progress[i] += dt / lt;
    while (sim.progress[i] >= 1) {
      sim.progress[i] -= 1;
      earn(sim, B.lapValue(sh.tier, s.circuitLevel, wm) * mult);
    }
  }
  sim.boostLeft = Math.max(0, sim.boostLeft - dt);
  sim.x2Left = Math.max(0, sim.x2Left - dt);
  sim.x2Cd = Math.max(0, sim.x2Cd - dt);
  // tap every 2s
  if (sim.t >= sim.nextTap) {
    sim.boostLeft = Math.min(B.TAP_BOOST_CAP_S, sim.boostLeft + B.TAP_BOOST_ADD_S);
    sim.nextTap = sim.t + 2;
  }
  // x2 toggle when ready
  if (sim.x2Cd <= 0 && sim.x2Left <= 0) {
    sim.x2Left = B.X2_DURATION_S;
    sim.x2Cd = B.X2_COOLDOWN_S;
  }
  // buy cheapest affordable
  let u = cheapestUpgrade(sim);
  while (u && s.coins >= u.cost) {
    buy(sim, u.kind);
    tryMerge(sim);
    u = cheapestUpgrade(sim);
  }
  tryMerge(sim);
  claimGoals(sim);
  sim.t += dt;
}

function run(seconds) {
  const sim = newSim();
  const dt = 0.25;
  const marks = [60, 300, 600, 900, 1200, 1800];
  let mi = 0;
  console.log('t=0: ' + sim.state.ships.length + ' ships');
  while (sim.t < seconds) {
    tick(sim, dt);
    if (mi < marks.length && sim.t >= marks[mi]) {
      const s = sim.state;
      console.log(
        `t=${marks[mi]}s: earned=${fmt(s.totalEarned)} coins=${fmt(s.coins)} ` +
          `ships=${s.ships.length} maxTier=${B.maxTier(s)} circuit=${s.circuitLevel} ` +
          `rings=${s.rings} goals=${s.goalsClaimed.length}/10 cps=${fmt(B.coinsPerSecond(s) * activeMult(sim))}`
      );
      mi++;
    }
  }
  return sim;
}

const sim = run(1800);
const earned15 = sim.state.totalEarned; // total at 30 min; 15-min mark printed above
console.log('\nTarget check: ~100K lifetime coins by t=900s (15 min active play).');
