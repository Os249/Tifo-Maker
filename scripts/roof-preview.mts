/**
 * Dev-only: look at every catalogue roof before believing it.
 *   npx tsx scripts/roof-preview.mts            → preview-out/roof/*.png
 *   npx tsx scripts/roof-preview.mts <id-part>  → just the ones matching
 *
 * Two shots per stadium. The outside one shows the silhouette and the slope;
 * the inside one, taken from the pitch looking up at the far stand, shows the
 * only thing that really matters — how much of the tifo the roof is standing
 * in front of, and whether its underside reads as a surface or as a black hole.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/roof');
const filter = process.argv[2] ?? '';
const SHOTS = ['outside', 'inside', 'broadcast'] as const;

const wanted = STADIUM_CATALOG.filter((s) => !filter || s.id.includes(filter));
if (wanted.length === 0) throw new Error(`no catalogue stadium matches "${filter}"`);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5227 }, logLevel: 'error' });
await vite.listen(5227);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1100, height: 660 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5227/scripts/roof-preview.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

console.log('stadium'.padEnd(26) + 'seats'.padStart(7) + ' under roof' + '   roof');
for (const s of wanted) {
  const r = (await page.evaluate(
    ([id, shots]) => (window as never as { __render: (a: unknown, b: unknown) => Promise<unknown> }).__render(id, shots),
    [s.id, SHOTS as unknown as string[]] as [string, string[]],
  )) as { shots: Record<string, string>; seats: number; roof: Record<string, unknown> | null; coveredPct: number; reach: number; error?: unknown };
  if (r.error) { console.error(s.id, r.error); continue; }
  for (const [k, data] of Object.entries(r.shots)) {
    writeFileSync(`${OUT}/${s.id}-${k}.png`, Buffer.from(data.split(',')[1], 'base64'));
  }
  const roof = r.roof
    ? `${String(r.roof.coverage ?? 'ring')} reach ${String(r.roof.reach ?? 0.5)} rise ${String(r.roof.rise ?? 6)}`
    : '(defaults)';
  console.log(
    String(s.meta?.name ?? s.id).slice(0, 25).padEnd(26) +
    String(r.seats).padStart(7) + '  ' +
    `${r.coveredPct.toFixed(0)}% (${r.reach.toFixed(1)}m)`.padStart(11) + '   ' + roof,
  );
}

await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}`);
