# Stadium from a photo (Pro allowance "photo"): quality notes, 1 Nov 2026

## Score: 6 of 10 (it was 3), so it is off the Pro list

The photo now gets the stadium's look right in broad strokes: the seats' colour, a box or a bowl, the
tiers, the roof, the track. Every stand is still drawn the same, though. There is no big main stand, no
single-tier Kop and no horseshoe, and the generated roof is a thin dark ring. The photo also only works
after the ground has been found on the map. A fan would recognise the colours and the shape, but not
their ground. That is below Osamh's bar of 8, so `PHOTO_ON_PRO = false` in `server/src/proPlan.ts`:

- Pro holders get the free allowance for photos (2 a week).
- `/pro` and the Pro sheets no longer offer photos as something Pro adds.
- The feature itself stays, free, for everyone.
- Setting the constant to `true` puts it back on sale with the old allowance (3 a day, 10 a month).

**And no fan can reach it today.** The photo button lives in the Stadium panel's Custom tab, under
"Build one from a real ground", and `CUSTOM_STADIUMS = false` in `src/ui/stadiumPanel.ts` hides that
tab. So Pro sells "Stadium from a photo", but nobody can find it, which is why nobody has used it. That
alone means it cannot stay on the Pro list. Turning the tab back on is a separate decision for Osamh.
`scripts/stadium-import-shots.mts` cannot open the panel on today's UI either, so the photo line was
checked on the import block mounted on its own, with the photo read stubbed:
`/home/claude/evidence/photo/panel-photo-line.png`, English and Arabic.

## How it was measured

`scripts/photo-eval.mts` runs the real reader (`server/src/photoRead`: Sonnet 5.5 at low effort, 3
readings) on the test set. The set is 35 openly licensed photos filed under 18 grounds the site models
(`/home/claude/testphotos/grounds`; the photos are never in the repo). The set is realistic, not clean:
- 25 photos show a ground.
- 3 of them are of Wembley, though filed under Etihad and Tottenham.
- 10 show no ground at all: dressing rooms, a pub, a museum display, a radar image, crowd close-ups.

Each answer is checked against the site's own template for that ground. The script then builds the
stadium the way the Stadium panel does: the same `buildStadium`, with the footprint and capacity that
OpenStreetMap would supply. OSM cannot be reached from the build machine, so the footprint is the real
ground's seats, hulled and pushed out 10 m. Finally, `scripts/photo-eval-render.mts` draws each build in
Match Day beside the site's own model.

Below: what the built stadium shows, right against the site's model, on the 25 ground photos.

| field | no photo | before (the panel today) | after |
|---|---|---|---|
| seat colour | 0/25 (charcoal) | 0/25 (read, never used) | **15/25** |
| box or bowl | 3/25 | 3/25 (never asked) | **20/25** |
| tiers | 9/25 | 17/25 | 18/25 |
| roof | 20/25 | 17/25 | 21/25 |
| track | 23/25 | 25/25 | 25/25 |
| floodlights | 2/25 | 21/25 | 20/25 |
| open corners | 19/25 | 19/25 (read, never used) | 20/25 |

When the reader gives a firm answer, it is right this often: tiers 75%, roof 90%, track 100%,
floodlights 100%, corners 84%, shape 75%, seats 83%. Most of its tier "misses" are definitional (San
Mamés' thin middle deck, Anfield's main stand being out of shot).

Before, the photos that show no ground had facts used from them: brick for the pub opposite Villa Park,
2 tiers from a crowd close-up. Now 6 of the 10 are recognised as no ground. Nothing is used from those,
the fan is told why, and the read is not counted. The other 4 (crowd close-ups, a line-up, an outside
wall) gave only harmless or correct facts.

Cost: $0.0188 a read (3 readings), measured; it was $0.0127 before the longer prompt.

Contact sheets (photo, before, after, the site's model):
- `/home/claude/evidence/photo/sheet-corner-*.jpg`
- `/home/claude/evidence/photo/sheet-aerial-*.jpg`

Scores: `/home/claude/evidence/photo/score-{before,final}.md`. Spend ledger: `/home/claude/evidence/photo/spend.md`.

## What changed

- **The reader** (`src/core/photoFacts.ts`). One fixed JSON shape, in which each answer says how sure
  it is. A "low" answer does not vote. The photo says first what it shows ("none" means nothing is
  used). The facade is ignored from inside the ground. A new question asks whether the long sides are
  straight or curved: asking "square or round" got "round" for every modern bowl. The seats are read
  between the fans, not off their shirts. Seat colours vote by how close they look, not by exact hex.
- **The build** (`src/core/stadiumFit.ts`). The photo's seat colour becomes the seats, shaded the way
  the hand-built grounds are; before, every user stadium had charcoal seats. Straight sides draw a box
  at p 8, the median of the site's 48 closed-corner grounds. Open corners draw four separate stands at
  p 14, the median of 18 such grounds. Without a photo of the shape, a ground said to have no track is
  drawn as a box, which 60 of the 66 such grounds are.
- **Template limits**: the exponent may now go up to 16 (it was 4), so the store keeps a box.
- **The panel** (`src/ui/stadiumImport.ts`, plus the lazy `src/ui/stadiumPhoto.ts`). The build carries
  the seat colour, the shape and the corners. Before, the panel dropped corners and colours. The line
  under the button shows the seats as a swatch. Its new strings are `qp.*`, in the lazy chunk.
- **The route** (`server/src/aiRoutes.ts`, 5 lines, marked `pq-photo`): a no-ground photo gives the
  allowance back.

## What it would take to reach 8

1. **Read each stand on its own**: tiers and roof for the main stand, the far side and both ends.
   Build them with `TierSpec.stands`, so the main stand is bigger and a single-tier end stands out.
2. **A roof that looks like one.** Generate light sheet `roofs` runs, not the dark cantilever ring.
3. **Let the photo work without the map.** Build from the photo alone, at a typed capacity, when OSM
   finds nothing.
4. **Re-run this eval.** Item 1 matters most.
