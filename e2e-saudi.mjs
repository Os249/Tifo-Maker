/**
 * The Saudi league's grounds, end to end, in the real app.
 *
 *   - every new ground opens with its own seat count, and the stadium panel
 *     names it; each is offered once, in English and in Arabic
 *   - a design still on the earlier Al-Awwal Park opens exactly as it was
 *     saved, is told a newer one exists, and moves across only when asked
 *   - Match Day opens on every ground, every camera renders a picture (not a
 *     blank frame), by day and at night, with no WebGL or page errors
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * Screenshots land in preview-out/e2e-saudi/.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-saudi';
mkdirSync(OUT, { recursive: true });

// id, seats (the generator's count, frozen in scripts/verify.mts), English and Arabic names.
const GROUNDS = [
  ['alawwal-park-26k', 26142, 'Al-Awwal Park (Riyadh)', 'الأول بارك (الرياض)'],
  ['shg-arena-14k', 13636, 'SHG Arena (Riyadh)', 'إس إتش جي أرينا (الرياض)'],
  ['ego-stadium-13k', 12740, 'EGO Stadium (Dammam)', 'ملعب إيجو (الدمام)'],
  ['alfateh-stadium-12k', 11836, 'Al-Fateh Stadium (Al-Ahsa)', 'ملعب نادي الفتح (الأحساء)'],
  ['pmbf-stadium-22k', 21920, 'Prince Mohamed bin Fahd Stadium (Dammam)', 'استاد الأمير محمد بن فهد (الدمام)'],
  ['alfaisal-stadium-27k', 26606, 'Prince Abdullah Al-Faisal Stadium (Jeddah)', 'ملعب الأمير عبدالله الفيصل (جدة)'],
  ['buraidah-stadium-25k', 24316, 'King Abdullah Sport City Stadium (Buraidah)', 'ملعب مدينة الملك عبدالله الرياضية (بريدة)'],
  ['abha-stadium-20k', 16430, 'Prince Sultan Sport City Stadium (Abha)', 'ملعب مدينة الأمير سلطان الرياضية (أبها)'],
  ['tabuk-stadium-12k', 11992, 'King Khalid Sport City Stadium (Tabuk)', 'ملعب مدينة الملك خالد الرياضية (تبوك)'],
  ['alhazem-stadium-8k', 6191, 'Al-Hazem Club Stadium (Ar Rass)', 'ملعب نادي الحزم (الرس)'],
  ['majmaah-stadium-7k', 6838, "Al-Majma'ah Sports City Stadium", 'ملعب مدينة المجمعة الرياضية'],
  ['pfbf-stadium-22k', 22768, 'Prince Faisal bin Fahd Stadium (Riyadh)', 'ملعب الأمير فيصل بن فهد (الرياض)'],
];
const OLD_ID = 'community-alawwal-park-25k';
const OLD_SEATS = 24652;
const only = process.argv[2] ?? '';

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
const seatsIn = (s) => Number((s.match(/([\d,٬٠-٩]+)\s*(seats|مقعد)/) || [])[1]?.replace(/[,٬]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))) || NaN);
const waitReady = (p) => p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 120000 });
const simPng = (p) => p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png'));
const save = (name, dataUrl) => writeFileSync(`${OUT}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
/** Brightness spread of the 3D view: a blank or single-colour frame is near 0. */
const spread = (p) =>
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
    const d = g.getImageData(0, 0, 160, 90).data;
    let s = 0;
    let s2 = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      s += v;
      s2 += v * v;
    }
    const m = s / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m));
  });
