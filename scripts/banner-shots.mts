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
import { BANNER_KINDS, KIND_PROFILE, newBanner, bannerFacts, revealEase, type BannerKind } from '../src/core/banner';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/banners');
const filter = process.argv[2] ?? '';
const TEMPLATE = 'generic-bowl-60k';

interface Shot {
  png: string;
  census: { banners: number; ropes: number; nets: number; bars: number; poles: number };
  stand: { width: number; height: number } | null;
  error?: unknown;
}

interface Job {
  name: string;
  kind: BannerKind;
  progress: number;
  material?: 'solid' | 'mesh';
  wind?: number;
}

const jobs: Job[] = [];
for (const kind of BANNER_KINDS) {
  jobs.push({ name: `${kind}-rest`, kind, progress: 1 });
  // Mid-reveal is where the rig has to be right: a roll half-way down a tier,
  // a sheet half-hauled, a crowd-pass wave half-way up the block.
  if (KIND_PROFILE[kind].reveal !== 'fade') jobs.push({ name: `${kind}-mid`, kind, progress: 0.45 });
}
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
console.log('shot'.padEnd(22) + 'net'.padStart(5) + 'bar'.padStart(5) + 'rope'.padStart(6) + 'pole'.padStart(6) + '   notes');
for (const job of wanted) {
  const r = (await page.evaluate(
    (spec) => (window as never as { __shoot: (s: unknown) => Promise<unknown> }).__shoot(spec),
    { template: TEMPLATE, kind: job.kind, progress: job.progress, material: job.material, wind: job.wind },
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
  if (flags.length) bad++;
  console.log(
    job.name.padEnd(22) +
      String(r.census.nets).padStart(5) + String(r.census.bars).padStart(5) +
      String(r.census.ropes).padStart(6) + String(r.census.poles).padStart(6) +
      (flags.length ? '   <- ' + flags.join(' ') : ''),
  );
}

// The stand the banners hung on, and what a default banner of each type weighs
// on it. Printed rather than asserted: these are the numbers the panel shows a
// user, and seeing them drift is the point.
const probe = (await page.evaluate(
  (spec) => (window as never as { __shoot: (s: unknown) => Promise<unknown> }).__shoot(spec),
  { template: TEMPLATE, kind: 'drop', progress: 1, settle: 120 },
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
