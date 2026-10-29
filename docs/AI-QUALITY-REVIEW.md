# AI Tifo Designer — quality review and plan

Written 28 October 2026 from a full read of the AI pipeline (server and client),
a run of the existing harnesses (`npm run verify:superai`, `scripts/ai-fit.mts`)
on the Kingdom Arena and Jewel seat maps, and research into what real tifos look
like (section 4). The question it answers: **why does the AI output feel like
the bare minimum, and what would it take to make it as good as a real tifo?**

The short answer: the engine underneath is strong (validated spec, deterministic
compiler, seat-level legibility checks, fit-to-stadium). What sits on top of it
is tuned for *cheapness and latency*, not quality. The model is the cheapest one
at the lowest effort, it designs blind, it is taught one template, it knows two
hex colours about the club, and nothing measures what it produces. Every one of
those is fixable, and the engine does not need to be rebuilt to fix them.

---

## 0. Summary

**What happens today.** A brief goes to a model that writes a `TifoSpec` (palette
plus a stack of fill / stripes / gradient / pattern / text / symbol / image layers,
each on a stand). The server validates and repairs it, a deterministic refiner
fixes contrast and minimum sizes, an image provider draws the hero picture, and
the browser fits the spec to the ground, paints the seats, and bakes the picture
through the image quantizer. All of that is sound and worth keeping.

**Why the result feels like the minimum (ranked by impact).**

1. **The default path is the weakest one.** The Generate button, the club chips
   and the AI bar all run "standard" mode unless *Whole stadium* is ticked. Standard
   mode is Claude Haiku 5.5 with thinking switched off, no stadium geometry, no
   copywriter, no few-shot gallery and no hero-picture guarantee. Super mode is
   Sonnet 5.5 at effort `low`, explicitly to keep latency near Gemini Flash. No
   Opus-class model is used anywhere.
2. **The model never sees its own work.** Generation is one shot, blind. The only
   feedback loop (Polish) is a separate button, runs once, and is shown a
   384 × 38-53 px JPEG of the whole bowl in which one seat is 0.3 px wide. It is
   judging a design it cannot see.
3. **Pictures are the weakest link visually.** FLUX schnell at 4 steps, a 1,300
   character style suffix the model mostly cannot read, nearest-colour quantization
   into a hue palette, a border flood-fill cut-out, and the user's whole brief pasted
   into the image prompt. The result is the yellow blob face in
   `Claude outputs/portrait-after.png`.
4. **One template, taught four times.** The few-shot gallery is four designs with
   the same shape (hero on one end, words on the other, pattern on the sides), so
   that is what comes back. Regenerate returns the identical cached design for 30
   minutes.
5. **The model knows almost nothing about the club or the ground.** Two hexes and a
   crest word per club; a stadium context with no main stand, home end, screens,
   block names or walkway positions, although the engine knows all of these.
6. **Nothing measures model output.** 250 checks test the plumbing; the fit harness
   tests the *offline* designer and the exemplars. The model's designs are never
   rendered, scored or compared between prompt versions.

**The plan** (section 5) is five phases. Phase 0 builds the eval that makes
everything else measurable. Phase 1 spends the tokens the right way (Opus 5.5 at
high effort with caching, structured output, async jobs, Super as the only
premium path, stadium and club knowledge, a real exemplar library). Phase 2
closes the loop: draft → render → vision critique at real resolution → revise,
automatically, with progress shown to the fan. Phase 3 makes pictures read.
Phase 4 turns a card mosaic into a choreography (banners, flags, reveal,
blocks), which is what the real thing is. Phase 5 learns from use.

Cost per Super design rises from roughly $0.03 today to roughly $0.40-0.60 at
full quality (section 6). At a thousand designs a month that is a few hundred
dollars, inside the credit you say you have.

---

## 1. How a design is made today

```
brief (≤400 chars)                                   src/ui/aiPanel.ts run()
  │  + stadium context text (SUPER ONLY)             src/core/stadiumContext.ts
  ▼
POST /api/ai/generate                                server/src/aiRoutes.ts
  ├─ prompt screen (regex)                           server/src/promptSafety.ts
  ├─ result cache: same brief → same design, 30 min  aiRoutes.ts:88, 639
  ├─ [super] COPYWRITER: Haiku 5.5, thinking off     aiProvider.ts writeCopy()
  ├─ DIRECTOR / DESIGNER:
  │     std   → Haiku 5.5, thinking off, no context  aiProvider.ts:130,157,169
  │     super → Sonnet 5.5, effort low, 45 s cap     aiProvider.ts:157,1003
  │     (Gemini behind it; 2 calls max per request)
  ├─ coerceModelSpec + validateSpec (repair layer)   src/core/tifoSpec.ts
  ├─ refineSpec: field, size floors, 3:1 contrast    src/core/specRefine.ts
  ├─ [super] ensureHeroImage                         src/core/heroImage.ts
  └─ pictures: Pollinations FLUX → Cloudflare → Gemini   server/src/imageAssets.ts
  ▼
browser applySpec()                                  src/ui/aiPanel.ts
  ├─ fitSpecToStadium (rows, moves, drops, 2 lines)  src/core/specFit.ts
  ├─ compileSpec → seats (one undo step)             src/core/specCompiler.ts
  ├─ critiqueDesign + one repairSpec bump            src/core/critique.ts
  └─ image layers → quantize/halftone/cut-out        src/core/objects.ts, importImage.ts

optional, manual: Polish → POST /api/ai/critique with a 384-px render → Sonnet 5.5 low
```

