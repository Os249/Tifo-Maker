import { chromium } from 'playwright';
import { createGzip } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
const B=process.env.BASE||'http://127.0.0.1:8911';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const page=await (await browser.newContext({viewport:{width:1400,height:900}})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
const ready=()=>page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},{timeout:45000});
/**
 * A project's copy in this browser (see src/core/projects.ts): compressed in
 * IndexedDB (src/core/draftStore.ts, performance plan P3.7), or JSON in
 * localStorage in the old form. Runs in the page; never creates the database.
 */
const READ_DRAFT = async (key) => {
  const rec = await new Promise((res) => {
    let rq;
    try { rq = indexedDB.open('tifo-drafts', 1); } catch { return res(null); }
    rq.onupgradeneeded = () => rq.transaction.abort(); // not there yet: leave it to the app to make
    rq.onerror = () => res(null);
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('drafts')) { db.close(); return res(null); }
      const g = db.transaction('drafts').objectStore('drafts').get(key);
      g.onsuccess = () => { db.close(); res(g.result ?? null); };
      g.onerror = () => { db.close(); res(null); };
    };
  });
  if (rec && rec.gz) {
    try {
      const json = await new Response(new Blob([rec.gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      return { json, form: 'idb', bytes: rec.gz.byteLength, old: localStorage.getItem(key) !== null };
    } catch { return { json: null, form: 'idb', bytes: rec.gz.byteLength, old: localStorage.getItem(key) !== null }; }
  }
  const r = localStorage.getItem(key);
  return r ? { json: r, form: 'ls', bytes: r.length * 2, old: true } : null;
};
const readDraft = (p, key) => p.evaluate(`(${READ_DRAFT})(${JSON.stringify(key)})`);
const sig=async()=>{const id=await page.evaluate(()=>new URLSearchParams(location.search).get('local'));const r=id&&await readDraft(page,'tifo_proj_'+id);if(!r||!r.json)return null;const d=JSON.parse(r.json);
  const rle=d.doc?.layers?.[0]?.cellsRle??[];
  return {runs:rle.length, head:JSON.stringify(rle.slice(0,3)), title:d.title, designId:d.designId, kb:Math.round(r.bytes/1024), form:r.form, chars:r.json.length};};

let pass=0, fail=0;
const check=(name,ok,extra='')=>{ (ok?pass++:fail++); console.log(`  ${ok?'PASS':'FAIL'}  ${name}${extra?'  '+extra:''}`); };
/**
 * Resident memory of this run's own Chromium renderers, in MB (Linux /proc;
 * 0 where it cannot be read): the processes under this one whose command
 * line says --type=renderer, so other browsers on the machine do not count.
 */
const rendererMB = () => {
  try {
    const parent = new Map();
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const st = readFileSync(`/proc/${d}/stat`, 'utf8'); parent.set(Number(d), Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1])); } catch { /* gone */ }
    }
    let kb = 0;
    for (const pid of parent.keys()) {
      let mine = false;
      for (let q = parent.get(pid), k = 0; q && q > 1 && k < 32; q = parent.get(q), k++) if (q === process.pid) { mine = true; break; }
      if (!mine) continue;
      try {
        if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
        const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (m) kb += Number(m[1]);
      } catch { /* gone */ }
    }
    return kb / 1024;
  } catch {
    return 0;
  }
};

