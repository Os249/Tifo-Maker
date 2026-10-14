/**
 * France: six Ligue 1 grounds, 2026-27, picked for their ultras and their
 * noise — the Vélodrome's two virages, the Parc's Auteuil, Lens's Kop Marek,
 * Lyon's Virage Nord, Lille's DVE and Rennes's Roazhon Celtic Kop.
 *
 * Each is built from the ground's OpenStreetMap footprint (pitch, stands and
 * their heights, © OpenStreetMap contributors, ODbL), Esri satellite pictures
 * and recent photographs, with the capacity the club publishes, and laid out
 * in its real blocks from the start (TierSpec.blocks): the stairways, the
 * walkways and vomitories the photographs show, and the block names where the
 * club's ticketing publishes them.
 *
 * The frame is the engine's: the main stand (tunnel, dugouts, press) is south
 * (-z), the stand opposite north, the ends east (+x) and west (-x) — east
 * being the end on your right as you face the main stand from the pitch.
 * Which real compass side each one is on is in the comment above it.
 *
 * Seat maps are frozen once released (scripts/verify.mts): a change to a
 * ground's seats after that needs a new id.
 */

import type { StadiumEntry } from './stadiumCatalog';
import type { TierSpec } from './types';
import { ringStairs, atStairs } from './realBlocks';

const L1 = 'ligue-1';

/** A tier's stairs from ringStairs, kept to the stands it has. */
function stairs(t: Parameters<typeof ringStairs>[0], tier: TierSpec, o: Parameters<typeof ringStairs>[2]): ReturnType<typeof ringStairs> {
  const sides = new Set((tier.stands ?? []).map((s) => s.side));
  return ringStairs(t, tier, o).filter((r) => !tier.stands || sides.has(r.side));
}

