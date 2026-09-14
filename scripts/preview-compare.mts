/**
 * Dev-only: render the SAME brief through four design tiers and save PNGs, so a
 * quality difference can be judged by eye before any of it is built.
 *   npx tsx scripts/preview-compare.mts
 *
 * Tier 1 is REAL output from composeSuperOffline(). Tiers 2-4 are hand-authored
 * stand-ins for what each model tier emits against the real director contract;
 * every one is then put through the REAL validateSpec + refineSpec + compileSpec
 * and rendered on the REAL 3D bowl, so the picture is honest even where the
 * spec's authorship is simulated.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';
import { composeSuperOffline } from '../src/core/promptDesigner';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out');
const CAM = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };

type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };

/** Validate + refine exactly as the live route does. */
function prep(raw: Raw): TifoSpec {
  const v = validateSpec(raw);
  if (!v.valid || !v.spec) throw new Error(`invalid: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
}

// ---------------------------------------------------------------- brief A
const BRIEF_A = 'الهلال بطل آسيا — تيفو يملأ الملعب كله';
const A_STADIUM = 'community-jewel-jeddah-62k';

/** Tier 2 — AI today, standard mode: no director prompt, no stadium context, no
 *  club table. One element stretched over the whole unrolled 10:1 bowl. */
const A2: Raw = {
  title: 'Al Hilal',
  summary: 'Blue bowl with the club name across it.',
  palette: ['#262a33', '#1e5fbf', '#ffffff'],
  background: 1,
  layers: [
    { kind: 'text', region: 'all', text: 'الهلال', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.45, align: 'center' },
    { kind: 'symbol', region: 'all', symbol: 'star', colorIndex: 2, scaleFrac: 0.3, align: 'top' },
  ],
};

/** Tier 3 — AI today, Super mode on Flash: the director prompt gives it per-stand
 *  roles, but with no club data the blue is wrong and the composition is timid. */
const A3: Raw = {
  title: 'Hilal Champions',
  summary: 'Crest stand, name opposite, striped sides.',
  palette: ['#262a33', '#1e5fbf', '#ffffff', '#c9a227'],
  background: 1,
  layers: [
    { kind: 'symbol', region: 'north', symbol: 'crescent', colorIndex: 2, scaleFrac: 0.45, align: 'center' },
    { kind: 'text', region: 'south', text: 'الهلال', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.3, align: 'center' },
    { kind: 'stripes', region: 'sides', colors: [1, 2], orientation: 'horizontal', bands: 14 },
  ],
};

/** Tier 4 — proposed: Pro + the matched club palette injected + a vision-critic
 *  pass. Authentic #0033a0, one dominant focal point per stand, everything big. */
const A4: Raw = {
  title: 'زعيم آسيا',
  summary: 'Crescent hero on the north, the name filling the south, gold champion band on the sides over deep club blue.',
  palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37', '#001d5c'],
  background: 1,
  layers: [
    { kind: 'fill', region: 'north', colorIndex: 2 },
    { kind: 'symbol', region: 'north', symbol: 'crescent', colorIndex: 1, scaleFrac: 0.92, align: 'center' },
    { kind: 'fill', region: 'south', colorIndex: 4 },
    { kind: 'text', region: 'south', text: 'الهلال', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.78, align: 'center' },
    { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'horizontal', bands: 9 },
  ],
};

// ---------------------------------------------------------------- brief B
const BRIEF_B = "Derby night, our captain's last game — number 10 and his name, black and gold, make the whole ground roar";
const B_STADIUM = 'community-grand-national-80k';

const B2: Raw = {
  title: 'Captain 10',
  summary: 'A large 10 over the bowl.',
  palette: ['#262a33', '#111111', '#e8b923', '#ffffff'],
  background: 1,
  layers: [
    { kind: 'stripes', region: 'all', colors: [1, 2], orientation: 'horizontal', bands: 6 },
    { kind: 'text', region: 'all', text: '10', colorIndex: 3, fontId: 'black', arcDeg: 0, heightFrac: 0.5, align: 'center' },
  ],
};

const B3: Raw = {
  title: 'Farewell Captain',
  summary: 'Number on one stand, name opposite, dark sides.',
  palette: ['#262a33', '#111111', '#e8b923', '#ffffff'],
  background: 1,
  layers: [
    { kind: 'text', region: 'north', text: '10', colorIndex: 2, fontId: 'black', arcDeg: 0, heightFrac: 0.4, align: 'center' },
    { kind: 'text', region: 'south', text: 'CAPTAIN', colorIndex: 3, fontId: 'impact', arcDeg: 0, heightFrac: 0.26, align: 'center' },
    { kind: 'fill', region: 'sides', colorIndex: 1 },
  ],
};

const B4: Raw = {
  title: 'Il Capitano',
  summary: 'Giant 10 owning the north, his name filling the south, gold chevrons driving the sides into both.',
  palette: ['#262a33', '#0d0d0f', '#e8b923', '#ffffff', '#3a2f08'],
  background: 1,
  layers: [
    { kind: 'fill', region: 'north', colorIndex: 2 },
    { kind: 'text', region: 'north', text: '10', colorIndex: 1, fontId: 'black', arcDeg: 0, heightFrac: 0.95, align: 'center' },
    { kind: 'fill', region: 'south', colorIndex: 1 },
    { kind: 'text', region: 'south', text: 'CAPITANO', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.7, align: 'center' },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 10 },
  ],
};

interface Job { key: string; label: string; tier: string; brief: string; stadium: string; spec: TifoSpec }

const jobs: Job[] = [
  { key: 'a1', label: 'Brief A', tier: 'Quick Designer (offline, real output)', brief: BRIEF_A, stadium: A_STADIUM, spec: refineSpec(composeSuperOffline(BRIEF_A)) },
  { key: 'a2', label: 'Brief A', tier: 'AI today — standard mode', brief: BRIEF_A, stadium: A_STADIUM, spec: prep(A2) },
  { key: 'a3', label: 'Brief A', tier: 'AI today — Super mode (Flash)', brief: BRIEF_A, stadium: A_STADIUM, spec: prep(A3) },
  { key: 'a4', label: 'Brief A', tier: 'Proposed — Pro + club data + critic', brief: BRIEF_A, stadium: A_STADIUM, spec: prep(A4) },
  { key: 'b1', label: 'Brief B', tier: 'Quick Designer (offline, real output)', brief: BRIEF_B, stadium: B_STADIUM, spec: refineSpec(composeSuperOffline(BRIEF_B)) },
  { key: 'b2', label: 'Brief B', tier: 'AI today — standard mode', brief: BRIEF_B, stadium: B_STADIUM, spec: prep(B2) },
  { key: 'b3', label: 'Brief B', tier: 'AI today — Super mode (Flash)', brief: BRIEF_B, stadium: B_STADIUM, spec: prep(B3) },
  { key: 'b4', label: 'Brief B', tier: 'Proposed — Pro + club data + critic', brief: BRIEF_B, stadium: B_STADIUM, spec: prep(B4) },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5201 }, logLevel: 'error' });
await vite.listen(5201);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5201/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const manifest: Array<Record<string, unknown>> = [];
for (const job of jobs) {
  const res = (await page.evaluate(
    ([spec, stadiumId, cam]) => (window as never as { __shot: (a: unknown, b: unknown, c: unknown) => Promise<unknown> }).__shot(spec, stadiumId, cam),
    [job.spec, job.stadium, CAM] as [TifoSpec, string, typeof CAM],
  )) as { ok: boolean; shot?: string; flat?: string; seats?: number; painted?: number; warnings?: string[]; errors?: unknown };

  if (!res.ok) { console.error(`FAIL ${job.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${job.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${job.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  const pct = ((res.painted! / res.seats!) * 100).toFixed(1);
  console.log(`OK  ${job.key}  ${job.tier}  painted ${res.painted}/${res.seats} (${pct}%)  layers ${job.spec.layers.length}  warn ${res.warnings?.length ?? 0}`);
  manifest.push({ ...job, spec: undefined, layers: job.spec.layers.length, palette: job.spec.palette,
                  title: job.spec.title, summary: job.spec.summary, painted: res.painted, seats: res.seats, pct,
                  warnings: res.warnings ?? [] });
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
await browser.close();
await vite.close();
console.log(`\nwrote ${manifest.length * 2} images to ${OUT}`);
