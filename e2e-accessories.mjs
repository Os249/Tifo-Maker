/**
 * Match Day accessories — flags, flares, smoke bombs, strobes, paper, phones.
 *
 * A user asked for "flags, flares, pyro, smoke bomb, strobe lights, all that
 * sort of stuff", each at the intensity they want. This drives the real
 * Accessories section in a real browser and checks what someone using it would
 * notice: the section is there and starts with everything off; every slider
 * says its level in words; each step up puts MORE fans in the stand holding
 * one; the presets set every slider; Where moves them; the picture actually
 * changes (a stand of red flares at night makes the frame redder); a quality
 * change keeps them; a show's cue moves the slider it owns; and it all reads in
 * Arabic and fits a phone.
 *
 * What is in the stand is read from the simulator's own `[MDS] accessories`
 * console line, which it prints on every change — so these checks are about
 * the bowl, not about the panel agreeing with itself.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * SHOTS=dir saves a screenshot of the section and the bowl.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
}).catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const LS = (lang = 'en') => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  // Sound off: this suite looks, the sound suite listens.
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
];

async function sim({ lang = 'en', w = 1280, h = 900, phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang) }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  const log = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => {
    const t = m.text();
    const i = t.indexOf('accessories {');
    if (i >= 0) { try { log.push(JSON.parse(t.slice(i + 'accessories '.length))); } catch { /* not ours */ } }
  });
  await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  return { ctx, p, errs, log, last: () => log[log.length - 1] };
}

const openSec = async (p, key) => {
  await p.evaluate((k) => {
    const panel = document.querySelector('.mds-panel');
    panel?.classList.remove('collapsed');
    const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
    if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
  }, key);
  await p.waitForTimeout(350);
};
const setLevel = async (p, kind, v) => {
  await p.evaluate(({ k, val }) => {
    const r = document.querySelector(`[data-k="acc-${k}"]`);
    r.value = String(val);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }, { k: kind, val: v });
  await p.waitForTimeout(250);
};
const readouts = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.mds-section[data-sec="accessories"] .mds-step')].map((f) => ({
    label: f.querySelector('.mds-flabel span').textContent,
    word: f.querySelector('.mds-fval').textContent,
    value: Number(f.querySelector('input').value),
  })));
const choose = (p, key, value) => p.evaluate(({ k, v }) => {
  const s = document.querySelector(`[data-k="${k}"]`);
  s.value = v;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, { k: key, v: value });

/**
 * How far red (or green) leads the other two channels, averaged over the
 * frame. A tone-mapped flare glow is a pinkish red, not a pure one, so this
 * measures the lead rather than counting "pure red" pixels.
 */
async function redness(p) {
  // Straight off the canvas (it keeps its drawing buffer for snapshots): an
  // element screenshot waits for a "stable" element, and under software
  // rendering a canvas that redraws every frame never is.
  const url = await p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png'));
  const buf = Buffer.from(url.split(',')[1], 'base64');
  const png = PNG.sync.read(buf);
  let red = 0, green = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    red += Math.max(0, r - Math.max(g, b));
    green += Math.max(0, g - Math.max(r, b));
  }
  const n = png.width * png.height;
  return { red: red / n, green: green / n, buf };
}

