/**
 * Club kit (Pro, src/ui/clubKit.ts and src/ui/clubKitStore.ts) in a real
 * browser against real servers:
 *
 *   not on the list   no Club kit anywhere, and its code never loads;
 *   on the list       "Club kit" in the Colours panel, crowned (gold: Pro is
 *                     not running); saving this design as a kit keeps its
 *                     colours (less one left out), its picture as a logo and
 *                     the Text tool's font (a Pro voice), across a reload;
 *                     using it in another project sets the palette (the empty
 *                     seat kept, every seat on a kit colour), the Text tool's
 *                     font, and puts the logo in Import image, ready to place,
 *                     with Real colours off; placing it keeps the palette;
 *                     the kit is ONE undo step, palette and seats, and redo
 *                     brings it back;
 *   free try          the second use by a free account opens the gift sheet
 *                     instead, and changes nothing;
 *   Pro running       after the gift is accepted there is no limit and the
 *                     crown is quiet;
 *   bad data          what is planted in IndexedDB is checked: bad colours,
 *                     logos, fonts, names and records are left out (and the
 *                     store tidied), the rest move up to the account cleaned,
 *                     at most 3 kits are shown, and a name is only ever text;
 *   Arabic, a phone   the words in Arabic; at 390px every target is 44px,
 *                     the sheet sits at the bottom, nothing scrolls sideways,
 *                     and an added logo comes up in the import sheet;
 *   PRO_MODE off      nothing, even for a name that would be on the list.
 *
 * Self-contained: it boots its own servers (ports 8963 and 8964) on memory
 * repos. Needs a build:  npm run build && node e2e-pro-kit.mjs
 * KIT_SHOTS=<dir> also saves screenshots of what it looks at.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { deflateSync, gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8963;
const PORT_OFF = 8964;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const SHOTS = process.env.KIT_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'kit_fan,kit_ar' });
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
const templates = {};
const tplOf = async (base) => (templates[base] ??= (await api('/api/templates', null, {}, base)).json[0]);
/** A saved design: its palette, and seats painted by `paint(i, count)`. */
const design = async (token, title, palette, paint = () => 0, base = B) => {
  const tpl = await tplOf(base);
  const cells = new Uint8Array(tpl.seatCount);
  for (let i = 0; i < cells.length; i++) cells[i] = paint(i, cells.length);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title, templateId: tpl.id, templateVersion: tpl.version, palette, cellsGzB64: gzipSync(cells).toString('base64') }) }, base);
  return d.json?.id;
};
/** A verified account with one saved design (what the gift asks for). */
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  return { token, design: await design(token, `${username} wall`, ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], () => 0, base) };
};

// ---------------------------------------------------- a crest, as a PNG ---
/** A round crest on a transparent ground, written as a PNG in Node. */
function crestPng(w = 160, h = 160) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - w / 2, y - h / 2);
      let c = null;
      if (r < 72) c = [28, 95, 217];
      if (r < 56 && r > 46) c = [242, 241, 236];
      if (r < 22) c = [242, 241, 236];
      if (!c) continue;
      const p = (y * w + x) * 4;
      px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
    }
  }
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const CREST = crestPng();

