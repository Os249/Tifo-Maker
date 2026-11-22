# The Tifo Maker design bible

How Tifo Maker looks, moves, reads and behaves, and why. Read this before
building or changing any screen. The tokens live in `src/ui/tokens.css`,
`src/ui/colorScheme.css` (public pages) and `src/ui/floodlight.css` (the
editor); this file says how to use them. When this file and the code disagree,
fix whichever is wrong, in the same change.

Written 26 October 2026, from the design-principles review, the Figma
directions (A, B, C) and the launch audit, with the useful parts of four
outside libraries adopted and adapted (see Sources at the end).

---

## 1. Who it is for

- **Fans, not designers.** Most people arrive from a link in a WhatsApp group
  or on X, pick their club and want their tifo in their ground in a minute.
  Every screen is judged by whether a first-timer gets to a picture they would
  send their group.
- **On phones.** 63 to 80% of visits are phones. A phone is never an
  afterthought: it has its own editor shell (`src/ui/mobileShell.ts`), its own
  tap sizes and its own tests (`e2e-mobile.mjs`).
- **In Arabic as much as English.** 41 to 63% of visits are Arabic. Arabic is
  first class: every string has both languages, Arabic pages are pre-rendered
  under `/ar/`, Arabic type is one step larger, layouts mirror.
- **Every club's fans.** The site is not one club's. No page takes its colours
  from a club unless the person chose that club for their own tifo. The brand
  is night navy, one blue and floodlight yellow.
- **The seats are the canvas.** Every seat is a pixel of somebody's tifo. Seat
  maps are generated, exact and frozen: a change that moves a seat breaks saved
  designs (`scripts/verify.mts` holds their hashes).

## 2. The rules that matter most

1. **One blue button at a time.** Blue (`--blue-600`) is for the one next step
   on the screen: Save while there are unsaved changes, then Post it
   (`data-next` on the root). Everything else is quieter.
2. **"You are here" is a tint, not blue.** Selected tabs, tools, chips and
   views use `--here-bg` / `--here-ink` / `--here-line` (editor) or
   `--tint` (public pages).
3. **Every string in both languages**, in `src/ui/i18n/strings.ts`. No English
   left in an Arabic page; the build fails if there is.
4. **Western digits everywhere** (`1,790`, `60,000`, `10%`), in both
   languages. Format numbers with `Intl.NumberFormat('en')`.
5. **Tokens, not numbers.** Font sizes from `--fs-*`, space from `--sp-*`,
   motion from `--duration-*` / `--ease-*`, colours from roles. A ratchet in
   `verify.mts` lets raw sizes, raw colours and inline styles only go down.
6. **Phones get 44px targets**, desktops at least 24px.
7. **Motion explains, then gets out of the way**, and is zero for anyone who
   asks for less motion.
8. **Nothing runs inline.** `script-src 'self'`: no inline script, no eval.
   The only inline script element allowed is schema.org data
   (`type="application/ld+json"`).

## 3. Colour

| Role | Editor (`floodlight.css`) | Public pages (`colorScheme.css`) |
|---|---|---|
| Ground | `--ink-0` night | `--bg` day paper / night |
| Surface (cards, bars) | `--ink-1`, `--ink-2` | `--card` |
| Text | `--text-1`, `--text-2`, `--text-3` | `--ink`, `--muted` |
| Lines | `--line-1`, `--line-2` | `--line` |
| The action | `--blue` (`--blue-600`) | `--blue-solid` |
| You are here | `--here-bg`, `--here-ink`, `--here-line` | `--tint`, `--tint-hover` |
| Celebration | `--flare` with `--on-flare` text | the same |
| Selection on the canvas | `--violet` | n/a |

- Blue as text is a step darker on light grounds (`--blue-700`) and lighter
  on dark ones (`--blue-300`); `--blue-600` is a surface colour.
- Contrast is 4.5:1 for text, 3:1 for large text and controls. Measured
  values are written beside the primitives in `tokens.css`.
- A club's colours appear only in a fan's own tifo and on things they chose
  for it. Never on site chrome.

