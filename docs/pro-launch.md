# Pro's launch: the price, the founders, and the legal reading (19 Nov 2026)

What was added on top of payments v1, v2 and refunds (`docs/pro-payments-v2.md`,
`docs/pro-refunds.md`), what to set, in what order, and what the Saudi rules
say about it. **Nothing here does anything until Pro is on sale for real**:
`PRO_PAYMENTS=on`, a **live** Moyasar key and `PRO_MODE=on` (the code calls
that `paymentsPublic`). On a test key, in preview, in development and in the
tests no launch is recorded, nobody becomes a founder and no email is sent.

Code: `server/src/proLaunch.ts` (the rules, with the long note),
`launchRepo.ts` (the store), `launchRoutes.ts`, `proLaunchMail.ts` (the
email), `payments.ts` and `payRepo.ts` (the bonus at the moment an order is
paid), `src/proPage.ts`, `src/ui/proAccount.ts`, `adminPage.ts`. Tests:
`server/test/launch.test.mts` (`npm run test:launch`), `e2e-launch.mjs`.

## The variables

| Variable | What it does | Default |
| --- | --- | --- |
| `PRO_LAUNCH_PRICE_UNTIL` | The first day at the regular price, as a Riyadh date (`2027-01-15`: SAR 13.99 until the end of 14 Jan, SAR 19.99 from 15 Jan). | unset: no launch price, Pro costs SAR 19.99 |
| `PRO_PRICE_DISPLAY=strike` | Shows SAR 19.99 crossed out beside the launch price. Only together with the next one. | plain words, no crossed-out price |
| `PRO_DISCOUNT_LICENCE` | The Ministry of Commerce discount licence number. Printed on /pro beside the crossed-out price. | unset |
| `PRO_FOUNDERS_BONUS=on` | Makes and keeps the founders offer: 30 extra days for a founder who pays within 72 hours of the launch. | off: founders are still emailed that Pro is open, with no offer |

The two prices are in `server/src/proPlan.ts` (`OFFER.monthly.price` 19.99,
`launchPrice` 13.99; 1999 and 1399 halalas).

## The price

- An order made before the day in `PRO_LAUNCH_PRICE_UNTIL` costs SAR 13.99;
  from that day SAR 19.99, with nobody touching the code or the settings.
- An order keeps the price it was made at: what the fan was shown is what
  Moyasar charges, even if the day changes between "Get Pro" and paying. A
  new press after the change makes a new order at the new price.
- **Auto-renew always renews at SAR 19.99**, and the box says so before it is
  ticked: "SAR 13.99 now, then SAR 19.99 every 30 days until you cancel. The
  first renewal is on <date>." It is never ticked for the fan. The reminder 3
  days before each renewal states 19.99.
- Every place that shows or charges a price reads the server's one answer
  (`priceAt`): /pro, the editor's Pro sheets, the account page, the form and
  hosted invoice, the receipt, the renewal and refund emails, /admin, /legal.

### How the launch price is shown (the switch)

**Default, and the one to use:** "Launch price. From 29 December 2026 the
price will be SAR 19.99." A price, and the day it changes. No crossed-out
price, no percentage, no word "discount" or "sale", in either language.

**Behind the switch:** SAR 19.99 crossed out beside SAR 13.99, with "Discount
licence no. <number>" printed under it. It needs **both** `PRO_PRICE_DISPLAY=strike`
and `PRO_DISCOUNT_LICENCE`; with only one, the plain wording stays and /admin
and the start-up log say why.

Pro has never been sold at 19.99, so a crossed-out 19.99 is a "before" price
that was never charged. See "Legal reading" for why that is not something to
switch on.

## The founders

**Who:** every signed-in account with a **verified email** that pressed "Tell
me when Pro opens" or answered "What would you pay for a month of Pro?"
(answering puts the account on the same list, including "Not for me": they
were told they would hear first too). Each account once. Guests who answered
signed out have no address and are left out.

**The launch moment:** the first time the server finds Pro on sale for real,
it writes one row (`pro_launch`) and, in the same transaction, copies the
founders into `pro_founders`. That copy is the list: asking after the launch
makes nobody a founder. A restart or a second server reads the same moment.

**The email:** one per founder, Arabic and English, in the receipt's layout:
Pro is open; they are a founder because they helped price it; the offer and
its exact deadline in Riyadh time (when the offer is on); the price and when
it changes; a line on what Pro adds; a button to /pro; who sells it; and a
"stop these emails" link (also sent as the mail client's own unsubscribe
button).

