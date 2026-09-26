/* Star Circuit — shared balance constants (browser + node, UMD).
 * Single source of truth for tuning. Server re-implements save validation
 * from these numbers; sim/sim.js plays against them. */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StarBalance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIERS = 8;
  var TIER_MULT = 2.5; // lap-value multiplier per tier

  var TIER_NAMES = ['Spark', 'Comet', 'Nova', 'Pulsar', 'Quasar', 'Nebula', 'Supernova', 'Eclipse'];
  var TIER_COLORS = [
    '#7dd3fc', // Spark  - light blue
    '#34d399', // Comet  - green
    '#fbbf24', // Nova   - gold
    '#fb7185', // Pulsar - pink/red
    '#c084fc', // Quasar - purple
    '#f472b6', // Nebula - magenta
    '#fb923c', // Supernova - orange
    '#e2e8f0', // Eclipse - white/silver
  ];

  // ---- COSMETICS (presentation only — zero gameplay effect) ----
  // The theme/style *ids* below are the server-side allowlist for the
  // `cosmetics` field in saves (see src/validation.js). Colors live here so
  // both client and server agree on the valid sets.
  var COLOR_THEMES = [
    { id: 'classic', name: 'Classic',
      colors: ['#7dd3fc', '#34d399', '#fbbf24', '#fb7185', '#c084fc', '#f472b6', '#fb923c', '#e2e8f0'] },
    { id: 'neon', name: 'Neon Nights',
      colors: ['#22d3ee', '#a3e635', '#facc15', '#f472b6', '#e879f9', '#fb7185', '#fb923c', '#f8fafc'] },
    { id: 'sunset', name: 'Sunset',
      colors: ['#fda4af', '#fdba74', '#fde047', '#fb923c', '#f43f5e', '#e879f9', '#a855f7', '#fef3c7'] },
    { id: 'ocean', name: 'Ocean',
      colors: ['#a5f3fc', '#67e8f9', '#22d3ee', '#0ea5e9', '#38bdf8', '#6366f1', '#3b82f6', '#ecfeff'] },
    { id: 'royal', name: 'Royal',
      colors: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#d8b4fe', '#e879f9', '#f0abfc', '#7c3aed', '#faf5ff'] },
    { id: 'ghost', name: 'Ghost',
      colors: ['#f8fafc', '#e2e8f0', '#cbd5e1', '#a5b4fc', '#7dd3fc', '#f0abfc', '#94a3b8', '#ffffff'] },
  ];

  var SHIP_STYLES = [
    { id: 'fleet', name: 'Fleet', desc: 'The original 8 ship silhouettes' },
    { id: 'darts', name: 'Darts', desc: 'Sleek arrowheads, tiered by wingspan' },
    { id: 'orbs',  name: 'Orbs',  desc: 'Glowing spheres, tiered by rings' },
  ];

  function getTheme(id) {
    for (var i = 0; i < COLOR_THEMES.length; i++) {
      if (COLOR_THEMES[i].id === id) return COLOR_THEMES[i];
    }
    return null;
  }

  function getStyle(id) {
    for (var i = 0; i < SHIP_STYLES.length; i++) {
      if (SHIP_STYLES[i].id === id) return SHIP_STYLES[i];
    }
    return null;
  }

  var DEFAULT_COSMETICS = { colorTheme: 'classic', shipStyle: 'fleet' };

  function tierMult(tier) {
    return Math.pow(TIER_MULT, tier);
  }

  // Coins earned per completed lap by one ship.
  function lapValue(tier, circuitLevel, warpMultiplier) {
    return 2 * tierMult(tier) * Math.pow(1.15, circuitLevel) * warpMultiplier;
  }

  // Seconds per lap.
  function lapTime(circuitLevel) {
    return 6 / Math.pow(1.1, circuitLevel);
  }

  // Cost of the next ship, driven by total ships ever bought (never decreases).
  // This is the main progression brake: expanding the fleet gets steadily pricier.
  var SHIP_COST_BASE = 100;
  var SHIP_COST_GROWTH = 1.15;
  function shipCost(totalBought) {
    return Math.ceil(SHIP_COST_BASE * Math.pow(SHIP_COST_GROWTH, totalBought));
  }

  // Cost to unlock ring N (1-based). Everyone starts with ring 1.
  var RING_COSTS = [0, 5000, 250000, 10000000];
  var RING_CAPACITY = 8; // max ships per ring

  function circuitCost(level) {
    return Math.ceil(500 * Math.pow(2.2, level));
  }
  var CIRCUIT_MAX = 60;

  // Prestige ("Warp Reset").
  var WARP_REQUIRE = 1000000; // run earnings needed before warping
  function warpCoresFor(runEarned) {
    return Math.max(1, Math.floor(runEarned / 2500000));
  }
  function warpMult(cores) {
    return 1 + 0.25 * cores;
  }

  // Tap boost + x2 toggle (cooldown-based; no ads).
  var TAP_BOOST_ADD_S = 4;    // each tap adds this many seconds
  var TAP_BOOST_CAP_S = 120;  // boost timer caps here
  var TAP_BOOST_MULT = 2;
  var X2_DURATION_S = 60;
  var X2_COOLDOWN_S = 300;
  var X2_MULT = 2;

  // Offline earnings.
  var OFFLINE_CAP_S = 8 * 3600;
  var OFFLINE_EFF = 0.5;

  // 10-goal chain. check(state) -> true when the goal is complete.
  // reward: { coins } or { cores }.
  var GOALS = [
    { text: 'Own 3 ships', reward: { coins: 150 },
      check: function (s) { return s.ships.length >= 3; } },
    { text: 'Earn 1,500 total coins', reward: { coins: 500 },
      check: function (s) { return s.totalEarned >= 1500; } },
    { text: 'Merge up to a tier 2 ship', reward: { coins: 800 },
      check: function (s) { return maxTier(s) >= 2; } },
    { text: 'Own 6 ships', reward: { coins: 2000 },
      check: function (s) { return s.ships.length >= 6; } },
    { text: 'Upgrade the circuit to level 3', reward: { coins: 4000 },
      check: function (s) { return s.circuitLevel >= 3; } },
    { text: 'Unlock ring 2', reward: { coins: 15000 },
      check: function (s) { return s.rings >= 2; } },
    { text: 'Merge up to a tier 4 ship', reward: { coins: 40000 },
      check: function (s) { return maxTier(s) >= 4; } },
    { text: 'Earn 500K total coins', reward: { coins: 100000 },
      check: function (s) { return s.totalEarned >= 500000; } },
    { text: 'Own 14 ships', reward: { coins: 25000 * 10 },
      check: function (s) { return s.ships.length >= 14; } },
    { text: 'Perform a Warp Reset', reward: { cores: 1 },
      check: function (s) { return s.warps >= 1; } },
  ];

  function maxTier(s) {
    var m = -1;
    for (var i = 0; i < s.ships.length; i++) {
      if (s.ships[i].tier > m) m = s.ships[i].tier;
    }
    return m;
  }

  // Coins per second for a state (no boosts), used for HUD + offline earnings.
  function coinsPerSecond(state) {
    var wm = warpMult(state.warpCores || 0);
    var total = 0;
    for (var i = 0; i < state.ships.length; i++) {
      var t = state.ships[i].tier;
      total += lapValue(t, state.circuitLevel, wm) / lapTime(state.circuitLevel);
    }
    return total;
  }

  function freshState() {
    return {
      coins: 0,
      totalEarned: 0,
      ships: [
        { tier: 0, ring: 0, angle: 0.0 },
        { tier: 0, ring: 0, angle: Math.PI },
      ],
      rings: 1,
      circuitLevel: 0,
      shipsBought: 2,
      warps: 0,
      warpCores: 0,
      earnedAtLastWarp: 0,
      goalsClaimed: [],
      lastSeen: Date.now(),
      cosmetics: { colorTheme: DEFAULT_COSMETICS.colorTheme, shipStyle: DEFAULT_COSMETICS.shipStyle },
    };
  }

  return {
    TIERS: TIERS,
    TIER_MULT: TIER_MULT,
    SHIP_COST_BASE: SHIP_COST_BASE,
    SHIP_COST_GROWTH: SHIP_COST_GROWTH,
    TIER_NAMES: TIER_NAMES,
    TIER_COLORS: TIER_COLORS,
    COLOR_THEMES: COLOR_THEMES,
    SHIP_STYLES: SHIP_STYLES,
    DEFAULT_COSMETICS: DEFAULT_COSMETICS,
    getTheme: getTheme,
    getStyle: getStyle,
    tierMult: tierMult,
    lapValue: lapValue,
    lapTime: lapTime,
    shipCost: shipCost,
    RING_COSTS: RING_COSTS,
    RING_CAPACITY: RING_CAPACITY,
    circuitCost: circuitCost,
    CIRCUIT_MAX: CIRCUIT_MAX,
    WARP_REQUIRE: WARP_REQUIRE,
    warpCoresFor: warpCoresFor,
    warpMult: warpMult,
    TAP_BOOST_ADD_S: TAP_BOOST_ADD_S,
    TAP_BOOST_CAP_S: TAP_BOOST_CAP_S,
    TAP_BOOST_MULT: TAP_BOOST_MULT,
    X2_DURATION_S: X2_DURATION_S,
    X2_COOLDOWN_S: X2_COOLDOWN_S,
    X2_MULT: X2_MULT,
    OFFLINE_CAP_S: OFFLINE_CAP_S,
    OFFLINE_EFF: OFFLINE_EFF,
    GOALS: GOALS,
    maxTier: maxTier,
    coinsPerSecond: coinsPerSecond,
    freshState: freshState,
  };
});
