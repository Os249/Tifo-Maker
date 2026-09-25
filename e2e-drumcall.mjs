/**
 * The drum call — the Saudi way of showing a card tifo.
 *
 *   DOOM · DOOM · DOOM · every card up ……… DOOM · DOOM · DOOM · every card down
 *
 * What this checks is what someone watching would notice: that the picture is
 * NOT there before the count, IS there through the hold, and is gone after the
 * drop; that the drum is actually hit, six times, on the beat, loud enough to
 * hear; and that the count reads on screen with the sound off.
 *
 * Hits are caught at the source: every tabl hit starts its body oscillator at
 * 104 Hz with `setValueAtTime(104, at)`, so wrapping that one method records
 * each hit's time on the audio clock to the sample — no RMS sampling from Node
 * racing a software-rendered page. The loudness is then measured separately at
 * the destination, because a hit that is scheduled and inaudible is the bug the
 * sound suite was written for.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * SHOTS=dir saves a screenshot of each phase.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
}).catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// The timing the product promises (src/core/drumCall.ts), restated here on
// purpose: if someone changes the feel of it, this suite should notice.
const LEAD = 0.4, BEAT = 0.6, JITTER = 0.35, LIFT = 0.14, TAIL = 0.6;
const FIXED = LEAD + 6 * BEAT + JITTER + LIFT + TAIL;

const LS = (lang = 'en', extra = []) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  ...extra,
];

/** Analyser in front of every destination, and a log of every tabl hit. */
const TAP = () => {
  window.__audio = { contexts: [], hits: [], oohs: [], terrace: [], applause: 0, recorders: [] };
  const AC = window.AudioContext;
  if (AC) {
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
  }
  const svat = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function (v, t) {
    if (v === 104) window.__audio.hits.push(t); // a tabl hit's body
    if (v === 330) window.__audio.oohs.push(t); // the crowd's "Oooh" (its first formant)
    if (v === 150) window.__audio.terrace.push(t); // a terrace-drum hit
    return svat.call(this, v, t);
  };
  // A frame recorder. Under software rendering a frame takes about a second
  // and a page screenshot several, and the compositor runs seconds behind — so
  // a screenshot "during the count" can show any moment. Instead every frame is
  // sampled right after it is drawn, in the same task (the only time a WebGL
  // drawing buffer can be read), together with the count on screen at that
  // instant.
  window.__frames = [];
  window.__rec = null; // { full: bool }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    cb(ts);
    const rec = window.__rec;
    if (!rec) return;
    const c = document.querySelector('.mds-overlay canvas');
    if (!c || !c.width) return;
    const el = document.querySelector('.mds-beats');
    const hud = el && el.classList.contains('show') ? `${el.dataset.phase}${el.querySelectorAll('i.on').length}` : '-';
    const W = 96, H = 60;
    const t = window.__thumb || (window.__thumb = Object.assign(document.createElement('canvas'), { width: W, height: H }));
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) px.push(d[i], d[i + 1], d[i + 2]);
    const last = window.__frames[window.__frames.length - 1];
    if (last && last.ts === ts) window.__frames.pop();
    let full = null;
    if (rec.full) {
      const f = document.createElement('canvas');
      f.width = c.width; f.height = c.height;
      f.getContext('2d').drawImage(c, 0, 0);
      full = f.toDataURL('image/png');
    }
    window.__frames.push({ ts, at: performance.now(), hud, px, full });
  });
  // Applause is a 3.2 s buffer of claps; the drum call should never start one.
  const bst = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (this.buffer && Math.abs(this.buffer.duration - 3.2) < 0.01) window.__audio.applause++;
    return bst.apply(this, a);
  };
  const MR = window.MediaRecorder;
  if (MR) {
    window.MediaRecorder = class extends MR {
      constructor(stream, opts) {
        super(stream, opts);
        window.__audio.recorders.push({ asked: opts?.mimeType ?? '', tracks: stream.getTracks().map((t) => t.kind) });
      }
    };
    window.MediaRecorder.isTypeSupported = MR.isTypeSupported.bind(MR);
  }
};

