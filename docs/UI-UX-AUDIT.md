# TifoMaker UI / UX review

22 October 2026

## Direction

Make the first visit immediately understandable, make starting a project feel
approachable, and keep the stadium and the supporter's work central. Retain the
blue identity, real stadium imagery, existing editor engine, English/Arabic
localization, and light/dark preferences.

This is a source review and local browser evaluation, informed by published UX
guidance. It is not a usability study with representative users, and does not
establish a conversion improvement or full WCAG conformance.

## Findings and implemented changes

| Finding | Change | Reason |
| --- | --- | --- |
| The opening screen needed a stronger connection to the product and clearer hierarchy. | A dark stadium hero, simpler value proposition, restrained English display typography, and a framed stadium preview. | The main action and example should be recognizable before secondary details. |
| The workflow explanation appeared far down the homepage. | An early, linked three-part workflow introduces choosing a club, designing, and preparing match day. | Give newcomers a compact overview before asking them to explore leagues and features. |
| The stadium still depended on clicking an image to discover its interactive behavior. | A keyboard-accessible “Explore in 3D” button with loading, busy, and retry states; the static image remains until a preview succeeds. | Make the interaction discoverable and communicate its state. Keep WebGL lazy. |
| The mobile menu could omit links because responsive CSS hid their desktop originals. | Clone explicitly available navigation items regardless of responsive desktop visibility. | Mobile visitors need the same destinations. |
| A closed, off-screen drawer could remain keyboard reachable; an open drawer did not manage focus. | Inert closed drawer and page background, focus entry and trapping, Close button, Escape, focus restoration, scroll lock, and cleanup on desktop resize. | Keyboard and screen-reader navigation should follow what is visible. |
| Projects and setup lacked a strong visual hierarchy. | Workspace introduction, grouped search/filter controls, clearer empty-state card, more generous card spacing, larger pin/menu/colour targets, and separated setup header/footer. | Improve scanning and make actions easier to reach. |
| Setup progress was represented by unlabeled bars. | Visible localized step labels and `aria-current="step"`. | Explain where someone is in the flow. |
| Public-page focus and sticky navigation behavior varied. | Shared visible focus rings, header target sizing, current-page underline, and anchor clearance. | Provide consistent orientation and keyboard feedback. |
| Empty-project guidance described an older name-first setup. | English and Arabic guidance now describes the actual club-first flow. | Instructions should match the next screen. |

## Research used

