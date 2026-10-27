# Putting Cloudflare in front of tifomaker.org

Optional, free, and reversible. What it buys:

1. **Speed for Saudi visitors.** Cloudflare has data centres in Riyadh, Jeddah and Dammam. The TLS handshake and every hashed file under `/assets/` are answered there instead of crossing to Railway: a cold connection drops from about 540 ms to 100–150 ms, and a first visit's scripts and styles arrive 0.8–1.2 s sooner (estimates from the October 2026 performance plan, item P2.2).
2. **Visitor countries in `/admin`.** Cloudflare adds a `CF-IPCountry` header; the server believes it only when the request really came through Cloudflare (`server/src/proxyTrust.ts`).
3. **It absorbs the scanner noise.** Roughly 890 automated probes a week (`/.git/config`, `/wp-login.php`, ...) can be dropped at the edge.

It does **not** change what is collected about people: no IP is stored, before or after. But Cloudflare processes every request, so the privacy section of `legal.html` must name it **before** the orange cloud goes on: step 3 of the order below has the exact sentences.

The rules below are not suggestions. Each one exists because getting it wrong either leaks one person's data to another or switches off a security control. They were checked against the code by the plan's security review.

---

## The order to do things in

1. **`TRUST_PROXY=cloudflare` in Railway, first** (section 3). Safe with Railway alone: the extra hop is believed only from Cloudflare's own addresses, so until Cloudflare is in front nothing changes.
2. **Add the site, the SSL mode, the rules and the switches** (sections 1, 2, 4, 5), with the DNS record still grey (DNS only).
3. **Name Cloudflare in the privacy policy, and deploy that** (section 6, step 1), before anything goes through Cloudflare.
4. **Turn the orange cloud on** (section 6, step 2), and check (section 8).
5. **Lock the origin** (section 7): the Transform Rule in Cloudflare first, then `ORIGIN_SECRET` in Railway. In that order: the other way round, every request is refused until the rule exists.

If something looks wrong at any point: grey cloud (DNS only), and you are back where you started.

---

## 1. Add the site to Cloudflare

