/**
 * Dev-only: render what scripts/photo-eval.mts built, beside the site's own
 * model of the same ground, from the same two views, with the real simulator
 * (scripts/photo-eval.html).
 *
 *   npx tsx scripts/photo-eval-render.mts <out> <label>[,<label>…] [only,…]
 *     → <out>/render/<label>/<photo>-<view>.jpg and <out>/render/site/<ground>-<view>.jpg
 *
 * Builds that come out identical (the same facts, the same ground) are drawn
 * once. The contact sheets are put together from these by the eval's sheet
 * step; this only draws.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';
import type { StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [out, labels, only] = process.argv.slice(2);
if (!out || !labels) throw new Error('usage: photo-eval-render.mts <out> <label>[,<label>…] [only]');
const want = only ? new Set(only.split(',')) : null;

type Build = { ground: string; template: StadiumTemplate; truthId?: string };
type View = { name: string; position: [number, number, number]; target: [number, number, number]; fov: number };

/**
 * Two views, framed from the bowl's own extent so they suit any size: from a
 * corner of the pitch at the front of the stands, across to the far corner,
 * where most fans' photos are taken and which shows the tiers, the corners
 * and the seats' colour; and from above, which shows the shape and the roof.
 */
function viewsFor(e: { ax: number; bz: number; ty: number; a: number; b: number }): View[] {
  return [
    { name: 'corner', position: [e.a * 0.68, e.ty * 0.4, e.b * 0.68], target: [-e.a * 0.55, e.ty * 0.35, -e.b * 0.55], fov: 75 },
    { name: 'aerial', position: [e.ax * 0.55, Math.max(e.ax, e.bz) * 2.1, e.bz * 1.9], target: [0, 0, 0], fov: 45 },
  ];
}

// No HMR and no watching: an edit anywhere in the tree while this runs (other
// work goes on beside it) would reload the page under a half-taken shot.
const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241, hmr: false, watch: null }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
}).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push('page error: ' + e.message.slice(0, 300)));
await page.goto('http://127.0.0.1:5241/scripts/photo-eval.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

const drawn = new Map<string, string>();
async function draw(what: StadiumTemplate | string, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // Drawn by an earlier run that stopped part-way: kept.
  if (existsSync(resolve(dir, `${name}-aerial.jpg`))) return;
  const key = typeof what === 'string' ? what : createHash('sha1').update(JSON.stringify({ ...what, id: '', name: '' })).digest('hex');
  const prior = drawn.get(key);
  if (prior) {
    for (const v of ['corner', 'aerial']) writeFileSync(resolve(dir, `${name}-${v}.jpg`), readFileSync(`${prior}-${v}.jpg`));
    return;
  }
  const ext = (await page.evaluate((w) => (window as never as { __open: (a: unknown) => Promise<unknown> }).__open(w), what as never)) as { ax: number; bz: number; ty: number; a: number; b: number };
  for (const v of viewsFor(ext)) {
    const jpg = (await page.evaluate((vv) => (window as never as { __shoot: (a: unknown) => Promise<string> }).__shoot(vv), v as never)) as string;
    writeFileSync(resolve(dir, `${name}-${v.name}.jpg`), Buffer.from(jpg.split(',')[1], 'base64'));
  }
  drawn.set(key, resolve(dir, name));
  console.log(`drew ${dir.split('/').pop()}/${name}`);
}

const sites = new Set<string>();
for (const label of labels.split(',')) {
  const builds: Record<string, Build> = JSON.parse(readFileSync(resolve(out, `build-${label}.json`), 'utf8'));
  for (const [file, b] of Object.entries(builds)) {
    if (want && !want.has(file)) continue;
    await draw(b.template, resolve(out, 'render', label), file.replace(/\.jpe?g$/, ''));
    if (b.truthId) sites.add(`${b.ground}|${b.truthId}`);
  }
}
for (const s of sites) {
  const [ground, id] = s.split('|');
  if (existsSync(resolve(out, 'render', 'site', `${ground}-corner.jpg`))) continue;
  await draw(id, resolve(out, 'render', 'site'), ground);
}
await browser.close();
await vite.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n  ` + [...new Set(errors)].join('\n  '));
  process.exitCode = 1;
}
