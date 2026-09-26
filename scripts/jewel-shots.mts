/**
 * Dev-only: the Jewel of Jeddah (or any ground) from a fixed set of views,
 * rendered by the REAL simulator.
 *   npx tsx scripts/jewel-shots.mts [stadium-id] [out-subdir]
 *     → preview-out/<out-subdir>/<view>.png
 *
 * The views are chosen for what a fan checks: the broadcast angle, the main
 * stand with its VIP tribune and boxes, a corner with a vehicle tunnel, the
 * big screen, the roof from below, and the building from outside.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'jewel-jeddah-62k';
const OUT = resolve(ROOT, 'preview-out', process.argv[3] ?? 'jewel');
const only = process.argv[4] ?? '';
const openOpts = JSON.parse(process.argv[5] ?? '{}') as Record<string, unknown>;

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5233 }, logLevel: 'error' });
await vite.listen(5233);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
}).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5233/scripts/jewel-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });
mkdirSync(OUT, { recursive: true });

const opened = await page.evaluate((i) => (window as never as { __open: (a: string, b: unknown) => Promise<unknown> }).__open(i[0], i[1]), [id, openOpts] as [string, Record<string, unknown>]);
const { ax, bz, ty } = (await page.evaluate(() => (window as never as { __views: () => unknown }).__views())) as { ax: number; bz: number; ty: number };
console.log(id, opened, { ax: ax.toFixed(1), bz: bz.toFixed(1), ty: ty.toFixed(1) });

type V = { name: string; position: [number, number, number]; target: [number, number, number]; fov?: number };
const views: V[] = [
  // The reference angle: high in a corner of the upper tier, across the bowl.
  { name: '1-broadcast', position: [ax * 0.62, ty * 0.95, bz * 0.72], target: [-ax * 0.25, ty * 0.25, -bz * 0.25], fov: 62 },
  // The main stand (VIP tribune + boxes) straight on, from the far touchline.
  { name: '2-main-stand', position: [0, 6, bz * 0.45], target: [0, ty * 0.45, -bz], fov: 55 },
  // A corner: where the vehicle lanes come in.
  { name: '3-corner-lane', position: [ax * 0.12, 3.5, bz * 0.08], target: [ax * 0.5, 4, bz * 0.42], fov: 55 },
  // The royal box and the gold platform, from the halfway line.
  { name: '3b-royal-box', position: [0, 9, 4], target: [0, 20, -bz * 0.8], fov: 50 },
  // Behind a goal: the end-stand screen.
  { name: '4-end-screen', position: [ax * 0.25, 9, 0], target: [-ax, ty * 0.9, 0], fov: 55 },
  // Pitch level, looking up at the roof and the ring.
  { name: '5-roof-from-pitch', position: [ax * 0.2, 2, -bz * 0.25], target: [-ax * 0.3, ty * 1.6, bz * 0.4], fov: 70 },
  // Outside at night.
  { name: '6-outside', position: [ax * 1.55, ty * 0.55, bz * 1.45], target: [0, ty * 0.75, 0], fov: 50 },
  // A card display on the north stand, from high on the main stand.
  { name: '8-tifo', position: [ax * 0.3, ty * 0.95, -bz * 0.7], target: [-ax * 0.05, ty * 0.3, bz * 0.55], fov: 60 },
  // The east end's screen, close.
  { name: '9-screen', position: [ax * 0.1, 14, bz * 0.05], target: [ax, ty + 4.5, 0], fov: 32 },
  // The full bowl from above.
  { name: '7-aerial', position: [0, ty * 7, bz * 2.1], target: [0, 0, 0], fov: 50 },
];
for (const v of views) {
  if (only && !v.name.includes(only)) continue;
  const t0 = Date.now();
  const png = (await page.evaluate(([vv]) => (window as never as { __shoot: (a: unknown) => Promise<string> }).__shoot(vv), [v])) as string;
  writeFileSync(`${OUT}/${v.name}.png`, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`  ${v.name}  ${Date.now() - t0} ms`);
}
console.log('census', await page.evaluate(() => (window as never as { __census: () => unknown }).__census()));
await browser.close();
await vite.close();