- **Never twice.** A founder's row is claimed by a single `UPDATE` before the
  send, and given back only when the mail service refused the message. If the
  server stops between the claim and the send, that founder is shown as "not
  known" on /admin and is **not** sent again: one email missed rather than
  two delivered.
- **Paced.** Ten a minute at most, 0.7 s apart, and at most 60 a day on the
  send budget, so verification and receipt emails keep their share of the
  mail service's daily allowance.
- **Not on test keys, in preview or in development.** It also waits while
  email is not really being delivered (no mail key): nothing is marked sent.
- **Not after the offer ends.** With the offer on, an email about a deadline
  that has passed is not sent. With the offer off, the "Pro is open" email is
  not sent later than 14 days after the launch.
- **Stopped means stopped.** An account that used the link is recorded in
  `pro_mail_stops` and skipped by this and any later email of the kind.
  Receipts, refunds and renewal reminders are not such emails and always go.
  There was no email preference on accounts before this.

**/admin → Pro → "Launch and founders":** before the launch, the count, who
they are (usernames only) and the email as it would go. After it: sent,
waiting, failed, not known, skipped, and how many founders bought in time.
"Send now" runs the same job at once and gives refused sends another set of
tries; it cannot send to an account that has had the email.

## The founders bonus (only with `PRO_FOUNDERS_BONUS=on`)

A founder's first purchase gets 30 extra days on the pass it buys: 60 days.

**The rule for "in time", decided by the server's clock when the payment is
confirmed:**

1. the payment is confirmed no later than the deadline (launch + 72 hours); or
2. the order was made by the deadline and its payment is confirmed within 6
   hours after it. A fan who paid at 71:59, whose bank or whose webhook took
   its time, gets it; an order left open and paid the next day does not.

And: the order was made after the launch, with real money (never a test-mode
order), is a purchase and not a renewal, and the account has not had the
bonus before.

- **Once per account, ever.** The claim is taken in the same database step
  that marks the order paid (`payRepo.markPaid`), so two confirmations of one
  order, or two orders of one founder paid in the same second, give one bonus.
- **Only on a paid order.** A gift and a month given by hand are not orders.
- **A refund ends it.** The bonus is part of the order's one pass; the refund
  revokes the pass. The offer is not given again on a later purchase.
- **Seen before paying:** /pro shows "Founder: you get 2 months for the price
  of 1, until <deadline> (Riyadh time)" with its terms; then on the receipt
  ("30 days + 30 founder days free") and on the account page.
- **With auto-renew:** the first renewal is due when the 60 days end, and the
  box says "SAR 13.99 now for your first 60 days as a founder, then SAR 19.99
  every 30 days". The reminder before that first renewal says the 60 days end
  that day.
- **A founder who already holds Pro** (a month given by hand, a prize) may buy
  during the window instead of waiting for its last week; the bought days
  start when the Pro they hold ends.

## Legal reading (researched 19 Nov 2026; not legal advice)

Sources are listed with each point. Where only a newspaper or a law firm's
copy could be read, it says "secondary".

