/**
 * Build a StadiumTemplate from real-world data.
 *   npx tsx scripts/stadium-import.mts --name "Al-Awwal Park"
 *   npx tsx scripts/stadium-import.mts --osm way/123456 --capacity 62000
 *   npx tsx scripts/stadium-import.mts --selftest
 *
 * WHY THIS SHAPE. There is no public dataset of stadium seating bowls — tiers,
 * rows, rakes. The companies that hold that data (3D Digital Venue, Seatmap.pro,
 * Ticketmaster's 3D venues) build it per venue, under licence, for ticketing.
 *
 * What IS public, globally and freely, is two numbers:
 *   - the stadium's FOOTPRINT, from OpenStreetMap (ODbL)
 *   - its CAPACITY, from OSM or Wikidata
 *
 * And those two are enough, because the bowl is not free-form: seat pitch and
 * row depth are set by regulation and vary by centimetres, not metres. Given the
 * plan curve and the capacity, the number of rows is the only unknown left — so
 * solve for it against the renderer that will draw it. Verified by --selftest,
 * which round-trips the shipped catalogue.
 */
import { generateSeatMap } from '../src/core/seatmap';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import type { StadiumTemplate, TierSpec } from '../src/core/types';

// ---- geometry --------------------------------------------------------------

export type Pt = [number, number];

/** Metres per degree, good enough over a stadium's few hundred metres. */
function toMetres(ring: Pt[]): Pt[] {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lon, lat]) => [lon * mPerDegLon, lat * mPerDegLat] as Pt);
}

/** Centre and rotate a ring onto its own principal axes. */
export function principalAxes(ring: Pt[]): { centred: Pt[]; angleDeg: number } {
  const n = ring.length;
  // The AREA centroid, not the average of the vertices.
  //
  // An OSM way spaces its nodes by how much detail a mapper felt each part
  // deserved — a curved end gets ten nodes, a straight side gets two — so the
  // vertex average is pulled toward whichever side was mapped in more detail.
  // On Amman International that bias is 6.5 m, which alone manufactured a 10%
  // asymmetry and pushed the ellipse error from 11% to 21%. Synthetic test
  // rings have evenly spaced vertices, so this never showed up there.
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a2 += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a2) < 1e-9) {
    // Degenerate ring (collinear, or a single repeated point): fall back.
    cx = ring.reduce((s, p) => s + p[0], 0) / n;
    cy = ring.reduce((s, p) => s + p[1], 0) / n;
  } else {
    cx /= 3 * a2;
    cy /= 3 * a2;
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of ring) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Principal angle of the covariance matrix: the bowl's long axis.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(-theta), sin = Math.sin(-theta);
  const centred = ring.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [dx * cos - dy * sin, dx * sin + dy * cos] as Pt;
  });
  return { centred, angleDeg: (theta * 180) / Math.PI };
}

/** Extents and best exponent for a ring already rotated onto a candidate axis. */
function fitAt(centred: Pt[], angleRad: number): { a: number; b: number; p: number; err: number } {
  const cos = Math.cos(-angleRad), sin = Math.sin(-angleRad);
  const rot = centred.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as Pt);
  const a = Math.max(...rot.map((q) => Math.abs(q[0])));
  const b = Math.max(...rot.map((q) => Math.abs(q[1])));
  if (a < 1 || b < 1) return { a, b, p: 2, err: Infinity };
  let best = { p: 2, err: Infinity };
  for (let p = 1.6; p <= 6.01; p += 0.05) {
    let err = 0;
    for (const [x, y] of rot) err += (Math.abs(x / a) ** p + Math.abs(y / b) ** p - 1) ** 2;
    // Normalised by area, or a bigger bounding box always looks "better".
    const norm = err / (a * b);
    if (norm < best.err) best = { p, err: norm };
  }
  return { a, b, p: best.p, err: best.err };
}

/**
 * Fit |x/a|^p + |y/b|^p = 1 to a footprint.
 *
 * The orientation is SEARCHED, not taken from the principal axes. PCA gives the
 * long axis of an elongated bowl correctly, but a near-square one — an arena —
 * has no long axis at all, so the covariance is degenerate and it returns an
 * arbitrary angle. Rotating a squarish shape by that arbitrary amount inflates
 * its extents and flattens the exponent, and the fit comes out wrong in every
 * value at once. Ninety one-degree steps costs nothing and never degenerates.
 */
