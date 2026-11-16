// Renders the seven perk cards (perk.html?n=1..7) to PNG, 1080x1350 at 2x.
// From the repo root, after `npm ci`:  node marketing/pro-launch/perks/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = ['film', 'poster', 'no-mark', 'club-kit', 'fonts', 'led-boards', 'supporter-crown'];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
for (let n = 1; n <= NAMES.length; n++) {
  await page.goto(pathToFileURL(path.join(here, 'perk.html')).href + '?n=' + n);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(here, `perk-${n}-${NAMES[n - 1]}.png`) });
}
await browser.close();
