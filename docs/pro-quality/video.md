# Pro quality: the stadium video and the 4K poster (engineer "video", branch pq-video)

Two Pro perks were rated 3/10 on 31 Oct: the Full HD / vertical video and the
4K poster picture. Both were drawn from the editor's plain 3D model on its
grey plate (Preview3D): an orbit, and a 4K screenshot. This branch makes both
out of Match Day.

## What changed

### The video is Match Day's film of the tifo
- **The shot** (`src/render/simulator/filmPlan.ts`, pure): 13 seconds.
  - 0–3 s, establishing: the floodlit ground in its neighbourhood, from the
    air behind the stand across from the tifo, drifting (an indoor hall: from
    high in a corner under the roof);
  - a cut to the "Your tifo" stage camera, brought forward off the stand it
    stands on, and a push-in (dolly and zoom, easing out) on the tifo's stand;
  - 5.6–8.2 s, the reveal in the design's own order (the editor's reveal
    from the Animation panel; Match Day's own from its panel), stretched over
    the tifo's own seats; the seats round it keep their colours;
  - the hold: in landscape the tifo fills about four fifths of the frame's
    width, the camera still drifting; a calm end, a fade to black over the
    last 0.7 s.
  - **Kingdom Arena's north stand** has a gap between its tiers where the
    hospitality boxes are: the seat map has no rows there (a jump of a
    quarter of the stand's height), so a design running across it loses that
    band. Rays from every camera height and distance tried (6–40 m up,
    35–65 m out) find nothing hiding the cards: it is not the camera, and no
    camera can show seats that are not there. `simulator/tifoSplit.ts`
    measures it from the seat map and the design, and the editor's export
    (under the size) and Match Day's Video choice say so before filming
    (`qv.split`). Verify checks it fires for Kingdom's north stand and not
    for Jewel's end or the Kop.
  - **Vertical is shot for the height** (`TALL` in filmPlan.ts), the way
    tifo clips are filmed for phones: the camera comes to three fifths of the
    landscape hold's distance (never nearer than 0.45 × the tifo's width, or a
    wide tifo wraps round the lens), 10° above the tifo's middle (over a low
    ground, its top row under 26 m, up to 24°: from higher, a low stand's long
    rake stands up in the picture, and over its back are the streets, not
    sky). The lens is set so the tifo's height fills about half the frame;
    the tifo then runs wider than the picture, and the camera pans across it
    from the end the cards start from (4.6 s) to the middle (9.2 s), the
    push-in going on under it. Across is measured where the cards land in the
    picture, in metres at the tifo's middle, so a curved stand's ends (nearer,
    so wider) are counted as they look. At least 28% of the tifo's width is
    always in view. The pan ends in the middle at 9.2 s; then the calm end
    pulls back (9.4–11.6 s) until every card is in the picture: back along
    the way the push came in, as far as it takes for the whole tifo to fit a
    lens of 62° across, and held there through the fade. A long tifo ends
    up small (Abha's 100 m one is a band across a tall frame), but whole.
  - The hold is framed on where the tifo's cards really land in the picture
    (a curved stand's ends come towards the camera), looks down on it by at
    least 14° (a low stand seen level is a thin band), and comes down until a
    roof's front edge no longer hides the top rows (rays against the
    ground's structure).
  - The floodlight beams' haze thins to a third on the stage shot: seen down
    a beam it was a pale wedge over the cards.
- **Drawn frame by frame** (`src/render/simulator/film.ts`,
  `MatchDaySimulator.filmHost()`): the live loop stops, the renderer draws at
  exactly 1920 × 1080 or 1080 × 1920 whatever the window, and each frame
  moves the scene on by 1/30 s, not by the wall clock. WebCodecs'
  VideoEncoder (H.264 High, then Main, then Baseline, level 4.0, 7 Mbps at
  Full HD) and mp4-muxer make the MP4. No WebCodecs or no H.264: the same
  shot is filmed in real time through MediaRecorder, and the card and the
  status line say it may stutter.
- **Sound** (`src/render/simulator/filmSound.ts`): Match Day's own crowd and
  drum (atmosphere.ts, a Web Audio graph) built into an OfflineAudioContext
  and rendered to the film's clock: the crowd's bed and a chant from the
  start, the drum call's three tabl hits on the beat before the cards (the
  last the loud one) and the stand's "Oooh" as they go up, the roar when the
  reveal is done, applause and the chant again; the film's own mix (master
  up, crowd forward, the tabl over it), raised to −1 dBFS at its loudest,
  faded in and out with the picture. 13 s renders in 0.7 s and encodes in
  0.3 s. AudioEncoder makes AAC-LC (`mp4a.40.2`) where the browser has it
  (Chrome and Edge on Windows and macOS, Safari), Opus where not (Chromium
  without the proprietary codecs); mp4-muxer puts it beside the H.264. No
  AudioEncoder (or neither codec): the film is silent, and the card and the
  status line say so. The real-time fallback is silent too, and says so.
