/**
 * Seeing the tifo: the stadium's controls, and the cameras that look at it.
 *
 *   npm run test:stage-camera      (needs `npm run build` first: it serves dist/)
 *
 * A fan's report, 30 Oct 2026, with a tifo behind one goal:
 *
 *   1. In Split, the camera bar sat over the top of the stadium, which is
 *      where the far stand is, so the tifo on it could not be seen, and there
 *      was no way to move the bar or hide it.
 *   2. In Match Day, the show opened on the TV gantry, which looks across at
 *      the other side of the ground (the tifo's middle sat just off the edge
 *      of the picture for the whole reveal), and every cut went to a fixed
 *      place. Moving the camera to the tifo lasted until the next cut.
 *
 * Now: the bar sits in the stadium's corner and an eye (or H) clears the
 * stadium; the layer bar stays in the strip; the camera menu has "Your tifo";
 * Match Day opens on the tifo, the show's cuts are on it, a hand on the camera
 * ends the cuts for that show, and "Stay where I put it" never cuts at all.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8924;
const B = `http://127.0.0.1:${PORT}`;
const GROUND = 'jewel-jeddah-60k-rb';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', ADMIN_USERNAMES: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up on ' + B + '\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }));
const errs = [];
const BASE_LS = [
  ['tifo_consent_v1', 'essential'], ['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v2', '1'], ['tifo_guide_v1', 'done'],
  ['tifo_banner_tour_v1', '1'], ['tifo_draw_hint_v1', '1'], ['tifo_post_nudge_v1', '1'], ['mds_seen_intro', '1'], ['mds_help_seen_v1', '1'],
  ['mds_sound_v2', JSON.stringify({ on: false })], ['tifo_view_v1', 'split'],
];
const open = async (lang = 'en', ls = [], viewport = { width: 1600, height: 760 }) => {
  const ctx = await browser.newContext({ viewport, locale: lang === 'ar' ? 'ar-SA' : 'en-US' });
  await ctx.addInitScript((pairs) => {
    // Only on the first load: a reload must see what the page itself stored.
    try { if (sessionStorage.getItem('e2e_sc')) return; sessionStorage.setItem('e2e_sc', '1'); for (const [k, v] of pairs) localStorage.setItem(k, v); } catch { /* */ }
  }, [...BASE_LS, ['tifo_lang_v1', lang], ...ls]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return { ctx, p };
};
const until = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const editorReady = (p) => until(p, () => !!window.__tifo && /\d/.test(document.getElementById('stat')?.textContent || ''), null, 120000);
/** Paint the middle of one stand (0 east, 1 north, 2 west, 3 south) in two colours, and nothing else. */
const paintStand = (p, stand) => p.evaluate((stand) => {
  const { store, map } = window.__tifo;
  const cells = new Uint8Array(map.count);
  let x = 0, y = 0, z = 0, n = 0;
  for (let i = 0; i < map.count; i++) {
    const uu = map.uv[i * 2];
    const s = Math.floor(((uu + 0.125) % 1) * 4);
    if (s !== stand) continue;
    const across = ((uu + 0.125) % 1) * 4 - s;
    if (across < 0.2 || across > 0.8) continue;
    const v = map.uv[i * 2 + 1];
    cells[i] = (v > 0.35 && v < 0.65) || (across > 0.44 && across < 0.56) ? 2 : 1;
    x += map.pos3[i * 3]; y += map.pos3[i * 3 + 1]; z += map.pos3[i * 3 + 2]; n++;
  }
  store.loadCells(cells);
  return [x / n, y / n, z / n];
}, stand);
/** Where a world point lands in a camera's picture: NDC x, y, and whether it is in front. */
const projectIn = (p, which, point) => p.evaluate(([which, v]) => {
  const cam = which === 'md' ? window.__tifoMatchDay.camera : window.__tifoPreview.camera;
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const e = cam.matrixWorldInverse.elements, pr = cam.projectionMatrix.elements;
  const vx = e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12];
  const vy = e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13];
  const vz = e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14];
  const w = -vz;
  return { x: (pr[0] * vx + pr[8] * vz) / w, y: (pr[5] * vy + pr[9] * vz) / w, front: w > 0 };
}, [which, point]);
const inFrame = (q) => q.front && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1;
const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } : null; }, sel);

