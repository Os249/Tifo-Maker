# Security checks

How TifoMaker's security is checked, how often, and what to do with what the
checks find. Written after the September 2026 audit (rounds one to three; rounds four and five in October 2026), whose rounds found
and fixed every issue listed in the regression suite (`server/test/security.test.mts`).

The rule behind all of it: **a finding is only real once it has been reproduced,
and only fixed once a test that failed on the old code passes on the new.**

---

## 1. On every push (automatic)

GitHub Actions (`.github/workflows/ci.yml`) runs these on every push and pull
request. The two scans in `security-scan` also run every Monday at 06:00 UTC,
because new advisories are published whether or not anyone pushes.

| Check | Command | Fails when |
|---|---|---|
| Types and build | `npm run build` | anything does not compile |
| Server behaviour, on real Postgres | `npm run test:server` | a route or repository regresses |
| Security regressions | `npm run test:security` | any exploit from an audit works again; any security header changes by a byte (the header pin); anything about a non-public design becomes shareable-cacheable (the cache matrix); an `/api` answer or a 404 carries no Cache-Control; the asset rate-limit bucket opens a hole (sign-in, the 300, IPv6 /64); a check stops failing closed on a database timeout |
| Security monitor | `npm run test:soc` | an attack stops being recorded, an alert stops firing, or an address gets stored |
| Email | `npm run test:email` | verification or reset mail breaks, or looks like spam |
| Deployment | `npm run test:deploy` | Node.js is within 90 days of end of life, the image runs as root, installs stop using the lockfile, CI loses its read-only token or pinned actions; the server bundle lands in `dist/`, gets a source map or a `define`, imports something that is not a runtime dependency, or tsx/esbuild reach the image; the seat table differs from what the generator makes; helmet stops being a pinned direct dependency |
| Committed credentials | `node scripts/secret-scan.mjs` | a key, token, private key or database password is in a tracked file |
| Known vulnerabilities | `npm audit --omit=dev --audit-level=high --package-lock-only` | a production dependency has a high or critical advisory |

All of it at once, locally: `npm run security:check`.

**When the scan finds a credential:** revoke it at the provider *first*, then
remove it. Deleting the line does not remove it from git history, so a
committed key is a leaked key.

**When `npm audit` fails:** `npm audit fix` (never `--force` without reading
what it changes), run the tests, commit the lockfile. If there is no fix yet,
check whether the vulnerable code is reachable from the server and write down
why in the pull request.

**When `test:deploy` says Node is near end of life:** change `FROM node:NN-slim`
(both stages) in the `Dockerfile` and `node-version` in `ci.yml` to the next
even-numbered line, and add that line's date to `server/src/nodeSupport.ts`
from <https://github.com/nodejs/Release>.

---

## 2. Every day, two minutes: the Security tab

Open `/admin#security`.

1. **The banner.** "All quiet", or the alert rules that are over threshold.
2. **Admin audit trail.** Every row that says *signed in with the admin password*
   should be you. An address tag you do not recognise means someone else has the
   password: change `AI_ADMIN_PASSWORD` in Railway, which ends every admin
   session at once.
3. **Security posture.** Anything marked **fix** is a real exposure; **check**
   is worth a look.

Alert emails go to `SECURITY_ALERT_TO`, at most one per rule per hour and
twelve a day. Each one says what to do; in short:

| Alert | First response |
|---|---|
| Someone is guessing the admin password | Not you mistyping? Change `AI_ADMIN_PASSWORD` to 20+ random characters. |
| Possible account takeover | Reset that account's password (sessions end), tell the owner. |
| Sign-in attack / one address guessing | The per-address limits are holding. If it lasts for hours or comes from many addresses, add a Cloudflare rate-limiting rule for `POST /api/auth/login`. |
| Someone is trying to flood mailboxes | Nothing was sent. Check the Resend dashboard for bounces and quota. |
| Someone is testing which emails have accounts | Watch for a sign-in attack that follows. |
| Flood of blocked requests | If real visitors are affected, turn on Cloudflare's Under Attack mode for an hour. |
| Server errors are spiking | Railway logs, filter on `"level":50`, for the stack traces. |

The dashboard never has anyone's address. To block one, find the request in the
Railway logs at the time the event shows (the log line has the address).

---

## 3. Every month, thirty minutes

