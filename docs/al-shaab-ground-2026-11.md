# Al-Shaab International Stadium (Baghdad) — survey, November 2026

Status: **built, 11 November 2026** as `al-shaab-36k` (survey approved; gradient confirmed white at the front, blue at the top). Not committed. See "As built" at the end.

## Sources

| source | what it gave | trust |
|---|---|---|
| Five photographs from the user (two aerials, the architect's top-down render, two ground shots) | everything visible today: seat colours, vomitories, moat, main stand, screen, flags | ground truth |
| OpenStreetMap, ways 1494484765 (horseshoe), 1494484769 (main stand), 1494484768 (pitch), fetched from overpass-api.de | true plan sizes and compass bearing | good for plan; outlines are hand-traced, ±3 m |
| SketchUp 3D Warehouse model 4a213d6f… ("AMiiR", made 2010, last edited 2014), public GLB downloaded | plan proportions only | **old design**: multicoloured 2010 seats, no main-stand roof detail; agrees with OSM on the plan (pitch 105 m, horseshoe top about 90 m off the centre line), disagrees with the photos on everything else |
| English and Arabic Wikipedia, StadiumDB | capacity, history | figures conflict, see below |

No extra reference photos were downloaded.

## Published figures

- Capacity: **35,700** (English and Arabic Wikipedia infobox) against **34,200** (StadiumDB, the 2010 all-seater figure). Wikipedia says the 2023 renovation added 1,500 seats, and 34,200 + 1,500 = 35,700, so 35,700 is taken as the post-renovation figure. No official Ministry or IFA figure was found.
- 2023 renovation: seats changed to blue and white, 1,500 seats added (Wikipedia). Nothing published on the track, the screen or the contractor.
- Opened 6 November 1966; architects Francisco Keil do Amaral and Carlos Manuel Ramos; original floodlight masts 55 m.
- Main stand is called المقصورة الرئيسية. **No published stand names, section names, gate numbers or fan ends.**

## Measured plan (OSM, metres from the pitch centre)

| part | measure |
|---|---|
| Pitch long axis | bearing 178°, i.e. north–south |
| Main stand | on the **west** side; 135 m long, 17 m deep, front 51 m from the centre line |
| Horseshoe front row | about 96 m (ends) × 65 m (east side) from the centre |
| Horseshoe top | about 116 m × 94 m; depth about 28 m on the side, traced a little shallower at the ends |
| Horseshoe tails | stop level with the main stand's front line, open corners between |
| Mid-row length of the horseshoe | about 400 m |

Engine frame: main stand `south` (−z), horseshoe `north` + both ends; the screen end is `west` (−x), the real south end.

## Counted from the photographs

| item | count | from |
|---|---|---|
| Vomitories in the horseshoe | **13**: one on the centre line opposite the main stand, six each way, evenly spaced (about 31 m apart along the middle row) | render (all 13), photo 2 (13), photo 1 (5 visible, same spacing) |
| Stairs in the horseshoe | one per vomitory, from the vomitory's landing up to the top row; no stairs between vomitories | photo 1, photo 5, render |
| Rows in the horseshoe | **about 42** (three pixel-profile counts on photo 1: 40+ cut by the frame, 43, 44) | photo 1 |
| Vomitory height | mouth across about rows 13–17, landing just below it; roughly a third of the way up | photo 1 crop, photo 5 |
| Seats across a block | about 65–70 between stairs (31 m at 0.45–0.48 m); **not countable** at this resolution | scale only |
| Horseshoe front | seats start about 1.5–2 m above the track, behind a dry moat 4–5 m wide with small footbridges; blue boards on the track side | photo 1, photo 5 |
| Main stand | lower rows down to track level behind a white fence (no moat); a cross-walk at vomitory height; **4 vomitories**, two each side of the central VIP block with its glazed boxes; about 20–24 rows in all | photo 1 (left), photo 2, render |
| Main stand roof | flat cantilever over the whole stand, pale grey top, dark fascia with a row of floodlights along the front edge | photo 1, photo 4 (ground shot) |
| Track | blue, 8 lanes, blue D-areas with white "ALSHA'AB / INTERNATIONAL STADIUM" in both, letters parallel to the goal line with their tops toward the end stand | photo 1, photo 2 |
| Screen | one large screen on legs behind the top of the horseshoe at the real south end, on the main-stand side of the axis | photo 2, photo 5 |
| Floodlights | 4 lattice masts outside the bowl at the corners | photo 3, photo 4, 3D model |
| Flags | a row of about 8 poles on the track bend at the south-west corner | photo 1, photo 5 |
| Dugouts | two blue tunnel-style shelters in front of the main stand | photo 1, photo 2 |

## Seat colours (sampled)

| where | sampled | to build |
|---|---|---|
| Horseshoe blue, ground level (photo 3) | `#3d7ed4` | `#4585d6` |
| Horseshoe blue, hazy aerial (photo 1) | `#6389b6` | — |
| Horseshoe white, in shade | `#c5cbd4` | `#eef1f5` |
| Main stand navy (photo 3 foreground) | `#19346c` | `#1b3870` |
| Main stand lighter front seats (photo 1) | `#85aaca` | `#7fa6d0` |
| Track lanes / D-area | `#3080b2` / `#2283ba` | `#2f80b8` |

Horseshoe gradient as photographed: rows 1–11 white with a few blue seats, rows 12–22 mixed, rows 23–42 blue with a few white — **white at the front, blue at the top**, a scattered mosaic.

## Cross-checks

- Scale: 13 blocks × 31 m = 400 m, matching the OSM mid-row length.
- Capacity: horseshoe 42 rows × about 850 seats (0.47 m) = 35,700, less stairs and vomitories ≈ 34,300; main stand ≈ 4,000; total ≈ **38,000, about 7% over 35,700**. At a 0.50 m seat the total is ≈ 36,000. The seat width and the main stand's rows are the two numbers the photos cannot settle.

## Engine work needed

- Track lettering in the D-areas: `TrackSpec` has no text option; needs a new optional field.
- Moat between track and horseshoe: to be checked against what `runoff` and the tier base offset can draw.
- Blocks about 68 seats wide: needs `WIDE_OK` in `scripts/verify.mts`.

## Open questions

1. Gradient direction (photos contradict the brief).
2. Main stand colours: solid navy, or navy with lighter front rows as photographed.
3. Gate numbers and names.
4. Capacity to show.
5. Missing photographs: main stand straight on from the pitch; one horseshoe block close up; the outside with a gate.

## As built

| item | value |
|---|---|
| id / fingerprint | `al-shaab-36k`, `35284:ab5e983481903499` (never pushed, may still be re-taken) |
| seats | 35,284: main stand 4,504, horseshoe 30,780 (published 35,700, 1.2% under) |
| plan | `a` 96, `b` 65, exponent 2.3; horseshoe front row on the plan curve |
| horseshoe | 42 rows on the side, **33 round the ends** (a later count on photo 2 gave 33 at the end; the map's outline is 20-24 m deep there against 28 m on the side). Row depth 0.67 m, rake 21 degrees, first row 2.0 m up, seat pitch 0.45 m |
| vomitories | stations 0, 28 ... 168 m each way along the front row; landing 5.2 m, mouth 2.8 m, rows 13-17; one stair each, full height |
| main stand | tier 0 (listed first so the engine does not build a concourse over the horseshoe); 21 rows, cross-walk on row 9, vomitories at 20.5 and 43.5 m each way, boxes over the middle 18 m |
| screen | 20 x 10 m on legs at (-114, -50) |
| masts | lattice, 52 m, at (104, 80), (-104, 80), (86, -66), (-86, -66) |

Engine additions, all optional: `TrackSpec.lines` (lane-line colour), `TrackSpec.lettering` (words in both D-areas), `runoff.moat` (a dark ring outside the apron).

Checks run: `tsc`, `npm run verify`, `npm run verify:stadiumfit` (rates now 67/89 lighting, 48/89 tiers), `vite build`, renders from the five photo angles (`preview-out/al-shaab/compare.jpg`). **Not run:** the e2e suites (`e2e-world.mjs` has the new row, `e2e-projects.mjs` the count of 89).

Still open:
- The rows step from 42 to 33 at the corner diagonals; the real stand tapers gradually. The engine has no tapering tier.
- Seat width (0.45 m) is solved from the capacity, not counted.
- Flag poles on the south-west bend are not drawn (no flag-pole feature).
- Gate numbers, stand names and fan ends: none published; blocks keep the default labels.
- Main stand rows, the VIP block and the cross-walk are from two oblique aerials only.

## Round 2 (11 November 2026): the rim, the tails and the main stand

After the first review ("the seats are cut off at the tails but the structure is not; the cut-off is harder and bigger than the real one"):

| item | now |
|---|---|
| fingerprint / seats | `35454:f83cb063f08dd09e`, 35,454 seats (main stand 4,064, horseshoe 31,390; 0.7% under 35,700) |
| horseshoe depth | one ring tier with its own back edge (`TierSpec.rim`, new and optional): 42 rows along the side tapering smoothly to 33 behind the goals; the deck, back wall and end walls stop on the same curve as the seats. This replaces the 42/33 step at the corners |
| tails | cut square on z = -43, parallel to the main stand, concrete and seats together (`omit` on the whole south sector and on both ends below that line) |
| plan | `a` 93, `b` 66, exponent 2.6, fitted to the 13 vomitory positions in the top-down photograph with the drone taken as about 100 m up (average miss 4 m, the noise of reading the photo; the first layout missed by 10 m) |
| vomitories | 25.2 m apart along the front row, mouths on rows 15-19; the tail block beyond the last one is about a full block |
| moat | 3.6 m, 4 m inside the front row |
| main stand | cross-walk on row 13 with the four vomitories behind it at 25 and 50 m; sky-blue rows in front, navy behind; the VIP block is the middle 30 m in two steps; the roof covers only the rows behind the cross-walk |

Supersedes the plan, vomitory, main-stand and fingerprint lines of "As built" above, and the first "still open" item (the step). Checks re-run: `tsc`, `npm run verify`, `npm run verify:stadiumfit`, `vite build`. Comparison sheets: `preview-out/al-shaab/compare.jpg` and `compare-top.jpg`. The e2e suites are still not run, at the user's request, until the look is approved.

## Round 3 (11 November 2026): vomitory boxes, flags, shelters, VIP glazing

| item | now |
|---|---|
| fingerprint / seats | `34366:4c143c7ad61bf187`, 34,366 seats (3.7% under 35,700; the wider landings took about 1,100) |
| vomitories | a 3 m dark mouth in a bare white landing 7 m wide, two more bare rows in front (`areas`), one stairway 1.7 m wide from the front wall to the rim |
| flag poles | eight, 9 m, round the south-west bend 1.6 m outside the last lane (`details.flagpoles`, new and optional) |
| dugouts | three blue barrel shelters on the outer lanes in front of the main stand (`pitchside.shelters`, new and optional); no tunnel box |
| VIP block | both steps glazed to the pitch |

Still approximate: the VIP block's real shape (needs a straight-on photograph of the main stand), the seat width, gate numbers and stand names.

## Round 4 (11 November 2026): the horseshoe is a crescent

Second review: "it gets gradually smaller section by section until it becomes so small". Enlarged, the top-down photograph and both aerials show the tails narrowing to a tip only a few rows deep; the earlier reading (33 rows held to a square-cut tail) was wrong.

| item | now |
|---|---|
| fingerprint / seats | `32868:05b063cea5369586`, 32,868 seats (7.9% under 35,700) |
| rim | superellipse `a` 117, `b` 81.6, exponent 2.2, centred 12.5 m toward the far side (`TierSpec.rim.z`, new and optional) |
| depth, measured on the top-down photo / built | centre 28.1 / 28.1 m; 25 m round 28.0 / 27.5; 50 m round 27.5 / 26.3; 101 m round 24.5 / 25.8; 126 m round 24.0 / 23.9; last vomitory 18.3 / 17.0; tail tip 4.5 / 6.7 |
| rows | 42 at the centre, about 38 behind the goals, 34 at the fifth vomitory, 30 then 22 across the last one, 9 at the tip |

The capacity is now more than 5% under the published figure. Suspects, in order: the seat width (0.45 m is assumed), the 7 m landings, the main stand's row count. Nothing was padded to close the gap.

## Round 5 (12 November 2026): longer, thinner tails; Iraq's flag

Third review: "the tail even goes smaller than this and longer at the end", and the flags read as Yemen's (red, white, black with nothing on the white).

| item | now |
|---|---|
| fingerprint / seats | `33722:221bb2a5cb04b91b`, 33,722 seats (5.5% under 35,700) |
| rim | `a` 116, `b` 79.1, exponent 2.4, centred 15 m toward the far side |
| tails | end on z = -47 (was -43), about 9 m from the main stand's corner, as the aerial from the screen end shows; the top-down photo hides the tips under trees |
| depth, target / built | centre 28.1 / 28.1; 25 m round 28.0 / 28.0; 50 m 27.5 / 28.0; 101 m 24.5 / 26.8; 126 m 24.0 / 22.8; last vomitory 18.3 / 16.2; z = -43 5.5 / 5.1; tip 2.5 / 3.4 m |
| flags | each cloth is painted: three bands and, on Iraq's, the green takbir across the white (`FlagDesign.text`); every fourth pole flies plain white |
