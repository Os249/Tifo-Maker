/**
 * Match Day: the floodlight brightness slider and the Hide tifo button.
 *
 * - Floodlight brightness (Atmosphere). The pitch at night gets measurably
 *   brighter from 10% to 100% to 150%. The slider rests while the floodlights
 *   are off, and keeps its level through a quality change.
 * - Hide tifo (top bar, or T). On the Jewel of Jeddah, taking the tifo off
 *   the seats shows the ground's own orange tiers. The frame is measured, not
 *   the button's label. The design itself is untouched. Starting a show puts
 *   the tifo back, because a reveal of nothing is no reveal.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * SHOTS=dir saves the frames.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const LS = (lang = 'en') => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
];

async function sim({ lang = 'en', w = 1440, h = 900, template = 'jewel-jeddah-60k', phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang) }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.goto(`${B}/app?template=${template}&sim=1`, { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3500);
  return { ctx, p, errs };
}
const openSec = (p, key) => p.evaluate((k) => {
  const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
  if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
}, key);
/** The canvas, straight off its drawing buffer (it is kept for snapshots). */
const frame = async (p, wait = 2500) => {
  await p.waitForTimeout(wait);
  const url = await p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png'));
  return { png: PNG.sync.read(Buffer.from(url.split(',')[1], 'base64')), url };
};
/** Mean brightness of a box of the frame, given as fractions of its size. */
const bright = ({ png }, [x0, y0, x1, y1]) => {
  let sum = 0, n = 0;
  for (let y = Math.floor(y0 * png.height); y < y1 * png.height; y += 2) {
    for (let x = Math.floor(x0 * png.width); x < x1 * png.width; x += 2) {
      const i = (y * png.width + x) * 4;
      sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      n++;
    }
  }
  return sum / n;
};
/** Share of the frame that is the Jewel's seat orange. */
const orange = ({ png }) => {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 140 && g > 40 && g < 150 && b < 90 && r > g * 1.35) n++;
  }
  return n / (png.width * png.height);
};
const save = (name, f) => { if (SHOTS) writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(f.url.split(',')[1], 'base64')); };
const setLevel = (p, v) => p.evaluate((val) => {
  const r = document.querySelector('[data-k="flood-level"]');
  r.value = String(val);
  r.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

// ---------------------------------------------------------------------------
console.log('\n— floodlight brightness —');
{
  const { ctx, p, errs } = await sim();
  await openSec(p, 'atmosphere');
  await p.waitForTimeout(300);
  const ui = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="atmosphere"]');
    const rows = [...s.querySelector('.mds-sbody').children].map((c) => c.textContent.trim());
    const r = s.querySelector('[data-k="flood-level"]');
    return { rows, min: r.min, max: r.max, step: r.step, value: r.value, disabled: r.disabled, read: r.closest('.mds-field').textContent };
  });
  const iF = ui.rows.findIndex((t) => t === 'Floodlights');
  check('Atmosphere has Floodlight brightness right under Floodlights', /^Floodlight brightness/.test(ui.rows[iF + 1] ?? ''), ui.rows.join(' | '));
  check('it runs 10% to 150%, and starts at 100%', ui.min === '0.1' && ui.max === '1.5' && ui.value === '1' && /100%/.test(ui.read), `${ui.min}-${ui.max} @${ui.value} "${ui.read}"`);
  check('and is live while the floodlights are on', !ui.disabled);

  // Night, so the floodlights are what lights the pitch.
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="atmosphere"] select');
    s.value = 'night';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The TV camera looks down on the pitch; its middle band is grass.
  const PITCH = [0.3, 0.55, 0.9, 0.8];
  // Software rendering can take seconds to draw the next frame, so each level
  // waits for the pitch to actually move before it is measured.
  const settleLum = async (prev, want) => {
    let f = await frame(p, 1500);
    for (let k = 0; k < 12 && !want(bright(f, PITCH), prev); k++) f = await frame(p, 1500);
    return f;
  };
  const lum = {};
  const base = bright(await frame(p), PITCH);
  for (const [v, want] of [[0.1, (b, a) => b < a * 0.75], [1, (b, a) => b > a * 1.5], [1.5, (b, a) => b > a * 1.08]]) {
    const prev = v === 0.1 ? base : lum[v === 1 ? 0.1 : 1];
    await setLevel(p, v);
    const f = await settleLum(prev, want);
    lum[v] = bright(f, PITCH);
    save(`floods-${v}`, f);
  }
  check('the pitch darkens at 10%', lum[0.1] < lum[1] * 0.75, `${lum[0.1].toFixed(1)} vs ${lum[1].toFixed(1)}`);
  check('and brightens at 150%', lum[1.5] > lum[1] * 1.08, `${lum[1].toFixed(1)} -> ${lum[1.5].toFixed(1)}`);
  const read = await p.$eval('[data-k="flood-level"]', (r) => r.closest('.mds-field').querySelector('.mds-fval').textContent);
  check('the readout follows the slider', read === '150%', read);

  // Off: the slider rests. On again: it comes back at the level it was left at.
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.mds-section[data-sec="atmosphere"] .mds-checkrow')].find((r) => r.textContent.trim() === 'Floodlights');
    row.querySelector('input').click();
  });
  check('with the floodlights off, the slider rests', await p.$eval('[data-k="flood-level"]', (r) => r.disabled));
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.mds-section[data-sec="atmosphere"] .mds-checkrow')].find((r) => r.textContent.trim() === 'Floodlights');
    row.querySelector('input').click();
  });
  const back = await settleLum(lum[1], (b, a) => b > a * 1.08);
  check('and on again, they come back at 150%', bright(back, PITCH) > lum[1] * 1.08, bright(back, PITCH).toFixed(1));

  // A quality change builds a new bowl; the level is put back into it.
  await setLevel(p, 0.1);
  await p.evaluate(() => {
    const q = document.querySelector('.mds-bar select, .mds-panel-acts select');
    q.value = 'medium';
    q.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 60000 });
  const med = await frame(p, 6000);
  await setLevel(p, 1);
  const med1 = await settleLum(bright(med, PITCH), (b, a) => b > a * 1.5);
  check('a quality change keeps the level', bright(med, PITCH) < bright(med1, PITCH) * 0.75, `${bright(med, PITCH).toFixed(1)} at 10% vs ${bright(med1, PITCH).toFixed(1)} at 100%`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— Hide tifo, on the Jewel of Jeddah —');
{
  const { ctx, p, errs } = await sim();
  const btn = () => p.$eval('[data-k="hide-tifo"]', (b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed'), inBar: !!b.closest('.mds-bar') }));
  const b0 = await btn();
  check('the top bar has Hide tifo', b0.text === 'Hide tifo' && b0.pressed === 'false' && b0.inBar, JSON.stringify(b0));
  const shown = await frame(p);
  save('jewel-tifo', shown);
  await p.click('[data-k="hide-tifo"]');
  // Software rendering can take a few seconds to draw the next frame; wait
  // for the picture to change rather than for a fixed time.
  const settle = async (want) => {
    let f = await frame(p, 1500);
    for (let k = 0; k < 10 && !want(f); k++) f = await frame(p, 1500);
    return f;
  };
  const hidden = await settle((f) => orange(f) > orange(shown) + 0.08);
  save('jewel-seats', hidden);
  check('hiding it shows the Jewel\'s orange seats', orange(hidden) > orange(shown) + 0.08, `orange ${(orange(shown) * 100).toFixed(1)}% -> ${(orange(hidden) * 100).toFixed(1)}%`);
  const b1 = await btn();
  check('and the button says Show tifo, pressed', b1.text === 'Show tifo' && b1.pressed === 'true', JSON.stringify(b1));
  await p.keyboard.press('t');
  const again = await settle((f) => Math.abs(orange(f) - orange(shown)) < 0.02);
  check('T puts the tifo back', Math.abs(orange(again) - orange(shown)) < 0.02 && (await btn()).text === 'Hide tifo', `orange ${(orange(again) * 100).toFixed(1)}%`);
  await p.keyboard.press('T');
  check('and T takes it off again', (await btn()).pressed === 'true');

  // It survives a quality change (a new bowl is built).
  await p.evaluate(() => {
    const q = document.querySelector('.mds-bar select, .mds-panel-acts select');
    q.value = 'medium';
    q.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 60000 });
  await p.waitForTimeout(2500);
  const rebuilt = await settle((f) => orange(f) > orange(shown) + 0.08);
  check('a quality change keeps the tifo off', orange(rebuilt) > orange(shown) + 0.08 && (await btn()).pressed === 'true', `orange ${(orange(rebuilt) * 100).toFixed(1)}%`);

  // A show brings it back, and says so.
  await openSec(p, 'choreo');
  await p.evaluate(() => document.querySelector('[data-k="play-reveal"]').click());
  await p.waitForTimeout(600);
  const b2 = await btn();
  const msg = await p.$eval('.mds-status', (s) => s.textContent);
  check('playing a reveal puts the tifo back first', b2.pressed === 'false' && b2.text === 'Hide tifo', JSON.stringify(b2));
  check('and says so', /Tifo back on/.test(msg), msg);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the design is untouched —');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS() }] } });
  const p = await ctx.newPage();
  await p.goto(`${B}/app?template=jewel-jeddah-60k`, { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForTimeout(3000);
  const counts = () => p.evaluate(() => [...document.querySelectorAll('.swatch-count, .sw-count, [class*="count"]')].map((e) => e.textContent.trim()).filter((t) => /\d/.test(t)).join(','));
  const before = await counts();
  await p.evaluate(() => { const b = document.getElementById('match-day'); if (b) b.click(); });
  const opened = await p.waitForSelector('.mds-overlay canvas', { timeout: 60000 }).then(() => true).catch(() => false);
  if (opened) {
    await p.waitForTimeout(3000);
    await p.click('[data-k="hide-tifo"]');
    await p.waitForTimeout(1500);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(1500);
  }
  const after = await counts();
  check('closing Match Day with the tifo hidden leaves every seat of the design as it was', opened && before === after && before.length > 0, `${before} -> ${after}`);
  await ctx.close();
}

console.log('\n— the bar still fits —');
for (const w of [900, 1024, 1280]) {
  const { ctx, p } = await sim({ w, h: 800, template: 'generic-bowl-60k' });
  const r = await p.evaluate(() => {
    const bar = document.querySelector('.mds-bar');
    const kids = [...bar.querySelectorAll('button, select')].filter((e) => e.getClientRects().length);
    const off = kids.filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.textContent.trim());
    return { off, overflow: bar.scrollWidth - bar.clientWidth, hide: !!bar.querySelector('[data-k="hide-tifo"]') };
  });
  check(`${w} wide: nothing in the top bar runs off the screen`, r.off.length === 0 && r.overflow <= 1, `${r.overflow}px over; ${r.off.join(', ')}`);
  check(`${w} wide: Hide tifo is in it`, r.hide);
  await ctx.close();
}
{
  const { ctx, p, errs } = await sim({ w: 390, h: 844, phone: true });
  await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
  await p.waitForTimeout(700);
  const r = await p.evaluate(() => {
    const b = document.querySelector('[data-k="hide-tifo"]');
    const box = b.getBoundingClientRect();
    return { inPanel: !!b.closest('.mds-panel-acts'), h: box.height, onScreen: box.right <= innerWidth + 1 && box.left >= -1 };
  });
  check('on a phone it sits with the other actions in the sheet', r.inPanel && r.onScreen, JSON.stringify(r));
  check('big enough for a thumb', r.h >= 44, String(r.h));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— in Arabic —');
{
  const { ctx, p } = await sim({ lang: 'ar' });
  await openSec(p, 'atmosphere');
  await p.waitForTimeout(300);
  const t = await p.evaluate(() => ({
    btn: document.querySelector('[data-k="hide-tifo"]').textContent,
    label: document.querySelector('[data-k="flood-level"]').closest('.mds-field').querySelector('.mds-flabel span').textContent,
  }));
  check('the button is إخفاء التيفو', t.btn === 'إخفاء التيفو', t.btn);
  check('the slider is سطوع الكشافات', t.label === 'سطوع الكشافات', t.label);
  await p.click('[data-k="hide-tifo"]');
  check('and pressed it says إظهار التيفو', (await p.$eval('[data-k="hide-tifo"]', (b) => b.textContent)) === 'إظهار التيفو');
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