// ---------------------------------------------------------------------------
console.log('\n— the section, in English, on a desktop —');
{
  const { ctx, p, errs, log, last } = await sim();
  const order = await p.evaluate(() => [...document.querySelectorAll('.mds-panel > .mds-section')].map((s) => s.dataset.sec));
  check('there is an Accessories section', order.includes('accessories'), order.join(' > '));
  check('it comes straight after Crowd — the fans hold these', order.indexOf('accessories') === order.indexOf('crowd') + 1);
  await openSec(p, 'accessories');
  const head = await p.$eval('.mds-section[data-sec="accessories"] .mds-shead', (h) => h.textContent.trim());
  check('it is called Accessories', head === 'Accessories', head);
  const rd = await readouts(p);
  check('six accessories, each on its own slider',
    rd.map((r) => r.label).join('|') === 'Flags|Flares|Smoke bombs|Strobes|Paper & confetti|Phone lights', rd.map((r) => r.label).join('|'));
  check('every one of them starts Off', rd.every((r) => r.value === 0 && r.word === 'Off'), rd.map((r) => r.word).join(','));
  const ui = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="accessories"]');
    return {
      where: [...s.querySelector('[data-k="acc-where"]').options].map((o) => o.textContent),
      whereNow: s.querySelector('[data-k="acc-where"]').selectedOptions[0].textContent,
      presets: [...s.querySelectorAll('[data-k^="acc-preset-"]')].map((b) => b.textContent),
      flare: [...s.querySelector('[data-k="acc-flare-colour"]').options].map((o) => o.textContent),
      smoke: [...s.querySelector('[data-k="acc-smoke-colour"]').options].map((o) => o.textContent),
      bursts: [...s.querySelectorAll('[data-k="acc-cannon"], [data-k="acc-jets"]')].map((b) => b.textContent),
      hint: [...s.querySelectorAll('.mds-hint')].map((h) => h.textContent).join(' '),
      ranges: [...s.querySelectorAll('input[type=range]')].map((r) => `${r.min}-${r.max}/${r.step}`),
      aria: [...s.querySelectorAll('input[type=range]')].map((r) => r.getAttribute('aria-valuetext')),
    };
  });
  check('Where offers every stand, both pairs and the whole ground', ui.where.length === 7 && ui.where.includes('The whole ground'), ui.where.join(', '));
  check('and starts on the stand the default camera faces', ui.whereNow === 'North stand', ui.whereNow);
  check('five quick presets', ui.presets.join('|') === 'All off|Terrace|Ultras|Inferno|Light show', ui.presets.join('|'));
  check('flares come in real flame colours, red first', ui.flare[0] === 'Red' && ui.flare.includes('Club colours') && ui.flare.includes('Green'), ui.flare.join(','));
  check('smoke defaults to the club\'s colours', ui.smoke[0] === 'Club colours' && ui.smoke.includes('Black'), ui.smoke.join(','));
  check('the one-off bursts are here too', ui.bursts.join('|') === 'Confetti cannon|Fire jets', ui.bursts.join('|'));
  check('with a line saying it is for the picture only', /picture only/i.test(ui.hint) && /banned/i.test(ui.hint), ui.hint);
  check('every slider is five steps, 0 to 4', ui.ranges.every((r) => r === '0-4/1'), ui.ranges.join(' '));
  check('and tells a screen reader the word, not the number', ui.aria.every((a) => a === 'Off'), ui.aria.join(','));

  // Atmosphere no longer carries the things that moved.
  await openSec(p, 'atmosphere');
  const atmo = await p.$eval('.mds-section[data-sec="atmosphere"]', (s) => s.textContent);
  check('Atmosphere no longer has Smoke, Phone flashes, Confetti or Pyro', !/Smoke|Phone flashes|Confetti|Pyro/.test(atmo));

  // Levels: every step adds fans, and the word follows.
  await openSec(p, 'accessories');
  const words = [];
  const counts = [];
  for (let lv = 1; lv <= 4; lv++) {
    await setLevel(p, 'flares', lv);
    words.push((await readouts(p))[1].word);
    counts.push(last()?.holders?.flares ?? 0);
  }
  check('the readout says Light, Medium, Heavy, Full', words.join(',') === 'Light,Medium,Heavy,Full', words.join(','));
  check('each step up puts more flares in the stand', counts.every((c, i) => c > 0 && (i === 0 || c > counts[i - 1])), counts.join(' < '));
  check('and in the stand that was chosen', last()?.where === 'north', String(last()?.where));
  await setLevel(p, 'flares', 0);
  check('Off puts them all out', last()?.holders?.flares === 0 && last()?.levels?.flares === 0, JSON.stringify(last()?.holders));

  // Each of the others does something too.
  for (const k of ['flags', 'smoke', 'strobes', 'paper', 'phones']) {
    await setLevel(p, k, 2);
    const n = last()?.holders?.[k] ?? 0;
    check(`${k} at Medium are held by fans in the stand`, n > 0, String(n));
    await setLevel(p, k, 0);
  }

  // Presets set every slider, and light up the one that matches.
  const preset = async (id) => {
    await p.evaluate((x) => document.querySelector(`[data-k="acc-preset-${x}"]`).click(), id);
    await p.waitForTimeout(400);
    return { rd: await readouts(p), active: await p.evaluate(() => [...document.querySelectorAll('[data-k^="acc-preset-"].active')].map((b) => b.dataset.k)) };
  };
  let r = await preset('ultras');
  check('Ultras sets every slider', r.rd.map((x) => x.value).join(',') === '3,3,2,2,2,0', r.rd.map((x) => `${x.label}:${x.word}`).join(' '));
  check('and marks Ultras as the one in use', r.active.join() === 'acc-preset-ultras', r.active.join());
  check('and the stand has what the sliders say', last()?.levels?.flares === 3 && last()?.levels?.smoke === 2 && last()?.holders?.flares > 0);
  const ultrasFlares = last()?.holders?.flares ?? 0;
  r = await preset('inferno');
  check('Inferno turns everything up', r.rd.map((x) => x.value).join(',') === '4,4,4,3,3,0', r.rd.map((x) => x.word).join(','));
  check('with more flares than Ultras', (last()?.holders?.flares ?? 0) > ultrasFlares, `${ultrasFlares} -> ${last()?.holders?.flares}`);
  await setLevel(p, 'strobes', 1);
  r = { active: await p.evaluate(() => [...document.querySelectorAll('[data-k^="acc-preset-"].active')].map((b) => b.dataset.k)) };
  check('moving a slider off a preset un-marks it', r.active.length === 0, r.active.join());
  r = await preset('off');
  check('All off puts every slider back to Off', r.rd.every((x) => x.value === 0 && x.word === 'Off'));
  check('and empties the stand', Object.values(last()?.holders ?? { x: 1 }).every((v) => v === 0), JSON.stringify(last()?.holders));

  // Where moves them.
  await setLevel(p, 'flares', 2);
  const north = last()?.holders?.flares ?? 0;
  await choose(p, 'acc-where', 'all');
  await p.waitForTimeout(300);
  check('the whole ground holds more than one stand', (last()?.holders?.flares ?? 0) > north * 3, `${north} -> ${last()?.holders?.flares}`);
  check('and the log says where', last()?.where === 'all');
  await choose(p, 'acc-where', 'north');
  await setLevel(p, 'flares', 0);

  // The picture: a stand of red flares at night makes the bowl redder.
  await openSec(p, 'atmosphere');
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="atmosphere"] select');
    s.value = 'night';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await openSec(p, 'accessories');
  await p.waitForTimeout(1500);
  const dark = await redness(p);
  await setLevel(p, 'flares', 4);
  await p.waitForTimeout(3500);
  const lit = await redness(p);
  check('a stand of red flares turns the picture red', lit.red > dark.red * 2.5, `red lead ${dark.red.toFixed(2)} -> ${lit.red.toFixed(2)}`);
  await choose(p, 'acc-flare-colour', 'green');
  await p.waitForTimeout(2500);
  const green = await redness(p);
  // Green is dimmed to red's apparent brightness (it carries three times the
  // luminance), so it leads by less in raw channel terms — but it must lead.
  check('and green flares turn it green instead', green.red < lit.red * 0.4 && green.green > dark.green * 1.8,
    `red lead ${lit.red.toFixed(2)} -> ${green.red.toFixed(2)}, green lead ${dark.green.toFixed(2)} -> ${green.green.toFixed(2)}`);
  if (SHOTS) {
    writeFileSync(`${SHOTS}/night-off.png`, dark.buf);
    writeFileSync(`${SHOTS}/night-flares-full.png`, lit.buf);
    writeFileSync(`${SHOTS}/night-flares-green.png`, green.buf);
  }
  await choose(p, 'acc-flare-colour', 'red');

  // A quality change rebuilds the bowl; the fans keep what they were holding.
  const before = last();
  await p.evaluate(() => {
    const q = document.querySelector('.mds-bar select, .mds-panel-acts select');
    q.value = 'low';
    q.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 60000 });
  await p.waitForTimeout(3000);
  const after = await readouts(p);
  const lowLine = log.filter((l) => l.tier === 'low').pop();
  check('a quality change keeps the flares on', after[1].value === 4 && after[1].word === 'Full', after[1].word);
  check('and puts them back in the new bowl', lowLine?.levels?.flares === 4 && lowLine?.holders?.flares > 0, JSON.stringify(lowLine?.holders));
  check('fewer of them on Low, so a phone keeps up', (lowLine?.holders?.flares ?? 1e9) < (before?.holders?.flares ?? 0), `${before?.holders?.flares} -> ${lowLine?.holders?.flares}`);

  // A show's cue moves the slider it owns.
  await setLevel(p, 'flares', 0);
  await openSec(p, 'choreo');
  const offered = await p.$eval('[data-k="cue-kind"]', (s) => [...s.options].map((o) => o.textContent));
  check('the sequence builder offers Flares on, Strobes on, Flags up and Accessories off',
    ['Flares on', 'Strobes on', 'Flags up', 'Accessories off', 'Smoke bombs on'].every((x) => offered.includes(x)), offered.join(', '));
  await p.evaluate(() => {
    const k = document.querySelector('[data-k="cue-kind"]');
    k.value = 'flares-on';
    k.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-k="add-cue"]').click();
    document.querySelector('[data-k="play-seq"]').click();
  });
  await p.waitForTimeout(2500);
  await openSec(p, 'accessories');
  const cued = await readouts(p);
  check('a Flares on cue lights them at Medium, and the slider says so', cued[1].value === 2 && cued[1].word === 'Medium', cued[1].word);
  check('and they are in the stand', (last()?.holders?.flares ?? 0) > 0);

  if (SHOTS) await p.screenshot({ path: `${SHOTS}/panel-en.png`, timeout: 60000 });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— in Arabic —');
{
  const { ctx, p, errs } = await sim({ lang: 'ar' });
  await openSec(p, 'accessories');
  const t = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="accessories"]');
    return {
      head: s.querySelector('.mds-shead').textContent.trim(),
      text: [...s.querySelectorAll('.mds-flabel, .mds-btn, option, .mds-hint')].map((e) => e.textContent).join(' | '),
      dir: document.querySelector('.mds-overlay').dir,
    };
  });
  check('the section is الإكسسوارات', t.head === 'الإكسسوارات', t.head);
  check('the whole overlay runs right to left', t.dir === 'rtl');
  const latin = t.text.match(/[A-Za-z]{3,}/g) ?? [];
  check('no English left in it', latin.length === 0, latin.slice(0, 8).join(', '));
  check('levels read in Arabic', /مطفأ/.test(t.text));
  await setLevel(p, 'flares', 3);
  const w = (await readouts(p))[1].word;
  check('and a raised one says كثيف', w === 'كثيف', w);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/panel-ar.png`, timeout: 60000 });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— on a phone —');
{
  const { ctx, p, errs, last } = await sim({ w: 390, h: 844, phone: true });
  await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
  await p.waitForTimeout(700);
  await openSec(p, 'accessories');
  await p.evaluate(() => document.querySelector('.mds-section[data-sec="accessories"]').scrollIntoView());
  await p.waitForTimeout(500);
  const m = await p.evaluate(() => {
    const panel = document.querySelector('.mds-panel');
    const s = document.querySelector('.mds-section[data-sec="accessories"]');
    const ranges = [...s.querySelectorAll('input[type=range]')].map((r) => r.getBoundingClientRect().height);
    const btns = [...s.querySelectorAll('.mds-btn')].map((b) => b.getBoundingClientRect().height);
    const wide = [...s.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length;
    return { overflow: panel.scrollWidth - panel.clientWidth, ranges, btns, wide };
  });
  check('nothing in it runs off the side of the screen', m.overflow <= 1 && m.wide === 0, `overflow ${m.overflow}px, ${m.wide} wide`);
  check('sliders are big enough for a thumb', m.ranges.every((h) => h >= 28), m.ranges.map(Math.round).join(','));
  check('buttons are big enough for a thumb', m.btns.every((h) => h >= 44), m.btns.map(Math.round).join(','));
  await setLevel(p, 'smoke', 3);
  check('and they work there too', (last()?.holders?.smoke ?? 0) > 0);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/phone.png`, timeout: 60000 });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
