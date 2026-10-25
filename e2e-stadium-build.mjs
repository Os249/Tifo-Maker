/**
 * The Stadium view builds its stadium in slices, and keeps what it built for
 * the session (performance plan P3.6).
 *
 * - The building comes in many short tasks, the main thread given back
 *   between them, not one long one: the view's own count of slices, and the
 *   page's long-task record while it builds (reported; this machine is shared
 *   and software-rendered, so the bound checked is loose).
 * - A second view of the same ground (the community preview of another design,
 *   a hero chip and back, the editor reopening it) takes the kept building:
 *   nothing is built again, and the picture is the same, pixel for pixel, with
 *   that view's own design on it.
 * - What is kept holds no design: its screens show the neutral picture, not
 *   the design's colours. A ground the site does not ship (a copy of one, or
 *   someone's own) is never kept. Losing a WebGL context drops everything kept.
 *   A device with 1 GB keeps nothing; the number kept is bounded.
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
  { name: 'tifo_post_nudge_v1', value: '1' },
];
// The design's colours are ones the neutral screen picture never has.
const PALETTE = ['#262a33', '#ff00ff', '#00ff66', '#ffee00'];

function diff(a, b) {
  const A = PNG.sync.read(Buffer.from(a.split(',')[1], 'base64'));
  const Bp = PNG.sync.read(Buffer.from(b.split(',')[1], 'base64'));
  if (A.width !== Bp.width || A.height !== Bp.height) return { px: -1, max: 999 };
  let px = 0, max = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const m = Math.max(Math.abs(A.data[i] - Bp.data[i]), Math.abs(A.data[i + 1] - Bp.data[i + 1]), Math.abs(A.data[i + 2] - Bp.data[i + 2]));
    if (m > 0) px++;
    if (m > max) max = m;
  }
  return { px, max };
}

async function editor(template, { memory = 4, quality = 'low' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => { const t = m.text(); if (/Shader Error|Program Info Log|WebGL: INVALID|could not be built/.test(t)) errs.push('GL: ' + t.slice(0, 160)); });
  await p.addInitScript((mem) => Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => mem }), memory);
  await p.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch { /* */ }
  });
  await p.addInitScript(([tpl, palette]) => {
    try {
      if (sessionStorage.getItem('e2e_started')) return;
      sessionStorage.setItem('e2e_started', '1');
      sessionStorage.setItem('tifo_new_project', JSON.stringify({ title: 'Build', templateId: tpl, start: { kind: 'blank', palette } }));
    } catch { /* */ }
  }, [template, PALETTE]);
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

/** Open the Stadium view and wait for its building; the time it took and the long tasks meanwhile. */
async function openView(p) {
  const t0 = await p.evaluate(() => { const t = performance.now(); document.getElementById('view-3d').click(); return t; });
  await p.waitForFunction(() => !!window.__tifoPreview, null, { timeout: 240000 });
  return p.evaluate(async (t0) => {
    const v = window.__tifoPreview;
    await v.ready;
    const t1 = performance.now();
    const tasks = window.__lt.filter(([s, d]) => s + d > t0 && s < t1).map(([, d]) => Math.round(d));
    return { ms: Math.round(t1 - t0), longest: Math.max(0, ...tasks), census: v.census() };
  }, t0);
}

/** Close the view and make a new one on the same ground, as the community preview does for the next design. */
const reopen = (p, opts = {}) => p.evaluate(async (o) => {
  const old = window.__tifoPreview;
  const C = old.constructor;
  const host = document.getElementById('preview-host');
  const template = o.copy ? structuredClone(old.template) : old.template;
  const quality = old.settings.tier;
  old.stop();
  old.dispose();
  const keptAfterClose = old.shellMod.keptShells().map((k) => ({ ground: k.ground, tier: k.tier, bytes: k.bytes }));
  const t0 = performance.now();
  const v = new C(host, window.__tifo.map, window.__tifo.store, { template, quality });
  window.__tifoPreview = v;
  v.start();
  await v.ready;
  return { ms: Math.round(performance.now() - t0), census: v.census(), keptAfterClose, keptNow: v.shellMod?.keptShells().length ?? -1 };
}, opts);

