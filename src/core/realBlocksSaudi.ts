import type { RealBlocksLayout } from './realBlocks';
import type { SeatOpening, StandSide } from './types';
import { atStairs, endCornerStation, rebuilt, ringStairs } from './realBlocks';
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
        const sideVoms = [20.5, 35.2, 45.7, 62.3, 72.6];
        const oppVoms = [5.25, ...sideVoms];
        const endVoms = [6.4, 16.9, 32.4, 39.2];
        const voms = (side: StandSide, at: number[]): SeatOpening => ({ side, at, mirror: true, width: 2.4, rows: [8, 11], kind: 'vomitory' });
        return {
          tiers: [
            {
              ...bowl,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'south', at: [0, 14, ...sideVoms], mirror: true },
                  { side: 'north', at: oppVoms, mirror: true },
                  { side: 'east', at: endVoms, mirror: true },
                  { side: 'west', at: endVoms, mirror: true },
                ],
                openings: [voms('south', sideVoms), voms('north', oppVoms), voms('east', endVoms), voms('west', endVoms)],
              },
            },
          ],
        };
      }),
  },

  // Prince Faisal bin Fahd Stadium. Only four small photographs of it are to
  // be had (StadiumDB, 575 px wide), too small to solve a camera from, so its
  // rhythm is counted off them rather than measured: in the end under the
  // screen (no. 2) a stair on the centre line and every 14 m out from it, and
  // a lit vomitory half way up in the middle of each block between them; the
  // long sides the same (nos. 1 and 3). The upper tier over the stand
  // opposite has its stairs over the lower tier's and is entered from the
  // front, between them.
  'pfbf-stadium-22k': {
    id: 'pfbf-stadium-22k-rb',
    build: (old) =>
      rebuilt(old, 'pfbf-stadium-22k-rb', (t) => {
        const [bowl, upper] = t.tiers;
        const sides = ['north', 'south', 'east', 'west'] as const;
        const corner = (side: StandSide): number => cornerStation(t, bowl, side) - 2;
        const full = (side: StandSide): number[] => rhythm(14, false, corner(side));
        const half = (side: StandSide): number[] => rhythm(14, true, corner(side));
        const upStairs = rhythm(14, false, (upper.stands?.[0]?.halfLength ?? 75) - 3);
        return {
          tiers: [
            {
              ...bowl,
              blocks: {
                width: 1.2,
                aisles: sides.map((side) => ({ side, at: full(side), mirror: true })),
                // Five rows: the headroom of a passage coming up under a 26° rake.
                openings: sides.map((side) => ({ side, at: half(side), mirror: true, width: 2.4, rows: [7, 11] as [number, number], kind: 'vomitory' as const })),
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

  // EGO Stadium. Only two photographs of the rebuilt ground are to be had
  // (StadiumDB nos. 1 and 2, the club's drone views), both from far off, and
  // under the fabric vaults the stairs barely show. What does show, in the end
  // seen from behind the main stand's far corner at dusk (no. 2, scaled from
  // the goal), is a vomitory in the front half of the rake 7.7 m to the main
  // stand's side of the goal and another 25.7 m on: so a vomitory every
  // 25.7 m, each with a stair through it, and a stair half way between. The
  // stand opposite and the corners are given the same rhythm, centred on the
  // middle; the 1983 main stand a stair every 12.85 m from its centre line.
  'ego-stadium-13k': {
    id: 'ego-stadium-13k-rb',
    build: (old) =>
      rebuilt(old, 'ego-stadium-13k-rb', (t) => {
        const [u, main] = t.tiers;
        const step = 12.85;
        // The ends: from -20.55 (the first stair past the open corner) on round to the far corner.
        const ends = [-20.55, -7.7, 5.15, 18, 30.85, 37, 41.5];
        const endVoms = [-7.7, 18];
        // The corners are tight on the front row and fan out behind: a stair on
        // the diagonal and one either side of it.
        const opp = [0, 12.85, 25.7, 38.55, 49.5, 52.8];
        const oppVoms = [12.85, 38.55];
        const vom = (side: StandSide, at: number[], mirror: boolean): SeatOpening => ({ side, at, mirror, width: 2.4, rows: [4, 7], kind: 'vomitory' });
        return {
          tiers: [
            {
              ...u,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'east', at: ends },
                  { side: 'west', at: ends },
                  { side: 'north', at: opp, mirror: true },
                ],
                openings: [vom('east', endVoms, false), vom('west', endVoms, false), vom('north', oppVoms, true)],
              },
            },
            { ...main, blocks: { width: 1.1, aisles: [{ side: 'south', at: rhythm(step, false, (main.stands?.[0]?.halfLength ?? 72) - 6), mirror: true }] } },
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

  // Al-Hazem Club Stadium. One photograph of it on Wikimedia Commons ("Al-Hazm
  // Club Stadium", from behind a goal along the main stand), from before the
  // 2019 reseating, which kept the stand: the VIP box in the middle of its
  // upper rows, and two stairs either side of it, the outer blocks the width
  // of the inner. The curved terraces round the corners are seen in the
  // satellite picture only, a stair every 12 m along them.
  'alhazem-stadium-8k': {
    id: 'alhazem-stadium-8k-rb',
    build: (old) =>
      rebuilt(old, 'alhazem-stadium-8k-rb', (t) => {
        const [terraces, main] = t.tiers;
        return {
          tiers: [
            {
              ...terraces,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'west', at: [-34, -22, -10, 0] },
                  { side: 'east', at: [-34] },
                  { side: 'south', at: [57, 66], mirror: true },
                ],
              },
            },
            {
              ...main,
              blocks: {
                width: 1.1,
                aisles: [
                  { side: 'south', at: [9, 23.5, 37], mirror: true },
                  // Down the middle of the rows below the box, to the tunnel.
                  { side: 'south', at: [0], rows: [0, 8] },
                ],
                // The VIP box, in the middle of the upper rows.
                areas: [{ side: 'south', from: -9, to: 9, rows: [9, main.rows - 1], kind: 'platform' }],
              },
            },
          ],
        };
      }),
  },

  // King Khalid Sport City Stadium, Tabuk. No photograph of its stands near
  // enough to read is to be had (the August 2025 ones of the works are from
  // the far side of the track); the main stand curving round from bend to
  // bend is laid out on the rhythm its roof bays keep in the satellite
  // picture, a stair every 13 m from the centre line, and the movable stand
  // opposite in its four sections, a stair between each.
  'tabuk-stadium-12k': {
    id: 'tabuk-stadium-12k-rb',
    build: (old) =>
      rebuilt(old, 'tabuk-stadium-12k-rb', (t) => {
        const [main, opp] = t.tiers;
        const half = opp.stands?.[0]?.halfLength ?? 56;
        return {
          tiers: [
            {
              ...main,
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'south', at: [0, 13, 26, 39, 52, 61, 68], mirror: true },
                  { side: 'east', at: [-40, -31, -22] },
                  { side: 'west', at: [-40, -31, -22] },
                ],
                walkways: [{ row: 12 }],
                openings: [{ side: 'south', at: [6.5, 19.5, 32.5, 45.5], mirror: true, width: 2.4, rows: [13, 15], kind: 'vomitory' }],
              },
            },
            { ...opp, blocks: { width: 1.2, aisles: [{ side: 'north', at: [0, half / 2], mirror: true }, { side: 'north', at: [half / 4, (3 * half) / 4], mirror: true }] } },
          ],
        };
      }),
  },

  // Al-Majma'ah Sports City Stadium. From the satellite pictures (Bing), in
  // which the stairs show as pale lines across both stands: the main stand a
  // stair every 12 m either side of the VIP seats in its middle, the long low
  // stand opposite every 12 m from the centre line.
  'majmaah-stadium-7k': {
    id: 'majmaah-stadium-7k-rb',
    build: (old) =>
      rebuilt(old, 'majmaah-stadium-7k-rb', (t) => {
        const [tier] = t.tiers;
        return {
          tiers: [
            {
              ...tier,
              // The published 6,844 with these stairs: seats 0.478 m apart.
              seatPitch: 0.478,
              blocks: {
                width: 1.2,
                aisles: [
                  { side: 'south', at: [6, 18, 30, 42], mirror: true },
                  { side: 'north', at: rhythm(12, false, 66), mirror: true },
                ],
              },
            },
          ],
        };
      }),
  },
};