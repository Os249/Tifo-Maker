/**
 * Morocco: four Botola Pro grounds, 2026-27, the homes of the country's
 * famous curvas — Wydad's Winners and Raja's Green Boys and Eagles at the
 * Mohammed V, AS FAR's Ultras Askary in Rabat's new South Kop, Tangier's
 * Ultras Hercules and Fès's Fatal Tigers — as they stand after the rebuilds
 * for AFCON 2025.
 *
 * Built the same way as the European grounds (see ligue1.ts): the
 * OpenStreetMap footprint (© OpenStreetMap contributors, ODbL), Esri
 * satellite pictures and photographs, the official capacity, and the real
 * blocks from the start. The engine's frame: the main stand (tribune
 * d'honneur) south (-z), the ends east (+x, on your right as you face the
 * main stand from the pitch) and west (-x).
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { TierSpec } from './types';
import { ringStairs, atStairs } from './realBlocks';

const BP = 'botola';

/**
 * Skip for atStairs: a vomitory only at every other stairway of the regular
 * rhythm, not at the stairs ringStairs adds round a corner (two of those
 * close together would take every seat of the narrow block between them out
 * of the vomitory's rows).
 */
const offRhythm = (step: number) => (_s: string, at: number): boolean => Math.abs(at - step * Math.round(at / step)) > 0.3 || Math.round(at / step) % 2 === 1;

