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
  // Returns {merges}.
  function autoMerge(state) {
    var merges = 0, changed = true;
    while (changed) {
      changed = false;
      for (var t = 0; t < B.TIERS - 1; t++) {
        for (;;) {
          var pair = findPair(state, t);
          if (pair.length < 2) break;
          mergePair(state, pair[0], pair[1]);
          merges++;
          changed = true;
        }
      }
    }
    return { merges: merges };
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
    };
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
  var rafId = 0, lastT = 0, lastSave = 0, lastHud = 0;
  var toastTimer = 0;

  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    ['auth-screen', 'game-screen', 'tab-login', 'tab-register', 'auth-user',
     'auth-pass', 'auth-error', 'auth-submit', 'guest-btn',
     'hud', 'coins', 'cps', 'cores-line', 'auth-btn',
     'goal-fill', 'goal-text',
     'panel-game', 'panel-goals', 'panel-board', 'panel-news',
     'canvas-wrap', 'orbit',
     'boost-fill', 'boost-label',
     'btn-ship', 'btn-ring', 'btn-circuit', 'btn-merge', 'btn-x2', 'btn-warp',
     'cost-ship', 'cost-ring', 'cost-circuit', 'x2-label', 'x2-sub',
     'warp-label', 'warp-sub',
     'goals-list', 'board-list', 'board-refresh', 'news-list',
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
        'Collect', null, null
      );
    }
    persist();

    el['auth-screen'].classList.add('hidden');
    el['game-screen'].classList.remove('hidden');
    el['auth-btn'].textContent = guest ? 'Sign in' : 'Log out';
    switchTab('game');
    refreshGoals(); refreshBoard(true); refreshNews(true);

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
    api('/api/save', { method: 'POST', body: state }).then(function (r) {
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
    ['game', 'goals', 'board', 'news'].forEach(function (t) {
      el['panel-' + t].classList.toggle('hidden', t !== name);
    });
    document.querySelectorAll('#tabs .tabbtn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    if (name === 'board') refreshBoard();
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

  /* ---------------- leaderboard ---------------- */

  var boardLoaded = false;
  async function refreshBoard(force) {
    if (boardLoaded && !force) return;
    boardLoaded = true;
    el['board-list'].innerHTML = '<div class="board-empty">Loading…</div>';
    try {
      var r = await api('/api/leaderboard');
      var entries = (r.data && r.data.entries) || [];
      if (!entries.length) {
        el['board-list'].innerHTML = '<div class="board-empty">No pilots on the board yet. Be the first.</div>';
        return;
      }
      var html = '';
      entries.forEach(function (e, i) {
        html += '<div class="board-row"><div class="board-rank">' + (i + 1) + '</div>' +
          '<div class="board-name">' + escapeHtml(e.username) + '</div>' +
          '<div class="board-stats">' + fmt(e.totalEarned) + ' earned<br>' + (e.warps || 0) + ' warps</div></div>';
      });
      el['board-list'].innerHTML = html;
    } catch (e) {
      el['board-list'].innerHTML = '<div class="board-empty">Could not load the leaderboard.</div>';
      boardLoaded = false;
    }
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
    el['news-list'].innerHTML = '<div class="board-empty">Loading…</div>';
    try {
      var r = await api('/api/changelog');
      var entries = (r.data && r.data.entries) || [];
      if (!entries.length) {
        el['news-list'].innerHTML = '<div class="board-empty">No news yet.</div>';
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
      el['news-list'].innerHTML = '<div class="board-empty">Could not load the news.</div>';
      newsLoaded = false;
    }
  }

  /* ---------------- canvas ---------------- */

  var DPR = 1, CW = 0, CH = 0, CX = 0, CY = 0, MAXR = 0;

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
    buildStarfield();
  }

  function buildStarfield() {
    stars = document.createElement('canvas');
    stars.width = Math.round(CW * DPR);
    stars.height = Math.round(CH * DPR);
    var c = stars.getContext('2d');
    c.scale(DPR, DPR);
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
  }

  function ringRadius(i) { return MAXR * (i + 1) / MAX_RINGS; }

  function shipXY(sh) {
    var r = ringRadius(sh.ring);
    return { x: CX + r * Math.cos(sh.angle), y: CY + r * Math.sin(sh.angle), r: r };
  }

  function shipSize() { return Math.max(9, Math.min(15, MAXR / 16)); }

  // Distinct canvas-drawn art per tier. Ships point along their velocity.
  function drawShipShape(c, tier, s, color) {
    c.fillStyle = color;
    c.strokeStyle = color;
    c.lineWidth = 1.6;
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
    if (tier === 5 || tier === 7) {
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 1.4;
      c.beginPath();
      c.ellipse(0, 0, s * 1.25, s * 0.45, -0.5, 0, TAU);
      c.stroke();
    }
  }

  function draw() {
    var canvas = el.orbit;
    var c = canvas.getContext('2d');
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, CW, CH);
    if (stars) c.drawImage(stars, 0, 0, CW, CH);

    // Central core glow
    var core = c.createRadialGradient(CX, CY, 0, CX, CY, 34);
    core.addColorStop(0, 'rgba(125,211,252,0.5)');
    core.addColorStop(1, 'rgba(125,211,252,0)');
    c.fillStyle = core;
    c.beginPath(); c.arc(CX, CY, 34, 0, TAU); c.fill();

    // Orbit rings
    for (var ri = 0; ri < state.rings; ri++) {
      c.strokeStyle = ri === 0 ? 'rgba(125,211,252,0.35)' : 'rgba(125,211,252,0.18)';
      c.lineWidth = ri === 0 ? 2 : 1.5;
      c.beginPath();
      c.arc(CX, CY, ringRadius(ri), 0, TAU);
      c.stroke();
    }

    var s = shipSize();

    // Trails (behind each ship along its orbit)
    for (var ti = 0; ti < state.ships.length; ti++) {
      var sh = state.ships[ti];
      var p = shipXY(sh);
      var col = B.TIER_COLORS[sh.tier];
      var trailLen = 0.35 + sh.tier * 0.14;
      c.strokeStyle = col;
      c.globalAlpha = 0.28;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(CX, CY, p.r, sh.angle - trailLen, sh.angle);
      c.stroke();
      c.globalAlpha = 1;
    }

    // Ships
    for (var si = 0; si < state.ships.length; si++) {
      var shp = state.ships[si];
      var pos = shipXY(shp);
      var color = B.TIER_COLORS[shp.tier];
      var heading = Math.atan2(Math.cos(shp.angle), -Math.sin(shp.angle));

      // engine glow
      var glow = c.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, s * 2.2);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.35;
      c.fillStyle = glow;
      c.beginPath(); c.arc(pos.x, pos.y, s * 2.2, 0, TAU); c.fill();
      c.globalAlpha = 1;

      // tier-7 halo
      if (shp.tier === B.TIERS - 1) {
        c.strokeStyle = 'rgba(226,232,240,0.7)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(pos.x, pos.y, s * 1.7, 0, TAU); c.stroke();
      }

      // selection highlight
      if (si === selected) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = 2;
        c.beginPath(); c.arc(pos.x, pos.y, s * 1.9, 0, TAU); c.stroke();
      }

      c.save();
      c.translate(pos.x, pos.y);
      c.rotate(heading);
      drawShipShape(c, shp.tier, s, color);
      c.restore();
    }

    // Floating "+N" texts
    c.textAlign = 'center';
    c.font = 'bold 13px system-ui, sans-serif';
    for (var fi = floats.length - 1; fi >= 0; fi--) {
      var f = floats[fi];
      var k = f.ttl / f.maxTtl;
      c.globalAlpha = Math.min(1, k * 2);
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
    var hit = shipAt(pt.x, pt.y);
    if (hit < 0) {
      // empty space: tap speed boost (2x while active)
      var left = tapBoost(rt);
      el['boost-label'].textContent = 'Speed boost active: ' + Math.ceil(left) + 's (tap for more)';
      return;
    }
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
        var p = { x: CX + ringRadius(r.ring) * Math.cos(r.angle), y: CY + ringRadius(r.ring) * Math.sin(r.angle) };
        spawnFloat(p.x, p.y, B.TIER_NAMES[r.newTier] + '!', B.TIER_COLORS[r.newTier]);
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
      // one float per lap, at the ship's current position
      for (var i = 0; i < laps.length; i++) {
        var lap = laps[i];
        var r = ringRadius(lap.ring);
        // lap completed at angle ~0; approximate with a mid-ring point is fine,
        // but we can place it near the rightmost point of the ring:
        spawnFloat(CX + r * 0.7, CY - r * 0.7,
          '+' + fmt(Math.floor(B.lapValue(lap.tier, state.circuitLevel, B.warpMult(state.warpCores || 0)) * m)),
          B.TIER_COLORS[lap.tier]);
      }
      if (floats.length > 40) floats.splice(0, floats.length - 40);
    }
    updateFloats(dt);
    draw();
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
    el['board-refresh'].addEventListener('click', function () { boardLoaded = false; refreshBoard(); });
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
