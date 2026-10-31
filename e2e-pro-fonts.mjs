/**
 * Pro fonts in a real browser against a real server with PRO_MODE=preview
 * (ui/proFonts.ts, core/proVoices.ts, core/proFontFaces.ts).
 *
 *   not on the list  the three font pickers exactly as they were: no Pro
 *                    group, no crown, and no Pro code or font file fetched;
 *                    PRO_MODE off is the same, even for a name on the list;
 *   on the list      the Pro voices in the Text tool's picker, a text
 *                    layer's and a sign's letters, after the free ones, in a
 *                    "♛ Pro fonts" group, the crown beside the picker while
 *                    one is chosen (and following undo); text placed in a Pro
 *                    voice is drawn in that face, not the fallback; the export
 *                    question names "Pro fonts" once, for a layer and a
 *                    banner, and lifts both to the default voice for a free
 *                    export without an undo step, then puts them back;
 *   saved            reopened, the layer and the banner keep their Pro voice
 *                    and its faces load;
 *   someone else     opening it (Pro not on for them) still draws the Pro
 *                    face: a banner in the stadium, and a text layer redrawn
 *                    after a colour change comes out seat for seat the same;
 *   in Arabic        the group's name; with Pro running, a quiet crown.
 *   in Node          the Pro voices never reach the AI's list or the spec.
 *
 * Self-contained: it boots its own servers on memory repos. Needs a build:
 *   npm run build && node e2e-pro-fonts.mjs        (SHOTS=dir for pictures)
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const PORT = 8945;
const PORT_OFF = 8946;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const SHOTS = process.env.SHOTS || '';
const PRO_IDS = ['block', 'stencil', 'rounded', 'classic', 'marker'];
const PICKERS = ['text-font', 'obj-font', 'bn-msg-font'];
const out = [];
const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pf_fan' });
const serverOff = boot(PORT_OFF, { PRO_MODE: 'off' });
const stop = () => { for (const s of [server, serverOff]) { try { s.kill(); } catch { /* gone */ } } };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up(B)) || !(await up(OFF))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
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
const cellsGzB64 = gzipSync(new Uint8Array(tpl.seatCount)).toString('base64');
/** A verified account with one saved design. */
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64 }) }, base);
  return { token, design: d.json?.id };
};
const gunzipJson = async (b64) => JSON.parse(new TextDecoder().decode(await new Response(new Blob([Buffer.from(b64, 'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const page = async (token, { lang = 'en', w = 1440, h = 900, ls = {} } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_view_v1: '2d', tifo_lang_v1: lang, ...ls })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, ls]);
  const p = await ctx.newPage();
  const asked = [];
  p.on('request', (r) => asked.push(new URL(r.url()).pathname));
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p, asked };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const editor = async (token, url, opts = {}) => {
  const e = await page(token, opts);
  await e.p.goto(`${opts.base ?? B}${url}`, { waitUntil: 'domcontentloaded' });
  await waitFor(e.p, () => !!window.__tifo, null, 90000);
  return e;
};
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

/** What each font picker holds, and the crown beside it. */
const pickers = (p) => p.evaluate(([ids, pro]) => Object.fromEntries(ids.map((id) => {
  const s = document.getElementById(id);
  const g = s?.querySelector(':scope > optgroup.pfont-group');
  const next = s?.nextElementSibling;
  const chip = next?.classList.contains('pfont-chip') ? next : null;
  return [id, {
    value: s?.value ?? null,
    group: g ? { label: g.label, ids: [...g.querySelectorAll('option')].map((o) => o.value), last: s.lastElementChild === g } : null,
    pro: [...(s?.options ?? [])].filter((o) => pro.includes(o.value)).length,
    free: [...(s?.children ?? [])].filter((o) => o.tagName === 'OPTION').map((o) => o.value),
    chip: chip ? { shown: getComputedStyle(chip).display !== 'none', quiet: !!chip.querySelector('.pro-chip.quiet'), crown: !!chip.querySelector('.pro-crown'), text: chip.textContent, spoken: chip.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null } : null,
    chips: document.querySelectorAll('.pfont-chip').length,
  }];
})), [PICKERS, PRO_IDS]);
/** How many faces of a family have loaded. */
const facesOf = (p, family) => p.evaluate((f) => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === f && x.status === 'loaded').length, family);
const bowlMid = (p) => p.evaluate(() => { const b = window.__tifo.map.bounds; return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; });
const toPage = (p, x, y) => p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [x, y]);
/**
 * A text layer's shape against the shape its words come out at in a face:
 * renderTextCanvas pads 6 px around the measured run at 128 px bold, and the
 * layer keeps that canvas's aspect.
 */
const aspects = (p, fallbackCss) => p.evaluate((fb) => {
  const o = window.__tifo.objects.list().filter((x) => x.kind === 'text').at(-1);
  const ratio = (css) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `bold 128px ${css}`;
    const m = c.measureText(o.text.trim());
    return (Math.ceil(m.width) + 12) / (Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 12);
  };
  return { fontId: o.fontId, css: o.fontCss, layer: o.width / o.height, face: ratio(o.fontCss), fallback: ratio(fb) };
}, fallbackCss);
const near = (a, b, tol) => Math.abs(a - b) / b <= tol;
const FREE_IDS = ['poster', 'kufi', 'condensed', 'slab', 'sign', 'grotesk', 'impact', 'black', 'verdana', 'georgia', 'courier'];
const fan = await account('pf_fan');
const other = await account('pf_other');

// =====================================================================
console.log('\n— in Node: the Pro voices stay away from the AI —');
{
  const { PRO_VOICES, PRO_FONTS, isProVoice, proVoicesIn } = await tsImport('./src/core/proVoices.ts', import.meta.url);
  const { TIFO_VOICES } = await tsImport('./src/core/tifoVoices.ts', import.meta.url);
  const { TIFO_FONTS, fontCssOf, findFontCss } = await tsImport('./src/core/text.ts', import.meta.url);
  const { SPEC_FONT_IDS } = await tsImport('./src/core/tifoSpec.ts', import.meta.url);
  const ids = PRO_VOICES.map((v) => v.id);
  check('five Pro voices, each one family with its Arabic and Latin pair', ids.join() === PRO_IDS.join() && PRO_VOICES.every((v) => /^TifoPro/.test(v.family) && v.pair && v.note), ids.join());
  check('none of them in TIFO_VOICES, TIFO_FONTS or the spec\'s font ids (what the AI may use)',
    !ids.some((id) => TIFO_VOICES.some((v) => v.id === id) || TIFO_FONTS.some((f) => f.id === id) || SPEC_FONT_IDS.includes(id)));
  check('a Pro id resolves to its own family for anybody; an unknown one to the first voice',
    PRO_FONTS.every((f) => fontCssOf(f.id).includes(PRO_VOICES.find((v) => v.id === f.id).family)) && fontCssOf('nope') === TIFO_FONTS[0].css && findFontCss('nope') === undefined);
  check('the cheap check finds the Pro voices a design uses, once each',
    proVoicesIn([{ kind: 'text', fontId: 'block' }, { kind: 'text', fontId: 'poster' }, { kind: 'image' }, { kind: 'text', fontId: 'block' }, { kind: 'text', fontId: 'classic' }]).join() === 'block,classic' && !isProVoice('grotesk'));
}

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const e = await editor(other.token, `/app?project=${other.design}&e2e=1`);
  await e.p.waitForTimeout(2500);
  const pk = await pickers(e.p);
  check('no Pro group, no Pro voice, no crown in any picker', PICKERS.every((id) => !pk[id].group && pk[id].pro === 0 && !pk[id].chip) && pk['text-font'].chips === 0, JSON.stringify(pk));
  check('the Text tool lists the free voices, as before', pk['text-font'].free.join() === FREE_IDS.join(), pk['text-font'].free.join());
  check('no Pro fonts code and no Pro font file fetched', !e.asked.some((u) => /proFont|lalezar|bowlby|reem-kufi|black-ops|lemonada|rakkas|marhey/.test(u)), e.asked.filter((u) => /proFont/.test(u)).join(' '));
  await e.ctx.close();
}
{
  const u = await account('pf_fan', OFF);
  const e = await editor(u.token, `/app?project=${u.design}&e2e=1`, { base: OFF });
  await e.p.waitForTimeout(2500);
  const pk = await pickers(e.p);
  check('PRO_MODE off: none of it, even for a name on the list', PICKERS.every((id) => !pk[id].group && pk[id].pro === 0) && pk['text-font'].chips === 0 && !e.asked.some((u) => /proFont/.test(u)), JSON.stringify(pk['text-font']));
  await e.ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list —');
let savedCells = '';
const TEXT = 'الهلال HILAL';
{
  const e = await editor(fan.token, `/app?project=${fan.design}&e2e=1`);
  const { p } = e;
  check('the Pro voices arrive in all three pickers', await waitFor(p, (ids) => ids.every((id) => !!document.querySelector(`#${id} > optgroup.pfont-group`)), PICKERS));
  let pk = await pickers(p);
  check('…after the free ones, in a "♛ Pro fonts" group of five',
    PICKERS.every((id) => pk[id].group?.label === '♛ Pro fonts' && pk[id].group.ids.join() === PRO_IDS.join() && pk[id].group.last) && pk['text-font'].free.join() === FREE_IDS.join(),
    JSON.stringify(PICKERS.map((id) => pk[id].group)));
  check('no crown while a free voice is chosen', PICKERS.every((id) => pk[id].chip && !pk[id].chip.shown), JSON.stringify(PICKERS.map((id) => pk[id].chip)));
  check('the faces wait until a picker needs them', (await facesOf(p, 'TifoProBlock')) === 0 && !e.asked.some((u) => /proFontFaces|lalezar/.test(u)));

  // The Text tool, in a Pro voice.
  await p.click('.tool-rail [data-tool="text"]');
  await p.fill('#text-input', TEXT);
  await p.selectOption('#text-font', 'block');
  pk = await pickers(p);
  check('choosing one crowns the picker (gold, "Pro")', pk['text-font'].chip?.shown && pk['text-font'].chip.crown && pk['text-font'].chip.text === 'Pro' && !pk['text-font'].chip.quiet, JSON.stringify(pk['text-font'].chip));
  check('…and says it is free to try', await waitFor(p, () => /free to try/.test(document.getElementById('message')?.textContent || '')));
  check('its two faces (Arabic and Latin) load, from their own chunk', await waitFor(p, () => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === 'TifoProBlock' && x.status === 'loaded').length === 2) && e.asked.some((u) => /proFontFaces-/.test(u)) && e.asked.some((u) => /lalezar-arabic/.test(u)) && e.asked.some((u) => /bowlby-one-latin/.test(u)));
  const m = await bowlMid(p);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 2; });
  const [cx, cy] = await toPage(p, m.x, m.y);
  await p.mouse.click(cx, cy);
  check('placing it makes a text layer', await waitFor(p, () => window.__tifo.objects.list().some((o) => o.kind === 'text')));
  await p.waitForTimeout(500);
  let a = await aspects(p, '"Arial Black", sans-serif');
  check('the layer is in the Pro voice', a.fontId === 'block' && /TifoProBlock/.test(a.css), `${a.fontId} ${a.css}`);
  check('…drawn in its face, not the fallback (the layer\'s shape is the face\'s)', near(a.layer, a.face, 0.01) && !near(a.layer, a.fallback, 0.03),
    `layer ${a.layer.toFixed(3)} face ${a.face.toFixed(3)} fallback ${a.fallback.toFixed(3)}`);
  const seats = await p.evaluate(() => { let n = 0; for (const c of window.__tifo.store.cells) if (c === 2) n++; return n; });
  check('…and on the seats', seats > 200, `${seats} seats`);
  await shot(p, 'pf-text-block');

  // The layer's own picker follows the selection, and undo.
  pk = await pickers(p);
  check('the layer panel shows its Pro voice, crowned', pk['obj-font'].value === 'block' && pk['obj-font'].chip?.shown, JSON.stringify(pk['obj-font']));
  await p.selectOption('#obj-font', 'stencil');
  check('changing it there redraws the layer in that voice', await waitFor(p, () => window.__tifo.objects.list().find((o) => o.kind === 'text')?.fontId === 'stencil'));
  await waitFor(p, () => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === 'TifoProStencil' && x.status === 'loaded').length === 2);
  a = await aspects(p, '"Arial Black", sans-serif');
  check('…in Stencil\'s faces', a.fontId === 'stencil' && near(a.layer, a.face, 0.01), `layer ${a.layer.toFixed(3)} face ${a.face.toFixed(3)}`);
  await p.selectOption('#obj-font', 'poster');
  await waitFor(p, () => window.__tifo.objects.list().find((o) => o.kind === 'text')?.fontId === 'poster');
  pk = await pickers(p);
  check('a free voice: no crown', pk['obj-font'].value === 'poster' && !pk['obj-font'].chip.shown);
  await p.click('#undo');
  check('undo puts Stencil back, and the crown with it', await waitFor(p, () => window.__tifo.objects.list().find((o) => o.kind === 'text')?.fontId === 'stencil') && (await pickers(p))['obj-font'].chip.shown);
  await p.click('#undo');
  check('…and Block', await waitFor(p, () => window.__tifo.objects.list().find((o) => o.kind === 'text')?.fontId === 'block'));

  // A sign's letters.
  await p.click('#view-banner');
  await p.waitForTimeout(900);
  const mk = await p.$('#bn-empty:not([hidden]) button[data-kind="sign"]');
  if (mk) await mk.click();
  await p.waitForTimeout(700);
  await p.fill('#bn-msg', 'ULTRAS الهلال');
  await p.waitForTimeout(900);
  pk = await pickers(p);
  check('the sign\'s picker: the free voices first, then the Pro group', pk['bn-msg-font'].free.join() === FREE_IDS.join() && pk['bn-msg-font'].group?.last && !pk['bn-msg-font'].chip.shown, JSON.stringify(pk['bn-msg-font']));
  await p.selectOption('#bn-msg-font', 'block');
  check('the sign takes the Pro voice', await waitFor(p, () => window.__tifoProFonts?.banners().some((b) => b.fontId === 'block')));
  pk = await pickers(p);
  check('…crowned (the crown alone in that narrow row, its name spoken)', pk['bn-msg-font'].chip?.shown && pk['bn-msg-font'].chip.crown && pk['bn-msg-font'].chip.spoken === 'Pro', JSON.stringify(pk['bn-msg-font'].chip));
  await p.waitForTimeout(600);
  await shot(p, 'pf-sign-block');
  const signBox = (await p.evaluate(() => window.__tifoProFonts.banners()))[0];

  // The export question.
  const items = await p.evaluate(() => window.__tifoProFonts.items());
  check('the export sheet would name "Pro fonts", once, for the layer and the sign', JSON.stringify(items) === '["Pro fonts"]', JSON.stringify(items));
  const undoBefore = await p.evaluate(() => window.__tifo.store.canUndo);
  const during = await p.evaluate(() => window.__tifoProFonts.duringFreeExport());
  check('a free export draws both in the default voice', during.layers.every((l) => l.fontId === 'grotesk') && during.banners.every((b) => b.fontId === 'grotesk') && during.layers.length === 1 && during.banners.length === 1, JSON.stringify(during));
  check('…the sign\'s words refitted to its sheet', during.banners[0].w <= 0.941 && during.banners[0].w !== signBox.w, `${signBox.w.toFixed(3)} -> ${during.banners[0].w.toFixed(3)}`);
  const after = await p.evaluate(() => ({ layers: window.__tifoProFonts.layers(), banners: window.__tifoProFonts.banners() }));
  check('…and both come back after, exactly', after.layers[0].fontId === 'block' && after.banners[0].fontId === 'block' && after.banners[0].w === signBox.w && after.banners[0].h === signBox.h, JSON.stringify(after));
  check('…with no undo step', (await p.evaluate(() => window.__tifo.store.canUndo)) === undoBefore);

  // Save.
  await p.click('#view-2d');
  await p.waitForTimeout(400);
  await p.click('#save-top');
  await waitFor(p, () => { const b = document.getElementById('save-top'); return !!b && !b.disabled; }, null, 60000);
  await waitFor(p, () => /Saved to your account|Saved in your account/i.test(document.getElementById('save-state-top')?.textContent || ''), null, 30000);
  await p.waitForTimeout(1500);
  savedCells = await p.evaluate(() => Array.from(window.__tifo.store.cells).join(','));
  await e.ctx.close();
  const sc = await api(`/api/designs/${fan.design}/scene`, fan.token);
  const scene = sc.json?.sceneGzB64 ? await gunzipJson(sc.json.sceneGzB64) : null;
  check('saved: the layer and the sign keep their Pro voice', scene?.layers?.objects?.some((o) => o.kind === 'text' && o.fontId === 'block') && scene?.banners?.banners?.[0]?.items?.some((i) => i.fontId === 'block'), JSON.stringify(scene?.layers?.objects?.map((o) => o.fontId)));
}
{
  // Reopened, in a fresh browser.
  const e = await editor(fan.token, `/app?project=${fan.design}&e2e=1`);
  const { p } = e;
  check('reopened: the layer is back in its Pro voice', await waitFor(p, () => window.__tifo.objects.list().some((o) => o.kind === 'text' && o.fontId === 'block' && /TifoProBlock/.test(o.fontCss)), null, 20000));
  check('…its faces load with the design', await waitFor(p, () => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === 'TifoProBlock' && x.status === 'loaded').length === 2));
  check('…and exactly its seats', (await p.evaluate(() => Array.from(window.__tifo.store.cells).join(','))) === savedCells);
  await p.evaluate(() => window.__tifo.objects.select(window.__tifo.objects.list().find((o) => o.kind === 'text').id));
  await p.waitForTimeout(300);
  const pk = await pickers(p);
  check('…selected, its picker shows it, crowned', pk['obj-font'].value === 'block' && pk['obj-font'].chip?.shown, JSON.stringify(pk['obj-font']));
  check('…and the sign\'s letters are still Block', await waitFor(p, () => window.__tifoProFonts?.banners().some((b) => b.fontId === 'block')));
  await e.ctx.close();
}

