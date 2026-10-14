/**
 * Turkey: five Süper Lig grounds, 2026-27, picked for their crowds and their
 * supporters' groups — Galatasaray's ultrAslan, Fenerbahçe's GFB, Beşiktaş's
 * Çarşı, Trabzonspor's and Göztepe's GözGöz, the league's fullest ground.
 *
 * Built the same way as the French grounds (see ligue1.ts): the
 * OpenStreetMap footprint (© OpenStreetMap contributors, ODbL), Esri
 * satellite pictures and photographs, the capacity the club publishes, and
 * the real blocks from the start — with the block numbers the clubs' ticket
 * maps publish where they do. The engine's frame: the main stand south
 * (-z), the ends east (+x, on your right as you face the main stand from the
 * pitch) and west (-x).
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { TierSpec } from './types';
import { ringStairs, atStairs } from './realBlocks';

const SL = 'super-lig';

export const SUPER_LIG: StadiumEntry[] = [
  (() => {
    // RAMS Park (Ali Sami Yen Spor Kompleksi), Seyrantepe, Istanbul. The Batı
    // (west, main) stand is -z here, the Doğu (east) opposite, the Kuzey
    // (north) end +x — ultrAslan's — and the Güney (south) -x, the away fans
    // in its upper corner. One steep, continuous bowl: a lower tier of 37
    // rows, the suites' balconies, and an upper tier of 20-27, under a roof
    // of solar panels on great triangular trusses with an opening over the
    // pitch. Crimson seats with GALATASARAY in yellow along the lower tier
    // opposite the main stand; since 2025-26 a 240 m² screen over each end.
    const lower: TierSpec = { rows: 37, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 21, rowDepth: 0.85, rakeDeg: 35, baseElevation: 19, baseOffset: 34, seatPitch: 0.5 };
    const t = { plan: { a: 59.5, b: 41, exponent: 9 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12.5, centred: true });
    const upS = ringStairs(t, upper, { step: 12.5, centred: true });
    return {
      id: 'rams-park-53k',
      template: {
        id: 'rams-park-53k',
        name: 'RAMS Park (Istanbul)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          {
            ...lower,
            blocks: {
              width: 1.1, aisles: lowS,
              // A walkway half way up, the vomitories coming up onto it.
              walkways: [{ row: 18 }],
              openings: atStairs(lowS, { width: 2.4, rows: [19, 21], kind: 'vomitory' }, (_s, at) => Math.round(at / 12.5) % 2 === 1),
            },
          },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 56, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'truss', back: 66, front: 4, backY: 41, frontY: 37, depth: 4, bay: 8, color: 0x3a3f47, underColor: 0xd3d6d9, lights: { every: 5, y: 37.5 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x8f8f8c, walls: 0xa7a6a2 },
        facade: { style: 'concrete', color: 0xb8b6b0, accent: 0xe9e9e6, bayMeters: 10 },
        runoff: { color: 0x2f7a3a, a: 58.5, b: 40, exponent: 9 },
        seatLook: {
          colors: ['#b3162e'],
          text: [{ text: 'GALATASARAY', color: '#f4b40a', tier: 0, centerU: 0.25, halfU: 0.105, rows: [4, 16] }],
        },
        details: {
          ribbons: { color: 0xd8a210, tiers: [1] },
          // The outer wall, clad up to the roof's edge.
          skins: [{ offset: 63.5, y0: 0, y1: 40, color: 0xcfd1d3, pattern: 'panels', tile: [6, 4] }],
          // The two 240 m² screens over the ends, under the roof.
          screens: [
            { centerU: 0, widthM: 22, heightM: 9, hang: { offset: 26, y: 29, ceiling: 38 } },
            { centerU: 0.5, widthM: 22, heightM: 9, hang: { offset: 26, y: 29, ceiling: 38 } },
          ],
        },
        site: { key: 'rams-park', horizon: 'city-towers', ground: 0x9c9a8c, forecourt: 0xb9b6ad, style: 'es' },
      },
      meta: { name: 'RAMS Park (Istanbul)', source: 'builtin', country: 'Europe', capacity: 53387, type: 'Two-tier', inspiredBy: 'RAMS Park (Ali Sami Yen Spor Kompleksi), Seyrantepe, Istanbul - home of Galatasaray', tags: ['galatasaray', 'gs', 'cimbom', 'rams-park', 'ali-sami-yen', 'seyrantepe', 'turk-telekom', 'istanbul', 'turkey', 'ultras', SL] },
    };
  })(),

  (() => {
    // Chobani Stadyumu Fenerbahçe Şükrü Saracoğlu, Kadıköy, Istanbul. The
    // Fenerium (west, main) stand is -z here, ATATÜRK on its roof; the
    // Maraton (east) opposite, MUSTAFA KEMAL on its roof; the Kuzey (north)
    // end +x, the away end; the Güney — Okul Açık, the GFB's end — -x. Four
    // steep two-tier stands joined by small corners that carry the trusses of
    // the membrane roof. Cream lower tiers along the sides, yellow upper ones
    // with FENERBAHÇE in navy across the Maraton, navy ends.
    const lower: TierSpec = { rows: 23, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.47 };
    const upper: TierSpec = { rows: 25, rowDepth: 0.85, rakeDeg: 35, baseElevation: 14.5, baseOffset: 24, seatPitch: 0.47 };
    const t = { plan: { a: 60, b: 40.5, exponent: 10 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 11.5, centred: true });
    const upS = ringStairs(t, upper, { step: 11.5, centred: true });
    const sides = (side: 'north' | 'south', tier: number, colors: string[]) => ({ tiers: [tier], side, from: -64, to: 64, colors });
    return {
      id: 'sukru-saracoglu-47k',
      template: {
        id: 'sukru-saracoglu-47k',
        name: 'Şükrü Saracoğlu (Istanbul)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 52, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          // A membrane on steel trusses from the corners, white on top and tan beneath.
          { style: 'membrane', back: 50, front: 2, backY: 35, frontY: 31, depth: 2.5, bay: 9, color: 0xf3f1ec, underColor: 0xc9a970, lights: { every: 5, y: 31.3 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9a9894, walls: 0xb4b1aa },
        facade: { style: 'cladding', color: 0xdfe3e6, accent: 0x1d2a5c },
        runoff: { color: 0x2f7a3a, a: 59, b: 39.5, exponent: 10 },
        seatLook: {
          colors: ['#1d2a5c'],
          regions: [
            sides('south', 0, ['#e7dcc0']), sides('north', 0, ['#e7dcc0']),
            sides('south', 1, ['#f3c20b']), sides('north', 1, ['#f3c20b']),
          ],
          text: [{ text: 'FENERBAHÇE', color: '#1d2a5c', tier: 1, centerU: 0.25, halfU: 0.1, rows: [4, 15] }],
        },
        details: {
          ribbons: { color: 0xf3c20b, tiers: [1] },
          // A screen hung from the truss in two of the corners.
          screens: [
            { centerU: 0.1, widthM: 9, heightM: 5, at: [64, 47], hang: { y: 25, ceiling: 32 } },
            { centerU: 0.6, widthM: 9, heightM: 5, at: [-64, -47], hang: { y: 25, ceiling: 32 } },
          ],
        },
        site: { key: 'sukru-saracoglu', horizon: 'city', ground: 0x9c9a8c, forecourt: 0xb6b2a8, style: 'es' },
      },
      meta: { name: 'Şükrü Saracoğlu (Istanbul)', source: 'builtin', country: 'Europe', capacity: 47430, type: 'Two-tier', inspiredBy: 'Chobani Stadyumu Fenerbahçe Şükrü Saracoğlu, Kadıköy, Istanbul - home of Fenerbahçe', tags: ['fenerbahce', 'fb', 'sukru-saracoglu', 'saracoglu', 'chobani', 'kadikoy', 'okul-acik', 'istanbul', 'turkey', 'ultras', SL] },
    };
  })(),

  (() => {
    // Tüpraş Stadyumu, Beşiktaş, Istanbul (Vodafone Park until 2023), on the
    // site of the İnönü below Dolmabahçe. The West (main) stand is -z here, the
    // East — Kapalı, Çarşı's stand — opposite; the north end +x, the biggest,
    // with no boxes; the south end -x, lower, looking out over the Bosphorus.
    // One oval bowl of two tiers, 6 m from the touchline and 8 m from the
    // goal lines: a shallow lower tier (23°) and a very steep upper one (39°)
    // whose back rises and falls, lowest in the corners, under a white PTFE
    // roof on a ring of 84 columns. Black and white seats in a mosaic.
    const lower: TierSpec = { rows: 22, rowDepth: 0.8, rakeDeg: 23, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.48 };
    const upper: TierSpec = {
      rows: 30, rowDepth: 0.85, rakeDeg: 38, baseElevation: 13, baseOffset: 22.5, seatPitch: 0.48,
      // Its back rows only along the middle of each stand: lowest in the
      // corners, and lower at the south end, which looks over the Bosphorus.
      omit: [
        { side: 'north', from: -200, to: -46, fromRow: 22 }, { side: 'north', from: 46, to: 200, fromRow: 22 },
        { side: 'south', from: -200, to: -46, fromRow: 22 }, { side: 'south', from: 46, to: 200, fromRow: 22 },
        { side: 'east', from: -200, to: -26, fromRow: 22 }, { side: 'east', from: 26, to: 200, fromRow: 22 },
        { side: 'west', from: -200, to: 200, fromRow: 20 },
      ],
    };
    const t = { plan: { a: 60.5, b: 40.5, exponent: 7 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 11, centred: true });
    const upS = ringStairs(t, upper, { step: 11, centred: true });
    return {
      id: 'tupras-stadyumu-42k',
      template: {
        id: 'tupras-stadyumu-42k',
        name: 'Tüpraş Stadyumu (Istanbul)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 52, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'membrane', back: 58, front: 0, backY: 40, frontY: 36.5, depth: 2.4, bay: 7, color: 0xf4f4f2, underColor: 0xe7e7e4, lights: { every: 5, y: 36.8 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x8f8f8e, walls: 0xa5a5a3 },
        // The limestone colonnade round the outside.
        facade: { style: 'concrete', color: 0xd9d2c3, accent: 0xe8e2d6, bayMeters: 6 },
        runoff: { color: 0x2f7a3a, a: 59.5, b: 39.5, exponent: 7 },
        seatLook: {
          colors: [{ c: '#18181a', w: 0.62 }, { c: '#f1f1f1', w: 0.38 }],
          grain: { along: 2.5, rows: 2 },
        },
        details: {
          ribbons: { color: 0xf2f2f2, tiers: [1] },
          // The outer wall up to the roof's edge.
          skins: [{ offset: 56, y0: 0, y1: 39.5, color: 0xc9c4b8, pattern: 'slats', tile: [3, 4] }],
          screens: [
            { centerU: 0.1, widthM: 9, heightM: 5, at: [63, 45], hang: { y: 27, ceiling: 37 } },
            { centerU: 0.6, widthM: 9, heightM: 5, at: [-63, -45], hang: { y: 27, ceiling: 37 } },
          ],
        },
        site: { key: 'tupras', horizon: 'city', ground: 0x9a9888, forecourt: 0xb9b5aa, style: 'es' },
      },
      meta: { name: 'Tüpraş Stadyumu (Istanbul)', source: 'builtin', country: 'Europe', capacity: 42684, type: 'Two-tier', inspiredBy: 'Tüpraş Stadyumu (Beşiktaş Stadium), Istanbul - home of Beşiktaş', tags: ['besiktas', 'bjk', 'kartal', 'tupras', 'vodafone-park', 'inonu', 'dolmabahce', 'carsi', 'istanbul', 'turkey', 'ultras', SL] },
    };
  })(),

  (() => {
    // Papara Park (Şenol Güneş Spor Kompleksi), Akyazı, Trabzon, on land
    // reclaimed from the Black Sea. The West (main) stand is -z here, with
    // the hospitality and the VIP entrance; the East opposite; the north end
    // +x, the south -x. Two tiers all round with the boxes between, 8.5 m
    // from the touchline and 10 m behind the goals, under a roof of 245
    // white triangular membrane panels whose points zigzag along the top.
    // Sky blue below with TRABZONSPOR across the East stand, claret above.
    const lower: TierSpec = { rows: 22, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 23, rowDepth: 0.85, rakeDeg: 34, baseElevation: 13.5, baseOffset: 22.5, seatPitch: 0.5 };
    const t = { plan: { a: 62.5, b: 42.5, exponent: 9 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    return {
      id: 'papara-park-41k',
      template: {
        id: 'papara-park-41k',
        name: 'Papara Park (Trabzon)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 52, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'membrane', back: 58, front: 2, backY: 36, frontY: 31, depth: 3, bay: 14, color: 0xf3f3f0, underColor: 0xe2e3e2, lights: { every: 5, y: 31.3 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9a9b9c, walls: 0xb8b9ba },
        facade: { style: 'membrane', color: 0xf0f0ed },
        runoff: { color: 0x2f7a3a, a: 61.5, b: 41.5, exponent: 9 },
        seatLook: {
          colors: ['#3f8fd2'],
          regions: [{ tiers: [1], colors: [{ c: '#7a1a2d', w: 0.88 }, { c: '#3f8fd2', w: 0.12 }], grain: { along: 3, rows: 2 } }],
          text: [{ text: 'TRABZONSPOR', color: '#f2f4f6', tier: 0, centerU: 0.25, halfU: 0.1, rows: [4, 16] }],
        },
        details: {
          ribbons: { color: 0x7a1a2d, tiers: [1] },
          // The white skin round the outside, up to the roof's edge.
          skins: [{ offset: 56, y0: 0, y1: 35.5, color: 0xeeeeeb, pattern: 'panels', tile: [6, 4] }],
          screens: [
            { centerU: 0.1, widthM: 10, heightM: 5.5, at: [66, 48], hang: { y: 27, ceiling: 33 } },
            { centerU: 0.6, widthM: 10, heightM: 5.5, at: [-66, -48], hang: { y: 27, ceiling: 33 } },
          ],
        },
        site: { key: 'papara-park', horizon: 'mountains', ground: 0xa29e8e, forecourt: 0xbab6aa, style: 'es' },
      },
      meta: { name: 'Papara Park (Trabzon)', source: 'builtin', country: 'Europe', capacity: 41061, type: 'Two-tier', inspiredBy: 'Papara Park (Şenol Güneş Spor Kompleksi), Trabzon - home of Trabzonspor', tags: ['trabzonspor', 'trabzon', 'papara-park', 'senol-gunes', 'akyazi', 'medical-park', 'black-sea', 'turkey', 'ultras', SL] },
    };
  })(),

  (() => {
    // Isonem Park Gürsel Aksel, Üçkuyular, İzmir. The West (main) stand is -z
    // here, with the glazed VIP floors; the East opposite; the north end +x,
    // the south -x, the club's offices raised over the plaza behind it. One
    // compact tier, a box with its corners filled, up to 28 rows from the
    // front walkway (fewer in the main stand), the pitch 6.7 m above the
    // street, under a roof of steel lattice whose top is a public walkway
    // with grass along it. Red seats, yellow along the front of the ends; the
    // league's fullest ground (GözGöz).
    const bowl: TierSpec = {
      rows: 30, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.48,
      stands: [
        { side: 'south', halfLength: 200, rows: 24 },
        { side: 'north', halfLength: 200 },
        { side: 'east', halfLength: 200 },
        { side: 'west', halfLength: 200 },
      ],
    };
    const t = { plan: { a: 57, b: 41, exponent: 14 }, tiers: [bowl] } as Parameters<typeof ringStairs>[0];
    const st = ringStairs(t, bowl, { step: 11, centred: true });
    return {
      id: 'gursel-aksel-23k',
      template: {
        id: 'gursel-aksel-23k',
        name: 'Gürsel Aksel (İzmir)',
        version: 1,
        levels: 1,
        plan: t.plan,
        evenRows: true,
        tiers: [
          {
            ...bowl,
            blocks: {
              width: 1.1, aisles: st,
              openings: atStairs(st, { width: 2.4, rows: [12, 14], kind: 'vomitory' }, (_s, at) => Math.round(at / 11) % 2 === 1),
            },
          },
        ],
        aisles: { count: 40, widthMeters: 1.1 },
        sectionsPerTier: 30,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'truss', back: 36, front: 1, backY: 25, frontY: 22.5, depth: 2.5, bay: 6, color: 0x5f8d4e, underColor: 0x3a3e44, glazing: 0.35, lights: { every: 5, y: 22.8 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9b9a98, walls: 0xb6b4b0 },
        // The rhythm of vertical blinds round the outside.
        facade: { style: 'cladding', color: 0xd8dadb, accent: 0xb9bcbe, bayMeters: 2.5 },
        runoff: { color: 0x2f7a3a, a: 56, b: 40, exponent: 14 },
        seatLook: {
          colors: ['#d01f2c'],
          regions: [
            { side: 'east', rows: [0, 6], colors: ['#f2c40d'] },
            { side: 'west', rows: [0, 6], colors: ['#f2c40d'] },
          ],
          text: [{ text: 'GÖZTEPE', color: '#f2c40d', tier: 0, centerU: 0.25, halfU: 0.075, rows: [10, 24] }],
        },
        details: {
          // The vertical blinds round the outside, up to the roof.
          skins: [{ offset: 34, y0: 0, y1: 24.5, color: 0xd8dadb, pattern: 'slats', tile: [2.5, 4] }],
          screens: [
            { centerU: 0, widthM: 10, heightM: 5.5, hang: { offset: 6, y: 17, ceiling: 22.5 } },
            { centerU: 0.5, widthM: 10, heightM: 5.5, hang: { offset: 6, y: 17, ceiling: 22.5 } },
          ],
        },
        site: { key: 'gursel-aksel', horizon: 'hills', ground: 0xa49f8c, forecourt: 0xbcb7aa, style: 'es' },
      },
      meta: { name: 'Gürsel Aksel (İzmir)', source: 'builtin', country: 'Europe', capacity: 23376, type: 'Single-tier', inspiredBy: 'Isonem Park Gürsel Aksel Stadyumu, İzmir - home of Göztepe', tags: ['goztepe', 'gursel-aksel', 'isonem-park', 'izmir', 'uckuyular', 'gozgoz', 'turkey', 'ultras', SL] },
    };
  })(),
];
