/**
 * The rebuilt Jewel of Jeddah, end to end, in the real app.
 *
 *   - the new ground opens with its real seat count, and the design view
 *     shows its gaps where the ambulance ramps are
 *   - the stadium panel lists its ramps, platforms, boxes and screens
 *   - a design still on the earlier Jewel opens exactly as it was saved, is
 *     told a newer one exists, and moves across only when asked
 *   - Match Day: the Stadium screens section is there on the Jewel and not on a
 *     ground without screens; the screens take the stadium name, the live tifo
 *     and a picture chosen from disk, in English and in Arabic
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * Screenshots land in preview-out/e2e-jewel/.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-jewel';
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

const LS = (lang = 'en') => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
  { name: 'tifo_consent_v1', value: 'essential' },
];

async function open(path, { lang = 'en', w = 1440, h = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang) }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  // A shader that does not compile only says so on the console, and the
  // picture silently loses whatever it drew — the crowd, once. Count it.
  p.on('console', (m) => {
    const t = m.text();
    if (/Shader Error|Program Info Log|WebGL: INVALID|THREE\.WebGLProgram/.test(t)) errs.push('GL: ' + t.slice(0, 200));
  });
  await p.goto(B + path, { waitUntil: 'networkidle', timeout: 120000 });
  return { ctx, p, errs };
}
const stat = (p) => p.$eval('#stat', (s) => s.textContent || '');
const seatsIn = (s) => Number((s.match(/([\d,٬]+)\s*(seats|مقعد)/) || [])[1]?.replace(/[,٬]/g, '') || NaN);
const waitReady = (p) => p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 120000 });
const simPng = (p) => p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png'));
const save = (name, dataUrl) => writeFileSync(`${OUT}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

// ---------------------------------------------------------------------------
console.log('\n— the new Jewel in the design view —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=jewel-jeddah-60k');
  await waitReady(p);
  await p.waitForTimeout(1500);
  const s = await stat(p);
  check('opens with the real seat count', seatsIn(s) === 59436, s);
  await p.screenshot({ path: `${OUT}/editor.png` });
  // The stadium panel lists what the ground has.
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('the panel names it', /The Jewel of Jeddah/.test(info), info.slice(0, 60));
  check('it lists the four ambulance ramps', /Ambulance ramps\s*4/.test(info));
  check('and the gold and silver platforms and the royal box', /Gold platform[\d,]+/.test(info) && /Silver platform[\d,]+/.test(info) && /Royal box seats[\d,]+/.test(info));
  check('and the boxes and the screens', /Hospitality boxes\s*44/.test(info) && /Big screens\s*2/.test(info));
  check('no "move to the new version" on the new one', !(await p.$('#stadium-info button.primary')));
  const listed = await p.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));
  check('the stadium list has exactly one Jewel', listed.filter((t) => /Jewel of Jeddah/.test(t)).length === 1, String(listed.filter((t) => /Jewel/.test(t)).length));
  await p.screenshot({ path: `${OUT}/stadium-panel.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— a design on the earlier Jewel —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=community-jewel-jeddah-62k');
  await waitReady(p);
  await p.waitForTimeout(1200);
  const s = await stat(p);
  check('opens on its own seat map, unchanged', seatsIn(s) === 61572, s);
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('says it is the earlier layout', /earlier layout/.test(info));
  check('and that a more accurate one exists', /more accurate/.test(info));
  const btn = await p.$('#stadium-info button.primary');
  check('with a button to move it', !!btn);
  await p.screenshot({ path: `${OUT}/legacy-panel.png` });
  // Moving is the owner's call: a confirm, then the stadium switch.
  await btn.click();
  await p.waitForSelector('#sw-continue', { timeout: 5000 });
  await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.click('#sw-continue')]);
  await waitReady(p);
  await p.waitForTimeout(1500);
  // A project keeps its stadium, so "moving" makes a copy on the new Jewel
  // and leaves the one on the earlier layout exactly as it was.
  await p.waitForFunction(() => /[?&]local=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
  check('it moves to the new Jewel', seatsIn(await stat(p)) === 59436, p.url());
  check('as a copy, with the original kept', await p.evaluate(() => {
    const idx = JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]');
    return idx.length === 2 && idx.some((x) => x.templateId === 'community-jewel-jeddah-62k') && idx.some((x) => x.templateId === 'jewel-jeddah-60k');
  }));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day on the Jewel: the screens —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=jewel-jeddah-60k&sim=1');
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(4000);
  const sec = await p.$('.mds-section[data-sec="screens"]');
  const shown = sec && (await sec.evaluate((s) => getComputedStyle(s).display !== 'none'));
  check('there is a Stadium screens section', !!shown);
  const heading = sec ? await sec.$eval('.mds-shead', (h) => h.textContent.trim()) : '';
  check('called "Stadium screens"', heading === 'Stadium screens', heading);
  const opts = await p.$$eval('[data-k="screen-mode"] option', (o) => o.map((x) => x.value).join(','));
  check('it offers the name, the live tifo and your own image', opts === 'stadium,tifo,image', opts);
  const shots = await p.$$eval('.mds-bar select option, .mds-panel select option', (o) => o.map((x) => x.textContent));
  check('the camera offers the royal box and a vehicle ramp', shots.includes('Royal Box') && shots.includes('Vehicle Ramp'));
  save('md-default', await simPng(p));

  await p.evaluate(() => {
    const s = document.querySelector('[data-k="screen-mode"]');
    s.value = 'tifo';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(800);
  check('the live tifo is picked', (await p.$eval('[data-k="screen-mode"]', (s) => s.value)) === 'tifo');
  // A picture from disk. It is read in the page and never sent anywhere.
  const posts = [];
  p.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });
  await p.setInputFiles('[data-k="screen-image"]', 'scripts/data/test-badge.png');
  await p.waitForTimeout(1500);
  check('choosing a file switches the screens to it', (await p.$eval('[data-k="screen-mode"]', (s) => s.value)) === 'image');
  check('the picture is never uploaded', posts.length === 0, posts.join(' '));
  // Look at the screen: the Royal Box camera faces the main stand; the end
  // screens are seen from the pitch. Use the end camera from the bar.
  save('md-image', await simPng(p));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day in Arabic, and on a ground without screens —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=jewel-jeddah-60k&sim=1', { lang: 'ar' });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  const heading = await p.$eval('.mds-section[data-sec="screens"] .mds-shead', (h) => h.textContent.trim());
  check('the section is in Arabic', heading === 'شاشات الملعب', heading);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, p, errs } = await open('/app?new=1&sim=1');
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  const hidden = await p.$eval('.mds-section[data-sec="screens"]', (s) => getComputedStyle(s).display === 'none');
  check('a ground with no screens does not offer them', hidden);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\njewel: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
