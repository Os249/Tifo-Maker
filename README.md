# Tifo Maker — Phase 1 + 2 engine

Design stadium tifos seat by seat, then preview them draped over the bowl. This covers
Phases 1 and 2 of the technical blueprint: a 60,000-seat 2D editor engine (data
contracts, parametric seat-map generator, instanced renderer, tools, sparse-diff undo)
plus the Three.js stadium preview bound to the same design buffer.

## Interface — Floodlight design system

A dark "stadium at night" workspace: the muted concourse-dark chrome recedes so the
vibrant tifo canvas is the focal point. Two accents with a strict division of labor —
terracotta (#FF5C38) **acts** (active tools, primary actions), violet (#8B7CFF)
**selects** (focus, selection, the mini-map viewport); enforced by the rule that
danger never glows while accents always do. Layout is the four-region creative-tool
grammar tuned for a 10:1 panoramic document: 44px top bar with the centered
Design/Stadium toggle, 48px icon tool rail, central canvas with a floating zoom pill
and a live mini-map (the thumbnail renderer pointed at the live buffer, with a violet
viewport rect for click/drag navigation), and a 264px contextual properties panel.
The status bar reports the cursor's seat in stadium language (stand · section · row ·
seat); palette swatches carry live card counts (ambient bill-of-materials); `Tab` is
zen mode. Tokens live in `src/ui/floodlight.ts`; `theme.ts` installs them.

## Responsive strategy

Three tiers keyed to capability, not just width:
- **Desktop (>=1100px)** — the full Floodlight editor.
- **Tablet (768-1099px)** — the complete editor with larger touch targets; the
  properties panel becomes a slide-over summoned by a floating button, so the canvas
  keeps full width between adjustments.
- **Phone (<768px)** — a dedicated read-only **viewer**, not a crippled editor
  (`src/ui/viewer.ts`). The 3D stadium is the full-bleed hero with camera-preset
  pills, followed by the design's title, a flat 2D strip, a card bill-of-materials,
  a primary Share action, Fork, and the public gallery. Editing redirects to desktop
  (`?editor=1` forces the editor anywhere) — no dead tool buttons ship to a screen
  that cannot use them. Reuses the same seat map, store, and Preview3D as the editor.

## Recent additions

- **Likes & community feed** — published tifos appear in a full-screen feed with
  search-by-name, Recent / Most-liked sorting, and like/dislike voting (one vote
  per user per design, backed by a `design_votes` table and a denormalized
  `like_score`). A request-token guard prevents stale search responses from
  overwriting newer ones.
- **Profiles** — the header "Sign up" button shines until you sign in, then shows
  your name and opens a profile with your created and liked tifos.
- **Guided save** — Save opens a dialog to choose: keep private, publish to the
  community, or download a portable `.tifo` file — with a "save as new copy" option
  when editing an existing design.
- **Split view** — a third workspace mode showing the 2D Design canvas and the 3D
  Stadium side by side, both live; painting on the left updates the stadium on the
  right in real time (they share the one cell buffer).
- **Real-colour import** — image import defaults to extracting the picture's own
  dominant colours as the palette (dither now off by default).
- **Design-tab clarity** — an orientation strip and section header tags make it
  clear which controls set how you paint vs. the overall look.

## Deployment

The app and API deploy as **one process from one origin** — the server serves
the built SPA and the API together, so the client's relative `/api` calls work
with no proxy and no CORS. For step-by-step host instructions (Railway, Render,
Fly, or plain Docker) see **[DEPLOY.md](./DEPLOY.md)**; config files for all
three hosts (`railway.json`, `render.yaml`, `fly.toml`) are in the repo root.

**Build + run:**
```
npm run build:prod   # type-checks and builds the SPA into dist/
npm start            # NODE_ENV=production; serves dist/ + API on $PORT (default 8787)
```

**Required environment** (see `.env.example`):
- `DATABASE_URL` — Postgres connection string. **Required in production**: the
  server refuses to start without it under `NODE_ENV=production`, because the
  in-memory fallback would lose every design on restart. The schema is applied
  automatically on boot (idempotent `CREATE TABLE IF NOT EXISTS`).
