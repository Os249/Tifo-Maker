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
- **Panel sections fold** (`ui/foldSections.ts`); the browser remembers
  (`tifo_folds_v1`); picking a tool opens its section.
- **The first-tifo guide** (`ui/guide.ts`) runs once (`tifo_guide_v1`) and
  hides what it is not about.

### Empty states
Say what is missing, why it is fine, and give the next step right there, once.
The banner empty state is the model: three cards (stand banner, hanging banner,
sign), each with a drawing, a name and what it is; the panel does not repeat
them.

### Cards that carry news (the post nudge, the AI state card, the limit card)
One title, one sentence, one blue action, at most one quiet alternative.

### Pro (`ui/pro.ts`, `ui/pro.css`)
- **One mark: the gold crown.** "Pro" beside it in English, "مميّز" in
  Arabic, where there is room (`proChipHtml()`); the crown alone, with its
  name spoken, on a small thumbnail. Gold is `--pro-*` (tokens `--gold-*`):
  `--gold-700` for words on light grounds, `--gold-400` on dark. Gold is
  never the blue: the one next step stays blue, a Pro action that is not the
  step is a gold-tinted `.pro-btn`.
- **A crown where the thing is picked, never first at export.** Pro tools
  are free to try in the editor and the 3D; an export with Pro items opens
  the export sheet: the gift (or Pro), and "Export without Pro items".
  Saving and publishing are never blocked.
- **A pass holder still sees what is Pro, quietly** (`.pro-chip.quiet`), and
  never sees a limit card that sells: at a ceiling the card says when it
  comes back and offers the free alternative.
- **The limit card**: what ran out ("That's all 3 Super designs for this
  week"), when it comes back ("on Sunday (in 2 days)"), one blue way on (the
  gift when there is one, else "See what Pro adds") and one quiet
  alternative (a standard design, the Quick Designer).
- **The countdown chip** (`mountProChip`) sits before the header's account
  control while a pass runs; on a phone, the crown alone.
- **The Supporter crown** (`supporterCrownHtml()`) follows a paid pass's
  name in the community: cards, the profile, comments.
- **Everything shown comes from `/api/pro`.** The interface decides nothing;
  with `PRO_MODE=off` none of it appears.

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
- **opendesign.dev**: retired by Ceros on 1 October 2023; nothing to adopt.
