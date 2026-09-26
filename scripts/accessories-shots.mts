/**
 * Dev-only: every Match Day accessory at every level, rendered by the REAL
 * simulator.
 *   npx tsx scripts/accessories-shots.mts            → preview-out/accessories/*.png
 *   npx tsx scripts/accessories-shots.mts flares     → just the shots matching
 *
 * Prints what each shot actually put in the stand (holders per accessory, live
 * particles, lights casting), and flags a level that did not add anything —
 * the one failure a picture of a smoky stand hides best.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/accessories');
const filter = process.argv[2] ?? '';

type Lv = Partial<Record<'flags' | 'flares' | 'smoke' | 'strobes' | 'paper' | 'phones', number>>;
interface Spec { name: string; shot?: string; ground?: string; levels?: Lv; where?: string; tod?: string; cam?: string; flare?: string; smoke?: string; quality?: string; floods?: boolean }
const G = 'generic-bowl-60k';
const specs: Spec[] = [
  { name: '00-off', levels: {} },
  { name: '00-off-pitch', levels: {}, shot: 'Pitch Level' },
];
for (const k of ['flags', 'flares', 'smoke', 'strobes', 'paper', 'phones'] as const) {
  for (let l = 1; l <= 4; l++) specs.push({ name: `${k}-${l}`, levels: { [k]: l } });
}
specs.push(
  ...(['flags', 'flares', 'smoke', 'strobes', 'paper', 'phones'] as const).flatMap((k) => [2, 4].map((l) => ({ name: `${k}-${l}-pitch`, levels: { [k]: l }, shot: 'Pitch Level' }))),
  ...(['flags', 'flares', 'smoke', 'strobes', 'paper', 'phones'] as const).map((k) => ({ name: `${k}-3-close`, levels: { [k]: 3 }, cam: 'close', shot: '', floods: false })),
  { name: 'uv-off', levels: {}, shot: 'Ultra View' },
  { name: 'uv-strobes-2', levels: { strobes: 2 }, shot: 'Ultra View' },
  { name: 'uv-flares-3', levels: { flares: 3 }, shot: 'Ultra View' },
  { name: 'uv-ultras', levels: { flags: 3, flares: 3, smoke: 2, strobes: 2, paper: 2 }, shot: 'Ultra View' },
  { name: 'flags-3-day-pitch', levels: { flags: 3 }, shot: 'Pitch Level', tod: 'day', floods: false },
  { name: 'flares-3-night-pitch', levels: { flares: 3 }, shot: 'Pitch Level', tod: 'night' },
  { name: 'flares-green-3', levels: { flares: 3 }, flare: 'green' },
  { name: 'flares-club-3', levels: { flares: 3 }, flare: 'club' },
  { name: 'smoke-red-3-day', levels: { smoke: 3 }, smoke: 'red', tod: 'day', floods: false, shot: 'Pitch Level' },
  { name: 'preset-terrace', levels: { flags: 2, flares: 1, smoke: 1 } },
  { name: 'preset-ultras', levels: { flags: 3, flares: 3, smoke: 2, strobes: 2, paper: 2 } },
  { name: 'preset-inferno', levels: { flags: 4, flares: 4, smoke: 4, strobes: 3, paper: 3 } },
  { name: 'preset-ultras-pitch', levels: { flags: 3, flares: 3, smoke: 2, strobes: 2, paper: 2 }, shot: 'Pitch Level' },
  { name: 'preset-inferno-pitch', levels: { flags: 4, flares: 4, smoke: 4, strobes: 3, paper: 3 }, shot: 'Pitch Level' },
  { name: 'all-ultras-drone', levels: { flags: 3, flares: 3, smoke: 2, strobes: 2 }, where: 'all', shot: 'Drone' },
  { name: 'ns-flares-3-drone', levels: { flares: 3 }, where: 'north-south', shot: 'Drone' },
  { name: 'low-tier-inferno', levels: { flags: 4, flares: 4, smoke: 4, strobes: 3, paper: 3 }, quality: 'low' },
  { name: 'jewel-ultras', ground: 'community-jewel-jeddah-62k', levels: { flags: 3, flares: 3, smoke: 2, strobes: 2, paper: 2 } },
  { name: 'kingdom-ultras-dusk', ground: 'community-kingdom-arena-28k', levels: { flags: 3, flares: 3, smoke: 2 }, tod: 'dusk' },
);
const wanted = specs.filter((s) => !filter || filter.split(',').some((f) => s.name.includes(f)));

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5232 }, logLevel: 'error' });
await vite.listen(5232);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('  page error:', e.message.slice(0, 200)); });
await page.goto('http://127.0.0.1:5232/scripts/accessories-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

if (!filter && existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let bad = 0;
const prev: Record<string, number> = {};
for (const s of wanted) {
  const r = (await page.evaluate(
    (spec) => (window as never as { __shoot: (a: unknown) => Promise<unknown> }).__shoot(spec),
    { ground: G, shot: 'TV Broadcast', ...s },
  )) as { png: string; census: { holders: Record<string, number>; particles: number; lightsOn: number } };
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  const h = r.census.holders;
  const flags: string[] = [];
  // Each level has to add fans: level n holds more than level n-1.
  const m = /^(flags|flares|smoke|strobes|paper|phones)-(\d)$/.exec(s.name);
  if (m) {
    const n = h[m[1]];
    if (!n) flags.push('EMPTY');
    if (prev[m[1]] !== undefined && n <= prev[m[1]]) flags.push(`NOT-MORE ${n}<=${prev[m[1]]}`);
    prev[m[1]] = n;
  }
  if (flags.length) bad++;
  console.log(s.name.padEnd(24) + Object.entries(h).map(([k, v]) => `${k}:${v}`).join(' ').padEnd(64) +
    `particles:${r.census.particles} lights:${r.census.lightsOn}` + (flags.length ? '  <- ' + flags.join(' ') : ''));
}
await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}${bad ? `  (${bad} with flags)` : ''}${errors.length ? `  ${errors.length} page errors` : ''}`);
if (bad || errors.length) process.exitCode = 1;
