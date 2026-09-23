/**
 * Match Day sound: the suite that listens.
 *
 * Every check below measures the actual signal at the audio destination, not
 * the state of a checkbox — because the bug this suite exists for passed every
 * DOM assertion anyone could have written. The engine was built, the graph was
 * connected, the buffers were full of real noise, the checkbox said "on", and
 * the output was digital silence, because `Number(localStorage.getItem(...))`
 * is `0` when nothing is stored and `0` passed every guard it was given. For
 * however long that shipped, the Sound section did nothing at all for anybody
 * who had never dragged the volume slider — which is everybody, the first time.
 *
 * The technique: an AnalyserNode is spliced in front of every AudioContext's
 * destination before the app runs, so a test can read the RMS of exactly what
 * the speakers would be getting. Headless Chromium renders audio to a null sink
 * and the graph runs normally, so the numbers are real.
 */
import { chromium } from 'playwright';

const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
}).catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const LS = (lang = 'en', extra = []) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  ...extra,
];

/** Splice an analyser in front of the destination of every context the app makes. */
const TAP = () => {
  const AC = window.AudioContext;
  if (!AC) return;
  window.__audio = { contexts: [], recorders: [] };
  window.AudioContext = class extends AC {
    constructor(...a) {
      super(...a);
      const real = AC.prototype.__lookupGetter__('destination').call(this);
      const an = this.createAnalyser();
      an.fftSize = 2048;
      an.connect(real);
      Object.defineProperty(this, 'destination', { get: () => an, configurable: true });
      window.__audio.contexts.push({ ctx: this, an });
    }
  };
  // What the recorder was actually handed, for the clip-has-sound check.
  const MR = window.MediaRecorder;
  if (MR) {
    window.MediaRecorder = class extends MR {
      constructor(stream, opts) {
        super(stream, opts);
        window.__audio.recorders.push({
          asked: opts?.mimeType ?? '',
          tracks: stream.getTracks().map((t) => t.kind),
        });
      }
    };
    window.MediaRecorder.isTypeSupported = MR.isTypeSupported.bind(MR);
  }
};

async function sim({ lang = 'en', w = 1280, h = 900, extra = [] } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, extra) }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.addInitScript(TAP);
  await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(4000);
  return [ctx, p, errs];
}

/**
 * Sections are addressed by `data-sec`, never by their heading: the headings are
 * translated, and an Arabic run failing because it could not find "Sound" would
 * be a test bug wearing a product bug's clothes.
 */
const open = async (p, key) => {
  await p.evaluate((k) => {
    const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
    if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
  }, key);
  await p.waitForTimeout(400);
};
const openSound = (p) => open(p, 'sound');
/** Controls inside a named section, by index (checkboxes and faders) or label (buttons). */
const inSec = (p, key, fn, arg) => p.evaluate(({ k, f, a }) => {
  const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
  // eslint-disable-next-line no-new-func
  return new Function('sec', 'arg', f)(s, a);
}, { k: key, f: fn, a: arg });

const toggle = (p, i) => inSec(p, 'sound', 'sec.querySelectorAll(\'input[type="checkbox"]\')[arg].click();', i);
const press = (p, label) => inSec(p, 'sound',
  '[...sec.querySelectorAll(".mds-btn")].find(b=>b.textContent.trim()===arg).click();', label);
const setFader = async (p, i, v) => {
  await inSec(p, 'sound',
    "const r=sec.querySelectorAll('input[type=\"range\"]')[arg.i]; r.value=String(arg.v); r.dispatchEvent(new Event('input',{bubbles:true}));",
    { i, v });
  await p.waitForTimeout(450);
};
const faders = (p) => inSec(p, 'sound', "return [...sec.querySelectorAll('input[type=\"range\"]')].map(r=>Number(r.value));");

/**
 * Peak RMS at the destination over a short window.
 *
 * Sampled from Node, one reading per call: inside a single page evaluate the
 * loop is starved by the WebGL render loop under swiftshader, and a 2.5s window
 * returns one frame.
 */
async function peak(p, n = 20, gap = 70) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    xs.push(await p.evaluate(() => {
      const a = window.__audio?.contexts?.[0];
      if (!a) return -1;
      const b = new Uint8Array(a.an.fftSize);
      a.an.getByteTimeDomainData(b);
      let s = 0;
      for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; s += v * v; }
      return Math.sqrt(s / b.length);
    }));
    await new Promise((r) => setTimeout(r, gap));
  }
  return Math.max(...xs);
}
/** Stop the render loop so the sampler is not competing with swiftshader. */
const freeze = (p) => p.evaluate(() => { window.requestAnimationFrame = () => 0; });
const AUDIBLE = 0.004;
const SILENT = 0.0015;

