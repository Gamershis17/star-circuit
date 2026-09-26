'use strict';
/* Star Circuit smoke test: zero-JS-error check for the 1.2 settings rework.
 *
 * 1. Logic level (node require): buy/merge/tick/warp/goal/boost/sanitize,
 *    cosmetics defaults + allowlists + tierColorsFor resolution.
 * 2. Real server validator (src/validation.js): cosmetics allowlist —
 *    valid ids pass, unknown ids fail, missing cosmetics stays back-compat.
 * 3. Browser wiring level (vm + stub DOM + stub canvas 2d): boot, guest
 *    session, ~120 driven frames, button clicks, canvas taps, tab switches
 *    (incl. the new Settings tab), theme/style switching, ship-shape
 *    distinctness per style, guest persistence of cosmetics.
 * 4. Source hygiene: no `board` references remain; every cacheDom id exists
 *    in index.html.
 *
 * Any thrown error or failed check fails the run. Run: node test/smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
let failures = 0;
// JS errors thrown by app code inside the stub browser (event listeners,
// DOMContentLoaded handlers, rAF frames). _fire/frames record instead of
// throwing so one bad handler can't mask the rest; the run fails at the end.
const jsErrors = [];
function calls(label, fn) {
  try { fn(); } catch (e) { jsErrors.push(label + ': ' + ((e && e.stack) || e)); }
}
function check(name, cond) {
  if (!cond) { failures++; console.error('FAIL:', name); }
  else console.log('ok:', name);
}

/* ---------------- 1. logic level ---------------- */
const SC = require('../public/js/app.js');
const B = SC.balance;

(function logic() {
  let s = B.freshState();
  check('fresh state has 2 ships', s.ships.length === 2);
  check('fresh state has default cosmetics',
    !!s.cosmetics && s.cosmetics.colorTheme === 'classic' && s.cosmetics.shipStyle === 'fleet');

  s.coins = 1e9;
  let r = SC.buyShip(s);
  check('buyShip ok', r.ok === true && s.ships.length === 3);
  r = SC.buyRing(s);
  check('buyRing ok', r.ok === true && s.rings === 2);
  r = SC.buyCircuit(s);
  check('buyCircuit ok', r.ok === true && s.circuitLevel === 1);

  // autoMerge returns merge positions for FX (behavior unchanged)
  s.ships = [{ tier: 0, ring: 0, angle: 0 }, { tier: 0, ring: 0, angle: 0.1 },
             { tier: 1, ring: 0, angle: 1 }, { tier: 1, ring: 0, angle: 1.1 }];
  const am = SC.autoMerge(s);
  check('autoMerge merges + reports positions', am.merges === 2 && Array.isArray(am.at) && am.at.length === 2);
  check('autoMerge result tiers', s.ships.length === 2 && s.ships.every(x => x.tier >= 1));

  const t0 = s.totalEarned;
  const tk = SC.tick(s, 30, 1);
  check('tick advances + awards', tk.laps.length > 0 && s.totalEarned > t0);

  const rt = SC.newRuntime();
  SC.tapBoost(rt);
  check('tapBoost engages', SC.totalMult(rt) === B.TAP_BOOST_MULT);
  const x2 = SC.toggleX2(rt);
  check('x2 toggle ok', x2.ok === true && SC.totalMult(rt) === B.TAP_BOOST_MULT * B.X2_MULT);

  check('goal 0 locked initially on fresh-ish state', SC.goalStatus(B.freshState(), 0) === 'locked');
  const g = B.freshState(); g.ships.push({ tier: 0, ring: 0, angle: 0 });
  check('claimGoal works', SC.claimGoal(g, 0).ok === true && g.goalsClaimed.indexOf(0) >= 0);

  const w = B.freshState();
  check('warp blocked early', SC.warpInfo(w).can === false && SC.doWarp(w).ok === false);

  const san = SC.sanitize({ coins: 5, ships: [{ tier: 3, ring: 0, angle: 1 }], rings: 2 });
  check('sanitize keeps valid save', san.coins === 5 && san.ships.length === 1 && san.ships[0].tier === 3);

  // --- cosmetics ---
  check('six color themes defined',
    B.COLOR_THEMES.length >= 6 && B.COLOR_THEMES.every(t => t.id && t.name && t.colors && t.colors.length === 8));
  check('three ship styles defined',
    B.SHIP_STYLES.length >= 3 && B.SHIP_STYLES.every(t => t.id && t.name));
  const cClassic = SC.tierColorsFor(B.freshState());
  check('default theme resolves classic colors', cClassic.length === 8 && cClassic[0] === '#7dd3fc');
  const neonState = B.freshState();
  neonState.cosmetics.colorTheme = 'neon';
  const cNeon = SC.tierColorsFor(neonState);
  check('theme switch changes resolved tier colors', cNeon[0] === '#22d3ee' && cNeon[0] !== cClassic[0]);
  const bogusState = B.freshState();
  bogusState.cosmetics = { colorTheme: 'hacker', shipStyle: 'nope' };
  check('tierColorsFor falls back on bogus ids',
    SC.tierColorsFor(bogusState).join() === B.TIER_COLORS.join());
  const s1 = SC.sanitize({ cosmetics: { colorTheme: 'sunset', shipStyle: 'orbs' } });
  check('sanitize keeps valid cosmetics', s1.cosmetics.colorTheme === 'sunset' && s1.cosmetics.shipStyle === 'orbs');
  const s2 = SC.sanitize({ cosmetics: { colorTheme: 'nope', shipStyle: 'nope' } });
  check('sanitize falls back on bogus cosmetics',
    s2.cosmetics.colorTheme === 'classic' && s2.cosmetics.shipStyle === 'fleet');
  const s3 = SC.sanitize({});
  check('sanitize defaults cosmetics when absent',
    s3.cosmetics.colorTheme === 'classic' && s3.cosmetics.shipStyle === 'fleet');
})();

