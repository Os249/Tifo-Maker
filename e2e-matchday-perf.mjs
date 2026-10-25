/**
 * Match Day draws only what it has to (performance plan P2.12 and P2.13).
 *
 * - A still Match Day draws no frames: once the opening glide has landed and
 *   nothing moves, the canvas is left alone. It wakes for what changes the
 *   picture — a drag of the camera (and stops again when the glide after it
 *   ends), a time-of-day change, a confetti burst (until it has landed), the
 *   flyover (for as long as it flies).
 * - Medium and Low draw at most 30 frames a second: no two frames closer
 *   than the cap allows.
 * - High has no MSAA under its post pass (its buffers have none, so MSAA on
 *   the screen smoothed nothing), and no tier draws at more than 1.5x pixels
 *   on a 2x screen.
 * - The fans walking in outside step on their own only when the camera can
 *   see them: from the drone, not from the gantry.
 * - Draw calls: each ground's building is merged, so a frame takes no more
 *   than its budget below — in Match Day and in the Stadium view.
 *
 * Frames are counted at the WebGL calls (a draw into Match Day's canvas),
 * not from the page's frame callbacks, which other things on the page ask for.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server),
 * or BASE=http://127.0.0.1:<port>.
 */
import { chromium } from 'playwright';

const B = process.env.BASE || 'http://127.0.0.1:8911';
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LS = [
  { name: 'tifo_lang_v1', value: 'en' },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v2', value: '1' }, { name: 'tifo_guide_v1', value: 'done' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
  { name: 'tifo_post_nudge_v1', value: '1' },
];

/** Count every draw into the Match Day canvas, and the time stamp of each frame that drew. */
const COUNT_DRAWS = () => {
  const md = new WeakMap();
  const isMd = (gl) => {
    let v = md.get(gl);
    if (v === undefined) md.set(gl, (v = !!gl.canvas?.closest?.('.mds-overlay')));
    return v;
  };
  window.__md = { draws: 0, tris: 0, frames: 0, stamps: [], inFrame: false, drewThisFrame: false };
  const P = WebGL2RenderingContext.prototype;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const f = P[name];
    P[name] = function (...a) {
      if (isMd(this)) {
        window.__md.draws++;
        const mode = a[0];
        const n = name.startsWith('drawElements') ? a[1] : a[2];
        const inst = name.endsWith('Instanced') ? a[name === 'drawElementsInstanced' ? 4 : 3] : 1;
        if (mode === 4) window.__md.tris += (n / 3) * inst;
        window.__md.drewThisFrame = true;
      }
      return f.apply(this, a);
    };
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    window.__md.drewThisFrame = false;
    cb(t);
    if (window.__md.drewThisFrame) {
      window.__md.frames++;
      window.__md.stamps.push(t);
      if (window.__md.stamps.length > 400) window.__md.stamps.shift();
    }
  });
};

