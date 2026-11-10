/**
 * Pro's Match Day film (src/render/simulator/film.ts, src/ui/proFilm.ts), in
 * a real browser against a real server with PRO_MODE=preview:
 *
 *   the editor     a Pro size exports Match Day's film, not the stadium
 *                  view: the progress card (frames counting, a bar, Cancel),
 *                  then an H.264 MP4 at exactly 1920 × 1080 or 1080 × 1920,
 *                  every frame there, 30 a second, no frame repeated, no
 *                  mark when it is ticked, and the editor's view as it was;
 *                  Cancel stops it and saves nothing;
 *   Match Day      Record makes the film for an account Pro is on for: the
 *                  "Video" choice heads Recording, crowned, and hides the
 *                  recording's own fields; Record asks first (preview list),
 *                  then films; "Export without Pro items" is the recording
 *                  it always made; with the gift, landscape and vertical;
 *   no WebCodecs   the film is made in real time and the card says so;
 *   not on the list  none of it: Record is what it always was.
 *
 * A whole film is 390 frames; under software GL that is most of an hour, so
 * the page asks for its first frames only (window.__tifoFilmFrames, read only
 * on a page opened with ?e2e). The whole film is checked by
 * scripts/pro-film-shots.mts encode.
 *
 * Self-contained: it boots its own server (port 8975) on memory repos.
 * Needs a build:   npm run build && node e2e-pro-video.mjs
 * SHOTS=<dir> saves the card, the Match Day choice and a frame of each file.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8975;
const B = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/** How many frames each film in this suite makes. */
const FRAMES = 18;
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'qv_fan,qv_gift' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = await fetch(`${B}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const [tpl] = (await api('/api/templates')).json;
/** A verified account with one saved design: a tifo in the middle of one stand. */
const account = async (username) => {
  const cells = new Uint8Array(tpl.seatCount);
  // Bands round the bowl would be a whole-stadium design; a block of one
  // stretch of seats is a tifo with a stand to look at.
  const from = Math.floor(tpl.seatCount * 0.08), to = Math.floor(tpl.seatCount * 0.2);
  for (let i = from; i < to; i++) cells[i] = 1 + (Math.floor(i / 97) % 3);
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64: gzipSync(cells).toString('base64') }) });
  return { token, design: d.json?.id };
};
const fan = await account('qv_fan');
const gift = await account('qv_gift');
const other = await account('qv_other');
check('the gift starts for qv_gift', (await api('/api/pro/gift/accept', gift.token, { method: 'POST', body: '{}' })).status === 200);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const LS = { tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d', mds_seen_intro: '1', mds_help_seen_v1: '1', mds_sound_v2: JSON.stringify({ on: false }) };
/** A page for `token`: the editor, or Match Day straight away. */
const open = async (token, design, { sim = false, lang = 'en', noCodecs = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(([tok, lang, ls, frames, noCodecs]) => {
    try {
      for (const [k, v] of Object.entries({ ...ls, tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
    window.__tifoFilmFrames = frames;
    if (noCodecs) { delete window.VideoEncoder; delete window.VideoFrame; }
    window.__marks = 0;
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (text === 'tifomaker.org') window.__marks++;
      return fill.call(this, text, ...rest);
    };
  }, [token, lang, LS, FRAMES, noCodecs]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?project=${design}${sim ? '&sim=1' : ''}&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitFor(p, () => !!window.__tifo, null, 120000);
  if (sim) {
    await waitFor(p, () => window.__tifoMatchDay?.compileDone === true, null, 180000);
  } else {
    await waitFor(p, () => /wall$/.test(document.getElementById('doc-title')?.value || ''), null, 30000);
  }
  await p.waitForTimeout(800);
  return { ctx, p };
};
// Software GL holds the page for seconds a frame: a screenshot waits its turn.
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 300000 }); };
const bytesOf = async (dl) => Buffer.concat(await (await dl.createReadStream()).toArray());
const downloadFrom = async (p, click, ms = 900000) => {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: ms }), click()]);
  return { name: dl.suggestedFilename(), buf: await bytesOf(dl) };
};

/** What ffprobe and ffmpeg say of a film: its stream, its frames, repeats and spacing. */
const probe = (buf, name) => {
  const dir = join(tmpdir(), `qv-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, buf);
  try {
    const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
    const hashes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split('\n').map(Number);
    const steps = pts.slice(1).map((t, i) => t - pts[i]);
    let repeats = 0;
    for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) repeats++;
    if (SHOTS) execFileSync('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.1', '-i', file, '-frames:v', '1', join(SHOTS, `${name}.png`)]);
    return { codec: s.codec_name, w: s.width, h: s.height, rate: s.r_frame_rate, frames: Number(s.nb_read_frames), decoded: hashes.length, repeats, uneven: steps.filter((d) => Math.abs(d - 1 / 30) > 0.002).length };
  } catch (e) {
    return { err: String(e.message).slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** The film's sound track as ffprobe finds it: codec, channels, rate and length. */
const probeSound = (buf, name) => {
  const dir = join(tmpdir(), `qv-a-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, buf);
  try {
    const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,channels,sample_rate,duration', '-of', 'json', file], { encoding: 'utf8' })).streams;
    if (!s.length) return { streams: 0 };
    return { streams: s.length, codec: s[0].codec_name, channels: s[0].channels, rate: Number(s[0].sample_rate), duration: Number(s[0].duration) };
  } catch (e) {
    return { err: String(e.message).slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** The loudest moment of the film's sound, in dB below full scale (ffmpeg's volumedetect). */
const loudness = (buf, name) => {
  const dir = join(tmpdir(), `qv-l-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, buf);
  try {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || '');
    return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** The film plays in a browser's own <video>: its size and length. */
// A blank page: the site's own headers would refuse a blob: video.
const reader = await (await browser.newContext()).newPage();
await reader.setContent('<!doctype html><title>reader</title>');
const plays = (buf) => reader.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  try {
    await new Promise((res, rej) => { v.oncanplay = res; v.onerror = () => rej(new Error(String(v.error?.message || 'error'))); setTimeout(() => rej(new Error('timeout')), 20000); });
    await v.play();
    await new Promise((r) => setTimeout(r, 300));
    return { w: v.videoWidth, h: v.videoHeight, duration: v.duration, moved: v.currentTime > 0 };
  } catch (e) {
    return { err: String(e.message) };
  }
}, buf.toString('base64'));
const card = (p) => p.evaluate(() => {
  const c = document.querySelector('.qv-card');
  if (!c) return null;
  return { title: c.querySelector('h2')?.textContent, sub: c.querySelector('.qv-sub')?.textContent, count: c.querySelector('.qv-count')?.textContent, bar: c.querySelector('progress')?.value, note: c.querySelector('.qv-note')?.textContent };
});
/** The checks every film gets. */
const checkFilm = async (label, buf, w, h, { sound = true } = {}) => {
  const pr = probe(buf, `${label}.mp4`);
  const a = probeSound(buf, `${label}.mp4`);
  if (sound) {
    check(`${label}: a stereo sound track (${a.codec}), as long as the picture`, a.streams === 1 && ['aac', 'opus'].includes(a.codec) && a.channels === 2 && a.rate === 48000 && Math.abs(a.duration - FRAMES / 30) < 0.1, JSON.stringify(a));
    const db = loudness(buf, `${label}.mp4`);
    check(`${label}: …and the crowd can be heard on it`, db > -40 && db < 0.5, `max ${db} dB`);
  } else check(`${label}: no sound track`, a.streams === 0, JSON.stringify(a));
  check(`${label}: H.264, ${w} × ${h}, 30 frames a second`, pr.codec === 'h264' && pr.w === w && pr.h === h && pr.rate === '30/1', JSON.stringify(pr));
  check(`${label}: every frame there, none repeated, evenly spaced`, pr.frames === FRAMES && pr.decoded === FRAMES && pr.repeats === 0 && pr.uneven === 0, JSON.stringify(pr));
  const pl = await plays(buf);
  check(`${label}: plays in a <video>`, pl.w === w && pl.h === h && Math.abs(pl.duration - FRAMES / 30) < 0.05 && pl.moved, JSON.stringify(pl));
};

// =====================================================================
console.log('\n— the editor, Pro running (the gift) —');
{
  const { ctx, p } = await open(gift.token, gift.design);
  await p.click('#rail-anim');
  await waitFor(p, () => !document.getElementById('sx-size-row')?.hidden, null, 30000);
  await p.selectOption('#sx-size', 'hd');
  await p.check('#sx-nomark');
  await p.evaluate(() => { window.__marks = 0; });
  const dlP = downloadFrom(p, () => p.click('#sx-export'));
  check('Export at Full HD shows the film\'s card', await waitFor(p, () => !!document.querySelector('.qv-card'), null, 60000));
  check('…counting frames on a bar', await waitFor(p, () => /Frame \d+ of 18/.test(document.querySelector('.qv-count')?.textContent || '') && document.querySelector('.qv-card progress').value > 0, null, 600000), JSON.stringify(await card(p)));
  check('…and how long is left', await waitFor(p, () => /Frame \d+ of 18 · about (\d+ seconds?|a minute|\d+ minutes) left/.test(document.querySelector('.qv-count')?.textContent || ''), null, 600000), JSON.stringify(await card(p)));
  const c = await card(p);
  check('…saying what it makes', c?.title === 'Making your Match Day video' && /Full HD 1920\s×\s1080 · 13 seconds/.test(c?.sub || ''), JSON.stringify(c));
  await shot(p, 'qv-card-1440-en');
  const hd = await dlP;
  check('…and downloads an MP4 named for Match Day', /-matchday\.mp4$/.test(hd.name), hd.name);
  await checkFilm('editor-landscape', hd.buf, 1920, 1080);
  check('…without the mark (ticked)', await p.evaluate(() => window.__marks === 0));
  check('…and says what it saved', await waitFor(p, () => /Video saved: 1920\s×\s1080, 0.6 seconds/.test(document.getElementById('sx-status')?.textContent || ''), null, 10000), await p.textContent('#sx-status'));
  check('the card goes, and Match Day built for it is gone', await p.evaluate(() => !document.querySelector('.qv-card') && !document.querySelector('.qv-offscreen')));

  // A browser that can encode pictures but not sound: the film is silent, and says so.
  await p.selectOption('#sx-size', 'vertical');
  await p.uncheck('#sx-nomark');
  await p.evaluate(() => { window.__marks = 0; delete window.AudioEncoder; });
  const vtP = downloadFrom(p, () => p.click('#sx-export'));
  check('with no AudioEncoder the card says the video will be silent', await waitFor(p, () => { const n = document.querySelector('.qv-silent'); return !!n && !n.hidden && /silent/.test(n.textContent || ''); }, null, 120000), JSON.stringify(await card(p)));
  const vt = await vtP;
  await checkFilm('editor-vertical', vt.buf, 1080, 1920, { sound: false });
  check('…and so does the status', await waitFor(p, () => /the video is silent/.test(document.getElementById('sx-status')?.textContent || ''), null, 10000), await p.textContent('#sx-status'));
  check('…with the mark when it is not ticked', await p.evaluate(() => window.__marks >= 18));

  // Cancel: nothing saved, the editor as it was.
  await p.evaluate(() => { window.__tifoFilmFrames = 300; });
  let saved = false;
  p.once('download', () => { saved = true; });
  await p.click('#sx-export');
  await waitFor(p, () => /Frame [1-9]/.test(document.querySelector('.qv-count')?.textContent || ''), null, 600000);
  // Software GL holds the page for seconds a frame: the click waits its turn.
  await p.click('.qv-cancel', { timeout: 300000 });
  check('Cancel stops the film and says so', await waitFor(p, () => !document.querySelector('.qv-card') && /Video cancelled/.test(document.getElementById('sx-status')?.textContent || ''), null, 120000));
  await p.waitForTimeout(1500);
  check('…and saves nothing', !saved);
  check('…and frees its Match Day', await p.evaluate(() => !document.querySelector('.qv-offscreen')));
  await ctx.close();
}

// =====================================================================
console.log('\n— Match Day: on the preview list, Pro not running —');
{
  const { ctx, p } = await open(fan.token, fan.design, { sim: true });
  await p.evaluate(() => { const s = document.querySelector('.mds-section[data-sec="record"]'); if (!s.classList.contains('open')) s.querySelector('.mds-shead').click(); });
  check('Recording opens with the Video choice, crowned', await waitFor(p, () => !!document.querySelector('[data-k="rec-film"]') && !!document.querySelector('.qv-md-field .pro-chip:not(.quiet)'), null, 30000));
  const ui = await p.evaluate(() => ({
    opts: [...document.querySelector('[data-k="rec-film"]').options].map((o) => o.textContent),
    value: document.querySelector('[data-k="rec-film"]').value,
    hidden: ['rec-length', 'rec-camera'].map((k) => document.querySelector(`[data-k="${k}"]`).closest('.mds-field').hidden),
  }));
  check('…the film first, landscape and vertical, then the recording', ui.value === 'landscape' && ui.opts.length === 3 && /Full HD/.test(ui.opts[0]) && /vertical/.test(ui.opts[1]) && /Recording/.test(ui.opts[2]), JSON.stringify(ui));
  check('…and the recording\'s own fields hidden while a film is picked', ui.hidden.every(Boolean));
  await shot(p, 'qv-md-choice-1440-en');
  await p.click('.mds-bar .mds-btn:has-text("Record")');
  check('Record asks first, naming the film', await waitFor(p, () => [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent).includes('Full HD video'), null, 20000));
  const free = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'), 120000);
  check('"Export without Pro items" is the recording it always made', /^tifo-matchday\.(mp4|webm)$/.test(free.name) && free.buf.length > 0, `${free.name} ${free.buf.length}`);
  await p.selectOption('[data-k="rec-film"]', 'screen');
  check('picking the recording shows its fields again', await p.evaluate(() => !document.querySelector('[data-k="rec-length"]').closest('.mds-field').hidden));
  await ctx.close();
}

// =====================================================================
console.log('\n— Match Day, Pro running —');
{
  const { ctx, p } = await open(gift.token, gift.design, { sim: true });
  await p.evaluate(() => { const s = document.querySelector('.mds-section[data-sec="record"]'); if (!s.classList.contains('open')) s.querySelector('.mds-shead').click(); });
  await waitFor(p, () => !!document.querySelector('.qv-md-field .pro-chip.quiet'), null, 30000);
  check('the crown on the choice is quiet', await p.evaluate(() => !!document.querySelector('.qv-md-field .pro-chip.quiet')));
  await waitFor(p, () => !window.__tifoMatchDay.camTween, null, 20000);
  const before = await p.evaluate(() => { const c = window.__tifoMatchDay.camera; return [c.position.x, c.position.y, c.position.z, c.fov].map((v) => v.toFixed(3)).join(); });
  const land = await downloadFrom(p, () => p.click('.mds-bar .mds-btn:has-text("Record")'));
  check('Record makes the film with no sheet', /^tifo-matchday-film\.mp4$/.test(land.name), land.name);
  await checkFilm('matchday-landscape', land.buf, 1920, 1080);
  const after = await p.evaluate(() => { const c = window.__tifoMatchDay.camera; return [c.position.x, c.position.y, c.position.z, c.fov].map((v) => v.toFixed(3)).join(); });
  check('Match Day\'s camera is put back where it was', before === after, `${before} / ${after}`);
  check('…and its picture is its own size again', await p.evaluate(() => { const c = window.__tifoMatchDay.canvas; return Math.abs(c.width / c.height - c.clientWidth / c.clientHeight) < 0.02; }));
  await p.selectOption('[data-k="rec-film"]', 'vertical');
  const vert = await downloadFrom(p, () => p.click('.mds-bar .mds-btn:has-text("Record")'));
  await checkFilm('matchday-vertical', vert.buf, 1080, 1920);
  await ctx.close();
}

// =====================================================================
console.log('\n— a browser with no WebCodecs —');
{
  const { ctx, p } = await open(gift.token, gift.design, { noCodecs: true });
  // In real time the film runs on the clock: two seconds of it, whatever software GL manages to draw.
  await p.evaluate(() => { window.__tifoFilmFrames = 60; });
  await p.click('#rail-anim');
  await waitFor(p, () => !document.getElementById('sx-size-row')?.hidden, null, 30000);
  await p.selectOption('#sx-size', 'hd');
  const dlP = downloadFrom(p, () => p.click('#sx-export'));
  check('the card says it films in real time', await waitFor(p, () => /real time/.test(document.querySelector('.qv-note')?.textContent || ''), null, 120000));
  const rt = await dlP;
  check('…and a file still comes out, at the film\'s size', rt.buf.length > 0, `${rt.name} ${rt.buf.length}`);
  check('…and the status says how it was made', await waitFor(p, () => /filmed in real time/.test(document.getElementById('sx-status')?.textContent || ''), null, 10000), await p.textContent('#sx-status'));
  await ctx.close();
}

// =====================================================================
console.log('\n— not on the list —');
{
  const { ctx, p } = await open(other.token, other.design, { sim: true });
  await p.waitForTimeout(1500);
  check('Match Day has no Video choice', await p.evaluate(() => !document.querySelector('[data-k="rec-film"]')));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
