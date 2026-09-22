/**
 * Dev-only: what a banner actually looks like in the product.
 *
 *   npm run shots:banner              → preview-out/banners/*.png
 *   npm run shots:banner <ground>     → just that ground
 *
 * `npm run sweep:banner` proves the geometry — every slot, every ground, both
 * kinds — and proves nothing about whether it LOOKS like a banner. This is the
 * other half: real frames from the real simulator, with the rig's own
 * penetration figure printed beside each one, because a screenshot cannot tell
 * you a sheet is two centimetres inside the concrete and a number cannot tell
 * you it reads as a folded screen.
 *
 * Shot from a LOW, grazing angle on purpose. From the camera gantry a banner
 * that has sunk into the seating looks identical to one lying on it; from
 * pitch level, looking along the terracing, it is unmistakable.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/banners');
const filter = process.argv[2] ?? '';

interface Spec {
  name: string;
  ground: string;
  kind: 'stand' | 'hanging';
  stand: 0 | 1 | 2 | 3;
  from: number;
  span: number;
  tier: number;
  aspect?: number;
  wind?: number;
  progress?: number;
  elevationDeg?: number;
  tod?: 'day' | 'night';
  label?: string;
  /**
   * Also write a second frame, most of a gust later.
   *
   * For eyeballing the wind, which no single still can show. The GEOMETRY
   * moving is proved by the sweep's MOVES check; what these two frames answer
   * is whether you can SEE it, which is a question about the material as much
   * as about the motion.
   */
  pair?: boolean;
}

/**
 * The shots that would have caught the last four rounds of bugs.
 *
 * Not a gallery: each one is a case that broke before. The whole-stand run is
 * where a banner used to hang into the skyline; the corner run is where the
 * geometry used to fold; the tall aspect is where a size change used to break
 * it; the grazing angle is where a sunk banner used to hide.
 */
const SHOTS: Spec[] = [
  { name: 'kop-two-blocks', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, label: 'ALWAYS' },
  { name: 'kop-two-blocks-grazing', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, elevationDeg: 6, label: 'ALWAYS' },
  { name: 'whole-stand', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: 0, span: 8, tier: -1, label: 'ONE CLUB' },
  { name: 'corner-run', ground: 'generic-bowl-60k', kind: 'stand', stand: 1, from: 0, span: 3, tier: -1, label: 'NORD' },
  { name: 'upper-tier', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 3, tier: 1, label: 'ULTRAS' },
  { name: 'lower-tier', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 3, tier: 0, label: 'ULTRAS' },
  { name: 'tall-aspect', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 1, tier: -1, aspect: 2.4, label: 'S' },
  { name: 'wide-aspect', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 4, tier: -1, aspect: 0.18, label: 'FOREVER' },
  { name: 'hanging-whole', ground: 'generic-bowl-60k', kind: 'hanging', stand: 0, from: -1, span: 2, tier: -1, label: 'CURVA' },
  { name: 'hanging-lower', ground: 'generic-bowl-60k', kind: 'hanging', stand: 0, from: -1, span: 2, tier: 0, label: 'CURVA' },
  { name: 'hanging-fascia', ground: 'generic-bowl-60k', kind: 'hanging', stand: 0, from: -1, span: 4, tier: 1, label: 'CURVA NORD' },
  // Every stand, so "changing the stand does nothing" cannot come back
  // unnoticed: the four frames have to be four different parts of the ground.
  { name: 'stand-N', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, label: 'NORD' },
  { name: 'stand-E', ground: 'generic-bowl-60k', kind: 'stand', stand: 1, from: -1, span: 2, tier: -1, label: 'EST' },
  { name: 'stand-S', ground: 'generic-bowl-60k', kind: 'stand', stand: 2, from: -1, span: 2, tier: -1, label: 'SUD' },
  { name: 'stand-W', ground: 'generic-bowl-60k', kind: 'stand', stand: 3, from: -1, span: 2, tier: -1, label: 'OVEST' },
  { name: 'windy', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, wind: 1, pair: true, label: 'ALWAYS' },
  { name: 'still', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, wind: 0, pair: true, label: 'ALWAYS' },
  // Halfway through each reveal. Both pay out DOWNWARD from a fixed top
  // edge — a rolled cover down the terracing, a flown sheet off its rigging
  // — so at a third of the way through each should be a short banner hanging
  // from where its full-length one starts, not a full one somewhere else.
  { name: 'reveal-stand-35', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, progress: 0.35, label: 'ALWAYS' },
  { name: 'reveal-hanging-35', ground: 'generic-bowl-60k', kind: 'hanging', stand: 0, from: -1, span: 2, tier: -1, progress: 0.35, label: 'CURVA' },
  { name: 'night', ground: 'generic-bowl-60k', kind: 'stand', stand: 0, from: -1, span: 3, tier: -1, tod: 'night', label: 'ALWAYS' },
  { name: 'steep-cauldron', ground: 'community-steep-cauldron-55k', kind: 'stand', stand: 0, from: -1, span: 3, tier: -1, label: 'CAULDRON' },
  { name: 'small-arena', ground: 'community-kingdom-arena-28k', kind: 'stand', stand: 0, from: 0, span: 4, tier: -1, label: 'RIYADH' },
  { name: 'small-arena-low', ground: 'community-kingdom-arena-28k', kind: 'stand', stand: 0, from: 0, span: 4, tier: -1, elevationDeg: 14, label: 'RIYADH' },
  { name: 'small-arena-one', ground: 'community-kingdom-arena-28k', kind: 'stand', stand: 0, from: -1, span: 1, tier: -1, label: 'RIYADH' },
  { name: 'single-kop', ground: 'single-kop-40k', kind: 'stand', stand: 0, from: -1, span: 2, tier: -1, label: 'KOP' },
];