1. **A crossed-out "before" price is a discount, and a discount needs a
   licence.** The Ministry of Commerce requires a licence before a discount
   is announced, online stores included
   ([MoC, 26 Sep 2022](https://mc.gov.sa/ar/mediacenter/News/Pages/26-09-22-01.aspx),
   [28 Feb 2024](https://mc.gov.sa/ar/mediacenter/News/Pages/28-02-24-01.aspx)).
   The licence service asks for a commercial registration, a list of prices
   before and after, and invoices the system picks at random to prove the
   earlier price ([MoC, "تراخيص التخفيضات"](https://mc.gov.sa/ar/eservices/Pages/ServiceDetails.aspx?sID=46)).
   Pro was never sold at 19.99, so there is nothing to prove; and a freelance
   document is not a commercial registration. Legal basis as reproduced by
   secondary sources: Anti-Commercial Fraud Law (M/19 of 1429H) art. 4 and its
   regulations art. 18.
2. **"13.99 now, 19.99 from <date>" is not addressed by any official text
   found.** It is a first price with an announced change, not a reduction
   from an earlier price, so it is reasonably outside the discount licence.
   That is a reading, not a ruling. It must be honoured: an advertisement is
   part of the contract (E-Commerce Law, M/126 of 2019, art. 10) and a false
   offer is forbidden (art. 11)
   ([official translation](https://misa.gov.sa/app/uploads/2025/07/E-Commerce-Law.pdf)).
   So do not keep moving the date.
3. **"Buy within 72 hours, get a month free" may be a promotional offer that
   needs the Ministry's approval.** MoC licenses "التخفيضات والعروض الترويجية"
   together; press reports put a promotional offer at SAR 150 each, and tie
   it to a commercial registration (secondary:
   [Okaz, 28 Jul 2024](https://www.okaz.com.sa/economy/na/2166814)). No
   official definition was found, and nothing says whether a digital service
   sold by a freelancer is covered. **This is why the founders offer is
   behind `PRO_FOUNDERS_BONUS`, off by default.**
4. **E-Commerce Law disclosures** (arts. 6, 7, 8; regulations arts. 6 to 8,
   secondary): the seller's name, address and contact, a register number
   "if any, or of any other publicly available register", the total price
   with all charges and taxes, delivery, the right to cancel, a complaints
   route, and a receipt. /legal and the receipt carry the name, the freelance
   document number, the contact, the price, delivery, refund and complaints.
   **An address is not there**: the law asks for one unless the shop is
   registered with an e-shop authentication body
   ([MoC, 29 Mar 2023](https://mc.gov.sa/ar/mediacenter/News/Pages/29-03-23-02.aspx):
   the Saudi Business Center, which takes a freelance document).
5. **The 7-day refund** matches art. 13(1): seven days from the contract for
   a service not yet used. The site's promise is that, and no more.
6. **Auto-renew:** no Saudi rule specific to it was found. What applies is
   the duty to state recurring payments and future charges before the
   contract (regulations art. 7, secondary). The site does more than that:
   never pre-ticked, the renewal price and first date beside the box, an
   email 3 days before each charge, one-click cancel.
7. **VAT:** registration is required above SAR 375,000 a year and optional
   from SAR 187,500 ([ZATCA SME guidelines](https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/(SMEs)%20Guidelines%20–%20Zatca%201.pdf)).
   A seller who is not registered must not charge or show VAT or issue a "tax
   invoice". So the pages say "the whole price: no VAT is added" and the email
   is a receipt.
8. **The founders email is marketing.** PDPL art. 25 and its regulations
   arts. 28 and 29 ask for the recipient's consent, the sender's name, and an
   easy, free way to stop
   ([PDPL and regulations](https://qadha.org.sa/files/shares/نظام%20حماية%20البيانات%20الشخصية%20ولوائحه%20التنفيذية.pdf));
   the E-Commerce regulations add that it must say it is an advertisement.
   Both buttons that make a founder said they would hear when Pro opens, the
   email names the seller, says it is an advertisement sent once, and carries
   the stop link.
9. **A new Consumer Protection Law** was approved on 10 Nov 2026 and takes
   effect 180 days after it is published; it is reported to replace the
   E-Commerce Law and the Anti-Commercial Fraud Law (secondary:
   [Okaz, 12 Nov 2026](https://www.okaz.com.sa/local/na/2275167)). Its text
   was not available. Read it when it is published.

## Launch day, in order

1. **Decide** (see the hand-over): the founders offer on or off; the day the
   launch price ends.
2. Railway → Variables, **before** switching Pro on:
   `PRO_LAUNCH_PRICE_UNTIL=<date>`, and `PRO_FOUNDERS_BONUS=on` if the offer
   is to be made. Leave `PRO_PRICE_DISPLAY` and `PRO_DISCOUNT_LICENCE` unset.
3. Check email is delivering (/admin → Email), and that `PUBLIC_URL` is
   `https://tifomaker.org` (the email's links are built from it).
4. Still in preview with **test** keys: open /admin → Pro → "Launch and
   founders". Read the count, the list and the email. Buy once as yourself.
   No launch is recorded and no founder is emailed.
5. Put in the **live** keys, still in preview (`PRO_MODE=preview`): buy once
   for real and refund yourself from /admin. Still no launch.
6. `PRO_MODE=on`. About 20 seconds after the deploy the launch is recorded
   and the emails start: ten a minute.
7. /admin → Pro: the launch time, the deadline, "sent" rising. If any stay
   "failed", press "Send now".
8. On the day after `PRO_LAUNCH_PRICE_UNTIL`: nothing to do. /pro shows SAR
   19.99, /legal drops the launch paragraph, and the variable can be removed.

Changing `PRO_FOUNDERS_BONUS` **after** the launch does not rewrite emails
already sent: set it before step 6.

## Not done here, on purpose

- No real key, card or email was used.
- The price is not a setting. Changing 13.99 or 19.99 is an edit to
  `proPlan.ts`.
- /pro stays `noindex` and out of the sitemap. Whether to let search engines
  have it is a separate choice.
- On the landing, clubs and events pages the header says "Pro" from the
  server once Pro is on sale to everyone; an account that can buy earlier (the
  owner's preview) still sees "Pro · soon" there, and "Pro" on /pro,
  /account, /community, /projects and in the editor.
