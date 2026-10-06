/**
 * LaLiga's grounds, 2026-27 — all twenty, as they stand this season.
 *
 * Each is built from the ground's OpenStreetMap footprint (pitch, stands and
 * their heights, © OpenStreetMap contributors, ODbL), Esri satellite pictures
 * and recent photographs, with the capacity the club or the league publishes.
 * The frame is the engine's: the main stand (tunnel, dugouts, palco) is south
 * (-z), the stand opposite north, the ends east (+x) and west (-x). Which real
 * compass side each one is on is in the comment above it.
 *
 * Several are building sites this season, and are built as they physically
 * stand in October 2026, not as they will be: Camp Nou's third tier is bare
 * concrete with no roof over it, the Coliseum's main stand has lost its upper
 * tier, and Balaídos' new Gol end is a frame with five rows of seats in it.
 * A tier that is built but not yet seated is a `building` tier: its concrete
 * is drawn and nobody sits in it.
 *
 * Seat maps are frozen once released (scripts/verify.mts): a change to a
 * ground's seats after that needs a new id.
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { Crane, Girder } from './types';

const LL = 'laliga';

/**
 * A ring of straight girder segments round a superellipse — Camp Nou's
 * compression ring on its crown of pillars, a roof's perimeter truss.
 */
function RING(a: number, b: number, p: number, y: number, height: number, n: number, color: number): Girder[] {
  const at = (t: number): [number, number] => {
    const c = Math.cos(t), s = Math.sin(t);
    return [a * Math.sign(c) * Math.abs(c) ** (2 / p), b * Math.sign(s) * Math.abs(s) ** (2 / p)];
  };
  const out: Girder[] = [];
  for (let i = 0; i < n; i++) {
    const from = at((i / n) * Math.PI * 2);
    const to = at(((i + 1) / n) * Math.PI * 2);
    out.push({ from, to, y, height, bay: 4, color });
  }
  return out;
}

/** A yellow tower crane on a building site. */
function CRANE(x: number, z: number, height: number, jib: number, angle: number): Crane {
  return { at: [x, z], height, jib, angle, color: 0xf2c200 };
}