export const LIGUE_1: StadiumEntry[] = [
  (() => {
    // The CEPAC Vélodrome, Marseille (Orange Vélodrome until July 2026).
    // The Jean-Bouin (main) stand is on the west side (-z here), the Ganay
    // opposite (east), the Virage Nord (Patrice de Peretti) north (+x here)
    // and the Virage Sud (Chevalier Roze) south (-x). Four separate stands
    // under one white membrane roof, their corners open, rebuilt 2011-14:
    // the sides in three tiers with boxes between, the virages in two. The
    // OpenStreetMap footprints put the side stands' front 5 m off the
    // touchline and the virages' 11.5 m behind the goal line.
    const lower: TierSpec = {
      rows: 38, rowDepth: 0.8, rakeDeg: 25, baseElevation: 0.8, baseOffset: 0.5, seatPitch: 0.5,
      stands: [
        { side: 'south', halfLength: 68, rows: 26 },
        { side: 'north', halfLength: 68, rows: 28 },
        { side: 'east', halfLength: 60 },
        { side: 'west', halfLength: 60 },
      ],
    };
    const middle: TierSpec = {
      rows: 20, rowDepth: 0.85, rakeDeg: 30, baseElevation: 13, baseOffset: 27, seatPitch: 0.5,
      stands: [{ side: 'south', halfLength: 72, rows: 16 }, { side: 'north', halfLength: 74 }],
    };
    const upper: TierSpec = {
      rows: 34, rowDepth: 0.85, rakeDeg: 35, baseElevation: 26.5, baseOffset: 44, seatPitch: 0.5,
      stands: [{ side: 'south', halfLength: 76, rows: 29 }, { side: 'north', halfLength: 80 }],
    };
    const virage: TierSpec = {
      rows: 31, rowDepth: 0.85, rakeDeg: 34, baseElevation: 17, baseOffset: 36, seatPitch: 0.5,
      stands: [{ side: 'east', halfLength: 62 }, { side: 'west', halfLength: 62 }],
    };
    const t = { plan: { a: 63, b: 38.5, exponent: 8 }, tiers: [lower, middle, upper, virage] } as Parameters<typeof ringStairs>[0];
    const lowS = stairs(t, lower, { step: 12, centred: true });
    const midS = stairs(t, middle, { step: 12, centred: true });
    const upS = stairs(t, upper, { step: 12, centred: true });
    const virS = stairs(t, virage, { step: 12, centred: true });
    return {
      id: 'velodrome-67k',
      template: {
        id: 'velodrome-67k',
        name: 'CEPAC Vélodrome (Marseille)',
        version: 1,
        levels: 3,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [19, 22], kind: 'vomitory' }, (_s, at) => Math.round(at / 12) % 2 === 1) } },
          { ...middle, blocks: { width: 1.1, aisles: midS, openings: atStairs(midS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
          { ...virage, blocks: { width: 1.1, aisles: virS, openings: atStairs(virS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 48, widthMeters: 1.1 },
        sectionsPerTier: 30,
        roof: { coverage: 'none' },
        roofs: [
          // The white PTFE membrane on its steel lattice, one roof over the
          // four stands and their open corners.
          { style: 'truss', back: 78, front: -4, backY: 50, frontY: 41, bay: 7, depth: 3, color: 0xf2f2ef, underColor: 0xe4e5e1, glazing: 0.4, lights: { every: 5, y: 41.5 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0xb9b8b3, walls: 0xd9d8d3 },
        facade: { style: 'plain', color: 0xd9d8d3 },
        runoff: { color: 0x2f7a3a, a: 60, b: 37.5, exponent: 8 },
        seatLook: {
          colors: [{ c: '#f1f2f0', w: 0.72 }, { c: '#c4c9ce', w: 0.28 }],
          grain: { along: 3, rows: 2 },
          text: [{ text: 'MARSEILLE', color: '#4f9fdb', tier: 1, centerU: 0.25, halfU: 0.085, rows: [3, 12] }],
        },
        details: {
          ribbons: { color: 0x2b8fd6, tiers: [1, 2, 3] },
          // The membrane carries on down the outside as the façade.
          skins: [{ offset: 77, y0: 6, y1: 49, color: 0xf2f2ee, pattern: 'panels', tile: [6, 4] }],
          // Two screens hung under the roof over the open corners.
          screens: [
            { centerU: 0.093, widthM: 9, heightM: 5, at: [72, 50], hang: { y: 27, ceiling: 34 } },
            { centerU: 0.593, widthM: 9, heightM: 5, at: [-72, -50], hang: { y: 27, ceiling: 34 } },
          ],
        },
        site: { key: 'velodrome', horizon: 'hills', ground: 0xb9ab8e, forecourt: 0xc9c2b4, style: 'es', palms: 0.15 },
      },
      meta: { name: 'CEPAC Vélodrome (Marseille)', source: 'builtin', country: 'Europe', capacity: 67394, type: 'Bowl', inspiredBy: 'CEPAC Vélodrome, Marseille - home of Olympique de Marseille', tags: ['marseille', 'om', 'olympique-de-marseille', 'velodrome', 'cepac', 'orange-velodrome', 'france', 'ultras', L1] },
    };
  })(),

  (() => {
    // Parc des Princes, Paris. The Présidentielle Francis-Borelli (main)
    // stand is on the west side (-z here), the Tribune Paris opposite (east),
    // Auteuil the north end (+x here) and Boulogne the south (-x). Taillibert's
    // 1972 bowl: one continuous oval of two tiers under a concrete cantilever
    // roof hung from fifty portal ribs (the outer ellipse 251.5 x 191 m), the
    // pitch ringed by a blue apron. Since 2015 the seats are navy with red and
    // white bands, and the Eiffel Tower picked out in red in the Tribune Paris
    // and both ends. The Collectif Ultras Paris are in Auteuil, and since
    // 2025-26 the upper part of Boulogne too.
    const lower: TierSpec = { rows: 24, rowDepth: 0.8, rakeDeg: 23, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 28, rowDepth: 0.8, rakeDeg: 34, baseElevation: 11.5, baseOffset: 22, seatPitch: 0.5 };
    const t = { plan: { a: 62, b: 41, exponent: 6 }, tiers: [lower, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 11, centred: true });
    const upS = ringStairs(t, upper, { step: 11, centred: false });
    // The Eiffel Tower, stacked in bands narrowing up the upper tier.
    const tower = (centerU: number) => [0, 1, 2, 3, 4, 5].map((k) => ({ tiers: [1], centerU, halfU: 0.034 - k * 0.0052, rows: [k * 5, k * 5 + 4] as [number, number], colors: ['#d4142c'] }));
    return {
      id: 'parc-des-princes-48k',
      template: {
        id: 'parc-des-princes-48k',
        name: 'Parc des Princes (Paris)',
        version: 1,
        levels: 2,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.2, rows: [20, 23], kind: 'vomitory' }, (_s, at) => Math.round(at / 11) % 2 === 1) } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.2, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 52, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          // The concrete canopy hung from the portals, its rim lit by 172 projectors.
          { style: 'slab', back: 52, front: 7, backY: 33, frontY: 30, depth: 2.2, bay: 14, color: 0xb9b3a7, underColor: 0x7d776d, lights: { every: 4, y: 30.4 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9c9890, walls: 0xb3aea3 },
        // The fifty portal ribs, standing proud of the bowl.
        facade: { style: 'concrete', color: 0xc8c3b7, accent: 0xd8d3c8, bayMeters: 14 },
        runoff: { color: 0x1d3f8f, a: 61, b: 40, exponent: 6 },
        seatLook: {
          colors: [{ c: '#1c2a5e', w: 0.8 }, { c: '#24346f', w: 0.2 }],
          grain: { along: 2, rows: 2 },
          regions: [
            // Red and white bands along the front of each tier.
            { tiers: [0], rows: [0, 1], colors: ['#d4142c'] },
            { tiers: [0], rows: [2, 2], colors: ['#f2f2f2'] },
            { tiers: [1], rows: [0, 0], colors: ['#f2f2f2'] },
            ...tower(0.25),
            ...tower(0),
            ...tower(0.5),
          ],
        },
        details: {
          ribbons: { color: 0x0d3b8f, tiers: [1] },
          screens: [
            { centerU: 0.1, widthM: 10, heightM: 5.5, at: [62, 44], hang: { y: 24, ceiling: 30 } },
            { centerU: 0.6, widthM: 10, heightM: 5.5, at: [-62, -44], hang: { y: 24, ceiling: 30 } },
          ],
        },
        site: { key: 'parc-des-princes', horizon: 'city', ground: 0x9a968a, forecourt: 0xb3ada2, style: 'es' },
      },
      meta: { name: 'Parc des Princes (Paris)', source: 'builtin', country: 'Europe', capacity: 47929, type: 'Two-tier', inspiredBy: 'Parc des Princes, Paris - home of Paris Saint-Germain', tags: ['psg', 'paris-saint-germain', 'paris', 'parc-des-princes', 'auteuil', 'boulogne', 'france', 'ultras', L1] },
    };
  })(),

  (() => {
    // Stade Bollaert-Delelis, Lens. The Lepagnot (main) stand is on the south
    // side (-z here), the Marek opposite (north): the Kop, unusually on a long
    // side, with the Xercès-Louis above it. Trannin is the west end (+x here),
    // Delacourt the east (-x). Four separate stands rebuilt for Euro 2016,
    // their corners open, each roof hung from white trusses between four 72 m
    // masts standing in the corners. The ends are the big stands (over 12,000
    // each, in three levels with boxes between); since 2015 the seats are
    // charcoal and grey with the stairs picked out in yellow, and RC LENS in
    // white across the Marek's lower tier, where the Red Tigers stand.
    const lower: TierSpec = {
      rows: 30, rowDepth: 0.8, rakeDeg: 24, baseElevation: 0.9, baseOffset: 0.5, seatPitch: 0.5, straight: true,
      stands: [
        { side: 'south', halfLength: 56, rows: 15, offset: 1 },
        { side: 'north', halfLength: 60, rows: 22 },
        { side: 'east', halfLength: 52, rows: 26, offset: 1 },
        { side: 'west', halfLength: 52, rows: 26, offset: 1 },
      ],
    };
    const upper: TierSpec = {
      rows: 35, rowDepth: 0.85, rakeDeg: 34, baseElevation: 12, baseOffset: 25, seatPitch: 0.5, straight: true,
      stands: [
        { side: 'south', halfLength: 56, rows: 18, offset: -4, elevation: -2 },
        { side: 'north', halfLength: 60, rows: 12, offset: -2, elevation: -2 },
        { side: 'east', halfLength: 52, rows: 35 },
        { side: 'west', halfLength: 52, rows: 35 },
      ],
    };
    const st = (side: 'north' | 'south' | 'east' | 'west', hl: number, step: number) => {
      const at: number[] = [];
      for (let x = step / 2; x < hl - 3; x += step) at.push(Math.round(x * 10) / 10);
      return { side, at, mirror: true };
    };
    const lowS = [st('south', 56, 12), st('north', 60, 12), st('east', 52, 13), st('west', 52, 13)];
    const upS = [st('south', 56, 12), st('north', 60, 12), st('east', 52, 13), st('west', 52, 13)];
    return {
      id: 'bollaert-38k',
      template: {
        id: 'bollaert-38k',
        name: 'Stade Bollaert-Delelis (Lens)',
        version: 1,
        levels: 3,
        plan: { a: 61.5, b: 39, exponent: 14 },
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: upS.map((r) => ({ ...r, width: 2.4, rows: [0, 1] as [number, number], kind: 'vomitory' as const })) } },
        ],
        aisles: { count: 44, widthMeters: 1.1 },
        sectionsPerTier: 32,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'sheet', side: 'south', straight: true, from: -60, to: 60, back: 48, front: 1, backY: 32, frontY: 28.5, depth: 1.8, bay: 8, color: 0xe9ecee, underColor: 0x8d9298 },
          { style: 'sheet', side: 'north', straight: true, from: -62, to: 62, back: 46, front: 1, backY: 30, frontY: 27, depth: 1.8, bay: 8, color: 0xe9ecee, underColor: 0x8d9298 },
          { style: 'sheet', side: 'east', straight: true, from: -55, to: 55, back: 56, front: 1, backY: 36, frontY: 31, depth: 1.8, bay: 8, color: 0xe9ecee, underColor: 0x8d9298 },
          { style: 'sheet', side: 'west', straight: true, from: -55, to: 55, back: 56, front: 1, backY: 36, frontY: 31, depth: 1.8, bay: 8, color: 0xe9ecee, underColor: 0x8d9298 },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700, masts: { at: [[70, 55]], height: 72, style: 'pole', head: 'none', cables: { reach: 58, y: 37 } } },
        finish: { concrete: 0x9a9c9e, walls: 0xb4b8bb },
        facade: { style: 'cladding', color: 0xe6eaec, accent: 0xc9ced2 },
        runoff: { color: 0x2f7a3a, a: 60, b: 38, exponent: 14 },
        seatLook: {
          colors: [{ c: '#34363b', w: 0.82 }, { c: '#5a5d63', w: 0.18 }],
          grain: { along: 3, rows: 2 },
          regions: [
            { tiers: [0], side: 'south', from: -60, to: 60, colors: [{ c: '#d2d3d0', w: 0.8 }, { c: '#a9abaa', w: 0.2 }], grain: { along: 3, rows: 2 } },
            { tiers: [0], side: 'east', from: -60, to: 60, colors: [{ c: '#d2d3d0', w: 0.8 }, { c: '#a9abaa', w: 0.2 }], grain: { along: 3, rows: 2 } },
            { tiers: [0], side: 'west', from: -60, to: 60, colors: [{ c: '#d2d3d0', w: 0.8 }, { c: '#a9abaa', w: 0.2 }], grain: { along: 3, rows: 2 } },
            { tiers: [0], side: 'north', from: -70, to: 70, colors: ['#1e1f22'] },
          ],
          text: [{ text: 'RC LENS', color: '#f2f2f2', tier: 0, centerU: 0.25, halfU: 0.085, rows: [4, 22] }],
        },
        details: {
          ribbons: { color: 0xd4141f, tiers: [1] },
          // The white trusses between the masts that the four roofs hang from.
          girders: [
            { from: [-70, -55], to: [70, -55], y: 33, height: 4, color: 0xf0f2f3 },
            { from: [-70, 55], to: [70, 55], y: 31, height: 4, color: 0xf0f2f3 },
            { from: [70, -55], to: [70, 55], y: 37, height: 4, color: 0xf0f2f3 },
            { from: [-70, -55], to: [-70, 55], y: 37, height: 4, color: 0xf0f2f3 },
          ],
          // A screen on a frame in two of the open corners.
          screens: [
            { centerU: 0.1, widthM: 8, heightM: 4.5, at: [64, 56], post: { y: 16 } },
            { centerU: 0.6, widthM: 8, heightM: 4.5, at: [-64, -56], post: { y: 16 } },
          ],
        },
        site: { key: 'bollaert', horizon: 'city', ground: 0x8f9480, forecourt: 0xaaa79f, style: 'uk' },
      },
      meta: { name: 'Stade Bollaert-Delelis (Lens)', source: 'builtin', country: 'Europe', capacity: 38223, type: 'Two-tier', inspiredBy: 'Stade Bollaert-Delelis, Lens - home of RC Lens', tags: ['lens', 'rc-lens', 'racing-club-de-lens', 'bollaert', 'delelis', 'sang-et-or', 'france', 'ultras', L1] },
    };
  })(),

  (() => {
    // Groupama Stadium (Parc Olympique Lyonnais), Décines-Charpieu, Lyon.
    // The main stand is on the west side (-z here), the Tribune Est opposite,
    // the Virage Nord north (+x here) — the Bad Gones' end — and the Virage
    // Sud south (-x), Lyon 1950's. One continuous bowl of three tiers, boxes
    // between the middle and the upper, under a polycarbonate roof whose
    // outer edge is a twelve-sided polygon. Royal blue below, red above with
    // OLYMPIQUE LYONNAIS across the Tribune Est, and a white panel down the
    // middle of each end with a red and a blue stripe through it.
    const lower: TierSpec = { rows: 24, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const middle: TierSpec = { rows: 12, rowDepth: 0.85, rakeDeg: 30, baseElevation: 11, baseOffset: 23, seatPitch: 0.5 };
    const upper: TierSpec = { rows: 25, rowDepth: 0.85, rakeDeg: 34, baseElevation: 22, baseOffset: 35, seatPitch: 0.5 };
    const t = { plan: { a: 59.5, b: 39.5, exponent: 10 }, tiers: [lower, middle, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12.5, centred: true });
    const midS = ringStairs(t, middle, { step: 12.5, centred: true });
    const upS = ringStairs(t, upper, { step: 12.5, centred: true });
    const endPanel = (u: number) => [
      { tiers: [0, 1, 2], centerU: u, halfU: 0.042, colors: ['#eef0f2'] },
      { tiers: [0, 1, 2], centerU: u - 0.006, halfU: 0.004, colors: ['#d0142c'] },
      { tiers: [0, 1, 2], centerU: u + 0.006, halfU: 0.004, colors: ['#1d3fa6'] },
    ];
    return {
      id: 'groupama-stadium-59k',
      template: {
        id: 'groupama-stadium-59k',
        name: 'Groupama Stadium (Lyon)',
        version: 1,
        levels: 3,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [22, 26], kind: 'vomitory' }, (_s, at) => Math.round(at / 12.5) % 2 === 1) } },
          { ...middle, blocks: { width: 1.1, aisles: midS, openings: atStairs(midS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 56, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          // Polycarbonate panels on a steel frame, lit from inside at night.
          { style: 'truss', back: 74, front: 9, backY: 46, frontY: 41, depth: 3, bay: 8, color: 0xe8e4dc, underColor: 0xcfd2d4, glazing: 0.7, columns: { every: 14, offset: 72.5, color: 0xe8e4dc }, lights: { every: 5, y: 41.5 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9fa1a3, walls: 0xb8b6b0 },
        facade: { style: 'concrete', color: 0xb9b5ac, accent: 0xa9a59c, bayMeters: 12 },
        runoff: { color: 0x2f7a3a, a: 58.5, b: 38.5, exponent: 10 },
        seatLook: {
          colors: ['#2344a8'],
          regions: [
            { tiers: [2], colors: ['#c9122c'] },
            ...endPanel(0),
            ...endPanel(0.5),
          ],
          text: [{ text: 'OLYMPIQUE LYONNAIS', color: '#f4f4f4', tier: 2, centerU: 0.25, halfU: 0.11, rows: [6, 20] }],
        },
        details: {
          ribbons: { color: 0x1d3fa6, tiers: [1, 2] },
          screens: [
            { centerU: 0.097, widthM: 10, heightM: 5.5, at: [66, 48], hang: { y: 30, ceiling: 40 } },
            { centerU: 0.403, widthM: 10, heightM: 5.5, at: [-66, 48], hang: { y: 30, ceiling: 40 } },
            { centerU: 0.597, widthM: 10, heightM: 5.5, at: [-66, -48], hang: { y: 30, ceiling: 40 } },
            { centerU: 0.903, widthM: 10, heightM: 5.5, at: [66, -48], hang: { y: 30, ceiling: 40 } },
          ],
        },
        site: { key: 'groupama', horizon: 'city', ground: 0xa49e8a, forecourt: 0xb9b4a8, style: 'es' },
      },
      meta: { name: 'Groupama Stadium (Lyon)', source: 'builtin', country: 'Europe', capacity: 59186, type: 'Bowl', inspiredBy: 'Groupama Stadium (Parc Olympique Lyonnais), Décines-Charpieu - home of Olympique Lyonnais', tags: ['lyon', 'ol', 'olympique-lyonnais', 'groupama', 'parc-ol', 'decines', 'france', 'ultras', L1] },
    };
  })(),

  (() => {
    // Decathlon Arena - Stade Pierre-Mauroy, Villeneuve-d'Ascq, Lille. The
    // main stand is on the west side (-z here), the Tribune Est opposite, the
    // Tribune Nord north (+x here) — the DVE's end — and the Tribune Sud south
    // (-x), the Go Rijsel Spirit's. One continuous bowl of three tiers, the
    // middle one all hospitality, under a fixed roof on two great triangular
    // trusses along the sides whose middle slides shut. Pale grey seats below
    // with LOSC in red across the Tribune Est, charcoal above.
    const lower: TierSpec = { rows: 23, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.0, baseOffset: 0.5, seatPitch: 0.5 };
    const middle: TierSpec = { rows: 8, rowDepth: 0.85, rakeDeg: 29, baseElevation: 11, baseOffset: 22, seatPitch: 0.55 };
    const upper: TierSpec = { rows: 23, rowDepth: 0.85, rakeDeg: 34, baseElevation: 19, baseOffset: 31, seatPitch: 0.5 };
    const t = { plan: { a: 59.5, b: 39.5, exponent: 10 }, tiers: [lower, middle, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 12, centred: true });
    const midS = ringStairs(t, middle, { step: 12, centred: true });
    const upS = ringStairs(t, upper, { step: 12, centred: true });
    return {
      id: 'pierre-mauroy-50k',
      template: {
        id: 'pierre-mauroy-50k',
        name: 'Stade Pierre-Mauroy (Lille)',
        version: 1,
        levels: 3,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS, openings: atStairs(lowS, { width: 2.4, rows: [18, 22], kind: 'vomitory' }, (_s, at) => Math.round(at / 12) % 2 === 1) } },
          { ...middle, blocks: { width: 1.1, aisles: midS } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.4, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 56, widthMeters: 1.1 },
        sectionsPerTier: 36,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'truss', back: 70, front: 6, backY: 42, frontY: 38, depth: 3.5, bay: 8, color: 0xb9bec2, underColor: 0xc4bba2, lights: { every: 5, y: 38.5 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x9ea2a6, walls: 0xb4b8bc },
        // The envelope of translucent polycarbonate tubes, lit at night.
        facade: { style: 'membrane', color: 0xdfe3e6 },
        runoff: { color: 0x2f7a3a, a: 58.5, b: 38.5, exponent: 10 },
        seatLook: {
          colors: [{ c: '#3d4146', w: 0.85 }, { c: '#55595f', w: 0.15 }],
          grain: { along: 3, rows: 2 },
          regions: [
            { tiers: [0], colors: [{ c: '#c9cccf', w: 0.85 }, { c: '#aeb2b6', w: 0.15 }], grain: { along: 3, rows: 2 } },
            { tiers: [1], colors: ['#8d9196'] },
          ],
          text: [{ text: 'LOSC', color: '#d2121f', tier: 0, centerU: 0.25, halfU: 0.07, rows: [5, 20] }],
        },
        details: {
          ribbons: { color: 0xd2121f, tiers: [1, 2] },
          // The two trusses the roof hangs from, along the sides.
          girders: [
            { from: [-112, -50], to: [112, -50], y: 43, height: 8, color: 0xe9ecee },
            { from: [-112, 50], to: [112, 50], y: 43, height: 8, color: 0xe9ecee },
          ],
          // The box the bowl stands in: its glazed skin up to the roof's edge.
          skins: [{ offset: 69, y0: 0, y1: 41, color: 0xdfe3e6, pattern: 'glass', tile: [6, 4] }],
          screens: [
            { centerU: 0, widthM: 10, heightM: 5.5, hang: { offset: 12, y: 30, ceiling: 39 } },
            { centerU: 0.5, widthM: 10, heightM: 5.5, hang: { offset: 12, y: 30, ceiling: 39 } },
          ],
        },
        site: { key: 'pierre-mauroy', horizon: 'city', ground: 0x8f9282, forecourt: 0xaaa79f, style: 'uk' },
      },
      meta: { name: 'Stade Pierre-Mauroy (Lille)', source: 'builtin', country: 'Europe', capacity: 50186, type: 'Bowl', inspiredBy: 'Decathlon Arena - Stade Pierre-Mauroy, Villeneuve-d\'Ascq - home of LOSC Lille', tags: ['lille', 'losc', 'losc-lille', 'pierre-mauroy', 'decathlon-arena', 'villeneuve-d-ascq', 'dve', 'france', 'ultras', L1] },
    };
  })(),

  (() => {
    // Roazhon Park, Rennes. The Vilaine (main) stand is on the south side
    // (-z here), the low one of the four; the Lorient opposite (north), on its
    // 150 m beam over the road; the Mordelles end west (+x here), the Roazhon
    // Celtic Kop's, and the Rennes end east (-x). Four flat-roofed stands with
    // their corners filled, the ends set back 13-15 m from the goal lines, the
    // Lorient and both ends in three levels (OpenStreetMap footprints). Red
    // seats since 2015, with black in among them and SRFC in black across the
    // Lorient; two screens of 48 m² behind the goals.
    const lower: TierSpec = { rows: 16, rowDepth: 0.8, rakeDeg: 24, baseElevation: 0.8, baseOffset: 0.5, seatPitch: 0.5 };
    const middle: TierSpec = {
      rows: 16, rowDepth: 0.85, rakeDeg: 30, baseElevation: 8.5, baseOffset: 15, seatPitch: 0.5,
      stands: [
        { side: 'south', halfLength: 60, rows: 12 },
        { side: 'north', halfLength: 62, rows: 14 },
        { side: 'east', halfLength: 40 },
        { side: 'west', halfLength: 40 },
      ],
    };
    const upper: TierSpec = {
      rows: 18, rowDepth: 0.85, rakeDeg: 33, baseElevation: 18, baseOffset: 30, seatPitch: 0.5,
      stands: [
        { side: 'north', halfLength: 62, rows: 12 },
        { side: 'east', halfLength: 40 },
        { side: 'west', halfLength: 40 },
      ],
    };
    const t = { plan: { a: 66, b: 39, exponent: 8 }, tiers: [lower, middle, upper] } as Parameters<typeof ringStairs>[0];
    const lowS = ringStairs(t, lower, { step: 10.5, centred: true });
    const midS = stairs(t, middle, { step: 10.5, centred: true });
    const upS = stairs(t, upper, { step: 10.5, centred: true });
    return {
      id: 'roazhon-park-30k',
      template: {
        id: 'roazhon-park-30k',
        name: 'Roazhon Park (Rennes)',
        version: 1,
        levels: 3,
        plan: t.plan,
        evenRows: true,
        tiers: [
          { ...lower, blocks: { width: 1.1, aisles: lowS } },
          { ...middle, blocks: { width: 1.1, aisles: midS, openings: atStairs(midS, { width: 2.2, rows: [0, 1], kind: 'vomitory' }) } },
          { ...upper, blocks: { width: 1.1, aisles: upS, openings: atStairs(upS, { width: 2.2, rows: [0, 1], kind: 'vomitory' }) } },
        ],
        aisles: { count: 44, widthMeters: 1.1 },
        sectionsPerTier: 32,
        roof: { coverage: 'none' },
        roofs: [
          { style: 'slab', side: 'south', from: -64, to: 64, back: 26, front: 1, backY: 17.5, frontY: 15.5, depth: 1.4, bay: 8, color: 0xd9dcde, underColor: 0x2a2c30, lights: { every: 5, y: 15.6 } },
          { style: 'slab', side: 'north', from: -88, to: 88, back: 38, front: 1, backY: 28.5, frontY: 26, depth: 1.6, bay: 8, color: 0xd9dcde, underColor: 0x2a2c30, lights: { every: 5, y: 26.2 } },
          { style: 'slab', side: 'east', from: -42, to: 42, back: 46, front: 1, backY: 31, frontY: 28, depth: 1.6, bay: 8, color: 0xd9dcde, underColor: 0x2a2c30, lights: { every: 5, y: 28.1 } },
          { style: 'slab', side: 'west', from: -42, to: 42, back: 46, front: 1, backY: 31, frontY: 28, depth: 1.6, bay: 8, color: 0xd9dcde, underColor: 0x2a2c30, lights: { every: 5, y: 28.1 } },
        ],
        lighting: { style: 'roof-rim', kelvin: 5700 },
        finish: { concrete: 0x8f9296, walls: 0x9fa4aa },
        facade: { style: 'cladding', color: 0x55595f, accent: 0x3b3e43 },
        runoff: { color: 0x2f7a3a, a: 64, b: 38, exponent: 8 },
        seatLook: {
          colors: [{ c: '#cc1426', w: 0.86 }, { c: '#1b1b1d', w: 0.14 }],
          grain: { along: 3, rows: 2 },
          text: [{ text: 'SRFC', color: '#141416', tier: 1, centerU: 0.25, halfU: 0.06, rows: [2, 12] }],
        },
        details: {
          // The two 48 m² screens, behind the goals.
          screens: [
            { centerU: 0, widthM: 9, heightM: 5.3 },
            { centerU: 0.5, widthM: 9, heightM: 5.3 },
          ],
        },
        site: { key: 'roazhon', horizon: 'city', ground: 0x8f9480, forecourt: 0xa7a59d, style: 'uk' },
      },
      meta: { name: 'Roazhon Park (Rennes)', source: 'builtin', country: 'Europe', capacity: 29778, type: 'Two-tier', inspiredBy: 'Roazhon Park, Rennes - home of Stade Rennais', tags: ['rennes', 'stade-rennais', 'srfc', 'roazhon', 'route-de-lorient', 'bretagne', 'france', 'ultras', L1] },
    };
  })(),
];