async function sim({ template = 'alhazem-stadium-8k-rb', w = 480, h = 300, memory = 4, dpr = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => { const t = m.text(); if (/Shader Error|Program Info Log|WebGL: INVALID|could not be built/.test(t)) errs.push('GL: ' + t.slice(0, 160)); });
  // The probe's answer: 8 GB is High on a desktop, 4 GB Medium.
  await p.addInitScript((mem) => Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => mem }), memory);
  await p.addInitScript(COUNT_DRAWS);
  await p.addInitScript((tpl) => {
    try {
      if (sessionStorage.getItem('e2e_started')) return;
      sessionStorage.setItem('e2e_started', '1');
      sessionStorage.setItem('tifo_new_project', JSON.stringify({ title: 'Hoops', templateId: tpl, start: { kind: 'pattern', patternId: 'hoops', palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#16161a'] } }));
    } catch { /* */ }
  }, template);
  await p.goto(`${B}/app?new=1&template=${template}&e2e=1`, { waitUntil: 'networkidle', timeout: 240000 });
  await p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 240000 });
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await p.waitForSelector('.mds-overlay canvas', { timeout: 240000 });
  await p.waitForFunction(() => window.__md.frames >= 2, null, { timeout: 600000, polling: 500 });
  return { ctx, p, errs };
}
const frames = (p) => p.evaluate(() => window.__md.frames);
/** Wait until Match Day stops drawing by itself: no frame for `quiet` ms. */
async function still(p, quiet = 4000, limit = 240000) {
  const t0 = Date.now();
  let last = await frames(p);
  let since = Date.now();
  while (Date.now() - t0 < limit) {
    await sleep(500);
    const f = await frames(p);
    if (f !== last) { last = f; since = Date.now(); } else if (Date.now() - since >= quiet) return true;
  }
  return false;
}
const framesIn = async (p, ms) => { const a = await frames(p); await sleep(ms); return (await frames(p)) - a; };
const K = (k) => `.mds-overlay [data-k="${k}"]`;
// From inside the page: a section that is shut keeps its buttons out of sight.
const press = (p, k) => p.$eval(K(k), (b) => b.click());
const setSel = (p, k, v) => p.$eval(K(k), (s, v) => { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, v);

// ---------------------------------------------------------------------------
console.log('\n— a still Match Day draws nothing, and wakes for what changes —');
{
  const { ctx, p, errs } = await sim();
  check('the opening glide lands and the drawing stops by itself', await still(p));
  const idle = await framesIn(p, 5000);
  check('no frames in five still seconds', idle === 0, `${idle} frames`);
  // A drag across the view.
  const box = await p.$eval('.mds-overlay canvas', (c) => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const f0 = await frames(p);
  await p.mouse.move(box.x + box.w * 0.4, box.y + box.h * 0.5);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) { await p.mouse.move(box.x + box.w * (0.4 + i * 0.03), box.y + box.h * 0.5); await sleep(100); }
  await p.mouse.up();
  await sleep(1500);
  check('a drag of the camera draws', (await frames(p)) > f0, `${(await frames(p)) - f0} frames`);
  check('and the glide after it ends by itself', await still(p, 4000, 300000));
  // Time of day.
  const t0 = await frames(p);
  const before = await p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png').length);
  await setSel(p, 'tod', 'night');
  await p.waitForFunction((f) => window.__md.frames > f, t0, { timeout: 60000, polling: 250 }).catch(() => {});
  check('a time-of-day change draws a frame', (await frames(p)) > t0);
  const after = await p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/png').length);
  check('and the picture is the night one', after !== before, `${before} -> ${after} bytes`);
  check('then it is still again', await still(p));
  // Confetti: frames while it falls, none once it has landed.
  const c0 = await frames(p);
  await press(p, 'acc-cannon');
  await sleep(6000);
  const during = (await frames(p)) - c0;
  check('confetti keeps it drawing while it falls', during >= 2, `${during} frames in 6 s`);
  check('and once it has landed, nothing', await still(p, 4000, 300000));
  // The flyover.
  await press(p, 'flyover');
  await sleep(1500);
  const fly = await framesIn(p, 6000);
  check('the flyover draws for as long as it flies', fly >= 2, `${fly} frames in 6 s`);
  // Medium: never two frames closer than the 30-a-second cap allows.
  const gaps = await p.evaluate(() => { const s = window.__md.stamps; return s.slice(1).map((t, i) => t - s[i]); });
  const minGap = Math.min(...gaps.slice(-30));
  check('Medium draws at most 30 frames a second', minGap >= 26, `closest frames ${minGap.toFixed(1)} ms apart`);
  await press(p, 'flyover');
  // It stops wherever the flight was: often high over the rim, where the fans
  // walking in outside are in view and step ten times a second (below).
  await sleep(3000);
  const afterFly = await framesIn(p, 5000);
  check('the flyover off, it no longer draws every frame', afterFly <= 5 * 10 + 2, `${afterFly} frames in 5 s`);
  // The drone: high above the rim, the fans walking in outside are in view
  // and step ten times a second; back on the gantry they are hidden.
  const shots = await p.$$eval(K('camera') + ' option', (o) => o.map((x) => x.textContent));
  const drone = shots.findIndex((s) => /drone/i.test(s));
  await setSel(p, 'camera', String(drone));
  await sleep(4000);
  const walk = await framesIn(p, 5000);
  check('from the drone the fans walking in keep moving', walk >= 1, `${walk} frames in 5 s`);
  check('at no more than ten steps a second', walk <= 5 * 10 + 2, `${walk} frames in 5 s`);
  await setSel(p, 'camera', '0');
  await sleep(4000);
  check('back on the gantry, where the stands hide them, it is still', await still(p, 4000, 300000));
  check('no page or GL errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— High: no MSAA under the post pass; 1.5x pixels at most —');
{
  const { ctx, p, errs } = await sim({ memory: 8, dpr: 2 });
  const r = await p.evaluate(() => {
    const c = document.querySelector('.mds-overlay canvas');
    const gl = c.getContext('webgl2');
    return { aa: gl.getContextAttributes().antialias, ratio: c.width / c.clientWidth, tier: document.querySelector('.mds-bar select, .mds-panel-acts select')?.value, glow: !document.querySelector('[data-k="glow"]').disabled };
  });
  check('it opens on High (the post pass is there: Glow is live)', r.tier === 'high' && r.glow, JSON.stringify(r));
  check('the screen buffer has no MSAA', r.aa === false);
  check('a 2x screen gets at most 1.5x pixels', r.ratio <= 1.5 + 1e-6, `${r.ratio.toFixed(3)}x`);
  check('no page or GL errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, p } = await sim({ memory: 4, dpr: 2 });
  const r = await p.evaluate(() => {
    const c = document.querySelector('.mds-overlay canvas');
    return { aa: c.getContext('webgl2').getContextAttributes().antialias, ratio: c.width / c.clientWidth, tier: document.querySelector('.mds-bar select, .mds-panel-acts select')?.value };
  });
  check('Medium keeps its MSAA (it has no post pass)', r.tier === 'medium' && r.aa === true, JSON.stringify(r));
  check('and 1.5x pixels at most', r.ratio <= 1.5 + 1e-6, `${r.ratio.toFixed(3)}x`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Draw calls per frame, Medium, at the opening camera. Budgets a little over
// what the merged buildings take (performance plan P2.13), well under what
// they took before (in brackets).
const BUDGET = {
  'alhazem-stadium-8k-rb': 85, // (99)
  'kingdom-arena-26k-rb': 110, // (198)
  'jewel-jeddah-60k-rb': 110, // (146)
};
console.log('\n— draw calls, Match Day (Medium) —');
for (const [id, budget] of Object.entries(BUDGET)) {
  let o;
  try {
    o = await sim({ template: id, w: 640, h: 400 });
  } catch (e) {
    check(`${id}: Match Day opens`, false, String(e).slice(0, 160));
    continue;
  }
  const { ctx, p, errs } = o;
  // The neighbourhood arrives on its own: wait for the frame it lands in.
  await still(p, 6000, 400000);
  const r = await p.evaluate(async () => {
    const s = window.__tifoMatchDay;
    const a = { d: window.__md.draws, t: window.__md.tris, f: window.__md.frames };
    for (let i = 0; i < 3; i++) {
      const f = window.__md.frames;
      s.requestRender();
      while (window.__md.frames === f) await new Promise((r) => setTimeout(r, 100));
    }
    const n = window.__md.frames - a.f;
    return { draws: Math.round((window.__md.draws - a.d) / n), tris: Math.round((window.__md.tris - a.t) / n), census: s.sceneCensus() };
  });
  check(`${id}: at most ${budget} draw calls a frame`, r.draws <= budget, `${r.draws} calls, ${r.tris} triangles`);
  check(`${id}: every lamp and mesh still in the scene`, r.census.meshes > 20 && r.census.spotLights > 0, JSON.stringify(r.census));
  check(`${id}: no page or GL errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// The Stadium view, Low, from the Full view preset (the whole bowl, where
// the far armchairs take over): the merged shell's budget, and the premium
// chairs in their 22-triangle form.
const SV_BUDGET = {
  'jewel-jeddah-60k-rb': 80, // (123)
  'kingdom-arena-26k-rb': 70, // (110)
};
console.log('\n— draw calls, Stadium view (Low, Full view) —');
for (const [id, budget] of Object.entries(SV_BUDGET)) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => { const t = m.text(); if (/Shader Error|Program Info Log|WebGL: INVALID|could not be built/.test(t)) errs.push('GL: ' + t.slice(0, 160)); });
  await p.addInitScript((tpl) => {
    try {
      if (sessionStorage.getItem('e2e_started')) return;
      sessionStorage.setItem('e2e_started', '1');
      sessionStorage.setItem('tifo_new_project', JSON.stringify({ title: 'Hoops', templateId: tpl, start: { kind: 'pattern', patternId: 'hoops', palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#16161a'] } }));
    } catch { /* */ }
  }, id);
  try {
    await p.goto(`${B}/app?new=1&template=${id}&quality=low&e2e=1`, { waitUntil: 'networkidle', timeout: 240000 });
    await p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 240000 });
    const opened = await p.waitForFunction(() => document.getElementById('view-3d')?.classList.contains('active'), null, { timeout: 30000 }).then(() => true, () => false);
    if (!opened) await p.click('#view-3d');
    await p.waitForFunction(() => !!window.__tifoPreview, null, { timeout: 120000 });
    await p.evaluate(() => window.__tifoPreview.ready);
    const r = await p.evaluate(() => {
      const v = window.__tifoPreview;
      v.applyPreset(v.presets().find((x) => x.name === 'Full view'));
      const c = v.census();
      return { draws: c.drawCalls, tris: c.triangles, shell: c.shell };
    });
    check(`${id}: at most ${budget} draw calls from the Full view`, r.draws <= budget, `${r.draws} calls, ${r.tris} triangles; shell ${r.shell.meshesBefore} -> ${r.shell.meshesAfter} meshes`);
  } catch (e) {
    check(`${id}: the Stadium view opens`, false, String(e).slice(0, 160));
  }
  check(`${id}: no page or GL errors (Stadium view)`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
