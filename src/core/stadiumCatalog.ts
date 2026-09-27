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
  return t.tiers.length;
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
    meta: { name: 'The Jewel of Jeddah', source: 'builtin', country: 'Middle East', capacity: 60241, type: 'Bowl', inspiredBy: 'King Abdullah Sports City (Alinma Stadium), Jeddah - nicknamed "The Shining Jewel"', tags: ['jewel', 'jeddah', 'alinma', 'saudi', 'three-tier', 'bowl', 'large', 'world-cup-2034'] },
  },
  {
    // Tribute to Al-Awwal Park (King Saud University Stadium), Riyadh - Al-Nassr's
    // home. Open two-tier ground with a gold perforated metal skin and a roof that
    // bends over the West (main) stand. ~25,000.
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
    meta: { name: 'Al-Awwal Park (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 25000, type: 'Two-tier', inspiredBy: 'Al-Awwal Park (King Saud University Stadium), Riyadh - home of Al-Nassr', tags: ['al-nassr', 'riyadh', 'saudi', 'two-tier', 'gold', 'open'] },
  },
  {
    // Tribute to Kingdom Arena, Riyadh - Al-Hilal's fully covered indoor arena, the
    // largest covered football stadium. Enclosed rectangular box, closed roof, a
    // four-sided screen hung over the centre. ~28,000.
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
    meta: { name: 'Kingdom Arena (Riyadh)', source: 'builtin', country: 'Middle East', capacity: 28000, type: 'Arena', inspiredBy: "Kingdom Arena, Riyadh - Al-Hilal's fully covered indoor arena", tags: ['al-hilal', 'riyadh', 'saudi', 'arena', 'covered', 'indoor'] },
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
