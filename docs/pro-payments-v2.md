# Pro payments v2 (16 Nov 2026)

What was added on top of payments v1 (the hosted invoice), how to switch each
part on, and what is still to ask Moyasar. Everything here is **off until its
own Railway variable is set**: with none of them set the site behaves exactly
as it did before this change.

Code: `server/src/payments.ts` (the rules and switches, with the long notes),
`moyasar.ts` (the API client), `moyasarProxy.ts` (the proxy tunnel),
`payRepo.ts` (orders and subscriptions, and the locks), `payRoutes.ts`,
`payRenewMail.ts` (the renewal emails), `src/proPage.ts` (the form on /pro),
`src/ui/proAccount.ts` (the account page). Tests: `server/test/payments2.test.mts`,
`e2e-pay-form.mjs`, with the stand-in Moyasar in `scripts/fake-moyasar.mjs`.

Refund emails, the account page's purchases and refund requests came after
this (19 Nov 2026): see `docs/pro-refunds.md`. The launch price, the founders
list and email, and the founders bonus are in `docs/pro-launch.md`.

## The variables

| Variable | What it does | Default |
| --- | --- | --- |
| `MOYASAR_PROXY_URL` | Sends the server's calls to Moyasar, and nothing else, through this HTTP proxy (`http://user:password@host:port`). | unset: direct |
| `PRO_CHECKOUT=form` | "Get Pro" opens Moyasar's payment form on /pro instead of going to the hosted page. | hosted invoice |
| `MOYASAR_PUBLISHABLE_KEY` | `pk_test_...` or `pk_live_...`, for the form. Must be the same mode as the secret key. | unset |
| `MOYASAR_METHODS` | What the form offers: `creditcard`, `applepay`, `stcpay`, `samsungpay`, comma-separated. | `creditcard` |
| `APPLE_PAY_DOMAIN_ASSOCIATION` | The contents of Apple Pay's domain file from Moyasar. Served at `/.well-known/apple-developer-merchantid-domain-association`. | unset: 404, no Apple Pay |
| `MOYASAR_SAMSUNG_SERVICE_ID` | Samsung Pay's service id, if you ever register one. | unset |
| `MOYASAR_VERIFY=webhook` | No secret key on the server: the form is the checkout and Pro is given from Moyasar's webhook alone. | unset: read back with the secret key |
| `PRO_AUTORENEW=on` | Offers "Keep Pro on" on the form and charges renewals. | off |
| `PRO_AUTORENEW_MADA=off` | Keeps mada payments one-time (the form says so before paying). Use it if Moyasar says mada tokens cannot be charged with no fan present (question 3 below). | unset: mada renews like any card |

`/admin` → Pro shows, under Payments, how it is set up right now ("the payment
form on /pro (creditcard, applepay); every payment is read back from Moyasar
with the secret key; auto-renew is ON (mada included)") and warns when a
variable is set but not in use. The server's start-up log warns the same way,
naming variables and never printing their values.

## How to switch it on

Do each one first with **test keys in preview** (`PRO_MODE=preview`,
`PRO_PREVIEW_USERS=<you>`), exactly as v1 was tried, then with live keys.

### 1a. Fixed-IP proxy (live secret key locked to "Allowed IPs")

Use this if Moyasar will not clear the Allowed IPs list. It keeps everything:
server-side verification, refunds from /admin, auto-renew.

1. Get an HTTP proxy with fixed outbound addresses (Fixie is one; check its
   free plan's monthly request limit: a purchase is usually 2 to 4 calls to
   Moyasar, a renewal 1 or 2).
2. Railway → Variables: `MOYASAR_PROXY_URL=http://user:password@host:port`
   (the address the proxy gives you; it holds a password, so it goes only
   there).
3. Moyasar dashboard → Settings → API Keys → Live → Allowed IPs → Specific
   addresses: add the proxy's outbound IPs (the proxy's dashboard lists
   them). Saving the live list asks for a 6-digit code.
4. Check: /admin → Pro says "calls to Moyasar go through the fixed-IP proxy";
   press "Get Pro" yourself. If the proxy or the list is wrong, the page says
   "Payments can't be reached right now, and nothing was charged" and the log
   says `Moyasar answered 0 (proxy)` or `401 (authentication_error)`.

Only `api.moyasar.com` goes through the proxy, inside a CONNECT tunnel with
TLS end to end: the proxy sees the destination and encrypted bytes, never the
key or the payment. Email, AI and everything else still go out directly.

### 2. Moyasar's payment form on /pro

1. Moyasar dashboard → Settings → API Keys: copy the **publishable** key of
   the same mode as your secret key.
2. Railway → Variables: `PRO_CHECKOUT=form`, `MOYASAR_PUBLISHABLE_KEY=pk_...`.
   Leave `MOYASAR_METHODS` unset for cards and mada only.
3. Webhook (recommended, as in v1): Settings → Webhooks → endpoint
   `https://tifomaker.org/api/pro/pay/webhook`, method POST, the secret token
   equal to `MOYASAR_WEBHOOK_SECRET`, events `payment_paid`, `payment_failed`,
   `payment_refunded`, `payment_voided`. Moyasar then sends a 6-digit code:
   it shows on /admin → Pro; type it into Verify Webhook within 30 minutes.
