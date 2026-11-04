# Pro quality: Pro fonts and LED board text (1 Nov 2026)

Two Pro perks, rated on 31 Oct by their output: Pro fonts 6/10 (sharp on
banners, much like the free fonts on seats, Classic broke up), LED board text
7/10 (crisp, both languages, but static and only on the touchline ring).

## Pro fonts

### What changed

- **Seat-aware lettering** (`src/core/seatText.ts`, used by `core/objects`
  `ensureGrid` for every Pro voice on seats). The words are drawn on a fine
  grid, 4 pixels a seat across and 6 a row up, so that the minimum stroke (3
  seats across, 2 rows up) is 12 pixels both ways. An opening (a disc that
  wide rolled through the ink) separates the thick strokes from the thin ones;
  every thin stroke is drawn again along its spine at the minimum width (at
  most 0.75 row wider a side), and the thick strokes, corners included, are
  left exactly as the face drew them. Then every opening the face had at seat
  scale (a counter, the gap between two letters, the space under a dot) is
  kept open: a run of seats that was clear, with letter at both ends, keeps
  at least 2 seats across or 1 row up (`keepOpenings`).
- **Measured floors** per voice and script (`SEAT_FLOORS`): the letter height
  from which it reads as drawn, and from which it reads seat-aware.
- **The seat preview** (`src/ui/seatPreview.ts`), under the Text tool and under
  a text layer's words, for Pro accounts: the words as they are (or will be) on
  this ground's own seat map, card by card, over the design's colours; the
  verdict (reads / reads, thickened / too small / stand too shallow / banners
  only) with the fix one tap away ("Make it 15 rows", "Use Pixel"); and every
  Pro face drawn small on the same spot, a tap to pick one, marked when it will
  not read there.
- **Classic: kept off seats (banners only)**, with Ruqaa. Seat-aware strokes
  rescue its Latin (it reads from about 11 rows), but its Arabic swashes still
  split into islands on every stand (`evidence/fonts/specimen-classic.jpg`, the
  62-row stand at 44 rows). A voice has to read in both scripts. The Text tool
  offers banners-only voices only in the Banner view (a group of their own);
  leaving the Banner view with one chosen switches the Text tool to the seat
  voice nearest it in spirit (Classic → Heritage, Ruqaa → Marker) and says so.
  A text layer's picker never offers them. Old layers set in Classic still
  draw (fonts are assets, not the gate), now seat-aware.
- **Four new faces**, all SIL OFL 1.1 from @fontsource, credited in
  docs/DESIGN.md: **Pixel** (Handjet 900: letters built from blocks, reads
  smallest of all: Arabic from 12 rows, Latin from 8), **Gothic** (Blaka:
  blackletter and its Arabic twin, the ultras banner look), **Heritage** (El
  Messiri 700: elegant Arabic and classical capitals; Latin from 12 rows
  seat-aware, 20 as drawn), **Ruqaa** (Aref Ruqaa 700, banners only: the
  hand-painted street banner). 19 candidates were measured; dropped: Badeen
  Display (draws as solid blocks in a canvas), Oi (counters close: Latin
  unreadable on seats), Jomhuria (reads, but on seats it looks like the free
  Condensed), Katibeh, Vibes, Qahiri, Ruwudu, Mirza (hairlines), Rubik, Mada,
  Zain, Alexandria, Baloo Bhaijaan 2, Reem Kufi Fun, Playpen Sans Arabic (too
  close to a free or existing Pro voice).

### How it was measured

`scripts/pro-font-seats.mts` (with `scripts/pro-font-seats.html`) draws three
words a script (الزعيم, نادي القرن, زعيم آسيا; CHAMPIONS, FORZA, ULTRAS) at
letter heights from 6 to 44 rows, as the Text tool sizes a layer, and compares
the seats with the face at 128 px piece by piece: a dot or mark lost, a letter
broken in two, pieces welded together, counters open, and the share of seats
in strokes thinner than the minimum (3 across, 2 up). A voice "reads" from the
smallest height that passes with the next two above it: as drawn, and drawn
seat-aware. Specimen sheets put each face on four real stands (Prince Abdullah
Al-Faisal upper west, 12 rows; Prince Mohammed bin Fahd north, 22; Buraidah
north, 34; Anfield upper west, 62), the smallest also with 1 card in 10 not
held up. The numbers and the eye disagreed twice (Gothic's Arabic welds its
dots at every size, so the numbers never pass; Classic and Ruqaa pass the
numbers lower than they read): there the floors are the eye's.

