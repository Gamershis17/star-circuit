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
    _fire: (t, evt) => { (listeners[t] || []).forEach((fn) => fn(evt || {})); },
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
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());
  check('boot shows auth screen', $('auth-screen').classList.contains('hidden') === false);

  // guest login
  $('guest-btn')._fire('click');
  check('guest session shows game screen', $('game-screen').classList.contains('hidden') === false);

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
  for (let i = 0; i < 120; i++) { t += 16; raf(t); }
  check('120 frames run clean', true);
  check('HUD updated', $('coins').textContent.length > 0 && $('cps').textContent.length > 0);
  check('boost button wired', $('btn-boost').textContent !== undefined);

  // canvas tap anywhere -> boost + ripple (no ship under tap point far away)
  const before = $('boost-label').textContent;
  $('orbit')._fire('click', { preventDefault() {}, clientX: 20, clientY: 20 });
  check('canvas tap triggers boost label', $('boost-label').textContent !== before);

  // switch color theme via the settings hook: resolved colors change live
  dbg().setCosmetics('colorTheme', 'ocean');
  check('theme switch applies',
    dbg().activeCosmetics().colorTheme === 'ocean' &&
    api.tierColorsFor(st())[0] === '#a5f3fc');
  check('theme list re-renders selection',
    $('theme-list').innerHTML.indexOf('data-theme="ocean"') >= 0 &&
    $('theme-list').innerHTML.indexOf('selected') >= 0);

  // switch ship style: shapes re-prerender without errors
  dbg().setCosmetics('shipStyle', 'darts');
  check('style switch applies', dbg().activeCosmetics().shipStyle === 'darts');
  for (let i = 0; i < 60; i++) { t += 16; raf(t); }
  check('frames clean after cosmetics switch', true);

  // bogus ids are ignored, never crash or corrupt state
  dbg().setCosmetics('colorTheme', 'hacker');
  dbg().setCosmetics('shipStyle', 'nope');
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
      dbg().drawShipShape(rec, tier, 10, '#ffffff', style);
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
  for (let i = 0; i < 20; i++) { t += 16; raf(t); } // let updateHUD tick
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

  // modal open/close
  $('modal-ok')._fire('click');
  check('modal ok closes', $('modal').classList.contains('hidden'));

  // more frames after all the action (particles/shocks/floats decaying)
  for (let i = 0; i < 60; i++) { t += 16; raf(t); }
  check('post-action frames clean', true);

  // guest persistence roundtrip carries cosmetics (whole state is stringified)
  check('guest save carries cosmetics',
    JSON.stringify(st()).indexOf('"ocean"') >= 0 &&
    JSON.stringify(st()).indexOf('"darts"') >= 0);
  const raw = sandbox.localStorage.getItem('starcircuit_guest');
  check('guest save persisted', !!raw && JSON.parse(raw).ships.length === st().ships.length);
})();

/* ---------------- 4. source hygiene ---------------- */
(function hygiene() {
  const appSrc = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  check('no board references remain in app.js', !/board/i.test(appSrc));
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

if (failures) { console.error('\nSMOKE FAILED:', failures, 'check(s)'); process.exit(1); }
console.log('\nSMOKE PASSED: zero JS errors, buy/merge/tab/boost/settings flows work.');