export const BOTOLA: StadiumEntry[] = [
  (() => {
    // Stade Mohammed V ("Donor"), Maârif, Casablanca: the derby. The tribune
    // d'honneur is on the west side (-z here), under its cantilever canopy of
    // white radial ribs; the Virage Nord ("Frimija", the Winners') is +x
    // here, the Virage Sud ("Magana", the Green Boys' and Eagles', under the
    // scoreboard) -x. An oval of two tiers round the athletics track, kept and
    // resurfaced in blue in the 2024-25 rebuild (reopened April 2025), with
    // floodlights on four masts. Blue seats with CASABLANCA in white across
    // the lower tier opposite the main stand.
    const lower: TierSpec = { rows: 32, rowDepth: 0.9, rakeDeg: 24, baseElevation: 1.2, baseOffset: 1, seatPitch: 0.55 };
    const upper: TierSpec = { rows: 16, rowDepth: 0.95, rakeDeg: 30, baseElevation: 16, baseOffset: 33, seatPitch: 0.55 };
    const t = { plan: { a: 92, b: 48, exponent: 2.4 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 13, centred: true });
    const upS = ringStairs(t, upper, { step: 13, centred: true });
    return {
      id: 'mohammed-v-45k',
      template: {
        id: 'mohammed-v-45k',
        name: 'Stade Mohammed V (Casablanca)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.2, aisles: lowS, openings: atStairs(lowS, { width: 2.6, rows: [26, 29], kind: 'vomitory' }, (_s, at) => Math.round(at / 13) % 2 === 1) } },
          { ...upper, blocks: { width: 1.2, aisles: upS, openings: atStairs(upS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 60, widthMeters: 1.2 },
        sectionsPerTier: 40,
        roof: { coverage: 'none' },
        roofs: [
          // The main stand's canopy on its white radial ribs.
          { style: 'sheet', side: 'south', from: -95, to: 95, back: 58, front: 12, backY: 30, frontY: 27, depth: 1.6, bay: 9, color: 0xf1f2f0, underColor: 0xd9dcdb, columns: { every: 9, color: 0xf3f3f1, shape: 'raking', offset: 56 } },
        ],
        track: { lanes: 8, surface: 0x2d63b8 },
        lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[128, 88]], height: 48, style: 'pole', head: 'rect' } },
        finish: { concrete: 0xb9b6ae, walls: 0xd2cec4 },
        facade: { style: 'concrete', color: 0xd8d3c7, accent: 0xe6e2d8, bayMeters: 9 },
        runoff: { color: 0x2d63b8, a: 92, b: 48, exponent: 2.4 },
        seatLook: {
          colors: [{ c: '#1f4fa6', w: 0.6 }, { c: '#3a87d6', w: 0.4 }],
          grain: { along: 3, rows: 2 },
          text: [{ text: 'CASABLANCA', color: '#f4f6f8', tier: 0, centerU: 0.25, halfU: 0.1, rows: [8, 28] }],
        },
        details: {
          // The scoreboard over the Virage Sud ("Magana", after its clock).
          screens: [{ centerU: 0.5, widthM: 14, heightM: 7 }],
        },
        site: { key: 'mohammed-v', horizon: 'city', ground: 0xc4b99f, forecourt: 0xd2cabb },
      },
      meta: { name: 'Stade Mohammed V (Casablanca)', source: 'builtin', country: 'Africa', capacity: 45891, type: 'Oval', inspiredBy: 'Stade Mohammed V (Complexe sportif Mohammed V), Casablanca - home of Wydad AC and Raja CA', tags: ['wydad', 'raja', 'casablanca', 'mohammed-v', 'donor', 'winners', 'green-boys', 'morocco', 'track', 'ultras', BP] },
    };
  })(),

  (() => {
    // Stade Prince Moulay Abdellah, Rabat, rebuilt 2023-25 (Populous with
    // Orange Atelier; opened September 2025, the AFCON 2025 final). The West
    // stand (main: royal box, VVIP) is -z here; the East, three tiers of
    // lounges and boxes, opposite; the north end +x, and the South Kop -x —
    // 23,000 seats in two tiers for AS FAR's Ultras Askary and Black Army,
    // the upper reserved for them. A football bowl with no track, its front
    // rows close to the pitch, a ring of boxes between the tiers, under a full
    // roof whose shell is also the façade: 19,200 champagne aluminium
    // triangles, lit as a screen at night. Red seats, dark maroon round the
    // main stand's middle.
    const lower: TierSpec = { rows: 32, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 34, rowDepth: 0.85, rakeDeg: 34, baseElevation: 18, baseOffset: 30, seatPitch: 0.5 };
    // The South Kop's upper tier runs on up behind the ring's.
    const kop: TierSpec = {
      rows: 26, rowDepth: 0.85, rakeDeg: 34, baseElevation: 38, baseOffset: 60, seatPitch: 0.5,
      stands: [{ side: 'west', halfLength: 46 }],
    };
    const t = { plan: { a: 61.5, b: 41, exponent: 7 }, tiers: [lower, upper, kop] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    const kopS = ringStairs(t, kop, { step: 12, centred: true, sides: ['west'] });
    return {
      id: 'moulay-abdellah-69k',
      template: {
        id: 'moulay-abdellah-69k',
        name: 'Prince Moulay Abdellah (Rabat)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.2, aisles: lowS, openings: atStairs(lowS, { width: 2.6, rows: [24, 27], kind: 'vomitory' }, offRhythm(12)) } },
          { ...upper, blocks: { width: 1.2, aisles: upS, openings: atStairs(upS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }) } },
          { ...kop, blocks: { width: 1.2, aisles: kopS } },
        ],
        aisles: { count: 60, widthMeters: 1.2 },
        sectionsPerTier: 40,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'truss', back: 88, front: 10, backY: 58, frontY: 44, depth: 3.5, bay: 8, color: 0xefeee9, underColor: 0x46494e, lights: { every: 5, y: 44.5 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9d9a94, walls: 0xb9b5ac },
        facade: { style: 'plain', color: 0xc6b38c },
        runoff: { color: 0x2f7a3a, a: 60.5, b: 40, exponent: 7 },
        seatLook: {
          colors: ['#c8142a'],
          regions: [{ tiers: [0], side: 'south', from: -30, to: 30, colors: ['#5a1420'] }],
        },
        details: {
          ribbons: { color: 0xc8142a, tiers: [1] },
          // The champagne aluminium shell, lit at night.
          skins: [{ offset: 86, y0: 0, y1: 52, color: 0xc9b58b, pattern: 'perforated', tile: [5, 5], glow: 0.35 }],
          screens: [
            { centerU: 0.1, widthM: 12, heightM: 6.5, at: [66, 47], hang: { y: 33, ceiling: 44 } },
            { centerU: 0.6, widthM: 12, heightM: 6.5, at: [-66, -47], hang: { y: 33, ceiling: 44 } },
          ],
        },
        site: { key: 'moulay-abdellah', horizon: 'city', ground: 0xb7a98a, forecourt: 0xcdc3b0 },
      },
      meta: { name: 'Prince Moulay Abdellah (Rabat)', source: 'builtin', country: 'Africa', capacity: 68700, type: 'Two-tier', inspiredBy: 'Stade Prince Moulay Abdellah, Rabat - home of AS FAR and the Morocco national team', tags: ['as-far', 'far-rabat', 'rabat', 'moulay-abdellah', 'ultras-askary', 'black-army', 'morocco', 'afcon-2025', 'world-cup-2030', 'ultras', BP] },
    };
  })(),

  (() => {
    // Grand Stade de Tanger (Stade Ibn Batouta), rebuilt 2023-25 for AFCON
    // and reopened in November 2025. The tribune d'honneur is on the west
    // side (-z here), the north end (visitors) +x, the south end — Ultras
    // Hercules' — -x. The track is gone and the pitch lowered: a new lower
    // ring close to the pitch, then the middle and upper tiers of the old
    // athletics oval, well back behind the goals, three levels of boxes in
    // the main stand. Every seat under a white membrane on a spoke-wheel cable
    // roof (370 x 250 m, the opening 136 x 93 m), a 220 m² screen hung over
    // each end. Seats in blue, grey and white.
    const lower: TierSpec = { rows: 24, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const middle: TierSpec = { rows: 24, rowDepth: 0.85, rakeDeg: 28, baseElevation: 10.5, baseOffset: 24, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 24, rowDepth: 0.85, rakeDeg: 33, baseElevation: 23, baseOffset: 48, seatPitch: 0.5 };
    const t = { plan: { a: 66, b: 44, exponent: 4 }, tiers: [lower, middle, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12.5, centred: true });
    const midS = ringStairs(t, middle, { step: 12.5, centred: true });
    const upS = ringStairs(t, upper, { step: 12.5, centred: true });
    return {
      id: 'grand-stade-tanger-75k',
      template: {
        id: 'grand-stade-tanger-75k',
        name: 'Grand Stade de Tanger (Tangier)',
        version: 1,
        levels: 3,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.2, aisles: lowS } },
          { ...middle, blocks: { width: 1.2, aisles: midS, openings: atStairs(midS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }, offRhythm(12.5)) } },
          { ...upper, blocks: { width: 1.2, aisles: upS, openings: atStairs(upS, { width: 2.6, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 64, widthMeters: 1.2 },
        sectionsPerTier: 44,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'membrane', back: 92, front: 2, backY: 50, frontY: 41, depth: 2.6, bay: 10, color: 0xf6f6f3, underColor: 0xeeeeea, lights: { every: 5, y: 41.3 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0xb8b5ad, walls: 0xd6d2c8 },
        facade: { style: 'concrete', color: 0xe4e0d6, accent: 0xf0ede6, bayMeters: 14 },
        runoff: { color: 0x2f7a3a, a: 65, b: 43, exponent: 4 },
        seatLook: {
          colors: [{ c: '#2b5aa6', w: 0.45 }, { c: '#9aa5b0', w: 0.3 }, { c: '#f1f2f3', w: 0.25 }],
          grain: { along: 3, rows: 2 },
        },
        details: {
          ribbons: { color: 0x2b5aa6, tiers: [1, 2] },
          // The new white skin round the bowl, up to the roof's edge.
          skins: [{ offset: 89.5, y0: 0, y1: 49, color: 0xeceae4, pattern: 'panels', tile: [6, 5] }],
          // The two 220 m² screens, one hung over each end.
          screens: [
            { centerU: 0, widthM: 20, heightM: 11, hang: { offset: 30, y: 35, ceiling: 44 } },
            { centerU: 0.5, widthM: 20, heightM: 11, hang: { offset: 30, y: 35, ceiling: 44 } },
          ],
        },
        site: { key: 'tanger', horizon: 'hills', ground: 0xc9bfa6, forecourt: 0xdcd5c6 },
      },
      meta: { name: 'Grand Stade de Tanger (Tangier)', source: 'builtin', country: 'Africa', capacity: 75500, type: 'Bowl', inspiredBy: 'Grand Stade de Tanger (Stade Ibn Batouta), Tangier - home of Ittihad Riadi Tanger', tags: ['irt', 'ittihad-tanger', 'tanger', 'tangier', 'ibn-batouta', 'ultras-hercules', 'morocco', 'afcon-2025', 'world-cup-2030', 'ultras', BP] },
    };
  })(),

  (() => {
    // Complexe Sportif de Fès (Grand Stade de Fès), Route de Sefrou. The
    // tribune d'honneur is on the west side (-z here), under its folded roof
    // and behind its glass façade; the north end +x, the south -x. One oval
    // tier of seats round an eight-lane athletics track, cut by the radial
    // walls of its entrances, refitted in 2024-25 (35,468 seats, 92 boxes).
    // Terracotta seats with FES picked out in pale grey across the stand
    // opposite the main stand; the Fatal Tigers in the home end.
    const bowl: TierSpec = { rows: 36, rowDepth: 0.8, rakeDeg: 24, baseElevation: 1.4, baseOffset: 1, seatPitch: 0.5 };
    const t = { plan: { a: 94, b: 50, exponent: 2.6 }, tiers: [bowl] } as Parameters<typeof ringStairs>[0];
    const st = ringStairs(t, bowl, { step: 13, centred: true });
    return {
      id: 'fes-stadium-35k',
      template: {
        id: 'fes-stadium-35k',
        name: 'Complexe Sportif de Fès (Fès)',
        version: 1,
        levels: 1,
        plan: t.plan,
        evenRows: true,
        tiers: [
          {
            ...bowl,
            blocks: {
              width: 1.2, aisles: st,
              // The entrances come up through the back of the stand between the radial walls.
              openings: atStairs(st, { width: 2.8, rows: [29, 35], kind: 'vomitory' }, offRhythm(13)),
            },
          },
        ],
        aisles: { count: 56, widthMeters: 1.2 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          // The main stand's folded roof on its fan of steel ribs.
          { style: 'sheet', side: 'south', from: -82, to: 82, back: 46, front: 8, backY: 25, frontY: 20, depth: 1.6, bay: 7, color: 0xcfd3d5, underColor: 0x7b8086, columns: { every: 14, color: 0xe6e8e9, shape: 'raking', offset: 44 } },
        ],
        track: { lanes: 8, surface: 0x5f7fa3 },
        lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[122, 82]], height: 45, style: 'pole', head: 'rect' } },
        finish: { concrete: 0xc8bba4, walls: 0xd9cdb6 },
        facade: { style: 'concrete', color: 0xddd1ba, accent: 0xe9e0cf, bayMeters: 12 },
        runoff: { color: 0x5f7fa3, a: 94, b: 50, exponent: 2.6 },
        seatLook: {
          colors: [{ c: '#cf5a40', w: 0.8 }, { c: '#e0806a', w: 0.2 }],
          grain: { along: 3, rows: 2 },
          text: [{ text: 'FES', color: '#cfd1d3', tier: 0, centerU: 0.25, halfU: 0.05, rows: [6, 30] }],
        },
        details: {
          screens: [
            { centerU: 0, widthM: 12, heightM: 6 },
            { centerU: 0.5, widthM: 12, heightM: 6 },
          ],
        },
        site: { key: 'fes', horizon: 'hills', ground: 0xcdbb98, forecourt: 0xdcd0b8 },
      },
      meta: { name: 'Complexe Sportif de Fès (Fès)', source: 'builtin', country: 'Africa', capacity: 35468, type: 'Oval', inspiredBy: 'Complexe Sportif de Fès, Fès - home of Maghreb de Fès', tags: ['mas', 'maghreb-de-fes', 'fes', 'fez', 'fatal-tigers', 'morocco', 'track', 'afcon-2025', 'ultras', BP] },
    };
  })(),
];