// A new project: the editor is always opened on one now (see e2e-projects.mjs),
// and with the first-run dialog gone (the start flow on the Projects page asks
// its questions before the editor opens) it exists as soon as the editor does.
await page.goto(B+'/app?new=1',{waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(1000);
check('the project exists as soon as the editor is open', await page.evaluate(()=>/[?&]local=/.test(location.search) && JSON.parse(localStorage.getItem('tifo_projects_v1')||'[]').length===1 && !localStorage.getItem('tifo_draft_v1')));
check('and nothing is left inert behind a dialog', await page.evaluate(()=>document.querySelectorAll('[inert]').length===0));

// Paint with real pointer events (Pixi listens for these, not synthetic mouse).
await page.evaluate(()=>{
  const c=document.querySelector('#canvas-host canvas'); const r=c.getBoundingClientRect();
  const ev=(type,x,y)=>c.dispatchEvent(new PointerEvent(type,{pointerId:1,isPrimary:true,bubbles:true,
    cancelable:true,composed:true,clientX:x,clientY:y,buttons:type==='pointerup'?0:1,pointerType:'mouse'}));
  // Sweep a grid across the middle of the canvas rather than one line: the
  // seat band is a thin horizontal strip whose exact height depends on the
  // fit, and a single line at a fixed fraction can miss it entirely.
  const x0 = r.left + r.width * 0.20, x1 = r.left + r.width * 0.80;
  for (const f of [0.45, 0.50, 0.55, 0.60, 0.65]) {
    const y = r.top + r.height * f;
    ev('pointerdown', x0, y);
    for (let i = 0; i <= 20; i++) ev('pointermove', x0 + ((x1 - x0) * i) / 20, y);
    ev('pointerup', x1, y);
  }
});
await page.waitForTimeout(3000);
const a = await sig();
check('painting writes a draft', !!a, a?`${a.runs} runs, ${a.kb}KB`:'');
check('…compressed, in IndexedDB (P3.7)', a?.form === 'idb' && a.kb * 1024 < a.chars, a?`${a.form}: ${a.chars} characters stored in ${a.kb} KB`:'');

// The result appears beside whichever Save was pressed, and NOWHERE else. It
// used to be written to the header chip, the panel chip and the message line at
// once, so one save read as three things happening.
const savedText = () => page.evaluate(()=>{
  const hits=[...document.querySelectorAll('*')].filter(e=>e.children.length===0
    && /saved in this browser/i.test(e.textContent||'')
    && e.getBoundingClientRect().height>0);
  return { count: hits.length, where: hits.map(e=>e.id||e.className||e.tagName) };
});
const state = await page.evaluate(()=>
  (document.getElementById('save-state-top')?.textContent || document.getElementById('draft-state')?.textContent || ''));
check('saved-state says "this browser", not "saved"', /this browser/i.test(state), JSON.stringify(state));

// Reload: the whole point.
await page.reload({waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(1500);
const b = await sig();
check('draft survives a reload', !!b && b.head===a.head, b?`${b.runs} runs`:'');
check('the reload reopens the same project, not a new one', await page.evaluate(()=>/[?&]local=/.test(location.search) && JSON.parse(localStorage.getItem('tifo_projects_v1')||'[]').length===1));

// The bug that starved every number below it: Save sat ~580px under the fold in
// a side panel, so most people who painted never saw it. Check the sizes real
// visitors actually use, including a phone.
for (const vp of [{width:1366,height:768},{width:1920,height:1080},{width:390,height:844}]) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(400);
  const r = await page.evaluate(()=>{
    const b=document.getElementById('save-top');
    if(!b) return null;
    const q=b.getBoundingClientRect();
    return {onScreen:q.top>=0&&q.bottom<=innerHeight&&q.left>=0&&q.right<=innerWidth,
            top:Math.round(q.top), w:Math.round(q.width), h:Math.round(q.height)};
  });
  check(`Save is on screen at ${vp.width}x${vp.height}`, !!r && r.onScreen, JSON.stringify(r));
  // Comfortable-target guidance is ~44px; a 56px header caps that, so 36 is the
  // floor worth holding. Anything near 27 is a miss waiting to happen.
  check(`Save is a real tap target at ${vp.width}x${vp.height}`, !!r && r.h>=36 && r.w>=36, r?`${r.w}x${r.h}`:'missing');
  // A bounding-box-inside-the-viewport check passed while the header children
  // were overlapping each other, with Save painted over the "Split" tab. Boxes
  // being on screen is not the same as a layout that works.
  const clash = await page.evaluate(()=>{
    const ids=['doc-title','save-top','lang-toggle','signin','avatar','view-2d','view-3d','view-split'];
    const boxes=ids.map(id=>{const e=document.getElementById(id); if(!e) return null;
      const r=e.getBoundingClientRect(); return r.width>0&&r.height>0?{id,r}:null;}).filter(Boolean);
    const hits=[];
    for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++){
      const a=boxes[i].r,b=boxes[j].r;
      const ov=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))
             * Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      if(ov>16) hits.push(`${boxes[i].id}/${boxes[j].id}`);
    }
    return hits;
  });
  check(`header controls do not overlap at ${vp.width}x${vp.height}`, clash.length===0, clash.join(', ')||'clean');
}
await page.setViewportSize({width:1400,height:900});
await page.waitForTimeout(400);

