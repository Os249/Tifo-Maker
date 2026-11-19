# Pro: refunds told to the fan, and "Pro and purchases" (19 Nov 2026)

What was added on top of payments v1 and v2 (`docs/pro-payments-v2.md`), what
you need to set, and what the "not used" check can and cannot see. Nothing
here shows to anyone until payments are on for them: an account that never
had an order gets the site exactly as it was.

Code: `server/src/payments.ts` (the section "refunds, told and asked for"),
`payRepo.ts` (the store), `payRoutes.ts`, `payRefundMail.ts` (the emails),
`src/ui/proAccount.ts` (the account page), `src/ui/proPurchases.ts` (its
purchases list, downloaded only by an account with an order or a refund to
show, so the page starts no heavier for anyone else), `src/ui/proCards.ts`
(`mountRefundCard`, the one-time card on My projects), `adminPage.ts` (the
queue). Tests: `server/test/payments3.test.mts`, `e2e-pay-account.mjs`.

## What a refund does now

Wherever it is made (the Refund button in /admin, Approve on a request, the
auto-refund switch, or Moyasar's dashboard, seen through the webhook or the
next look at the order):

1. The pass ends and auto-renew is switched off, as before.
2. **The fan is emailed once** (Arabic and English, the receipt's layout):
   which order, the amount, the date, that its month of Pro has ended, that
   the money goes back the way they paid, and who to ask. A test-mode refund
   says so in the subject and the first line.
3. **The site says it once**: a card on My projects the next time they open
   it (or a strip at the top of "Pro and purchases" if they open the account
   page first), with a link to their purchases. The server offers it once and
   is told as soon as it is on screen.
4. An open refund request for that order is closed as approved.

"Once" is kept by the database, not by which code path ran: the order row
carries `refund_mail_at`, set by a single `UPDATE ... WHERE refund_mail_at IS
NULL`, so of ten webhook deliveries and two servers one sends the email. If
the mail service refuses it, the mark is taken off again and the renewals job
(every 15 minutes) tries for 3 days. /admin's orders table shows "fan
emailed" or "fan not emailed yet" under each refunded order.

On timing: Moyasar's documentation (docs.moyasar.com, the refund API page and
the payment-operations guide, read 19 Nov 2026) says a refund "returns the
funds to the cardholder" and gives **no number of days**; its help centre
could not be reached. So the email and the page say what is true: sent back
at once from our side, usually showing within a few working days, the exact
time depending on the bank. If Moyasar gives you a figure, the wording is in
`payRefundMail.ts`, `strings.ts` (`pu.rf.refunded`, `rn.body`) and
`legal.html`.

## "Pro and purchases" on the account page

One section, first on /account, shown when Pro is on for the account or it
has ever bought anything:

- **Status**: the plan, when it ends, and for a gift how many days are left.
- **Purchases**: each order's date, amount, how it was paid (Apple Pay, mada,
  Visa, Mastercard; the card's scheme is now kept with the order, never a
  number), its status (Paid, Refunded, Didn't go through, Being checked), and
  its **receipt**, which opens in place and can be sent to the account's
  email again (once per 5 minutes per order, only ever to the account's own
  address). An order that did not go through stays listed for 30 days; one
  that was opened and never sent is not listed.
- **Request a refund** on an order paid within 7 days. Each order says where
  it stands: can still be asked for (until which date), asked for, declined
  (with your reason), refunded, or too late (and since when).
- **Auto-renew**, when the account has it: on or off, the next date, the
  amount, which card, and one button that turns it off. The reminder and
  receipt emails' link (`/pro?stop=...`) still works by itself with no
  sign-in, and the reminder now also points to the account page.
- A fan who never bought anything sees nothing new except "Get Pro for SAR
  19.99" where Pro is on sale to them.

## Refund requests

A request is **not** a refund. It is recorded (one per order, ever), you get
an email at osamah9070@gmail.com, and the fan gets one saying it arrived and
that they will hear within 3 working days. Pro stays on meanwhile.

/admin → Pro → **Refund requests** lists them, the waiting ones first, with
who, the order, whether it was asked in time, "used" or "not used" (as it
stands now, and when they asked if that differs), and what they wrote.

- **Approve** refunds the whole order through Moyasar. It asks "Sure? Refund
  SAR 19.99" once, like the Refund button beside it, because it moves money.
  The pass ends and the fan gets the refund email. A request made in time is
  honoured even if you answer after the 7 days.
- **Decline** asks for a reason, which is emailed to the fan and shown on
  the order. Pro stays on. You can still refund that order later from the
  orders table.
- If Moyasar refuses, nothing changes and the request stays open.
- With `MOYASAR_VERIFY=webhook` (no secret key) Approve cannot refund: it
  says to refund in Moyasar's dashboard, and the webhook then ends the pass,
  closes the request and emails the fan.

The server refuses a request for an order that is not the asker's own (404,
as if it were not there), not paid, already refunded, already asked for, or
paid more than 7 days ago. A request for an order already paid for still
works if payments are later switched off; approving it then says payments
are off.

