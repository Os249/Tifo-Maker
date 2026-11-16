// Renders free-vs-pro.html to PNG: 4:5 (1080x1350) and 16:9 (1600x900), both at 2x.
// Run from the repo root after `npm ci` (the fonts come from node_modules):
//   node marketing/pro-launch/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = pathToFileURL(path.join(here, 'free-vs-pro.html')).href;
const shots = [
  { name: 'free-vs-pro-4x5.png', width: 1080, height: 1350, wide: false },
  { name: 'free-vs-pro-16x9.png', width: 1600, height: 900, wide: true },
];

const browser = await chromium.launch();
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  await page.goto(page_url);
  if (s.wide) await page.evaluate(() => document.body.classList.add('wide'));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(here, s.name) });
  await page.close();
}
await browser.close();