const fan = await account('kit_fan');
const other = await account('kit_other');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
/** A browser of its own (its own IndexedDB), signed in. */
const browserFor = async (token, { lang = 'en', w = 1440, h = 900, phone = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_view_v1: '2d', tifo_lang_v1: lang })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
/** Open a project in the editor (again: the same browser keeps its kits). */
const open = async (p, id, title, { lang = 'en', base = B } = {}) => {
  await p.goto(`${base}${lang === 'ar' ? '/ar' : ''}/app?project=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!window.__tifo, null, 90000);
  await waitFor(p, (t) => document.getElementById('doc-title')?.value === t, title, 30000);
  await p.waitForTimeout(800);
};
const entryShown = (p) => waitFor(p, () => { const b = document.querySelector('.kit-entry'); return !!b && !b.hidden && b.getClientRects().length > 0; }, null, 20000);
const openSheet = async (p) => {
  await p.click('.kit-entry');
  return waitFor(p, () => !!document.querySelector('.kit-sheet h2') && !/Opening|نفتح/.test(document.querySelector('.kit-sheet')?.textContent || ''));
};
const closeSheet = async (p) => {
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
};
/** Text as read, without the isolate marks a kit's name carries inside a sentence. */
const text = async (p, sel) => (await p.textContent(sel) || '').replace(/[\u2068\u2069]/g, '');
const seats = (p) => p.evaluate(() => { const c = window.__tifo.store.cells; let h = 2166136261; for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i], 16777619); return (h >>> 0).toString(16); });
const palette = (p) => p.evaluate(() => window.__tifo.store.palette.slice());
/** A screenshot, once the sheet's entrance has finished. */
const shot = async (p, name) => { if (!SHOTS) return; await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const { ctx, p } = await browserFor(other.token);
  await open(p, other.design, 'kit_other wall');
  await p.waitForTimeout(1500);
  const seen = await p.evaluate(() => ({
    entry: !!document.querySelector('.kit-entry'),
    strip: !!document.querySelector('.kit-logos-field'),
    hook: '__tifoClubKit' in window,
    crowns: [...document.querySelectorAll('.pro-crown')].filter((c) => c.getClientRects().length > 0).length,
    code: performance.getEntriesByType('resource').some((e) => /clubKit-/.test(e.name)),
    links: [...document.querySelectorAll('#ctx-colors .palette-links button')].map((b) => b.id),
  }));
  check('no Club kit, no crown, and its code never loads', !seen.entry && !seen.strip && !seen.hook && seen.crowns === 0 && !seen.code, JSON.stringify(seen));
  check('…the Colours panel is as it was: Import palette and Save palette', JSON.stringify(seen.links) === JSON.stringify(['palette-import', 'palette-save']), JSON.stringify(seen.links));
  await ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list (Pro not running) —');
const { ctx: fanCtx, p } = await browserFor(fan.token);
const away = await design(fan.token, 'kit_fan away', ['#262a33', '#00aa44', '#ffffff', '#d01f2f', '#1c5fd9'], (i, n) => (i < n / 4 ? 4 : i < n / 2 ? 3 : 0));
const third = await design(fan.token, 'kit_fan third', ['#262a33', '#7c1218', '#f2f1ec'], (i, n) => (i < n / 3 ? 1 : 0));
let kitPalette = null;
{
  await open(p, fan.design, 'kit_fan wall');
  check('"Club kit" sits in the Colours panel', await entryShown(p));
  const entry = await p.evaluate(() => {
    const b = document.querySelector('.kit-entry');
    return { text: b.textContent, after: b.previousElementSibling?.id, chip: !!b.querySelector('.pro-chip .pro-crown'), quiet: !!b.querySelector('.pro-chip.quiet'), blue: b.matches('.primary, .pro-primary') };
  });
  check('…after Save palette, crowned in gold (not quiet: Pro is not running), and not blue', /^Club kitPro$/.test(entry.text) && entry.after === 'palette-save' && entry.chip && !entry.quiet && !entry.blue, JSON.stringify(entry));

  // A picture in the design (the crest), and a Pro voice for the Text tool.
  await p.setInputFiles('#import-file', { name: 'crest.png', mimeType: 'image/png', buffer: CREST });
  await waitFor(p, () => !document.getElementById('import-apply').disabled);
  // Without Real colours, so the design keeps its own three colours.
  await p.uncheck('#real-colors');
  await p.click('#import-apply');
  await waitFor(p, () => window.__tifo.objects.pictureCount() === 1);
  await waitFor(p, () => !!document.querySelector('#text-font option[value="block"]'));
  await p.evaluate(() => { const s = document.getElementById('text-font'); s.value = 'block'; s.dispatchEvent(new Event('change')); });
  await p.click('[data-tool="brush"]');
  await entryShown(p);

  check('the sheet opens', await openSheet(p));
  const empty = await p.evaluate(() => ({
    h2: document.querySelector('.kit-sheet h2')?.textContent,
    empty: document.querySelector('.kit-empty')?.textContent,
    free: document.querySelector('.kit-free')?.textContent,
    blue: [...document.querySelectorAll('.kit-sheet .pro-primary')].map((b) => b.textContent),
    dialog: document.querySelector('.kit-sheet')?.getAttribute('role'),
  }));
  check('…empty: says what is missing, with one blue step, "Save this design as a kit"', /No kit yet/.test(empty.empty || '') && JSON.stringify(empty.blue) === JSON.stringify(['Save this design as a kit']) && empty.dialog === 'dialog', JSON.stringify(empty));
  check('…and says it is free to try once', /Free to try in one project/.test(empty.free || ''), empty.free);
  await shot(p, '1440-en-empty');

  await p.click('.kit-sheet [data-act="new"]');
  check('Save this design as a kit: a form', await waitFor(p, () => !!document.getElementById('kit-name')));
  const form = await p.evaluate(() => ({
    name: document.getElementById('kit-name').value,
    nameLabel: document.querySelector('label[for="kit-name"]')?.textContent,
    colours: [...document.querySelectorAll('.kit-colour')].map((b) => [b.dataset.c, b.getAttribute('aria-pressed'), b.getAttribute('aria-label')]),
    pics: [...document.querySelectorAll('.kit-pic')].map((b) => [b.getAttribute('aria-pressed'), b.getAttribute('aria-label')]),
    font: document.getElementById('kit-font').value,
    fontLabel: document.querySelector('label[for="kit-font"]')?.textContent,
    pro: [...document.querySelectorAll('#kit-font optgroup option')].map((o) => o.value),
  }));
  check('…the design\'s three colours, all in', JSON.stringify(form.colours.map((c) => c[0])) === JSON.stringify(['#1c5fd9', '#f2f1ec', '#e8b73a']) && form.colours.every((c) => c[1] === 'true' && /^Colour #/.test(c[2])), JSON.stringify(form.colours));
  check('…its picture, picked as a logo', form.pics.length === 1 && form.pics[0][0] === 'true' && /crest\.png, as a logo/.test(form.pics[0][1]), JSON.stringify(form.pics));
  check('…the Text tool\'s font (a Pro voice), and the Pro voices listed', form.font === 'block' && form.pro.includes('marker') && form.fontLabel === 'Font', JSON.stringify(form));
  check('…named after the project, every control labelled', form.name === 'kit_fan wall' && form.nameLabel === 'Name');
  await shot(p, '1440-en-form');
  await p.click('.kit-colour[data-c="#e8b73a"]');
  check('tapping a colour leaves it out', await p.evaluate(() => document.querySelector('.kit-colour[data-c="#e8b73a"]').getAttribute('aria-pressed') === 'false'));
  await p.click('.kit-colour[data-c="#1c5fd9"]');
  await p.click('.kit-colour[data-c="#f2f1ec"]');
  check('…but the last one stays, and says why', await p.evaluate(() => document.querySelector('.kit-colour[data-c="#f2f1ec"]').getAttribute('aria-pressed') === 'true' && /at least one colour/.test(document.querySelector('.kit-note').textContent)));
  await p.click('.kit-colour[data-c="#1c5fd9"]');
  await p.fill('#kit-name', 'Blue Wave');
  await p.click('.kit-sheet [data-act="save"]');
  check('Save kit: the kit is a card', await waitFor(p, () => document.querySelector('.kit-card .kit-name')?.textContent === 'Blue Wave'));
  const card = await p.evaluate(() => {
    const c = document.querySelector('.kit-card');
    return {
      strip: [...c.querySelectorAll('.kit-strip span')].map((s) => getComputedStyle(s).backgroundColor),
      logos: c.querySelectorAll('canvas.kit-logo').length,
      font: c.querySelector('.kit-font')?.textContent,
      use: c.querySelector('.kit-use')?.textContent,
      useBlue: c.querySelector('.kit-use').matches('.primary, .pro-primary'),
      quiet: [...c.querySelectorAll('.kit-link')].map((b) => b.textContent),
      note: document.querySelector('.kit-note')?.textContent.replace(/[\u2068\u2069]/g, ''),
      blue: document.querySelectorAll('.kit-sheet .pro-primary').length,
    };
  });
  check('…a colour strip of the two kept colours, one logo, "Font: Block"', JSON.stringify(card.strip) === JSON.stringify(['rgb(28, 95, 217)', 'rgb(242, 241, 236)']) && card.logos === 1 && card.font === 'Font: Block', JSON.stringify(card));
  check('…"Use in this project" (tinted, not blue), Rename and Delete quiet, no blue left on the sheet', card.use === 'Use in this project' && !card.useBlue && JSON.stringify(card.quiet) === JSON.stringify(['Rename', 'Delete']) && card.blue === 0, JSON.stringify(card));
  check('…and the status line says it is saved', /Saved “Blue Wave”/.test(card.note || ''), card.note);
  await shot(p, '1440-en-list');
  const kept = await p.evaluate(() => window.__tifoClubKit.kits());
  kitPalette = ['#262a33', ...kept[0].colors];
  check('…kept as two colours, one logo and the font', kept.length === 1 && JSON.stringify(kept[0].colors) === JSON.stringify(['#1c5fd9', '#f2f1ec']) && kept[0].logos === 1 && kept[0].font === 'block', JSON.stringify(kept));

  // Rename: a quiet action, through the editor's own dialog.
  await p.click('.kit-card [data-act="rename"]');
  await waitFor(p, () => !!document.querySelector('.dlg .dlg-input'));
  await p.fill('.dlg .dlg-input', 'Blue Wave FC');
  await p.click('.dlg .dlg-confirm');
  check('Rename changes the name', await waitFor(p, () => document.querySelector('.kit-card .kit-name')?.textContent === 'Blue Wave FC' && !!document.querySelector('.kit-backdrop')));
  await closeSheet(p);
}
{
  // Across a reload: the same browser, the page opened again.
  await open(p, fan.design, 'kit_fan wall');
  await entryShown(p);
  await openSheet(p);
  const again = await p.evaluate(() => ({ kits: window.__tifoClubKit.kits(), canvases: document.querySelectorAll('.kit-card canvas.kit-logo').length, kept: window.__tifoClubKit.kept() }));
  check('after a reload the kit is still there: its colours, its logo and its font', again.kept && again.kits.length === 1 && again.kits[0].name === 'Blue Wave FC' && JSON.stringify(again.kits[0].colors) === JSON.stringify(['#1c5fd9', '#f2f1ec']) && again.kits[0].logos === 1 && again.kits[0].font === 'block' && again.canvases === 1, JSON.stringify(again));
  const drawn = await p.evaluate(() => { const c = document.querySelector('.kit-card canvas.kit-logo'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check('…and the logo is drawn from what was kept', drawn > 1000, String(drawn));
  await closeSheet(p);
}
{
  // Another project: the kit in one tap.
  await open(p, away, 'kit_fan away');
  const before = { palette: await palette(p), seats: await seats(p), font: await p.evaluate(() => document.getElementById('text-font').value) };
  await entryShown(p);
  await openSheet(p);
  await p.click('.kit-card [data-act="use"]');
  check('Use in this project: the sheet closes and the logo waits in Import image', await waitFor(p, () => !document.querySelector('.kit-backdrop') && !document.getElementById('import-bar').hidden && !document.getElementById('import-apply').disabled));
  const used = await p.evaluate(() => {
    const { store } = window.__tifo;
    let max = 0, onKit = 0, empty = 0;
    for (const v of store.cells) { if (v > max) max = v; if (v === 1) onKit++; if (v === 0) empty++; }
    return {
      palette: store.palette.slice(), max, onKit, empty,
      font: document.getElementById('text-font').value,
      name: document.getElementById('import-name').textContent,
      strip: [...document.querySelectorAll('.kit-logos-field:not([hidden]) .kit-logo-btn')].map((b) => [b.getAttribute('aria-pressed'), b.getAttribute('aria-label')]),
      label: document.querySelector('.kit-logos-label')?.textContent,
      real: document.getElementById('real-colors').checked,
      swatches: document.querySelectorAll('#palette .swatch').length,
      free: window.__tifoClubKit.freeUsed(),
    };
  });
  check('the palette is the kit\'s, after this design\'s empty seat', JSON.stringify(used.palette) === JSON.stringify(kitPalette) && used.swatches === 2, JSON.stringify(used.palette));
  check('every seat is on a kit colour (those past its end too), the blue ones on its blue', used.max < kitPalette.length && used.onKit > 0, JSON.stringify({ max: used.max, onKit: used.onKit }));
  check('the Text tool\'s font is the kit\'s', used.font === 'block' && before.font !== 'block', `${before.font} → ${used.font}`);
  check('the logo is in Import image, named for the kit, with the kit\'s logos beside it', used.name === 'Blue Wave FC 1.png' && used.label === 'Kit logos' && used.strip.length === 1 && used.strip[0][0] === 'true' && /Logo 1 of “Blue Wave FC”/.test(used.strip[0][1]), JSON.stringify(used));
  check('…Real colours off while it waits (it is drawn in the kit\'s colours)', used.real === false);
  check('…and the status line says so', await waitFor(p, () => /“Blue Wave FC” is in\. Logo 1 of 1 is ready/.test(document.getElementById('message').textContent.replace(/[\u2068\u2069]/g, ''))), await text(p, '#message'));
  check('the free try is spent', used.free === 1, String(used.free));
  await shot(p, '1440-en-import-bar');
  const usedSeats = await seats(p);
  await p.click('#import-apply');
  check('Place puts the logo down as a picture layer', await waitFor(p, () => window.__tifo.objects.pictureCount() === 1));
  const placed = await p.evaluate(() => ({ palette: window.__tifo.store.palette.length, real: document.getElementById('real-colors').checked, offered: window.__tifoClubKit.offered() }));
  check('…in the kit\'s colours (the palette did not grow), and Real colours is as it was', placed.palette === kitPalette.length && placed.real === true && placed.offered?.placed[0] === true, JSON.stringify(placed));
  await p.click('#undo');
  await waitFor(p, () => window.__tifo.objects.pictureCount() === 0);
  check('undo takes the logo back', (await seats(p)) === usedSeats);
  await p.click('#undo');
  const undone = await p.evaluate(() => ({ palette: window.__tifo.store.palette.slice(), canUndo: window.__tifo.store.canUndo, swatches: document.querySelectorAll('#palette .swatch').length }));
  check('ONE more undo takes the whole kit back: the palette and every seat, and nothing is left to undo', JSON.stringify(undone.palette) === JSON.stringify(before.palette) && (await seats(p)) === before.seats && !undone.canUndo && undone.swatches === 4, JSON.stringify(undone));
  await p.click('#redo');
  check('…and redo brings it back', JSON.stringify(await palette(p)) === JSON.stringify(kitPalette) && (await seats(p)) === usedSeats);
}
{
  // The second use by an account without Pro running. (Club kit lives in the
  // Colours panel, which shows with the painting tools.)
  await p.click('[data-tool="brush"]');
  await entryShown(p);
  await openSheet(p);
  check('the sheet now says the free go is used', /You’ve had your free go/.test(await p.textContent('.kit-free')));
  const pal = await palette(p);
  await p.evaluate(() => { window.__tifo.store.setPalette(['#262a33', '#123456']); });
  const was = await palette(p);
  await p.click('.kit-card [data-act="use"]');
  check('Use a second time opens the gift sheet instead', await waitFor(p, () => /Your 7-day Pro gift/.test(document.querySelector('.pro-sheet:not(.kit-sheet) h2')?.textContent || '')));
  check('…and the kit was not used', JSON.stringify(await palette(p)) === JSON.stringify(was));
  await shot(p, '1440-en-gift');
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.pro-sheet-backdrop'));
  await p.evaluate((pal) => window.__tifo.store.setPalette(pal), pal);
}
{
  // Pro running: the gift, accepted.
  const g = await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' });
  check('(the gift starts)', g.status === 200, String(g.status));
  await open(p, third, 'kit_fan third');
  await entryShown(p);
  check('with Pro running the crown is quiet', await waitFor(p, () => !!document.querySelector('.kit-entry .pro-chip.quiet')));
  await openSheet(p);
  const sheet = await p.evaluate(() => ({ free: !!document.querySelector('.kit-free'), quiet: !!document.querySelector('.kit-sheet h2 .pro-chip.quiet') }));
  check('…in the sheet too, with no "free to try" line', !sheet.free && sheet.quiet, JSON.stringify(sheet));
  await p.click('.kit-card [data-act="use"]');
  check('…and Use works again: no limit', await waitFor(p, () => JSON.stringify(window.__tifo.store.palette) === JSON.stringify(['#262a33', '#1c5fd9', '#f2f1ec'])));
  await waitFor(p, () => !document.getElementById('import-apply').disabled);
  await p.click('#import-cancel');
  check('Cancel leaves the logo unplaced, and Real colours as it was', await waitFor(p, () => window.__tifo.objects.pictureCount() === 0 && document.getElementById('real-colors').checked && window.__tifoClubKit.offered()?.placed[0] === false));
  // A design at its picture limit: the kit's colours go in, its logos wait.
  const limit = await p.evaluate(async () => {
    const c = new OffscreenCanvas(32, 32);
    c.getContext('2d').fillRect(0, 0, 32, 32);
    const bmp = await createImageBitmap(c);
    const { objects } = window.__tifo;
    for (let i = 0; i < 12; i++) objects.addImage({ cx: 400 + i * 300, cy: 300, width: 96, height: 96, colorIndex: 0, tier: null, bitmap: bmp, name: `p${i}.png`, dither: false, alphaThreshold: 128 });
    objects.select(null);
    return objects.pictureCount();
  });
  await p.click('[data-tool="brush"]');
  await entryShown(p);
  await openSheet(p);
  await p.click('.kit-card [data-act="use"]');
  check(`at ${limit} pictures the logo is not put in Import image, and the status line says why`, await waitFor(p, () => /has 12 pictures, the most there is/.test(document.getElementById('message').textContent)) && (await p.evaluate(() => document.getElementById('import-bar').hidden && window.__tifo.objects.pictureCount() === 12)));
}
{
  // Bad data in IndexedDB.
  await p.evaluate(async () => {
    const big = await (() => { const c = new OffscreenCanvas(600, 600); c.getContext('2d').fillRect(0, 0, 600, 600); return c.convertToBlob({ type: 'image/png' }); })();
    const tiny = await (() => { const c = new OffscreenCanvas(40, 40); c.getContext('2d').fillRect(0, 0, 40, 40); return c.convertToBlob({ type: 'image/png' }); })();
    const db = await new Promise((res, rej) => { const r = indexedDB.open('tifo_club_kits'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('kits', 'readwrite');
      const s = tx.objectStore('kits');
      s.put({ v: 1, name: '<img src=x onerror="window.__kitXss=1">Evil‮', colors: ['#zzzzzz', 'red', '#00FF00', 7], logos: [new Blob(['not a png'], { type: 'image/png' }), 'a string', tiny], font: 'comic-sans', at: 5 }, 'kevil00001');
      s.put({ v: 1, name: 'Big logo', colors: ['#ff0000'], logos: [big], font: 'kufi', at: 6 }, 'kbiglogo01');
      s.put({ v: 1, name: 'Not an id', colors: ['#ffffff'], logos: [], font: '', at: 1 }, 'not a valid id!');
      s.put('just a string', 'kstring001');
      s.put({ v: 1, name: 'No colours', colors: ['nope'], logos: [], font: '', at: 2 }, 'knocolour1');
      s.put({ v: 2, name: 'Future', colors: ['#ffffff'], logos: [], font: '', at: 3 }, 'kfuture001');
      s.put({ v: 1, name: 'Fourth', colors: ['#abcdef'], logos: [], font: '', at: Date.now() + 1e6 }, 'kfourth001');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  await open(p, third, 'kit_fan third');
  await entryShown(p);
  await openSheet(p);
  const bad = await p.evaluate(() => ({
    names: [...document.querySelectorAll('.kit-card .kit-name')].map((n) => n.textContent),
    imgs: document.querySelectorAll('.kit-sheet img').length,
    xss: '__kitXss' in window,
    kits: window.__tifoClubKit.kits(),
    note: document.querySelector('.kit-note')?.textContent,
    full: [...document.querySelectorAll('.kit-hint')].some((h) => /You have 3 kits/.test(h.textContent)),
    saveDisabled: document.querySelector('.kit-sheet [data-act="new"]').disabled,
    evilFont: document.querySelector('.kit-card .kit-font')?.textContent,
  }));
  // The planted name is cut at 40 characters, as every kit name is.
  check('only the 3 oldest valid kits are shown, in order', JSON.stringify(bad.names) === JSON.stringify(['<img src=x onerror="window.__kitXss=1">E', 'Big logo', 'Blue Wave FC']), JSON.stringify(bad.names));
  check('…a name is only ever text (no element, nothing run, the direction override gone)', bad.imgs === 0 && !bad.xss);
  const evil = bad.kits[0], big = bad.kits[1];
  check('…bad colours, logos and fonts are left out', JSON.stringify(evil.colors) === JSON.stringify(['#00ff00']) && evil.logos === 1 && evil.font === '' && bad.evilFont === 'No font', JSON.stringify(evil));
  check('…a logo larger than 512px is left out', big.logos === 0 && big.font === 'kufi', JSON.stringify(big));
  check('…the sheet says part of a kit was left out, and that 3 is the most', /couldn’t be read/.test(bad.note || '') && bad.full && bad.saveDisabled, JSON.stringify({ note: bad.note, full: bad.full }));
  const stored = await p.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('tifo_club_kits'); r.onsuccess = () => res(r.result); });
    const read = (q) => new Promise((res) => { const r = q; r.onsuccess = () => res(r.result); });
    const tx = db.transaction('kits');
    const keys = await read(tx.objectStore('kits').getAllKeys());
    db.close();
    return { keys: keys.sort() };
  });
  // Signed in, the browser's kits move up to the account (cleaned on the way), and the account holds three.
  check('…and the store is tidied: bad records gone, the two that fitted moved up to the account, the 4th left here', JSON.stringify(stored.keys) === JSON.stringify(['kfourth001']), JSON.stringify(stored));
  const onAccount = (await api('/api/pro/kits', fan.token)).json?.kits ?? [];
  check('…on the account cleaned, as the browser cleaned them', onAccount.length === 3 && JSON.stringify(onAccount[0].colours) === JSON.stringify(['#00ff00']) && onAccount[0].logos.length === 1 && onAccount[0].font === '' && !/‮/.test(onAccount[0].name), JSON.stringify(onAccount.map((k) => [k.name, k.colours, k.logos.length, k.font])));
  check('…and the sheet says the one left did not fit', /didn’t fit: your account has 3 already/.test(await p.textContent('.kit-sheet')));
  await shot(p, '1440-en-bad-data');
  // Delete: asks first, and the 4th kit comes back next time.
  await p.click('.kit-card [data-act="delete"]');
  await waitFor(p, () => !!document.querySelector('.dlg .dlg-confirm'));
  check('Delete asks first, with "Keep it" as the way back', /^Delete “<img/.test(await text(p, '.dlg-title')) && (await p.textContent('.dlg .dlg-cancel')) === 'Keep it');
  await p.click('.dlg .dlg-confirm');
  check('…and the kit goes', await waitFor(p, () => document.querySelectorAll('.kit-card').length === 2 && /Deleted/.test(document.querySelector('.kit-note')?.textContent || '')));
  await closeSheet(p);
}
await fanCtx.close();

// =====================================================================
console.log('\n— Arabic, and a phone —');
const ar = await account('kit_ar');
await api('/api/pro/gift/accept', ar.token, { method: 'POST', body: '{}' });
{
  const { ctx, p } = await browserFor(ar.token, { lang: 'ar' });
  await open(p, ar.design, 'kit_ar wall', { lang: 'ar' });
  check('in Arabic: "هوية النادي", crowned مميّز', await entryShown(p) && await waitFor(p, () => /^هوية الناديمميّز$/.test(document.querySelector('.kit-entry')?.textContent || '')));
  await openSheet(p);
  const words = await p.evaluate(() => ({ dir: document.documentElement.dir, h2: document.querySelector('.kit-sheet h2')?.textContent, save: document.querySelector('.kit-sheet [data-act="new"]')?.textContent, body: document.querySelector('.kit-sheet')?.textContent }));
  check('…the sheet in Arabic, right to left, no English left', words.dir === 'rtl' && words.h2 === 'هوية الناديمميّز' && words.save === 'احفظ هالتصميم كهوية' && !/[A-Za-z]{3,}/.test(words.body.replace(/Pro|PNG|JPG/g, '')), JSON.stringify(words));
  await shot(p, '1440-ar-empty');
  await p.click('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await shot(p, '1440-ar-form');
  await p.fill('#kit-name', 'الموج الأزرق');
  await p.click('.kit-sheet [data-act="save"]');
  check('…saving says so in Arabic', await waitFor(p, () => /انحفظت «الموج الأزرق»/.test((document.querySelector('.kit-note')?.textContent || '').replace(/[\u2068\u2069]/g, ''))));
  await shot(p, '1440-ar-list');
  await ctx.close();
}
{
  const { ctx, p } = await browserFor(ar.token, { w: 390, h: 844, phone: true });
  await open(p, ar.design, 'kit_ar wall');
  await p.tap('.m-tab[data-tab="colors"]');
  check('on a phone, Club kit is in the Colours sheet, 44px tall', await entryShown(p) && (await p.evaluate(() => document.querySelector('.kit-entry').getBoundingClientRect().height)) >= 44);
  await p.tap('.kit-entry');
  await waitFor(p, () => !!document.querySelector('.kit-sheet [data-act="new"]'));
  await p.waitForTimeout(500);
  const sheet = await p.evaluate(() => { const r = document.querySelector('.kit-sheet').getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), width: Math.round(r.width), close: document.querySelector('.kit-sheet .pro-sheet-close').getBoundingClientRect().height }; });
  check('…the sheet is a bottom sheet, the width of the phone, its close button 44px', sheet.bottom <= 1 && sheet.width === 390 && sheet.close >= 44, JSON.stringify(sheet));
  await shot(p, '390-en-empty');
  await p.tap('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.setInputFiles('input.kit-logo-file', { name: 'crest.png', mimeType: 'image/png', buffer: CREST });
  check('…"Add a logo" adds one, picked', await waitFor(p, () => document.querySelector('.kit-pic')?.getAttribute('aria-pressed') === 'true'));
  const targets = await p.evaluate(() => [...document.querySelectorAll('.kit-sheet button, .kit-sheet input, .kit-sheet select')]
    .filter((b) => b.getClientRects().length > 0 && !b.classList.contains('pro-text-btn'))
    .map((b) => [b.className || b.id, Math.round(b.getBoundingClientRect().height), Math.round(b.getBoundingClientRect().width)])
    .filter(([, h, w]) => h < 44 || w < 44));
  check('…every control in the form is at least 44px', targets.length === 0, JSON.stringify(targets));
  await shot(p, '390-en-form');
  await p.fill('#kit-name', 'Phone kit');
  await p.tap('.kit-sheet [data-act="save"]');
  // The kit saved in Arabic on the laptop is on the account, so the phone has it too.
  check('…the phone has the kit saved on the laptop, and its own', await waitFor(p, () => JSON.stringify([...document.querySelectorAll('.kit-card .kit-name')].map((n) => n.textContent)) === JSON.stringify(['الموج الأزرق', 'Phone kit'])));
  const list = await p.evaluate(() => ({
    small: [...document.querySelectorAll('.kit-sheet button')].filter((b) => b.getClientRects().length > 0).map((b) => [b.className, Math.round(b.getBoundingClientRect().height)]).filter(([, h]) => h < 44),
    over: document.documentElement.scrollWidth - innerWidth,
    useWidth: Math.round(document.querySelector('.kit-use').getBoundingClientRect().width),
  }));
  check('…the card\'s buttons are 44px, Use spans the card, nothing scrolls sideways', list.small.length === 0 && list.over <= 0 && list.useWidth > 300, JSON.stringify(list));
  await shot(p, '390-en-list');
  // The phone's own kit, the one with a logo (the laptop's has none).
  await p.tap('.kit-card:nth-child(2) [data-act="use"]');
  check('Use on a phone brings the import sheet up with the kit\'s logos', await waitFor(p, () => { const b = document.querySelector('.m-sheet .kit-logos-field:not([hidden]) .kit-logo-btn'); return !!b && b.getBoundingClientRect().height >= 44; }));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('…with nothing scrolling sideways', over <= 0, String(over));
  await shot(p, '390-en-import');
  await ctx.close();
}
{
  // A browser that keeps nothing: the kit still works for the session, and says so.
  const { ctx, p } = await browserFor(ar.token);
  // Opening the kit store throws, as some private windows do; the rest of the editor keeps its storage.
  await ctx.addInitScript(() => {
    const real = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, v) {
      if (name === 'tifo_club_kits') throw new DOMException('no storage here', 'InvalidStateError');
      return real.call(this, name, v);
    };
  });
  await open(p, ar.design, 'kit_ar wall');
  await entryShown(p);
  await openSheet(p);
  check('no storage, signed in: the kits are the account\'s, and the sheet says so', /On your account/.test(await p.textContent('.kit-sheet')) && (await p.evaluate(() => document.querySelectorAll('.kit-card').length)) === 2);
  await closeSheet(p);
  // And with no kits on the account either (the server says none): kits last until the tab is closed.
  await p.route('**/api/pro/kits**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }));
  await open(p, ar.design, 'kit_ar wall');
  await entryShown(p);
  await openSheet(p);
  check('no storage, no account kits: the sheet says kits last until the tab is closed', /isn’t keeping kits/.test(await p.textContent('.kit-sheet')));
  await p.click('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.click('.kit-sheet [data-act="save"]');
  check('…and a kit can still be saved and used this session', await waitFor(p, () => document.querySelectorAll('.kit-card').length === 1 && /isn’t keeping kits/.test(document.querySelector('.kit-note')?.textContent || '')));
  await p.click('.kit-card [data-act="use"]');
  check('…used', await waitFor(p, () => /is in: its colours/.test(document.getElementById('message').textContent)));
  await ctx.close();
}
if (SHOTS) {
  const { ctx, p } = await browserFor(ar.token, { w: 390, h: 844, phone: true, lang: 'ar' });
  await open(p, ar.design, 'kit_ar wall', { lang: 'ar' });
  await p.tap('.m-tab[data-tab="colors"]');
  await entryShown(p);
  await shot(p, '390-ar-colours');
  await p.tap('.kit-entry');
  await waitFor(p, () => !!document.querySelector('.kit-sheet [data-act="new"]'));
  await p.tap('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.setInputFiles('input.kit-logo-file', { name: 'crest.png', mimeType: 'image/png', buffer: CREST });
  await waitFor(p, () => !!document.querySelector('.kit-pic'));
  await p.waitForTimeout(400);
  await shot(p, '390-ar-form');
  await p.tap('.kit-sheet [data-act="save"]');
  await waitFor(p, () => /انحفظت/.test(document.querySelector('.kit-note')?.textContent || ''));
  await p.waitForTimeout(400);
  await shot(p, '390-ar-list');
  await ctx.close();
}

// =====================================================================
console.log('\n— PRO_MODE off —');
{
  const u = await account('kit_fan', OFF);
  const { ctx, p } = await browserFor(u.token);
  await open(p, u.design, 'kit_fan wall', { base: OFF });
  await p.waitForTimeout(1500);
  const seen = await p.evaluate(() => ({ entry: !!document.querySelector('.kit-entry'), code: performance.getEntriesByType('resource').some((e) => /clubKit-/.test(e.name)) }));
  check('no Club kit, even for a name that would be on the list, and no code for it', !seen.entry && !seen.code, JSON.stringify(seen));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
