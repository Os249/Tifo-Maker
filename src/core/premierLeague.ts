/**
 * The Premier League's grounds, 2026-27 — all twenty, as they stand this season.
 *
 * Each is built from the ground's OpenStreetMap footprint (pitch, stands and
 * their heights, © OpenStreetMap contributors, ODbL), Esri satellite pictures
 * and recent photographs, with the published capacity per stand. The frame is
 * the engine's: the main stand (tunnel, dugouts, directors' box) is south
 * (-z), the stand opposite north, the ends east (+x) and west (-x). Which real
 * compass side each one is on is in the comment above it.
 *
 * Seat maps are frozen once released (scripts/verify.mts): a change to a
 * ground's seats after that needs a new id.
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { Girder } from './types';

const PL = 'premier-league';

/** Liverpool's red, and the white the Kop's letters are picked out in. */
const LFC_RED = '#c8102e';

/**
 * A tubular arch over a side stand, as straight girder segments: across the
 * ground at z = `z`, reaching `span` metres either side of halfway, rising from `y0` at its feet to
 * `y1` at the crown.
 */
function ARCH(z: number, span: number, y0: number, y1: number): Girder[] {
  const out: Girder[] = [];
  const n = 10;
  const at = (i: number) => {
    const t = i / n;
    return { x: -span + 2 * span * t, y: y0 + (y1 - y0) * (1 - (2 * t - 1) ** 2) };
  };
  for (let i = 0; i < n; i++) {
    const p = at(i), q = at(i + 1);
    out.push({ from: [p.x, z], to: [q.x, z], y: p.y, yTo: q.y, height: 3.2, bay: 3.5, color: 0xf2f3f4 });
  }
  return out;
}

