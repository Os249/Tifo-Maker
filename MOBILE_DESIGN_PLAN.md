# Mobile Design UX Plan — Designing on Phones

## 1) Why this is now priority #1

Your TikTok audience is **almost entirely phone users**, and the video's whole job is to send them to `tifomaker.org`. If they land and can't comfortably design on a phone, the funnel **leaks at the worst possible point** — right after you spent effort earning their attention. 69.8% Saudi, 18–34, mobile‑native. **The phone editing experience is what converts video reach into actual users.** Right now the editor is a shrunk‑down desktop tool, not a phone‑native one.

## 2) How the giants do it (research synthesis)

Common patterns across **Canva, Photoshop for iPad, Photoshop Express, and Picsart**:

1. **The canvas is the hero.** Full‑screen; chrome collapses. Photoshop Express lets you *tap the canvas to hide the UI* for a clean, immersive view.
2. **Bottom, thumb‑reachable controls.** Canva uses a 5‑tab bottom bar; PS Express puts *all tools + presets in a bottom row*; Picsart uses a scrollable bottom ribbon. One‑handed use is the default assumption — essential controls live in the bottom half, in the thumb's natural reach.
3. **Contextual, on‑demand tools.** Photoshop for iPad is *context‑aware* — tools and options surface only when relevant. Canva: tap an element → a contextual edit bar appears.
4. **One obvious "add" affordance.** Canva's purple **+** floating button.
5. **Direct manipulation.** Drag to move, control handles to resize/rotate, **pinch‑zoom / spread**, standard gestures — with **instant visual feedback** and **≥48×48px touch targets**.
6. **Progressive disclosure.** Mobile surfaces the *most‑used* tools; power features are deferred or hidden (Express = quick actions + sliders; iPad = fuller but still contextual).
7. **Templates / AI‑first entry.** Canva leads with templates, AI, and Quick Create so users **start from something**, never a blank canvas.

## 3) The hard truth for TifoMaker

Your canvas isn't one photo — it's **60,000 seats**. "Paint every seat with a fingertip" is **not viable** on a 6" screen. So mobile has to **reframe what 'designing' means**:

- **Lead with AI + Presets + Club palettes** — pick or type, don't paint. (This also *is* the Saudi‑club angle from the video plan.)
- **Paint by section/zone, not per‑seat** — fill scope = seat / section / stand / whole‑bowl, big brush, mirror symmetry.
- **Light touch‑up only**, with pinch‑zoom for precision.
- **Then the payoff everyone wants:** the 3D Match Day + share (already strong on touch).

**Design goal:** *a first‑time phone user makes a shareable, great‑looking tifo in under 60 seconds — mostly via AI/presets + a few taps.*

## 4) Design principles (TifoMaker mobile)

1. **Canvas‑first, full‑screen**; minimal floating chrome.
2. **One thumb** — every primary action reachable at the bottom.
3. **AI & presets are the front door on mobile**, not the brush.
4. **Big targets (≥48px), standard gestures, instant feedback.**
5. **Progressive disclosure** — 5–6 core tools visible, the rest in a "More" sheet.
6. **Never block the canvas with a full panel** — use draggable **bottom sheets** the user can dismiss with a swipe.

## 5) Current state (audit)

You already have real foundations — `src/ui/mobileNav.ts` (nav drawer), responsive breakpoints, safe‑area handling, mobile content pages, and a phone **"create‑lite"** editor flow (paint + AI + simulate + share). **The gap is the editor's *touch tool UX*** — it behaves like a shrunk desktop editor. This plan turns create‑lite into a giant‑grade phone editor. It builds on what exists; it isn't a rewrite.

## 6) The plan (phased, surgical — on your stack: PixiJS editor + Three.js simulator)

**M1 — Mobile detection + full‑screen canvas layout**
Detect coarse pointer / small width → switch to a dedicated mobile editor layout (not just CSS‑shrink). Canvas goes edge‑to‑edge; a tiny top bar (back · title · **Match Day**); everything else moves to the bottom.

**M2 — Gestures on the Pixi canvas**
Pinch‑zoom + two‑finger pan; one‑finger paint; tap‑select; long‑press = eyedropper/context. Set `touch-action: none` on the canvas, use pointer events, add momentum. (You already have a zoom range on desktop — extend it to touch.)

**M3 — Bottom tool ribbon (thumb zone)**
Horizontal scrollable ribbon of big icons: **Brush · Fill · Shapes · Text · Image · Colours · AI · Presets**. Active tool highlighted; a persistent colour‑swatch row + "＋ Colour".

**M4 — Bottom sheets for tool options**
Tapping a tool opens a **draggable bottom sheet** (brush size, fill scope, mirror, palette). Swipe down to dismiss. It never covers the whole canvas.

**M5 — AI/Presets‑led "Create" front door (mobile) — the biggest conversion lever**
The mobile editor opens on: **"Describe it"** (Quick Designer, Arabic + English) · **"Pick a preset"** · **"Your club"** palette (Al Hilal / Al Nassr / Al Ittihad / Al Ahli / …) · then **"or paint."** One tap → apply → straight to 3D preview. This is what turns video traffic into finished designs.

**M6 — Section painting + symmetry**
Default fill scope to **Section** on mobile; mirror toggle; snapping; large brush; big undo/redo. Makes big‑canvas work feasible by thumb.

**M7 — Simulator + share touch polish**
Confirm orbit/pinch, reveal record, and the share sheet are all thumb‑friendly (mostly done — verify).

**M8 — Cross‑device QA + performance** *(your pending Mobile P6)*
Real‑device testing (iOS Safari, Android Chrome), 60k‑seat performance on mid‑range phones, safe‑area, RTL.

## 7) Feature parity (desktop → mobile)

- **Keep:** AI / Quick Designer, presets, club palettes, section fill, brush, text, shapes, image import, 3D Match Day, share, print/seat‑map (as export links).
- **Simplify:** layers / advanced palette editing → essentials + a "More" sheet.
- **Defer / hide on phone:** fine per‑seat precision work, dense multi‑panel layouts.

## 8) Success metrics

- **% of mobile visitors who complete a design** (primary — expect a big lift).
- **Time‑to‑first‑tifo on phone** (target < 60s).
- **Mobile signup conversion from video traffic.**
- **3D reveal + share rate on mobile** (the viral loop that feeds the next video).

## 9) Recommended sequence

Do **M1–M4 first** (they unlock everything), then **M5** (AI/presets front door — the single biggest lever for converting the exact phone traffic your TikTok sends), then **M6–M8**. I can start with an **M1 audit + a mobile‑editor layout spec** (wireframe of the bottom ribbon + sheets + gestures), then implement surgically, one phase per pass, without touching the locked desktop layout.

---

*Sources: [Navigate the Canva mobile app](https://www.canva.com/help/navigate-canva-mobile-app/), [Photoshop iPad workspace](https://helpx.adobe.com/photoshop/using/workspace-ipad.html), [Photoshop iPad vs Express](https://paperlike.com/blogs/paperlikers-insights/photoshop-for-ipad-vs-photoshop-express), [Designing for Touch — UXmatters](https://www.uxmatters.com/mt/archives/2020/02/designing-for-touch.php), [Mobile UX best practices 2026](https://www.mobileviewer.io/blog/mobile-ux-design-15-best-practices-for-2026).*