- `PORT` — listen port (most hosts inject this).
- `NODE_ENV=production` — enables the DATABASE_URL guard, rate limiting, and logging.

**Hardening built in:**
- `@fastify/helmet` security headers.
- `@fastify/rate-limit` — 300 req/min global, 10/min on `/api/auth/*` (brute-force
  and spam protection).
- 1MB request body limit (room for gzipped cells + a thumbnail, capped as an abuse ceiling).
- `GET /health` for load-balancer health checks (used by the Dockerfile HEALTHCHECK).
- TLS is terminated by the host/reverse proxy — deploy behind HTTPS before login goes live.

**Docker:** a single `Dockerfile` builds the frontend and runs the combined server.
```
docker build -t tifo-maker .
docker run -p 8787:8787 -e DATABASE_URL=postgres://... -e NODE_ENV=production tifo-maker
```

**Verified:** production server serves the SPA at `/`, the API same-origin, SPA
fallback for client routes, 404 for unknown `/api` paths; a full
register → create (60,832-seat design) → load → publish → gallery cycle persists
to Postgres; the DATABASE_URL guard and the 10/min auth rate limit both fire.

## Run it

```bash
npm install
npm run dev            # open http://localhost:5173
npm run build          # type-check + production bundle
npm run verify         # headless sanity check of generator + algorithms (Node)
npm run export:sample  # render a 57-page distribution-plan PDF to out/
npm run server         # API on :8787 (in-memory repo; set DATABASE_URL for Postgres)
npm run test:server    # route suite vs memory repo (+ Postgres when DATABASE_URL set)
```

With the API running next to `npm run dev`: **Sign in** (accounts auto-create),
**Save** (uploads gzipped cells + a client-rendered PNG thumbnail), tick **Public**
to list it, and **Gallery** browses everyone's published tifos with one-click load.
Loading someone else's design gives a working copy — Save creates your own.

## What you get

- **Parametric bowl** — a superellipse-plan, two-tier, ~60,800-seat stadium generated
  deterministically from `DEFAULT_TEMPLATE` (`src/core/template.ts`). Rows are placed by
  arc length along offset curves; radial aisles and the tier walkway are punched out of
  the grid; every seat carries editor (x,y), normalized (u,v), AND world (x,y,z)
  coordinates — the (u,v) ↔ xyz pairing is what makes the Phase 2 3D preview and the
  Phase 4 anamorphic warp lookups instead of rewrites.
- **Instanced rendering** — one PixiJS `ParticleContainer`, one draw call, static
  positions, dynamic per-seat color. Pan with space/right-drag, wheel-zoom around the
  cursor.
- **Tools** — brush (sizes, stroke interpolation), eraser (paints index 0), flood fill
  with **section** scope (bounded by aisle wedges — the unit real tifo planners
  distribute cards by) or **global** scope (crosses aisles, hard-stops at tier
  walkways), palette presets, section guides, keyboard shortcuts (B/F/E/Space,
  Ctrl+Z / Ctrl+Shift+Z).
- **Draggable object layer** — text and images place as floating, movable,
  resizable objects (65% ghost, violet selection frame + corner handle) above the
  seat grid until you **Bake** them in. Objects keep their own undo stack entirely
  separate from the seat buffer, so arranging never touches the engine's verified
  painting; the **Select tool** (V) and an Object panel drive height-in-seats, tier,
  stacking order, bake/bake-all, and delete. Scaling re-rasterizes crisply (text
  keeps its string/font/arc, images keep their bitmap) rather than stretching pixels.
