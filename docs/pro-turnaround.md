# Pro turnaround: reach, the gift, the price, and Pro where fans are (22 Nov 2026)

What was added on top of the launch (`docs/pro-launch.md`), which variable
switches each part on, the order to switch them on, and what the Saudi rules
say. **Everything here is off until its own variable is set.** A deploy of this
code with no new variable changes nothing for a fan and sends no email.

Tests: `server/test/turnaround.test.mts` (`npm run test:turnaround`) and
`e2e-pro-turnaround.mjs` (`npm run test:turnaround-ui`).

## Why (live /admin, 22 Nov 2026)

496 accounts, 1 real sale. The gift was offered to 16 accounts (the "one saved
design" rule shut the rest out) and nobody was told about it. In 30 days 394
people opened Post it and 79 shared; 3 saw the export sheet, the only place
Pro's exports were sold. The price question's median was SAR 10; the launch
price is 13.99. Only 1.1% of editor visitors make an account, and nobody else
can be gifted, emailed or sold to.

## The switches

| Variable | What it does | Default |
| --- | --- | --- |
| `PRO_MONTHLY_PRICE=9.99` | What 30 days of Pro cost, in riyals. Set, it **is** the price: no launch price beside it, nothing says "from <date> the price will be", and auto-renew renews at it. A value that is not a price from SAR 1 to SAR 100 is ignored, and /admin says so. | unset: `PRO_LAUNCH_PRICE_UNTIL` and the prices in `proPlan.ts` decide, as before |
| `PRO_MATCH_PASS=on` | The match pass is sold (only where Pro is on sale). | off |
| `PRO_MATCH_PRICE=4.99` | Its price in riyals. | 4.99 |
| `PRO_MATCH_DAYS=3` | Its length in whole days (72 hours). 1 to 14. | 3 |
| `PRO_AUTO_GIFT=on` | The 7 days start by themselves. | off: the old Accept gift |
| `PRO_GIFT_MAILS=on` | The three emails about the 7 days. Needs `PRO_AUTO_GIFT` too. | off |
| `PRO_POST_OFFERS=on` | Pro's versions and the account offer on the Post it sheet, and the row on the share dialog. | off |

/admin → Pro → "Switches" shows how the server reads each one.

## 1. The gift starts by itself (`PRO_AUTO_GIFT`)

- **Who:** an account with a verified email that is not a throwaway address and
  that has never held Pro (bought, given by hand, or a gift). Once per account,
  ever. The "one saved design" rule is gone while the switch is on.
- **When:** the first time its holder is on the site, signed in, with a
  verified email (`pro.ts giftFor`, asked by every page through `/api/pro`). A
  new account: the moment it verifies, or straight away after Google sign-in.
  An existing account: its next visit after the switch, never all at once, so
  a dormant account does not burn its days unseen. An offer made before the
  switch (the old Accept card) starts the same way.
  - *Why not start it at the verify click itself:* the link in the email can be
    opened on another device or by a mail scanner; starting on the first
    signed-in visit means the days begin in front of the fan. No other trigger
    was built.
- **The fan notices it, in one place:** a welcome sheet, once (the server
  remembers, so not again on another device): "Pro is on for you: 7 days,
  free", that no card was taken and it ends by itself, and **one** thing to
  try, the vertical video. In the editor its button opens the export with
  Vertical 9:16 picked. The header's countdown chip and the crowns that now
  just work are as they were.
- **When it ends:** an end sheet, once: what they made with Pro (the Pro items
  their exports carried, remembered by the server during the gift, and how many
  AI results Pro's limits gave), that everything made stays theirs, what Pro
  did that Free does not, and one blue button to keep Pro at the price it is
  now, with the match pass as one quiet line and "Not now" beside it. Nothing
  made is touched: saved exports are files on the fan's device.
- **/admin → Pro → "Gifts started":** by itself against the old Accept button;
  running, ended, bought while it ran, bought within 7 days of its end.

## 2. The emails (`PRO_GIFT_MAILS`)

Three, Arabic and English, in the receipt's layout, each at most once
(`proGift.ts`, `proGiftMail.ts`): it started; about a day before it ends (26
hours down to 6); it ended.

- **The first two and the plain third are notices about the account.** They
  carry no price and nothing to buy.
- **The third carries the price only for a fan who ticked "Email me Pro news
  and offers"** on the welcome sheet. The box is never ticked for anyone, the
  time of the tick is kept, and that part of the email is marked
  "Advertisement / إعلان" and names the seller. See "Legal reading" 4.
- Every one has "Stop these emails" (and the mail client's own unsubscribe
  button). It stops all emails of this kind, the founders email included
  (`pro_mail_stops`). Receipts, refunds and renewal reminders always go.
- Not sent: to an address that is gone or no longer verified; after "stop";
  the second and third to a fan who has bought Pro meanwhile; anything for a
  gift started from the old Accept button; a late "it started" for a gift
  older than a day when the emails are switched on.
- Paced: 12 a run, 0.7 s apart, 40 a day on the shared send budget. Only on a
  server that really delivers mail (never the console sender).
- /admin → Pro → "Switches" has each email as it would go out now.

## 3. Pro where fans are (`PRO_POST_OFFERS`)

On the Post it sheet, **under** its own buttons, which are untouched:

- One closed row, "Pro versions of this tifo". Opened: the three versions in
  plain words, and "See it on your tifo", a small preview of the vertical film
  of the fan's own tifo with the mark on it. Value first, then the price.
- One way on, never two: with Pro running (paid or the gift) three buttons
  that make the vertical video, the Full HD video and the 4K poster; with a
  gift waiting, "Use my Pro gift"; signed out where the gift is automatic, the
  free account (said once, in the line above); otherwise "Pro is SAR 9.99 for
  30 days, one payment. Or SAR 4.99 for a 72-hour match pass", with Get Pro
  and Match pass.
- Signed out: one line, "Save your tifo to an account and get 7 days of Pro
  free", with Continue with Google (one tap, where Google's page can open) and
  "Use my email". The tifo is kept in the browser first and moved to the
  account after (`toolbar.ts accountFromPost`), through the existing claim
  flow. "Posting stays free without one."
- Nothing in Pro's part is blue: the blue button stays the sheet's own.
- The share dialog (a link to a published tifo) has no export to sell Pro on:
  it gets one quiet row that opens the Post it sheet.
- The save offer in the editor ("Create a free account") also gets Continue
  with Google in one tap, and says the 7 days where they are automatic. With
  this switch on it comes on the **first** save of a visit, not the second
  (30 fans saw it, 2 opened sign-up: most save once). Off, it waits for the
  second save as before. The save itself never waits for an answer.

**Not there:** X sign-in. The server has only Google as a provider
(`oauth.ts`); adding X is its own piece of work (an X developer app, and X
gives no verified email, so such an account would get no gift until it adds
one).

## 4. The price and the match pass

- `PRO_MONTHLY_PRICE` is read by the one function every price comes from
  (`proLaunch.ts priceAt`), so /pro, the sheets, the form, the receipt, the
  emails, /admin and /legal agree. With it set there is no launch price, so
  /pro's "from 15 January the price will be SAR 19.99" line and /legal's
  launch paragraph are not shown. `PRO_LAUNCH_PRICE_UNTIL` can stay set or be
  removed: it is not used.
- **Auto-renew renews at the price shown.** A subscription started when
  renewals were SAR 19.99 is moved down to the current price before its
  reminder states it (`payments.ts renewOne`, `payRepo.lowerSubAmount`). It
  never moves a subscription up.
- **The match pass** (`PRO_MATCH_PASS`): the same Pro for 72 hours, SAR 4.99,
  one payment. It is an order like any other (`pro_orders.product = 'match'`),
  so every payment guarantee holds unchanged: the server sets the price and the
  length, Moyasar's own answer is checked for the amount and the currency, one
  pass per paid order, a refund ends the pass, nothing from the browser is
  believed. It never renews (no "Keep Pro on" with it; a tick is refused; a
  card saved with it is deleted), never carries the founders bonus, and starts
  when the Pro an account holds ends. Sold on /pro under the month, from Post
  it, the export sheet, the limit sheet and the card after the gift.
- Moyasar's limits (SAR 100 a payment, 2,000 a day, 20,000 a month): a price
  setting over SAR 100 is refused. 2,000 a day is about 200 months or 400
  match passes; nothing in the code watches the daily or monthly total.

## 5. Measuring

New funnel events (consent-gated like the rest): `pro_offer_<place>` and
`pro_get_<place>` for post, share, export, page, giftend, limit, account;
`pro_preview_post`, `monthly_bought`, `match_bought`, `gift_auto`,
`gift_welcome`, `gift_end_seen`, `bought_after_gift`, `signup_offer_post`,
`signup_post`. /admin → Pro → "Pro funnel": saw a Pro offer, pressed Get Pro,
paid, by place and by plan. "Paid" is the orders themselves; an order names its
place (`pro_orders.src`) only when its buyer allowed counting.

## Switching it on (after 23 Nov 2026, 13:00 Riyadh)

Deploy first, with none of the new variables: nothing changes. Then, one at a
time, each after looking at the one before on the live site:

1. **Deploy** this code. Check /admin → Pro → "Switches": all off.
2. **`PRO_MONTHLY_PRICE=9.99`.** /pro, signed out: SAR 9.99, no "from 15
   January" line. /legal: no launch paragraph. (`PRO_FOUNDERS_BONUS=off` at the
   same time takes the ended founders offer's paragraph off /legal.)
3. **`PRO_MATCH_PASS=on`** (with `PRO_MATCH_PRICE` and `PRO_MATCH_DAYS` only if
   not 4.99 and 3). /pro shows it under the month; /legal has its terms. Buy
   one yourself and refund it from /admin.
4. **`PRO_POST_OFFERS=on`.** Open the editor signed out, press Post it: the
   account line and the closed Pro row are under the buttons.
5. **`PRO_AUTO_GIFT=on`.** Sign in with an account that never had Pro: the
   welcome opens once. From here every eligible account gets its 7 days on its
   next visit.
6. **`PRO_GIFT_MAILS=on`**, last, and only after reading the four emails on
   /admin and "Legal reading" 3 and 4 below. Check /admin → Email is
   delivering. Gifts already more than a day old get no "it started" email;
   they still get the other two.

To undo any step, remove its variable. A gift that has started keeps running;
an order keeps the price it was made at.

## Legal reading (researched 22 Nov 2026; not legal advice)

"Secondary" marks a point read only from a newspaper, a law firm or a copy
that is not the Ministry's own. mc.gov.sa would not open during the research,
so the Ministry's discount rules are from secondary copies.

1. **A plain new price is not a discount.** The licence attaches to
   "تخفيضات" (Anti-Commercial Fraud Regulations art. 18; secondary copy:
   <https://nezams.com/?p=2925>). Showing "SAR 9.99" with no "was", no
   percentage, no word "discount" and no end date is an ordinary price change.
   That is a reading: no text says so expressly. The earlier line "from 15
   January the price will be SAR 19.99" was an advertisement, which binds
   (E-Commerce Law art. 10) and must not mislead (art. 11)
   (<https://misa.gov.sa/app/uploads/2025/07/E-Commerce-Law.pdf>); dropping it
   in the customer's favour is low risk. **Do not** call 9.99 a "launch" or a
   limited-time price. No price-protection duty toward a fan who paid 13.99
   was found; he can also use the 7-day refund and buy again.
2. **The match pass.** E-Commerce Law art. 13(1): seven days to withdraw from
   a service contract provided the consumer "has not used the product,
   received the service, or benefitted from either one". No exception in art.
   13(2) or in Regulations art. 11 is about short services. So "all your money
   back within 7 days if you haven't used Pro" is lawful and enough for both
   products, and the 7 days keep running after a 72-hour pass has ended
   (/legal says so). Regulations art. 7 asks that the total price, the
   duration, any recurring payment and the withdrawal right be stated before
   paying: /pro's match pass block and /legal do.
3. **The 7 free days: unresolved.** A free trial given to every account, with
   no purchase, no prize and no draw, is neither a discount (art. 18) nor a
   contest (art. 19). Whether the Ministry would treat it as a "عرض ترويجي"
   that needs its licence was not settled by any official text found
   (secondary: the Ministry licenses "discounts and promotional offers"
   together, tied to a commercial registration:
   <https://www.okaz.com.sa/economy/na/2166814>). **This is the one point that
   may need permission.** Osamh's decision (22 Nov 2026): it is switched on
   all the same, as the founders offer was; removing `PRO_AUTO_GIFT` is the
   way out if the Ministry says it needs approval, and asking it (1900) is
   still the safe order. The new copy calls it "7 days
   of Pro free"; the older screens still say "gift" (هدية).
4. **The emails.** PDPL Implementing Regulation arts. 28 and 29 and art. 11
   (<https://dgp.sdaia.gov.sa/wps/portal/pdp/knowledgecenter>): marketing
   needs prior consent that is free, specific to that purpose and recorded,
   the sender's name, and a free, easy way to stop. E-Commerce Regulations
   art. 5(2)(b) (secondary:
   <https://qadha.org.sa/files/shares/نظام التجارة الإلكترونية ولائحته التنفيذية.pdf>)
   asks for explicit prior consent before using a consumer's data for
   marketing, and art. 10 for an advertisement to be labelled. Reading: "your
   7 days started" and "they end tomorrow" are service notices while they
   carry no price; "keep it for SAR X" is marketing. So the price goes only to
   fans who ticked the box, labelled as an advertisement. The 496 existing
   accounts never agreed to marketing: they get the notices, and a price only
   after ticking. SDAIA's draft amendments (consultation closed 5 Nov 2026)
   would tighten arts. 28 and 29; not final (secondary:
   <https://www.clydeco.com/en/insights/2026/10/sdaia-publishes-draft-amendments-to-the-pdpl>).
5. **The new Consumer Protection Law** was approved on 10 Nov 2026
   (<https://www.uqn.gov.sa/news/council-of-ministers/4002369>); no text or
   date in force was found. Secondary reports say it takes effect 180 days
   after publication and requires a licence for "contests and promotions".
   Read it when it is published: it bears on point 3.
6. **Still open from the launch:** an address for the seller on the page
   (E-Commerce Law art. 6), unless the shop is registered with the Saudi
   Business Center.

**What the privacy text and the sign-up form say now.** /legal's privacy
section gained: what is kept about the 7 days (shown only while the gift is
automatic), the three emails and the tick (shown only while the emails are
on), and receipts and Pro notices in the list of emails the site sends
(always). The sign-up form itself is unchanged: it links the Terms and the
Privacy Policy and says nothing about emails, and no consent to marketing is
taken there. The only consent to marketing is the box on the welcome sheet.

## Decided on 22 Nov 2026 (Osamh)

- The numbers: `PRO_MONTHLY_PRICE=9.99`, and the match pass at SAR 4.99 for 72
  hours (the defaults, so only `PRO_MATCH_PASS=on` is needed).
- @Adb, who paid SAR 13.99 on 20 Nov: 12 extra days (13.99 buys 42 days at
  9.99). Osamh gives them from /admin → Pro → grant, with days = the days his
  pass has left + 12; the longer pass covers the rest. Nothing in the code
  does it.
- The automatic 7 days: switched on without waiting for the Ministry.
- "More AI designs" stays on the list of what Pro sells.

## Not done here, on purpose

- No price was changed and nothing was switched on.
- @Adb's SAR 13.99 pass was not touched.
- No free limit was changed.
- X sign-in, and a way to turn the offers tick off from the account page (the
  stop link in every email does it today).
