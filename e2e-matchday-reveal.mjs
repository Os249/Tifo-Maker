/**
 * The card reveal is drawn by the GPU (performance plan P3.2), in the Stadium
 * view and in Match Day.
 *
 * - A frame of a reveal is the frame the CPU drew at the same instant: every
 *   reveal style, scrubbed to fixed points in each of its phases (before, along
 *   the wave, the drum call's count, lift, hold and drop, the end), drawn both
 *   ways from a fixed camera and compared pixel by pixel. They may differ by
 *   one colour level on a handful of pixels (float32 against float64 for a card
 *   exactly on a rounding edge), no more.
 * - A frame of a reveal sends nothing to the GPU but a few uniforms: no seat
 *   colours, no card states. The seats' numbers go once per reveal style.
 * - The reveal asks for frames while it plays and none once it has ended or
 *   been stopped; the design is back exactly as it was.
 * - Match Day: every mode (the wipes, centre out, sparkle, the drum call with
 *   its options, the design settling back after one), the same comparison, and
 *   the same silence when nothing plays.
 * - The stadium export (GIF) still exports, and sends the seats' numbers once,
 *   not once a frame.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server),
 * or BASE=http://127.0.0.1:<port>.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

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
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v2', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
  { name: 'tifo_post_nudge_v1', value: '1' },
];

/** Bytes sent to the GPU, per canvas kind: buffers and textures, at the WebGL calls. */
const COUNT_UPLOADS = () => {
  // Decided once the canvas is in the page (a renderer makes its first calls before it is).
  const kind = new WeakMap();
  const kindOf = (gl) => {
    let k = kind.get(gl);
    if (k === undefined) {
      const c = gl.canvas;
      k = c?.closest?.('.mds-overlay') ? 'md' : c?.closest?.('#preview-host') ? 'sv' : 'other';
      if (c?.isConnected) kind.set(gl, k);
    }
    return k;
  };
  const up = (window.__up = { md: 0, sv: 0, other: 0, mdDraws: 0, svDraws: 0 });
  const P = WebGL2RenderingContext.prototype;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const f = P[name];
    P[name] = function (...a) {
      try {
        const k = kindOf(this);
        if (k === 'md') up.mdDraws++;
        if (k === 'sv') up.svDraws++;
      } catch { /* never break the page */ }
      return f.apply(this, a);
    };
  }
  const size = (v) => (v && typeof v === 'object' && 'byteLength' in v ? v.byteLength : typeof v === 'number' ? v : 0);
  const wrap = (name, bytes) => {
    const f = P[name];
    P[name] = function (...a) {
      try {
        up[kindOf(this)] += bytes(a);
      } catch { /* never break the page */ }
      return f.apply(this, a);
    };
  };
  wrap('bufferData', (a) => size(a[1]));
  wrap('bufferSubData', (a) => (a.length >= 5 && a[4] ? a[4] * (a[2]?.BYTES_PER_ELEMENT || 1) : size(a[2])));
  wrap('texImage2D', (a) => (a.length >= 9 ? a[3] * a[4] * 4 : (a[5]?.width || 0) * (a[5]?.height || 0) * 4));
  wrap('texSubImage2D', (a) => (a.length >= 9 ? a[4] * a[5] * 4 : (a[6]?.width || 0) * (a[6]?.height || 0) * 4));
  wrap('texImage3D', (a) => a[3] * a[4] * a[5] * 4);
};

/** Pixel comparison of two PNG data URLs: how many pixels differ, and by how much at most. */
function diff(a, b) {
  const A = PNG.sync.read(Buffer.from(a.split(',')[1], 'base64'));
  const Bp = PNG.sync.read(Buffer.from(b.split(',')[1], 'base64'));
  if (A.width !== Bp.width || A.height !== Bp.height) return { px: -1, max: 999, total: 0 };
  let px = 0, max = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const m = Math.max(Math.abs(A.data[i] - Bp.data[i]), Math.abs(A.data[i + 1] - Bp.data[i + 1]), Math.abs(A.data[i + 2] - Bp.data[i + 2]));
    if (m > 0) px++;
    if (m > max) max = m;
  }
  return { px, max, total: A.data.length / 4 };
}
/** Within float32-versus-float64 rounding: at most one level, on at most 1 pixel in 2,000. */
const sameAsCpu = (d) => d.px >= 0 && d.max <= 1 && d.px <= d.total / 2000;

