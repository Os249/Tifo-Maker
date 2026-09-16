/**
 * Measure a stadium's seating ring off an overhead image.
 *
 *   npx tsx scripts/stadium-ring.mts \
 *     --image scratch/amman.jpg \
 *     --bounds 35.90165198,31.98626374,35.90385139,31.98400693 \
 *     --osm scripts/data/amman-osm.json \
 *     --out scripts/data/amman-ring.json
 *
 * This is the step that makes the difference between a good template and a bad
 * one. A building footprint gives the OUTER wall; `plan` is the inner edge of
 * row 0, and the gap between them is the whole bowl. Overhead imagery is the
 * only free source that sees where the seats actually start — so walk outward
 * along 360 bearings from the bowl's centre and record where the pixels look
 * like seating.
 *
 * --bounds is west,north,east,south in degrees: the geographic corners of the
 * image, which whatever produced it can tell you. The image itself is not
 * committed — map imagery is not ours to redistribute — but its measurement is,
 * which is why the output of this script lives in scripts/data/.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fitRing, measureRing, type RadialProbe } from '../src/core/stadiumFit';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

const imagePath = arg('--image');
const boundsRaw = arg('--bounds');
const osmPath = arg('--osm');
const outPath = arg('--out');
const step = Number(arg('--step') ?? 0.2);

if (!imagePath || !boundsRaw || !osmPath || !outPath) {
  console.log('usage: --image a.jpg --bounds W,N,E,S --osm scripts/data/x-osm.json --out scripts/data/x-ring.json [--step 0.2]');
  process.exit(1);
}

const [W_DEG, N_DEG, E_DEG, S_DEG] = boundsRaw.split(',').map(Number);
if ([W_DEG, N_DEG, E_DEG, S_DEG].some((v) => !Number.isFinite(v))) throw new Error('--bounds must be W,N,E,S in degrees');

// sharp ships with the project for image work elsewhere; this only needs raw pixels.
const sharp = require('sharp') as (p: string) => {
  raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
  ensureAlpha(): ReturnType<typeof sharp>;
};

const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
const { width: IW, height: IH, channels: CH } = info;
console.log(`image ${IW}x${IH}, ${CH} channels`);

// ---- geo -> pixel, in Web Mercator because that is what map tiles are in.
const mercY = (lat: number): number => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
const mx0 = (W_DEG + 180) / 360, mx1 = (E_DEG + 180) / 360;
const my0 = mercY(N_DEG), my1 = mercY(S_DEG);
const toPx = (lon: number, lat: number): [number, number] => [
  (((lon + 180) / 360) - mx0) / (mx1 - mx0) * IW,
  (mercY(lat) - my0) / (my1 - my0) * IH,
];

// ---- the bowl's centre: the AREA centroid of the OSM footprint.
const osm = JSON.parse(readFileSync(osmPath, 'utf8')) as { stadium: { geom: Array<[number, number]> } };
const geom = osm.stadium.geom;
const LAT0 = geom.reduce((s, p) => s + p[1], 0) / geom.length;
const LON0 = geom.reduce((s, p) => s + p[0], 0) / geom.length;
const mLat = 111_132, mLon = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const toM = (lon: number, lat: number): [number, number] => [(lon - LON0) * mLon, (lat - LAT0) * mLat];
const fromM = (x: number, y: number): [number, number] => [LON0 + x / mLon, LAT0 + y / mLat];

const ringM = geom.map(([lon, lat]) => toM(lon, lat));
let a2 = 0, cx = 0, cy = 0;
for (let i = 0; i < ringM.length; i++) {
  const [x0, y0] = ringM[i];
  const [x1, y1] = ringM[(i + 1) % ringM.length];
  const f = x0 * y1 - x1 * y0;
  a2 += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
}
const CX = cx / (3 * a2), CY = cy / (3 * a2);

/**
 * How far the stadium reaches along one bearing, by ray-casting the footprint.
 *
 * Not a single max radius. Amman is ringed by trees, and sampling to the
 * bowl's greatest extent in every direction walks straight off the building
 * into them — the colour detector's first answer was #122a0e, which is foliage,
 * and every bearing then "found seating" out in the car park. The footprint is
 * the edge of the stadium and nothing outside it is evidence about its seats.
 */
