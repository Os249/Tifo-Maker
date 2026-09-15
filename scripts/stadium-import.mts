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
import { buildStadium, fitSuperellipse, solveRows, type Pt } from '../src/core/stadiumFit';

// The fitting itself now lives in src/core/stadiumFit.ts, so the app, the
// seat-map worker, the tests and this script all resolve a stadium the same way.
// Re-exported here because scripts/stadium-preview.mts and the self-tests below
// were written against these names.
export { fitSuperellipse, principalAxes, solveRows, type Pt } from '../src/core/stadiumFit';

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
    // Relative span is enough to pick the biggest way; no need for metres.
    const lat0 = ring.reduce((t, q) => t + q[1], 0) / ring.length;
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const xs = ring.map((q) => q[0] * kx);
    const ys = ring.map((q) => q[1]);
    const span = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
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
    const capacity = Number(arg('--capacity') ?? found.tags.capacity ?? found.tags['seating:capacity'] ?? 0);
    console.log('OSM tags:', JSON.stringify(found.tags, null, 2));
    if (!capacity) {
      console.log('\nNo capacity in OSM — pass --capacity (Wikidata P1083 has it for most grounds).');
      process.exit(0);
    }
    const tiers = arg('--tiers') ? Number(arg('--tiers')) : undefined;
    // Straight through buildStadium, so the CLI cannot drift from what the app
    // does. It gets the footprint path, which is the weak one — the estimator
    // says so in its own provenance, and the fix is to measure the seating ring
    // off imagery (see scripts/stadium-from-pictures.mts).
    const fit = buildStadium({
      id: `osm-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      footprint: found.ring,
      capacity,
      known: tiers ? { tiers } : {},
    });
    console.log(`\nsolved: ${fit.built} seats against a stated ${capacity} (${((fit.built / capacity - 1) * 100).toFixed(1)}%)`);
    for (const [field, pr] of Object.entries(fit.provenance)) {
      console.log(`  ${field.padEnd(18)} ${pr.confidence.padEnd(10)} ${pr.source}`);
    }
    for (const w of fit.warnings) console.log(`  warning: ${w}`);
    if (fit.confirm.length) console.log(`  confirm: ${fit.confirm.join(', ')}`);
    console.log(JSON.stringify(fit.template, null, 2));
  }
}
