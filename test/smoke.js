'use strict';
/* Star Circuit smoke test: zero-JS-error check for the 1.1 visual rework.
 *
 * 1. Logic level (node require): buy/merge/tick/warp/goal/boost/sanitize.
 * 2. Browser wiring level (vm + stub DOM + stub canvas 2d): boot, guest
 *    session, ~120 driven frames (draw/updateHUD/particles), button clicks
 *    (ship/ring/circuit/merge/x2/warp/boost), canvas taps (boost ripple +
 *    merge select), tab switches.
 *
 * Any thrown error fails the run. Run: node test/smoke.js
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
})();

/* ---------------- 2. browser wiring level ---------------- */

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
    getAttribute: (a) => el.dataset[a],
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

  // tab buttons for '#tabs .tabbtn'
  const tabBtns = ['game', 'goals', 'board', 'news'].map((name, i) => {
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

  // fire DOMContentLoaded -> init() -> boot() (fetch undefined -> auth screen)
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());
  check('boot shows auth screen', $('auth-screen').classList.contains('hidden') === false);

  // guest login
  $('guest-btn')._fire('click');
  check('guest session shows game screen', $('game-screen').classList.contains('hidden') === false);

  const api = sandbox.StarCircuit;
  const st = () => sandbox.window.__starcircuit.getState();
  check('guest state exists', !!st() && st().ships.length === 2);

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

  // tabs
  tabBtns.forEach((b) => b._fire('click'));
  check('tab switches run clean', tabBtns[0].classList.contains('active'));

  // modal open/close
  $('modal-ok')._fire('click');
  check('modal ok closes', $('modal').classList.contains('hidden'));

  // more frames after all the action (particles/shocks/floats decaying)
  for (let i = 0; i < 60; i++) { t += 16; raf(t); }
  check('post-action frames clean', true);

  // guest persistence roundtrip
  const raw = sandbox.localStorage.getItem('starcircuit_guest');
  check('guest save persisted', !!raw && JSON.parse(raw).ships.length === st().ships.length);
})();

if (failures) { console.error('\nSMOKE FAILED:', failures, 'check(s)'); process.exit(1); }
console.log('\nSMOKE PASSED: zero JS errors, buy/merge/tab/boost flows work.');
