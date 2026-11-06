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
import type { TierSpec } from './types';
import { lazyEntry } from './lazyEntry';

const IQ = 'iraq-stars-league';

type Side = 'north' | 'south' | 'east' | 'west';

/** Stairways across a straight stand, `step` apart, mirrored about its middle. */
const st = (side: Side, hl: number, step: number) => {
  const at: number[] = [];
  for (let x = step / 2; x < hl - 3; x += step) at.push(Math.round(x * 10) / 10);
  return { side, at, mirror: true };
};

export const IRAQ_STARS_LEAGUE: StadiumEntry[] = [
  lazyEntry('al-zawraa-15k', { name: 'Al-Zawraa Stadium (Baghdad)', source: 'builtin', country: 'Middle East', capacity: 15443, type: 'Single-tier', inspiredBy: 'Al-Zawraa Stadium, Utayfia, Karkh, Baghdad - home of Al-Zawraa SC', tags: ['al-zawraa', 'zawraa', 'nawaris', 'al-nawaris', 'gulls', 'baghdad', 'utayfia', 'karkh', 'iraq', 'ultras', IQ] }, () => {
    // Al-Zawraa Stadium, Utayfia, Baghdad — a compact rectangle in a dense
    // residential quarter near the Tigris, inside the white shell of the
    // Al-Zawraa sports complex. Four covered straight stands, held together
    // by four tall corner blocks (the Bessa/Nîmes pattern), each under a
    // flat steel-truss roof with the floodlights in rows along its edge; a
    // video screen on two of the corner blocks. The main stand (real west)
    // is -z here, the complex's building behind it: one tier plus a narrow
    // gallery with boxes at the top, the only second storey in the ground.
    // The first rows sit on a wall well above the pitch, clearest behind
    // the goals. Seats in the club's black and white, mixed as a mosaic —
    // white weighted at the bottom, black at the top — with a black Z on a
    // white field in the middle of the stand opposite the main one (the
    // real east), and the main stand's lower rows in the beige and white of
    // its padded seats.
    const lower: TierSpec = {
      rows: 24, rowDepth: 0.78, rakeDeg: 27, baseElevation: 3.4, baseOffset: 1, seatPitch: 0.48, straight: true,
      stands: [
        { side: 'south', halfLength: 50.5, rows: 22 },
        { side: 'north', halfLength: 50.5, rows: 24 },
        { side: 'east', halfLength: 33.5, rows: 24 },
        { side: 'west', halfLength: 33.5, rows: 24 },
      ],
    };
    // The main stand's narrow gallery under the roof, the boxes behind it.
    const gallery: TierSpec = {
      rows: 4, rowDepth: 0.8, rakeDeg: 29, baseElevation: 15.2, baseOffset: 20.6, seatPitch: 0.48, straight: true,
      stands: [{ side: 'south', halfLength: 44, rows: 4 }],
    };
    const s = [st('south', 50, 10), st('north', 50, 10), st('east', 33, 9), st('west', 33, 9)];
    return {
      id: 'al-zawraa-15k',
      name: 'Al-Zawraa Stadium (Baghdad)',
      version: 1,
      levels: 2,
      plan: { a: 57, b: 40, exponent: 14 },
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.0, aisles: s } },
        { ...gallery, blocks: { width: 1.0, aisles: [st('south', 44, 10.5)] } },
      ],
      aisles: { count: 36, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        // Four flat truss roofs, one per stand, the main stand's the taller.
        { style: 'sheet', side: 'south', straight: true, from: -52, to: 52, back: 26.5, front: 3, backY: 21, frontY: 19.5, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10.4, offset: 25.8, color: 0xd6d8da }, lights: { every: 4.5, y: 19.8 } },
        { style: 'sheet', side: 'north', straight: true, from: -52, to: 52, back: 23.5, front: 2.5, backY: 18.4, frontY: 17, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10.4, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 17.3 } },
        { style: 'sheet', side: 'east', straight: true, from: -35, to: 35, back: 23.5, front: 2.5, backY: 18.4, frontY: 17, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 17.3 } },
        { style: 'sheet', side: 'west', straight: true, from: -35, to: 35, back: 23.5, front: 2.5, backY: 18.4, frontY: 17, depth: 1.6, bay: 8, color: 0xdfe1e3, underColor: 0x4a5058, columns: { every: 10, offset: 22.8, color: 0xd6d8da }, lights: { every: 4.5, y: 17.3 } },
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
          { tiers: [0], side: 'south', from: -51, to: 51, rows: [0, 10], colors: [{ c: '#cfc4aa', w: 0.52 }, { c: '#eceade', w: 0.33 }, { c: '#23252a', w: 0.15 }] },
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
        // The white shell round the bowl, and the four corner blocks that
        // hold the stands together: the inner ring fills each corner with a
        // flat white face flush with the stands (the photographs show the
        // roofs dying onto them, their top edge a little proud of the lower
        // roofs' fascia); the outer ring is the complex's wall, whose main-
        // stand side is the complex's own building, below.
        skins: [
          { offset: 1.3, y0: 0, y1: 17.8, color: 0xf0eee9, pattern: 'panels', tile: [5, 4.5], omit: [
            { side: 'south', from: -50.5, to: 50.5 },
            { side: 'north', from: -50.5, to: 50.5 },
            { side: 'east', from: -33.5, to: 33.5 },
            { side: 'west', from: -33.5, to: 33.5 },
          ] },
          { offset: 25.5, y0: 0, y1: 18.6, color: 0xeceae5, pattern: 'panels', tile: [6, 4], omit: [{ side: 'south', from: -52, to: 52 }] },
        ],
        buildings: [
          // The sports complex block behind the main stand (hotel, offices),
          // its glazed floors over the gallery.
          { side: 'south', straight: true, halfLength: 54, front: 24.5, depth: 14, y0: 0, y1: 17.8, glassFloors: 2, color: 0xe8e5de, fascia: 0xf2f0ea },
        ],
        // The video screens on two of the corner blocks (real north-west and
        // south-east corners), on the blocks' faces, turned to the centre spot.
        screens: [
          { centerU: 0.896, widthM: 7, heightM: 5, at: [54.8, -38.6], post: { y: 11.5 } },
          { centerU: 0.396, widthM: 7, heightM: 5, at: [-54.8, 38.6], post: { y: 11.5 } },
        ],
      },
      site: { key: 'al-zawraa', horizon: 'city', ground: 0xa89a7e, forecourt: 0xc0b6a2, palms: 0.35 },
    };
  }),
];
