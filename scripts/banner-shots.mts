/**
 * Dev-only: every banner type, hanging in the real bowl.
 *   npm run shots:banner            → preview-out/banners/*.png
 *   npm run shots:banner drop       → just the ones whose name matches
 *
 * Two things are checked, and only one of them is the picture.
 *
 * A screenshot can tell you a banner is THERE. It cannot tell you that the rig
 * group was built and left empty — that a net-backed banner has no net, that a
 * pole-out has no poles — because at a hundred metres a missing rope looks
 * exactly like a rope you cannot see. So every shot also reads a census back
 * out of the scene, and the census is what fails the run. It is the same
 * lesson `matchday-shots.mts` records about floodlights.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import {
  BANNER_KINDS, KIND_PROFILE, newBanner, bannerFacts, revealEase,
  physicalRevealMs, freeFallSeconds, DEPLOY_SPEED, type BannerKind,
} from '../src/core/banner';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/banners');
const filter = process.argv[2] ?? '';
const TEMPLATE = 'generic-bowl-60k';

interface Shot {
  png: string;
  census: { banners: number; ropes: number; nets: number; bars: number; poles: number; particles: number };
  stand: { width: number; height: number } | null;
  /** Deepest the fabric is inside the terracing, in metres. */
  penetration: number;
  /** Deepest it has dipped below whatever is holding it up, in metres. */
  sag: number;
  revealMs: number;
  framed: boolean;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  error?: unknown;
}

interface Job {
  name: string;
  kind: BannerKind;
  progress: number;
  material?: 'solid' | 'mesh';
  wind?: number;
  /** Camera elevation in degrees; low is where penetration shows. */
  elevationDeg?: number;
  settleS?: number;
}

/**
 * How far into the stand the fabric is allowed to be, in metres.
 *
 * Not zero, and it would be dishonest to claim zero. The collider is a
 * heightfield on a one-metre grid, the solver resolves contacts once per
 * substep, and between substeps gravity gets a fraction of a millisecond to
 * pull a particle back in. What is NOT allowed is a sheet sitting inside the
 * terracing, which is what the screenshot that started this rewrite showed and
 * which measures in whole metres. Five centimetres is under the thickness of
 * the seat it is resting on.
 */
const PENETRATION_MAX_M = 0.05;

/**
 * How far the fabric may dip below its support before something is wrong.
 *
 * A gust pressing a sheet a few centimetres into the crowd holding it up is
 * fabric behaving; half a metre means the support is not being felt at all.
 */
const SAG_MAX_M = 0.4;

const jobs: Job[] = [];
for (const kind of BANNER_KINDS) {
  jobs.push({ name: `${kind}-rest`, kind, progress: 1 });
  // The grazing view: pitch level, looking along the terracing. This is the
  // angle the first version of this harness never took, which is how a banner
  // buried in the seats got through a run of green screenshots. Six degrees
  // up is where a photographer on the touchline stands.
  jobs.push({ name: `${kind}-graze`, kind, progress: 1, elevationDeg: 6 });
  // Mid-reveal is where the rig has to be right: a roll half-way down a tier,
  // a sheet half-hauled, a crowd-pass wave half-way up the block.
  if (KIND_PROFILE[kind].reveal !== 'fade') jobs.push({ name: `${kind}-mid`, kind, progress: 0.45 });
}
// Long settle on the two that drape over the rake. If a sheet is going to sink
// into the seating it does it slowly, so a short settle can hide it.
jobs.push({ name: 'drop-long-settle', kind: 'drop', progress: 1, settleS: 15, elevationDeg: 6 });
// Straight off the layout, with no solver time at all. If this one differs
// wildly from `drop-rest` the layout is not a shape the solver agrees with,
// and the banner will visibly jump the instant it is placed.
jobs.push({ name: 'drop-nosettle', kind: 'drop', progress: 1, settleS: 0 });
jobs.push({ name: 'cover-long-settle', kind: 'stand-cover', progress: 1, settleS: 15, elevationDeg: 6 });
// The fabric argument, side by side: the same banner solid and perforated in a
// stiff wind. If mesh does not visibly move less, the wind model is decorative.
jobs.push({ name: 'wind-solid', kind: 'pole-out', progress: 1, material: 'solid', wind: 1 });
jobs.push({ name: 'wind-mesh', kind: 'pole-out', progress: 1, material: 'mesh', wind: 1 });

