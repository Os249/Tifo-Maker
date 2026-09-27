/**
 * Recording in the cinematic flyover.
 *
 * Match Day could fly the camera round the bowl, and it could record a clip,
 * but never both at once: starting the show switched the flyover off (with its
 * button still lit), and the clip cut between the show's fixed cameras. Now the
 * Recording section has a Camera choice, and "Cinematic flyover" films the
 * whole clip in one move, starting wide and high and sweeping in.
 *
 * What this checks, in a real browser against the built app:
 *   - the Camera choice exists, follows the live Flyover button, and is Arabic in Arabic;
 *   - a show played under the flyover keeps flying, and the button tells the truth;
 *   - picking a fixed camera ends the flyover, and the button says so;
 *   - Preview in flyover mode flies;
 *   - a flyover clip flies for its whole length, then puts the camera back as it was;
 *   - a show-cameras clip does not fly, even with the flyover on, and turns it back on after;
 *   - the file is named for what it is, and it is a real video: frames pulled from it
 *     show the camera moving round the bowl (ffprobe/ffmpeg, when installed).
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * SHOTS=dir keeps frames pulled from the flyover clip.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

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
async function sim({ lang = 'en', webm = false, small = false } = {}) {
  const ctx = await browser.newContext({ viewport: small ? { width: 800, height: 520 } : { width: 1280, height: 800 }, acceptDownloads: true, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang) }] } });
  // This test Chromium has no H.264 encoder, and the bare-MP4 fallback it
  // offers writes an empty file here. Hide MP4 so it records the WebM it can
  // actually produce, and the clip can be opened and looked at.
  if (webm) await ctx.addInitScript(() => {
    const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    MediaRecorder.isTypeSupported = (t) => !/mp4/i.test(t) && orig(t);
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.goto(`${B}/app?new=1&sim=1`, { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(3000);
  return { ctx, p, errs };
}
const K = (k) => `.mds-overlay [data-k="${k}"]`;
const openSec = (p, key) => p.evaluate((k) => {
  const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
  if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
}, key);
const flying = (p) => p.$eval(K('flyover'), (b) => b.classList.contains('active') && b.getAttribute('aria-pressed') === 'true');
const setSel = (p, k, v) => p.$eval(K(k), (s, v) => { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const click = (p, k) => p.$eval(K(k), (b) => b.click());
// How many frames a second the page actually paints. A software-rendered test
// browser can manage one or two, and a clip of a page that is not painting has
// nothing in it — that is this machine, not the recorder.
const paintRate = (p) => p.evaluate(() => new Promise((r) => {
  let n = 0; const t = performance.now();
  const f = () => { n++; if (performance.now() - t < 1500) requestAnimationFrame(f); else r(n / ((performance.now() - t) / 1000)); };
  requestAnimationFrame(f);
}));

// ---------------------------------------------------------------------------
console.log('\n— the choice —');
{
  const { ctx, p, errs } = await sim();
  await openSec(p, 'camera');
  await openSec(p, 'record');
  const opts = await p.$eval(K('rec-camera'), (s) => [...s.options].map((o) => [o.value, o.textContent]));
  check('Recording has a Camera choice: show cameras or the cinematic flyover',
    JSON.stringify(opts) === JSON.stringify([['show', 'Show cameras'], ['flyover', 'Cinematic flyover']]), JSON.stringify(opts));
  check('it starts on the show cameras while the flyover is off', (await p.$eval(K('rec-camera'), (s) => s.value)) === 'show');
  await click(p, 'flyover');
  check('turning the flyover on sets the clip to it', await flying(p) && (await p.$eval(K('rec-camera'), (s) => s.value)) === 'flyover');

  // The bug under the feature: a show started under the flyover switched it
  // off and left the button lit.
  await openSec(p, 'choreo');
  await click(p, 'auto');
  await p.waitForTimeout(2500);
  check('a show played under the flyover keeps flying', await flying(p));
  await p.waitForTimeout(1500);

  // Picking a fixed camera is leaving the flyover; the button follows.
  await p.$eval(K('camera'), (s) => { s.value = String((s.selectedIndex + 1) % s.options.length); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.waitForTimeout(600);
  check('picking a fixed camera ends the flyover, and the button says so', !(await flying(p)));

  // Preview flies when the clip will.
  await setSel(p, 'rec-camera', 'flyover');
  check('choosing the flyover for a clip does not start it by itself', !(await flying(p)));
  await click(p, 'rec-preview');
  await p.waitForTimeout(1200);
  check('Preview of a flyover clip flies', await flying(p));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— recording the flyover —');
let clipPath = null;
{
  const { ctx, p, errs } = await sim({ webm: true, small: true });
  await openSec(p, 'record');
  const fps = await paintRate(p);
  await setSel(p, 'rec-length', '6');
  await setSel(p, 'rec-camera', 'flyover');
  check('before the clip, the camera is still', !(await flying(p)));
  const dl = p.waitForEvent('download', { timeout: 90000 });
  await click(p, 'record-video');
  await p.waitForTimeout(1500);
  const during = [await flying(p)];
  await p.waitForTimeout(2500);
  during.push(await flying(p));
  check('the camera flies for the whole clip', during.every(Boolean), JSON.stringify(during));
  const d = await dl.catch(() => null);
  const name = d?.suggestedFilename() ?? '';
  check('the file is named for what it is', /^tifo-matchday-flyover\.(mp4|webm)$/.test(name), name);
  await p.waitForTimeout(300);
  const toast = await p.evaluate(() => document.querySelector('.mds-status')?.textContent || '');
  check('it says a flyover video was saved, and how big', /Flyover video saved — [\d.]+ MB/.test(toast), toast);
  const bytes = d ? await d.path().then((f) => readFileSync(f).length).catch(() => 0) : 0;
  if (fps >= 4) check('and it is not empty', bytes > 20000, `${bytes} bytes`);
  else console.log(`  (not checking the size: this browser paints ${fps.toFixed(1)} frames a second, so the clip has almost nothing in it — ${bytes} bytes)`);
  check('afterwards the camera is put back as it was (the flyover was off)', !(await flying(p)));
  if (d && bytes > 20000) {
    clipPath = join(mkdtempSync(join(tmpdir(), 'fly-')), name);
    await d.saveAs(clipPath);
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— show cameras, with the flyover on —');
{
  const { ctx, p, errs } = await sim();
  await openSec(p, 'camera');
  await click(p, 'flyover');
  await openSec(p, 'record');
  await setSel(p, 'rec-length', '6');
  await setSel(p, 'rec-camera', 'show');
  const dl = p.waitForEvent('download', { timeout: 90000 });
  await click(p, 'record-video');
  await p.waitForTimeout(2000);
  check('a show-cameras clip does not fly, even with the flyover on', !(await flying(p)));
  const d = await dl.catch(() => null);
  check('and is named as the reveal clip it is', /^tifo-matchday\.(mp4|webm)$/.test(d?.suggestedFilename() ?? ''), d?.suggestedFilename());
  await p.waitForTimeout(800);
  check('afterwards the flyover is back on', await flying(p));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— the clip itself —');
const have = (bin) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const run = (bin, args) => { try { return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; } };
const tools = have('ffprobe') && have('ffmpeg');
// Every frame, small. A MediaRecorder WebM often carries no duration in its
// header, so the frames are what is counted and compared, not the header.
const dir = SHOTS || mkdtempSync(join(tmpdir(), 'flyf-'));
const frames = clipPath && existsSync(clipPath) && tools && run('ffmpeg', ['-v', 'error', '-y', '-i', clipPath, '-vf', 'scale=320:-2', '-vsync', '0', join(dir, 'fly-%03d.png')]) !== null
  ? readdirSync(dir).filter((f) => /^fly-\d{3}\.png$/.test(f)).sort()
  : [];
if (frames.length >= 2) {
  check('the flyover clip is a real video with frames in it', frames.length >= 2, `${frames.length} frames`);
  // The first frame and the last. The flyover starts wide and high and closes
  // in, so the picture changes a lot from one to the other.
  const a = PNG.sync.read(readFileSync(join(dir, frames[0])));
  const b = PNG.sync.read(readFileSync(join(dir, frames[frames.length - 1])));
  let changed = 0, n = 0;
  for (let i = 0; i < a.data.length && i < b.data.length; i += 16) {
    const dd = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (dd > 60) changed++;
    n++;
  }
  check('the camera moves through the clip: first and last frames are different views', changed / n > 0.25, `${Math.round((100 * changed) / n)}% of the frame changed`);
} else {
  console.log('  (skipped: no clip with frames in it, or no ffprobe/ffmpeg on this machine)');
}

// ---------------------------------------------------------------------------
console.log('\n— Arabic —');
{
  const { ctx, p, errs } = await sim({ lang: 'ar' });
  await openSec(p, 'record');
  const r = await p.$eval(K('rec-camera'), (s) => ({
    opts: [...s.options].map((o) => o.textContent),
    label: s.closest('.mds-field')?.querySelector('.mds-flabel')?.textContent ?? '',
  }));
  const AR = /[؀-ۿ]/;
  check('the Camera choice is in Arabic', r.opts.every((o) => AR.test(o)) && AR.test(r.label), JSON.stringify(r));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
