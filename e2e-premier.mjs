/**
 * The Premier League's grounds (2026-27), end to end, in the real app.
 *
 *   - every ground opens with its own seat count, and the stadium panel names
 *     it; each is offered once, in English and in Arabic
 *   - Match Day opens on every ground in its real neighbourhood (credited to
 *     OpenStreetMap), every camera renders a picture (not a blank frame), by
 *     day and at night, with no WebGL or page errors
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * Screenshots land in preview-out/e2e-premier/.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-premier';
mkdirSync(OUT, { recursive: true });

// id, seats (the generator's count, frozen in scripts/verify.mts), English and Arabic names.
const GROUNDS = [
  ['anfield-61k', 60814, 'Anfield (Liverpool)', 'آنفيلد (ليفربول)'],
  ['old-trafford-74k', 74798, 'Old Trafford (Manchester)', 'أولد ترافورد (مانشستر)'],
  ['etihad-61k', 61854, 'Etihad Stadium (Manchester)', 'ملعب الاتحاد (مانشستر)'],
  ['emirates-60k', 61444, 'Emirates Stadium (London)', 'ملعب الإمارات (لندن)'],
  ['tottenham-62k', 62486, 'Tottenham Hotspur Stadium (London)', 'ملعب توتنهام هوتسبير (لندن)'],
  ['stamford-bridge-40k', 40114, 'Stamford Bridge (London)', 'ستامفورد بريدج (لندن)'],
  ['craven-cottage-29k', 27848, 'Craven Cottage (London)', 'كرافن كوتيج (لندن)'],
  ['selhurst-park-25k', 25382, 'Selhurst Park (London)', 'سيلهرست بارك (لندن)'],
  ['brentford-17k', 17084, 'Gtech Community Stadium (Brentford)', 'ملعب جي تك كوميونيتي (برينتفورد)'],
  ['amex-32k', 32654, 'American Express Stadium (Brighton)', 'ملعب أمريكان إكسبريس (برايتون)'],
  ['vitality-11k', 11388, 'Vitality Stadium (Bournemouth)', 'ملعب فيتاليتي (بورنموث)'],
  ['villa-park-37k', 36548, 'Villa Park (Birmingham)', 'فيلا بارك (برمنغهام)'],
  ['st-james-park-52k', 53182, "St James' Park (Newcastle)", 'سانت جيمس بارك (نيوكاسل)'],
  ['stadium-of-light-48k', 48909, 'Stadium of Light (Sunderland)', 'ملعب النور (سندرلاند)'],
  ['elland-road-37k', 37152, 'Elland Road (Leeds)', 'إيلاند رود (ليدز)'],
  ['city-ground-31k', 30692, 'City Ground (Nottingham)', 'سيتي غراوند (نوتنغهام)'],
  ['cbs-arena-32k', 32808, 'CBS Arena (Coventry)', 'سي بي إس أرينا (كوفنتري)'],
  ['mkm-25k', 24952, 'MKM Stadium (Hull)', 'ملعب إم كي إم (هل)'],
  ['portman-road-30k', 30390, 'Portman Road (Ipswich)', 'بورتمان رود (إيبسويتش)'],
  ['hill-dickinson-52k', 52028, 'Hill Dickinson Stadium (Liverpool)', 'ملعب هيل ديكنسون (ليفربول)'],
];
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
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v1', value: '1' },
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
/**
 * The spread of a settled picture. Software GL draws a big ground at well under
 * one frame a second, so a read can land on a frame still being drawn (near 0)
 * when the next one is fine: read again, a frame or two later, before calling
 * it blank.
 */
const settled = async (p, min) => {
  let sd = await spread(p);
  for (let k = 0; k < 3 && sd < min; k++) {
    await p.waitForTimeout(2500);
    sd = await spread(p);
  }
  return sd;
};
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
  if (id === GROUNDS[0][0]) {
    const listed = await p.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));
    for (const [, , name] of GROUNDS) check(`the list offers ${name} once`, listed.filter((t) => t.includes(name)).length === 1);
    await p.screenshot({ path: `${OUT}/stadium-panel.png` });
  }
  await p.screenshot({ path: `${OUT}/editor-${id}.png` });
  check(`${id}: no page errors`, errs.length === 0, errs.join(' | '));
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
  // seen from the air and on foot.
  const credit = await p.$eval('[data-k="osm-credit"]', (a) => ({ t: a.textContent, h: a.href })).catch(() => null);
  check(`${id}: credits OpenStreetMap on the picture`, !!credit && /OpenStreetMap/.test(credit.t) && /openstreetmap\.org\/copyright/.test(credit.h), JSON.stringify(credit));
  check(`${id}: has the Aerial and Outside views`, names.includes('Aerial') && names.includes('Outside'), names.join(', '));
  let flat = [];
  for (let k = 0; k < values.length; k++) {
    await pick(p, 'camera', values[k]);
    await p.waitForTimeout(1600);
    const sd = await settled(p, 8);
    if (sd < 8) flat.push(`${names[k]} (${sd.toFixed(1)})`);
    if (k === 0 || k === 2) save(`md-${id}-${names[k].replace(/\W+/g, '-').toLowerCase()}`, await simPng(p));
  }
  check(`${id}: every camera shows a picture`, flat.length === 0, flat.join(', '));
  await pick(p, 'camera', values[0]);
  await pick(p, 'tod', 'night');
  await p.waitForTimeout(2200);
  const night = await settled(p, 6);
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
  check('the panel names Anfield in Arabic', info.includes(GROUNDS[0][3]), info.slice(0, 80));
  await p.screenshot({ path: `${OUT}/stadium-panel-ar.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\npremier league: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