interface Shot {
  png: string;
  census: { banners: number; ropes: number; bars: number; particles: number };
  penetration: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  focused: boolean;
  png2: string | null;
  travelled: number;
  cam: [number, number, number];
  error?: unknown;
}

const wanted = SHOTS.filter((s) => !filter || s.name.includes(filter) || s.ground.includes(filter));
if (wanted.length === 0) throw new Error(`no shot matches "${filter}"`);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5233 }, logLevel: 'error' });
await vite.listen(5233);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
await page.goto('http://127.0.0.1:5233/scripts/banner-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

// Only a full run clears the folder. A filtered run is someone iterating on
// one shot, and wiping the other fourteen while they do it means the contact
// sheet they were comparing against is gone.
if (!filter && existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let bad = 0;
console.log('shot'.padEnd(26) + 'banners'.padStart(8) + 'bars'.padStart(6) + 'ropes'.padStart(7) + 'in-stand'.padStart(10) + '   size (w x h x d, m)');
for (const s of wanted) {
  const r = (await page.evaluate(
    (spec) => (window as never as { __shoot: (a: unknown) => Promise<unknown> }).__shoot(spec),
    s as unknown,
  )) as Shot;
  if (r.error) { console.error(`${s.name}: ${String(r.error).slice(0, 200)}`); bad++; continue; }
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  if (r.png2) writeFileSync(`${OUT}/${s.name}-later.png`, Buffer.from(r.png2.split(',')[1], 'base64'));

  const b = r.bounds;
  const dims = b
    ? `${(b.max[0] - b.min[0]).toFixed(0)} x ${(b.max[1] - b.min[1]).toFixed(0)} x ${(b.max[2] - b.min[2]).toFixed(0)}`
    : '—';
  const flags: string[] = [];
  if (r.census.banners !== 1) flags.push(`BANNERS ${r.census.banners}`);
  // Zero by construction. A non-zero figure means the construction is not
  // what I think it is, which is the only interesting failure left.
  if (r.penetration > 0.001) flags.push(`IN-STAND ${r.penetration.toFixed(3)} m`);
  if (!r.focused) flags.push('NO-FOCUS');
  if (!b) flags.push('NO-BOUNDS');
  else if (b.max[1] - b.min[1] < 1) flags.push('FLAT');
  if (flags.length) bad++;
  console.log(
    s.name.padEnd(26) + String(r.census.banners).padStart(8) + String(r.census.bars).padStart(6) +
    String(r.census.ropes).padStart(7) + r.penetration.toFixed(3).padStart(10) + '   ' + dims +
    `  cam(${r.cam.map((v) => v.toFixed(0)).join(',')})` +
    (s.pair ? '  (+ -later.png, 0.9 s on)' : '') +
    (flags.length ? '   ' + flags.join(' ') : ''),
  );
}

await browser.close();
await vite.close();
console.log(`\n${wanted.length} shot(s) -> preview-out/banners`);
if (bad) {
  console.error(`${bad} shot(s) flagged`);
  process.exitCode = 1;
}
