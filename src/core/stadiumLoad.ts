import type { StadiumEntry } from './stadiumCatalog';
import type { StadiumTemplate } from './types';
import { GROUND_GROUPS } from './stadiumGroups.data';

/**
 * One ground's geometry, by id, without the rest of the catalogue
 * (performance plan P2.7).
 *
 * A share link (/t) and the match-day seat page (/s) show one design on one
 * ground. They used to load the whole catalogue for it: 42 KB gzipped, every
 * league's grounds, the second-largest script either page had. The grounds
 * are kept in one module per league (core/coreGrounds.ts for the
 * catalogue's own, core/worldLeagues.ts for five smaller leagues together), so
 * a page asks for the ground and gets its league's module only. The full
 * catalogue is made of these same modules, so the entry, and its template
 * object, is the very one templateById returns.
 *
 * Which module holds which ground is generated with the index
 * (scripts/stadium-index.mts). A ground that is not in it, a custom or a
 * community one, or one added since it was made, is looked up in the full
 * catalogue instead: slower, never wrong.
 */
export type GroundGroup = 'core' | 'premier' | 'laliga' | 'ligue1' | 'superLig' | 'botola' | 'algeria' | 'thai';

const LOAD: Record<GroundGroup, () => Promise<readonly StadiumEntry[]>> = {
  core: () => import('./coreGrounds').then((m) => [...m.BUILTINS_LIVE, ...m.COMMUNITY_LIVE, ...m.LEGACY_STADIUMS]),
  premier: () => import('./premierLeague').then((m) => m.PREMIER_LEAGUE),
  laliga: () => import('./laLiga').then((m) => m.LA_LIGA),
  // Five smaller leagues, one script (core/worldLeagues.ts).
  ligue1: () => import('./worldLeagues').then((m) => m.LIGUE_1),
  superLig: () => import('./worldLeagues').then((m) => m.SUPER_LIG),
  botola: () => import('./worldLeagues').then((m) => m.BOTOLA),
  algeria: () => import('./worldLeagues').then((m) => m.ALGERIA_LIGUE_1),
  thai: () => import('./worldLeagues').then((m) => m.THAI_LEAGUE),
};

let groupOf: Map<string, GroundGroup> | null = null;
function groupFor(id: string): GroundGroup | undefined {
  if (!groupOf) {
    groupOf = new Map();
    for (const g of Object.keys(GROUND_GROUPS) as GroundGroup[]) for (const gid of GROUND_GROUPS[g]) groupOf.set(gid, g);
  }
  return groupOf.get(id);
}

/** The shipped entry (catalogue or legacy) with this id, from its own module; undefined if that module does not have it. */
async function shippedEntry(id: string): Promise<StadiumEntry | undefined> {
  const g = groupFor(id);
  if (!g) return undefined;
  const list = await LOAD[g]();
  return list.find((e) => e.id === id);
}

/**
 * A ground's template by id, any ground templateById knows: a shipped one
 * from its league's module, anything else from the full catalogue.
 */
export async function loadTemplate(id: string): Promise<StadiumTemplate | undefined> {
  const e = await shippedEntry(id);
  if (e) return e.template;
  return (await import('./stadiumCatalog')).templateById(id);
}

/**
 * Is this exactly one of the templates we ship? By identity, as
 * stadiumCatalog.isShippedTemplate: a copy with a shipped id is not one. The
 * seat-map client asks this before building a map, and validates anything
 * that is not (P1.16).
 */
export async function isShipped(t: StadiumTemplate): Promise<boolean> {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string') return false;
  const e = await shippedEntry(t.id);
  if (e) return e.template === t;
  // A custom ground is never one of ours (core/customStadiums.ts names them so).
  if (t.id.startsWith('custom-')) return false;
  // A community ground, or one the generated list does not have yet: the
  // full catalogue knows.
  return (await import('./stadiumCatalog')).isShippedTemplate(t);
}
