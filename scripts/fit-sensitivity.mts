/**
 * Dev-only: which stadium parameters can a single photograph actually pin down?
 *   npx tsx scripts/fit-sensitivity.mts
 *
 * The question behind the stadium-from-pictures tool. We already have a fast
 * parametric generator for exactly this object class, so the tractable framing
 * is not "reconstruct the geometry" but "search a dozen numbers until the render
 * matches the photo". That only works for the numbers the picture is SENSITIVE
 * to — perturb one, and if the silhouette barely moves, no optimiser will ever
 * recover it and the tool must get it from somewhere else or ask.
 *
 * So: render a known template, perturb one parameter at a time, and measure how
 * far the silhouette moves. Truth is known because we generated it, which is the
 * only way to get an honest answer without a scanned stadium to compare against.
 *
 * Reported per parameter:
 *   d(IoU)/d(1%)  how much silhouette agreement one percent of change costs
 *   just-noticeable  the change needed to move ~1% of pixels — roughly the point
 *                    a fit could tell two candidates apart through image noise
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { templateById } from '../src/core/stadiumCatalog';
import type { StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/fit');

type Cam = { pos: [number, number, number]; target: [number, number, number]; fov: number };
type Mask = { lab: number[]; seats: number };

/** Where people actually photograph a tifo from. */
const CAMERAS: Record<string, (t: StadiumTemplate) => Cam> = {
  // High in the stand opposite — the shot every tifo photo on the internet is.
  gantry: (t) => ({ pos: [0, 26, t.plan.b * 0.95], target: [0, 12, -t.plan.b * 1.2], fov: 52 }),
  // Pitch level near a corner flag, phone held up. Much more common, much worse.
  corner: (t) => ({ pos: [t.plan.a * 0.72, 2.0, t.plan.b * 0.72], target: [-t.plan.a * 0.5, 14, -t.plan.b * 0.5], fov: 68 }),
  // A drone or the aerial the satellite gives us, for contrast.
  above: (t) => ({ pos: [0, t.plan.a * 1.9, t.plan.b * 0.45], target: [0, 0, 0], fov: 46 }),
};

const clone = (t: StadiumTemplate): StadiumTemplate => JSON.parse(JSON.stringify(t)) as StadiumTemplate;

/** One parameter, how to move it, and what it means. */
type Knob = {
  name: string;
  unit: string;
  base: (t: StadiumTemplate) => number;
  set: (t: StadiumTemplate, v: number) => void;
  /** Fractions of the base value to try. */
  steps: number[];
};

const KNOBS: Knob[] = [
  { name: 'plan.a', unit: 'm', base: (t) => t.plan.a, set: (t, v) => { t.plan.a = v; }, steps: [0.01, 0.02, 0.05, 0.1] },
  { name: 'plan.b', unit: 'm', base: (t) => t.plan.b, set: (t, v) => { t.plan.b = v; }, steps: [0.01, 0.02, 0.05, 0.1] },
  { name: 'plan.exponent', unit: '', base: (t) => t.plan.exponent, set: (t, v) => { t.plan.exponent = v; }, steps: [0.02, 0.05, 0.1, 0.2] },
  { name: 'tier0.rows', unit: 'rows', base: (t) => t.tiers[0].rows, set: (t, v) => { t.tiers[0].rows = Math.max(2, Math.round(v)); }, steps: [0.03, 0.06, 0.12, 0.25] },
  { name: 'tier0.rakeDeg', unit: '°', base: (t) => t.tiers[0].rakeDeg, set: (t, v) => { t.tiers[0].rakeDeg = v; }, steps: [0.02, 0.05, 0.1, 0.2] },
  { name: 'tier0.rowDepth', unit: 'm', base: (t) => t.tiers[0].rowDepth, set: (t, v) => { t.tiers[0].rowDepth = v; }, steps: [0.02, 0.05, 0.1, 0.2] },
  { name: 'tier0.baseElevation', unit: 'm', base: (t) => t.tiers[0].baseElevation, set: (t, v) => { t.tiers[0].baseElevation = v; }, steps: [0.1, 0.25, 0.5, 1.0] },
  // Not a scalar: the alternative is "the same seats in one tier instead of two".
  // Tested as its own case below, because multiplying 2 by 1.05 is not a stadium.

  { name: 'roof.reach', unit: 'frac', base: (t) => t.roof?.reach ?? 0.5, set: (t, v) => { t.roof = { ...(t.roof ?? {}), reach: v }; }, steps: [0.05, 0.1, 0.2, 0.4] },
  { name: 'roof.rise', unit: 'm', base: (t) => t.roof?.rise ?? 6, set: (t, v) => { t.roof = { ...(t.roof ?? {}), rise: v }; }, steps: [0.05, 0.1, 0.2, 0.4] },
  { name: 'aisles.count', unit: '', base: (t) => t.aisles.count, set: (t, v) => { t.aisles.count = Math.max(4, Math.round(v)); }, steps: [0.1, 0.2, 0.4] },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5228 }, logLevel: 'error' });