- [ ] `npm run security:check` locally, on an up-to-date `main`.
- [ ] Merge or close open Dependabot pull requests (npm and GitHub Actions).
- [ ] `npm outdated` for the server's own packages (`fastify`, `@fastify/*`,
      `pg`, `pdfkit`): read the release notes of any newer patch. `npm audit`
      said 0 while `@fastify/rate-limit` 11.0.0 had CVE-2026-15144 (every
      per-address limit open over IPv6); round five found it by looking the
      packages up by hand.
- [ ] Security posture on `/admin#security` has nothing marked **fix**.
- [ ] Railway variables are as in section 6. Nothing there that is no longer used.
- [ ] Resend: domain still verified (SPF, DKIM), no rise in bounces or complaints.
- [ ] GitHub: two-factor on, secret scanning and push protection on, private
      vulnerability reporting on, and Actions' default workflow token read-only.
- [ ] Railway: the Postgres service is not reachable from the internet unless
      something outside Railway needs it; backups are enabled.
- [ ] Send a test alert from the Security tab and confirm it arrives.

---

## 4. Every quarter, and before any big launch: a full audit

Three separate passes, each reproducing what it finds against a **local** server
(`npm run server:local`, or the production image). Never against tifomaker.org:
audit traffic in production pollutes the security log, can trip the alerts, and
can hurt real visitors.

**Server attack surface** (`server/src`)
- Authentication and sessions: timing of every sign-in path, token lifetimes,
  what ends a session.