- **Reveal animation + GIF export** — play the design on as a choreographed wave
  with eight orderings (left/right sweeps, rise-from-pitch, open-from-center, section
  by section, row by row, sparkle, instant). Un-revealed seats dim with a soft fade
  edge; play/pause/scrub and a length slider control playback. A dependency-free
  GIF89a encoder (LZW over the tifo's small palette) exports a looping reveal —
  verified valid, infinitely looping, progressing from fully-dimmed to fully-revealed.
- **Per-swatch color editor** — double-click any palette slot for a native color
  picker + hex field; editing recolors every seat using that slot instantly (seats
  store indices, not colors) and re-tints floating objects, so custom club colors
  are two clicks away.
- **Section navigator** — the Stadium panel lists all sections grouped by stand
  (North/East/South/West) as clickable cells; click one to zoom-to-fit that section.
- **Off-thread heavy work** — seat-map generation and GIF LZW encoding run in a Web
  Worker with zero-copy typed-array transfers and a synchronous fallback, so even the
  76k oval never blocks the UI thread.
- **Image import with full configuration** — click **Import image**, and a config bar
  opens with a cursor-following ghost preview of the actual image: set the **width in
  seats** (8-1,250, with the derived height shown live), limit painting to the
  **lower or upper tier**, toggle **dithering**, tune the **alpha cutoff** (1-254 —
  which transparency level leaves seats untouched), then either **click anywhere** to
  place or pick a **stand preset** (North/East/South/West, centered on the chosen
  tier) and hit Place. Pixels resample to seat density, quantize to the card palette
  (index 0 is never a target), optionally Floyd-Steinberg dither, wrap across the
  bowl seam, and stamp as ONE undo step. Esc cancels the import.
- **Stadium preview (Phase 2)** — switch to the **Stadium** tab for a Three.js view:
  one `InstancedMesh` of 60k card-quads positioned from `SeatMap.pos3`, colored from
  the SAME `cells` buffer the editor paints (no sync layer — the dirty callback updates
  instance colors directly). Camera presets (TV gantry, behind goal, pitch level,
  aerial) plus free orbit, and a "No-shows 10%" toggle that previews real-world card
  dropout. Three.js is code-split: it downloads only when the stadium view first opens.
- **Persistence API with accounts + gallery (Phase 3, complete)** — Fastify backend
  in `server/` implementing the blueprint schema: `designs` stores the gzipped cell
  buffer in-row (a saved 60k design measures **~300 bytes** in Postgres),
  `design_revisions` is append-only sparse diffs — byte-identical to the client undo
  format — with a full snapshot every 20th revision so replay stays bounded.
  Accounts use scrypt password hashing and opaque bearer tokens stored only as
  sha256 hashes (node:crypto, zero auth dependencies). Ownership semantics: private
  designs are **404** to everyone else (existence hidden), public designs are
  readable and forkable by anyone signed in but mutable only by the owner (**403**).
  The gallery endpoint joins owner names and serves client-rendered PNG thumbnails.
  Validation reuses the SAME seat-map generator the browser runs (core/ is DOM-free).
  Storage sits behind `DesignRepository`/`AuthRepository` interfaces with Postgres
  and in-memory implementations; the test suite runs the full multi-user scenario
  against both.
- **Distribution-plan export (Phase 4)** — `npm run export:sample` renders the
  matchday document: a cover with the purchase list (total cards per color) and the
  unrolled bowl overview, then one page per section with its bill of materials and a
  seat-by-seat chart drawn from real coordinates (arcs, ragged rows, and aisle gaps
  appear exactly as the steward sees them), row labels, and a view-orientation note.
  56 sections + cover = 57 pages in ~0.6 s. The renderer lives in `src/export/` and
  shares the core types — the export worker was always meant to be this codebase.
- **Three stadiums** — the Stadium selector switches between the generic two-tier
  60k bowl, a steep single-tier 40k kop (Tottenham-style resolution wall), and a
  shallow 76k grand oval (Berlin-style p=2.0 wrap). Bowls are pure data
  (`StadiumTemplate` entries); the selector reloads with `?template=<id>`, and the
  seed pattern, section guides, and server validation all adapt automatically.
- **Pattern presets** — the Pattern dropdown applies nine deterministic backgrounds
  computed from seat-map coordinates (hoops, section columns, checkerboard, diagonal
  sash, opposite stands, tier split, Bayer-dithered vertical gradient, accent
  borders, solid), each as a single undo step using palette slots 1-3.
- **Text tool** — press T (or the Text button), type your message, pick one of five
  fonts (Impact, Arial Black, Verdana, Georgia, Courier), set the height in seats
  (1 "pixel" = 1 seat, 6-44), then click a stand to place it in the active color.
  Text renders with real canvas fonts, is alpha-masked at seat density through the
  same aspect-correct pipeline as image import (so letterforms stay undistorted on
  the non-square seat grid), wraps across the bowl seam at u=0/1, and is never
  mirrored (reflected glyphs read backwards). Each placement is one undo step.
  Custom fonts load via **Font file…** (.ttf/.otf/.woff through the FontFace API)
  and appear in the font select immediately.
  A **ghost preview** at 55% alpha follows the cursor in the active color, live-
  updating as you edit text, font, size, or arc. The **Arc slider** (-150° to
  +150°) bends the text along a circular arc — per-character placement with exact
  arc-length spacing, so letter spacing is preserved at any bend; positive arches
  up, negative bows down, and the seat-height slider always controls letterform
  size (the bow adds extent without shrinking the glyphs). Arabic, Hebrew, and
  Indic text arc correctly too: connected/RTL scripts are shaped as a whole string
  (preserving joining and bidi) and then the pixels are bent along the arc, while
  Latin keeps the crisp per-glyph rotation.
- **Mirror painting** — toggle **Mirror** (or press M) and every brush stroke, fill,
  and erase reflects across the halfway line. The reflection map is precomputed in the
  seat map (`mirrorOf`) and is an exact involution: rows are generated with even seat
  counts so each row's seat set maps perfectly onto itself.
- **Legibility check** — the **Check** button flags every painted seat sitting in a
  stroke thinner than 3 seats (the survival threshold under real ~10% no-show rates,
  per the reference tifos), flashes them warning-pink, and reports the count. Thickness
  is the minimum run dimension, so 1-tall bands and 1-wide diagonals both flag.
  Dithered regions flag heavily by design — dither does soften under no-shows.
- **History as SparseDiffs** — every stroke commits one `{indices, before, after}`
  record. The same format is the autosave payload, the revision-history row, and the
  future realtime-collaboration message. A full design is one byte per seat: ~60 KB raw,
  single-digit KB gzipped.

## Verified numbers (`npm run verify`)

| Check | Result |
| --- | --- |
| Seats generated | 60,832 in ~140 ms |
| Neighbor link coverage (L/R/D/U) | 100 / 100 / 96 / 95 % — no dangling refs |
| Section flood fill | ~1,060 seats in 1.6 ms |
| Global flood fill | 31,212 seats (full lower tier) in 18 ms |
| Undo round-trip | byte-exact |
| Design state size | 60,832 bytes raw |
| Bowl geometry | front row 1.5 m, top 25.4 m, radial 70–134 m, pitch clearance ok |
| Bundles | entry 83 KB gzip (Pixi + engine); 3D chunk 132 KB gzip, loaded on demand |
| Quantizer | 50% gray dithers to a 527/497 black/white mix; alpha skip and one-step undo verified |
| Mirror map | 100% coverage, exact involution (0 failures), never crosses rows |
| Patterns | 9 presets deterministic, palette-valid, color-balanced; tier split matches tierOf exactly |
| Seam wrap | rect across u=0/1 paints 1,551 + 1,548 seats on both sides, zero leakage |
| Arc layout | symmetric glyph placement/rotation, arch-up and bow-down orientation, arc-length spacing exactly preserved, chord < flat run |
| Templates | generic-bowl-60k = 60,832 · single-kop-40k = 39,700 · grand-oval-76k = 75,984 seats, tier counts correct |
| Tier-limited stamp | 31,220/31,220 upper-tier seats painted, zero lower-tier leakage |
| Reveals | 8 orderings span [0,1]; sweep-lr tracks u monotonically |
| GIF export | valid GIF89a, 36 frames, infinite loop; gray fraction 100% → 11% across reveal |
| Object lifecycle | place → drag → bake verified; objects undo independent of seat buffer |
| Worker | spawns, generates bowl off-thread, returns byte-identical GIF |
| Palette sync | switching palette on Design now recolors the 3D Stadium view (store.setPalette fans out to both) |
| Reveal guard | painting during a scrubbed reveal snaps back to full color instead of fighting the dim |
| Legibility | uniform base: 0 flags; 1-tall line: all 32 flagged; thickened to 5 rows: collapses to 3 ragged-edge seats |
| PDF export | 57 pages (cover + 56 sections), ~0.6 s, page count verified with qpdf |
| API suite | two-user scenario: register/login/logout, 401/403/404/409 semantics, visibility, byte-exact round-trip, thumbnail round-trip, gallery, 25 diff revisions, snapshots, cross-user fork, per-owner lists — passing on memory AND Postgres 16 |
| Stored sizes | full design 282 B in-row; 25 revisions = 750 B of diffs + one 257 B snapshot |

## Architecture map

```
src/
  core/            framework-free engine (shared with backend + export worker later)
    types.ts       StadiumTemplate, SeatMap, DesignState, SparseDiff — the contracts
    template.ts    default 60k bowl + club palette presets
    seatmap.ts     deterministic generator: superellipse → offset rows → arc-length
                   seats → aisles/walkways → sections → neighbor graph
    spatialHash.ts O(1) pointer→seat resolution (disc + nearest queries)
    design.ts      DesignStore: cells buffer, stroke recording, sparse-diff undo/redo
    tools.ts       brush stamp/segment, BFS flood fill over the neighbor graph
    importImage.ts image→palette quantizer (FS dithering at seat density), seat stamping
    analysis.ts    legibility: flag strokes thinner than the 3-seat survival threshold
    patterns.ts    nine preset backgrounds as pure (seat index → palette index) functions
    text.ts        real-font text rasterization + pure arcLayout for arched baselines
    objects.ts     floating text/image object layer with its own undo + bake-to-seats
    reveal.ts      per-seat reveal orderings + RevealPlayer playback clock
    gif.ts         dependency-free GIF89a encoder (LZW) for reveal export
  net/
    api.ts         browser client: auth, CompressionStream gzip, thumbnail render, gallery
  ui/ (additional)
    gallery.ts     public-gallery overlay with thumbnails + one-click load
  export/
    distributionPdf.ts per-section distribution plan: BOMs + seat charts (Node/pdfkit)
  render/
    editor.ts      PixiJS app, particle renderer, camera, pointer→tool wiring
    preview3d.ts   Three.js stadium: InstancedMesh from pos3, camera presets, no-shows
    objectOverlay.ts floating-object sprites + drag/resize/select interactions
  workers/
    heavy.worker.ts  off-thread seat-map generation + GIF encoding (pure ops)
    client.ts        async wrapper with synchronous fallback
  ui/
    toolbar.ts     thin DOM layer over the engine (replaced by React+Zustand in Phase 3)
```

Design rule enforced throughout: **the cell buffer never passes through UI-framework
state.** The renderer reads `DesignStore.cells` directly and reacts to dirty-index
callbacks; UI code holds tool/color/zoom state only.

## Server

```
server/
  schema.sql       designs + design_revisions (see comments for the design rationale)
  src/
    routes.ts      Fastify routes: auth, templates, designs CRUD, revisions, gallery, fork
    auth.ts        scrypt password hashing + hashed bearer tokens (node:crypto only)
    repo.ts        DesignRepository contract
    pgRepo.ts      Postgres implementation (transactional revision appends)
    memoryRepo.ts  in-memory implementation (dev + tests)
    codec.ts       gzip + base64 wire codecs
    server.ts      bootstrap; DATABASE_URL selects Postgres
  test/
    server.test.mts full scenario, parameterized over both repositories
```

## What remains from the blueprint

- Worker offloading (generation, large fills, quantization — all already pure).
- More `StadiumTemplate`s (data-only), and the export worker's 4K stills / video
  jobs beside `renderDistributionPdf`.
- Realtime collaboration: the revision wire format is already the CRDT-friendly
  per-seat last-writer-wins diff the blueprint planned for.

## Known simplifications

- Seat-map generation (~140 ms) and large global fills (~18 ms) run on the main thread.
- Up/down neighbor coverage is ~96% — missing links sit at tier edges by design.
- The preview's no-show mask is regenerated per session (visual aid, not design data).
- No persistence yet — that is Phase 3.