await vite.listen(5228);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 700, height: 460 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5228/scripts/fit-sensitivity.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });

const maskOf = async (t: StadiumTemplate, cam: Cam): Promise<Mask> =>
  (await page.evaluate(
    ([tt, cc]) => (window as never as { __mask: (a: unknown, b: unknown) => Mask }).__mask(tt, cc),
    [t, cam] as [StadiumTemplate, Cam],
  )) as Mask;

/**
 * Box-downsample a label field to a coarse occupancy map.
 *
 * Without this the measurement is dominated by moiré. Seen from above, a seat row
 * is well under a pixel, so shifting the plan curve by one metre slides a fine
 * ring pattern across the sampling grid and destroys per-pixel IoU while changing
 * the SHAPE almost not at all — the first run of this script reported a 1% change
 * in plan.a costing 66% IoU, which is an aliasing artefact, not identifiability.
 * A photograph is matched on where the bowl's edges are, so measure that.
 */
function coarse(m: Mask, W: number, H: number, k: number): Float32Array {
  const cw = Math.floor(W / k), ch = Math.floor(H / k);
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let n = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const px = m.lab[(y * k + j) * W + (x * k + i)];
          if (px === 2) n++;
        }
      }
      out[y * cw + x] = n / (k * k);
    }
  }
  return out;
}

/** Soft IoU between two coarse occupancy maps. */
function softIoU(a: Float32Array, b: Float32Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    inter += Math.min(a[i], b[i]);
    uni += Math.max(a[i], b[i]);
  }
  return uni === 0 ? 1 : inter / uni;
}
/** Share of pixels whose label changed at all — roof movement included. */
function anyChange(a: Mask, b: Mask): number {
  let d = 0;
  for (let i = 0; i < a.lab.length; i++) if (a.lab[i] !== b.lab[i]) d++;
  return d / a.lab.length;
}

const WPX = 640, HPX = 400, K = 8; // coarse cell = 8x8 px

/**
 * Camera perturbations no smaller than the pose error a real photo carries.
 * PnLCalib-class pitch-line calibration reports ~0.4-0.6 m mean ground-plane
 * error on BROADCAST frames and has never been evaluated on photos from the
 * stands, so 1 degree and 2% focal is, if anything, generous to us.
 */
const jitters = (k: number): Array<(c: Cam) => Cam> => [
  (c) => ({ ...c, fov: c.fov * (1 + 0.02 * k) }),
  (c) => ({ ...c, target: [c.target[0] + 2 * k, c.target[1], c.target[2]] }),
  (c) => ({ ...c, pos: [c.pos[0], c.pos[1] + 1.5 * k, c.pos[2]] }),
];

/**
 * Two regimes, because the whole question turns on which one you are in.
 *   loose  — the camera is a guess. A phone photo with no EXIF, no calibration.
 *   solved — the camera came from pitch-line calibration. PnLCalib-class methods
 *            report ~0.4-0.6 m mean ground-plane error on broadcast frames; a
 *            fifth of the loose jitter is a fair stand-in, and generous, since
 *            nobody has ever evaluated those methods on photos from the stands.
 */
const REGIMES: Array<[string, number]> = [['loose', 1], ['solved', 0.2]];

