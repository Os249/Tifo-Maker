/**
 * The Stadium view is a stadium: every ground, in the real app.
 *
 *   npm run build && node e2e-stadium-view.mjs            (every ground)
 *   node e2e-stadium-view.mjs anfield                     (just the ones matching)
 *
 * For every ground in the catalogue, and the legacy ones saved designs still
 * open on:
 *
 *   - the building comes in: stands, roofs, floodlights, pitch (the census
 *     says so) in a phone's draw-call budget, with no page or WebGL error;
 *   - every seat has a chair (premium seating has its own) and every painted
 *     seat a card; an empty design shows no cards at all — the seats are the
 *     stadium's own colour;
 *   - no camera preset sits inside the seats;
 *   - it draws nothing while nothing moves, and draws again when a seat is
 *     painted.
 *
 * Then the quality tiers, the roofs fading for the Full view, and the pages
 * that reuse the view (the landing hero, a shared design, the community
 * preview).
 *
 * Spawns its own server on :8933 serving dist/ (so build first).
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8933;
const B = `http://127.0.0.1:${PORT}`;
const OUT = 'preview-out/e2e-stadium-view';
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ?? '';

const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 120; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up on ' + B + '\n' + out.join('')); stop(); process.exit(1); }

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

const LS = (lang = 'en') => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_news_leagues_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_post_nudge_v1', value: '1' },
];

async function open(path, { w = 1280, h = 800 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS() }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  p.on('console', (m) => {
    const t = m.text();
    if (/Shader Error|Program Info Log|WebGL: INVALID|THREE\.WebGLProgram|could not be built/.test(t)) errs.push('GL: ' + t.slice(0, 200));
  });
  await p.goto(B + path, { waitUntil: 'networkidle', timeout: 120000 });
  return { ctx, p, errs };
}

/** Open a ground's Stadium view and wait for the building. */
async function stadium(id, quality = 'low') {
  const o = await open(`/app?new=1&template=${id}&quality=${quality}&e2e=1`);
  const { p } = o;
  await p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 120000 });
  await p.click('#view-3d');
  await p.waitForFunction(() => !!window.__tifoPreview, null, { timeout: 60000 });
  await p.evaluate(() => window.__tifoPreview.ready);
  await p.waitForTimeout(400);
  return o;
}

const census = (p) => p.evaluate(() => window.__tifoPreview.census());

// The catalogue and the legacy grounds, with each one's seat count and how
// many seats have a premium chair of their own.
const grounds = await (async () => {
  const { p, ctx } = await open('/app?new=1&e2e=1');
  const list = await p.evaluate(async () => {
    const cat = await import('/src/core/stadiumCatalog.ts').catch(() => null);
    return cat ? [...cat.STADIUM_CATALOG, ...cat.LEGACY_STADIUMS].map((e) => e.id) : null;
  });
  await ctx.close();
  if (list) return list;
  // dist/ has no source modules: ask the server, which knows every shipped ground.
  const r = await fetch(`${B}/api/templates`).then((x) => x.json());
  return r.map((t) => t.id);
})();

