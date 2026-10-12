import type { RealBlocksLayout } from './realBlocks';
import type { SeatOpening, StandSide } from './types';
import { atStairs, endCornerStation, radialStation, rebuilt, ringStairs } from './realBlocks';
import { cornerStation, rhythm } from './blocks';

/**
 * The Saudi grounds in their real blocks (October 2026). Each is measured from
 * photographs of the ground — see the comment on each — and replaces the even
 * layout it was built with; the old one stays for the designs saved on it.
 *
 * How they were measured: a photograph's camera is solved from the pitch
 * markings (corners, the halfway line, the penalty areas, the centre circle —
 * all of fixed size), then each stand is unrolled from the photograph onto
 * its own rows, square on, so its stairways can be read off in metres along
 * the front row. Where a stand is only seen from the pitch, without markings,
 * its stairs are counted and their rhythm checked against a stand that was
 * measured.
 */
export const SAUDI_REAL_BLOCKS: Record<string, RealBlocksLayout> = {
  // The Jewel of Jeddah (King Abdullah Sports City). Measured from the
  // StadiumDB photographs (Ministry of Sport): the corner view over the pitch
  // (no. 20, camera solved from the markings to 2.7 px) for the lower tier of
  // a long side and an end, and the pitch-level view of the main stand (no.
  // 21) for how the tiers sit on one another.
  //
  // - Lower tier: a stairway every 12.65 m, a block (22 seats) on each centre
  //   line, all the way round, and more stairs fanning out round the corners
  //   so no block is more than 15 m across at the back; no vomitories — it
  //   empties at the back, onto the concourse under the boxes.
  // - Middle tier: its stairs in line with the lower tier's (the profile of
  //   the photograph shows no stagger), and a vomitory at the foot of every
  //   stair (the white portals along the front of the tier).
  // - Upper tier: in line again, with a vomitory a few rows up each stair.
  'jewel-jeddah-60k': {
    id: 'jewel-jeddah-60k-rb',
    build: (old) =>
      rebuilt(old, 'jewel-jeddah-60k-rb', (t) => {
        const [lo, mid0, up0] = t.tiers;
        // One more row in each of the upper two tiers: their stairs and
        // vomitories take more seats than the even aisles did, and the
        // published tier totals (22,244 and 14,038) are what they hold.
        const mid = { ...mid0, rows: mid0.rows + 1 };
        const up = { ...up0, rows: up0.rows + 1 };
        const midStairs = ringStairs(t, mid, { step: 12.65, centred: true });
        const upStairs = ringStairs(t, up, { step: 12.65, centred: true });
        return {
          tiers: [
            { ...lo, blocks: { width: 1.1, aisles: ringStairs(t, lo, { step: 12.65, centred: true }) } },
            {
              ...mid,
              blocks: {
                width: 1.1,
                aisles: midStairs,
                openings: atStairs(midStairs, { width: 2.6, rows: [0, 1], kind: 'vomitory' }),
              },
            },
            { ...up, blocks: { width: 1.1, aisles: upStairs, openings: atStairs(upStairs, { width: 2.6, rows: [2, 5], kind: 'vomitory' }) } },
          ],
        };
      }),
  },

  // Al-Awwal Park. Measured from two photographs on Wikimedia Commons: the
  // panorama from the main stand at halfway ("Inside King Saud University
  // Stadium", camera solved from the markings to 3 px in 3,840) for the stand
  // opposite, the corners and the near halves of both ends; and the view from
  // high in the north-east corner ("Entire King Saud University Stadium", 2 px)
  // for the main stand.
  //
  // - The bowl: one tier, a stairway every 14.75 m along the sides with a
  //   block on the centre line, every 14.15 m round the ends with a stairway
  //   on it, and the corners fanned out between (a stairway every 4 to 6.5 m
  //   along the front row). A vomitory a third of the way up every stairway
  //   (rows 13 to 16 of 31), the box over it standing proud of the seats; no
  //   lateral gangway — the banners hang over the twelve rows below them.
  // - The main stand: its twelve front rows between the corners have a stair
  //   every 5.2 m (one up to each pair of glass boxes), none on the centre
  //   line, where the players' tunnel comes out through the front rows. Above
  //   the boxes, the upper section: a balcony of three rows in front of each
  //   box in the middle 34 m, the royal box behind, and blue blocks to either
  //   side with a stair every 5.5 m.
  'alawwal-park-26k': {
    id: 'alawwal-park-26k-rb',
    build: (old) =>
      rebuilt(old, 'alawwal-park-26k-rb', (t) => {
        const [bowl, upper] = t.tiers;
        // Stations along the front row, from each side's centre line. The
        // corners: 49.3 and 55.8 on the sides, 35.65 and 40.05 on the ends
        // (the same stairs measured from both photographs: 60.0 and 64.4
        // round from the side's centre).
        const sides = [7.4, 22.1, 36.9, 49.3, 55.8];
        const ends = [0, 14.15, 28.3, 35.65, 40.05];
        // The main stand: its middle twelve rows, and the bowl beyond the ends of its boxes.
        const mainLow = [2.6, 7.8, 13, 18.2, 23.4, 28.6, 33.8];
        // 38.4: the stair at each end of the boxes, its far side on the line (x = ±38)
        // where the rows behind them start again.
        const mainEdge = [38.4, 49.3, 55.8];
        const bowlVoms = [
          { side: 'north' as const, at: sides },
          { side: 'south' as const, at: mainEdge },
          { side: 'east' as const, at: ends },
          { side: 'west' as const, at: ends },
        ].map((r) => ({ ...r, mirror: true, width: 2.8, rows: [12, 15] as [number, number], kind: 'vomitory' as const }));
        return {
          tiers: [
            {
              ...bowl,
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'north', at: sides, mirror: true },
                  { side: 'south', at: mainLow, mirror: true, rows: [0, 11] },
                  { side: 'south', at: mainEdge, mirror: true },
                  { side: 'east', at: ends, mirror: true },
                  { side: 'west', at: ends, mirror: true },
                ],
                openings: [...bowlVoms, { side: 'south', at: [0], width: 4, rows: [0, 3], kind: 'tunnel' }],
              },
            },
            {
              ...upper,
              blocks: {
                width: 1.1,
                aisles: [
                  // The middle's two ends, and the blue blocks either side.
                  { side: 'south', at: [17, 22.5, 28, 33.5], mirror: true },
                  // Eight balconies, one in front of each box, three rows
                  // deep and divided by partitions rather than stairs.
                  { side: 'south', at: [0, 4.25, 8.5, 12.75], mirror: true, rows: [0, 2], width: 0.5 },
                  // The royal box behind them, in three.
                  { side: 'south', at: [8.5], mirror: true, rows: [4, 11] },
                ],
                // The balconies' back wall, between them and the royal box.
                walkways: [{ row: 3, side: 'south', from: -17, to: 17 }],
              },
            },
          ],
        };
      }),
  },

  // Kingdom Arena. Measured from three of StadiumDB's photographs, each camera
  // solved from the markings (2 to 3 px): from the back of the west end down
  // the length of the pitch (no. 16), from the stand opposite at halfway
  // (no. 11) and from the west end's south half (no. 17).
  //
  // The side stands are shorter than the earlier layout had them: all three
  // photographs put the ends of the main stand and of the stand opposite
  // level with the front of the end stands (x = ±41 at the front row), the
  // corners being open floor round the screens on the corner columns; the
  // upper tier opposite runs 3 m further each way. So the bowl holds about
  // 22,000 numbered seats — the published 26,700 is not to be found in the
  // photographs (it was announced before the expansion was built, and counts
  // the boxes and the hospitality floors).
  //
  // - The ends (42 rows): a stairway on the centre line and every 12.5 m out
  //   to ±25, one more at ±36.5, and a vomitory on every stairway at three
  //   heights — at the front (rows 2 to 4), a quarter of the way up and near
  //   the back.
  // - The main stand (12 rows): a vomitory through the front rows at ±8.25
  //   with a stair up either side of it, stairs at ±24.5 and down each end,
  //   and the players' tunnel on the centre line between the dugouts.
  // - Opposite (28 rows, then the boxes and the upper tier): a gangway half
  //   way up. Below it a vomitory every 19.2 m (±9.6, ±28.8) a few rows up,
  //   with a stair through each and one between; above it a stair every
  //   14.25 m from the centre line, each with a vomitory. The upper tier, a
  //   stair every 13.2 m either side of the centre line.
  'kingdom-arena-26k': {
    id: 'kingdom-arena-26k-rb',
    build: (old) =>
      rebuilt(old, 'kingdom-arena-26k-rb', (t) => {
        const [lower, upper] = t.tiers;
        const ends = [0, 12.5, 25, 36.5];
        const endVoms = ([[1, 3], [11, 14], [31, 34]] as [number, number][]).flatMap((rows) =>
          (['east', 'west'] as const).map((side) => ({ side, at: ends, mirror: true, width: 2.6, rows, kind: 'vomitory' as const })),
        );
        return {
          tiers: [
            {
              ...lower,
              // Four straight stands (TierSpec.straight), as they are: on the
              // plan's rounded corners the earlier layout's ends curled round
              // towards the corner columns, and a stairway near a corner
              // fanned out across the stand.
              straight: true,
              stands: (lower.stands ?? []).map((s) => (s.side === 'north' ? { ...s, halfLength: 41 } : s.side === 'south' ? { ...s, halfLength: 40 } : s)),
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'east', at: ends, mirror: true },
                  { side: 'west', at: ends, mirror: true },
                  { side: 'south', at: [6.45, 10.05, 24.5, 39.4], mirror: true },
                  { side: 'north', at: [0, 9.6, 19.2, 28.8], mirror: true, rows: [0, 12] },
                  { side: 'north', at: [0, 14.25, 28.5], mirror: true, rows: [14, 27] },
                ],
                walkways: [{ row: 13, side: 'north' }],
                openings: [
                  ...endVoms,
                  { side: 'south', at: [8.25], mirror: true, width: 2.4, rows: [0, 4], kind: 'vomitory' },
                  { side: 'south', at: [0], width: 4, rows: [0, 3], kind: 'tunnel' },
                  { side: 'north', at: [9.6, 28.8], mirror: true, width: 2.6, rows: [4, 7], kind: 'vomitory' },
                  { side: 'north', at: [0, 14.25, 28.5], mirror: true, width: 2.6, rows: [16, 19], kind: 'vomitory' },
                ],
              },
            },
            {
              // Left on the plan's curve, which is straight here: a straight
              // tier is drawn with a wall from its front down to the ground,
              // through the boxes under this one.
              ...upper,
              stands: (upper.stands ?? []).map((s) => ({ ...s, halfLength: 44 })),
              blocks: { width: 1.2, aisles: [{ side: 'north', at: [6.6, 19.8, 33], mirror: true }] },
            },
          ],
          // The hospitality floors over the main stand are as long as its seats.
          details: { ...t.details, ...(t.details?.hospitality ? { hospitality: { ...t.details.hospitality, halfLength: 41 } } : {}) },
        };
      }),
  },

  // Prince Mohamed bin Fahd Stadium. Measured from the Ministry of Sport's
  // drone photograph at dusk (StadiumDB no. 10), from behind the stand
  // opposite: the camera solved from the far touchline's corners and the
  // goal, and every lit vomitory of the main stand read off along it. The
  // ends and the stand opposite are less well seen (nos. 2 and 9, and the
  // Commons photograph from the north end) and follow the same rhythm.
  //
  // The 1970s bowl has no gangway across it: it is entered half way up
  // (rows 9 to 12 of 22), by vomitories with a stair straight up from each
  // and straight down to the front. They come in pairs, 10.5 m apart, the
  // pairs 15.5 m apart; on the stand opposite a pair either side of the
  // centre line, on the main stand the royal box there instead, with stairs
  // at its ends and down its middle.
  'pmbf-stadium-22k': {
    id: 'pmbf-stadium-22k-rb',
    build: (old) =>
      rebuilt(old, 'pmbf-stadium-22k-rb', (t) => {
        const [bowl] = t.tiers;
        // The front row, 6 m behind the track: 3.8 m nearer the pitch than
        // the earlier plan on the long sides and 2 m behind the goals. The
        // roof, the buildings and the arcade stay where they were.
        const plan = { a: 95.6, b: 53.5, exponent: 2.95 };
        const db = t.plan.b - plan.b;
        const sideVoms = [20.5, 35.2, 45.7, 62.3, 72.6];
        // The stand opposite (real east), from the Ministry of Sport's
        // square-on photograph across the pitch: in the middle the media box,
        // 8.6 m wide, through the front two of webook's three rings of
        // sections; then a vomitory 12.4 m out and two pairs beyond, each with
        // a stair through it, and stairs beside the box and between the pairs.
        const oppVoms = [12.4, 24.2, 34.5, 51, 63];
        // The ends (the 2024 drone photograph, over one end looking at the
        // other, and webook's seat map): stairs 7.2 and 16.4 m either side of
        // the centre line and vomitories 26 and 37.2 m out. Behind the camera
        // (east) the players' tunnel comes out under the scoreboard, a gap
        // through the whole stand; the end it looks at has two gates at the
        // front either side of the middle and a camera platform at the back.
        const endVoms = [26, 37.2];
        const endStairs = [7.2, 16.4, ...endVoms, 44.5];
        const voms = (side: StandSide, at: number[]): SeatOpening => ({ side, at, mirror: true, width: 2.4, rows: [8, 11], kind: 'vomitory' });
        return {
          tiers: [
            {
              ...bowl,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'south', at: [0, 14, ...sideVoms], mirror: true },
                  { side: 'north', at: [4.5, 12.4, 24.2, 34.5, 42.8, 51, 63, 70], mirror: true },
                  // The tunnel's sides are the stairs either side of it.
                  { side: 'east', at: endStairs.slice(1), mirror: true },
                  { side: 'west', at: endStairs, mirror: true },
                ],
                openings: [
                  voms('south', sideVoms),
                  voms('north', oppVoms),
                  voms('east', endVoms),
                  voms('west', endVoms),
                  { side: 'east', at: [0], width: 9, rows: [0, 21], kind: 'tunnel' },
                  { side: 'west', at: [-4.75, 7.75], width: 4.5, rows: [0, 5], kind: 'gate' },
                ],
                areas: [
                  { side: 'north', from: -4.3, to: 4.3, rows: [0, 13], kind: 'press' },
                  { side: 'west', from: -2, to: 2, rows: [12, 15], kind: 'gantry' },
                ],
              },
            },
          ],
          plan,
          ...(t.runoff ? { runoff: { ...t.runoff, ...plan } } : {}),
          roofs: (t.roofs ?? []).map((r) => ({ ...r, back: r.back + db, front: r.front + db, columns: r.columns ? { ...r.columns, offset: (r.columns.offset ?? r.back) + db } : r.columns })),
          details: {
            ...t.details,
            buildings: (t.details?.buildings ?? []).map((bd) => ({ ...bd, front: bd.front + db })),
            skins: (t.details?.skins ?? []).map((sk) => ({ ...sk, offset: sk.offset + db })),
          },
        };
      }),
  },

  // Prince Faisal bin Fahd Stadium. Measured from a drone photograph from high
  // over the main stand (on X, March 2024, with the club's ticket prices), the
  // camera solved from the pitch markings, the stand opposite and both ends
  // unrolled from it; StadiumDB's four small photographs for the rest.
  //
  // - Opposite the main stand the lower tier has a stair on the centre line,
  //   over the media box at its front, and every 16.5 m out from ±17 m; a
  //   vomitory two thirds of the way up (rows 10 to 13) half way between
  //   each pair of stairs past the middle block.
  // - The ends: a stair every 14 m at 11, 25 and 39 m out, a vomitory on
  //   the centre line with a stair through it, and others half way between
  //   the stairs.
  // - The main stand is out of the photograph and keeps the 14 m rhythm of
  //   StadiumDB's photographs; so does the upper tier, entered from the front.
  'pfbf-stadium-22k': {
    id: 'pfbf-stadium-22k-rb',
    build: (old) =>
      rebuilt(old, 'pfbf-stadium-22k-rb', (t) => {
        const [bowl, upper] = t.tiers;
        const corner = (side: StandSide): number => cornerStation(t, bowl, side) - 2;
        const mainStairs = rhythm(14, false, corner('south'));
        const mainVoms = rhythm(14, true, corner('south'));
        // (The last, 81 m round, is the end's stair 39 m out.)
        const opp = [0, 17, 33.5, 50, 66.3];
        const oppVoms = [25.3, 41.7, 58.1, 73.6];
        const ends = [0, 11, 25, 39];
        const endVoms = [0, 18, 32];
        const upStairs = rhythm(14, false, (upper.stands?.[0]?.halfLength ?? 75) - 3);
        const vom = (side: StandSide, at: number[]): SeatOpening => ({ side, at, mirror: true, width: 2.4, rows: [10, 13], kind: 'vomitory' });
        return {
          tiers: [
            {
              ...bowl,
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'south', at: mainStairs, mirror: true },
                  { side: 'north', at: opp, mirror: true },
                  { side: 'east', at: ends, mirror: true },
                  { side: 'west', at: ends, mirror: true },
                ],
                openings: [{ ...vom('south', mainVoms), rows: [7, 11] }, vom('north', oppVoms), vom('east', endVoms), vom('west', endVoms)],
                // The media box at the front of the middle of the stand opposite.
                areas: [{ side: 'north', from: -5, to: 5, rows: [0, 7], kind: 'press' }],
              },
            },
            {
              ...upper,
              blocks: {
                width: 1.1,
                aisles: [{ side: 'north', at: upStairs, mirror: true }],
                openings: [{ side: 'north', at: rhythm(14, true, upStairs[upStairs.length - 1]), mirror: true, width: 2.4, rows: [0, 2], kind: 'vomitory' }],
              },
            },
          ],
        };
      }),
  },

  // King Abdullah Sport City Stadium, Buraidah. Measured from the Ministry of
  // Sport's drone photograph straight down over it at night (StadiumDB no.
  // 18): the camera solved from the pitch markings to 1.4 px, the stands
  // unrolled from it, and every vomitory (the dark squares) found and placed
  // automatically — the two ends agree to 0.3 m. The main stand, under its
  // roof there, from the photograph square on to it (no. 15).
  //
  // The photograph also corrects the horseshoe's shape, which the satellite
  // picture had not shown: its front row follows the track's oval (fitted to
  // fifteen points round it, to 0.1 m), and its back is an oval of its own,
  // so the stand is 21 m deep behind the goals and 27 m along the side
  // opposite the main stand — the side the canopy covers. That side was a
  // whole band short.
  //
  // - The horseshoe: a gangway eight rows up behind the goals, ten along the
  //   side and round the bends, and a second, thirteen rows higher, along the
  //   side. A ring of vomitories just above each gangway, staggered: from
  //   the lower one a stair down through the front band, from the upper one a
  //   stair up to the back. Along the side opposite the main stand the front
  //   band's blocks are 35 seats wide — it was built in 1983 — and in the
  //   middle a ramp comes up from the track, between two short flights, to a
  //   box on the first gangway.
  // - The main stand: six rows at the front either side of the glass VIP
  //   box, a gangway, and eight rows above it, a stair every 13 m.
  'buraidah-stadium-25k': {
    id: 'buraidah-stadium-25k-rb',
    build: (old) =>
      rebuilt(old, 'buraidah-stadium-25k-rb', (t) => {
        const [bowl, main] = t.tiers;
        // The front row, 2.8 m further out than the earlier plan opposite the
        // main stand and up to 4.5 m round the bends; the main stand stays put.
        const plan = { a: 95.2, b: 54.8, exponent: 2.48 };
        const db = plan.b - t.plan.b;
        const rows = 36;
        const last = rows - 1;
        // Behind the goals the stand is shallower: its back, row by row out from the centre line.
        const ends = (side: StandSide) => [
          { side, from: -15, to: 15, fromRow: 28 },
          { side, from: 15, to: 27, fromRow: 31 },
          { side, from: -27, to: -15, fromRow: 31 },
          { side, from: 27, to: 34, fromRow: 34 },
          { side, from: -34, to: -27, fromRow: 34 },
        ];
        // Stations, measured on this plan's front row. A: the lower ring of
        // vomitories, each with a stair down through the front band; B: the
        // upper ring, each with a stair from the first gangway to the back.
        const sideA = [23.1, 40.25, 53.8, 67.05];
        const sideB = [13.75, 31.15, 46.55, 60.4, 73.6];
        const endA = [6.9, 19.55, 31.85, 44.3];
        const endB = [0, 13.2, 25.3, 37.25];
        // The first gangway: eight rows up behind the goals, ten along the
        // side, eleven round the bends; the second, along the side and round
        // the bends, at row 23.
        const g1 = 10;
        const g1End = 8;
        const g1Bend = 11;
        const g2 = 23;
        // Behind the goals as far as the third stair out; the bends beyond, to the corner.
        const BEND = endA[2];
        const CORNER = endCornerStation({ ...t, plan }, bowl);
        const vom = (side: StandSide, at: number[], rows: [number, number]): SeatOpening => ({ side, at, mirror: true, width: 2.4, rows, kind: 'vomitory' });
        const endStairs = (side: StandSide) => [
          // The stair at the bend's edge runs up to the higher gangway.
          { side, at: endA.filter((x) => x < BEND), mirror: true, rows: [0, g1End - 1] as [number, number] },
          { side, at: endA.filter((x) => x >= BEND), mirror: true, rows: [0, g1Bend - 1] as [number, number] },
          { side, at: endB.filter((x) => x < BEND), mirror: true, rows: [g1End + 1, last] as [number, number] },
          { side, at: endB.filter((x) => x > BEND), mirror: true, rows: [g1Bend + 1, last] as [number, number] },
        ];
        const endVoms = (side: StandSide): SeatOpening[] => [
          vom(side, endA.filter((x) => x < BEND), [g1End + 1, g1End + 4]),
          vom(side, endA.filter((x) => x >= BEND), [g1Bend + 1, g1Bend + 4]),
          vom(side, endB.filter((x) => x < BEND), [22, 25]),
          vom(side, endB.filter((x) => x > BEND), [g2 + 1, g2 + 4]),
        ];
        return {
          plan,
          runoff: { ...(t.runoff ?? { color: 0x9e6447 }), a: plan.a, b: plan.b, exponent: plan.exponent },
          tiers: [
            {
              ...bowl,
              rows,
              // Half-metre seats, as at the other grounds of its time.
              seatPitch: 0.5,
              omit: [...(bowl.omit ?? []), ...ends('east'), ...ends('west')],
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'north', at: sideA, mirror: true, rows: [0, g1 - 1] },
                  // The centre of the stand opposite: a stair up from the box
                  // (and the box between the blocks either side of it).
                  { side: 'north', at: [0, ...sideB], mirror: true, rows: [g1 + 1, last] },
                  ...endStairs('east'),
                  ...endStairs('west'),
                  // The horseshoe's arms either side of the main stand.
                  { side: 'south', at: [sideB[sideB.length - 1]], mirror: true, rows: [g1 + 1, last] },
                ],
                walkways: [
                  { row: g1, side: 'north' },
                  { row: g2, side: 'north' },
                  { row: g1, side: 'south' },
                  { row: g2, side: 'south' },
                  ...(['east', 'west'] as const).flatMap((side) => [
                    { row: g1End, side, from: -BEND, to: BEND },
                    { row: g1Bend, side, from: BEND, to: CORNER },
                    { row: g1Bend, side, from: -CORNER, to: -BEND },
                    // The second from the last upper stair before the bend.
                    { row: g2, side, from: endB[3], to: CORNER },
                    { row: g2, side, from: -CORNER, to: -endB[3] },
                  ]),
                ],
                openings: [
                  vom('north', sideA, [g1 + 1, g1 + 5]),
                  vom('north', sideB.filter((x) => x < 50), [g2 + 1, g2 + 4]),
                  ...endVoms('east'),
                  ...endVoms('west'),
                  // The ramp and its two flights, up from the track.
                  { side: 'north', at: [0], width: 12.5, rows: [0, g1 - 1], kind: 'gate' },
                ],
                areas: [{ side: 'north', from: -4.5, to: 4.5, rows: [g1 + 1, g1 + 5], kind: 'platform' }],
              },
            },
            {
              ...main,
              // Where it was: the plan's side moved out from under it.
              baseOffset: main.baseOffset - db,
              blocks: {
                width: 1.1,
                aisles: [
                  // Where the colours of the seats change along the back, and
                  // on down through the front rows either side of the VIP box.
                  { side: 'south', at: [13, 26, 39], mirror: true },
                  { side: 'south', at: [0], rows: [7, main.rows - 1] },
                ],
                walkways: [{ row: 6 }],
                openings: [{ side: 'south', at: [19.5, 32.5], mirror: true, width: 2.4, rows: [7, 9], kind: 'vomitory' }],
                // The glass VIP box, in the front rows.
                areas: [{ side: 'south', from: -12.4, to: 12.4, rows: [0, 5], kind: 'platform' }],
              },
            },
          ],
          roofs: (t.roofs ?? []).map((r) =>
            r.side === 'north'
              ? // The canopy over the back rows of the stand opposite, now that it has them.
                { ...r, back: 29, front: 19.5, backY: 20.2, frontY: 19.2, columns: r.columns ? { ...r.columns, offset: 28.4 } : r.columns }
              : r.side === 'south' && r.straight
                ? { ...r, back: r.back - db, front: r.front - db, columns: r.columns ? { ...r.columns, offset: (r.columns.offset ?? r.back) - db } : r.columns }
                : r,
          ),
          details: {
            ...t.details,
            buildings: (t.details?.buildings ?? []).map((bd) => (bd.side === 'south' && bd.straight ? { ...bd, front: bd.front - db } : bd)),
          },
        };
      }),
  },

  // SHG Arena. Measured from the Ministry of Sport's drone photograph straight
  // down over it (StadiumDB no. 4), in which every block's name is painted on
  // the walkway in front of it — E1 to E9 opposite the main stand, W1 to W9
  // along it, N1 to N9 and S1 to S9 in the ends (real compass: the main stand
  // faces east) — scaled from the pitch markings (8.2 px a metre) and allowed
  // for the stands' height over the pitch; checked against the drone view from
  // behind an end (no. 1), which puts the end's stairs within 0.5 m.
  //
  // - Every stand: nine blocks, laid out the same either side of the centre
  //   line. The long sides' middle block is 15 m across, then 19, 18, 12 and
  //   the end block; every stair starts at a vomitory at the front of the
  //   upper rows, the two at ±26.5 wide ones over a gate through the front
  //   rows to the pitch.
  // - The ends: two rows at the front, the walkway with the names, twelve
  //   rows behind with a vomitory at ±14.
  'shg-arena-14k': {
    id: 'shg-arena-14k-rb',
    build: (old) =>
      rebuilt(old, 'shg-arena-14k-rb', (t) => {
        const [lower, upper] = t.tiers;
        const longStairs = [7.3, 26.6, 44.2, 56.4];
        const ends = [5, 14.2, 21.7, 32.3];
        const endRows: [number, number] = [3, (lower.stands?.find((s) => s.side === 'east')?.rows ?? 15) - 1];
        const mainRows = (lower.stands?.find((s) => s.side === 'south')?.rows ?? 18) - 1;
        const names = (side: StandSide, letter: string, band = 0) => ({ side, band, names: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${letter}${n}`) });
        return {
          tiers: [
            {
              ...lower,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'east', at: ends, mirror: true },
                  { side: 'west', at: ends, mirror: true },
                  // The six rows in front of the stand opposite.
                  { side: 'north', at: [7.2, 44.5, 57.2], mirror: true },
                  { side: 'south', at: longStairs, mirror: true, rows: [0, mainRows] },
                ],
                walkways: [
                  { row: 2, side: 'east' },
                  { row: 2, side: 'west' },
                ],
                openings: [
                  // The gates through the front rows opposite, down to the pitch.
                  { side: 'north', at: [26.9], mirror: true, width: 2.5, rows: [0, 5], kind: 'gate' },
                  { side: 'east', at: [14.2], mirror: true, width: 1.8, rows: endRows.map((r, i) => (i ? endRows[0] + 2 : r)) as [number, number], kind: 'vomitory' },
                  { side: 'west', at: [14.2], mirror: true, width: 1.8, rows: endRows.map((r, i) => (i ? endRows[0] + 2 : r)) as [number, number], kind: 'vomitory' },
                  { side: 'south', at: [26.6], mirror: true, width: 3.4, rows: [0, 3], kind: 'vomitory' },
                ],
                // The real names, from the photograph: block 1 at the end on
                // the left as the main stand sees it, in the app's order.
                names: [names('south', 'W'), names('east', 'S', 1), names('west', 'N', 1)],
              },
            },
            {
              ...upper,
              blocks: {
                width: 1.1,
                aisles: [{ side: 'north', at: longStairs, mirror: true }],
                openings: [
                  { side: 'north', at: [7.3, 44.2, 56.4], mirror: true, width: 1.8, rows: [0, 2], kind: 'vomitory' },
                  { side: 'north', at: [26.6], mirror: true, width: 3.4, rows: [0, 3], kind: 'vomitory' },
                ],
                names: [names('north', 'E')],
              },
            },
          ],
        };
      }),
  },

  // EGO Stadium. From the ground's seat map on webook (2026-27), which draws
  // every seat and names every block, checked against the club's two drone
  // photographs (StadiumDB nos. 1 and 2).
  //
  // - The U is 14 rows deep. The stand opposite (`north`) is D1 to D11 from
  //   the west corner round to the east: D6 in the middle, 12 seats wide over
  //   a box at the front, then blocks of 22, 26, 21 and 21 seats either side,
  //   and D1 and D11 round the corners to the diagonal. The ends are C1 to C7
  //   (west, from the open corner by the main stand round to the far corner)
  //   and E1 to E7 (east, the other way round): blocks of 23, 23, 28, 28, 20 and 19 seats, then
  //   the corner block. Scaled onto the ends as the photographs place them —
  //   the openings at the front the dusk photograph shows 7.7 m to the main
  //   stand's side of the goal and 18 m beyond it are the ones the map has
  //   between C2 and C3 and between C4 and C5.
  // - Every block has a vomitory half way up its middle (rows 5 to 7); at
  //   the stairs between C2 and C3, C4 and C5 and C6 and C7 (and their twins in
  //   the west end), and between D1 and D2, D3 and D4 and their twins, the
  //   front rows open onto the walkway round the pitch.
  // - The 1983 main stand is 19 rows: B4, B3, B2, B1, the VIP block, A4, A3,
  //   A2 and A1 (west to east), blocks of 13, 25, 36 and 38 seats either side
  //   of a VIP block of 31; a vomitory half way up each (rows 9 to 11), and the
  //   players' tunnel and the VIP entrance across the front five rows of the
  //   middle.
  //
  // About 11,000 seats: the map's count (10,900), against the published
  // 12,924 that includes the boxes.
  'ego-stadium-13k': {
    id: 'ego-stadium-13k-rb',
    build: (old) =>
      rebuilt(old, 'ego-stadium-13k-rb', (t) => {
        const [u, main] = t.tiers;
        const P = 0.47;
        // The stand opposite: stairs out from D6, block by block.
        const dWidths = [22, 26, 21, 21];
        const dStairs: number[] = [];
        let x = (12 * P) / 2 + 0.55;
        dStairs.push(x);
        for (const w of dWidths) {
          x += 0.55 + w * P + 0.55;
          dStairs.push(Math.round(x * 100) / 100);
        }
        const dMid = dStairs.slice(0, -1).map((a, k) => Math.round(((a + dStairs[k + 1]) / 2) * 100) / 100);
        // The diagonal at the corner, between D1 and C7.
        const diag = cornerStation(t, u, 'north') - 0.6;
        // The ends, from the open corner (z = -27) round to the diagonal:
        // the map's blocks (and the corner block's front row, 25 seats)
        // shared out over the end's length.
        const z0 = -27;
        const endLen = cornerStation(t, u, 'east') - z0;
        const seats = [23, 23, 28, 28, 20, 19, 25];
        const stairU = 1.1 / P;
        const unit = endLen / (seats.reduce((a, b) => a + b, 0) + (seats.length - 1) * stairU);
        const endStairs: number[] = [];
        const endMid: number[] = [];
        let c = 0;
        for (let k = 0; k < seats.length; k++) {
          endMid.push(Math.round((z0 + (c + seats[k] / 2) * unit) * 100) / 100);
          c += seats[k];
          if (k < seats.length - 1) {
            endStairs.push(Math.round((z0 + (c + stairU / 2) * unit) * 100) / 100);
            c += stairU;
          }
        }
        const endFront = [endStairs[1], endStairs[3], endStairs[5]];
        // The main stand: out from the VIP block.
        const mWidths = [38, 36, 25, 13];
        const mStairs: number[] = [];
        let m = (31 * P) / 2 + 0.55;
        mStairs.push(Math.round(m * 100) / 100);
        for (const w of mWidths.slice(0, -1)) {
          m += 0.55 + w * P + 0.55;
          mStairs.push(Math.round(m * 100) / 100);
        }
        const mEnd = Math.round((m + 0.55 + mWidths[mWidths.length - 1] * P) * 10) / 10;
        const mMid = [...mStairs, mEnd].slice(0, -1).map((a, k) => Math.round(((a + [...mStairs, mEnd][k + 1]) / 2) * 100) / 100);
        const vom = (side: StandSide, at: number[], mirror: boolean, width: number, rows: [number, number]): SeatOpening => ({ side, at, mirror, width, rows, kind: 'vomitory' });
        // The openings from the walkway round the pitch into the front rows.
        const front = (side: StandSide, at: number[], mirror: boolean, width: number, rows: [number, number]): SeatOpening => ({ side, at, mirror, width, rows, kind: 'vomitory' });
        const names = (side: StandSide, letter: string, n: number) => ({ side, names: Array.from({ length: n }, (_, k) => `${letter}${k + 1}`) });
        return {
          tiers: [
            {
              ...u,
              rows: 14,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'north', at: [...dStairs, diag], mirror: true },
                  { side: 'east', at: endStairs },
                  { side: 'west', at: endStairs },
                ],
                openings: [
                  vom('north', dMid, true, 3.6, [5, 7]),
                  vom('east', endMid.slice(0, -1), false, 3, [5, 7]),
                  vom('west', endMid.slice(0, -1), false, 3, [5, 7]),
                  front('north', [dStairs[2], dStairs[4]], true, 4.9, [0, 4]),
                  front('east', endFront, false, 4.6, [0, 5]),
                  front('west', endFront, false, 4.6, [0, 5]),
                ],
                areas: [
                  // The box at the front of D6, and the camera gantry at its back.
                  { side: 'north', from: -2.8, to: 2.8, rows: [0, 4], kind: 'platform' },
                  { side: 'north', from: -1.6, to: 1.6, rows: [9, 13], kind: 'gantry' },
                  // The camera platform in E2.
                  { side: 'east', from: endMid[5] - 1.2, to: endMid[5] + 1.2, rows: [0, 9], kind: 'platform' },
                ],
                // Named as the map names them, left to right facing each stand
                // from the pitch: D1 at the west corner, the C blocks the west
                // end, the E blocks the east.
                names: [names('north', 'D', 11), names('west', 'C', 7), names('east', 'E', 7)],
              },
            },
            {
              ...main,
              rows: 19,
              stands: (main.stands ?? []).map((st) => ({ ...st, halfLength: mEnd })),
              blocks: {
                width: 1.1,
                aisles: [{ side: 'south', at: mStairs, mirror: true }],
                openings: [vom('south', mMid, true, 3.3, [9, 11])],
                areas: [
                  // The players' tunnel and the VIP entrance, across the front of the middle.
                  { side: 'south', from: -(mStairs[0] + 3.8), to: mStairs[0] + 3.8, rows: [0, 4], kind: 'platform' },
                  // The VIP boxes over it; the VIP block's seats are its five back rows.
                  { side: 'south', from: -(mStairs[0] - 0.55), to: mStairs[0] - 0.55, rows: [5, 13], kind: 'press' },
                ],
                names: [{ side: 'south', names: ['A1', 'A2', 'A3', 'A4', 'VIP', 'B1', 'B2', 'B3', 'B4'] }],
              },
            },
          ],
        };
      }),
  },

  // Al-Fateh Stadium. Measured from the Ministry of Sport's drone photograph
  // from behind the main stand's far end (StadiumDB no. 2): the camera solved
  // from the far penalty area and the centre spot to 1.9 px, and the far end
  // and the stand opposite unrolled from it. The far end's vomitories are
  // plain — a little way up the rake at -19.5, 9.5 and 29.5 m — with a stair
  // through each and one half way between; the near end is under the roof in
  // every photograph and is given the same. Along the sides the vomitories
  // the photograph shows (the middle, and -30) put them every 29 m, a stair
  // through each and between.
  'alfateh-stadium-12k': {
    id: 'alfateh-stadium-12k-rb',
    build: (old) =>
      rebuilt(old, 'alfateh-stadium-12k-rb', (t) => {
        const [bowl] = t.tiers;
        const endVoms = [-19.5, 9.5, 29.5];
        const ends = [-42, -34, -19.5, -5, 9.5, 19.5, 29.5, 39];
        const sideVoms = [0, 29];
        const sides = [0, 14.5, 29, 43.5, 52.5];
        const vom = (side: StandSide, at: number[], mirror: boolean): SeatOpening => ({ side, at, mirror, width: 2.4, rows: [2, 5], kind: 'vomitory' });
        return {
          tiers: [
            {
              ...bowl,
              // Half-metre seats: with its real stairs, the even layout's 0.48 m
              // would put 500 more seats in it than it has.
              seatPitch: 0.5,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'east', at: ends },
                  { side: 'west', at: ends },
                  { side: 'north', at: sides, mirror: true },
                  { side: 'south', at: sides, mirror: true },
                ],
                openings: [vom('east', endVoms, false), vom('west', endVoms, false), vom('north', sideVoms, true), vom('south', sideVoms.filter((x) => x > 0), true)],
              },
            },
          ],
        };
      }),
  },

  // Prince Sultan bin Abdul Aziz Stadium, Abha. Measured from the Ministry of
  // Sport's drone photograph straight down over it at dusk (StadiumDB no.
  // 12), scaled from the goal lines (6.2 px a metre at the magnification it
  // was read at) and allowed for the stands' height: the stair lines read off
  // either side of the centre agree to 1.7 m, so the stations are the means.
  //
  // - The horseshoe: one rake from the track to the back opposite the main
  //   stand, with a stair every 13.8 m from ±10.5 (a media box on the centre
  //   line) on round into the bends; the low ends round the track a stair
  //   every 7 m.
  // - The main stand: a stair every 10 m from the centre line out to the
  //   ends, a walkway six rows up, and vomitories above it on the centre
  //   line, at ±20 and at ±50.
  'abha-stadium-20k': {
    id: 'abha-stadium-20k-rb',
    build: (old) =>
      rebuilt(old, 'abha-stadium-20k-rb', (t) => {
        const [front, deep, main] = t.tiers;
        const opp = [10.5, 24.3, 38.1, 51.9, 63.5];
        return {
          tiers: [
            {
              ...front,
              blocks: {
                width: 1.1,
                aisles: [
                  // A stair down from the media box on the centre line.
                  { side: 'north', at: [0, ...opp, 72], mirror: true },
                  { side: 'east', at: rhythm(7, false, 46), mirror: true },
                  { side: 'west', at: rhythm(7, false, 46), mirror: true },
                ],
              },
            },
            {
              ...deep,
              blocks: {
                width: 1.1,
                // The media box, the full depth of the stand on the centre line,
                // between the two blocks either side of it.
                aisles: [{ side: 'north', at: [0, ...opp], mirror: true }],
                areas: [{ side: 'north', from: -3.5, to: 3.5, rows: [0, deep.rows - 1], kind: 'press' }],
              },
            },
            {
              ...main,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'south', at: rhythm(10, false, 71), mirror: true },
                ],
                walkways: [{ row: 6 }],
                openings: [{ side: 'south', at: [0, 20, 50], mirror: true, width: 2.4, rows: [7, 9], kind: 'vomitory' }],
              },
            },
          ],
        };
      }),
  },

  // Al-Hazem Club Stadium. Measured from three drone photographs: the
  // Ministry of Sport's daytime one along the ground from behind the east goal
  // (2023-24, with the long roof over the main stand), and two at night in
  // 2020 (Arriyadiyah, July 2020), one high over the north-east corner and
  // one square on to the main stand from over the empty side, each camera
  // solved from the pitch markings and each stand unrolled onto its rows.
  //
  // - The long curved terrace round the west end starts at the end's centre
  //   line and runs round the bend to a flank wall short of the main stand;
  //   its stairs are 18 m apart (blocks of 34-36 seats, the front row
  //   following the track), and a gangway crosses it half way up, at row 6.
  // - The short terrace round the south-east corner: two blocks either side
  //   of one stair, from its own flank wall round to the corner.
  // - The main stand: 92 m long and centred 1.7 m east of the halfway line,
  //   fifteen rows, a stair every 14-15 m; in the middle, 16 m wide, the
  //   players' tunnel and the raised VIP box in front of the rows behind it,
  //   which have a stair down their middle.
  //
  // About 4,900 seats: what the photographs hold, against the 8,000 the
  // ground is usually given (and the 6,129 of the earlier layout, which
  // guessed at the terraces from the satellite picture).
  'alhazem-stadium-8k': {
    id: 'alhazem-stadium-8k-rb',
    build: (old) =>
      rebuilt(old, 'alhazem-stadium-8k-rb', (t) => {
        const [terraces, main] = t.tiers;
        // The terraces' front row follows the track round the bends, 49.5 m
        // from the bends' centres; the main stand stays where it was.
        const plan = { a: 90.1, b: 50.6, exponent: 3 };
        const db = plan.b - t.plan.b;
        const C = 1.7;
        const at = (offs: number[]) => offs.map((o) => Math.round((C + o) * 10) / 10);
        return {
          plan,
          ...(t.runoff ? { runoff: { ...t.runoff, ...plan } } : {}),
          roofs: (t.roofs ?? []).map((r) => (r.straight ? { ...r, back: r.back - db, front: r.front - db, columns: r.columns ? { ...r.columns, offset: (r.columns.offset ?? r.back) - db } : r.columns } : r)),
          details: { ...t.details, buildings: (t.details?.buildings ?? []).map((bd) => (bd.straight ? { ...bd, front: bd.front - db } : bd)) },
          tiers: [
            {
              ...terraces,
              // From the west end's centre line round to x = -56.8, and from
              // x = 60.5 round the south-east corner to z = -36.
              omit: [
                { side: 'north', from: -99, to: 99 },
                { side: 'east', from: -36, to: 99 },
                { side: 'west', from: -1.5, to: 99 },
                { side: 'south', from: -56.8, to: 60.5 },
              ],
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'west', at: [-10.2, -28.2, -46.8] },
                  { side: 'east', at: [-46.6] },
                ],
                walkways: [{ row: 6 }],
              },
            },
            {
              ...main,
              // Fifteen rows: in both night photographs the seats stop at the
              // fifteenth, under a walkway along the back.
              rows: 15,
              baseOffset: main.baseOffset - db,
              stands: (main.stands ?? []).map((st) => ({ ...st, halfLength: 46, center: C })),
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'south', at: at([-36.8, -21.9, -8, 8, 21.9, 36.8]) },
                  // Down the middle of the rows behind the box.
                  { side: 'south', at: [C], rows: [8, 14] },
                ],
                // The tunnel and the VIP box, in the middle of the front rows.
                areas: [{ side: 'south', from: C - 8, to: C + 8, rows: [0, 7], kind: 'platform' }],
              },
            },
          ],
        };
      }),
  },

  // King Khalid Sport City Stadium, Tabuk. From the ground's seat map on
  // webook (2026-27: sections 101-114, 201-218 and 301-313, three levels)
  // and the photographs of the 2025 works: the Slaati drone photograph square
  // on to the main stand (August 2025) and NEOM SC's own photograph from the
  // corner flag, the cameras solved from the track and the pitch markings.
  //
  // The main stand curves from bend to bend (to 96 m either side along its
  // front row) in three bands, each its own tier, steeper as they go up:
  // - the front band, 10 rows (sections 101-114): one stair down from each
  //   vomitory above it, the players' tunnel in the middle, and a wide gate
  //   at the front of each bend;
  // - a walkway, then the middle band, 12 rows, entered by vomitories at its
  //   foot every 15 m (the stand is centred 3.2 m off the halfway line), a
  //   stair up either side of each; the VIP seats and the glass lounge in the
  //   middle;
  // - a second walkway and the top band, 12 rows under the roof, entered the
  //   same way above, with the press box in the middle.
  'tabuk-stadium-12k': {
    id: 'tabuk-stadium-12k-rb',
    build: (old) =>
      rebuilt(old, 'tabuk-stadium-12k-rb', (t) => {
        const [main, opp] = t.tiers;
        const half = opp.stands?.[0]?.halfLength ?? 56;
        const C = 3.2;
        const d = [9.9, 24.9, 39.7, 54.9, 70, 84.9];
        const voms = [...d.map((x) => Math.round((C - x) * 10) / 10), ...d.map((x) => Math.round((C + x) * 10) / 10)].sort((p, q) => p - q);
        // Measured along the front row; the bands behind it have their
        // vomitories on the same lines out, a stair either side of each (and
        // one more in the long block at the stand's west end).
        const on = (offset: number, at: number[]) => at.map((s) => radialStation(t, 0, offset, 'south', s));
        const either = (offset: number) => [...on(offset, voms).flatMap((v) => [Math.round((v - 2.8) * 10) / 10, Math.round((v + 2.8) * 10) / 10]), ...on(offset, [-90.2])];
        // The main stand stops 96 m round from its centre along the front row,
        // at z = -18.6; the bands behind stop on the same line out.
        const omit = (z: number) => [
          { side: 'north' as const, from: -99, to: 99 },
          { side: 'east' as const, from: z, to: 99 },
          { side: 'west' as const, from: z, to: 99 },
        ];
        const front = { ...main, rows: 10, rakeDeg: 27, omit: omit(-18.6) };
        const middle = { ...main, rows: 12, rowDepth: 0.8, rakeDeg: 35, baseOffset: 9.6, baseElevation: 5.8, omit: omit(-23.1) };
        const top = { ...main, rows: 12, rowDepth: 0.8, rakeDeg: 37, baseOffset: 20.8, baseElevation: 12.6, omit: omit(-28.4) };
        // As wide as the gap between the stairs either side of it.
        const vom = (offset: number, rows: [number, number]): SeatOpening => ({ side: 'south', at: on(offset, voms), width: 4.6, rows, kind: 'vomitory' });
        return {
          // Three levels, as webook sells them (101-114, 201-218, 301-313).
          levels: 3,
          tiers: [
            {
              ...front,
              blocks: {
                width: 1.2,
                aisles: [{ side: 'south', at: voms.map((v) => Math.round((v - 1.8) * 10) / 10) }],
                openings: [
                  { side: 'south', at: [C], width: 4.5, rows: [0, 9], kind: 'tunnel' },
                  // The gates at the front of the bends.
                  { side: 'south', at: [C - 67.5, C + 66.1], width: 4, rows: [1, 9], kind: 'vomitory' },
                ],
                // Round the bends the blocks are the ends' (east and west) in the app's terms.
                names: [
                  { side: 'east', names: ['101', '102'] },
                  { side: 'south', names: ['103', '104', '105', '106', '107', '108', '109', '110', '111', '112'] },
                  { side: 'west', names: ['113', '114'] },
                ],
              },
            },
            {
              ...middle,
              blocks: {
                width: 1.2,
                aisles: [{ side: 'south', at: either(middle.baseOffset) }],
                openings: [vom(middle.baseOffset, [0, 3])],
                // The VIP seats in front of the glass lounge.
                areas: [{ side: 'south', from: C - 7.5, to: C + 7.5, rows: [4, 11], kind: 'press' }],
              },
            },
            {
              ...top,
              blocks: {
                width: 1.2,
                aisles: [{ side: 'south', at: either(top.baseOffset) }],
                openings: [vom(top.baseOffset, [0, 2])],
                // The press box.
                areas: [{ side: 'south', from: C - 7.5, to: C + 7.5, rows: [0, 11], kind: 'press' }],
              },
            },
            { ...opp, blocks: { width: 1.2, aisles: [{ side: 'north', at: [0, half / 2], mirror: true }, { side: 'north', at: [half / 4, (3 * half) / 4], mirror: true }] } },
          ],
          roofs: (t.roofs ?? []).map((r) => ({ ...r, back: 31.5, front: 15, backY: 22.5, frontY: 21, columns: r.columns ? { ...r.columns, offset: 30.5 } : r.columns, omit: omit(-16) })),
          seatLook: {
            colors: t.seatLook?.colors ?? ['#2f6b3f'],
            // The front band beige, the two above green; the movable stand blue.
            regions: [
              { tiers: [0], colors: [{ c: '#d9c58f', w: 4 }, { c: '#cdb67c', w: 3 }] },
              { tiers: [3], colors: ['#2b5fae', '#2352a0', '#3368b8'] },
            ],
          },
          details: {
            ...t.details,
            zones: (t.details?.zones ?? []).map((z) => ({ ...z, tiers: [1] })),
            buildings: (t.details?.buildings ?? []).map((bd) => ({ ...bd, front: 31, y1: 23 })),
          },
        };
      }),
  },

  // Al-Majma'ah Sports City Stadium, as rebuilt for 2026: from the ground's
  // seat map on webook (2026-27) and the stadium photographs of May 2026
  // (@stadiumscorner on X: a drone square on to the main stand and one over
  // the corner, the cameras solved from the pitch markings).
  //
  // - The main stand is new: 93.5 m long, two bands of 14 rows with a
  //   walkway between, in eleven columns 8.5 m wide — the map's Blocks 1-4,
  //   Silver A-C and 5-8 at the front, 9-19 behind — each band a stair
  //   between each column. The upper band is entered from the walkway by
  //   vomitories either side of the stairs 21.25 and 38.25 m out, and one
  //   beside each stair 12.75 m out. In the middle of the front band the
  //   players' tunnel and the glass VIP lounge.
  // - The stand opposite is ten rows: Blocks 20-27, six of 12.4 m and one of
  //   half that at either end, and a wheelchair platform beyond each.
  //
  // About 6,800 seats, as published (6,844, of which 578 are kept empty).
  'majmaah-stadium-7k': {
    id: 'majmaah-stadium-7k-rb',
    build: (old) =>
      rebuilt(old, 'majmaah-stadium-7k-rb', (t) => {
        const [tier] = t.tiers;
        const mainHalf = 46.75;
        const oppHalf = 57;
        const mainStairs = [4.25, 12.75, 21.25, 29.75, 38.25];
        const oppStairs = [0, 14.1, 28.2, 42.3, 50.1];
        const pair = (at: number) => [at - 1.7, at + 1.7];
        const upVoms = [...pair(21.25), ...pair(38.25), 11.05];
        // Left to right facing each stand from the pitch.
        const front = ['Block 8', 'Block 7', 'Block 6', 'Block 5', 'Silver C', 'Silver B', 'Silver A', 'Block 4', 'Block 3', 'Block 2', 'Block 1'];
        const back = Array.from({ length: 11 }, (_, k) => `Block ${19 - k}`);
        const opp = Array.from({ length: 8 }, (_, k) => `Block ${27 - k}`);
        return {
          tiers: [
            {
              ...tier,
              rows: 29,
              stands: (tier.stands ?? []).map((st) => (st.side === 'north' ? { ...st, halfLength: oppHalf, rows: 10 } : { ...st, halfLength: mainHalf })),
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'south', at: mainStairs, mirror: true },
                  { side: 'north', at: oppStairs, mirror: true },
                ],
                walkways: [{ row: 14, side: 'south' }],
                openings: [{ side: 'south', at: upVoms, mirror: true, width: 2.0, rows: [15, 18], kind: 'vomitory' }],
                areas: [
                  // The players' tunnel at the front, and the glass VIP lounge over it.
                  { side: 'south', from: -2.2, to: 2.2, rows: [0, 3], kind: 'platform' },
                  { side: 'south', from: -5.5, to: 5.5, rows: [9, 13], kind: 'press' },
                  // The wheelchair platforms at the ends of the stand opposite.
                  { side: 'north', from: -oppHalf, to: -50.7, rows: [0, 9], kind: 'platform' },
                  { side: 'north', from: 50.7, to: oppHalf, rows: [0, 9], kind: 'platform' },
                ],
                names: [
                  { side: 'south', band: 0, names: front },
                  { side: 'south', band: 1, names: back },
                  { side: 'north', names: opp },
                ],
              },
            },
          ],
          // The new main stand is 23 m deep: its roof and the building behind it go back with it.
          roofs: (t.roofs ?? []).map((r) =>
            r.side === 'south'
              ? { ...r, from: -mainHalf - 1, to: mainHalf + 1, back: 32, front: 19, backY: 16.8, frontY: 16.0, columns: r.columns ? { ...r.columns, offset: 31.5 } : r.columns }
              : { ...r, from: -oppHalf + 2, to: oppHalf - 2, back: 8.6, front: 3.5, backY: 7.6, frontY: 7.2, columns: r.columns ? { ...r.columns, offset: 8.2 } : r.columns },
          ),
          seatLook: {
            colors: [{ c: '#e8e2d4', w: 5 }, { c: '#d8d0bf', w: 3 }],
            regions: [
              // The silver seats in the middle of the main stand's front band.
              { side: 'south', from: -12.75, to: 12.75, rows: [0, 13], colors: ['#8fc7cf', '#7fb9c3'] },
              // Red, pink and white in clumps across the stand opposite.
              { side: 'north', colors: [{ c: '#c8242f', w: 4 }, { c: '#f2f2f0', w: 4 }, { c: '#e27a96', w: 2 }], grain: { along: 1.5, rows: 2 } },
            ],
          },
          details: {
            ...t.details,
            buildings: (t.details?.buildings ?? []).map((bd) => (bd.side === 'south' ? { ...bd, front: 32 } : bd)),
          },
        };
      }),
  },
};