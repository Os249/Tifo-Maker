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

---

## Round four — October 2026

A full pass over everything added since round three (`7a43129`): Google
sign-in and account linking, Projects, banners, growth, the AI review queues,
community notifications, Tifo of the Day, the stadium tools. It ran as four
independent reviews:

- access control and data exposure;
- authentication, sessions and OAuth;
- client and server-rendered injection;
- abuse, DoS, secrets, dependencies and deployment.

Every finding was reproduced with a real request before it was fixed. The
`audit round four` block in `server/test/security.test.mts` repeats each
exploit. Run against the pre-fix commit (`fc8ddd7`), 44 of its 91 checks fail;
the rest are controls that already held. On the fixed code all of them pass,
on memory and on Postgres.

| Severity | Finding | Fix |
|---|---|---|
| High | **Takeover before sign-up.** An attacker registered the victim's email with a password, linked their own Google, and kept that sign-in after the victim reset the password. | Linking needs a verified email and the current password. A reset removes every connected sign-in. |
| High | **Takedowns undone by the owner.** A moderator's takedown only made the design private, so the owner could publish it again with one request, through the Trash, or through a copy. | New `taken_down_at` column. Publishing it again is refused by the route and by the repository. A restore leaves it private. Copies inherit the takedown. |
| High | **One account drained the site-wide AI budget.** Photo reading (8 calls per request) and the critic were not metered per account. One free account emptied `AI_DAILY_BUDGET` in about 11 minutes, and premium AI then rested for everyone. | Each free account gets its own daily share: 24 photo readings and 30 critiques. |
| Medium | **A stolen session became a permanent key.** Linking and moving the email needed only a bearer token, and a link started before a password change still finished afterwards. | Both need the current password. A link is bound to the session that started it. The owner is emailed about a new link or a moved email (only to a verified address, and under the per-recipient mail budget). |
| Medium | **Verification marked the account, not the address.** Hold your own verification link, switch the account to someone else's email, click: their address was "verified" and caught their first Google sign-in. | The code hash includes the address and the link carries an address tag. The account is marked verified only while its email still matches. |
| Medium | **Host allow-list bypass.** Only the part before the colon was checked, so `tifomaker.org:@evil.example` sent reset tokens to evil.example while `PUBLIC_URL` was unset. | The Host is parsed strictly (name plus optional port) and rebuilt. Escaped in page HTML. |
| Medium | **Tifo of the Day ignored takedowns.** The day's pick stayed on the home page until midnight after a takedown, unpublish or trash. | The pick is re-checked every minute and forgotten immediately on takedown, unpublish or delete. |
| Medium | **Private titles through remixes.** A public remix card showed its source's current title after the source went private. Notifications on Postgres did the same. | The source is named only while public. Notifications name only designs the recipient can see. |
| Medium | **Admin rights followed a name its owner could give up.** An admin renaming or deleting their account freed the name for anyone to register. | Admin accounts cannot be renamed or deleted from the account page. The Security tab flags allow-listed names nobody has registered. |
| Medium | **Votes from throwaway accounts.** Five unverified sign-ups decided the likes ranking and Tifo of the Day. | Voting needs a verified email. Taking a vote back is always allowed. |
| Medium | **Anonymous scene views blocked the server.** Every anonymous view of a public design's scene ran a synchronous gunzip, parse and gzip, about 290 ms each for one large scene. | Stripped scenes are cached by content hash (32 MB, least recently used first). |
| Medium | **Unbounded revision storage.** About 215 MB per minute from one account. | A diff may not be larger than the stadium, the last 200 revisions are kept, and the route is limited to 60 a minute. |
| Low | **Case-variant usernames on Postgres.** `Alice` could be registered or taken by rename next to `alice`. | Refused on every write. Added a `lower(username)` unique index (skipped and logged at boot if old duplicates exist). |
| Low | **Handoff cookie was a full session.** It was a 30-day session token, and two concurrent trades of it both succeeded. | Now a 2-minute single-use ticket, spent atomically, and not accepted as a bearer token. |
| Low | **Reset links outlived changes.** A reset link stayed valid after an email change, a password change or a successful reset. | All reset links are deleted on each of those. |
| Low | **The choose-a-username wall had gaps.** It was skipped by fork, publish, scene and revision writes, and placeholder names appeared in user search. | The wall now covers every design write. Placeholder names are hidden from search, and search escapes `LIKE` wildcards. |
| Low | **Fork ignored "no remixes".** | Fork now honours `allowRemix` for anyone but the owner. |
| Low | **Queue, notification and counter spam.** Anyone could flood the moderation queue, repeat follow and post notifications, and inflate view and share counts. | Reports must name a design the reporter can see, are de-duplicated and limited to 10 a minute. Follow and post notifications go out once. Views and shares count once per visitor per day. |
| Low | **Leads form had no limits.** | 5 per 10 minutes, and every field is capped. |
| Low | **Forged log lines.** The OAuth `error` parameter went into the log raw. | Quoted, with non-printable characters replaced. |
| Low | **Non-PNG thumbnails and share cards were stored.** | PNG signature required. |
| Low | **Private design photos could be cached publicly.** They were sent with `cache-control: public`. | Now `private, no-store`. |
| Low | **Production dependency advisories.** `fastify` 5.12.3 had an HTTP/2 DoS, and `fast-uri` had two flaws. | Lockfile updated to `fastify` 5.12.5 and `fast-uri` 4.2.1 (also `source-map-js`, dev only). Production dependencies now have 0 advisories. |
| Hardening | **Inconsistent escaping.** The server pages and the admin dashboard used their own escapers without single quotes, and two admin header values went into HTML raw. | Both now use the shared escaper. |

**Found sound.** Everything below was checked and needed no change:

- no stored or reflected XSS in the new client code, the server-rendered pages or the admin dashboard (all hostile values rendered escaped);
- the CSP is unchanged;
- OAuth state, PKCE and redirects are sound;
- no SSRF: every outbound host is fixed;
- no image decode bombs: images are never pixel-decoded on the server;
- no credentials in tracked files;
- error bodies and `/health` reveal nothing;
- the deployment hardening from round three is intact.

**Residual risks and open items:**

- **Admin unlock token.** It is stateless; a leaked one lives its 12 hours unless `AI_ADMIN_PASSWORD` is changed.
- **AI image spend.** Image generation inside a design is metered by the per-provider credit breaker, not by `AI_DAILY_BUDGET`.
- **Analytics retention.** `/api/events` rows have no retention pruning.
- **Development server.** vite and esbuild advisories remain; they affect only the dev server, and the fix is the vite 8 upgrade.