## 4. Type

- Faces: Inter for UI and English, Almarai for Arabic, Changa for display
  headings, JetBrains Mono for numbers in tables.
- The scale: `--fs-2xs` 11, `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 14,
  `--fs-base` 16, `--fs-lg` 18, `--fs-xl` 22, `--fs-2xl` 28, `--fs-3xl`,
  `--fs-4xl` (fluid).
- Editor body is 14px; public body is 16px.
- **Arabic is one step up in the editor** (`:root[dir="rtl"]` in
  `floodlight.css`: 12, 13, 14, 15). Nothing in Arabic is below 12px.
- Numbers that line up use `font-variant-numeric: tabular-nums`.
- Headings use `text-wrap: balance`. Loading and "more to come" labels end in
  `…`, the single character.

## 5. Space, shape, layers

- Space: `--sp-1` 4 through `--sp-10` 40, a 4px ladder. Lay out siblings
  with flex or grid and `gap`.
- Radius: `--r-sm` 8, `--r-md` 12, `--r-lg` 16, `--r-xl` 22, `--r-pill`.
  A child's radius is never larger than its parent's.
- Layers: `--z-raised` (controls on a canvas), `--z-sticky`, `--z-popover`,
  `--z-overlay`, `--z-toast`, `--z-consent`. No new z-index values.

## 6. Motion

The scale is in `tokens.css`, after the motion tokens of transitions.dev.

| Token | Value | Use it for |
|---|---|---|
| `--duration-stagger` | 40ms | per item in a list; keep the total under ~300ms |
| `--duration-micro` | 80ms | an intent delay (tooltip), a shake step |
| `--duration-quick` | 150ms | a close, a text swap, a hover colour |
| `--duration-fast` | 250ms | an open, tabs sliding, a fold (both ways) |
| `--duration-medium` | 350ms | a panel or toast closing |
| `--duration-slow` | 400ms | a panel opening, content arriving |
| `--duration-very-slow` | 500ms | a one-off moment: a check, a reveal |
| `--ease-smooth-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | the default: open, close, slide, resize |
| `--ease-in-out` | ease-in-out | a swap in place |
| `--ease-bounce` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | entrances only: a badge, a number |
| `--distance-micro` / `-small` / `-base` / `-medium` | 4 / 6 / 8 / 12px | a swap / a shake / a slide / text arriving |
| `--blur-small` | 2px | softens a swap or slide, never a plain fade |

- **Pick by what the motion does**, not by the nearest number.
- **Closes are quicker than opens** (dropdown 250 → 150ms, panel 400 →
  350ms). A fold, tabs and a page slide are the same both ways.
- **Never bounce a close.** Never delay a close or a hover-out.
- **Animate `transform` and `opacity`**; list properties explicitly. Never
  `transition: all` (verify.mts counts them; the count is 0).
- **Reduced motion**: every duration and distance token drops to 0 under
  `prefers-reduced-motion: reduce`, so anything built on tokens stops on its
  own. A looping animation (a shimmer, a pulse) also needs `animation: none`
  under that query.
- **Where the patterns live**: the panel fold (`ui/foldSections.ts`, the
  accordion), the dock handle (`ui/dock.ts`), the AI bar's shimmer and shake
  (`ui/aiBar.ts`), the guide card (`ui/guide.ts`).

## 7. Components

### Buttons
- **Primary** (blue, solid): the one next step. One per screen.
- **Secondary** (outline on public pages, `--ink-3` in the editor): a
  real alternative.
- **Tinted** (`--tint` / `--here-bg`): a main-path action that is not the
  screen's one step (Use as template, Generate with AI, the AI bar's Go).
- **Text button** (`.link-btn`): footnotes, Sign up in the editor, Import and
  Save palette.
- A button says what it does: "Post it", "Save palette", not "OK" or
  "Continue".

### The editor workspace
- **Split is the default for a new project** on desktop and tablet: the
  stadium on top, the strip docked under it. The handle (`#dock-handle`)
  resizes the dock and the browser keeps it (`tifo_dock_v1`). The view a
  person picks becomes their default (`tifo_view_v1`). Phones keep their own
  shell.
