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

const TL = 'thai-league';

type Side = 'north' | 'south' | 'east' | 'west';

/** Stairways across a straight stand, `step` apart, mirrored about its middle. */
const st = (side: Side, hl: number, step: number) => {
  const at: number[] = [];
  for (let x = step / 2; x < hl - 3; x += step) at.push(Math.round(x * 10) / 10);
  return { side, at, mirror: true };
};

export const THAI_LEAGUE: StadiumEntry[] = [
  (() => {
    // Chang Arena (Thunder Castle), Buriram — Buriram United's, built in 256
    // days in 2011. The main stand, its dark blue facade and Thai-gabled
    // entrance outside, is on the east, -z here; the opposite stand west, the
    // north end -x and the south end +x, the away end. One single tier close
    // to the pitch right round, its corners filled when it grew to 32,600,
    // with roofs over the two sides only, the main stand's the taller. Blue
    // seats, THUNDER CASTLE in white across the west stand and BURIRAM
    // across both ends; the big screen over the away end.
    const bowl: TierSpec = { rows: 36, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.4, baseOffset: 1, seatPitch: 0.47 };
    const t = { plan: { a: 60.5, b: 42, exponent: 8 }, tiers: [bowl] } as Parameters<typeof ringStairs>[0];
    const s = ringStairs(t, bowl, { step: 12, centred: true });
    return {
      id: 'chang-arena-33k',
      template: {
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
      },
      meta: { name: 'Chang Arena (Buriram)', source: 'builtin', country: 'Asia', capacity: 32600, type: 'Single-tier', inspiredBy: 'Chang Arena (Thunder Castle), Buriram - home of Buriram United', tags: ['buriram', 'buriram-united', 'chang-arena', 'thunder-castle', 'thailand', 'ultras', TL] },
    };
  })(),

  (() => {
    // PAT Stadium (Port Authority of Thailand), Khlong Toei, Bangkok — Port
    // FC's. Zone A, the 1967 concrete grandstand and the only one with a
    // roof, is the main stand, on the south, -z here; Zone C opposite, with
    // its upper section over the road that runs underneath; Zones B (east,
    // -x) and D (west, +x) behind the goals, steel and tube, the corners open
    // between them and the four masts in them. The stands as built hold
    // 12,308; the league's licence admits about 6,250. Blue and orange.
    const lower: TierSpec = {
      rows: 20, rowDepth: 0.75, rakeDeg: 26, baseElevation: 1.2, baseOffset: 1, seatPitch: 0.48, straight: true,
      stands: [
        { side: 'south', halfLength: 44, rows: 16 },
        { side: 'north', halfLength: 50, rows: 20 },
        { side: 'east', halfLength: 30, rows: 15, offset: 1 },
        { side: 'west', halfLength: 32, rows: 19, offset: 1 },
      ],
    };
    const upper: TierSpec = {
      rows: 10, rowDepth: 0.8, rakeDeg: 30, baseElevation: 10.5, baseOffset: 17, seatPitch: 0.48, straight: true,
      stands: [{ side: 'north', halfLength: 44, rows: 10 }],
    };
    const lowS = [st('south', 44, 11), st('north', 50, 11), st('east', 30, 11), st('west', 32, 11)];
    const upS = [st('north', 44, 11)];
    return {
      id: 'pat-stadium-12k',
      template: {
        id: 'pat-stadium-12k',
        name: 'PAT Stadium (Bangkok)',
        version: 1,
        levels: 2,
        plan: { a: 57.5, b: 39.5, exponent: 14 },
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.0, aisles: lowS } },
          { ...upper, blocks: { width: 1.0, aisles: upS } },
        ],
        aisles: { count: 36, widthMeters: 1.0 },
        sectionsPerTier: 28,
        roof: { coverage: 'none' },
        roofs: [
          // Zone A's concrete canopy, the only roof in the ground.
          { style: 'slab', side: 'south', straight: true, from: -44, to: 44, back: 15, front: 3, backY: 10.5, frontY: 9.5, depth: 0.8, bay: 6, color: 0xc9c5bd, underColor: 0xa29e96, columns: { every: 11, offset: 14, color: 0xc9c5bd } },
        ],
        lighting: { style: 'corner-masts', kelvin: 5200, masts: { at: [[62, 50]], height: 38, style: 'lattice', head: 'rect' } },
        finish: { concrete: 0x9d9a94, walls: 0xbcb8b0 },
        facade: { style: 'truss', color: 0x7d838a, accent: 0xa9aeb3 },
        runoff: { color: 0x2f7a3a, a: 57, b: 39, exponent: 14 },
        seatLook: {
          colors: [{ c: '#1b4fa0', w: 0.75 }, { c: '#f07c1b', w: 0.25 }],
          grain: { along: 3, rows: 2 },
          regions: [
            { tiers: [0], side: 'west', from: -40, to: 40, colors: [{ c: '#f07c1b', w: 0.7 }, { c: '#1b4fa0', w: 0.3 }], grain: { along: 3, rows: 2 } },
          ],
        },
        site: { key: 'pat-stadium', horizon: 'city-towers', ground: 0x8e8c84, forecourt: 0xaaa69c, style: 'es', palms: 0.4 },
      },
      meta: { name: 'PAT Stadium (Bangkok)', source: 'builtin', country: 'Asia', capacity: 12308, type: 'Single-tier', inspiredBy: 'PAT Stadium (Port Authority of Thailand Stadium), Khlong Toei, Bangkok - home of Port FC', tags: ['port', 'port-fc', 'pat', 'pat-stadium', 'khlong-toei', 'bangkok', 'thailand', 'ultras', TL] },
    };
  })(),

  (() => {
    // Thunderdome Stadium, Muang Thong Thani, Nonthaburi — Muangthong
    // United's (the Kirins), rebuilt in 2010 from one grandstand into four
    // steel stands close to the pitch. The West (main) stand is -z here, the
    // East opposite, the north end +x and the south end -x; the two sides
    // roofed, the ends open, the corners open with a mast in each. Red seats,
    // white in the ends, MUANGTHONG across the East.
    const lower: TierSpec = {
      rows: 26, rowDepth: 0.78, rakeDeg: 27, baseElevation: 1.3, baseOffset: 1, seatPitch: 0.48, straight: true,
      stands: [
        { side: 'south', halfLength: 52, rows: 23 },
        { side: 'north', halfLength: 52, rows: 26 },
        { side: 'east', halfLength: 34, rows: 20, offset: 1 },
        { side: 'west', halfLength: 34, rows: 20, offset: 1 },
      ],
    };
    const lowS = [st('south', 52, 11), st('north', 52, 11), st('east', 34, 11), st('west', 34, 11)];
    return {
      id: 'thunderdome-15k',
      template: {
        id: 'thunderdome-15k',
        name: 'Thunderdome Stadium (Nonthaburi)',
        version: 1,
        levels: 1,
        plan: { a: 57.5, b: 39.5, exponent: 14 },
        evenRows: true,
        tiers: [{ ...lower, blocks: { width: 1.0, aisles: lowS } }],
        aisles: { count: 34, widthMeters: 1.0 },
        sectionsPerTier: 28,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'sheet', side: 'south', straight: true, from: -52, to: 52, back: 21, front: 2, backY: 14, frontY: 12.5, depth: 1.2, bay: 7, color: 0xe2e4e6, underColor: 0x8e1d22, columns: { every: 13, offset: 19.8, color: 0xd9dbdd } },
          { style: 'sheet', side: 'north', straight: true, from: -52, to: 52, back: 23, front: 2, backY: 15.5, frontY: 13.5, depth: 1.2, bay: 7, color: 0xe2e4e6, underColor: 0x8e1d22, columns: { every: 13, offset: 22.2, color: 0xd9dbdd } },
        ],
        lighting: { style: 'corner-masts', kelvin: 5600, masts: { at: [[62, 48]], height: 40, style: 'lattice', head: 'rect' } },
        finish: { concrete: 0x9a9893, walls: 0xb9b6ae },
        facade: { style: 'truss', color: 0x6f7378, accent: 0x9ea2a6 },
        runoff: { color: 0x2f7a3a, a: 57, b: 39, exponent: 14 },
        seatLook: {
          colors: ['#c4161c'],
          regions: [
            { tiers: [0], side: 'east', from: -40, to: 40, colors: [{ c: '#f2f2f0', w: 0.7 }, { c: '#c4161c', w: 0.3 }], grain: { along: 3, rows: 2 } },
            { tiers: [0], side: 'west', from: -40, to: 40, colors: [{ c: '#f2f2f0', w: 0.7 }, { c: '#c4161c', w: 0.3 }], grain: { along: 3, rows: 2 } },
          ],
          text: [{ text: 'MUANGTHONG', color: '#f4f4f2', tier: 0, centerU: 0.25, halfU: 0.1, rows: [5, 21] }],
        },
        site: { key: 'thunderdome', horizon: 'city-towers', ground: 0x8e8c84, forecourt: 0xaaa69c, style: 'es', palms: 0.4 },
      },
      meta: { name: 'Thunderdome Stadium (Nonthaburi)', source: 'builtin', country: 'Asia', capacity: 15000, type: 'Single-tier', inspiredBy: 'Thunderdome Stadium, Muang Thong Thani, Nonthaburi - home of Muangthong United', tags: ['muangthong', 'muangthong-united', 'kirin', 'thunderdome', 'scg-stadium', 'nonthaburi', 'bangkok', 'thailand', 'ultras', TL] },
    };
  })(),
];