## The auto-refund switch

`PRO_AUTO_REFUND=on` in Railway's variables. **Off unless set**: it moves
money with nobody looking. With it on, a request is refunded at once when
**all** of these hold, and otherwise waits for you exactly as above:

- the order was paid within 7 days;
- its pass shows no use (below);
- the account has never had an order refunded before (so buying and
  refunding in a loop, each one costing Moyasar's fees, is not on offer);
- the server has the secret key (not the webhook-only mode), and Moyasar
  accepts the refund.

/admin's payment summary says whether it is on, and the queue marks such a
request "Approved automatically". The data export says so too.

### What "not used" can and cannot detect

"Used" is one number: `passUse`, the sum of the allowance counters kept for
**the pass that order bought**.

It **does** see, when taken on that pass: AI designs, Polishes, smart
cut-outs, stadium photo reads, AI reviews and AI chat messages (while
`AI_ON_PRO` and `PHOTO_ON_PRO` are on; a kind that is switched back to the
free allowances is counted per day or week instead and is not seen).

It **cannot** see:

- anything that has no allowance: exporting the Match Day film, the 4K
  poster, the Reel, the pack, the proposal or the LED file without the mark;
  Pro fonts, Pro styles, club kits, the credit line, the supporter badge;
- use counted on **another** pass: a fan holding a gift or a month given by
  hand at the same time has their use counted on whichever pass is the one
  in force, which may not be the bought one;
- a month that has not started yet (bought early, queued behind the current
  one) always reads "not used", correctly;
- whether a design made with Pro was kept, published or downloaded.

So "not used" means "no counted AI use on this pass", not "got nothing from
Pro". A fan could export a clean film and still be refunded automatically.
If that matters more than answering quickly, leave the switch off and decide
each one yourself; the queue shows the same number.

## What you need to set

Nothing, to keep things as they are. Optional:

| Variable | What it does | Default |
| --- | --- | --- |
| `PRO_AUTO_REFUND=on` | Refunds a request at once when in time, unused and a first refund for that account. | off: every request waits for you |

The database changes apply themselves at deploy (`server/schema.sql`: three
columns on `pro_orders`, one new table `pro_refund_requests`; each statement
is safe to run again).

Worth doing in preview with test keys before it matters: buy, press "Request
a refund" on /account, read the two emails, Approve in /admin, read the
refund email, and open My projects to see the card.

## Not done here, on purpose

- No real key or card was used: everything ran against the stand-in Moyasar.
- The one-time card is on My projects and the account page, the two places a
  signed-in fan lands; the editor and the community page do not show it.
- Partial refunds can only be made in Moyasar's dashboard. The site treats
  one as before (the pass ends) and the email states the amount that
  actually went back.
- Refunds made before this change get no email after the fact (the retry
  only looks 3 days back, and only while payments are on) and no card older
  than 30 days.
