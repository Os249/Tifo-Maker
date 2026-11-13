/**
 * Iraq: the Iraq Stars League's first ground, 2026-27 — Al-Zawraa SC's new
 * home in Utayfia, Karkh, Baghdad, by the Tigris: the ground of the most
 * decorated club in Iraq (Al-Nawaris, the Gulls), rebuilt 2012-2022 and
 * opened on 15 February 2022. Asked for by the club's own ultras, whose
 * Tifo Maker banner flew at the derby against Al-Shorta.
 *
 * Built the same way as the other countries' grounds (see ligue1.ts): the
 * club's photographs, the StadiumDB description, the GEG project sheet and
 * the published capacity (15,443), and the real blocks from the start. The
 * engine's frame: the main stand (real west, under the sports complex's
 * building) south (-z), the ends east (+x, on your right as you face the
 * main stand from the pitch — the real north end) and west (-x).
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { SeatOpening, StandBuilding, TierSpec } from './types';
import { lazyEntry } from './lazyEntry';

const IQ = 'iraq-stars-league';

type Side = 'north' | 'south' | 'east' | 'west';

export const IRAQ_STARS_LEAGUE: StadiumEntry[] = [
  lazyEntry('al-zawraa-15k', { name: 'Al-Zawraa Stadium (Baghdad)', source: 'builtin', country: 'Middle East', capacity: 15443, type: 'Single-tier', inspiredBy: 'Al-Zawraa Stadium, Utayfia, Karkh, Baghdad - home of Al-Zawraa SC', tags: ['al-zawraa', 'zawraa', 'nawaris', 'al-nawaris', 'gulls', 'baghdad', 'utayfia', 'karkh', 'iraq', 'ultras', IQ] }, () => {
    // Al-Zawraa Stadium, Utayfia, Baghdad — a compact rectangle in a dense
    // residential quarter near the Tigris, inside the white shell of the
    // Al-Zawraa sports complex. Four covered straight stands, held together
    // by four solid corner blocks (the Bessa/Nîmes pattern): each block a
    // concrete tower filling its corner from the stands' front line back to
    // the shell, a flat angled face to the pitch with a doorway at its foot,
    // its top at the roofs, which die onto it; a video screen hung on two of
    // them. Each stand under its own flat steel-truss roof with the
    // floodlights in rows along its edge. The main stand (real west) is -z
    // here, the complex's building behind it: the lower tier plus a narrow
    // gallery with the boxes behind, the only second storey in the ground.
    //
    // Counted off the ultras' photographs (November 2026), seat by seat:
    //   - every stand is cut only at its gates, and each gate is a cross:
    //     one stairway from the front wall to the back row, a wide low gate
    //     across it, so the blocks are tall plain fields of seats;
    //   - the blocks are all the same width: 43 seats across, with a shorter
    //     block against each corner;
    //   - the side stands have six gates and 27 rows (12 below the gates,
    //     five beside them, 10 above), their first row barely above the pitch
    //     behind a 1 m wall; the ends four gates at the foot and 15 rows on a
    //     wall 3.4 m high, their tops a little below the sides';
    //   - the players' tunnel comes out under the Z, its roof at the eighth
    //     row; the Z itself is three black bars, each three rows thick, on a
    //     white field filling the middle block from the eighth row to the
    //     twenty-fourth, three white rows above it; the mosaic grades from
    //     black at the top to white at the bottom everywhere else.
    // The rows are close: a seat in the photographs is 13 px wide and a row
    // 10.5 px tall, so the rise is four fifths of the seat pitch.
    // Forty-three seats to a block only fits inside the real bowl (the
    // mapped grass is 114 x 79 m and the walls stand 5-9 m off the pitch) at
    // a 0.36 m seat pitch, which is also what the tunnel mouth and the front
    // wall in the photographs give; the seats are drawn that wide.
    const PITCH = 0.36;
    // The way in is a cross (the ultras' own word for it): one stairway three
    // seats wide from the front wall to the back row, and across it a low,
    // wide gate - a white flat-roofed box 2.7 m across with the landing either
    // side of it, 13 seats and five rows of the stand in all. On the side
    // stands the crossing is just above half-way up (12 rows below it, 10
    // above, of 27); on the ends it is at the foot.
    const VOID = 5.0; // the gate and its landings, along the row
    const BOX = 2.7; // the gate itself
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const SIDE_HL = 51.7;
    const END_HL = 35.4;
    // The generator lays each stand's seats on one even grid, its pitch the
    // stand's length over a whole even number of seats: 286 on a side, 196
    // on an end. A block of 43 in the middle of a stand needs a seat on the
    // centre line, so each stand sits half a seat off centre and the one
    // seat that leaves over at its far end is taken out (END_TRIM).
    const PS = (2 * SIDE_HL) / 286; // 0.3615
    const PE = (2 * END_HL) / 196;  // 0.3612
    // Counting seats from the centre line: the middle block is seats -21..21,
    // a stairway on 22-24, a block on 25-67, a stairway on 68-70, and so on;
    // the outer block against each corner is what is left, 26 seats on a
    // side and 27 on an end. Each gate sits on its stairway.
    const sideGates = [23, 69, 115].map((k) => k * PS); // 8.32, 24.95, 41.58
    const endGates = [23, 69].map((k) => k * PE);       // 8.31, 24.92
    const STAIR_S = 3 * PS;
    const STAIR_E = 3 * PE;
    const SIDE_ROWS: [number, number] = [12, 16];
    const END_ROWS: [number, number] = [0, 4];
    // Half the Z block in u: its seats run to 21 either side of the centre line; the next block begins three seats further on.
    const Z_HALF_U = 0.021;
    const ROW = 0.52; // 27 rows in the 14 m the stand is deep
    const lower: TierSpec = {
      rows: 27, rowDepth: ROW, rakeDeg: 29, baseElevation: 1.3, baseOffset: 1, seatPitch: PITCH, straight: true,
      stands: [
        { side: 'south', halfLength: SIDE_HL, center: PS / 2, rows: 26 },
        { side: 'north', halfLength: SIDE_HL, center: PS / 2, rows: 27 },
        { side: 'east', halfLength: END_HL, center: PE / 2, rows: 15, elevation: 2.1 },
        { side: 'west', halfLength: END_HL, center: PE / 2, rows: 15, elevation: 2.1 },
      ],
    };
    // The main stand's gallery: a parapet walk with five rows behind it,
    // over the back of the lower tier, the boxes' glazing behind that.
    const gallery: TierSpec = {
      rows: 5, rowDepth: 0.8, rakeDeg: 30, baseElevation: 9.6, baseOffset: 16.4, seatPitch: 0.45, straight: true,
      stands: [{ side: 'south', halfLength: 50, rows: 5 }],
    };
    const gate = (side: Side, at: number[], rows: [number, number]): SeatOpening => ({ side, at, mirror: true, width: VOID, mouth: BOX, rows, kind: 'vomitory' });
    const gates = [
      gate('south', sideGates, SIDE_ROWS), gate('north', sideGates, SIDE_ROWS),
      gate('east', endGates, END_ROWS), gate('west', endGates, END_ROWS),
    ];
    const END_TRIM = 0.3;
    const stairs = [
      { side: 'south' as const, at: sideGates, mirror: true, width: STAIR_S }, { side: 'north' as const, at: sideGates, mirror: true, width: STAIR_S },
      { side: 'east' as const, at: endGates, mirror: true, width: STAIR_E }, { side: 'west' as const, at: endGates, mirror: true, width: STAIR_E },
      { side: 'south' as const, at: [SIDE_HL], mirror: true, width: END_TRIM }, { side: 'north' as const, at: [SIDE_HL], mirror: true, width: END_TRIM },
      { side: 'east' as const, at: [END_HL], mirror: true, width: END_TRIM }, { side: 'west' as const, at: [END_HL], mirror: true, width: END_TRIM },
    ];
    // The gate boxes: a white flat roof over the crossing, a dark mouth
    // under it facing the pitch.
    const RISE = ROW * Math.tan((29 * Math.PI) / 180);
    const boxes = (side: Side, at: number[], rows: [number, number], base: number): StandBuilding[] =>
      at.flatMap((x) => [x, -x]).flatMap((x) => {
        const front = 1 + (rows[0] - 0.5) * ROW;
        const y0 = base + (rows[0] - 0.5) * RISE;
        const y1 = base + (rows[1] + 0.5) * RISE + 0.6; // its roof clear of the cards held up in the rows in front
        return [
          { side, straight: true, center: x, halfLength: BOX / 2, front: front + 0.25, depth: (rows[1] - rows[0] + 1) * ROW - 0.3, y0, y1, color: 0xf4f3ef, fascia: 0xffffff },
          { side, straight: true, center: x, halfLength: BOX / 2 - 0.25, front: front + 0.18, depth: 0.08, y0, y1: y1 - 0.35, color: 0x0b0c0e, fascia: 0x0b0c0e },
        ];
      });
    const gateBoxes: StandBuilding[] = [
      ...boxes('south', sideGates, SIDE_ROWS, 1.3), ...boxes('north', sideGates, SIDE_ROWS, 1.3),
      ...boxes('east', endGates, END_ROWS, 3.4), ...boxes('west', endGates, END_ROWS, 3.4),
    ];
    // The players' tunnel under the Z: through the front seven rows of the
    // stand opposite the main one into a portal that stands proud of the
    // front wall, a railed flat roof at the eighth row, a dark mouth.
    const tunnel: SeatOpening = { side: 'north', at: [0], width: 3.2, rows: [0, 6], kind: 'tunnel' };
    const openings = [...gates, tunnel];
    const portal: StandBuilding[] = [
      { side: 'north', straight: true, center: 0, halfLength: 1.75, front: 0.3, depth: 4.4, y0: 0, y1: 3.35, color: 0xd9d7d1, fascia: 0xe6e4df, railing: { height: 1.0, color: 0x26282c } },
      { side: 'north', straight: true, center: 0, halfLength: 1.3, front: 0.22, depth: 0.1, y0: 0, y1: 2.75, color: 0x0b0c0e, fascia: 0x0b0c0e },
    ];
    // The corner blocks: one solid wedge per corner, from the stands' front
    // line (plan offset 1.3) back to the shell (19.5), two ring buildings
    // meeting a little past the 45° point so there is no seam, their tops at
    // the roofs. Precast panels with their joints every 3 m, a dark railing
    // along the top, a ledge across the face at the stands' top-walkway
    // level, a dark doorway at the foot of each face.
    const A = 59;
    const B = 40.5;
    const DIAG = Math.pow(0.5, 1 / 14); // where the 45° point of the plan sits, as a fraction of a and b
    const CS: [number, number] = [SIDE_HL, r1(A * DIAG + 1.4)]; // the block's run along a side, from the stand's end past the 45° point
    const CE: [number, number] = [END_HL, r1(B * DIAG + 1.6)];
    const DOOR_AT = r1(A * DIAG + 0.4);
    const TOP = 13.6;
    const WALK = 9.0; // the stands' top walkway, 1.3 + 18 rows' rise
    const BLK = { front: 1.3, depth: 18.2, y0: 0, y1: TOP, color: 0xdcdbd6, fascia: 0xe9e8e3, joints: 3, railing: { height: 1.1, color: 0x26282c } } as const;
    const corner = (side: Side, from: number, to: number): StandBuilding => ({ side, center: (from + to) / 2, halfLength: Math.abs(to - from) / 2, ...BLK });
    const ledge = (side: Side, from: number, to: number): StandBuilding => ({ side, center: (from + to) / 2, halfLength: Math.abs(to - from) / 2, front: 1.05, depth: 0.25, y0: WALK - 0.4, y1: WALK, color: 0xc9c7c1, fascia: 0xe9e8e3 });
    const door = (side: Side, at: number): StandBuilding => ({ side, center: at, halfLength: 2, front: 1.1, depth: 0.3, y0: 0, y1: 3.4, color: 0x15171a, fascia: 0x15171a });
    const corners: StandBuilding[] = [
      corner('south', CS[0], CS[1]), corner('east', -CE[1], -CE[0]), ledge('south', CS[0], CS[1]), ledge('east', -CE[1], -CE[0]), door('south', DOOR_AT),
      corner('south', -CS[1], -CS[0]), corner('west', -CE[1], -CE[0]), ledge('south', -CS[1], -CS[0]), ledge('west', -CE[1], -CE[0]), door('south', -DOOR_AT),
      corner('north', CS[0], CS[1]), corner('east', CE[0], CE[1]), ledge('north', CS[0], CS[1]), ledge('east', CE[0], CE[1]), door('north', DOOR_AT),
      corner('north', -CS[1], -CS[0]), corner('west', CE[0], CE[1]), ledge('north', -CS[1], -CS[0]), ledge('west', CE[0], CE[1]), door('north', -DOOR_AT),
    ];
    const ROOF = { style: 'sheet' as const, straight: true, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058 };
    return {
      id: 'al-zawraa-15k',
      name: 'Al-Zawraa Stadium (Baghdad)',
      version: 1,
      levels: 2,
      plan: { a: A, b: B, exponent: 14 },
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: STAIR_S, aisles: stairs, openings } },
        { ...gallery, blocks: { width: 1.0, aisles: [{ side: 'south', at: [6, 18, 30, 42], mirror: true }] } },
      ],
      aisles: { count: 36, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        // Four flat truss roofs, one per stand, 4 m over the top rows; the
        // main stand's higher, over its gallery and boxes; the ends' run on
        // over the corner blocks, as the photographs show.
        { ...ROOF, side: 'south', from: -(SIDE_HL + 1.5), to: SIDE_HL + 1.5, back: 24, front: 3, backY: 17.4, frontY: 16, columns: { every: 10.4, offset: 23.3, color: 0xd6d8da }, lights: { every: 4.5, y: 16.3 } },
        { ...ROOF, side: 'north', from: -(SIDE_HL + 1.5), to: SIDE_HL + 1.5, back: 17.5, front: 2.5, backY: TOP + 0.6, frontY: TOP - 0.8, columns: { every: 10.4, offset: 16.8, color: 0xd6d8da }, lights: { every: 4.5, y: TOP - 0.5 } },
        { ...ROOF, side: 'east', from: -(CE[1] + 0.6), to: CE[1] + 0.6, back: 17.5, front: 2.5, backY: TOP + 0.6, frontY: TOP - 0.8, columns: { every: 10, offset: 16.8, color: 0xd6d8da }, lights: { every: 4.5, y: TOP - 0.5 } },
        { ...ROOF, side: 'west', from: -(CE[1] + 0.6), to: CE[1] + 0.6, back: 17.5, front: 2.5, backY: TOP + 0.6, frontY: TOP - 0.8, columns: { every: 10, offset: 16.8, color: 0xd6d8da }, lights: { every: 4.5, y: TOP - 0.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0xc9c7c2, walls: 0xd8d6d0 }, // the pale precast of the gate columns and walls
      facade: { style: 'cladding', color: 0xe9e7e1, accent: 0xc8c5bd },
      runoff: { color: 0x2f7a3a, a: A - 0.5, b: B - 0.5, exponent: 14 },
      seatLook: {
        // The black-and-white mosaic, seat by seat, grading from black at the
        // top to white at the bottom as the photographs show it. Regions are
        // first-match, so the main stand's beige comes before the bands.
        colors: [{ c: '#e9ebee', w: 0.66 }, { c: '#b7bbc0', w: 0.22 }, { c: '#1b1d20', w: 0.12 }],
        regions: [
          // The main stand's beige padded seats across its lower half.
          { tiers: [0], side: 'south', from: -(SIDE_HL + 0.5), to: SIDE_HL + 0.5, rows: [0, 12], colors: [{ c: '#cfc4aa', w: 0.52 }, { c: '#eceade', w: 0.33 }, { c: '#23252a', w: 0.15 }] },
          { tiers: [0], rows: [23, 26], colors: [{ c: '#1b1d20', w: 0.82 }, { c: '#e9ebee', w: 0.12 }, { c: '#b7bbc0', w: 0.06 }] },
          { tiers: [0], rows: [18, 22], colors: [{ c: '#1b1d20', w: 0.55 }, { c: '#e9ebee', w: 0.3 }, { c: '#b7bbc0', w: 0.15 }] },
          { tiers: [0], rows: [12, 17], colors: [{ c: '#1b1d20', w: 0.3 }, { c: '#e9ebee', w: 0.5 }, { c: '#b7bbc0', w: 0.2 }] },
          // The gallery, black like the top of the bowl.
          { tiers: [1], colors: [{ c: '#1b1d20', w: 0.8 }, { c: '#e9ebee', w: 0.2 }] },
        ],
        text: [
          // The club's Z: three black bars on a white field, filling the
          // middle block of the stand opposite the main one (the real east)
          // from the eighth row to the twenty-fourth, edge to edge, three
          // white rows above it.
          { text: 'Z', shape: 'zed', color: '#0c0d0f', ground: '#eceef0', tier: 0, centerU: 0.25, halfU: Z_HALF_U, rows: [7, 23] },
          { text: '', shape: 'zed', color: '#eceef0', ground: '#eceef0', tier: 0, centerU: 0.25, halfU: Z_HALF_U, rows: [24, 26] },
        ],
      },
      details: {
        // The white shell round the bowl — the complex's outer wall, whose
        // main-stand side is the complex's own building, below.
        skins: [{ offset: 19.5, y0: 0, y1: TOP + 0.4, color: 0xeceae5, pattern: 'panels', tile: [6, 4], omit: [{ side: 'south', from: -(SIDE_HL + 1.5), to: SIDE_HL + 1.5 }] }],
        buildings: [
          ...corners,
          ...portal,
          ...gateBoxes,
          // The sports complex block behind the main stand (hotel, offices),
          // its glazed floors over the gallery.
          { side: 'south', straight: true, halfLength: SIDE_HL + 2, front: 21, depth: 14, y0: 0, y1: 17, glassFloors: 2, color: 0xe8e5de, fascia: 0xf2f0ea },
        ],
        // The video screens, bolted to the faces of two of the corner blocks
        // (real north-west and south-east corners) between the ledge and the
        // railing, flat to the block: no legs, no cables.
        screens: [
          { centerU: 0.8985, widthM: 5.5, heightM: 3.2, wall: { offset: -0.5, y: 11.5 } },
          { centerU: 0.3985, widthM: 5.5, heightM: 3.2, wall: { offset: -0.5, y: 11.5 } },
        ],
      },
      site: { key: 'al-zawraa', horizon: 'city', ground: 0xa89a7e, forecourt: 0xc0b6a2, palms: 0.35 },
      // The dugouts and the players' tunnel in front of the main stand (the
      // night photographs), and a second tunnel under the Z.
      pitchside: { dugouts: 'south' },
    };
  }),
  lazyEntry('al-shaab-36k', { name: 'Al-Shaab International Stadium (Baghdad)', source: 'builtin', country: 'Middle East', capacity: 35700, type: 'Oval', inspiredBy: 'Al-Shaab International Stadium, Rusafa, Baghdad - the national stadium, home of the Baghdad derbies', tags: ['al-shaab', 'shaab', 'alshaab', 'peoples-stadium', 'baghdad', 'rusafa', 'iraq', 'national-team', 'derby', 'clasico', 'al-zawraa', 'al-quwa-al-jawiya', 'al-shorta', 'al-talaba', 'track', 'horseshoe', 'ultras', IQ] }, () => {
    // Al-Shaab International Stadium, Baghdad (1966, Keil do Amaral and
    // Ramos; re-seated in blue and white in 2023) — the national stadium and
    // the ground of the Baghdad derbies. A blue 8-lane track with the
    // ground's name in white in both D-areas; round it, behind a dry moat, one
    // open horseshoe of terracing; and the roofed main stand (real west, -z
    // here) on its own between the horseshoe's tails. The pitch runs
    // north-south; the screen end (the real south) is -x.
    //
    // Surveyed November 2026 (docs/al-shaab-ground-2026-11.md) from the
    // user's photographs and the OpenStreetMap outlines:
    //   - the horseshoe's front row is 93 m (ends) by 66 m (side) from the
    //     centre spot; the stand is a crescent, 28 m deep along the side,
    //     about 25 m behind the goals and narrowing to a few rows at the tip
    //     of each tail, just inside the main stand's front line;
    //   - 13 vomitories, one on the centre line opposite the main stand and
    //     six each way, evenly spaced, each with one stairway; their mouths
    //     on rows 15 to 19;
    //   - about 42 rows along the side (three pixel counts on the aerial:
    //     40+, 43, 44), fewer block by block toward the tails;
    //   - the seats white at the front, blue at the top, a scattered mosaic;
    //   - the main stand 135 m long and 17 m deep: sky-blue rows down to the
    //     track behind a fence, a cross-walk with four vomitories, navy rows
    //     behind it under a flat roof with the floodlights along its edge,
    //     and the VIP block in the middle.
    // The seat width is not countable in the photographs: 0.45 m is used,
    // which with the counted rows and the vomitories' landings gives 33,722
    // seats against the published 35,700 (see verify.mts).
    // Fitted to where the 13 vomitories lie in the top-down photograph
    // (taken from about 100 m up, so what stands higher is pushed outward):
    // the plan, its exponent, the spacing and the vomitories' rows together.
    const A = 93;
    const B = 66;
    const P = 2.6;
    // 13 vomitories 25.2 m apart along the front row, and beyond the last
    // one a tail block about as long as the others.
    const STEP = 25.2;
    const voms = [0, 1, 2, 3, 4, 5, 6].map((k) => k * STEP);
    const VOM_ROWS: [number, number] = [14, 18];
    const TAIL = 47;
    const bowl: TierSpec = {
      rows: 42, rowDepth: 0.67, rakeDeg: 21, baseElevation: 2.0, baseOffset: 0, seatPitch: 0.45,
      // A crescent: its back edge is its own curve, centred 15 m toward the
      // far side, so the stand is 42 rows deep opposite the main stand, about
      // 38 behind the goals, 24 at the last vomitory, and beyond it a long
      // thin tail down to four or five rows at its tip - smaller block by
      // block the further round it comes. Fitted to the stand's depth at
      // eight places on the photographs (within 1.2 m). The tips end on
      // z = -TAIL, a few metres short of the main stand's corner.
      rim: { a: 116, b: B + (42 - 0.1) * 0.67 - 15, exponent: 2.4, z: 15 },
      omit: [{ side: 'south', from: -400, to: 400 }, { side: 'east', from: -400, to: -TAIL }, { side: 'west', from: -400, to: -TAIL }],
      // Each vomitory is a white concrete box: a dark mouth in a bare landing
      // seven metres wide, two more bare rows in front of it, and the one
      // stairway, two seats wide, running through it from the wall to the rim.
      blocks: {
        width: 1.7,
        aisles: [{ side: 'north', at: voms, mirror: true }],
        openings: [{ side: 'north', at: voms, mirror: true, width: 7, mouth: 3, rows: VOM_ROWS, kind: 'vomitory' }],
        areas: voms.flatMap((s) => (s === 0 ? [0] : [s, -s])).map((s) => ({ side: 'north' as const, from: s - 3.5, to: s + 3.5, rows: [VOM_ROWS[0] - 2, VOM_ROWS[0] - 1] as [number, number], kind: 'platform' as const })),
      },
    };
    // The main stand: 21 rows, a cross-walk on the thirteenth with the four
    // vomitories coming up behind it, 25 and 50 m either side of the centre
    // line; the middle 30 m is the VIP block, stepped up from the sixth row.
    // The roof covers only the rows behind the cross-walk.
    const MAIN_HL = 67;
    const MAIN_OFF = 51 - B; // its front row 51 m from the centre line
    const main: TierSpec = {
      rows: 21, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: MAIN_OFF, seatPitch: 0.5, straight: true,
      stands: [{ side: 'south', halfLength: MAIN_HL }],
      blocks: {
        width: 1.0,
        aisles: [{ side: 'south', at: [0, 7.5, 15, 25, 37.5, 50, 60], mirror: true }],
        walkways: [{ row: 12 }],
        openings: [{ side: 'south', at: [25, 50], mirror: true, width: 3.5, rows: [13, 15], kind: 'vomitory' }],
        areas: [{ side: 'south', from: -15, to: 15, rows: [6, 20], kind: 'press' }],
      },
    };
    const MAIN_RISE = 0.8 * Math.tan((25 * Math.PI) / 180);
    // The track's bend at the screen end is a circle of 46.3 m about
    // (-42.2, 0); the poles stand 1.6 m outside it, every 5 degrees.
    const IRAQ_FLAG = { bands: [0xce1126, 0xffffff, 0x111111] as [number, number, number], text: '\u0627\u0644\u0644\u0647 \u0623\u0643\u0628\u0631', textColor: 0x007a3d };
    const FLAGS: [number, number][] = [205, 210, 215, 220, 225, 230, 235, 240].map((d) => {
      const t = (d * Math.PI) / 180;
      return [Math.round((-42.2 + 47.9 * Math.cos(t)) * 10) / 10, Math.round(47.9 * Math.sin(t) * 10) / 10] as [number, number];
    });
    const WHITE = '#eef1f5';
    const BLUE = '#4585d6';
    const NAVY = '#1b3870';
    const SKY = '#7fa6d0';
    const TRACK = 0x2f80b8;
    return {
      id: 'al-shaab-36k',
      name: 'Al-Shaab International Stadium (Baghdad)',
      version: 1,
      levels: 1,
      plan: { a: A, b: B, exponent: P },
      evenRows: true,
      // The main stand first: a tier after the horseshoe would be given a
      // concourse over the horseshoe's back row on its side of the ground.
      tiers: [main, bowl],
      aisles: { count: 52, widthMeters: 1.2 },
      sectionsPerTier: 26,
      track: { lanes: 8, surface: TRACK, lines: 0xf2f4f6, lettering: { lines: ["ALSHA'AB", 'INTERNATIONAL STADIUM'], color: 0xffffff } },
      roof: { coverage: 'none' },
      roofs: [
        // The main stand's flat cantilever, the floodlights along its edge.
        // It reaches forward only as far as the cross-walk: the lower rows are in the sun.
        { style: 'slab', side: 'south', straight: true, from: -(MAIN_HL + 1.5), to: MAIN_HL + 1.5, back: MAIN_OFF + 22.5, front: MAIN_OFF + 9.5, backY: 14.0, frontY: 13.0, depth: 1.2, bay: 9, color: 0xe4e3de, underColor: 0x2a2d33, columns: { every: 9, color: 0xcfcdc6, offset: MAIN_OFF + 17.6 }, lights: { every: 3.2, y: 13.1 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5200, masts: { at: [[104, 80], [-104, 80], [86, -66], [-86, -66]], height: 52, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0xdfe1e3, walls: 0xeef0f1 }, // the terracing painted white in 2023
      facade: { style: 'concrete', color: 0xeceeef, accent: 0xf6f7f8, bayMeters: 7 },
      // The blue apron from the track out to the moat: behind the goals the
      // moat is only a couple of metres outside the track's last lane.
      runoff: { color: TRACK, a: A - 4, b: B - 4.2, exponent: P, moat: { width: 3.6 } },
      seatLook: {
        colors: [{ c: BLUE, w: 0.9 }, { c: WHITE, w: 0.1 }],
        regions: [
          // The horseshoe: white at the front, blue at the top, seat by seat.
          { tiers: [1], rows: [0, 9], colors: [{ c: WHITE, w: 0.93 }, { c: BLUE, w: 0.07 }] },
          { tiers: [1], rows: [10, 14], colors: [{ c: WHITE, w: 0.75 }, { c: BLUE, w: 0.25 }] },
          { tiers: [1], rows: [15, 18], colors: [{ c: WHITE, w: 0.5 }, { c: BLUE, w: 0.5 }] },
          { tiers: [1], rows: [19, 23], colors: [{ c: WHITE, w: 0.25 }, { c: BLUE, w: 0.75 }] },
          { tiers: [1], rows: [24, 41], colors: [{ c: BLUE, w: 0.92 }, { c: WHITE, w: 0.08 }] },
          // The main stand: sky blue in front of the cross-walk, navy behind it under the roof.
          { tiers: [0], rows: [0, 11], colors: [{ c: SKY, w: 0.94 }, { c: NAVY, w: 0.06 }] },
          { tiers: [0], colors: [{ c: NAVY, w: 0.95 }, { c: SKY, w: 0.05 }] },
        ],
      },
      details: {
        // The one big screen, on legs behind the top of the horseshoe at the
        // real south end, on the main stand's side of the axis.
        screens: [{ centerU: 0.56, widthM: 20, heightM: 10, at: [-114, -50], post: { y: 20 } }],
        // Eight flag poles round the south-west bend, just outside the last lane.
        // Iraq's flag (the default design, with its green script), and a plain white one every fourth pole.
        flagpoles: { at: FLAGS, height: 9, flags: [IRAQ_FLAG, IRAQ_FLAG, { bands: [0xffffff, 0xffffff, 0xffffff] }, IRAQ_FLAG] },
        buildings: [
          // The VIP block in the middle of the main stand, in two steps: a
          // glazed terrace from the sixth row, the boxes behind the cross-walk.
          { side: 'south', straight: true, center: 0, halfLength: 15, front: MAIN_OFF + 5.6 * 0.8, depth: 6 * 0.8, y0: 0, y1: 1.0 + 6 * MAIN_RISE + 3.0, glassFloors: 1, color: 0xd3d8de, fascia: 0xeef0f2 },
          { side: 'south', straight: true, center: 0, halfLength: 15, front: MAIN_OFF + 11.6 * 0.8, depth: 8, y0: 0, y1: 11.6, glassFloors: 1, color: 0xdfe1e4, fascia: 0xf3f4f5 },
          // The stand's own building behind it: offices and the press floor.
          { side: 'south', straight: true, halfLength: MAIN_HL, front: MAIN_OFF + 17.2, depth: 5, y0: 0, y1: 12.2, glassFloors: 1, color: 0xe3e4e6, fascia: 0xf0f1f2 },
        ],
      },
      site: { key: 'al-shaab', horizon: 'city', ground: 0xb3a78c, forecourt: 0xc6bfae, palms: 0.3 },
      // The blue barrel shelters on the outer lanes in front of the main
      // stand; the players come out through the stand, not a tunnel box.
      pitchside: { dugouts: 'south', tunnel: false, shelters: { color: 0x2a53b8, offset: 10.5 } },
    };
  }),
];
