# Tifo Maker marketing videos (Remotion)

Separate from the site: its own `package.json`, nothing here is built or
deployed with tifomaker.org.

    npm install
    npm run studio                                  # preview and edit
    npx remotion render src/index.ts ProTeaser out/pro-teaser.mp4

## ProTeaser ("وش يضيف برو؟", 4:5, 30 s)

For the Pro announcement tweet. Every picture in the window is the product's
own output; `src/ProTeaser.tsx` adds the frame, captions and cuts.

The tifos are showcase designs drawn for these videos (`harness/tifos.js`),
laid on a stand's seats and rendered by the site's own Match Day, film and
poster code (`harness/run.mts`, which swaps the tifo painter in the repo's shot
harnesses). From the repo root:

| File in `public/` | What it is | Made by |
|---|---|---|
| `film.mp4` | The Full HD Match Day film: "الزعيم" at Kingdom Arena | `npx tsx marketing/video-src/harness/run.mts film hilal kingdom-arena-26k 0 large out.mp4` (about 30 min) |
| `poster-*.jpg` | The 4K posters: "العالمي" at Al-Awwal Park | `CLUB='{...}' npx tsx marketing/video-src/harness/run.mts poster nassr alawwal-park-26k-rb 0 outdir` |
| `font-stencil.jpg`, `font-block.jpg` | Film stills of the two tifos: the stencil and block Pro faces on seats | `... run.mts preview <design> <ground> 0 large out.jpg 330` |
| `led-*.jpg` | The LED boards in Match Day, with the boards panel | `npm run build && GROUNDS=jewel-jeddah-60k-rb LANGS=ar node scripts/led-shots.mjs <out>` |
| `credit-free.jpg`, `credit-pro.jpg` | A film frame with the site's mark (`drawWatermark`) and with the credit line (`drawCreditLine`) | the two functions run on a film frame |
| `track.m4a` | The music | `python3 music/make_track.py track.wav`, then ffmpeg to AAC |

To use a real fan's tifo, replace the files in `public/` with exports from
the site under the same names and render again.

Sound: an original synthesised track (120 BPM; the cuts sit on its beats).
No voice (X). To use another track, replace `public/track.m4a`; a 120 BPM
track keeps the cuts on the beat.
