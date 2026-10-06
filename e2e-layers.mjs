/**
 * Layers in the editor.
 *
 * Text, pictures and shapes used to float only until they were baked into the
 * seats — and every save and every export baked them — so nothing could be
 * moved once it had landed. Now each is a layer of its own, above one Paint
 * layer, for the life of the project. This drives the real editor:
 *
 *   - adding text, a shape and a picture makes a row each in the Layers list;
 *   - the list and the canvas select together; a row picked off screen is framed;
 *   - dragging moves the seats (the old place shows the paint again), the
 *     corner resizes keeping the shape, the handle below turns it (Shift: 15°);
 *   - one Undo takes back a move, a stroke, a merge, a lift — whichever was last;
 *   - a brush stroke over a picture touches up the picture, and the fix moves
 *     with it; the eraser cuts a hole to the paint; the label says so first;
 *   - hide leaves a layer out of the seats; lock stops moving and painting;
 *   - reordering by dragging a row, with the drop line where it lands;
 *   - rename, duplicate, bring forward, merge into paint, delete; the keys;
 *   - Make movable lifts painted seats into a layer;
 *   - no export bakes anything; the .tifo file carries the layers;
 *   - the layers survive a reload, in this browser and in the account, and a
 *     remix (or anyone else opening the design) gets the seats, flat;
 *   - twelve pictures at most;
 *   - on a phone: a Layers tab, big rows, the object bar; in Arabic: mirrored.
 *
 * Needs the dev server on :8911 with a built dist.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const B = process.env.BASE || 'http://127.0.0.1:8911';
const SHOTS = process.env.SHOTS || '';
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const LS = (lang = 'en', extra = []) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  ...extra,
];
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  let json = null;
  try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, json };
};

async function editor({ lang = 'en', viewport = { width: 1440, height: 900 }, url = '/app?new=1&e2e=1', token = null, ls = [] } = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, ls) }] } });
  if (token) await ctx.addInitScript((t) => { try { localStorage.setItem('tifo_token_v1', t); } catch { /* */ } }, token);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  await p.goto(B + url, { waitUntil: 'networkidle', timeout: 90000 });
  await p.waitForFunction(() => !!window.__tifo, null, { timeout: 60000 });
  await p.waitForTimeout(600);
  return { ctx, p, errs };
}