export const PREMIER_LEAGUE: StadiumEntry[] = [
  {
    // Anfield, Liverpool. The main stand is on the north-west side (-z here);
    // the Kop is the south-west end (-x), the Anfield Road Stand the north-east
    // end (+x) and the Sir Kenny Dalglish Stand the south-east side (+z).
    // Pitch 101 x 68 (OSM). Four separate stands: the main stand and the
    // Anfield Road Stand tall (~39 m), the Kop and the Dalglish lower.
    id: 'anfield-61k',
    template: {
      id: 'anfield-61k',
      name: 'Anfield (Liverpool)',
      version: 1,
      levels: 3,
      plan: { a: 55.5, b: 38.5, exponent: 16 },
      evenRows: true,
      tiers: [
        {
          // The lower tiers of the main stand, the Dalglish and the Anfield Road Stand.
          rows: 42, rowDepth: 0.78, rakeDeg: 24, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 42 },
            { side: 'north', halfLength: 55, rows: 31 },
            { side: 'east', halfLength: 55, rows: 34, offset: 0.5 },
          ],
        },
        {
          // The Kop: one great tier behind the goal.
          rows: 62, rowDepth: 0.74, rakeDeg: 33, baseElevation: 1.4, baseOffset: 0.5, seatPitch: 0.47, straight: true,
          stands: [{ side: 'west', halfLength: 54 }],
        },
        {
          // The main stand's middle tier, over the boxes.
          rows: 12, rowDepth: 0.85, rakeDeg: 28, baseElevation: 17.5, baseOffset: 35.5, seatPitch: 0.47, straight: true,
          stands: [{ side: 'south', halfLength: 70 }],
        },
        {
          // The upper tiers of the Dalglish and the Anfield Road Stand.
          rows: 40, rowDepth: 0.8, rakeDeg: 34, baseElevation: 16, baseOffset: 29, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'north', halfLength: 55, rows: 24, offset: -2, elevation: -1 },
            { side: 'east', halfLength: 64, rows: 40, offset: 1.5 },
          ],
        },
        {
          // The main stand's upper tier, added in 2016.
          rows: 30, rowDepth: 0.85, rakeDeg: 35, baseElevation: 26, baseOffset: 47, seatPitch: 0.47, straight: true,
          stands: [{ side: 'south', halfLength: 70 }],
        },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // The main stand's roof, high over the upper tier, hung from the great
        // truss that stands on it the length of the stand; clear panels at the front.
        { style: 'sheet', side: 'south', straight: true, from: -72, to: 72, back: 74, front: 37, backY: 46, frontY: 41, depth: 1.4, bay: 9, color: 0xd9dcdf, underColor: 0x55585d, glazing: 0.6, girder: { offset: 43, height: 7.5 }, lights: { every: 6, y: 41.5 } },
        // The Kop's cantilever.
        { style: 'sheet', side: 'west', straight: true, from: -54, to: 54, back: 49, front: 3, backY: 33.5, frontY: 27, bay: 9, color: 0xc9ccd0, underColor: 0x4a4d52, glazing: 0.18, lights: { every: 6, y: 27.5 } },
        // The Dalglish: its roof with a truss along the top of the front.
        { style: 'sheet', side: 'north', straight: true, from: -57, to: 57, back: 47, front: 4, backY: 30, frontY: 27.5, bay: 8, color: 0xd5d8dc, underColor: 0x4a4d52, glazing: 0.25, girder: { offset: 9, height: 5 }, lights: { every: 6, y: 28 } },
        // The Anfield Road Stand's new roof, as high as the main stand's.
        { style: 'sheet', side: 'east', straight: true, from: -66, to: 66, back: 64, front: 5, backY: 41, frontY: 37, bay: 9, color: 0xd5d8dc, underColor: 0x4a4d52, glazing: 0.35, lights: { every: 6, y: 37.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8f9296, walls: 0x8a3b2b },
      runoff: { color: 0x2f7a3a, a: 55.5, b: 38.5, exponent: 16 },
      seatLook: {
        colors: [LFC_RED],
        text: [
          // L F C across the middle of the Kop.
          { text: 'L F C', color: '#f4f4f2', tier: 1, centerU: 0.5, halfU: 0.05, rows: [10, 34] },
        ],
      },
      details: {
        // Red LED boards along the front of every tier above the lowest.
        ribbons: { color: 0xc8102e },
        buildings: [
          // The corners between the stands: concourses and stairs, brick and grey cladding.
          { side: 'west', straight: true, center: -64, halfLength: 9.5, front: 0, depth: 30, y0: 0, y1: 22, color: 0x8a3b2b },
          { side: 'west', straight: true, center: 61, halfLength: 7, front: 0, depth: 24, y0: 0, y1: 15, color: 0x8a3b2b },
          { side: 'east', straight: true, center: -65, halfLength: 9.5, front: 0, depth: 30, y0: 0, y1: 22, color: 0xb8bcc0 },
          { side: 'east', straight: true, center: 63, halfLength: 8, front: 0, depth: 28, y0: 0, y1: 22, color: 0xb8bcc0 },
        ],
        skins: [
          // Red brick at the foot of the main stand and the Anfield Road Stand, grey cladding above.
          { side: 'south', straight: true, from: -72, to: 72, offset: 72, y0: 0, y1: 14, color: 0x9a4a37, pattern: 'brick', tile: [3, 3] },
          { side: 'south', straight: true, from: -72, to: 72, offset: 73, y0: 14, y1: 45, color: 0xb8bcc0, pattern: 'slats', tile: [3, 4] },
          { side: 'east', straight: true, from: -66, to: 66, offset: 61, y0: 0, y1: 12, color: 0x9a4a37, pattern: 'brick', tile: [3, 3] },
          { side: 'east', straight: true, from: -66, to: 66, offset: 62, y0: 12, y1: 41, color: 0xb8bcc0, pattern: 'slats', tile: [3, 4] },
          { side: 'west', straight: true, from: -54, to: 54, offset: 48, y0: 0, y1: 34, color: 0x9a4a37, pattern: 'brick', tile: [3, 3] },
          { side: 'north', straight: true, from: -57, to: 57, offset: 46, y0: 0, y1: 30, color: 0x9a4a37, pattern: 'brick', tile: [3, 3] },
        ],
        screens: [
          { centerU: 0.375, widthM: 12, heightM: 6.5, post: { offset: 6, y: 18 } },
          { centerU: 0.875, widthM: 12, heightM: 6.5, post: { offset: 6, y: 18 } },
        ],
      },
      // Anfield's terraced streets, Stanley Park behind the Anfield Road end, from OpenStreetMap.
      site: { key: 'anfield', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Anfield (Liverpool)', source: 'builtin', country: 'Europe', capacity: 61276, type: 'Two-tier', inspiredBy: 'Anfield, Liverpool - home of Liverpool FC', tags: ['liverpool', 'anfield', 'kop', 'england', PL] },
  },
  {
    // Old Trafford, Manchester. The main stand (the Sir Bobby Charlton Stand,
    // single tier, the railway behind it) is south-south-east (-z); the
    // three-tier Sir Alex Ferguson Stand north (+z), the Stretford End west
    // (+x) and the East Stand east (-x). The north side wraps round both
    // corners into the ends (the 2006 quadrants); the south corners are low.
    // OSM heights: SAF 42 m, ends 37 m, the main stand 18 m, the quadrant
    // roof hubs 52 m.
    id: 'old-trafford-74k',
    template: {
      id: 'old-trafford-74k',
      name: 'Old Trafford (Manchester)',
      version: 1,
      levels: 3,
      plan: { a: 57, b: 39.5, exponent: 12 },
      evenRows: true,
      tiers: [
        {
          // The lower tier all round but the main stand: the ends, the SAF's
          // lower tier and the low south corners (the away end at the south-east).
          rows: 34, rowDepth: 0.76, rakeDeg: 25, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.46,
          omit: [{ side: 'south', from: -61, to: 61 }],
        },
        {
          // The main stand: one long tier.
          rows: 50, rowDepth: 0.78, rakeDeg: 24, baseElevation: 1.2, baseOffset: 1.5, seatPitch: 0.46, straight: true,
          stands: [{ side: 'south', halfLength: 61 }],
        },
        {
          // The second tier: the ends' upper tiers, the quadrants, and the SAF's middle tier (shallower).
          rows: 36, rowDepth: 0.8, rakeDeg: 32, baseElevation: 13.5, baseOffset: 29.5, seatPitch: 0.46,
          omit: [{ side: 'south', from: -200, to: 200 }, { side: 'north', from: -64, to: 64, fromRow: 18 }],
        },
        {
          // The SAF's upper tier, and the quadrants' top tiers stepping up to it.
          rows: 26, rowDepth: 0.82, rakeDeg: 35, baseElevation: 27, baseOffset: 46.5, seatPitch: 0.46,
          omit: [{ side: 'south', from: -200, to: 200 }, { side: 'east', from: -200, to: 22 }, { side: 'west', from: -200, to: 22 }],
        },
      ],
      aisles: { count: 72, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        // The great cantilever over the north side and round into the ends,
        // hung from the white trusses that stand on top of it.
        { style: 'sheet', back: 70, front: 8, backY: 46, frontY: 42, depth: 1.5, bay: 9, color: 0xc9ccd0, underColor: 0x5a5d62, glazing: 0.42, girder: { offset: 20, height: 7, color: 0xf0f0ee }, lights: { every: 6, y: 42.5 }, omit: [{ side: 'south', from: -200, to: 200 }, { side: 'east', from: -200, to: 22 }, { side: 'west', from: -200, to: 22 }] },
        // The ends' roofs, lower than the north's.
        { style: 'sheet', side: 'west', from: -200, to: 22, back: 68, front: 7, backY: 38.5, frontY: 35, depth: 1.4, bay: 9, color: 0xc9ccd0, underColor: 0x5a5d62, glazing: 0.42, girder: { offset: 20, height: 6, color: 0xf0f0ee }, lights: { every: 6, y: 35.5 } },
        { style: 'sheet', side: 'east', from: -200, to: 22, back: 68, front: 7, backY: 38.5, frontY: 35, depth: 1.4, bay: 9, color: 0xc9ccd0, underColor: 0x5a5d62, glazing: 0.42, girder: { offset: 20, height: 6, color: 0xf0f0ee }, lights: { every: 6, y: 35.5 } },
        // The main stand's low roof, its name in red along the fascia.
        { style: 'sheet', side: 'south', straight: true, from: -62, to: 62, back: 50, front: 4, backY: 21.5, frontY: 17, depth: 1.2, bay: 8, color: 0xc9ccd0, underColor: 0x5a5d62, glazing: 0.15, lights: { every: 6, y: 17.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8e9195, walls: 0x6f2a24 },
      runoff: { color: 0x2f7a3a, a: 57, b: 39.5, exponent: 12 },
      seatLook: {
        colors: ['#d7261e'],
        text: [
          // STRETFORD over END across the Stretford End's lower tier, and
          // MANCHESTER over UNITED across the Sir Alex Ferguson Stand's.
          { text: 'STRETFORD', color: '#f4f4f2', tier: 0, centerU: 0, halfU: 0.062, rows: [17, 31] },
          { text: 'END', color: '#f4f4f2', tier: 0, centerU: 0, halfU: 0.03, rows: [3, 15] },
          { text: 'MANCHESTER', color: '#f4f4f2', tier: 0, centerU: 0.25, halfU: 0.09, rows: [17, 31] },
          { text: 'UNITED', color: '#f4f4f2', tier: 0, centerU: 0.25, halfU: 0.06, rows: [3, 15] },
        ],
      },
      details: {
        ribbons: { color: 0xd7261e },
        skins: [
          // Grey and red cladding round the back of the bowl, tinted glass on the East Stand.
          { offset: 68, y0: 0, y1: 40, color: 0xa8acb2, pattern: 'slats', tile: [3, 4], omit: [{ side: 'south', from: -200, to: 200 }, { side: 'east', from: -40, to: 40 }] },
          { side: 'east', from: -40, to: 40, offset: 68, y0: 0, y1: 36, color: 0x3a4652, pattern: 'glass', tile: [3, 3.6] },
          { side: 'south', straight: true, from: -62, to: 62, offset: 49, y0: 0, y1: 19, color: 0x8a3b2b, pattern: 'brick', tile: [3, 3] },
        ],
      },
      site: { key: 'old-trafford', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Old Trafford (Manchester)', source: 'builtin', country: 'Europe', capacity: 74158, type: 'Bowl', inspiredBy: 'Old Trafford, Manchester - home of Manchester United', tags: ['manchester-united', 'man-utd', 'old-trafford', 'manchester', 'stretford-end', 'england', PL] },
  },
  {
    // The Etihad (City of Manchester Stadium). The main stand (the Colin Bell
    // Stand, the tunnel) is west (-z here); the East Stand east (+z), the
    // South Stand -x and the new Pep Guardiola Stand (north, 2026) +x. A
    // continuous oval bowl, three tiers on the sides and at the south end; at
    // the north end one great steep tier above the lower one. The roof hangs
    // from tall masts outside the bowl.
    id: 'etihad-61k',
    template: {
      id: 'etihad-61k',
      name: 'Etihad Stadium (Manchester)',
      version: 1,
      levels: 3,
      plan: { a: 59, b: 40.5, exponent: 9 },
      evenRows: true,
      tiers: [
        {
          rows: 22, rowDepth: 0.76, rakeDeg: 21, baseElevation: 0.8, baseOffset: 0, seatPitch: 0.47,
        },
        {
          // The middle tier, round the sides and the south end.
          rows: 17, rowDepth: 0.8, rakeDeg: 29, baseElevation: 7.9, baseOffset: 20, seatPitch: 0.47,
          omit: [{ side: 'east', from: -200, to: 200 }],
        },
        {
          // The Pep Guardiola Stand's great upper tier, behind the north goal.
          rows: 56, rowDepth: 0.76, rakeDeg: 35, baseElevation: 7.9, baseOffset: 20, seatPitch: 0.47, straight: true,
          stands: [{ side: 'east', halfLength: 50 }],
        },
        {
          // The upper tiers of the sides and of the south end (added 2015).
          rows: 22, rowDepth: 0.82, rakeDeg: 34, baseElevation: 21.8, baseOffset: 37, seatPitch: 0.47,
          omit: [{ side: 'east', from: -200, to: 200 }],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        // The sides' roof: dark grey underneath, a clear strip at the front.
        { style: 'sheet', back: 62, front: 9, backY: 47, frontY: 40, depth: 1.6, bay: 9, color: 0xc4c8cc, underColor: 0x3c4046, glazing: 0.22, lights: { every: 5, y: 40.5 }, omit: [{ side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 }] },
        // The south end's raised roof (2015) and the north's new one (2026).
        { style: 'sheet', side: 'west', from: -200, to: 200, back: 62, front: 8, backY: 50, frontY: 42, depth: 1.6, bay: 9, color: 0xc4c8cc, underColor: 0x3c4046, glazing: 0.22, lights: { every: 5, y: 42.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -54, to: 54, back: 66, front: 8, backY: 54, frontY: 44, depth: 1.6, bay: 9, color: 0xc4c8cc, underColor: 0x3c4046, glazing: 0.22, lights: { every: 5, y: 43.5 } },
      ],
      // The roof's masts, round the outside, carrying its cables.
      lighting: { style: 'roof-rim', kelvin: 5700, masts: { at: [[-42, -112], [42, -112], [-42, 112], [42, 112], [-130, -42], [-130, 42], [130, -42], [130, 42], [-102, -87], [102, -87], [-102, 87], [102, 87]], height: 70, style: 'pole', head: 'none', cables: { reach: 82, y: 48 } } },
      finish: { concrete: 0x8d9196, walls: 0x9aa1a8 },
      runoff: { color: 0x2f7a3a, a: 59, b: 40.5, exponent: 9 },
      seatLook: {
        colors: [{ c: '#4f97d4', w: 6 }, { c: '#4387c2', w: 1 }],
        grain: { along: 6, rows: 30 },
      },
      details: {
        ribbons: { color: 0x2f8bd0 },
        screens: [
          // Either side of the north stand, and the big one hung in the south end.
          { centerU: 0.12, widthM: 11, heightM: 6, hang: { offset: 14, y: 30 } },
          { centerU: 0.88, widthM: 11, heightM: 6, hang: { offset: 14, y: 30 } },
          { centerU: 0.5, widthM: 18, heightM: 8, hang: { offset: 22, y: 34 } },
        ],
        skins: [
          // Silver cladding and glass round the outside of the bowl.
          { offset: 60, y0: 0, y1: 42, color: 0xb9bec4, pattern: 'slats', tile: [2.5, 4], omit: [{ side: 'east', from: -200, to: 200 }] },
          { side: 'east', straight: true, from: -54, to: 54, offset: 66, y0: 0, y1: 52, color: 0x3c4a58, pattern: 'glass', tile: [3, 3.6] },
        ],
      },
      site: { key: 'etihad', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Etihad Stadium (Manchester)', source: 'builtin', country: 'Europe', capacity: 61470, type: 'Bowl', inspiredBy: 'City of Manchester Stadium (Etihad Stadium) - home of Manchester City', tags: ['manchester-city', 'man-city', 'city', 'etihad', 'manchester', 'england', PL] },
  },
  {
    // Emirates Stadium, London. The main stand (the West Stand: tunnel,
    // dugouts, directors' box) is west (-z here); the East Stand east (+z),
    // the North Bank +x and the Clock End -x. One continuous bowl of four
    // levels: the lower tier, Club Level, a ring of boxes and an upper tier
    // that dips towards the corners. The roof slopes down towards the pitch,
    // its inner edge clear polycarbonate on a white steel grid.
    id: 'emirates-60k',
    template: {
      id: 'emirates-60k',
      name: 'Emirates Stadium (London)',
      version: 1,
      levels: 3,
      plan: { a: 59, b: 40.5, exponent: 8 },
      evenRows: true,
      tiers: [
        { rows: 27, rowDepth: 0.78, rakeDeg: 22, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        {
          // Club Level.
          rows: 12, rowDepth: 0.84, rakeDeg: 23, baseElevation: 9.9, baseOffset: 23.7, seatPitch: 0.49,
        },
        {
          // The upper tier: full depth in the middle of each side, shallower towards the corners.
          rows: 26, rowDepth: 0.8, rakeDeg: 33, baseElevation: 20.7, baseOffset: 37.4, seatPitch: 0.47,
          omit: [
            { side: 'north', from: -200, to: -52, fromRow: 19 }, { side: 'north', from: 52, to: 200, fromRow: 19 },
            { side: 'south', from: -200, to: -52, fromRow: 19 }, { side: 'south', from: 52, to: 200, fromRow: 19 },
            { side: 'east', from: -200, to: -30, fromRow: 19 }, { side: 'east', from: 30, to: 200, fromRow: 19 },
            { side: 'west', from: -200, to: -30, fromRow: 19 }, { side: 'west', from: 30, to: 200, fromRow: 19 },
          ],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 68, front: 15, backY: 44, frontY: 38.5, depth: 3.4, bay: 8, color: 0xc2c6ca, underColor: 0xe6e8e9, glazing: 0.42, lights: { every: 5, y: 39 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9b9ea2, walls: 0xb9bcc0 },
      runoff: { color: 0x2f7a3a, a: 59, b: 40.5, exponent: 8 },
      seatLook: { colors: ['#d8141d'] },
      details: {
        ribbons: { color: 0xd8141d, tiers: [1, 2] },
        boxes: [{ centerU: 0, halfU: 0.5, underTier: 2, count: 150 }],
        screens: [
          // Hung from the roof in the north-west and south-east corners.
          { centerU: 0.875, widthM: 13, heightM: 7, hang: { offset: 30, y: 34, ceiling: 42 } },
          { centerU: 0.375, widthM: 13, heightM: 7, hang: { offset: 30, y: 34, ceiling: 42 } },
        ],
        skins: [
          // Glass and steel round the outside, between concrete cores.
          { offset: 68, y0: 0, y1: 41, color: 0x8a98a6, pattern: 'glass', tile: [4.5, 4] },
        ],
      },
      site: { key: 'emirates', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Emirates Stadium (London)', source: 'builtin', country: 'Europe', capacity: 60704, type: 'Bowl', inspiredBy: 'Emirates Stadium, Holloway, London - home of Arsenal', tags: ['arsenal', 'emirates', 'london', 'north-london', 'highbury', 'england', PL] },
  },
  {
    // Tottenham Hotspur Stadium, London. The main stand (the West Stand: the
    // tunnel and dugouts) is west (-z here); the East Stand east (+z), the
    // North Stand +x and the single-tier South Stand -x — 17,500 in one
    // steep sweep, the largest single tier in the country. The sides have
    // four tiers (two of them premium), the north end three; every corner is
    // filled. The roof is one ring, its glazed inner edge carrying the lights.
    id: 'tottenham-62k',
    template: {
      id: 'tottenham-62k',
      name: 'Tottenham Hotspur Stadium (London)',
      version: 1,
      levels: 4,
      plan: { a: 59, b: 40, exponent: 9 },
      evenRows: true,
      tiers: [
        {
          // The lower tier of the sides and of the North Stand.
          rows: 27, rowDepth: 0.8, rakeDeg: 23, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.48,
          omit: [{ side: 'west', from: -200, to: 200 }, { side: 'north', from: -200, to: -42 }, { side: 'south', from: -200, to: -42 }],
        },
        {
          // The South Stand: one tier, all the way up.
          rows: 56, rowDepth: 0.75, rakeDeg: 35, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47,
          omit: [{ side: 'east', from: -200, to: 200 }, { side: 'north', from: -42, to: 200 }, { side: 'south', from: -42, to: 200 }],
        },
        {
          // The first premium tier (and the North Stand's middle tier).
          rows: 9, rowDepth: 0.85, rakeDeg: 25, baseElevation: 10.2, baseOffset: 23.5, seatPitch: 0.5,
          omit: [{ side: 'west', from: -200, to: 200 }, { side: 'north', from: -200, to: -42 }, { side: 'south', from: -200, to: -42 }],
        },
        {
          // The second premium tier, along the sides.
          rows: 7, rowDepth: 0.88, rakeDeg: 27, baseElevation: 16.5, baseOffset: 33.5, seatPitch: 0.52,
          omit: [{ side: 'west', from: -200, to: 200 }, { side: 'east', from: -200, to: 200 }, { side: 'north', from: -200, to: -42 }, { side: 'south', from: -200, to: -42 }],
        },
        {
          // The upper tier of the sides and of the North Stand.
          rows: 26, rowDepth: 0.8, rakeDeg: 34, baseElevation: 23, baseOffset: 42.5, seatPitch: 0.47,
          omit: [{ side: 'west', from: -200, to: 200 }, { side: 'north', from: -200, to: -42 }, { side: 'south', from: -200, to: -42 }],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        // One ring of roof, dark underneath, a ring of glass at the inner edge.
        { style: 'sheet', back: 70, front: 12, backY: 48, frontY: 42, depth: 1.8, bay: 9, color: 0xb9bdc2, underColor: 0x34383e, glazing: 0.26, lights: { every: 4.5, y: 42.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5900 },
      finish: { concrete: 0x8e9196, walls: 0xb2b6bb },
      runoff: { color: 0x2f7a3a, a: 59, b: 40, exponent: 9 },
      seatLook: { colors: ['#1b2a5c'] },
      details: {
        ribbons: { color: 0x1d3c8f, tiers: [2, 3, 4] },
        boxes: [
          { centerU: 0.75, halfU: 0.11, underTier: 3, count: 28 },
          { centerU: 0.25, halfU: 0.11, underTier: 3, count: 28 },
        ],
        screens: [
          // Two big ones at the south end's corners, two smaller at the north's.
          { centerU: 0.43, widthM: 22, heightM: 11, hang: { offset: 34, y: 34, ceiling: 46 } },
          { centerU: 0.57, widthM: 22, heightM: 11, hang: { offset: 34, y: 34, ceiling: 46 } },
          { centerU: 0.08, widthM: 16, heightM: 9, hang: { offset: 30, y: 36, ceiling: 46 } },
          { centerU: 0.92, widthM: 16, heightM: 9, hang: { offset: 30, y: 36, ceiling: 46 } },
        ],
        skins: [
          // Glass and silver aluminium round the outside.
          { offset: 70, y0: 0, y1: 47, color: 0xaeb4ba, pattern: 'slats', tile: [3, 4] },
        ],
      },
      site: { key: 'tottenham', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Tottenham Hotspur Stadium (London)', source: 'builtin', country: 'Europe', capacity: 62850, type: 'Bowl', inspiredBy: 'Tottenham Hotspur Stadium, London - home of Tottenham Hotspur', tags: ['tottenham', 'spurs', 'tottenham-hotspur', 'london', 'north-london', 'england', PL] },
  },
  {
    // Stamford Bridge, London. The main stand (the East Stand of 1973: three
    // tiers under one cantilever, the tunnel and dugouts) is north-east (-z
    // here); the West Stand south-west (+z), the Shed End +x and the Matthew
    // Harding Stand -x. Four stands close to the pitch with the corners filled
    // in; translucent roofs all round.
    id: 'stamford-bridge-40k',
    template: {
      id: 'stamford-bridge-40k',
      name: 'Stamford Bridge (London)',
      version: 1,
      levels: 3,
      plan: { a: 53.5, b: 37, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 29, rowDepth: 0.76, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 58, rows: 26 },
            { side: 'north', halfLength: 60, rows: 28 },
            { side: 'east', halfLength: 36, rows: 23, offset: 2 },
            { side: 'west', halfLength: 36, rows: 29, offset: 2 },
          ],
        },
        {
          // The East Stand's middle tier (the suites), the West Stand's middle,
          // and the upper tiers of both ends.
          rows: 28, rowDepth: 0.78, rakeDeg: 30, baseElevation: 10.5, baseOffset: 23, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 56, rows: 10, offset: 1, elevation: 0.5 },
            { side: 'north', halfLength: 60, rows: 16, offset: 1.5 },
            { side: 'east', halfLength: 50, rows: 22, offset: -2.5, elevation: -1.5 },
            { side: 'west', halfLength: 52, rows: 26, offset: 1.5 },
          ],
        },
        {
          // The upper tiers of the East and West Stands.
          rows: 27, rowDepth: 0.78, rakeDeg: 35, baseElevation: 18, baseOffset: 34, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 58, rows: 27 },
            { side: 'north', halfLength: 60, rows: 24, offset: 6, elevation: 3.5 },
          ],
        },
      ],
      aisles: { count: 56, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -62, to: 62, back: 58, front: 2, backY: 36, frontY: 31, depth: 1.5, bay: 8, color: 0xb9bdc2, underColor: 0x4a4e55, glazing: 0.55, lights: { every: 5, y: 31.5 } },
        { style: 'sheet', side: 'north', straight: true, from: -64, to: 64, back: 62, front: 3, backY: 38, frontY: 33, depth: 1.5, bay: 8, color: 0xb9bdc2, underColor: 0x4a4e55, glazing: 0.55, lights: { every: 5, y: 33.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -54, to: 54, back: 42, front: 2, backY: 24, frontY: 21, depth: 1.3, bay: 8, color: 0xb9bdc2, underColor: 0x4a4e55, glazing: 0.5, lights: { every: 5, y: 21.5 } },
        { style: 'sheet', side: 'west', straight: true, from: -56, to: 56, back: 48, front: 2, backY: 28, frontY: 25, depth: 1.3, bay: 8, color: 0xb9bdc2, underColor: 0x4a4e55, glazing: 0.5, lights: { every: 5, y: 25.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8e9196, walls: 0x9fa4aa },
      runoff: { color: 0x2f7a3a, a: 53.5, b: 37, exponent: 14 },
      seatLook: { colors: ['#1f4ea8'] },
      details: {
        ribbons: { color: 0x1f4ea8 },
        boxes: [{ centerU: 0.25, halfU: 0.1, underTier: 2, count: 51 }],
        screens: [
          { centerU: 0.375, widthM: 10, heightM: 5.5, post: { offset: 6, y: 18 } },
          { centerU: 0.875, widthM: 10, heightM: 5.5, post: { offset: 6, y: 18 } },
        ],
        skins: [
          { side: 'south', straight: true, from: -62, to: 62, offset: 57, y0: 0, y1: 36, color: 0x9a9fa6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', straight: true, from: -64, to: 64, offset: 61, y0: 0, y1: 38, color: 0x8e5a44, pattern: 'brick', tile: [3, 3] },
          { side: 'east', straight: true, from: -54, to: 54, offset: 41, y0: 0, y1: 24, color: 0x8e5a44, pattern: 'brick', tile: [3, 3] },
          { side: 'west', straight: true, from: -56, to: 56, offset: 47, y0: 0, y1: 28, color: 0x9a9fa6, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'stamford-bridge', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Stamford Bridge (London)', source: 'builtin', country: 'Europe', capacity: 40044, type: 'Two-tier', inspiredBy: 'Stamford Bridge, Fulham, London - home of Chelsea', tags: ['chelsea', 'stamford-bridge', 'london', 'west-london', 'england', PL] },
  },
  {
    // Craven Cottage, London. The main stand (the Johnny Haynes Stand of
    // 1905, listed: two low tiers under a pitched roof on a row of columns,
    // its red-brick back on Stevenage Road) is east (-z here); the new
    // Riverside Stand (2025) on the Thames west (+z), the Putney End +x and
    // the Hammersmith End -x. The Cottage pavilion stands in the corner
    // between the main stand and the Putney End.
    id: 'craven-cottage-29k',
    template: {
      id: 'craven-cottage-29k',
      name: 'Craven Cottage (London)',
      version: 1,
      levels: 2,
      plan: { a: 58.5, b: 38, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 38, rowDepth: 0.74, rakeDeg: 25, baseElevation: 0.8, baseOffset: 0, seatPitch: 0.46, straight: true,
          stands: [
            // The Johnny Haynes paddock, low and shallow, behind a wider gap.
            { side: 'south', halfLength: 50, rows: 17, offset: 1.5, elevation: -0.2 },
            { side: 'north', halfLength: 56, rows: 24, offset: -1 },
            { side: 'east', halfLength: 39, rows: 36 },
            { side: 'west', halfLength: 52, rows: 38 },
          ],
        },
        {
          // The Johnny Haynes upper tier (wooden seats) and the Riverside's upper tier.
          rows: 18, rowDepth: 0.8, rakeDeg: 30, baseElevation: 6.5, baseOffset: 15, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 50, rows: 15, elevation: -1.5 },
            { side: 'north', halfLength: 56, rows: 18, offset: 9, elevation: 6 },
          ],
        },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        // The Johnny Haynes Stand's pitched roof on its columns.
        { style: 'sheet', side: 'south', straight: true, from: -51, to: 51, back: 28, front: 1, backY: 14.2, frontY: 10.5, depth: 1.8, bay: 7, color: 0x6f7468, underColor: 0x3f4440, columns: { every: 7, color: 0x2f4f3f, offset: 2.5 } },
        // The Riverside Stand's floating cantilever: bronze underneath, solar panels on top.
        { style: 'sheet', side: 'north', straight: true, from: -58, to: 58, back: 44, front: 3, backY: 30, frontY: 27, depth: 1.8, bay: 7.4, color: 0x2c3138, underColor: 0x8a6646, glazing: 0.1, lights: { every: 5, y: 27.5 } },
        // The ends' white roofs, on a couple of columns each.
        { style: 'sheet', side: 'east', straight: true, from: -40, to: 40, back: 30, front: 2, backY: 17.5, frontY: 14, depth: 1.2, bay: 8, color: 0xeef0f0, underColor: 0xd5d8da, columns: { every: 25, color: 0xeeeeee, offset: 12 }, lights: { every: 6, y: 12.5 } },
        { style: 'sheet', side: 'west', straight: true, from: -53, to: 53, back: 31, front: 2, backY: 18.5, frontY: 14.5, depth: 1.2, bay: 8, color: 0xeef0f0, underColor: 0xd5d8da, columns: { every: 25, color: 0xeeeeee, offset: 13 }, lights: { every: 6, y: 13 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0x8e9196, walls: 0x8a4a38 },
      runoff: { color: 0x2f7a3a, a: 58.5, b: 38, exponent: 14 },
      seatLook: {
        colors: ['#1d1f23'],
        // The Johnny Haynes upper tier's old wooden seats.
        regions: [{ tiers: [1], side: 'south', colors: ['#6e4f35', '#7a583b'] }],
      },
      details: {
        ribbons: { color: 0x2b2d31, tiers: [1] },
        buildings: [
          // The Cottage, in the corner by the Putney End.
          { side: 'south', straight: true, center: 59, halfLength: 7.5, front: 2, depth: 9, y0: 0, y1: 10, color: 0x9a4b38, fascia: 0xf2efe6 },
          // The Riverside Stand's hospitality floors behind its seats, glass to the river.
          { side: 'north', straight: true, halfLength: 56, front: 38, depth: 10, y0: 0, y1: 30, glassFloors: 6, color: 0x2c3138 },
        ],
        skins: [
          // Stevenage Road: the listed red-brick facade.
          { side: 'south', straight: true, from: -51, to: 51, offset: 27, y0: 0, y1: 12.5, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
          { side: 'east', straight: true, from: -40, to: 40, offset: 29, y0: 0, y1: 17, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', straight: true, from: -53, to: 53, offset: 29, y0: 0, y1: 17, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
        ],
        screens: [{ centerU: 0, widthM: 9, heightM: 4.5, post: { offset: 4, y: 15 } }],
      },
      site: { key: 'craven-cottage', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Craven Cottage (London)', source: 'builtin', country: 'Europe', capacity: 28107, type: 'Two-tier', inspiredBy: 'Craven Cottage, Fulham, London - home of Fulham', tags: ['fulham', 'craven-cottage', 'cottage', 'london', 'thames', 'england', PL] },
  },
  {
    // Selhurst Park, London. The main stand (Archibald Leitch's 1924 Main
    // Stand: one low tier under a pitched roof on columns, its back clad in
    // pale blue) is south-west (-z here); the deep Arthur Wait Stand north-east
    // (+z), its flat roof on a row of pillars ten rows back; the two-tier
    // Holmesdale Road Stand, the home end, -x, PALACE in the upper tier and
    // EAGLES! in the lower; the little Whitehorse Lane Stand +x, a few rows of
    // seats under two levels of boxes, the screen on its roof and Sainsbury's
    // behind. Open corners, with floodlight masts in them.
    id: 'selhurst-park-25k',
    template: {
      id: 'selhurst-park-25k',
      name: 'Selhurst Park (London)',
      version: 1,
      levels: 2,
      plan: { a: 54.5, b: 36.5, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 45, rowDepth: 0.74, rakeDeg: 22, baseElevation: 0.9, baseOffset: 0, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 52, rows: 26, offset: 3 },
            { side: 'north', halfLength: 55, rows: 45, offset: 2.5 },
            { side: 'west', halfLength: 43, rows: 35, offset: 1 },
            { side: 'east', halfLength: 38, rows: 16, offset: 1 },
          ],
        },
        {
          // The Holmesdale's upper tier.
          rows: 17, rowDepth: 0.8, rakeDeg: 33, baseElevation: 14, baseOffset: 25, seatPitch: 0.46, straight: true,
          stands: [{ side: 'west', halfLength: 43, rows: 17 }],
        },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 34,
      roof: { coverage: 'none' },
      roofs: [
        // The Main Stand's pitched roof on its row of front columns.
        { style: 'sheet', side: 'south', straight: true, from: -54, to: 54, back: 26, front: 1.5, backY: 12.5, frontY: 10, depth: 1.6, bay: 7, color: 0xdfe2e4, underColor: 0x4f545c, columns: { every: 14, color: 0x2f3a5a, offset: 3 }, lights: { every: 6, y: 10.5 } },
        // The Arthur Wait's flat roof, on pillars well back in the stand.
        { style: 'sheet', side: 'north', straight: true, from: -57, to: 57, back: 37, front: 2, backY: 17.5, frontY: 13.5, depth: 1.6, bay: 7, color: 0xe4e6e8, underColor: 0x4f545c, columns: { every: 14, color: 0x2f3a5a, offset: 10 } },
        // The Holmesdale's sweeping roof, white over a black fascia.
        { style: 'sheet', side: 'west', straight: true, from: -46, to: 46, back: 42, front: 2, backY: 26.5, frontY: 23.5, depth: 2.6, bay: 8, color: 0xe8eaec, underColor: 0x2c2f35, lights: { every: 6, y: 23.5 } },
        // Whitehorse Lane: a low roof over the boxes.
        { style: 'sheet', side: 'east', straight: true, from: -40, to: 40, back: 21, front: 1, backY: 13, frontY: 11, depth: 1.2, bay: 8, color: 0xe4e6e8, underColor: 0x4f545c },
      ],
      lighting: { style: 'corner-masts', kelvin: 5200, masts: { at: [[63, 46]], height: 42, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x8e9196, walls: 0x9fa4aa },
      runoff: { color: 0x2f7a3a, a: 54.5, b: 36.5, exponent: 14 },
      seatLook: {
        colors: ['#1d4fa8'],
        regions: [
          // The Arthur Wait: red and blue block by block.
          { side: 'north', colors: ['#1d4fa8', '#c8102e'], alternate: true },
          { tiers: [1], side: 'west', colors: ['#c8102e'] },
        ],
        text: [
          { text: 'PALACE', color: '#1d4fa8', tier: 1, centerU: 0.5, halfU: 0.085, rows: [2, 14] },
          { text: 'EAGLES!', color: '#c8102e', tier: 0, centerU: 0.5, halfU: 0.085, rows: [5, 27] },
        ],
      },
      details: {
        ribbons: { color: 0x1f6b3a, tiers: [1] },
        buildings: [
          // Whitehorse Lane's two storeys of boxes over its few rows of seats.
          { side: 'east', straight: true, halfLength: 38, front: 12.5, depth: 8, y0: 5.4, y1: 12.5, glassFloors: 2, color: 0x2f3a5a },
        ],
        screens: [{ centerU: 0, widthM: 10, heightM: 5, hang: { offset: 6, y: 16, ceiling: 18.5 } }],
        skins: [
          // The Main Stand's pale blue cladding on Park Road.
          { side: 'south', straight: true, from: -54, to: 54, offset: 25, y0: 0, y1: 12.5, color: 0x8cbfe0, pattern: 'panels', tile: [4, 3] },
          { side: 'north', straight: true, from: -57, to: 57, offset: 36.5, y0: 0, y1: 17.5, color: 0xd9dcdf, pattern: 'panels', tile: [5, 3.5] },
          // The Holmesdale: brick below, the black band of the roof above.
          { side: 'west', straight: true, from: -46, to: 46, offset: 41.5, y0: 0, y1: 15, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
          { side: 'west', straight: true, from: -46, to: 46, offset: 41.5, y0: 15, y1: 26.5, color: 0x2a2c30, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'selhurst-park', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Selhurst Park (London)', source: 'builtin', country: 'Europe', capacity: 25194, type: 'Two-tier', inspiredBy: 'Selhurst Park, South Norwood, London - home of Crystal Palace', tags: ['crystal-palace', 'palace', 'selhurst', 'selhurst-park', 'london', 'south-london', 'england', PL] },
  },
  {
    // Gtech Community Stadium, Brentford. Four steep stands close to the
    // pitch in a triangle of railway lines, the corners filled, the roofs
    // rising and falling between them. The main stand (the South Stand: two
    // tiers either side of a level of boxes, a screen on its roof) is south
    // (-z here); the low North Stand +z, the West Stand (all rail seats, the
    // home end) +x and the East Stand -x. Seats in a confetti of reds,
    // amber, cream and dark green.
    id: 'brentford-17k',
    template: {
      id: 'brentford-17k',
      name: 'Gtech Community Stadium (Brentford)',
      version: 1,
      levels: 2,
      plan: { a: 54, b: 36, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 25, rowDepth: 0.78, rakeDeg: 30, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 54, rows: 16, offset: 2 },
            { side: 'north', halfLength: 54, rows: 17, offset: 2 },
            { side: 'east', halfLength: 43, rows: 25, offset: 2 },
            { side: 'west', halfLength: 43, rows: 25, offset: 2 },
          ],
        },
        {
          // The South Stand's upper tier, over its boxes.
          rows: 13, rowDepth: 0.82, rakeDeg: 34, baseElevation: 12.5, baseOffset: 17, seatPitch: 0.47, straight: true,
          stands: [{ side: 'south', halfLength: 52, rows: 13 }],
        },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 34,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -59, to: 59, back: 31, front: 1, backY: 26.5, frontY: 24, depth: 2.6, bay: 7.4, color: 0xe6e8ea, underColor: 0x8d939a, lights: { every: 5, y: 24 } },
        { style: 'sheet', side: 'north', straight: true, from: -56, to: 56, back: 22, front: 1, backY: 14.5, frontY: 12.5, depth: 1.8, bay: 7.4, color: 0xe6e8ea, underColor: 0x8d939a, lights: { every: 5, y: 12.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -47, to: 47, back: 26, front: 1, backY: 17.5, frontY: 15.5, depth: 2, bay: 7.4, color: 0xe6e8ea, underColor: 0x8d939a, lights: { every: 5, y: 15.5 } },
        { style: 'sheet', side: 'west', straight: true, from: -47, to: 47, back: 26, front: 1, backY: 17.5, frontY: 15.5, depth: 2, bay: 7.4, color: 0xe6e8ea, underColor: 0x8d939a, lights: { every: 5, y: 15.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9b9ea2, walls: 0xb9bcc0 },
      runoff: { color: 0x2f7a3a, a: 54, b: 36, exponent: 14 },
      seatLook: {
        // The mosaic: dark and bright reds most, then amber, cream and dark green.
        colors: ['#8f1d2c', '#8f1d2c', '#c8202f', '#c8202f', '#c8202f', '#6b2030', '#c98a1e', '#d49a22', '#cdbb9a', '#2f3a33'],
      },
      details: {
        ribbons: { color: 0xc8202f, tiers: [1] },
        boxes: [{ centerU: 0.75, halfU: 0.11, underTier: 1, count: 18 }],
        screens: [
          // On the roofs either side of halfway.
          { centerU: 0.75, widthM: 11, heightM: 5.5, hang: { offset: 3, y: 30, ceiling: 32.8 } },
          { centerU: 0.25, widthM: 9, heightM: 4.5, hang: { offset: 3, y: 17, ceiling: 19.3 } },
        ],
        skins: [
          { side: 'south', straight: true, from: -59, to: 59, offset: 30, y0: 0, y1: 27, color: 0xb9bdc2, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', straight: true, from: -56, to: 56, offset: 21, y0: 0, y1: 15, color: 0xb9bdc2, pattern: 'panels', tile: [5, 3.5] },
          { side: 'east', straight: true, from: -47, to: 47, offset: 25, y0: 0, y1: 18, color: 0xb9bdc2, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', straight: true, from: -47, to: 47, offset: 25, y0: 0, y1: 18, color: 0xb9bdc2, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'brentford', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Gtech Community Stadium (Brentford)', source: 'builtin', country: 'Europe', capacity: 17250, type: 'Two-tier', inspiredBy: 'Gtech Community Stadium, Brentford, London - home of Brentford', tags: ['brentford', 'bees', 'gtech', 'brentford-community-stadium', 'london', 'west-london', 'england', PL] },
  },
  {
    // The American Express Stadium (Amex), Falmer, Brighton. One continuous
    // bowl, its corners filled, the roof high over the sides and low over
    // the ends, a great white tubular arch over each side. The main stand
    // (the West Stand: three tiers, the tallest) is west (-z here); the
    // two-tier East Stand +z, the single-tier North Stand +x and South
    // Stand -x. Blue seats throughout.
    id: 'amex-32k',
    template: {
      id: 'amex-32k',
      name: 'American Express Stadium (Brighton)',
      version: 1,
      levels: 3,
      plan: { a: 56, b: 37, exponent: 10 },
      evenRows: true,
      tiers: [
        {
          rows: 24, rowDepth: 0.8, rakeDeg: 21, baseElevation: 1.2, baseOffset: 3, seatPitch: 0.48,
          omit: [{ side: 'east', from: -200, to: 200, fromRow: 20 }, { side: 'west', from: -200, to: 200, fromRow: 20 }],
        },
        {
          // The West Stand's middle tier and the East Stand's upper.
          rows: 27, rowDepth: 0.82, rakeDeg: 30, baseElevation: 11.4, baseOffset: 24.4, seatPitch: 0.48,
          omit: [
            { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'south', from: -200, to: 200, fromRow: 16 },
            { side: 'north', from: -200, to: -46, fromRow: 16 }, { side: 'north', from: 46, to: 200, fromRow: 16 },
          ],
        },
        {
          // The West Stand's upper tier.
          rows: 20, rowDepth: 0.82, rakeDeg: 34, baseElevation: 22.4, baseOffset: 40.4, seatPitch: 0.48,
          omit: [
            { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 }, { side: 'north', from: -200, to: 200 },
            { side: 'south', from: -200, to: -46, fromRow: 10 }, { side: 'south', from: 46, to: 200, fromRow: 10 },
          ],
        },
      ],
      aisles: { count: 60, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', back: 63, front: 6, backY: 41.5, frontY: 36, depth: 2.4, bay: 8, color: 0xd6d9dc, underColor: 0xb7bcc1, glazing: 0.2, lights: { every: 5, y: 36 } },
        { style: 'sheet', side: 'north', back: 52, front: 6, backY: 31, frontY: 27.5, depth: 2.2, bay: 8, color: 0xd6d9dc, underColor: 0xb7bcc1, glazing: 0.2, lights: { every: 5, y: 27.5 } },
        { style: 'sheet', side: 'east', back: 26, front: 6, backY: 16, frontY: 14, depth: 1.6, bay: 8, color: 0xd6d9dc, underColor: 0xb7bcc1, glazing: 0.2, lights: { every: 5, y: 14 } },
        { style: 'sheet', side: 'west', back: 26, front: 6, backY: 16, frontY: 14, depth: 1.6, bay: 8, color: 0xd6d9dc, underColor: 0xb7bcc1, glazing: 0.2, lights: { every: 5, y: 14 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9b9ea2, walls: 0xc9ccd0 },
      runoff: { color: 0x2f7a3a, a: 56, b: 37, exponent: 10 },
      seatLook: { colors: ['#0a57b0'] },
      details: {
        ribbons: { color: 0x0a57b0 },
        boxes: [{ centerU: 0.75, halfU: 0.12, underTier: 2, count: 24 }],
        // The two arches, each a white tube truss sprung from the roof's ends.
        girders: ARCH(-72, 105, 22, 52).concat(ARCH(61, 100, 18, 42)),
        screens: [
          { centerU: 0, widthM: 10, heightM: 5.5, hang: { offset: 22, y: 14, ceiling: 16 } },
          { centerU: 0.5, widthM: 10, heightM: 5.5, hang: { offset: 22, y: 14, ceiling: 16 } },
        ],
        skins: [
          // White cladding round the outside.
          { side: 'south', offset: 62, y0: 0, y1: 41.5, color: 0xdfe2e5, pattern: 'panels', tile: [6, 4] },
          { side: 'north', offset: 51, y0: 0, y1: 31, color: 0xdfe2e5, pattern: 'panels', tile: [6, 4] },
          { side: 'east', offset: 25, y0: 0, y1: 16, color: 0xdfe2e5, pattern: 'panels', tile: [6, 4] },
          { side: 'west', offset: 25, y0: 0, y1: 16, color: 0xdfe2e5, pattern: 'panels', tile: [6, 4] },
        ],
      },
      site: { key: 'amex', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'American Express Stadium (Brighton)', source: 'builtin', country: 'Europe', capacity: 32176, type: 'Bowl', inspiredBy: 'The American Express Stadium, Falmer, Brighton - home of Brighton & Hove Albion', tags: ['brighton', 'brighton-and-hove-albion', 'seagulls', 'amex', 'falmer', 'england', PL] },
  },
  {
    // The Vitality Stadium (Dean Court), Bournemouth. Four single-tier stands
    // close to the pitch, black seats since 2026 with AFCB picked out in red
    // in the East Stand. The main stand is west (-z here); the East Stand
    // +z, the Steve Fletcher Stand (north, the home end) +x, its back a
    // white wall lettered with the club's name, and the temporary Ted
    // MacDougall Stand (south, old red seats, a scaffold frame) -x. Floodlight
    // masts at the corners, stayed to the side roofs.
    id: 'vitality-11k',
    template: {
      id: 'vitality-11k',
      name: 'Vitality Stadium (Bournemouth)',
      version: 1,
      levels: 1,
      plan: { a: 54.5, b: 36, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 21, rowDepth: 0.76, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 50, rows: 18, offset: 2 },
            { side: 'north', halfLength: 50, rows: 16, offset: 2 },
            { side: 'east', halfLength: 33, rows: 21, offset: 2 },
            { side: 'west', halfLength: 34, rows: 16, offset: 3, elevation: 0.4 },
          ],
        },
      ],
      aisles: { count: 36, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        // The Main Stand's new roof, its leading edge clear.
        { style: 'sheet', side: 'south', straight: true, from: -52, to: 52, back: 19, front: 0, backY: 11.5, frontY: 10.5, depth: 1.4, bay: 7, color: 0xc9ccd0, underColor: 0x55595f, glazing: 0.25, lights: { every: 6, y: 10.5 } },
        { style: 'sheet', side: 'north', straight: true, from: -52, to: 52, back: 18, front: 0, backY: 11.5, frontY: 10, depth: 1.4, bay: 7, color: 0xc9ccd0, underColor: 0x55595f },
        { style: 'sheet', side: 'east', straight: true, from: -35, to: 35, back: 20, front: 0, backY: 12, frontY: 10.5, depth: 1.4, bay: 7, color: 0xe4e6e8, underColor: 0x55595f },
        // The Ted MacDougall's temporary roof.
        { style: 'sheet', side: 'west', straight: true, from: -35, to: 35, back: 17, front: 1, backY: 9.5, frontY: 8.5, depth: 0.8, bay: 6, color: 0xb9bdc2, underColor: 0x55595f, columns: { every: 12, color: 0x9aa0a6, offset: 2 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5600, masts: { at: [[50, 52]], height: 34, style: 'pole', head: 'rect', cables: { reach: 44, y: 11 } } },
      finish: { concrete: 0x8e9196, walls: 0xb9bcc0 },
      runoff: { color: 0x2f7a3a, a: 54.5, b: 36, exponent: 14 },
      seatLook: {
        colors: ['#1b1c1f'],
        regions: [{ side: 'west', colors: ['#b81f2a', '#a81c27'] }],
        text: [{ text: 'AFCB', color: '#d71920', tier: 0, centerU: 0.25, halfU: 0.065, rows: [3, 16] }],
      },
      details: {
        ribbons: { color: 0xd71920 },
        buildings: [
          // The new corner stands going up in the north-west and south-east, clad in red.
          { side: 'south', straight: true, center: 59, halfLength: 5, front: 2, depth: 14, y0: 0, y1: 10, color: 0xb8202a },
          { side: 'north', straight: true, center: -59, halfLength: 5, front: 2, depth: 14, y0: 0, y1: 10, color: 0xb8202a },
        ],
        skins: [
          { side: 'south', straight: true, from: -52, to: 52, offset: 18, y0: 0, y1: 11.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', straight: true, from: -52, to: 52, offset: 17, y0: 0, y1: 11.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          // The Steve Fletcher Stand's white back wall.
          { side: 'east', straight: true, from: -35, to: 35, offset: 19, y0: 0, y1: 12, color: 0xf0f1f2, pattern: 'panels', tile: [6, 4] },
        ],
      },
      site: { key: 'vitality', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Vitality Stadium (Bournemouth)', source: 'builtin', country: 'Europe', capacity: 11307, type: 'Single-tier', inspiredBy: 'Vitality Stadium (Dean Court), Kings Park, Bournemouth - home of AFC Bournemouth', tags: ['bournemouth', 'afc-bournemouth', 'cherries', 'vitality', 'dean-court', 'england', PL] },
  },
  {
    // Villa Park, Birmingham. The main stand (the Trinity Road Stand: three
    // tiers, a band of boxes under the top one, the road running through a
    // tunnel beneath it) is west (-z here); the two-tier Doug Ellis Stand
    // east (+z); the Holte End, the vast two-tier home end with THE HOLTE
    // END in its lower tier, -x. The North Stand (+x) is a building site all
    // season: its roof is off and only the old concrete frame stands, with
    // the cranes over it. Sky-blue lower tiers, claret upper ones.
    id: 'villa-park-37k',
    template: {
      id: 'villa-park-37k',
      name: 'Villa Park (Birmingham)',
      version: 1,
      levels: 3,
      plan: { a: 55.5, b: 37, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 40, rowDepth: 0.76, rakeDeg: 23, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 22, offset: 3 },
            { side: 'north', halfLength: 55, rows: 24, offset: 0.5 },
            { side: 'west', halfLength: 48, rows: 40, offset: 4 },
          ],
        },
        {
          // The Trinity Road's middle tier and the Doug Ellis's upper.
          rows: 23, rowDepth: 0.8, rakeDeg: 29, baseElevation: 10.5, baseOffset: 20.5, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 21 },
            { side: 'north', halfLength: 55, rows: 23, offset: -1.5, elevation: 1.2 },
          ],
        },
        {
          // The Trinity Road's top tier and the Holte End's upper.
          rows: 35, rowDepth: 0.8, rakeDeg: 34, baseElevation: 24, baseOffset: 37.5, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 24 },
            { side: 'west', halfLength: 48, rows: 35, offset: -4.5, elevation: -6.5 },
          ],
        },
      ],
      aisles: { count: 52, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -59, to: 59, back: 58, front: 2, backY: 40, frontY: 35.5, depth: 2.6, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, glazing: 0.3, lights: { every: 4, y: 35.5 } },
        { style: 'sheet', side: 'north', straight: true, from: -59, to: 59, back: 36, front: 1, backY: 25.5, frontY: 23, depth: 2.2, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, glazing: 0.3, lights: { every: 4, y: 23 } },
        // The Holte End's King Truss roof, sloping down to the pitch.
        { style: 'sheet', side: 'west', straight: true, from: -51, to: 51, back: 63, front: 4, backY: 40, frontY: 34.5, depth: 3, bay: 8, color: 0xb9bdc2, underColor: 0xd9dcde, glazing: 0.25, lights: { every: 5, y: 34.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8e9196, walls: 0x9a4b38 },
      runoff: { color: 0x2f7a3a, a: 55.5, b: 37, exponent: 14 },
      seatLook: {
        colors: ['#5f9fd6'],
        regions: [
          { tiers: [2], side: 'south', colors: ['#6b1d3a'] },
          { tiers: [1], side: 'north', colors: ['#6b1d3a'] },
          { tiers: [2], side: 'west', colors: ['#6b1d3a'] },
        ],
        text: [{ text: 'THE HOLTE END', color: '#6b1d3a', tier: 0, centerU: 0.5, halfU: 0.105, rows: [9, 32] }],
      },
      details: {
        ribbons: { color: 0x6b1d3a, tiers: [1, 2] },
        boxes: [
          { centerU: 0.75, halfU: 0.13, underTier: 2, count: 30 },
          { centerU: 0.25, halfU: 0.13, underTier: 1, count: 24 },
        ],
        buildings: [
          // The North Stand, stripped to its concrete frame for the rebuild.
          { side: 'east', straight: true, halfLength: 33, front: 3, depth: 26, y0: 0, y1: 7, color: 0x8d8c86 },
          { side: 'east', straight: true, halfLength: 30, front: 14, depth: 15, y0: 0, y1: 13, color: 0x7f7e79 },
          // The corner pavilion between the Holte End and the Trinity Road, its screen above.
          { side: 'south', straight: true, center: -64, halfLength: 7.5, front: 3, depth: 18, y0: 0, y1: 15, glassFloors: 3, color: 0x9a4b38 },
        ],
        cranes: [
          { at: [86, -22], height: 52, jib: 50, angle: 165 },
          { at: [92, 28], height: 46, jib: 44, angle: 200, color: 0xe8b416 },
        ],
        screens: [{ centerU: 0.625, widthM: 10, heightM: 5.5, post: { offset: 10, y: 19 } }],
        skins: [
          // Red brick and glass: the Trinity Road's and the Holte End's facades.
          { side: 'south', straight: true, from: -59, to: 59, offset: 59, y0: 0, y1: 40, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
          { side: 'west', straight: true, from: -51, to: 51, offset: 64, y0: 0, y1: 40, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
          { side: 'north', straight: true, from: -59, to: 59, offset: 35, y0: 0, y1: 25.5, color: 0xa4a8ad, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'villa-park', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Villa Park (Birmingham)', source: 'builtin', country: 'Europe', capacity: 36887, type: 'Two-tier', inspiredBy: 'Villa Park, Aston, Birmingham - home of Aston Villa', tags: ['aston-villa', 'villa', 'villa-park', 'birmingham', 'aston', 'england', PL] },
  },
  {
    // St James' Park, Newcastle. The main stand (the Milburn Stand) is west
    // (-z here) and the Leazes End north (+x): together the great L, a huge
    // lower tier, a level of boxes and a steep upper tier under one 65 m
    // cantilever with a glass leading edge, wrapping the corner between them.
    // The low East Stand (+z) and the single-tier Gallowgate End (-x) are a
    // storey lower, the roofs stepping down at the corners. Grey seats.
    id: 'st-james-park-52k',
    template: {
      id: 'st-james-park-52k',
      name: "St James' Park (Newcastle)",
      version: 1,
      levels: 2,
      plan: { a: 56, b: 37.5, exponent: 12 },
      evenRows: true,
      tiers: [
        {
          rows: 46, rowDepth: 0.76, rakeDeg: 24, baseElevation: 1.2, baseOffset: 2.5, seatPitch: 0.46,
          omit: [{ side: 'north', from: -200, to: 200, fromRow: 28 }],
        },
        {
          // The upper tier round the Milburn and Leazes, Level 7 at the top.
          rows: 34, rowDepth: 0.8, rakeDeg: 35, baseElevation: 21.3, baseOffset: 38.5, seatPitch: 0.46,
          omit: [
            { side: 'north', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'south', from: -200, to: -50 }, { side: 'east', from: 30, to: 200 },
          ],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', back: 76, front: 14, backY: 50, frontY: 46, depth: 3, bay: 8, color: 0xe4e6e8, underColor: 0xd6d9dc, glazing: 0.55, girder: { offset: 52, height: 7 }, lights: { every: 4, y: 46 } },
        { style: 'sheet', side: 'east', back: 76, front: 14, backY: 50, frontY: 46, depth: 3, bay: 8, color: 0xe4e6e8, underColor: 0xd6d9dc, glazing: 0.55, girder: { offset: 52, height: 7 }, lights: { every: 4, y: 46 } },
        { style: 'sheet', side: 'west', back: 42, front: 4, backY: 25, frontY: 21.5, depth: 1.8, bay: 7, color: 0xb9bdc2, underColor: 0xd6d9dc, glazing: 0.3, lights: { every: 4, y: 21.5 } },
        { style: 'sheet', side: 'north', back: 27, front: 2, backY: 15.5, frontY: 13, depth: 1.6, bay: 7, color: 0xb9bdc2, underColor: 0x55595f, lights: { every: 4, y: 13 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5900 },
      finish: { concrete: 0x8e9196, walls: 0xb9bcc0 },
      runoff: { color: 0x2f7a3a, a: 56, b: 37.5, exponent: 12 },
      seatLook: {
        colors: ['#6e7278'],
        regions: [{ tiers: [1], colors: ['#6e7278', '#6e7278', '#2b2d31'], alternate: true }],
      },
      details: {
        ribbons: { color: 0x1d1f23, tiers: [1] },
        boxes: [{ centerU: 0.875, halfU: 0.2, underTier: 1, count: 80 }],
        screens: [
          { centerU: 0.95, widthM: 12, heightM: 6.5, hang: { offset: 28, y: 38, ceiling: 46 } },
          { centerU: 0.75, widthM: 10, heightM: 5.5, hang: { offset: 28, y: 38, ceiling: 46 } },
          // Strawberry Corner, the Gallowgate End and the East Stand.
          { centerU: 0.375, widthM: 9, heightM: 5, post: { offset: 16, y: 18 } },
        ],
        skins: [
          // The Milburn's glass front on Barrack Road; white steel and grey cladding round the rest.
          { side: 'south', offset: 74, y0: 0, y1: 50, color: 0x8a98a6, pattern: 'glass', tile: [4.5, 4] },
          { side: 'east', offset: 74, y0: 0, y1: 50, color: 0xb9bdc2, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', offset: 41, y0: 0, y1: 25, color: 0xd9dcdf, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', offset: 26, y0: 0, y1: 15.5, color: 0x9a9fa6, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'st-james-park', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: "St James' Park (Newcastle)", source: 'builtin', country: 'Europe', capacity: 52719, type: 'Two-tier', inspiredBy: "St James' Park, Newcastle upon Tyne - home of Newcastle United", tags: ['newcastle', 'newcastle-united', 'magpies', 'st-james-park', 'sjp', 'gallowgate', 'england', PL] },
  },
  {
    // The Stadium of Light, Sunderland. One continuous red bowl, its corners
    // in white. The main stand (the West Stand, named for Jimmy Montgomery:
    // lower tier, boxes, upper tier) is west (-z here); the North Stand +x,
    // its upper tier wrapping the corner from the West Stand, HA'WAY THE LADS
    // in its lower tier; the single-tier East Stand +z with SUNDERLAND A.F.C
    // along it; the single-tier Roker End -x.
    id: 'stadium-of-light-48k',
    template: {
      id: 'stadium-of-light-48k',
      name: 'Stadium of Light (Sunderland)',
      version: 1,
      levels: 2,
      plan: { a: 56, b: 37.5, exponent: 11 },
      evenRows: true,
      tiers: [
        {
          rows: 48, rowDepth: 0.78, rakeDeg: 26, baseElevation: 1.2, baseOffset: 2.5, seatPitch: 0.46,
          omit: [
            { side: 'south', from: -200, to: 200, fromRow: 36 },
            { side: 'east', from: -200, to: 200, fromRow: 36 },
            { side: 'north', from: -200, to: 200, fromRow: 44 },
          ],
        },
        {
          // The upper tier, from the West Stand round into the North Stand.
          rows: 26, rowDepth: 0.8, rakeDeg: 33, baseElevation: 18.5, baseOffset: 31, seatPitch: 0.46,
          omit: [
            { side: 'north', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'south', from: -200, to: -52 },
            { side: 'east', from: 44, to: 200 },
          ],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', back: 58, front: 4, backY: 38.5, frontY: 34, depth: 2.6, bay: 8, color: 0xc9ccd0, underColor: 0xe1e3e5, glazing: 0.25, lights: { every: 4, y: 34 } },
        { style: 'sheet', side: 'east', back: 57, front: 4, backY: 38, frontY: 33.5, depth: 2.6, bay: 8, color: 0xc9ccd0, underColor: 0xe1e3e5, glazing: 0.25, lights: { every: 4, y: 33.5 } },
        { style: 'sheet', side: 'north', back: 43, front: 4, backY: 26, frontY: 23, depth: 2.2, bay: 8, color: 0xc9ccd0, underColor: 0xe1e3e5, glazing: 0.25, lights: { every: 4, y: 23 } },
        { style: 'sheet', side: 'west', back: 43, front: 4, backY: 26, frontY: 23, depth: 2.2, bay: 8, color: 0xc9ccd0, underColor: 0xe1e3e5, glazing: 0.25, lights: { every: 4, y: 23 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9b9ea2, walls: 0xc9ccd0 },
      runoff: { color: 0x2f7a3a, a: 56, b: 37.5, exponent: 11 },
      seatLook: {
        colors: ['#d2232a'],
        regions: [
          // White corners, and the thin white band round the top of the East Stand and the Roker End.
          { tiers: [0], centerU: 0.125, halfU: 0.03, colors: ['#f1f1ef'] },
          { tiers: [0], centerU: 0.375, halfU: 0.03, colors: ['#f1f1ef'] },
          { tiers: [0], centerU: 0.625, halfU: 0.03, colors: ['#f1f1ef'] },
          { tiers: [0], centerU: 0.875, halfU: 0.03, colors: ['#f1f1ef'] },
          { tiers: [0], side: 'north', rows: [42, 43], colors: ['#f1f1ef'] },
          { tiers: [0], side: 'west', rows: [46, 47], colors: ['#f1f1ef'] },
        ],
        text: [
          { text: "HA'WAY", color: '#f1f1ef', tier: 0, centerU: 0, halfU: 0.06, rows: [19, 33] },
          { text: 'THE LADS', color: '#f1f1ef', tier: 0, centerU: 0, halfU: 0.075, rows: [3, 17] },
          { text: 'SUNDERLAND A.F.C', color: '#f1f1ef', tier: 0, centerU: 0.25, halfU: 0.095, rows: [4, 13] },
        ],
      },
      details: {
        ribbons: { color: 0xd2232a, tiers: [1] },
        boxes: [{ centerU: 0.8, halfU: 0.15, underTier: 1, count: 50 }],
        screens: [
          { centerU: 0.375, widthM: 10, heightM: 5.5, hang: { offset: 24, y: 19, ceiling: 24 } },
          { centerU: 0.875, widthM: 10, heightM: 5.5, hang: { offset: 38, y: 32, ceiling: 37 } },
        ],
        skins: [
          { side: 'south', offset: 57, y0: 0, y1: 38.5, color: 0xc9ccd0, pattern: 'panels', tile: [5, 3.5] },
          { side: 'east', offset: 56, y0: 0, y1: 38, color: 0xc9ccd0, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', offset: 42, y0: 0, y1: 26, color: 0xc9ccd0, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', offset: 42, y0: 0, y1: 26, color: 0xc9ccd0, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'stadium-of-light', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Stadium of Light (Sunderland)', source: 'builtin', country: 'Europe', capacity: 48095, type: 'Bowl', inspiredBy: 'Stadium of Light, Monkwearmouth, Sunderland - home of Sunderland', tags: ['sunderland', 'black-cats', 'stadium-of-light', 'wearside', 'england', PL] },
  },
  {
    // Elland Road, Leeds. The main stand (the John Charles Stand: two tiers
    // under an old pitched roof on columns, being rebuilt over the top, with
    // the cranes behind it) is west (-z here); the Jack Charlton Stand east
    // (+z), the vast black cantilever that towers over the rest; the Don
    // Revie Stand (the Kop), one steep tier wrapping both its corners, +x;
    // the Norman Hunter Stand, two tiers either side of its boxes, -x. Blue
    // seats; the south-east corner, the cheese wedge, in yellow.
    id: 'elland-road-37k',
    template: {
      id: 'elland-road-37k',
      name: 'Elland Road (Leeds)',
      version: 1,
      levels: 2,
      plan: { a: 55, b: 36, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 50, rowDepth: 0.76, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 18, offset: 1.5 },
            { side: 'north', halfLength: 55, rows: 36, offset: 4.5 },
            { side: 'east', halfLength: 54, rows: 50, offset: 4 },
            { side: 'west', halfLength: 48, rows: 15, offset: 2.5 },
          ],
        },
        {
          rows: 32, rowDepth: 0.8, rakeDeg: 32, baseElevation: 10, baseOffset: 15, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 55, rows: 18 },
            { side: 'north', halfLength: 55, rows: 32, offset: 17, elevation: 7.2 },
            { side: 'west', halfLength: 44, rows: 15, offset: -1 },
          ],
        },
      ],
      aisles: { count: 52, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // The John Charles Stand's old roof, on columns at the front of its upper tier; temporary lights on top.
        { style: 'sheet', side: 'south', straight: true, from: -57, to: 57, back: 31, front: 0, backY: 21, frontY: 16, depth: 1.6, bay: 7, color: 0xa4a8ad, underColor: 0x4f545c, columns: { every: 9, color: 0x2f3a5a, offset: 15 }, lights: { every: 5, y: 16 } },
        // The Jack Charlton Stand's great cantilever.
        { style: 'sheet', side: 'north', straight: true, from: -58, to: 58, back: 59, front: 3, backY: 41, frontY: 35.5, depth: 5, bay: 8, color: 0x3b4048, underColor: 0x1f2226, girder: { offset: 3.5, height: 3.5, color: 0x1d8f9c }, lights: { every: 3.5, y: 39.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -57, to: 57, back: 45, front: 2, backY: 24, frontY: 20, depth: 2.4, bay: 8, color: 0xa4a8ad, underColor: 0x3b4048, lights: { every: 4, y: 20 } },
        { style: 'sheet', side: 'west', straight: true, from: -50, to: 50, back: 29, front: 1, backY: 19.5, frontY: 16, depth: 1.8, bay: 8, color: 0xa4a8ad, underColor: 0x3b4048, lights: { every: 5, y: 16 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8e9196, walls: 0x9fa4aa },
      runoff: { color: 0x2f7a3a, a: 55, b: 36, exponent: 14 },
      seatLook: {
        colors: ['#1f4fa0'],
        regions: [{ tiers: [0], centerU: 0.375, halfU: 0.035, colors: ['#f2c500'] }],
      },
      details: {
        ribbons: { color: 0x1d8f9c, tiers: [1] },
        boxes: [
          { centerU: 0.25, halfU: 0.13, underTier: 1, count: 25 },
          { centerU: 0.5, halfU: 0.1, underTier: 1, count: 32 },
        ],
        cranes: [
          { at: [-30, -98], height: 58, jib: 55, angle: 70 },
          { at: [38, -104], height: 50, jib: 48, angle: 110, color: 0xe8b416 },
        ],
        screens: [{ centerU: 0.625, widthM: 10, heightM: 5.5, post: { offset: 12, y: 15 } }],
        skins: [
          { side: 'north', straight: true, from: -58, to: 58, offset: 58, y0: 0, y1: 41, color: 0x3b4048, pattern: 'panels', tile: [5, 3.5] },
          { side: 'east', straight: true, from: -57, to: 57, offset: 44, y0: 0, y1: 24, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', straight: true, from: -50, to: 50, offset: 28, y0: 0, y1: 19.5, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
        ],
      },
      site: { key: 'elland-road', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Elland Road (Leeds)', source: 'builtin', country: 'Europe', capacity: 37645, type: 'Two-tier', inspiredBy: 'Elland Road, Beeston, Leeds - home of Leeds United', tags: ['leeds', 'leeds-united', 'elland-road', 'yorkshire', 'england', PL] },
  },
  {
    // The City Ground, Nottingham, on the bank of the Trent. The main stand
    // (the old Peter Taylor Stand: one low tier split by a walkway) is south
    // (-z here); the Brian Clough Stand north (+z), two tiers either side of
    // its boxes, FOREST in white across the upper tier; the Trent End, the
    // home end, +x, two tiers either side of a glazed band; the John
    // Robertson (Bridgford) Stand -x, its roof dropping towards one corner.
    // Red seats.
    id: 'city-ground-31k',
    template: {
      id: 'city-ground-31k',
      name: 'City Ground (Nottingham)',
      version: 1,
      levels: 2,
      plan: { a: 54, b: 36, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 34, rowDepth: 0.76, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'south', halfLength: 50, rows: 34, offset: 4 },
            { side: 'north', halfLength: 55, rows: 18, offset: 1.5 },
            { side: 'east', halfLength: 36, rows: 28, offset: 1.5 },
            { side: 'west', halfLength: 40, rows: 33, offset: 1.5 },
          ],
        },
        {
          rows: 29, rowDepth: 0.8, rakeDeg: 32, baseElevation: 10.5, baseOffset: 15.5, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'north', halfLength: 55, rows: 29 },
            { side: 'east', halfLength: 36, rows: 26, offset: 7, elevation: 3.5 },
            // Only over the half of the Bridgford Stand with the high roof.
            { side: 'west', halfLength: 21, center: 21, rows: 18, offset: 9, elevation: 4 },
          ],
        },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -52, to: 52, back: 30, front: 1, backY: 14.5, frontY: 12, depth: 1.5, bay: 7, color: 0xa4a8ad, underColor: 0x4f545c, columns: { every: 12, color: 0x8a1c22, offset: 3.5 }, lights: { every: 5, y: 12 } },
        { style: 'sheet', side: 'north', straight: true, from: -57, to: 57, back: 39, front: 1, backY: 27, frontY: 23.5, depth: 2.2, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, lights: { every: 4, y: 23.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -38, to: 38, back: 43, front: 2, backY: 29.5, frontY: 25, depth: 2.4, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, lights: { every: 4, y: 25 } },
        // The Robertson Stand's roof, low over one half for the houses behind.
        { style: 'sheet', side: 'west', straight: true, from: -42, to: 0, back: 40, front: 2, backY: 17, frontY: 14, depth: 2, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, lights: { every: 4, y: 14 } },
        { style: 'sheet', side: 'west', straight: true, from: 0, to: 42, back: 42, front: 2, backY: 26, frontY: 22.5, depth: 2, bay: 8, color: 0xb9bdc2, underColor: 0xe9ebec, lights: { every: 4, y: 22.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0x8e9196, walls: 0x9fa4aa },
      runoff: { color: 0x2f7a3a, a: 54, b: 36, exponent: 14 },
      seatLook: { colors: ['#d4202a'], text: [{ text: 'FOREST', color: '#f4f4f2', tier: 1, centerU: 0.25, halfU: 0.085, rows: [5, 24] }] },
      details: {
        ribbons: { color: 0xd4202a, tiers: [1] },
        boxes: [
          { centerU: 0.25, halfU: 0.13, underTier: 1, count: 33 },
          { centerU: 0, halfU: 0.09, underTier: 1, count: 16 },
        ],
        buildings: [
          // The Corner Box: stacked shipping containers between the Trent End and the Clough Stand.
          { side: 'north', straight: true, center: 61, halfLength: 6.5, front: 2, depth: 14, y0: 0, y1: 8.5, glassFloors: 2, color: 0x2b2d31 },
        ],
        screens: [
          { centerU: 0.5, widthM: 14, heightM: 4.5, hang: { offset: 24, y: 15, ceiling: 17.5 } },
          { centerU: 0.09, widthM: 9, heightM: 5, post: { offset: 8, y: 13 } },
        ],
        skins: [
          { side: 'north', straight: true, from: -57, to: 57, offset: 38, y0: 0, y1: 27, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'east', straight: true, from: -38, to: 38, offset: 42, y0: 0, y1: 29.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'south', straight: true, from: -52, to: 52, offset: 29, y0: 0, y1: 14.5, color: 0x9a4b38, pattern: 'brick', tile: [3, 3] },
        ],
      },
      site: { key: 'city-ground', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'City Ground (Nottingham)', source: 'builtin', country: 'Europe', capacity: 31212, type: 'Two-tier', inspiredBy: 'The City Ground, West Bridgford, Nottingham - home of Nottingham Forest', tags: ['nottingham-forest', 'forest', 'city-ground', 'nottingham', 'trent', 'england', PL] },
  },
  {
    // The CBS Arena, Coventry. One enclosed bowl on a podium, every corner
    // filled to the same height, sky-blue seats under one continuous roof
    // with a strip of clear sheeting at the back. The main stand (the West
    // Stand: a big lower tier and a small upper one over a row of boxes, the
    // hotel's pitch-view rooms above) is west (-z here); the East Stand +z,
    // the North Stand (the home end, CCFC in dark seats) +x, the South Stand
    // (SKY BLUES, the screen) -x.
    id: 'cbs-arena-32k',
    template: {
      id: 'cbs-arena-32k',
      name: 'CBS Arena (Coventry)',
      version: 1,
      levels: 2,
      plan: { a: 56, b: 37, exponent: 7 },
      evenRows: true,
      tiers: [
        { rows: 34, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.6, baseOffset: 5, seatPitch: 0.46 },
        {
          // The West Stand's small upper tier.
          rows: 15, rowDepth: 0.82, rakeDeg: 33, baseElevation: 20.5, baseOffset: 31.2, seatPitch: 0.46,
          omit: [
            { side: 'north', from: -200, to: 200 }, { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'south', from: -200, to: -54 }, { side: 'south', from: 54, to: 200 },
          ],
        },
      ],
      aisles: { count: 60, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', back: 36, front: 8, backY: 25, frontY: 23, depth: 2.4, bay: 8, color: 0xc9ccd0, underColor: 0xd9dcde, glazing: 0.3, lights: { every: 4, y: 23 }, omit: [{ side: 'south', from: -200, to: 200 }] },
        { style: 'sheet', side: 'south', back: 47, front: 8, backY: 31, frontY: 27, depth: 2.4, bay: 8, color: 0xc9ccd0, underColor: 0xd9dcde, glazing: 0.2, lights: { every: 4, y: 27 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9b9ea2, walls: 0xc9ccd0 },
      runoff: { color: 0x2f7a3a, a: 56, b: 37, exponent: 7 },
      seatLook: {
        colors: ['#4ea6e0'],
        text: [
          { text: 'CCFC', color: '#1b2a4a', tier: 0, centerU: 0, halfU: 0.07, rows: [6, 26] },
          { text: 'SKY BLUES', color: '#1b2a4a', tier: 0, centerU: 0.5, halfU: 0.09, rows: [8, 24] },
        ],
      },
      details: {
        ribbons: { color: 0x1b2a4a, tiers: [1] },
        boxes: [{ centerU: 0.75, halfU: 0.1, underTier: 1, count: 30 }],
        screens: [{ centerU: 0.5, widthM: 10, heightM: 5.5, hang: { offset: 16, y: 19, ceiling: 24 } }],
        skins: [
          { side: 'north', offset: 35, y0: 0, y1: 25, color: 0xc9ccd0, pattern: 'panels', tile: [6, 4] },
          { side: 'east', offset: 35, y0: 0, y1: 25, color: 0xc9ccd0, pattern: 'panels', tile: [6, 4] },
          { side: 'west', offset: 35, y0: 0, y1: 25, color: 0xc9ccd0, pattern: 'panels', tile: [6, 4] },
          // The West Stand's back: the hotel's windows over the car park.
          { side: 'south', offset: 46, y0: 0, y1: 31, color: 0x8a98a6, pattern: 'glass', tile: [4, 3.6] },
        ],
      },
      site: { key: 'coventry', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'CBS Arena (Coventry)', source: 'builtin', country: 'Europe', capacity: 32609, type: 'Bowl', inspiredBy: 'The CBS Arena, Longford, Coventry - home of Coventry City', tags: ['coventry', 'coventry-city', 'sky-blues', 'cbs-arena', 'ricoh', 'england', PL] },
  },
  {
    // The MKM Stadium, Hull, in West Park. A round single-tier bowl set back
    // from the pitch for rugby league, black seats with a band of white and
    // amber round it and HULL in both ends; the main stand (the West Stand,
    // with a second tier over a row of boxes and the highest roof) is west
    // (-z here); the East Stand +z, the North Stand +x and the South Stand
    // (the Kop) -x.
    id: 'mkm-25k',
    template: {
      id: 'mkm-25k',
      name: 'MKM Stadium (Hull)',
      version: 1,
      levels: 2,
      plan: { a: 57, b: 37, exponent: 6 },
      evenRows: true,
      tiers: [
        { rows: 25, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.5, baseOffset: 6, seatPitch: 0.47 },
        {
          // The West Stand's upper tier.
          rows: 20, rowDepth: 0.82, rakeDeg: 33, baseElevation: 15.2, baseOffset: 25.9, seatPitch: 0.47,
          omit: [
            { side: 'north', from: -200, to: 200 }, { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'south', from: -200, to: -56 }, { side: 'south', from: 56, to: 200 },
          ],
        },
      ],
      aisles: { count: 56, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', back: 46, front: 6, backY: 31, frontY: 27, depth: 2.6, bay: 8, color: 0xb9bdc2, underColor: 0xd6d9dc, glazing: 0.3, lights: { every: 4, y: 27 } },
        { style: 'sheet', side: 'north', back: 30, front: 6, backY: 17.5, frontY: 16, depth: 2, bay: 8, color: 0xb9bdc2, underColor: 0xd6d9dc, glazing: 0.3, lights: { every: 4, y: 16 } },
        { style: 'sheet', side: 'east', back: 30, front: 6, backY: 17.5, frontY: 16, depth: 2, bay: 8, color: 0xb9bdc2, underColor: 0xd6d9dc, glazing: 0.3, lights: { every: 4, y: 16 } },
        { style: 'sheet', side: 'west', back: 30, front: 6, backY: 17.5, frontY: 16, depth: 2, bay: 8, color: 0xb9bdc2, underColor: 0xd6d9dc, glazing: 0.3, lights: { every: 4, y: 16 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0x8e9196, walls: 0x9aa0a6 },
      runoff: { color: 0x2f7a3a, a: 57, b: 37, exponent: 6 },
      seatLook: {
        colors: ['#1c1d20'],
        regions: [
          { tiers: [0], rows: [18, 18], colors: ['#f1f1ef'] },
          { tiers: [0], rows: [19, 19], colors: ['#f5a800'] },
        ],
        text: [
          { text: 'HULL', color: '#f1f1ef', tier: 0, centerU: 0, halfU: 0.055, rows: [3, 16] },
          { text: 'HULL', color: '#f1f1ef', tier: 0, centerU: 0.5, halfU: 0.055, rows: [3, 16] },
        ],
      },
      details: {
        ribbons: { color: 0xf5a800, tiers: [1] },
        boxes: [{ centerU: 0.75, halfU: 0.1, underTier: 1, count: 28 }],
        screens: [{ centerU: 0, widthM: 9, heightM: 4.5, hang: { offset: 16, y: 13, ceiling: 15.5 } }],
        skins: [
          { side: 'south', offset: 45, y0: 0, y1: 31, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', offset: 29, y0: 0, y1: 17.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'east', offset: 29, y0: 0, y1: 17.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', offset: 29, y0: 0, y1: 17.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'mkm', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'MKM Stadium (Hull)', source: 'builtin', country: 'Europe', capacity: 24983, type: 'Bowl', inspiredBy: 'The MKM Stadium, West Park, Hull - home of Hull City', tags: ['hull', 'hull-city', 'tigers', 'mkm', 'kcom', 'england', PL] },
  },
  {
    // Portman Road, Ipswich. Four separate stands in the town centre, blue
    // seats, open corners with floodlight pylons in them. The main stand (the
    // West Stand, three tiers, the boxes and the press) is west (-z here);
    // the older two-tier Cobbold Stand east (+z) under its low roof; the
    // Sir Bobby Robson Stand +x and the Sir Alf Ramsey Stand -x, matching
    // two-tier ends from 2001-02, the screen in the corner by the Cobbold.
    id: 'portman-road-30k',
    template: {
      id: 'portman-road-30k',
      name: 'Portman Road (Ipswich)',
      version: 1,
      levels: 3,
      plan: { a: 54, b: 36, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 24, rowDepth: 0.76, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'south', halfLength: 56, rows: 18, offset: 1.5 },
            { side: 'north', halfLength: 56, rows: 22, offset: 1.5 },
            { side: 'east', halfLength: 37, rows: 24, offset: 3.5 },
            { side: 'west', halfLength: 37, rows: 24, offset: 3.5 },
          ],
        },
        {
          rows: 20, rowDepth: 0.8, rakeDeg: 31, baseElevation: 9.5, baseOffset: 15.5, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'south', halfLength: 56, rows: 12 },
            { side: 'north', halfLength: 56, rows: 16, offset: 2.5, elevation: 2 },
            { side: 'east', halfLength: 37, rows: 20, offset: 6, elevation: 3 },
            { side: 'west', halfLength: 37, rows: 20, offset: 6, elevation: 3 },
          ],
        },
        {
          // The West Stand's top tier, added in 1982.
          rows: 14, rowDepth: 0.8, rakeDeg: 34, baseElevation: 18, baseOffset: 25, seatPitch: 0.45, straight: true,
          stands: [{ side: 'south', halfLength: 54, rows: 14 }],
        },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -58, to: 58, back: 38, front: 1, backY: 28.5, frontY: 24, depth: 2, bay: 7.5, color: 0xa4a8ad, underColor: 0x4f545c, lights: { every: 5, y: 24 } },
        { style: 'sheet', side: 'north', straight: true, from: -58, to: 58, back: 32, front: 1, backY: 21, frontY: 17.5, depth: 1.8, bay: 7.5, color: 0xa4a8ad, underColor: 0x4f545c, columns: { every: 15, color: 0x2f3a5a, offset: 31 } },
        { style: 'sheet', side: 'east', straight: true, from: -39, to: 39, back: 39, front: 2, backY: 25, frontY: 21.5, depth: 2, bay: 7.5, color: 0xa4a8ad, underColor: 0x3b4048 },
        { style: 'sheet', side: 'west', straight: true, from: -39, to: 39, back: 39, front: 2, backY: 25, frontY: 21.5, depth: 2, bay: 7.5, color: 0xa4a8ad, underColor: 0x3b4048 },
      ],
      lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[63, 47]], height: 42, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x8e9196, walls: 0x9fa4aa },
      runoff: { color: 0x2f7a3a, a: 54, b: 36, exponent: 14 },
      seatLook: { colors: ['#1e4fb4'] },
      details: {
        ribbons: { color: 0x1e4fb4, tiers: [1, 2] },
        boxes: [
          { centerU: 0.75, halfU: 0.13, underTier: 2, count: 22 },
          { centerU: 0.25, halfU: 0.13, underTier: 1, count: 18 },
        ],
        screens: [{ centerU: 0.375, widthM: 10, heightM: 5.5, post: { offset: 9, y: 11 } }],
        skins: [
          { side: 'south', straight: true, from: -58, to: 58, offset: 37, y0: 0, y1: 28.5, color: 0x9aa0a6, pattern: 'panels', tile: [5, 3.5] },
          { side: 'north', straight: true, from: -58, to: 58, offset: 31, y0: 0, y1: 21, color: 0x8e5a44, pattern: 'brick', tile: [3, 3] },
          { side: 'east', straight: true, from: -39, to: 39, offset: 38, y0: 0, y1: 25, color: 0x6f86a8, pattern: 'panels', tile: [5, 3.5] },
          { side: 'west', straight: true, from: -39, to: 39, offset: 38, y0: 0, y1: 25, color: 0x6f86a8, pattern: 'panels', tile: [5, 3.5] },
        ],
      },
      site: { key: 'portman-road', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Portman Road (Ipswich)', source: 'builtin', country: 'Europe', capacity: 30056, type: 'Two-tier', inspiredBy: 'Portman Road, Ipswich - home of Ipswich Town', tags: ['ipswich', 'ipswich-town', 'tractor-boys', 'portman-road', 'suffolk', 'england', PL] },
  },
  {
    // Hill Dickinson Stadium, Bramley-Moore Dock, Liverpool (2025). Very
    // steep blue stands hard against the pitch, every corner filled, under
    // one roof of white steel trusses and clear sheeting. The main stand
    // (the West Stand on the river: two tiers either side of the boxes, the
    // Tunnel Club) is west (-z here); the two-tier East Stand +z; the
    // slightly lower North Stand +x, glass behind it; the single-tier South
    // Stand -x, 13,000 in one wall. A brick plinth like the dock warehouses
    // with a metal body above.
    id: 'hill-dickinson-52k',
    template: {
      id: 'hill-dickinson-52k',
      name: 'Hill Dickinson Stadium (Liverpool)',
      version: 1,
      levels: 2,
      plan: { a: 55, b: 36.5, exponent: 14 },
      evenRows: true,
      tiers: [
        {
          rows: 70, rowDepth: 0.78, rakeDeg: 31, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'south', halfLength: 57, rows: 34, offset: 2 },
            { side: 'north', halfLength: 57, rows: 34, offset: 2 },
            { side: 'east', halfLength: 47, rows: 32, offset: 2.5 },
            { side: 'west', halfLength: 52, rows: 70, offset: 2.5 },
          ],
        },
        {
          rows: 34, rowDepth: 0.8, rakeDeg: 35, baseElevation: 21, baseOffset: 29, seatPitch: 0.45, straight: true,
          stands: [
            { side: 'south', halfLength: 57, rows: 34 },
            { side: 'north', halfLength: 57, rows: 34 },
            { side: 'east', halfLength: 47, rows: 22, offset: -1.5, elevation: -1 },
          ],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', side: 'south', straight: true, from: -112, to: 112, back: 58, front: 2, backY: 44, frontY: 40, depth: 3.4, bay: 8, color: 0xb9bdc2, underColor: 0xeef0f1, glazing: 0.6, lights: { every: 4, y: 40 } },
        { style: 'truss', side: 'north', straight: true, from: -112, to: 112, back: 58, front: 2, backY: 44, frontY: 40, depth: 3.4, bay: 8, color: 0xb9bdc2, underColor: 0xeef0f1, glazing: 0.6, lights: { every: 4, y: 40 } },
        { style: 'truss', side: 'east', straight: true, from: -55, to: 55, back: 47, front: 2, backY: 37, frontY: 34, depth: 3.4, bay: 8, color: 0xb9bdc2, underColor: 0xeef0f1, glazing: 0.6, lights: { every: 4, y: 34 } },
        { style: 'truss', side: 'west', straight: true, from: -55, to: 55, back: 59, front: 2, backY: 42, frontY: 38, depth: 3.4, bay: 8, color: 0xb9bdc2, underColor: 0xeef0f1, glazing: 0.6, lights: { every: 4, y: 38 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5900 },
      finish: { concrete: 0x9b9ea2, walls: 0xb9bcc0 },
      runoff: { color: 0x2f7a3a, a: 55, b: 36.5, exponent: 14 },
      seatLook: { colors: ['#1f45b8'] },
      details: {
        ribbons: { color: 0x1d2a5c, tiers: [1] },
        boxes: [
          { centerU: 0.75, halfU: 0.12, underTier: 1, count: 30 },
          { centerU: 0.25, halfU: 0.12, underTier: 1, count: 30 },
        ],
        screens: [
          { centerU: 0, widthM: 12, heightM: 6.5, hang: { offset: 22, y: 28, ceiling: 34 } },
          { centerU: 0.5, widthM: 12, heightM: 6.5, hang: { offset: 34, y: 35, ceiling: 41 } },
        ],
        skins: [
          // The dock-warehouse plinth: brick and black panels.
          { side: 'south', straight: true, from: -112, to: 112, offset: 57, y0: 0, y1: 14, color: 0x8e4a36, pattern: 'brick', tile: [3, 3] },
          { side: 'north', straight: true, from: -112, to: 112, offset: 57, y0: 0, y1: 14, color: 0x8e4a36, pattern: 'brick', tile: [3, 3] },
          { side: 'west', straight: true, from: -93, to: 93, offset: 58, y0: 0, y1: 14, color: 0x8e4a36, pattern: 'brick', tile: [3, 3] },
          // The metal body above, and the glass wall behind the North Stand.
          { side: 'south', straight: true, from: -112, to: 112, offset: 57, y0: 14, y1: 44, color: 0xb9bdc2, pattern: 'panels', tile: [4, 4] },
          { side: 'north', straight: true, from: -112, to: 112, offset: 57, y0: 14, y1: 44, color: 0xb9bdc2, pattern: 'panels', tile: [4, 4] },
          { side: 'west', straight: true, from: -93, to: 93, offset: 58, y0: 14, y1: 42, color: 0xb9bdc2, pattern: 'panels', tile: [4, 4] },
          { side: 'east', straight: true, from: -93, to: 93, offset: 46, y0: 0, y1: 37, color: 0x8a98a6, pattern: 'glass', tile: [4.5, 4] },
        ],
      },
      site: { key: 'hill-dickinson', horizon: 'city', ground: 0x6f7f55, forecourt: 0x9b9a94, style: 'uk' },
    },
    meta: { name: 'Hill Dickinson Stadium (Liverpool)', source: 'builtin', country: 'Europe', capacity: 52769, type: 'Two-tier', inspiredBy: 'Hill Dickinson Stadium, Bramley-Moore Dock, Liverpool - home of Everton', tags: ['everton', 'toffees', 'hill-dickinson', 'bramley-moore', 'everton-stadium', 'liverpool', 'merseyside', 'england', PL] },
  },
];