export const LA_LIGA: StadiumEntry[] = [
  {
    // Mendizorrotza, Vitoria-Gasteiz. The Principal (main) stand is on the
    // south side (-z here), under its leaky clear polycarbonate roof; the
    // Preferente opposite (north), the Polideportivo end east (-x here) and
    // the Paseo de Cervantes end west (+x). Pitch 105 x 68 (OSM). One low bowl
    // with its corners filled, the sides split in two by a walkway, every
    // seat under a roof on columns.
    id: 'mendizorrotza-20k',
    template: {
      id: 'mendizorrotza-20k',
      name: 'Mendizorrotza (Vitoria-Gasteiz)',
      version: 1,
      levels: 1,
      plan: { a: 58.5, b: 40, exponent: 10 },
      evenRows: true,
      tiers: [
        { rows: 19, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        {
          // The back of the sides and the corners, over the walkway.
          rows: 9, rowDepth: 0.8, rakeDeg: 30, baseElevation: 9.8, baseOffset: 17.8, seatPitch: 0.47,
          omit: [{ side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 }],
        },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 32,
      roof: { coverage: 'none' },
      roofs: [
        // Metal sheet on columns along the front, all round but the main stand.
        { style: 'sheet', back: 28, front: 2, backY: 18.5, frontY: 14.5, depth: 1.2, bay: 8, color: 0xc4c8cc, underColor: 0x8a9096, omit: [{ side: 'south', from: -200, to: 200 }], columns: { every: 16, offset: 4, color: 0xd6d8da } },
        // The Principal's clear polycarbonate.
        { style: 'sheet', side: 'south', from: -62, to: 62, back: 28, front: 1, backY: 18.5, frontY: 14.5, depth: 1.2, bay: 6, color: 0xb9d2e6, underColor: 0xc9d8e4, glazing: 0.95, columns: { every: 16, offset: 4, color: 0xd6d8da } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5000 },
      finish: { concrete: 0x8f9296, walls: 0x9fa4aa },
      facade: { style: 'cladding', color: 0xb9bdc2, accent: 0x8e949a },
      runoff: { color: 0x2f7a3a, a: 58.5, b: 40, exponent: 10 },
      seatLook: {
        colors: ['#1e3f8e'],
        text: [
          { text: 'DEPORTIVO', color: '#8fb6e6', tier: 0, centerU: 0.25, halfU: 0.1, rows: [11, 18] },
          { text: 'ALAVÉS', color: '#8fb6e6', tier: 0, centerU: 0.25, halfU: 0.07, rows: [2, 9] },
        ],
      },
      details: {
        ribbons: { color: 0x1e4fa8, tiers: [1] },
        screens: [{ centerU: 0.5, widthM: 9, heightM: 5, hang: { offset: 14, y: 14, ceiling: 17 } }],
        skins: [{ offset: 26.5, y0: 0, y1: 16.5, color: 0xb9bdc2, pattern: 'panels', tile: [4, 3] }],
      },
      site: { key: 'mendizorrotza', horizon: 'city', ground: 0x7e8462, forecourt: 0xa8a59c, style: 'es' },
    },
    meta: { name: 'Mendizorrotza (Vitoria-Gasteiz)', source: 'builtin', country: 'Europe', capacity: 19840, type: 'Single-tier', inspiredBy: 'Estadio de Mendizorrotza, Vitoria-Gasteiz - home of Deportivo Alavés', tags: ['alaves', 'deportivo-alaves', 'vitoria', 'gasteiz', 'mendizorroza', 'mendi', 'spain', LL] },
  },
  {
    // San Mamés, Bilbao. The Tribuna Principal is on the south-west side (-z
    // here); the Tribuna Este opposite, the Norte end (the Herri Harmaila)
    // north-west (+x here) and the Sur end south-east (-x). Pitch 105 x 66
    // (OSM). One closed bowl: a lower tier, a thin ring of premium seats over
    // the boxes and a steep upper tier that peaks at the middle of each side,
    // under a white ETFE roof on radial trusses with an oval hole over the pitch.
    id: 'san-mames-53k',
    template: {
      id: 'san-mames-53k',
      name: 'San Mamés (Bilbao)',
      version: 1,
      levels: 3,
      plan: { a: 59, b: 41.5, exponent: 8 },
      evenRows: true,
      tiers: [
        { rows: 24, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.47 },
        { rows: 8, rowDepth: 0.85, rakeDeg: 28, baseElevation: 13.2, baseOffset: 24, seatPitch: 0.5 },
        {
          // The upper tier: full depth at the middle of each side, lower at the corners and ends.
          rows: 25, rowDepth: 0.82, rakeDeg: 35, baseElevation: 20.5, baseOffset: 33.5, seatPitch: 0.47,
          omit: [
            { side: 'north', from: -200, to: -40, fromRow: 21 }, { side: 'north', from: 40, to: 200, fromRow: 21 },
            { side: 'south', from: -200, to: -40, fromRow: 21 }, { side: 'south', from: 40, to: 200, fromRow: 21 },
            { side: 'east', from: -200, to: 200, fromRow: 21 }, { side: 'west', from: -200, to: 200, fromRow: 21 },
          ],
        },
      ],
      aisles: { count: 64, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'membrane', back: 64, front: -6, backY: 47, frontY: 41, depth: 3, bay: 6, color: 0xf3f3f0, underColor: 0xeae6df, lights: { every: 5, y: 41.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x2b2b2e, walls: 0x8c1d22 },
      facade: { style: 'membrane', color: 0xf2f2ef, accent: 0xd9dbdc },
      runoff: { color: 0x2f7a3a, a: 59, b: 41.5, exponent: 8 },
      seatLook: {
        colors: ['#d0021b'],
        text: [{ text: 'ATHLETIC CLUB', color: '#f4f4f2', tier: 0, centerU: 0.25, halfU: 0.1, rows: [4, 17] }],
      },
      details: {
        ribbons: { color: 0xd0021b, tiers: [1, 2] },
        boxes: [{ centerU: 0.25, halfU: 0.16, underTier: 1, count: 50 }, { centerU: 0.75, halfU: 0.16, underTier: 1, count: 50 }],
        // The white ETFE fins round the outside, lit at night.
        skins: [{ offset: 58, y0: 0, y1: 40, color: 0xf2f2ef, pattern: 'slats', tile: [3.2, 2.4], glow: 0.5 }],
        screens: [
          { centerU: 0, widthM: 14, heightM: 7.5, hang: { offset: 30, y: 34, ceiling: 46 } },
          { centerU: 0.5, widthM: 14, heightM: 7.5, hang: { offset: 30, y: 34, ceiling: 46 } },
        ],
      },
      site: { key: 'san-mames', horizon: 'hills', ground: 0x6f7a5a, forecourt: 0xa5a29a, style: 'es' },
    },
    meta: { name: 'San Mamés (Bilbao)', source: 'builtin', country: 'Europe', capacity: 53331, type: 'Bowl', inspiredBy: 'Estadio de San Mamés, Bilbao - home of Athletic Club', tags: ['athletic', 'athletic-club', 'athletic-bilbao', 'bilbao', 'san-mames', 'basque', 'spain', LL] },
  },
  {
    // Riyadh Air Metropolitano, Madrid. The main stand is the old La Peineta
    // on the west side (-z here); the Lateral Este opposite, the Fondo Norte
    // north (+x here) and the Fondo Sur south (-x). Pitch 105 x 68 (OSM).
    // Three continuous tiers, except that the old west upper tier stops short
    // of the corners; a white membrane roof on a cable wheel over all of it,
    // with a 360-degree screen hung in its inner ring.
    id: 'metropolitano-71k',
    template: {
      id: 'metropolitano-71k',
      name: 'Riyadh Air Metropolitano (Madrid)',
      version: 1,
      levels: 3,
      plan: { a: 61, b: 43, exponent: 6 },
      evenRows: true,
      tiers: [
        { rows: 29, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.5 },
        { rows: 15, rowDepth: 0.85, rakeDeg: 30, baseElevation: 15.5, baseOffset: 28.5, seatPitch: 0.5 },
        {
          rows: 27, rowDepth: 0.85, rakeDeg: 34, baseElevation: 27, baseOffset: 46, seatPitch: 0.5,
          // The Peineta's upper tier does not join up with the new ring.
          omit: [{ side: 'south', from: -200, to: -58 }, { side: 'south', from: 58, to: 200 }],
        },
      ],
      aisles: { count: 72, widthMeters: 1.0 },
      sectionsPerTier: 56,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'membrane', back: 76, front: -4, backY: 50, frontY: 44, depth: 2.5, bay: 7, color: 0xf6f6f4, underColor: 0xeee8dc, lights: { every: 5, y: 44.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9a958c, walls: 0xd6cdbb },
      facade: { style: 'concrete', color: 0xd9d0bf, accent: 0xb9b0a0 },
      runoff: { color: 0x2f7a3a, a: 61, b: 43, exponent: 6 },
      seatLook: {
        colors: ['#c8102e'],
        text: [
          { text: 'ATLÉTICO DE MADRID', color: '#f6f2ee', tier: 1, centerU: 0.25, halfU: 0.13, rows: [3, 14] },
          { text: '1903', color: '#f6f2ee', tier: 0, centerU: 0.25, halfU: 0.035, rows: [18, 27] },
        ],
      },
      details: {
        ribbons: { color: 0x2a62d8, tiers: [1, 2] },
        boxes: [
          { centerU: 0.25, halfU: 0.16, underTier: 1, count: 40 },
          { centerU: 0, halfU: 0.1, underTier: 1, count: 22 },
          { centerU: 0.5, halfU: 0.1, underTier: 1, count: 22 },
        ],
        // Bare concrete with its slots, the white roof over it.
        skins: [{ offset: 70, y0: 0, y1: 43, color: 0xd9d0bf, pattern: 'panels', tile: [6, 3.2] }],
        screens: [
          { centerU: 0, widthM: 16, heightM: 8, hang: { offset: 36, y: 38, ceiling: 50 } },
          { centerU: 0.5, widthM: 16, heightM: 8, hang: { offset: 36, y: 38, ceiling: 50 } },
        ],
      },
      site: { key: 'metropolitano', horizon: 'city', ground: 0xb7a07c, forecourt: 0xc2bdb2, style: 'es' },
    },
    meta: { name: 'Riyadh Air Metropolitano (Madrid)', source: 'builtin', country: 'Europe', capacity: 70813, type: 'Bowl', inspiredBy: 'Estadio Metropolitano, San Blas-Canillejas, Madrid - home of Atlético de Madrid', tags: ['atletico', 'atletico-madrid', 'atleti', 'madrid', 'metropolitano', 'wanda', 'peineta', 'spain', LL] },
  },
  {
    // Spotify Camp Nou, Barcelona, as it stands in 2026-27. The Tribuna (main)
    // is the west side (-z here); the Lateral opposite, Gol Nord north (+x
    // here) and Gol Sud south (-x). Pitch 105 x 68 (OSM). The first and second
    // tiers are open, their new seats a scatter from garnet low down to blue
    // higher up; the third tier is built round the whole bowl but closed and
    // unseated, with the steel pillars and compression ring of the future roof
    // standing on top of it and cranes round the rim. No roof this season.
    id: 'camp-nou-63k',
    template: {
      id: 'camp-nou-63k',
      name: 'Spotify Camp Nou (Barcelona)',
      version: 1,
      levels: 3,
      plan: { a: 63, b: 46, exponent: 4 },
      evenRows: true,
      tiers: [
        { rows: 25, rowDepth: 0.8, rakeDeg: 25, baseElevation: 0.8, baseOffset: 0, seatPitch: 0.46 },
        { rows: 35, rowDepth: 0.82, rakeDeg: 31, baseElevation: 14.5, baseOffset: 26.5, seatPitch: 0.46 },
        // The third tier: concrete, closed, no seats yet.
        { rows: 28, rowDepth: 0.85, rakeDeg: 36, baseElevation: 37.5, baseOffset: 60, seatPitch: 0.46, building: true },
      ],
      aisles: { count: 72, widthMeters: 1.1 },
      sectionsPerTier: 56,
      roof: { coverage: 'none' },
      lighting: { style: 'roof-rim', kelvin: 5700, mount: { offset: 85, y: 61 } },
      finish: { concrete: 0x9b9a96, walls: 0xa6a49f },
      facade: { style: 'concrete', color: 0xb7b4ad, accent: 0x8f8c86 },
      runoff: { color: 0x2f7a3a, a: 63, b: 46, exponent: 4 },
      seatLook: {
        colors: ['#a50044'],
        grain: { along: 1.5, rows: 2 },
        regions: [
          { tiers: [0], colors: [{ c: '#a50044', w: 8 }, { c: '#004d98', w: 2 }] },
          { tiers: [1], colors: [{ c: '#a50044', w: 5 }, { c: '#004d98', w: 5 }] },
        ],
      },
      details: {
        // The 360-degree LED ribbon between the first and second tiers.
        ribbons: { color: 0xa50044, tiers: [1] },
        boxes: [{ centerU: 0.75, halfU: 0.14, underTier: 2, count: 40 }, { centerU: 0.25, halfU: 0.14, underTier: 2, count: 40 }],
        // The roof's compression ring on its crown of pillars, waiting for the cable net.
        girders: RING(148, 131, 3.4, 56, 4.5, 40, 0x8d8f93),
        cranes: [CRANE(-118, -112, 72, 55, 45), CRANE(128, 96, 68, 50, 225), CRANE(-150, 40, 64, 48, 0)],
      },
      site: { key: 'camp-nou', horizon: 'city-towers', ground: 0xa99a80, forecourt: 0xbfb9ad, style: 'es', palms: 0.1 },
    },
    meta: { name: 'Spotify Camp Nou (Barcelona)', source: 'builtin', country: 'Europe', capacity: 62652, type: 'Bowl', inspiredBy: 'Spotify Camp Nou, Les Corts, Barcelona - home of FC Barcelona, mid-rebuild in 2026-27', tags: ['barcelona', 'fc-barcelona', 'barca', 'camp-nou', 'spotify', 'catalonia', 'spain', LL] },
  },
  {
    // ABANCA Balaídos, Vigo, as it stands in 2026-27. The Tribuna (main) is on
    // the north side (-z here), old and single-tier under its concrete
    // cantilever; Río opposite, the tallest; Marcador the east end (+x here),
    // rebuilt in 2023; and the new Gol end west (-x), its concrete frame topped
    // out but only its first five rows seated. Pitch 105 x 68 (OSM).
    id: 'balaidos-24k',
    template: {
      id: 'balaidos-24k',
      name: 'ABANCA Balaídos (Vigo)',
      version: 1,
      levels: 2,
      plan: { a: 58.5, b: 39.5, exponent: 12 },
      evenRows: true,
      tiers: [
        {
          rows: 30, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'south', halfLength: 56, rows: 30, offset: 1 },
            { side: 'north', halfLength: 58, rows: 22 },
            { side: 'east', halfLength: 44, rows: 23 },
            { side: 'west', halfLength: 36, rows: 5, offset: 1 },
          ],
        },
        {
          rows: 24, rowDepth: 0.82, rakeDeg: 32, baseElevation: 12, baseOffset: 21.5, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'north', halfLength: 62, rows: 24 },
            { side: 'east', halfLength: 46, rows: 17 },
          ],
        },
        // The Gol: the rest of its lower tier and its upper tier, built, unseated.
        { rows: 17, rowDepth: 0.8, rakeDeg: 26, baseElevation: 4.8, baseOffset: 4.8, seatPitch: 0.47, straight: true, building: true, stands: [{ side: 'west', halfLength: 40, offset: 1 }] },
        { rows: 16, rowDepth: 0.82, rakeDeg: 32, baseElevation: 12, baseOffset: 21.5, seatPitch: 0.47, straight: true, building: true, stands: [{ side: 'west', halfLength: 44 }] },
      ],
      aisles: { count: 40, widthMeters: 1.0 },
      sectionsPerTier: 32,
      roof: { coverage: 'none' },
      roofs: [
        // The Tribuna's 1928 concrete cantilever.
        { style: 'slab', side: 'south', straight: true, from: -58, to: 58, back: 26, front: 6, backY: 15.5, frontY: 14.5, depth: 1.6, bay: 6, color: 0x9da2a7, underColor: 0x6a6f75 },
        { style: 'sheet', side: 'north', straight: true, from: -64, to: 64, back: 42, front: 3, backY: 27, frontY: 23.5, depth: 1.8, bay: 8, color: 0x5d8fc6, underColor: 0x2c3138, lights: { every: 6, y: 24 } },
        { style: 'sheet', side: 'east', straight: true, from: -48, to: 48, back: 38, front: 3, backY: 25, frontY: 21.5, depth: 1.8, bay: 8, color: 0x5d8fc6, underColor: 0x2c3138, lights: { every: 6, y: 22 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8f9296, walls: 0x6d93c2 },
      runoff: { color: 0x2f7a3a, a: 58.5, b: 39.5, exponent: 12 },
      seatLook: { colors: [{ c: '#7fc3ea', w: 9 }, { c: '#9aa6b0', w: 1 }], grain: { along: 2, rows: 2 } },
      details: {
        ribbons: { color: 0x7fc3ea, tiers: [1] },
        skins: [
          // The blue wave of aluminium round Río and Marcador.
          { side: 'north', straight: true, from: -64, to: 64, offset: 40, y0: 0, y1: 27, color: 0x6d9bd0, pattern: 'panels', tile: [7, 27] },
          { side: 'east', straight: true, from: -48, to: 48, offset: 36, y0: 0, y1: 25, color: 0x6d9bd0, pattern: 'panels', tile: [7, 25] },
        ],
        // The temporary screen in the Tribuna-Gol corner.
        screens: [{ centerU: 0.62, widthM: 8, heightM: 4.5, post: { offset: 8, y: 6 } }],
        cranes: [CRANE(-92, 30, 52, 45, 0), CRANE(-90, -36, 46, 38, 20)],
      },
      site: { key: 'balaidos', horizon: 'hills', ground: 0x77805e, forecourt: 0xa9a69e, style: 'es' },
    },
    meta: { name: 'ABANCA Balaídos (Vigo)', source: 'builtin', country: 'Europe', capacity: 23700, type: 'Two-tier', inspiredBy: 'Estadio Abanca Balaídos, Vigo - home of RC Celta, its Gol end being rebuilt in 2026-27', tags: ['celta', 'celta-vigo', 'vigo', 'balaidos', 'abanca', 'galicia', 'spain', LL] },
  },
  {
    // ABANCA-Riazor, A Coruña. The Tribuna (main) is the north side (-z
    // here); Preferencia opposite, the Marathón end west (-x here) under its
    // 45 m tower, and the Pabellón end east (+x). Pitch 105 x 68 (OSM). Two
    // tiers all round, the corners filled, under roofs hung from concrete
    // posts behind the stands.
    id: 'riazor-33k',
    template: {
      id: 'riazor-33k',
      name: 'ABANCA-Riazor (A Coruña)',
      version: 1,
      levels: 2,
      plan: { a: 59, b: 41, exponent: 8 },
      evenRows: true,
      tiers: [
        { rows: 21, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 15, rowDepth: 0.82, rakeDeg: 32, baseElevation: 11.5, baseOffset: 21, seatPitch: 0.47 },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 40, front: 5, backY: 27, frontY: 23, depth: 2.4, bay: 7, color: 0x3c6fb4, underColor: 0x2f5f9e, glazing: 0.3, columns: { every: 14, shape: 'raking', color: 0xb9bcbf }, lights: { every: 6, y: 23.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0x8f9296, walls: 0x8a9ba9 },
      facade: { style: 'cladding', color: 0x3f7cc6, accent: 0xe9edf0 },
      runoff: { color: 0x2f7a3a, a: 59, b: 41, exponent: 8 },
      seatLook: {
        colors: ['#1b55b0'],
        text: [
          { text: 'DÉPOR', color: '#f4f6f8', tier: 1, centerU: 0.25, halfU: 0.06, rows: [3, 15] },
          { text: '1906', color: '#f4f6f8', tier: 0, centerU: 0.25, halfU: 0.035, rows: [8, 19] },
        ],
      },
      details: {
        ribbons: { color: 0x1b55b0, tiers: [1] },
        // The Torre de Marathón behind the west end.
        buildings: [{ side: 'west', straight: true, center: 0, halfLength: 3, front: 42, depth: 6, y0: 0, y1: 45, color: 0xd8dcdf }],
        screens: [{ centerU: 0.5, widthM: 10, heightM: 5.5, hang: { offset: 26, y: 20, ceiling: 26 } }, { centerU: 0, widthM: 10, heightM: 5.5, hang: { offset: 26, y: 20, ceiling: 26 } }],
      },
      site: { key: 'riazor', horizon: 'city', ground: 0x8f8b7a, forecourt: 0xaaa79f, style: 'es' },
    },
    meta: { name: 'ABANCA-Riazor (A Coruña)', source: 'builtin', country: 'Europe', capacity: 32660, type: 'Two-tier', inspiredBy: 'Estadio ABANCA-Riazor, A Coruña - home of RC Deportivo', tags: ['deportivo', 'depor', 'deportivo-la-coruna', 'coruna', 'riazor', 'abanca', 'galicia', 'spain', LL] },
  },
  {
    // Martínez Valero, Elche. The Tribuna (main) is the west side (-z here);
    // Preferencia opposite, Fondo Norte north (+x here, away fans up top) and
    // Fondo Sur south (-x). Pitch 105 x 68 (OSM). A ring of two tiers, the
    // upper overhanging the lower, with no roof; lamps on racks along the rim.
    id: 'martinez-valero-31k',
    template: {
      id: 'martinez-valero-31k',
      name: 'Martínez Valero (Elche)',
      version: 1,
      levels: 2,
      plan: { a: 60, b: 43, exponent: 6 },
      evenRows: true,
      tiers: [
        { rows: 18, rowDepth: 0.8, rakeDeg: 22, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 18, rowDepth: 0.85, rakeDeg: 30, baseElevation: 8.5, baseOffset: 12, seatPitch: 0.47 },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      lighting: { style: 'roof-rim', kelvin: 5200, mount: { offset: 32, y: 24 } },
      finish: { concrete: 0x9c9a92, walls: 0x3d7a52 },
      facade: { style: 'concrete', color: 0x3d7a52, accent: 0xe9e9e4 },
      runoff: { color: 0x2f7a3a, a: 60, b: 43, exponent: 6 },
      seatLook: { colors: [{ c: '#0b7a3c', w: 4 }, { c: '#178a4a', w: 1 }], grain: { along: 2, rows: 1 } },
      details: {
        screens: [
          { centerU: 0, widthM: 10, heightM: 5, post: { offset: 32, y: 22 } },
          { centerU: 0.5, widthM: 10, heightM: 5, post: { offset: 32, y: 22 } },
        ],
      },
      site: { key: 'martinez-valero', horizon: 'city', ground: 0xb9a582, forecourt: 0xc4bcae, style: 'es', palms: 0.5 },
    },
    meta: { name: 'Martínez Valero (Elche)', source: 'builtin', country: 'Europe', capacity: 31388, type: 'Two-tier', inspiredBy: 'Estadio Manuel Martínez Valero, Elche - home of Elche CF', tags: ['elche', 'elche-cf', 'martinez-valero', 'valencian-community', 'spain', LL] },
  },
  {
    // RCDE Stadium, Cornellà de Llobregat. The Tribuna (main) is the west side
    // (-z here); the Lateral opposite, and the two ends. Pitch 105 x 68 (OSM).
    // Two tiers all round with a band of boxes between them, under one roof
    // hung from four great lattice girders; a skin of translucent panels lit
    // blue outside.
    id: 'cornella-38k',
    template: {
      id: 'cornella-38k',
      name: 'RCDE Stadium (Cornellà)',
      version: 1,
      levels: 2,
      plan: { a: 58, b: 40, exponent: 9 },
      evenRows: true,
      tiers: [
        { rows: 23, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 18, rowDepth: 0.85, rakeDeg: 33, baseElevation: 14.5, baseOffset: 24, seatPitch: 0.47 },
      ],
      aisles: { count: 56, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 50, front: 6, backY: 34, frontY: 31, depth: 2.6, bay: 7, color: 0xd9dcdf, underColor: 0xe6e8e9, glazing: 0.55, lights: { every: 5, y: 31.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9a9da1, walls: 0x9fa3a8 },
      facade: { style: 'membrane', color: 0x3b72d6, accent: 0xc9d6ea },
      runoff: { color: 0x2f7a3a, a: 58, b: 40, exponent: 9 },
      seatLook: {
        colors: ['#0a54b5'],
        text: [{ text: 'RCD ESPANYOL', color: '#f4f6f9', tier: 0, centerU: 0.25, halfU: 0.1, rows: [7, 20] }],
      },
      details: {
        ribbons: { color: 0x0a54b5, tiers: [1] },
        boxes: [{ centerU: 0.75, halfU: 0.13, underTier: 1, count: 30 }, { centerU: 0.25, halfU: 0.13, underTier: 1, count: 22 }],
        girders: [
          { from: [-96, -74], to: [96, -74], y: 33, height: 9, bay: 6, color: 0xe1e3e5 },
          { from: [-96, 74], to: [96, 74], y: 33, height: 9, bay: 6, color: 0xe1e3e5 },
          { from: [-86, -84], to: [-86, 84], y: 33, height: 9, bay: 6, color: 0xe1e3e5 },
          { from: [86, -84], to: [86, 84], y: 33, height: 9, bay: 6, color: 0xe1e3e5 },
        ],
        screens: [
          { centerU: 0, widthM: 12, heightM: 6, hang: { offset: 30, y: 26, ceiling: 34 } },
          { centerU: 0.5, widthM: 12, heightM: 6, hang: { offset: 30, y: 26, ceiling: 34 } },
        ],
      },
      site: { key: 'cornella', horizon: 'city', ground: 0xa49a80, forecourt: 0xbcb6aa, style: 'es', palms: 0.15 },
    },
    meta: { name: 'RCDE Stadium (Cornellà)', source: 'builtin', country: 'Europe', capacity: 37776, type: 'Two-tier', inspiredBy: 'RCDE Stadium (Estadi Cornellà-El Prat), Cornellà de Llobregat - home of RCD Espanyol', tags: ['espanyol', 'rcd-espanyol', 'cornella', 'el-prat', 'rcde', 'barcelona', 'catalonia', 'spain', LL] },
  },
  {
    // Coliseum, Getafe, as it stands in 2026-27. The main stand is the west
    // side (-z here), its old upper tier and curved roof being demolished; the
    // east side and both ends have their new upper tiers, and the new roof is
    // going up over the south end first (-x here). Pitch 105 x 68 (OSM).
    id: 'coliseum-11k',
    template: {
      id: 'coliseum-11k',
      name: 'Coliseum (Getafe)',
      version: 1,
      levels: 2,
      plan: { a: 59, b: 41, exponent: 8 },
      evenRows: true,
      tiers: [
        { rows: 10, rowDepth: 0.8, rakeDeg: 22, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 5, rowDepth: 0.85, rakeDeg: 32, baseElevation: 6.5, baseOffset: 11.5, seatPitch: 0.47, omit: [{ side: 'south', from: -200, to: 200 }] },
        // The main stand's upper tier: its frame, no seats.
        {
          rows: 10, rowDepth: 0.85, rakeDeg: 32, baseElevation: 6.5, baseOffset: 11.5, seatPitch: 0.47, building: true,
          omit: [{ side: 'north', from: -200, to: 200 }, { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 }],
        },
      ],
      aisles: { count: 40, widthMeters: 1.0 },
      sectionsPerTier: 32,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'west', from: -60, to: 60, back: 32, front: 3, backY: 22, frontY: 19, depth: 1.6, bay: 7, color: 0xd8dadc, underColor: 0x6f757c },
      ],
      lighting: { style: 'corner-masts', kelvin: 5000, masts: { at: [[78, 62]], height: 40, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x8f9296, walls: 0x9ea3a8 },
      runoff: { color: 0x2f7a3a, a: 59, b: 41, exponent: 8 },
      seatLook: { colors: ['#1f4fa8'] },
      details: {
        cranes: [CRANE(-10, -82, 50, 42, 90), CRANE(-70, -60, 46, 38, 45), CRANE(-88, 20, 44, 36, 0)],
      },
      site: { key: 'coliseum', horizon: 'city', ground: 0xb5a17e, forecourt: 0xc1bbae, style: 'es' },
    },
    meta: { name: 'Coliseum (Getafe)', source: 'builtin', country: 'Europe', capacity: 11000, type: 'Two-tier', inspiredBy: 'Coliseum, Getafe - home of Getafe CF, mid-rebuild in 2026-27', tags: ['getafe', 'getafe-cf', 'coliseum', 'alfonso-perez', 'madrid', 'spain', LL] },
  },
  {
    // Ciutat de València, Valencia. The Tribuna (main) is the west side (-z
    // here); the Grada Central opposite, Gol Alboraya north (+x here) and Gol
    // Orriols south (-x). Pitch 105 x 68 (OSM). One closed single tier under a
    // white membrane roof of puffed bays that covers every seat.
    id: 'ciutat-de-valencia-26k',
    template: {
      id: 'ciutat-de-valencia-26k',
      name: 'Ciutat de València (Valencia)',
      version: 1,
      levels: 1,
      plan: { a: 58, b: 40, exponent: 10 },
      evenRows: true,
      tiers: [{ rows: 31, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.47 }],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'membrane', back: 34, front: 2, backY: 25, frontY: 20.5, depth: 1.8, bay: 6, color: 0xf6f6f3, underColor: 0xe7e5df, lights: { every: 5, y: 21 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8f9296, walls: 0x2a3a72 },
      facade: { style: 'cladding', color: 0x283a78, accent: 0x7a2034 },
      runoff: { color: 0x2f7a3a, a: 58, b: 40, exponent: 10 },
      seatLook: {
        colors: [{ c: '#1d3c8f', w: 6 }, { c: '#8a1538', w: 4 }],
        grain: { along: 1.5, rows: 2 },
        text: [
          { text: 'LEVANTE UD', color: '#c9cdd3', ground: '#1d3c8f', tier: 0, centerU: 0.25, halfU: 0.1, rows: [16, 28] },
          { text: '1909', color: '#c9cdd3', ground: '#1d3c8f', tier: 0, centerU: 0.25, halfU: 0.04, rows: [5, 13] },
        ],
      },
      details: {
        screens: [
          { centerU: 0, widthM: 11, heightM: 6, hang: { offset: 18, y: 20, ceiling: 25 } },
          { centerU: 0.5, widthM: 11, heightM: 6, hang: { offset: 18, y: 20, ceiling: 25 } },
        ],
      },
      site: { key: 'ciutat-de-valencia', horizon: 'city-towers', ground: 0xb3a27e, forecourt: 0xc0baad, style: 'es', palms: 0.35 },
    },
    meta: { name: 'Ciutat de València (Valencia)', source: 'builtin', country: 'Europe', capacity: 26354, type: 'Single-tier', inspiredBy: 'Estadi Ciutat de València, Valencia - home of Levante UD', tags: ['levante', 'levante-ud', 'valencia', 'ciutat-de-valencia', 'orriols', 'spain', LL] },
  },
  {
    // La Rosaleda, Málaga. The Tribuna (main) is the west side by the
    // Guadalmedina (-z here); Preferencia opposite, and the two open ends,
    // taller, their tops sweeping down into the corners. Pitch 105 x 68 (OSM).
    // Two tiers all round; only the sides are roofed.
    id: 'la-rosaleda-30k',
    template: {
      id: 'la-rosaleda-30k',
      name: 'La Rosaleda (Málaga)',
      version: 1,
      levels: 2,
      plan: { a: 60, b: 41, exponent: 7 },
      evenRows: true,
      tiers: [
        { rows: 15, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        {
          rows: 23, rowDepth: 0.82, rakeDeg: 32, baseElevation: 10, baseOffset: 17, seatPitch: 0.47,
          omit: [
            { side: 'north', from: -200, to: 200, fromRow: 17 }, { side: 'south', from: -200, to: 200, fromRow: 17 },
            { side: 'east', from: -200, to: -26, fromRow: 18 }, { side: 'east', from: 26, to: 200, fromRow: 18 },
            { side: 'west', from: -200, to: -26, fromRow: 18 }, { side: 'west', from: 26, to: 200, fromRow: 18 },
          ],
        },
      ],
      aisles: { count: 48, widthMeters: 1.0 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', from: -52, to: 52, back: 33, front: 6, backY: 25, frontY: 22, depth: 1.6, bay: 7, color: 0xe6e8ea, underColor: 0x6d737a },
        { style: 'sheet', side: 'north', from: -52, to: 52, back: 33, front: 6, backY: 25, frontY: 22, depth: 1.6, bay: 7, color: 0xe6e8ea, underColor: 0x6d737a },
      ],
      lighting: { style: 'side-banks', kelvin: 5600 },
      finish: { concrete: 0xa3a19b, walls: 0xe4e2dc },
      facade: { style: 'concrete', color: 0xe9e7e1, accent: 0xd2d0ca },
      runoff: { color: 0x2f7a3a, a: 60, b: 41, exponent: 7 },
      seatLook: {
        colors: [{ c: '#5fb0e5', w: 6 }, { c: '#f2f4f6', w: 4 }],
        grain: { along: 1.5, rows: 2 },
        text: [
          { text: 'MÁLAGA CF', color: '#f4f6f8', ground: '#2f86c8', tier: 1, centerU: 0.2, halfU: 0.045, rows: [3, 14] },
          { text: '1904', color: '#f4f6f8', ground: '#2f86c8', tier: 1, centerU: 0.3, halfU: 0.03, rows: [3, 14] },
        ],
      },
      details: {
        ribbons: { color: 0x2f86c8, tiers: [1] },
        screens: [{ centerU: 0, widthM: 10, heightM: 5, post: { offset: 40, y: 26 } }, { centerU: 0.5, widthM: 10, heightM: 5, post: { offset: 40, y: 26 } }],
        // White concrete fins round the outside.
        skins: [{ offset: 39, y0: 0, y1: 26, color: 0xe9e7e1, pattern: 'slats', tile: [4.5, 26] }],
      },
      site: { key: 'la-rosaleda', horizon: 'mountains', ground: 0xb8a37e, forecourt: 0xc6c0b2, style: 'es', palms: 0.45 },
    },
    meta: { name: 'La Rosaleda (Málaga)', source: 'builtin', country: 'Europe', capacity: 30044, type: 'Two-tier', inspiredBy: 'Estadio La Rosaleda, Málaga - home of Málaga CF', tags: ['malaga', 'malaga-cf', 'rosaleda', 'andalusia', 'spain', LL] },
  },
  {
    // El Sadar, Pamplona. The main stand is the south-west side (-z here),
    // its two tiers kept in the 2019-21 rebuild; the Lateral opposite and
    // both ends got a steep new upper tier to match, and one red roof was put
    // over all four sides. Pitch 105 x 68 (OSM). A tight box, square-cornered.
    id: 'el-sadar-24k',
    template: {
      id: 'el-sadar-24k',
      name: 'El Sadar (Pamplona)',
      version: 1,
      levels: 2,
      plan: { a: 58, b: 39.5, exponent: 12 },
      evenRows: true,
      tiers: [
        { rows: 13, rowDepth: 0.78, rakeDeg: 33, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46 },
        { rows: 14, rowDepth: 0.8, rakeDeg: 39, baseElevation: 9, baseOffset: 12.5, seatPitch: 0.46 },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 27, front: 1, backY: 22, frontY: 20.5, depth: 2.6, bay: 6, color: 0xd11a2a, underColor: 0x9fa4a9, glazing: 0.35, lights: { every: 5, y: 27 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8a8d91, walls: 0x9aa0a6 },
      facade: { style: 'cladding', color: 0xa9adb2, accent: 0xd11a2a },
      runoff: { color: 0x2f7a3a, a: 58, b: 39.5, exponent: 12 },
      seatLook: {
        colors: ['#d11a2a'],
        text: [{ text: 'OSASUNA', color: '#14336e', tier: 0, centerU: 0.25, halfU: 0.09, rows: [2, 11] }],
      },
      details: {
        ribbons: { color: 0xd11a2a, tiers: [1] },
        screens: [
          { centerU: 0, widthM: 14.4, heightM: 6, hang: { offset: 16, y: 16, ceiling: 21 } },
          { centerU: 0.5, widthM: 14.4, heightM: 6, hang: { offset: 16, y: 16, ceiling: 21 } },
        ],
      },
      site: { key: 'el-sadar', horizon: 'hills', ground: 0x8e8a6a, forecourt: 0xaaa69c, style: 'es' },
    },
    meta: { name: 'El Sadar (Pamplona)', source: 'builtin', country: 'Europe', capacity: 23576, type: 'Two-tier', inspiredBy: 'Estadio El Sadar, Pamplona - home of CA Osasuna', tags: ['osasuna', 'ca-osasuna', 'pamplona', 'iruna', 'el-sadar', 'navarre', 'spain', LL] },
  },
  {
    // Campos de Sport de El Sardinero, Santander. The main stand is the west
    // side (-z here), a little taller with boxes between its tiers; the east
    // side opposite, and the two ends, La Gradona the north (+x here). Pitch
    // 105 x 68 (OSM). Two tiers all round, the corners filled, the upper tiers
    // under roofs on concrete ribs; four corner masts.
    id: 'el-sardinero-22k',
    template: {
      id: 'el-sardinero-22k',
      name: 'El Sardinero (Santander)',
      version: 1,
      levels: 2,
      plan: { a: 58, b: 40, exponent: 10 },
      evenRows: true,
      tiers: [
        { rows: 11, rowDepth: 0.8, rakeDeg: 22, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 15, rowDepth: 0.82, rakeDeg: 30, baseElevation: 6.8, baseOffset: 11.5, seatPitch: 0.47 },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'slab', back: 27, front: 10, backY: 17.5, frontY: 16, depth: 1.4, bay: 6, color: 0xb9bcbe, underColor: 0x55595e },
      ],
      lighting: { style: 'corner-masts', kelvin: 4800, masts: { at: [[76, 62]], height: 44, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x8f9296, walls: 0xcfd0cc },
      facade: { style: 'concrete', color: 0xd9d8d2, accent: 0xb8b7b1 },
      runoff: { color: 0x2f7a3a, a: 58, b: 40, exponent: 10 },
      seatLook: {
        colors: ['#0f7b3e'],
        text: [{ text: 'RACING', color: '#f4f6f2', tier: 1, centerU: 0.25, halfU: 0.07, rows: [2, 11] }],
      },
      details: {
        screens: [
          { centerU: 0, widthM: 9, heightM: 5, post: { offset: 25, y: 18 } },
          { centerU: 0.5, widthM: 9, heightM: 5, post: { offset: 25, y: 18 } },
        ],
      },
      site: { key: 'el-sardinero', horizon: 'hills', ground: 0x7c875f, forecourt: 0xa9a69c, style: 'es' },
    },
    meta: { name: 'El Sardinero (Santander)', source: 'builtin', country: 'Europe', capacity: 22308, type: 'Two-tier', inspiredBy: 'Campos de Sport de El Sardinero, Santander - home of Real Racing Club', tags: ['racing', 'racing-santander', 'santander', 'sardinero', 'cantabria', 'spain', LL] },
  },
  {
    // Estadio de Vallecas, Madrid. The main stand is the south side (Arroyo
    // del Olivar, -z here); the north stand opposite is its twin, the
    // Bukaneros' end is the west (+x here), and the east end (-x) has no stand
    // at all, just a wall and the flats behind it. Pitch 100 x 64 (OSM). The
    // sides in three tiers, a red band through the middle one, part-roofed.
    id: 'vallecas-15k',
    template: {
      id: 'vallecas-15k',
      name: 'Estadio de Vallecas (Madrid)',
      version: 1,
      levels: 3,
      plan: { a: 54.5, b: 37, exponent: 12 },
      evenRows: true,
      tiers: [
        {
          rows: 19, rowDepth: 0.76, rakeDeg: 30, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46, straight: true,
          stands: [
            { side: 'south', halfLength: 50, rows: 16, offset: 1 },
            { side: 'north', halfLength: 50, rows: 16, offset: 1 },
            { side: 'east', halfLength: 32, rows: 19, offset: 1 },
          ],
        },
        {
          rows: 7, rowDepth: 0.8, rakeDeg: 33, baseElevation: 9, baseOffset: 15, seatPitch: 0.46, straight: true,
          stands: [{ side: 'south', halfLength: 50 }, { side: 'north', halfLength: 50 }],
        },
        {
          rows: 9, rowDepth: 0.8, rakeDeg: 36, baseElevation: 14, baseOffset: 21.5, seatPitch: 0.46, straight: true,
          stands: [{ side: 'south', halfLength: 50 }, { side: 'north', halfLength: 50 }],
        },
      ],
      aisles: { count: 32, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -50, to: 50, back: 31, front: 19, backY: 21.5, frontY: 20.5, depth: 1, bay: 6, color: 0xd5d7d9, underColor: 0x6a7076 },
        { style: 'sheet', side: 'north', straight: true, from: -50, to: 50, back: 31, front: 19, backY: 21.5, frontY: 20.5, depth: 1, bay: 6, color: 0xd5d7d9, underColor: 0x6a7076 },
      ],
      lighting: { style: 'side-banks', kelvin: 5000 },
      finish: { concrete: 0x8f9296, walls: 0xc7c5c0 },
      runoff: { color: 0x2f7a3a, a: 54.5, b: 37, exponent: 12 },
      seatLook: {
        colors: ['#f1f1ee'],
        regions: [{ tiers: [1], colors: ['#d01d1d'] }],
      },
      details: {
        skins: [
          // The wall across the open east end.
          { side: 'west', straight: true, from: -36, to: 36, offset: 6, y0: 0, y1: 5, color: 0xd9d6cf, pattern: 'panels', tile: [5, 5] },
        ],
      },
      site: { key: 'vallecas', horizon: 'city', ground: 0xa99a7c, forecourt: 0xb9b4a8, style: 'es' },
    },
    meta: { name: 'Estadio de Vallecas (Madrid)', source: 'builtin', country: 'Europe', capacity: 14708, type: 'Two-tier', inspiredBy: 'Estadio de Vallecas, Puente de Vallecas, Madrid - home of Rayo Vallecano', tags: ['rayo', 'rayo-vallecano', 'vallecas', 'madrid', 'bukaneros', 'spain', LL] },
  },
  {
    // Estadio La Cartuja, Seville: Real Betis' home for 2026-27 while the
    // Villamarín is rebuilt. The main stand is the west side (-z here). Pitch
    // 105 x 68 (OSM). The athletics track is gone: a new open lower tier has
    // been built where it was, close to the pitch, and above it the old oval's
    // two upper tiers under the ring roof.
    id: 'la-cartuja-69k',
    template: {
      id: 'la-cartuja-69k',
      name: 'La Cartuja (Seville)',
      version: 1,
      levels: 3,
      plan: { a: 63, b: 42, exponent: 6 },
      evenRows: true,
      tiers: [
        { rows: 21, rowDepth: 0.8, rakeDeg: 22, baseElevation: 0.8, baseOffset: 0, seatPitch: 0.5 },
        { rows: 26, rowDepth: 0.85, rakeDeg: 28, baseElevation: 9.5, baseOffset: 24, seatPitch: 0.5 },
        { rows: 20, rowDepth: 0.85, rakeDeg: 33, baseElevation: 23.5, baseOffset: 49.5, seatPitch: 0.5 },
      ],
      aisles: { count: 72, widthMeters: 1.1 },
      sectionsPerTier: 56,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'membrane', back: 76, front: 36, backY: 41, frontY: 37, depth: 2.4, bay: 8, color: 0xf2f2ef, underColor: 0xe4e2dc, lights: { every: 5, y: 37.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0xa09d95, walls: 0xd8d2c4 },
      facade: { style: 'concrete', color: 0xddd6c6, accent: 0xbfb8a8 },
      runoff: { color: 0x2f7a3a, a: 63, b: 42, exponent: 6 },
      seatLook: { colors: ['#ef7f22'] },
      details: { ribbons: { color: 0x0ba14b, tiers: [1, 2] } },
      site: { key: 'la-cartuja', horizon: 'city', ground: 0xb8a57f, forecourt: 0xc6c0b2, style: 'es', palms: 0.35 },
    },
    meta: { name: 'La Cartuja (Seville)', source: 'builtin', country: 'Europe', capacity: 68887, type: 'Bowl', inspiredBy: 'Estadio La Cartuja de Sevilla - home of Real Betis in 2026-27 while the Benito Villamarín is rebuilt', tags: ['betis', 'real-betis', 'seville', 'sevilla', 'cartuja', 'olimpico', 'andalusia', 'spain', LL] },
  },
  {
    // Bernabéu, Madrid. The Lateral Oeste on the Castellana (main: palco,
    // dugouts, tunnel) is the west side (-z here); the Lateral Este opposite,
    // the Fondo Norte north (+x here) and the Fondo Sur south (-x). Pitch
    // 105 x 68 (OSM). A steep closed bowl of four stacked tiers, every seat
    // navy, under a fixed roof whose retractable middle is open here, with
    // the 360-degree screen round its inner edge; outside, the steel ribbons.
    id: 'bernabeu-83k',
    template: {
      id: 'bernabeu-83k',
      name: 'Bernabéu (Madrid)',
      version: 1,
      levels: 4,
      plan: { a: 58, b: 40.5, exponent: 10 },
      evenRows: true,
      tiers: [
        { rows: 23, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.47 },
        { rows: 15, rowDepth: 0.82, rakeDeg: 30, baseElevation: 14.5, baseOffset: 23, seatPitch: 0.47 },
        { rows: 19, rowDepth: 0.82, rakeDeg: 34, baseElevation: 24, baseOffset: 38, seatPitch: 0.47 },
        { rows: 18, rowDepth: 0.8, rakeDeg: 38, baseElevation: 36.5, baseOffset: 56, seatPitch: 0.47 },
      ],
      aisles: { count: 72, widthMeters: 1.0 },
      sectionsPerTier: 56,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 74, front: 2, backY: 54, frontY: 49, depth: 4, bay: 8, color: 0xc9ccd1, underColor: 0x6b7077, glazing: 0.25, lights: { every: 5, y: 49.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x76797e, walls: 0x8b8f95 },
      runoff: { color: 0x2f7a3a, a: 58, b: 40.5, exponent: 10 },
      seatLook: {
        colors: ['#1f2b4d'],
        text: [{ text: 'REAL MADRID', color: '#f2f3f5', tier: 2, centerU: 0.75, halfU: 0.1, rows: [3, 14] }],
      },
      details: {
        ribbons: { color: 0xf2f3f5, tiers: [1, 2, 3] },
        boxes: [{ centerU: 0.75, halfU: 0.16, underTier: 1, count: 60 }, { centerU: 0.25, halfU: 0.16, underTier: 1, count: 60 }],
        // The 360-degree screen under the roof's inner edge: taller at the ends.
        screens: [
          { centerU: 0.25, widthM: 70, heightM: 6.5, hang: { offset: 6, y: 45, ceiling: 49 } },
          { centerU: 0.75, widthM: 70, heightM: 6.5, hang: { offset: 6, y: 45, ceiling: 49 } },
          { centerU: 0, widthM: 44, heightM: 11, hang: { offset: 6, y: 43, ceiling: 49 } },
          { centerU: 0.5, widthM: 44, heightM: 11, hang: { offset: 6, y: 43, ceiling: 49 } },
        ],
        skins: [{ offset: 76, y0: 0, y1: 54, color: 0xc4c8cd, pattern: 'slats', tile: [4, 1.6] }],
      },
      site: { key: 'bernabeu', horizon: 'city-towers', ground: 0xa99a7c, forecourt: 0xc3bfb6, style: 'es' },
    },
    meta: { name: 'Bernabéu (Madrid)', source: 'builtin', country: 'Europe', capacity: 83186, type: 'Bowl', inspiredBy: 'Bernabéu (Estadio Santiago Bernabéu), Chamartín, Madrid - home of Real Madrid', tags: ['real-madrid', 'madrid', 'bernabeu', 'santiago-bernabeu', 'chamartin', 'castellana', 'spain', LL] },
  },
  {
    // Anoeta, San Sebastián. The Tribuna Principal is the south-west side (-z
    // here); the Tribuna Este opposite, the Aitor Zabaleta end north-west (+x
    // here). Pitch 105 x 68 (OSM). New rectangular lower tiers and ends built
    // in to the pitch in 2017-19, under the 1993 oval upper tiers of the sides,
    // and in 2026 new top sections on both sides and seats in every corner; a
    // translucent roof on four great trusses, the whole wrapped in sky-blue ETFE.
    id: 'anoeta-42k',
    template: {
      id: 'anoeta-42k',
      name: 'Anoeta (San Sebastián)',
      version: 1,
      levels: 3,
      plan: { a: 59, b: 41.5, exponent: 8 },
      evenRows: true,
      tiers: [
        { rows: 24, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 20, rowDepth: 0.85, rakeDeg: 32, baseElevation: 11.5, baseOffset: 23, seatPitch: 0.47 },
        {
          // The new top sections of 2026 over the middle of each side.
          rows: 6, rowDepth: 0.85, rakeDeg: 34, baseElevation: 23.5, baseOffset: 41.5, seatPitch: 0.47,
          omit: [
            { side: 'east', from: -200, to: 200 }, { side: 'west', from: -200, to: 200 },
            { side: 'north', from: -200, to: -34 }, { side: 'north', from: 34, to: 200 },
            { side: 'south', from: -200, to: -40 }, { side: 'south', from: 40, to: 200 },
          ],
        },
      ],
      aisles: { count: 60, widthMeters: 1.0 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'truss', back: 60, front: 5, backY: 35, frontY: 31, depth: 2.4, bay: 7, color: 0x8fbbe6, underColor: 0xf0f2f3, glazing: 0.7, lights: { every: 5, y: 31.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x8f9296, walls: 0x9aa0a6 },
      facade: { style: 'membrane', color: 0x4a8fd8, accent: 0xb8d4f0 },
      runoff: { color: 0x2f7a3a, a: 59, b: 41.5, exponent: 8 },
      seatLook: {
        colors: ['#1565c0'],
        text: [
          { text: 'REAL SOCIEDAD', color: '#a9cbee', tier: 1, centerU: 0.25, halfU: 0.11, rows: [5, 16] },
          { text: '1909', color: '#a9cbee', tier: 0, centerU: 0.25, halfU: 0.035, rows: [12, 22] },
        ],
      },
      details: {
        ribbons: { color: 0x1565c0, tiers: [1] },
        girders: [
          { from: [-100, -76], to: [100, -76], y: 25, height: 10, bay: 7, color: 0xe4e7ea },
          { from: [-100, 76], to: [100, 76], y: 25, height: 10, bay: 7, color: 0xe4e7ea },
          { from: [-96, -80], to: [-96, 80], y: 25, height: 10, bay: 7, color: 0xe4e7ea },
          { from: [96, -80], to: [96, 80], y: 25, height: 10, bay: 7, color: 0xe4e7ea },
        ],
        screens: [
          { centerU: 0, widthM: 12, heightM: 6.5, hang: { offset: 34, y: 27, ceiling: 34 } },
          { centerU: 0.5, widthM: 12, heightM: 6.5, hang: { offset: 34, y: 27, ceiling: 34 } },
        ],
        // The sky-blue ETFE wrapped round it all, glowing at night.
        skins: [{ offset: 62, y0: 0, y1: 33, color: 0x4a8fd8, pattern: 'panels', tile: [5, 33], glow: 0.6 }],
      },
      site: { key: 'anoeta', horizon: 'hills', ground: 0x6f7a5a, forecourt: 0xa7a49b, style: 'es' },
    },
    meta: { name: 'Anoeta (San Sebastián)', source: 'builtin', country: 'Europe', capacity: 42247, type: 'Bowl', inspiredBy: 'Estadio Municipal de Anoeta, San Sebastián - home of Real Sociedad', tags: ['real-sociedad', 'la-real', 'san-sebastian', 'donostia', 'anoeta', 'reale-arena', 'basque', 'spain', LL] },
  },
  {
    // Ramón Sánchez-Pizjuán, Seville. The Preferencia (main) is the west side
    // (-z here), under the only roof, a thin flat canopy on stilts; the Fondo
    // opposite, Gol Norte (the Biris) north (+x here) and Gol Sur south (-x).
    // Pitch 105 x 68 (OSM). Two tiers all round, the corners filled; lamps on
    // racks round the rim.
    id: 'sanchez-pizjuan-44k',
    template: {
      id: 'sanchez-pizjuan-44k',
      name: 'Ramón Sánchez-Pizjuán (Seville)',
      version: 1,
      levels: 2,
      plan: { a: 60, b: 42, exponent: 7 },
      evenRows: true,
      tiers: [
        { rows: 23, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.47 },
        { rows: 23, rowDepth: 0.82, rakeDeg: 33, baseElevation: 12, baseOffset: 21, seatPitch: 0.47 },
      ],
      aisles: { count: 56, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'slab', side: 'south', from: -60, to: 60, back: 50, front: 26, backY: 33, frontY: 33, depth: 1.2, bay: 6, color: 0xc8cacc, underColor: 0x8c9196, columns: { every: 12, offset: 42, color: 0xd9dbdd } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0x9a9894, walls: 0xb6b2ab },
      facade: { style: 'cladding', color: 0xeeeeec, accent: 0xc8102e },
      runoff: { color: 0x2f7a3a, a: 60, b: 42, exponent: 7 },
      seatLook: {
        colors: ['#d4202b'],
        text: [{ text: 'SEVILLA FC', color: '#f6f4f2', tier: 1, centerU: 0.25, halfU: 0.1, rows: [11, 21] }],
      },
      details: {
        ribbons: { color: 0xd4202b, tiers: [1] },
        screens: [
          { centerU: 0, widthM: 10, heightM: 5.5, post: { offset: 44, y: 28 } },
          { centerU: 0.5, widthM: 10, heightM: 5.5, post: { offset: 44, y: 28 } },
        ],
        skins: [{ offset: 44, y0: 0, y1: 5, color: 0xc8102e, pattern: 'solid' }],
      },
      site: { key: 'sanchez-pizjuan', horizon: 'city', ground: 0xb8a57f, forecourt: 0xc3bdb0, style: 'es', palms: 0.3 },
    },
    meta: { name: 'Ramón Sánchez-Pizjuán (Seville)', source: 'builtin', country: 'Europe', capacity: 43883, type: 'Two-tier', inspiredBy: 'Estadio Ramón Sánchez-Pizjuán, Nervión, Seville - home of Sevilla FC', tags: ['sevilla', 'sevilla-fc', 'seville', 'nervion', 'pizjuan', 'andalusia', 'spain', LL] },
  },
  {
    // Mestalla, Valencia, in its last season. The Tribuna (main) is the west
    // side on Avinguda de Suècia (-z here), two tiers under the only roof; the
    // Grada Central opposite, three very steep tiers; the Gol Gran end north
    // (+x here) and the Gol Xicotet south (-x). Pitch 105 x 68 (OSM).
    id: 'mestalla-49k',
    template: {
      id: 'mestalla-49k',
      name: 'Mestalla (Valencia)',
      version: 1,
      levels: 3,
      plan: { a: 58, b: 39.5, exponent: 12 },
      evenRows: true,
      tiers: [
        { rows: 21, rowDepth: 0.75, rakeDeg: 28, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46 },
        { rows: 15, rowDepth: 0.75, rakeDeg: 34, baseElevation: 12, baseOffset: 19, seatPitch: 0.46 },
        { rows: 20, rowDepth: 0.75, rakeDeg: 36, baseElevation: 22, baseOffset: 33, seatPitch: 0.46, omit: [{ side: 'south', from: -200, to: 200 }] },
      ],
      aisles: { count: 56, widthMeters: 1.0 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', from: -56, to: 56, back: 44, front: 2, backY: 27, frontY: 24, depth: 1.6, bay: 7, color: 0x9c9fa3, underColor: 0x3f4247 },
      ],
      lighting: { style: 'corner-masts', kelvin: 5000, masts: { at: [[82, 70]], height: 58, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x8f9296, walls: 0x3a3a3d },
      facade: { style: 'concrete', color: 0x3a3a3d, accent: 0xee7d1a },
      runoff: { color: 0x2f7a3a, a: 58, b: 39.5, exponent: 12 },
      seatLook: {
        colors: ['#f07d1a'],
        regions: [{ tiers: [1, 2], side: 'north', from: -45, to: 45, colors: ['#1d1d1f'] }],
        text: [
          { text: 'VCF', color: '#f5f5f3', tier: 2, centerU: 0.25, halfU: 0.06, rows: [3, 18] },
          { text: 'MESTALLA', color: '#f5f5f3', tier: 1, centerU: 0.75, halfU: 0.1, rows: [3, 13] },
          { text: 'AMUNT', color: '#1d1d1f', tier: 2, centerU: 0, halfU: 0.08, rows: [4, 17] },
          { text: 'VALENCIA', color: '#1d1d1f', tier: 2, centerU: 0.5, halfU: 0.09, rows: [4, 17] },
        ],
      },
      details: {
        ribbons: { color: 0xee7d1a, tiers: [1, 2] },
        // Dark frames and orange bands; spiral ramps at the corners.
        skins: [{ offset: 50, y0: 0, y1: 37, color: 0x343437, pattern: 'slats', tile: [6, 3.6] }],
      },
      site: { key: 'mestalla', horizon: 'city', ground: 0xb3a27e, forecourt: 0xbfb9ac, style: 'es', palms: 0.3 },
    },
    meta: { name: 'Mestalla (Valencia)', source: 'builtin', country: 'Europe', capacity: 49430, type: 'Bowl', inspiredBy: 'Camp de Mestalla, Valencia - home of Valencia CF in its last season there', tags: ['valencia', 'valencia-cf', 'mestalla', 'vcf', 'spain', LL] },
  },
  {
    // Estadio de la Cerámica, Vila-real. The Tribuna (main) is the north-west
    // side (-z here); Preferencia opposite, the two-tier Fondo Norte the
    // north-east end (+x here) and the Fondo Sur south-west (-x). Pitch
    // 105 x 68 (OSM). Everything yellow: seats, steel, roof.
    id: 'la-ceramica-23k',
    template: {
      id: 'la-ceramica-23k',
      name: 'Estadio de la Cerámica (Vila-real)',
      version: 1,
      levels: 2,
      plan: { a: 58, b: 39, exponent: 14 },
      evenRows: true,
      tiers: [
        { rows: 23, rowDepth: 0.78, rakeDeg: 28, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.46 },
        {
          rows: 18, rowDepth: 0.82, rakeDeg: 33, baseElevation: 13, baseOffset: 22, seatPitch: 0.46, straight: true,
          stands: [{ side: 'east', halfLength: 40 }, { side: 'south', halfLength: 44, rows: 5 }],
        },
      ],
      aisles: { count: 44, widthMeters: 1.0 },
      sectionsPerTier: 36,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', back: 26, front: 2, backY: 20, frontY: 17, depth: 1.6, bay: 6, color: 0xf3e15a, underColor: 0xf2d21b, omit: [{ side: 'east', from: -200, to: 200 }], lights: { every: 5, y: 17.5 } },
        { style: 'sheet', side: 'east', straight: true, from: -44, to: 44, back: 40, front: 2, backY: 30, frontY: 26, depth: 2, bay: 6, color: 0x2c3540, underColor: 0xf2d21b, lights: { every: 5, y: 26.5 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0x9a978c, walls: 0xf2d21b },
      facade: { style: 'cladding', color: 0xf0d24a, accent: 0xe2c02a },
      runoff: { color: 0x2f7a3a, a: 58, b: 39, exponent: 14 },
      seatLook: { colors: ['#ffd400'] },
      details: {
        ribbons: { color: 0xffd400, tiers: [1] },
        screens: [
          { centerU: 0, widthM: 21, heightM: 7, hang: { offset: 20, y: 21, ceiling: 28 } },
          { centerU: 0.5, widthM: 21, heightM: 7, hang: { offset: 14, y: 14, ceiling: 19 } },
        ],
      },
      site: { key: 'la-ceramica', horizon: 'city', ground: 0xb3a27e, forecourt: 0xc0baad, style: 'es', palms: 0.25 },
    },
    meta: { name: 'Estadio de la Cerámica (Vila-real)', source: 'builtin', country: 'Europe', capacity: 23008, type: 'Single-tier', inspiredBy: 'Estadio de la Cerámica (El Madrigal), Vila-real - home of Villarreal CF', tags: ['villarreal', 'villarreal-cf', 'vila-real', 'ceramica', 'madrigal', 'yellow-submarine', 'spain', LL] },
  },
];