Seats in thin strokes, as drawn → seat-aware, at 10 / 14 / 20 rows: Heritage
Arabic 24→10% · 17→7% · 2→3%; Heritage Latin 24→9% · 13→3% · 7→1%; Ruqaa
Arabic 66→15% · 34→11% · 16→8%; Block Arabic 7→8% · 4→4% · 1→2% (a heavy face
is left alone). The full table is `evidence/fonts/floors-table.md`.

### Score: 8/10

On seats each Pro voice now either reads, reads because it was thickened, or
says it will not and how to fix it, before the fan places a word; four of the
seven seat faces (Pixel, Gothic, Heritage, Stencil) look nothing like the free
voices on a stand of 20 rows or more. What keeps it from 9: Arabic under about
15 rows is still blocky in every face (physics: a seat is the pixel), the
heavy faces (Block, Rounded, Marker) still look alike on seats below 20 rows,
and the seat preview is a panel under the tool bar, not inside the native font
list.

## LED board text

### What changed

- **Pages and a show clock** (`src/render/simulator/ledBoards.ts`): the words
  are drawn once into an atlas of pages; each touchline face shows a page
  through its own texture, so scrolling (the texture's offset), sequencing (its
  page) and flashing (the material's brightness) are uniforms, never redraws.
  The boards move only on frames Match Day draws anyway (the reveal, the camera
  gliding, a show, a recording); when everything else stops they finish the
  change they are in (under a second) and rest, with the messages side by side
  round the ring as before.
- **The reveal**: three flashes as the cards go up, the messages taking turns
  faster; the countdown style counts 3, 2, 1 on every board as the reveal
  starts, then the first message.
- **Templates** (`src/render/simulator/ledPanel.ts`, in the LED section):
  your messages; sponsor board (the club kit's crest beside each message);
  chant ticker; score ("HILAL [2–0] NASSR", then the messages); countdown.
- **The club kit's crest** from `loadKits()` (ui/clubKitStore), read when the
  section is first shown; with no kit the list says where to make one.
- **The big screens**: "♛ Your LED boards" on the Screens list shows the page
  the boards show (crest and words laid out for a screen, the score, the
  digits), repainted when the page changes; a free export shows the ground's
  name there, as the boards go plain.

### How it was checked

- Node: the show clock at 60 frames a second (still, moving, after moving,
  reveal flashes, countdown beats 0.8 s apart, chant ticker, score pages).
- Browser (`e2e-pro-matchday.mjs`): templates, the crest list, a still Match Day
  with words on the boards draws nothing for 4 s, the reveal moves the boards,
  Match Day stops drawing again after it, the score and countdown pages, the
  big screens' option.
- Frames: `scripts/led-shots.mjs` on three grounds with big screens, English
  and Arabic, before / during / after the reveal and the big screen
  (`evidence/fonts/led/`).
- Performance: `e2e-matchday-perf.mjs` 35/35: no frames in five still
  seconds; draw calls 76 / 97 / 98 at Al-Hazem, Kingdom Arena and the Jewel
  (budgets 85 / 110 / 110). The boards add no draw call: four faces were
  four meshes before, and still are.

### Score: 8/10

The boards now come alive with the reveal (they count it in, flash as the
cards go up, take turns) and rest when Match Day rests; sponsor boards carry
the fan's own crest, the big screens repeat the boards, and the score and
chant styles read like the real thing, in both languages. Short of 9: the
crest is small on a 0.8 m board, the transitions are a slide and a cut rather
than a real LED wipe, and the crest only comes from a kit kept in this
browser (the account's kits are another engineer's work, behind the same
`loadKits()`).

## Files

New: `src/core/seatText.ts`, `src/ui/seatPreview.ts` + `.css`,
`src/render/simulator/ledBoards.ts`, `ledPanel.ts` + `.css`,
`scripts/pro-font-seats.mts` + `.html`, `scripts/led-shots.mjs`, this note.
Changed: `src/core/proVoices.ts`, `proFontFaces.ts`, `objects.ts`,
`src/ui/proFonts.ts` + `.css`, `bannerView.ts` (the sign's picker keeps both
Pro groups last), `src/render/simulator/pitchside.ts`, `screenPicture.ts`,
shared: `overlay.ts` (3 lines), `index.ts` (about 25 lines), `strings.ts`
(one `qf.` block), `package.json` (four @fontsource packages),
`docs/DESIGN.md` (credits), `e2e-pro-fonts.mjs`, `e2e-pro-matchday.mjs`.
