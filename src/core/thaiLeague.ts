/**
 * Thailand: three Thai League grounds, 2026-27 — Buriram United's Chang
 * Arena, Port FC's PAT Stadium in Khlong Toei and Muangthong United's
 * Thunderdome (Muangthong in Thai League 2 this season; its ground, and its
 * Ultras Muangthong, are still the loudest in Bangkok's north).
 *
 * Built the same way as the European grounds (see ligue1.ts): the
 * OpenStreetMap centre and axis (© OpenStreetMap contributors, ODbL), the
 * stand capacities the clubs and StadiumDB publish, and the real blocks from
 * the start. The engine's frame: the main stand south (-z), the ends east
 * (+x, on your right as you face the main stand from the pitch) and west
 * (-x).
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { TierSpec } from './types';
import { ringStairs, atStairs } from './realBlocks';
import { lazyEntry } from './lazyEntry';

const TL = 'thai-league';

type Side = 'north' | 'south' | 'east' | 'west';

/** Stairways across a straight stand, `step` apart, mirrored about its middle. */
const st = (side: Side, hl: number, step: number) => {
  const at: number[] = [];
  for (let x = step / 2; x < hl - 3; x += step) at.push(Math.round(x * 10) / 10);
  return { side, at, mirror: true };
};

export const THAI_LEAGUE: StadiumEntry[] = [
  lazyEntry('chang-arena-33k', { name: 'Chang Arena (Buriram)', source: 'builtin', country: 'Asia', capacity: 32600, type: 'Single-tier', inspiredBy: 'Chang Arena (Thunder Castle), Buriram - home of Buriram United', tags: ['buriram', 'buriram-united', 'chang-arena', 'thunder-castle', 'thailand', 'ultras', TL] }, () => {
    // Chang Arena (Thunder Castle), Buriram — Buriram United's, built in 256
    // days in 2011. The main stand, its dark blue facade and Thai-gabled
    // entrance outside, is on the east, -z here — the club megastore and the
    // formal forecourt are on that side (OpenStreetMap, the satellite
    // picture); the opposite stand west, the north end -x and the south end
    // +x, the away end, its screen over it and Khao Kradong behind it. One single tier close
    // to the pitch right round, its corners filled when it grew to 32,600,
    // with roofs over the two sides only, the main stand's the taller. Blue
    // seats, THUNDER CASTLE in white across the west stand and BURIRAM
    // across both ends; the big screen over the away end.
    const bowl: TierSpec = { rows: 36, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.4, baseOffset: 1, seatPitch: 0.47 };
    const t = { plan: { a: 60.5, b: 42, exponent: 8 }, tiers: [bowl] } as Parameters<typeof ringStairs>[0];
    const s = ringStairs(t, bowl, { step: 12, centred: true });
    return {
      id: 'chang-arena-33k',
      name: 'Chang Arena (Buriram)',
      version: 1,
      levels: 1,
      plan: t.plan,
      evenRows: true,
      tiers: [{ ...bowl, blocks: { width: 1.1, aisles: s, openings: atStairs(s, { width: 2.4, rows: [18, 20], kind: 'vomitory' }) } }],
      aisles: { count: 52, widthMeters: 1.1 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // The two side roofs, the main stand's over its skyboxes.
        { style: 'sheet', side: 'south', from: -56, to: 56, back: 32, front: 2, backY: 22, frontY: 20, depth: 1.8, bay: 8, color: 0xdfe3e7, underColor: 0x2c4a8c, columns: { every: 12, offset: 31.2, color: 0xdfe3e7 }, lights: { every: 5, y: 20.3 } },
        { style: 'sheet', side: 'north', from: -56, to: 56, back: 32, front: 2, backY: 19.5, frontY: 17.5, depth: 1.8, bay: 8, color: 0xdfe3e7, underColor: 0x2c4a8c, columns: { every: 12, offset: 31.2, color: 0xdfe3e7 }, lights: { every: 5, y: 17.8 } },
      ],
      lighting: { style: 'side-banks', kelvin: 5700 },
      finish: { concrete: 0xa3a5a8, walls: 0xc9ccd0 },
      facade: { style: 'cladding', color: 0x1d3466, accent: 0xc9a74a },
      runoff: { color: 0x2f7a3a, a: 59.5, b: 41, exponent: 8 },
      seatLook: {
        colors: [{ c: '#1d4fb8', w: 0.9 }, { c: '#163f96', w: 0.1 }],
        grain: { along: 3, rows: 2 },
        text: [
          { text: 'THUNDER CASTLE', color: '#f4f6f8', tier: 0, centerU: 0.25, halfU: 0.11, rows: [6, 28] },
          { text: 'BURIRAM', color: '#f4f6f8', tier: 0, centerU: 0.5, halfU: 0.07, rows: [8, 28] },
          { text: 'BURIRAM', color: '#f4f6f8', tier: 0, centerU: 0, halfU: 0.07, rows: [8, 28] },
        ],
      },
      details: {
        ribbons: { color: 0xf0b323, tiers: [0] },
        // The big screen on the back of the away end.
        screens: [{ centerU: 0, widthM: 16, heightM: 8 }],
      },
      site: { key: 'chang-arena', horizon: 'hills', ground: 0x9b8f72, forecourt: 0xbdb5a3, style: 'es', palms: 0.5 },
    };
  }),

  lazyEntry('pat-stadium-12k', { name: 'PAT Stadium (Bangkok)', source: 'builtin', country: 'Asia', capacity: 12308, type: 'Single-tier', inspiredBy: 'PAT Stadium (Port Authority of Thailand Stadium), Khlong Toei, Bangkok - home of Port FC', tags: ['port', 'port-fc', 'pat', 'pat-stadium', 'khlong-toei', 'bangkok', 'thailand', 'ultras', TL] }, () => {
    // PAT Stadium (Port Authority of Thailand), Khlong Toei, Bangkok — Port
    // FC's. Zone A, the 1967 grandstand and the only one with a roof, is the
    // main stand, on the south, -z here; Zone C opposite, the deepest, over
    // the road that runs underneath; Zones B (east, -x) and D (west, +x)
    // behind the goals, shallow steel stands, the corners open between them
    // with a floodlight pole in each. As the satellite picture shows them:
    // blue seats striped with orange blocks, PORT FC 1967 across Zone C. The
    // stands as built hold 12,308; the league's licence admits about 6,250.
    const bowl: TierSpec = {
      rows: 25, rowDepth: 0.72, rakeDeg: 27, baseElevation: 1.1, baseOffset: 0.5, seatPitch: 0.43, straight: true,
      stands: [
        { side: 'south', halfLength: 50, rows: 14 },
        { side: 'north', halfLength: 52, rows: 25 },
        { side: 'east', halfLength: 36, rows: 12 },
        { side: 'west', halfLength: 38, rows: 11 },
      ],
    };
    const s = [st('south', 50, 10), st('north', 52, 10), st('east', 36, 9), st('west', 38, 9)];
    // Orange blocks every ten metres along the open stands.
    const stripes = (side: Side, hl: number) => {
      const r: { tiers: number[]; side: Side; from: number; to: number; colors: string[] }[] = [];
      for (let x = -hl + 4; x < hl - 3; x += 10) r.push({ tiers: [0], side, from: x, to: x + 3.5, colors: ['#f0801e'] });
      return r;
    };
    return {
      id: 'pat-stadium-12k',
      name: 'PAT Stadium (Bangkok)',
      version: 1,
      levels: 1,
      plan: { a: 56, b: 38.5, exponent: 14 },
      evenRows: true,
      tiers: [{ ...bowl, blocks: { width: 0.9, aisles: s } }],
      aisles: { count: 36, widthMeters: 0.9 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        // Zone A's roof, the only one in the ground.
        { style: 'sheet', side: 'south', straight: true, from: -50, to: 50, back: 11.5, front: 0, backY: 10.5, frontY: 9.5, depth: 0.9, bay: 6, color: 0x9db4c6, underColor: 0x3e4752, columns: { every: 10, offset: 11, color: 0x5d6670 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5200, masts: { at: [[60, 46]], height: 40, style: 'pole', head: 'rect' } },
      finish: { concrete: 0x9d9a94, walls: 0xbcb8b0 },
      facade: { style: 'truss', color: 0x7d838a, accent: 0xa9aeb3 },
      runoff: { color: 0x2f7a3a, a: 55.5, b: 38, exponent: 14 },
      seatLook: {
        colors: ['#2747a8'],
        regions: [...stripes('north', 52), ...stripes('east', 36), ...stripes('west', 38)],
        text: [{ text: 'PORT FC 1967', color: '#f4f1ea', tier: 0, centerU: 0.25, halfU: 0.09, rows: [4, 20] }],
      },
      site: { key: 'pat-stadium', horizon: 'city-towers', ground: 0x8e8c84, forecourt: 0xaaa69c, style: 'es', palms: 0.4 },
    };
  }),

  lazyEntry('thunderdome-15k', { name: 'Thunderdome Stadium (Nonthaburi)', source: 'builtin', country: 'Asia', capacity: 15000, type: 'Single-tier', inspiredBy: 'Thunderdome Stadium, Muang Thong Thani, Nonthaburi - home of Muangthong United', tags: ['muangthong', 'muangthong-united', 'kirin', 'thunderdome', 'scg-stadium', 'nonthaburi', 'bangkok', 'thailand', 'ultras', TL] }, () => {
    // Thunderdome Stadium, Muang Thong Thani, Nonthaburi — Muangthong
    // United's (the Kirins), rebuilt in 2010 from one grandstand into four
    // steel stands. As the satellite picture shows them: the West (main)
    // stand -z here, the deepest, with MTUTD across its front rows; the East
    // opposite; the north end +x, MUANGTHONG across it; the shallower south
    // end -x. Red seats, a wide grass margin round the pitch, and a white
    // roof over the back of every stand, the front rows open to the sky.
    const bowl: TierSpec = {
      rows: 27, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.3, baseOffset: 0.8, seatPitch: 0.48, straight: true,
      stands: [
        { side: 'south', halfLength: 55, rows: 27 },
        { side: 'north', halfLength: 53, rows: 21 },
        { side: 'east', halfLength: 37, rows: 21 },
        { side: 'west', halfLength: 37, rows: 14 },
      ],
    };
    const s = [st('south', 55, 11), st('north', 53, 11), st('east', 37, 11), st('west', 37, 11)];
    const roof = (side: Side, hl: number, front: number, back: number, frontY: number, backY: number) =>
      ({ style: 'sheet' as const, side, straight: true, from: -hl, to: hl, back, front, backY, frontY, depth: 1.1, bay: 7, color: 0xe9ebec, underColor: 0x7d838a, columns: { every: 12, offset: back - 0.8, color: 0xd9dbdd } });
    return {
      id: 'thunderdome-15k',
      name: 'Thunderdome Stadium (Nonthaburi)',
      version: 1,
      levels: 1,
      plan: { a: 60.5, b: 43, exponent: 14 },
      evenRows: true,
      tiers: [{ ...bowl, blocks: { width: 1.0, aisles: s } }],
      aisles: { count: 34, widthMeters: 1.0 },
      sectionsPerTier: 28,
      roof: { coverage: 'none' },
      roofs: [
        roof('south', 55, 9, 23, 13, 14.5),
        roof('north', 53, 8, 18.5, 11.5, 12.5),
        roof('east', 37, 7, 18, 11, 12),
        roof('west', 37, 5, 12.5, 9, 9.5),
      ],
      lighting: { style: 'corner-masts', kelvin: 5600, masts: { at: [[70, 56]], height: 40, style: 'lattice', head: 'rect' } },
      finish: { concrete: 0x9a9893, walls: 0xb9b6ae },
      facade: { style: 'truss', color: 0x6f7378, accent: 0x9ea2a6 },
      runoff: { color: 0x2f7a3a, a: 60, b: 42.5, exponent: 14 },
      seatLook: {
        colors: ['#c4161c'],
        text: [
          { text: 'MTUTD', color: '#f4f4f2', tier: 0, centerU: 0.75, halfU: 0.066, rows: [1, 9] },
          { text: 'MUANGTHONG', color: '#f4f4f2', tier: 0, centerU: 0, halfU: 0.078, rows: [2, 9] },
        ],
      },
      site: { key: 'thunderdome', horizon: 'city-towers', ground: 0x8e8c84, forecourt: 0xaaa69c, style: 'es', palms: 0.4 },
    };
  }),
];