1. Sign up at [cloudflare.com](https://cloudflare.com) (the Free plan is enough).
2. **Add a site** → `tifomaker.org` → **Free**.
3. Cloudflare scans the existing DNS. **Check the list before continuing**: it must contain the record pointing at Railway (a `CNAME` whose target ends in `.up.railway.app`), and every email record (`MX`, and the `TXT` records Resend gave you for SPF/DKIM/DMARC). Anything missing stops working the moment the nameservers switch; verification and reset emails would start bouncing.
4. Set that Railway record to **grey (DNS only)** for now.
5. At your registrar, replace the nameservers with the two Cloudflare gives you. Cloudflare emails you when the zone is active.

## 2. SSL/TLS

- **SSL/TLS → Overview → Full.** Not Flexible (an endless redirect loop: Cloudflare sends HTTP, Railway redirects to HTTPS, forever). Not Full (Strict): Railway says not to use it, because certificate renewals then show Error 526.
- **Edge Certificates → Always Use HTTPS: on. Minimum TLS version: 1.2.** Leave 0-RTT at its default.
- HSTS already comes from the server (one year, includeSubDomains). Do not turn on HSTS preload in Cloudflare.

Accepted residual: in Full mode Cloudflare does not verify Railway's certificate, so someone who could sit between Cloudflare and Railway would not be detected. A Cloudflare Tunnel would remove that, at the price of a different proxy setup (it needs its own `TRUST_PROXY` mode and tests; do not reuse `cloudflare` mode untested).

## 3. Tell the server it is behind Cloudflare

In Railway → the Tifo-Maker service → **Variables**:

```
TRUST_PROXY=cloudflare
```

**Never `TRUST_PROXY=2`, and never leave it unset behind Cloudflare.**

- Unset (or `1`): the server takes Cloudflare's edge for the visitor. Everyone behind one Cloudflare data centre shares one set of rate limits (300 a minute, 10 sign-ins a minute): a self-inflicted outage for a whole country. The server notices: a request carrying `cf-ray` while the mode is not `cloudflare` writes a warning to the log (at most once a minute) and turns the posture panel's *Client address* row red.
- `2`: believes the extra hop whoever wrote it. Cloudflare does not stop anyone connecting to Railway directly, so a script that skips Cloudflare picks its own address on every request and is never rate limited.
- `cloudflare`: believes the extra hop only when the connection really came from one of Cloudflare's published ranges (the list is in `server/src/proxyTrust.ts`). Only then is `CF-IPCountry` believed. `CF-Connecting-IP`, `True-Client-IP` and `X-Real-IP` are never used for anything.

Railway redeploys when you save a variable.

## 4. What Cloudflare may keep, and what it must not

**Caching → Cache Rules**, in this order (the first that matches wins):

| # | Name | When | Then |
|---|---|---|---|
| 1 | Bypass private and dynamic | URI path starts with `/api/`, `/og/`, `/admin`, `/auth`, `/reset`, `/account`, `/projects`, `/s/`, `/ar/reset`, `/ar/account`, `/ar/projects` or `/ar/s/`, or equals `/health` | **Bypass cache** |
| 2 | Bypass credentials | the request has an `Authorization` or a `Cookie` header **and** the path does not start with `/assets/` | **Bypass cache** |
| 3 | Hashed build files | URI path starts with `/assets/` | **Eligible for cache**, Edge TTL: *Use cache-control header if present* (the server sends a year, immutable) |

Everything else, every HTML page included, is **never cached**: do not add a rule for it, and never turn on "Cache Everything".

**The Arabic pages.** Every page whose words exist in Arabic has a twin under `/ar/` (`/ar/`, `/ar/community`, `/ar/t/…`, `/ar/d/…`, `/ar/s/…`, `/ar/app`, `/ar/clubs`, `/ar/legal`, `/ar/reset`, `/ar/account`, `/ar/projects`). The server answers each exactly like its English page: the same headers, the same `Cache-Control`, the same checks, the same limits. So every rule here that names a path names its `/ar/` twin as well, and any rule you add later for a page must too: a rule for `/reset` alone would leave `/ar/reset` to the defaults. The language is in the path and nowhere else; no rule, Worker or Transform may pick it from a cookie or `Accept-Language`, and nothing at the edge may vary a page on either.

As an expression, rule 1 is:

```
(starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/og/")
 or starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/auth")
 or starts_with(http.request.uri.path, "/reset") or starts_with(http.request.uri.path, "/account")
 or starts_with(http.request.uri.path, "/projects") or starts_with(http.request.uri.path, "/s/")
 or starts_with(http.request.uri.path, "/ar/reset") or starts_with(http.request.uri.path, "/ar/account")
 or starts_with(http.request.uri.path, "/ar/projects") or starts_with(http.request.uri.path, "/ar/s/")
 or http.request.uri.path eq "/health")
```

Why each matters:

- **`/api/` answers differ by who asks.** A design's owner gets its pictures (the scene's layers) and its private fields; the gallery carries the caller's own votes; `/api/me`, notifications and the account export are one person's. Cloudflare keys its cache on the URL, not on who is asking, and does not honour `Vary: Authorization`. The server marks all of these `no-store` (or `private, no-store`), and rule 1 makes sure nothing at the edge ever second-guesses that.
- **Pictures and cards (`/og/`, thumbnails) can be taken down.** A public design's picture says `public, no-cache` with an ETag: the browser revalidates it every time, which is cheap (a 304). At the edge it would need a purge on every unpublish and takedown, which does not exist, so it stays out.
- **HTML lists and names designs.** `/`, `/community`, `/t/…` and `/d/…`, and their Arabic twins `/ar/`, `/ar/community`, `/ar/t/…` and `/ar/d/…`, read the database on every request, so a takedown or an unpublish is seen by the next visitor. Cloudflare's default edge TTL for a page is two hours.
- **No Edge TTL override ("Ignore cache-control header") on any rule that can match `/api`.** An override makes Cloudflare strip `Set-Cookie` and cache the answer: the Google sign-in (`tm_oauth`, `tm_handoff`) and the admin unlock (`tm_admin`) would break, or worse, be shared.
- **Answers that carry a secret say `no-store, no-transform`** (a session token, a sign-in ticket, the account export; see `SECURITY-CHECKS.md`): nothing between the server and the browser may store, rewrite or recompress them.

**Caching → Configuration:**

