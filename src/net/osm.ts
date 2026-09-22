/**
 * Looking a stadium up in OpenStreetMap, from the browser.
 *
 * OSM is the only free, global source of stadium FOOTPRINTS and often their
 * capacity too (see claude/stadium-geometry-sources.md). Both services below are
 * queried directly from the user's browser rather than through our server: they
 * are public read-only APIs, they send CORS headers, and proxying them would put
 * us in the path of somebody else's rate limit for no benefit.
 *
 * ODbL requires attribution wherever this data is shown — OSM_ATTRIBUTION below,
 * and the import panel prints it.
 *
 * ---------------------------------------------------------------------------
 * WHY NOMINATIM SEARCHES AND OVERPASS ONLY FETCHES
 *
 * This file used to search by running a case-insensitive name REGEX across the
 * planet on Overpass:
 *
 *     way["leisure"="stadium"]["name"~"Anfield",i];  ... four clauses ...
 *
 * Measured against the live API in September 2026, that query:
 *
 *   - took 48.8 s and returned ZERO elements for "Anfield" — a ground that is
 *     in OSM, correctly tagged, with its capacity;
 *   - returned 504 on the next attempt, and 429 the time after that;
 *   - returned HTTP 400 in 371 ms for any name containing a regex metacharacter,
 *     because only " and \ were stripped and everything else went into the
 *     regex verbatim.
 *
 * Overpass is not a search engine and a name regex cannot use its index. The
 * same lookup through Nominatim — which IS OSM's search engine, and is indexed
 * for exactly this — answers in 178 ms and hands back the footprint polygon AND
 * the capacity tag in a single response.
 *
 * So Nominatim finds the ground. When a match comes back without a polygon —
 * which happens in its category-restricted mode — the outline is fetched by id,
 * from Nominatim's own /lookup endpoint first (691 ms for two elements, with
 * their capacity tags) and from Overpass only if that fails. Overpass is the
 * backstop, not the path.
 *
 * Nominatim's usage policy allows this shape of traffic — a human typing a name
 * and pressing a button — at no more than one request a second, which THROTTLE
 * below enforces. Anything heavier than a fan looking up their own ground would
 * need a self-hosted instance.
 */

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** [lon, lat], the order the fitter wants. */
export type LonLat = [number, number];

export interface OsmStadium {
  /** OSM element id, for citing what we used. */
  id: number;
  /** Which OSM table that id is in — a citation of "way 123" is wrong for a relation. */
  osmType: 'way' | 'relation' | 'node';
  name: string;
  /** Town and country, so two grounds of the same name can be told apart. */
  where?: string;
  /** The footprint ring, closed. */
  ring: LonLat[];
  /** Capacity, if OSM carries one. Often it does not. */
  capacity?: number;
  tags: Record<string, string>;
}

/**
 * Why a lookup failed, so the panel can say something true.
 *
 * The old code showed "OpenStreetMap is not answering" for every failure
 * including our own malformed query, which is both a lie and useless advice:
 * the user retries, and it fails identically.
 */
export type OsmFailure = 'offline' | 'busy' | 'timeout';

