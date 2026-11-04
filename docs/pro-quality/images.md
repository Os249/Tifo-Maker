# Pro quality: pictures (portrait styles, smart cut-out, AI pictures)

1 November 2026, follow-up 2 November. One picture pipeline now serves all
three perks. What changed, how it was measured, and an honest score for each. The evidence is
in /home/claude/evidence/images/ (never in the repo: it is made from test
photos that must not ship).

## What changed

**Portrait styles** (`core/portraitStyles.ts`, `core/portraitPipeline.ts`,
`ui/portraitPrep.ts`, `ui/portraitVision.ts`, `ui/proStyles.ts`):

1. Subject: the smart cut-out's matte when the picture has one, else a local
   person mask (MediaPipe Selfie Segmentation, 296 KB, self-hosted under
   `src/vendor/selfie`), snapped to the photo's edges with a guided filter
   and cleaned (`core/matte.ts`). A mask that misses the face is ignored.
2. Face and 68 landmarks in the browser (@vladmandic/face-api, MIT; Tiny Face
   Detector + 68-point net from the npm package). WebGL or CPU back end; no
   WebAssembly, no eval, so the CSP is unchanged. Found faces are checked for
   size and proportion (`plausibleFace`).
3. Crop: head and shoulders from 28 rows, the face alone from 18, a
   silhouette below. Sized to fill the stand's rows, and as wide as the face
   needs at the seats' real shape: a seat card is about 0.55 as wide as a row
   is tall from across the ground (measured from the seat map's 3D
   positions), while the editor draws 2.9 to 6.3 units per seat against 8 per
   row, so a picture sized in editor units alone is 1.3 to 1.9 times too wide
   on the big grounds. The 3D stills show the faces in proportion.
4. Tone: stretched, smoothed with an edge-preserving filter (fine on the
   face, coarse on hair and clothes), balanced so the face sits on the light
   side, local contrast at the face's scale. CLAHE was tried first; at seat
   scale it turned wrinkles and a shirt's print into blobs.
5. Features from the landmarks: eye sockets or eyes, brows, the shadow under
   the nose, the mouth, the line under the jaw, pushed dark and at least
   three seats by three rows.
6. Bands by the face's own histogram (Otsu), then the seat-scale clean-up:
   every level set opened and closed with a 3 x 3 window, small dark features
   given back three seats thick instead of dropped, the run rule
   (`core/analysis.ts`: three across and three down) enforced on the grid and
   again on the real seats (`core/seatClean.ts`, in the composer), where a
   bowl's uneven rows would otherwise turn a run of three cells into two seats.
7. Colours by lightness, and never the card the picture lands on when the
   palette has two others (`underAt`): a cut-out face no longer melts into a
   field of its own club colour.
8. A styled picture is drawn one cell per seat (`seat` on the layer, measured
   by the composer where the seat map is).

Styles: Stencil, Club duotone (new: the club's colour between ink and
paper), Poster 2 and Poster 3 ("Hope"), Pop art rebuilt as the posterised
subject on a flat field of another bold colour. Halftone is gone: a dot
screen of three-seat dots leaves a face about ten dots tall. A design saved
with it is drawn as a stencil.

