# Three plans on /pro: the match pass, the month and the year (22 Nov 2026)

What was added on top of the turnaround (`docs/pro-turnaround.md`), which
variable switches each part on, the order to switch them on, the Moyasar
limit, and what the Saudi rules say about the labels. **Everything here is
off until its own variable is set.** A deploy of this code with no new
variable changes nothing for a fan.

Tests: `server/test/plans.test.mts` (`npm run test:plans`) and
`e2e-pro-plans.mjs` (`npm run test:plans-ui`).

## The switches

| Variable | What it does | Default |
| --- | --- | --- |
| `PRO_THREE_PLANS=on` | /pro becomes one price list (every plan on sale, each with its own button), and the sheets name the other plans under the month's button. Only where Pro is on sale. | off: Free against Pro, as before |
| `PRO_YEAR=on` | The year is sold: 365 days of the same Pro, one payment, never renewed. Shown only where `PRO_THREE_PLANS` is on too: the old page has no place for it. | off |
| `PRO_YEAR_PRICE=89.99` | Its price in riyals. A value that is not a price from SAR 1 to SAR 100 is ignored (the default stands), and /admin says so. | 89.99 |

/admin → Pro → "Switches" shows how the server reads each one.

## Switching it on

Deploy first, with none of the new variables: nothing changes. Then:

1. **`PRO_THREE_PLANS=on`.** /pro shows two plans in the new layout (the
   match pass and the month, if `PRO_MATCH_PASS` is on). Look at it on a
   phone in Arabic and on a desktop in English, light and dark.
2. **`PRO_YEAR=on`.** The year joins the list, the sheets and /legal. Buy one
   yourself and refund it from /admin.

To undo either, remove its variable. An order keeps the price and the length
it was made at; a year already paid for runs to its end.

## What a year is

- An order like any other (`pro_orders.product = 'year'`), so every payment
  guarantee holds unchanged: the server sets the price and the length,
  Moyasar's answer is checked for the amount and the currency, one pass per
  paid order, a refund ends the pass, nothing from the browser is believed.
- It never renews: no "Keep Pro on" with it, a tick is refused, a card saved
  with it is deleted. It never carries the founders bonus.
- **Buying over Pro already held.** A month or a match pass can be bought
  only in the last 7 days of what is held, as before. A year can be bought
  while up to 37 days are held (`YEAR_WITHIN_DAYS`: a month, plus one added
  in its last week), so a month holder can move up at any time; the year
  starts when that Pro ends. A year over a year waits until 37 days are left.
- **A pass bought to follow the one running now counts as held** (a change
  to `payments.ts monthEnd`). Before, only a pass running at that moment was
  counted, so two purchases in a row could start at the same moment and
  overlap. This applies to every product.
- The schema's check on `pro_orders.product` is replaced by one that names
  three products (`server/schema.sql`); it is safe to run on every boot.

## /pro as a price list (option C of the mockups)

`src/proPlansView.ts` and `src/proPlans.css`, loaded only when the server
says the page is this one. `proPage.ts` keeps the sign-in, the form and the
return from Moyasar; the server sends the page already carrying the new
title and the class the layout goes by, so nobody sees the old page first.

- The hero says what Pro makes. Under it, one joined card: each plan's
  length (the large figure), its whole price, a price per day, one line, and
  its own button. The month has the gold tint, "Our pick" and the one blue
  button; the others are outlines.
- "Every plan includes" under the plans, then three promises right under the
  card: the 7-day refund, "Moyasar handles your card", "Nothing renews by
  itself", and the links to the terms and a contact.
- What Pro makes as three rows (the vertical video in a phone, the 4K
  poster, the film with a Free / With Pro switch), one table of Free against
  Pro from the server's limits, and a first question, "What is the
  difference between the plans?".
- On a phone the plans are rows of one card. Moyasar's form opens under the
  plans, says what is being paid for, and the other buttons step aside.

## The same plans wherever Pro is sold