// ---- in-page helpers -----------------------------------------------------------
const st = (p) => p.evaluate(() => {
  const { objects, store } = window.__tifo;
  const sel = objects.selected;
  return {
    n: objects.list().length,
    ids: objects.list().map((o) => o.id),
    sel: sel?.id ?? null,
    selObj: sel ? { cx: sel.cx, cy: sel.cy, w: sel.width, h: sel.height, rot: sel.rotation, hidden: !!sel.hidden, locked: !!sel.locked, touch: !!sel.touch, kind: sel.kind } : null,
    canUndo: store.canUndo,
  };
});
/** How many seats show palette index v. */
const count = (p, v) => p.evaluate((v) => { let n = 0; for (const c of window.__tifo.store.cells) if (c === v) n++; return n; }, v);
/** The seat nearest a world point and what it shows / has painted under it. */
const seat = (p, x, y) => p.evaluate(([x, y]) => {
  const { map, store } = window.__tifo;
  let best = -1, bd = Infinity;
  for (let i = 0; i < map.count; i++) { const d = (map.xy[i * 2] - x) ** 2 + (map.xy[i * 2 + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return { i: best, shown: store.cells[best], paint: store.base[best] };
}, [x, y]);
/** World → page coordinates. */
const toPage = (p, x, y) => p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [x, y]);
/** Two animation frames: the Layers list redraws on the next frame after a change. */
const settle = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const rows = async (p) => { await settle(p); return p.$$eval('#layers-list .ly-row', (rs) => rs.map((r) => ({ id: r.dataset.id ?? null, name: r.querySelector('.ly-name')?.textContent ?? '', sub: r.querySelector('.ly-sub')?.textContent ?? '', sel: r.classList.contains('sel') }))); };
const tool = (p, t) => p.click(`.tool-rail [data-tool="${t}"]`);
const bowlMid = (p) => p.evaluate(() => { const b = window.__tifo.map.bounds; return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, minY: b.minY, maxY: b.maxY }; });
/** Put a colour (palette index) on every seat of the Paint layer — a known background. */
const paintAll = (p, v) => p.evaluate((v) => window.__tifo.store.fillAll(v), v);
async function dragWorld(p, from, to, steps = 8, mods = []) {
  const [ax, ay] = await toPage(p, from[0], from[1]);
  const [bx, by] = await toPage(p, to[0], to[1]);
  for (const m of mods) await p.keyboard.down(m);
  await p.mouse.move(ax, ay);
  await p.mouse.down();
  for (let k = 1; k <= steps; k++) await p.mouse.move(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
  await p.mouse.up();
  for (const m of mods) await p.keyboard.up(m);
  await p.waitForTimeout(150);
}
async function addText(p, text, x, y) {
  await tool(p, 'text');
  await p.fill('#text-input', text);
  const [cx, cy] = await toPage(p, x, y);
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(400);
}
async function addShape(p, kind, x, y) {
  await tool(p, 'shape');
  await p.selectOption('#shape-kind', kind);
  const [cx, cy] = await toPage(p, x, y);
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(300);
}
async function addPicture(p) {
  await p.setInputFiles('#import-file', 'scripts/data/test-badge.png');
  await p.waitForSelector('#import-apply:not([disabled])', { timeout: 10000 });
  await p.click('#import-apply');
  await p.waitForTimeout(500);
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

// ---------------------------------------------------------------------------
console.log('\n— adding things makes layers —');
{
  const { ctx, p, errs } = await editor();
  const m = await bowlMid(p);
  await paintAll(p, 2);
  // Pick colour 1 for what we add, so it is told apart from the paint.
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 1; });
  const before1 = await count(p, 1);
  await addText(p, 'YALLA', m.x - 600, m.y);
  let s = await st(p);
  check('text lands as a layer, selected', s.n === 1 && s.sel === s.ids[0], JSON.stringify(s.selObj));
  const withText = await count(p, 1);
  check('…shown as real seats straight away (no Bake)', withText > before1 + 50, `${withText - before1} seats`);
  const at = await seat(p, s.selObj.cx, s.selObj.cy);
  check('…the paint under it is untouched', at.paint === 2);
  await addShape(p, 'star', m.x + 400, m.y);
  s = await st(p);
  const r = await rows(p);
  check('the Layers list shows both, newest on top, then Paint, then Banners',
    r.length === 4 && r[0].id === s.ids[1] && r[1].id === s.ids[0] && /Paint/.test(r[2].name) && /Banners/.test(r[3].name), JSON.stringify(r.map((x) => x.name)));
  check('each row says what it is', /Shape/.test(r[0].sub) && /Text/.test(r[1].sub) && /YALLA/.test(r[1].name), `${r[0].sub} | ${r[1].sub}`);
  check('the shape row is selected, like the canvas', r[0].sel && !r[1].sel);
  await tool(p, 'select');
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${s.ids[0]}"]`);
  s = await st(p);
  check('picking a row selects the layer on the canvas', s.sel === s.ids[0]);
  check('the floating action bar sits above it', await p.$eval('.ly-actionbar', (b) => !b.hidden && b.getBoundingClientRect().width > 100));
  await shot(p, 'desk-selected');

  // ---- move ----
  const textId = s.ids[0];
  const o = s.selObj;
  const cellsBefore = await count(p, 1);
  await dragWorld(p, [o.cx, o.cy], [o.cx + 300, o.cy]);
  s = await st(p);
  check('dragging moves it', Math.abs(s.selObj.cx - (o.cx + 300)) < 8, `${o.cx.toFixed(0)} → ${s.selObj.cx.toFixed(0)}`);
  const old = await seat(p, o.cx, o.cy);
  check('…the old place shows the paint again', old.shown === 2, JSON.stringify(old));
  const nw = await seat(p, s.selObj.cx, s.selObj.cy);
  check('…and the seats go with it', nw.shown === 1 && Math.abs((await count(p, 1)) - cellsBefore) < cellsBefore * 0.15);
  await p.click('#undo');
  s = await st(p);
  check('one Undo puts it back', Math.abs(s.selObj.cx - o.cx) < 1 && (await seat(p, o.cx, o.cy)).shown === 1);
  await p.click('#redo');
  await p.click('#undo');

  // ---- resize from a corner keeps the shape ----
  const o2 = (await st(p)).selObj;
  const corner = await p.evaluate((id) => { const o = window.__tifo.objects.get(id); return [o.cx + o.width / 2, o.cy + o.height / 2]; }, textId);
  await dragWorld(p, corner, [corner[0] + 120, corner[1] + 40]);
  const o3 = (await st(p)).selObj;
  check('a corner resizes it and keeps its shape', o3.w > o2.w * 1.2 && Math.abs(o3.w / o3.h - o2.w / o2.h) < 0.02, `${o2.w.toFixed(0)}×${o2.h.toFixed(0)} → ${o3.w.toFixed(0)}×${o3.h.toFixed(0)}`);
  check('…and the seats are drawn again at the new size', (await count(p, 1)) > cellsBefore * 1.3);
  // ---- an edge stretches one way ----
  const edge = await p.evaluate((id) => { const o = window.__tifo.objects.get(id); return [o.cx + o.width / 2, o.cy]; }, textId);
  await dragWorld(p, edge, [edge[0] + 80, edge[1] + 30]);
  const o4 = (await st(p)).selObj;
  check('an edge stretches one way only', o4.w > o3.w + 50 && Math.abs(o4.h - o3.h) < 0.5);
  await p.click('#undo');
  await p.click('#undo');

  // ---- turn ----
  const rot = await p.evaluate((id) => { const o = window.__tifo.objects.get(id); const k = window.__tifo.editor.app.stage.children[0].scale.x; return [o.cx, o.cy + o.height / 2 + 28 / k]; }, textId);
  const oo = (await st(p)).selObj;
  await dragWorld(p, rot, [oo.cx + 200, oo.cy + 120], 10, ['Shift']);
  const o5 = (await st(p)).selObj;
  check('the handle below turns it', Math.abs(o5.rot) > 10, `${o5.rot}°`);
  check('…Shift turns it in 15° steps', Math.abs(o5.rot / 15 - Math.round(o5.rot / 15)) < 1e-6, `${o5.rot}°`);
  check('the panel shows the angle', Number(await p.inputValue('#obj-rot')) === Math.round(o5.rot));
  await p.fill('#obj-rot', '30');
  await p.press('#obj-rot', 'Enter');
  check('typing an angle turns it', (await st(p)).selObj.rot === 30);
  await p.click('#obj-rot-reset');
  check('Straighten puts it back to 0°', (await st(p)).selObj.rot === 0);

  // ---- brush over it touches it up, and the fix moves with it ----
  const t0 = (await st(p)).selObj;
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 3; });
  await tool(p, 'brush');
  const [hx, hy] = await toPage(p, t0.cx, t0.cy);
  await p.mouse.move(hx, hy);
  await p.waitForTimeout(100);
  const label = await p.$eval('.ly-paint-target', (e) => ({ hidden: e.hidden, text: e.textContent }));
  check('hovering the brush over a layer says it will touch it up', !label.hidden && /Touching up/.test(label.text), label.text);
  const target = await seat(p, t0.cx, t0.cy);
  await dragWorld(p, [t0.cx - 6, t0.cy], [t0.cx + 6, t0.cy], 3);
  const after = await seat(p, t0.cx, t0.cy);
  s = await st(p);
  check('a stroke over the layer touches it up', after.shown === 3 && after.paint === target.paint && s.selObj === null ? true : after.shown === 3, JSON.stringify(after));
  check('…the layer knows it', await p.evaluate((id) => !!window.__tifo.objects.get(id).touch, textId));
  await p.evaluate(([id, dx]) => { const o = window.__tifo.objects.get(id); window.__tifo.objects.update(id, { cx: o.cx + dx }); }, [textId, 240]);
  const moved = await seat(p, t0.cx + 240, t0.cy);
  check('…and the fix moves with it', moved.shown === 3, JSON.stringify(moved));
  check('…leaving the paint where it was', (await seat(p, t0.cx, t0.cy)).shown === 2);
  await p.click('#undo');
  await p.click('#undo');
  check('undo takes the stroke back too', (await seat(p, t0.cx, t0.cy)).shown !== 3 && !(await p.evaluate((id) => window.__tifo.objects.get(id).touch, textId)));

  // ---- eraser cuts a hole ----
  await tool(p, 'eraser');
  const onGlyph = await p.evaluate((id) => {
    const { objects, composer, map } = window.__tifo;
    for (let i = 0; i < map.count; i++) if (composer.objectAtSeat(i)?.id === id) return [map.xy[i * 2], map.xy[i * 2 + 1]];
    return null;
  }, textId);
  await dragWorld(p, onGlyph, [onGlyph[0] + 0.5, onGlyph[1]], 1);
  check('the eraser cuts through the layer to the paint', (await seat(p, onGlyph[0], onGlyph[1])).shown === 2);
  await p.click('#undo');

  // ---- hide, lock ----
  await tool(p, 'select');
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"]`);
  const n1 = await count(p, 1);
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"] .ly-eye`);
  await settle(p);
  check('the eye hides it: left out of the seats', (await count(p, 1)) < n1 - 50);
  check('…and the eye stays shown while it is hidden', await p.$eval(`#layers-list .ly-row[data-id="${textId}"] .ly-eye`, (e) => e.classList.contains('on') && getComputedStyle(e).opacity === '1'));
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"] .ly-eye`);
  check('…and shows it again', (await count(p, 1)) === n1);
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"] .ly-lock`);
  const lk = (await st(p)).selObj;
  await dragWorld(p, [lk.cx, lk.cy], [lk.cx + 200, lk.cy]);
  check('a locked layer cannot be dragged', Math.abs((await st(p)).selObj?.cx ?? lk.cx - lk.cx) < 1 || (await p.evaluate((id) => window.__tifo.objects.get(id).cx, textId)) === lk.cx);
  await tool(p, 'brush');
  await dragWorld(p, [lk.cx - 6, lk.cy], [lk.cx + 6, lk.cy], 3);
  check('…nor painted on, and the status line says why', /locked/.test(await p.textContent('#message')), await p.textContent('#message'));
  await tool(p, 'select');
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"] .ly-lock`);

  // ---- reorder by dragging a row ----
  const [shapeId] = (await st(p)).ids.slice(1);
  let order = (await rows(p)).map((r) => r.id);
  const src = await p.$(`#layers-list .ly-row[data-id="${textId}"]`);
  const dst = await p.$(`#layers-list .ly-row[data-id="${shapeId}"]`);
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await p.mouse.down();
  await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 - 10, { steps: 3 });
  await p.mouse.move(db.x + db.width / 2, db.y + 4, { steps: 6 });
  const line = await p.$eval('.ly-drop', (e) => e.getBoundingClientRect().top).catch(() => null);
  check('dragging a row shows where it will land', line !== null && Math.abs(line - db.y) < 8, `${line} vs ${db.y}`);
  await p.mouse.up();
  await p.waitForTimeout(200);
  order = (await rows(p)).map((r) => r.id);
  s = await st(p);
  check('…and it lands there: the text is in front now', order[0] === textId && s.ids[s.ids.length - 1] === textId, JSON.stringify(order));
  await p.click('#undo');
  check('undo puts the order back', (await st(p)).ids[1] === shapeId);

  // ---- rename ----
  await settle(p);
  await settle(p); await p.dblclick(`#layers-list .ly-row[data-id="${textId}"] .ly-name`);
  await p.fill('#layers-list .ly-rename', 'Chant');
  await p.press('#layers-list .ly-rename', 'Enter');
  await p.waitForTimeout(100);
  check('double-clicking a name renames the layer', (await rows(p)).some((r) => r.id === textId && r.name === 'Chant'));

  // ---- keys ----
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${textId}"]`);
  // Off the list (a focused row takes the arrow keys, to move through the list).
  await p.evaluate(() => document.activeElement?.blur());
  const k0 = (await st(p)).selObj;
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Shift+ArrowDown');
  const k1 = (await st(p)).selObj;
  check('arrow keys nudge it a seat; Shift ten', Math.abs(k1.cx - k0.cx - 3.2) < 0.01 && Math.abs(k1.cy - k0.cy - 80) < 0.01, `${(k1.cx - k0.cx).toFixed(1)}, ${(k1.cy - k0.cy).toFixed(1)}`);
  await p.keyboard.press('Control+d');
  s = await st(p);
  check('Ctrl+D duplicates it, just above', s.n === 3 && s.sel !== textId && s.ids.indexOf(s.sel) === s.ids.indexOf(textId) + 1);
  await p.keyboard.press('Control+[');
  check('Ctrl+[ sends it back a step', (await st(p)).ids.indexOf((await st(p)).sel) === (await st(p)).ids.indexOf(textId) - 1);
  await p.keyboard.press('Delete');
  check('Delete removes it', (await st(p)).n === 2);
  await p.keyboard.press('Control+z');
  check('Ctrl+Z brings it back', (await st(p)).n === 3);
  await p.keyboard.press('Control+Shift+H');
  check('Ctrl+Shift+H hides it', (await st(p)).selObj.hidden);
  await p.keyboard.press('Control+Shift+H');
  await p.keyboard.press('Escape');
  check('Escape deselects', (await st(p)).sel === null);

  // ---- the row menu: merge into paint ----
  await settle(p); await p.click(`#layers-list .ly-row[data-id="${shapeId}"] .ly-more`, { force: true });
  const items = await p.$$eval('.ly-menu button', (b) => b.map((x) => x.textContent.trim()));
  check('the ⋯ menu has the layer\'s actions', ['Rename', 'Duplicate', 'Bring forward', 'Send backward', 'Merge into paint', 'Delete'].every((w) => items.includes(w)), JSON.stringify(items));
  const starSeats = await p.evaluate((id) => { const { composer, map } = window.__tifo; let n = 0; for (let i = 0; i < map.count; i++) if (composer.objectAtSeat(i)?.id === id) n++; return n; }, shapeId);
  const c1 = await count(p, 1);
  await p.click('.ly-menu button:has-text("Merge into paint")');
  s = await st(p);
  check('Merge into paint: the layer goes, its seats stay', !s.ids.includes(shapeId) && (await count(p, 1)) === c1, `${starSeats} seats`);
  check('…and the status line says how to get it back', /undo/i.test(await p.textContent('#message')));
  await p.click('#undo');
  check('one Undo makes it a layer again', (await st(p)).ids.includes(shapeId) && (await count(p, 1)) === c1);

  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— a layer is still editable after it has landed —');
{
  const { ctx, p, errs } = await editor();
  const m = await bowlMid(p);
  await paintAll(p, 2);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 1; });
  await addText(p, 'GO', m.x, m.y);
  await tool(p, 'select');
  const o = (await st(p)).selObj;
  // Double-click the text: its words, ready to change.
  const [dx, dy] = await toPage(p, o.cx, o.cy);
  await p.mouse.dblclick(dx, dy);
  check('double-clicking a text layer goes to its words', await p.evaluate(() => document.activeElement?.id === 'obj-text'));
  check('…with the words selected, ready to be typed over', await p.evaluate(() => { const i = document.getElementById('obj-text'); return i.selectionStart === 0 && i.selectionEnd === i.value.length; }));
  await p.keyboard.press('End');
  await p.keyboard.type('AL');
  await p.keyboard.press('Enter');
  const t1 = await p.evaluate(() => ({ text: window.__tifo.objects.selected.text, w: window.__tifo.objects.selected.width }));
  check('changing the words re-draws the layer, as wide as the words', t1.text === 'GOAL' && t1.w > o.w * 1.3, JSON.stringify(t1));
  await p.click('#undo');
  check('…and the whole edit is one Undo', (await p.evaluate(() => window.__tifo.objects.selected?.text)) === 'GO');
  await p.click('#redo');
  // Recolour it.
  const n1 = await count(p, 1);
  await p.click('#obj-colors .ly-swatch:nth-child(3)');
  const ci = await p.evaluate(() => window.__tifo.objects.selected.colorIndex);
  check('a text layer can be recoloured', ci === 3 && (await count(p, 1)) < n1 - 20, `colour ${ci}`);
  // Alt-drag copies.
  const o2 = (await st(p)).selObj;
  await dragWorld(p, [o2.cx, o2.cy], [o2.cx + 250, o2.cy], 6, ['Alt']);
  const s2 = await st(p);
  const orig = await p.evaluate(() => window.__tifo.objects.list()[0].cx);
  // (a moving layer snaps to the one it was copied from, so "about 250 over")
  check('Alt-drag leaves it and drags a copy', s2.n === 2 && Math.abs(s2.selObj.cx - (o2.cx + 250)) < 32 && orig === o2.cx,
    `${s2.n} layers, copy at +${(s2.selObj?.cx - o2.cx).toFixed(1)}, original ${orig === o2.cx ? 'stayed' : 'moved'}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— pictures, Make movable, exports —');
{
  const { ctx, p, errs } = await editor();
  await paintAll(p, 2);
  await addPicture(p);
  let s = await st(p);
  check('a picture lands as a layer', s.n === 1 && s.selObj.kind === 'image');
  const r = await rows(p);
  check('its row is named after the file, with a thumbnail', /test-badge/.test(r[0].name) && /Picture/.test(r[0].sub));
  check('the list counts pictures out of twelve', /1\/12/.test(await p.textContent('#layers-tag')), await p.textContent('#layers-tag'));
  const hasSrc = await p.evaluate(() => { const o = window.__tifo.objects.selected; return typeof o.src === 'string' && o.src.startsWith('data:image/'); });
  check('the picture is kept, small, to be saved with the project', hasSrc);
  // Twelve at most.
  await p.evaluate(() => { const { objects } = window.__tifo; const id = objects.selected.id; for (let k = 0; k < 11; k++) objects.duplicate(id); });
  check('twelve pictures fit', (await st(p)).n === 12);
  await p.keyboard.press('Control+d');
  check('a thirteenth is refused, and the status line says why', (await st(p)).n === 12 && /12 pictures/.test(await p.textContent('#message')), await p.textContent('#message'));
  await p.setInputFiles('#import-file', 'scripts/data/test-badge.png');
  await p.waitForTimeout(400);
  check('…from the picture tool too', (await st(p)).n === 12 && !(await p.$eval('#import-bar', (b) => !b.hidden)));
  await p.evaluate(() => { const { objects } = window.__tifo; for (const o of objects.list().slice(1)) objects.remove(o.id); objects.select(null); });

  // Make movable: paint a block, box-select it, lift it.
  const m = await bowlMid(p);
  await p.evaluate(([x, y]) => {
    const { store, map } = window.__tifo;
    store.beginStroke();
    for (let i = 0; i < map.count; i++) { const dx = map.xy[i * 2] - x, dy = map.xy[i * 2 + 1] - y; if (Math.abs(dx) < 40 && Math.abs(dy) < 20) store.paint(i, 4); }
    store.commitStroke();
  }, [m.x + 700, m.y]);
  const block = await count(p, 4);
  await tool(p, 'select');
  await dragWorld(p, [m.x + 650, m.y - 30], [m.x + 750, m.y + 30]);
  check('box-selecting painted seats offers Make movable', await p.$eval('#region-lift', (b) => b.offsetParent !== null));
  await p.click('#region-lift');
  s = await st(p);
  check('Make movable turns them into a layer, selected', s.n === 2 && s.selObj.kind === 'cells' && (await rows(p))[0].sub.includes('Moved area'));
  check('…without changing what you see', (await count(p, 4)) === block);
  await dragWorld(p, [s.selObj.cx, s.selObj.cy], [s.selObj.cx + 200, s.selObj.cy]);
  check('…and they move: the old place takes the colour around it', (await seat(p, m.x + 700, m.y)).shown === 2 && (await seat(p, m.x + 900, m.y)).shown === 4);
  await p.click('#undo');
  await p.click('#undo');
  check('undo, undo: back to painted seats', (await st(p)).n === 1 && (await seat(p, m.x + 700, m.y)).paint === 4);

  // Exports bake nothing.
  const n0 = (await st(p)).n;
  await p.evaluate(() => { const b = document.getElementById('rail-save'); b?.click(); });
  const dl = p.waitForEvent('download', { timeout: 20000 });
  await p.click('#export-csv');
  const csv = await dl;
  check('an export leaves every layer a layer (nothing baked)', (await st(p)).n === n0, `${n0} layers`);
  const csvText = readFileSync(await csv.path(), 'utf8');
  check('…and the export has the layers in it all the same', csvText.split('\n').length > 1000);
  const dl2 = p.waitForEvent('download', { timeout: 20000 });
  await p.click('#download-tifo');
  const tifo = JSON.parse(readFileSync(await (await dl2).path(), 'utf8'));
  check('the .tifo file carries the flat seats AND the layers', Array.isArray(tifo.layers) && tifo.editor?.layers?.objects?.length === n0);
  // Open it again: a .tifo opens as a new project, and its layers come with it.
  await p.setInputFiles('input[type=file][accept=".tifo,application/json"]', { name: 'x.tifo', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tifo)) });
  await p.waitForURL(/import=1/, { timeout: 20000 });
  await p.waitForSelector('#layers-list .ly-row[data-id]', { timeout: 60000 }).catch(() => null);
  const reopened = await p.$$eval('#layers-list .ly-row[data-id]', (r) => r.length);
  check('opening that file brings the layers back, in a new project', reopened === n0, `${reopened}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— the layers are kept —');
{
  // In this browser: a project with no account.
  const { ctx, p, errs } = await editor();
  const m = await bowlMid(p);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 1; });
  await addText(p, 'KEEP', m.x - 500, m.y);
  await addShape(p, 'heart', m.x + 300, m.y);
  await addPicture(p);
  await tool(p, 'select');
  const before = await p.evaluate(() => ({ ids: window.__tifo.objects.list().map((o) => o.id), cells: Array.from(window.__tifo.store.cells).join('') }));
  await p.waitForURL(/local=/, { timeout: 20000 });
  // The draft is written a moment after the last change, and the layers beside it.
  await p.waitForTimeout(3500);
  await p.goto(p.url().replace(/([?&])e2e=1&?/, '$1') + (p.url().includes('?') ? '&' : '?') + 'e2e=1', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => !!window.__tifo);
  await p.waitForTimeout(800);
  const after = await p.evaluate(() => ({ ids: window.__tifo.objects.list().map((o) => o.id), cells: Array.from(window.__tifo.store.cells).join(''), kinds: window.__tifo.objects.list().map((o) => o.kind) }));
  check('a reload brings every layer back', JSON.stringify(after.ids) === JSON.stringify(before.ids), `${before.ids} → ${after.ids}`);
  check('…with the same seats', after.cells === before.cells);
  const r = await rows(p);
  check('…and the Layers list shows them', r.filter((x) => x.id).length === 3 && r.some((x) => /KEEP/.test(x.name)));
  const pic = await p.evaluate(() => window.__tifo.objects.list().find((o) => o.kind === 'image'));
  check('the picture is still movable', !!pic);
  await tool(p, 'select');
  await p.evaluate(() => { const o = window.__tifo.objects.list().find((x) => x.kind === 'image'); window.__tifo.objects.select(o.id); });
  const o = (await st(p)).selObj;
  const corner = [o.cx + o.w / 2, o.cy + o.h / 2];
  await dragWorld(p, corner, [corner[0] + 60, corner[1] + 20]);
  const grown = (await st(p)).selObj;
  const redrawn = await p.evaluate(() => { const x = window.__tifo.objects.selected; return { key: x.gridKey, cols: x.grid?.cols, want: Math.round(x.width / 3) }; });
  check('…and resizable: it is drawn again from the saved picture', grown.w > o.w * 1.1 && redrawn.cols === redrawn.want, `${o.w.toFixed(0)} → ${grown.w.toFixed(0)} ${JSON.stringify(redrawn)}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  // In the account: saved, opened on another machine, seen by someone else, remixed.
  const stamp = Date.now() % 1e7;
  const u = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username: `lyr${stamp}`, password: 'harbor-kite-moss-31', email: `lyr${stamp}@example.test`, acceptedVersion: 'test' }) });
  const token = u.json?.token;
  check('(an account for the account checks)', !!token, String(u.status));
  const { ctx, p, errs } = await editor({ token });
  const m = await bowlMid(p);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 1; });
  await addText(p, 'ACCOUNT', m.x - 400, m.y);
  await addPicture(p);
  await p.waitForURL(/project=/, { timeout: 30000 });
  const id = new URL(p.url()).searchParams.get('project');
  await p.click('#save-top');
  await p.waitForFunction(() => /Saved to your account|Saved in your account/i.test(document.getElementById('save-state-top')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const cells = await p.evaluate(() => Array.from(window.__tifo.store.cells).join(''));
  await ctx.close();
  const own = await api(`/api/designs/${id}/scene`, token);
  check('Save puts the layers in the account, beside the banners', !!own.json?.sceneGzB64);
  // Another machine: a fresh browser, nothing kept locally.
  const two = await editor({ token, url: `/app?project=${id}&e2e=1` });
  await two.p.waitForTimeout(800);
  const back = await two.p.evaluate(() => ({ n: window.__tifo.objects.list().length, cells: Array.from(window.__tifo.store.cells).join('') }));
  check('opened anywhere, the project has its layers', back.n === 2, `${back.n}`);
  check('…and exactly its seats', back.cells === cells);
  check('no page errors', two.errs.length === 0 && errs.length === 0, [...errs, ...two.errs].join(' | '));
  await two.ctx.close();
  // Someone else.
  await api(`/api/designs/${id}`, token, { method: 'PATCH', body: JSON.stringify({ isPublic: true }) });
  const v = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username: `lyv${stamp}`, password: 'harbor-kite-moss-31', email: `lyv${stamp}@example.test`, acceptedVersion: 'test' }) });
  const other = v.json?.token;
  const seen = await api(`/api/designs/${id}/scene`, other);
  const theirs = seen.json?.sceneGzB64 ? JSON.parse(new TextDecoder().decode(await new Response(new Blob([Buffer.from(seen.json.sceneGzB64, 'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())) : null;
  check('anyone else gets the design without its layers (and pictures)', !!seen.json && !(theirs && 'layers' in theirs), seen.status);
  const anon = await api(`/api/designs/${id}/scene`, null);
  const anonScene = anon.json?.sceneGzB64 ? JSON.parse(new TextDecoder().decode(await new Response(new Blob([Buffer.from(anon.json.sceneGzB64, 'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())) : null;
  check('…signed out too', !(anonScene && 'layers' in anonScene));
  const view = await editor({ token: other, url: `/app?design=${id}&e2e=1` });
  const viewN = await view.p.evaluate(() => window.__tifo.objects.list().length);
  check('someone else opening it gets the seats, flat', viewN === 0 && (await view.p.evaluate(() => Array.from(window.__tifo.store.cells).join(''))) === cells);
  await view.ctx.close();
  const rx = await api(`/api/designs/${id}/remix`, other, { method: 'POST', body: JSON.stringify({ title: 'mine now' }) });
  if (rx.status === 201) {
    const rs = await api(`/api/designs/${rx.json.id}/scene`, other);
    const rScene = rs.json?.sceneGzB64 ? JSON.parse(new TextDecoder().decode(await new Response(new Blob([Buffer.from(rs.json.sceneGzB64, 'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())) : null;
    check('a remix is the seats, flat: no layers come with it', !(rScene && 'layers' in rScene));
  } else {
    console.log(`  (remix not available here: ${rx.status})`);
  }
  // Leave the community as it was: other suites read it.
  await api(`/api/designs/${id}`, token, { method: 'PATCH', body: JSON.stringify({ isPublic: false }) });
}

// ---------------------------------------------------------------------------
console.log('\n— on a phone —');
{
  const { ctx, p, errs } = await editor({ viewport: { width: 390, height: 844 } });
  await p.evaluate(() => {
    const { objects } = window.__tifo;
    objects.addText({ cx: 1000, cy: 200, width: 300, height: 100, colorIndex: 1, tier: null, text: 'PHONE', fontCss: 'sans-serif', fontId: 'x', arcDeg: 0, heightSeats: 12 });
  });
  const tabs = await p.$$eval('.m-ribbon .m-tab', (t) => t.map((x) => x.dataset.tab));
  check('the ribbon has a Layers tab', tabs.includes('layers'), JSON.stringify(tabs));
  await p.click('.m-tab[data-tab="layers"]');
  await settle(p);
  const inSheet = await p.$eval('.m-sheet-body', (b) => !!b.querySelector('#layers-list .ly-row[data-id]'));
  check('…which opens the list in the sheet', inSheet);
  const rowH = await p.$eval('#layers-list .ly-row[data-id]', (r) => r.getBoundingClientRect().height);
  check('rows are thumb-sized (≥ 48px)', rowH >= 48, `${rowH}px`);
  const togs = await p.$$eval('#layers-list .ly-row[data-id] .ly-tog', (b) => b.map((x) => [getComputedStyle(x).opacity, x.getBoundingClientRect().width]));
  check('the eye and lock are always there, and big enough', togs.every(([o, w]) => o === '1' && w >= 40), JSON.stringify(togs));
  await p.click('#layers-list .ly-row[data-id] .ly-name');
  await settle(p);
  const bar = await p.$$eval('.m-objbar:not([hidden]) .m-objbar-b', (b) => b.map((x) => x.textContent.trim() || x.getAttribute('aria-label')));
  check('picking one brings up the object bar: Options, Duplicate, Layers, Delete', bar.length === 4 && /Options/.test(bar[0]) && /Layers/.test(bar[2]), JSON.stringify(bar));
  check('the desktop action bar stays away on a phone', await p.$eval('.ly-actionbar', (b) => b.hidden));
  await shot(p, 'phone-layers');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— Arabic —');
{
  const { ctx, p, errs } = await editor({ lang: 'ar' });
  await p.evaluate(() => {
    const { objects } = window.__tifo;
    objects.addText({ cx: 1000, cy: 200, width: 300, height: 100, colorIndex: 1, tier: 0, text: 'هلا', fontCss: 'sans-serif', fontId: 'x', arcDeg: 0, heightSeats: 12 });
  });
  await tool(p, 'select');
  const r = await rows(p);
  const AR = /[؀-ۿ]/;
  check('the list speaks Arabic', AR.test(await p.textContent('#ctx-layers h4')) && r.every((x) => AR.test(x.name) && AR.test(x.sub)), JSON.stringify(r));
  const dir = await p.$eval('#layers-list .ly-row[data-id]', (row) => {
    const t = row.querySelector('.ly-thumb').getBoundingClientRect();
    const e = row.querySelector('.ly-eye').getBoundingClientRect();
    return { rtl: getComputedStyle(row).direction === 'rtl', thumbRight: t.left > e.left };
  });
  check('…and is mirrored: picture on the right, toggles on the left', dir.rtl && dir.thumbRight, JSON.stringify(dir));
  check('the layer panel\'s own words are Arabic', AR.test(await p.textContent('label[for="obj-rot"]')) && AR.test(await p.textContent('#obj-merge')));
  await shot(p, 'arabic');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
