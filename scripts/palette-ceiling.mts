/**
 * Dev-only: is the 8-colour spec cap what actually limits AI tifo quality?
 *   npx tsx scripts/palette-ceiling.mts
 * Same artwork, same quantizer, same bowl — only the palette size changes.
 * DesignStore supports 256 colours; SPEC_LIMITS.maxPalette allows the AI 8.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/palette');
const STAD = 'community-jewel-jeddah-62k';

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5214 }, logLevel: 'error' });
await vite.listen(5214);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5214/scripts/palette-ceiling.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const [label, colours, wide] of [['08-spec-cap', 8, false], ['32-store', 32, false], ['32-wide', 32, true]] as const) {
  const r = (await page.evaluate(
    ([id, n, w]) => (window as never as { __bakeArtwork: (a: unknown, b: unknown, c: unknown) => Promise<unknown> }).__bakeArtwork(id, n, w),
    [STAD, colours, wide] as [string, number, boolean],
  )) as { bowl: string | null; flat: string; source: string; palette: string[] };
  if (r.bowl) writeFileSync(`${OUT}/${label}-bowl.png`, Buffer.from(r.bowl.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${label}-flat.png`, Buffer.from(r.flat.split(',')[1], 'base64'));
  if (label === '08-spec-cap') writeFileSync(`${OUT}/source.png`, Buffer.from(r.source.split(',')[1], 'base64'));
  console.log(`OK  ${label.padEnd(12)} ${r.palette.length} colours`);
}
await browser.close();
await vite.close();