/* ---------------- 2. real server validator ---------------- */
(function validator() {
  const V = require('../src/validation.js');
  const vs = B.freshState();
  vs.cosmetics = { colorTheme: 'neon', shipStyle: 'darts' };
  check('validator accepts valid cosmetics', V.validateProgress(null, vs, Date.now()) === null);
  const bad1 = B.freshState();
  bad1.cosmetics = { colorTheme: 'hacker', shipStyle: 'fleet' };
  check('validator rejects unknown colorTheme',
    typeof V.validateProgress(null, bad1, Date.now()) === 'string');
  const bad2 = B.freshState();
  bad2.cosmetics = { colorTheme: 'neon', shipStyle: 'x' };
  check('validator rejects unknown shipStyle',
    typeof V.validateProgress(null, bad2, Date.now()) === 'string');
  const bad3 = B.freshState();
  bad3.cosmetics = 'neon';
  check('validator rejects non-object cosmetics',
    typeof V.validateProgress(null, bad3, Date.now()) === 'string');
  const old = B.freshState();
  delete old.cosmetics;
  check('validator accepts missing cosmetics (back-compat)',
    V.validateProgress(null, old, Date.now()) === null);
  // a full save -> load roundtrip through the real validator keeps cosmetics
  const rt = B.freshState();
  rt.cosmetics = { colorTheme: 'royal', shipStyle: 'orbs' };
  rt.totalEarned = 500; rt.coins = 500;
  const prev = { state: B.freshState(), totalEarned: 0, warps: 0, updatedAt: Date.now() - 60000 };
  const problem = V.validateProgress(prev, rt, Date.now());
  check('save/load roundtrip through validator keeps cosmetics',
    problem === null && rt.cosmetics.colorTheme === 'royal');
})();