function footprintRadius(theta: number): number {
  const dx = Math.cos(theta), dy = Math.sin(theta);
  let best = 0;
  for (let i = 0; i < ringM.length; i++) {
    const [ax, ay] = [ringM[i][0] - CX, ringM[i][1] - CY];
    const [bx, by] = [ringM[(i + 1) % ringM.length][0] - CX, ringM[(i + 1) % ringM.length][1] - CY];
    const den = dx * (ay - by) - dy * (ax - bx);
    if (Math.abs(den) < 1e-9) continue;
    const t = (dx * (ay - by) * ax - dx * (ax - bx) * ay) / den; // unused guard
    void t;
    // Solve C + u*d = A + v*(B-A) for u >= 0, v in [0,1].
    const ex = bx - ax, ey = by - ay;
    const det = dx * -ey - dy * -ex;
    if (Math.abs(det) < 1e-9) continue;
    const u = (ax * -ey - ay * -ex) / det;
    const v = (dx * ay - dy * ax) / det;
    if (u > 0 && v >= 0 && v <= 1) best = Math.max(best, u);
  }
  return best;
}

const maxR = Math.max(...ringM.map(([x, y]) => Math.hypot(x - CX, y - CY)));
console.log(`centre ${CX.toFixed(1)}, ${CY.toFixed(1)} m; footprint reaches ${maxR.toFixed(0)} m at its furthest`);

/**
 * What colour are this ground's seats?
 *
 * The first version of this hard-coded blue, calibrated on Amman. That quietly
 * failed on every red, green or yellow ground in the world: nothing matched, no
 * bearing reported seating, and the estimator fell back to the weaker
 * footprint path without anyone being told why.
 *
 * So learn it from the picture. The trick is geometric rather than chromatic —
 * a hue test cannot separate red seats from a red running track, but the two
 * are never in the same place. A World Athletics 400 m track is 176.91 x 92.52 m
 * overall, so its outer edge is 46.26 m from the centre at its narrowest. Sample
 * only BEYOND that and grass, track and their run-offs are all excluded by
 * construction, whatever colour they happen to be.
 *
 * What is left is seating, concrete and roof. Drop the greys, and the dominant
 * saturated colour is the seats.
 */
type Rgb = [number, number, number];

function saturation([r, g, b]: Rgb): number {
  const mx = Math.max(r, g, b);
  return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
}

/**
 * Candidate seat colours, ranked by how much of the stadium they cover.
 *
 * Bucketed by CHROMATICITY — r/(r+g+b), g/(r+g+b) — rather than by raw RGB, so a
 * stand in its own roof's shadow votes with the sunlit stand opposite instead of
 * against it. Amman's blue seats split across three brightness buckets and each
 * one individually lost to the track's single uniform bucket; merged by chroma
 * they are one candidate.
 *
 * This returns CANDIDATES, not an answer. Picking between them by colour is what
 * failed: a running track and a seating bowl are both large saturated ovals, and
 * on an oblique ray neither thickness nor hue tells them apart. The choice is
 * made downstream by geometry — see chooseSeatColour.
 */
function seatColourCandidates(
  probe: (x: number, y: number) => Rgb | null,
  outerAt: (theta: number) => number,
  top = 5,
): Array<{ colour: Rgb; share: number }> {
  const votes = new Map<number, { n: number; sum: [number, number, number] }>();
  let considered = 0;
  const STEP = 0.5;
  for (let i = 0; i < 720; i++) {
    const th = (i / 720) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    const outer = outerAt(th) - 1; // less the wall itself
    for (let r = 12; r < outer; r += STEP) {
      const px = probe(dx * r, dy * r);
      if (!px) continue;
      const sum = px[0] + px[1] + px[2];
      if (sum < 60 || sum > 720) continue; // shadow, blown highlight
      if (saturation(px) < 0.18) continue; // concrete, roof, tarmac
      considered++;
      const key = Math.min(11, Math.floor((px[0] / sum) * 12)) * 12 + Math.min(11, Math.floor((px[1] / sum) * 12));
      const v = votes.get(key) ?? { n: 0, sum: [0, 0, 0] as [number, number, number] };
      v.n++; v.sum[0] += px[0]; v.sum[1] += px[1]; v.sum[2] += px[2];
      votes.set(key, v);
    }
  }
  if (!considered) return [];
  return [...votes.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, top)
    .map((v) => ({
      colour: [Math.round(v.sum[0] / v.n), Math.round(v.sum[1] / v.n), Math.round(v.sum[2] / v.n)] as Rgb,
      share: v.n / considered,
    }));
}

