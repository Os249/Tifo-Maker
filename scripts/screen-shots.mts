/**
 * Dev-only: every big screen of every ground, rendered by the REAL simulator
 * (scripts/jewel-shots.html), to check by eye that each stands where the real
 * one does and nowhere near the seats. Two views a screen:
 *
 *   - `pitch`: from the pitch, a third of the way to it, at head height, looking level at it
 *   - `wide`:  from high over the far touchline, the screen in its corner of the bowl
 *
 *   npx tsx scripts/screen-shots.mts [id ...]   → preview-out/screens/<id>-<n>-<view>.png
 *
 * Where a screen stands comes from core/screens.ts, the same placement the
 * renderer uses and `npm run verify` checks (scripts/screen-audit.mts prints
 * the numbers).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';
import { STADIUM_CATALOG, LEGACY_STADIUMS } from '../src/core/stadiumCatalog';
import { screenPlacements } from '../src/core/screens';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out', 'screens');
mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
const entries = [...STADIUM_CATALOG, ...LEGACY_STADIUMS].filter((e) => (want.length ? want.includes(e.id) : !e.meta.supersededBy) && screenPlacements(e.template).length);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5236 }, logLevel: 'error' });
await vite.listen(5236);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
}).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push('page error: ' + e.message.slice(0, 300)));
await page.goto('http://127.0.0.1:5236/scripts/jewel-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

type V = { name: string; position: number[]; target: number[]; fov: number; time: 'day' };
for (const e of entries) {
  await page.evaluate(([i]) => (window as never as { __open: (a: string, b: unknown) => Promise<unknown> }).__open(i, { time: 'day', screen: 'stadium' }), [e.id] as const);
  const { a, b } = e.template.plan;
  for (const [k, p] of screenPlacements(e.template).entries()) {
    const d = Math.hypot(p.x, p.z) || 1;
    const dir = [p.x / d, p.z / d];
    // A third of the way from the centre spot, at head height, looking level:
    // Match Day's camera never looks up (its orbit stops just short of the
    // horizon), so a raised target would lift the camera to the screen's
    // height, and a screen hung under a roof would vanish behind it.
    const from = [dir[0] * d * 0.33, 1.7, dir[1] * d * 0.33];
    const dist = Math.hypot(p.x - from[0], p.z - from[2]);
    const up = (Math.atan((p.y + p.h / 2 - 1.7) / dist) * 180) / Math.PI;
    const across = (Math.atan((p.w * 1.6) / dist) * 180) / Math.PI;
    const fov = Math.min(85, Math.max(30, 2 * up + 12, across));
    // High over the far touchline (or the far end), looking across at it.
    const far = [-dir[0] * (a + 10), 32, -dir[1] * (b + 10)];
    const views: V[] = [
      { name: 'pitch', position: from, target: [p.x, 1.6, p.z], fov, time: 'day' },
      { name: 'wide', position: far, target: [p.x * 0.85, p.y * 0.6, p.z * 0.85], fov: 50, time: 'day' },
    ];
    for (const v of views) {
      const png = (await page.evaluate(([vv]) => (window as never as { __shoot: (a: unknown) => Promise<string> }).__shoot(vv), [{ floods: false, ...v }])) as string;
      writeFileSync(`${OUT}/${e.id}-${k}-${v.name}.png`, Buffer.from(png.split(',')[1], 'base64'));
    }
  }
  console.log('shot', e.id);
}
await browser.close();
await vite.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n  ` + [...new Set(errors)].join('\n  '));
  process.exitCode = 1;
}