`src/ui/proPlanList.ts`. Each place keeps its one button for the month;
under it, "The same Pro, for longer or shorter:" and one quiet link per
other plan with its whole price and length, to `/pro?from=<place>&plan=<plan>`.
Post it, the export sheet, the "What Pro adds" sheet behind every limit
card, the sheet after the gift, and the account page (which now names its
place, `account`, and is counted). The account page's plan reads "Pro"
rather than "Pro monthly"; purchases, receipts and refund emails name a year
as one; the refund-request email no longer says "that month" for another
plan. /admin's orders have a Plan column, and its funnel has the plan list
seen, the plan chosen and paid, by place and by plan, with money by plan.

Not done: the small card on My projects after the gift still has one button
(it opens /pro, where every plan is); there is no email before a year ends.

## Measuring

New funnel events (consent-gated like the rest): `pro_plans_<place>` (the
plan list was shown there), `pro_pick_<monthly|match|year>_<place>` (that
plan was pressed there), `year_bought`. "Paid" is the orders themselves, by
plan and by the place the checkout named.

## Moyasar's limit (looked up 22 Nov 2026)

Moyasar publishes no maximum per payment, per day or per month, for any
method or kind of account: the Create Payment reference
(<https://docs.moyasar.com/api/payments/01-create-payment>) gives `amount` no
maximum, the card form guide
(<https://docs.moyasar.com/guides/card-payments/basic-integration>) gives only
the minimum of 100 halalas, and the terms
(<https://moyasar.com/en/resources/terms/>, art. 5.13) name "the maximum
allowable amount" without a figure. The help centre and pricing pages would
not open. So the limit is the account's own: check the Moyasar dashboard, or
ask support, for the per-payment, daily and monthly limits by method. The
code's ceiling stays SAR 100 a payment (`PRICE_MAX_HALALAS`), the figure in
`docs/pro-turnaround.md`, whose source is not written down. SAR 89.99 fits it.

## The price (Osamh's decision, 22 Nov 2026)

SAR 89.99. Twelve months at SAR 9.99 are SAR 119.88; the year is SAR 7.50 a
month and SAR 0.25 a day, and brings what nine separate months would. It does
not renew by itself.

## Legal reading (researched 22 Nov 2026; not legal advice)

"Secondary" marks a point read only from a copy that is not a government
site's own.

1. **Comparing one's own standing plans is read as outside the discount
   licence.** The Ministry's nine controls
   (<https://mc.gov.sa/ar/mediacenter/News/Pages/14-09-23-01.aspx>) and the
   Anti-Commercial Fraud regulations art. 18 (secondary:
   <https://nezams.com/?p=2925>) frame a discount as a cut from the same
   product's earlier price for a licensed period, with "price before and
   after" tags. A standing difference between two lengths has no "before"
   price. This is a reading: no official text states the exemption. To be
   certain, ask the Ministry (1900).
2. **"Free" may be a promotional offer.** The licence service has a separate
   track for "promotional offers" with no published definition
   (<https://mc.gov.sa/ar/eservices/Documents/ID%3D46.pdf>). So nothing says
   "2 months free".
3. **The total comes first.** E-Commerce Law art. 7(d) requires the total
   price with all fees and taxes
   (<https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/360de590-0286-4fa5-a243-aa9100c31979/1>);
   art. 11 bans misleading claims. No rule on prominence was found; the page
   shows the whole price larger than the per-day and per-month figures, and
   /legal says the per-month figure is the one payment divided by twelve.
4. **The 7 days apply to a year as to a month** (art. 13(1): a service not
   yet used). Nothing found requires a refund after use, or says what is owed
   if the seller stops the service early; /legal promises the unused days'
   share back in that case, as a fair term for a year paid up front.
5. **The new Consumer Protection Law** (approved 10 Nov 2026,
   <https://www.uqn.gov.sa/news/4002369>) will replace the E-Commerce Law and
   the Anti-Fraud Law 180 days after publication
   (<https://mc.gov.sa/ar/cps/pages/replaces-three.aspx>). Its text was still
   not found. Read it when published: it bears on discounts, renewals and
   refunds.

**The labels used, and why.** "Our pick" on the month (the seller's own
recommendation, not a claim about sales). "Works out at SAR 7.50 a month" on
the year and "SAR 0.25 a day" on each plan (arithmetic on a standing price,
under the whole price). **Not used:** "Save 25%", "2 months free", a
crossed-out price, "discount", "most popular", any countdown. The browser
suite fails if one of them appears on /pro or a sheet.
