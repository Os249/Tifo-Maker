import type { StadiumEntry, StadiumMeta } from './stadiumCatalog';
import type { StadiumTemplate } from './types';

/**
 * A catalogue entry whose template is built the first time it is read
 * (performance plan P2.7).
 *
 * Grounds laid out in their real blocks are worked out from their stairs,
 * walkways and corners (core/realBlocks.ts), and the catalogue used to do it
 * for every one of them as it loaded: on the main thread of almost every page,
 * about 0.3 s of a phone's CPU before anything else could run, for a page that
 * shows one ground or none. The name, capacity and tags a list needs are
 * plain data and stay so; the geometry waits until something asks for it, and
 * is then the very same object every time it is asked (seat maps and the
 * server's seat table are built from it, so it must never be rebuilt).
 */
let builds = 0;
/** How many grounds have been built so far (scripts/verify.mts checks an import builds none). */
export function lazyEntryBuilds(): number {
  return builds;
}

export function lazyEntry(id: string, meta: StadiumMeta, build: () => StadiumTemplate): StadiumEntry {
  let built: StadiumTemplate | null = null;
  return {
    id,
    meta,
    get template(): StadiumTemplate {
      if (!built) {
        const t = build();
        if (t.id !== id) throw new Error(`${id}: its template has the id ${t.id}`);
        built = t;
        builds++;
      }
      return built;
    },
  };
}
