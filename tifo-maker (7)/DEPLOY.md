# Deploying Tifo Maker

The app and API run as **one process from one origin** — the Fastify server
serves the built SPA and the API together, so there's no proxy or CORS to
configure. You need exactly two things at any host: a place to run the
container, and a Postgres database. Pick whichever host below you prefer; the
config files (`railway.json`, `render.yaml`, `fly.toml`) are already in the repo.

## What every host needs

Three environment variables (see `.env.example`):

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | **Required.** Server refuses to start in production without it. Schema is created automatically on first boot. |
| `NODE_ENV` | `production` | Enables the DATABASE_URL guard, rate limiting, and logging. |
| `PORT` | (injected by host) | The server reads it; you rarely set this yourself. |

The build command is `npm run build:prod` and the start command is `npm start`
— both already wired into the `Dockerfile`, so Docker-based hosts need no
command overrides.

---

## Option A — Railway (simplest)

Railway provisions the database and reads `railway.json` automatically.

1. Push this repo to GitHub.
2. At railway.app: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway detects the `Dockerfile` and `railway.json`.
3. In the project, **New → Database → PostgreSQL**. Railway creates it and
   exposes a `DATABASE_URL` reference variable.
4. On the web service, open **Variables** and add:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference the database you just made)
5. Deploy. Railway builds the image, runs the health check at `/health`, and
   gives you a public URL. The schema is applied on first boot.

To verify: open the URL (the app loads), then `…/api/templates` returns JSON.

---

## Option B — Render (blueprint = app + database together)

`render.yaml` declares both the web service and a managed Postgres, so one
blueprint stands the whole thing up.

1. Push this repo to GitHub.
2. At render.com: **New → Blueprint**, point it at the repo. Render reads
   `render.yaml`, creates the `tifo-maker` web service and the
   `tifo-maker-db` Postgres, and wires `DATABASE_URL` between them via the
   `fromDatabase` reference (no manual copy-paste).
3. Click **Apply**. Render builds the Docker image and deploys; the health
   check at `/health` gates the rollout.

`NODE_ENV=production` is set in the blueprint; `PORT` is injected by Render.

---

## Option C — Fly.io (CLI-driven, scale-to-zero)

`fly.toml` is configured for HTTPS and machines that sleep when idle.

1. Install the CLI and sign in: `fly auth login`.
2. From the repo root: `fly launch --no-deploy`. Accept reusing the existing
   `fly.toml`; if Fly assigns a different app name, update the `app = …` line.
3. Provision Postgres and attach it (this sets `DATABASE_URL` as a secret):
   ```
   fly postgres create --name tifo-maker-db
   fly postgres attach tifo-maker-db
   ```
4. Set the remaining secret:
   ```
   fly secrets set NODE_ENV=production
   ```
5. Deploy: `fly deploy`. The schema applies on boot; `force_https = true`
   means tokens never travel over plain HTTP.

---

## Anything else with Docker

The `Dockerfile` is self-contained. Any container host works:

```
docker build -t tifo-maker .
docker run -p 8787:8787 \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" \
  -e NODE_ENV=production \
  tifo-maker
```

Point a managed Postgres at `DATABASE_URL`, put the host's TLS-terminating
load balancer in front, and you're live.

## Post-deploy checklist

- [ ] App loads at `/` and the canvas renders.
- [ ] `…/api/templates` returns the three templates as JSON.
- [ ] `…/health` returns `{"ok":true}`.
- [ ] Sign in, save a design, reload the page, load it back — it persists.
- [ ] The site is served over HTTPS (host-terminated).

## Notes & limits

- **Sessions are in-memory tokens.** A page refresh signs the user out (the
  bearer token lives in browser memory, not storage). This is intentional for
  now; swapping in persistent token storage is a product decision.
- **Single instance assumed.** Auth tokens are stored in the database, so the
  API itself scales horizontally — but if you run multiple instances, make sure
  they share the one `DATABASE_URL`. There's no in-process state that needs
  stickiness.
- **TLS is the host's job.** Railway, Render, and Fly all terminate HTTPS for
  you; the app trusts the proxy. Don't expose the raw container port publicly.
