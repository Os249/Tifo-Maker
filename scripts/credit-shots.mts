/**
 * Dev-only: the credit line (src/ui/creditLine.ts) on the backgrounds it has
 * to read on (a night sky, a floodlit white stand, a busy crowd, a gold tifo),
 * at the sizes it is drawn at (a 480 px GIF, Full HD, vertical 9:16, 4K), in
 * Latin and Arabic, with and without the site's mark. One picture to judge.
 *   npx tsx scripts/credit-shots.mts /home/claude/evidence/kit/credit-sheet.png
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = process.argv[2] ?? '/tmp/credit-sheet.png';
const vite = await createServer({ root: ROOT, server: { port: 5223 }, logLevel: 'error' });
await vite.listen(5223);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: 1330, height: 900 } });
  page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
  await page.goto('http://127.0.0.1:5223/scripts/credit-shots.html', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`credit-shots: ${outPath}`);
} finally {
  await browser.close();
  await vite.close();
}
