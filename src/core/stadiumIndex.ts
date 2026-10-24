import type { StadiumMeta } from './stadiumCatalog';
import { INDEX_GROUNDS } from './stadiumIndex.data';
import { LEAGUES, matchesQuery, type CatalogQuery } from './stadiumQuery';

/**
 * The catalogue's grounds without their geometry (performance plan P2.7):
 * ids, names, leagues, cities, capacities, and the tier and section counts a
 * ground's card shows. What a list of grounds and a search over them need,
 * for a fraction of the catalogue (about 7 KB gzipped against 42 KB, and
 * nothing to work out as it loads).
 *
 * Generated from the catalogue (scripts/stadium-index.mts), so the two say
 * the same; scripts/verify.mts checks it. The section count is the one a
 * ground's seats make (stadiumCatalog.sectionCount), which for a ground in
 * its real blocks means placing every seat: done once, when the index is
 * made, rather than on a phone each time a ground is picked.
 *
 * The grounds only: legacy layouts are never listed, and custom and community
 * grounds are not in it (the editor's stadium panel lists those from the full
 * catalogue). A ground's geometry is core/stadiumLoad.ts.
 */
export interface StadiumIndexEntry {
  id: string;
  /** stadiumCatalog.tierCount of its template. */
  tiers: number;
  /** stadiumCatalog.sectionCount of its template. */
  sections: number;
  meta: StadiumMeta;
}

export { LEAGUES };
export type { CatalogQuery };

/** Every catalogue ground, in catalogue order. */
export const STADIUM_INDEX: readonly StadiumIndexEntry[] = INDEX_GROUNDS;

let byId: Map<string, StadiumIndexEntry> | null = null;
/** A ground's index entry by id, or undefined (a legacy, custom or unknown id). */
export function indexEntry(id: string): StadiumIndexEntry | undefined {
  byId ??= new Map(STADIUM_INDEX.map((e) => [e.id, e]));
  return byId.get(id);
}

/** Filter and search the index, as stadiumCatalog.queryCatalog does the catalogue. */
export function queryIndex(q: CatalogQuery = {}, list: readonly StadiumIndexEntry[] = STADIUM_INDEX): StadiumIndexEntry[] {
  return list.filter((e) => matchesQuery(e, q, () => e.tiers));
}