async function editor(template, { w = 960, h = 600, quality = 'low' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => { const t = m.text(); if (/Shader Error|Program Info Log|WebGL: INVALID|could not be built/.test(t)) errs.push('GL: ' + t.slice(0, 160)); });
  await p.addInitScript(COUNT_UPLOADS);
  // A blank start (no reveal plays by itself), painted with three-colour hoops once the editor is up.
  await p.addInitScript((tpl) => {
    try {
      if (sessionStorage.getItem('e2e_started')) return;
      sessionStorage.setItem('e2e_started', '1');
      sessionStorage.setItem('tifo_new_project', JSON.stringify({ title: 'Reveal', templateId: tpl, start: { kind: 'blank', palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#d81e3a'] } }));
    } catch { /* */ }
  }, template);
  await p.goto(`${B}/app?new=1&template=${template}&e2e=1&quality=${quality}`, { waitUntil: 'networkidle', timeout: 240000 });
  await p.waitForFunction(() => !!window.__tifo?.store && /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 240000 });
  await p.evaluate(() => {
    const { store, map } = window.__tifo;
    const c = new Uint8Array(map.count);
    for (let i = 0; i < map.count; i++) c[i] = 1 + ((map.rowOf[i] >> 2) % 3);
    store.loadCells(c);
  });
  return { ctx, p, errs };
}

// ---------------------------------------------------------------------------
console.log('\n— the Stadium view: a reveal frame is the CPU\'s frame —');
for (const G of (process.env.GROUNDS || 'jewel-jeddah-60k-rb,alhazem-stadium-8k-rb').split(',')) {
  const { ctx, p, errs } = await editor(G);
  await p.evaluate(() => document.getElementById('view-3d').click());
  await p.waitForFunction(() => !!window.__tifoPreview, null, { timeout: 240000 });
  await p.evaluate(() => window.__tifoPreview.ready);
  await sleep(800);
  const setStyle = (st, dur) => p.evaluate(([st, dur]) => {
    const sel = document.getElementById('reveal-preset');
    sel.value = st;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const d = document.getElementById('reveal-dur');
    d.value = String(dur);
    d.dispatchEvent(new Event('input', { bubbles: true }));
  }, [st, dur]);
  /** Scrub to `c` percent and draw it on the GPU, then (unless asked not to) the same instant on the CPU. */
  const shot = (c, preset = 'Full view', withCpu = true) => p.evaluate(([c, preset, withCpu]) => {
    const v = window.__tifoPreview;
    v.applyPreset(v.presets().find((x) => x.name === preset));
    const s = document.getElementById('reveal-scrub');
    s.value = String(c);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    v.renderOnce();
    const gpu = v.renderer.domElement.toDataURL('image/png');
    const mode = v.census().revealMode;
    let cpu = null;
    if (withCpu && v.lastRevealFrame && mode !== 0) {
      v.showReveal(v.lastRevealFrame, { cpu: true });
      v.renderOnce();
      cpu = v.renderer.domElement.toDataURL('image/png');
      v.showReveal(v.lastRevealFrame);
    }
    return { gpu, cpu, mode };
  }, [c, preset, withCpu]);
  const design = await p.evaluate(() => { const v = window.__tifoPreview; v.applyPreset(v.presets().find((x) => x.name === 'Full view')); v.renderOnce(); return v.renderer.domElement.toDataURL('image/png'); });
  const cases = [['sweep-rl', 4, [5, 30, 60, 90]], ['random', 4, [20, 70]], ['rows', 4, [40]], ['drum-call', 9, [20, 25, 27, 50, 89, 92, 97]]];
  for (const [st, dur, clocks] of cases) {
    await setStyle(st, dur);
    let worst = null;
    let modes = 0;
    let shows = 0;
    for (const c of clocks) {
      const s = await shot(c);
      if (s.mode !== 0) modes++;
      if (diff(s.gpu, design).px > 500) shows++;
      if (!s.cpu) continue;
      const d = diff(s.gpu, s.cpu);
      if (!worst || d.px > worst.px || d.max > worst.max) worst = { ...d, at: c };
    }
    check(`${G}: ${st} is drawn on the GPU at every point (${clocks.join(', ')} %)`, modes === clocks.length, `${modes} of ${clocks.length}`);
    check(`${G}: ${st} matches the CPU's frame`, !!worst && sameAsCpu(worst), JSON.stringify(worst));
    check(`${G}: ${st} shows on screen (its frames are not the design's)`, shows >= Math.ceil(clocks.length / 2), `${shows} of ${clocks.length}`);
  }
  // Nothing but uniforms between two instants of one style.
  await setStyle('sweep-rl', 4);
  await shot(10, 'Full view', false);
  const u0 = await p.evaluate(() => window.__up.sv);
  for (const c of [20, 35, 50, 65]) await shot(c, 'Full view', false);
  const u1 = await p.evaluate(() => window.__up.sv);
  check(`${G}: four reveal frames send no bytes to the GPU`, u1 - u0 === 0, `${u1 - u0} bytes`);
  // A second style sends its delays once (16 bytes a seat, at most), not a frame's worth of colours each frame.
  const seats = await p.evaluate(() => window.__tifo.map.count);
  const u2 = await p.evaluate(() => window.__up.sv);
  await setStyle('random', 4);
  for (const c of [15, 45, 75]) await shot(c, 'Full view', false);
  const u3 = await p.evaluate(() => window.__up.sv);
  // (Counted at 4 bytes a texel here; the texture is RGBA float, 16 bytes a seat, sent once.)
  check(`${G}: a new style sends its seats' numbers once`, u3 - u2 > 0 && u3 - u2 <= seats * 16 + 65536, `${u3 - u2} bytes counted for ${seats} seats`);
  // Play it: frames while it plays, none once it has ended; the design comes back exactly.
  await p.evaluate(() => document.getElementById('reveal-reset').click());
  await setStyle('sweep-rl', 4);
  await sleep(1500);
  const f0 = await p.evaluate(() => window.__tifoPreview.census().frames);
  await p.evaluate(() => document.getElementById('reveal-play').click());
  await p.waitForFunction(() => Number(document.getElementById('reveal-scrub').value) >= 100, null, { timeout: 120000 });
  // The last frame (the design back) is asked for as it ends; software GL can take more than a
  // second to give it (Jewel's Full view), so settled is: the same count a second apart, and no
  // frame asked for and not yet drawn (the view's own requestAnimationFrame handle).
  let f1 = -1;
  for (let k = 0; k < 40; k++) {
    const s = await p.evaluate(() => ({ f: window.__tifoPreview.census().frames, asked: !!window.__tifoPreview.raf }));
    if (s.f === f1 && !s.asked) break;
    f1 = s.f;
    await sleep(1000);
  }
  await sleep(1500);
  const after = await p.evaluate(() => ({ ...window.__tifoPreview.census(), asked: !!window.__tifoPreview.raf }));
  check(`${G}: the reveal draws frames while it plays`, f1 - f0 >= 2, `${f1 - f0} frames`);
  check(`${G}: and none once it has ended`, after.frames === f1 && !after.asked, `${after.frames - f1} frames in 1.5 s${after.asked ? ', one asked for' : ''}`);
  check(`${G}: the design is back, off the GPU reveal`, after.revealMode === 0, String(after.revealMode));
  const back = await p.evaluate(() => { const v = window.__tifoPreview; v.applyPreset(v.presets().find((x) => x.name === 'Full view')); v.renderOnce(); return v.renderer.domElement.toDataURL('image/png'); });
  const db = diff(design, back);
  check(`${G}: pixel for pixel`, db.px === 0, JSON.stringify(db));
  // Stopped half way: the design, at once.
  await setStyle('drum-call', 9);
  await shot(50);
  await p.evaluate(() => document.getElementById('reveal-reset').click());
  const reset = await p.evaluate(() => { const v = window.__tifoPreview; v.renderOnce(); return { mode: v.census().revealMode, url: v.renderer.domElement.toDataURL('image/png') }; });
  check(`${G}: Reset mid-call puts the design back`, reset.mode === 0 && diff(design, reset.url).px === 0, String(reset.mode));
  check(`${G}: no page or WebGL errors`, errs.length === 0, errs.join(' | '));
  if (G.startsWith('alhazem')) {
    // The export: a GIF of the sweep, its seats' numbers sent once.
    await p.evaluate(() => {
      const sel = document.getElementById('reveal-preset');
      sel.value = 'sweep-lr';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const f = document.getElementById('sx-format');
      f.value = 'gif';
      f.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const g0 = await p.evaluate(() => window.__up.sv);
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), p.evaluate(() => document.getElementById('sx-export').click())]);
    const buf = Buffer.concat(await (await dl.createReadStream()).toArray());
    const g1 = await p.evaluate(() => window.__up.sv);
    check('the stadium GIF exports', buf.slice(0, 3).toString() === 'GIF' && buf.length > 2000, `${(buf.length / 1024).toFixed(0)} KB`);
    check('…sending the seats\' numbers once, not a frame\'s worth each frame', g1 - g0 <= seats * 16 + 262144, `${g1 - g0} bytes for ${seats} seats over the whole export`);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Match Day: every mode, the CPU\'s frame, on the GPU —');
{
  const G = process.env.MD_GROUND || 'alhazem-stadium-8k-rb';
  const { ctx, p, errs } = await editor(G, { w: 640, h: 400 });
  // The page clock stands still from here: the scene clock with it, so a reveal held at a point stays there.
  await p.evaluate(() => { window.__t = performance.now(); performance.now = () => window.__t; });
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await p.waitForSelector('.mds-overlay canvas', { timeout: 240000 });
  await p.waitForFunction(() => !!window.__tifoMatchDay, null, { timeout: 240000 });
  const frames = () => p.evaluate(() => window.__up.mdDraws);
  /** Draw a frame now and read it. */
  const draw = () => p.evaluate(async () => {
    const sim = window.__tifoMatchDay;
    const n = window.__up.mdDraws;
    for (let k = 0; k < 400 && window.__up.mdDraws === n; k++) { sim.requestRender(); await new Promise((r) => setTimeout(r, 25)); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector('.mds-overlay canvas').toDataURL('image/png');
  });
  await draw();
  await sleep(3000);
  const design = await draw();
  const cases = [
    ['wipe-lr', 0.3], ['wipe-lr', 0.62], ['wipe-up', 0.5], ['center-out', 0.35], ['center-out', 0.7], ['sparkle', 0.4],
    ['drum-call', 2.3 / 8.09], ['drum-call', 2.45 / 8.09], ['drum-call', 4.5 / 8.09], ['drum-call', 7.15 / 8.09],
  ];
  let shown = 0;
  for (const [mode, at] of cases) {
    await p.evaluate(([m, a]) => window.__tifoMatchDay.showRevealAt(m, a), [mode, at]);
    const gpu = await draw();
    if (diff(gpu, design).px > 500) shown++;
    await p.evaluate(([m, a]) => window.__tifoMatchDay.showRevealAt(m, a, undefined, true), [mode, at]);
    const cpu = await draw();
    const d = diff(gpu, cpu);
    check(`${mode} at ${at.toFixed(2)}: the GPU frame is the CPU's`, sameAsCpu(d), JSON.stringify(d));
  }
  // (Not all of them: from this camera a wipe well along can already show all it sees as the design.)
  check('the reveals show on screen (their frames are not the design\'s)', shown >= cases.length / 2, `${shown} of ${cases.length}`);
  // The drum call with its options: two cycles, a two-second hold, through its own plan.
  for (const t of [2.4, 6.15, 10.3]) {
    await p.evaluate((t) => { const s = window.__tifoMatchDay; s.setDrumCall({ hold: 2, times: 2 }); const plan = s.drumCallPlan(); s.showRevealAt('drum-call', t / plan.duration, plan); window.__plan = plan; }, t);
    const gpu = await draw();
    await p.evaluate((t) => { const s = window.__tifoMatchDay; s.showRevealAt('drum-call', t / window.__plan.duration, window.__plan, true); }, t);
    const cpu = await draw();
    const d = diff(gpu, cpu);
    check(`a two-cycle drum call at ${t} s: the GPU frame is the CPU's`, sameAsCpu(d), JSON.stringify(d));
  }
  await p.evaluate(() => window.__tifoMatchDay.setDrumCall({ hold: 4, times: 1 }));
  // The design settling back after a drum call: one value for every seat.
  for (const a of [0.25, 0.7]) {
    await p.evaluate((a) => window.__tifoMatchDay.showRevealAll(a), a);
    const gpu = await draw();
    await p.evaluate((a) => window.__tifoMatchDay.applyReveal(() => a), a);
    const cpu = await draw();
    const d = diff(gpu, cpu);
    check(`settling back at ${a}: the GPU frame is the CPU's`, sameAsCpu(d), JSON.stringify(d));
  }
  // A reveal frame sends no seat colours: compare what four frames send with and without a reveal on.
  await p.evaluate(() => window.__tifoMatchDay.showRevealAt('wipe-lr', 0.2));
  await draw();
  const b0 = await p.evaluate(() => window.__up.md);
  for (const a of [0.3, 0.4, 0.5, 0.6]) {
    await p.evaluate((a) => window.__tifoMatchDay.showRevealAt('wipe-lr', a), a);
    await draw();
  }
  const b1 = await p.evaluate(() => window.__up.md);
  await p.evaluate(() => window.__tifoMatchDay.applyReveal(null));
  await draw();
  const b2 = await p.evaluate(() => window.__up.md);
  for (let k = 0; k < 4; k++) await draw();
  const b3 = await p.evaluate(() => window.__up.md);
  const seats = await p.evaluate(() => window.__tifo.map.count);
  check('four reveal frames send no more than four still frames', b1 - b0 <= b3 - b2, `${b1 - b0} bytes against ${b3 - b2}`);
  check('…and nothing like the seats\' colours (12 bytes a seat)', b1 - b0 < seats * 12, `${b1 - b0} bytes for ${seats} seats`);
  const off = await draw();
  check('the reveal off: the design exactly', diff(design, off).px === 0, JSON.stringify(diff(design, off)));
  // Played for real (the clock running again): frames while it plays, then none.
  await p.evaluate(() => { const real = Object.getPrototypeOf(performance).now.bind(performance); performance.now = real; });
  // The clock running again lets the opening glide land first: wait for a still view.
  for (let k = 0, last = -1, same = 0; k < 120 && same < 3; k++) {
    const f = await frames();
    same = f === last ? same + 1 : 0;
    last = f;
    await sleep(1000);
  }
  await p.evaluate(() => window.__tifoMatchDay.playReveal('wipe-lr', 2000));
  const q0 = await frames();
  await sleep(2000);
  const q1 = await frames();
  await sleep(1500);
  const q1b = await frames();
  await sleep(2500);
  const q2 = await frames();
  check('Play reveal draws while it plays', q1 > q0, `${q1 - q0} draw calls`);
  check('…and the drawing stops when it is over', q2 - q1b === 0, `${q2 - q1b} draw calls in 2.5 s, a moment after it ended`);
  // Stopped mid drum call: the design back, the uniforms off.
  await p.evaluate(() => window.__tifoMatchDay.playReveal('drum-call'));
  await sleep(1500);
  await p.evaluate(() => window.__tifoMatchDay.stopTimeline());
  const mode = await p.evaluate(() => window.__tifoMatchDay.revealU.tifoRevealMode.value);
  check('Stop mid drum call: the design back', mode === 0, String(mode));
  check('no page or WebGL errors in Match Day', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
