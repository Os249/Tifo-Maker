/**
 * Favourite stadiums — persisted across sessions in localStorage.
 *
 * A plain set of catalog ids. Kept tiny and resilient: any storage error degrades
 * to an in-memory set for the session rather than throwing. The Stadium panel
 * holds the live set and calls toggle/save; this module owns the persistence.
 */

const KEY = 'tifo_stadium_favorites';

export function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — favourites stay in memory for this session */
  }
}

/** Return a NEW set with `id` toggled, and persist it. */
export function toggleFavorite(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  saveFavorites(next);
  return next;
}
