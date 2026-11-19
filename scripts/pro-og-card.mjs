/**
 * /pro's link-preview picture (public/pro/og-pro.png, 1200 x 630): the page's
 * own Pro film frame (public/pro/film.webp, a real export of the one
 * fan-made design every /pro picture uses) under the site's name and the
 * crown. No words but the name, so one picture serves both languages, and no
 * price: the price is the server's and it changes.
 *
 *   node scripts/pro-og-card.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const frame = readFileSync('public/pro/film.webp').toString('base64');
const CROWN = '<svg viewBox="0 0 24 24" width="44" height="44" fill="#F5B93A"><path d="M3.2 7.6l4.6 3.6 3.4-5.7a.95.95 0 0 1 1.6 0l3.4 5.7 4.6-3.6a.6.6 0 0 1 .96.58L19.9 17H4.1L2.24 8.18a.6.6 0 0 1 .96-.58z"/><path d="M4.4 18.6h15.2V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z"/></svg>';
const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; }
  .card { position: relative; width: 1200px; height: 630px; overflow: hidden; background: #0A1020; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 42%; }
  .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8, 12, 26, 0.86) 0%, rgba(8, 12, 26, 0.25) 34%, rgba(8, 12, 26, 0) 55%); }
  .name { position: absolute; left: 56px; top: 44px; display: flex; align-items: center; gap: 18px; font-weight: 800; font-size: 54px; letter-spacing: -0.02em; color: #F4F6FC; }
  .name b { color: #4C8DF6; font-weight: 800; }
  .pro { display: inline-flex; align-items: center; gap: 10px; margin-left: 6px; padding: 6px 22px 6px 16px; border: 2px solid #C99A2E; border-radius: 999px; background: rgba(20, 16, 6, 0.72); color: #F5B93A; font-size: 44px; }
</style><div class="card"><img src="data:image/webp;base64,${frame}"><div class="shade"></div>
<div class="name"><span>TIFO<b>MAKER</b></span><span class="pro">${CROWN}Pro</span></div></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.locator('.card').screenshot({ path: 'public/pro/og-pro.png' });
await browser.close();
console.log('wrote public/pro/og-pro.png');