- **Browser Cache TTL: Respect Existing Headers.** A fixed value would turn the pages' `no-cache` into hours of browser caching.
- **Cache Deception Armor: on.**
- **Always Online: off.** It serves stored copies of pages when the server is down, including pages of designs taken down since.

The server already sends brotli and gzip copies of the build files (made at build time), with `Vary: Accept-Encoding`. Cloudflare passes them on.

## 5. Features that must stay off

| Feature | Setting | Why |
|---|---|---|
| Rocket Loader | **Off** | Rewrites every script tag into an inline loader. The CSP blocks inline script (`script-src 'self'`), and answering that with `'unsafe-inline'` would hand any XSS every 30-day session. |
| Email Address Obfuscation (Scrape Shield) | **Off** | Rewrites the HTML and injects a Cloudflare script that runs with the page's privileges. |
| Zaraz | **Off** | Inline injection, needs CSP changes, and is third-party tracking, which `legal.html` says the site does not do. |
| Web Analytics / RUM beacon | **Off** | A third-party script origin the CSP blocks; same legal conflict. Never relax the CSP for it. |
| Mirage (Polish → Mirage) | **Off** | Injects script. |
| Pseudo IPv4 | **Off** | "Overwrite headers" replaces the visitor's IPv6 address with a made-up IPv4 one, which undoes the per-/64 grouping every rate limit relies on (CVE-2026-15144). |
| Always Online | **Off** | See section 4. |
| Automatic HTTPS Rewrites, Early Hints, HTTP/3, Brotli | fine | Change no content the CSP cares about. |
| Bot Fight Mode | fine | Its JavaScript detections are served from `/cdn-cgi/` on this origin. If one is ever blocked by the CSP, leave it blocked: never answer with `'unsafe-inline'`. |
| Speed Brain | fine | Prefetches only from Cloudflare's own cache, never from the origin. |

Optional, two minutes: **Security → WAF → Custom rules**, "Block common exploit probes": URI Path contains `/.git`, `/wp-`, `/xmlrpc.php`, `/.env`, `/phpmyadmin`, `/vendor/` → Block. The server's own rate limits stay in force behind it: a Cloudflare rule is an extra layer, never a replacement.

## 6. Turn the proxy on

1. **The privacy policy first.** In `legal.html`, section "Who else is involved", add these sentences to the paragraph that lists the services, right after "...when you use the AI Designer).", deploy, and check it is live on `/legal`. The page's own text is English; the Arabic is for the page's Arabic version and for the string table if that paragraph is ever translated (`src/ui/i18n/strings.ts`):

   - **English:** "Cloudflare sits in front of the site as a content delivery and security network: every request to the site passes through it, including your IP address and the address of the page you ask for, so that pages load quickly and attacks are stopped. Cloudflare processes this on my behalf under its own privacy policy, and keeps copies only of the site's public files, never your account or your private designs."
   - **العربية:** "تمرّ كل الطلبات إلى الموقع عبر Cloudflare، وهي شبكة لتوصيل المحتوى وحمايته، بما في ذلك عنوان IP الخاص بك وعنوان الصفحة التي تطلبها، حتى تفتح الصفحات بسرعة وتُصدّ الهجمات. تعالج Cloudflare هذه البيانات نيابةً عني وفق سياسة الخصوصية الخاصة بها، ولا تحتفظ إلا بنسخ من ملفات الموقع العامة، ولا تحتفظ أبدًا بحسابك أو بتصاميمك الخاصة."

   Do this before step 2: from the moment the cloud is orange, every visitor's requests go through Cloudflare.

   *Done on 27 October 2026.* `legal.html` has the English sentences as written above, and its Arabic half says the same in the page's own Saudi wording (والموقع يمرّ عبر Cloudflare…). The Cookies section in both languages also says Cloudflare may set a short-lived security cookie of its own when it needs to tell people apart from automated attacks (Bot Fight Mode or a challenge). Check both are live on `/legal` and `/ar/legal` before the cloud goes orange.
2. **DNS → Records** → the `tifomaker.org` record → **orange (Proxied)**.

If a certificate error appears right after: Railway may need to re-issue its certificate. Grey it, wait for Railway to show the domain as issued, orange again.

## 7. Lock the origin