const TRUTH = templateById('generic-bowl-60k');
if (!TRUTH) throw new Error('generic-bowl-60k is not in the catalogue');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/** The same bowl, same total rows, collapsed into a single tier. */
function asOneTier(t: StadiumTemplate): StadiumTemplate {
  const rows = t.tiers.reduce((n, x) => n + x.rows, 0);
  const f = t.tiers[0];
  return { ...clone(t), tiers: [{ ...f, rows }] };
}

const report: string[] = [];
for (const [regimeName, REGIME_K] of REGIMES) {
for (const [camName, mk] of Object.entries(CAMERAS)) {
  if (regimeName === 'solved' && camName === 'above') continue; // aerial is not fitted, it is measured
  const cam = mk(TRUTH);
  const ref = await maskOf(TRUTH, cam);
  const refC = coarse(ref, WPX, HPX, K);
  const seatPx = ref.lab.filter((v) => v === 2).length;

  // The noise floor. A real photograph comes with an unknown camera: the pose
  // recovered from pitch lines carries error, and the focal length is a guess.
  // Jitter the camera by less than that error and see how much the silhouette
  // moves anyway. Any parameter whose effect is smaller than this cannot be
  // recovered from the picture no matter how good the optimiser is — that is the
  // bar, not a round number I picked.
  let floor = 0;
  for (const jit of jitters(REGIME_K)) {
    const j = jit(cam);
    const m = await maskOf(TRUTH, j);
    floor = Math.max(floor, 1 - softIoU(refC, coarse(m, WPX, HPX, K)));
  }
  const head = `\n=== ${camName} camera, ${regimeName} camera === seating fills ` +
    `${((100 * seatPx) / ref.lab.length).toFixed(1)}% of frame` +
    `, noise floor ${(floor * 100).toFixed(1)}% ΔIoU`;
  console.log(head);
  report.push(head);
  const line = 'parameter'.padEnd(20) + 'base'.padStart(8) + '   ' +
    ['+1%', '+2%', '+5%', '+10%'].map((s) => s.padStart(9)).join('') + '    identifiable?';
  console.log(line);
  report.push(line);

  for (const k of KNOBS) {
    const base = k.base(TRUTH);
    const cells: string[] = [];
    let best = 0;
    for (const f of k.steps) {
      const t = clone(TRUTH);
      k.set(t, base * (1 + f));
      const m = await maskOf(t, cam);
      const dIoU = 1 - softIoU(refC, coarse(m, WPX, HPX, K));
      const dAny = anyChange(ref, m);
      best = Math.max(best, dIoU);
      cells.push(`${(dIoU * 100).toFixed(1)}/${(dAny * 100).toFixed(1)}`.padStart(9));
    }
    while (cells.length < 4) cells.push(''.padStart(9));
    // A parameter is identifiable from this view if its largest tried change
    // moves more than 1% of pixels: below that, JPEG noise and a hand-held
    // camera angle would swamp it.
    const verdict = best > floor * 3 ? 'strong' : best > floor ? 'weak' : 'NO — below camera noise';
    const row = k.name.padEnd(20) + base.toFixed(2).padStart(8) + '   ' + cells.join('') + '    ' + verdict;
    console.log(row);
    report.push(row);
  }

  // One tier or two, same seats. The question a photo is supposed to be best at.
  const one = await maskOf(asOneTier(TRUTH), cam);
  const dOne = 1 - softIoU(refC, coarse(one, WPX, HPX, K));
  const oneRow = '2 tiers -> 1 tier'.padEnd(20) + ''.padStart(8) + '   ' +
    `${(dOne * 100).toFixed(1)}/${(anyChange(ref, one) * 100).toFixed(1)}`.padStart(9) +
    ''.padStart(27) + '    ' + (dOne > floor * 3 ? 'strong' : dOne > floor ? 'weak' : 'NO — below camera noise');
  console.log(oneRow);
  report.push(oneRow);
}
}

const foot = '\ncells are  ΔIoU% / Δpixels%  — seating-only IoU loss, and share of all pixels whose label changed';
console.log(foot);
report.push(foot);
writeFileSync(`${OUT}/sensitivity.txt`, report.join('\n') + '\n');
await browser.close();
await vite.close();
console.log(`wrote ${OUT}/sensitivity.txt`);