- **Stand buttons** (`#stand-chips`, `.m-stand`) show a picture of the stand
  as painted and its seat count (`ui/standThumbs.ts`). Picking one fills the
  strip with that stand.
- **The AI bar** (`#ai-bar`) is the AI tab's own prompt and Generate, one line
  on the canvas. It never adds a second AI path.
- **The stadium's camera controls** (`#cam-bar`) sit in its top corner, never
  over the middle of the picture, where the far stand and the tifo on it are.
  The eye on them (or H) clears them and the AI bar off the stadium until it
  is pressed again (`tifo_stage_clean_v1`). Anything else floating over the
  canvas, like the layer bar, stays inside the part it belongs to.
- **Cameras look at the tifo.** "Your tifo" in the stadium's menu, and Match
  Day opens on it and films the show on it (`simulator/cameras.ts`,
  `tifoShots`). A hand on the camera wins: it ends the show's cuts, and "Stay
  where I put it" never cuts (`mds_showcam_v1`).
- **Panel sections fold** (`ui/foldSections.ts`); the browser remembers
  (`tifo_folds_v1`); picking a tool opens its section.
- **The first-tifo guide** (`ui/guide.ts`) runs once (`tifo_guide_v1`) and
  hides what it is not about.

### The AI drawer (`ui/aiDrawer.ts`, `ui/aiDrawer.css`)
The AI tab is one home for both AI tools, and a little wider than the tool
panels (380px; 340px on a small laptop).

- **Two doors, never a switch.** "Create a new tifo" replaces what is on the
  stands; "Review my tifo" keeps it and suggests fixes. Each door says so in
  one sentence and carries its own counter. The tab opens on the tool used
  last (`tifo_ai_view_v1`), with a back arrow to the doors.
- **A counter is seen before anything is spent**: on the door, in the tool's
  header, and on the button that spends it ("Review my tifo · uses 1 of 2").
  Create, reviews and chat messages each have their own; a review never draws
  from Create's. The last one of a period is a warning (`data-level="low"`).
- **A fix is a card**: a number, what is wrong, one sentence why, the before
  and the after, Apply and Dismiss. Nothing changes until Apply; an applied
  card says so and offers Undo. Apply is a tint (`.rv-apply`), never blue.
  The number is violet because pointing at a card selects its layer.
- **Bigger ideas are not fixes**: a dashed edge, no number, and "Give it to
  Create", which says it uses one of Create's designs.
- **Signed out or not verified, the drawer is all there** and a card says the
  one step that opens it. At a limit: what ran out, when it comes back, and
  the fixes already there stay usable. Pro is offered only where Pro is on.
- **Full screen** (`body.ai-full`) hides everything but the tifo and the
  review; the button or Escape puts it back. It always opens as the drawer.
- Every sentence the model writes is put on the page as text, never as HTML,
  and every fix is checked against the live design before it is applied
  (`core/fixParse.ts`, `core/fixOps.ts`).

### Empty states
Say what is missing, why it is fine, and give the next step right there, once.
The banner empty state is the model: three cards (stand banner, hanging banner,
sign), each with a drawing, a name and what it is; the panel does not repeat
them.

### Cards that carry news (the post nudge, the AI state card, the limit card)
One title, one sentence, one blue action, at most one quiet alternative.

### Pro (`ui/pro.ts`, `ui/pro.css`)
- **One mark: the gold crown.** "Pro" beside it in English, "برو" in
  Arabic, where there is room (`proChipHtml()`); the crown alone, with its
  name spoken, on a small thumbnail. Gold is `--pro-*` (tokens `--gold-*`):
  `--gold-700` for words on light grounds, `--gold-400` on dark. Gold is
  never the blue: the one next step stays blue, a Pro action that is not the
  step is a gold-tinted `.pro-btn`.
- **A crown where the thing is picked, never first at export.** Pro tools
  are free to try in the editor and the 3D; an export with Pro items opens
  the export sheet: the gift (or Pro), and "Export without Pro items".
  Saving and publishing are never blocked.