export function fitSuperellipse(ringLonLat: Pt[]): { a: number; b: number; exponent: number; angleDeg: number } {
  const { centred } = principalAxes(toMetres(ringLonLat));
  // principalAxes already rotated by its own estimate, so search around 0.
  let best = { a: 0, b: 0, p: 2, err: Infinity, deg: 0 };
  for (let deg = -90; deg <= 90; deg += 1) {
    const f = fitAt(centred, (deg * Math.PI) / 180);
    if (f.err < best.err) best = { ...f, deg };
  }
  // A bowl is described long-axis-first; swapping keeps a >= b without changing it.
  let { a, b } = best;
  let deg = best.deg;
  if (b > a) { [a, b] = [b, a]; deg += 90; }
  return { a: round(a, 1), b: round(b, 1), exponent: round(best.p, 2), angleDeg: round(((deg + 180) % 180), 1) };
}

const round = (n: number, d: number): number => Number(n.toFixed(d));

// ---- the part the data cannot tell you -------------------------------------

/**
 * Choose rows per tier so the built bowl actually holds `capacity`.
 *
 * Solved against generateSeatMap rather than a formula, because the renderer is
 * the authority: aisles, corner cuts and row offsets all move the real count,
 * and a closed form would drift from whatever the engine does next.
 */
export function solveRows(base: StadiumTemplate, capacity: number): { template: StadiumTemplate; built: number; iterations: number } {
  const shares = base.tiers.map((t) => t.rows);
  const total = shares.reduce((s, r) => s + r, 0) || 1;
  const withScale = (k: number): StadiumTemplate => ({
    ...base,
    tiers: base.tiers.map((t, i) => ({ ...t, rows: Math.max(4, Math.round((shares[i] / total) * k)) })) as TierSpec[],
  });
  // Bisect on total rows: the count rises monotonically with them.
  let lo = 4, hi = 400, iterations = 0;
  let bestT = withScale(total), bestErr = Infinity, bestN = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = withScale(mid);
    const n = generateSeatMap(t).count;
    iterations++;
    const err = Math.abs(n - capacity);
    if (err < bestErr) { bestErr = err; bestT = t; bestN = n; }
    if (n === capacity) break;
    if (n < capacity) lo = mid + 1; else hi = mid - 1;
  }
  return { template: bestT, built: bestN, iterations };
}

// ---- self test: can the method rebuild the catalogue it was not shown? ------

function selftest(): void {
  console.log('Round-tripping the shipped catalogue: fit the plan, then solve rows from capacity alone.\n');
  console.log('stadium'.padEnd(26) + 'stated'.padStart(8) + 'before'.padStart(8) + 'after'.padStart(8) + '   error');
  let worst = 0;
  for (const s of STADIUM_CATALOG) {
    const cap = s.meta?.capacity;
    if (!cap) continue;
    const before = generateSeatMap(s.template).count;
    const { template, built } = solveRows(s.template, cap);
    const err = Math.abs(built - cap) / cap;
    worst = Math.max(worst, err);
    const rows = template.tiers.map((t) => t.rows).join('+');
    console.log(
      String(s.meta?.name ?? s.id).slice(0, 25).padEnd(26) +
      String(cap).padStart(8) + String(before).padStart(8) + String(built).padStart(8) +
      `   ${(err * 100).toFixed(1)}%  rows ${rows}`,
    );
  }
  console.log(`\nworst error after solving: ${(worst * 100).toFixed(1)}%`);
}

/** Synthesise a footprint with known a/b/p at a real latitude, then refit it. */
function fitSelftest(): void {
  const mk = (aM: number, bM: number, p: number, rotDeg: number, lat0 = 24.7, lon0 = 46.7, n = 96): Pt[] => {
    const mLat = 111_132, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const r = (rotDeg * Math.PI) / 180;
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const ct = Math.cos(t), st = Math.sin(t);
      const x = aM * Math.sign(ct) * Math.abs(ct) ** (2 / p);
      const y = bM * Math.sign(st) * Math.abs(st) ** (2 / p);
      out.push([lon0 + (x * Math.cos(r) - y * Math.sin(r)) / mLon, lat0 + (x * Math.sin(r) + y * Math.cos(r)) / mLat]);
    }
    return out;
  };
  console.log('\nFitting footprints with known geometry:');
  let worst = 0;
  for (const [a, b, p, rot] of [
    [122, 96, 2.2, 0], [80, 64, 2.8, 35], [140, 110, 2.0, -70],
    [95, 95, 4.0, 15],   // the degenerate one: a square-ish arena has no long axis
    [105, 68, 3.4, 12],
  ] as const) {
    const f = fitSuperellipse(mk(a, b, p, rot));
    const e = Math.max(Math.abs(f.a - a) / a, Math.abs(f.b - b) / b, Math.abs(f.exponent - p) / p);
    worst = Math.max(worst, e);
    console.log(
      `  a=${a} b=${b} p=${p} rot=${rot}`.padEnd(32) +
      `-> a=${f.a} b=${f.b} p=${f.exponent}`.padEnd(30) + `${(e * 100).toFixed(1)}%`,
    );
  }
  console.log(`worst fit error: ${(worst * 100).toFixed(1)}%`);
}

