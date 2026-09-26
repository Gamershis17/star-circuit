# Star Circuit — API contract (frontend <-> backend)

Base URL: same origin. All JSON.

## Auth
- `POST /api/auth/register` `{username, password}` -> `200 {user:{username, role}}`
  errors: 400 invalid, 409 taken, 429 rate-limited (20 req/min/IP on /api/auth/*)
- `POST /api/auth/login` `{username, password}` -> `200 {user:{username, role}}`
  errors: 400, 401 wrong credentials
- `POST /api/auth/logout` -> `200 {ok:true}`
- `GET /api/auth/me` -> `200 {user:{username, role}}` or `401`

Username rules: 3-16 chars, letters/numbers/underscore. Password: min 6 chars.
Session cookie (httpOnly), 30 days.

## Save (auth required)
- `GET /api/save` -> `200 {state}` — the player's save; a fresh state if first login.
  `state` shape (see `public/js/balance.js` `freshState()`):
  ```json
  {
    "coins": 0, "totalEarned": 0,
    "ships": [{"tier":0,"ring":0,"angle":0.0}],
    "shipsBought": 2,
    "rings": 1, "circuitLevel": 0,
    "warps": 0, "warpCores": 0, "earnedAtLastWarp": 0,
    "goalsClaimed": [],
    "lastSeen": 1730000000000
  }
  ```
  Client-only (NOT saved / NOT trusted): boost timers (`boostUntil`, `x2Until`,
  `x2CooldownUntil`) — keep those in memory/localStorage only.
- `POST /api/save` `{state}` -> `200 {ok:true}` or `422 {error}` when the
  server's anti-cheat validation rejects the save (monotonic totalEarned,
  gains bounded by theoretical max for elapsed time, warp rules).
  The client must keep its local state on 422 and keep playing.

## Leaderboard (public)
- `GET /api/leaderboard` -> `200 {entries:[{username, totalEarned, warps}]}`,
  ordered by totalEarned desc, max 50.

## Changelog (public)
- `GET /api/changelog` -> `200` the contents of `changelog.json`
  `{version, entries:[{version, date, notes:[...]}]}`.

## Client responsibilities
- Game tick runs client-side (requestAnimationFrame).
- Autosave: `POST /api/save` every 30s and on `pagehide` (sendBeacon).
- On load: `GET /api/save`, compute offline earnings client-side from
  `state.lastSeen` (cap 8h, 50% rate via `StarBalance`), show "Welcome back"
  popup, then set `lastSeen = Date.now()`.
- Update `state.lastSeen = Date.now()` on every save.
- If not logged in, play as guest with localStorage save; prompt login to sync.
