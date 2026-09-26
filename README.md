# Star Circuit

An orbit-ship idle game for the web — ships fly a circuit earning coins every
lap. Merge ships into 8 tiers, buy more ships, unlock orbit rings, upgrade the
circuit, chase goals, and Warp Reset for permanent bonuses. **No ads, ever:**
boosts are cooldown-based.

## Run locally

```bash
npm install
node server.js        # http://localhost:3000
```

With no `DATABASE_URL` set, the server uses an in-memory database (dev only —
nothing persists). For real persistence, set `DATABASE_URL` to a Postgres
(Neon) connection string.

## Project layout

```
server.js            Express entry (helmet, sessions, rate-limited auth, static)
src/db.js            Postgres access (pg-mem fallback when DATABASE_URL unset)
src/auth.js          register / login / logout / me
src/gameApi.js       save (with anti-cheat validation), leaderboard, changelog
src/validation.js    input + save-progress validation
src/sessionStore.js  connect-pg-simple session store
public/              frontend (index.html, css/style.css, js/app.js)
public/js/balance.js shared tuning (browser + node + sim + server validation)
sim/sim.js           balance simulator: node sim/sim.js
changelog.json       "What's New" feed
render.yaml          Render Blueprint (Docker, free plan)
Dockerfile           production image
DEPLOY.md            step-by-step Render + Neon deploy guide
API_CONTRACT.md      frontend <-> backend contract
```

## Game design

- **Loop:** ships orbit; each lap pays `2 × 2.5^tier × 1.15^circuit × warpMult`.
  Lap time `6s / 1.1^circuit`.
- **Merge:** two same-tier ships → tier+1 (max tier 7, Eclipse). Tap-select or
  MERGE-all.
- **Economy:** ship cost `100 × 1.15^shipsBought` (lifetime purchases);
  rings 2/3/4 cost 5K/250K/10M (8 ships each); circuit `500 × 2.2^level`
  (+10% speed, +15% coins/level, max 60).
- **Boosts:** tap = +4s of 2x (cap 120s); x2 toggle = 60s on, 5min cooldown.
- **Goals:** 10-goal chain (coins + a warp core for the finale).
- **Offline:** 50% rate, 8h cap, Welcome-back popup.
- **Warp Reset:** needs 1M run earnings → cores = run/2.5M (min 1), each core
  +25% permanent. Resets fleet/rings/circuit/goals.
- **Integrity:** game tick is client-side; the server validates every save
  (monotonic lifetime earnings, gains bounded by theoretical max, warp rules).

## Balance target

Sim-verified (`node sim/sim.js`, superhuman bot): ~194K lifetime coins at
15 min active play, tier 5 by then, tier 7+ and first warp around 30-60 min.
Human players will land a bit lower — right on the ~100K target.
