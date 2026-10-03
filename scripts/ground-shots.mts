/**
 * Dev-only: one real ground from the views a fan would check it against the
 * photographs with, rendered by the REAL simulator (scripts/jewel-shots.html),
 * by day unless a view says otherwise.
 *
 *   npx tsx scripts/ground-shots.mts <stadium-id> [out-subdir] [only] [views.json]
 *     → preview-out/<out-subdir>/<view>.png
 *
 * The default views are framed from the bowl's own extent, so they suit any
 * ground; a JSON file of { name, position, target, fov, time } overrides them
 * (to match a particular photograph). APP_SHOTS=1 renders the app's own
 * camera shots instead, by day or at APP_TIME (day | dusk | night), on a
 * wet pitch (the app's default) with APP_WET=1.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';
import { templateById } from '../src/core/stadiumCatalog';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) throw new Error('usage: ground-shots.mts <stadium-id> [out] [only] [views.json]');
const OUT = resolve(ROOT, 'preview-out', process.argv[3] ?? id);
const only = process.argv[4] ?? '';
const viewsFile = process.argv[5];
const tpl = templateById(id)!;

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5234 }, logLevel: 'error' });
await vite.listen(5234);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
}).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push('page error: ' + e.message.slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /Shader Error|Program Info Log|WebGL: INVALID/.test(t)) errors.push('console: ' + t.slice(0, 300));
});
await page.goto('http://127.0.0.1:5234/scripts/jewel-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });
mkdirSync(OUT, { recursive: true });

const opened = await page.evaluate((i) => (window as never as { __open: (a: string, b: unknown) => Promise<unknown> }).__open(i, { time: 'day', screen: 'stadium' }), id);
const { ax, bz, ty } = (await page.evaluate(() => (window as never as { __views: () => unknown }).__views())) as { ax: number; bz: number; ty: number };
console.log(id, opened, { ax: ax.toFixed(1), bz: bz.toFixed(1), ty: ty.toFixed(1) });

type V = { wet?: boolean; name: string; position: [number, number, number]; target: [number, number, number]; fov?: number; time?: 'day' | 'dusk' | 'night' };
const appShots = process.env.APP_SHOTS ? ((await page.evaluate(() => (window as never as { __appShots: () => V[] }).__appShots())) as V[]).map((v, i) => ({ ...v, name: `app-${i}-${v.name.replace(/\W+/g, '-')}`, ...(process.env.APP_TIME ? { time: process.env.APP_TIME as V['time'] } : {}), ...(process.env.APP_WET ? { wet: true } : {}) })) : null;
const views: V[] = appShots ? appShots : viewsFile
  ? (JSON.parse(readFileSync(viewsFile, 'utf8')) as V[])
  : (() => {
      // Framed from the plan, low enough to stay under any roof.
      const a = tpl.plan.a;
      const b = tpl.plan.b;
      return [
        // From the far touchline, at the main stand.
        { name: 'a-main-stand', position: [0, 2.5, b * 0.75], target: [0, 9, -(b + 12)], fov: 70 },
        // From the front of the main stand, across the pitch.
        { name: 'b-broadcast', position: [0, 9, -(b + 2)], target: [0, 3, b * 0.6], fov: 72 },
        // From a corner of the pitch, across the bowl.
        { name: 'c-corner', position: [a * 0.85, 3, b * 0.85], target: [-a * 0.3, 7, -b * 0.4], fov: 72 },
        // Behind a goal, at the far end.
        { name: 'd-end', position: [-a * 0.6, 2.2, 0], target: [a + 10, 8, 0], fov: 70 },
        // Pitch level, up at the roof over the stand opposite.
        { name: 'e-roof-edge', position: [a * 0.15, 1.8, -b * 0.3], target: [0, 22, b + 8], fov: 70 },
        // Outside, at the main stand's corner.
        { name: 'f-outside', position: [-(a + 95), 28, -(b + 115)], target: [0, 8, 0], fov: 45 },
        // From above.
        { name: 'g-aerial', position: [a * 0.5, 230, -(b + 160)], target: [0, 0, 0], fov: 45 },
        // The far touchline view at night, floodlights on.
        { name: 'h-night', position: [0, 2.5, b * 0.75], target: [0, 9, -(b + 12)], fov: 70, time: 'night' },
      ] as V[];
    })();
if (appShots) for (const v of appShots) console.log(v.name, v.position.map((n) => n.toFixed(1)).join(','), '->', v.target.map((n) => n.toFixed(1)).join(','));
const shot: string[] = [];
for (const v of views) {
  if (only && !only.split(',').some((o) => v.name.includes(o))) continue;
  const png = (await page.evaluate(([vv]) => (window as never as { __shoot: (a: unknown) => Promise<string> }).__shoot(vv), [{ time: 'day', floods: (v.time ?? 'day') !== 'day', ...v }])) as string;
  writeFileSync(`${OUT}/${v.name}.png`, Buffer.from(png.split(',')[1], 'base64'));
  shot.push(v.name);
}
console.log('views', shot.join(', '));
await browser.close();
await vite.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n  ` + [...new Set(errors)].join('\n  '));
  process.exitCode = 1;
}