const wanted = jobs.filter((j) => !filter || j.name.includes(filter));
if (wanted.length === 0) throw new Error(`no banner shot matches "${filter}"`);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5233 }, logLevel: 'error' });
await vite.listen(5233);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 220)));
await page.goto('http://127.0.0.1:5233/scripts/banner-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let bad = 0;
console.log(
  'shot'.padEnd(22) + 'net'.padStart(5) + 'bar'.padStart(5) + 'rope'.padStart(6) +
  'pole'.padStart(6) + 'parts'.padStart(7) + 'in-stand'.padStart(9) + 'sag'.padStart(7) + '   notes',
);
for (const job of wanted) {
  const r = (await page.evaluate(
    (spec) => (window as never as { __shoot: (s: unknown) => Promise<unknown> }).__shoot(spec),
    {
      template: TEMPLATE, kind: job.kind, progress: job.progress,
      material: job.material, wind: job.wind,
      elevationDeg: job.elevationDeg, settleS: job.settleS,
    },
  )) as Shot;
  if (r.error) {
    console.error(job.name, r.error);
    bad++;
    continue;
  }
  writeFileSync(`${OUT}/${job.name}.png`, Buffer.from(r.png.split(',')[1], 'base64'));

  const p = KIND_PROFILE[job.kind];
  const flags: string[] = [];
  if (r.census.banners !== 1) flags.push(`BANNERS=${r.census.banners}`);
  if (p.netBacked && r.census.nets < 1) flags.push('NO-NET');
  if (!p.netBacked && r.census.nets > 0) flags.push('UNWANTED-NET');
  if (p.weightBar && r.census.bars < 1) flags.push('NO-BAR');
  if (p.roped && r.census.ropes < 1) flags.push('NO-ROPES');
  if (job.kind === 'pole-out' && r.census.poles < 2) flags.push('NO-POLES');
  if (!r.stand) flags.push('NO-STAND-FRAME');
  if (!r.framed) flags.push('NOT-FRAMED');
  // A banner that has collapsed into a rope still censuses fine and still
  // measures zero penetration. Its BOX is what gives it away.
  if (r.bounds) {
    const w = Math.hypot(r.bounds.max[0] - r.bounds.min[0], r.bounds.max[2] - r.bounds.min[2]);
    const span = Math.hypot(w, r.bounds.max[1] - r.bounds.min[1]);
    const want = Math.hypot(KIND_PROFILE[job.kind].widthM, KIND_PROFILE[job.kind].heightM);
    // Half the diagonal is generous — a sheet draped over a rake is genuinely
    // shorter end to end than it is long. A quarter of it is a crumple.
    if (job.progress > 0.9 && span < want * 0.5) flags.push(`CRUMPLED=${span.toFixed(1)}m/${want.toFixed(1)}m`);
  } else {
    flags.push('NO-BOUNDS');
  }
  if (process.env.BANNER_BOUNDS && r.bounds) {
    const b = r.bounds;
    console.log(`    box  x ${b.min[0].toFixed(1)}..${b.max[0].toFixed(1)}   y ${b.min[1].toFixed(1)}..${b.max[1].toFixed(1)}   z ${b.min[2].toFixed(1)}..${b.max[2].toFixed(1)}`);
  }
  // A rig can be complete and still be wrong. This is the check that was
  // missing the first time round, and the only one that would have caught the
  // banner slicing through the terracing.
  if (!(r.penetration <= PENETRATION_MAX_M)) flags.push(`IN-STAND=${r.penetration.toFixed(2)}m`);
  if (r.census.particles < 30) flags.push(`NO-CLOTH=${r.census.particles}`);
  if (!(r.sag <= SAG_MAX_M)) flags.push(`SAG=${r.sag.toFixed(2)}m`);
  if (flags.length) bad++;
  console.log(
    job.name.padEnd(22) +
      String(r.census.nets).padStart(5) + String(r.census.bars).padStart(5) +
      String(r.census.ropes).padStart(6) + String(r.census.poles).padStart(6) +
      String(r.census.particles).padStart(7) +
      r.penetration.toFixed(3).padStart(9) +
      r.sag.toFixed(3).padStart(7) +
      (flags.length ? '   <- ' + flags.join(' ') : ''),
  );
}

// The stand the banners hung on, and what a default banner of each type weighs
// on it. Printed rather than asserted: these are the numbers the panel shows a
// user, and seeing them drift is the point.
const probe = (await page.evaluate(
  (spec) => (window as never as { __shoot: (s: unknown) => Promise<unknown> }).__shoot(spec),
  { template: TEMPLATE, kind: 'drop', progress: 1, settleS: 0.5 },
)) as Shot;
if (probe.stand) {
  console.log(`\nNorth stand: ${probe.stand.width.toFixed(1)} m wide, ${probe.stand.height.toFixed(1)} m high`);
  for (const kind of BANNER_KINDS) {
    const f = bannerFacts(newBanner(kind));
    console.log(
      `  ${kind.padEnd(15)} ${String(KIND_PROFILE[kind].widthM).padStart(5)} x ${String(KIND_PROFILE[kind].heightM).padStart(5)} m` +
      `  ${String(f.panels).padStart(3)} panels  ${f.weightKg.toFixed(1).padStart(7)} kg  ${String(f.carriers).padStart(3)} carriers`,
    );
  }
}

// The timings, printed as what they claim to be: a distance and a speed. The
// first version of this ran every reveal for 4.2 seconds, which is roughly
// right for a drop and an order of magnitude wrong for a rope lift.
console.log('\nreveal timings');
for (const kind of BANNER_KINDS) {
  const p = KIND_PROFILE[kind];
  const ms = physicalRevealMs(kind, p.widthM, p.heightM);
  const why =
    p.reveal === 'drop' ? `free fall ${freeFallSeconds(p.heightM).toFixed(1)}s + settle`
    : p.reveal === 'lift' ? `${p.heightM} m hauled at ${DEPLOY_SPEED.haul} m/s`
    : p.reveal === 'hoist' ? `${p.heightM} m lowered at ${DEPLOY_SPEED.hoist} m/s`
    : p.reveal === 'pass' ? `${p.heightM} m of block at ${DEPLOY_SPEED.pass} m/s`
    : p.reveal === 'unfold' ? 'pole sweep at arm speed'
    : 'already rigged; a cut';
  console.log(`  ${kind.padEnd(15)} ${p.reveal.padEnd(7)} ${(ms / 1000).toFixed(1).padStart(6)} s   ${why}`);
}
// The bands real deployments fall in. Outside them the animation is not slow
// or fast, it is a different event.
const BAND: Partial<Record<BannerKind, [number, number]>> = {
  drop: [3, 8],
  lift: [20, 60],
  'overhead-pass': [20, 45],
  'roof-hung': [25, 100],
};
for (const [kind, band] of Object.entries(BAND) as [BannerKind, [number, number]][]) {
  const p = KIND_PROFILE[kind];
  const s2 = physicalRevealMs(kind, p.widthM, p.heightM) / 1000;
  if (s2 < band[0] || s2 > band[1]) {
    console.error(`  "${kind}" reveals in ${s2.toFixed(1)}s, outside the real ${band[0]}-${band[1]}s band`);
    bad++;
  }
}

// Every reveal curve has to start at 0 and finish at 1, or a banner either
// never appears or never finishes appearing. `hoist` deliberately overshoots
// on the way, which is a mass on a rope settling, so only the ends are held.
for (const mode of ['drop', 'lift', 'pass', 'hoist', 'unfold', 'fade'] as const) {
  const a = revealEase(mode, 0);
  const b = revealEase(mode, 1);
  if (Math.abs(a) > 1e-6 || Math.abs(b - 1) > 1e-6) {
    console.error(`  reveal "${mode}" does not run 0→1 (got ${a} → ${b})`);
    bad++;
  }
}

await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}${bad ? `  (${bad} with flags)` : ''}`);
if (bad) process.exitCode = 1;
