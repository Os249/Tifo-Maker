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
    //   - every stand is cut only at its gates, one stairway hard against
    //     each gate, so the blocks are tall plain fields of seats;
    //   - the blocks are all the same width: 43 seats across, with a short
    //     block of 16 against each corner;
    //   - the side stands have six gates a third of the way up, 18 rows,
    //     their first row barely above the pitch behind a 1 m wall; the ends
    //     four gates at the foot, each between two stairways, 14 rows on a
    //     wall 3.4 m high, so the tops of all four stands line up;
    //   - the players' tunnel comes out under the Z, its roof at the fourth
    //     row; the Z itself is three black bars on a white field filling the
    //     middle block from the seventh row to the sixteenth, two white rows
    //     above it; the mosaic grades from black at the top to white at the
    //     bottom everywhere else.
    // Forty-three seats to a block only fits inside the real bowl (the
    // mapped grass is 114 x 79 m and the walls stand 5-9 m off the pitch) at
    // a 0.36 m seat pitch, which is also what the tunnel mouth and the front
    // wall in the photographs give; the seats are drawn that wide.
    const PITCH = 0.36;
    const BLOCK = 43 * PITCH; // 15.48 m
    const OUTER = 16 * PITCH; // the short block against each corner, 5.76 m
    const GATE = 1.6; // clear, between its walls
    const STAIR = 0.8;
    // Sides: block | stair gate | block | stair gate | block | stair gate | outer.
    const SIDE_UNIT = STAIR + GATE;
    const SIDE_HL = Math.round((BLOCK * 2.5 + 3 * SIDE_UNIT + OUTER) * 10) / 10; // 51.7
    // Ends: block | stair gate stair | block | stair gate stair | outer (and mirrored).
    const END_UNIT = STAIR + GATE + STAIR;
    const END_HL = Math.round((BLOCK * 1.5 + 2 * END_UNIT + OUTER) * 10) / 10; // 35.4
    const r1 = (x: number) => Math.round(x * 10) / 10;
    // Gate centres, measured from the middle of the stand, and the stairways.
    // The photographs show the whole gate column free of seats from the
    // front wall to the back — the stairway beside it, the steps down from
    // the gate, the way down to it from the rows above — so each unit is
    // laid as a run of 0.8 m aisles side by side across its full width, and
    // the gate's mouth sits in that run.
    const sideGates = [0, 1, 2].map((k) => r1(BLOCK / 2 + k * (BLOCK + SIDE_UNIT) + STAIR + GATE / 2));   // 9.3, 27.2, 45.1
    const endGates = [0, 1].map((k) => r1(BLOCK / 2 + k * (BLOCK + END_UNIT) + END_UNIT / 2));              // 9.3, 28.0
    const unitAisles = (starts: number[], width: number) =>
      starts.flatMap((x0) => {
        const at: number[] = [];
        for (let x = x0 + STAIR / 2; x < x0 + width - STAIR / 2 - 0.05; x += STAIR) at.push(r1(x));
        at.push(r1(x0 + width - STAIR / 2));
        return at;
      });
    const sideStairs = unitAisles([0, 1, 2].map((k) => BLOCK / 2 + k * (BLOCK + SIDE_UNIT)), SIDE_UNIT);
    const endStairs = unitAisles([0, 1].map((k) => BLOCK / 2 + k * (BLOCK + END_UNIT)), END_UNIT);
    // Half the Z block in u: its seats run to ±(BLOCK/2 - a seat); the next block begins a stairway and a gate further on.
    const Z_HALF_U = 0.017;
    const lower: TierSpec = {
      rows: 18, rowDepth: 0.78, rakeDeg: 29, baseElevation: 1.3, baseOffset: 1, seatPitch: PITCH, straight: true,
      stands: [
        { side: 'south', halfLength: SIDE_HL, rows: 17 },
        { side: 'north', halfLength: SIDE_HL, rows: 18 },
        { side: 'east', halfLength: END_HL, rows: 14, elevation: 2.1 },
        { side: 'west', halfLength: END_HL, rows: 14, elevation: 2.1 },
      ],
    };
    // The main stand's gallery: a parapet walk with five rows behind it,
    // over the back of the lower tier, the boxes' glazing behind that.
    const gallery: TierSpec = {
      rows: 5, rowDepth: 0.8, rakeDeg: 30, baseElevation: 9.6, baseOffset: 16.4, seatPitch: 0.45, straight: true,
      stands: [{ side: 'south', halfLength: 50, rows: 5 }],
    };
    const gate = (side: Side, at: number[], rows: [number, number]): SeatOpening => ({ side, at, mirror: true, width: GATE, rows, kind: 'vomitory' });
    const gates = [
      gate('south', sideGates, [5, 8]), gate('north', sideGates, [5, 8]),
      gate('east', endGates, [1, 3]), gate('west', endGates, [1, 3]),
    ];
    const stairs = [
      { side: 'south' as const, at: sideStairs, mirror: true }, { side: 'north' as const, at: sideStairs, mirror: true },
      { side: 'east' as const, at: endStairs, mirror: true }, { side: 'west' as const, at: endStairs, mirror: true },
    ];
    // The players' tunnel under the Z: through the front four rows of the
    // stand opposite the main one into a portal that stands proud of the
    // front wall, a railed flat roof at the fourth row, a dark mouth.
    const tunnel: SeatOpening = { side: 'north', at: [0], width: 3.2, rows: [0, 3], kind: 'tunnel' };
    const openings = [...gates, tunnel];
    const portal: StandBuilding[] = [
      { side: 'north', straight: true, center: 0, halfLength: 2.1, front: 0.3, depth: 4.6, y0: 0, y1: 3.5, color: 0xd9d7d1, fascia: 0xe6e4df, railing: { height: 1.0, color: 0x26282c } },
      { side: 'north', straight: true, center: 0, halfLength: 1.4, front: 0.22, depth: 0.1, y0: 0, y1: 2.9, color: 0x0b0c0e, fascia: 0x0b0c0e },
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
        { ...lower, blocks: { width: STAIR, aisles: stairs, openings } },
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
          { tiers: [0], side: 'south', from: -(SIDE_HL + 0.5), to: SIDE_HL + 0.5, rows: [0, 8], colors: [{ c: '#cfc4aa', w: 0.52 }, { c: '#eceade', w: 0.33 }, { c: '#23252a', w: 0.15 }] },
          { tiers: [0], rows: [15, 17], colors: [{ c: '#1b1d20', w: 0.82 }, { c: '#e9ebee', w: 0.12 }, { c: '#b7bbc0', w: 0.06 }] },
          { tiers: [0], rows: [12, 14], colors: [{ c: '#1b1d20', w: 0.55 }, { c: '#e9ebee', w: 0.3 }, { c: '#b7bbc0', w: 0.15 }] },
          { tiers: [0], rows: [8, 11], colors: [{ c: '#1b1d20', w: 0.3 }, { c: '#e9ebee', w: 0.5 }, { c: '#b7bbc0', w: 0.2 }] },
          // The gallery, black like the top of the bowl.
          { tiers: [1], colors: [{ c: '#1b1d20', w: 0.8 }, { c: '#e9ebee', w: 0.2 }] },
        ],
        text: [
          // The club's Z: three black bars on a white field, filling the
          // middle block of the stand opposite the main one (the real east)
          // from the seventh row to the sixteenth, edge to edge, two white
          // rows above it.
          { text: 'Z', shape: 'zed', color: '#0c0d0f', ground: '#eceef0', tier: 0, centerU: 0.25, halfU: Z_HALF_U, rows: [6, 15] },
          { text: '', shape: 'zed', color: '#eceef0', ground: '#eceef0', tier: 0, centerU: 0.25, halfU: Z_HALF_U, rows: [16, 17] },
        ],
      },
      details: {
        // The white shell round the bowl — the complex's outer wall, whose
        // main-stand side is the complex's own building, below.
        skins: [{ offset: 19.5, y0: 0, y1: TOP + 0.4, color: 0xeceae5, pattern: 'panels', tile: [6, 4], omit: [{ side: 'south', from: -(SIDE_HL + 1.5), to: SIDE_HL + 1.5 }] }],
        buildings: [
          ...corners,
          ...portal,
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