In the import bar, picking a style prepares the picture for the stand it is
going to, puts the prepared picture (and its face) in the bar, and shows all
six choices as tiles drawn on the fan's own stand, seat by seat over the
design already there. A line says what the stand can carry ("North stand has
14 rows; a face needs about 18. It will read as a silhouette. A banner shows
it in full."). "Cut out and style" is one tap. On a banner the style is drawn
at full size for print. In a layer's properties the face is found the first
time a style is picked.

**Smart cut-out** (`ui/smartCutout.ts`, `core/matte.ts`, `server/src/cutout.ts`):
the model's matte is cleaned (islands dropped, pinholes filled, real gaps
such as a trophy's handles kept, the edge smoothed then tightened so it never
grows a halo, the old background's colour solved out of the edge pixels),
cropped to the subject, and sized to fill the stand's rows. For tests,
`AI_CUTOUT_LOCAL_URL` sends the same request to `scripts/cutout-local.py`
(rembg); loopback only, ignored in production (and the boot report says so).

**AI pictures** (`core/heroImage.ts`, `server/src/imageAssets.ts`, `core/objects.ts`,
`core/importImage.ts`):
- posterised by brightness rank (`posterizeByRank`): up to four tone levels
  from the picture's own histogram mapped to the palette's cards in order of
  lightness, then the same seat-scale clean-up. aiPanel marks AI pictures
  `tones: 'rank'` (one marked line);
- the flood-fill cut-out follows a shaded or vignetted backdrop step by step;
- Pro: the real cut-out runs on the server right after generation
  (`cutoutForDesign`, one marked block in aiRoutes). It is folded into the
  design's cost (about $0.018), not taken from the member's cut-outs;
- prompts: the subject alone (no brief pasted in), then five constraints,
  60 words at most; the stand's real rows and shape from the stadium context
  the editor already sends (`pictureStyleFor`, one marked line in aiRoutes).

## Follow-up, 2 November

**A face on a banner for small stands** (`ui/faceBanner.ts`,
`render/simulator/tvShot.ts`, `ui/proStyles.ts`). Below 45 rows a face on the
cards is a person, not a likeness (measured on the sheets); the advice line
says so in one line and offers one tap, "Put the face on a banner" (the lead
offer below 18 rows, where the cards give only a silhouette). It draws the
picked style (Painted if none) at print size, makes a banner through the
banner system (`newBanner`, `BannerStore.add`: it saves with the design,
shows in Match Day, is edited in Banners) on a sheet of the stand's own card
colour, and puts the import away: the seats keep the club colours.

The banner is sized for television. `tvShot` is the yardstick: the far
side's gantry, as high as the tallest stand, its lens zoomed so the stand's
whole width fills a 16:9 picture. A face reads at home when it is a fifth of
that picture's height (`FACE_SHARE_MIN`). `bestFaceBanner` tries, on the
ground's own frame: laid over one tier or the stand's whole height, flown
from the roof in front of the stand (as tall as the air there), with the
head and shoulders or the face alone, and, when the design has words (its
longest text layer), a long cloth with the face at one end and the words
beside it. It takes the least cloth that reaches a fifth, else the biggest
face the ground allows.

**Styles that differ in look** (`core/portraitStyles.ts`). The seat picker is
now four looks: Stencil (two tones and a hard dark outline round the subject,
drawn last and three seats thick), Poster 3 ("Hope": three tones, the darkest
also the outline, on a field split down the middle into the two lighter
tones), Duotone (two club colours, the second the colourful card furthest in
lightness from the first, no black and white unless the club has one colour;
soft, no outline, no field; on a banner a smooth ramp, `duotoneRamp`), Pop art
(flat field). Poster 2 was the stencil in other colours: it still draws for
saved designs but is not offered. Painted (five tones and the outline) is
offered on banners only.

**A second face detector** (`ui/portraitVision.ts`). When the tiny detector
finds no plausible face (two passes), face-api's SSD MobileNet v1 (MIT, same
package, 5.6 MB of weights fetched only then) looks again; a detection whose
landmarks are out of a face's order is refused in each pass, so the next one
still runs. The face is looked for once per picture, not per stand. Faces
found: 19 of 20 (p10 and w6 now; beard3, a face behind a magnifying glass,
still none, and it falls back to drawing the whole picture on tone).

**AI pictures** (`server/src/imageAssets.ts`, `core/portraitStyles.ts`). The
prompt constraints now ask for what posterises: "One subject, a bold
silhouette filling the frame. Big simple shapes, strong light-dark
separation, N flat tones, hard edges, no gradients or fine detail. Plain
backdrop, much lighter or darker than the subject", subject first, 60 words
in all. N follows the region's rows, as the browser cuts it: two tones under
16 rows, three under 30, four above (`rankTonesFor`); the smoothing before
the cut is looser on edges (guided filter eps 0.01). A wider smoothing window
was tried and took the eyes with it.