/* ---------------- 2b. daily rewards: logic + validator + sanitize ---------------- */
(function dailyUnit() {
  // reward table
  check('daily day 1 pays 1000', B.dailyReward(1).coins === 1000 && B.dailyReward(1).cores === 0);
  check('daily day 6 pays 6000', B.dailyReward(6).coins === 6000);
  check('daily day 7 pays 7000 + 1 core',
    B.dailyReward(7).coins === 7000 && B.dailyReward(7).cores === 1);
  check('dailyReward clamps out-of-range days',
    B.dailyReward(0).coins === 1000 && B.dailyReward(99).coins === 7000);

  // UTC day helpers
  var t0 = Date.UTC(2026, 8, 26, 12, 0, 0); // 2026-09-26 12:00 UTC
  check('utcDayString', B.utcDayString(t0) === '2026-09-26');
  check('utcDayString at midnight edge', B.utcDayString(Date.UTC(2026, 8, 27, 0, 0, 1)) === '2026-09-27');
  check('shiftDayString -1', B.shiftDayString('2026-09-26', -1) === '2026-09-25');
  check('shiftDayString crosses month boundary',
    B.shiftDayString('2026-10-01', -1) === '2026-09-30');
  check('shiftDayString crosses year boundary',
    B.shiftDayString('2026-01-01', -1) === '2025-12-31');
  check('isValidDayString accepts real dates', B.isValidDayString('2026-09-26') === true);
  check('isValidDayString rejects garbage',
    !B.isValidDayString('not-a-date') && !B.isValidDayString('2026-13-45') &&
    !B.isValidDayString('2026-02-30') && !B.isValidDayString('2026-9-6') &&
    !B.isValidDayString(null) && !B.isValidDayString(''));
  var secs = B.secsUntilUtcMidnight(t0);
  check('secsUntilUtcMidnight ~12h at noon UTC', secs > 11 * 3600 && secs <= 12 * 3600 + 1);
  check('secsUntilUtcMidnight always >= 1',
    B.secsUntilUtcMidnight(Date.UTC(2026, 8, 26, 23, 59, 59, 999)) >= 1);

  // claim info: fresh player
  var f = B.dailyClaimInfo(null, 0, t0);
  check('fresh player claimable day 1 streak 1',
    f.claimable === true && f.streak === 1 && f.day === 1 && f.reward.coins === 1000);
  // already claimed today
  var c = B.dailyClaimInfo('2026-09-26', 3, t0);
  check('same-day claim rejected', c.claimable === false && c.streak === 3 &&
    c.nextClaimInSec > 0 && c.nextClaimInSec <= 86400);
  // yesterday -> streak+1
  var y = B.dailyClaimInfo('2026-09-25', 3, t0);
  check('yesterday increments streak', y.claimable === true && y.streak === 4 && y.day === 4);
  // gap -> reset
  var g = B.dailyClaimInfo('2026-09-20', 5, t0);
  check('gap resets streak to 1', g.claimable === true && g.streak === 1 && g.day === 1);
  // day 7 -> cycle restarts at streak 8
  var w = B.dailyClaimInfo('2026-09-25', 7, t0);
  check('post-day-7 restarts cycle', w.claimable === true && w.streak === 8 && w.day === 1);
  // garbage last claim -> treated as fresh
  var gb = B.dailyClaimInfo('garbage', 9, t0);
  check('garbage lastDailyClaim treated as fresh', gb.claimable === true && gb.streak === 1);
  // future date (clock skew) -> safe reset, still claimable
  var fu = B.dailyClaimInfo('2026-09-27', 4, t0);
  check('future lastDailyClaim resets safely', fu.claimable === true && fu.streak === 1);

  // applyDailyClaim
  var s = B.freshState();
  var rw = SC.applyDailyClaim(s, 2, 2, '2026-09-26');
  check('applyDailyClaim pays + sets fields',
    rw.coins === 2000 && s.coins === 2000 && s.totalEarned === 2000 &&
    s.lastDailyClaim === '2026-09-26' && s.dailyStreak === 2 && s.warpCores === 0);
  var s7 = B.freshState();
  SC.applyDailyClaim(s7, 7, 7, '2026-09-26');
  check('applyDailyClaim day 7 grants core', s7.warpCores === 1 && s7.coins === 7000);

  // validator: daily fields
  const V = require('../src/validation.js');
  var vs = B.freshState();
  vs.lastDailyClaim = '2026-09-26'; vs.dailyStreak = 4;
  check('validator accepts valid daily fields', V.validateProgress(null, vs, Date.now()) === null);
  var vb = B.freshState(); vb.lastDailyClaim = 'yesterday';
  check('validator rejects garbage lastDailyClaim',
    typeof V.validateProgress(null, vb, Date.now()) === 'string');
  var vb2 = B.freshState(); vb2.lastDailyClaim = '2026-02-30';
  check('validator rejects impossible date',
    typeof V.validateProgress(null, vb2, Date.now()) === 'string');
  var vb3 = B.freshState(); vb3.dailyStreak = -1;
  check('validator rejects negative dailyStreak',
    typeof V.validateProgress(null, vb3, Date.now()) === 'string');
  var vb4 = B.freshState(); vb4.dailyStreak = 2.5;
  check('validator rejects fractional dailyStreak',
    typeof V.validateProgress(null, vb4, Date.now()) === 'string');
  var vo = B.freshState(); delete vo.lastDailyClaim; delete vo.dailyStreak;
  check('validator accepts missing daily fields (back-compat)',
    V.validateProgress(null, vo, Date.now()) === null);

  // sanitize carries + clamps daily fields
  var ss = SC.sanitize({ lastDailyClaim: '2026-09-26', dailyStreak: 3 });
  check('sanitize keeps valid daily fields',
    ss.lastDailyClaim === '2026-09-26' && ss.dailyStreak === 3);
  var ss2 = SC.sanitize({ lastDailyClaim: 'bogus', dailyStreak: -5 });
  check('sanitize resets bogus daily fields',
    ss2.lastDailyClaim === null && ss2.dailyStreak === 0);
  var ss3 = SC.sanitize({});
  check('sanitize defaults daily fields when absent',
    ss3.lastDailyClaim === null && ss3.dailyStreak === 0);

  // warp preserves daily streak (loyalty survives prestige)
  var ws = B.freshState();
  ws.totalEarned = 2e6; ws.lastDailyClaim = '2026-09-26'; ws.dailyStreak = 5;
  check('doWarp keeps daily streak', SC.doWarp(ws).ok === true &&
    ws.dailyStreak === 5 && ws.lastDailyClaim === '2026-09-26');
})();

