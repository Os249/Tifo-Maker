/**
 * Stadium catalog — the scalable registry behind the Stadium panel.
 *
 * Wraps the raw `StadiumTemplate` (geometry the seat-map generator needs) with
 * presentation METADATA (name, country, capacity, type, tags, source). One flat,
 * data-driven list designed to grow to hundreds of entries and power search,
 * filtering, categories and community submissions WITHOUT UI changes — adding a
 * stadium is a data entry here, never new code.
 *
 * Sources:
 *  - 'builtin'   : the engine's own bowls (reuse the existing TEMPLATES objects).
 *  - 'community' : community-created APPROXIMATIONS inspired by real venues. These
 *                  are not official plans/CAD/blueprints and carry a disclaimer.
 *                  None is ever loaded by default — the user must choose one.
 *  - 'custom'    : user-authored bowls (future; same shape).
 *
 * Pure and DOM-free: it runs on the main thread, in the seat-map worker, and in
 * tests, so id→template resolution is identical everywhere.
 */

import type { StadiumTemplate } from './types';
import { DEFAULT_TEMPLATE, KOP_TEMPLATE, OVAL_TEMPLATE } from './template';

export type StadiumSource = 'builtin' | 'community' | 'custom';
export type StadiumType = 'Bowl' | 'Single-tier' | 'Two-tier' | 'Oval' | 'Arena';

export interface StadiumMeta {
  name: string;
  source: StadiumSource;
  /** Free-form country/region label, when known. */
  country?: string;
  /** Approximate spectator capacity, when known. */
  capacity?: number;
  /** Bowl archetype, for display + filtering. */
  type?: StadiumType;
  /** Search/category tags (lower-case). */
  tags?: string[];
  /**
   * For community entries: a generic descriptor of the real-world venue style
   * that inspired it (never a claim of official affiliation). The disclaimer in
   * the panel makes the non-affiliation explicit.
   */
  inspiredBy?: string;
  /**
   * Set on a legacy ground: the id of the stadium that replaced it, so a design
   * still on the old one can be offered the new one.
   */
  supersededBy?: string;
}

export interface StadiumEntry {
  id: string;
  template: StadiumTemplate;
  meta: StadiumMeta;
}

/** Tiers / sections derived from a template's geometry (single source of truth). */
export function tierCount(t: StadiumTemplate): number {
  return t.levels ?? t.tiers.length;
}
export function sectionCount(t: StadiumTemplate): number {
  return t.sectionsPerTier * t.tiers.length;
}

// ---- built-in entries (reuse the existing template objects — no duplication) ----
const BUILTINS: StadiumEntry[] = [
  {
    id: DEFAULT_TEMPLATE.id,
    template: DEFAULT_TEMPLATE,
    meta: { name: DEFAULT_TEMPLATE.name, source: 'builtin', type: 'Two-tier', capacity: 60000, tags: ['default', 'bowl', 'two-tier'] },
  },
  {
    id: KOP_TEMPLATE.id,
    template: KOP_TEMPLATE,
    meta: { name: KOP_TEMPLATE.name, source: 'builtin', type: 'Single-tier', capacity: 40000, tags: ['kop', 'single-tier', 'steep'] },
  },
  {
    id: OVAL_TEMPLATE.id,
    template: OVAL_TEMPLATE,
    meta: { name: OVAL_TEMPLATE.name, source: 'builtin', type: 'Oval', capacity: 76000, tags: ['oval', 'two-tier', 'athletics'] },
  },
];

