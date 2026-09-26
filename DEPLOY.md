# Star Circuit — deploy to Render (free tier)

The game is a Docker web service + Neon Postgres. You (the owner) do these
steps in the Render dashboard — they need your logins, so they can't be
automated from here.

## 0. Push the code to GitHub

```bash
cd ~/workspace/orbit-idle
git init
git add -A
git commit -m "Star Circuit 1.0.0"
gh repo create star-circuit --public --source=. --push
# (or create the repo on github.com and push manually)
```

## 1. Create the database (Neon, free)

1. Go to https://neon.tech → sign up / log in → **New Project**.
2. Name it `star-circuit`, pick the closest region, create it.
3. Copy the **connection string** (it looks like
   `postgres://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`).
   Keep it private — it is a password.

## 2. Create the web service (Render, free)

1. Go to https://dashboard.render.com → **New +** → **Web Service**.
2. Connect your GitHub account if needed, select the `star-circuit` repo.
3. Settings:
   - **Runtime:** Docker (it builds the `Dockerfile` automatically)
   - **Plan:** Free
   - **Health check path:** `/api/health`
4. **Environment variables** (Environment tab):
   - `DATABASE_URL` = your Neon connection string (REQUIRED)
   - `SESSION_SECRET` = click **Generate** (or any long random string)
   - `NODE_ENV` = `production`
   - `OWNER_USERNAME` = your in-game username (optional; register in-game
     first, then set this to claim the owner role)
   - `PORT` = `3000`
5. Click **Create Web Service**. First deploy takes a few minutes.

## 3. Verify

- Open the service URL → you should see the Star Circuit login screen.
- Register an account, play 30s, reload — progress must persist.
- `GET <url>/api/health` → `{"ok":true,"game":"star-circuit"}`.
- `GET <url>/api/leaderboard` → `{"entries":[...]}`.

## Notes

- **Free-tier sleep:** Render sleeps the service after ~15 min idle; first
  visit wakes it in ~50s. All data is safe in Neon.
- **Never commit `DATABASE_URL`** to the repo. It lives only in Render's
  Environment tab.
- **Local dev:** with no `DATABASE_URL` set, the server uses an in-memory
  database (loud warning in logs) — perfect for testing, nothing persists.
- To update the live game later: `git push` — Render redeploys automatically.