// Save, signed out. Scroll the panel back to the top first: that is the state
// that used to render the offer far below the fold, so the in-view assertion
// below is a real guard rather than one the layout satisfies by luck.
await page.evaluate(()=>{
  const p=document.getElementById('save').closest('.panel'); if(p) p.scrollTop=0;
  document.scrollingElement.scrollTop=0;
});
await page.waitForTimeout(300);
await page.evaluate(()=>document.getElementById('save-top').click());
await page.waitForTimeout(1200);
const after = await page.evaluate(()=>({
  topState: document.getElementById('save-state-top')?.textContent||'',
  offer: !document.getElementById('account-offer')?.hidden,
  text: (document.getElementById('account-offer')?.innerText||'').replace(/\s+/g,' ').slice(0,110),
}));
check('Save works signed out (no modal, no wall)', /this browser/i.test(after.topState), JSON.stringify(after.topState));
const dupes = await savedText();
check('the save result is shown once, not in three places', dupes.count === 1, JSON.stringify(dupes));
check('the first save asks for nothing', !after.offer, after.text);
// Saving again means the work is worth keeping: that is when an account is offered.
await page.evaluate(()=>document.getElementById('save-top').click());
await page.waitForTimeout(1200);
const again = await page.evaluate(()=>({ offer: !document.getElementById('account-offer')?.hidden, text: (document.getElementById('account-offer')?.innerText||'').replace(/\s+/g,' ').slice(0,110) }));
check('an account is offered after the second save', again.offer, again.text);

// An offer below the fold is the same as no offer: pressing Save without
// scrolling used to leave it ~700px under the viewport.
const offerInView = await page.evaluate(()=>{
  const o=document.getElementById('account-offer'); if(!o||o.hidden) return null;
  const r=o.getBoundingClientRect();
  return {top:Math.round(r.top), bottom:Math.round(r.bottom), vh:innerHeight, inView:r.top>=0 && r.bottom<=innerHeight};
});
check('the offer is scrolled into view', !!offerInView?.inView, JSON.stringify(offerInView));

// Dismissible without consequence.
await page.evaluate(()=>document.querySelector('#account-offer .ao-dismiss')?.click());
await page.waitForTimeout(300);
check('offer can be dismissed', await page.evaluate(()=>document.getElementById('account-offer')?.hidden===true));
check('work still kept after dismissing', !!(await sig()));

// ---------------------------------------------------------------------------
// Shared by the two blocks below: a fresh editor with the test hooks, and
// strokes made of real pointer events.
const LS0 = { tifo_lang_v1: 'en', tifo_consent_v1: 'essential', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_draw_hint_v1: '1' };
async function freshEditor(url = '/app?new=1&e2e=1') {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((ls) => {
    try { for (const [k, v] of Object.entries(ls)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* */ }
    // Every write to a project's draft key, and whether a stroke was open when
    // it happened: into the compressed store (P3.7) or, on the way out of a
    // page, the old form in localStorage.
    window.__writes = [];
    const si = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (this === window.localStorage && /^tifo_proj_l/.test(k)) window.__writes.push({ k, form: 'ls', at: performance.now(), inStroke: !!window.__tifo?.store?.inStroke, len: String(v).length });
      return si.call(this, k, v);
    };
    // The layer stacks (tifo-layers' "docs" store) are counted apart from the drafts.
    window.__puts = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'docs') window.__puts++;
      if (this.name === 'drafts' && /^tifo_proj_l/.test(String(a[1]))) window.__writes.push({ k: String(a[1]), form: 'idb', at: performance.now(), inStroke: !!window.__tifo?.store?.inStroke, len: a[0]?.gz?.byteLength ?? 0 });
      return put.apply(this, a);
    };
  }, LS0);
  const p = await ctx.newPage();
  const errs2 = [];
  p.on('pageerror', (e) => errs2.push(String(e.message).slice(0, 200)));
  await p.goto(B + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await p.waitForTimeout(2500);
  return { ctx, p, errs: errs2 };
}
const raf2 = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Open a stroke at a world point (pointerdown), move it, and leave it open. */
const strokeDown = (p, wx, wy) => p.evaluate(([wx, wy]) => {
  const c = document.querySelector('#canvas-host canvas');
  const [x, y] = window.__tifo.editor.worldToClient(wx, wy);
  c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1, pointerType: 'mouse' }));
}, [wx, wy]);
const strokeMove = (p, wx, wy) => p.evaluate(([wx, wy]) => {
  const c = document.querySelector('#canvas-host canvas');
  const [x, y] = window.__tifo.editor.worldToClient(wx, wy);
  c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1, pointerType: 'mouse' }));
}, [wx, wy]);
const strokeUp = (p, wx, wy) => p.evaluate(([wx, wy]) => {
  const c = document.querySelector('#canvas-host canvas');
  const [x, y] = window.__tifo.editor.worldToClient(wx, wy);
  c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 0, pointerType: 'mouse' }));
}, [wx, wy]);
async function stroke(p, from, to, n = 12) {
  await strokeDown(p, from[0], from[1]);
  for (let i = 1; i <= n; i++) await strokeMove(p, from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n);
  await strokeUp(p, to[0], to[1]);
}
const bowl = (p) => p.evaluate(() => { const b = window.__tifo.map.bounds; return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; });
const renders = (p) => p.evaluate(() => window.__tifo.editor.rendersDrawn);
const canvasShot = async (p) => { const r = await p.evaluate(() => { const b = document.querySelector('#canvas-host').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }); return p.screenshot({ clip: r }); };
const projId = (p) => p.evaluate(() => new URLSearchParams(location.search).get('local'));
/** The stored draft's seats, decoded. */
const storedCells = async (p) => {
  const id = await p.evaluate(() => new URLSearchParams(location.search).get('local'));
  const r = await readDraft(p, 'tifo_proj_' + id);
  const d = r?.json ? JSON.parse(r.json) : null;
  const rle = d?.doc?.layers?.[0]?.cellsRle; if (!rle) return null;
  const out = []; for (const [v, n] of rle) for (let k = 0; k < n; k++) out.push(v);
  return out.join(',');
};
const liveCells = (p) => p.evaluate(() => Array.from(window.__tifo.store.cells).join(','));