const picture = (p) => p.evaluate(() => {
  const v = window.__tifoPreview;
  v.applyPreset(v.presets().find((x) => x.name === 'TV gantry'));
  v.renderOnce();
  return v.renderer.domElement.toDataURL('image/png');
});

// ---------------------------------------------------------------------------
console.log('\n— the building in slices, kept for the next view —');
{
  const G = process.env.GROUND || 'jewel-jeddah-60k-rb';
  const { ctx, p, errs } = await editor(G);
  const first = await openView(p);
  await p.evaluate(() => { window.__shipped = window.__tifoPreview.template; });
  const b = first.census.build;
  check(`${G}: the building is in`, first.census.structure && first.census.shell?.meshesAfter > 0, JSON.stringify(first.census.shell?.steps));
  check(`${G}: built, not taken`, b && b.reused === false, JSON.stringify(b));
  check(`${G}: in many slices, the main thread given back between them`, b && b.slices >= 20, `${b?.slices} slices, the longest ${b?.longestSliceMs} ms, ${b?.busyMs} ms of work`);
  check(`${G}: no slice of it long (loose bound: a shared, software-rendered machine)`, b && b.longestSliceMs < 400, `${b?.longestSliceMs} ms`);
  console.log(`      (the view open in ${first.ms} ms; its longest task ${first.longest} ms)`);
  const one = await picture(p);
  const again = await reopen(p);
  check(`${G}: closing the view kept its building`, again.keptAfterClose.length === 1 && again.keptAfterClose[0].ground === G, JSON.stringify(again.keptAfterClose));
  check(`${G}: the next view takes it, building nothing`, again.census.build?.reused === true && again.census.structure, JSON.stringify(again.census.build));
  check(`${G}: and has it to itself while it shows it`, again.keptNow === 0, String(again.keptNow));
  const two = await picture(p);
  const d = diff(one, two);
  check(`${G}: the same picture, pixel for pixel`, d.px === 0, JSON.stringify(d));
  // Roofs fade to a ghost from high up and come back as built. A solid roof writes depth again:
  // it used to come back not writing it (a building landing while the camera was high, or any
  // orbit up and down), and showed what is under it through its top edge.
  const roofs = await p.evaluate(() => {
    const v = window.__tifoPreview;
    const solid = (v.shell?.roofMaterials ?? []).filter((m) => !(m.userData.baseTransparent ?? m.transparent));
    const at = (name) => { v.applyPreset(v.presets().find((x) => x.name === name)); v.renderOnce(); };
    const writing = solid.filter((m) => m.depthWrite).length;
    at('Full view');
    const ghost = solid.filter((m) => m.transparent && !m.depthWrite).length;
    at('TV gantry');
    return { solid: solid.length, writing, ghost, back: solid.filter((m) => !m.transparent && m.depthWrite).length };
  });
  check(`${G}: a roof seen from high up is a ghost, and back down it is solid, writing depth as built`, roofs.solid > 0 && roofs.writing === roofs.solid && roofs.ghost === roofs.solid && roofs.back === roofs.solid, JSON.stringify(roofs));
  const three = diff(one, await picture(p));
  check(`${G}: …the same picture as before, pixel for pixel`, three.px === 0, JSON.stringify(three));
  // Its own design: paint every seat one colour in the new view; its chairs follow its cards.
  const recoloured = await p.evaluate(() => {
    const { store, map } = window.__tifo;
    store.loadCells(new Uint8Array(map.count).fill(2));
    return window.__tifoPreview.census().cardsUp;
  });
  const seats = await p.evaluate(() => window.__tifo.map.count);
  check(`${G}: the taken building shows this view's design`, recoloured > seats * 0.8, `${recoloured} cards of ${seats}`);
  // What is kept holds no design: its screens are the neutral picture.
  const kept = await p.evaluate(async (palette) => {
    const v = window.__tifoPreview;
    v.stop();
    v.dispose();
    const k = v.shellMod.keptShells()[0];
    if (!k) return null;
    const c = k.screens;
    if (!c) return { screens: false };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const rgb = palette.slice(1).map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    let hits = 0;
    for (let i = 0; i < d.length; i += 4) for (const [r, g, b] of rgb) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) hits++;
    return { screens: true, hits, px: d.length / 4 };
  }, PALETTE);
  check(`${G}: the kept building's screens hold none of the design's colours`, !!kept && (kept.screens === false || kept.hits === 0), JSON.stringify(kept));
  // A copy of the template is not the shipped one: built, and never kept.
  await p.evaluate(() => {
    const C = window.__tifoPreview.constructor;
    const v = new C(document.getElementById('preview-host'), window.__tifo.map, window.__tifo.store, { template: window.__tifoPreview.template, quality: 'low' });
    window.__tifoPreview = v;
    v.start();
    return v.ready;
  });
  const copy = await reopen(p, { copy: true });
  check('a copy of a shipped ground is built, not taken', copy.census.build?.reused === false && copy.census.structure, JSON.stringify(copy.census.build));
  const keptCopy = await p.evaluate(() => { const v = window.__tifoPreview; v.stop(); v.dispose(); return v.shellMod.keptShells().map((k) => k.ground); });
  check('…and not kept when it closes', keptCopy.length === 1, JSON.stringify(keptCopy));
  // A lost context: nothing kept any more, and this view's building not kept either.
  const lost = await p.evaluate(async () => {
    const C = window.__tifoPreview.constructor;
    const v = new C(document.getElementById('preview-host'), window.__tifo.map, window.__tifo.store, { template: window.__shipped, quality: 'low' });
    window.__tifoPreview = v;
    v.start();
    await v.ready;
    const taken = v.census().build?.reused;
    v.renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    const during = v.shellMod.keptShells().length;
    v.dispose();
    return { taken, during, after: v.shellMod.keptShells().length };
  });
  check('a lost context drops what is kept, and keeps nothing more', lost.taken === true && lost.during === 0 && lost.after === 0, JSON.stringify(lost));
  check(`${G}: no page or WebGL errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

{
  // The number kept is bounded (two on a 4 GB device): three tiers of one ground, kept one after another.
  const { ctx, p } = await editor('alhazem-stadium-8k-rb');
  await openView(p);
  const n = await p.evaluate(async () => {
    const out = [];
    for (const q of ['medium', 'high', 'low']) {
      const old = window.__tifoPreview;
      const C = old.constructor;
      old.stop();
      old.dispose();
      const v = new C(document.getElementById('preview-host'), window.__tifo.map, window.__tifo.store, { template: old.template, quality: q });
      window.__tifoPreview = v;
      v.start();
      await v.ready;
      out.push(v.shellMod.keptShells().map((k) => k.tier).join(','));
    }
    const v = window.__tifoPreview;
    v.stop();
    v.dispose();
    out.push(v.shellMod.keptShells().map((k) => k.tier).join(','));
    return out;
  });
  check('at most two buildings kept on a 4 GB device, the latest', n.at(-1).split(',').length === 2 && n.at(-1).endsWith('low'), n.join(' | '));
  await ctx.close();
}
{
  // A 1 GB device keeps nothing.
  const { ctx, p } = await editor('alhazem-stadium-8k-rb', { memory: 1 });
  await openView(p);
  const again = await reopen(p);
  check('a 1 GB device keeps nothing', again.keptAfterClose.length === 0 && again.census.build?.reused === false, JSON.stringify({ kept: again.keptAfterClose, build: again.census.build }));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