/* ---------------- 3. browser wiring level ---------------- */

function makeClassList(seed) {
  const set = new Set(seed || []);
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; on ? set.add(c) : set.delete(c); return on; },
    contains: (c) => set.has(c),
  };
}

function makeCtx() {
  const grad = { addColorStop() {} };
  const base = {
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
  };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      return () => {}; // every other method is a no-op
    },
    set() { return true; }, // property writes (fillStyle, etc.) absorbed
  });
}

// Recording canvas context: captures the path commands drawShipShape issues,
// so tests can prove each (style, tier) draws a distinct shape.
function makeRecorder() {
  const calls = [];
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    calls,
    beginPath() { calls.push('begin'); },
    closePath() { calls.push('close'); },
    fill() { calls.push('fill'); },
    stroke() { calls.push('stroke'); },
    fillRect(x, y, w, h) { calls.push('rect' + [x, y, w, h].map(r2).join(',')); },
    moveTo(x, y) { calls.push('M' + r2(x) + ',' + r2(y)); },
    lineTo(x, y) { calls.push('L' + r2(x) + ',' + r2(y)); },
    quadraticCurveTo(a, b, c, d) { calls.push('Q' + [a, b, c, d].map(r2).join(',')); },
    arc(x, y, rad) { calls.push('A' + r2(x) + ',' + r2(y) + ',' + r2(rad)); },
    ellipse(x, y, rx, ry, rot) { calls.push('E' + [rx, ry, rot].map(r2).join(',')); },
  };
}

function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 600 }),
    addEventListener() {},
  };
}

function makeEl(id, seedClasses) {
  const listeners = {};
  const el = {
    _id: id,
    textContent: '', innerHTML: '', value: '', disabled: false,
    style: {}, classList: makeClassList(seedClasses),
    clientWidth: id === 'canvas-wrap' ? 390 : 0,
    clientHeight: id === 'canvas-wrap' ? 600 : 0,
    dataset: {},
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    // data-* attributes map to dataset keys, like the real DOM
    getAttribute: (a) => (a.indexOf('data-') === 0 ? el.dataset[a.slice(5)] : el.dataset[a]),
    setAttribute() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 600 }),
    _fire: (t, evt) => {
      (listeners[t] || []).forEach((fn) => {
        calls(id + ' [' + t + ']', () => fn(evt || {}));
      });
    },
  };
  return el;
}

