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

The build commands are `npm run build:prod` (the site, into `dist/`) and
`npm run build:server` (the seat table and the server bundle, into
`server/build/`), and the start command is `npm start`, which runs
`node server/build/server.mjs` — all already wired into the `Dockerfile`, so
Docker-based hosts need no command overrides. A non-Docker host must run both
builds; `tsx` and `esbuild` are build tools only and are not installed with
`--omit=dev`.

### How the server is built (October 2026)

- **One bundled file.** `scripts/bundle-server.mjs` bundles `server/src` into
  `server/build/server.mjs` with esbuild. Boot went from 18-31 s under tsx to
  about 1.5 s. The bundle sits outside `dist/` (the public web root), has no
  source map, bakes in no environment value (nothing is `define`d), and keeps
  every package as an import so `npm audit` sees what runs. `test:deploy`
  checks all of this.
- **The seat table.** Every ground's seat count and royal box are read from
  `server/data/seat-table.json` rather than generated at boot.
  `npm run seats:table` rewrites it from the seat-map generator; the Docker
  build does that itself, and `test:deploy` fails if the committed copy differs
  from what the generator makes now. After changing a ground or the generator,
  run `npm run seats:table` and commit the file. A ground the table does not
  match is generated at boot (and the boot log says so), so a stale table is
  slow, never wrong.
- **Database pools.** Requests use a pool of 20 connections (5 s wait, 10 s
  per statement); schema, purges, the admin dashboard and account erasure use a
  separate pool of 3 (a minute per statement). A database that is too slow
  answers 503 "try again". Eight foreign-key indexes are built `CONCURRENTLY`
  after the server starts listening (see `server/src/schema.ts`); a build that
  fails is logged and retried at the next boot.
- **The schema at boot (stage 2).** Each statement of `server/schema.sql` that
  has taken effect is recorded in a `schema_ledger` table and skipped at the
  next boot; one not recorded yet whose index, column or table is already there
  is recorded without running. Anything else runs with a 3-second lock wait, so
  a deploy never queues behind the old instance's writes; one that fails is
  logged and tried again at the next boot. The statements a security control
  rests on are checked in the catalogue at every boot whatever the ledger says,
  and one not in force says `SECURITY` in the boot log and **fix** on
  `/admin#security`. Among them are two triggers that make the database compute
  the picture and scene hashes itself, so a release that does not know those
  columns (the previous one during the deploy overlap, or a rollback) can never
  leave a stale one; the first boot that has them recomputes every stored hash
  once, after the port is open, and until that is done the server hashes the
  bytes it reads instead of believing the stored hash. The purges run after the
  port is open too.
- **The feed's indexes and the retention sweeps (stage 3).** After the
  foreign-key indexes, the first boot of this release builds six more, also
  `CONCURRENTLY` after listen: one per community feed sort
  (`designs_feed_recent_idx`, `designs_feed_likes_idx`) and four for the
  sweeps (events, visits, notifications, shares). Once both feed indexes are
  valid it drops the two they replace (`designs_public_idx`,
  `designs_like_score_idx`), also `CONCURRENTLY`; the boot log names what was
  built and dropped. On the production database this takes seconds. Then the
  retention sweeps run (and every six hours after): expired sessions, used or
  expired email links and codes, read notifications older than 180 days, AI
  requests and shares older than 400 days rolled up per day. Each logs one
  `[tifo] retention:` line; a big first backlog is worked off in batches, at
  most 30 s per table per run, so the rest waits for the next run. Periods and
  reasons: `SECURITY-CHECKS.md` §9. Rolling back is safe: the previous release
  pages the feed by offset on the new indexes (same order), and its schema
  file's two old index statements are already in the ledger, so they are not
  rebuilt; it would only leave rolled-up rows out of its all-time share and AI
  totals (none exist until a row is 400 days old).
- **The feed cursor's key** is made once and kept in the `server_keys` table,
  so cursors outlive a deploy and work on any instance. Nothing to set. If the
  boot log says it could not be read, cursors last until the next boot and a
  visitor mid-scroll at a deploy starts again from the top.
- **Worker threads.** Scene checks and strips, and the distribution PDF, run in
  `server/build/sceneWorker.mjs` and `pdfWorker.mjs`, beside the server bundle
  (both built by `npm run build:server`, checked by `test:deploy`). Do not set
  `NODE_OPTIONS=--max-old-space-size`: V8 lets it override the workers' own
  memory limits (preflight and the posture panel say so if it is set).
- **Cloudflare.** When it goes in front, follow `CLOUDFLARE.md` in order:
  `TRUST_PROXY=cloudflare` first, and `ORIGIN_SECRET` only after the Transform
  Rule that sends it is live.

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

### Moving the app and its database to Europe (performance plan P2.1)

Most visitors are in Saudi Arabia. From there, Amsterdam is roughly 100 to 140 ms
closer per round trip than US West (an estimate), and a page makes several round
trips. Railway's regions are US West (California), US East (Virginia), EU West
(Amsterdam) and Southeast Asia (Singapore). EU West is the nearest for Saudi
visitors that Railway offers.

Move **both** services, the database first. Never leave the app and the
database in different regions: every query would cross the Atlantic, which is
much slower than today.

Before you start:

1. Check where you are: each service, **Settings → Region**. If both already say
   EU West, there is nothing to do.
2. Take a backup you hold yourself. Railway keeps volume backups with the *old*
   volume, and a failed volume move has lost data for some users. Turn on the
   Postgres TCP proxy for this only (Postgres service → Settings → Networking),
   then on your PC:
   `pg_dump --format=custom --no-owner "postgresql://…@….proxy.rlwy.net:PORT/railway?sslmode=require" -f tifo-backup.dump`
   and check it opens: `pg_restore --list tifo-backup.dump`. Always use
   `sslmode=require` over the proxy. Turn the proxy off again afterwards. Keep
   the file somewhere private: it holds every account.
3. Pick a quiet hour (late night in Saudi Arabia). The site is down while the
   database moves: Railway copies the volume first, then moves the service, and
   the time grows with the volume's size.

The move:

4. **Postgres service → Settings → Region → EU West.** Wait until the volume
   migration is finished and the service is Active again, and its log shows
   `database system is ready to accept connections`.
5. **Tifo-Maker service → Settings → Region → EU West.** It has no volume, so
   this is an ordinary redeploy.
6. Leave `DATABASE_URL` as `${{Postgres.DATABASE_URL}}` (the private network,
   `postgres.railway.internal`). No secret changes. If `DATABASE_URL` ever
   pointed at the public proxy, switch it to the reference and regenerate the
   database password.

Check it worked:

7. `/health` answers 200, and the boot log says
   `[tifo] schema: 0 applied, … already in place`. Open a project, `/community` and a share page, sign in, and look at
   the posture panel in `/admin` (everything good).
8. Compare a few counts with the backup, for example the number of designs and
   users in `/admin`.

If something goes wrong (the migration fails, or data is missing): make a new
Postgres service in EU West, restore into it with
`pg_restore --no-owner --clean --if-exists -d "<its URL>?sslmode=require" tifo-backup.dump`,
and point the app's `DATABASE_URL` at it with a reference variable.

Privacy: the data moves from the United States to the Netherlands. The privacy
policy already says some services may process data in other countries, so the
page needs no change. Saudi Arabia's PDPL has rules on transfers abroad; the EU
is generally regarded as giving strong protection, but check this yourself or
with someone qualified (this note is not legal advice).

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