/**
 * Is this pixel that colour?
 *
 * Compared as a RATIO rather than an absolute distance, because one stand is in
 * its own roof's shadow and another is in full sun: the same seats differ by a
 * factor of two in brightness while their colour balance barely moves. Matching
 * on brightness would read a shaded stand as no-data and throw the bearing away.
 */
function matcher(target: Rgb, tol: number): (px: Rgb) => boolean {
  const tSum = target[0] + target[1] + target[2] || 1;
  const tN = target.map((c) => c / tSum);
  const tSat = saturation(target);
  return (px: Rgb): boolean => {
    const sum = px[0] + px[1] + px[2];
    if (sum < 60 || sum > 720) return false; // black shadow, blown highlight
    const d = Math.abs(px[0] / sum - tN[0]) + Math.abs(px[1] / sum - tN[1]) + Math.abs(px[2] / sum - tN[2]);
    // A saturated target needs the sample to be saturated too, or off-white
    // concrete passes the ratio test on its way to being neutral.
    return d < tol && (tSat < 0.2 || saturation(px) > tSat * 0.45);
  };
}

const sample = (x: number, y: number): Rgb | null => {
  const [lon, lat] = fromM(x, y);
  const [u, v] = toPx(lon, lat);
  if (u < 0 || v < 0 || u >= IW || v >= IH) return null;
  const i = (Math.floor(v) * IW + Math.floor(u)) * CH;
  return [data[i], data[i + 1], data[i + 2]];
};

// ---- sweep the bearings for one candidate colour
function sweep(isSeat: (px: Rgb) => boolean): RadialProbe[] {
  const out: RadialProbe[] = [];
  for (let i = 0; i < 360; i++) {
    const theta = (i / 360) * Math.PI * 2;
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const outer = footprintRadius(theta) - 1;
    const hits: number[] = [];
    for (let r = 12; r < outer; r += step) {
      const px = sample(CX + dx * r, CY + dy * r);
      if (px && isSeat(px)) hits.push(Number(r.toFixed(2)));
    }
    if (hits.length) out.push({ theta: Number(theta.toFixed(5)), hits });
  }
  return out;
}

/**
 * Which candidate is the seating?
 *
 * Measure the ring each one produces and judge it as GEOMETRY, because colour
 * cannot decide this: a running track and a seating bowl are both big saturated
 * ovals, and on an oblique ray neither hue nor band thickness separates them.
 * Three earlier versions of this file picked the track.
 *
 * Two tests, in order:
 *   1. does its inner edge fit a superellipse at all, on enough bearings —
 *      a car park or a roof stripe does not;
 *   2. of those that do, take the OUTERMOST. That is the one structural fact
 *      that always holds: seats are the last thing before the wall, and the
 *      track is always inside them.
 */
const tol = Number(arg('--tolerance') ?? 0.07);
type Scored = { colour: Rgb; hex: string; share: number; probes: RadialProbe[]; used: number; rms: number; meanR: number; depth: number };

function score(colour: Rgb, share: number): Scored | null {
  const probes = sweep(matcher(colour, tol));
  const m = measureRing(probes, { minHits: 25 });
  if (m.used < 60) return null;
  const f = fitRing(m.points);
  if (!Number.isFinite(f.rms) || f.rms > 0.25) return null;
  const meanR = m.points.reduce((t, [x, y]) => t + Math.hypot(x, y), 0) / m.points.length;
  return {
    colour, share, probes, used: m.used, rms: f.rms, meanR, depth: m.depth.median,
    hex: '#' + colour.map((c) => c.toString(16).padStart(2, '0')).join(''),
  };
}

const forced = arg('--seat-color');
let chosen: Scored;
let how: string;