export class OsmError extends Error {
  constructor(readonly kind: OsmFailure, message: string) {
    super(message);
    this.name = 'OsmError';
  }
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * Overpass mirrors, tried in order, for id lookups only.
 *
 * The main instance rate-limits and answers 504 under load, so a second mirror
 * is worth having even for the cheap queries.
 */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Nominatim asks for at most one request a second. Serialise and space them. */
let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = Math.max(0, 1100 - (Date.now() - lastCall));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * A fetch that actually gives up.
 *
 * Neither service guarantees a response, and the panel previously had no
 * client-side deadline at all: a stalled request left the button disabled and
 * the user staring at "Searching…" indefinitely.
 */
async function fetchWithDeadline(url: string, ms: number, signal?: AbortSignal, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuter = (): void => ctrl.abort();
  signal?.addEventListener('abort', onOuter);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    // The caller aborting is not a failure; a deadline is.
    if (signal?.aborted) throw e;
    if ((e as Error)?.name === 'AbortError') throw new OsmError('timeout', `No answer within ${ms} ms`);
    throw new OsmError('offline', String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

// ---- Nominatim ------------------------------------------------------------

interface NominatimHit {
  osm_type?: string;
  osm_id?: number;
  class?: string;
  category?: string;
  type?: string;
  name?: string;
  display_name?: string;
  extratags?: Record<string, string> | null;
  namedetails?: Record<string, string> | null;
  geojson?: { type: string; coordinates: unknown } | null;
}

/**
 * How much we want a given result, before area is considered.
 *
 * Nominatim ranks by text relevance, which is right for an address and wrong
 * here: searching "Camp Nou" returns a meadow, a hotel and a railway node above
 * the ground itself. A stadium is what was asked for, so a stadium wins.
 */
function kindScore(hit: NominatimHit): number {
  const cls = hit.class ?? hit.category ?? '';
  const typ = hit.type ?? '';
  if (typ === 'stadium') return 3; // leisure=stadium or building=stadium
  if (cls === 'leisure' && (typ === 'sports_centre' || typ === 'track')) return 2;
  if (cls === 'leisure' && typ === 'pitch') return 1;
  if (cls === 'building') return 1;
  return 0;
}

/** Largest ring of a GeoJSON Polygon / MultiPolygon, or null for anything else. */
function ringOf(geo: NominatimHit['geojson']): LonLat[] | null {
  if (!geo) return null;
  const big = (rings: LonLat[][]): LonLat[] | null =>
    rings.filter((r) => Array.isArray(r) && r.length >= 6).sort((a, b) => area(b) - area(a))[0] ?? null;
  if (geo.type === 'Polygon') return big(geo.coordinates as LonLat[][]);
  if (geo.type === 'MultiPolygon') return big((geo.coordinates as LonLat[][][]).map((p) => p[0]));
  return null;
}

/** Planar area of a ring in square metres — good enough to rank by size. */
function area(ring: LonLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(a / 2);
}

/** Second and third parts of a display_name — the town, not the street. */
function whereOf(display?: string): string | undefined {
  if (!display) return undefined;
  const parts = display.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const tail = parts.slice(-2);
  return tail.join(', ');
}

function toStadium(hit: NominatimHit): OsmStadium | null {
  const ring = ringOf(hit.geojson);
  const osmType = hit.osm_type === 'relation' ? 'relation' : hit.osm_type === 'node' ? 'node' : 'way';
  const id = Number(hit.osm_id);
  if (!Number.isFinite(id)) return null;
  const nd = hit.namedetails ?? {};
  const ex = hit.extratags ?? {};
  const cap = Number(ex.capacity ?? ex['seating:capacity'] ?? 0);
  const name = nd['name:en'] ?? nd.name ?? hit.name ?? hit.display_name?.split(',')[0] ?? 'Unnamed ground';
  const cls = hit.class ?? hit.category ?? '';
  return {
    id,
    osmType,
    name: name.trim(),
    where: whereOf(hit.display_name),
    ring: ring ?? [],
    capacity: Number.isFinite(cap) && cap > 0 ? cap : undefined,
    tags: { ...ex, ...(cls && hit.type ? { [cls]: hit.type } : {}) },
  };
}

async function nominatim(q: string, signal?: AbortSignal): Promise<NominatimHit[]> {
  await throttle();
  const url =
    `${NOMINATIM}?format=jsonv2&limit=30&polygon_geojson=1&extratags=1&namedetails=1&dedupe=1` +
    `&q=${encodeURIComponent(q)}`;

  const res = await fetchWithDeadline(url, 12_000, signal, { headers: { Accept: 'application/json' } });
  if (res.status === 429 || res.status === 503) throw new OsmError('busy', `Nominatim ${res.status}`);
  if (!res.ok) throw new OsmError('offline', `Nominatim ${res.status}`);

  let hits: unknown;
  try {
    hits = await res.json();
  } catch {
    throw new OsmError('offline', 'Nominatim returned no JSON');
  }
  if (!Array.isArray(hits)) throw new OsmError('offline', 'Nominatim returned an unexpected shape');
  return hits as NominatimHit[];
}

function rank(hits: NominatimHit[]): OsmStadium[] {
  const scored = hits
    .map((h) => ({ score: kindScore(h), s: toStadium(h) }))
    .filter((x): x is { score: number; s: OsmStadium } => x.score > 0 && x.s !== null)
    // A named point with no outline is no use to the fitter and cannot be
    // rescued by an id lookup either, because a node has no geometry to fetch.
    .filter((x) => x.s.osmType !== 'node' || x.s.ring.length >= 6);

  // Class first (a stadium beats a school of the same name), then whether we
  // already have an outline, then size. Ranking an outline above a bare match
  // matters because Nominatim omits geometry in category mode, and a result we
  // can draw immediately is worth more than one needing a second round trip.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.s.ring.length >= 6) - Number(a.s.ring.length >= 6) ||
      area(b.s.ring) - area(a.s.ring),
  );

  const seen = new Set<string>();
  return scored
    .map((x) => x.s)
    .filter((s) => {
      const key = `${s.osmType}/${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

/**
 * Find stadiums by name, best match first.
 *
 * Nominatim handles the multilingual case for us: a ground in Riyadh tagged in
 * Arabic with the English name second is found by either, because the search
 * index carries every name variant. That was the one thing the old Overpass
 * union was trying to do by hand, with three of its four clauses. It also
 * resolves nicknames the tags do not carry — "San Siro" finds Giuseppe Meazza,
 * "Maracanã" finds Estádio Jornalista Mário Filho.
 *
 * Two passes, because one is measurably not enough. Plain relevance ranking is
 * right for a ground named exactly what people call it, and wrong when it is
 * not: searching "Camp Nou" returns a meadow in Brazil, a hotel, an apartment
 * block and a video-game shop, while the ground itself — tagged "Spotify Camp
 * Nou" since the sponsorship — never appears at any limit. Repeating the search
 * restricted to `[leisure=stadium]` finds grounds the first pass buried.
 *
 * The second pass only runs when the first found no stadium, so the common case
 * still costs one request.
 *
 * Throws OsmError so the caller can tell "nothing by that name" (an empty array)
 * apart from "the service is down" (a throw) — the old code could not, and said
 * the service was down either way.
 */
export async function findStadiums(name: string, signal?: AbortSignal): Promise<OsmStadium[]> {
  const q = name.trim();
  if (q.length < 3) return [];

  const first = rank(await nominatim(q, signal));
  if (first.length) return first;

  // Nothing stadium-shaped came back. Ask again for stadiums only.
  const second = rank(await nominatim(`${q} [leisure=stadium]`, signal));
  return second;
}

// ---- Overpass, for geometry by id only ------------------------------------

interface OverpassElement {
  id: number;
  type?: string;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{ role?: string; geometry?: Array<{ lat: number; lon: number }> }>;
}

async function overpass(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  let last: OsmError = new OsmError('offline', 'Overpass unreachable');
  for (const url of OVERPASS) {
    try {
      const res = await fetchWithDeadline(url, 12_000, signal, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.status === 429) { last = new OsmError('busy', 'Overpass 429'); continue; }
      if (!res.ok) { last = new OsmError('offline', `Overpass ${res.status}`); continue; }
      const text = await res.text();
      // A busy instance answers 200 with an XML error document, so the status
      // code alone does not mean there is JSON to parse.
      if (!text.trimStart().startsWith('{')) { last = new OsmError('busy', 'Overpass returned no JSON'); continue; }
      const data = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string };
      // A timed-out Overpass query answers 200 with an EMPTY element list and a
      // remark. Reading that as "no such stadium" is how a server problem got
      // reported to users as a spelling problem.
      if (data.remark && !(data.elements ?? []).length) { last = new OsmError('busy', data.remark); continue; }
      return data.elements ?? [];
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e instanceof OsmError ? e : new OsmError('offline', String((e as Error)?.message ?? e));
    }
  }
  throw last;
}

function ringFromElement(el: OverpassElement): LonLat[] {
  if (el.geometry?.length) return el.geometry.map((g) => [g.lon, g.lat] as LonLat);
  // A multipolygon relation: take the longest outer way.
  const outers = (el.members ?? [])
    .filter((m) => (m.role ?? 'outer') === 'outer' && m.geometry?.length)
    .map((m) => m.geometry!.map((g) => [g.lon, g.lat] as LonLat))
    .sort((a, b) => b.length - a.length);
  return outers[0] ?? [];
}

/**
 * Fetch one known element's geometry by id.
 *
 * Used for a Nominatim match that came back without a polygon, and for
 * re-importing a ground we have cited before. This is an index lookup, not a
 * scan — the operation Overpass is genuinely fast at.
 */
export async function fetchGeometry(
  osmType: 'way' | 'relation',
  osmId: number,
  signal?: AbortSignal,
): Promise<LonLat[]> {
  if (!Number.isInteger(osmId) || osmId <= 0) return [];
  const sel = osmType === 'relation' ? `relation(${osmId})` : `way(${osmId})`;
  const els = await overpass(`[out:json][timeout:20];${sel};out tags geom;`, signal);
  const el = els[0];
  return el ? ringFromElement(el) : [];
}

/**
 * Ask Nominatim for one element's outline by id.
 *
 * Its `/lookup` endpoint answers the same question as the Overpass id query and
 * is dramatically more dependable from a browser: measured side by side, lookup
 * returned two full polygons plus their capacity tags in 691 ms, while the
 * Overpass id query for the same kind of element hit the 20-second deadline.
 * So this is tried first and Overpass is the backstop, not the other way round.
 */
async function nominatimLookup(
  osmType: 'way' | 'relation',
  osmId: number,
  signal?: AbortSignal,
): Promise<{ ring: LonLat[]; capacity?: number }> {
  await throttle();
  const prefix = osmType === 'relation' ? 'R' : 'W';
  const url = `${NOMINATIM.replace(/\/search$/, '/lookup')}?format=jsonv2&polygon_geojson=1&extratags=1&osm_ids=${prefix}${osmId}`;
  const res = await fetchWithDeadline(url, 12_000, signal, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new OsmError(res.status === 429 || res.status === 503 ? 'busy' : 'offline', `Nominatim lookup ${res.status}`);
  const rows = (await res.json()) as NominatimHit[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { ring: [] };
  const cap = Number(row.extratags?.capacity ?? row.extratags?.['seating:capacity'] ?? 0);
  return { ring: ringOf(row.geojson) ?? [], capacity: Number.isFinite(cap) && cap > 0 ? cap : undefined };
}

/**
 * Make sure a match has an outline, fetching one if the search did not send it.
 *
 * Returns the stadium unchanged when it already has a ring, so the common path
 * costs nothing. A node is returned as-is: there is no geometry to fetch for a
 * point, and the panel says so rather than spending two requests finding out.
 */
export async function withGeometry(s: OsmStadium, signal?: AbortSignal): Promise<OsmStadium> {
  if (s.ring.length >= 6) return s;
  if (s.osmType === 'node') return s;

  try {
    const got = await nominatimLookup(s.osmType, s.id, signal);
    if (got.ring.length >= 6) return { ...s, ring: got.ring, capacity: s.capacity ?? got.capacity };
  } catch (e) {
    if (signal?.aborted) throw e;
    // Fall through to Overpass rather than failing on the first service.
  }

  const ring = await fetchGeometry(s.osmType, s.id, signal);
  return ring.length >= 6 ? { ...s, ring } : s;
}
