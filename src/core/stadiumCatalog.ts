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
    },
    meta: { name: 'Grand National Bowl', source: 'community', country: 'International', capacity: 80000, type: 'Two-tier', inspiredBy: 'a large national stadium', tags: ['large', 'national', 'two-tier'] },
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
    },
    meta: { name: 'Steep Cauldron', source: 'community', country: 'Europe', capacity: 55000, type: 'Two-tier', inspiredBy: 'a steep atmospheric club ground', tags: ['steep', 'atmosphere', 'compact'] },
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
    },
    meta: { name: 'Compact Wall', source: 'community', country: 'Europe', capacity: 30000, type: 'Single-tier', inspiredBy: 'a single-tier terrace wall', tags: ['single-tier', 'wall', 'compact'] },
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
    },
    meta: { name: 'Desert Arena', source: 'community', country: 'Middle East', capacity: 68000, type: 'Two-tier', inspiredBy: 'a modern desert-region arena', tags: ['modern', 'two-tier', 'large'] },
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
    },
    meta: { name: 'Roaring Terraces', source: 'community', country: 'South America', capacity: 48000, type: 'Single-tier', inspiredBy: 'a single-tier terraced ground', tags: ['single-tier', 'steep', 'atmosphere'] },
  },
];

/** The full catalog. Order: built-ins first, then community, then custom. */
export const STADIUM_CATALOG: StadiumEntry[] = [...BUILTINS, ...COMMUNITY];

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

/** Resolve an id to its template (used by the seat-map worker + loaders). */
export function templateById(id: string): StadiumTemplate | undefined {
  return STADIUM_CATALOG.find((e) => e.id === id)?.template;
}

/** Resolve an id to its full catalog entry (template + metadata). */
export function entryById(id: string): StadiumEntry | undefined {
  return STADIUM_CATALOG.find((e) => e.id === id);
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