- **Time left:** the card counts frames and, from the fourth frame, says
  about how long is left (frames still to come × the smoothed time a frame
  takes here: "about 25 seconds left", "about 2 minutes left").
- **Where:** the editor's export (`src/ui/proExport.ts` → `src/ui/proFilm.ts`)
  builds Match Day off screen from the editor's design (dusk, floodlights,
  a full house) and pauses the editor's own 3D view meanwhile; Match Day's
  Record makes it from the live Match Day as the fan has set it up. A card
  shows the frames counting, a bar and Cancel. The Preview of a Pro size
  plays the same film at half size. Free is unchanged (the screen's size,
  with the mark); one question per export (proGate).
- **Match Day's Recording** gets a crowned "Video" choice for an account Pro
  is on for: the film (landscape or vertical) or the recording of the view as
  before; the recording's own fields hide while a film is picked.

### The poster is a designed match-day poster
- **The sheet** (`src/ui/proPoster.ts`): a live preview beside the fields;
  three layouts (match day, chant, minimal), landscape 3840 × 2160 or
  portrait 2160 × 3840; club, opponent, date, kick-off, ground, chant;
  colours and lettering from the club kit (`loadKits()`), else the design's
  palette and its own lettering, or a Pro voice. The fields are remembered in
  the browser.
- **The picture:** Match Day's hold on the stage camera at full size
  (`filmStill`), with the tifo as the hero (`posterHold` in film.ts),
  framed on where its cards land in the picture, as the film's hold is.
  Landscape: up to 62% of the width and 90% of the height, on the side the
  type does not start from (right for English, left for Arabic, so a still is
  drawn each way); a wide tifo is held by the width, a tall one by the
  height. Portrait: up to 92% of the width and 46% of the height, between
  the header and the names. The ground's big screens are left out of the
  still (a name board on the back of the stand sat on the tifo): their
  boards are kept out of the static merge so they can be hidden, at the
  cost of a few draw calls (`venue.ts`).
- **The type** (`src/ui/posterLayout.ts`): in landscape a column on the
  reading side, 35% of the width (`TYPE_COLUMN`), over a wash in from that
  edge; in portrait above and below the tifo. The conventions of a club's
  match-day graphic (crest and MATCHDAY at the top, the club huge, VS and
  the opponent, the date, kick-off and ground on a band of the club's
  colour); every line fitted to its room and stacked on its ink; each field
  set in its own direction, Arabic shaped and right to left; the poster's
  own words in the site's language.
- **Export:** a PNG with no mark. "Export without Pro items" is today's free
  picture (the screen's size, with the mark).
- **Credit line hook:** `makeFilm`, `FilmJob` and `PosterSpec` take
  `creditLine?: string` and draw it small (`drawCreditLine` in film.ts, to be
  swapped for `src/ui/creditLine.ts` at the merge).

## How it was measured
- `scripts/pro-film-shots.mts frames`: the real simulator and film code, 4
  frames (establishing, push-in, reveal, hold; vertical also the calm end
  at 12.1 s) for 5 grounds (kingdom,
  jewel, abha, anfield, bernabeu) × a small, a medium and a large tifo ×
  landscape and vertical → `/home/claude/evidence/video/*.jpg`, with contact
  sheets `sheet-*.jpg`; `holds-vertical.jpg` is the vertical push-in, the
  pan's end (9.2 s) and the whole tifo (11.9 s) for all 15 (columns: Kingdom, Jewel, Abha, Anfield, Bernabéu,
  each small, medium, large). The test tifo sits on one real stand (behind a goal
  or along a side), never round a corner.
- `scripts/pro-film-shots.mts encode`: whole 390-frame films, checked with
  ffprobe and ffmpeg (codec, size, rate, frame count, every frame decoded and
  none repeated, timestamps evenly spaced) → `film-*.mp4` and a sheet each.
- `scripts/pro-film-shots.mts sound`: the soundtrack alone
  (`film-sound.mp4`, `film-sound-wave.png`) and a whole film with its sound
  at 360 × 640 (`film-av-check-360x640.mp4`), both checked with ffprobe.
  `bench`: the encoder's share of a frame without the GPU (a changing 2D
  picture at the film's size through the film's own path, 120 frames).
- `scripts/pro-poster-shots.mts`: 5 grounds × 3 layouts × English and
  Arabic × both shapes at full size → `/home/claude/evidence/video/posters/`
  (a third of the size, JPEG), the full PNGs' sizes in the log.
- Browser suites: `e2e-pro-video.mjs` and `e2e-pro-poster.mjs` (new),
  `e2e-pro-export.mjs` and `e2e-pro-matchday.mjs` (extended).

