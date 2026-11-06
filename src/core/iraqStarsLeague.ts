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

/**
 * Stairways across a straight stand: the first `half` metres from the
 * middle, then every `step`, mirrored about the middle. With half = step/2
 * every block is `step` wide and its middle sits on a multiple of `step` —
 * where the vomitories go.
 */
const st = (side: Side, hl: number, step: number, half = step / 2) => {
  const at: number[] = [];
  for (let x = half; x < hl - 2.5; x += step) at.push(Math.round(x * 10) / 10);
  return { side, at, mirror: true };
};

/** Vomitories at the middles of blocks `step` wide: at ±step, ±3·step, … (`count` of them, even). */
const vom = (side: Side, step: number, count: number, rows: [number, number]): SeatOpening => {
  const at: number[] = [];
  for (let k = 1; at.length < count / 2; k += 2) at.push(Math.round(k * step * 10) / 10);
  return { side, at, mirror: true, width: 2.4, rows, kind: 'vomitory' };
};

export const IRAQ_STARS_LEAGUE: StadiumEntry[] = [
  lazyEntry('al-zawraa-15k', { name: 'Al-Zawraa Stadium (Baghdad)', source: 'builtin', country: 'Middle East', capacity: 15443, type: 'Single-tier', inspiredBy: 'Al-Zawraa Stadium, Utayfia, Karkh, Baghdad - home of Al-Zawraa SC', tags: ['al-zawraa', 'zawraa', 'nawaris', 'al-nawaris', 'gulls', 'baghdad', 'utayfia', 'karkh', 'iraq', 'ultras', IQ] }, () => {
    // Al-Zawraa Stadium, Utayfia, Baghdad — a compact rectangle in a dense
    // residential quarter near the Tigris, inside the white shell of the
    // Al-Zawraa sports complex. Four covered straight stands, held together
    // by four solid corner blocks (the Bessa/Nîmes pattern): each block a
    // concrete tower filling its corner from the stands' front line back to
    // the shell, a flat angled face to the pitch with a doorway at its foot,
    // its top just under the roofs, which die onto it; a video screen on two
    // of them. Each stand under its own flat steel-truss roof with the
    // floodlights in rows along its edge. The main stand (real west) is -z
    // here, the complex's building behind it: one tier plus a narrow gallery
    // with boxes at the top, the only second storey in the ground. The two
    // side stands start barely above the pitch — a low wall and the first
    // row — while the ends sit on a wall well above it. Six vomitories a
    // third of the way up each side stand, four at the foot of each end, all
    // evenly spaced. Seats in the club's black and white, mixed as a mosaic —
    // white weighted at the bottom, black at the top — with a black Z on a
    // white field in the middle of the stand opposite the main one (the real
    // east), and the main stand's lower rows in the beige and white of its
    // padded seats.
    const SIDE_HL = 52;
    const END_HL = 34.5;
    const STEP = 8.4; // block width: six evenly spaced vomitories along each side, four along each end
    const lower: TierSpec = {
      rows: 24, rowDepth: 0.78, rakeDeg: 27, baseElevation: 1.3, baseOffset: 1, seatPitch: 0.475, straight: true,
      stands: [
        { side: 'south', halfLength: SIDE_HL, rows: 22 },
        { side: 'north', halfLength: SIDE_HL, rows: 24 },
        { side: 'east', halfLength: END_HL, rows: 24, elevation: 2.1 },
        { side: 'west', halfLength: END_HL, rows: 24, elevation: 2.1 },
      ],
    };
    // The main stand's narrow gallery under the roof, the boxes behind it.
    const gallery: TierSpec = {
      rows: 4, rowDepth: 0.8, rakeDeg: 29, baseElevation: 12.4, baseOffset: 19.6, seatPitch: 0.48, straight: true,
      stands: [{ side: 'south', halfLength: 44, rows: 4 }],
    };
    const stairs = [st('south', SIDE_HL, STEP), st('north', SIDE_HL, STEP), st('east', END_HL, STEP), st('west', END_HL, STEP)];
    const openings = [
      vom('south', STEP, 6, [6, 8]), vom('north', STEP, 6, [6, 8]),
      vom('east', STEP, 4, [1, 3]), vom('west', STEP, 4, [1, 3]),
    ];
    // The corner blocks: one solid wedge per corner, from the stands' front
    // line (plan offset 1.3) back to the shell (25.3), two ring buildings
    // meeting a little past the 45° point so there is no seam. Their doorways
    // at the foot of each face, dark.
    const BLOCK = { front: 1.3, depth: 24, y0: 0, y1: 16.2, color: 0xdcdbd6, fascia: 0xe9e8e3 } as const;
    const corner = (side: Side, from: number, to: number): StandBuilding => ({ side, center: (from + to) / 2, halfLength: Math.abs(to - from) / 2, ...BLOCK });
    const door = (side: Side, at: number): StandBuilding => ({ side, center: at, halfLength: 2, front: 1.1, depth: 0.3, y0: 0, y1: 3.4, color: 0x15171a, fascia: 0x15171a });
    const corners: StandBuilding[] = [
      // South-east corner (real north-west): the south stand's end at x 52 to
      // past the 45° point (x ≈ 55); the east stand's end at z -34.5 to past it (z ≈ -39.1).
      corner('south', 52, 55.8), corner('east', -39.6, -34.5), door('south', 54.6),
      corner('south', -55.8, -52), corner('west', -39.6, -34.5), door('south', -54.6),
      corner('north', 52, 55.8), corner('east', 34.5, 39.6), door('north', 54.6),
      corner('north', -55.8, -52), corner('west', 34.5, 39.6), door('north', -54.6),
    ];
    return {
      id: 'al-zawraa-15k',
      name: 'Al-Zawraa Stadium (Baghdad)',
      version: 1,
      levels: 2,
      plan: { a: 57, b: 40, exponent: 14 },
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.0, aisles: stairs, openings } },
        { ...gallery, blocks: { width: 1.0, aisles: [st('south', 44, 10.5)] } },
      ],
      aisles: { count: 36, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        // Four flat truss roofs, one per stand, the main stand's the taller.
        { style: 'sheet', side: 'south', straight: true, from: -53.5, to: 53.5, back: 26.5, front: 3, backY: 18.6, frontY: 17.2, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10.4, offset: 25.8, color: 0xd6d8da }, lights: { every: 4.5, y: 17.5 } },
        { style: 'sheet', side: 'north', straight: true, from: -53.5, to: 53.5, back: 23.5, front: 2.5, backY: 17.4, frontY: 16, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10.4, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 16.3 } },
        { style: 'sheet', side: 'east', straight: true, from: -36, to: 36, back: 23.5, front: 2.5, backY: 17.4, frontY: 16, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 16.3 } },
        { style: 'sheet', side: 'west', straight: true, from: -36, to: 36, back: 23.5, front: 2.5, backY: 17.4, frontY: 16, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 16.3 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5600 },
      finish: { concrete: 0xa8a6a1, walls: 0xd8d6d0 },
      facade: { style: 'cladding', color: 0xe9e7e1, accent: 0xc8c5bd },
      runoff: { color: 0x2f7a3a, a: 56.5, b: 39.5, exponent: 14 },
      seatLook: {
        // The black-and-white mosaic, mixed seat by seat as the photographs
        // show it: white weighted at the bottom, black at the top. Regions are
        // first-match, so the main stand's beige comes before the row bands.
        colors: [{ c: '#e9ebee', w: 0.52 }, { c: '#1b1d20', w: 0.48 }],
        regions: [
          // The main stand's beige padded seats across its lower half.
          { tiers: [0], side: 'south', from: -52.5, to: 52.5, rows: [0, 10], colors: [{ c: '#cfc4aa', w: 0.52 }, { c: '#eceade', w: 0.33 }, { c: '#23252a', w: 0.15 }] },
          { tiers: [0], rows: [0, 7], colors: [{ c: '#e9ebee', w: 0.74 }, { c: '#1b1d20', w: 0.26 }] },
          { tiers: [0], rows: [17, 23], colors: [{ c: '#1b1d20', w: 0.72 }, { c: '#e9ebee', w: 0.28 }] },
          // The gallery, black like the top of the bowl.
          { tiers: [1], colors: [{ c: '#1b1d20', w: 0.8 }, { c: '#e9ebee', w: 0.2 }] },
        ],
        text: [
          // The club's Z, black on a white field, mid-height of the real east stand.
          { text: 'Z', color: '#0c0d0f', ground: '#f0f1f3', tier: 0, centerU: 0.25, halfU: 0.035, rows: [5, 19] },
        ],
      },
      details: {
        // The white shell round the bowl — the complex's outer wall, whose
        // main-stand side is the complex's own building, below.
        skins: [{ offset: 25.5, y0: 0, y1: 17.6, color: 0xeceae5, pattern: 'panels', tile: [6, 4], omit: [{ side: 'south', from: -53.5, to: 53.5 }] }],
        buildings: [
          ...corners,
          // The sports complex block behind the main stand (hotel, offices),
          // its glazed floors over the gallery.
          { side: 'south', straight: true, halfLength: 54, front: 24.5, depth: 14, y0: 0, y1: 17.8, glassFloors: 2, color: 0xe8e5de, fascia: 0xf2f0ea },
        ],
        // The video screens at the top of two of the corner blocks (real
        // north-west and south-east corners), turned to the centre spot.
        screens: [
          { centerU: 0.896, widthM: 6, heightM: 5, at: [54.8, -38.6], post: { y: 11 } },
          { centerU: 0.396, widthM: 6, heightM: 5, at: [-54.8, 38.6], post: { y: 11 } },
        ],
      },
      site: { key: 'al-zawraa', horizon: 'city', ground: 0xa89a7e, forecourt: 0xc0b6a2, palms: 0.35 },
    };
  }),
];
