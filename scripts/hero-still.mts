/**
 * Render the landing hero's still pictures: public/hero/<club>.webp and
 * public/hero/<club>-640.webp (the same picture for smaller screens), one pair
 * for every club in src/data/heroTifos.json. The home page opens on a
 * different club each visit (server/src/landingHero.ts), and the first thing
 * a visitor sees is that club's still.
 *   npx tsx scripts/hero-still.mts            every club
 *   npx tsx scripts/hero-still.mts hilal      one club
 *
 * Each is the live hero (src/heroStadium.ts) on that club (?hero=<club>), on
 * its own ground, rendered by the same code, captured from its own canvas
 * once the bowl has turned to a good angle, and encoded as WebP. The frame it
 * sits in has its own night ground, so the transparent background shows
 * that. Re-run it whenever data/heroTifos.json or the stadium look changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';
import HERO_TIFOS from '../src/data/heroTifos.json';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The hero box is at most ~360 CSS px wide on a phone, so 960 covers a 2.7×
// screen, and every step up costs more bytes than it shows. On a desktop it is
// at most ~574 px, so a 1× desktop takes the 640 copy (performance plan P1.14).
const OUT_DIR = resolve(ROOT, 'public/hero');
const outputs = (club: string) => [
  { out: resolve(OUT_DIR, `${club}.webp`), w: 960, h: 600 }, // the hero frame is 16:10
  { out: resolve(OUT_DIR, `${club}-640.webp`), w: 640, h: 400 },
];
const only = process.argv.slice(2);
const CLUBS = (HERO_TIFOS as { club: string }[]).map((t) => t.club).filter((c) => !only.length || only.includes(c));
if (!CLUBS.length) throw new Error(`no hero club called ${only.join(', ')}`);
mkdirSync(OUT_DIR, { recursive: true });

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241 }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }));
try {
  for (const club of CLUBS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
    // ?hero3d forces the live renderer even where the page would show this still.
    await page.goto(`http://127.0.0.1:5241/landing.html?hero3d&quality=high&hero=${club}`, { waitUntil: 'networkidle', timeout: 240_000 });
    await page.waitForSelector('#hero-3d.ready canvas', { timeout: 240_000 });
    // The stadium itself streams in after the first frame (render/stadiumShell.ts).
    await page.waitForSelector('#hero-3d[data-stadium="ready"]', { timeout: 240_000 });
    // Let it turn a little: the first frame faces the pitch square-on.
    await page.waitForTimeout(6000);
    // Both sizes from the same frame, so the srcset never mixes two angles.
    await page.evaluate(() => {
      const src = document.querySelector('#hero-3d canvas') as HTMLCanvasElement;
      const copy = document.createElement('canvas');
      copy.width = src.width;
      copy.height = src.height;
      copy.getContext('2d')!.drawImage(src, 0, 0);
      (window as unknown as { __heroFrame: HTMLCanvasElement }).__heroFrame = copy;
    });
    for (const { out, w, h } of outputs(club)) {
      const dataUrl = await page.evaluate(
        ({ w, h }) => {
          const src = (window as unknown as { __heroFrame: HTMLCanvasElement }).__heroFrame;
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d')!;
          // Smoothed on the way down, which keeps the seat rows from aliasing as badly.
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          // Cover-fit the renderer's canvas into the 16:10 box.
          const s = Math.max(w / src.width, h / src.height);
          const cw = w / s;
          const ch = h / s;
          ctx.drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, w, h);
          return c.toDataURL('image/webp', 0.74);
        },
        { w, h },
      );
      if (!dataUrl.startsWith('data:image/webp')) throw new Error('this browser cannot encode WebP');
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      writeFileSync(out, bytes);
      console.log(`hero still: ${out} (${(bytes.length / 1024).toFixed(1)} KB, ${w}×${h})`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