// ---- Overpass (needs network; runs on your machine, not in CI) --------------

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

/** The stadium's outer way, plus its tags. */
export async function fetchFootprint(name: string): Promise<{ ring: Pt[]; tags: Record<string, string> } | null> {
  const q = `[out:json][timeout:60];
    (way["leisure"="stadium"]["name"~"${name}",i];
     way["building"="stadium"]["name"~"${name}",i];
     way["leisure"="stadium"]["name:en"~"${name}",i];);
    out geom tags 5;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: `data=${encodeURIComponent(q)}` });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = (await res.json()) as {
    elements?: Array<{ tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }>;
  };
  // Biggest footprint wins: a stadium's own way, not a kiosk that shares its name.
  let best: { ring: Pt[]; tags: Record<string, string>; span: number } | null = null;
  for (const el of data.elements ?? []) {
    if (!el.geometry || el.geometry.length < 8) continue;
    const ring = el.geometry.map((g) => [g.lon, g.lat] as Pt);
    const m = toMetres(ring);
    const span =
      (Math.max(...m.map((p) => p[0])) - Math.min(...m.map((p) => p[0]))) *
      (Math.max(...m.map((p) => p[1])) - Math.min(...m.map((p) => p[1])));
    if (!best || span > best.span) best = { ring, tags: el.tags ?? {}, span };
  }
  return best ? { ring: best.ring, tags: best.tags } : null;
}

// ---- cli -------------------------------------------------------------------

const isCli = import.meta.url === `file://${process.argv[1]}`;
const args = isCli ? process.argv.slice(2) : ['--noop'];
const arg = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!isCli) {
  /* imported for its functions (tests) — do nothing */
} else if (args.includes('--selftest')) {
  selftest();
  fitSelftest();
} else {
  const name = arg('--name');
  if (!name) {
    console.log('usage: --name "Al-Awwal Park" [--capacity 25000] [--tiers 2]   |   --selftest');
  } else {
    const found = await fetchFootprint(name);
    if (!found) {
      console.error(`no stadium footprint found for "${name}"`);
      process.exit(1);
    }
    const plan = fitSuperellipse(found.ring);
    const capacity = Number(arg('--capacity') ?? found.tags.capacity ?? found.tags['seating:capacity'] ?? 0);
    const tierCount = Number(arg('--tiers') ?? (capacity > 45000 ? 2 : 1));
    console.log('OSM tags:', JSON.stringify(found.tags, null, 2));
    console.log('fitted plan:', plan);
    if (!capacity) {
      console.log('\nNo capacity in OSM — pass --capacity (Wikidata P1083 has it for most grounds).');
      process.exit(0);
    }
    // A seed with plausible proportions; solveRows fixes the row counts.
    const seedTiers: TierSpec[] = Array.from({ length: tierCount }, (_, i) => ({
      rows: i === 0 ? 30 : 22,
      rowDepth: 0.8,
      rakeDeg: i === 0 ? 24 : 34,
      baseElevation: i === 0 ? 1.5 : 15,
      baseOffset: i === 0 ? 0 : 26,
      seatPitch: 0.5,
    }));
    const seed: StadiumTemplate = {
      id: `osm-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      version: 1,
      plan: { a: plan.a, b: plan.b, exponent: plan.exponent },
      tiers: seedTiers,
      aisles: { count: Math.round((2 * Math.PI * ((plan.a + plan.b) / 2)) / 20), widthMeters: 1.2 },
      sectionsPerTier: Math.round((2 * Math.PI * ((plan.a + plan.b) / 2)) / 20),
      evenRows: true,
    };
    const { template, built } = solveRows(seed, capacity);
    console.log(`\nsolved: ${built} seats against a stated ${capacity} (${((built / capacity - 1) * 100).toFixed(1)}%)`);
    console.log(JSON.stringify(template, null, 2));
  }
}