const pick = (p, k, v) =>
  p.evaluate(([kk, vv]) => {
    const s = document.querySelector(`[data-k="${kk}"]`);
    s.value = vv;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, [k, v]);

// ---------------------------------------------------------------------------
console.log('\n— each ground in the design view —');
for (const [id, seats, en] of GROUNDS) {
  if (only && !id.includes(only)) continue;
  const { ctx, p, errs } = await open(`/app?new=1&template=${id}`);
  await waitReady(p);
  await p.waitForTimeout(800);
  const s = await stat(p);
  check(`${id}: opens with its ${seats} seats`, seatsIn(s) === seats, s);
  await p.click('#rail-stadium');
  await p.waitForTimeout(600);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check(`${id}: the panel names it`, info.includes(en), info.slice(0, 80));
  check(`${id}: no "move to the new version" on it`, !(await p.$('#stadium-info button.primary')));
  if (id === 'alawwal-park-26k') {
    const listed = await p.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));
    for (const [, , name] of GROUNDS) check(`the list offers ${name} once`, listed.filter((t) => t.includes(name)).length === 1);
    check('the earlier Al-Awwal is not offered', !listed.some((t) => /earlier layout/.test(t) && /Al-Awwal/.test(t)));
    await p.screenshot({ path: `${OUT}/stadium-panel.png` });
  }
  await p.screenshot({ path: `${OUT}/editor-${id}.png` });
  check(`${id}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
if (!only || 'alawwal'.includes(only)) {
  console.log('\n— a design on the earlier Al-Awwal Park —');
  const { ctx, p, errs } = await open(`/app?new=1&template=${OLD_ID}`);
  await waitReady(p);
  await p.waitForTimeout(1200);
  check('opens on its own seat map, unchanged', seatsIn(await stat(p)) === OLD_SEATS, await stat(p));
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('says it is the earlier layout', /earlier layout/.test(info), info.slice(0, 80));
  check('and that a more accurate one exists', /more accurate/.test(info));
  const btn = await p.$('#stadium-info button.primary');
  check('with a button to move it', !!btn);
  if (btn) {
    await btn.click();
    await p.waitForSelector('#sw-continue', { timeout: 5000 });
    await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.click('#sw-continue')]);
    await waitReady(p);
    await p.waitForTimeout(1500);
    await p.waitForFunction(() => /[?&]local=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
    check('it moves to the new Al-Awwal Park', seatsIn(await stat(p)) === GROUNDS[0][1], p.url());
    check('as a copy, with the original kept', await p.evaluate(([o, n]) => {
      const idx = JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]');
      return idx.length === 2 && idx.some((x) => x.templateId === o) && idx.some((x) => x.templateId === n);
    }, [OLD_ID, GROUNDS[0][0]]));
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day on each ground —');
for (const [id] of GROUNDS) {
  if (only && !id.includes(only)) continue;
  const { ctx, p, errs } = await open(`/app?new=1&template=${id}&sim=1`);
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3500);
  const names = await p.$$eval('[data-k="camera"] option', (o) => o.map((x) => x.textContent));
  const values = await p.$$eval('[data-k="camera"] option', (o) => o.map((x) => x.value));
  check(`${id}: Match Day has its cameras`, values.length >= 6, String(values.length));
  // Its neighbourhood comes from OpenStreetMap: credited on the picture, and
  // seen from the air and on foot (not Kingdom Arena: an indoor hall stays inside).
  const credit = await p.$eval('[data-k="osm-credit"]', (a) => ({ t: a.textContent, h: a.href })).catch(() => null);
  check(`${id}: credits OpenStreetMap on the picture`, !!credit && /OpenStreetMap/.test(credit.t) && /openstreetmap\.org\/copyright/.test(credit.h), JSON.stringify(credit));
  if (id !== 'kingdom-arena-26k')
    check(`${id}: has the Aerial and Outside views`, names.includes('Aerial') && names.includes('Outside'), names.join(', '));
  let flat = [];
  for (let k = 0; k < values.length; k++) {
    await pick(p, 'camera', values[k]);
    await p.waitForTimeout(1600);
    const sd = await spread(p);
    if (sd < 8) flat.push(`${names[k]} (${sd.toFixed(1)})`);
    if (k === 0 || k === 2) save(`md-${id}-${names[k].replace(/\W+/g, '-').toLowerCase()}`, await simPng(p));
  }
  check(`${id}: every camera shows a picture`, flat.length === 0, flat.join(', '));
  await pick(p, 'camera', values[0]);
  await pick(p, 'tod', 'night');
  await p.waitForTimeout(2200);
  const night = await spread(p);
  check(`${id}: renders at night`, night >= 6, night.toFixed(1));
  save(`md-${id}-night`, await simPng(p));
  check(`${id}: no page or WebGL errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
if (!only) {
  console.log('\n— in Arabic —');
  const { ctx, p, errs } = await open(`/app?new=1&template=${GROUNDS[0][0]}`, { lang: 'ar' });
  await waitReady(p);
  await p.waitForTimeout(800);
  await p.click('#rail-stadium');
  await p.waitForTimeout(800);
  const listed = await p.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));
  for (const [id, , , ar] of GROUNDS) check(`${id}: named in Arabic in the list`, listed.filter((t) => t.includes(ar)).length === 1);
  const info = await p.$eval('#stadium-info', (e) => e.textContent || '');
  check('the panel names Al-Awwal Park in Arabic', info.includes(GROUNDS[0][3]), info.slice(0, 80));
  await p.screenshot({ path: `${OUT}/stadium-panel-ar.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\nsaudi: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
