import type { StadiumMeta, StadiumSource, StadiumType } from './stadiumCatalog';

/**
 * Searching and filtering grounds, shared by the full catalogue
 * (core/stadiumCatalog.ts) and the small index the lists use
 * (core/stadiumIndex.ts), so the two can never disagree about what a search
 * finds (performance plan P2.7). No geometry here.
 */

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
  /** Only one league's grounds, by its tag (see LEAGUES). */
  league?: string;
}

/**
 * The leagues whose every home ground is in the catalogue, by the tag their
 * grounds carry. Order is the order the stadium panel lists them in.
 */
export const LEAGUES: { tag: string; key: string }[] = [
  { tag: 'saudi-pro-league', key: 'sp.league.saudi' },
  { tag: 'premier-league', key: 'sp.league.premier' },
  { tag: 'laliga', key: 'sp.league.laliga' },
  { tag: 'ligue-1', key: 'sp.league.ligue1' },
  { tag: 'super-lig', key: 'sp.league.superLig' },
  { tag: 'botola', key: 'sp.league.botola' },
  { tag: 'algeria-ligue-1', key: 'sp.league.algeria' },
  { tag: 'thai-league', key: 'sp.league.thai' },
];

/**
 * Does a ground match a query? `tiers` is asked for only when the query
 * filters on it (the full catalogue counts them from the geometry).
 */
export function matchesQuery(e: { id: string; meta: StadiumMeta }, q: CatalogQuery, tiers: () => number): boolean {
  const needle = q.search?.trim().toLowerCase();
  if (q.source && e.meta.source !== q.source) return false;
  if (q.ids && !q.ids.has(e.id)) return false;
  if (q.league && !(e.meta.tags ?? []).includes(q.league)) return false;
  if (q.country && (e.meta.country ?? '').toLowerCase() !== q.country.toLowerCase()) return false;
  if (q.type && e.meta.type !== q.type) return false;
  if (q.tiers !== undefined && tiers() !== q.tiers) return false;
  if (q.minCapacity !== undefined && (e.meta.capacity ?? 0) < q.minCapacity) return false;
  if (q.maxCapacity !== undefined && (e.meta.capacity ?? Infinity) > q.maxCapacity) return false;
  if (needle) {
    const hay = [e.meta.name, e.meta.country, e.meta.inspiredBy, ...(e.meta.tags ?? [])].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}