- **A Pro member (a month of Pro, or the gift running) still sees what is
  Pro, quietly** (`.pro-chip.quiet`), and
  never sees a limit card that sells: at a ceiling the card says when it
  comes back and offers the free alternative.
- **A member exports without the mark unless they ask for it back** (14 Nov
  2026, `ui/proMark.ts`): while Pro runs, every "Without the tifomaker.org
  mark" tick (the stadium export, Post it, Match Day) starts ticked; unticking
  one is kept in the browser (`tifo_pro_nomark_v1`) and holds for all three.
  An account without Pro still starts unticked and meets the export sheet.
- **The LED boards have their own camera** (`simulator/cameras.ts`
  `boardShot`, last in Match Day's list): from across the pitch the boards
  are a strip a few pixels tall, so "See them up close" under the messages
  goes to a camera on the grass in front of them, where the words read.
- **A stadium video nobody framed looks at the tifo**: while the Stadium view
  is still on the untouched whole-bowl camera, Preview and Export use "Your
  tifo" (`ui/toolbar.ts`); a camera picked or turned by hand is left alone.
- **The export sheet shows the fan's own tifo both ways** (15 Nov 2026,
  `ui/proGate.ts` `BothWays`, `ui/proSheets.ts`): beside the words, two small
  pictures, "Free" and "With Pro", drawn from the design in hand (today's
  free export, then the Pro one). Free first, one at a time; a side with no
  picture is left out. It stays one calm sheet: no timer, no second pop-up,
  and "Export without Pro items" is as easy as it was.
- **The Reel** (`simulator/reel.ts`, `ui/proReel.ts`): the vertical film cut
  for TikTok, Reels and Shorts. 15 or 30 seconds, a line of the fan's own
  over the build-up (gone before the first card goes up), a closing frame
  with a title and a line. At 30 seconds it cuts round the tifo; every cut is
  checked against the ground and one that cannot see the tifo is left out.
  Words stay inside `REEL.safe` (what the apps cover); the sheet can shade
  those parts over the preview, never in the file. No music: copyright.
- **The designer pack** (`ui/proPack.ts`): 4:5, 3:4, 1:1, 16:9 and 9:16, each
  drawn again by Match Day's camera at its own shape and full size (never a
  crop of one picture), framed by dragging or the arrow keys, and the tifo's
  art alone on a clear background. One size, or all in a ZIP
  (`core/zipStore.ts`).
- **The LED boards in the film** (`simulator/film.ts` `BOARDS_CUT`): with
  words on the boards, Match Day's film goes from the establishing shot to
  the grass beside them, then to the stage camera. Plain boards: the film is
  what it was. **The board file** (`simulator/ledFile.ts`): each message as
  a flat strip at a size the fan types (venues differ; 10880 × 90 is one).
- **Two phases** (`simulator/phases.ts`, `ui/proPhases.ts`): colours first,
  then every card turns. The first phase is worked out from the design's own
  colours, so nothing is added to a saved design; the choice is an export
  setting in the browser (`tifo_pro_phases_v1`). Shown in the Pro film and
  the Reel, not in the live views.
- **The proposal sheet** (`ui/proProposal.ts`, with the production files):
  one A4 page for a club or a group, as a PDF (`core/pdfImage.ts`) or a PNG.
  The distribution PDF and the CSV beside it stay free.