// =====================================================================
console.log('\n— opened by an account Pro is not on for —');
{
  await api(`/api/designs/${fan.design}`, fan.token, { method: 'PATCH', body: JSON.stringify({ isPublic: true }) });
  // In the stadium, where the sign is drawn.
  const e = await editor(other.token, `/app?design=${fan.design}&e2e=1`);
  const { p } = e;
  check('the seats are the design\'s', await waitFor(p, (c) => Array.from(window.__tifo.store.cells).join(',') === c, savedCells, 20000));
  check('in the Design view, nothing Pro is fetched yet (no banner is drawn there)', !e.asked.some((u) => /proFont|lalezar/.test(u)));
  await p.click('#view-3d');
  check('the sign\'s Pro face loads for them too, to draw it', await waitFor(p, () => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === 'TifoProBlock' && x.status === 'loaded').length === 2, null, 45000));
  check('…that voice\'s two files and no other Pro voice\'s', e.asked.some((u) => /lalezar-arabic/.test(u)) && e.asked.some((u) => /bowlby-one-latin/.test(u)) && !e.asked.some((u) => /reem-kufi|black-ops|lemonada|rakkas|marhey/.test(u)),
    e.asked.filter((u) => /woff2/.test(u)).map((u) => u.split('/').pop()).join(' '));
  const pk = await pickers(p);
  check('…while their pickers stay free', PICKERS.every((id) => !pk[id].group && pk[id].pro === 0) && pk['text-font'].chips === 0);
  await p.waitForTimeout(1500);
  await shot(p, 'pf-other-stadium');
  await e.ctx.close();
}
{
  // The same design as their own (a Pro gift that has ended): the layer travels too.
  const d = await api(`/api/designs/${fan.design}`, fan.token);
  const sc = await api(`/api/designs/${fan.design}/scene`, fan.token);
  const nd = await api('/api/designs', other.token, { method: 'POST', body: JSON.stringify({ title: 'after the gift', templateId: d.json.templateId, templateVersion: d.json.templateVersion, palette: d.json.palette, cellsGzB64: d.json.cellsGzB64 }) });
  const put = await api(`/api/designs/${nd.json?.id}/scene`, other.token, { method: 'PUT', body: JSON.stringify({ sceneGzB64: sc.json.sceneGzB64 }) });
  check('(their copy, with its layers)', !!nd.json?.id && put.status < 300, `${nd.status} ${put.status}`);
  const e = await editor(other.token, `/app?project=${nd.json.id}&e2e=1`);
  const { p } = e;
  check('their text layer opens in the Pro voice', await waitFor(p, () => window.__tifo.objects.list().some((o) => o.kind === 'text' && o.fontId === 'block' && /TifoProBlock/.test(o.fontCss)), null, 20000));
  check('…and its faces load, though their pickers do not offer it', await waitFor(p, () => [...document.fonts].filter((x) => x.family.replace(/"/g, '') === 'TifoProBlock' && x.status === 'loaded').length === 2) && !(await pickers(p))['obj-font'].group);
  const redraw = await p.evaluate(async () => {
    const { objects } = window.__tifo;
    const o = objects.list().find((x) => x.kind === 'text');
    const shape = (g) => Array.from(g.data, (v) => (v >= 0 ? 1 : 0)).join('');
    const before = shape(o.grid);
    objects.update(o.id, { colorIndex: 1 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const now = objects.list().find((x) => x.id === o.id);
    return { same: shape(now.grid) === before, redrawn: now.gridKey !== o.gridKey || now.colorIndex === 1, cells: before.length };
  });
  check('a colour change redraws it in the Pro face, seat for seat the same shape', redraw.same && redraw.redrawn, JSON.stringify(redraw));
  await p.evaluate(() => window.__tifo.objects.select(window.__tifo.objects.list().find((o) => o.kind === 'text').id));
  await p.waitForTimeout(300);
  const shown = await p.evaluate(() => { const s = document.getElementById('obj-font'); return { value: s.value, name: s.selectedOptions[0]?.textContent, group: !!s.querySelector('optgroup'), chip: !!document.querySelector('.pfont-chip') }; });
  check('…its panel names the voice it is set in, with no Pro group and no crown', shown.value === 'block' && shown.name === 'Block' && !shown.group && !shown.chip, JSON.stringify(shown));
  await e.ctx.close();
}

// =====================================================================
console.log('\n— in Arabic, and with Pro running —');
{
  const e = await editor(fan.token, `/ar/app?project=${fan.design}&e2e=1`, { lang: 'ar' });
  check('the group is "♛ خطوط مميّزة"', await waitFor(e.p, () => document.querySelector('#text-font > optgroup.pfont-group')?.label === '♛ خطوط مميّزة'));
  await e.p.evaluate(() => window.__tifo.objects.select(window.__tifo.objects.list().find((o) => o.kind === 'text').id));
  await e.p.waitForTimeout(300);
  const pk = await pickers(e.p);
  check('…the crown says مميّز', pk['obj-font'].chip?.shown && pk['obj-font'].chip.text === 'مميّز', JSON.stringify(pk['obj-font'].chip));
  check('…and the export sheet would say "الخطوط المميّزة"', JSON.stringify(await e.p.evaluate(() => window.__tifoProFonts.items())) === '["الخطوط المميّزة"]');
  await shot(e.p, 'pf-arabic');
  await e.ctx.close();
}
{
  const g = await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' });
  check('(the gift, accepted)', g.status < 300, String(g.status));
  const e = await editor(fan.token, `/app?project=${fan.design}&e2e=1`);
  await waitFor(e.p, () => !!document.querySelector('#obj-font > optgroup.pfont-group'));
  await e.p.evaluate(() => window.__tifo.objects.select(window.__tifo.objects.list().find((o) => o.kind === 'text').id));
  check('with Pro running, the crown is quiet', await waitFor(e.p, () => !!document.querySelector('#obj-font + .pfont-chip .pro-chip.quiet') && getComputedStyle(document.querySelector('#obj-font + .pfont-chip')).display !== 'none'));
  await e.ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
