/* Star Circuit — game client (browser + node, UMD).
 *
 * STRUCTURE: all pure game logic (tick math, lap completion, merge logic,
 * purchases, goals, warp, offline earnings) lives in plain functions below
 * that never touch the DOM. Browser wiring (canvas, buttons, tabs, auth)
 * happens only inside init()/boot(), which run solely when `document`
 * exists. In node, require('./app.js') exposes the logic API for testing.
 *
 * All tuning numbers come from StarBalance (js/balance.js). Nothing is
 * hardcoded here except presentation details (colors/sizes).
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StarCircuit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var B = (typeof module !== 'undefined' && module.exports)
    ? require('./balance.js')
    : (typeof StarBalance !== 'undefined' ? StarBalance : null);
  if (!B) throw new Error('StarCircuit: StarBalance not loaded');

  var TAU = Math.PI * 2;
  var MAX_RINGS = B.RING_COSTS.length; // derived: one cost entry per unlockable ring

  /* ---------------- number formatting ---------------- */

  function trim1(x) {
    // 1 decimal place, trailing ".0" removed: 1.5, 250, 99.9
    return String(x >= 100 ? Math.round(x) : parseFloat(x.toFixed(1)));
  }

  // 1.5K, 2.3M, 4.1B, 9.8T style. Values < 1000 shown plain (9.8).
  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    var neg = n < 0;
    n = Math.abs(n);
    var s;
    if (n < 1000) s = (n % 1 === 0) ? String(n) : n.toFixed(1);
    else if (n < 1e6) s = trim1(n / 1e3) + 'K';
    else if (n < 1e9) s = trim1(n / 1e6) + 'M';
    else if (n < 1e12) s = trim1(n / 1e9) + 'B';
    else if (n < 1e15) s = trim1(n / 1e12) + 'T';
    else s = n.toExponential(1);
    return (neg ? '-' : '') + s;
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  /* ---------------- core tick ---------------- */

  // Advance every ship's angle by dt (dt-based, frame-rate independent).
  // Returns array of completed laps: [{tier, ring}].
  function advanceShips(state, dt) {
    var omega = TAU / B.lapTime(state.circuitLevel);
    var laps = [];
    for (var i = 0; i < state.ships.length; i++) {
      var sh = state.ships[i];
      sh.angle += dt * omega;
      while (sh.angle >= TAU) {
        sh.angle -= TAU;
        laps.push({ tier: sh.tier, ring: sh.ring });
      }
    }
    return laps;
  }

  // Award coins for completed laps. mult = active boost multiplier.
  // Returns total coins awarded.
  function awardLaps(state, laps, mult) {
    var wm = B.warpMult(state.warpCores || 0);
    var total = 0;
    for (var i = 0; i < laps.length; i++) {
      total += B.lapValue(laps[i].tier, state.circuitLevel, wm) * mult;
    }
    state.coins += total;
    state.totalEarned += total;
    return total;
  }

  // One full tick: advance + award. Returns {laps, awarded}.
  function tick(state, dt, mult) {
    var laps = advanceShips(state, dt);
    var awarded = awardLaps(state, laps, mult == null ? 1 : mult);
    return { laps: laps, awarded: awarded };
  }

  /* ---------------- merge ---------------- */

  function angularMid(a, b) {
    var d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return (((a + d / 2) % TAU) + TAU) % TAU;
  }

  // Merge ships[i] + ships[j] (must be same tier).
  // Tier < 7: one ship of tier+1 at the angular midpoint, on i's ring.
  // Tier 7 (max) pair: nothing happens — max-tier ships cannot merge.
  function mergePair(state, i, j) {
    var a = state.ships[i], b = state.ships[j];
    if (!a || !b || i === j || a.tier !== b.tier) return { ok: false };
    var tier = a.tier, ring = a.ring, angle = angularMid(a.angle, b.angle);
    if (tier >= B.TIERS - 1) {
      return { ok: false, maxed: true, tier: tier, ring: ring, angle: angle };
    }
    state.ships.splice(Math.max(i, j), 1);
    state.ships.splice(Math.min(i, j), 1);
    state.ships.push({ tier: tier + 1, ring: ring, angle: angle });
    return { ok: true, newTier: tier + 1, ring: ring, angle: angle };
  }

  function findPair(state, tier) {
    var found = [];
    for (var i = 0; i < state.ships.length && found.length < 2; i++) {
      if (state.ships[i].tier === tier) found.push(i);
    }
    return found;
  }

  // Greedily merge all possible pairs, lowest tier first.
  // Max-tier (tier 7) pairs are skipped — they cannot merge.
  // Returns {merges, at}: `at` lists where each new ship appeared
  // (for visual effects only; merge behavior is unchanged).
  function autoMerge(state) {
    var merges = 0, changed = true, at = [];
    while (changed) {
      changed = false;
      for (var t = 0; t < B.TIERS - 1; t++) {
        for (;;) {
          var pair = findPair(state, t);
          if (pair.length < 2) break;
          var r = mergePair(state, pair[0], pair[1]);
          if (r.ok) {
            merges++;
            at.push({ tier: r.newTier, ring: r.ring, angle: r.angle });
          }
          changed = true;
        }
      }
    }
    return { merges: merges, at: at };
  }

  /* ---------------- purchases ---------------- */

  function ringCounts(state) {
    var c = [];
    for (var r = 0; r < state.rings; r++) c.push(0);
    for (var i = 0; i < state.ships.length; i++) {
      var ring = state.ships[i].ring;
      if (ring >= 0 && ring < state.rings) c[ring]++;
    }
    return c;
  }

  function buyShip(state) {
    // Cost scales with lifetime purchases (shipsBought), never current fleet.
    if (typeof state.shipsBought !== 'number') state.shipsBought = 2;
    var cost = B.shipCost(state.shipsBought);
    var counts = ringCounts(state);
    var best = -1, bestN = Infinity;
    for (var r = 0; r < counts.length; r++) {
      if (counts[r] < B.RING_CAPACITY && counts[r] < bestN) { bestN = counts[r]; best = r; }
    }
    if (best < 0) return { ok: false, reason: 'rings-full' };
    if (state.coins < cost) return { ok: false, reason: 'coins', cost: cost };
    state.coins -= cost;
    state.shipsBought++;
    state.ships.push({ tier: 0, ring: best, angle: Math.random() * TAU });
    return { ok: true, cost: cost, ring: best };
  }

  function buyRing(state) {
    if (state.rings >= MAX_RINGS) return { ok: false, reason: 'max' };
    var cost = B.RING_COSTS[state.rings]; // cost to unlock ring N (1-based) is RING_COSTS[N-1]
    if (state.coins < cost) return { ok: false, reason: 'coins', cost: cost };
    state.coins -= cost;
    state.rings++;
    return { ok: true, cost: cost, rings: state.rings };
  }

  function buyCircuit(state) {
    if (state.circuitLevel >= B.CIRCUIT_MAX) return { ok: false, reason: 'max' };
    var cost = B.circuitCost(state.circuitLevel);
    if (state.coins < cost) return { ok: false, reason: 'coins', cost: cost };
    state.coins -= cost;
    state.circuitLevel++;
    return { ok: true, cost: cost, level: state.circuitLevel };
  }

  /* ---------------- goals ---------------- */

  function goalStatus(state, idx) {
    if (state.goalsClaimed.indexOf(idx) >= 0) return 'claimed';
    return B.GOALS[idx].check(state) ? 'ready' : 'locked';
  }

  function claimGoal(state, idx) {
    if (goalStatus(state, idx) !== 'ready') return { ok: false };
    var rw = B.GOALS[idx].reward, got = {};
    if (rw.coins) {
      state.coins += rw.coins;
      state.totalEarned += rw.coins; // goal rewards count as earnings
      got.coins = rw.coins;
    }
    if (rw.cores) {
      state.warpCores = (state.warpCores || 0) + rw.cores;
      got.cores = rw.cores;
    }
    state.goalsClaimed.push(idx);
    return { ok: true, reward: got };
  }

  function nextGoal(state) {
    for (var i = 0; i < B.GOALS.length; i++) {
      if (state.goalsClaimed.indexOf(i) < 0) return { index: i, goal: B.GOALS[i] };
    }
    return null;
  }

  /* ---------------- daily login rewards ---------------- */

  // Snapshot of the daily-reward state for a save (UTC calendar days).
  // Thin wrapper over the shared B.dailyClaimInfo so client and server agree.
  function dailyStatus(st, nowMs) {
    return B.dailyClaimInfo(
      st && st.lastDailyClaim,
      st && st.dailyStreak,
      nowMs == null ? Date.now() : nowMs
    );
  }

  // Apply a daily claim to a state (guest path, and client mirror of a
  // successful server claim). Mutates st. Returns { coins, cores }.
  function applyDailyClaim(st, streak, day, todayStr) {
    var rw = B.dailyReward(day);
    st.coins = (st.coins || 0) + rw.coins;
    st.totalEarned = (st.totalEarned || 0) + rw.coins;
    if (rw.cores) st.warpCores = (st.warpCores || 0) + rw.cores;
    st.lastDailyClaim = todayStr;
    st.dailyStreak = streak;
    return { coins: rw.coins, cores: rw.cores };
  }

  // HH:MM:SS for the countdown timer.
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(h) + ':' + p(m) + ':' + p(s);
  }

  function dailyRewardText(rw) {
    var t = '+' + fmt(rw.coins) + ' coins';
    if (rw.cores) t += ' · +' + rw.cores + ' warp core';
    return t;
  }

  /* ---------------- warp (prestige) ---------------- */

  function runEarned(state) {
    return (state.totalEarned || 0) - (state.earnedAtLastWarp || 0);
  }

  function warpInfo(state) {
    var run = Math.max(0, runEarned(state));
    var can = run >= B.WARP_REQUIRE;
    var cores = B.warpCoresFor(run);
    return {
      run: run,
      can: can,
      cores: cores,
      curMult: B.warpMult(state.warpCores || 0),
      newMult: B.warpMult((state.warpCores || 0) + cores),
    };
  }

  function doWarp(state) {
    var info = warpInfo(state);
    if (!info.can) return { ok: false };
    var fresh = B.freshState();
    state.warpCores = (state.warpCores || 0) + info.cores;
    state.warps = (state.warps || 0) + 1;
    state.earnedAtLastWarp = state.totalEarned || 0;
    state.coins = 0;
    state.ships = fresh.ships;
    state.shipsBought = 2;
    state.rings = 1;
    state.circuitLevel = 0;
    state.goalsClaimed = [];
    // totalEarned, warps, warpCores persist (lifetime stats)
    return { ok: true, cores: info.cores, newMult: info.newMult };
  }

  /* ---------------- offline earnings ---------------- */

  function offlineEarnings(state, nowMs) {
    var last = state.lastSeen || nowMs;
    var elapsedS = Math.min(Math.max(0, (nowMs - last) / 1000), B.OFFLINE_CAP_S);
    if (elapsedS <= 1) return { amount: 0, elapsedS: elapsedS };
    var amount = B.coinsPerSecond(state) * B.OFFLINE_EFF * elapsedS;
    return { amount: amount, elapsedS: elapsedS };
  }

  function applyOffline(state, nowMs) {
    var o = offlineEarnings(state, nowMs);
    if (o.amount > 0) {
      state.coins += o.amount;
      state.totalEarned += o.amount;
    }
    state.lastSeen = nowMs;
    return o;
  }

  /* ---------------- boost runtime (client-only, never saved) ---------------- */

  function newRuntime() { return { boostLeft: 0, x2Left: 0, x2Cd: 0 }; }

  function rtTick(rt, dt) {
    rt.boostLeft = Math.max(0, rt.boostLeft - dt);
    rt.x2Left = Math.max(0, rt.x2Left - dt);
    if (rt.x2Left <= 0) rt.x2Cd = Math.max(0, rt.x2Cd - dt);
  }

  function totalMult(rt) {
    var m = 1;
    if (rt.boostLeft > 0) m *= B.TAP_BOOST_MULT;
    if (rt.x2Left > 0) m *= B.X2_MULT;
    return m;
  }

  function tapBoost(rt) {
    rt.boostLeft = Math.min(B.TAP_BOOST_CAP_S, rt.boostLeft + B.TAP_BOOST_ADD_S);
    return rt.boostLeft;
  }

  function toggleX2(rt) {
    if (rt.x2Left > 0) return { ok: false, state: 'active', left: rt.x2Left };
    if (rt.x2Cd > 0) return { ok: false, state: 'cooldown', left: rt.x2Cd };
    rt.x2Left = B.X2_DURATION_S;
    rt.x2Cd = B.X2_COOLDOWN_S;
    return { ok: true, state: 'active', left: rt.x2Left };
  }

  /* ---------------- save hygiene ---------------- */

  function sanitize(raw) {
    var f = B.freshState();
    if (!raw || typeof raw !== 'object') return f;
    function num(v, dflt, min, max) {
      v = Number(v);
      if (!isFinite(v)) return dflt;
      return Math.min(max, Math.max(min, v));
    }
    var s = {
      coins: num(raw.coins, 0, 0, 1e30),
      totalEarned: num(raw.totalEarned, 0, 0, 1e30),
      ships: [],
      rings: Math.floor(num(raw.rings, 1, 1, MAX_RINGS)),
      circuitLevel: Math.floor(num(raw.circuitLevel, 0, 0, B.CIRCUIT_MAX)),
      warps: Math.floor(num(raw.warps, 0, 0, 1e6)),
      warpCores: Math.floor(num(raw.warpCores, 0, 0, 1e6)),
      earnedAtLastWarp: num(raw.earnedAtLastWarp, 0, 0, 1e30),
      shipsBought: Math.floor(num(raw.shipsBought, 2, 2, 1e6)),
      goalsClaimed: [],
      lastSeen: num(raw.lastSeen, Date.now(), 0, Date.now() + 60000),
      // Daily login rewards: strict date string or null; streak counter.
      lastDailyClaim: B.isValidDayString(raw.lastDailyClaim) ? raw.lastDailyClaim : null,
      dailyStreak: Math.floor(num(raw.dailyStreak, 0, 0, 1e6)),
    };
    // Cosmetics: allowlisted ids only; anything unknown falls back to defaults
    // (mirrors the server-side allowlist in src/validation.js).
    s.cosmetics = {
      colorTheme: B.DEFAULT_COSMETICS.colorTheme,
      shipStyle: B.DEFAULT_COSMETICS.shipStyle,
    };
    var rc = raw.cosmetics;
    if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
      if (B.getTheme(rc.colorTheme)) s.cosmetics.colorTheme = rc.colorTheme;
      if (B.getStyle(rc.shipStyle)) s.cosmetics.shipStyle = rc.shipStyle;
    }
    if (Array.isArray(raw.ships)) {
      for (var i = 0; i < raw.ships.length && s.ships.length < s.rings * B.RING_CAPACITY; i++) {
        var sh = raw.ships[i];
        if (!sh || typeof sh !== 'object') continue;
        s.ships.push({
          tier: Math.floor(num(sh.tier, 0, 0, B.TIERS - 1)),
          ring: Math.floor(num(sh.ring, 0, 0, s.rings - 1)),
          angle: num(sh.angle, 0, 0, TAU) % TAU,
        });
      }
    }
    if (s.ships.length === 0) s.ships = f.ships;
    if (Array.isArray(raw.goalsClaimed)) {
      for (var g = 0; g < raw.goalsClaimed.length; g++) {
        var gi = Math.floor(Number(raw.goalsClaimed[g]));
        if (gi >= 0 && gi < B.GOALS.length && s.goalsClaimed.indexOf(gi) < 0) {
          s.goalsClaimed.push(gi);
        }
      }
    }
    return s;
  }

  /* ---------------- cosmetics (presentation only, zero gameplay effect) ---------------- */

  // Active cosmetics, always resolved against the allowlists (never trusts raw state).
  function activeCosmetics() {
    var c = (state && state.cosmetics) || {};
    return {
      colorTheme: B.getTheme(c.colorTheme) ? c.colorTheme : B.DEFAULT_COSMETICS.colorTheme,
      shipStyle: B.getStyle(c.shipStyle) ? c.shipStyle : B.DEFAULT_COSMETICS.shipStyle,
    };
  }

  // The 8 resolved tier colors for a state (pure function; testable).
  function tierColorsFor(st) {
    var c = (st && st.cosmetics) || {};
    var th = B.getTheme(c.colorTheme);
    if (th && th.colors && th.colors.length >= B.TIERS) return th.colors.slice();
    return B.TIER_COLORS.slice();
  }

  // Live tier color used by the canvas render path.
  function tierColor(tier) {
    return tierColorsFor(state)[tier] || B.TIER_COLORS[tier];
  }

  /* ---------------- public logic API ---------------- */

  var SC = {
    balance: B,
    MAX_RINGS: MAX_RINGS,
    fmt: fmt,
    fmtDur: fmtDur,
    angularMid: angularMid,
    advanceShips: advanceShips,
    awardLaps: awardLaps,
    tick: tick,
    mergePair: mergePair,
    autoMerge: autoMerge,
    ringCounts: ringCounts,
    buyShip: buyShip,
    buyRing: buyRing,
    buyCircuit: buyCircuit,
    goalStatus: goalStatus,
    claimGoal: claimGoal,
    nextGoal: nextGoal,
    runEarned: runEarned,
    warpInfo: warpInfo,
    doWarp: doWarp,
    offlineEarnings: offlineEarnings,
    applyOffline: applyOffline,
    newRuntime: newRuntime,
    rtTick: rtTick,
    totalMult: totalMult,
    tapBoost: tapBoost,
    toggleX2: toggleX2,
    sanitize: sanitize,
    tierColorsFor: tierColorsFor,
    dailyStatus: dailyStatus,
    applyDailyClaim: applyDailyClaim,
    fmtClock: fmtClock,
    dailyRewardText: dailyRewardText,
  };

  /* ================================================================
   * BROWSER UI — everything below runs only when `document` exists.
   * ================================================================ */

  var GUEST_KEY = 'starcircuit_guest';
  var SAVE_EVERY_MS = 30000;

  var el = {};          // DOM refs
  var state = null;     // save state (StarBalance shape)
  var rt = newRuntime();// client-only boost timers (never saved)
  var user = null;      // {username, role} when logged in
  var isGuest = false;
  var selected = -1;    // selected ship index for merging
  var floats = [];      // floating "+N" texts {x,y,ttl,text,color}
  var stars = null;     // prerendered starfield canvas
  var rafId = 0, lastT = 0, lastSave = 0, lastHud = 0, lastDailyUi = 0;
  var toastTimer = 0;

  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    ['auth-screen', 'game-screen', 'tab-login', 'tab-register', 'auth-user',
     'auth-pass', 'auth-error', 'auth-submit', 'guest-btn',
     'hud', 'coins', 'cps', 'cores-line', 'auth-btn',
     'goal-fill', 'goal-text',
     'panel-game', 'panel-goals', 'panel-settings', 'panel-news',
     'canvas-wrap', 'orbit',
     'boost-fill', 'boost-label', 'btn-boost',
     'btn-ship', 'btn-ring', 'btn-circuit', 'btn-merge', 'btn-x2', 'btn-warp',
     'cost-ship', 'cost-ring', 'cost-circuit', 'x2-label', 'x2-sub',
     'warp-label', 'warp-sub',
     'goals-list', 'theme-list', 'style-list', 'news-list',
     'daily-card',
     'modal', 'modal-title', 'modal-body', 'modal-ok', 'modal-cancel',
     'toast'
    ].forEach(function (id) { el[id] = $(id); });
    document.querySelectorAll('#tabs .tabbtn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
  }

  /* ---------------- tiny helpers ---------------- */

  function showToast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 2600);
  }

  var modalOkCb = null;
  function showModal(title, bodyHTML, okText, cancelText, onOk) {
    el['modal-title'].textContent = title;
    el['modal-body'].innerHTML = bodyHTML;
    el['modal-ok'].textContent = okText || 'OK';
    el['modal-cancel'].style.display = cancelText ? '' : 'none';
    el['modal-cancel'].textContent = cancelText || 'Cancel';
    modalOkCb = onOk || null;
    el.modal.classList.remove('hidden');
  }
  function hideModal() {
    el.modal.classList.add('hidden');
    modalOkCb = null;
  }

  async function api(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    var res = await fetch(path, init);
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, data: data };
  }

  /* ---------------- auth ---------------- */

  var authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    el['tab-login'].classList.toggle('active', mode === 'login');
    el['tab-register'].classList.toggle('active', mode === 'register');
    el['auth-submit'].textContent = mode === 'login' ? 'Log in' : 'Register';
    el['auth-error'].textContent = '';
    el['auth-pass'].setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  }

  function authError(msg) { el['auth-error'].textContent = msg; }

  async function doAuth() {
    var username = el['auth-user'].value.trim();
    var password = el['auth-pass'].value;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) { authError('Username: 3-16 chars, letters/numbers/_'); return; }
    if (password.length < 6) { authError('Password: min 6 characters'); return; }
    el['auth-submit'].disabled = true;
    try {
      var r = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/register',
        { method: 'POST', body: { username: username, password: password } });
      if (r.status === 200 && r.data && r.data.user) {
        startSession(r.data.user, false);
      } else if (r.status === 409) authError('That username is taken.');
      else if (r.status === 401) authError('Wrong username or password.');
      else if (r.status === 429) authError('Too many attempts — wait a minute and retry.');
      else authError((r.data && r.data.error) || 'Could not reach the server. Try again.');
    } catch (e) {
      authError('Could not reach the server. Try again.');
    }
    el['auth-submit'].disabled = false;
  }

  function playAsGuest() {
    startSession({ username: 'Guest' }, true);
  }

  /* ---------------- session / save ---------------- */

  function loadGuestState() {
    try {
      var raw = localStorage.getItem(GUEST_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    } catch (e) { /* corrupted save -> fresh */ }
    return B.freshState();
  }

  function persistGuest() {
    try { localStorage.setItem(GUEST_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
  }

  async function startSession(u, guest) {
    user = u;
    isGuest = guest;
    rt = newRuntime();
    selected = -1;
    floats = [];
    particles = [];
    shocks = [];

    if (guest) {
      state = loadGuestState();
    } else {
      var r = await api('/api/save');
      if (r.status === 401) { // session died between me() and save
        showAuthScreen();
        authError('Session expired — please log in again.');
        return;
      }
      state = sanitize(r.data && r.data.state);
    }

    // Offline earnings (contract: from lastSeen, cap + efficiency in StarBalance)
    var off = applyOffline(state, Date.now());
    if (off.amount >= 1) {
      showModal(
        'Welcome back' + (guest ? '' : ', ' + user.username) + '!',
        'While you were away (' + fmtDur(off.elapsedS) + ' at 50% efficiency):<br>' +
        '<span class="big">+' + fmt(Math.floor(off.amount)) + '</span> coins',
        'Collect', null,
        function () { showDailyModal(); } // daily popup follows the welcome-back one
      );
    } else {
      showDailyModal();
    }
    persist();

    el['auth-screen'].classList.add('hidden');
    el['game-screen'].classList.remove('hidden');
    el['auth-btn'].textContent = guest ? 'Sign in' : 'Log out';
    switchTab('game');
    refreshGoals(); refreshSettings(); refreshNews(true);

    resize();
    lastT = performance.now();
    lastSave = lastT;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

  function showAuthScreen() {
    cancelAnimationFrame(rafId);
    el['game-screen'].classList.add('hidden');
    el['auth-screen'].classList.remove('hidden');
    state = null; user = null; isGuest = false;
  }

  async function handleAuthBtn() {
    if (isGuest) {
      persistGuest();
      location.reload(); // back to auth screen; guest save stays in localStorage
      return;
    }
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* best effort */ }
    location.reload();
  }

  // Autosave: every 30s + pagehide. On 422, keep local state and keep playing.
  function persist() {
    if (!state) return;
    state.lastSeen = Date.now();
    if (isGuest) { persistGuest(); return; }
    var payload = JSON.stringify({ state: state });
    api('/api/save', { method: 'POST', body: { state: state } }).then(function (r) {
      if (r.status === 422) {
        showToast('Server rejected this save (anti-cheat) — your local game is safe, keep playing.');
      } else if (r.status === 401) {
        showToast('Session expired — progress is kept locally. Log in again to sync.');
      }
    }).catch(function () { /* offline: keep playing, retry next cycle */ });
  }

  function persistBeacon() {
    if (!state) return;
    state.lastSeen = Date.now();
    if (isGuest) { persistGuest(); return; }
    try {
      navigator.sendBeacon('/api/save', new Blob(
        [JSON.stringify({ state: state })], { type: 'application/json' }));
    } catch (e) { /* best effort */ }
  }

  /* ---------------- tabs ---------------- */

  function switchTab(name) {
    ['game', 'goals', 'settings', 'news'].forEach(function (t) {
      el['panel-' + t].classList.toggle('hidden', t !== name);
    });
    document.querySelectorAll('#tabs .tabbtn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    if (name === 'settings') refreshSettings();
    if (name === 'news') refreshNews();
    if (name === 'goals') refreshGoals();
    if (name === 'game') resize();
  }

  /* ---------------- goals panel ---------------- */

  function rewardText(rw) {
    var parts = [];
    if (rw.coins) parts.push('+' + fmt(rw.coins) + ' coins');
    if (rw.cores) parts.push('+' + rw.cores + ' warp core' + (rw.cores > 1 ? 's' : ''));
    return parts.join(' · ');
  }

  function refreshGoals() {
    if (!state) return;
    refreshDaily();
    var html = '';
    for (var i = 0; i < B.GOALS.length; i++) {
      var st = goalStatus(state, i);
      var g = B.GOALS[i];
      html += '<div class="goal-row ' + st + '"><div class="goal-num">' + (i + 1) + '</div>' +
        '<div class="goal-info"><div class="goal-text">' + g.text + '</div>' +
        '<div class="goal-reward">Reward: ' + rewardText(g.reward) + '</div></div>';
      if (st === 'claimed') html += '<div class="goal-done">CLAIMED</div>';
      else if (st === 'ready') html += '<button class="goal-claim" data-goal="' + i + '" type="button">CLAIM</button>';
      else html += '<div class="goal-locked">Locked</div>';
      html += '</div>';
    }
    el['goals-list'].innerHTML = html;
    el['goals-list'].querySelectorAll('.goal-claim').forEach(function (b) {
      b.addEventListener('click', function () {
        var idx = Number(b.getAttribute('data-goal'));
        var r = claimGoal(state, idx);
        if (r.ok) {
          var bits = [];
          if (r.reward.coins) bits.push('+' + fmt(r.reward.coins) + ' coins');
          if (r.reward.cores) bits.push('+' + r.reward.cores + ' warp core');
          showToast('Goal complete: ' + bits.join(', '));
          refreshGoals();
          persist();
        }
      });
    });
  }

  /* ---------------- daily reward card (top of Goals tab) ---------------- */

  function refreshDaily() {
    if (!state || !el['daily-card']) return;
    var info = dailyStatus(state, Date.now());
    var dots = '';
    for (var d = 1; d <= B.DAILY_CYCLE; d++) {
      var cls = 'ddot';
      if (d < info.day) cls += ' done';
      else if (d === info.day) cls += info.claimable ? ' today' : ' done';
      dots += '<span class="' + cls + '">' + d + '</span>';
    }
    var streakLine;
    if (info.claimable) {
      streakLine = info.streak >= 2
        ? '🔥 Claim now for a <b>' + info.streak + '-day streak</b>!'
        : 'Come back every day to build a streak.';
    } else {
      streakLine = '🔥 <b>' + info.streak + '-day streak</b>' + (info.streak === 1 ? '' : 's');
    }
    var html = '<div class="daily-head"><span class="daily-title">🎁 DAILY REWARD</span>' +
      '<span class="daily-day">Day ' + info.day + ' of ' + B.DAILY_CYCLE + '</span></div>' +
      '<div class="daily-dots" aria-hidden="true">' + dots + '</div>' +
      '<div class="daily-streakline">' + streakLine + '</div>';
    if (info.claimable) {
      html += '<div class="daily-reward">Today: <b>' + dailyRewardText(info.reward) + '</b></div>' +
        '<button id="daily-claim" class="daily-btn" type="button">CLAIM</button>';
    } else {
      html += '<div class="daily-reward dim">Day ' + info.day + ' claimed ✓</div>' +
        '<div class="daily-count">Next reward in <span id="daily-count">' +
        fmtClock(info.nextClaimInSec) + '</span></div>';
    }
    el['daily-card'].innerHTML = html;
    var btn = $('daily-claim');
    if (btn) btn.addEventListener('click', claimDaily);
  }

  function claimDaily() {
    if (!state) return;
    var info = dailyStatus(state, Date.now());
    if (!info.claimable) {
      showToast('Already claimed — next reward in ' + fmtClock(info.nextClaimInSec) + '.');
      return;
    }
    if (isGuest) {
      // Guest: same rules, local only.
      var rw = applyDailyClaim(state, info.streak, info.day, info.date);
      persistGuest();
      showToast('Daily reward: ' + dailyRewardText(rw));
      refreshDaily();
      return;
    }
    var btn = $('daily-claim');
    if (btn) btn.disabled = true;
    api('/api/daily/claim', { method: 'POST' }).then(function (r) {
      if (r.status === 200 && r.data && r.data.ok) {
        // Mirror the server-authoritative result locally BEFORE the next
        // autosave, so the anti-cheat never sees earnings go backwards.
        applyDailyClaim(state, r.data.streak, r.data.day, r.data.date);
        var got = r.data.reward || { coins: 0, cores: 0 };
        showToast('Daily reward: ' + dailyRewardText(got));
        updateHUD();
        persistSoon();
      } else if (r.status === 409) {
        showToast('Already claimed — come back tomorrow.');
      } else if (r.status === 401) {
        showToast('Session expired — log in again to claim.');
      } else {
        showToast((r.data && r.data.error) || 'Could not claim the daily reward.');
      }
      refreshDaily();
    }).catch(function () {
      showToast('Could not reach the server — try again.');
      refreshDaily();
    });
  }

  function showDailyModal() {
    var di = dailyStatus(state, Date.now());
    if (!di.claimable) return;
    showModal(
      '🎁 Daily Reward — Day ' + di.day,
      (di.streak >= 2 ? '🔥 <b>' + di.streak + '-day streak!</b><br>' : '') +
      'Today\'s reward:<br><span class="big">' + dailyRewardText(di.reward) + '</span>',
      'CLAIM', 'Later',
      function () { claimDaily(); }
    );
  }

  /* ---------------- settings panel (custom colors + ships) ---------------- */

  function refreshSettings() {
    if (!state) return;
    var cos = activeCosmetics();
    var i, k;
    var html = '';
    for (i = 0; i < B.COLOR_THEMES.length; i++) {
      var th = B.COLOR_THEMES[i];
      var sel = th.id === cos.colorTheme;
      html += '<button class="theme-row' + (sel ? ' selected' : '') + '" data-theme="' + th.id + '" type="button">' +
        '<span class="theme-name">' + escapeHtml(th.name) + '</span>' +
        '<span class="swatches" aria-hidden="true">';
      for (k = 0; k < th.colors.length; k++) {
        html += '<span class="sw" style="background:' + th.colors[k] + '"></span>';
      }
      html += '</span><span class="sel-mark">' + (sel ? '&#10003;' : '') + '</span></button>';
    }
    el['theme-list'].innerHTML = html;
    el['theme-list'].querySelectorAll('.theme-row').forEach(function (b) {
      b.addEventListener('click', function () { setCosmetics('colorTheme', b.getAttribute('data-theme')); });
    });

    var sh = '';
    for (i = 0; i < B.SHIP_STYLES.length; i++) {
      var st = B.SHIP_STYLES[i];
      var ssel = st.id === cos.shipStyle;
      sh += '<button class="style-row' + (ssel ? ' selected' : '') + '" data-style="' + st.id + '" type="button">' +
        '<span class="style-text"><span class="style-name">' + escapeHtml(st.name) + '</span>' +
        '<span class="style-desc">' + escapeHtml(st.desc) + '</span></span>' +
        '<span class="sel-mark">' + (ssel ? '&#10003;' : '') + '</span></button>';
    }
    el['style-list'].innerHTML = sh;
    el['style-list'].querySelectorAll('.style-row').forEach(function (b) {
      b.addEventListener('click', function () { setCosmetics('shipStyle', b.getAttribute('data-style')); });
    });
  }

  function setCosmetics(key, id) {
    if (!state) return;
    var ok = key === 'colorTheme' ? B.getTheme(id) : B.getStyle(id);
    if (!ok) return; // never accept unknown ids
    if (!state.cosmetics || typeof state.cosmetics !== 'object') {
      state.cosmetics = {
        colorTheme: B.DEFAULT_COSMETICS.colorTheme,
        shipStyle: B.DEFAULT_COSMETICS.shipStyle,
      };
    }
    if (state.cosmetics[key] === id) return; // no-op
    state.cosmetics[key] = id;
    buildShipSprites();  // re-prerender with the new look (fast, off the frame path)
    refreshSettings();   // update selection marks
    persistSoon();       // sync to server / guest storage
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- changelog ---------------- */

  var newsLoaded = false;
  async function refreshNews(force) {
    if (newsLoaded && !force) return;
    newsLoaded = true;
    el['news-list'].innerHTML = '<div class="empty-note">Loading…</div>';
    try {
      var r = await api('/api/changelog');
      var entries = (r.data && r.data.entries) || [];
      if (!entries.length) {
        el['news-list'].innerHTML = '<div class="empty-note">No news yet.</div>';
        return;
      }
      var html = '';
      entries.forEach(function (e) {
        html += '<div class="news-entry"><span class="news-ver">v' + escapeHtml(e.version) + '</span>' +
          '<span class="news-date">' + escapeHtml(e.date || '') + '</span><ul>';
        (e.notes || []).forEach(function (n) { html += '<li>' + escapeHtml(n) + '</li>'; });
        html += '</ul></div>';
      });
      el['news-list'].innerHTML = html;
    } catch (e) {
      el['news-list'].innerHTML = '<div class="empty-note">Could not load the news.</div>';
      newsLoaded = false;
    }
  }

  /* ---------------- canvas ---------------- */

  var DPR = 1, CW = 0, CH = 0, CX = 0, CY = 0, MAXR = 0;
  var ctx2d = null;            // cached 2d context of #orbit
  var nebulaCv = null;         // prerendered nebula wash
  var twinkleA = null, twinkleB = null; // prerendered twinkle layers (crossfaded)
  var shipSprites = [];        // per-tier prerendered sprites {cv, half}
  var particles = [];          // spark bursts {x,y,vx,vy,ttl,maxTtl,size,color}
  var shocks = [];             // expanding merge shockwaves {x,y,ttl,maxTtl,color}
  var MAX_PARTICLES = 140;
  var MAX_SHOCKS = 8;
  var lastLapFloatT = 0;

  // getContext guarded so logic tests (node/jsdom without canvas) never throw.
  function getCtx(cv) {
    try { return cv.getContext('2d'); } catch (e) { return null; }
  }

  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function shade(hex, f) {
    var r = Math.round(parseInt(hex.slice(1, 3), 16) * f),
        g = Math.round(parseInt(hex.slice(3, 5), 16) * f),
        b = Math.round(parseInt(hex.slice(5, 7), 16) * f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function resize() {
    var canvas = el.orbit;
    if (!canvas || el['panel-game'].classList.contains('hidden')) return;
    var wrap = el['canvas-wrap'];
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    DPR = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    CW = w; CH = h;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    CX = w / 2; CY = h / 2;
    MAXR = Math.max(40, Math.min(w, h) / 2 - 30);
    ctx2d = getCtx(canvas);
    buildStarfield();
    buildShipSprites();
  }

  // Offscreen layer canvas (CSS-pixel coordinate space), or null when
  // no 2d context is available (headless test environments).
  function makeLayer() {
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(CW * DPR));
    cv.height = Math.max(2, Math.round(CH * DPR));
    var c = getCtx(cv);
    if (!c) return null;
    c.scale(DPR, DPR);
    return { cv: cv, c: c };
  }

  function buildStarfield() {
    // base star layer
    var base = makeLayer();
    if (base) {
      var c = base.c;
      var n = Math.round((CW * CH) / 9000);
      for (var i = 0; i < n; i++) {
        var x = Math.random() * CW, y = Math.random() * CH;
        var r = Math.random() < 0.85 ? 1 : 1.8;
        c.globalAlpha = 0.25 + Math.random() * 0.55;
        c.fillStyle = Math.random() < 0.2 ? '#cfe6ff' : '#ffffff';
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();
      }
      c.globalAlpha = 1;
      stars = base.cv;
    } else { stars = null; }
    // nebula wash: large, very soft color blobs (static, subtle)
    var neb = makeLayer();
    if (neb) {
      var nc = neb.c;
      var blobs = [
        [0.20, 0.26, 0.34, '109,72,222'],
        [0.80, 0.60, 0.38, '46,110,230'],
        [0.55, 0.88, 0.30, '24,170,190'],
        [0.85, 0.12, 0.26, '220,90,160']
      ];
      for (var b = 0; b < blobs.length; b++) {
        var bx = blobs[b][0] * CW, by = blobs[b][1] * CH,
            br = blobs[b][2] * Math.max(CW, CH);
        var g = nc.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, 'rgba(' + blobs[b][3] + ',0.10)');
        g.addColorStop(1, 'rgba(' + blobs[b][3] + ',0)');
        nc.fillStyle = g;
        nc.fillRect(0, 0, CW, CH);
      }
      nebulaCv = neb.cv;
    } else { nebulaCv = null; }
    // two twinkle layers, crossfaded every frame for a shimmer effect
    twinkleA = buildTwinkles(26, false);
    twinkleB = buildTwinkles(18, true);
  }

  function buildTwinkles(count, big) {
    var L = makeLayer();
    if (!L) return null;
    var c = L.c;
    for (var i = 0; i < count; i++) {
      var x = Math.random() * CW, y = Math.random() * CH;
      var r = big ? 1.7 + Math.random() * 1.2 : 1 + Math.random() * 0.9;
      c.globalAlpha = 0.45 + Math.random() * 0.5;
      c.fillStyle = '#ffffff';
      c.fillRect(x - r * 3, y - 0.6, r * 6, 1.2); // horizontal flare
      c.fillRect(x - 0.6, y - r * 3, 1.2, r * 6); // vertical flare
      c.beginPath(); c.arc(x, y, r * 0.85, 0, TAU); c.fill();
    }
    c.globalAlpha = 1;
    return L.cv;
  }

  // Prerender each tier's ship (glow + gradient hull) once per resize so the
  // frame loop is just drawImage calls — no per-frame gradients.
  function buildShipSprites() {
    shipSprites = [];
    var s = shipSize();
    var style = activeCosmetics().shipStyle;
    for (var t = 0; t < B.TIERS; t++) {
      var half = s * 3;
      var cv = document.createElement('canvas');
      cv.width = cv.height = Math.max(4, Math.ceil(half * 2 * DPR));
      var c = getCtx(cv);
      if (!c) { shipSprites.push(null); continue; }
      c.scale(DPR, DPR);
      c.translate(half, half);
      var col = tierColor(t);
      // soft outer glow
      var g = c.createRadialGradient(0, 0, 0, 0, 0, half);
      g.addColorStop(0, hexA(col, 0.5));
      g.addColorStop(0.4, hexA(col, 0.16));
      g.addColorStop(1, hexA(col, 0));
      c.fillStyle = g;
      c.fillRect(-half, -half, half * 2, half * 2);
      // hull: white-hot core fading to tier color with a dark rim
      var bg = c.createRadialGradient(-s * 0.3, -s * 0.3, s * 0.1, 0, 0, s * 1.25);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(0.38, col);
      bg.addColorStop(1, shade(col, 0.42));
      drawShipShape(c, t, s, bg, style);
      // cockpit glint
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.beginPath(); c.arc(s * 0.28, 0, Math.max(1, s * 0.16), 0, TAU); c.fill();
      shipSprites.push({ cv: cv, half: half });
    }
  }

  function ringRadius(i) { return MAXR * (i + 1) / MAX_RINGS; }

  function shipXY(sh) {
    var r = ringRadius(sh.ring);
    return { x: CX + r * Math.cos(sh.angle), y: CY + r * Math.sin(sh.angle), r: r };
  }

  function shipSize() { return Math.max(9, Math.min(15, MAXR / 16)); }

  // Distinct canvas-drawn art per tier, in three selectable ship styles.
  // Ships point along +x (velocity). `fill` may be a color string or a CanvasGradient.
  // style: 'fleet' (original silhouettes), 'darts' (arrowhead family), 'orbs' (sphere family).
  function drawShipShape(c, tier, s, fill, style) {
    c.fillStyle = fill;
    if (style === 'darts') drawDart(c, tier, s);
    else if (style === 'orbs') drawOrb(c, tier, s);
    else drawFleet(c, tier, s);
  }

  function rimLight(c) {
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1;
    c.stroke();
  }

  function saturnRing(c, s, rx, ry, rot) {
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.4;
    c.beginPath();
    c.ellipse(0, 0, s * (rx || 1.25), s * (ry || 0.45), rot == null ? -0.5 : rot, 0, TAU);
    c.stroke();
  }

  // Original 8 silhouettes.
  function drawFleet(c, tier, s) {
    c.beginPath();
    var i, a;
    if (tier === 0) {           // Spark: triangle
      c.moveTo(s * 1.1, 0); c.lineTo(-s * 0.7, s * 0.8); c.lineTo(-s * 0.7, -s * 0.8);
    } else if (tier === 1) {    // Comet: dart
      c.moveTo(s * 1.5, 0); c.lineTo(-s * 0.5, s * 0.6); c.lineTo(-s * 0.1, 0); c.lineTo(-s * 0.5, -s * 0.6);
    } else if (tier === 2) {    // Nova: diamond
      c.moveTo(s * 1.2, 0); c.lineTo(0, s * 0.85); c.lineTo(-s * 1.2, 0); c.lineTo(0, -s * 0.85);
    } else if (tier === 3) {    // Pulsar: pentagon
      for (i = 0; i < 5; i++) {
        a = -Math.PI / 2 + i * TAU / 5;
        var px = Math.cos(a) * s, py = Math.sin(a) * s;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
    } else if (tier === 4) {    // Quasar: hexagon
      for (i = 0; i < 6; i++) {
        a = i * TAU / 6;
        var hx = Math.cos(a) * s, hy = Math.sin(a) * s;
        if (i === 0) c.moveTo(hx, hy); else c.lineTo(hx, hy);
      }
    } else if (tier === 5) {    // Nebula: ringed orb
      c.arc(0, 0, s * 0.75, 0, TAU);
    } else if (tier === 6) {    // Supernova: 5-point star
      for (i = 0; i < 10; i++) {
        a = -Math.PI / 2 + i * Math.PI / 5;
        var rr = (i % 2 === 0) ? s * 1.15 : s * 0.5;
        var sx = Math.cos(a) * rr, sy = Math.sin(a) * rr;
        if (i === 0) c.moveTo(sx, sy); else c.lineTo(sx, sy);
      }
    } else {                    // Eclipse: double orb (halo drawn separately)
      c.arc(0, 0, s * 0.8, 0, TAU);
    }
    c.closePath();
    c.fill();
    rimLight(c);
    if (tier === 5 || tier === 7) saturnRing(c, s);
  }

  // Arrowhead family — every tier a distinct dart, all pointing +x.
  function drawDart(c, tier, s) {
    function poly(pts) {
      c.beginPath();
      for (var i = 0; i < pts.length; i++) {
        if (i === 0) c.moveTo(pts[i][0] * s, pts[i][1] * s);
        else c.lineTo(pts[i][0] * s, pts[i][1] * s);
      }
      c.closePath();
      c.fill();
      rimLight(c);
    }
    var i, a, rr, px, py;
    if (tier === 0) {           // Spark: slim needle
      poly([[1.4, 0], [-0.6, 0.26], [-0.6, -0.26]]);
    } else if (tier === 1) {    // Comet: paper-plane chevron
      poly([[1.5, 0], [-0.15, 0.6], [-0.55, 0], [-0.15, -0.6]]);
    } else if (tier === 2) {    // Nova: needle with tail fins
      poly([[1.6, 0], [-0.75, 0.16], [-0.75, -0.16]]);
      poly([[-0.45, 0.1], [-0.95, 0.62], [-0.66, 0.06]]);
      poly([[-0.45, -0.1], [-0.95, -0.62], [-0.66, -0.06]]);
    } else if (tier === 3) {    // Pulsar: swept delta wings
      poly([[1.35, 0], [-0.9, 0.95], [-0.42, 0], [-0.9, -0.95]]);
    } else if (tier === 4) {    // Quasar: twin prongs
      poly([[1.4, 0.44], [-0.55, 0.64], [-0.55, 0.28]]);
      poly([[1.4, -0.44], [-0.55, -0.64], [-0.55, -0.28]]);
      poly([[0.95, 0.14], [-0.85, 0.14], [-0.85, -0.14], [0.95, -0.14]]);
    } else if (tier === 5) {    // Nebula: scimitar blade
      c.beginPath();
      c.moveTo(1.35 * s, 0.15 * s);
      c.quadraticCurveTo(0.3 * s, 0.95 * s, -0.85 * s, 0.8 * s);
      c.quadraticCurveTo(-0.15 * s, 0.3 * s, 0.95 * s, -0.3 * s);
      c.closePath();
      c.fill();
      rimLight(c);
    } else if (tier === 6) {    // Supernova: star-dart (nose + 4-point sparkle)
      poly([[1.45, 0], [-0.3, 0.34], [-0.3, -0.34]]);
      c.beginPath();
      for (i = 0; i < 8; i++) {
        a = i * Math.PI / 4;
        rr = (i % 2 === 0) ? 0.85 : 0.2;
        px = (-0.42 + Math.cos(a) * rr) * s;
        py = Math.sin(a) * rr * s;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
      rimLight(c);
    } else {                    // Eclipse: void dart + halo
      poly([[1.3, 0], [-0.7, 0.4], [-0.45, 0], [-0.7, -0.4]]);
      saturnRing(c, s, 1.35, 0.5, 0);
    }
  }

  // Sphere family — every tier a distinct orb.
  function drawOrb(c, tier, s) {
    function ball(r) {
      c.beginPath();
      c.arc(0, 0, r * s, 0, TAU);
      c.closePath();
      c.fill();
      rimLight(c);
    }
    function dot(x, y, r) {
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.beginPath();
      c.arc(x * s, y * s, r * s, 0, TAU);
      c.fill();
    }
    var i, a;
    if (tier === 0) {           // Spark: small orb
      ball(0.55);
    } else if (tier === 1) {    // Comet: orb with bright core
      ball(0.68);
      dot(0.12, 0, 0.24);
    } else if (tier === 2) {    // Nova: ringed orb
      ball(0.6);
      saturnRing(c, s);
    } else if (tier === 3) {    // Pulsar: double-ring orb
      ball(0.58);
      saturnRing(c, s, 1.25, 0.45, -0.5);
      saturnRing(c, s, 1.5, 0.55, 0.5);
    } else if (tier === 4) {    // Quasar: orb with satellites
      ball(0.66);
      for (i = 0; i < 3; i++) {
        a = 0.5 + i * TAU / 3;
        dot(Math.cos(a) * 1.15, Math.sin(a) * 1.15, 0.16);
      }
    } else if (tier === 5) {    // Nebula: great ringed orb
      ball(0.8);
      saturnRing(c, s, 1.6, 0.5, -0.5);
    } else if (tier === 6) {    // Supernova: orb with cross flares
      ball(0.72);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fillRect(-1.2 * s, -0.09 * s, 2.4 * s, 0.18 * s);
      c.fillRect(-0.09 * s, -1.2 * s, 0.18 * s, 2.4 * s);
    } else {                    // Eclipse: haloed orb
      ball(0.78);
      c.strokeStyle = 'rgba(226,232,240,0.8)';
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(0, 0, 1.18 * s, 0, TAU);
      c.stroke();
      dot(0, 0, 0.2);
    }
  }

  function draw(t) {
    var c = ctx2d;
    if (!c || !state) return;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, CW, CH);
    if (nebulaCv) c.drawImage(nebulaCv, 0, 0, CW, CH);
    if (stars) c.drawImage(stars, 0, 0, CW, CH);
    // twinkling star layers, crossfaded
    var tw = 0.5 + 0.5 * Math.sin(t / 850);
    if (twinkleA) { c.globalAlpha = 0.25 + 0.55 * tw; c.drawImage(twinkleA, 0, 0, CW, CH); }
    if (twinkleB) { c.globalAlpha = 0.8 - 0.55 * tw; c.drawImage(twinkleB, 0, 0, CW, CH); }
    c.globalAlpha = 1;

    // Central core: pulsing glow + bright dot
    var pulse = 1 + 0.1 * Math.sin(t / 520);
    var coreR = 34 * pulse;
    var core = c.createRadialGradient(CX, CY, 0, CX, CY, coreR);
    core.addColorStop(0, 'rgba(160,225,255,0.55)');
    core.addColorStop(0.5, 'rgba(125,211,252,0.18)');
    core.addColorStop(1, 'rgba(125,211,252,0)');
    c.fillStyle = core;
    c.beginPath(); c.arc(CX, CY, coreR, 0, TAU); c.fill();
    var dot = c.createRadialGradient(CX, CY, 0, CX, CY, 9 * pulse);
    dot.addColorStop(0, 'rgba(255,255,255,0.95)');
    dot.addColorStop(1, 'rgba(125,211,252,0)');
    c.fillStyle = dot;
    c.beginPath(); c.arc(CX, CY, 9 * pulse, 0, TAU); c.fill();

    // Orbit rings: bright, glowing, distinct color per ring.
    // (Player feedback: the old faint lines were hard to see.)
    var RING_COLORS = ['#7dd3fc', '#5eead4', '#c084fc', '#fbbf24'];
    var ri, rr;
    for (ri = 0; ri < MAX_RINGS; ri++) {
      rr = ringRadius(ri);
      if (ri < state.rings) {
        var rc = RING_COLORS[ri];
        // soft glow pass
        c.strokeStyle = hexA(rc, 0.16);
        c.lineWidth = 9;
        c.beginPath(); c.arc(CX, CY, rr, 0, TAU); c.stroke();
        // bright core line
        c.strokeStyle = hexA(rc, ri === 0 ? 0.75 : 0.6);
        c.lineWidth = ri === 0 ? 2.5 : 2;
        c.beginPath(); c.arc(CX, CY, rr, 0, TAU); c.stroke();
        // hot center thread for definition
        c.strokeStyle = 'rgba(255,255,255,0.28)';
        c.lineWidth = 1;
        c.beginPath(); c.arc(CX, CY, rr, 0, TAU); c.stroke();
        if (ri === 0) {
          // energy dashes travelling along the inner ring
          c.strokeStyle = 'rgba(190,235,255,0.5)';
          c.lineWidth = 2;
          c.setLineDash([3, 26]);
          c.lineDashOffset = -((t / 28) % 29);
          c.beginPath(); c.arc(CX, CY, rr, 0, TAU); c.stroke();
          c.setLineDash([]);
        }
      } else {
        // locked: faint dashed hint of what's to come
        c.strokeStyle = 'rgba(139,152,184,0.18)';
        c.lineWidth = 1.5;
        c.setLineDash([4, 9]);
        c.beginPath(); c.arc(CX, CY, rr, 0, TAU); c.stroke();
        c.setLineDash([]);
      }
    }

    var s = shipSize();

    // Engine trails: gradient-faded arcs behind each ship
    for (var ti = 0; ti < state.ships.length; ti++) {
      var sh = state.ships[ti];
      var p = shipXY(sh);
      var col = tierColor(sh.tier);
      var trailLen = 0.35 + sh.tier * 0.14;
      var tx = CX + p.r * Math.cos(sh.angle - trailLen),
          ty = CY + p.r * Math.sin(sh.angle - trailLen);
      var tg = c.createLinearGradient(tx, ty, p.x, p.y);
      tg.addColorStop(0, hexA(col, 0));
      tg.addColorStop(1, hexA(col, 0.55));
      c.strokeStyle = tg;
      c.lineWidth = Math.max(2, s * 0.3);
      c.lineCap = 'round';
      c.beginPath();
      c.arc(CX, CY, p.r, sh.angle - trailLen, sh.angle);
      c.stroke();
    }
    c.lineCap = 'butt';

    // Ships (prerendered sprites: glow + gradient hull)
    for (var si = 0; si < state.ships.length; si++) {
      var shp = state.ships[si];
      var pos = shipXY(shp);
      var color = tierColor(shp.tier);
      var heading = Math.atan2(Math.cos(shp.angle), -Math.sin(shp.angle));
      var spr = shipSprites[shp.tier];

      // pulsing selection ring
      if (si === selected) {
        var pr = s * (1.9 + 0.14 * Math.sin(t / 170));
        c.strokeStyle = 'rgba(125,211,252,0.4)';
        c.lineWidth = 7;
        c.beginPath(); c.arc(pos.x, pos.y, pr, 0, TAU); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.9)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(pos.x, pos.y, pr, 0, TAU); c.stroke();
      }
      // tier-7 halo
      if (shp.tier === B.TIERS - 1) {
        c.strokeStyle = 'rgba(226,232,240,0.55)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(pos.x, pos.y, s * 1.7, 0, TAU); c.stroke();
      }

      c.save();
      c.translate(pos.x, pos.y);
      c.rotate(heading);
      // flickering engine flame (behind the hull)
      var fl = s * (0.8 + Math.random() * 0.8);
      var fg = c.createLinearGradient(-s * 0.7, 0, -s * 0.7 - fl, 0);
      fg.addColorStop(0, 'rgba(255,255,255,0.85)');
      fg.addColorStop(0.4, hexA(color, 0.6));
      fg.addColorStop(1, hexA(color, 0));
      c.fillStyle = fg;
      c.beginPath();
      c.moveTo(-s * 0.65, s * 0.3);
      c.lineTo(-s * 0.65 - fl, 0);
      c.lineTo(-s * 0.65, -s * 0.3);
      c.closePath();
      c.fill();
      if (spr) c.drawImage(spr.cv, -spr.half, -spr.half, spr.half * 2, spr.half * 2);
      else drawShipShape(c, shp.tier, s, color, activeCosmetics().shipStyle); // fallback if prerender unavailable
      c.restore();
    }

    // merge shockwaves
    for (var qi = shocks.length - 1; qi >= 0; qi--) {
      var q = shocks[qi];
      var kq = 1 - q.ttl / q.maxTtl;
      c.globalAlpha = 0.7 * (1 - kq);
      c.strokeStyle = q.color;
      c.lineWidth = 3 * (1 - kq) + 1;
      c.beginPath(); c.arc(q.x, q.y, 10 + kq * 46, 0, TAU); c.stroke();
      c.globalAlpha = 1;
    }

    // spark particles
    for (var pi = 0; pi < particles.length; pi++) {
      var pt = particles[pi];
      c.globalAlpha = Math.max(0, pt.ttl / pt.maxTtl);
      c.fillStyle = pt.color;
      var psz = Math.max(0.6, pt.size * (pt.ttl / pt.maxTtl));
      c.fillRect(pt.x - psz / 2, pt.y - psz / 2, psz, psz);
    }
    c.globalAlpha = 1;

    // Floating texts: dark outline + bright fill for readability
    c.textAlign = 'center';
    c.font = '700 13px system-ui, sans-serif';
    for (var fi = floats.length - 1; fi >= 0; fi--) {
      var f = floats[fi];
      var k = f.ttl / f.maxTtl;
      c.globalAlpha = Math.min(1, k * 2);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(3,6,14,0.85)';
      c.strokeText(f.text, f.x, f.y);
      c.fillStyle = f.color;
      c.fillText(f.text, f.x, f.y);
      c.globalAlpha = 1;
    }
  }

  function spawnFloat(x, y, text, color) {
    floats.push({ x: x, y: y, ttl: 1.3, maxTtl: 1.3, text: text, color: color || '#fbbf24' });
    if (floats.length > 40) floats.splice(0, floats.length - 40);
  }

  function updateFloats(dt) {
    for (var i = floats.length - 1; i >= 0; i--) {
      var f = floats[i];
      f.ttl -= dt;
      f.y -= 34 * dt;
      if (f.ttl <= 0) floats.splice(i, 1);
    }
  }

  /* ---------------- particles & merge FX (visual only) ---------------- */

  function spawnBurst(x, y, color, n, speed) {
    for (var i = 0; i < (n || 22); i++) {
      if (particles.length >= MAX_PARTICLES) return;
      var a = Math.random() * TAU;
      var sp = (speed || 110) * (0.35 + Math.random() * 0.95);
      var ttl = 0.55 + Math.random() * 0.55;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        ttl: ttl, maxTtl: ttl, size: 1.6 + Math.random() * 2.6, color: color });
    }
  }

  function spawnShock(x, y, color) {
    shocks.push({ x: x, y: y, ttl: 0.45, maxTtl: 0.45, color: color || '#ffffff' });
    if (shocks.length > MAX_SHOCKS) shocks.splice(0, shocks.length - MAX_SHOCKS);
  }

  // quick ripple so the player sees a tap registered (boost taps, etc.)
  function spawnTapRipple(x, y) {
    spawnShock(x, y, '#a5e3ff');
    spawnBurst(x, y, '#7dd3fc', 6, 60);
  }

  function updateParticles(dt) {
    var i, p;
    for (i = particles.length - 1; i >= 0; i--) {
      p = particles[i];
      p.ttl -= dt;
      if (p.ttl <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      var d = Math.max(0, 1 - 2.4 * dt);
      p.vx *= d; p.vy *= d;
    }
    for (i = shocks.length - 1; i >= 0; i--) {
      shocks[i].ttl -= dt;
      if (shocks[i].ttl <= 0) shocks.splice(i, 1);
    }
  }

  // Combined merge celebration: floating tier name + spark burst + shockwave.
  function mergeFx(ring, angle, newTier) {
    var x = CX + ringRadius(ring) * Math.cos(angle);
    var y = CY + ringRadius(ring) * Math.sin(angle);
    var col = tierColor(newTier);
    spawnFloat(x, y, B.TIER_NAMES[newTier] + '!', col);
    spawnBurst(x, y, col, 24, 130);
    spawnBurst(x, y, '#ffffff', 8, 70);
    spawnShock(x, y, col);
  }

  /* ---------------- input: select / merge / tap boost ---------------- */

  function canvasPos(evt) {
    var rect = el.orbit.getBoundingClientRect();
    var cx = (evt.clientX !== undefined) ? evt.clientX : (evt.touches && evt.touches[0].clientX);
    var cy = (evt.clientY !== undefined) ? evt.clientY : (evt.touches && evt.touches[0].clientY);
    return { x: cx - rect.left, y: cy - rect.top };
  }

  function shipAt(x, y) {
    var best = -1, bestD = 26; // px hit radius
    for (var i = 0; i < state.ships.length; i++) {
      var p = shipXY(state.ships[i]);
      var d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function onCanvasTap(evt) {
    if (!state) return;
    evt.preventDefault();
    var pt = canvasPos(evt);
    // ANY tap anywhere on the canvas speeds the ships up (boost strength /
    // duration unchanged), with a ripple where the tap landed so it registers
    // visibly. Ship taps additionally keep their select/merge behavior below.
    var boostLeft = tapBoost(rt);
    el['boost-label'].textContent = 'Speed boost active: ' + Math.ceil(boostLeft) + 's (tap for more)';
    spawnTapRipple(pt.x, pt.y);
    var hit = shipAt(pt.x, pt.y);
    if (hit < 0) return; // empty space: boost only
    if (selected < 0 || selected >= state.ships.length) {
      selected = hit;
      return;
    }
    if (selected === hit) { selected = -1; return; } // tap again to deselect
    var a = state.ships[selected], b = state.ships[hit];
    if (a.tier === b.tier) {
      if (a.tier >= B.TIERS - 1) { showToast(B.TIER_NAMES[a.tier] + ' is max tier — cannot merge further.'); selected = -1; return; }
      var r = mergePair(state, selected, hit);
      if (r.ok) {
        mergeFx(r.ring, r.angle, r.newTier);
        refreshGoals();
        persistSoon();
      }
    } else {
      selected = hit; // switch selection
    }
    if (selected >= state.ships.length) selected = -1;
  }

  /* ---------------- buttons ---------------- */

  var saveQueued = false;
  function persistSoon() {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(function () { saveQueued = false; persist(); }, 1500);
  }

  function bindButtons() {
    el['btn-boost'].addEventListener('click', function () {
      // same boost as tapping the canvas — big thumb-friendly trigger
      var left = tapBoost(rt);
      el['boost-label'].textContent = 'Speed boost active: ' + Math.ceil(left) + 's (tap for more)';
    });
    el['btn-ship'].addEventListener('click', function () {
      var r = buyShip(state);
      if (r.ok) { showToast('Ship launched on ring ' + (r.ring + 1)); refreshGoals(); persistSoon(); }
      else if (r.reason === 'coins') showToast('Need ' + fmt(r.cost) + ' coins for a new ship.');
      else showToast('All rings are full — merge ships to free space.');
    });
    el['btn-ring'].addEventListener('click', function () {
      var r = buyRing(state);
      if (r.ok) { showToast('Ring ' + r.rings + ' online'); refreshGoals(); persistSoon(); }
      else if (r.reason === 'max') showToast('All ' + MAX_RINGS + ' rings already unlocked.');
      else showToast('Need ' + fmt(r.cost) + ' coins to unlock ring ' + (state.rings + 1) + '.');
    });
    el['btn-circuit'].addEventListener('click', function () {
      var r = buyCircuit(state);
      if (r.ok) { showToast('Circuit upgraded to level ' + r.level); refreshGoals(); persistSoon(); }
      else if (r.reason === 'max') showToast('Circuit at max level (' + B.CIRCUIT_MAX + ').');
      else showToast('Need ' + fmt(r.cost) + ' coins to upgrade.');
    });
    el['btn-merge'].addEventListener('click', function () {
      var r = autoMerge(state);
      selected = -1;
      if (r.merges === 0) { showToast('No mergeable pairs right now.'); return; }
      showToast('Auto-merge: ' + r.merges + ' merge' + (r.merges > 1 ? 's' : ''));
      var at = r.at || [];
      for (var i = 0; i < at.length && i < 6; i++) mergeFx(at[i].ring, at[i].angle, at[i].tier);
      refreshGoals();
      persistSoon();
    });
    el['btn-x2'].addEventListener('click', function () {
      var r = toggleX2(rt);
      if (r.ok) showToast('x2 speed engaged for 60s');
      else if (r.state === 'active') showToast('x2 already active');
      else showToast('x2 recharging: ' + fmtDur(r.left) + ' left');
    });
    el['btn-warp'].addEventListener('click', function () {
      var info = warpInfo(state);
      if (!info.can) {
        showToast('Warp needs ' + fmt(B.WARP_REQUIRE) + ' run earnings (' +
          fmt(Math.floor(info.run)) + ' so far).');
        return;
      }
      showModal(
        'Warp Reset',
        'Run earnings: <span class="hl">' + fmt(Math.floor(info.run)) + '</span><br>' +
        'Warp cores: <span class="big">+' + info.cores + '</span><br>' +
        'Multiplier: <span class="hl">&times;' + info.newMult.toFixed(2) + '</span> ' +
        '(was &times;' + info.curMult.toFixed(2) + ')<br><br>' +
        'Ships, rings and circuit reset. Cores, goals and lifetime earnings are kept.',
        'Engage Warp', 'Cancel',
        function () {
          var r = doWarp(state);
          if (r.ok) {
            selected = -1;
            showToast('Warp complete: +' + r.cores + ' cores, now x' + r.newMult.toFixed(2));
            refreshGoals();
            persist();
          }
        }
      );
    });
  }

  /* ---------------- HUD ---------------- */

  function updateHUD() {
    el.coins.textContent = fmt(Math.floor(state.coins));
    var cps = B.coinsPerSecond(state) * totalMult(rt);
    el.cps.textContent = fmt(cps) + '/s';

    var mult = B.warpMult(state.warpCores || 0);
    el['cores-line'].textContent = 'Cores ' + (state.warpCores || 0) + ' · ×' + mult.toFixed(2);

    // goal strip: "Goal (n/10): <text>"
    var claimed = state.goalsClaimed.length;
    var ng = nextGoal(state);
    el['goal-fill'].style.width = (claimed / B.GOALS.length * 100) + '%';
    el['goal-text'].textContent = ng
      ? 'Goal (' + claimed + '/' + B.GOALS.length + '): ' + ng.goal.text
      : 'All ' + B.GOALS.length + ' goals complete';

    // buttons with live costs
    var sc = B.shipCost(state.shipsBought == null ? 2 : state.shipsBought);
    el['cost-ship'].textContent = fmt(sc);
    el['btn-ship'].classList.toggle('cant', state.coins < sc);

    if (state.rings >= MAX_RINGS) {
      el['cost-ring'].textContent = 'MAX';
      el['btn-ring'].classList.add('cant');
    } else {
      var rc = B.RING_COSTS[state.rings];
      el['cost-ring'].textContent = fmt(rc);
      el['btn-ring'].classList.toggle('cant', state.coins < rc);
    }

    if (state.circuitLevel >= B.CIRCUIT_MAX) {
      el['cost-circuit'].textContent = 'MAX';
      el['btn-circuit'].classList.add('cant');
    } else {
      var cc = B.circuitCost(state.circuitLevel);
      el['cost-circuit'].textContent = 'Lv' + state.circuitLevel + ' · ' + fmt(cc);
      el['btn-circuit'].classList.toggle('cant', state.coins < cc);
    }

    // x2 button state
    if (rt.x2Left > 0) {
      el['x2-label'].textContent = 'x2 ACTIVE';
      el['x2-sub'].textContent = fmtDur(rt.x2Left);
      el['btn-x2'].classList.add('hot');
    } else if (rt.x2Cd > 0) {
      el['x2-label'].textContent = 'x2 SPEED';
      el['x2-sub'].textContent = fmtDur(rt.x2Cd);
      el['btn-x2'].classList.remove('hot');
    } else {
      el['x2-label'].textContent = 'x2 SPEED';
      el['x2-sub'].textContent = 'ready';
      el['btn-x2'].classList.add('hot');
    }

    // warp button
    var wi = warpInfo(state);
    if (wi.can) {
      el['warp-label'].textContent = 'WARP +' + wi.cores;
      el['warp-sub'].textContent = 'ready';
      el['btn-warp'].classList.add('hot');
    } else {
      el['warp-label'].textContent = 'WARP';
      el['warp-sub'].textContent = fmt(Math.floor(wi.run)) + '/' + fmt(B.WARP_REQUIRE);
      el['btn-warp'].classList.remove('hot');
    }

    // boost bar
    var bpct = rt.boostLeft > 0 ? (rt.boostLeft / B.TAP_BOOST_CAP_S * 100) : 0;
    el['boost-fill'].style.width = bpct + '%';
    if (rt.boostLeft > 0) {
      el['boost-label'].textContent = 'Speed boost: ' + Math.ceil(rt.boostLeft) + 's left' +
        (rt.x2Left > 0 ? ' · x2 stacking (x4 total)' : '');
    }

    // daily reward countdown (1s gate; re-renders the card at midnight rollover)
    var nowMs = Date.now();
    if (nowMs - lastDailyUi > 1000) {
      lastDailyUi = nowMs;
      var dc = el['daily-card'] && $('daily-count');
      if (dc) {
        var di = dailyStatus(state, nowMs);
        if (di.claimable) refreshDaily();
        else dc.textContent = fmtClock(di.nextClaimInSec);
      }
    }
  }

  /* ---------------- main loop ---------------- */

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!state) return;
    var dt = Math.min(0.25, Math.max(0, (t - lastT) / 1000)); // tab-switch safe
    lastT = t;
    rtTick(rt, dt);
    var m = totalMult(rt);
    var laps = advanceShips(state, dt);
    if (laps.length) {
      awardLaps(state, laps, m);
      // floating "+N" per lap, throttled so busy fleets don't spam
      var wm = B.warpMult(state.warpCores || 0);
      for (var i = 0; i < laps.length; i++) {
        if (t - lastLapFloatT < 110 && floats.length >= 6) break;
        lastLapFloatT = t;
        var lap = laps[i];
        var r = ringRadius(lap.ring);
        spawnFloat(CX + r * 0.7, CY - r * 0.7,
          '+' + fmt(Math.floor(B.lapValue(lap.tier, state.circuitLevel, wm) * m)),
          tierColor(lap.tier));
      }
      if (floats.length > 40) floats.splice(0, floats.length - 40);
    }
    updateFloats(dt);
    updateParticles(dt);
    draw(t);
    if (t - lastHud > 200) { lastHud = t; updateHUD(); }
    if (t - lastSave > SAVE_EVERY_MS) { lastSave = t; persist(); }
  }

  /* ---------------- init / boot ---------------- */

  function bindAuth() {
    el['tab-login'].addEventListener('click', function () { setAuthMode('login'); });
    el['tab-register'].addEventListener('click', function () { setAuthMode('register'); });
    el['auth-submit'].addEventListener('click', doAuth);
    el['auth-pass'].addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });
    el['auth-user'].addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });
    el['guest-btn'].addEventListener('click', playAsGuest);
  }

  function init() {
    cacheDom();
    bindAuth();
    bindButtons();
    el.orbit.addEventListener('click', onCanvasTap);
    el['auth-btn'].addEventListener('click', handleAuthBtn);
    el['modal-ok'].addEventListener('click', function () {
      var cb = modalOkCb;
      hideModal();
      if (cb) cb();
    });
    el['modal-cancel'].addEventListener('click', hideModal);
    window.addEventListener('resize', resize);
    window.addEventListener('pagehide', persistBeacon);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') persistBeacon();
    });
    boot();
  }

  // Read-only debug/test hook (used by automated smoke tests). Invisible to players.
  if (typeof window !== 'undefined') {
    window.__starcircuit = {
      api: SC,
      getState: function () { return state; },
      setCosmetics: setCosmetics,
      activeCosmetics: activeCosmetics,
      drawShipShape: drawShipShape,
      claimDaily: claimDaily,
    };
  }

  async function boot() {
    try {
      var me = await api('/api/auth/me');
      if (me.status === 200 && me.data && me.data.user) {
        startSession(me.data.user, false);
        return;
      }
    } catch (e) { /* offline -> show auth; guest still works */ }
    // not logged in: show auth screen (login / register / guest)
  }

  // Browser only: boot once the DOM exists. Guarded so node require() stays pure.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return SC;
});
