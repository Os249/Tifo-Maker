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
import type { RadialProbe } from '../src/core/stadiumFit';

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
const maxR = Math.max(...ringM.map(([x, y]) => Math.hypot(x - CX, y - CY))) * 1.05;
console.log(`centre ${CX.toFixed(1)}, ${CY.toFixed(1)} m; sampling out to ${maxR.toFixed(0)} m`);

/**
 * Does this pixel look like stadium seating?
 *
 * Blue dominance rather than an absolute colour. Calibrated against Amman's
 * seats (111,139,161) and (176,202,227) versus its track (217,196,179) and its
 * concrete apron (198,199,201): b-r is +50 on seats and negative or near zero on
 * everything else, which separates them cleanly under any exposure. Grounds with
 * red or green seating need their own test — this is honest about being tuned
 * for blue, which is the commonest, rather than pretending to be general.
 */
function isSeat(r: number, g: number, b: number): boolean {
  return b - r > 20 && g >= r && b > 60 && b < 240;
}

const sample = (x: number, y: number): [number, number, number] | null => {
  const [lon, lat] = fromM(x, y);
  const [u, v] = toPx(lon, lat);
  if (u < 0 || v < 0 || u >= IW || v >= IH) return null;
  const i = (Math.floor(v) * IW + Math.floor(u)) * CH;
  return [data[i], data[i + 1], data[i + 2]];
};

const probes: RadialProbe[] = [];
const BEARINGS = 360;
for (let i = 0; i < BEARINGS; i++) {
  const theta = (i / BEARINGS) * Math.PI * 2;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const hits: number[] = [];
  for (let r = 20; r < maxR; r += step) {
    const px = sample(CX + dx * r, CY + dy * r);
    if (px && isSeat(px[0], px[1], px[2])) hits.push(Number(r.toFixed(2)));
  }
  if (hits.length) probes.push({ theta: Number(theta.toFixed(5)), hits });
}

writeFileSync(outPath, JSON.stringify({
  source: `Overhead imagery sampled radially for seat-coloured pixels. Bounds ${boundsRaw}, step ${step} m.`,
  stadium: osmPath,
  centre_m: [Number(CX.toFixed(2)), Number(CY.toFixed(2))],
  step_m: step,
  probes,
}));

const counts = probes.map((p) => p.hits.length).sort((x, y) => x - y);
console.log(`${probes.length} of ${BEARINGS} bearings saw seating; median ${counts[counts.length >> 1] ?? 0} hits each`);
console.log(`wrote ${outPath}`);
console.log('\nNext: feed it to buildStadium — see scripts/stadium-from-pictures.mts');
