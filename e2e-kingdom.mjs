/**
 * The rebuilt Kingdom Arena, end to end, in the real app.
 *
 *   - the new ground opens with its seat count, and the stadium panel lists
 *     its 34 boxes and seven screens; it is the only Kingdom Arena offered
 *   - a design still on the earlier Kingdom Arena opens exactly as it was
 *     saved, is told a newer one exists, and moves across only when asked
 *   - Match Day: every camera is inside the hall; the screens take the
 *     stadium name and the live tifo; it is an indoor ground, so the weather
 *     is switched off with a note saying why, and "day" does not light the
 *     hall like daylight
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * Screenshots land in preview-out/e2e-kingdom/.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-kingdom';
const SEATS = 26580;
const OLD_SEATS = 26052;
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
/** Mean brightness (0..255) of the top quarter of the 3D view: the roof. */
const roofBrightness = (p) =>
  p.evaluate(async () => {
    const c = document.querySelector('.mds-overlay canvas');
    const img = new Image();
    img.src = c.toDataURL('image/png');
    await img.decode();
    const k = document.createElement('canvas');
    k.width = 160;
    k.height = 90;
    const g = k.getContext('2d');
    g.drawImage(img, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 22).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return s / (d.length / 4);
  });
const pick = (p, k, v) =>
  p.evaluate(([kk, vv]) => {
    const s = document.querySelector(`[data-k="${kk}"]`);
    s.value = vv;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, [k, v]);

// ---------------------------------------------------------------------------
console.log('\n— the new Kingdom Arena in the design view —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=kingdom-arena-26k');
  await waitReady(p);
  await p.waitForTimeout(1500);
  const s = await stat(p);
  check('opens with its seat count', seatsIn(s) === SEATS, s);
  await p.screenshot({ path: `${OUT}/editor.png` });
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('the panel names it', /Kingdom Arena/.test(info), info.slice(0, 60));
  check('it lists the 34 boxes', /Hospitality boxes\s*34/.test(info), info.slice(0, 300));
  check('and the seven screens', /Big screens\s*7/.test(info));
  check('no "move to the new version" on the new one', !(await p.$('#stadium-info button.primary')));
  const listed = await p.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));
  check('the stadium list has exactly one Kingdom Arena', listed.filter((t) => /Kingdom Arena/.test(t)).length === 1, String(listed.filter((t) => /Kingdom/.test(t)).length));
  await p.screenshot({ path: `${OUT}/stadium-panel.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— a design on the earlier Kingdom Arena —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=community-kingdom-arena-28k');
  await waitReady(p);
  await p.waitForTimeout(1200);
  check('opens on its own seat map, unchanged', seatsIn(await stat(p)) === OLD_SEATS, await stat(p));
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('says it is the earlier layout', /earlier layout/.test(info));
  check('and that a more accurate one exists', /more accurate/.test(info));
  const btn = await p.$('#stadium-info button.primary');
  check('with a button to move it', !!btn);
  await btn.click();
  await p.waitForSelector('#sw-continue', { timeout: 5000 });
  await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.click('#sw-continue')]);
  await waitReady(p);
  await p.waitForTimeout(1500);
  await p.waitForFunction(() => /[?&]local=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
  check('it moves to the new Kingdom Arena', seatsIn(await stat(p)) === SEATS, p.url());
  check('as a copy, with the original kept', await p.evaluate(() => {
    const idx = JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]');
    return idx.length === 2 && idx.some((x) => x.templateId === 'community-kingdom-arena-28k') && idx.some((x) => x.templateId === 'kingdom-arena-26k');
  }));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day in the Kingdom Arena —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=kingdom-arena-26k&sim=1');
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(4000);
  const sec = await p.$('.mds-section[data-sec="screens"]');
  check('there is a Stadium screens section', !!sec && (await sec.evaluate((s) => getComputedStyle(s).display !== 'none')));
  const shots = await p.$$eval('[data-k="camera"] option', (o) => o.map((x) => x.textContent));
  check('the cameras include the centre screen and the hospitality', shots.includes('Centre Screen') && shots.includes('Hospitality'), shots.join(', '));
  // Every camera, one after the other, all inside the hall.
  const values = await p.$$eval('[data-k="camera"] option', (o) => o.map((x) => x.value));
  for (const v of values) {
    await pick(p, 'camera', v);
    await p.waitForTimeout(2200);
    const name = shots[values.indexOf(v)].replace(/\W+/g, '-').toLowerCase();
    save(`cam-${name}`, await simPng(p));
  }
  check('every camera rendered', values.length >= 8, String(values.length));
  // Indoor: the weather is off, with a note; daylight does not light the hall.
  check('the weather is switched off indoors', await p.$eval('[data-k="weather"]', (s) => s.disabled));
  check('with a note saying why', /indoor arena/i.test((await p.$eval('[data-k="indoor-hint"]', (e) => e.textContent).catch(() => '')) || ''));
  // Same camera, settled, then night / day / night: day must look like night.
  await pick(p, 'camera', values[0]);
  await p.waitForTimeout(3000);
  await pick(p, 'tod', 'night');
  await p.waitForTimeout(1500);
  const night = await roofBrightness(p);
  await pick(p, 'tod', 'day');
  await p.waitForTimeout(1500);
  const day = await roofBrightness(p);
  await pick(p, 'tod', 'night');
  await p.waitForTimeout(1500);
  const night2 = await roofBrightness(p);
  check('"day" does not light the hall like daylight', Math.abs(day - night) < 6 && Math.abs(day - night2) < 6, `night ${night.toFixed(1)} day ${day.toFixed(1)} night ${night2.toFixed(1)}`);
  // The screens show the live tifo.
  await pick(p, 'screen-mode', 'tifo');
  await p.waitForTimeout(800);
  check('the live tifo is picked', (await p.$eval('[data-k="screen-mode"]', (s) => s.value)) === 'tifo');
  save('md-tifo', await simPng(p));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— in Arabic —');
{
  const { ctx, p, errs } = await open('/app?new=1&template=kingdom-arena-26k&sim=1', { lang: 'ar' });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  const shots = await p.$$eval('[data-k="camera"] option', (o) => o.map((x) => x.textContent));
  check('the cameras are named in Arabic', shots.includes('الشاشة المعلقة') && shots.includes('مقصورات الضيافة'), shots.join(', '));
  const hint = await p.$eval('[data-k="indoor-hint"]', (e) => e.textContent).catch(() => '');
  check('the indoor note is in Arabic', /ملعب مغطى/.test(hint || ''), hint || '');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\nkingdom: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
