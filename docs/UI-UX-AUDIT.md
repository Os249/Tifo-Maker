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
