---
name: tifo-maker-ui
description: Use when building, changing or reviewing any screen, component, style, animation or copy in Tifo Maker (the editor, the public pages, the phone shell). Holds the design bible's rules, the tokens and the checks to run.
---

# Tifo Maker UI

The full rules are in `docs/DESIGN.md`; read it before the first UI change in
a session. Prompts for new sections are in `docs/design-prompts.md`. This skill
is the short version and the workflow.

## Rules that are never broken

1. **One blue button per screen**: the one next step (Save, then Post it in
   the editor, via `data-next`). Selected states are tints (`--here-*` in the
   editor, `--tint` on public pages).
2. **Every string in English and Saudi everyday Arabic** in
   `src/ui/i18n/strings.ts`, applied with `data-i18n` / `data-i18n-attr`.
   Western digits in both. The Arabic page renders right to left; the build
   fails on English left in it.
3. **Tokens only**: `--fs-*`, `--sp-*`, `--r-*`, `--z-*`, colour roles, and
   the motion scale (`--duration-*`, `--ease-*`, `--distance-*`,
   `--blur-small`). The ratchet in `scripts/verify.mts` lets raw font sizes,
   raw colours and inline styles only go down.
4. **Motion**: pick by what it does; closes quicker than opens; transform and
   opacity; never `transition: all`; zero under reduced motion (the tokens do
   it; loops also need `animation: none`).
5. **Targets**: 44px on touch, 24px with a mouse; visible focus; labels;
   `aria-live` on changing status.
6. **No inline script** (`script-src 'self'`); the only exception is
   schema.org data (`type="application/ld+json"`).
7. **Seat maps never move**: anything touching `src/core/` geometry must keep
   the frozen hashes in `verify.mts`, on Node 22 and Node 24.
8. **The site is every club's**: no club colours on site chrome.

## Where things are

- Tokens: `src/ui/tokens.css`; public roles `src/ui/colorScheme.css`; editor
  `src/ui/floodlight.css`.
- Editor layout: `src/main.ts` (views, `setView`, new-project flow),
  `src/ui/dock.ts` (Split dock), `src/ui/standThumbs.ts` (stand pictures),
  `src/ui/aiBar.ts` (AI bar), `src/ui/foldSections.ts` (panel folds),
  `src/ui/guide.ts` (first tifo), `src/ui/mobileShell.ts` (phones).
- Browser memory keys: `tifo_guide_v1`, `tifo_view_v1`, `tifo_dock_v1`,
  `tifo_folds_v1`.
- Funnel events: `src/net/analytics.ts`, `FUNNEL_STEPS` in
  `server/src/routes.ts`, labels in `server/src/adminPage.ts` (all three).

## Workflow

1. Reuse the nearest existing pattern; build on tokens.
2. Strings in both languages.
3. `npx tsc --noEmit -p .`, `npm run build`, `npm run verify`.
4. Look at it in a browser: 390px and 1440px, English and Arabic, light and
   dark where it applies. Fix and look again until it is right.
5. Update the covering browser suite. Suites that start a new project but are
   not about the guide set `localStorage.tifo_guide_v1 = 'done'`; suites that
   expect one view first set `tifo_view_v1` (`'2d'` or `'3d'`): a new project
   otherwise settles in Split.
6. Run every suite (server suites, verify, verify:superai, secret scan,
   bundle-server, every `e2e-*.mjs`, the four ground walks), on Node 24 like
   CI and the server.
7. Hand over with the commit's Summary and Description as two separately
   labelled parts. Never push: pushing is Osamh's.
