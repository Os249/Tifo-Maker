/**
 * Dev-only: how many seat rows does a word need before it reads?
 *   npx tsx scripts/ai-text-rows.mts OUTDIR
 * Draws one headline at a ladder of heights on a deep stand and writes each as
 * seats, so the threshold is judged by eye on the real seat grid.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? 'preview-out/ai-text-rows';
const STAD = process.argv[3] ?? 'jewel-jeddah-60k';
const STAND = JSON.parse(process.argv[4] ?? '"north"');
mkdirSync(OUT, { recursive: true });
const vite = await createServer({ root: ROOT, server: { port: 5242 }, logLevel: 'error' });
await vite.listen(5242);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error', e.message));
await page.goto('http://127.0.0.1:5242/scripts/ai-fit-harness.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });
const words = (process.argv[5] ?? 'CHAMPIONS|FORZA|الزعيم|نادي القرن').split('|');
const fonts = (process.argv[6] ?? 'poster').split(',');
const fracs = (process.argv[7] ?? '0.08,0.1,0.12,0.14,0.17,0.2,0.25').split(',').map(Number);
for (const w of words) for (const f of fonts) for (const h of fracs) {
  const r = await page.evaluate(([a, b, c, d, e, o]) => (window as never as { __textTest: (...x: unknown[]) => Promise<{ rows: number; png: string }> }).__textTest(a, b, c, d, e, 3, o), [STAD, w, f, h, STAND, Number(process.env.OUTLINE ?? 0)] as const);
  const name = `${OUT}/${f}-o${process.env.OUTLINE ?? 0}-${w.replace(/\s+/g, '_')}-${String(r.rows).padStart(2, '0')}rows.png`;
  writeFileSync(name, Buffer.from(r.png.split(',')[1], 'base64'));
  console.log(w, f, h, r.rows);
}
await browser.close(); await vite.close();
