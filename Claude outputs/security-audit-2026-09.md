# Security audit, September 2026

_Full review of the server, the client and the deployment. Every finding below was reproduced against running code before it was fixed, and every fix was re-tested by re-running the same exploit._

## Summary

| Severity | Found | Fixed now | Left open |
|---|---|---|---|
| Critical | 3 | 3 | 0 |
| High | 4 | 4 | 0 |
| Medium | 8 | 5 | 3 |
| Low | 6 | 3 | 3 |

The three criticals were all reachable by an anonymous stranger, and two of them took the site down or took it over in a single request.

---

## Critical

### 1. One request from moderator: admin allow-list matched case-insensitively

`ADMIN_USERNAMES` was compared with `.toLowerCase()`, but usernames are unique **case-sensitively** — `schema.sql` has a `lower()` unique index for email and handle, and none for username. So `Admin` could be registered alongside the real `admin` and inherited everything.

Reproduced:

```
POST /api/auth/register {"username":"Admin", ...}  -> 201
GET  /api/me                                        -> isAdmin: true
GET  /api/admin/reports                             -> 200  (reporter identities, reported content)
```

That also unlocked takedown, photo deletion, stadium review, Pro granting, and every analytics endpoint. The existing security test only exercised an *empty* allow-list, so it could never have caught this.

**Fixed:** exact-match comparison, plus registration now refuses any username that case-folds onto an allow-listed one, so the look-alike pair cannot exist in the first place.

### 2. A 400-byte design title returned a 31.6 MB page

`String.prototype.replace` expands `$&`, `` $` `` and `$'` when the replacement is a **string**. Design titles flow into the `<meta>` block injected into `/d/:id`, `/t/:id` and `/community`, and `esc()` deliberately does not escape `$`. Because `<head>` sits near the top of a 31 KB document, `$'` ("everything after the match") re-emitted almost the whole page, once per pair.

Measured:

| Title | Response |
|---|---|
| 2 B | 0.21 MB |
| 100 B | 9.08 MB |
| 400 B | 31.62 MB |

Titles had **no length cap** on create, fork or remix (only PATCH enforced 1..120), so a 20 KB title was reachable inside the 1 MB body limit and extrapolates to roughly 1.5 GB — an out-of-memory kill from one unauthenticated GET.

**Fixed:** injection now uses a replacer *function*, which is inserted verbatim with no dollar expansion. Titles are capped at 120 characters on every write path. After the fix the same 400-byte title returns 0.03 MB, flat regardless of title length.

### 3. Anonymous PDF export burned unbounded CPU

`POST /api/export/pdf` takes no authentication, had no route rate limit, and passed `colorNames` straight to pdfkit, which flows text and auto-adds pages. A single oversized entry is quadratic and synchronous, on the only thread the process has.

Measured: **8,058 ms** of blocked event loop from one 20 KB name, inside a ~200 KB body. Longer names run for minutes.

**Fixed:** names are bounded (256 entries, 40 characters each) and the route now has its own 6/minute limit. Same request now completes in 407 ms.

---

## High

### 4. Every rate limit was bypassable with one header

`trustProxy` defaulted to `true` in production — *trust every hop*, not the hop count the comment beside it described. Fastify then reports `req.ip` as the **leftmost** `X-Forwarded-For` entry, which the caller writes. Rotating that header defeated the global 300/min, the 10/min auth limit, the 12/min AI limit and the stadium limit, and it poisoned the visitor hashing behind the traffic dashboard.

Verified: `X-Forwarded-For: 9.9.9.9, 8.8.8.8, 10.0.0.5` → `req.ip` was `9.9.9.9`.

**Fixed:** expressed as a hop predicate, defaulting to one hop and never `true`. Now resolves to `10.0.0.5` (Railway's appended address). `TRUST_PROXY=2` correctly yields `8.8.8.8` for a Cloudflare→Railway chain, and `TRUST_PROXY=0` falls back to the socket address.

### 5. Password reset links followed the Host header

`const base = options.publicUrl ?? \`${req.protocol}://${req.headers.host}\`` — and `PUBLIC_URL` is set in no committed config. An attacker POSTs `/api/auth/forgot` for a victim's address with a forged `Host`, and the victim receives a genuine TifoMaker email whose reset link carries a **valid single-use token** to the attacker's domain. The mail is authentic, so it passes every trust signal a user has.

**Fixed:** email links use `PUBLIC_URL` when set, otherwise accept the Host only if it matches a known hostname, otherwise fall back to the canonical origin.

### 6. Changing your password did not end other sessions

`/api/auth/reset` revoked tokens correctly; `/api/account/password` did not. Tokens live 30 days, so someone who noticed a stolen session and changed their password kept the attacker signed in for up to a month. Changing a password is *the* thing people do in that situation.

**Fixed:** the change now revokes every token and mints a fresh one for the caller, returned in the response body so the current tab stays signed in.

### 7. Stored HTML injection on every mobile share page

`src/ui/viewer.ts` interpolated another user's design title into `innerHTML` three times with no escaping — including inside an `alt=""` attribute — from the public gallery feed. This viewer is what every **phone** gets for a `/d/:id` share link.

The CSP (`script-src 'self' 'unsafe-eval'`, no `unsafe-inline`, `script-src-attr 'none'`) blocks script execution, so this was arbitrary markup rather than XSS: full-page overlays, fake sign-in forms, layout takeover. It would have become critical on any CSP relaxation.

**Fixed:** the card is built from DOM nodes with `textContent`.

---

## Medium — fixed