- Authorisation: every `/api/admin/*` route, every route that takes an id
  (can one account read or change another's?).
- Enumeration: does any answer, status code *or response time* reveal whether an
  account or address exists?
- Abuse of side effects: anything that sends mail, calls a paid AI provider, or
  does heavy work (PDF export) — is it bounded per address, per recipient, per
  account?
- Input bounds: every string that reaches a renderer, a regex or the database
  has a length cap; bodies have size caps; uploads are really images.
- What comes back: error bodies, log lines (no tokens, no passwords), headers.
- Caching: nothing only its owner may see (a private design's card or picture,
  any `/api` answer) can be kept by a shared cache. Look at `cache-control` on
  each, as a CDN in front would.
- Failing closed: when the database cannot answer, does every check refuse
  (the username wall, the admin-name guards, the scene strip), or does it wave
  the request through? Make the repository throw and see.
- Races: a sign-in, an email change or a provider sign-in that overlaps a
  password reset must not leave a session or a reset link behind.
- Proxy trust: `req.ip` cannot be chosen by the caller.
- Rate limits: every bucket (the general 300, the asset 600, each route's own)
  is keyed on the address with IPv6 grouped by /64, never on a header the
  caller writes, and decided on the route that answered, never the raw URL.
- Timeouts: with the database slow (a statement past 10 s, no connection
  within 5 s) every check still refuses; nothing that counts toward a cap
  reads a failure as zero.
- The headers: `test:security` pins them byte for byte; a change there must
  only ever tighten them.

**Client and admin pages** (`src/`, `server/src/adminPage.ts`)
- Every `innerHTML`, attribute and URL built from user data goes through
  `escapeHtml` (`src/core/escape.ts`) or `textContent`.
- The CSP (set in `server/src/routes.ts`) still has no `unsafe-inline` for
  scripts; no page relies on an inline script.
- Plant a marked payload in every user-controlled field, then open every screen
  in a real browser and search the DOM for it.

**Secrets, dependencies, deployment**
- Scan the whole git history, not just the working tree, for credentials.
- `npm audit` for production and development dependencies; for each advisory,
  is the vulnerable code reachable?
- The `Dockerfile`, `.dockerignore`, CI workflow and Railway settings against
  section 6.

For each finding: write the attack as a test in `server/test/security.test.mts`,
watch it fail on the current code, fix, watch it pass, and run every suite in
section 1. Record the findings and their fixes in the project notes, not in this
public repository, until they are fixed.

---

## 5. When something has happened

1. **Contain first.** Leaked key: revoke it at the provider. Admin password
   exposed: change `AI_ADMIN_PASSWORD`. Database credentials exposed: rotate
   them in Railway. An account taken over: reset its password.
2. **Then look.** The Security tab (30 days of counts, the audit trail), Railway
   logs (full detail, including addresses), Resend's activity log.
3. **Then fix the cause**, with a regression test, as in section 4.
4. **Write it down**: what happened, when it started, what it touched, what
   changed. If personal data was exposed, the law may require telling the people
   affected and a regulator within days; check before deciding it was minor.

---

## 6. Settings that matter for security

Set in Railway → the Tifo-Maker service → Variables. `.env.example` explains
each one in more detail.

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | request logs, `Secure` admin cookie, refuses to start without a database |
| `DATABASE_URL` | Railway's Postgres | required in production |
| `AI_ADMIN_PASSWORD` | 20+ random characters | guards `/admin` and the AI budget bypass |
| `ADMIN_USERNAMES` | your account's username | moderation actions; a listed name with no account is reserved, claimable only with the admin password itself (Account → rename) |
| `PUBLIC_URL` | `https://tifomaker.org` | links in emails never depend on a request header |
| `RESEND_API_KEY` | from Resend | without it no email, including alerts, is delivered |
| `EMAIL_FROM` | unset, or `TifoMaker <hello@tifomaker.org>` | a no-reply sender lands in spam |
| `SECURITY_ALERT_TO` | the inbox that should hear about attacks | spike alerts |
| `SOC_IP_KEY` | `openssl rand -hex 32` | address tags stay the same across restarts; never reuse another secret |
| `TRUST_PROXY` | unset while Railway is alone; `cloudflare` once Cloudflare is in front | never a plain `2`: see `CLOUDFLARE.md` |
| `ORIGIN_SECRET` | unset until Cloudflare's Transform Rule sends it; then `openssl rand -hex 32` | only requests that came through Cloudflare are answered; under 32 characters the server refuses to start. See `CLOUDFLARE.md`, "Lock the origin" |

---

## 7. What the server keeps, compresses and hands to workers

Speed work (performance plan, stage 2) added things the server keeps between
requests and work it does off the main thread. Each has a rule, and
`npm run test:security` holds every one of them; a change to any of these must
keep its rule or tighten it.

**Compression, and why secrets say `no-transform`.** The server compresses
nothing per request. The build writes `.br` and `.gz` copies of its files, and
`@fastify/static` sends a copy when the browser takes it (`preCompressed`);
the copies are never addressable on their own (a `.br` URL is a 404, and so is
a copy with no original), and they carry their original's cache rule and rate
bucket. Those files hold no secret.

BREACH needs four things in one response: compression, a secret in the body,
input the attacker chose reflected beside it, and a browser that sends the
victim's credential on its own. Sessions here are a bearer token a page sends
itself, never a cookie, so the fourth is missing for every `/api` answer. The
only cookies are the sealed sign-in state (`tm_oauth`), the one-use Google
handoff ticket (`tm_handoff`, `SameSite=Lax`, POST only, spent on first use)
and the admin cookie (`tm_admin`, `SameSite=Strict`, which only decides whether
the `/admin` page opens: no `/api` route accepts it); none of the answers they
ride on reflects attacker input. The `/reset` page carries its
token in the URL, never in the page. What is left is an edge compressing
on our behalf, so every answer that carries a secret is sent
`Cache-Control: no-store, no-transform`, which also tells Cloudflare not to
compress or rewrite it:

| Answer | Secret in it |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login` | a session token |
| `POST /api/auth/handoff` | a session token, for a Google or X sign-in |
| `POST /api/account/password` | the session it keeps |
| `GET /api/auth/:provider`, `POST /api/account/link/:provider` | a sealed state cookie |
| `GET /api/auth/:provider/callback` (every outcome) | the handoff ticket, or the cookie it clears |
| `GET /api/auth/verify` | the link's own token, on its way to the page |
| `GET /api/account/export` | everything the account holds |
| `POST /api/ai/unlock` | the admin token and its cookie |

**What is kept between requests.**
- *Content hashes*: the SHA-256 (hex) of each stored picture and scene is
  computed by the database itself, by a trigger on every insert and on every
  update that names the bytes or the hash, so any writer of any release (the
  previous one still serving during a deploy, or one rolled back to) keeps it
  right. The triggers are security statements (checked in the catalogue at
  every boot, and only one that fires in ordinary sessions counts: not
  disabled, not replica-only); until they are in force and every older hash
  has been recomputed from its bytes, the server hashes the bytes it reads
  instead of believing the stored hash. A boot that has to put a trigger or
  its function back recomputes again first, since rows written meanwhile may
  be stale.
- *Thumbnails*: the ETag is that hash. The visibility check runs first, then
  `If-None-Match`; a public picture is `public, no-cache` with that ETag, a
  private one is `private, no-store` with no ETag and never a 304. A design
  that stops being public answers an old ETag with the 404 anyone else gets,
  and a replaced picture never answers its old ETag with a 304.
- *Scenes*: anyone but the owner gets the scene without its layers, kept by
  design and the scene's hash (32 MB at most, counted as the memory each entry
  really holds, one version per design). Only the output of the layer strip is
  ever kept, so the cache can hold no layer; it is read only after the
  visibility check, so a private, taken-down or trashed design is never served
  from it; new bytes are a new hash, so the next view has the new banners.
- *HTML shells*: `/app`, `/clubs`, `/legal` and `/tifo-spec` are built once
  (per allowed address when `PUBLIC_URL` is unset, eight at most; with it, one)
  and sent with an ETag and `no-cache`. They hold no user data and are the same
  bytes for every caller and every forged `Host`. `/`, `/community`, `/t` and
  `/d` are never kept: they name designs, which can stop being public.
- *Page views* are written every 5 seconds in one statement. Only what the
  address-free record holds is buffered (5,000 at most; drops are counted and
  logged), and a shutdown writes what is left within 2 seconds.

**Worker threads.** Reading a scene (the save check and the layer strip) and
drawing a PDF run in worker threads (`server/src/workerPool.ts`). Each pool has
its own bounded queue (scenes 16, PDFs 4), a time limit (5 s, 30 s) and memory
limits. Anonymous views may take only 12 of the scene queue's places and an
owner's save waits ahead of them, so a flood of views never refuses a save;
and nothing waits for ever: a task not started within 5 s (PDFs 15 s) is
refused. A full queue, a wait past that, a time-out or a crash is a 503 with
`code: 'retry'`; a scene that
could not be stripped is never sent as stored. The PDF's temporary file is
removed whatever happens. The body caps, the scene's complexity caps and the
rate limits (scene saves 30 a minute, PDFs 6) are checked before the work is
queued.

A worker thread is **not a sandbox**. It is the same process: code running in
it can read `/proc/self/environ` (the server's environment, secrets included),
the server's files and its memory. Workers start with an empty `process.env`
only as defence in depth, against a careless line, not as isolation. What
keeps them safe is that the code they run is our own, never something a
request supplies, and that nothing secret is ever posted to one: only the scene
or the seats being worked on, as an exact-size copy handed over (never a view
into a shared buffer, which would carry other requests' bytes with it).

**The schema at boot.** `schema.sql` runs statement by statement, each under a
3-second lock wait, with a ledger of what has run (`schema_ledger`). The ones
the access controls stand on (the unique names and addresses, session and email
tokens, the username wall, visibility, ownership, takedown, the Trash and the
content-hash triggers) each name what the catalogue must show when they are in
force (a valid unique index, a column, a table, a function's body, a trigger
that fires in ordinary sessions); that is checked on every boot whatever the
ledger says, and again
after the run, so one that ran cleanly but left nothing in force (an invalid
index under the right name) counts too. If one is not in force, the boot log
says `SECURITY` and the posture panel marks the schema **fix** until a boot
applies it.

**The origin lock.** With `ORIGIN_SECRET` set, every request but `GET /health`
must carry it in `x-origin-secret` (Cloudflare adds it; see `CLOUDFLARE.md`).
It is compared in constant time, removed from the request before any route sees
it, and never logged. A request without it gets a 403 with the usual security
headers and `no-store`, counted in the rate limit like any other. Cloudflare's
headers arriving while `TRUST_PROXY` is not `cloudflare` make the posture row
at least a **check**, never kinder than it was (a plain `TRUST_PROXY=2` stays
**fix**, its own explanation first), and are said once a minute in the log: if Cloudflare is in front, every visitor
would share Cloudflare's addresses until `TRUST_PROXY=cloudflare` is set; if it
is not, anyone can send those headers, they are never believed, and there is
nothing to do.

**Request logs.** One line per request (`request completed`, or
`request aborted` for a client that left), with method, the URL with any token
or code replaced by `[redacted]`, address, status, time and request id; every
error keeps its own line with the same request id. Nothing else is dropped.

---

## What the Security tab keeps

Counts per minute of each kind of event, the admin audit trail and the alerts
sent, for 30 days, then deleted (`server/src/socRepo.ts`). No IP address is
stored: each is replaced by a 12-character keyed hash whose key is never in the
database. Accounts appear only by their public @name, and only when the account
exists. No password or code is ever recorded, right or wrong.
