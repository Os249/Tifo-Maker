# Putting Cloudflare in front of tifomaker.org

Optional, free, and reversible. Two things it buys you:

1. **Visitor countries in `/admin`.** Cloudflare adds a `CF-IPCountry` header to every request; the server already reads it (`server/src/routes.ts`, the `onResponse` traffic hook). Without an edge that provides it, the Countries panel stays empty — everything else on the dashboard works regardless.
2. **It absorbs the scanner noise.** The Railway logs show roughly **890 automated probe requests a week** hitting paths like `/.git/config`, `/WP`, `/old` and `/wp-login.php`. Right now every one of those wakes your Node process. Cloudflare drops them at the edge for free.

It does **not** change what you collect about people. Country is a two-letter code stored on an aggregate row — no IP is stored, before or after.

---

## Before you start

- You need access to wherever you bought **tifomaker.org**, because you will change its nameservers.
- Propagation takes anywhere from a few minutes to a few hours. The site stays up throughout if you follow the order below.
- Everything here is reversible: point the nameservers back and you are exactly where you started.

---

## 1. Add the site to Cloudflare

1. Sign up at [cloudflare.com](https://cloudflare.com) (the Free plan is all you need).
2. **Add a site** → enter `tifomaker.org` → choose **Free**.
3. Cloudflare scans your existing DNS and shows what it found.

**Check this list carefully before continuing.** It must contain the record pointing at Railway — a `CNAME` for `tifomaker.org` (or `www`) whose target ends in `.up.railway.app`. If any record is missing, add it by hand now, copying it from your current DNS provider. Anything missing here stops working the moment the nameservers switch.

Pay particular attention to your **email records** — if you have `MX` records, or the `TXT` records Resend gave you for SPF/DKIM/DMARC, they must all be carried over or your verification and password-reset emails will start bouncing.

## 2. Set the SSL mode — do this BEFORE switching nameservers

In **SSL/TLS → Overview**, set the encryption mode to **Full**.

This matters more than anything else on this page:

| Mode | What happens |
|---|---|
| **Flexible** | ❌ Infinite redirect loop (`ERR_TOO_MANY_REDIRECTS`). Cloudflare sends plain HTTP to Railway, Railway redirects to HTTPS, forever. |
| **Full** | ✅ Correct. Encrypted end to end, and tolerant of the brief certificate states during Railway's automatic renewals. |
| **Full (Strict)** | ⚠️ Works most of the time, then throws **Error 526** during a Railway certificate renewal. Railway explicitly recommends **Full**, not Full (Strict). |

## 3. Switch the nameservers

Cloudflare gives you two nameservers (something like `ana.ns.cloudflare.com`). At your domain registrar, replace the existing nameservers with those two, and save.

Cloudflare emails you when the zone is active.

## 4. Turn the proxy on

In **DNS → Records**, the cloud icon next to the `tifomaker.org` record should be **orange (Proxied)**. Orange is what gives you `CF-IPCountry` and the scanner filtering — grey means traffic bypasses Cloudflare entirely and nothing on this page applies.

**If the site shows a certificate error right after switching:** Railway may need to re-issue its certificate and Cloudflare is in the way. Toggle that record to grey (DNS only), wait a few minutes for Railway to show the domain as issued, then toggle it back to orange.

## 5. Tell the server it is behind two proxies

This step is easy to forget and it silently breaks visitor counting and rate limiting.

Your app works out a visitor's address from the `X-Forwarded-For` header. Behind Cloudflare *and* Railway there are now **two** proxies in that chain, so the server has to skip two hops to find the real client.

In Railway → your **Tifo-Maker** service → **Variables**, set:

```
TRUST_PROXY=2
```

(Use `TRUST_PROXY=1` if you ever remove Cloudflare and go back to Railway alone. `TRUST_PROXY=0` disables it entirely — only correct if nothing sits in front of the app.)

Railway redeploys automatically when you save a variable.

## 6. Block the scanners (optional, 2 minutes)

**Security → WAF → Custom rules → Create rule.**

- Name: `Block common exploit probes`
- Field `URI Path` → operator `contains` → value `/.git` — then **Or** more rows for `/wp-`, `/wp-login`, `/xmlrpc.php`, `/.env`, `/phpmyadmin`, `/vendor/`
- Action: **Block**

Also worth enabling: **Security → Bots → Bot Fight Mode** (free). It challenges obvious automated traffic before it ever reaches Railway.

Neither affects real visitors, and your dashboard already excludes bots from its numbers — this just stops paying to serve them.

## 7. Verify it worked

Give it ten minutes, then:

```bash
# Should show Cloudflare serving the site
curl -sI https://tifomaker.org | grep -i "server\|cf-ray"
```

`server: cloudflare` and a `cf-ray` header mean the proxy is live.

Then open **/admin** and check the **Countries** panel. It fills in from new visits only — existing rows keep the empty country they were recorded with, so give it a few hours of real traffic before judging it.

Sanity-check these too, since they are the things most likely to break:

- Sign up with a throwaway email → the verification email still arrives (confirms your DNS records carried over).
- Open the site normally → no certificate warning, no redirect loop.

## Rolling back

Point the nameservers at your registrar back to what they were, and set `TRUST_PROXY=1` on Railway. Nothing else in the app depends on Cloudflare — the Countries panel simply goes quiet again.

---

## Sources

- [Troubleshooting SSL — Railway Docs](https://docs.railway.com/networking/troubleshooting/ssl)
- [Working with Domains — Railway Docs](https://docs.railway.com/networking/domains/working-with-domains)