**Smart cut-out on the live site.** The request matched Cloudflare's current
docs (POST `/accounts/{id}/ai/run` with `{"model":"bria/remove-background",
"input":{"image":...}}`; the answer `{"state":"Completed","result":{"image":
URL}}`). What broke it for the fan: the route answered a provider failure
with 502, and Cloudflare in front of the site swaps an origin's 502/504 for
its own "Bad gateway" page, so the editor could not read why. Now a refused
picture is 422 and every other failure 503, with `reason` and `cause`
(tested). The request first asks with the optional moderation flags and
`preserve_alpha`, and on a 5xx asks once more with the image alone; the
admin detail says what came back (status, the HTML page's title, cf-ray).

Suites on 2 November: verify-portrait 1702/0, verify-superai 302/0,
`npm run verify` clean, server test:pro and test:images (45/0) clean,
e2e-pro-styles 58/0 (with a real portrait and the local cut-out stand-in),
e2e-banner 181/0, e2e-layers 98/0, e2e-csp 86/0, e2e-mobile 318/0.

### What Osamh should check

1. The token in `AI_CLOUDFLARE_API_TOKEN` has Account > Workers AI > Read
   and Edit for the account in `AI_CLOUDFLARE_ACCOUNT_ID` (the "Workers AI"
   template gives both). A token for another account answers 401/403.
2. After deploying, cut out one picture as a Pro member. If it fails, open
   /admin > AI failures, mode "cutout", and read the detail:
   - `HTTP 401` / `403 ... (the token or the plan does not allow this model)`:
     the token's permissions or account, as in 1;
   - `HTTP 402` / `429`: out of credit or rate-limited on Workers AI;
   - `HTTP 5xx: <title> (cf-ray ...)`: Cloudflare's side; the cf-ray is what
     their support asks for. "asked again with the image alone" means the
     second, plain request failed too;
   - `result host X is not allowed`: the picture came back from a host not on
     the list; if X is Cloudflare's, add it to `AI_CUTOUT_RESULT_HOSTS`;
   - `the API answered with a redirect`: the account id is wrong;
   - `timeout`: the model took longer than the limit.
3. Other routes still answer 502 and would show the same Cloudflare page:
   `/api/ai/generate` and `/api/stadium/photo` in `aiRoutes.ts`, and the
   sign-up email and `/api/admin/email/test` in `routes.ts`. Not changed here
   (not mine); worth the same 503.

## How it was measured

`scripts/portrait-shots.mts` runs the real pipeline in Chromium (face, mask,
crop, `ensureGrid`, the composer's stamp and seat clean-up) on real seat maps
and draws every seat as a card at its real shape. 20 portraits of people who
are not public figures, five stands: Kingdom Arena south (12 rows), Jewel
north upper (22), Al-Awwal Park north (31), Kingdom Arena west (42), Camp Nou
north (60). Cut-outs from the local IS-Net model (the architecture of Bria's
RMBG 1.4; RMBG 2.0 and BiRefNet need over 5 GB, more than this machine has).

Seats in a run under three (what an empty seat on the day erases), share of
the picture's seats, 20 photos per stand (2 November, the four looks offered):

| rows | Original (free) | Stencil | Poster 3 | Duotone | Pop art |
|---|---|---|---|---|---|
| 12 | 42.8% | 0.6% | 1.3% | 0.6% | 5.9% |
| 22 | 28.5% | 0.3% | 0.4% | 0.4% | 1.6% |
| 31 | 23.2% | 0.2% | 0.5% | 0.3% | 0.7% |
| 42 | 18.5% | 0.2% | 0.4% | 0.1% | 0.5% |
| 60 | 14.9% | 0.2% | 0.5% | 0.2% | 0.4% |

Faces found and judged plausible: 19 of 20 photos (17 before the second
detector). The miss: a face behind a magnifying glass (beard3), drawn on tone
alone as a picture.

AI stand-ins (11: five poster-like renders, three FLUX-like renders with
gradient backdrops, grain and rim light made from the bird and lion photos,
and three raw photos of an eagle, a falcon and a lion): seats in a run under
three, 12 rows: 29 to 80% before, 0% after; 42 rows: 13 to 46% before, 0 to
1.4% after (Pro cut-out 0 to 1.7%).

Face banners from the TV gantry (`face-banners-tv.png`; 4 photos on Kingdom
Arena south, 12 rows; Jewel north upper, 22; Majmaah north, 10; the design's
words "ONE CLUB ONE VOICE"), the face's height as a share of the picture:

| stand | chosen | sheet | face |
|---|---|---|---|
| Kingdom south, 12 rows | flown from the roof (2 photos); long flown cloth with the words (2) | 8 x 13 m; 38 x 13 m | 19 to 23% |
| Jewel north upper, 22 rows | laid over the tier, one block | 18 x 20 m | 20 to 27% |
| Majmaah north, 10 rows | long flown cloth with the words | 35 x 12 m | 16 to 20% |

Kingdom and Majmaah stop near a fifth because the air under the roof rig is
12 to 13 m; nothing taller can be hung there.

Evidence: `portraits-{12,22,31,42,60}-rows.png` (prep, Original and the four
looks for all 20 photos), `face-banners-tv.png` (above), `face-banners-3d.png`
(the previous round, default lens), `ai-pictures-{12,42}-rows.png`, `ui-small-stand.png`,
plus the phase-1 files.

## Scores (output, 1 to 10)

- **Portrait styles: 8.** What a fan sees: on the cards, a person in a look
  of their choosing (outline, split field, two club colours, flat field),
  clean, with nothing an empty seat takes away; below 45 rows not a
  likeness, and the bar says so in one line and offers the banner. On a low
  stand the banner now reads on television: the face about a fifth of the
  gantry's picture (19 to 27% on the stands tried), flown from the roof or
  as a long cloth with the club's words. Not 9: on the cards below 45 rows it
  is still "a person"; Kingdom Arena and Majmaah top out just under or at a
  fifth (the roof rig is 12 to 13 m up); at Majmaah, an open ground, the
  flown cloth hangs from a rig the 3D view does not draw, so it looks
  hoisted from nothing; a white beard (p10) becomes a mask.
- **Smart cut-out: 8 (provisional).** Clean edges with no halo, holes and
  specks fixed, cropped and sized to the stand, one tap with a style. The
  model's own mistakes stay (the stand-in dropped a fur hood). The live
  failure is now readable (503/422 with a reason, never Cloudflare's page)
  and asked again plainly; whether it then works depends on the token, which
  only Osamh can check (above).
- **AI pictures: 7.** No specks anywhere, tones in order whatever the
  generator's colours, two tones on a small stand, never the field's colour,
  real cut-out for Pro, and a prompt that asks for what posterises. A poster
  -like picture (crest, the face, the eagle on teal) reads well. Not 8: a
  busy picture (the raw falcon and lion photos, the lion render) still comes
  out as blocks that say "an animal" rather than "a lion" at 42 rows, and no
  real FLUX output could be tested from here, so whether the new prompt gets
  FLUX to draw bold silhouettes is not shown.

## Not done or not verified

- Bria RMBG 2.0 on Cloudflare and FLUX on Pollinations/Cloudflare are not
  reachable from here: stand-ins only. The live cut-out fix is tested against
  a fake provider (HTML 502 with a cf-ray, healed by the plain retry); the
  token can only be checked on Osamh's side.
- The face banner is not yet offered from the AI panel (a generated face on a
  small stand): `aiPanel.ts` is the AI engineer's.
- The SSD detector is slow in software WebGL (about 20 s per picture in the
  lab; the tiny one about 3 s); on a phone's GPU it should be well under a
  second, not measured here.
- Candidates scored at seat resolution (review phase 3.6) and better
  generators (3.7) are the AI engineer's prompts and spec.
