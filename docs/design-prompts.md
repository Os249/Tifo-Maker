# Prompts for the next sections

Ready-to-use briefs for asking an AI assistant (Claude, Cursor, v0) to build
the sections Tifo Maker is likely to need next. Each one is written for this
codebase: plain HTML and CSS on the tokens in `src/ui/tokens.css`, strings in
both languages in `src/ui/i18n/strings.ts`, no Tailwind, no inline script.
Read `docs/DESIGN.md` first; every prompt below assumes it.

The list of section types follows VibePrompt's catalogue (vibeprompts.dev),
kept only where Tifo Maker has a use for it. Its prompts target Tailwind and
none of their text is copied here.

Paste the shared preamble first, then the section's prompt.

---

## Shared preamble

```text
You are working in the Tifo Maker repository (Vite, TypeScript, plain CSS,
Fastify). Follow docs/DESIGN.md. In particular:
- Colours, type, space, radius and motion come from the tokens in
  src/ui/tokens.css (and colorScheme.css on public pages, floodlight.css in
  the editor). No new raw px font sizes, raw colours or inline styles: the
  ratchet in scripts/verify.mts fails if their counts go up.
- One blue button per screen: the one next step. Selected states are tints.
- Every string goes in src/ui/i18n/strings.ts with English and Saudi everyday
  Arabic, and is applied with data-i18n / data-i18n-attr. Western digits in
  both languages. Check the /ar/ page renders right to left.
- 44px touch targets, visible focus, labels on every control, aria-live on
  status that changes on its own.
- No inline <script> (CSP script-src 'self'); no third-party scripts or fonts.
- Motion on the --duration-* and --ease-* tokens, transform and opacity only,
  never transition: all; it must stop under prefers-reduced-motion.
- Phone first: build and check at 390px, then desktop.
- Add or update the browser suite that covers the change, then run every
  suite. Show me screenshots at 390px and 1440px in English and Arabic.
```

---

## Passes and pricing (the paid plan)

```text
Build the passes section for the AI limits and paid plan (see the project doc
"AI limits and the paid plan"; use the plan names, prices and limits that are
DECIDED there at the time, not the proposal's, and ask me if they are not).
- Three cards: the free plan, the Match Pass and the Season Pass, side by side
  on desktop, stacked on a phone with the Season Pass first.
- Each card: the name, the price in SAR as a large tabular number with "for 72
  hours" / "until 31 May" beside it, what it includes as a short list with
  check icons, and one button.
- Only the recommended pass has the blue button; the others are tinted. The
  free plan's button says what it does ("Keep designing free").
- A line under the cards: paying with mada, Apple Pay or STC Pay (text, no
  logos unless we have the right to use them), and "The Match Pass comes off
  a Season Pass bought within 7 days."
- The group plan is a separate quiet band: "For a supporters' group" and a
  contact link, not a fourth card.
- Do not invent testimonials, user counts or "most popular" claims.
- Tracking: a funnel event per button (add it to FUNNEL_STEPS, analytics.ts
  and the admin labels).
```

## The AI limit card, with the buy button

```text
Update the AI limit card in src/ui/aiPanel.ts (the quota branch of showCard)
for when passes are on sale:
- Title and one sentence as today, in both languages.
- The blue button becomes the pass that fits ("Get a Match Pass, SAR 9");
  "Use the Quick Designer" moves to the tinted secondary; "Not now" is a text
  button.
- Show when the free allowance comes back ("Back on Sunday") from the quota
  the server returns.
- Track each button. The same card appears from the AI bar on the canvas
  (it opens the AI tab), so check both paths.
```

## Questions and answers

```text
Build a questions-and-answers section for the passes page (and reusable on the
home page):
- Six to eight questions a Saudi football fan would ask: what a pass gives,
  how long it lasts, whether designs stay mine without a pass, refunds, paying
  with mada, using it on a phone and a laptop.
- Each answer two or three short sentences, written from the fan's side.
- Use the fold pattern of the editor's panel sections (the accordion in
  src/ui/foldSections.ts and floodlight.css: grid-template-rows 0fr/1fr on
  the motion tokens), as real <button aria-expanded> headings.
- Arabic and English answers written separately, not translated word for
  word.
```

## A stats strip

```text
Add a stats strip to the home page under "How it works":
- Three or four numbers that are TRUE today and read from the server, never
  typed in: the grounds (from the stadium catalogue), the leagues, the designs
  published in the community. Each with a one-line label.
- Large tabular numerals in --font-display, labels in --fs-sm.
- If a number cannot be read, the strip is not shown (no zeros, no
  placeholders).
- When a number first scrolls into view it may count up once, on the motion
  tokens, never under reduced motion.
```

## What fans say

```text
Add a section of real quotes from fans:
- Only quotes we have, with the person's permission and their handle as they
  wrote it, stored in a reviewed list on the server. Never written by us or an
  AI, never "a fan from Riyadh" without a real person behind it.
- Each quote with the tifo it was about (a thumbnail linking to it in the
  community).
- If there are fewer than three approved quotes, the section is not shown.
```

## First-run and empty states

```text
Design the empty state for <the screen>:
- Say what is missing, why that is fine, and give the next step right there,
  once (the banner empty state in src/ui/bannerView.ts is the model: three
  cards with a drawing, a name and one line each, and nothing repeated in the
  side panel).
- One action may be blue only if nothing else on the screen is.
- Both languages, phone first, a drawing in inline SVG on the tokens
  (currentColor, --here-line, --text-3), no stock illustration.
```

## The closing band

```text
Change the home page's closing band (landing.html, #final-go):
- It is the same for every visitor: never a club's colours or a club's name.
- One heading, one line, one blue button to /projects?new=1, and the
  "carry on with your projects" link only for someone with projects in this
  browser.
- Keep it light: no animation beyond a hover.
```

## Signing in with a link

```text
Add "Email me a sign-in link" to the sign-in modal (src/ui/authModal.ts) and
the server (server/src/routes.ts), beside the password and Google:
- One email field (type="email", autocomplete="email", spellcheck off), one
  button, then a screen that says where the link went and how long it lasts,
  with "Use a different email".
- The link is single use, bound to the browser that asked, expires in 15
  minutes, and is rate limited like the reset link. Add the checks to
  server/test/security.test.mts next to the reset-link ones.
- No email enumeration: the same answer whether or not the address has an
  account.
```

## An admin panel

```text
Add a panel to /admin (server/src/adminPage.ts) for <the metric>:
- Read from the existing stats repositories; no new tracking without
  consent.
- Numbers as tabular numerals with the period they cover and when they were
  read. A sparkline only if there are at least 7 points.
- Compare with the previous period in words ("up 12 from last week"), not
  colour alone.
- Admin pages are noindex and behind the admin password; keep both.
```
