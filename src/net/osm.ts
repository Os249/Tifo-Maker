/**
 * Looking a stadium up in OpenStreetMap, from the browser.
 *
 * OSM is the only free, global source of stadium FOOTPRINTS and often their
 * capacity too (see claude/stadium-geometry-sources.md). Overpass is queried
 * directly from the user's browser rather than through our server: it is a
 * public read-only API, it sends CORS headers, and proxying it would put us in
 * the path of somebody else's rate limit for no benefit.
 *
 * ODbL requires attribution wherever this data is shown — OSM_ATTRIBUTION below,
 * and the import panel prints it.
 */

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** [lon, lat], the order the fitter wants. */
export type LonLat = [number, number];

export interface OsmStadium {
  /** OSM element id, for citing what we used. */
  id: number;
  name: string;
  /** The footprint way, closed. */
  ring: LonLat[];
  /** Capacity, if OSM carries one. Often it does not. */
  capacity?: number;
  tags: Record<string, string>;
}

/**
 * Mirrors, tried in order.
 *
 * The main instance rate-limits and answers 504 under load — it did so twice
 * while this was being written — and a stadium lookup that fails because someone
 * else is busy is not a failure worth showing the user.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query: string, signal?: AbortSignal): Promise<{ elements?: OverpassElement[] }> {
  let lastError: unknown = null;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) { lastError = new Error(`Overpass ${res.status}`); continue; }
      const text = await res.text();
      // A busy instance answers 200 with an XML error document, so the status
      // code alone does not mean there is JSON to parse.
      if (!text.trimStart().startsWith('{')) { lastError = new Error('Overpass returned no JSON'); continue; }
      return JSON.parse(text) as { elements?: OverpassElement[] };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass unreachable');
}

interface OverpassElement {
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** Rough planar area of a ring, for picking the stadium over a kiosk beside it. */
function span(ring: LonLat[]): number {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = ring.map((p) => p[0] * kx);
  const ys = ring.map((p) => p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

function toStadium(el: OverpassElement): OsmStadium | null {
  if (!el.geometry || el.geometry.length < 8) return null;
  const tags = el.tags ?? {};
  const cap = Number(tags.capacity ?? tags['seating:capacity'] ?? 0);
  return {
    id: el.id,
    name: tags['name:en'] ?? tags.name ?? 'Unnamed ground',
    ring: el.geometry.map((g) => [g.lon, g.lat] as LonLat),
    capacity: Number.isFinite(cap) && cap > 0 ? cap : undefined,
    tags,
  };
}

/**
 * Find stadiums by name, biggest footprint first.
 *
 * Matches `name`, `name:en` and `int_name` case-insensitively, because a ground
 * in Amman or Riyadh is usually tagged in Arabic with the English name second,
 * and a user searching in either language should find it.
 */
export async function findStadiums(name: string, signal?: AbortSignal): Promise<OsmStadium[]> {
  const q = name.trim().replace(/["\\]/g, '');
  if (q.length < 3) return [];
  const query = `[out:json][timeout:45];
(
  way["leisure"="stadium"]["name"~"${q}",i];
  way["leisure"="stadium"]["name:en"~"${q}",i];
  way["leisure"="stadium"]["int_name"~"${q}",i];
  way["building"="stadium"]["name"~"${q}",i];
);
out tags geom 12;`;
  const data = await overpass(query, signal);
  const found = (data.elements ?? []).map(toStadium).filter((s): s is OsmStadium => s !== null);
  // Biggest first: a stadium's own way, not a car park or a kiosk sharing its name.
  return found.sort((a, b) => span(b.ring) - span(a.ring));
}

/** Fetch one known way by id, for re-importing a ground we have cited before. */
export async function fetchStadiumWay(wayId: number, signal?: AbortSignal): Promise<OsmStadium | null> {
  const data = await overpass(`[out:json][timeout:45];way(${wayId});out tags geom;`, signal);
  const el = (data.elements ?? [])[0];
  return el ? toStadium(el) : null;
}