// ===========================================================================
for (const lang of ['en', 'ar']) {
  console.log(`\n— the stadium's controls in Split (${lang === 'ar' ? 'Arabic' : 'English'}) —`);
  const { ctx, p } = await open(lang);
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?new=1&template=${GROUND}&e2e`, { waitUntil: 'domcontentloaded' });
  check('the editor is up', await editorReady(p));
  await until(p, () => document.getElementById('view-split')?.classList.contains('active'), null, 30000);
  await until(p, () => !document.getElementById('cam-bar')?.hidden, null, 30000);
  await p.waitForTimeout(1200);
  const pv = await box(p, '#preview-host');
  const bar = await box(p, '#cam-bar');
  const rtl = lang === 'ar';
  check('the camera bar sits in the stadium\'s top corner, at its start', !!pv && !!bar && bar.t - pv.t <= 16 && (rtl ? pv.r - bar.r <= 16 : bar.l - pv.l <= 16), JSON.stringify({ pv, bar }));
  check('…and not over the middle of the stadium', !!pv && !!bar && (rtl ? bar.l > pv.l + pv.w / 2 : bar.r < pv.l + pv.w / 2), JSON.stringify(bar));
  check('…on one line', !!bar && bar.h <= 56, String(bar?.h));
  const eye = await p.evaluate(() => { const b = document.getElementById('cam-hide'); return { label: b?.getAttribute('aria-label'), title: b?.title }; });
  check('it has an eye that says what it does', rtl ? /أخفِ الأدوات/.test(eye.label) : /Hide the controls on the stadium/.test(eye.label), JSON.stringify(eye));
  check('…with H in its tooltip', /\(H\)/.test(eye.title || ''), eye.title);

  await p.click('#cam-hide');
  await p.waitForTimeout(300);
  let s = await p.evaluate(() => ({
    clean: document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'),
    tools: !!document.querySelector('#cam-bar .cam-tools')?.getBoundingClientRect().width,
    ai: !!document.getElementById('ai-bar')?.getBoundingClientRect().width,
    eye: document.getElementById('cam-hide')?.getBoundingClientRect().width,
    label: document.getElementById('cam-hide')?.getAttribute('aria-label'),
    kept: localStorage.getItem('tifo_stage_clean_v1'),
  }));
  check('the eye clears the camera controls and the AI bar off the stadium', s.clean && !s.tools && !s.ai, JSON.stringify(s));
  check('…and stays, small, to bring them back', s.eye >= 24 && (rtl ? /رجّع الأدوات/.test(s.label) : /Show the controls/.test(s.label)), JSON.stringify(s));
  check('…and the browser keeps it', s.kept === '1');
  // Opened again (the editor takes ?e2e out of the address, so it goes back in).
  const again = new URL(p.url());
  again.searchParams.set('e2e', '1');
  await p.goto(again.toString(), { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  // A project opened again opens in Design; the stadium is a click away.
  if (!(await p.evaluate(() => document.getElementById('view-split')?.classList.contains('active')))) await p.click('#view-split');
  await until(p, () => !document.getElementById('cam-bar')?.hidden, null, 30000);
  check('after a reload the stadium is still clear', await until(p, () => document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'), null, 10000));
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press('h');
  check('H brings the controls back', await until(p, () => !document.querySelector('.canvas-wrap')?.classList.contains('stage-clean') && !!document.querySelector('#cam-bar .cam-tools')?.getBoundingClientRect().width, null, 5000));
  await p.keyboard.press('h');
  check('…and H clears them again', await until(p, () => document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'), null, 5000));
  await p.keyboard.press('h');
  // H typed into a field is a letter, not a shortcut.
  await p.focus('#ai-bar-input');
  await p.keyboard.press('h');
  check('H typed in the AI bar is a letter', (await p.inputValue('#ai-bar-input')) === 'h' && !(await p.evaluate(() => document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'))));
  await p.fill('#ai-bar-input', '');
  // Design view: no stadium, nothing to clear, and the AI bar is back on the canvas.
  await p.click('#cam-hide');
  await p.click('#view-2d');
  await p.waitForTimeout(600);
  s = await p.evaluate(() => ({ clean: document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'), bar: document.getElementById('cam-bar')?.hidden, ai: !!document.getElementById('ai-bar')?.getBoundingClientRect().width }));
  check('in Design the camera bar goes, and the stadium setting does not hide the AI bar', !s.clean && s.bar && s.ai, JSON.stringify(s));
  await p.keyboard.press('h');
  check('…and H does nothing there', !(await p.evaluate(() => document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'))));
  await p.click('#view-split');
  check('back in Split it is clear again, as it was left', await until(p, () => document.querySelector('.canvas-wrap')?.classList.contains('stage-clean'), null, 10000));
  await p.click('#cam-hide');

  if (lang === 'en') {
    console.log('\n— the layer bar stays in the strip —');
    await p.evaluate(() => {
      const { objects, map } = window.__tifo;
      const bx = map.bounds;
      objects.addShape({ shape: 'rect', cx: (bx.minX + bx.maxX) / 2, cy: bx.minY + (bx.maxY - bx.minY) * 0.1, width: (bx.maxX - bx.minX) * 0.06, height: (bx.maxY - bx.minY) * 0.14, rotation: 0, colorIndex: 1, tier: null });
    });
    await p.keyboard.press('v');
    await until(p, () => !document.querySelector('.ly-actionbar')?.hidden, null, 10000);
    await p.waitForTimeout(400);
    const ab = await box(p, '.ly-actionbar');
    const strip = await box(p, '#canvas-host');
    check('a layer at the top of the strip gets its bar inside the strip, not on the stadium', !!ab && !!strip && ab.t >= strip.t && ab.b <= strip.b, JSON.stringify({ ab, strip }));
    await p.keyboard.press('Escape');

    console.log('\n— "Your tifo" in the stadium\'s camera menu —');
    // The layer goes (it is on the seats too), and the paint.
    await p.evaluate(() => { const { objects } = window.__tifo; for (const o of [...objects.list()]) objects.remove(o.id); });
    await p.evaluate(() => window.__tifo.store.loadCells(new Uint8Array(window.__tifo.map.count)));
    await p.evaluate(() => document.getElementById('camera-preset').dispatchEvent(new Event('focus')));
    check('with nothing painted, "Your tifo" is not offered', await p.evaluate(() => document.querySelector('#camera-preset option[value="tifo"]')?.disabled === true));
    const c = await paintStand(p, 0); // east: behind a goal on the Jewel
    await p.evaluate(() => document.getElementById('camera-preset').dispatchEvent(new Event('focus')));
    check('a tifo behind one goal: "Your tifo" is offered', await p.evaluate(() => document.querySelector('#camera-preset option[value="tifo"]')?.disabled === false));
    await p.selectOption('#camera-preset', 'tifo');
    await p.waitForTimeout(800);
    const q = await projectIn(p, 'ed', c);
    check('…and it puts the tifo in the middle of the stadium picture', inFrame(q) && Math.abs(q.x) < 0.3, JSON.stringify(q));
    await p.selectOption('#camera-preset', '0');
    await p.waitForTimeout(500);
    const g = await projectIn(p, 'ed', c);
    check('(the TV gantry, for comparison, does not)', !inFrame(g) || Math.abs(g.x) > 0.6, JSON.stringify(g));
  }
  await ctx.close();
}

// ===========================================================================
console.log('\n— Match Day, a tifo behind one goal —');
{
  const { ctx, p } = await open('en');
  await p.goto(`${B}/app?new=1&template=${GROUND}&e2e`, { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  const c = await paintStand(p, 0);
  await p.evaluate(() => document.getElementById('match-day')?.click());
  check('Match Day opens', await until(p, () => !!window.__tifoMatchDay && !!document.querySelector('.mds-overlay canvas'), null, 120000));
  await p.waitForTimeout(3000);
  const menu = await p.evaluate(() => { const s = document.querySelector('[data-k="camera"]'); return { value: s.value, names: [...s.options].map((o) => o.textContent) }; });
  check('the first two cameras are on the tifo', menu.names[0] === 'Your tifo' && menu.names[1] === 'Your tifo from the pitch', menu.names.slice(0, 3).join(', '));
  check('…and Match Day opens on the first', menu.value === '0');
  await until(p, () => !window.__tifoMatchDay.camTween, null, 10000);
  const open0 = await projectIn(p, 'md', c);
  check('opening, the tifo is in the middle of the picture', inFrame(open0) && Math.abs(open0.x) < 0.25 && Math.abs(open0.y) < 0.4, JSON.stringify(open0));
  // From inside the ground: outside it the fans walking in are in view, and a
  // still Match Day keeps drawing for them (e2e-matchday-perf.mjs).
  check('…from inside the ground, where a still Match Day stops drawing', !(await p.evaluate(() => window.__tifoMatchDay.walkersInView())));
  const shots = await p.evaluate(() => window.__tifoMatchDay.shots().map((s) => ({ name: s.name, position: s.position, target: s.target, fov: s.fov })));
  const seen = {};
  for (const name of ['Your Tifo', 'Tifo Pitch Level', 'TV Broadcast']) {
    const sh = shots.find((x) => x.name === name);
    await p.evaluate((sh) => { const s = window.__tifoMatchDay; s.camera.position.set(...sh.position); s.controls.target.set(...sh.target); s.camera.fov = sh.fov; s.camera.updateProjectionMatrix(); s.controls.update(); }, sh);
    seen[name] = await projectIn(p, 'md', c);
  }
  check('"Your tifo" frames it', inFrame(seen['Your Tifo']), JSON.stringify(seen['Your Tifo']));
  check('"Your tifo from the pitch" frames it', inFrame(seen['Tifo Pitch Level']), JSON.stringify(seen['Tifo Pitch Level']));
  check('(the TV gantry, the show\'s old first camera, does not)', !inFrame(seen['TV Broadcast']), JSON.stringify(seen['TV Broadcast']));
  const ys = shots.find((x) => x.name === 'Your Tifo');
  check('"Your tifo" stands on the far side, across the pitch from the tifo', ys.position[0] * c[0] + ys.position[2] * c[2] < 0, JSON.stringify(ys.position));
  const cuts = await p.evaluate(() => window.__tifoMatchDay.buildAutoChoreo().cues.filter((q) => q.kind === 'camera').map((q) => q.shot));
  check('the auto show cuts between the tifo\'s cameras and the drone', cuts.join(',') === 'Your Tifo,Tifo Pitch Level,Drone', cuts.join(','));
  const drum = await p.evaluate(() => [...new Set(window.__tifoMatchDay.drumCallCues(0, true).filter((q) => q.kind === 'camera').map((q) => q.shot))]);
  check('…and so does the drum call', drum.join(',') === 'Your Tifo,Tifo Pitch Level', drum.join(','));
  check('the flares and smoke go in the tifo\'s stand', (await p.evaluate(() => document.querySelector('[data-k="acc-where"]')?.value)) === 'east');
  const rec = await p.evaluate(() => [...document.querySelectorAll('[data-k="rec-camera"] option')].map((o) => o.value));
  check('Record offers the show\'s cameras, where I put it, and the flyover', rec.join(',') === 'show,hold,flyover', rec.join(','));

  // A hand on the camera mid-show: the cuts stop for that show.
  await p.evaluate(() => window.__tifoMatchDay.playAutoChoreo());
  await p.waitForTimeout(800);
  const cv = await box(p, '.mds-overlay canvas');
  await p.mouse.move(cv.l + cv.w * 0.3, cv.t + cv.h * 0.5);
  await p.mouse.down();
  await p.mouse.move(cv.l + cv.w * 0.3 + 200, cv.t + cv.h * 0.5 + 20, { steps: 5 });
  await p.mouse.up();
  const toastText = await p.evaluate(() => document.querySelector('.mds-status')?.textContent || '');
  check('taking the camera mid-show says the cuts have stopped', /camera is yours/i.test(toastText), toastText);
  const took = await p.evaluate(() => window.__tifoMatchDay.lastCamName);
  await until(p, () => !window.__tifoMatchDay.timeline, null, 40000);
  const after = await p.evaluate(() => window.__tifoMatchDay.lastCamName);
  check('…and no cut comes after it, to the end of the show', after === took && after !== 'Drone', `${took} → ${after}`);

  // "Stay where I put it": the show never moves the camera.
  await p.evaluate(() => {
    const sel = document.querySelector('[data-k="show-camera"]');
    sel.value = 'hold';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('the choice is remembered', (await p.evaluate(() => localStorage.getItem('mds_showcam_v1'))) === 'hold');
  check('…and Record follows it', (await p.evaluate(() => document.querySelector('[data-k="rec-camera"]')?.value)) === 'hold');
  // The glide left over from the drag above is spent first: damping decays
  // per frame, and the software renderer here draws a few frames a second,
  // so a fling that is over in a second on a laptop lasts most of a show.
  await p.evaluate(() => { const c = window.__tifoMatchDay.controls; c.enableDamping = false; c.update(); c.enableDamping = true; });
  await p.evaluate(() => { const s = window.__tifoMatchDay; s.applyShot(s.shots().find((x) => x.name === 'Behind Goal')); });
  await until(p, () => !window.__tifoMatchDay.camTween, null, 10000);
  const camAt = () => p.evaluate(() => window.__tifoMatchDay.camera.position.toArray());
  const pos0 = await camAt();
  await p.evaluate(() => window.__tifoMatchDay.playAutoChoreo());
  await until(p, () => !window.__tifoMatchDay.timeline, null, 40000);
  const pos1 = await camAt();
  const moved = Math.hypot(pos1[0] - pos0[0], pos1[1] - pos0[1], pos1[2] - pos0[2]);
  check('with "Stay where I put it" the whole show keeps the camera still', moved < 0.05, `moved ${moved.toFixed(3)} m`);
  await ctx.close();
}

console.log('\n— Match Day in Arabic, and the remembered choice —');
{
  const { ctx, p } = await open('ar', [['mds_showcam_v1', 'hold']]);
  await p.goto(`${B}/ar/app?new=1&template=${GROUND}&e2e`, { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  await paintStand(p, 2); // west, the other end
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await until(p, () => !!window.__tifoMatchDay && !!document.querySelector('.mds-overlay canvas'), null, 120000);
  await p.waitForTimeout(2500);
  const m = await p.evaluate(() => ({
    names: [...document.querySelector('[data-k="camera"]').options].slice(0, 2).map((o) => o.textContent),
    show: document.querySelector('[data-k="show-camera"]')?.value,
    showLabels: [...document.querySelectorAll('[data-k="show-camera"] option')].map((o) => o.textContent),
    rec: document.querySelector('[data-k="rec-camera"]')?.value,
    where: document.querySelector('[data-k="acc-where"]')?.value,
  }));
  check('the tifo\'s cameras are named in Arabic', m.names[0] === 'تيفوك' && m.names[1] === 'تيفوك من أرض الملعب', m.names.join(' | '));
  check('"Stay where I put it" is remembered from last time', m.show === 'hold' && m.rec === 'hold', JSON.stringify(m));
  check('…in Arabic', m.showLabels.join('|') === 'تتنقل بين اللقطات|تثبت مكان ما حطيتها', m.showLabels.join('|'));
  check('the flares and smoke go in this tifo\'s stand (the west end)', m.where === 'west', m.where);
  await ctx.close();
}

console.log('\n— a small ground with stands on some sides (Al Hazem) —');
{
  const { ctx, p } = await open('en');
  await p.goto(`${B}/app?new=1&template=alhazem-stadium-8k-rb&e2e`, { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  // Its biggest stand, the middle of it.
  const big = await p.evaluate(() => {
    const { map } = window.__tifo;
    const n = [0, 0, 0, 0];
    for (let i = 0; i < map.count; i++) n[Math.floor(((map.uv[i * 2] + 0.125) % 1) * 4)]++;
    return n.indexOf(Math.max(...n));
  });
  const c = await paintStand(p, big);
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await until(p, () => !!window.__tifoMatchDay && !!document.querySelector('.mds-overlay canvas'), null, 120000);
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const s = window.__tifoMatchDay;
    const out = [];
    for (const sh of s.shots().filter((x) => x.name === 'Your Tifo' || x.name === 'Tifo Pitch Level')) {
      s.camera.position.set(...sh.position); s.controls.target.set(...sh.target); s.camera.fov = sh.fov; s.camera.updateProjectionMatrix();
      out.push({ name: sh.name, outside: s.walkersInView() });
    }
    return out;
  });
  check('a tifo on one of its stands gets the tifo\'s two cameras', r.length === 2, JSON.stringify(r));
  check('…both inside the ground, where a still Match Day can stop drawing', r.every((x) => !x.outside), JSON.stringify(r));
  const ys = await p.evaluate(() => window.__tifoMatchDay.shots()[0]);
  await p.evaluate((sh) => { const s = window.__tifoMatchDay; s.camera.position.set(...sh.position); s.controls.target.set(...sh.target); s.camera.fov = sh.fov; s.camera.updateProjectionMatrix(); }, ys);
  check('…and "Your tifo" has it in the picture', inFrame(await projectIn(p, 'md', c)));
  await ctx.close();
}
{
  // Painted on every seat it has: a whole-stadium design on this ground,
  // though its stands only go part of the way round.
  const { ctx, p } = await open('en');
  await p.goto(`${B}/app?new=1&template=alhazem-stadium-8k-rb&e2e`, { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  await p.evaluate(() => window.__tifo.store.fillAll(1));
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await until(p, () => !!window.__tifoMatchDay && !!document.querySelector('.mds-overlay canvas'), null, 120000);
  await p.waitForTimeout(2000);
  const first = await p.evaluate(() => window.__tifoMatchDay.shots()[0].name);
  check('every seat it has painted: the ground\'s own cameras, as before', first !== 'Your Tifo', first);
  await ctx.close();
}

console.log('\n— nothing to point at: no tifo cameras, the show as it was —');
for (const [label, fill] of [['an empty design', 0], ['a whole-stadium design', 1]]) {
  const { ctx, p } = await open('en');
  await p.goto(`${B}/app?new=1&template=${GROUND}&e2e`, { waitUntil: 'domcontentloaded' });
  await editorReady(p);
  await p.evaluate((v) => window.__tifo.store.fillAll(v), fill);
  await p.evaluate(() => document.getElementById('match-day')?.click());
  await until(p, () => !!window.__tifoMatchDay && !!document.querySelector('.mds-overlay canvas'), null, 120000);
  await p.waitForTimeout(2000);
  const r = await p.evaluate(() => ({
    first: document.querySelector('[data-k="camera"]').options[0].textContent,
    cuts: window.__tifoMatchDay.buildAutoChoreo().cues.filter((q) => q.kind === 'camera').map((q) => q.shot).join(','),
  }));
  check(`${label}: opens on the TV gantry, and the show cuts as before`, r.first === 'TV Broadcast' && r.cuts === 'TV Broadcast,Ultra View,Drone', JSON.stringify(r));
  await ctx.close();
}

check('no page errors', errs.length === 0, [...new Set(errs)].join(' | '));
await browser.close();
stop();
console.log(`\nstage camera: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