Stage by stage, what each one is allowed to spend:

| Stage | Model | Thinking / effort | Prompt | Output cap | Time cap |
|---|---|---|---|---|---|
| Copywriter (super only) | claude-haiku-5-5 | disabled | ~460 tokens | 16k | 30 s |
| Standard design | claude-haiku-5-5 | disabled | ~2.3k system, no stadium | 16k | 30 s |
| Super director | claude-sonnet-5-5 | effort **low** | ~3.5k system + ~400 user | 16k | 45 s |
| Polish critic | claude-sonnet-5-5 | effort **low** | ~770 system + spec + 384-px image | 16k | 45 s |
| Picture | FLUX schnell (4 steps) | n/a | ≤200-char subject + ~300-token style | 1 image | 45 s |

The whole request has to finish inside Cloudflare's 100-second limit, which is
why every cap above is where it is. That constraint shapes everything, and it is
the first thing to remove (an async job, section 5, phase 1).

---

## 2. What the output looks like now

The exemplars and the offline designs rendered as seats (unrolled stands, two
strips per bowl) are in the harness output; a few observations from them and
from the stadium renders in `Claude outputs/`:

- Every design is the same composition: a field, a symbol or word on one end, a
  word on the other end, hoops or chevrons on the sides. `v1-hilal-bowl.png`,
  `v3-ittihad-bowl.png` and `w2-kufi-bowl.png` are the same tifo in different
  colours.
- Text is set in a display face at the stand's full height and reads well. This
  part of the engine is good and should be protected.
- The hero symbol is a 20-30 vertex polygon (`src/core/symbols.ts`). The eagle
  reads as "a bird-ish shape"; the crescent and star read; nothing else carries a
  stand on its own.
- The one portrait example (`portrait-after.png`) is a six-tone yellow oval with
  two black dots. No fan would hold that up.
- Nothing in a design is specific to the club beyond its two colours: no
  nickname, no slogan, no legend, no year, no rival, no ultras group.

---

## 3. Findings

Each finding: what, where, why it limits quality, and the fix. Ordered by how
much quality it holds back.

### F1 — The default path is the cheapest model with thinking off and no stadium

- `src/ui/aiPanel.ts:698` sends the stadium context only when `useSuper`; the
  Generate button, the club chips (`index.html:359`) and the AI bar run standard
  mode unless the *Whole stadium* box (`index.html:370`, unchecked by default) is
  ticked.
- Standard mode is the fast tier: `claude-haiku-5-5` (`server/src/aiProvider.ts:130`)
  with thinking disabled (`:169`), the shorter system prompt without the bowl rules,
  no copywriter (`aiRoutes.ts:694` is super-only), no exemplar gallery and no hero
  guarantee (`aiRoutes.ts:753` is super-only).
- So the front-door experience ("Al Hilal" chip → tifo) is a small model, not
  thinking, that has never been told how many rows the ground has.

**Fix.** One premium path. Every generation gets the stadium context, the
copywriter, the gallery and the hero guarantee; "one stand" versus "whole bowl"
becomes a *brief* parameter (the active-area text already exists in
`src/core/activeArea.ts`), not a different pipeline. Keep the offline Quick
Designer as the free fallback, nothing else.

**Done on this branch (29 October 2026).** The *Whole stadium* box is gone
from the panel; every request runs the director pipeline (copywriter, premium
tier, stadium context, hero guarantee) and the Quick Designer composes the
whole bowl too. The request's `mode` now only picks the allowance a design is
metered on: the panel sends none, so designs are metered as *standard*
(10 a day free under Pro), and the *super* allowance is no longer spent by
anything in the UI. The Pro tiers need a decision on what "Super" sells now.

### F2 — The premium model is run at its lowest setting

- `claudeEffort()` returns `low` for premium (`aiProvider.ts:157`), with the comment
  that it keeps the wait "close to what Gemini Flash took".
- `claudeMaxTokens()` is 16,000 (`:180`) and the premium time cap is 45 s (`:1003`).
  At high effort on Opus, thinking alone can exceed both.
- No Opus-class model is configured anywhere; `claude-opus-5-5` is only mentioned
  in a comment as an option.

**Fix.** `claude-opus-5-5` for the director and the critic at effort `high`
(measure `xhigh`), adaptive thinking (it cannot be disabled on Opus 5.5), streaming,
`max_tokens` 32-64k, and the static system prompt cached (`cache_control`
`ephemeral`; Opus 5.5 cache reads cost $0.20/MTok, so the 3.5-4k-token system
prompt costs under a tenth of a cent per call after the first). The copywriter is
the single most important creative decision ("the PHRASE decides the design"); it
should not be the cheapest model with thinking off. Make the time cap a job, not
a request (F11).

### F3 — The model designs blind, and the critic is nearly blind

- Generation is one call; the model never sees the compiled seats.
- Polish (`aiPanel.ts:885`) is manual, runs once, and `captureRender()` draws the
  bowl at **384 px wide** (`:863`), JPEG 0.82 (`:878`). Measured on the real maps
  (`scripts` run in this review): 384 × 38 px on the 60k bowl, 384 × 46 on Kingdom
  Arena, 384 × 53 on the Jewel. One seat is 0.31 × 0.65 px. A ten-row Arabic
  headline is a 6-px smear. The critic prompt then asks the model to judge
  legibility "as a spectator across the pitch".