const gallery = await (await fetch(B + '/api/gallery?templates=1&limit=5')).json();
const DESIGN = gallery[0].id;

async function openPage(path, { lang = 'en', w = 1440, h = 900, extra = [] } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, extra) }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.addInitScript(TAP);
  await p.goto(B + path, { waitUntil: 'networkidle', timeout: 120000 });
  return [ctx, p, errs];
}

/** How much of a region is the design (saturated or bright), 0..1 — the stand's empty cards are neither. */
async function pictureScore(p, clip) {
  const png = PNG.sync.read(await p.screenshot({ clip }));
  let n = 0, tot = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if ((mx > 60 && (mx - mn) / mx > 0.45) || mn > 190) n++;
    tot++;
  }
  return n / tot;
}
/** Fraction of sampled pixels that differ between two screenshots. */
const differs = (a, b) => {
  let n = 0, tot = 0;
  for (let i = 0; i < a.data.length; i += 16) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 50) n++;
    tot++;
  }
  return n / tot;
};
const shot = async (p, name, clip) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, clip }); };

// ---------------------------------------------------------------------------
console.log('\n— the editor: Animate reveal —');
{
  const [ctx, p, errs] = await openPage('/app?design=' + DESIGN);
  await p.waitForTimeout(5000);
  await p.click('#rail-anim', { force: true });
  await p.waitForTimeout(700);
  const opts = await p.$$eval('#reveal-preset option', (os) => os.map((o) => [o.value, o.textContent]));
  const opt = opts.find(([v]) => v === 'drum-call');
  check('the reveal list offers the drum call', !!opt, opt?.[1]);
  check('its row is hidden for other reveals', await p.$eval('#reveal-drum', (e) => e.hidden));
  await p.selectOption('#reveal-preset', 'drum-call');
  await p.waitForTimeout(400);
  const ui = await p.evaluate(() => ({
    hidden: document.querySelector('#reveal-drum').hidden,
    min: Number(document.querySelector('#reveal-dur').min),
    val: Number(document.querySelector('#reveal-dur').value),
    out: document.querySelector('#reveal-dur-out').textContent,
  }));
  check('choosing it shows its row', ui.hidden === false);
  check('its length starts where the hits fit', ui.min >= Math.ceil(FIXED + 1) && ui.val === 9 && ui.out === '9s', JSON.stringify(ui));

  const canvasBox = await p.$eval('#canvas-host canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const clip = { x: Math.round(canvasBox.x + 10), y: Math.round(canvasBox.y + canvasBox.height * 0.3), width: Math.round(canvasBox.width - 20), height: Math.round(canvasBox.height * 0.4) };
  const seek = async (sec) => {
    await p.evaluate((v) => { const s = document.querySelector('#reveal-scrub'); s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); }, Math.round((sec / 9) * 100));
    await p.waitForTimeout(500);
  };
  const hold = 9 - FIXED, up = LEAD + 3 * BEAT, down = up + hold + 3 * BEAT;
  await p.click('#reveal-reset');
  await p.waitForTimeout(500);
  const full = await pictureScore(p, clip);
  await seek(1.3);
  const counting = await pictureScore(p, clip);
  const dots1 = await p.$$eval('#reveal-beats i.on', (d) => d.length);
  await shot(p, 'editor-1-counting', undefined);
  await seek(up + hold / 2);
  const held = await pictureScore(p, clip);
  await shot(p, 'editor-2-held', undefined);
  await seek(down + 0.2);
  const dropping = await pictureScore(p, clip);
  await seek(9);
  const after = await pictureScore(p, clip);
  await shot(p, 'editor-3-gone', undefined);
  check('the design is there to begin with', full > 0.05, full.toFixed(3));
  check('during the count the stand is empty', counting < full * 0.15, `${counting.toFixed(3)} vs ${full.toFixed(3)}`);
  check('the count shows on the dots (two hits in)', dots1 === 2, String(dots1));
  check('through the hold the whole picture is up', held > full * 0.9, `${held.toFixed(3)} vs ${full.toFixed(3)}`);
  check('on the drop the picture goes', dropping < held, `${dropping.toFixed(3)}`);
  check('it ends with the stand empty, not the design popping back', after < full * 0.15, `${after.toFixed(3)} vs ${full.toFixed(3)}`);

  // Play: six hits of the drum, on the beat, from the start.
  await p.click('#reveal-reset');
  await p.evaluate(() => { window.__audio.hits.length = 0; });
  await p.click('#reveal-play');
  await p.waitForTimeout(800);
  const label = await p.$eval('#reveal-play', (b) => b.textContent.trim());
  await p.waitForTimeout(9000);
  const hits = await p.evaluate(() => window.__audio.hits.slice());
  const rel = hits.map((t) => t - hits[0]);
  const want = [0, BEAT, 2 * BEAT, 3 * BEAT + hold, 4 * BEAT + hold, 5 * BEAT + hold];
  check('Play hits the drum six times', hits.length === 6, String(hits.length));
  check('…on the beat: three, the hold, three', rel.length === 6 && rel.every((t, i) => Math.abs(t - want[i]) < 0.02), rel.map((t) => t.toFixed(2)).join(' '));
  check('while playing, the button says Pause', /Pause/.test(label), label);
  const endScore = await pictureScore(p, clip);
  check('played to the end, it ends empty', endScore < full * 0.15, endScore.toFixed(3));

  // Drum sound off: the same show, silent.
  await p.click('#reveal-reset');
  await p.uncheck('#reveal-drum-sound');
  await p.evaluate(() => { window.__audio.hits.length = 0; });
  await p.click('#reveal-play');
  await p.waitForTimeout(2600);
  check('with Drum sound off, nothing is hit', (await p.evaluate(() => window.__audio.hits.length)) === 0);
  await p.click('#reveal-play'); // pause
  await p.check('#reveal-drum-sound');

  // Pausing mid-count cancels the hits still to come.
  await p.click('#reveal-reset');
  await p.evaluate(() => { window.__audio.hits.length = 0; });
  await p.click('#reveal-play');
  await p.waitForTimeout(700);
  await p.click('#reveal-play');
  const scheduled = await p.evaluate(() => window.__audio.hits.length);
  check('the hits are scheduled together on Play', scheduled === 6, String(scheduled));

  // Back to a sweep: the old range, the row hidden, and the end is the design again.
  await p.selectOption('#reveal-preset', 'sweep-rl');
  await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({ hidden: document.querySelector('#reveal-drum').hidden, max: Number(document.querySelector('#reveal-dur').max), val: Number(document.querySelector('#reveal-dur').value) }));
  check('another reveal gets the old length range back', back.hidden && back.max === 10 && back.val <= 10, JSON.stringify(back));
  await p.evaluate(() => { const s = document.querySelector('#reveal-scrub'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(400);
  const sweepEnd = await pictureScore(p, clip);
  check('a sweep still ends on the finished design', sweepEnd > full * 0.9, sweepEnd.toFixed(3));

  // The flat GIF plays the same show: empty, picture, empty.
  await p.selectOption('#reveal-preset', 'drum-call');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click('#reveal-gif')]);
  const buf = await (await dl.createReadStream()).toArray();
  const gif = Buffer.concat(buf);
  check('the drum-call GIF exports', gif.slice(0, 3).toString() === 'GIF' && gif.length > 2000, `${(gif.length / 1024).toFixed(0)} KB`);

  // The 3D stadium video: the same show, and the drum is in the file.
  await p.evaluate(() => { window.__audio.recorders.length = 0; window.__audio.hits.length = 0; });
  const [vdl] = await Promise.all([
    p.waitForEvent('download', { timeout: 180000 }),
    p.$eval('#sx-export', (b) => b.click()),
  ]);
  const vpath = await vdl.path();
  const recs = await p.evaluate(() => window.__audio.recorders.slice());
  const vhits = await p.evaluate(() => window.__audio.hits.length);
  check('the 3D video export records the drum', recs.length > 0 && recs.every((r) => r.tracks.includes('audio')), JSON.stringify(recs));
  // No codec-name check: which audio codec gets named is a fact about the
  // browser (this Chromium has no AAC and muxes Opus into a bare video/mp4).
  // ffprobe on the actual file, below, is the check that matters.
  check('…with all six hits in it', vhits === 6, String(vhits));
  try {
    const { execFileSync } = await import('node:child_process');
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', vpath], { encoding: 'utf8' }).trim().split('\n');
    check('the downloaded video has an audio stream', streams.includes('audio'), streams.join(','));
  } catch { /* no ffprobe here: the recorder check above stands */ }
  // Exporting again still has sound: the drum's tracks are detached, not stopped.
  await p.evaluate(() => { window.__audio.recorders.length = 0; });
  await p.click('#view-2d', { force: true }).catch(() => {});
  await p.waitForTimeout(500);
  const [vdl2] = await Promise.all([p.waitForEvent('download', { timeout: 180000 }), p.$eval('#sx-export', (b) => b.click())]);
  await vdl2.path();
  const recs2 = await p.evaluate(() => window.__audio.recorders.slice());
  check('a second export still records the drum', recs2.length > 0 && recs2.every((r) => r.tracks.includes('audio')), JSON.stringify(recs2));
  check('no page errors in the editor', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— the editor, in Arabic —');
{
  const [ctx, p] = await openPage('/app?design=' + DESIGN, { lang: 'ar' });
  await p.waitForTimeout(5000);
  await p.click('#rail-anim', { force: true });
  await p.selectOption('#reveal-preset', 'drum-call');
  await p.waitForTimeout(400);
  const t = await p.evaluate(() => ({
    opt: [...document.querySelectorAll('#reveal-preset option')].find((o) => o.value === 'drum-call').textContent,
    hint: document.querySelector('#reveal-drum .hint').textContent,
    sound: document.querySelector('#reveal-drum label').textContent.trim(),
    play: document.querySelector('#reveal-play').textContent.trim(),
  }));
  const arabic = (s) => /[؀-ۿ]/.test(s) && !/[A-Za-z]{3,}/.test(s);
  check('the drum call is named in Arabic', arabic(t.opt), t.opt);
  check('its hint and its drum switch are Arabic', arabic(t.hint) && arabic(t.sound), t.sound);
  await p.click('#reveal-play');
  await p.waitForTimeout(500);
  const pauseAr = await p.$eval('#reveal-play', (b) => b.textContent.trim());
  check('Play / Pause are Arabic too (they were hard-coded English)', arabic(t.play) && arabic(pauseAr), `${t.play} / ${pauseAr}`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day —');
{
  const [ctx, p, errs] = await openPage('/app?sim=1&design=' + DESIGN, { w: 1100, h: 700 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);
  const openSec = async (k) => {
    await p.evaluate((key) => {
      const s = document.querySelector(`.mds-section[data-sec="${key}"]`);
      if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
    }, k);
    await p.waitForTimeout(350);
  };
  const K = (k) => `.mds-overlay [data-k="${k}"]`;
  // By script, not by pointer: the panel is an accordion and a section this
  // suite is not looking at may be folded away — the control still works.
  const clickK = (k) => p.$eval(K(k), (b) => b.click());
  const selectK = (k, v) => p.$eval(K(k), (s, val) => { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  // Low tier: under software rendering the higher tiers draw a frame every
  // second or so, and a show is judged by what is on screen at each beat.
  await p.$eval('.mds-baracts select', (s) => { s.value = 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);
  await openSec('choreo');
  const labels = await p.$$eval(K('reveal') + ' option', (os) => os.map((o) => [o.value, o.textContent]));
  check('Match Day offers the drum call', labels.some(([v]) => v === 'drum-call'), labels.find(([v]) => v === 'drum-call')?.[1]);
  check('its controls are hidden until it is chosen', await p.$eval('.mds-drumcall', (e) => getComputedStyle(e).display === 'none'));
  await selectK('reveal', 'drum-call');
  await p.waitForTimeout(300);
  check('choosing it shows Hold and How many times', await p.$eval('.mds-drumcall', (e) => getComputedStyle(e).display !== 'none'));
  const rec = await p.$eval(K('rec-length'), (s) => Number(s.value));
  check('the clip length grows to hold the whole call', rec >= 12, `${rec}s`);

  // Sound on, crowd and effects silent, so the tabl is the only thing playing.
  await openSec('sound');
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const c = s.querySelectorAll('input[type="checkbox"]')[0];
    if (!c.checked) c.click();
  });
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="sound"]');
    const r = [...s.querySelectorAll('input[type="range"]')];
    // master, crowd, sfx, amb, drum
    [1, 0, 0, 0, 1].forEach((v, i) => { if (r[i]) { r[i].value = String(v); r[i].dispatchEvent(new Event('input', { bubbles: true })); } });
    // The terrace drum on, to prove the call silences it and only hands it
    // back once everything is over (it used to walk in on the drop's "Oooh").
    const d = s.querySelectorAll('input[type="checkbox"]')[2];
    if (!d.checked) d.click();
  });
  await p.waitForTimeout(1500);

  // Every frame of the show, sampled as it is drawn (see TAP).
  const diffPx = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 50) n++; return n / (a.length / 3); };
  await p.evaluate((full) => { window.__frames.length = 0; window.__rec = { full }; }, !!SHOTS);
  await p.waitForTimeout(2500); // a frame or two of the design as it stands
  // Marked and clicked in one go: a frame rendered between the two would count
  // as "after Play" while still showing the design as it stood.
  await p.evaluate(() => {
    window.__audio.hits.length = 0;
    window.__audio.oohs.length = 0;
    window.__audio.applause = 0;
    window.__playAt = performance.now();
    window.__clickAudio = window.__audio.contexts[0]?.ctx.currentTime ?? 0;
    document.querySelector('.mds-overlay [data-k="play-reveal"]').click();
  });
  await p.waitForTimeout(13000);
  const frames = await p.evaluate(() => { window.__rec = null; return window.__frames.map((f) => ({ ...f, after: f.at > window.__playAt })); });
  if (SHOTS) {
    const fs = await import('node:fs');
    frames.forEach((f, i) => { if (f.full) fs.writeFileSync(`${SHOTS}/matchday-frame-${String(i).padStart(2, '0')}-${f.hud.replace('-', 'none')}.png`, Buffer.from(f.full.split(',')[1], 'base64')); });
  }
  const base = frames.find((f) => !f.after);
  const show = frames.filter((f) => f.after);
  const order = show.map((f) => f.hud).filter((k, i, xs) => i === 0 || xs[i - 1] !== k).join(' ');
  const firstUp = show.findIndex((f) => /^up/.test(f.hud));
  const lifted = show.findIndex((f, i) => i > firstUp && firstUp >= 0 && f.hud === '-');
  const firstDown = show.findIndex((f) => /^down/.test(f.hud));
  const dropped = show.findIndex((f, i) => i > firstDown && firstDown >= 0 && f.hud === '-');
  // Before the lift: every frame up to (not including) the one showing the third hit.
  const counting = show.filter((f, i) => i < (firstUp >= 0 ? firstUp : 0) || f.hud === 'up1' || f.hud === 'up2');
  // Held: after the count clears (half a second past the lift, everyone up), up to the third drop hit.
  const holding = show.filter((f, i) => lifted >= 0 && i >= lifted && (firstDown < 0 || i < firstDown || f.hud === 'down1' || f.hud === 'down2'));
  const after = dropped >= 0 ? show.slice(dropped) : [];
  check('frames were recorded through the whole show', !!base && show.length >= 6, `${show.length} frames`);
  check('the count shows going up, clears, then shows coming down', /up\d.* - .*down\d.* -/.test(order + ' -'), order);
  const counts = (ph) => show.filter((f) => f.hud.startsWith(ph)).map((f) => Number(f.hud.slice(ph.length)));
  const rising = (xs) => xs.length > 0 && xs.every((x, i) => i === 0 || x >= xs[i - 1]) && xs.every((x) => x >= 1 && x <= 3);
  check('…and only ever counts forward, 1 to 3', rising(counts('up')) && rising(counts('down')), order);
  if (base && counting.length && holding.length && after.length) {
    const dC = Math.min(...counting.map((f) => diffPx(base.px, f.px)));
    const dH = Math.max(...holding.map((f) => diffPx(base.px, f.px)));
    const dA = Math.min(...after.slice(0, 2).map((f) => diffPx(base.px, f.px)));
    check('before the lift, the picture is not there', dC > 0.04, `${counting.length} frames, ${dC.toFixed(3)} different from the design`);
    check('through the hold, all of it is there', dH < 0.01, `${holding.length} frames, ${dH.toFixed(3)} different from the design`);
    check('after the drop, it is gone again', dA > 0.04 && Math.abs(dA - dC) < 0.02, `${dA.toFixed(3)} (the count was ${dC.toFixed(3)})`);
  } else check('caught a frame of every phase', false, `count ${counting.length} · hold ${holding.length} · after ${after.length} · ${order}`);
  const hits = await p.evaluate(() => window.__audio.hits.slice());
  const rel = hits.map((t) => t - hits[0]);
  const wantMd = [0, BEAT, 2 * BEAT, 3 * BEAT + 4, 4 * BEAT + 4, 5 * BEAT + 4];
  check('the tabl is hit six times', hits.length === 6, String(hits.length));
  check('…on the beat on the audio clock, however slowly the frames come', rel.length === 6 && rel.every((t, i) => Math.abs(t - wantMd[i]) < 0.02), rel.map((t) => t.toFixed(2)).join(' '));
  // The "Oooh" is ON the beat the cards go up — the one after the third hit —
  // and on the beat they come down. Within 2 ms: one render quantum.
  const au = await p.evaluate(() => ({ oohs: window.__audio.oohs.slice(), applause: window.__audio.applause, terrace: window.__audio.terrace.slice(), click: window.__clickAudio }));
  const oohLift = au.oohs[0] - hits[2], oohDrop = au.oohs[1] - hits[5];
  check('the crowd goes "Oooh" twice: as it appears, and as it goes', au.oohs.length === 2, String(au.oohs.length));
  check('…the first exactly as the cards go up, not a moment after', Math.abs(oohLift - BEAT) < 0.002, `${((oohLift - BEAT) * 1000).toFixed(2)} ms from the lift`);
  check('…the second exactly as they come down', Math.abs(oohDrop - BEAT) < 0.002, `${((oohDrop - BEAT) * 1000).toFixed(2)} ms from the drop`);
  check('no applause in the drum call (it sounded like a fault)', au.applause === 0, String(au.applause));
  const showEnd = au.click + FIXED + 4 + 0.4; // the call with its default 4 s hold, plus the show's closing 0.4 s
  const during = au.terrace.filter((t) => t > au.click + 0.4 && t < showEnd + 2.4);
  check('the terrace drum stays out of the call, and out of the drop\'s "Oooh"', during.length === 0, during.map((t) => (t - au.click).toFixed(2)).join(' '));
  // …and a few seconds later the design settles back.
  await p.evaluate(() => { window.__frames.length = 0; window.__rec = { full: false }; });
  await p.waitForTimeout(3000);
  const settledF = await p.evaluate(() => { window.__rec = null; return window.__frames.slice(-1)[0]; });
  const dS = settledF ? diffPx(base.px, settledF.px) : 1;
  check('a few seconds after, the design settles back', dS < 0.01, dS.toFixed(3));
  await p.waitForTimeout(2500);
  const back = await p.evaluate((end) => window.__audio.terrace.filter((t) => t > end).length, showEnd + 2.4);
  check('…and only then does the terrace drum come back', back > 0, `${back} hits`);
  await p.evaluate(() => {
    const d = document.querySelector('.mds-section[data-sec="sound"]').querySelectorAll('input[type="checkbox"]')[2];
    if (d.checked) d.click();
  });

  // Twice round.
  await selectK('drum-times', '2');
  await p.waitForTimeout(200);
  const rec2 = await p.$eval(K('rec-length'), (s) => Number(s.value));
  check('twice round, the clip grows again', rec2 >= 20, `${rec2}s`);
  await p.evaluate(() => { window.__frames.length = 0; window.__rec = { full: false }; window.__audio.hits.length = 0; });
  await clickK('play-reveal');
  await p.waitForTimeout(1800);
  const mid = await p.evaluate(() => window.__frames.slice(-1)[0]);
  await clickK('stop');
  await p.waitForTimeout(2500);
  const stopped = await p.evaluate(() => { window.__rec = null; return window.__frames.slice(-1)[0]; });
  check('stopped mid-count, the stand was empty', !!mid && diffPx(base.px, mid.px) > 0.04, mid ? diffPx(base.px, mid.px).toFixed(3) : 'no frame');
  check('Stop brings the design straight back', !!stopped && diffPx(base.px, stopped.px) < 0.01, stopped ? diffPx(base.px, stopped.px).toFixed(3) : 'no frame');
  check('…and clears the count', !(await p.$eval('.mds-beats', (e) => e.classList.contains('show'))));
  await selectK('drum-times', '1');

  // A custom sequence cue: the call comes with its drum.
  await selectK('cue-kind', 'reveal');
  await clickK('add-cue');
  await p.waitForTimeout(200);
  const cueText = await p.$eval('.mds-section[data-sec="choreo"]', (s) => [...s.querySelectorAll('.mds-hint')].map((h) => h.textContent).join(' | '));
  check('a drum-call cue brings its six hits and both Oohs', /\b9 cues/.test(cueText), cueText);

  // Auto choreo: the Saudi show, with its camera cuts.
  await p.evaluate(() => { window.__audio.hits.length = 0; });
  await clickK('auto');
  await p.waitForTimeout(3200);
  const autoHits = await p.evaluate(() => window.__audio.hits.length);
  check('Auto choreo opens on the count', autoHits >= 3, String(autoHits));
  await clickK('stop');
  await p.waitForTimeout(600);

  // Loud enough to hear. Last, because it stops the render loop: the hits are
  // already booked on the audio clock, and sampling from Node competes with
  // software rendering for the main thread otherwise.
  await p.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await p.waitForTimeout(1500); // the frame in flight lands; nothing renders after it
  await clickK('play-reveal');
  const rmsNow = () => p.evaluate(() => {
    let rms = 0;
    for (const a of window.__audio.contexts) {
      const d = new Uint8Array(a.an.fftSize); a.an.getByteTimeDomainData(d);
      let s = 0; for (const x of d) { const v = (x - 128) / 128; s += v * v; }
      rms = Math.max(rms, Math.sqrt(s / d.length));
    }
    return rms;
  });
  let loud = 0, quiet = 1;
  const a0 = Date.now();
  while (Date.now() - a0 < 2600) {
    const r = await rmsNow();
    const el = (Date.now() - a0) / 1000;
    if (el < 0.25) quiet = Math.min(quiet, r); // before the first hit (0.4 s)
    loud = Math.max(loud, r);
    await p.waitForTimeout(30);
  }
  check('before the first hit, with the crowd silent, it is quiet', quiet < 0.01, quiet.toFixed(4));
  check('the tabl is loud enough to hear', loud > 0.05, loud.toFixed(3));
  check('no page errors in Match Day', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day, in Arabic —');
{
  const [ctx, p] = await openPage('/app?sim=1&design=' + DESIGN, { lang: 'ar', w: 1280, h: 860 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="choreo"]');
    if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
  });
  await p.selectOption('.mds-overlay [data-k="reveal"]', 'drum-call');
  await p.waitForTimeout(300);
  const t = await p.evaluate(() => {
    const sec = document.querySelector('.mds-section[data-sec="choreo"]');
    return {
      options: [...sec.querySelector('[data-k="reveal"]').options].map((o) => o.textContent),
      box: sec.querySelector('.mds-drumcall').textContent,
    };
  });
  const arabic = (s) => /[؀-ۿ]/.test(s) && !/[A-Za-z]{3,}/.test(s);
  check('every Match Day reveal is named in Arabic (they were English-only)', t.options.every(arabic), t.options.join(' / '));
  check('the drum call controls are Arabic', arabic(t.box.replace(/\d+s/g, '')), t.box.slice(0, 80));
  await ctx.close();
}

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
