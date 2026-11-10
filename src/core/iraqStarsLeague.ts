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
];