(function browser() {
  const els = {};
  function $(id) {
    if (!els[id]) {
      const seed = (id === 'game-screen' || id === 'modal' || id === 'toast') ? ['hidden'] : [];
      els[id] = makeEl(id, seed);
    }
    return els[id];
  }

  // tab buttons for '#tabs .tabbtn' — settings replaces board
  const tabNames = ['game', 'goals', 'settings', 'news'];
  const tabBtns = tabNames.map((name, i) => {
    const b = makeEl('tabbtn-' + name, i === 0 ? ['tabbtn', 'active'] : ['tabbtn']);
    b.dataset.tab = name;
    return b;
  });

  const docListeners = {};
  const sandbox = {
    console,
    Math, JSON, Object, Array, Number, String, Boolean, Date, parseInt, parseFloat,
    isFinite, isNaN, Infinity, NaN, undefined,
    setTimeout: (fn) => 0, clearTimeout: () => {},
    performance: { now: (() => { let t = 0; return () => (t += 16); })() },
    requestAnimationFrame: (cb) => { sandbox.__raf = cb; return 1; },
    cancelAnimationFrame: () => {},
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    navigator: {},
    devicePixelRatio: 2,
  };
  sandbox.self = sandbox;
  sandbox.window = {
    devicePixelRatio: 2,
    addEventListener() {},
  };
  sandbox.document = {
    readyState: 'loading',
    visibilityState: 'visible',
    getElementById: $,
    querySelectorAll: (sel) => (sel.indexOf('#tabs') >= 0 ? tabBtns : []),
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : makeEl('anon')),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  vm.createContext(sandbox);

  const balSrc = fs.readFileSync(path.join(PUB, 'js', 'balance.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  vm.runInContext(balSrc, sandbox, { filename: 'balance.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  check('scripts load in stub browser', !!sandbox.StarBalance && !!sandbox.StarCircuit);

  const dbg = () => sandbox.window.__starcircuit;

  // fire DOMContentLoaded -> init() -> boot() (fetch undefined -> auth screen)
  (docListeners.DOMContentLoaded || []).forEach((fn) => calls('DOMContentLoaded', fn));
  check('boot shows auth screen', $('auth-screen').classList.contains('hidden') === false);

  // guest login
  $('guest-btn')._fire('click');
  check('guest session shows game screen', $('game-screen').classList.contains('hidden') === false);

  // daily auto-modal opens at session start when a claim is waiting
  check('daily auto-modal opens on session start',
    $('modal').classList.contains('hidden') === false &&
    $('modal-title').textContent.indexOf('Daily Reward') >= 0);
  $('modal-cancel')._fire('click'); // dismiss without claiming
  check('daily modal dismisses', $('modal').classList.contains('hidden'));

  const api = sandbox.StarCircuit;
  const st = () => dbg().getState();
  check('guest state exists', !!st() && st().ships.length === 2);
  check('guest state has default cosmetics',
    st().cosmetics.colorTheme === 'classic' && st().cosmetics.shipStyle === 'fleet');

  // settings panel renders with all themes + styles
  check('settings lists render',
    $('theme-list').innerHTML.indexOf('Neon Nights') >= 0 &&
    $('theme-list').innerHTML.indexOf('data-theme="ghost"') >= 0 &&
    $('style-list').innerHTML.indexOf('Darts') >= 0 &&
    $('style-list').innerHTML.indexOf('data-style="orbs"') >= 0);

  // drive ~120 frames: draw(), updateHUD(), floats, particles, twinkles
  const raf = sandbox.__raf;
  let t = 16;
  // drive n frames, recording (not throwing) rAF errors
  function frames(n) {
    for (let i = 0; i < n; i++) { t += 16; calls('rAF', () => raf(t)); }
  }
  frames(120);
  check('120 frames run clean', true);
  check('HUD updated', $('coins').textContent.length > 0 && $('cps').textContent.length > 0);
  check('boost button wired', $('btn-boost').textContent !== undefined);

  // canvas tap anywhere -> boost + ripple (no ship under tap point far away)
  const before = $('boost-label').textContent;
  $('orbit')._fire('click', { preventDefault() {}, clientX: 20, clientY: 20 });
  check('canvas tap triggers boost label', $('boost-label').textContent !== before);

  // switch color theme via the settings hook: resolved colors change live
  calls('setCosmetics', () => dbg().setCosmetics('colorTheme', 'ocean'));
  check('theme switch applies',
    dbg().activeCosmetics().colorTheme === 'ocean' &&
    api.tierColorsFor(st())[0] === '#a5f3fc');
  check('theme list re-renders selection',
    $('theme-list').innerHTML.indexOf('data-theme="ocean"') >= 0 &&
    $('theme-list').innerHTML.indexOf('selected') >= 0);

  // switch ship style: shapes re-prerender without errors
  calls('setCosmetics', () => dbg().setCosmetics('shipStyle', 'darts'));
  check('style switch applies', dbg().activeCosmetics().shipStyle === 'darts');
  frames(60);
  check('frames clean after cosmetics switch', true);

  // bogus ids are ignored, never crash or corrupt state
  calls('setCosmetics', () => dbg().setCosmetics('colorTheme', 'hacker'));
  calls('setCosmetics', () => dbg().setCosmetics('shipStyle', 'nope'));
  check('bogus cosmetics ids rejected',
    dbg().activeCosmetics().colorTheme === 'ocean' &&
    dbg().activeCosmetics().shipStyle === 'darts');

  // every (style, tier) draws a distinct shape
  const styles = ['fleet', 'darts', 'orbs'];
  const sigs = {};
  let dupes = 0;
  styles.forEach((style) => {
    const seen = new Set();
    for (let tier = 0; tier < 8; tier++) {
      const rec = makeRecorder();
      calls('drawShipShape', () => dbg().drawShipShape(rec, tier, 10, '#ffffff', style));
      const sig = style + ':' + tier + '=' + rec.calls.join('|');
      sigs[style + tier] = sig;
      if (seen.has(rec.calls.join('|'))) dupes++;
      seen.add(rec.calls.join('|'));
    }
  });
  check('all 8 tiers distinct within each style', dupes === 0);
  let crossDupes = 0;
  for (let tier = 0; tier < 8; tier++) {
    const set = new Set([sigs['fleet' + tier], sigs['darts' + tier], sigs['orbs' + tier]]);
    if (set.size < 3) crossDupes++;
  }
  check('switching style changes every tier shape', crossDupes === 0);

  // purchases with funds
  st().coins = 1e12;
  const n0 = st().ships.length;
  $('btn-ship')._fire('click');
  check('buy ship via button', st().ships.length === n0 + 1);
  $('btn-ring')._fire('click');
  check('buy ring via button', st().rings === 2);
  $('btn-circuit')._fire('click');
  check('buy circuit via button', st().circuitLevel === 1);

  // merge via button with forced pair
  st().ships = [{ tier: 0, ring: 0, angle: 0 }, { tier: 0, ring: 0, angle: 0.05 }];
  $('btn-merge')._fire('click');
  check('auto-merge via button (+FX)', st().ships.length === 1 && st().ships[0].tier === 1);

  // ship tap select -> second tap merges (boost also fires, harmless)
  st().ships = [{ tier: 2, ring: 0, angle: 0.5 }, { tier: 2, ring: 0, angle: 0.55 }];
  const p1 = { preventDefault() {}, clientX: 195 + 80 * Math.cos(0.5), clientY: 300 + 80 * Math.sin(0.5) };
  $('orbit')._fire('click', p1); // select (also boosts)
  check('canvas tap does not crash on ship', true);

  // x2 + warp buttons
  $('btn-x2')._fire('click');
  frames(20); // let updateHUD tick
  check('x2 button engages', $('x2-label').textContent.indexOf('ACTIVE') >= 0);
  $('btn-warp')._fire('click'); // insufficient -> toast, no modal
  check('warp button safe when locked', $('modal').classList.contains('hidden'));

  // tabs: exactly one active at a time; settings opens its panel
  const byName = {};
  tabBtns.forEach((b) => { byName[b.dataset.tab] = b; });
  byName.settings._fire('click');
  const activeCount = tabBtns.filter((b) => b.classList.contains('active')).length;
  check('settings tab opens its panel',
    byName.settings.classList.contains('active') && activeCount === 1 &&
    !$('panel-settings').classList.contains('hidden') &&
    $('panel-game').classList.contains('hidden'));
  byName.game._fire('click');
  check('game tab reopens canvas panel',
    !$('panel-game').classList.contains('hidden') &&
    $('panel-settings').classList.contains('hidden'));
  tabBtns.forEach((b) => b._fire('click')); // full cycle, no crashes

  // daily card: fresh guest state -> claimable, CLAIM button rendered
  byName.goals._fire('click'); // switchTab('goals') -> refreshGoals -> refreshDaily
  check('daily card renders claim button when claimable',
    $('daily-card').innerHTML.indexOf('id="daily-claim"') >= 0 &&
    $('daily-card').innerHTML.indexOf('ddot') >= 0);
  check('daily card shows 7 dots',
    ($('daily-card').innerHTML.match(/ddot/g) || []).length >= 7);
  // guest claim through the real claim path (local only)
  const coinsBefore = st().coins;
  calls('claimDaily', () => dbg().claimDaily());
  check('guest daily claim pays + sets streak',
    st().coins === coinsBefore + 1000 && st().dailyStreak === 1 &&
    typeof st().lastDailyClaim === 'string' && st().totalEarned >= 1000);
  check('daily card shows countdown after claim',
    $('daily-card').innerHTML.indexOf('daily-count') >= 0 &&
    $('daily-card').innerHTML.indexOf('id="daily-claim"') < 0);
  // second claim same day rejected locally
  calls('claimDaily', () => dbg().claimDaily());
  check('guest double-claim rejected', st().coins === coinsBefore + 1000 && st().dailyStreak === 1);
  // guest save roundtrip carries daily fields
  const draw = sandbox.localStorage.getItem('starcircuit_guest');
  const dparsed = JSON.parse(draw);
  check('guest save carries daily fields',
    dparsed.dailyStreak === 1 && typeof dparsed.lastDailyClaim === 'string');
  // countdown tick via updateHUD path (frames) — no crash, no setInterval needed
  frames(80);
  check('frames clean with claimed daily card', true);

  // modal open/close
  $('modal-ok')._fire('click');
  check('modal ok closes', $('modal').classList.contains('hidden'));

  // more frames after all the action (particles/shocks/floats decaying)
  frames(60);
  check('post-action frames clean', true);

  // guest persistence roundtrip carries cosmetics (whole state is stringified)
  check('guest save carries cosmetics',
    JSON.stringify(st()).indexOf('"ocean"') >= 0 &&
    JSON.stringify(st()).indexOf('"darts"') >= 0);
  const raw = sandbox.localStorage.getItem('starcircuit_guest');
  check('guest save persisted', !!raw && JSON.parse(raw).ships.length === st().ships.length);

  // zero JS errors across the whole stub-browser run
  if (jsErrors.length) console.error('  JS errors:\n  ' + jsErrors.join('\n  '));
  check('zero JS errors in stub browser', jsErrors.length === 0);
})();

/* ---------------- 4. source hygiene ---------------- */
(function hygiene() {
  const appSrc = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  check('no board references remain in app.js', !/board/i.test(appSrc));
  check('persist sends {state} save shape (not raw state)',
    appSrc.indexOf('body: { state: state }') >= 0 &&
    appSrc.indexOf('method: \'POST\', body: state }') < 0);
  check('no board tab in index.html',
    html.indexOf('data-tab="board"') < 0 && html.indexOf('panel-board') < 0 &&
    html.indexOf('board-list') < 0);
  check('settings tab + panel exist in index.html',
    html.indexOf('data-tab="settings"') >= 0 && html.indexOf('id="panel-settings"') >= 0 &&
    html.indexOf('id="theme-list"') >= 0 && html.indexOf('id="style-list"') >= 0);
  // every id cacheDom references must exist in index.html
  const m = appSrc.match(/\['auth-screen',([\s\S]*?)\]\.forEach/);
  const ids = ['auth-screen'].concat([...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]));
  const missing = ids.filter((id) => html.indexOf('id="' + id + '"') < 0);
  if (missing.length) console.error('  missing ids:', missing.join(', '));
  check('all ' + ids.length + ' cacheDom ids exist in index.html', missing.length === 0);
})();

/* ---------------- 5. integration: real server daily claim flow ---------------- */
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');

function verdict() {
  if (failures) { console.error('\nSMOKE FAILED:', failures, 'check(s)'); process.exit(1); }
  console.log('\nSMOKE PASSED: zero JS errors, buy/merge/tab/boost/settings/daily flows work.');
}

async function integration() {
  const PORT = 32107;
  const base = 'http://127.0.0.1:' + PORT;
  const env = Object.assign({}, process.env);
  delete env.DATABASE_URL; // force the in-memory pg-mem database
  env.PORT = String(PORT);
  env.SESSION_SECRET = 'smoke-test-secret';
  env.NODE_ENV = 'test';
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: env, stdio: 'pipe' });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const kill = () => { try { srv.kill('SIGTERM'); } catch (e) {} };

  try {
    // wait for health
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      try {
        const r = await fetch(base + '/api/health');
        healthy = r.ok;
      } catch (e) { /* not up yet */ }
      if (!healthy) await new Promise((r) => setTimeout(r, 200));
    }
    check('integration server boots', healthy);
    if (!healthy) { console.error('  server output:', out.slice(0, 500)); kill(); return; }

    let cookie = '';
    async function call(method, p, body) {
      const r = await fetch(base + p, {
        method: method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          cookie ? { Cookie: cookie } : {}
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let data = null;
      try { data = await r.json(); } catch (e) {}
      return { status: r.status, data: data };
    }
    async function register() {
      cookie = '';
      const u = 'dtest' + Math.floor(Math.random() * 1e9);
      const r = await call('POST', '/api/auth/register',
        { username: u, password: 'TestPass123!' });
      return r.status === 200;
    }

    // first claim
    check('integration register', await register());
    const today = B.utcDayString(Date.now());
    const c1 = await call('POST', '/api/daily/claim');
    check('endpoint: first claim 200 with day-1 reward',
      c1.status === 200 && c1.data && c1.data.ok === true &&
      c1.data.streak === 1 && c1.data.day === 1 &&
      c1.data.reward.coins === 1000 && c1.data.reward.cores === 0 &&
      c1.data.date === today && c1.data.nextClaimIn > 0);
    // second claim same day -> 409
    const c2 = await call('POST', '/api/daily/claim');
    check('endpoint: second claim same day 409',
      c2.status === 409 && c2.data && typeof c2.data.nextClaimIn === 'number');
    // save reflects the reward
    const sv = await call('GET', '/api/save');
    const st8 = sv.data && sv.data.state;
    check('endpoint: save carries daily claim',
      st8 && st8.coins >= 1000 && st8.totalEarned >= 1000 &&
      st8.lastDailyClaim === today && st8.dailyStreak === 1);

    // streak continuation: seed yesterday's claim, then claim
    const y = B.shiftDayString(today, -1);
    st8.lastDailyClaim = y; st8.dailyStreak = 5;
    const seed = await call('POST', '/api/save', { state: st8 });
    check('integration seed yesterday save accepted', seed.status === 200);
    const c3 = await call('POST', '/api/daily/claim');
    check('endpoint: streak continues after yesterday',
      c3.status === 200 && c3.data.streak === 6 && c3.data.day === 6 &&
      c3.data.reward.coins === 6000);
    // client mirror autosave after claim must not 422
    const sv2 = await call('GET', '/api/save');
    const mirror = await call('POST', '/api/save', { state: sv2.data.state });
    check('endpoint: post-claim autosave accepted (no 422)', mirror.status === 200);

    // gap resets the streak
    check('integration register #2', await register());
    const sv3 = await call('GET', '/api/save');
    const s3 = sv3.data.state;
    s3.lastDailyClaim = B.shiftDayString(today, -3); s3.dailyStreak = 5;
    await call('POST', '/api/save', { state: s3 });
    const c4 = await call('POST', '/api/daily/claim');
    check('endpoint: streak resets after a gap',
      c4.status === 200 && c4.data.streak === 1 && c4.data.day === 1);

    // garbage daily fields rejected by the save validator
    const sv4 = await call('GET', '/api/save');
    const s4 = sv4.data.state;
    s4.lastDailyClaim = 'not-a-date';
    const bad = await call('POST', '/api/save', { state: s4 });
    check('endpoint: garbage lastDailyClaim rejected', bad.status === 422);

    // day 7 grants the warp core
    check('integration register #3', await register());
    const sv5 = await call('GET', '/api/save');
    const s5 = sv5.data.state;
    s5.lastDailyClaim = y; s5.dailyStreak = 6;
    await call('POST', '/api/save', { state: s5 });
    const c7 = await call('POST', '/api/daily/claim');
    check('endpoint: day 7 grants warp core',
      c7.status === 200 && c7.data.day === 7 && c7.data.reward.cores === 1);
    const sv6 = await call('GET', '/api/save');
    check('endpoint: warp core persisted', sv6.data.state.warpCores === 1);

    // concurrent double-claim: exactly one 200, one 409
    check('integration register #4', await register());
    const [r1, r2] = await Promise.all([
      call('POST', '/api/daily/claim'),
      call('POST', '/api/daily/claim'),
    ]);
    const codes = [r1.status, r2.status].sort().join(',');
    check('endpoint: concurrent double-claim -> one 200 + one 409', codes === '200,409');
  } catch (e) {
    failures++;
    console.error('integration crashed:', (e && e.message) || e);
  } finally {
    kill();
  }
}

integration().then(verdict).catch((e) => {
  failures++;
  console.error('integration crashed:', (e && e.message) || e);
  verdict();
});
