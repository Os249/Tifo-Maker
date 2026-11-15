# Tifo events: the plan

Written 15 November 2026, from Osamh's note on "Tifo of the week":

> I love this. Right now people are posting without even this idea, so this will
> encourage even more. It needs a whole system though, so really carefully plan
> this out, and maybe not have it every week: some weeks, so we could announce
> it, or maybe put a theme like game jams, and a time.

**Built on 15 November 2026**, after Osamh said to build it with a page on
/admin. What follows is the plan as written; where the build differs:

- **Built**: the three tables, every route, the admin's Events tab, the event
  page and list, the band on the home and community pages, the prize pass,
  one prize per 90 days, the audit trail, the three funnel events, a server
  suite (`server/test/events.test.mts`) and a browser suite
  (`e2e-events.mjs`).
- **Different**: a vote counts when the voter's *email was verified* before
  voting opened (the plan said the account was made before it): the server
  keeps that time for every account, and it is the harder thing to fake.
  An entry needs at least one counted vote to take a place.
- **Not built**: "Remind me" emails, the line in the editor after publishing
  ("Enter this in <theme>?"), rules the server checks (a ground, a league, a
  number of colours: the admin takes an entry out by hand, with a reason the
  page shows), the "Winner" line on the tifo's own page, and the home page's
  "Tifo of the day" slot (the band names the winner for a week instead).

## What it is

A **tifo event**: a themed contest that is announced, runs for a set time, and
ends with a winner who gets a month of Pro and a place on the home page. Not a
standing weekly feature. An event exists only when one is created, so a quiet
month has none and a derby week can have one.

A game jam's shape, because that is what makes people post:

| Stage | Length (default) | What a fan can do |
|---|---|---|
| Announced | up to 7 days before | See the theme, the dates and the prize. "Remind me" (signed-in: an email on opening day, through the existing mail queue). |
| Open | 5 days | Enter one published tifo made after the announcement. Change the entry until entries close. |
| Voting | 2 days | Vote. Entries are frozen. |
| Result | from then on | Winner and two runners-up shown; the event page stays as a record. |

Example themes: "The derby", "A farewell", "One word", "Two colours only",
"Your city". A theme is a title, one line, and optionally a rule the server can
check (a ground, a league, a maximum number of colours). Rules that cannot be
checked by code are not offered: a rule nobody enforces becomes an argument.

## What a fan sees

- **Home page and community page**: one band while an event is announced, open
  or in voting. Nothing when there is none. The band says the theme, what stage
  it is in, and when that stage ends, in the reader's own time zone.
- **`/events/<slug>`** (and `/ar/events/<slug>`): the theme, the dates, the
  prize, the rules in plain words, and the entries as the community cards the
  site already has. During voting, each card has the vote button. After, the
  podium.
- **In the editor**, after publishing while an event is open: one line,
  "Enter this in <theme>?", with a button. Never a pop-up. Entering is also
  possible from the event page ("Enter one of my tifos").
- **The winner**: the Supporter crown for the month (it comes with the pass), a
  "Winner: <theme>" line on that tifo's page for good, and the home page slot
  that "Tifo of the day" uses, for a week.

Entering and voting are free for everyone. Pro is the prize, never the ticket.

## Rules that keep it fair

1. **One entry per account per event.** The tifo must be published and created
   after the event was announced, so nobody enters last year's best. Remixes
   are allowed if the site's remix rules allowed the remix; the entry shows
   what it was remixed from.
2. **One vote per account per entry, verified email only.** Same rule as the
   site's existing votes (`design_votes`), but counted in a separate table so
   event votes and ordinary likes never mix. Nobody votes for their own entry.
3. **Votes are hidden while voting is open.** Cards are shown in an order that
   is shuffled per visitor (seeded by their account), so the early leader does
   not collect votes for being first. Counts appear at the result.
4. **Accounts made after voting opened do not count** toward the result (they
   can still vote; it is simply not tallied). This is the cheap answer to vote
   rings: a ring has to exist before the event, which is most of the work of a
   real following.
5. **The winner is confirmed by hand.** The server proposes the top three by
   counted votes; Osamh presses "Confirm" on `/admin`. Until he does, the page
   says "Result soon". He can disqualify an entry with a reason that is shown
   ("broke the theme's rule", "reported and removed"). A tie is broken by the
   earlier entry.
6. **Reports work as they do today.** An entry removed by moderation leaves the
   event. No crests, player faces or sponsor marks are needed to enter, and the
   theme text never asks for them.
7. **One prize per person per 90 days**, so the same designer does not hold the
   crown all season; a repeat winner still gets the title and the home page.

## How it is built

Server (Fastify, Postgres and the memory repos, as everything else):

- `tifo_events` (id, slug, title_en, title_ar, line_en, line_ar, rule JSON,
  announce_at, open_at, vote_at, close_at, prize_days, status, winner_design,
  confirmed_by, confirmed_at).
- `tifo_event_entries` (event_id, design_id, user_id, entered_at,
  disqualified_reason), unique on (event_id, user_id).
- `tifo_event_votes` (event_id, design_id, user_id, voted_at, counted BOOLEAN),
  unique on (event_id, design_id, user_id).
- Routes: `GET /api/events/current`, `GET /api/events/:slug`,
  `POST /api/events/:slug/enter`, `DELETE` the same,
  `POST /api/events/:slug/vote/:designId`, and under `/api/admin/events`:
  create, edit until announced, disqualify, confirm.
- Confirming calls the existing `grantPass` (source `'event'`, 30 days,
  `createdBy` the admin). If the winner already holds a pass, the month is
  added after it, the way a second payment is.
- The stage is worked out from the four times, never stored by a timer: no
  cron, nothing to fall over at midnight.
- Rate limits as the vote route has today. Every admin action goes in the
  existing audit trail.

Client:

- `src/events.ts` and `events.html` (a public page like `community.html`), the
  band (`src/ui/eventBand.ts`) on the landing and community pages, one line in
  the publish flow, and the admin form in `adminPage.ts`.
- Every string in English and Saudi Arabic; dates through the same `Intl`
  helpers the Pro chip uses.
- Funnel events: `event_view`, `event_enter`, `event_vote`, added in the three
  places the design bible names.

Tests: a server suite for the rules above (one entry, own-entry vote refused,
late accounts not counted, hidden counts while voting, confirm grants exactly
one pass, disqualify), and a browser suite walking one event through its four
stages with the clock moved.

Size: large. About the size of the payments work: three tables, eight routes,
one public page, one admin form, two suites.

## What it costs

- One Pro month per event. Worst case USD 2.47 of AI if the winner uses every
  allowance (the figure from the Pro costing); typically far less.
- At one event a month: under USD 2.50 a month. At four: under USD 10.
- No AI is used to run or judge an event.

## The first event, as a trial

Before building the system, the idea can be tried by hand once: announce a
theme on the site's social accounts, collect entries with a tag on the
community page (tags exist), count the existing likes on a set day, and grant
the month from `/admin` (the grant exists). If fewer than about ten people
enter, the system is not worth its size yet. If thirty do, build it.

## Decisions for Osamh

1. **Build the system now, or run one event by hand first?** I would run one
   by hand: it costs an afternoon and tells you whether the system is worth a
   week.
2. **The live database gets three new tables** when this is built. They are
   additive (nothing existing changes), but it is a change to production data
   and it is yours to approve.
3. **The prize.** A month of Pro per event, one prize per person per 90 days,
   and you confirm each winner by hand. Say if you want runners-up to get
   something (a week of Pro each would triple the give-away).
