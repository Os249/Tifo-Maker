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
 * Pure and DOM-free: it runs on the main thread, on the server and in tests,
 * so id→template resolution is identical everywhere.
 *
 * Lighter ways in (performance plan P2.7). This module is every ground with
 * its geometry, and a page that lists grounds or shows one should not load
 * it: core/stadiumIndex.ts has the names, leagues and capacities lists need,
 * and core/stadiumLoad.ts loads one ground's geometry (its league's module)
 * by id. Each ground's template is built the first time it is read
 * (core/lazyEntry.ts), and it is the same object whichever way in it came
 * by: this module is made of those same league modules.
 */

import type { StadiumTemplate } from './types';
import { BUILTINS_LIVE, COMMUNITY_LIVE, LEGACY_STADIUMS } from './coreGrounds';
import { PREMIER_LEAGUE } from './premierLeague';
import { LA_LIGA } from './laLiga';
import { LIGUE_1, SUPER_LIG, BOTOLA, ALGERIA_LIGUE_1, THAI_LEAGUE } from './worldLeagues';
import { hasBlocks } from './blocks';
import { generateSeatMap } from './seatmap';
import { realBlocksFor } from './realBlocks';
import { LEAGUES, matchesQuery, type CatalogQuery } from './stadiumQuery';

// Re-exported where they always were (performance plan P2.7 moved them).
export { LEGACY_STADIUMS, LEAGUES };
export type { CatalogQuery };

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
  /**
   * What changed, for the note offering the newer ground (an i18n key).
   * Omitted: the general note about the rebuilt Saudi grounds.
   */
  supersededNote?: string;
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
const blockCounts = new WeakMap<StadiumTemplate, number>();
export function sectionCount(t: StadiumTemplate): number {
  // A ground in its real blocks has as many as its stairs, walkways and
  // stands make, which only placing the seats tells you. Counted once.
  if (hasBlocks(t)) {
    let n = blockCounts.get(t);
    if (n === undefined) {
      const m = generateSeatMap(t);
      n = 0;
      for (let i = 0; i < m.count; i++) n = Math.max(n, m.sectionOf[i] + 1);
      blockCounts.set(t, n);
    }
    return n;
  }
  return t.sectionsPerTier * t.tiers.length;
}

// The leagues' grounds are laid out in their real blocks in their own modules,
// from the start. The real-blocks rebuild of an earlier layout (realBlocks.ts)
// is done where those earlier layouts live (coreGrounds.ts): a page that loads
// one league for one ground (stadiumLoad.ts) must get exactly the entry this
// catalogue has, so a rebuild may not be added to a league's ground here
// without moving it there. Checked as the catalogue loads: on the server's
// boot, in the build's tests, everywhere.
function asShipped(list: StadiumEntry[]): StadiumEntry[] {
  for (const e of list) if (realBlocksFor(e.id)) throw new Error(`${e.id}: a real-blocks rebuild of a league ground belongs in coreGrounds.ts`);
  return list;
}
const PREMIER_LEAGUE_LIVE = asShipped(PREMIER_LEAGUE);
const LA_LIGA_LIVE = asShipped(LA_LIGA);
// The ultras' grounds of five more countries (October 2026), each laid out in
// its real blocks from the start, so none has an earlier layout.
const WORLD_LIVE = asShipped([...LIGUE_1, ...SUPER_LIG, ...BOTOLA, ...ALGERIA_LIGUE_1, ...THAI_LEAGUE]);

/** The full catalog. Order: built-ins first, then community, then custom. */
export const STADIUM_CATALOG: StadiumEntry[] = [...BUILTINS_LIVE, ...COMMUNITY_LIVE, ...PREMIER_LEAGUE_LIVE, ...LA_LIGA_LIVE, ...WORLD_LIVE];

/**
 * Every template that ships in the bundle and can be saved against: the
 * built-in catalogue plus the legacy grounds. What the server validates seat
 * counts against — it used to know only the three generic bowls, so a design
 * on any real-venue ground could not be saved at all.
 */
export function shippedTemplates(): StadiumTemplate[] {
  return [...BUILTINS_LIVE, ...COMMUNITY_LIVE, ...PREMIER_LEAGUE_LIVE, ...LA_LIGA_LIVE, ...WORLD_LIVE, ...LEGACY_STADIUMS].map((e) => e.template);
}

/**
 * Is this exactly one of the templates we ship (the catalogue or a legacy
 * ground), as opposed to a custom or community one registered at run time?
 * By identity, not id: a copy with a shipped id is not trusted for it. The
 * seat-map worker client checks the others before building them (P1.16).
 *
 * The shipped entry with the template's id is looked up and its template
 * compared, rather than every shipped template being built into a set on the
 * first question (P2.7): that built all 104 grounds on the first seat map.
 */
let shippedById: Map<string, StadiumEntry[]> | null = null;
export function isShippedTemplate(t: StadiumTemplate): boolean {
  if (!shippedById) {
    shippedById = new Map();
    for (const e of [...BUILTINS_LIVE, ...COMMUNITY_LIVE, ...PREMIER_LEAGUE_LIVE, ...LA_LIGA_LIVE, ...WORLD_LIVE, ...LEGACY_STADIUMS]) {
      const same = shippedById.get(e.id);
      if (same) same.push(e);
      else shippedById.set(e.id, [e]);
    }
  }
  return !!t && (shippedById.get(t.id)?.some((e) => e.template === t) ?? false);
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

/**
 * The layout a design on this ground would move to: the ground's newest,
 * following `supersededBy` on through every rebuild (the Jewel's 2025 build was
 * replaced in September 2026, and that one by its real blocks in October), so
 * a design is never offered a layout that is itself superseded. Undefined for
 * a ground that is current.
 */
export function newestLayout(id: string): StadiumEntry | undefined {
  let e = entryById(id);
  const seen = new Set<string>();
  let newest: StadiumEntry | undefined;
  while (e?.meta.supersededBy && !seen.has(e.id)) {
    seen.add(e.id);
    const next = entryById(e.meta.supersededBy);
    if (!next) break;
    newest = next;
    e = next;
  }
  return newest;
}

/** Filter + search the catalog. Foundation for the panel's search/filter (Wave B). */
export function queryCatalog(q: CatalogQuery = {}, catalog: StadiumEntry[] = STADIUM_CATALOG): StadiumEntry[] {
  return catalog.filter((e) => matchesQuery(e, q, () => tierCount(e.template)));
}

/** Distinct countries present in the catalog (for filter dropdowns). */
export function catalogCountries(catalog: StadiumEntry[] = STADIUM_CATALOG): string[] {
  return [...new Set(catalog.map((e) => e.meta.country).filter((c): c is string => !!c))].sort();
}