- **"Can the camera read it?"** (`ui/proRead.ts`, `POST /api/ai/read`): on
  the Post it sheet, a view straight at the tifo is sent to the fast model,
  which answers with the words the cards spell. Worded as an opinion ("the
  camera read"), it says when it was unsure, and the line under the button
  says where the picture goes. Twenty a day; a running pass only.
- **The first week of a pass** (`ui/proCards.ts` `mountReexportCard`): My
  projects says the earlier tifos can go out clean and puts "Export clean" on
  each card (`?export=1` opens the project with its export panel up). "OK"
  puts it away (`tifo_pro_reexport_v1`).
- **/pro shows pictures** (`pro.html` "What Pro makes", files in
  `public/pro`): every one a real export of one design, the free video
  beside the Pro film. When a tool's output changes, make them again.
- **The limit card**: what ran out ("That's all 3 designs for today"),
  when it comes back ("on Sunday (in 2 days)"), one blue way on (the gift
  when there is one, else "See what Pro adds") and one quiet alternative
  (the Quick Designer).
- **The countdown chip** (`mountProChip`) sits in the editor's top bar while
  Pro runs; on a laptop (900 to 1599 px, where that bar is full), the crown
  alone with its words in the title. On the public pages the same fact is
  the gold ring and crown on the account's letter, with the countdown's
  words in its menu (see The site header).
- **The supporter badge** (`supporterBadgeHtml()`, `ui/supporterBadge.ts`)
  follows a paid month of Pro's name: the crown and "Pro supporter" /
  "داعم برو" on their tifo cards, their public tifo page, their profile
  header and their account page; the crown alone, its words spoken, in a
  tight row (a comment). It shows what the server says (`ownerSupporter`,
  `supporter`), never a plan or a date, and never for the gift.
- **A club kit dresses what it touches** (`ui/kitEverywhere.ts`): the AI
  panel says "Using kit: …" in a tint, a banner gets one gold-tinted "Dress
  this banner in …", Post it wears the kit's colours and crest. The kit's
  colours appear only on the fan's own work, never on site chrome.
- **The credit line** (`ui/creditLine.ts`) is the fan's own handle, small,
  in a bottom corner of every export, on a dark pill with a hairline; the
  site's mark keeps the bottom right, an Arabic credit reads right to left.
- **/pro on sale** (19 Nov 2026): once Pro is on sale to everyone the server
  sends the page already saying so (`ui/proSaleCopy.ts` is the one list of
  swapped words; `routes.ts` adds the title, description and link card and
  drops `noindex`), so nobody sees "coming soon" first. The lead says what
  TifoMaker is and that it stays free; the price card comes straight under
  it and "how it works" after the plans (`#pp-open.on-sale`). Under the one
  blue button: the methods by name, the 7-day refund line, and links to the
  terms and a contact. The price is never in the HTML: it is `/api/pro`'s.
  A perk that is not working comes off the page through `UNLISTED` in
  `server/src/proPlan.ts`, never by editing the page.
- **One plan** (31 Oct 2026): Free against Pro, SAR 19.99 for 30 days (SAR 13.99 while the launch price runs: docs/pro-launch.md), and a
  7-day gift that waits until it is started. Every new Pro item gets the
  crown where it is picked, is free to try, meets the export sheet at
  export, has English and Saudi Arabic words that load only with it, and has
  checks in a browser suite (`e2e-pro*.mjs`).
- **Behind switches (22 Nov 2026, docs/pro-turnaround.md).** The price can be
  a setting, with a 72-hour match pass under the month on /pro (quiet: the
  month keeps the one blue button). The 7 days can start by themselves: then
  one welcome sheet, once, with one thing to try, and one end sheet, once,
  with what the fan made, one blue "Keep Pro" and "Not now" beside it.
- **Pro on Post it.** Under the sheet's own buttons, never above them and
  never blue: one closed row ("Pro versions of this tifo") that opens to the
  three versions, a small marked preview of the fan's own tifo, then one way
  on (they just work with Pro; else the gift, a free account, or Get Pro with
  the price in words). Signed out, one line offers an account. At most one
  offer per moment; no timer, nothing pre-ticked, and the free picture's
  buttons do what they always did.
- **Everything shown comes from `/api/pro`.** The interface decides nothing;
  with `PRO_MODE=off` none of it appears, except /pro itself.
- **Coming soon** (8 Nov 2026, until payments open): /pro shows Free ("Always
  free") against Pro with no price; Pro's card asks "What would you pay for a
  month of Pro?" (riyals or dollars, the page's language choosing first; an
  optional comment), and "Send my price" is the page's one blue button.
  "Tell me when Pro opens" sits below it, quiet. Every public header carries
  "♛ Pro · soon" / "♛ برو · قريباً" (`.nav-pro`: the gold crown, the
  link's ink). The answers are on /admin → Pro.

### The site header (`ui/siteHeader.css`, `ui/siteHeader.ts`)

One header on every public page (21 Nov 2026): home, community, events,
projects, clubs, Pro and the account page. Three groups, always in this
order: the wordmark, the places, and you.

- **The places are tabs**: Home, Community, Events, My projects (and For
  clubs where there is room). In the bar on a desktop. On a phone they are a
  bar at the bottom of the screen, under the thumb, with the blue "new tifo"
  in its middle. There is no menu button. One element holds them in both
  places, so a page writes them once.
- **You are here is a tint** on the tab, never the blue.
- **"New tifo" is the header's one blue thing**, the same on every page. On
  a page with a blue step of its own (My projects, Pro, the account page) it
  is a tint (`.quiet`).
- **The account**: "Sign up" as an outline until someone is signed in, then
  their letter, which opens the menu: who and the plan, Account, My
  projects, Pro, the theme, Sign out. Signed out on a phone, what the bar has
  no room for (Pro, For clubs, the theme) is behind "More".
- **Pro is said once.** Signed out: the crown and "Pro" on the bar. Signed
  in: a row of the menu, and nothing on the bar.
- **A letter with a gold ring and the crown is an account whose Pro is
  running** (a paid month or the gift), as `/api/pro` says. Its menu carries
  the countdown's own words ("Pro · 5 days left") and "Manage Pro".
- The phone's bottom bar keeps room under the page for itself, and the
  cookie bar sits above it.
- Checked by `e2e-header.mjs`. The editor has its own top bar and is not
  part of this; the legal page keeps its small bar.

### The account page (`account.html`, `src/account.ts`, `ui/accountAreas.ts`)

Five named areas, one on screen at a time (20 Nov 2026): Profile, Sign-in and
security, Pro and billing, Data and privacy, Danger zone.

- **The address is the area**: /account#profile, #security, #billing, #data,
  #danger. The addresses the page had before still open the right place:
  #pro is billing, and the old section ids (#sec-danger and the rest) open
  the area they moved into.
- **A phone opens on the overview**: the summary (who I am, my email, my
  plan, each with its one next step) and the list of areas with a line of
  status under each name. An area is its own screen with a way back. From
  900px the list stays beside the open area and the summary above it.
- **An address that is not verified comes first**, above the summary: the
  code box, its errors, Send a new code and its wait counted down on the
  button. When it is verified the box goes and the word that it worked stays
  in its place.
- **One blue button**: Verify while a code is owed; otherwise the submit of
  the one form that is open (opening one puts the other away), or Save once
  the name was changed. A step from the summary is a tint. Delete is red and
  never blue.
- **Forms stay folded behind "Change"** (email, password), so nothing on the
  page looks like work waiting. The name is the Profile area's one job and
  stays open.
- **Every action says all its states**: the button turns and names what it
  is doing, then a panel says what came of it (`.ac-msg`, read out politely).
  An error about a field sits beside that field, which is marked
  (`aria-invalid`, `aria-describedby`): `say(msg, text, tone, field)`.
- **Password**: show and hide on every password box, the rules and what a
  change does said before anything is typed, the confirmation after.
- **Pro and billing reads as a bill** (`ui/proAccount.ts`): the plan with the
  days left and the day it ends, auto-renew, what happens when it ends, what
  is left of each allowance, then the purchases with their receipts and
  refunds, or the word that there are none yet. On Free: one calm line and a
  gold-tinted way to Pro, never the blue. Every number is `/api/pro`'s.
- **Delete is apart and asked twice**: its own area, then "Are you sure",
  the name typed and the password.
- Checked by `e2e-account.mjs`, on a phone and a desktop, in both languages.

### Tifo events (`src/events.ts`, `ui/eventBand.ts`)

A themed contest the admin makes on /admin → Events: announced, open for
entries, voting, then confirmed by hand. The nav's "Events" link (after
Community, on every public page) goes to the list at /events, which says so
when there is none. With no event, nothing else about events is on the site.

- **The page** (/events/<address>, and the list at /events) uses the public
  pages' roles and the community's cards. Its one blue button is the next
  step of the stage: "Start a tifo" (announced), "Enter one of my tifos" or
  "Sign in to enter" (open), "Sign in to vote" (voting, signed out). Once a
  fan has entered there is none: "Change my entry" and "Take my entry out"
  are quiet.
- **A vote is a tint**, never a second blue button: `.evp-vote`, pressed
  state `--tint` with the word "Voted". 44px tall on every screen.
- **Votes are not shown until the result**, because the server does not send
  them; entries come in a different order for each visitor while votes are
  taken. The podium's winner takes Pro's gold line, the only gold on the page.
- **The band** (`.ev-band`) on the home and community pages is a tint with
  a link, added only while an event is on, after the page is idle.
- **Times** are shown in the reader's own time zone with Western digits
  (`ui/eventText.ts`); the admin types them in the browser's time zone.
- Entering and voting are free for every account. Pro is the prize, never
  the ticket.

## 8. Words

- **Active voice and the person's side of the screen**: "Post it makes a
  picture of your tifo", not "A picture will be generated".
- **Arabic is Saudi everyday Arabic**, warm and short ("عشان", "تبغى",
  "سوّ"), the way fans talk; English is plain and British-spelled in copy
  ("colour").
- **Errors say what happened and what to do next.** No apologies, no vague
  "something went wrong" without a way forward.
- **Numbers as numerals**, Western digits, with `&nbsp;` between a number and
  its unit where a break would hurt.
- **Brand names**: TifoMaker (one word) in the wordmark; translate="no" on
  brand names and code tokens.

## 9. Interface rules

Adapted from Vercel's Web Interface Guidelines (MIT), keeping the ones that
apply to this site. Where a test enforces a rule, it says which.

**Accessibility**
- Icon-only buttons have an `aria-label`; decorative icons `aria-hidden`.
- Every form control has a `<label>` or `aria-label`.
- Visible focus on everything: `:focus-visible` with an outline or ring,
  never `outline: none` without a replacement.
- Status that changes on its own (saving, AI progress, toasts) sits in
  `aria-live="polite"`.
- Images: a real `alt` when the picture carries meaning, `alt=""` only when
  it is decoration beside words that already say it. A card whose picture and
  label say the same thing puts the words in `alt` and hides the label
  (`aria-hidden`), so it is read once (the league cards).
- Headings in order; a skip link on every public page.

**Targets and touch**
- 44px on touch (`@media (pointer: coarse)`), at least 24px with a mouse.
  A small visible control gets a bigger invisible hit area (`::before`).
- `touch-action: none` only on drag handles; everything else scrolls.
- Every drag has a keyboard and tap alternative (the dock handle takes the
  arrow keys, Home and End).

**Forms**
- The right `type`, `inputmode` and `autocomplete`; never block paste.
- Placeholders show an example and end with `…`.
- Errors next to the field; the submit button stays enabled until the request
  starts.

**Content**
- Text containers handle long content: flex and grid children get
  `min-width: 0`; long names truncate with an ellipsis or wrap.
- Design empty, sparse, dense and error states, in both languages.

**Performance**
- Images have `width` and `height`; below the fold `loading="lazy"`; the hero
  `fetchpriority="high"`.
- No layout reads in a render loop. Pictures and counts that follow the paint
  are drawn in idle time (`requestIdleCallback`), not on every brush event.
- three.js loads only where 3D is shown (`e2e-pages-load`).

## 10. Launch checks

From the isreadyforlaunch audit of tifomaker.org (26 Oct 2026, 87/100). Every
public page, in both languages:

- `<title>` up to 60 characters; `<meta name="description">` up to 160
  characters (`meta.landing.desc`).
- `<link rel="canonical">` and `hreflang` twins (`/` and `/ar/`).
- `<meta name="robots">`: `index,follow,max-image-preview:large` on public
  pages, `noindex` on personal ones (projects, account, reset).
- `/robots.txt` and `/sitemap.xml`.
- Open Graph and Twitter card with an absolute 1200×630 image.
- schema.org data on the home page (WebSite, Organization, WebApplication).
- A web app manifest (`/manifest.webmanifest`) and the Apple touch icon.
- Images with `alt` (see section 9), targets at least 24px (44px on touch).
- HTTPS, HSTS, the security headers and `script-src 'self'`
  (`security.test.mts`).
- Not fixed by code: the audit's Cloudflare and HTTP-redirect notes are about
  hosting (`CLOUDFLARE.md`); `theme-boot.js` stays render-blocking on purpose,
  so the page never flashes the wrong theme.

## 11. Building something new

1. Find the closest existing pattern in this file and in the code; reuse its
   classes and tokens.
2. Write both languages in `strings.ts`. Check the Arabic page renders right
   to left.
3. Build it on the tokens. Run `npm run verify` (the ratchet and the frozen
   seat maps) and `npm run build` (i18n tables, the Arabic pages, the script
   check).
4. Look at it: desktop and phone, English and Arabic, light and dark where it
   applies.
5. Update the browser suite that covers it. A suite that starts a new project
   and is not about the guide sets `tifo_guide_v1`; one that expects a view
   first sets `tifo_view_v1` (`2d` or `3d`), since a new project otherwise
   settles in Split.
6. Run every suite before handing over: the server suites, `verify`,
   `verify:superai`, the secret scan, the server bundle, every `e2e-*.mjs` and
   the four ground walks.

Prompts for asking an AI assistant to build the next sections (passes and
pricing, FAQ, stats, onboarding and more), already written in these terms,
are in `docs/design-prompts.md`.

## Sources and licences

- **transitions.dev** (Jakub Antalik): the motion token scale, the open/close
  doctrine, the accordion (panel fold), shimmer text and error shake. Its
  licence allows use in our product, modified; it does not allow
  redistributing the library. We use the patterns we need inside our own
  stylesheet and keep this credit; the library itself is not copied into this
  repository. To use more of it in a coding agent:
  `npx skills add Jakubantalik/transitions.dev`.
- **Vercel Web Interface Guidelines** (MIT, github.com/vercel-labs/
  web-interface-guidelines): the interface rules in section 9, adapted.
- **VibePrompt** (vibeprompts.dev): its catalogue of section types guided which
  prompts `docs/design-prompts.md` has. Its prompts target Tailwind and are not
  copied; ours are written for this stack.
- **isreadyforlaunch.com**: the checks in section 10, from Osamh's scan.
- **The Pro display fonts** (`core/proVoices.ts`, `core/proFontFaces.ts`), all
  under the SIL Open Font License 1.1 and installed from their @fontsource
  packages, each of which ships its LICENSE. Block: Lalezar (The Lalezar
  Project Authors, github.com/BornaIz/Lalezar) with Bowlby One (Vernon Adams).
  Stencil: Reem Kufi (The Reem Kufi Project Authors, github.com/aliftype/
  reem-kufi) with Black Ops One (github.com/SorkinType/Black-Ops). Rounded:
  Lemonada (The Lemonada Project Authors, github.com/Gue3bara/Lemonada).
  Classic: Rakkas (The Rakkas Project Authors, github.com/zeynepakay/Rakkas).
  Marker: Marhey (The Marhey Project Authors, github.com/namelatype/Marhey).
  Pixel: Handjet (The Handjet Project Authors, github.com/rosettatype/Handjet).
  Gothic: Blaka (The Blaka Project Authors, github.com/Gue3bara/Blaka).
  Heritage: El Messiri (The El Messiri Project Authors, github.com/Gue3bara/
  El-Messiri). Ruqaa: Aref Ruqaa (The Aref Ruqaa Project Authors, github.com/
  alif-type/aref-ruqaa; Reserved Font Name EURM10, which we never use).
  Classic and Ruqaa are offered for banners only: on seats their thin strokes
  break up (docs/pro-quality/fonts.md).
  The licence allows using, embedding and redistributing them in the product;
  the fonts are never sold on their own.
- **opendesign.dev**: retired by Ceros on 1 October 2023; nothing to adopt.
