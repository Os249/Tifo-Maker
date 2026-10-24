/**
 * Algeria: five Ligue 1 Mobilis grounds, 2026-27 — the 5 Juillet (USM Alger
 * and the derbies), MC Alger's new home at Douéra, CR Belouizdad's at Baraki,
 * JS Kabylie's at Tizi Ouzou and MC Oran's.
 *
 * Built the same way as the European grounds (see ligue1.ts): the
 * OpenStreetMap footprint (© OpenStreetMap contributors, ODbL), Esri
 * satellite pictures and photographs, the official capacity, and the real
 * blocks from the start. The engine's frame: the main stand (tribune
 * officielle) south (-z), the ends east (+x, on your right as you face the
 * main stand from the pitch) and west (-x).
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { TierSpec } from './types';
import { ringStairs, atStairs } from './realBlocks';
import { lazyEntry } from './lazyEntry';

const AL = 'algeria-ligue-1';

/** Skip for atStairs: a vomitory only at every other stairway of the regular rhythm (see botola.ts). */
const offRhythm = (step: number) => (_s: string, at: number): boolean => Math.abs(at - step * Math.round(at / step)) > 0.3 || Math.round(at / step) % 2 === 1;

export const ALGERIA_LIGUE_1: StadiumEntry[] = [
  lazyEntry('stade-5-juillet-64k', { name: 'Stade du 5 Juillet 1962 (Algiers)', source: 'builtin', country: 'Africa', capacity: 64000, type: 'Oval', inspiredBy: 'Stade du 5 Juillet 1962, Algiers - home of USM Alger and the Algeria national team', tags: ['usma', 'usm-alger', 'mc-alger', 'algiers', 'alger', '5-juillet', 'cinq-juillet', 'algeria', 'track', 'ultras', AL] }, () => {
    // Stade du 5 Juillet 1962, Complexe olympique Mohamed-Boudiaf, Algiers —
    // USM Alger's home, the national stadium and the derbies' ground. The
    // tribune officielle, under its concrete canopy, is -z here. A 1972 oval
    // of two tiers round a blue athletics track, its thirty numbered gates
    // all round (OpenStreetMap): white and grey seats below with red at the
    // back, green above in the national colours, flagpoles along the rim.
    const lower: TierSpec = { rows: 30, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.3, baseOffset: 1.5, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 30, rowDepth: 0.85, rakeDeg: 31, baseElevation: 15, baseOffset: 29, seatPitch: 0.5 };
    const t = { plan: { a: 90, b: 48, exponent: 2.4 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 13, centred: true });
    const upS = ringStairs(t, upper, { step: 13, centred: true });
    return {
      id: 'stade-5-juillet-64k',
      name: 'Stade du 5 Juillet 1962 (Algiers)',
      version: 1,
      levels: 2,
      plan: t.plan,
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.2, aisles: lowS, openings: atStairs(lowS, { width: 2.6, rows: [24, 27], kind: 'vomitory' }, offRhythm(13)) } },
        { ...upper, blocks: { width: 1.2, aisles: upS, openings: atStairs(upS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }) } },
      ],
      aisles: { count: 64, widthMeters: 1.2 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        // The tribune officielle's concrete canopy.
        { style: 'slab', side: 'south', from: -70, to: 70, back: 58, front: 24, backY: 35, frontY: 32.5, depth: 1.4, bay: 8, color: 0xd9d6cf, underColor: 0xb7b3aa },
      ],
      track: { lanes: 8, surface: 0x2f63a9 },
      lighting: { style: 'corner-masts', kelvin: 5600, masts: { at: [[122, 86]], height: 50, style: 'pole', head: 'rect' } },
      finish: { concrete: 0xc9c5bc, walls: 0xd9d5cc },
      facade: { style: 'concrete', color: 0xd6d1c5, accent: 0xe3dfd5, bayMeters: 10 },
      runoff: { color: 0x2f63a9, a: 90, b: 48, exponent: 2.4 },
      seatLook: {
        colors: [{ c: '#eceeef', w: 0.7 }, { c: '#b9bec2', w: 0.3 }],
        grain: { along: 3, rows: 2 },
        regions: [
          { tiers: [0], rows: [24, 29], colors: ['#c8202c'] },
          { tiers: [1], colors: [{ c: '#14834a', w: 0.9 }, { c: '#eef0f0', w: 0.1 }], grain: { along: 3, rows: 2 } },
        ],
      },
      details: {
        screens: [
          { centerU: 0, widthM: 12, heightM: 6 },
          { centerU: 0.5, widthM: 12, heightM: 6 },
        ],
      },
      site: { key: 'cinq-juillet', horizon: 'hills', ground: 0xb9ad91, forecourt: 0xcdc4b2 },
    };
  }),
  lazyEntry('hocine-ait-ahmed-51k', { name: 'Stade Hocine Aït Ahmed (Tizi Ouzou)', source: 'builtin', country: 'Africa', capacity: 50766, type: 'Bowl', inspiredBy: 'Stade Hocine Aït Ahmed, Tizi Ouzou - home of JS Kabylie', tags: ['jsk', 'js-kabylie', 'kabylie', 'tizi-ouzou', 'boukhalfa', 'hocine-ait-ahmed', 'algeria', 'ultras', AL] }, () => {
    // Stade Hocine Aït Ahmed, Boukhalfa, Tizi Ouzou — JS Kabylie's since
    // 2024, under the Djurdjura. The main stand, on the west-north-west with
    // the helipad and the VIP car parks behind it, is -z here; the auxiliary
    // athletics stadium is behind the stand opposite. A football ground
    // of three tiers the same height all round — a lower one, a narrow middle
    // one of boxes and an upper one — with rounded, filled corners, all of it
    // under a roof of green glass in parabolic segments on white steel
    // trusses. Yellow seats with green below, a band of boxes, green with
    // yellow above — JSK's colours; a screen hung in two of the corners; an
    // open steel and glass facade with the ground's name across it.
    const lower: TierSpec = { rows: 23, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.6, baseOffset: 2, seatPitch: 0.5 };
    const middle: TierSpec = { rows: 8, rowDepth: 0.85, rakeDeg: 28, baseElevation: 13.5, baseOffset: 23, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 21, rowDepth: 0.85, rakeDeg: 34, baseElevation: 20.5, baseOffset: 31.5, seatPitch: 0.5 };
    const t = { plan: { a: 63, b: 45, exponent: 5 }, tiers: [lower, middle, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const midS = ringStairs(t, middle, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    return {
      id: 'hocine-ait-ahmed-51k',
      name: 'Stade Hocine Aït Ahmed (Tizi Ouzou)',
      version: 1,
      levels: 3,
      plan: t.plan,
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [16, 18], kind: 'vomitory' }, offRhythm(12)) } },
        { ...middle, blocks: { width: 1.1, aisles: midS } },
        { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
      ],
      aisles: { count: 60, widthMeters: 1.1 },
      sectionsPerTier: 44,
      roof: { coverage: 'none' },
      roofs: [
        // The glazed roof on its cables, white steel over the glass.
        { style: 'membrane', back: 52, front: 0, backY: 37, frontY: 33.5, depth: 2.5, bay: 10, color: 0xc6e3c4, underColor: 0x8fc49a, glazing: 0.55, lights: { every: 5, y: 33.8 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0xa9a7a1, walls: 0xd2d0ca },
      facade: { style: 'truss', color: 0xeef0f1, accent: 0x2f8a4a },
      runoff: { color: 0x2f7a3a, a: 62, b: 44, exponent: 5 },
      seatLook: {
        colors: [{ c: '#f5c400', w: 0.7 }, { c: '#1f8a3c', w: 0.3 }],
        grain: { along: 3, rows: 2 },
        regions: [
          { tiers: [1], colors: ['#1f8a3c'] },
          { tiers: [2], colors: [{ c: '#1f8a3c', w: 0.8 }, { c: '#f5c400', w: 0.2 }], grain: { along: 3, rows: 2 } },
        ],
      },
      details: {
        ribbons: { color: 0x1f8a3c, tiers: [1, 2] },
        // A screen hung under the roof in two of the corners.
        screens: [
          { centerU: 0.1, widthM: 12, heightM: 6.5, at: [76, 58], hang: { y: 28, ceiling: 35.5 } },
          { centerU: 0.6, widthM: 12, heightM: 6.5, at: [-76, -58], hang: { y: 28, ceiling: 35.5 } },
        ],
      },
      site: { key: 'hocine-ait-ahmed', horizon: 'mountains', ground: 0xa49c80, forecourt: 0xc4bdab, style: 'es' },
    };
  }),

  lazyEntry('miloud-hadefi-40k', { name: 'Stade Miloud Hadefi (Oran)', source: 'builtin', country: 'Africa', capacity: 40143, type: 'Two-tier', inspiredBy: 'Stade Miloud Hadefi, Oran - home of MC Oran', tags: ['mco', 'mc-oran', 'mouloudia-oran', 'oran', 'wahran', 'bir-el-djir', 'miloud-hadefi', 'algeria', 'track', 'ultras', AL] }, () => {
    // Stade Miloud Hadefi, Bir El Djir, Oran — MC Oran's, built for the 2022
    // Mediterranean Games. The tribune officielle, the only stand clad
    // outside, is on the west, -z here. Built into a slope round an athletics
    // track: a lower tier that runs right round, and an upper one in separate
    // straight stands with the corners open between them — the main stand's
    // upper tier the only continuous one — all under a roof of interwoven
    // steel, the "braid", that covers every seat.
    const lower: TierSpec = { rows: 24, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.8, baseOffset: 1.5, seatPitch: 0.5 };
    const upper: TierSpec = {
      rows: 19, rowDepth: 0.85, rakeDeg: 31, baseElevation: 13.5, baseOffset: 24, seatPitch: 0.5,
      omit: [
        { side: 'north', from: -200, to: -62 }, { side: 'north', from: 62, to: 200 },
        { side: 'east', from: -200, to: -36 }, { side: 'east', from: 36, to: 200 },
        { side: 'west', from: -200, to: -36 }, { side: 'west', from: 36, to: 200 },
      ],
    };
    const t = { plan: { a: 93, b: 63, exponent: 2.6 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 13, centred: true });
    const upS = ringStairs(t, upper, { step: 13, centred: true });
    return {
      id: 'miloud-hadefi-40k',
      name: 'Stade Miloud Hadefi (Oran)',
      version: 1,
      levels: 2,
      plan: t.plan,
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.2, aisles: lowS, openings: atStairs(lowS, { width: 2.6, rows: [18, 21], kind: 'vomitory' }, offRhythm(13)) } },
        { ...upper, blocks: { width: 1.2, aisles: upS, openings: atStairs(upS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }) } },
      ],
      aisles: { count: 64, widthMeters: 1.2 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // The steel braid, silver over the whole bowl.
        { style: 'truss', back: 43, front: 0, backY: 28, frontY: 24, depth: 4.5, bay: 7, color: 0xc9ccd0, underColor: 0xe6e8ea, lights: { every: 5, y: 24.3 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      track: { lanes: 8, surface: 0x2f6db3 },
      finish: { concrete: 0xb3afa6, walls: 0xd8d4cb },
      // The steel braid that wraps the bowl, standing clear of it.
      facade: { style: 'lattice', color: 0xe9ebed, accent: 0xc9ccd0 },
      runoff: { color: 0x2f6db3, a: 93, b: 63, exponent: 2.6 },
      seatLook: {
        colors: [{ c: '#d0202e', w: 0.78 }, { c: '#eef0f0', w: 0.22 }],
        grain: { along: 3, rows: 2 },
        regions: [
          { tiers: [1], colors: [{ c: '#d0202e', w: 0.7 }, { c: '#eef0f0', w: 0.3 }], grain: { along: 3, rows: 2 } },
          // The tribune officielle's seats, brown, in the middle of the upper tier.
          { tiers: [1], side: 'south', from: -30, to: 30, colors: ['#7a5236'] },
        ],
      },
      details: {
        // A screen hung under the roof over each open corner on the far side.
        screens: [
          { centerU: 0.103, widthM: 12, heightM: 6.5, at: [86, 64], hang: { y: 17.5, ceiling: 25.5 } },
          { centerU: 0.397, widthM: 12, heightM: 6.5, at: [-86, 64], hang: { y: 17.5, ceiling: 25.5 } },
        ],
      },
      site: { key: 'miloud-hadefi', horizon: 'hills', ground: 0xb5a98a, forecourt: 0xcbc2ae, style: 'es' },
    };
  }),

  lazyEntry('nelson-mandela-41k', { name: 'Stade Nelson Mandela (Baraki)', source: 'builtin', country: 'Africa', capacity: 40784, type: 'Two-tier', inspiredBy: 'Stade Nelson Mandela, Baraki, Algiers - home of CR Belouizdad', tags: ['crb', 'cr-belouizdad', 'chabab', 'belouizdad', 'baraki', 'algiers', 'alger', 'nelson-mandela', 'algeria', 'ultras', AL] }, () => {
    // Stade Nelson Mandela, Baraki, Algiers — CR Belouizdad's home and the
    // Ultras Fanatic Reds'. The main stand is on the south, -z here as well.
    // A football oval of two tiers right round, the corners filled, under
    // one roof carried by two great trusses that span the length of the
    // ground and rest on four pillars behind the goals, a band of open sky
    // between the roof and the last row; its underside bronze. Seats in a
    // grey mosaic, white, silver and charcoal. A screen behind each goal
    // between the red pillars; the floodlights under the roof; outside,
    // white bands of facade and glass.
    // Each truss rises from its pillars behind the goals to its crown over the halfway line: four straight bays.
    const ARCH: [number, number][] = [[-112, 38], [-56, 48], [0, 51], [56, 48], [112, 38]];
    const arch = (z: number) => ARCH.slice(1).map(([x, y], i) => ({ from: [ARCH[i][0], z] as [number, number], to: [x, z] as [number, number], y: ARCH[i][1], yTo: y, height: 7, color: 0xeef0f1 }));
    const lower: TierSpec = { rows: 22, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.6, baseOffset: 2, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 22, rowDepth: 0.85, rakeDeg: 33, baseElevation: 14.5, baseOffset: 24, seatPitch: 0.5 };
    const t = { plan: { a: 63, b: 45, exponent: 4 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    return {
      id: 'nelson-mandela-41k',
      name: 'Stade Nelson Mandela (Baraki)',
      version: 1,
      levels: 2,
      plan: t.plan,
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [15, 17], kind: 'vomitory' }, offRhythm(12)) } },
        { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
      ],
      aisles: { count: 56, widthMeters: 1.1 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // High over the bowl, open sky between it and the back row.
        { style: 'truss', back: 47, front: -2, backY: 38, frontY: 35, depth: 3, bay: 8, color: 0xe8eaec, underColor: 0x6b5644, lights: { every: 5, y: 35.3 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700, masts: { at: [[112, 52]], height: 50, style: 'lattice', head: 'none' } },
      finish: { concrete: 0xa7a59f, walls: 0xdcdad4 },
      facade: { style: 'concrete', color: 0xf2f2f0, accent: 0xdcdcd8, bayMeters: 10 },
      runoff: { color: 0x2f7a3a, a: 62, b: 44, exponent: 4 },
      seatLook: {
        colors: [{ c: '#eceeef', w: 0.35 }, { c: '#a7acb1', w: 0.35 }, { c: '#4b5056', w: 0.3 }],
        grain: { along: 3, rows: 2 },
      },
      details: {
        // The two arched trusses that carry the roof, end to end over the side stands.
        girders: arch(-52).concat(arch(52)),
        // The facade: white bands round the bowl, glazing between them.
        skins: [
          { offset: 44.6, y0: 0, y1: 33, color: 0xf4f4f2, pattern: 'glass', tile: [6, 3.3] },
          ...[[0, 4], [9, 11.5], [16.5, 19], [24, 26.5], [31, 33]].map(([y0, y1]) => ({ offset: 45, y0, y1, color: 0xf2f2ef, pattern: 'solid' as const })),
        ],
        // A screen behind each goal, hung under the roof over the back rows.
        screens: [
          { centerU: 0, widthM: 14, heightM: 7, hang: { offset: 32, y: 30, ceiling: 37 } },
          { centerU: 0.5, widthM: 14, heightM: 7, hang: { offset: 32, y: 30, ceiling: 37 } },
        ],
      },
      site: { key: 'nelson-mandela', horizon: 'city', ground: 0xa99f84, forecourt: 0xc6bfad, style: 'es' },
    };
  }),

  lazyEntry('ali-la-pointe-40k', { name: 'Stade Ali La Pointe (Douéra)', source: 'builtin', country: 'Africa', capacity: 40000, type: 'Two-tier', inspiredBy: 'Stade Ali La Pointe, Douéra, Algiers - home of MC Alger', tags: ['mca', 'mc-alger', 'mouloudia', 'douera', 'algiers', 'alger', 'ali-la-pointe', 'algeria', 'ultras', AL] }, () => {
    // Stade Ali La Pointe, Douéra, Algiers — MC Alger's home since 2024. The
    // main stand, glazed underneath, is on the west, -z here. A football
    // saucer of two tiers, green below and red above in the Mouloudia's
    // colours, under a flat roof over every seat: the upper tier is cut by
    // notches between its sections, and their edges rise past the back row
    // as the columns that carry the roof. A screen hung under the roof near
    // two of the corners.
    const lower: TierSpec = { rows: 22, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.8, baseOffset: 2, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 22, rowDepth: 0.85, rakeDeg: 33, baseElevation: 14.5, baseOffset: 23, seatPitch: 0.5 };
    const t = { plan: { a: 62.5, b: 44.5, exponent: 4.5 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    return {
      id: 'ali-la-pointe-40k',
      name: 'Stade Ali La Pointe (Douéra)',
      version: 1,
      levels: 2,
      plan: t.plan,
      evenRows: true,
      tiers: [
        { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [15, 17], kind: 'vomitory' }, offRhythm(12)) } },
        { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
      ],
      aisles: { count: 56, widthMeters: 1.1 },
      sectionsPerTier: 40,
      roof: { coverage: 'none' },
      roofs: [
        // The flat roof, on the columns that rise from the upper tier's notches.
        { style: 'slab', back: 44, front: 0, backY: 31, frontY: 29.5, depth: 2, bay: 12, color: 0xe2e2df, underColor: 0xc9c9c5, columns: { every: 24, offset: 43, color: 0xd6d4ce }, lights: { every: 5, y: 29.8 } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700 },
      finish: { concrete: 0xb0aca3, walls: 0xd2cec5 },
      facade: { style: 'concrete', color: 0xd6d2c8, accent: 0xe4e0d8, bayMeters: 12 },
      runoff: { color: 0x2f7a3a, a: 61.5, b: 43.5, exponent: 4.5 },
      seatLook: {
        colors: ['#178a41'],
        regions: [{ tiers: [1], colors: ['#c8202c'] }],
      },
      details: {
        ribbons: { color: 0xc8202c, tiers: [1] },
        // A screen hung under the roof near two of the corners.
        screens: [
          { centerU: 0.1, widthM: 12, heightM: 6.5, at: [74, 56], hang: { y: 24.5, ceiling: 29.5 } },
          { centerU: 0.6, widthM: 12, heightM: 6.5, at: [-74, -56], hang: { y: 24.5, ceiling: 29.5 } },
        ],
      },
      site: { key: 'ali-la-pointe', horizon: 'hills', ground: 0xa99f84, forecourt: 0xc6bfad, style: 'es' },
    };
  }),
];