- [NN/g: Five Principles of Visual Design](https://www.nngroup.com/articles/principles-visual-design/): scale, contrast, grouping, and hierarchy informed the hero and project controls.
- [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): introduce the overall workflow early while retaining advanced work in the established editor panels.
- [W3C: WCAG 2.2](https://www.w3.org/TR/WCAG22/): keyboard operation, visible focus, target size, and unobscured focus informed interaction changes. Several important controls now use 44px targets; this is not a claim that every control has been audited.
- [W3C: Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance): informed the explicit focus treatment. This is AAA guidance, used as a design reference rather than a conformance claim.

## Verification

- Production TypeScript + Vite build passed. Missing files in the local
  `@types/three` installation were restored from the same npm version, 0.184.1;
  dependency manifests and lockfile were not changed.
- Existing theme suite: **62 passed, 0 failed**, including both themes,
  public-page contrast checks, Arabic, and the mobile theme control.
- Existing projects suite: **93 passed, 0 failed; no page errors**, including
  guest/account project creation, saving, search, pinning, rename, duplication,
  recovery, AI gates, publication, and Arabic phone setup on temporary data.
- `npm run verify` completed successfully. Its legacy diagnostic output includes
  `undo works: false` and `import undo: false`; the browser projects suite
  separately passes painting/autosave and recovery checks. This change does not
  alter those engine paths.
- Browser inspection covered desktop, 390px and 320px phone layouts, English
  and Arabic, club search results, 3D loading and successful preview, mobile
  menu destinations, Shift+Tab focus wrapping, Escape/focus restoration, and
  club selection through project setup into the editor.
- Phone layout measurements showed no document-level horizontal overflow at
  320px. Primary action labels remain unbroken and stack on narrow phones.
- Local testing uses an in-memory backend. No production deployment or
  account changes were made.

## Follow-up priorities to validate with users

1. **Editor discoverability:** observe new users making one design, switching
   to Stadium, and finding Share. Measure completion and hesitation before
   changing the established tool/panel structure.
2. **Community discovery:** test whether people find a useful example and
   successfully remix it. Evaluate sorting and filtering using real content.
3. **Production handoff:** test whether an organizer can obtain and understand
   the right export pack without assistance.
4. **Performance:** measure first interaction and 3D readiness on ordinary
   phones. The production build still reports a large 3D chunk; preserve lazy
   loading and use measurements before splitting renderer code.
5. **Content density:** compare the compact workflow against the longer
   explanation later on the homepage. Remove repetition if user testing shows
   the shorter version answers the necessary questions.

## Full product pass — 22 October 2026

The second pass follows the actual product beyond the landing page. It combines
source inspection, browser walkthroughs, simulated failures, and regression tests.
The earlier results above describe the first pass; the coverage below describes
this wider review.

### Journey coverage

| Surface | Review performed | Result |
| --- | --- | --- |
| Homepage and navigation | Entry points, club selection, responsive navigation, existing light/dark support | Retained the first pass; checked continuity into projects. |
| Projects and creation | Club/ground/start flow, storage messaging, search, rename, copies, recovery, account migration | Existing project suite re-run after dialog changes. |
| Seat editor | Views, tool names, tab navigation, colour controls, save state, export discovery | Corrected shortcut guidance, tab keyboard behavior, and misleading empty save indicator. |
| Banner studio | Empty state, creation choices, contextual properties, introductory tour | Tour now yields to work elsewhere and does not interrupt another panel. |
| AI designer | Prompt/examples and guest account gate; account and verification states in project tests | Preserved the existing gate and editable workflow. Live external AI output is not a visual-design validation method. |
| Stadium and Match Day | Entry/exit, help, camera controls, recording controls, touch layout, failure states | Added focus containment and honest clipboard feedback; preserved rendering and camera behavior. |
| Publishing and sharing | Public/private distinction, metadata dialog, nested Share overlay, QR and clipboard denial | Reworked shared Share presentation and recovery; added modal focus behavior. |
| Production exports | PDF and CSV downloads, QR prerequisites, explanations | Described each format; stopped offering unusable fan QR links for private/local work. |
| Public tifo page | Viewing, share entry, related designs, phone width | Exercised public links in English and Arabic. |
| Fan seat page | Section → row → seat → card, small-screen width, failed loading | Exercised the real seat-selection path and added retry on load failure. |
| Community | Cards, search, filters, profiles, preview, pagination and failed network requests | Added title search, keyboard entry points, safe async transitions, visible failures and retry. |
| Account and authentication | Signed-out entry, settings layout, sign-in/signup/reset subviews, themes and Arabic | Added consistent language/theme controls; fixed modal focus and light-theme password hints. Authenticated project states use disposable local test accounts. |
| Password reset | Missing-token state and link recovery | Hide the unusable password form; open the reset-email form directly from recovery. |
| Clubs | Capability claims, form feedback, language consistency | Describe implemented tools rather than promising shared editing or white-label hosting; localize results and preserve fields on failure. |
| Legal | Direct section links, English/Arabic section mapping | Canonical links now resolve to the section that is actually visible. Legal policy text was not rewritten. |

### Important findings addressed

1. **Private fan QR links:** a saved private design is visible to its owner,
   but a fan without that session cannot load it. Require publication, explain
   why, focus the publishing action, and remind organizers to keep it published.
2. **False clipboard success:** Share, Post it, and Match Day previously treated
   denied or missing clipboard access as success. Report the actual result. The
   Share/QR dialogs offer a selectable link for manual copying.
3. **Dialog focus and nesting:** a visually modal screen did not consistently
   isolate the page or restore focus. A reusable controller handles keyboard
   containment, scroll locking, original inert states, and top-dialog Escape.
   It covers confirmations, auth, publishing, feedback, community previews,
   sharing, animation previews, QR, simulator, and simulator help.
4. **Invisible community failures:** feed loading wrote an error and then hid
   the element containing it. Separate errors from loading; retain existing
   cards, expose Retry, and avoid automatic repeated requests during an outage.
5. **Inaccessible cards and creator search:** click handlers on articles/spans
   gave keyboard users no equivalent. Use real title links and creator buttons;
   preserve public URLs and modified-click behavior.
6. **Search expectations:** the prominent search field only searched creators.
   It now also searches design titles; @creator lookup remains available, and
   responses from old searches cannot replace a newer result.
7. **Stale preview loading:** closing or switching a preview while its 3D assets
   loaded could populate a different preview. Ignore results from older opens.
8. **Lost reset flow:** a tokenless reset page solicited a new password that
   could never be submitted. It now leads directly to requesting a fresh link.
9. **Unclear export formats:** use labeled rows with a short task-oriented
   explanation for volunteer sheets, spreadsheet seat records, and fan QR.
10. **Keyboard orientation:** panel tabs now have one Tab stop and support
    Home/End; view buttons expose their selected state; status messages are
    announced. The footer correctly identifies I as the colour picker.
11. **Stray save indicator:** the empty panel status still drew a green tick
    via CSS when the actual save message was shown in the header. Hide it when
    empty rather than showing an unexplained success mark.
12. **Interrupted onboarding:** a spotlight could remain over another task.
    Tours now yield on an outside pointer interaction; automatic banner help
    waits until the painting panel is the active task.
13. **Inconsistent account controls:** settings lacked the public site's theme
    and language switches. Add both without discarding form values.
14. **Password contrast:** a yellow decorative accent was used for a link on a
    light background. Use the semantic blue and theme-aware text colours.
15. **Credibility:** the club page claimed simultaneous collaboration,
    white-label domains, and guaranteed exact venue modeling without those
    facilities in the inspected application. Replace these with the actual
    design, preview, distribution, and fan-instruction capabilities.
16. **Arabic legal navigation:** links to the canonical English section IDs
    could target hidden content. Resolve hashes to the current language.
17. **Cropped Share artwork:** older OG endpoints can return an 800×84 seat
    strip. Cropping it to a landscape tile enlarged only a few seats. Fit the
    whole image and reuse the existing bowl renderer for panoramic fallbacks.
    Move Copy link before secondary platform choices.
18. **Live language switching:** static headings translated while already
    rendered community cards kept the old language. Refresh runtime card labels
    and clear stale creator suggestions when switching languages in place.

### Regression results from the full pass

| Command | Result | What it establishes |
| --- | --- | --- |
| `npm run build` | Passed | Strict TypeScript and production asset build. The existing large-chunk warning remains. |
| `npm run test:ux` | 82 passed, no page errors | New cross-page recovery, keyboard/nesting, real PDF/CSV downloads, public seat links, simulator focus, and live language switching. |
| `npm run test:community-auth` | 118 passed | Sign-in/signup/reset views, creator lookup, light/dark, Arabic, and phone presentation. |
| `npm run test:projects` | 93 passed, no page errors | Guest and account project persistence, AI gates, publishing, copies and recovery. |
| `node e2e-mobile.mjs` | 318 passed | Touch editing, short screens, rotation, Arabic, simulator controls and WebGL failure behavior. |
| `npm run test:theme` | 62 passed | Public-page theme switching and the suite's sampled contrast checks. |

These suites ran during the review. The production build and new UX suite are
repeated after final fixes; the test totals describe executable checks, not a
claim of exhaustive usability or accessibility certification. Preview and test
logs live in the ignored `preview-out/` directory. The new `e2e-ux.mjs` is a
maintainable regression suite; it expects the local built site and in-memory
server on port 8911 (or `BASE` set to a separate test server).

### Additional research

- [W3C APG: Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) informed focus containment, top-dialog Escape, and focus restoration.
- [NN/g: Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/) informed visible, actionable network and clipboard recovery.
- [NN/g: Empty States](https://www.nngroup.com/articles/empty-state-interface-design/) informed distinct empty-search, loading, and failed-feed feedback.

### Limits

This does not claim every possible state is flawless or that a heuristic review
substitutes for representative users. Real device performance, screen-reader
testing with assistive technology, live email/OAuth delivery, and production
latency remain separate checks. Admin/security operations and moderation policy
were not redesigned. Existing large 3D bundles remain lazy-loaded; no renderer
rewrite or new dependency was introduced. No live-site publication was performed.