if (forced) {
  const mm = /^#?([0-9a-f]{6})$/i.exec(forced.trim());
  if (!mm) throw new Error('--seat-color wants a hex colour like #1e4f9c');
  const v = parseInt(mm[1], 16);
  const c: Rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  const sc = score(c, 0);
  if (!sc) throw new Error(`No seating ring found for ${forced}. Wrong colour, or the image is not georeferenced as --bounds says.`);
  chosen = sc;
  how = 'given on the command line';
} else {
  const cands = seatColourCandidates((x, y) => sample(CX + x, CY + y), footprintRadius, 8);
  const scored: Scored[] = [];
  for (const c of cands) {
    const sc = score(c.colour, c.share);
    if (sc) scored.push(sc);
    else if (process.env.RING_DEBUG) {
      const hx = '#' + c.colour.map((v) => v.toString(16).padStart(2, '0')).join('');
      console.log(`  rejected ${hx} (${(c.share * 100).toFixed(0)}% of saturated pixels): no ring that fits a plan curve`);
    }
  }
  if (scored.length === 0) {
    throw new Error(
      'No candidate colour produced a seating ring. The image may be too small or wrongly ' +
      'georeferenced, or the seating may be roofed over. Pass --seat-color #rrggbb to say what to look for.',
    );
  }
  // Merge candidates that describe the SAME BAND. A stand in sun and the same
  // stand in its roof's shadow land in different chroma buckets, and the shaded
  // one sits further out — so "outermost wins" picked the back rows, measured
  // half the bearings, and put the ring 3 m too far out. Two rings within 12 m
  // of each other are one stand seen under two lightings; union their bearings.
  const BAND_TOL_M = 12;
  scored.sort((a, b) => b.meanR - a.meanR);
  const bands: Scored[] = [];
  for (const c of scored) {
    const into = bands.find((b) => Math.abs(b.meanR - c.meanR) <= BAND_TOL_M);
    if (!into) { bands.push(c); continue; }
    const byTheta = new Map(into.probes.map((pr) => [pr.theta, new Set(pr.hits)]));
    for (const pr of c.probes) {
      const set = byTheta.get(pr.theta);
      if (set) for (const h of pr.hits) set.add(h);
      else byTheta.set(pr.theta, new Set(pr.hits));
    }
    into.probes = [...byTheta.entries()].map(([theta, set]) => ({ theta, hits: [...set].sort((x, y) => x - y) }));
    const m2 = measureRing(into.probes, { minHits: 25 });
    const f2 = fitRing(m2.points);
    into.used = m2.used;
    into.rms = f2.rms;
    into.depth = m2.depth.median;
    into.meanR = m2.points.reduce((t, [x, y]) => t + Math.hypot(x, y), 0) / (m2.points.length || 1);
    into.share += c.share;
  }

  console.log('\ncandidate bands, judged as geometry:');
  console.log('  colour     share  bearings   rms   mean r   band');
  for (const c of [...bands].sort((a, b) => b.meanR - a.meanR)) {
    console.log(
      `  ${c.hex}  ${(c.share * 100).toFixed(0).padStart(4)}%  ${String(c.used).padStart(7)}  ` +
      `${(c.rms * 100).toFixed(1).padStart(5)}%  ${c.meanR.toFixed(1).padStart(6)} m  ${c.depth.toFixed(1).padStart(5)} m`,
    );
  }
  // Outermost wins. The track is always inside the seats.
  chosen = bands.reduce((a, b) => (b.meanR > a.meanR ? b : a));
  how = `outermost of ${bands.length} candidate rings that fit a plan curve`;
}

const hex = chosen.hex;
const probes = chosen.probes;
console.log(`\nseat colour ${hex} — ${how}`);
console.log(`  ring at ${chosen.meanR.toFixed(1)} m mean radius, ${(chosen.rms * 100).toFixed(1)}% rms, band ${chosen.depth.toFixed(1)} m`);

writeFileSync(outPath, JSON.stringify({
  source: `Overhead imagery sampled radially for seat-coloured pixels. Bounds ${boundsRaw}, step ${step} m.`,
  seatColour: hex,
  seatColourHow: how,
  ringMeanRadius: Number(chosen.meanR.toFixed(1)),
  stadium: osmPath,
  centre_m: [Number(CX.toFixed(2)), Number(CY.toFixed(2))],
  step_m: step,
  probes,
}));

const counts = probes.map((p) => p.hits.length).sort((x, y) => x - y);
console.log(`${probes.length} of 360 bearings saw seating; median ${counts[counts.length >> 1] ?? 0} hits each`);
console.log(`wrote ${outPath}`);
console.log('\nNext: feed it to buildStadium — see scripts/stadium-from-pictures.mts');
