/**
 * Dev-only: does Arabic need MORE height than Latin to read at seat scale?
 *   npx tsx scripts/arabic-legibility.mts
 *
 * refineSpec enforces one MIN_TEXT_HEIGHT (0.22) for every text layer. Arabic
 * carries dots and thin connecting strokes that Latin capitals do not, so the
 * same height may not buy the same legibility. This measures it on the REAL seat
 * map: what fraction of each headline's seats land in sub-threshold strokes
 * (findFragileSeats) — i.e. detail too fine for a crowd to hold up.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAD = 'community-jewel-jeddah-62k';

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5219 }, logLevel: 'error' });
await vite.listen(5219);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5219/scripts/arabic-legibility.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

type R = { painted: number; fragile: number; error?: unknown };
const measure = (text: string, font: string, h: number, tier: number | 'all'): Promise<R> =>
  page.evaluate(
    ([s, t, f, hh, ti]) => (window as never as { __measure: (...a: unknown[]) => Promise<R> }).__measure(s, t, f, hh, ti),
    [STAD, text, font, h, tier] as [string, string, string, number, number | 'all'],
  );

const CASES: Array<[string, string]> = [
  ['LATIN  "CHAMPIONS"', 'CHAMPIONS'],
  ['ARABIC "نادي القرن"', 'نادي القرن'],
  ['ARABIC "هدفنا أفريقيا"', 'هدفنا أفريقيا'],
  ['ARABIC "الأهلي المصري"', 'الأهلي المصري'],
];
const HEIGHTS = [0.22, 0.3, 0.4, 0.55, 0.7, 0.85];

for (const tier of ['all', 0] as const) {
  console.log(`\n=== tier ${tier} — % of the headline's seats that are too fine to read ===`);
  console.log('text'.padEnd(26) + HEIGHTS.map((h) => `h=${h}`.padStart(9)).join(''));
  for (const [label, text] of CASES) {
    const cells: string[] = [];
    for (const h of HEIGHTS) {
      const r = await measure(text, 'poster', h, tier);
      cells.push(r.painted ? `${((r.fragile / r.painted) * 100).toFixed(0)}%`.padStart(9) : '   —'.padStart(9));
    }
    console.log(label.padEnd(26) + cells.join(''));
  }
}
await browser.close();
await vite.close();