console.log('\n— nothing plays until it is asked to —');
{
  const [ctx, p, errs] = await sim();
  check('no audio context exists on open', await p.evaluate(() => window.__audio.contexts.length === 0));
  await openSound(p);
  const ui = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    return {
      checks: [...s.querySelectorAll('.mds-checkrow span')].map((e) => e.textContent.trim()),
      faders: [...s.querySelectorAll('.mds-flabel-row')].map((e) => e.textContent.trim()),
      buttons: [...s.querySelectorAll('.mds-btn')].map((e) => e.textContent.trim()),
      firstChecked: s.querySelector('input[type="checkbox"]').checked,
    };
  });
  check('the rig is off by default', ui.firstChecked === false);
  check('there are five faders, not one', ui.faders.length === 5, ui.faders.join(' · '));
  check('every bus is named and shows its level', ui.faders.every((f) => /\d+%$/.test(f)), ui.faders.join(' · '));
  check('the test row covers crowd and effects', ui.buttons.length >= 5, ui.buttons.join(','));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— a browser that has never been here is not muted —');
{
  // THE regression. Empty storage used to mean master volume 0, silently.
  const [ctx, p, errs] = await sim();
  await openSound(p);
  const defaults = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    return [...s.querySelectorAll('input[type="range"]')].map((r) => Number(r.value));
  });
  check('no fader starts at zero on a clean profile', defaults.every((v) => v > 0), JSON.stringify(defaults));
  check('the faders are not all pinned at 1 either', defaults.some((v) => v < 1), JSON.stringify(defaults));
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await freeze(p);
  const heard = await peak(p);
  check('turning it on is audible, from empty storage', heard > AUDIBLE, `rms ${heard.toFixed(4)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— every sound in the section makes one —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await freeze(p);
  const bed = await peak(p);
  check('the crowd bed is audible', bed > AUDIBLE, `rms ${bed.toFixed(4)}`);
  for (const label of ['Roar', 'Applause', 'Chant', 'Air horn', 'Whistle']) {
    await press(p, label);
    const v = await peak(p, 16, 60);
    check(`${label} is audible`, v > AUDIBLE, `rms ${v.toFixed(4)}`);
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the faders are wired to the mix —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await freeze(p);
  const loud = await peak(p);
  await setFader(p, 0, 0.05); // overall
  const quiet = await peak(p);
  check('the overall fader moves the level', quiet < loud * 0.6, `${loud.toFixed(4)} -> ${quiet.toFixed(4)}`);
  await setFader(p, 0, 1);
  await setFader(p, 1, 0); // crowd
  await setFader(p, 4, 0); // drum
  await p.waitForTimeout(900);
  const noCrowd = await peak(p);
  check('crowd and drum at zero is a quiet ground', noCrowd < loud * 0.5, `${loud.toFixed(4)} -> ${noCrowd.toFixed(4)}`);
  // ...and the effects bus is independent of it.
  await press(p, 'Air horn');
  const horn = await peak(p, 14, 55);
  check('the effects bus still sounds with the crowd down', horn > noCrowd * 1.5 && horn > AUDIBLE, `${noCrowd.toFixed(4)} -> ${horn.toFixed(4)}`);
  await setFader(p, 2, 0); // effects
  await p.waitForTimeout(700);
  await press(p, 'Air horn');
  const hornOff = await peak(p, 14, 55);
  check('effects at zero silences the horn', hornOff < horn * 0.5, `${horn.toFixed(4)} -> ${hornOff.toFixed(4)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— mute, and what it does not forget —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await freeze(p);
  const on = await peak(p);
  await toggle(p, 1);
  await p.waitForTimeout(700);
  const muted = await peak(p);
  check('mute is silence', muted < SILENT, `rms ${muted.toFixed(5)}`);
  const kept = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    return [...s.querySelectorAll('input[type="range"]')].map((r) => Number(r.value));
  });
  check('mute does not move the faders', kept.every((v) => v > 0), JSON.stringify(kept));
  await toggle(p, 1);
  await p.waitForTimeout(700);
  const back = await peak(p);
  check('unmute brings it back', back > AUDIBLE && back > muted, `${muted.toFixed(4)} -> ${back.toFixed(4)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the mix is remembered, the noise is not —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const rs = [...s.querySelectorAll('input[type="range"]')];
    rs[1].value = '0.25';
    rs[1].dispatchEvent(new Event('input', { bubbles: true }));
    rs[4].value = '0.1';
    rs[4].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(400);
  await p.reload({ waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3500);
  await openSound(p);
  const after = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    return {
      faders: [...s.querySelectorAll('input[type="range"]')].map((r) => Number(r.value)),
      on: s.querySelector('input[type="checkbox"]').checked,
    };
  });
  check('the faders come back where they were left', after.faders[1] === 0.25 && after.faders[4] === 0.1, JSON.stringify(after.faders));
  check('but the sound is still off on arrival', after.on === false);
  check('no audio context on a reload either', await p.evaluate(() => window.__audio.contexts.length === 0));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— an empty stadium is a quiet one —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  // Drum off: it does not care how many people are in, and it dominates the bed.
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    [...s.querySelectorAll('input[type="checkbox"]')][2].click();
  });
  await freeze(p);
  await p.waitForTimeout(600);
  const full = await peak(p);
  const setCrowd = async (v) => {
    await open(p, 'crowd');
    await p.evaluate((v) => {
      const s = document.querySelector('.mds-section[data-sec="crowd"]');
      const sel = s.querySelector('select');
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await p.waitForTimeout(1200);
  };
  await setCrowd('empty');
  const empty = await peak(p);
  check('emptying the ground quietens the crowd', empty < full * 0.65, `${full.toFixed(4)} -> ${empty.toFixed(4)}`);
  // ...and the checkbox that turns that off, turns it off.
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    [...s.querySelectorAll('input[type="checkbox"]')][3].click(); // crowd follows the fill
  });
  await p.waitForTimeout(1200);
  const overridden = await peak(p);
  check('turning that off restores the level', overridden > empty * 1.3, `${empty.toFixed(4)} -> ${overridden.toFixed(4)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— weather you can hear —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  // Silence everything but the weather bus, so what is measured is the rain.
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const rs = [...s.querySelectorAll('input[type="range"]')];
    for (const i of [1, 2, 4]) { rs[i].value = '0'; rs[i].dispatchEvent(new Event('input', { bubbles: true })); }
    rs[3].value = '1'; rs[3].dispatchEvent(new Event('input', { bubbles: true }));
    [...s.querySelectorAll('input[type="checkbox"]')][2].click(); // drum off
  });
  await freeze(p);
  await p.waitForTimeout(900);
  const dry = await peak(p);
  await p.evaluate(() => {
  });
  await p.waitForTimeout(400);
  await open(p, 'atmosphere');
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="atmosphere"]');
    const sels = [...s.querySelectorAll('select')];
    const weather = sels[1];
    weather.value = 'rain';
    weather.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(1400);
  const wet = await peak(p);
  check('rain is audible', wet > dry * 2 && wet > AUDIBLE, `${dry.toFixed(4)} -> ${wet.toFixed(4)}`);
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    [...s.querySelectorAll('input[type="checkbox"]')][4].click(); // weather you can hear
  });
  await p.waitForTimeout(1200);
  const hushed = await peak(p);
  check('and can be switched off without changing the weather', hushed < wet * 0.5, `${wet.toFixed(4)} -> ${hushed.toFixed(4)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the effects that used to be silent —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const rs = [...s.querySelectorAll('input[type="range"]')];
    for (const i of [1, 3, 4]) { rs[i].value = '0'; rs[i].dispatchEvent(new Event('input', { bubbles: true })); }
    [...s.querySelectorAll('input[type="checkbox"]')][2].click(); // drum off
  });
  await freeze(p);
  await p.waitForTimeout(900);
  const quiet = await peak(p, 12, 60);
  for (const [label, name] of [['Confetti', 'confetti'], ['Pyro', 'pyro']]) {
    await p.evaluate((l) => {
        const s = document.querySelector('.mds-section[data-sec="atmosphere"]');
      [...s.querySelectorAll('.mds-btn')].find((b) => new RegExp(l, 'i').test(b.textContent)).click();
    }, name);
    const v = await peak(p, 14, 55);
    check(`${label} makes a noise`, v > quiet * 1.6 && v > AUDIBLE, `${quiet.toFixed(4)} -> ${v.toFixed(4)}`);
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the tab going away takes the sound with it —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  await freeze(p);
  const heard = await peak(p);
  check('audible while the tab is in front', heard > AUDIBLE, `rms ${heard.toFixed(4)}`);
  const state = await p.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 600));
    return window.__audio.contexts[0].ctx.state;
  });
  check('a hidden tab suspends the audio context', state === 'suspended', state);
  const back = await p.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 800));
    return window.__audio.contexts[0].ctx.state;
  });
  check('coming back resumes it', back === 'running', back);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the clip carries the crowd —');
{
  const [ctx, p, errs] = await sim();
  await openSound(p);
  await toggle(p, 0);
  await p.waitForTimeout(2200);
  // Shortest clip on offer, so the suite is not sitting here for 15 seconds.
  await open(p, 'record');
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="record"]');
    const dur = s.querySelector('select');
    dur.value = '6';
    dur.dispatchEvent(new Event('change', { bubbles: true }));
    [...s.querySelectorAll('.mds-btn')].find((b) => /Record video|سجّل/i.test(b.textContent)).click();
  });
  await p.waitForTimeout(14000);
  const rec = await p.evaluate(() => window.__audio.recorders.at(-1) ?? null);
  check('a recorder was constructed', !!rec, JSON.stringify(rec));
  check('its stream carries an audio track', !!rec && rec.tracks.includes('audio'), JSON.stringify(rec?.tracks));
  // Not "the mime names a codec", which is a fact about the browser: this
  // Chromium has no H.264 and no AAC, so the best audio-bearing MP4 it can do
  // is a bare `video/mp4` — which ffprobe confirms comes out carrying Opus.
  // The thing worth asserting is that nothing better was left on the table.
  const better = await p.evaluate((asked) => {
    if (/mp4a|opus/i.test(asked)) return null;
    const audioVariant = asked.includes('codecs=') ? `${asked},mp4a.40.2`
      : `${asked};codecs=${asked.includes('webm') ? 'opus' : 'mp4a.40.2'}`;
    return MediaRecorder.isTypeSupported(audioVariant) ? audioVariant : null;
  }, rec?.asked ?? '');
  check('it asked for the best audio-capable format this browser has', better === null,
    `asked ${rec?.asked}, but ${better} was available`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— with the sound off, the clip is still a clip —');
{
  const [ctx, p, errs] = await sim();
  await open(p, 'record');
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="record"]');
    const dur = s.querySelector('select');
    dur.value = '6';
    dur.dispatchEvent(new Event('change', { bubbles: true }));
    [...s.querySelectorAll('.mds-btn')].find((b) => /Record video|سجّل/i.test(b.textContent)).click();
  });
  await p.waitForTimeout(14000);
  const rec = await p.evaluate(() => window.__audio.recorders.at(-1) ?? null);
  check('a recorder was still constructed', !!rec, JSON.stringify(rec));
  check('video only, no dead audio track', !!rec && !rec.tracks.includes('audio'), JSON.stringify(rec?.tracks));
  check('and no audio codec is asked for', !!rec && !/mp4a|opus/i.test(rec.asked), rec?.asked);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— Arabic —');
{
  const [ctx, p, errs] = await sim({ lang: 'ar' });
  await openSound(p);
  const AR = /[؀-ۿ]/;
  const r = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    if (!s) return null;
    return {
      checks: [...s.querySelectorAll('.mds-checkrow span')].map((e) => e.textContent.trim()),
      faders: [...s.querySelectorAll('.mds-flabel-row span:first-child')].map((e) => e.textContent.trim()),
      buttons: [...s.querySelectorAll('.mds-btn')].map((e) => e.textContent.trim()),
    };
  });
  check('the Sound section exists in Arabic', !!r);
  check('every checkbox is Arabic', !!r && r.checks.every((x) => AR.test(x)), r?.checks.join(' · '));
  check('every fader is Arabic', !!r && r.faders.every((x) => AR.test(x)), r?.faders.join(' · '));
  check('every test button is Arabic', !!r && r.buttons.every((x) => AR.test(x)), r?.buttons.join(' · '));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— on a phone —');
{
  const c = await browser.newContext({
    viewport: { width: 360, height: 680 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS('en') }] },
  });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.addInitScript(TAP);
  await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(4500);
  await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
  await p.waitForTimeout(600);
  await openSound(p);
  await p.evaluate(() => {
    const ov = document.querySelector('.mds-overlay');
    for (const a of ov.getAnimations({ subtree: true })) { try { a.finish(); } catch { /* infinite */ } }
  });
  await p.waitForTimeout(300);
  const r = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const small = [], off = [];
    for (const el of s.querySelectorAll('input,button')) {
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.height < 24 || b.width < 24) small.push(`${el.type || el.tagName} ${Math.round(b.width)}x${Math.round(b.height)}`);
      if (b.right > innerWidth + 1 || b.left < -1) off.push(`${el.type || el.tagName} @${Math.round(b.x)}`);
    }
    return { small, off, faders: s.querySelectorAll('input[type="range"]').length, scrolls: s.closest('.mds-panel').scrollHeight > s.closest('.mds-panel').clientHeight };
  });
  check('all five faders are there on a phone', r.faders === 5, String(r.faders));
  check('nothing in the section is off-screen', r.off.length === 0, JSON.stringify(r.off));
  check('every control is a real target', r.small.length === 0, JSON.stringify(r.small));
  check('the sheet scrolls to reach them', r.scrolls);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await c.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
