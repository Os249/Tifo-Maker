# TifoMaker — Security Audit (pre-launch code review)

**Date:** pre-launch review
**Scope:** Code-level review of the application (auth, access control, input handling,
queries, routes, file upload, dependencies) plus an automated adversarial test suite
(`server/test/security.test.mts`).

## ⚠️ Honest limitations — read this first

This is a **code audit**, not a penetration test. A clean result here means *no
vulnerabilities were found in the areas reviewed* — it does **not** prove no
vulnerabilities exist. No audit, automated or human, can guarantee "no security holes
at all." Before relying on this with real user data at scale, also commission:

- A professional third-party penetration test (network + app layer).
- Infrastructure review of the host/Railway config (TLS, env-var handling, DB access,
  backups, log hygiene).
- Ongoing dependency monitoring (e.g. Dependabot) — new CVEs appear constantly.

Areas this review did **not** cover: hosting/infra config, DDoS resilience at scale,
the Postgres server hardening, TLS termination, secret rotation, and social-engineering
vectors.

## What was reviewed and the findings

### Authentication — STRONG
- Passwords hashed with `scrypt` + per-password 16-byte random salt (`auth.ts`).
- Password comparison uses `timingSafeEqual` — no timing side channel.
- Session tokens are 256-bit random, stored only as SHA-256 hashes; the raw token
  never persists server-side.
- Auth endpoints (`/register`, `/login`) have a stricter rate limit (10/min) to blunt
  brute-force and account-enumeration.

### Access control / IDOR — STRONG
- Central `getOwned` / `getVisible` guards enforce ownership on every design mutation.
- Private designs return **404** (not 403) to non-owners — no existence leak.
- Public designs are still owner-locked for writes (403).
- Comment deletion restricted to comment author or design owner.
- Photo delete restricted to parent-design owner (or moderator).
- Verified by adversarial tests that *attempt* cross-user reads/writes and assert failure.

### Privilege escalation — STRONG
- Admin status is an **environment allow-list** (`ADMIN_USERNAMES`), not a DB flag or
  any API-settable field. No request — forged or not — can grant admin.
- Admin allow-list is **closed by default**: with no env set, all admin routes 403.

### SQL injection — NOT FOUND
- All queries use parameterized `$1, $2…` placeholders.
- The one interpolation (`${META_COLS}`) is a hardcoded column constant, not user input.
- The dynamic gallery query routes every user value through bound parameters; only
  hardcoded literals are concatenated.

### XSS — MITIGATED (+ CSP now enabled)
- All user-supplied strings (titles, usernames, comments, descriptions, search results)
  are passed through `escapeHtml()` before `innerHTML` insertion, consistently.
- The one unescaped interpolation (`r.label` in `seat.ts`) is generated server-side from
  a template + integers, not user input.
- **A Content-Security-Policy is now enabled** (helmet) with a strict allow-list:
  `script-src 'self' 'unsafe-eval'` (eval is required by PixiJS 8's shader compiler — no
  inline scripts are allowed, and `script-src-attr 'none'` blocks inline on*= handlers),
  `style-src 'self' 'unsafe-inline' + fonts/CDN`, `img-src 'self' data:`,
  `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
  plus `upgrade-insecure-requests`. Verified to break no page or dynamic flow
  (editor canvas, QR data-URI, 3D preview all work; zero CSP violations).

### File upload (photos) — STRONG
- Auth + ownership required; oversized uploads rejected at route `bodyLimit` and by a
  decoded-byte check.
- Stored as BYTEA with a generated ID — no user filename, so no path traversal.
- Content-type derived from magic bytes (not a client header), limited to JPEG/PNG/WebP.

### Transport / headers / config — GOOD
- `@fastify/helmet` registered (security headers incl. `nosniff`).
- Global rate limit (300/min) + per-route auth limit.
- Same-origin API (no permissive CORS wildcard).
- Production guard: the server **hard-exits** if `DATABASE_URL` is missing in
  `NODE_ENV=production`, preventing an insecure in-memory fallback.
- No secrets committed to the repo — all credentials come from env vars.

### Dependencies — CLEAN (production)
- `npm audit --omit=dev` → **0 vulnerabilities**.
- A high-severity `esbuild` advisory exists only in **dev/build** deps (vite, tsx); the
  CVEs are build-time/dev-server issues (Windows dev-server file read; install-time RCE
  via a malicious registry env var) and do not affect the running production server.
  Patching to the next major vite is recommended eventually but was **not** force-applied
  pre-launch to avoid a breaking build change for a non-production-runtime risk.

## Recommended follow-ups
1. ✅ **DONE** — Content-Security-Policy added (helmet, strict allow-list).
2. ✅ **DONE** — Dependabot config added (`.github/dependabot.yml`) for weekly alerts.
3. **TODO (you)** — Commission a professional penetration test before scaling to many real users.
4. **TODO (you)** — Confirm Railway: HTTPS enforced, `DATABASE_URL` and `ADMIN_USERNAMES` set
   as secrets, DB not publicly reachable, backups on.
5. **Optional** — In-app admin view for `leads` (currently DB-only) so you're not querying
   Postgres by hand.
6. **Eventual** — Upgrade vite to clear the dev-only esbuild advisory (breaking major;
   prod deps already clean, so not urgent).