// ---- community example entries (generic approximations, NOT real venue names) ----
// These demonstrate the community system. Real-venue-inspired submissions slot in
// here later with the same shape; each is flagged 'community' so the UI shows the
// disclaimer and never auto-loads it.
const COMMUNITY: StadiumEntry[] = [
  {
    id: 'community-grand-national-80k',
    template: {
      id: 'community-grand-national-80k',
      name: 'Grand National Bowl',
      version: 1,
      plan: { a: 122, b: 96, exponent: 2.2 },
      tiers: [
        { rows: 32, rowDepth: 0.85, rakeDeg: 23, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 },
        { rows: 24, rowDepth: 0.8, rakeDeg: 32, baseElevation: 16, baseOffset: 30, seatPitch: 0.5 },
      ],
      aisles: { count: 34, widthMeters: 1.2 },
      sectionsPerTier: 34,
      roof: { coverage: 'ring', reach: 0.5, rise: 9, slope: 2.5 },
      facade: { style: 'cladding' },
      lighting: { style: 'roof-rim' },
    },
    meta: { name: 'Grand National Bowl', source: 'builtin', country: 'International', capacity: 80000, type: 'Two-tier', inspiredBy: 'a large national stadium', tags: ['large', 'national', 'two-tier'] },
  },
  {
    id: 'community-steep-cauldron-55k',
    template: {
      id: 'community-steep-cauldron-55k',
      name: 'Steep Cauldron',
      version: 1,
      plan: { a: 80, b: 64, exponent: 2.8 },
      tiers: [
        { rows: 24, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 },
        { rows: 26, rowDepth: 0.78, rakeDeg: 37, baseElevation: 13, baseOffset: 22, seatPitch: 0.48 },
      ],
      aisles: { count: 26, widthMeters: 1.1 },
      sectionsPerTier: 26,
      // Low and deep: a roof that holds the noise in is half of what makes a
      // cauldron a cauldron.
      roof: { coverage: 'ring', reach: 0.68, rise: 4.5, slope: 2.8 },
      facade: { style: 'concrete' },
      lighting: { style: 'roof-rim', kelvin: 5200 },
    },
    meta: { name: 'Steep Cauldron', source: 'builtin', country: 'Europe', capacity: 55000, type: 'Two-tier', inspiredBy: 'a steep atmospheric club ground', tags: ['steep', 'atmosphere', 'compact'] },
  },
  {
    id: 'community-compact-wall-30k',
    template: {
      id: 'community-compact-wall-30k',
      name: 'Compact Wall',
      version: 1,
      plan: { a: 66, b: 52, exponent: 2.7 },
      tiers: [{ rows: 40, rowDepth: 0.78, rakeDeg: 35, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 }],
      aisles: { count: 20, widthMeters: 1.1 },
      sectionsPerTier: 20,
      roof: { coverage: 'ring', reach: 0.55, rise: 5, slope: 2.4 },
      facade: { style: 'brick' },
      lighting: { style: 'corner-masts', kelvin: 4200 },
    },
    meta: { name: 'Compact Wall', source: 'builtin', country: 'Europe', capacity: 30000, type: 'Single-tier', inspiredBy: 'a single-tier terrace wall', tags: ['single-tier', 'wall', 'compact'] },
  },
  {
    id: 'community-desert-arena-68k',
    template: {
      id: 'community-desert-arena-68k',
      name: 'Desert Arena',
      version: 1,
      plan: { a: 108, b: 88, exponent: 2.4 },
      tiers: [
        { rows: 28, rowDepth: 0.85, rakeDeg: 24, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 },
        { rows: 22, rowDepth: 0.8, rakeDeg: 33, baseElevation: 15, baseOffset: 27, seatPitch: 0.5 },
      ],
      aisles: { count: 30, widthMeters: 1.2 },
      sectionsPerTier: 30,
      // Modern build: broad, near-flat, pale soffit.
      roof: { coverage: 'ring', reach: 0.6, rise: 9, slope: 1.2, thickness: 1.6, underColor: 0xd7d2c4 },
      facade: { style: 'membrane' },
      lighting: { style: 'roof-rim' },
    },
    meta: { name: 'Desert Arena', source: 'builtin', country: 'Middle East', capacity: 68000, type: 'Two-tier', inspiredBy: 'a modern desert-region arena', tags: ['modern', 'two-tier', 'large'] },
  },
  {
    id: 'community-roaring-terraces-48k',
    template: {
      id: 'community-roaring-terraces-48k',
      name: 'Roaring Terraces',
      version: 1,
      plan: { a: 74, b: 58, exponent: 2.9 },
      tiers: [{ rows: 44, rowDepth: 0.78, rakeDeg: 36, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 }],
      aisles: { count: 22, widthMeters: 1.1 },
      sectionsPerTier: 22,
      // One covered main stand, three sides open to the weather.
      roof: { coverage: 'west', reach: 0.6, rise: 6, slope: 2.6 },
      // One roofed stand, three open sides, raw concrete: the South American
      // ground this is drawn from would have pylons, not a rim array.
      facade: { style: 'concrete' },
      lighting: { style: 'corner-masts', kelvin: 4400 },
    },
    meta: { name: 'Roaring Terraces', source: 'builtin', country: 'South America', capacity: 48000, type: 'Single-tier', inspiredBy: 'a single-tier terraced ground', tags: ['single-tier', 'steep', 'atmosphere'] },
  },
  {
    id: 'community-cauldron-dome-62k',
    template: {
      id: 'community-cauldron-dome-62k',
      name: 'Cauldron Dome',
      version: 1,
      plan: { a: 86, b: 68, exponent: 2.7 },
      tiers: [
        { rows: 22, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 },
        { rows: 20, rowDepth: 0.78, rakeDeg: 36, baseElevation: 11, baseOffset: 18, seatPitch: 0.48 },
        { rows: 18, rowDepth: 0.76, rakeDeg: 40, baseElevation: 22, baseOffset: 34, seatPitch: 0.48 },
      ],
      aisles: { count: 28, widthMeters: 1.1 },
      sectionsPerTier: 28,
      roof: { coverage: 'ring', reach: 0.72, rise: 5, slope: 1.6 },
      facade: { style: 'cladding' },
      lighting: { style: 'roof-rim' },
    },
    meta: { name: 'Cauldron Dome', source: 'builtin', country: 'Europe', capacity: 62000, type: 'Bowl', inspiredBy: 'a steep three-tier cauldron', tags: ['steep', 'three-tier', 'enclosed', 'atmosphere'] },
  },
  {
    id: 'community-wide-oval-72k',
    template: {
      id: 'community-wide-oval-72k',
      name: 'Wide Athletics Oval',
      version: 1,
      plan: { a: 128, b: 92, exponent: 2.1 },
      tiers: [
        { rows: 30, rowDepth: 0.85, rakeDeg: 20, baseElevation: 1.5, baseOffset: 8, seatPitch: 0.5 },
        { rows: 24, rowDepth: 0.82, rakeDeg: 28, baseElevation: 14, baseOffset: 30, seatPitch: 0.5 },
      ],
      aisles: { count: 32, widthMeters: 1.2 },
      sectionsPerTier: 32,
      roof: { coverage: 'sides', reach: 0.5, rise: 8.5, slope: 1.5 },
      track: {},
      facade: { style: 'truss' },
      lighting: { style: 'corner-masts', kelvin: 4600 },
    },
    meta: { name: 'Wide Athletics Oval', source: 'builtin', country: 'International', capacity: 72000, type: 'Oval', inspiredBy: 'a wide running-track oval', tags: ['oval', 'athletics', 'two-tier', 'large'] },
  },
  {
    // King Abdullah Sports City (Alinma Stadium), Jeddah — "The Shining Jewel".
    //
    // Rebuilt September 2026 from StadiumDB's photo set and the Saudi ticket
    // maps, and fitted to the real seat counts: 23,473 lower / 22,244 middle /
    // 14,038 upper, plus 486 VIP (60,241 in all). The lower tier hugs the pitch
    // and is angular; the offset curves round off towards the top, which is what
    // Arup describes ("the angled layout on the lower levels becomes rounded at
    // the top").
    //
    // A NEW ID, not a version bump: the vehicle lanes remove real seats, and
    // every design saved on the earlier Jewel indexes its seats by position. The
    // earlier one lives on in LEGACY below, byte-identical, so those designs
    // still open exactly as they were saved.
    id: 'jewel-jeddah-60k',
    template: {
      id: 'jewel-jeddah-60k',
      name: 'The Jewel of Jeddah',
      version: 1,
      // A near-rectangle (p = 7) for the lower tier: square to the touchlines
      // with a tight chamfer at the corners, where the ramps come in. Clears
      // the pitch by about 9.4 m on the sides, 9.8 m behind the goals and
      // 7.1 m at the corner flags. (The first cut, p = 2.7, put the corner
      // seats 0.4 m from the corner flag.) Offset outward, the tiers round off.
      plan: { a: 62.5, b: 44, exponent: 7 },
      evenRows: true,
      tiers: [
        { rows: 29, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.51 },
        { rows: 21, rowDepth: 0.8, rakeDeg: 32, baseElevation: 16.7, baseOffset: 19.2, seatPitch: 0.5 },
        { rows: 12, rowDepth: 0.78, rakeDeg: 36, baseElevation: 31.3, baseOffset: 32.2, seatPitch: 0.5 },
      ],
      aisles: { count: 40, widthMeters: 1.1 },
      sectionsPerTier: 40,
      // The crown, the trusses and the skin are hand-built (simulator/jewel.ts).
      roof: { coverage: 'none' },
      // The lamps ride the inner edge of the crown, which reaches out over the
      // front of the lower tier — see the StadiumDB photo looking up through
      // the opening.
      lighting: { style: 'roof-rim', kelvin: 5700, mount: { offset: 7, y: 51.6 } },
      details: {
        // Two vehicle tunnels, both at the corners of the main stand (south,
        // under the royal box side), as at the real ground; the north corners
        // are seats all the way down. Tunnels, not slots: 5 m wide (an
        // ambulance is 2.1 m) and open for the first nine rows, where the deck
        // is 4.5 m up — enough headroom for the van. The rows behind run on
        // over the roof.
        lanes: [
          { corner: 'south-west', widthM: 5, tier: 0, rows: 9 },
          { corner: 'south-east', widthM: 5, tier: 0, rows: 9 },
        ],
        // The main stand is the south side (u = 0.75), where the broadcast
        // cameras are. Listed innermost first: a seat takes the first zone
        // that claims it.
        zones: [
          // The royal box: the VIP seats, front of the middle tier, centre.
          { kind: 'vip', centerU: 0.75, halfU: 0.0115, tiers: [1], noTifo: true },
          // The gold platform (المنصة الذهبية): lower tier, centre of the main stand.
          { kind: 'gold', centerU: 0.75, halfU: 0.034, tiers: [0] },
          // The silver platform (المنصة الفضية) either side of it.
          { kind: 'silver', centerU: 0.75, halfU: 0.075, tiers: [0] },
        ],
        // Glass-fronted boxes between the lower and middle tiers, both long sides.
        boxes: [
          { centerU: 0.75, halfU: 0.1, underTier: 1, count: 22 },
          { centerU: 0.25, halfU: 0.1, underTier: 1, count: 22 },
        ],
        // One big screen at the top of each end stand, under the roof.
        screens: [
          { centerU: 0, widthM: 26, heightM: 9.5 },
          { centerU: 0.5, widthM: 26, heightM: 9.5 },
        ],
      },
    },
    meta: { name: 'The Jewel of Jeddah', source: 'builtin', country: 'Middle East', capacity: 60241, type: 'Bowl', inspiredBy: 'King Abdullah Sports City (Alinma Stadium), Jeddah - nicknamed "The Shining Jewel"', tags: ['jewel', 'jeddah', 'alinma', 'saudi', 'three-tier', 'bowl', 'large', 'world-cup-2034', 'al-ittihad', 'ittihad', 'al-ahli', 'ahli', 'roshn', 'saudi-pro-league'] },
  },
  {
    // Al-Awwal Park (King Saud University Stadium), Riyadh — Al-Nassr's home,
    // and Al-Diriyah's in 2026-27.
    //
    // Rebuilt October 2026 from the satellite picture (Esri, September 2025),
    // the photographs (Wikimedia Commons, StadiumDB) and the published figures:
    // opened 2015, 26,004 seats (sell-outs of 26,003 in 2025-26). One
    // continuous bowl with filled, rounded corners hugging a 121 x 84 m grass
    // area; a steel space-truss roof on blue Y-columns over the back of every
    // stand, with racks of floodlights on its leading edge; and the main stand
    // (real west, `south` here) the exception: its lower rows run on, then a
    // band of glass boxes, a short upper section with the royal box, two glazed
    // floors of hospitality, and the roof arching up over all of it.
    //
    // A NEW ID: every design saved on the earlier Al-Awwal indexes its seats by
    // position. That one lives on in LEGACY below.
    id: 'alawwal-park-26k',
    template: {
      id: 'alawwal-park-26k',
      name: 'Al-Awwal Park (Riyadh)',
      version: 1,
      // Row 0 a metre and a half behind the grass, corners rounded at about 10 m.
      plan: { a: 62, b: 43.5, exponent: 10 },
      evenRows: true,
      tiers: [
        {
          rows: 31, rowDepth: 0.75, rakeDeg: 31, baseElevation: 1.2, baseOffset: 0, seatPitch: 0.465,
          // Over the middle of the main stand only the first twelve rows run
          // on; behind them are the boxes and the upper section (tier 1).
          omit: [{ side: 'south', from: -38, to: 38, fromRow: 12 }],
        },
        {
          // The main stand's upper section, over the boxes, with the royal box.
          rows: 12, rowDepth: 0.8, rakeDeg: 32, baseElevation: 9.7, baseOffset: 13.2, seatPitch: 0.5,
          stands: [{ side: 'south', halfLength: 38 }],
        },
      ],
      aisles: { count: 56, widthMeters: 1.1 },
      sectionsPerTier: 28,
      // The roof, its columns and the skin are built from `roofs` and `details` below.
      roof: { coverage: 'none' },
      roofs: [
        {
          style: 'truss',
          // From its outer edge, 14 m behind the back row, to a leading edge
          // 12 m in from the front row; lifted 11 m over the main stand.
          back: 37, front: 12, backY: 22.5, frontY: 26.5, depth: 3.4, bay: 6.5,
          // Grey sheeting on top; the space truss under it painted gold.
          color: 0xa9aaa8, underColor: 0xd2ae5e,
          columns: { shape: 'y', color: 0x1f3f8a, every: 6.5, offset: 24.2 },
          lights: { every: 3.5, y: 31 },
          arch: { side: 'south', rise: 11, halfLength: 72 },
        },
      ],
      // Racks of floodlights along the top of the roof's leading edge.
      lighting: { style: 'roof-rim', kelvin: 5700, mount: { offset: 12.5, y: 30.5 } },
      // Pale concrete steps and walls.
      finish: { concrete: 0xb9b5ad, walls: 0x8f8a80 },
      // Grass right up to the front row.
      runoff: { color: 0x1f6f37, a: 61, b: 42.5, exponent: 10 },
      seatLook: {
        colors: [{ c: '#f4c200', w: 6 }, { c: '#e9b800', w: 3 }, { c: '#f7cf1c', w: 2 }],
        regions: [
          // The main stand's middle: navy below the boxes, blue above them.
          { tiers: [0], side: 'south', from: -38, to: 38, colors: ['#1d3479', '#213a86', '#1a2f6e'] },
          { tiers: [1], colors: ['#1f409a', '#2348a6'] },
        ],
        text: [
          // The heart opposite the main stand, a shade darker than the gold
          // round it, from its Mrsool Park years.
          { text: 'heart', shape: 'heart', color: '#8f8862', tier: 0, centerU: 0.25, halfU: 0.03, rows: [13, 29] },
          // "ALNASSR FC" in navy across the end to the right of the main
          // stand (north in reality), plain in the satellite picture.
          { text: 'ALNASSR FC', color: '#1d2b66', tier: 0, centerU: 0, halfU: 0.085, rows: [7, 28], font: '900 {px}px Arial, sans-serif' },
        ],
      },
      details: {
        zones: [
          // The royal box: the middle of the main stand's upper section.
          { kind: 'vip', centerU: 0.75, halfU: 0.011, tiers: [1], noTifo: true },
        ],
        // Glass boxes between the main stand's lower rows and its upper section.
        boxes: [{ centerU: 0.75, halfU: 0.09, underTier: 1, count: 24 }],
        // A screen at the back of each end, under the roof.
        screens: [
          { centerU: 0, widthM: 13, heightM: 5.5 },
          { centerU: 0.5, widthM: 13, heightM: 5.5 },
        ],
        buildings: [
          // Two glazed floors of hospitality behind the upper section, with the presidential suite above.
          // Navy panels and glass, ALAWWAL PARK across the top.
          { side: 'south', halfLength: 40, front: 23.0, depth: 11, y0: 0, y1: 24.5, glassFloors: 2, color: 0x24336a, fascia: 0x1b2b6e },
        ],
        skins: [
          // The beige panels between the columns, from the top row up to the roof.
          { offset: 24.6, y0: 14.6, y1: 21.4, color: 0xeadcb6, pattern: 'slats', glow: 0.25, omit: [{ side: 'south', from: -40, to: 40 }] },
          // The blue band along the top of the seating.
          { offset: 24.0, y0: 14.0, y1: 15.2, color: 0x1f4f9e, pattern: 'solid', omit: [{ side: 'south', from: -40, to: 40 }] },
          // The gold perforated skin round the outside.
          // It wraps the main stand too, rising to the top of its building.
          { offset: 34, y0: 0, y1: 15.5, color: 0xc79a52, pattern: 'perforated', glow: 0.15, omit: [{ side: 'south', from: -42, to: 42 }] },
          { offset: 34.4, y0: 0, y1: 24.5, color: 0xc79a52, pattern: 'perforated', glow: 0.15, side: 'south', from: -42, to: 42 },
        ],
      },
    },
    meta: { name: 'Al-Awwal Park (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 26004, type: 'Bowl', inspiredBy: 'Al-Awwal Park (King Saud University Stadium), Riyadh - home of Al-Nassr', tags: ['al-nassr', 'riyadh', 'saudi', 'bowl', 'roshn', 'saudi-pro-league', 'al-diriyah', 'awwal'] },
  },
  {
    // SHG Arena (the Al-Shabab Club Stadium, Prince Khalid bin Sultan Stadium
    // until 2025), Riyadh — Al-Shabab's home, and Al-Riyadh's.
    //
    // Built October 2026 from the Ministry of Sport's 2023 photographs
    // (StadiumDB), a straight-down drone shot used as the plan (the pitch
    // markings give the scale: 5.74 px a metre) and the satellite picture
    // (Esri, September 2025). Rebuilt 2021-23: four separate straight stands
    // under white fabric vaults, the two side stands running the full length
    // past the ends of the two new end stands; the main stand (real west,
    // `south` here) is the old one, set back where the running track was;
    // the stand opposite got six new rows at the front. Black-and-white
    // seats; four lattice masts behind the corners; a screen in a corner.
    // 13,537 seats.
    id: 'shg-arena-14k',
    template: {
      id: 'shg-arena-14k',
      name: 'SHG Arena (Riyadh)',
      version: 1,
      levels: 1,
      // Square plan: the ends' front rows at x = ±61, the stand opposite the
      // main stand at z = 45; every stand is straight (TierSpec.straight).
      plan: { a: 61, b: 45.1, exponent: 16 },
      evenRows: true,
      tiers: [
        {
          // The front rows: the ends, the six rows added in front of the
          // stand opposite, and the main stand, set back 5 m further.
          rows: 19, rowDepth: 0.78, rakeDeg: 30, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            { side: 'east', halfLength: 40, rows: 15, elevation: 0.2 },
            { side: 'west', halfLength: 40, rows: 15, offset: 0.6, elevation: 0.2 },
            { side: 'north', halfLength: 61, rows: 6 },
            { side: 'south', halfLength: 72, rows: 18, offset: 5.1, elevation: -0.3 },
          ],
        },
        {
          // The stand opposite the main stand above its walkway, full length.
          rows: 11, rowDepth: 0.78, rakeDeg: 31, baseElevation: 5.0, baseOffset: 7.3, seatPitch: 0.47, straight: true,
          stands: [{ side: 'north', halfLength: 72 }],
        },
      ],
      aisles: { count: 48, widthMeters: 1.1 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        // White fabric vaults over every stand, leaving the front rows open.
        // The roofs over the ends run the full width, over the corners, and
        // overhang the concourses behind; the side roofs fill in between.
        // Low over the stands: the underside a couple of metres above the back
        // row, dipping towards the front; cream fabric on white tube arches.
        { style: 'membrane', side: 'north', straight: true, from: -66, to: 66, back: 18.5, front: 2.0, backY: 13.2, frontY: 10.0, bay: 7.2, underColor: 0xeee2c8, columns: { every: 7.2, color: 0xeeeeea, offset: 16.6 } },
        { style: 'membrane', side: 'south', straight: true, from: -66, to: 66, back: 21.5, front: 7.4, backY: 12.6, frontY: 10.4, bay: 7.2, underColor: 0xeee2c8, columns: { every: 7.2, color: 0xeeeeea, offset: 20.4 } },
        // The ends' roofs stop at the corners, where the side roofs, higher, run on over the long stands' ends.
        { style: 'membrane', side: 'east', straight: true, from: -47, to: 47, back: 21, front: 2.0, backY: 11.6, frontY: 9.2, bay: 7.2, underColor: 0xeee2c8, columns: { every: 7.2, color: 0xeeeeea, offset: 13.4 } },
        { style: 'membrane', side: 'west', straight: true, from: -47, to: 47, back: 21.5, front: 2.6, backY: 11.6, frontY: 9.2, bay: 7.2, underColor: 0xeee2c8, columns: { every: 7.2, color: 0xeeeeea, offset: 14.0 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[78, 64]], height: 44, style: 'lattice' } },
      finish: { concrete: 0xbdb9b2, walls: 0xeeeeea },
      // Grass to the ends; in front of the main stand, the apron where the track was.
      runoff: { color: 0x1f6f37, a: 61, b: 50, exponent: 16 },
      seatLook: {
        // Black, white and a little grey, laid in clumps of a few seats.
        colors: [{ c: '#1a1b1f', w: 5 }, { c: '#f2f2ef', w: 4 }, { c: '#8d8f93', w: 1 }],
        grain: { along: 1.5, rows: 2 },
        // The main stand in whole sections of black and white.
        regions: [{ tiers: [0], side: 'south', colors: ['#f2f2ef', '#1a1b1f'], alternate: true }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.016, tiers: [0], noTifo: true }],
        // In the open corner by the main stand and the south-east end.
        screens: [{ centerU: 0.875, widthM: 9, heightM: 4.6, post: { offset: 9, y: 10.5 } }],
        buildings: [
          // The VIP lounges and the presidential box behind the middle of the main stand.
          { side: 'south', straight: true, halfLength: 22, front: 19.4, depth: 9, y0: 0, y1: 13.8, glassFloors: 1, color: 0xf1efe9, fascia: 0x1a1b1f },
        ],
      },
    },
    meta: { name: 'SHG Arena (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 13537, type: 'Single-tier', inspiredBy: 'SHG Arena (Al-Shabab Club Stadium), Riyadh - home of Al-Shabab and Al-Riyadh', tags: ['al-shabab', 'al-riyadh', 'riyadh', 'saudi', 'roshn', 'saudi-pro-league', 'shg', 'membrane'] },
  },
  {
    // EGO Stadium (the Al-Ettifaq Club Stadium, Abdullah Al-Dabal Stadium when
    // it opened in 1983), Dammam — Al-Ettifaq's home.
    //
    // Built October 2026 from the satellite picture (Esri, February 2026), the
    // club's 2023 photographs and StadiumDB. Rebuilt 2021-23 by the Ministry of
    // Sport: new stands behind both goals, joined to the stand opposite the
    // main stand by rounded corners into one U under white fabric vaults; the
    // 1983 main stand (real west, `south` here) kept on its own, set back
    // where the running track was, with its own fabric roof. Seats mostly
    // white, with the club's red and green scattered through them. A screen in
    // the open corner, four masts behind the corners. 12,984 seats.
    id: 'ego-stadium-13k',
    template: {
      id: 'ego-stadium-13k',
      name: 'EGO Stadium (Dammam)',
      version: 1,
      levels: 1,
      // The U's front row: 7.8 m behind the goal lines, 12 m from the far
      // touchline, its corners rounded wide, 7 m clear of the corner flags.
      plan: { a: 60.3, b: 46, exponent: 6 },
      evenRows: true,
      tiers: [
        {
          // The U: both ends and the stand opposite, one ring with its main-stand side open.
          rows: 18, rowDepth: 0.78, rakeDeg: 31, baseElevation: 1.4, baseOffset: 0, seatPitch: 0.47,
          omit: [
            { side: 'south', from: -99, to: 99 },
            { side: 'east', from: -99, to: -27 },
            { side: 'west', from: -99, to: -27 },
          ],
        },
        {
          // The 1983 main stand, straight and set back 7 m behind the U's line.
          rows: 14, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.2, baseOffset: 7, seatPitch: 0.47, straight: true,
          stands: [{ side: 'south', halfLength: 72 }],
        },
      ],
      aisles: { count: 48, widthMeters: 1.1 },
      sectionsPerTier: 48,
      roof: { coverage: 'none' },
      roofs: [
        // Fabric vaults round the U, from the back of its top row to over its front rows.
        {
          style: 'membrane', back: 15.8, front: 1.8, backY: 14.2, frontY: 12.0, bay: 7, columns: { every: 7, color: 0xeeeeea, offset: 14.6 },
          omit: [
            { side: 'south', from: -99, to: 99 },
            { side: 'east', from: -99, to: -26 },
            { side: 'west', from: -99, to: -26 },
          ],
        },
        // And over the main stand.
        { style: 'membrane', side: 'south', straight: true, from: -74, to: 74, back: 20.2, front: 6.0, backY: 13.8, frontY: 11.2, bay: 7, columns: { every: 7, color: 0xeeeeea, offset: 18.4 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[80, 66]], height: 44, style: 'lattice' } },
      finish: { concrete: 0xc2beb6, walls: 0xeeeeea },
      runoff: { color: 0x1f6f37, a: 60.3, b: 53, exponent: 8 },
      seatLook: {
        colors: [{ c: '#f1f0ec', w: 6 }, { c: '#cf2027', w: 2.2 }, { c: '#0f7a3b', w: 1.8 }],
        // In little clumps, not seat by seat.
        grain: { along: 1.1, rows: 2 },
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.018, tiers: [1], noTifo: true }],
        // On a frame in the open corner between the main stand and the east end.
        screens: [{ centerU: 0.885, widthM: 8.5, heightM: 4.5, post: { offset: 13, y: 10 } }],
        buildings: [
          // The VIP boxes and the presidential box behind the middle of the main stand.
          { side: 'south', straight: true, halfLength: 20, front: 18.8, depth: 8, y0: 0, y1: 13.0, glassFloors: 1, color: 0xf0eee8, fascia: 0x0f7a3b },
        ],
      },
    },
    meta: { name: 'EGO Stadium (Dammam)', source: 'builtin', country: 'Middle East', capacity: 12984, type: 'Single-tier', inspiredBy: 'EGO Stadium (Al-Ettifaq Club Stadium), Dammam - home of Al-Ettifaq', tags: ['al-ettifaq', 'ettifaq', 'dammam', 'saudi', 'roshn', 'saudi-pro-league', 'ego', 'membrane'] },
  },
  {
    // Maydan Tamweel Aloula (the Al-Fateh Club Stadium), Al-Mubarraz, Al-Ahsa
    // — Al-Fateh's home.
    //
    // Built October 2026 from the satellite picture (Esri, September 2025),
    // the Ministry of Sport's 2023 photographs (StadiumDB) and the published
    // figures: rebuilt 2021-23, opened November 2023 with 12,000 numbered
    // seats (11,851 listed). One single-tier bowl round a football pitch,
    // its corners rounded, under a ring of white fabric vaults on an arcade
    // of steel arches; the old west stand, renovated, is the main stand
    // (`south` here) with the VIP box in its middle. Blue, white and green
    // seats; four lattice masts behind the corners; a screen in a corner.
    id: 'alfateh-stadium-12k',
    template: {
      id: 'alfateh-stadium-12k',
      name: 'Al-Fateh Stadium (Al-Ahsa)',
      version: 1,
      // The front row 8.7 m behind the goal lines and 13 m from the touchlines.
      plan: { a: 61.5, b: 47, exponent: 7 },
      evenRows: true,
      tiers: [{ rows: 15, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.4, baseOffset: 0, seatPitch: 0.48 }],
      aisles: { count: 52, widthMeters: 1.1 },
      sectionsPerTier: 52,
      roof: { coverage: 'none' },
      roofs: [
        // White fabric round the ends and the far side, peaked between its ribs…
        { style: 'membrane', back: 15.6, front: 1.2, backY: 12.8, frontY: 10.8, bay: 6.6, columns: { every: 6.6, color: 0xeeeeea, offset: 15.0, shape: 'raking' }, omit: [{ side: 'south', from: -50, to: 50 }] },
        // …and over the old main stand a straight, flat cantilever of its own.
        { style: 'sheet', side: 'south', from: -50, to: 50, back: 15.6, front: 0.6, backY: 13.4, frontY: 12.6, bay: 8, color: 0xf2f2ee, underColor: 0xe8e8e4, columns: { every: 8, color: 0xeeeeea, offset: 15.2 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 5700, masts: { at: [[80, 67]], height: 44, style: 'lattice' } },
      finish: { concrete: 0xc4c0b8, walls: 0xeeeeea },
      runoff: { color: 0x1f6f37, a: 61.5, b: 47, exponent: 7 },
      seatLook: {
        colors: [{ c: '#1f5fae', w: 5 }, { c: '#f2f2ef', w: 3.4 }, { c: '#1d8a4a', w: 1.6 }],
        grain: { along: 1.2, rows: 2 },
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.014, tiers: [0], noTifo: true }],
        screens: [{ centerU: 0.62, widthM: 8.5, heightM: 4.5, post: { offset: 15, y: 11 } }],
        buildings: [
          // The VIP box in the middle of the main stand.
          { side: 'south', halfLength: 13, front: 13.6, depth: 7, y0: 0, y1: 12.0, glassFloors: 1, color: 0xf0eee8, fascia: 0x1f5fae },
        ],
        // The white wall of pointed arches round the outside, one to a bay.
        skins: [{ offset: 15.3, y0: 0, y1: 11.6, color: 0xf2f1ec, pattern: 'arcade', tile: [6.6, 11.6], omit: [{ side: 'south', from: -50, to: 50 }] }],
      },
    },
    meta: { name: 'Al-Fateh Stadium (Al-Ahsa)', source: 'builtin', country: 'Middle East', capacity: 11851, type: 'Single-tier', inspiredBy: 'Maydan Tamweel Aloula (Al-Fateh Club Stadium), Al-Mubarraz, Al-Ahsa - home of Al-Fateh', tags: ['al-fateh', 'fateh', 'al-ahsa', 'hofuf', 'mubarraz', 'saudi', 'roshn', 'saudi-pro-league', 'membrane'] },
  },
  {
    // Prince Mohamed bin Fahd Stadium, Dammam — Al-Qadsiah's and Al-Khaleej's
    // home in 2026-27.
    //
    // Built October 2026 from the satellite picture (Esri, January 2026; the
    // pitch markings give the scale), the Ministry of Sport's photographs
    // (StadiumDB) and the published figures: opened 1973, 22,042 seats. The
    // 2024 plan to rebuild it without its track was not carried out, so it is
    // still the 1970s bowl: one single-tier oval round a blue 8-lane track,
    // the stands starting 99 m from the centre spot behind the goals and 57 m
    // to the side, under a ring of space frame, with four floodlight pylons
    // outside it and the VIP building in the main stand (real west, `south`).
    id: 'pmbf-stadium-22k',
    template: {
      id: 'pmbf-stadium-22k',
      name: 'Prince Mohamed bin Fahd Stadium (Dammam)',
      version: 1,
      plan: { a: 97.6, b: 57.3, exponent: 2.4 },
      evenRows: true,
      tiers: [{ rows: 22, rowDepth: 0.8, rakeDeg: 28, baseElevation: 1.6, baseOffset: 0, seatPitch: 0.5 }],
      aisles: { count: 60, widthMeters: 1.1 },
      sectionsPerTier: 30,
      track: { lanes: 8, surface: 0x2f5fb3 },
      roof: { coverage: 'none' },
      roofs: [
        // Pale translucent panels on a space frame painted sea-green.
        { style: 'truss', back: 23, front: 1.5, backY: 17, frontY: 16, depth: 2.4, bay: 8, color: 0xe6e9e3, underColor: 0xb4ccb2, columns: { every: 8, color: 0xc9d6c6, offset: 18.4, shape: 'raking' } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4800, masts: { at: [[122, 92]], height: 52, style: 'pole' } },
      finish: { concrete: 0xb4b0a8, walls: 0x9b968c },
      // The ends inside the track and the strip outside it: pale sea-green.
      runoff: { color: 0x8db49a, a: 97.6, b: 57.3, exponent: 2.4 },
      seatLook: {
        colors: [{ c: '#1e4f9f', w: 5 }, { c: '#2a5fb2', w: 3 }, { c: '#183f86', w: 2 }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.01, tiers: [0], noTifo: true }],
        screens: [
          { centerU: 0, widthM: 12, heightM: 5 },
          { centerU: 0.5, widthM: 12, heightM: 5 },
        ],
        buildings: [
          // The VIP and media building in the main stand.
          { side: 'south', halfLength: 22, front: 18.2, depth: 9, y0: 0, y1: 15.5, glassFloors: 1, color: 0xd8cbb4, fascia: 0x1e4f9f },
        ],
        // The 1970s arcade round the outside, under the roof's back edge.
        skins: [{ offset: 18.8, y0: 0, y1: 9.5, color: 0xe9e5dc, pattern: 'arcade', tile: [8, 9.5], omit: [{ side: 'south', from: -24, to: 24 }] }],
      },
    },
    meta: { name: 'Prince Mohamed bin Fahd Stadium (Dammam)', source: 'builtin', country: 'Middle East', capacity: 22042, type: 'Oval', inspiredBy: 'Prince Mohamed bin Fahd Stadium, Dammam - home of Al-Qadsiah and Al-Khaleej', tags: ['al-qadsiah', 'qadsiah', 'al-khaleej', 'khaleej', 'dammam', 'saudi', 'roshn', 'saudi-pro-league', 'track', 'oval'] },
  },
  {
    // Prince Abdullah Al-Faisal Stadium, Jeddah — Al-Ahli's and Al-Ittihad's
    // second home (both split their 2026-27 games between it and the Jewel),
    // and an Asian Cup 2027 venue.
    //
    // Built October 2026 from the satellite picture (Esri, January 2025), the
    // SPA photographs of the 2021 reopening (StadiumDB), a Club World Cup
    // photograph from December 2023 (Wikimedia Commons) and the published
    // figures: opened 1970, rebuilt 2013-21 to 27,000. An oval two-tier bowl
    // round the old track, which since 2023 is covered in artificial grass;
    // the 1970 main stand (real west, `south`) kept as one tier under its
    // three floors of VIP and media; a cream fabric roof on steel ribs and
    // cable trusses round the whole bowl, floodlights along its inner edge.
    // Seats from the 2023 refit: tan, charcoal, and white in the main stand.
    id: 'alfaisal-stadium-27k',
    template: {
      id: 'alfaisal-stadium-27k',
      name: 'Prince Abdullah Al-Faisal Stadium (Jeddah)',
      version: 1,
      // The front row just outside the old track.
      plan: { a: 90.5, b: 48.3, exponent: 2.5 },
      evenRows: true,
      tiers: [
        { rows: 18, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 },
        {
          // The upper tier added 2013-21, everywhere but the old main stand.
          rows: 14, rowDepth: 0.8, rakeDeg: 33, baseElevation: 10.5, baseOffset: 17.5, seatPitch: 0.5,
          omit: [{ side: 'south', from: -99, to: 99 }],
        },
      ],
      aisles: { count: 60, widthMeters: 1.1 },
      sectionsPerTier: 30,
      roof: { coverage: 'none' },
      roofs: [
        { style: 'membrane', back: 32, front: 6, backY: 25, frontY: 21.5, bay: 11, color: 0xe9dfc9, underColor: 0xe6dcc6, columns: { every: 11, color: 0xd7d7d2, offset: 30.5, shape: 'raking' } },
      ],
      lighting: { style: 'roof-rim', kelvin: 5700, mount: { offset: 6.5, y: 21 } },
      finish: { concrete: 0xbfbab0, walls: 0xd8d4cb },
      // The old track and its D zones, covered in artificial grass since 2023.
      runoff: { color: 0x2f7a3f, a: 90.5, b: 48.3, exponent: 2.5 },
      seatLook: {
        colors: [{ c: '#b9824a', w: 4 }, { c: '#a8733f', w: 3 }, { c: '#c4925a', w: 2 }],
        regions: [
          { side: 'west', colors: ['#3a3d42', '#2f3236', '#44474c'] },
          { tiers: [0], side: 'south', colors: ['#e8e8e4', '#d9dcdc', { c: '#2c8a8e', w: 0.6 }, { c: '#3a3d42', w: 0.8 }] },
        ],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.012, tiers: [0], noTifo: true }],
        screens: [
          { centerU: 0, widthM: 11, heightM: 5, hang: { offset: 21, y: 19, ceiling: 24 } },
          { centerU: 0.5, widthM: 11, heightM: 5, hang: { offset: 21, y: 19, ceiling: 24 } },
        ],
        buildings: [
          // The royal box and media floors over the back of the old main stand.
          { side: 'south', halfLength: 42, front: 14.8, depth: 12, y0: 0, y1: 21, glassFloors: 2, color: 0xeee9df, fascia: 0x6b5a8e },
        ],
      },
    },
    meta: { name: 'Prince Abdullah Al-Faisal Stadium (Jeddah)', source: 'builtin', country: 'Middle East', capacity: 27000, type: 'Two-tier', inspiredBy: 'Prince Abdullah Al-Faisal Stadium, Jeddah - home of Al-Ahli and Al-Ittihad', tags: ['al-ahli', 'ahli', 'al-ittihad', 'ittihad', 'jeddah', 'saudi', 'roshn', 'saudi-pro-league', 'faisal', 'asian-cup-2027'] },
  },
  {
    // King Abdullah Sport City Stadium, Buraidah — Al-Taawoun's home.
    //
    // Built October 2026 from the satellite picture (Esri, September 2025;
    // the pitch markings give the scale), the Ministry of Sport's photographs
    // (StadiumDB) and the published figures: opened 1983, 25,000 seats today.
    // A horseshoe of open blue terracing round a red 8-lane track, behind a
    // deep moat, and the main stand (real west, `south`) standing on its own
    // between the horseshoe's ends: green seats under a high flat cantilever
    // roof on tall columns, the VIP floor glazed behind them. Four masts.
    id: 'buraidah-stadium-25k',
    template: {
      id: 'buraidah-stadium-25k',
      name: 'King Abdullah Sport City Stadium (Buraidah)',
      version: 1,
      levels: 1,
      // The horseshoe's front row, just outside the moat round the track.
      plan: { a: 96, b: 52, exponent: 2.3 },
      evenRows: true,
      tiers: [
        {
          rows: 27, rowDepth: 0.75, rakeDeg: 27, baseElevation: 2.2, baseOffset: 0, seatPitch: 0.45,
          omit: [{ side: 'south', from: -68, to: 68 }],
        },
        {
          // The main stand, straight, between the ends of the horseshoe.
          rows: 15, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.8, baseOffset: -1.5, seatPitch: 0.48, straight: true,
          stands: [{ side: 'south', halfLength: 54 }],
        },
      ],
      aisles: { count: 64, widthMeters: 1.1 },
      sectionsPerTier: 32,
      // A clay-red track; the ends inside it the same.
      track: { lanes: 8, surface: 0xa5603f },
      roof: { coverage: 'none' },
      roofs: [
        // A long grey canopy over the back rows of the side opposite the main stand.
        { style: 'sheet', side: 'north', from: -56, to: 56, back: 21.4, front: 12.5, backY: 15.6, frontY: 14.6, bay: 9, color: 0xb8bcbf, underColor: 0xa9adb0, columns: { every: 9, color: 0xc9c9c4, offset: 21 } },
        // The main stand's high flat roof.
        { style: 'slab', side: 'south', straight: true, from: -58, to: 58, back: 16, front: -0.5, backY: 20, frontY: 19.5, depth: 1.6, bay: 9.5, color: 0xd8c6a2, underColor: 0xcdbb98, columns: { every: 9.5, color: 0xd4c19c, offset: 15 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4600, masts: { at: [[118, 82]], height: 48, style: 'pole' } },
      finish: { concrete: 0xc8b89c, walls: 0xcbb995 },
      runoff: { color: 0x9e6447, a: 96, b: 52, exponent: 2.3 },
      seatLook: {
        // Navy, the sun-faded sections a lighter blue.
        colors: [{ c: '#1f3f78', w: 5 }, { c: '#264a8a', w: 3 }, { c: '#3563a8', w: 1.4 }],
        grain: { along: 7, rows: 40 },
        regions: [{ tiers: [1], colors: ['#2f8a4e', '#287a44', '#36955a'] }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.012, tiers: [1], noTifo: true }],
        screens: [{ centerU: 0.25, widthM: 12, heightM: 5 }],
        buildings: [
          // The glazed VIP floor and the offices behind the main stand.
          { side: 'south', straight: true, halfLength: 52, front: 11, depth: 9, y0: 0, y1: 13.5, glassFloors: 1, color: 0xd9c8a6, fascia: 0xcbb995 },
        ],
      },
    },
    meta: { name: 'King Abdullah Sport City Stadium (Buraidah)', source: 'builtin', country: 'Middle East', capacity: 25000, type: 'Oval', inspiredBy: 'King Abdullah Sport City Stadium, Buraidah - home of Al-Taawoun', tags: ['al-taawoun', 'taawoun', 'buraidah', 'qassim', 'saudi', 'roshn', 'saudi-pro-league', 'track', 'horseshoe'] },
  },
  {
    // Prince Sultan bin Abdulaziz Sport City Stadium, Al-Mahalah, Abha —
    // Abha's home on their return to the league in 2026-27.
    //
    // Built October 2026 from the satellite picture (Esri, March 2024; the
    // pitch markings give the scale), the Ministry of Sport's photographs
    // (StadiumDB) and the published figures: opened 1984, 20,000 seats by the
    // book, about 17,000 in practice (14,357 at the 2024 Super Cup final), and
    // 2,200 m up in the Asir mountains. A blue 6-lane track; round it a
    // horseshoe of navy terracing that is deep along the side opposite the
    // main stand and tapers to a few rows round the bends; and the main stand
    // (real west, `south`) on its own, green and gold seats under a deep
    // timber-lined roof, with the white blocks of its building behind and the
    // clay watchtower beside it. Four masts.
    id: 'abha-stadium-20k',
    template: {
      id: 'abha-stadium-20k',
      name: 'Prince Sultan Sport City Stadium (Abha)',
      version: 1,
      levels: 1,
      // The horseshoe's front row, just outside the track.
      plan: { a: 93, b: 49, exponent: 2.3 },
      evenRows: true,
      tiers: [
        {
          // The front rows, all round the horseshoe.
          rows: 10, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.8, baseOffset: 0, seatPitch: 0.5,
          omit: [{ side: 'south', from: -72, to: 72 }],
        },
        {
          // The deep part opposite the main stand.
          rows: 23, rowDepth: 0.8, rakeDeg: 29, baseElevation: 6.0, baseOffset: 8.0, seatPitch: 0.5,
          stands: [{ side: 'north', halfLength: 72 }],
        },
        {
          // The main stand, straight, behind the track's home straight.
          rows: 17, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.6, baseOffset: 6, seatPitch: 0.5, straight: true,
          stands: [{ side: 'south', halfLength: 74 }],
        },
      ],
      aisles: { count: 56, widthMeters: 1.1 },
      sectionsPerTier: 28,
      track: { lanes: 6, surface: 0x3a64a8 },
      roof: { coverage: 'none' },
      roofs: [
        // The main stand's deep roof, timber-lined underneath.
        { style: 'sheet', side: 'south', straight: true, from: -76, to: 76, back: 24, front: 5.5, backY: 17.5, frontY: 15.5, depth: 1.4, bay: 7.4, color: 0xf0ece4, underColor: 0xb27a43, columns: { every: 14.8, color: 0xe8e1d4, offset: 23 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4800, masts: { at: [[112, 78]], height: 46, style: 'pole' } },
      finish: { concrete: 0xc7b597, walls: 0xd2c1a2 },
      // Green artificial grass inside and outside the track.
      runoff: { color: 0x3f8f62, a: 93, b: 49, exponent: 2.3 },
      seatLook: {
        colors: [{ c: '#1d2f6b', w: 5 }, { c: '#22377a', w: 3 }, { c: '#18275a', w: 2 }],
        grain: { along: 6, rows: 40 },
        regions: [
          // The main stand: a green block in the middle at the front…
          { tiers: [2], side: 'south', from: -20, to: 20, rows: [0, 9], colors: ['#2e8a52', '#2a7f4b'] },
          // …terracotta-orange round it, and the back rows dark brown.
          { tiers: [2], rows: [0, 9], colors: ['#c8692c', '#bd6127', '#d0763a'] },
          { tiers: [2], colors: ['#3b302b', '#45372f', '#332a26'] },
        ],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.01, tiers: [2], noTifo: true }],
        screens: [{ centerU: 0.13, widthM: 10, heightM: 4.5, post: { offset: 14, y: 8 } }],
        buildings: [
          // The white blocks of the main stand building, under and behind its roof.
          { side: 'south', straight: true, halfLength: 76, front: 20, depth: 10, y0: 0, y1: 14.5, glassFloors: 1, color: 0xcdb08a, fascia: 0xd9c7a8 },
        ],
      },
    },
    meta: { name: 'Prince Sultan Sport City Stadium (Abha)', source: 'builtin', country: 'Middle East', capacity: 20000, type: 'Oval', inspiredBy: 'Prince Sultan bin Abdulaziz Sport City Stadium, Al-Mahalah, Abha - home of Abha Club', tags: ['abha', 'mahalah', 'asir', 'saudi', 'roshn', 'saudi-pro-league', 'track', 'horseshoe', 'mountains'] },
  },
  {
    // King Khalid Sport City Stadium, Tabuk — NEOM SC's home.
    //
    // Built October 2026 from the satellite picture (Esri, January 2024; the
    // track gives the scale), the August 2025 photographs of the works for
    // NEOM's promotion (Slaati) and the published figures: founded 1985-87,
    // 12,000 seats, about 15,000 with the movable stands added in 2025. A red
    // 8-lane track that stays; the main stand (real west, `south`) curving
    // round it from bend to bend, its seats renewed in greens, under a fan of
    // roof bays; the movable stand opposite it, in blue; a
    // screen on a frame in a corner; four masts with square lamp heads.
    id: 'tabuk-stadium-12k',
    template: {
      id: 'tabuk-stadium-12k',
      name: 'King Khalid Sport City Stadium (Tabuk)',
      version: 1,
      levels: 1,
      plan: { a: 90.5, b: 50, exponent: 2.3 },
      evenRows: true,
      tiers: [
        {
          // The main stand: the ring's south side and the bends either side of it.
          rows: 24, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5,
          omit: [
            { side: 'north', from: -99, to: 99 },
            { side: 'east', from: -15, to: 99 },
            { side: 'west', from: -15, to: 99 },
          ],
        },
        {
          // The movable stand added opposite the main stand in 2025.
          rows: 12, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.0, baseOffset: 2, seatPitch: 0.5, straight: true,
          stands: [{ side: 'north', halfLength: 56 }],
        },
      ],
      aisles: { count: 56, widthMeters: 1.1 },
      sectionsPerTier: 28,
      // A faded red track; the ends inside it the same.
      track: { lanes: 8, surface: 0xc0644c },
      roof: { coverage: 'none' },
      roofs: [
        {
          style: 'sheet', back: 23, front: 3, backY: 17, frontY: 14.5, depth: 1.2, bay: 7, color: 0x8f97a3, underColor: 0xc9ccd0,
          columns: { every: 14, color: 0xd9d6cf, offset: 21.5 },
          omit: [
            { side: 'north', from: -99, to: 99 },
            { side: 'east', from: -12, to: 99 },
            { side: 'west', from: -12, to: 99 },
          ],
        },
      ],
      lighting: { style: 'corner-masts', kelvin: 4800, masts: { at: [[108, 80]], height: 46, style: 'pole' } },
      finish: { concrete: 0xc9bea9, walls: 0xd3c7ae },
      runoff: { color: 0xb8634d, a: 90.5, b: 50, exponent: 2.3 },
      seatLook: {
        colors: [{ c: '#2f6b3f', w: 4 }, { c: '#4f8a3a', w: 3 }, { c: '#8aa83c', w: 1.5 }, { c: '#26552f', w: 2 }],
        regions: [{ tiers: [1], colors: ['#2b5fae', '#2352a0', '#3368b8'] }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.012, tiers: [0], noTifo: true }],
        screens: [{ centerU: 0.62, widthM: 9, heightM: 4.5, post: { offset: 10, y: 9 } }],
        buildings: [
          // The VIP lounge and the press floor at the top of the main stand.
          { side: 'south', halfLength: 24, front: 18.6, depth: 7, y0: 0, y1: 15.5, glassFloors: 1, color: 0xd9cdb4, fascia: 0x2f6b3f },
        ],
      },
    },
    meta: { name: 'King Khalid Sport City Stadium (Tabuk)', source: 'builtin', country: 'Middle East', capacity: 12000, type: 'Oval', inspiredBy: 'King Khalid Sport City Stadium, Tabuk - home of NEOM SC', tags: ['neom', 'tabuk', 'saudi', 'roshn', 'saudi-pro-league', 'track'] },
  },
  {
    // Al-Hazem Club Stadium, Ar Rass — Al-Hazem's home, and Al-Kholood's while
    // their own ground in Ar Rass is rebuilt.
    //
    // Built October 2026 from the satellite picture (Esri, January 2024; the
    // track gives the scale), photographs (Wikimedia Commons) and the
    // published figures: opened 1982, 8,000 by the book, 6,200 numbered seats
    // after the 2019 rebuild. A red track; the main stand (`south`) under a
    // flat roof; curved terraces round one corner and along half of the end
    // beside it; nothing opposite the main stand, where the cameras stand on
    // movable platforms. Four masts.
    id: 'alhazem-stadium-8k',
    template: {
      id: 'alhazem-stadium-8k',
      name: 'Al-Hazem Club Stadium (Ar Rass)',
      version: 1,
      levels: 1,
      plan: { a: 90, b: 49, exponent: 2.3 },
      evenRows: true,
      tiers: [
        {
          // The curved terraces: the south-west corner, and the south-east
          // corner on round the east end to its middle.
          rows: 14, rowDepth: 0.8, rakeDeg: 27, baseElevation: 1.4, baseOffset: 0, seatPitch: 0.5,
          omit: [
            { side: 'north', from: -99, to: 99 },
            { side: 'west', from: -22, to: 99 },
            { side: 'east', from: 2, to: 99 },
            { side: 'south', from: -49, to: 49 },
          ],
        },
        {
          // The main stand.
          rows: 18, rowDepth: 0.8, rakeDeg: 25, baseElevation: 1.2, baseOffset: 0.5, seatPitch: 0.5, straight: true,
          stands: [{ side: 'south', halfLength: 48 }],
        },
      ],
      aisles: { count: 48, widthMeters: 1.1 },
      sectionsPerTier: 24,
      track: { lanes: 8, surface: 0xc0644c },
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -49, to: 49, back: 16.5, front: 1.5, backY: 13.5, frontY: 12.5, depth: 1.0, bay: 8, color: 0xe9e7e2, underColor: 0xcfcfcc, columns: { every: 16, color: 0xdedbd4, offset: 15.5 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4600, masts: { at: [[104, 74]], height: 44, style: 'pole' } },
      finish: { concrete: 0xc9bca4, walls: 0xd6cab2 },
      runoff: { color: 0xb8634d, a: 90, b: 49, exponent: 2.3 },
      seatLook: {
        colors: [{ c: '#24366e', w: 5 }, { c: '#2c4282', w: 3 }],
        regions: [{ tiers: [1], colors: [{ c: '#9a9a96', w: 3 }, { c: '#c8312b', w: 2 }, { c: '#e2b51f', w: 2 }, { c: '#2c4f9a', w: 1 }] }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.012, tiers: [1], noTifo: true }],
        buildings: [{ side: 'south', straight: true, halfLength: 18, front: 15, depth: 6, y0: 0, y1: 11.5, glassFloors: 1, color: 0xe2d8c4, fascia: 0xc8312b }],
      },
    },
    meta: { name: 'Al-Hazem Club Stadium (Ar Rass)', source: 'builtin', country: 'Middle East', capacity: 8000, type: 'Single-tier', inspiredBy: 'Al-Hazem Club Stadium, Ar Rass - home of Al-Hazem and Al-Kholood', tags: ['al-hazem', 'hazem', 'al-kholood', 'kholood', 'ar-rass', 'qassim', 'saudi', 'roshn', 'saudi-pro-league', 'track'] },
  },
  {
    // Al-Majma'ah Sports City Stadium — Al-Fayha's and Al-Faisaly's home.
    //
    // Built October 2026 from the satellite pictures (Bing; the pitch markings
    // give the scale) and the published figures: opened 1990, 6,844 seats for
    // 2026-27 (50 gold, 250 silver, 6,544 standard). A red track; the main
    // stand (`south`) under a white roof; a long low stand opposite it along
    // the track's straight (being rebuilt in concrete through 2026); nothing
    // behind the goals. Four masts.
    id: 'majmaah-stadium-7k',
    template: {
      id: 'majmaah-stadium-7k',
      name: "Al-Majma'ah Sports City Stadium",
      version: 1,
      plan: { a: 90, b: 47.5, exponent: 2.3 },
      evenRows: true,
      tiers: [
        {
          rows: 18, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.4, baseOffset: 0, seatPitch: 0.47, straight: true,
          stands: [
            // The long low stand opposite, right behind the track.
            { side: 'north', halfLength: 70, rows: 13 },
            // The main stand, set back behind the home straight.
            { side: 'south', halfLength: 50, offset: 7.5 },
          ],
        },
      ],
      aisles: { count: 48, widthMeters: 1.1 },
      sectionsPerTier: 24,
      track: { lanes: 8, surface: 0xc0644c },
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', straight: true, from: -51, to: 51, back: 23, front: 8, backY: 13.5, frontY: 12.5, depth: 1.0, bay: 8, color: 0xf2f1ee, underColor: 0xd4d3cf, columns: { every: 16, color: 0xdedbd4, offset: 22 } },
        // A light teal canopy along the back of the long stand opposite.
        { style: 'sheet', side: 'north', straight: true, from: -62, to: 62, back: 11.2, front: 5.5, backY: 9.0, frontY: 8.6, depth: 0.5, bay: 8, color: 0x9fd0cc, underColor: 0x8fc0bc, columns: { every: 16, color: 0xdedbd4, offset: 10.8 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4600, masts: { at: [[104, 72]], height: 44, style: 'pole' } },
      finish: { concrete: 0xc4b9a3, walls: 0xd2c7b0 },
      runoff: { color: 0xb8634d, a: 90, b: 47.5, exponent: 2.3 },
      seatLook: {
        colors: [{ c: '#2f6aa8', w: 4 }, { c: '#e3e5e6', w: 2 }, { c: '#3b7bb8', w: 2 }],
        regions: [{ side: 'south', colors: ['#f0a12b', '#e48f1d', { c: '#2f6aa8', w: 0.6 }] }],
      },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.01, tiers: [0], noTifo: true }],
        buildings: [{ side: 'south', straight: true, halfLength: 22, front: 20.5, depth: 7, y0: 0, y1: 12.5, glassFloors: 1, color: 0xe6e0d4, fascia: 0xf0a12b }],
      },
    },
    meta: { name: "Al-Majma'ah Sports City Stadium", source: 'builtin', country: 'Middle East', capacity: 6844, type: 'Single-tier', inspiredBy: "Al-Majma'ah Sports City Stadium - home of Al-Fayha and Al-Faisaly", tags: ['al-fayha', 'fayha', 'al-faisaly', 'faisaly', 'majmaah', 'saudi', 'roshn', 'saudi-pro-league', 'track'] },
  },
  {
    // Prince Faisal bin Fahd Stadium (Al-Malaz), Riyadh — Al-Riyadh's home.
    //
    // Built October 2026 from the satellite picture (Esri, December 2025), the
    // photographs (StadiumDB) and the published figures: opened 1971, 22,500
    // seats. A blue track inside one oval of blue seats, a second tier over
    // the long side opposite the main stand, the main stand (`south`) under a
    // fan of roof bays, a screen over one end, four floodlight pylons.
    id: 'pfbf-stadium-22k',
    template: {
      id: 'pfbf-stadium-22k',
      name: 'Prince Faisal bin Fahd Stadium (Riyadh)',
      version: 1,
      plan: { a: 94.5, b: 49, exponent: 2.4 },
      evenRows: true,
      tiers: [
        { rows: 20, rowDepth: 0.8, rakeDeg: 26, baseElevation: 1.6, baseOffset: 0, seatPitch: 0.5 },
        {
          // The upper tier opposite the main stand.
          rows: 16, rowDepth: 0.8, rakeDeg: 32, baseElevation: 10.5, baseOffset: 19.5, seatPitch: 0.5,
          stands: [{ side: 'north', halfLength: 75 }],
        },
      ],
      aisles: { count: 60, widthMeters: 1.1 },
      sectionsPerTier: 30,
      track: { lanes: 8, surface: 0x2f55a8 },
      roof: { coverage: 'none' },
      roofs: [
        { style: 'sheet', side: 'south', from: -78, to: 78, back: 21, front: 3, backY: 16, frontY: 14, depth: 1.2, bay: 6.5, color: 0xd9d4c8, underColor: 0xc8c2b4, columns: { every: 13, color: 0xd6d0c2, offset: 20 } },
      ],
      lighting: { style: 'corner-masts', kelvin: 4800, masts: { at: [[118, 84]], height: 50, style: 'pole' } },
      finish: { concrete: 0xc6bba6, walls: 0xcfc4ae },
      runoff: { color: 0x5f8a4c, a: 94.5, b: 49, exponent: 2.4 },
      seatLook: { colors: [{ c: '#3d7ac4', w: 4 }, { c: '#2f69b3', w: 3 }, { c: '#4f8bd0', w: 2 }] },
      details: {
        zones: [{ kind: 'vip', centerU: 0.75, halfU: 0.01, tiers: [0], noTifo: true }],
        screens: [{ centerU: 0.5, widthM: 12, heightM: 5 }],
        buildings: [{ side: 'south', halfLength: 26, front: 16.6, depth: 8, y0: 0, y1: 14, glassFloors: 1, color: 0xd8cdb6, fascia: 0x2f69b3 }],
      },
    },
    meta: { name: 'Prince Faisal bin Fahd Stadium (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 22500, type: 'Oval', inspiredBy: 'Prince Faisal bin Fahd Stadium (Al-Malaz), Riyadh - home of Al-Riyadh', tags: ['al-riyadh', 'riyadh', 'malaz', 'saudi', 'roshn', 'saudi-pro-league', 'track'] },
  },
  {
    // Kingdom Arena, Riyadh — Al-Hilal's fully enclosed home, the largest
    // covered football stadium by area (Guinness, February 2024).
    //
    // Rebuilt October 2026 from the photographs (StadiumDB's set of the ground
    // after the December 2024 expansion) and the published figures: a box
    // 220 x 150 m and 47 m high, four separate straight stands with open
    // corners, 26,700 seats for the public after the expansion (from 18,800),
    // 20 boxes on the main stand and 14 more opposite (34), a four-sided screen
    // hung over the centre and a screen over each end.
    //
    // In the tifo vocabulary: the main stand is south (u = 0.75) — a low lower
    // tier under three floors of glass hospitality; north is the stand the
    // expansion doubled, a deep lower tier, a band of 14 boxes and an upper
    // tier; east and west are the ends, one deep tier each. Nobody publishes a
    // per-stand split, so the rows are fitted to the photographs and to the
    // total.
    //
    // A NEW ID, not a version bump: every design saved on the earlier Kingdom
    // Arena indexes its seats by position. That one lives on in LEGACY below.
    id: 'kingdom-arena-26k',
    template: {
      id: 'kingdom-arena-26k',
      name: 'Kingdom Arena (Riyadh)',
      version: 1,
      // A 105 x 68 m pitch with 7.5 m of run-off all round; the plan is all but
      // a rectangle so the four stands are straight.
      plan: { a: 60, b: 41.5, exponent: 16 },
      evenRows: true,
      tiers: [
        {
          // One rake for the lower tier of all four stands; each stand has its own depth.
          rows: 42, rowDepth: 0.8, rakeDeg: 30, baseElevation: 1.0, baseOffset: 0, seatPitch: 0.45,
          stands: [
            { side: 'east', halfLength: 41, rows: 42 },
            { side: 'west', halfLength: 41, rows: 42 },
            { side: 'north', halfLength: 58, rows: 28 },
            { side: 'south', halfLength: 58, rows: 12 },
          ],
        },
        {
          // The 2024 upper tier, over the band of boxes on the north stand.
          rows: 16, rowDepth: 0.8, rakeDeg: 34, baseElevation: 18.2, baseOffset: 20.6, seatPitch: 0.45,
          stands: [{ side: 'north', halfLength: 54 }],
        },
      ],
      aisles: { count: 40, widthMeters: 1.2 },
      sectionsPerTier: 40,
      // The building is hand-built (simulator/kingdom.ts): no generated roof or facade.
      roof: { coverage: 'none' },
      indoor: true,
      // Rows of LED floodlights hang under the roof trusses over the front of
      // the stands, 28 m up.
      lighting: { style: 'roof-rim', kelvin: 5700, mount: { offset: 3, y: 28 } },
      details: {
        // The 14 boxes the expansion added opposite the main stand, ten seats
        // each, between the lower and upper tier.
        boxes: [{ centerU: 0.25, halfU: 0.0891, underTier: 1, count: 14 }],
        // The main stand's 20 boxes on two floors, each with seats out on a
        // terrace, and the sky lounge across the top.
        hospitality: { side: 'south', halfLength: 50, boxFloors: 2, boxesPerFloor: 10, lounge: true },
        // A screen hung from the roof over the front of each end.
        screens: [
          { centerU: 0, widthM: 12, heightM: 5, hang: { offset: 7, y: 21, ceiling: 26 } },
          { centerU: 0.5, widthM: 12, heightM: 5, hang: { offset: 7, y: 21, ceiling: 26 } },
        ],
        // The four-sided screen over the centre spot.
        centreScreen: { widthM: 14, depthM: 11, heightM: 8, y: 27, ceiling: 34 },
        // Portrait screens on the four corner columns.
        cornerScreens: { widthM: 4, heightM: 9, y: 8, columnTop: 29 },
      },
    },
    meta: { name: 'Kingdom Arena (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 26700, type: 'Arena', inspiredBy: "Kingdom Arena, Riyadh - Al-Hilal's fully covered indoor arena", tags: ['al-hilal', 'riyadh', 'saudi', 'arena', 'covered', 'indoor', 'kingdom', 'hilal', 'roshn', 'saudi-pro-league'] },
  },
];

/** The full catalog. Order: built-ins first, then community, then custom. */
export const STADIUM_CATALOG: StadiumEntry[] = [...BUILTINS, ...COMMUNITY];

/**
 * Stadiums that have been replaced by a more accurate one but that saved
 * designs still point at.
 *
 * A saved design is one byte per seat, indexed by position, so the seat map it
 * was drawn on has to stay exactly as it was. These resolve through
 * templateById like anything else — so a design opens, renders, saves and
 * shares exactly as before — but they are not in the catalogue, so they are
 * never offered. (A hand-typed ?template= link still opens one; that is the
 * same path an old share link takes, and it is harmless.)
 */
export const LEGACY_STADIUMS: StadiumEntry[] = [
  {
    // Al-Awwal Park as it was until October 2026 — replaced by alawwal-park-26k.
    // Keep byte-identical: every design saved on it indexes into this map.
    id: 'community-alawwal-park-25k',
    template: {
      id: 'community-alawwal-park-25k',
      name: 'Al-Awwal Park (Riyadh)',
      version: 1,
      plan: { a: 64, b: 50, exponent: 2.4 },
      evenRows: true,
      tiers: [
        { rows: 16, rowDepth: 0.8, rakeDeg: 28, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 },
        { rows: 12, rowDepth: 0.78, rakeDeg: 35, baseElevation: 10, baseOffset: 16, seatPitch: 0.48 },
      ],
      aisles: { count: 22, widthMeters: 1.1 },
      sectionsPerTier: 22,
      // Roof + perforated skin are hand-built (simulator/stadiumExtras.ts), so
      // no generic facade — the gold skin is already there.
      roof: { coverage: 'none' },
      lighting: { style: 'corner-masts', kelvin: 5000 },
    },
    meta: { name: 'Al-Awwal Park (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 25000, type: 'Two-tier', inspiredBy: 'Al-Awwal Park (King Saud University Stadium), Riyadh - home of Al-Nassr', tags: ['al-nassr', 'riyadh', 'saudi', 'legacy'], supersededBy: 'alawwal-park-26k' },
  },
  {
    // The Jewel as it was until September 2026 — replaced by jewel-jeddah-60k.
    // Keep byte-identical: every design saved on it indexes into this map.
    id: 'community-jewel-jeddah-62k',
    template: {
      id: 'community-jewel-jeddah-62k',
      name: 'The Jewel of Jeddah',
      version: 1,
      plan: { a: 83, b: 73, exponent: 2.15 },
      evenRows: true,
      tiers: [
        { rows: 20, rowDepth: 0.8, rakeDeg: 28, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.48 },
        { rows: 18, rowDepth: 0.78, rakeDeg: 35, baseElevation: 11, baseOffset: 18, seatPitch: 0.48 },
        { rows: 12, rowDepth: 0.76, rakeDeg: 42, baseElevation: 20, baseOffset: 32, seatPitch: 0.48 },
      ],
      aisles: { count: 32, widthMeters: 1.1 },
      sectionsPerTier: 32,
      roof: { coverage: 'none' },
      lighting: { style: 'roof-rim' },
    },
    meta: { name: 'The Jewel of Jeddah', source: 'builtin', country: 'Middle East', capacity: 62241, type: 'Bowl', inspiredBy: 'King Abdullah Sports City (Alinma Stadium), Jeddah - nicknamed "The Shining Jewel"', tags: ['jewel', 'jeddah', 'saudi', 'legacy'], supersededBy: 'jewel-jeddah-60k' },
  },
  {
    // Kingdom Arena as it was until October 2026 — replaced by kingdom-arena-26k.
    // Keep byte-identical: every design saved on it indexes into this map.
    id: 'community-kingdom-arena-28k',
    template: {
      id: 'community-kingdom-arena-28k',
      name: 'Kingdom Arena (Riyadh)',
      version: 1,
      plan: { a: 66, b: 50, exponent: 4.6 },
      // Box arena: open the four corners so the bowl reads as four straight
      // stands (sidelines reach the goal lines, ends cover the pitch width).
      cornerCut: 0.8,
      evenRows: true,
      tiers: [
        { rows: 16, rowDepth: 0.76, rakeDeg: 34, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.47 },
        { rows: 12, rowDepth: 0.74, rakeDeg: 40, baseElevation: 10, baseOffset: 14, seatPitch: 0.47 },
      ],
      aisles: { count: 20, widthMeters: 1.0 },
      sectionsPerTier: 20,
      // Indoor arena: walls and ceiling are hand-built (simulator/stadiumExtras.ts).
      // Fully covered: the lights are on the roof structure, which is what a
      // rim array is. The hand-built shell (simulator/stadiumExtras.ts) is the
      // facade here.
      roof: { coverage: 'none' },
      lighting: { style: 'roof-rim' },
    },
    meta: { name: 'Kingdom Arena (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 28000, type: 'Arena', inspiredBy: "Kingdom Arena, Riyadh - Al-Hilal's fully covered indoor arena", tags: ['al-hilal', 'riyadh', 'saudi', 'arena', 'legacy'], supersededBy: 'kingdom-arena-26k' },
  },
];

/**
 * Every template that ships in the bundle and can be saved against: the
 * built-in catalogue plus the legacy grounds. What the server validates seat
 * counts against — it used to know only the three generic bowls, so a design
 * on any real-venue ground could not be saved at all.
 */
export function shippedTemplates(): StadiumTemplate[] {
  return [...BUILTINS, ...COMMUNITY, ...LEGACY_STADIUMS].map((e) => e.template);
}

/** Every template the generator might be asked for (built-in + community + custom). */
export function allTemplates(): StadiumTemplate[] {
  return STADIUM_CATALOG.map((e) => e.template);
}

/**
 * Replace the catalog's 'custom' entries (user-authored, loaded from storage at
 * boot). Mutates the live array in place so templateById/queryCatalog/allTemplates
 * pick them up everywhere without re-importing.
 */
export function registerCustomStadiums(entries: StadiumEntry[]): void {
  for (let i = STADIUM_CATALOG.length - 1; i >= 0; i--) {
    if (STADIUM_CATALOG[i].meta.source === 'custom') STADIUM_CATALOG.splice(i, 1);
  }
  STADIUM_CATALOG.push(...entries.filter((e) => e.meta.source === 'custom'));
}

/** Replace catalog entries fetched from the server's approved-community endpoint. */
/**
 * Replace the server-fetched community stadiums.
 *
 * Note what is NOT community: the templates hard-coded above. They ship in the
 * bundle and we wrote them, and they were tagged `community` only because that
 * tag was doubling as "show the non-affiliation disclaimer". It does not any
 * more — the disclaimer follows `inspiredBy`, which is the field that actually
 * says a template resembles a real venue — so they are `builtin`, which is what
 * they always were. Ten of the thirteen shipped grounds were hidden behind a
 * Community tab because of that conflation.
 */
export function registerServerCommunity(entries: StadiumEntry[]): void {
  for (let i = STADIUM_CATALOG.length - 1; i >= 0; i--) {
    if (STADIUM_CATALOG[i].meta.tags?.includes('community-server')) STADIUM_CATALOG.splice(i, 1);
  }
  STADIUM_CATALOG.push(...entries);
}

/** Resolve an id to its template (used by the seat-map worker + loaders). */
export function templateById(id: string): StadiumTemplate | undefined {
  return (STADIUM_CATALOG.find((e) => e.id === id) ?? LEGACY_STADIUMS.find((e) => e.id === id))?.template;
}

/** Resolve an id to its full catalog entry (template + metadata). */
export function entryById(id: string): StadiumEntry | undefined {
  return STADIUM_CATALOG.find((e) => e.id === id) ?? LEGACY_STADIUMS.find((e) => e.id === id);
}

export interface CatalogQuery {
  source?: StadiumSource;
  /** Free-text over name/country/tags/inspiredBy. */
  search?: string;
  country?: string;
  type?: StadiumType;
  minCapacity?: number;
  maxCapacity?: number;
  tiers?: number;
  /** Only entries whose id is in this set (e.g. favourites). */
  ids?: Set<string>;
}

/** Filter + search the catalog. Foundation for the panel's search/filter (Wave B). */
export function queryCatalog(q: CatalogQuery = {}, catalog: StadiumEntry[] = STADIUM_CATALOG): StadiumEntry[] {
  const needle = q.search?.trim().toLowerCase();
  return catalog.filter((e) => {
    if (q.source && e.meta.source !== q.source) return false;
    if (q.ids && !q.ids.has(e.id)) return false;
    if (q.country && (e.meta.country ?? '').toLowerCase() !== q.country.toLowerCase()) return false;
    if (q.type && e.meta.type !== q.type) return false;
    if (q.tiers !== undefined && tierCount(e.template) !== q.tiers) return false;
    if (q.minCapacity !== undefined && (e.meta.capacity ?? 0) < q.minCapacity) return false;
    if (q.maxCapacity !== undefined && (e.meta.capacity ?? Infinity) > q.maxCapacity) return false;
    if (needle) {
      const hay = [e.meta.name, e.meta.country, e.meta.inspiredBy, ...(e.meta.tags ?? [])].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Distinct countries present in the catalog (for filter dropdowns). */
export function catalogCountries(catalog: StadiumEntry[] = STADIUM_CATALOG): string[] {
  return [...new Set(catalog.map((e) => e.meta.country).filter((c): c is string => !!c))].sort();
}