4. **Apple Pay** (optional, needs the live account):
   - Moyasar dashboard → Settings → Apple Pay Domains → add `tifomaker.org`
     (the exact host fans use; add `www.tifomaker.org` too if it serves pages).
   - Press **Download Association**. Open the file in a text editor and paste
     its whole contents into Railway as `APPLE_PAY_DOMAIN_ASSOCIATION`
     (or commit the file, with no extension, as
     `public/.well-known/apple-developer-merchantid-domain-association`).
   - After the deploy, open
     `https://tifomaker.org/.well-known/apple-developer-merchantid-domain-association`
     and see the same text. Back in Moyasar press **Validate**, then
     **Register**.
   - Railway: `MOYASAR_METHODS=creditcard,applepay`. The button shows only in
     Safari on Apple devices.
5. **STC Pay**: ask your Moyasar account manager to enable it, then add
   `stcpay` to `MOYASAR_METHODS`.
6. To go back to the hosted page at any time: remove `PRO_CHECKOUT`.

What changes on the page: "Get Pro" opens the form in the Pro column; the
form's Pay button is the screen's one blue button. Only /pro, and only while
the form is on, gets a wider Content-Security-Policy: `connect-src` adds
`https://api.moyasar.com`, and with Apple Pay on, `script-src` and `font-src`
add `https://applepay.cdn-apple.com` (Apple's own SDK). The form's script is
Moyasar's npm package `moyasar-payment-form` pinned at 2.3.1 and served from
our own `/assets`, so `script-src` needs no Moyasar host. Nothing is framed:
3-D Secure is a full-page visit to the bank and back.

The card never touches our server: the form posts it from the browser to
`api.moyasar.com`. The server chooses the payment's id beforehand
(`given_id`), and after the fan returns it reads that payment with the secret
key and gives Pro only if it is paid, in riyals, for the order's amount, and
names the order.

### 1b. No secret key on the server (`MOYASAR_VERIFY=webhook`)

The last resort if neither a cleared IP list nor a proxy is possible.

1. Railway → Variables: `MOYASAR_VERIFY=webhook`,
   `MOYASAR_PUBLISHABLE_KEY=pk_...`, `MOYASAR_WEBHOOK_SECRET=<24+ random
   characters>`; **remove** `MOYASAR_SECRET_KEY` and `MOYASAR_PROXY_URL`.
2. Set up the webhook as in step 3 above. It is no longer optional: without
   it nothing is ever marked paid.
3. Refunds are made in Moyasar's dashboard (Payments → the payment → Refund).
   The webhook then ends the pass here. /admin's Refund button says so.

**What this mode trusts that v1 and the other modes do not:**

- **The webhook's body is believed.** Nothing is read back from Moyasar. Pro
  is given when a POST arrives carrying the right `secret_token`, the right
  mode (`live`), the payment id this server chose for the order, status paid,
  the order's amount in SAR, and the order's id in the metadata. Anyone who
  learns `MOYASAR_WEBHOOK_SECRET` can therefore forge "paid" for an order of
  their own. Moyasar's webhooks carry only this shared secret in the body
  (no signature), so keep the secret long, in Railway only, and change it if
  it may have leaked.
- **Delivery.** Moyasar retries a webhook 5 times over about 4 hours and then
  drops it. If every try fails (the site was down), the fan has paid and has
  no Pro until you give it by hand in /admin (the order shows as "Not paid
  yet"; check it in Moyasar's dashboard first).
- **The fan waits on the webhook.** Back from the bank the page says
  "Checking your payment…" until the webhook arrives (normally seconds).
- **No auto-renew, no refunds from /admin, no deleting tokens**: all three
  need the secret key.

### 3. "Keep Pro on" (optional auto-renew)

Needs option 2 (the form) and the secret key (so not 1b).

1. Confirm with Moyasar that **Tokenization** is on for your account
   (question 2 below). mada cards renew like any other (decided 17 Nov 2026,
   before Moyasar's answer to question 3). If Moyasar says a mada token
   cannot be charged with no fan present, set `PRO_AUTORENEW_MADA=off`; until
   then such a renewal would simply fail, with nothing charged, and after the
   retries auto-renew ends for that fan with an email.
2. Railway → Variables: `PRO_AUTORENEW=on`.
3. Check in preview with test keys: tick the box, pay, see "Renews on …" on
   /account, press "Turn off auto-renew", and read the three emails (receipt,
   then "auto-renew is off").
4. /legal shows the auto-renew terms by itself once Pro is on sale to
   everyone (live key, `PRO_MODE=on`) and this is on.

How it behaves:

- The box is never ticked for the fan. It shows the price and the date of the
  first renewal, the 3-day reminder, one-click cancel, and which methods can
  renew. Ticking it is recorded on the server (with the time) before the form
  asks Moyasar to save the card.
- A subscription starts only if the order asked for it, Moyasar returned a
  token, the method can renew (cards including mada, Apple Pay, Samsung Pay;
  not mada when `PRO_AUTORENEW_MADA=off`) and the token is active. Otherwise
  the token is deleted at once and the month is a one-time pass; the page
  says so.
- A job runs every 15 minutes. About 3 days before a renewal it emails the
  reminder (Arabic and English: amount, date, card, one-click cancel link).
  A renewal is never charged unless that email was sent at least 3 days
  earlier; if it could not be sent, the renewal waits, and after a week
  auto-renew ends by itself.
- Each renewal is an order like any other: a receipt, one pass, a refund
  through /admin. A refund also turns auto-renew off.
- A failed renewal is retried after 1, then 2, then 3 more days; the fan is
  emailed once; after the last try auto-renew ends, with an email, and Pro
  simply runs out. An expired card ends it at once with an "update your
  card" email. Nothing is ever charged for a failed try.
- Cancelling (account page, the email's link, /admin, a refund, deleting the
  account) deletes the token at Moyasar; Pro stays until the paid days end.
- It cannot charge twice for a period: one live order per subscription and
  cycle (a row lock and a unique index), and one payment per order id
  (Moyasar's `given_id`), so a job that runs twice, on two servers, or after
  a time-out, is still one charge.
- **The switch-off:** remove `PRO_AUTORENEW` and nothing more is offered or
  charged, from the next run. Fans can still cancel, and their account page
  says renewals are paused. /admin → Pro → Auto-renew lists who renews, who
  is failing and who stopped, with a "Switch off" per account.

## Questions for Moyasar support

The docs (docs.moyasar.com, read 16 Nov 2026) leave these open.

1. **Allowed IPs.** Can the live secret key's Allowed IPs list be cleared (any
   IP), or must at least one address stay? If it must, is a shared proxy's
   address (Fixie) acceptable?
2. **Tokenization.** Is the Tokenization feature (`save_card`) enabled on my
   account, in test and live? My offer lists a tokenization fee of 0.05 SAR
   per transaction: is that per saved card or per token charge?
3. **mada and recurring charges.** Can a token made from a **mada** card be
   charged later by my server with no cardholder present (no 3-D Secure, no
   CVC)? Is any registration or approval needed for that? (My site lets mada
   renew; if the answer is no, I switch mada back to one-time.)
4. **Which key charges a token.** Your token guide's example uses the
   publishable key for `POST /v1/payments` with `source.type: "token"`. I
   charge from my server with the **secret** key: please confirm that is
   right.
5. **3-D Secure on token charges.** Can a charge on an `active` token come
   back `initiated` with a `transaction_url`? For which cards? Should I send
   anything (`3ds: false`, a recurring or merchant-initiated flag) to mark it
   as a renewal? (I treat `initiated` as a failed try.)
6. **Apple Pay and Samsung Pay tokens.** With `apple_pay.save_card: true`, is
   the returned `source.token` chargeable later from my server, and is it
   `active` straight away? Same for Samsung Pay.
7. **`given_id` in the payment form.** The form's code accepts `given_id`
   (a UUID v4) but the form's docs do not list it. Is it supported? If a
   payment under a `given_id` fails, must the next try use a new one? (I use
   a new order and a new id.)
8. **The return from 3-D Secure.** For cards, are `id`, `status` and
   `message` always added to `callback_url`? (I do not rely on them: I read
   the payment back. Just to confirm.)
9. **Webhooks.** (a) The exact body of a `payment_paid` event: does `data`
   carry the full payment, with `metadata`, `amount`, `currency`, `status`,
   `refunded` and `source`? (b) Is `live` always present? (c) Is the failed
   event named `payment_failed` (one page spells it `payment_faild`)? (d) Is
   a signature header planned, or is `secret_token` the only check? (e) The
   request time-out, and confirm the retries (5 over about 4 hours).
10. **Refunds.** After a partial refund, what are `status` and `refunded`?
    Which event is sent? Is the 1 SAR refund fee charged on each?
11. **Expired cards.** Does a token become `inactive` when its card expires,
    and do you update tokens when a bank reissues a card?
12. **`callback_url` on token charges.** It is required by the API; is it
    ever used when no 3-D Secure happens?
13. **Disputes.** For a renewal dispute, what evidence do you accept? I keep
    the time the fan ticked "Keep Pro on", the reminder email (sent 3 days
    before, with a one-click cancel link) and the receipt.
14. **The form's error reporting.** The form tries to report its own errors
    to `appsignal-endpoint.net`; my page's security policy blocks that. Is
    that fine?
15. **PCI.** Does hosting your payment form on my own page (rather than
    sending fans to your hosted invoice) change which PCI self-assessment
    applies to me?
16. **STC Pay.** Is it available on my account?

## Not done here, on purpose

- No real key or card was used. Everything was tested against a stand-in
  Moyasar. Before going live, buy once with **test keys** on the live site in
  preview, for the form and (if you want it) for "Keep Pro on".
- Moyasar's own form text has a typo in English when a card will be saved
  ("You card data will be saved upon submit."). It is theirs.