- The critic runs at effort `low` on Sonnet.

**Fix.** Make the render-critique-revise loop the *generation* path, not a
button: compile, render the unrolled strips at seat resolution (one seat ≥ 3 px;
a 10:1 bowl fits in two 1,600 × 300 strips, about 1,300 image tokens each) plus
one 3D camera view, and let Opus 5.5 critique against a written rubric and
return a revised spec, up to N rounds, keeping the best by score. Opus 5.5 reads
dense visual material accurately at every effort and is the model to use for the
critique. Show each draft to the fan as it lands ("Draft 1 … Draft 2 …"): the
wait becomes the show.

### F4 — Pictures: the pipeline is built to lose

- Provider chain is FLUX schnell on Pollinations, then Cloudflare's
  `flux-1-schnell` at 4 steps (`imageAssets.ts:449`), then Gemini's image model.
  Cloudflare's model always returns a square, which the client then cover-crops
  into a 4:1 stand (heads lose their tops).
- `mosaicStyle()` (`imageAssets.ts:174`) appends about 1,300 characters (roughly
  300 tokens) to every prompt. FLUX schnell reads at most 256 T5 tokens; the
  negatives at the end ("no gradients, no text…") are the part most likely to be
  dropped.
- The hero prompt pastes the brief in: `"${subject}, for: ${brief}"`
  (`heroImage.ts:69`), so "crescent moon, for: Al Hilal champions of Asia tifo
  whole stadium" asks a diffusion model for a stadium scene.
- Aspect and row hints come from a *nominal* bowl (`tifoSpec.ts:392-424`): 1,000
  px per stand, two tiers. Kingdom Arena's south stand is 13:1 and 12 rows; the
  picture is asked for at 4:1 and 52 rows.
- Quantization is nearest-RGB (`importImage.ts quantizePixels`) into a palette of
  club hues. A grey-shaded face mapped onto blue/white/gold by nearest colour is
  where the mush comes from, whatever the generator drew. The prompt asks for
  "tones ordered dark to light", but nothing uses that order.
- Cut-out is a border flood-fill with a tight tolerance (`cutoutBackground`); any
  vignette or soft edge from the generator fails it and the picture lands as a
  rectangle. The product already has a real background-removal model
  (`server/src/cutout.ts`, Bria on Cloudflare), used only for the Pro manual tool.