console.log(`\n— every ground (${grounds.length}) —`);
for (const id of grounds) {
  if (only && !id.includes(only)) continue;
  let o;
  try {
    o = await stadium(id, 'low');
  } catch (e) {
    check(`${id}: the Stadium view opens`, false, String(e).slice(0, 160));
    continue;
  }
  const { p, ctx, errs } = o;
  const c = await census(p);
  const seats = await p.evaluate(() => window.__tifo.map.count);
  const painted = await p.evaluate(() => window.__tifo.store.cells.reduce((s, v) => s + (v ? 1 : 0), 0));
  check(`${id}: the building is in`, c.structure && c.shell && c.shell.meshesAfter > 0 && c.shell.triangles > 500, JSON.stringify(c.shell));
  check(`${id}: in a phone's draw-call budget`, c.drawCalls <= 160, `${c.drawCalls} calls, ${c.triangles} triangles`);
  // Low tier: one panel (2 triangles) per chair; premium seats bring their own.
  check(`${id}: a chair on (nearly) every seat`, c.chairs / 2 >= seats * 0.85 && c.chairs / 2 <= seats, `${c.chairs / 2} chairs for ${seats} seats`);
  check(`${id}: a card on every painted seat`, c.cardsUp <= painted && c.cardsUp >= painted * 0.97, `${c.cardsUp} cards, ${painted} painted`);
  // No preset inside the seats.
  const inside = await p.evaluate(() => {
    const v = window.__tifoPreview;
    const P = window.__tifo.map.pos3;
    const bad = [];
    for (const s of v.presets()) {
      const [x, y, z] = s.position;
      let top = -Infinity;
      for (let k = 0; k < P.length / 3; k++) {
        const dx = P[k * 3] - x;
        const dz = P[k * 3 + 2] - z;
        if (dx * dx + dz * dz < 4) top = Math.max(top, P[k * 3 + 1]);
      }
      if (top > -Infinity && y < top + 1.2) bad.push(`${s.name} y=${y.toFixed(1)} seats to ${top.toFixed(1)}`);
    }
    return bad;
  });
  check(`${id}: no camera inside the seats`, inside.length === 0, inside.join('; '));
  // Idle: nothing drawn. Paint a seat: drawn again, and its card goes up.
  const f0 = (await census(p)).frames;
  await p.waitForTimeout(1200);
  const f1 = (await census(p)).frames;
  check(`${id}: draws nothing while nothing moves`, f1 === f0, `${f1 - f0} frames in 1.2 s`);
  await p.evaluate(() => {
    const s = window.__tifo.store;
    s.loadCells(new Uint8Array(s.cells.length));
  });
  // A frame is asked for at once; software GL can take a moment to give one.
  await p.waitForFunction((f) => window.__tifoPreview.census().frames > f, f1, { timeout: 8000 }).catch(() => {});
  const empty = await census(p);
  check(`${id}: an empty design holds up no cards`, empty.cardsUp === 0, String(empty.cardsUp));
  check(`${id}: and the change was drawn`, empty.frames > f1, `${empty.frames} after ${f1}`);
  await p.evaluate(() => {
    const s = window.__tifo.store;
    const cells = new Uint8Array(s.cells.length);
    cells[Math.floor(cells.length / 2)] = 1;
    s.loadCells(cells);
  });
  await p.waitForTimeout(300);
  check(`${id}: painting a seat raises its card`, (await census(p)).cardsUp === 1);
  check(`${id}: no page or WebGL errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

if (!only) {
  console.log('\n— quality tiers —');
  for (const [q, tris, maxRatio] of [['low', 2, 1], ['medium', 4, 1.5], ['high', 4, 2]]) {
    const { p, ctx, errs } = await stadium('generic-bowl-60k', q);
    const c = await census(p);
    const seats = await p.evaluate(() => window.__tifo.map.count);
    check(`${q}: the tier asked for`, c.tier === q, c.tier);
    check(`${q}: ${tris} triangles a chair`, c.chairs === seats * tris, `${c.chairs} for ${seats} seats`);
    check(`${q}: pixel ratio at most ${maxRatio}`, c.pixelRatio <= maxRatio + 1e-6, String(c.pixelRatio));
    check(`${q}: no errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— roofs from above —');
  {
    const { p, ctx } = await stadium('anfield-61k', 'low');
    await p.selectOption('#camera-preset', '4');
    await p.waitForTimeout(800);
    const full = await census(p);
    check('Full view: the roofs fade so the tifo under them shows', full.roofs && full.roofOpacity < 0.5, String(full.roofOpacity));
    await p.screenshot({ path: `${OUT}/anfield-full.png` });
    await p.selectOption('#camera-preset', '0');
    await p.waitForTimeout(800);
    const tv = await census(p);
    check('TV gantry: from inside the bowl a roof is a roof', tv.roofOpacity > 0.99, String(tv.roofOpacity));
    await p.screenshot({ path: `${OUT}/anfield-tv.png` });
    await ctx.close();
  }
  {
    const { p, ctx } = await stadium('kingdom-arena-26k', 'low');
    await p.selectOption('#camera-preset', '4');
    await p.waitForTimeout(800);
    // The hall is cut open from above: the pitch shows in the middle of the picture.
    const mid = await p.evaluate(() => {
      const c = document.querySelector('#preview-host canvas');
      const k = document.createElement('canvas');
      k.width = 40;
      k.height = 40;
      const g = k.getContext('2d');
      g.drawImage(c, c.width / 2 - c.width * 0.05, c.height / 2 - c.height * 0.05, c.width * 0.1, c.height * 0.1, 0, 0, 40, 40);
      const d = g.getImageData(0, 0, 40, 40).data;
      let gr = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2] + 20) gr++;
      return gr / 1600;
    });
    check('Kingdom Arena from above: the hall is cut open onto the pitch', mid > 0.5, mid.toFixed(2));
    await p.screenshot({ path: `${OUT}/kingdom-full.png` });
    await ctx.close();
  }

  console.log('\n— the pages that reuse the view —');
  {
    const { p, ctx, errs } = await open('/?hero3d');
    const ok = await p.waitForFunction(() => document.getElementById('hero-3d')?.dataset.stadium === 'ready', null, { timeout: 120000 }).then(() => true).catch(() => false);
    check('landing hero: the stadium comes in', ok);
    check('landing hero: no errors', errs.length === 0, errs.join(' | '));
    await p.screenshot({ path: `${OUT}/landing.png` });
    await ctx.close();
  }
  {
    // A published design, for the share page and the community preview.
    const api = async (path, token, body, method = 'POST') => {
      const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await r.text();
      try { return JSON.parse(t); } catch { return t; }
    };
    const stamp = Date.now().toString(36).slice(-6);
    const reg = await api('/api/auth/register', null, { username: `sv${stamp}`, password: 'harbor-kite-moss-31', email: `sv${stamp}@example.test`, acceptedVersion: 'test' });
    const tpl = (await (await fetch(`${B}/api/templates`)).json()).find((t) => t.id === 'alawwal-park-26k') ?? (await (await fetch(`${B}/api/templates`)).json())[0];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const cells = Buffer.alloc(tpl.seatCount, 0);
    for (let i = 0; i < cells.length; i += 3) cells[i] = 1;
    const design = await api('/api/designs', reg.token, {
      title: 'STADIUM VIEW', templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1f8a2e', '#ffffff'],
      cellsGzB64: gzipSync(cells).toString('base64'), thumbnailPngB64: png.toString('base64'),
    });
    await api(`/api/designs/${design.id}`, reg.token, { isPublic: true }, 'PATCH');
    check('seeded a public design', !!design.id, JSON.stringify(design).slice(0, 120));
    const spread = (p, sel) => p.evaluate((s) => {
      const c = document.querySelector(s);
      if (!c) return -1;
      const k = document.createElement('canvas');
      k.width = 120;
      k.height = 80;
      const g = k.getContext('2d');
      g.drawImage(c, 0, 0, 120, 80);
      const d = g.getImageData(0, 0, 120, 80).data;
      let a = 0;
      let a2 = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        a += v;
        a2 += v * v;
      }
      const n = d.length / 4;
      return Math.sqrt(Math.max(0, a2 / n - (a / n) ** 2));
    }, sel);
    for (const [label, path, sel] of [
      ['share page', `/t/${design.id}`, '#s-preview-host canvas'],
      ['community preview', `/community?t=${design.id}`, '#modal-3d-host canvas'],
    ]) {
      const { p, ctx, errs } = await open(path);
      const has = await p.waitForSelector(sel, { timeout: 90000 }).then(() => true).catch(() => false);
      await p.waitForTimeout(6000);
      const sd = has ? await spread(p, sel) : -1;
      check(`${label}: the 3D view draws a picture`, has && sd > 8, sd.toFixed(1));
      check(`${label}: no errors`, errs.length === 0, errs.join(' | '));
      await p.screenshot({ path: `${OUT}/${label.replace(/\W+/g, '-')}.png` });
      await ctx.close();
    }
  }
}

await browser.close();
stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