// ---------------------------------------------------------------------------
// The 2D editor draws only when something changes (performance plan P2.10).
console.log('\n— the editor draws on demand —');
{
  const { ctx, p, errs: e2 } = await freshEditor();
  const m = await bowl(p);
  const r0 = await renders(p);
  await p.waitForTimeout(1500);
  check('idle, it draws nothing', (await renders(p)) === r0, `${(await renders(p)) - r0} renders in 1.5 s`);
  check('and Pixi\'s own loop is off', await p.evaluate(() => window.__tifo.editor.app.ticker.started === false));
  const before = await canvasShot(p);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 2; });
  await stroke(p, [m.x - 700, m.y], [m.x + 300, m.y]);
  await raf2(p);
  const r1 = await renders(p);
  const after = await canvasShot(p);
  check('a stroke is drawn on the next frame', r1 > r0 && !before.equals(after), `${r1 - r0} renders`);
  await p.waitForTimeout(1200);
  check('and then it stops again', (await renders(p)) === r1);
  // Pan and zoom.
  const z0 = await canvasShot(p);
  const [cx, cy] = await p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [m.x, m.y]);
  await p.mouse.move(cx, cy);
  await p.mouse.wheel(0, -300);
  await p.waitForTimeout(200);
  await raf2(p);
  check('a zoom is drawn at once', (await renders(p)) > r1 && !z0.equals(await canvasShot(p)));
  await p.evaluate(() => window.__tifo.editor.fitToView());
  await raf2(p);
  // Hidden: nothing drawn; back: drawn at once, with what changed meanwhile.
  const fitShot = await canvasShot(p);
  await p.click('#view-3d');
  await p.waitForTimeout(800);
  const r2 = await renders(p);
  await p.evaluate(() => window.__tifo.store.fillAll(3));
  await p.waitForTimeout(800);
  check('while the 2D view is hidden it draws nothing', (await renders(p)) === r2);
  await p.click('#view-2d');
  await p.waitForTimeout(600);
  await raf2(p);
  const backShot = await canvasShot(p);
  check('back in 2D, the change made meanwhile is drawn', (await renders(p)) > r2 && !backShot.equals(fitShot));
  // A playing reveal keeps asking for frames, and stops when it stops.
  const r3 = await renders(p);
  await p.evaluate(() => document.getElementById('reveal-play')?.click());
  await p.waitForTimeout(1000);
  const r4 = await renders(p);
  check('a playing reveal draws as it plays', r4 - r3 >= 3, `${r4 - r3} renders in 1 s`);
  await p.evaluate(() => document.getElementById('reveal-reset')?.click());
  await p.waitForTimeout(400);
  const r5 = await renders(p);
  await p.waitForTimeout(1000);
  check('and stops with it', (await renders(p)) === r5);
  check('no page errors while drawing on demand', e2.length === 0, e2.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Autosave writes what changed, when it changed, never mid-gesture
// (performance plan P2.11).
console.log('\n— autosave: only what changed, never mid-gesture —');
{
  const { ctx, p, errs: e2 } = await freshEditor();
  const m = await bowl(p);
  const id = await projId(p);
  const docKey = 'tifo_proj_' + id;
  const draftWrites = () => p.evaluate((k) => window.__writes.filter((w) => w.k === k), docKey);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 2; window.__writes.length = 0; });
  // A stroke held open past the longest wait (6 s) is not written until it ends.
  await strokeDown(p, m.x - 900, m.y);
  for (let i = 1; i <= 16; i++) { await strokeMove(p, m.x - 900 + i * 40, m.y + (i % 2) * 6); await p.waitForTimeout(480); }
  const during = await draftWrites();
  check('nothing is written in the middle of a stroke, even past the longest wait', during.length === 0, `${during.length} writes during a ${16 * 0.48} s stroke`);
  await strokeUp(p, m.x - 260, m.y);
  await p.waitForTimeout(900);
  const afterUp = await draftWrites();
  check('the stroke is written as soon as it ends', afterUp.length === 1 && !afterUp[0].inStroke, `${afterUp.length} writes`);
  check('…and what is written is the seats as they are', (await storedCells(p)) === (await liveCells(p)));
  // A short stroke: written after the trailing wait, not before it.
  await p.evaluate(() => { window.__writes.length = 0; });
  await stroke(p, [m.x - 200, m.y + 20], [m.x + 200, m.y + 20]);
  await p.waitForTimeout(900);
  const early = (await draftWrites()).length;
  await p.waitForTimeout(1600);
  const late = (await draftWrites()).length;
  check('a stroke is written a moment after the last change, not on top of it', early === 0 && late === 1, `${early} at 0.9 s, ${late} at 2.5 s`);
  // Strokes with short pauses between them: the longest wait still writes, between strokes.
  await p.evaluate(() => { window.__writes.length = 0; });
  for (let k = 0; k < 9; k++) {
    await stroke(p, [m.x - 700 + k * 50, m.y - 30], [m.x - 300 + k * 50, m.y - 30], 6);
    await p.waitForTimeout(700);
  }
  const series = await draftWrites();
  check('a run of strokes is still saved as it goes (the longest wait)', series.length >= 1, `${series.length} writes over ~9 s`);
  check('…and never mid-stroke', series.every((w) => !w.inStroke));
  await p.waitForTimeout(2200);

  // Layers: written when they change, not with every draft.
  await p.click('.tool-rail [data-tool="shape"]');
  await p.selectOption('#shape-kind', 'star');
  { const [x, y] = await p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [m.x + 600, m.y]); await p.mouse.click(x, y); }
  await p.waitForTimeout(2500);
  const readStack = () => p.evaluate((k) => new Promise((res) => {
    const rq = indexedDB.open('tifo-layers', 1);
    rq.onsuccess = () => { const tx = rq.result.transaction('docs', 'readonly'); const g = tx.objectStore('docs').get(k); g.onsuccess = () => res(g.result ?? null); g.onerror = () => res(null); };
    rq.onerror = () => res(null);
  }), docKey);
  let stack = await readStack();
  check('a new layer is kept in this browser', stack?.objects?.length === 1);
  const puts0 = await p.evaluate(() => window.__puts);
  await p.evaluate(() => { window.__writes.length = 0; });
  // A title change: the draft is written, the layer stack is not.
  await p.fill('#doc-title', 'Autosave check');
  await p.waitForTimeout(2600);
  check('a title change writes the draft', (await draftWrites()).length >= 1);
  check('…and leaves the layer stack alone', (await p.evaluate(() => window.__puts)) === puts0);
  check('…and the banners too', !(await p.evaluate((k) => window.__writes.some((w) => w.k === k + '_banners'), docKey)));
  // Moving the layer rewrites it, after the drag.
  await p.click('.tool-rail [data-tool="select"]');
  const o = await p.evaluate(() => { const o = window.__tifo.objects.list()[0]; return { cx: o.cx, cy: o.cy }; });
  const [ax, ay] = await p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [o.cx, o.cy]);
  await p.mouse.move(ax, ay); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(ax + i * 12, ay);
  await p.mouse.up();
  await p.waitForTimeout(2600);
  stack = await readStack();
  const moved = await p.evaluate(() => window.__tifo.objects.list()[0].cx);
  check('a moved layer is written where it went', stack && Math.abs(stack.objects[0].cx - moved) < 0.01 && moved > o.cx + 20, `${o.cx.toFixed(0)} → ${moved.toFixed(0)} (kept ${stack?.objects?.[0]?.cx?.toFixed(0)})`);
  // A stroke with a layer on the canvas: the stack follows the seats (its fingerprint), so it is written too.
  await p.click('.tool-rail [data-tool="brush"]');
  const puts1 = await p.evaluate(() => window.__puts);
  await stroke(p, [m.x - 800, m.y + 40], [m.x - 400, m.y + 40]);
  await p.waitForTimeout(2600);
  check('with layers, a stroke rewrites the stack once', (await p.evaluate(() => window.__puts)) === puts1 + 1);

  // A banner: written when it changes.
  await p.click('#view-banner');
  await p.waitForTimeout(900);
  await p.evaluate(() => { window.__writes.length = 0; });
  await p.click('#bn-empty button[data-kind="stand"]');
  await p.waitForTimeout(2600);
  const bannersKey = docKey + '_banners';
  const bw = await p.evaluate((k) => window.__writes.filter((w) => w.k === k).length, bannersKey);
  check('a new banner is written with the next draft', bw === 1, `${bw} writes`);
  await p.click('#view-2d');
  await p.waitForTimeout(600);

  // Reload: everything comes back exactly.
  const snap = () => p.evaluate((k) => ({
    cells: Array.from(window.__tifo.store.cells).join(','),
    palette: window.__tifo.store.palette.join(','),
    title: document.getElementById('doc-title').value,
    objects: JSON.stringify(window.__tifo.objects.list().map((o) => [o.id, o.kind, Math.round(o.cx * 100), Math.round(o.cy * 100), Math.round(o.width * 100), o.rotation])),
    banners: localStorage.getItem(k),
  }), bannersKey);
  const s0 = await snap();
  // A reload of the project (the address it went to has no e2e flag, so name it).
  await p.goto(B + `/app?local=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await p.waitForTimeout(2500);
  const s1 = await snap();
  check('after a reload: the seats', s1.cells === s0.cells);
  check('…the palette and the title', s1.palette === s0.palette && s1.title === s0.title, s1.title);
  check('…the layer, where it was moved to', s1.objects === s0.objects, s1.objects);
  check('…and the banner', !!s0.banners && s1.banners === s0.banners && JSON.parse(s1.banners).banners?.length === 1);

  // Leaving the page with a change still waiting writes it on the way out.
  await stroke(p, [m.x + 100, m.y - 20], [m.x + 500, m.y - 20]);
  await p.evaluate(() => { window.__tifo.store.setPalette([...window.__tifo.store.palette.slice(0, 3), '#123456', ...window.__tifo.store.palette.slice(4)]); });
  const live = await snap();
  await p.goto(B + '/favicon.svg', { waitUntil: 'load' });
  await p.goto(B + `/app?local=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await p.waitForTimeout(2500);
  const back = await snap();
  check('a change still waiting is written on leaving the page', back.cells === live.cells && back.palette === live.palette);
  // A tab sent to the background writes at once too: here a palette edit,
  // which schedules no autosave of its own (leaving is what writes it).
  await stroke(p, [m.x - 100, m.y + 10], [m.x + 100, m.y + 10]);
  await p.waitForTimeout(2600);
  await p.evaluate(() => { window.__writes.length = 0; });
  await p.evaluate(() => { const s = window.__tifo.store; s.setPalette([...s.palette.slice(0, 3), '#654321', ...s.palette.slice(4)]); });
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hid = await draftWrites();
  check('a hidden tab writes at once (synchronously, the old form)', hid.length >= 1 && hid[0].form === 'ls', JSON.stringify(hid.map((w) => w.form)));
  await p.waitForTimeout(1500);
  check('…and the compressed copy follows and replaces it', (await draftWrites()).some((w) => w.form === 'idb') && !(await readDraft(p, docKey)).old);
  await p.evaluate(() => { window.__writes.length = 0; document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForTimeout(800);
  check('…and hidden again with nothing new, it writes nothing', (await draftWrites()).length === 0);
  await p.evaluate(() => { delete document.visibilityState; });
  // Save means a real write, every time.
  await p.evaluate(() => { window.__writes.length = 0; });
  await p.click('#save-top');
  await p.waitForTimeout(800);
  check('Save writes for real, even with nothing new', (await draftWrites()).length >= 1);
  check('no page errors in the autosave checks', e2.length === 0, e2.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// The draft compressed in IndexedDB (performance plan P3.7): old drafts come
// forward, damaged ones are no draft and never a crash, and a browser without
// IndexedDB keeps working as before.
console.log('\n— autosave: compressed, in IndexedDB —');
{
  const { ctx, p, errs: e2 } = await freshEditor();
  const m = await bowl(p);
  const id = await projId(p);
  const key = 'tifo_proj_' + id;
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 2; });
  await stroke(p, [m.x - 600, m.y], [m.x + 600, m.y + 30]);
  await p.waitForTimeout(2600);
  const r0 = await readDraft(p, key);
  check('the draft is stored compressed in IndexedDB, with no copy in localStorage', r0?.form === 'idb' && !r0.old, `${r0?.form}, ${r0?.json?.length} characters in ${r0?.bytes} bytes`);
  const live = await liveCells(p);
  check('…and holds exactly the seats on screen', (await storedCells(p)) === live);
  /** Reopen this project and say what came back. */
  const reopen = async () => {
    await p.goto(B + `/app?local=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
    await p.waitForTimeout(1500);
    return liveCells(p);
  };
  check('a reload restores the seats exactly', (await reopen()) === live);

  // An old-form draft (from before, or written on the way out of a page) that
  // is newer than the compressed one is read, brought forward, and only then
  // removed from localStorage.
  const older = await p.evaluate(async (k) => {
    const d = JSON.parse(await new Promise((res) => {
      const rq = indexedDB.open('tifo-drafts', 1);
      rq.onsuccess = () => { const g = rq.result.transaction('drafts').objectStore('drafts').get(k); g.onsuccess = async () => { const t = await new Response(new Blob([g.result.gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); rq.result.close(); res(t); }; };
    }));
    // Every seat the third colour, saved a minute later than the compressed copy.
    const n = d.doc.layers[0].cellsRle.reduce((a, [, c]) => a + c, 0);
    d.doc.layers[0].cellsRle = [[3, n]];
    d.savedAt += 60_000;
    localStorage.setItem(k, JSON.stringify(d));
    return n;
  }, key);
  const migrated = await reopen();
  const r1 = await readDraft(p, key);
  check('a newer old-form draft is the one that opens', migrated === Array(older).fill(3).join(','));
  check('…and is brought forward: compressed in IndexedDB, the old key removed', r1?.form === 'idb' && !r1.old && JSON.parse(r1.json).doc.layers[0].cellsRle[0][0] === 3);
  // An old-form copy OLDER than the compressed one is superseded, not read.
  await p.evaluate((k) => { const r = localStorage; const d = { v: 1, savedAt: 1000, templateId: 'x', templateVersion: 1, title: 'stale', designId: null, doc: { layers: [] } }; r.setItem(k, JSON.stringify(d)); }, key);
  const kept = await reopen();
  check('an older old-form copy is not read, and is removed', kept === migrated && !(await readDraft(p, key)).old);
  check('no page errors bringing drafts forward', e2.length === 0, e2.join(' | '));

  // Damaged records: no draft, never a crash, and the project still opens.
  const plant = (kind) => p.evaluate(async ([k, kind]) => {
    const gz = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let rec;
    if (kind === 'corrupt') rec = { v: 2, savedAt: Date.now(), chars: 1000, gz: crypto.getRandomValues(new Uint8Array(4096)) };
    if (kind === 'truncated') {
      const good = await gz(new TextEncoder().encode(JSON.stringify({ v: 1, savedAt: Date.now(), doc: { layers: [] }, pad: 'x'.repeat(200000) })));
      rec = { v: 2, savedAt: Date.now(), chars: 200050, gz: good.slice(0, good.length >> 1) };
    }
    // A small record that unpacks to 8 MB: reading stops at the cap.
    if (kind === 'oversized') rec = { v: 2, savedAt: Date.now(), chars: 1_000_000, gz: await gz(new Uint8Array(8_000_000).fill(32)) };
    if (kind === 'not-ours') rec = { hello: 'world' };
    await new Promise((res) => { const rq = indexedDB.open('tifo-drafts', 1); rq.onsuccess = () => { const tx = rq.result.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(rec, k); tx.oncomplete = () => { rq.result.close(); res(); }; }; });
    localStorage.removeItem(k);
    return rec.gz?.byteLength ?? 0;
  }, [key, kind]);
  for (const kind of ['corrupt', 'truncated', 'oversized', 'not-ours']) {
    const size = await plant(kind);
    e2.length = 0;
    const t0 = Date.now();
    let opened = true;
    try { await reopen(); } catch { opened = false; }
    check(`a ${kind} stored draft is ignored: the project opens without it, and nothing breaks`, opened && e2.length === 0 && (await p.evaluate(() => window.__tifo.map.count > 0)), `${size} bytes stored; opened in ${Date.now() - t0} ms${e2.length ? ' | ' + e2.join(' | ') : ''}`);
  }
  // A gzip bomb (stage 3 security review): 1 GB of zeros in about 1 MB of
  // gzip, inside the size a record may have. Reading it back must stop at the
  // cap without unpacking the rest: handed to the decompressor in one piece it
  // was unpacked whole first (+1 GB of renderer memory, and a tab killed on
  // every open of the project with a record a little larger still).
  {
    const bomb = await new Promise((res, rej) => {
      const z = createGzip({ level: 9 });
      const parts = [];
      z.on('data', (d) => parts.push(d));
      z.on('end', () => res(Buffer.concat(parts)));
      z.on('error', rej);
      const zero = Buffer.alloc(1 << 20);
      let n = 0;
      const pump = () => { while (n < 1024) { n++; if (!z.write(zero)) { z.once('drain', pump); return; } } z.end(); };
      pump();
    });
    await p.evaluate(async ([k, b64]) => {
      const gz = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const rec = { v: 2, savedAt: Date.now(), chars: 1_000_000, gz };
      await new Promise((res) => { const rq = indexedDB.open('tifo-drafts', 1); rq.onsuccess = () => { const tx = rq.result.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(rec, k); tx.oncomplete = () => { rq.result.close(); res(); }; }; });
      localStorage.removeItem(k);
    }, [key, bomb.toString('base64')]);
    e2.length = 0;
    const before = rendererMB();
    let peak = before;
    const sampler = setInterval(() => { peak = Math.max(peak, rendererMB()); }, 20);
    const t0 = Date.now();
    let opened = true;
    try { await reopen(); } catch { opened = false; }
    clearInterval(sampler);
    const grew = Math.round(peak - before);
    check(`a gzip bomb (${(bomb.length / 1024).toFixed(0)} KB stored, 1 GB unpacked) is ignored, and the project opens`, opened && e2.length === 0 && (await p.evaluate(() => window.__tifo.map.count > 0)), `opened in ${Date.now() - t0} ms${e2.length ? ' | ' + e2.join(' | ') : ''}`);
    if (before > 0) check('…without unpacking it: the page\'s memory grows by far less than the bomb', grew < 400, `renderer memory ${Math.round(before)} → ${Math.round(peak)} MB at its peak (+${grew} MB)`);
    else console.log('  (renderer memory not readable here: /proc is missing)');
  }
  // …and the next save writes a sound one over it.
  await stroke(p, [m.x - 300, m.y], [m.x + 300, m.y]);
  await p.waitForTimeout(2600);
  const r2 = await readDraft(p, key);
  check('after a damaged draft, the next save stores a sound one', r2?.form === 'idb' && !!r2.json && JSON.parse(r2.json).v === 1);

  // A store that fails (not "no draft"): the project is not opened over its draft.
  await p.addInitScript(() => {
    if (sessionStorage.getItem('__idbFails') !== '1') return;
    IDBFactory.prototype.open = function () { const rq = {}; setTimeout(() => { rq.error = { name: 'UnknownError' }; rq.onerror?.(); }, 0); return rq; };
  });
  await p.evaluate(() => sessionStorage.setItem('__idbFails', '1'));
  await p.goto(B + `/app?local=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  const backToList = await p.waitForFunction(() => location.pathname === '/projects' && /could not be opened/.test(document.querySelector('.pj-toast')?.textContent || ''), null, { timeout: 60000 }).then(() => true).catch(() => false);
  check('a store that cannot be read sends the project back to the list (and says so), not into an empty editor', backToList, p.url());
  await p.evaluate(() => sessionStorage.removeItem('__idbFails'));
  await p.goto(B + '/legal', { waitUntil: 'load' });
  check('…and its draft is untouched', (await readDraft(p, key))?.json === r2.json);
  await ctx.close();
}
{
  // No IndexedDB at all (some private modes, blocked storage): as before, in localStorage.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((ls) => {
    try { for (const [k, v] of Object.entries(ls)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* */ }
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  }, LS0);
  const p = await ctx.newPage();
  const e3 = [];
  p.on('pageerror', (e) => e3.push(String(e.message).slice(0, 200)));
  await p.goto(B + '/app?new=1&e2e=1', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await p.waitForTimeout(2000);
  const m = await bowl(p);
  await p.evaluate(() => { window.__tifo.editor.colorIndex = 2; });
  await stroke(p, [m.x - 500, m.y], [m.x + 500, m.y]);
  await p.waitForTimeout(2600);
  const id = await projId(p);
  const stored = await p.evaluate((k) => localStorage.getItem(k), 'tifo_proj_' + id);
  check('without IndexedDB, the draft is kept in localStorage as before', !!stored && JSON.parse(stored).v === 1);
  check('…and the editor says it is saved in this browser', /this browser/i.test(await p.evaluate(() => document.getElementById('save-state-top')?.textContent || document.getElementById('draft-state')?.textContent || '')));
  const live = await liveCells(p);
  // (The project's own address has no e2e flag, so it is named.)
  await p.goto(B + `/app?local=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__tifo && /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  check('…and a reload restores it exactly', (await liveCells(p)) === live);
  check('no page errors without IndexedDB', e3.length === 0, e3.join(' | '));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close();
process.exit(fail?1:0);
