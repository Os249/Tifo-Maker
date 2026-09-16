# Security checks

How TifoMaker's security is checked, how often, and what to do with what the
checks find. Written after the September 2026 audit, whose three rounds found
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
| Security regressions | `npm run test:security` | any exploit from an audit works again |
| Security monitor | `npm run test:soc` | an attack stops being recorded, an alert stops firing, or an address gets stored |
| Email | `npm run test:email` | verification or reset mail breaks, or looks like spam |
| Deployment | `npm run test:deploy` | Node.js is within 90 days of end of life, the image runs as root, installs stop using the lockfile, CI loses its read-only token or pinned actions |
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
- Proxy trust: `req.ip` cannot be chosen by the caller.

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
| `ADMIN_USERNAMES` | your account's username | moderation actions |
| `PUBLIC_URL` | `https://tifomaker.org` | links in emails never depend on a request header |
| `RESEND_API_KEY` | from Resend | without it no email, including alerts, is delivered |
| `EMAIL_FROM` | unset, or `TifoMaker <hello@tifomaker.org>` | a no-reply sender lands in spam |
| `SECURITY_ALERT_TO` | the inbox that should hear about attacks | spike alerts |
| `SOC_IP_KEY` | `openssl rand -hex 32` | address tags stay the same across restarts; never reuse another secret |
| `TRUST_PROXY` | unset while Railway is alone; `cloudflare` once Cloudflare is in front | never a plain `2`: see `CLOUDFLARE.md` |

---

## What the Security tab keeps

Counts per minute of each kind of event, the admin audit trail and the alerts
sent, for 30 days, then deleted (`server/src/socRepo.ts`). No IP address is
stored: each is replaced by a 12-character keyed hash whose key is never in the
database. Accounts appear only by their public @name, and only when the account
exists. No password or code is ever recorded, right or wrong.
