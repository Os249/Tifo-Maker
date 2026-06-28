# TifoMaker — Launch checklist

A practical, solo‑operator guide to going live. Work top to bottom. Items marked
**(you)** need your input; the rest is already built.

## 1. Fill in your details **(you)**
- `legal.html` → replace every `[CONTACT EMAIL]` with an address you actually watch
  (a dedicated `hello@tifomaker.org` is better than a personal inbox).
- That's the only placeholder left — the legal pages otherwise read as a solo dev,
  with today's date, Saudi law, and an "built with the help of AI" note.

## 2. Environment variables **(you)**
Copy `server/.env.example` to your host's env. Required / recommended:
- `DATABASE_URL` — Postgres (required in production).
- `PUBLIC_URL` — e.g. `https://tifomaker.org` (used in email links; no trailing slash).
- `RESEND_API_KEY` + `EMAIL_FROM` — for verification + password‑reset email.
- `ADMIN_USERNAMES` — your username(s); these get unlimited AI + the /admin dashboard.
- `AI_ADMIN_PASSWORD` — optional unlock for AI without an account.
- AI provider key (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
- `AI_FREE_FOR_ALL` — leave `true` for now (AI free for any verified account).

Never commit a real `.env`. The repo's `.gitignore` should exclude it — double‑check.

## 3. Email deliverability **(you)**
In Resend: add your sending domain and set the **SPF, DKIM, and DMARC** DNS records
it gives you. Without verifying the domain, verification/reset emails will land in
spam or bounce. Send yourself a test sign‑up to confirm inbox delivery.

## 4. Build + test
```
npm install
npm run build            # typecheck + bundle (the real gate)
npm run test:server      # memory + Postgres suites
```
CI (GitHub Actions) runs the same on every push, against a real Postgres.
The database schema applies automatically on server boot (`applySchema`).

## 5. What's already protecting you
- **Accounts are 18+**, email‑verified, minimal data (email + hashed password only).
- **AI is gated** to verified accounts; a prompt safety screen blocks the clearly
  harmful categories before the model sees them.
- **Acceptable Use** rules + a **Report button** on every community design.
- **Data rights:** users can export their data and delete their account (avatar menu).
- **Security headers + CSP** (helmet) are on; tokens are stored hashed.
- Cookie consent gates analytics; nothing tracks until the user accepts.

## 6. Moderation habit **(you — most important)**
Watch your contact/abuse email and the reports. Reports land in the moderation
queue (visible at `/admin` for `ADMIN_USERNAMES`, or directly in the `reports`
table). **Removing reported content quickly is your single best protection.**
You comply with lawful requests from authorities — you don't volunteer user data
beyond what's lawfully required.

## 7. Backups & monitoring **(you)**
- **Backups:** schedule a daily `pg_dump` of `DATABASE_URL` to off‑box storage,
  and actually test a restore once. (Most hosts offer automated PG backups — turn
  them on.)
- **Monitoring:** an uptime check on `/` and your server error logs; watch the
  Resend dashboard for email bounces.

## 8. When you go paid (later)
- Set `AI_FREE_FOR_ALL=false` → enforces `AI_FREE_LIMIT` (default 5) per month.
- Set a user's `is_pro = true` for unlimited (no payment processor wired yet —
  add a checkout that flips that flag when you're ready).

## 9. Legal **(you)**
The legal pages are honest, conservative drafts — **not** legal advice. If you can
ever afford a one‑time review (PDPL + user‑generated content + AI), it's worth it.
Until then, what you have is fair and protective.

---
_Independent project, built with the help of AI._
