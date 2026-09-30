/**
 * Render public/hero-stadium.webp: the picture phones see in the landing hero.
 *   npx tsx scripts/hero-still.mts
 *
 * It is the live hero (src/heroStadium.ts), rendered by the same code on the
 * same design, captured from its own canvas once the bowl has turned to a good
 * angle, and encoded as WebP with the background left transparent so it sits
 * on both the light and the dark theme. Re-run it whenever the showpiece
 * design or the stadium look changes, or the phone picture falls out of step.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/hero-stadium.webp');
// Phones only: the hero box is at most ~360 CSS px wide there, so 960 covers
// a 2.7× screen, and every step up costs more bytes than it shows.
const W = 960;
const H = 720;

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241 }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
  // ?hero3d forces the live renderer even where the page would show this still.
  await page.goto('http://127.0.0.1:5241/landing.html?hero3d', { waitUntil: 'networkidle', timeout: 240_000 });
  await page.waitForSelector('#hero-3d.ready canvas', { timeout: 240_000 });
  // Let it turn a little: the first frame faces the pitch square-on.
  await page.waitForTimeout(6000);
  const dataUrl = await page.evaluate(
    ({ w, h }) => {
      const src = document.querySelector('#hero-3d canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      // Smoothed on the way down, which keeps the seat rows from aliasing as badly.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Cover-fit the renderer's canvas into the 4:3 box.
      const s = Math.max(w / src.width, h / src.height);
      const cw = w / s;
      const ch = h / s;
      ctx.drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, w, h);
      return c.toDataURL('image/webp', 0.74);
    },
    { w: W, h: H },
  );
  if (!dataUrl.startsWith('data:image/webp')) throw new Error('this browser cannot encode WebP');
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(OUT, bytes);
  console.log(`hero still: ${OUT} (${(bytes.length / 1024).toFixed(1)} KB, ${W}×${H})`);
} finally {
  await browser.close();
  await vite.close();
}