Behind Cloudflare, anyone can still reach Railway directly at its own address and skip every Cloudflare rule. The server can refuse them: with `ORIGIN_SECRET` set, every request except `GET /health` (Railway's healthcheck) must carry the header `x-origin-secret` with that exact value, or it is answered 403 (the security headers, `no-store`, and counted by the rate limits like any request). The header is compared in constant time, deleted from the request once checked, and never written to a log. Without `ORIGIN_SECRET` nothing changes.

1. Make a secret: `openssl rand -hex 32` (64 characters; the server refuses to start with fewer than 32).
2. **Cloudflare first.** Rules → **Transform Rules** → **Modify Request Header** → Create rule:
   - Name: `Origin secret`
   - When incoming requests match: **All incoming requests** (or Hostname equals `tifomaker.org`)
   - Then: **Set static**, header name `x-origin-secret`, value: the secret
   - Deploy. (Check the rule type is available on your plan in the dashboard before relying on it.)
3. **Then Railway:** Variables → `ORIGIN_SECRET` = the same secret. Railway redeploys.
4. Check:
   ```bash
   # Through Cloudflare: 200
   curl -s -o /dev/null -w '%{http_code}\n' https://tifomaker.org/api/templates
   # Straight to Railway, without the secret: 403
   curl -s -o /dev/null -w '%{http_code}\n' https://<your-service>.up.railway.app/api/templates
   # The healthcheck still answers: 200
   curl -s -o /dev/null -w '%{http_code}\n' https://<your-service>.up.railway.app/health
   ```

The posture panel on `/admin#security` says *Cloudflare mode … The origin is not locked* until `ORIGIN_SECRET` is set.

**To change the secret:** remove `ORIGIN_SECRET` in Railway (the lock is off), change the Transform Rule's value, set the new `ORIGIN_SECRET`. Never the other way round.

Residual: the secret is a shared one, and Cloudflare holds a copy. It stops scanners and anyone who only knows the Railway address; it is not mutual TLS. Treat it like any other secret: never in the repository, rotate it if it may have leaked.

## 8. Check it worked

```bash
curl -sI https://tifomaker.org | grep -i "server\|cf-ray"          # server: cloudflare, a cf-ray
curl -sI https://tifomaker.org/assets/<any-hashed-file>.js | grep -i "cf-cache-status\|content-encoding"   # HIT after the second request, br
curl -sI https://tifomaker.org/api/me | grep -i "cf-cache-status\|cache-control"   # DYNAMIC or BYPASS, no-store
curl -sI https://tifomaker.org/ | grep -i "cf-cache-status\|cache-control"         # DYNAMIC, no-cache
curl -sI https://tifomaker.org/ar/ | grep -i "cf-cache-status\|cache-control"      # the same as /: DYNAMIC, no-cache
curl -sI https://tifomaker.org/ar/reset | grep -i "cf-cache-status\|cache-control" # BYPASS, no-cache (rule 1)
```

Then:

- `/admin#security` → *Client address*: Cloudflare mode, no warning.
- Sign up with a throwaway email: the verification email arrives (the DNS records carried over).
- A Google sign-in works end to end (cookies were not stripped).
- Measure `/health` from Saudi Arabia before and after. If the time to first byte rose (a known Railway issue routes some Cloudflare-proxied domains to a distant Railway edge), grey the record and report it.

## Rolling back

Grey cloud (DNS only) for an immediate rollback; point the nameservers back at the registrar to leave Cloudflare entirely. Then remove `ORIGIN_SECRET` and set `TRUST_PROXY=1` (or delete it) in Railway. Nothing else in the app depends on Cloudflare.

---

## Sources

- [Railway: troubleshooting SSL](https://docs.railway.com/networking/troubleshooting/ssl) (use Full, not Full (Strict))
- [Railway: working with domains](https://docs.railway.com/networking/domains/working-with-domains)
- [Cloudflare: default cache behaviour](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
- [Cloudflare: cache behaviour and Edge TTL overrides](https://developers.cloudflare.com/cache/concepts/cache-behavior)
- [Cloudflare: Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/set-browser-ttl/)
- [Cloudflare: request header Transform Rules](https://developers.cloudflare.com/rules/transform/request-header-modification/)
- [Cloudflare: HTTP headers it sends to the origin](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