## Results
- Whole films (`film-abha-medium-landscape.mp4`, `film-abha-medium-vertical.mp4`):
  H.264 High, 1920 × 1080 and 1080 × 1920, 30/1, 13.000 s, 390 frames
  decoded, 0 repeated, 0 unevenly spaced; 11 MB landscape. Under swiftshader
  a whole film takes 41–46 minutes to make; on a real GPU a frame is tens of
  milliseconds.
- Sound: Opus here (Playwright's Chromium has no AAC encoder), 48 kHz
  stereo, 13.02 s (Opus's 20 ms of priming); its loudest moment at −0.9 dBFS
  (the last tabl hit), the crowd between −11 and −7 dBFS once it is in, a
  hush of about −18 dBFS just before the drum call. The whole film:
  H.264 13.000 s, 390 frames, and Opus 13.02 s in one MP4.
- Time: the encoder's share here, with no GPU and a software H.264 encoder
  on a two-core box, is 33 ms a frame at 1920 × 1080 and at 1080 × 1920;
  the sound 0.7 s to render and 0.2 s to encode. Under swiftshader the
  picture itself is 6–12 s a frame. **On an ordinary laptop** (an Intel Iris
  Xe or Apple M1 class GPU), an estimate, as there is no GPU here to time
  it: Match Day should draw a 1080p frame in about 15–30 ms (its scenes stay
  within the perf suite's draw-call budgets), the
  copy to the encoder's canvas is a few ms, and the hardware H.264 encoder
  Chrome and Safari use there takes 3–8 ms: about 25–45 ms a frame, so
  **10–20 s for the 390 frames**, plus 3–8 s to build Match Day off screen
  from the editor, and a second for the sound: **about 15–30 s a film**
  (30–45 s where the encoder is software, as on most Linux machines; a
  minute or two on a mid-range phone). The card works its estimate out on
  the machine itself, from the fourth frame on, so a slow machine is told so.
- Posters: 3840 × 2160 and 2160 × 3840 PNGs, 2.4–6.2 MB each, 60 of them,
  each landscape still drawn twice (the tifo right for English, left for
  Arabic), 24–43 s a still under swiftshader.
- Suites: e2e-pro-video 48/48 (a stereo sound track as long as the
  picture and audible, the time left on the card, the silent film and its
  note when there is no AudioEncoder), e2e-pro-poster 28/28, e2e-pro-export
  56/56, e2e-pro-matchday 46/46, e2e-matchday-perf 35/35 (the big screens'
  boards kept out of the merge: Kingdom Arena 102 draw calls of 110, Jewel
  96 of 110); build and verify pass, verify now also checking the tier-gap
  note fires for Kingdom's north stand and not for Jewel's end or the Kop.
  Run before this round and not touched by it except atmosphere.ts's
  offline option and venue.ts's screens: e2e-stage-camera 66/66,
  e2e-flyover 20/20, e2e-matchday-view 40/40, e2e-matchday-reveal 65/65.

## Scores (of the output, judged from the frames and posters above)
Scored as a fan would see the output, not by what the code does.

- **Full HD and vertical 9:16 video: 8/10 landscape, 8/10 vertical, with
  sound; 7/10 for a tifo across Kingdom Arena's tier gap.** It is Match Day
  footage: the floodlit ground in its streets, a real push-in, the cards
  going up in the design's order, a hold where the tifo fills the frame and
  reads, a calm end; smooth by construction (every frame drawn, none dropped
  or repeated, checked with ffprobe). Vertical is shot for the height (the
  stand and the tifo fill the frame top to bottom, a pan across the tifo to
  its middle), and now always ends on the whole tifo: every word of it in
  the picture by 11.6 s, held through the fade (`holds-vertical.jpg`, bottom
  row, all 15). A long tifo is small there (Abha's 100 m one), but whole.
  The crowd and the tabl are on the soundtrack. What keeps it from 9:
  Match Day's own look (a low-poly crowd, flat roofs, the floodlight haze),
  a synthesised crowd, and the ground's own architecture, shown as it is:
  Jewel's tier fronts cross a tall tifo, and at Kingdom Arena a design
  across the north stand's box gap loses that band (no seats there), which
  the UI now says before filming.
- **4K poster: 8/10 (7 at Kingdom Arena).** The tifo is now the hero:
  45–62% of a landscape poster's width and up to 90% of its height, beside a
  column of type over a wash (Jewel's tall tifo fills the height at about
  half the width; Abha's, Kingdom's and the Bernabéu's run about 60% of
  it), and 60–92% of a portrait poster's width between the header and the
  names. No big screen sits on it (Jewel's name board is gone). English and
  Arabic set properly, the kit's colours, crest and lettering. What keeps it
  from 9: the picture is the simulator's (stylised), the layouts are fixed
  templates, and a portrait poster of a wide, low tifo has a lot of pitch
  under it. Kingdom: the tifo is whole and large, but split by the box gap
  (the sheet says so).