**Fix** (section 5, phase 3): posterize by *luminance rank* (k levels from the
picture's own histogram → palette tones ordered by value), a stencil clean-up
pass that removes any blob under the 3-seat legibility threshold before baking,
the real cut-out model on every AI picture, short front-loaded prompts sized to
the generator, the real stand's aspect and rows from a structured stadium
context, 2-4 candidates per picture scored by the vision model *at seat
resolution* before one is chosen, a better generator for heroes (Gemini image or
FLUX.2 class; Recraft-style vector output for silhouettes), and a photo-upload
path for real players (the only honest route to "our striker's face").

### F5 — One template, taught four times; Regenerate repeats it

- `src/core/exemplars.ts:37-93`: four exemplars, all "hero one end, headline the
  other, field or pattern on the sides". The director prompt says "never one
  default template" and then shows one template four times.
- `aiRoutes.ts:639-640`: the result cache key is (mode, prompt, stadium,
  provider). Regenerate (`aiPanel.ts:973`) resends the same brief, so for 30
  minutes the user gets the identical design back with the note "Served instantly
  from cache". That is the single most visible "bare minimum" moment in the UI.

**Fix.** A library of 12-20 distinct compositions, each a real design pattern
from section 4 (full-bowl mosaic, scarf stripes, split halves, hoops with a
crest, giant number, calligraphy end, two-stand mural, minimal single stand,
banner-plus-cards, …), with 4-6 selected per brief by occasion, language and
ground shape. Regenerate carries a nonce and the previous design's summary with
"do something structurally different". Cache only exact repeats of the *first*
request.

### F6 — The model knows two hexes about the club and little about the ground

- `src/core/clubs.ts`: 48 clubs × {aliases, 2-3 hexes, one of 22 symbol names}.
  Nothing about nicknames beyond aliases, slogans, chants, legends, numbers,
  rivals, ultras groups, founding years, honours or typical motifs.
- `describeStadiumContext()` gives seats, rows, cols, aspect, tiers per stand.
  The engine also knows the big screens (`src/core/screens.ts`), the real blocks
  and their names (`src/core/blocks.ts`, `realBlocksSaudi.ts`), the tier walkway
  position, the main stand and camera presets, but none of it reaches the prompt.
- There is no "understand the brief" stage: the copywriter chooses words, the
  director lays out; nobody first asks "what is this tifo *about*, for *whom*,
  against *whom*, and what would their curva actually hold up?"

**Fix.** A club knowledge file (JSON, start with the 18 Saudi Pro League clubs
plus the MENA and European clubs already listed): nickname, chant lines, slogans
in Arabic and English, legends with numbers, founding year, rivals, ultras group,
honours, motifs, kit colours as a tonal palette. A structured stadium context
(JSON beside the text): main/TV stand, home end, screen positions, walkway row
fraction, block names and sizes, per-stand real aspect and rows. A brief stage
(same Opus call, as the first part of its thinking) that writes a one-paragraph
creative brief before the spec.

### F7 — The spec cannot say what real tifos are made of

- Layers are fill, stripes, gradient, pattern, text, symbol, image. There is no
  banner, no overhead flag, no two-stick flag field, no per-block targeting, no
  multi-line text, no custom silhouette, no sequence. Real tifos (section 4) are
  cards *plus* a painted banner along the front or between tiers *plus* flags on
  the sides, revealed in an order.
- The product already has all of those: a full banner system
  (`src/core/banner.ts`, `src/ui/bannerView.ts`), Match Day accessories (flags,
  flares, smoke, strobes: `src/core/accessories.ts`), eight reveal orderings
  (`src/core/reveal.ts`), real blocks. The AI touches none of them.
- Symbols are 22 hand-written polygons. No lion, tiger, horse, falcon in flight,
  trophy, sword, palm, map, scarf, number shapes.

**Fix** (phase 4): spec v3 with `banner` (text or artwork on a printed banner,
placed by the banner system's own zones: front rail, between tiers, overhead),
`flags` (a field of two-stick flags on a stand, rendered by Match Day),
`reveal` (ordering + timing), `blocks` (region by real block name), `svg`
(a validated silhouette path the model or a vector generator supplies),
multi-line `text`. The output becomes a *choreography plan*, which is what a
capo actually needs. Following the research, a portrait defaults to a `banner`
in front of the cards unless the stand has at least 60 rows and 80 seats
across; the cards behind it carry the field and the words, which is how every
famous portrait tifo is built.

### F8 — Post-processing rewrites the design and the model never learns

- `refineSpec` raises text to 0.22 / 0.55 (Arabic) of the stand, recolours for
  3:1 contrast, adds panels, undoes letterboxes; `fitSpecToStadium` moves layers
  between stands, splits lines, drops layers; `critiqueDesign` bumps sizes by 12%;
  `validateModelSpec` drops up to a quarter of the layers. All silent to the
  model, and some of them collide (a backing copy recoloured, a stretch dropped).
- These are good safety nets. They are the wrong *first* line: they turn a
  deliberate design into an approximate one, and the model gets no chance to make
  the same fix deliberately.

**Fix.** In the loop (F3), every change these passes make is reported back to
the model as text ("your south headline was raised from 0.3 to 0.55 because
Arabic needs 12 rows; your east crest was moved to west because east has 9
rows") and the model revises. Keep the passes as the final guard, with their
changes logged into the eval.

### F9 — Nothing measures model quality

- `scripts/verify-superai.mts` is 250 checks of plumbing (regions, caches,
  prompts contain words, exemplars validate). `scripts/ai-fit.mts` renders the
  offline designer and the exemplars and counts rows and fragile seats. Neither
  ever calls the model.
- `/admin → AI` records cost, latency and failures, not quality. There is no
  user rating, no "kept vs regenerated" signal, no edit-distance after AI.
- The house rules in the prompts are "measured on real seats" (good) but the
  measurements are not re-run when the prompt changes.

**Fix** (phase 0, first): an eval set of 40-60 briefs (Arabic and English,
Saudi clubs, the occasions the composer already knows, single-stand and
whole-bowl, with and without a person) × 4 grounds (Jewel, Kingdom Arena, Abha,
Al-Majma'ah), run through the real pipeline in the existing headless harness,
rendered as strips plus a 3D still, graded by an Opus 5.5 vision rubric
(legibility, club identity, composition, hero quality, use of the whole bowl,
"would a curva hold this up") plus the deterministic numbers already computed
(fragile share, rows per word, per-stand fill). A score per prompt version,
kept in `docs/`, is how "think hard" becomes "measured better".

### F10 — Prompt engineering written for a different model

- The prompts (`buildSystemPrompt`, `buildDirectorPrompt`, `buildCriticPrompt`)
  are dense capitalised rule lists tuned for Gemini Flash, with the JSON contract
  repeated three times and no reasoning scaffold. Claude 5.5-class models do
  better with a structured brief, a few concrete patterns to avoid, and room to
  think; over-prescriptive prompts reduce their output quality.
- No structured output is used (`AI_RESPONSE_SCHEMA` exists for Gemini, off by
  default). The 200-line `coerceModelSpec` repair layer exists because of it.
- Contradictions: "never a default template" next to a four-copy template; "GIVE
  THE BOWL A PICTURE" in the single-stand prompt whose mode has no hero
  guarantee; a critic told to see a picture it cannot resolve.

**Fix.** Rewrite for Opus 5.5 with `output_config.format` (a JSON schema for the
spec, so the model cannot write an invalid region or a hex in a colour slot),
the reasoning steps named (read the ground, write the brief, choose the words,
assign stand roles, choose a composition from the library, set the palette as
tones, write the spec, self-check against the rubric), and the house rules kept
but shortened to what the measurements support. Keep `validateSpec` as the
guard; retire most of the coercion.

### F11 — The product nudges away from quality

- *Whole stadium* unchecked by default; the club chips never tick it.
- Any provider hiccup offers "Use the Quick Designer" as the primary button.
- Polish is a separate button most fans will never press.
- Briefs are capped at 400 characters (`aiRoutes.ts:45`); a supporters' group
  cannot describe a real idea in that.
- Everything is one synchronous request under a 100-second ceiling, so every
  stage is sized for speed first.

**Fix.** One mode. An async job (`POST /api/ai/jobs` → id; the client polls or
listens; the server may take 2-4 minutes) with real progress text from the model
(`thinking.display: "summarized"` or the progress-update blocks). Quick Designer
only when premium is genuinely unavailable. Brief cap 2,000 characters. Polish
folded into generation; keep the button for "one more pass" on an edited design.

### F12 — Smaller code issues (fix as they are touched)

- `regionRowsHint` / `regionAspectHint` use a nominal bowl although the client
  knows the real one; send structured context and use it (`tifoSpec.ts:392`).
- `MAX_PICTURES_PER_DESIGN = 4` and the per-account picture caps are sized for
  one FLUX call per layer; the candidate scoring in phase 3 needs its own budget
  line, not to be refused by `takeSide`.
- `copyLine()` forces the director to use the copywriter's words "EXACTLY", even
  when they do not fit the ground (a 12-row stand and a three-word Arabic phrase).
  Give the copywriter the ground, or let the director overrule with a reason.
- `halftoneCellFor` disables halftone under 40 rows, so on every Saudi ground
  except the Jewel the "halftone": true the director is told to write does
  nothing.
- The critic strips `assetRef` and re-attaches by *order* of image layers; a
  critic that reorders or drops an image layer gets the wrong picture.
- `screenPrompt` is English-only regex; Arabic abuse passes straight to the
  model's own filter (acceptable, but note it).
- Gemini fallback models named in `.env.example` (`gemini-2.5-flash`) are retired
  per `preflight.ts`; the example file should name current ids.
- The std prompt and the director prompt both embed the symbol and pattern lists
  and the font notes; one shared block already exists for the house rules and
  should hold all of it.
- Found while building the comparison (`scripts/spec-shots.mts`): the row
  fraction `v` a seat carries is a fraction of the *whole bowl's* row stack, not
  of its own stand. On Kingdom Arena the south stand spans v = 0..0.19 and the
  north lower tier 0..0.47, so horizontal `stripes`, vertical `gradient` and
  `pattern` layers (which use `v` directly in `specCompiler.applyLayer`) collapse
  on any stand shorter than the tallest: four horizontal bands on the south
  painted zero seats. Every real-block Saudi ground has stands of unequal
  height, so this hits them all; the generic 60k bowl hides it. The same global
  `v` is what makes `rows: [a, b]` bands land in the wrong place until the fit
  pass rescues them.
- The fit pass thickens Arabic under 25 glyph rows ("joins thinner than a
  seat") with an outline of 4 source pixels, which at 22-24 rows welds the
  counters shut: the same headline drawn one row taller, with no outline, read
  cleanly. The threshold and the stroke should both be measured per face.
- The stadium-context note tells the model "North and South are the ends
  facing each other; East and West are the long sides" (`stadiumContext.ts`).
  In world space it is the other way round: east and west sit at ±x behind the
  goals, north and south along the touchlines, and the TV-gantry preset looks
  from the south at the north. The house rule "words on north/south, pattern on
  east/west" is right for the camera and wrong in its stated reason.

---

## 4. The bar: what real tifos do

The full research brief, with sources, is in `docs/AI-TIFO-RESEARCH.md`. It was
built from search-result snippets because full-page fetches were refused by the
session's network policy; the photographs themselves still need to be collected
for the exemplar library. What it establishes:

**The canon is three layouts, not twenty.**

1. One giant painted image filling the end stand, with at most one line of text
   along the bottom or on a separate strip (Dortmund's binoculars 2013,
   Copenhagen's cannon 2014, Legia 2017, Lech 2025, Portland's Pennywise 2018).
2. A card mosaic of text, a number, a crest or stripes, in two to four colours
   (Celtic's 360-degree Lisbon Lions display 2017: green base, "LISBON LIONS" in
   silver on the long stand, "1967" on the main stand, a silver cup and a "50"
   in a gold star on the two ends; Legia's five-sector countdown; Al Hilal's
   2026 three-colour hidden tifo).
3. The whole bowl split by role: hero on the curva/end, a short slogan on the
   long main stand where the cameras face, stripes or flat club colour on the
   rest (Olympiacos v Real Madrid 2025-26, Marseille's four-stand anniversaries,
   Red Star 1996).

The engine's current one template is a thin version of layout 3. Layouts 1 and
2, and the *banner-plus-cards* combination that most of the canon actually is,
are not expressible in the spec today (F7).

**Faces are painted, not held up.** Every famous portrait tifo (Ronaldo at Al
Nassr, Beckenbauer at Bayern, Ahlawy's jailed members, Pennywise) is a painted
banner. Card mosaics carry text, numbers, crests and flat shapes. Painters
posterise to three to five tones and draw the dark outlines last. This is the
strongest argument for phase 4's banner layer: a portrait belongs on a printed
banner in front of the cards, which the product's banner system can already
render, and the cards behind it carry the colour field and the words.

**Saudi tifos are bilingual and star-led.** "Not Like Us" next to أطلق العنان
للوحش at Al Ittihad; "Greatness is earned" and "900" with Ronaldo at Al Nassr;
زعيم آسيا, كن قوياً and هنا الهلال at Al Hilal; English with an Arabic line
underneath on Al Hilal's 2025-26 banner. Subjects are the star player, the club
mascot (Ittihad's tiger), a milestone number, or a pop-culture reference. Named
groups: Blue Power, Curva Gold, the Al Nassr fans' council. None of this is in
the club file today (F6), and the copywriter is told to pick *one* language.

**Choreography is a sequence.** Cards up on the capo's signal and held through
kick-off, then the overhead banner unfurls, then flares and smoke. Legia's
countdown re-forms the cards every dozen seconds; Raja's 2023 derby display was
five tifos in one. The product has the reveal player, the banner system and the
accessories to express this and the AI uses none of them.

**The famous failures are all things a machine can check.** "Pack mas" read as
"Fick mas" at Bayern 2019 because letterforms distinct on paper collapsed at
seat resolution from the camera angle; a misspelling painted into an HSV banner;
a Lille banner section hung upside down; over-detailed card choreos that nobody
could read and half the crowd did not lift; holes from a late bus or an empty
third tier (Al Ittihad cancelled a design for exactly that reason). The lessons
are a spelling gate, an OCR gate on the seat-resolution render from the TV
camera, a minimum feature size, a dropout simulation and a perspective check.

**Nobody else computes quality.** The one professional vendor (Kivett) judges a
card stunt by superimposing the design on a photo of the venue; no planning tool
found measures legibility, contrast, no-show robustness or TV-angle readability.
That is the gap this engine is already half-way to owning (`findFragileSeats`,
`fitSpecToStadium`, the no-show mask in the 3D preview) and the eval in phase 0
turns it into a product claim.

**The rules, and where the system stands.** The brief ends with twenty testable
rules; the ones that matter most for this plan, with today's status:

| Rule (from the research) | Today |
|---|---|
| One hero per bowl, on an end, ≥80% of stand height, centred | Partly: `ensureHeroImage` for Super only; no size check after bake |
| Cards: ≤4 colours per stand, ≤6 across the bowl; depth only inside the hero | No: the prompt asks for 6-16 tones everywhere |
| Palette from club identity (3 club colours + white/black) | Partly: 2-3 hexes, no tonal ramp |
| Text one line per stand, ≤5 words Latin / ≤4 Arabic | Partly: prompts say so; nothing enforces it |
| Cap height ≥8 rows, stroke ≥2 seats, gap ≥1 seat | Yes for rows (fit floors); no stroke or gap check |
| Arabic as shaped glyphs, stroke ≥2 seats, reject broken joins | Partly: shaped glyphs yes; no join check |
| Spelling gate + OCR of the render from the TV camera | No |
| Minimum feature size (erosion test) | Partly: `findFragileSeats` flags, does not clean |
| 4.5:1 contrast between touching colours | 3:1 in `specRefine`; raise and measure |
| Outline when fill is close to field | Yes, as a prompt rule and the backing-pair device |
| Faces only on painted/generated layers, ≥60 rows × 80 seats for a card face | No: faces are baked into cards on 12-row stands |
| Banded gradients on cards | Yes (fit posterises shallow gradients) |
| No letter crosses a tier boundary | Partly: prompt rule; `localRows` ignores walkways |
| Dropout test: 15% random, 30% top tier | No (the 3D view has a 10% toggle, unused by AI) |
| Perspective check from the TV camera and the far end | No |
| Thumbnail test: hero still classifiable at 64 × 32 | No |
| Every spec ships a sequence (cards → banner → pyro) | No |
| Local language first, English second; a single idea | Partly: copywriter picks one language |

Phase 0's grader and phase 2's loop implement the checks in the "No" rows;
phase 4 makes the sequence and the banner expressible.

---

## 5. The plan

Five phases. Each lists what it buys, what it touches, what it costs per design
and how success is measured. Phases 1-3 can overlap; 0 comes first because
without it every later change is a guess.

### Phase 0 — Measure (3-4 days)

**Build the eval.**

- `scripts/ai-eval/briefs.json`: 40-60 briefs. Mix: Arabic 50%, English 40%,
  mixed 10%; Saudi clubs 60%; occasions (derby, farewell, anniversary, title,
  heritage, welcome, player, "just my club"); single stand and whole bowl; with
  and without a person; short and long briefs.
- `scripts/ai-eval.mts`: runs the real `/api/ai/generate` (a local server with
  keys) for each brief × ground, applies the spec in the headless harness exactly
  as `aiPanel.applySpec` does, writes the unrolled strips at ≥3 px per seat, a
  3D still from the TV-gantry preset, the spec, the fit changes and the
  deterministic numbers.
- `scripts/ai-grade.mts`: Opus 5.5 with the images and a rubric, returns a JSON
  score card (0-10 on legibility, hero recognisability, club identity,
  composition, use of the bowl, phrase quality, Arabic quality, "would a curva
  hold this up") with one sentence per score. Also records what refine/fit
  changed. Three checks from section 4 run on the same render: the model reads
  the text back from the TV-camera view (the "Pack mas" test), re-reads it on a
  degraded render with 15% random empty seats and 30% in the top tier, and
  classifies the hero from a 64 × 32 thumbnail of its stand.
- `docs/ai-eval/<date>-<label>.md`: the table, per-brief thumbnails, and the
  deltas against the previous run.

**Baseline** today's pipeline on it before changing anything. Run the eval after
every prompt or pipeline change from then on.

Cost: ~60 briefs × 4 grounds × (director + grader) ≈ $60-90 per full run on
Opus 5.5; use a 20-brief subset for daily runs.

### Phase 1 — Spend the tokens properly (1-2 weeks)

1. **Async jobs.** `POST /api/ai/jobs` returns a job id; `GET /api/ai/jobs/:id`
   returns stage, progress text and the result; the client polls every 2 s (or
   SSE). Removes the 100-second ceiling. The existing progress UI gets real
   stage text from the model.
2. **Models and settings.** Director and critic: `claude-opus-5-5`, effort `high`
   (A/B `xhigh` on the eval), adaptive thinking, streaming, `max_tokens` 48k,
   `cache_control` on the static system block. Copywriter: fold into the
   director's own reasoning (one model, one cache namespace) or Sonnet 5.5 at
   `high`. Include the server-side `fallbacks: "default"` opt-in so a safety
   decline on a legitimate brief still gets a design. Keep Gemini as the outage
   backup, not the quality tier.
3. **One premium path.** Standard mode = the director with a single-stand brief.
   Every run gets context, copywriter, gallery, hero guarantee. "Whole stadium"
   becomes a scope chip, default on.
4. **Structured output.** A JSON schema for `TifoSpec` via `output_config.format`;
   retire the coercion the schema makes impossible; keep `validateSpec`.
5. **Knowledge.** `src/core/clubKnowledge.ts` (18 SPL clubs first; the AI can
   draft it, a human checks it). Structured stadium context: per-stand real
   aspect and rows, main/TV stand, home end, screens, walkway fraction, block
   names. Both go in the user turn, not the cached system prompt.
6. **Exemplar library.** 12-20 compositions, each hand-authored, rendered and
   checked on three grounds; 4-6 chosen per brief. Each carries a one-line "when
   to use".
7. **Prompt rewrite** for Opus 5.5 (F10), with a self-check list and the house
   rules trimmed to what the measurements support.
8. **Regenerate** gets a nonce and "structurally different from: <summary>";
   cache only exact first requests.
9. **Brief cap** 2,000 characters; the AI bar keeps its one line.

Success: eval score up on every axis; zero "served from cache" on Regenerate;
latency 30-60 s for a draft (acceptable once progress is real).

Cost per design: ~$0.12-0.18 (one Opus director call with cached system prompt,
6-8k output tokens including thinking) plus the picture.

### Phase 2 — Close the loop (1-2 weeks, after phase 1)

1. **Render in the job.** Server-side render of the compiled design: the
   compiler needs a canvas for text, so run it in a headless Chromium worker
   (Playwright is already a dependency and the fit harness already does exactly
   this), bounded like `workerPool.ts`; or render on the client and post the
   images back to the job (zero new server infra, and the fan watches each draft
   land). Recommended: client-render first, server-render when the job needs to
   outlive the tab.
2. **Critique at seat resolution.** Two strips at ≥3 px per seat, one 3D still
   from the TV-gantry preset and one with the no-show mask on. Opus 5.5 scores
   against the rubric, reads the words back from the camera view, lists the
   three biggest problems, and returns a revised spec. Up to 3 rounds; stop
   early when the score stops rising; keep the best.
3. **Feed back the rewrites.** Everything `refineSpec`, `fitSpecToStadium` and
   `critiqueDesign` changed is passed to the model as text with the render, so
   the next draft makes those decisions itself.
4. **Progress as the show.** The job exposes the model's progress notes; the
   panel shows "Draft 1: crescent on the north, زعيم آسيا on the south… checking
   legibility… Draft 2: headline raised to 14 rows".
5. **Charge once**, at the end, as now.

Success: ≥80% of eval designs reach their best score by round 2; fragile share
and dropped-layer count fall to near zero without the deterministic passes
firing.

Cost per design: + ~$0.10 per round (two strips ≈ 2.6k image tokens, spec,
4-6k output) → ~$0.30-0.40 for a three-round Super design.

### Phase 3 — Pictures that read (1-2 weeks, overlaps phase 2)

1. **Luminance-rank posterization** for image layers: compute k levels from the
   picture's luminance histogram (k = number of tones the palette gives the
   picture, ordered by value), map level i → tone i. Hue no longer matters, so a
   grey or any-coloured generator output lands on the club palette cleanly.
2. **Stencil clean-up** before baking: morphological open/close at the 3-seat
   threshold, so no speck, no 1-seat line, no isolated card survives; then the
   existing `findFragileSeats` should report ~0 on the picture.
3. **Real cut-out** on every AI picture through the Bria model already wired in
   `cutout.ts`; the flood-fill stays as the free fallback.
4. **Prompts sized to the generator**: subject first, ≤60 words, the three
   constraints that matter (flat tones, plain backdrop, tight crop), nothing
   else; no brief text in the image prompt.
5. **Real shape and rows** from the structured stadium context; never request a
   square for a 4:1 stand on a provider that can take a size.
6. **Candidates scored at seat resolution**: generate 2-4, quantize each the way
   the bake will, downscale to the stand's rows, ask Opus 5.5 "which of these
   reads as <subject> from across a pitch; score each", keep the best. This is
   the single biggest lever for faces.
7. **Better generators for heroes**: Gemini 3.1 Flash Image (already supported
   as the Gemini provider; update the model id) or a FLUX.2 / Ideogram 3 class
   model for prompt adherence; a vector generator (Recraft's SVG output) for
   silhouettes that become symbol layers. Keep FLUX schnell as the free backup.
8. **Photo upload** for a real person: the Pro cut-out already produces a
   transparent PNG; add "use this photo as the hero" to the AI panel, posterize it
   through steps 1-2. This is how real groups make portrait mosaics (they trace a
   photo), and it is the only reliable route to a recognisable face of a specific
   player.

Success: eval "hero recognisability" ≥7/10 median on person briefs; zero
rectangles-on-the-stand from failed cut-outs.

Cost per design: pictures $0.01-0.20 depending on provider and candidates, plus
~$0.03 for the scoring call.

### Phase 4 — From mosaic to choreography (2-3 weeks)

1. **Spec v3** (`tifoSpec.ts`, versioned, with v2 migration): `banner` (text or
   artwork, a banner kind from `banner.ts`, a zone), `flags` (stand, density,
   colours), `reveal` (ordering from `reveal.ts`, duration, sequence: cards up →
   banner → flags/pyro), `blocks` regions by real block name on grounds that have
   them, `svg` silhouette layer (validated path, bounded complexity, rendered
   through the same mask path as symbols), multi-line `text`.
2. **Compiler and Match Day** consume the new layers: banners through the banner
   system, flags and pyro through accessories, reveal through the reveal player.
3. **Director prompt** gains the choreography vocabulary from section 4
   (Blockfahne, Überziehfahne, two-stick flags, card display, sequence), and the
   exemplar library gains banner+cards compositions.
4. **Symbol library** grows from 22 polygons to ~60 curated silhouettes (vector
   generator → trace → hand-check), covering the animals, objects and Saudi
   motifs the briefs actually ask for.

Success: an eval axis "is this a choreography a group could run" ≥7/10; banner
text at the front rail in ≥50% of whole-bowl designs where the brief has a
sentence.

### Phase 5 — Learn from use (ongoing)

- Keep / regenerate / edit-after-AI recorded per design (no prompt text stored,
  as today).
- Kept designs with high eval scores become candidates for the exemplar library
  (human-curated, as the IP note in `exemplars.ts` requires).
- Weekly eval run on the 20-brief subset; monthly on the full set; the score
  table in `docs/ai-eval/`.
- A/B prompt or model variants by job, scored by the grader and by keep-rate.

---

## 6. Cost model

List prices: Opus 5.5 $4 / $20 per MTok, cache reads $0.20; Sonnet 5.5 $2 / $10;
Haiku 5.5 $0.10 / $0.50. Pictures: FLUX schnell ~$0.002; Gemini image
~$0.03-0.07; Recraft vector ~$0.08 (third-party figures, check before relying).

| Per Super design | Today | Phase 1 | Phases 2+3 (3 rounds, 3 picture candidates) |
|---|---|---|---|
| Copywriter | Haiku, ~$0.001 | in the director | in the director |
| Director | Sonnet low, ~2.5k out → ~$0.03 | Opus high, ~7k out, cached system → ~$0.15 | ~$0.15 |
| Critique rounds | manual, Sonnet low ~$0.02 | — | 2 × ~$0.10 = ~$0.20 |
| Pictures | 1 × FLUX ~$0.002 | 1 × FLUX or Gemini ~$0.002-0.05 | 3 candidates + scoring ~$0.05-0.25 |
| **Total** | **~$0.03-0.05** | **~$0.15-0.20** | **~$0.40-0.60** |

At 1,000 Super designs a month: ~$40 today, ~$180 after phase 1, ~$500 at full
quality. The eval costs ~$60-90 per full run. All of it is behind env knobs
(`AI_CLAUDE_MODEL_PREMIUM`, `AI_CLAUDE_EFFORT_PREMIUM`, a new `AI_LOOP_ROUNDS`,
`AI_PICTURE_CANDIDATES`) so quality can be dialled per plan: free accounts at
one round, Pro at three.

---

## 7. Risks and guard-rails

- **Keep the moat.** The model still never touches seats; `validateSpec`,
  `refineSpec`, `fitSpecToStadium` and `critiqueDesign` stay as the last guard.
  The loop makes them fire less, not disappear.
- **Latency.** A three-round Super design is 2-4 minutes. That is fine only if
  progress is real and the first draft lands in under a minute. The async job
  and streamed progress are not optional.
- **Provider outages.** Keep the Gemini backup and the Quick Designer, but make
  the fallback a *message*, not the default button.
- **Arabic.** Every eval brief set is half Arabic; the grader scores Arabic
  separately; the fit floors for Arabic stay.
- **Safety.** Opus 5.5 may decline some briefs; use `fallbacks: "default"` and
  treat a refusal as content, as the code already does.
- **Cost control.** The daily budget breaker counts calls, not dollars; move it
  to cost (the pricing table already exists) before the loop ships.
- **Image rights and likeness.** Generators will not draw named players
  reliably and some providers refuse names. The photo-upload path (phase 3.8)
  needs the same rights attestation the design-photo upload has.

---

## 8. The first two weeks, as tickets

1. Eval set and harness; baseline run; score table committed. _(3-4 days)_
2. Async job endpoint; client polling; progress text. _(2 days)_
3. Opus 5.5 director at `high`, caching, structured output, 48k tokens,
   fallbacks; Sonnet 5.5 copywriter at `high`; one premium path; Regenerate
   nonce. _(2 days)_
4. Structured stadium context + club knowledge for the 18 SPL clubs. _(2 days)_
5. Exemplar library (12-20), rendered and checked. _(2-3 days)_
6. Prompt rewrite for Opus 5.5; second eval run; keep what scored. _(2 days)_
7. Client-render critique loop, 2 rounds, best-of; third eval run. _(3-4 days)_

Everything after that (pictures, choreography) builds on a pipeline that is
already measurably better and can be measured again.