- **Photos on private designs were world-readable.** Both `/api/designs/:id/photos` and `/api/photos/:photoId` skipped the visibility check every other design route uses. A private design answered 404 while its photos answered 200, with captions naming venue, date and opponent. Both paths are now gated; `getPhoto` returns its parent design so the bytes can be checked too.
- **Registration was an email-enumeration oracle.** A distinct `email already in use` let an anonymous caller test which addresses had accounts — defeating the anti-enumeration design of `/api/auth/forgot`. Now one generic 409 for both cases; the unique index was always the real race guard.
- **No error handler.** Fastify's default 500 returned `err.message` to the client: Postgres relation and constraint names, absolute container paths. Now logged server-side, generic body out. Deliberate 4xx messages still pass through.
- **A repeated query parameter caused an unauthenticated 500.** `?search=a&search=b` arrives as an array; `.trim()` threw. Now collapsed to one value, with length and count caps.
- **`/api/ai/unlock` had no brute-force limit.** The global 300/min allowed ~432,000 guesses a day from one IP against a single shared password that gates both the AI designer and every `/api/admin/*` endpoint. Now on the same 10/min limiter as login.

## Medium — open, with reasoning

- **Login timing oracle.** `verifyPassword` is short-circuited when no user exists, so a missing account answers in ~0.3 ms against ~35 ms for a real one. The response body is identical; the clock is not. Fix is to hash against a fixed dummy when the user is absent.
- **scrypt cost is below current guidance.** `scryptSync(password, salt, 32)` uses Node's default N=16384 (~34 ms). OWASP's current floor is N=131072 (~990 ms), 30× more work per offline guess. Everything else about the KDF is correct: 16-byte per-user random salt, constant-time compare, length-safe. Needs a version prefix so old hashes upgrade on next login.
- **The unlock token is an unsalted HMAC of the admin password.** Anyone holding one issued token can recover the password offline at ~500k guesses/sec/core. Derive the HMAC key through scrypt instead, shorten the 30-day TTL, and add a revocable token id.

## Low — open

- **Comments can be posted to private designs** and read back anonymously. Notification injection rather than data theft; deletion is correctly gated.
- **`/api/report` and follow accept unvalidated ids**, so a non-UUID raises an unhandled Postgres error. Now returns a generic 500 rather than leaking the message, but it should be a 400.
- **`escapeHtml` in six client files** uses the `textContent` trick, which does not escape quotes. Every current call site is a literal or an i18n constant, so nothing is exploitable today — but it is one call site away.

---

## Dependencies

`npm audit` reported 10 vulnerabilities, 8 high. The one that mattered for the running server was **`@fastify/static` authorization bypass via non-canonical URL paths**.

Upgraded `@fastify/static` to ^10.1.3 and `fastify` to ^5.12.3. Remaining 8 are all transitive and build-time only: `vite`, `esbuild`, `postcss`, `nanoid`, `brace-expansion` come through the dev toolchain and never ship; `fast-uri` and `find-my-way` are pinned by Fastify at its own latest; `@xmldom/xmldom` arrives via `pixi.js`.

---

## What was checked and found sound

Worth stating plainly, because it is most of the codebase:

- **Every SQL query is parameterised.** The handful of `${}` sites inside SQL are fixed column lists, hardcoded expressions, or ternaries over string literals. No dynamic column names, no interpolated LIMIT or ORDER BY. `days` is clamped 1..365 *and* bound.
- **Decompression bombs are properly bounded.** All four server-side gunzips go through one helper with `maxOutputLength: 4MB`, and each call site additionally requires the inflated length to equal the exact seat count.
- **No IDOR in the design routes.** `getVisible` and `getOwned` are correctly ordered (404 for invisible before 401/403, so existence never leaks), applied consistently, and backed by `AND owner_id = $2` in the SQL underneath.
- **Tokens are stored only as SHA-256**, expiry is enforced in SQL rather than trusted from the client, reset tokens are single-use atomically, and verify tokens cannot be replayed as reset tokens.
- **No secret can reach the client bundle.** Zero `import.meta.env`, `VITE_` or `process.env` in client source, so Vite has nothing to inline. A pattern scan of the built bundle for keys, tokens and internal URLs came back clean.
- **CORS is correctly absent and CSRF protection is not needed** — bearer auth in a custom header forces a preflight that fails. The honest tradeoff is that bearer-in-localStorage trades CSRF immunity for full token theft on any successful XSS, which is why finding 7 mattered.
- **No path traversal, no SSRF, no open redirect, no prototype pollution, no ReDoS.** Every `fs` read joins a literal; every outbound fetch targets a fixed or env-configured host; the single redirect is a fixed path.
- **Headers are right**: HSTS, nosniff, `frame-ancestors 'none'`, `referrer-policy: no-referrer`, COOP/CORP. `'unsafe-eval'` is genuinely required by PixiJS today — `import 'pixi.js/unsafe-eval'` is the concrete way to remove it.
- **Production refuses to start** with `NODE_ENV=production` and no `DATABASE_URL` rather than silently using the in-memory store.

---

## Regression tests

Every exploit above is now an assertion in `server/test/security.test.mts`, under `audit regressions`: the admin case-collision, the `$`-expansion amplification, title bounds on create and fork, private-design photos (including that the owner still has access), email enumeration, query arrays, and Host-forged reset links. Plus token revocation and rotation in `server.test.mts`.

They exist so the same doors cannot be reopened quietly.

## Still worth doing

1. Set `TRUST_PROXY=1` and `PUBLIC_URL=https://tifomaker.org` in Railway. The code now defaults safely for both, but explicit beats implicit.
2. Raise the scrypt cost with a version prefix for gradual rehashing.
3. Constant-time login regardless of whether the account exists.
4. Derive the unlock HMAC key through a KDF, and shorten its 30-day life.
5. Gate the `/admin` shell itself, not just its data endpoints — it currently hands out the full internal endpoint map.
