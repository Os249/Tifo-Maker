/**
 * The free designer on grounds of every size, in the real editor.
 *
 * A first visit that starts "from your club" draws the whole bowl with the
 * Quick Designer. Before October 2026 that design was planned for a 60-row bowl
 * and painted as-is: on Al-Majmaah (13-row stands) and Al-Hazem (a stand with no
 * seats at all) the words came out a few seats tall or not at all. Now every
 * design is fitted to the stadium's seats before it is painted.
 *
 *   - small and odd grounds: the design is fitted (the editor logs what moved)
 *     and Match Day opens on it
 *   - a big bowl: the design already reads, so the fit changes nothing
 *
 * Needs the server on :8911 with a built dist. Screenshots in preview-out/e2e-ai-fit/.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-ai-fit';
mkdirSync(OUT, { recursive: true });

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const LS = [
  { name: 'tifo_lang_v1', value: 'en' },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'tifo_draw_hint_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
];

/** Start a first project on `template` from a club typed into the guide. */
async function clubStart(template, club) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] } });
  const p = await ctx.newPage();
  const errs = [];
  const fitted = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  p.on('console', (m) => { if (/\[ai\] fitted/.test(m.text())) fitted.push(m.text()); });
  await p.goto(`${B}/app?new=1&template=${template}`, { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('#ob-club-input', { timeout: 60000 });
  await p.fill('#ob-club-input', club);
  await p.evaluate(() => document.getElementById('ob-club-own').requestSubmit());
  // The design lands, then the project is created and the URL becomes its own.
  await p.waitForFunction(() => /[?&](project|local)=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1500);
  return { ctx, p, errs, fitted };
}

const GROUNDS = [
  { id: 'majmaah-stadium-7k', small: true },
  { id: 'alhazem-stadium-8k', small: true },
  { id: 'coliseum-11k', small: true },
  { id: 'generic-bowl-60k', small: false },
];

for (const g of GROUNDS) {
  console.log(`\n— ${g.id} —`);
  const { ctx, p, errs, fitted } = await clubStart(g.id, 'Al Hilal الزعيم');
  const url = await p.evaluate(() => location.pathname + location.search);
  check('the club start made a project', /[?&](project|local)=/.test(url), url);
  await p.screenshot({ path: `${OUT}/${g.id}-editor.png` });
  if (g.small) check('the design was fitted to this ground', fitted.length > 0, fitted[0]?.slice(0, 160) ?? '');
  else check('a big bowl needs no fitting', fitted.length === 0, fitted[0]?.slice(0, 160) ?? '');
  // Match Day on the same project.
  await p.goto(`${B}${url}${url.includes('?') ? '&' : '?'}sim=1`, { waitUntil: 'networkidle', timeout: 120000 });
  const opened = await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 }).then(() => true, () => false);
  check('Match Day opens on it', opened);
  if (opened) {
    await p.waitForTimeout(4000);
    await p.screenshot({ path: `${OUT}/${g.id}-matchday.png` });
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\nai fit: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
