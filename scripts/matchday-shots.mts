/**
 * Dev-only: what a ground looks like from outside on match night, rendered by
 * the REAL simulator.
 *   npx tsx scripts/matchday-shots.mts            → preview-out/matchday/*.png
 *   npx tsx scripts/matchday-shots.mts <id-part>  → just the ones matching
 *
 * scripts/facade-preview.mts builds its own scene, which makes it fast and
 * makes it a liar about anything wired through buildStands or buildEffects.
 * This one boots MatchDaySimulator exactly as the app does and takes the shot
 * off its canvas, so a facade the product never adds, or a floodlight group
 * that ends up empty, shows up here and nowhere else.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { layOutLights } from '../src/render/simulator/lighting';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/matchday');
const filter = process.argv[2] ?? '';

interface Census { png: string; meshes: number; spotLights: number; lamps: number; instances: number; error?: unknown }

const wanted = STADIUM_CATALOG.filter((s) => !filter || s.id.includes(filter));
if (wanted.length === 0) throw new Error(`no catalogue stadium matches "${filter}"`);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5231 }, logLevel: 'error' });
await vite.listen(5231);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1100, height: 660 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5231/scripts/matchday-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let bad = 0;
console.log('stadium'.padEnd(25) + 'facade'.padEnd(10) + 'lighting'.padEnd(14) + 'lamps'.padStart(6) + 'spots'.padStart(6) + 'inst'.padStart(7));
for (const s of wanted) {
  const r = (await page.evaluate(
    ([id, floods]) => (window as never as { __shoot: (a: unknown, b: unknown) => Promise<unknown> }).__shoot(id, floods),
    [s.id, true] as [string, boolean],
  )) as Census;
  if (r.error) { console.error(s.id, r.error); bad++; continue; }
  writeFileSync(`${OUT}/${s.id}.png`, Buffer.from(r.png.split(',')[1], 'base64'));

  // The census is the check. Every luminaire the layout produced has to exist as
  // a lamp in the scene, and a facade style other than 'plain' has to have put
  // instanced members there — both are invisible in a dark screenshot.
  const plan = layOutLights(s.template);
  const style = s.template.facade?.style ?? 'plain';
  const flags: string[] = [];
  if (r.lamps < plan.luminaires.length) flags.push(`LAMPS ${r.lamps}<${plan.luminaires.length}`);
  if (plan.luminaires.length && r.spotLights === 0) flags.push('NO-SPOTS');
  if (style !== 'plain' && style !== 'berm' && r.instances < 20) flags.push('FACADE-MISSING');
  if (flags.length) bad++;
  console.log(
    String(s.meta?.name ?? s.id).slice(0, 24).padEnd(25) + style.padEnd(10) +
    plan.style.padEnd(14) + String(r.lamps).padStart(6) + String(r.spotLights).padStart(6) +
    String(r.instances).padStart(7) + (flags.length ? '  <- ' + flags.join(' ') : ''),
  );
}

await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}${bad ? `  (${bad} with flags)` : ''}`);
if (bad) process.exitCode = 1;
