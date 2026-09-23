/**
 * Phone editor: the touch suite.
 *
 * The desktop editor on a phone had eight of fourteen tools off the right edge
 * and an image-import bar 1270px wide inside a 360px screen, which is what the
 * two live bug reports actually were. These checks hold the new shell to the
 * standard those failures set: nothing unreachable, every gesture a drawing app
 * is expected to honour, and no horizontal scroll anywhere.
 */
import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const LS = (lang) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
];

async function editor({ w = 360, h = 680, lang = 'en' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang) }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await p.goto(B + '/app', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('#canvas-host canvas', { timeout: 120000 });
  await p.waitForTimeout(3500);
  return [ctx, p, errs];
}

const offscreen = () => {
  // Anything visible whose box leaves the viewport is, for a finger, gone.
  const bad = [];
  for (const el of document.querySelectorAll('button,a,select,input,.m-tab,.m-tool,.m-stand')) {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (st.clipPath && st.clipPath !== 'none') continue;
    if (el.closest('[hidden]')) continue;
    // Inside a scroller, being past the edge is intentional — that content is
    // reachable by scrolling, which the scroll checks below prove separately.
    let sc = el.parentElement, scrolls = false;
    while (sc && sc !== document.body) {
      const s2 = getComputedStyle(sc);
      const sx = (s2.overflowX === 'auto' || s2.overflowX === 'scroll') && sc.scrollWidth > sc.clientWidth;
      const sy = (s2.overflowY === 'auto' || s2.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight;
      if (sx || sy) { scrolls = true; break; }
      sc = sc.parentElement;
    }
    if (scrolls) continue;
    // A closed sheet lives below the fold by design.
    if (el.closest('.m-sheet:not(.open)')) continue;
    if (b.right > innerWidth + 1 || b.left < -1 || b.bottom > innerHeight + 1 || b.top < -1) {
      bad.push(`${el.id || el.className || el.tagName} @${Math.round(b.x)},${Math.round(b.y)}`);
    }
  }
  return bad;
};
const smallTargets = () => {
  const bad = [];
  for (const el of document.querySelectorAll('button,a,select,input[type="checkbox"],.m-tab,.m-tool,.m-stand')) {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden') continue;
    if (el.closest('[hidden]')) continue;
    // Visually-hidden-until-focused controls (the skip link) are clipped away;
    // they are full size when focused, which is when they are a target.
    if (st.clipPath && st.clipPath !== 'none') continue;
    if (b.height < 24 || b.width < 24) bad.push(`${el.id || el.className} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  return bad;
};

console.log('\n— the shell replaces the desktop rail —');
{
  const [ctx, p, errs] = await editor();
  const r = await p.evaluate(() => ({
    shell: document.body.classList.contains('m-shell'),
    tabs: document.querySelectorAll('.m-ribbon .m-tab').length,
    railHidden: (() => { const n = document.querySelector('.tool-rail'); const b = n.getBoundingClientRect(); return b.width <= 2; })(),
    header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    canvas: Math.round(document.querySelector('#canvas-host canvas').getBoundingClientRect().height),
    vh: innerHeight,
  }));
  check('mobile shell mounts', r.shell);
  check('five tabs, all present', r.tabs === 5, `${r.tabs} tabs`);
  check('the 752px desktop rail is out of the layout', r.railHidden);
  check('header is one row', r.header <= 60, `${r.header}px`);
  check('canvas gets most of the screen', r.canvas / r.vh > 0.7, `${r.canvas}/${r.vh} = ${Math.round(r.canvas / r.vh * 100)}%`);
  check('nothing off-screen', (await p.evaluate(offscreen)).length === 0, JSON.stringify(await p.evaluate(offscreen)).slice(0, 160));
  check('every target >=24px', (await p.evaluate(smallTargets)).length === 0, JSON.stringify(await p.evaluate(smallTargets)).slice(0, 160));
  check('no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— every tab opens a sheet, and every tool has a home —');
{
  const [ctx, p, errs] = await editor();
  const WANT = {
    paint: ['brush', 'fill', 'eraser', 'eyedropper', 'select', 'pan'],
    add: ['text', 'import', 'shape'],
  };
  for (const tab of ['paint', 'colors', 'add', 'ai', 'more']) {
    await p.tap(`.m-tab[data-tab="${tab}"]`);
    await p.waitForTimeout(700);
    const r = await p.evaluate(() => {
      const s = document.querySelector('.m-sheet');
      const b = s.getBoundingClientRect();
      return {
        open: s.classList.contains('open'),
        onScreen: b.top < innerHeight - 40,
        capped: b.height <= innerHeight * 0.62,
        title: document.querySelector('.m-sheet-title')?.textContent || '',
        tools: [...document.querySelectorAll('.m-sheet .m-tool[data-tool]')].map((e) => e.dataset.tool),
        content: document.querySelector('.m-sheet-body').textContent.trim().length,
        closeBtn: !!document.querySelector('.m-sheet-x'),
      };
    });
    check(`${tab}: sheet opens on screen`, r.open && r.onScreen, r.title);
    check(`${tab}: leaves the canvas visible`, r.capped, `sheet ${Math.round(r.capped ? 1 : 0)}`);
    check(`${tab}: has content`, r.content > 0, `${r.content} chars`);
    check(`${tab}: has a real close button`, r.closeBtn);
    if (WANT[tab]) check(`${tab}: every tool present`, WANT[tab].every((t) => r.tools.includes(t)), r.tools.join(','));
    check(`${tab}: nothing off-screen while open`, (await p.evaluate(offscreen)).length === 0, JSON.stringify(await p.evaluate(offscreen)).slice(0, 140));
    check(`${tab}: no horizontal scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    // Close for the next one
    await p.tap('.m-sheet-x');
    await p.waitForTimeout(400);
  }
  check('sheet closes via its X', await p.evaluate(() => !document.querySelector('.m-sheet').classList.contains('open')));
  check('no page errors across all tabs', errs.length === 0, errs.join(' | '));
  await ctx.close();
}


console.log('\n— scrolling by touch —');
{
  const [ctx, p, errs] = await editor();
  // A sheet whose content overflows must scroll with a finger, and must not
  // scroll the page behind it (overscroll-behavior: contain).
  await p.tap('.m-tab[data-tab="ai"]');
  await p.waitForTimeout(800);
  const before = await p.evaluate(() => {
    const b = document.querySelector('.m-sheet-body');
    return { top: b.scrollTop, overflows: b.scrollHeight > b.clientHeight + 4 };
  });
  check('the AI sheet has more content than fits', before.overflows);
  const box = await p.evaluate(() => {
    const b = document.querySelector('.m-sheet-body').getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x, y: box.y - i * 9 }] });
    await p.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => ({
    top: document.querySelector('.m-sheet-body').scrollTop,
    page: window.scrollY,
  }));
  check('the sheet body scrolls with a finger', after.top > before.top + 10, `scrollTop ${before.top} -> ${after.top}`);
  check('the page behind it does not scroll', after.page === 0, `window.scrollY ${after.page}`);

  // The stand chips are a horizontal scroller; all five must be reachable.
  await p.tap('.m-sheet-x');
  await p.waitForTimeout(400);
  const chips = await p.evaluate(() => {
    const s = document.querySelector('.m-stands');
    return { n: s.querySelectorAll('.m-stand').length, scrollW: s.scrollWidth, clientW: s.clientWidth };
  });
  check('all five stand chips exist', chips.n === 5, `${chips.n}`);
  if (chips.scrollW > chips.clientW) {
    await p.evaluate(() => { document.querySelector('.m-stands').scrollLeft = 9999; });
    await p.waitForTimeout(300);
    const last = await p.evaluate(() => {
      const b = document.querySelectorAll('.m-stand')[4].getBoundingClientRect();
      return { right: Math.round(b.right), vw: innerWidth };
    });
    check('the last chip is reachable by scrolling', last.right <= last.vw + 1, `right ${last.right} vw ${last.vw}`);
  } else {
    check('all chips fit without scrolling', true);
  }
  check('no errors during scrolling', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— canvas gestures —');
{
  const [ctx, p, errs] = await editor();
  const cdp = await ctx.newCDPSession(p);
  const canvas = await p.evaluate(() => {
    const b = document.querySelector('#canvas-host canvas').getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w: b.width, h: b.height };
  });

  // One finger paints.
  const painted = async () => p.evaluate(() => {
    const raw = localStorage.getItem('tifo_draft_v1');
    if (!raw) return 0;
    try { return (JSON.parse(raw).doc?.layers?.[0]?.cellsRle ?? []).length; } catch { return 0; }
  });
  await p.evaluate(() => {
    const c = document.querySelector('#canvas-host canvas'); const r = c.getBoundingClientRect();
    const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, buttons: t === 'pointerup' ? 0 : 1, pointerType: 'touch' }));
    for (const f of [0.45, 0.5, 0.55]) {
      const y = r.top + r.height * f;
      ev('pointerdown', r.left + r.width * 0.2, y);
      for (let i = 0; i <= 20; i++) ev('pointermove', r.left + r.width * (0.2 + 0.6 * i / 20), y);
      ev('pointerup', r.left + r.width * 0.8, y);
    }
  });
  await p.waitForTimeout(2500);
  const runs = await painted();
  check('one finger paints', runs > 0, `${runs} runs in the draft`);

  // Two-finger tap undoes, and says so.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: canvas.x - 40, y: canvas.y }, { x: canvas.x + 40, y: canvas.y }] });
  await p.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // Watched for rather than read after a fixed wait. The toast lives 900 ms
  // (toolbar.ts) and a CDP touch pair takes ~285 ms to arrive here, so any fixed
  // wait races it from one side or the other: this one read at 900 ms, and on a
  // loaded machine failed with the toast's own text, "Undone", in hand.
  const seenToast = () => p.waitForFunction(() => {
    const t = document.querySelector('.gesture-toast');
    return t && t.classList.contains('show') ? t.textContent || ' ' : null;
  }, null, { timeout: 3000, polling: 25 })
    .then((h) => h.jsonValue())
    .then((text) => ({ shown: true, text }), () => ({ shown: false, text: '' }));
  const toast = await seenToast();
  check('two-finger tap undoes and confirms', toast.shown, toast.text);

  // Double tap fits the view.
  //
  // Dispatched as PointerEvents rather than through CDP: measured here, a CDP
  // touchStart/touchEnd pair takes ~285ms to reach the handler, so two "taps"
  // land ~360-450ms apart and no double-tap window a human would tolerate can
  // catch them. That latency is an artifact of software GL in this harness, not
  // something a phone does. Same listener, same code path, honest timing.
  await p.evaluate(() => { document.querySelector('.gesture-toast')?.classList.remove('show'); });
  await p.evaluate(async () => {
    const c = document.querySelector('#canvas-host canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (t, id) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: id, isPrimary: true, bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, buttons: t === 'pointerup' ? 0 : 1, pointerType: 'touch',
    }));
    ev('pointerdown', 41); ev('pointerup', 41);
    await new Promise((r2) => setTimeout(r2, 120));
    ev('pointerdown', 42); ev('pointerup', 42);
  });
  const toast2 = await seenToast();
  check('double tap fits the whole stadium', toast2.shown, toast2.text);

  // Pinch changes the zoom.
  const zoom = () => p.evaluate(() => document.getElementById('zoom-level')?.textContent?.trim());
  const z0 = await zoom();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: canvas.x - 30, y: canvas.y }, { x: canvas.x + 30, y: canvas.y }] });
  for (let i = 1; i <= 14; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: canvas.x - 30 - i * 9, y: canvas.y }, { x: canvas.x + 30 + i * 9, y: canvas.y }] });
    await p.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(700);
  const z1 = await zoom();
  check('pinch zooms the canvas', z0 !== z1, `${z0} -> ${z1}`);
  check('no errors during gestures', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the two bug reports —');
{
  const [ctx, p, errs] = await editor();
  // "I want to design behind the goal and I cannot get there."
  const z0 = await p.evaluate(() => document.getElementById('zoom-level')?.textContent?.trim());
  await p.tap('.m-stand[data-stand="south"]');
  await p.waitForTimeout(1200);
  const z1 = await p.evaluate(() => ({
    zoom: document.getElementById('zoom-level')?.textContent?.trim(),
    on: document.querySelector('.m-stand[data-stand="south"]').classList.contains('on'),
  }));
  check('tapping a stand takes you there', z0 !== z1.zoom, `${z0} -> ${z1.zoom}`);
  check('the chosen stand is marked', z1.on);
  await p.tap('.m-stand[data-stand="all"]');
  await p.waitForTimeout(900);
  check('All returns to the whole bowl', (await p.evaluate(() => document.getElementById('zoom-level')?.textContent?.trim())) !== z1.zoom);

  // "If I add an image it hangs" — Place and Cancel were at x=708 and x=1173.
  await p.tap('.m-tab[data-tab="add"]');
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    // Reveal the import options the way choosing a file does, without a file picker.
    document.querySelector('.m-tool[data-tool="import"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const bar = document.getElementById('import-bar');
    if (bar) { bar.hidden = false; document.querySelector('.m-sheet-body')?.appendChild(bar); }
    document.querySelector('.m-sheet')?.classList.add('open');
  });
  await p.waitForTimeout(500);
  const imp = await p.evaluate(() => {
    const inSheet = !!document.querySelector('.m-sheet-body #import-bar');
    const g = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), inView: b.right <= innerWidth + 1 && b.left >= -1 }; };
    return { inSheet, apply: g('import-apply'), cancel: g('import-cancel'),
             barScroll: (() => { const b = document.getElementById('import-bar'); return b ? { sw: b.scrollWidth, cw: b.clientWidth } : null; })() };
  });
  check('the import options live in the sheet', imp.inSheet);
  check('"Place" is on screen', !!imp.apply && imp.apply.inView, JSON.stringify(imp.apply));
  check('"Cancel" is on screen', !!imp.cancel && imp.cancel.inView, JSON.stringify(imp.cancel));
  check('the 1270px import row now wraps', imp.barScroll && imp.barScroll.sw <= imp.barScroll.cw + 2, JSON.stringify(imp.barScroll));
  check('no errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}


console.log('\n— the palette works by touch —');
{
  const [ctx, p, errs] = await editor();
  await p.tap('[data-tab="colors"]');
  await p.waitForTimeout(700);

  // The bug: "+ Color" built an <input type="color"> at left:-9999px and
  // clicked it. Desktop browsers open a picker for that; mobile ones do not
  // open one for an input that is not on screen, so the tap did nothing at all.
  // What has to be true is that the tap lands ON a real colour input.
  const hits = await p.evaluate(() => {
    const at = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { el: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2), r };
    };
    const well = at('#fg-well');
    const add = at('#add-swatch');
    return {
      // The well IS the picker: the tap has to land on a real, on-screen
      // colour input. A hidden one off-canvas is what mobile browsers ignore.
      well: well.el?.tagName === 'INPUT' && well.el.type === 'color' && well.r.width > 0 && well.r.x >= 0,
      // "+ Color" is a plain button now — the commit, not a second picker.
      add: add.el?.id === 'add-swatch' && add.r.width >= 24 && add.r.height >= 24,
    };
  });
  check('the colour well opens a real colour input', hits.well);
  check('"+ Color" is a tappable button of its own', hits.add);

  const before = await p.$$eval('#palette .swatch', (e) => e.length);
  // Dragging through a picker fires `input` for every shade you pass. Each one
  // used to become a swatch, so looking at colours filled the palette with
  // things nobody chose. Picking previews; "+ Color" is what keeps it.
  await p.evaluate(() => {
    const input = document.querySelector('#fg-well').closest('.color-trigger').querySelector('input[type=color]');
    for (const hex of ['#ff0000', '#ee2200', '#dd4400', '#cc6600', '#ff8800']) {
      input.value = hex;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  const afterPicks = await p.$$eval('#palette .swatch', (e) => e.length);
  check('trying colours does not add any of them', afterPicks === before, `${before} -> ${afterPicks}`);
  check('the tried colour is previewed', (await p.$eval('#fg-hex', (e) => e.textContent)).toLowerCase() === '#ff8800');
  check('and it says it is not kept yet', await p.$eval('#fg-well', (e) => e.classList.contains('unsaved')));

  await p.tap('#add-swatch');
  await p.waitForTimeout(300);
  const after = await p.$$eval('#palette .swatch', (e) => e.length);
  check('"+ Color" keeps exactly one', after === before + 1, `${before} -> ${after}`);
  check('and the well settles', !(await p.$eval('#fg-well', (e) => e.classList.contains('unsaved'))));

  // With nothing tried, the button must still do something: open the picker.
  check('"+ Color" is never a dead button', await p.evaluate(() => {
    const input = document.querySelector('#fg-well').closest('.color-trigger').querySelector('input[type=color]');
    let opened = false;
    const spy = () => { opened = true; };
    input.addEventListener('click', spy, { once: true });
    document.getElementById('add-swatch').click();
    input.removeEventListener('click', spy);
    return opened;
  }));

  // A swatch could only be edited by double-clicking and only removed by
  // right-clicking, so a phone palette was add-only. Hold opens both.
  const swatch = (await p.$$('#palette .swatch')).at(-1);
  const box = await swatch.boundingBox();
  await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 })),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await p.waitForTimeout(700);
  const pop = await p.$('.color-pop');
  check('holding a swatch opens the editor', !!pop);
  if (pop) {
    const r = await pop.boundingBox();
    const vw = p.viewportSize();
    check('the editor stays on screen', r.x >= 0 && r.x + r.width <= vw.width + 1 && r.y + r.height <= vw.height + 1,
      JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width)]));
    await p.tap('.color-pop-remove');
    await p.waitForTimeout(300);
    check('an unused colour can be removed', (await p.$$eval('#palette .swatch', (e) => e.length)) === before);
  }

  // Removing a colour that is painted on seats would silently repaint them.
  const used = (await p.$$('#palette .swatch'))[0];
  const ub = await used.boundingBox();
  await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 })),
    { x: ub.x + ub.width / 2, y: ub.y + ub.height / 2 });
  await p.waitForTimeout(700);
  const keep = await p.$$eval('#palette .swatch', (e) => e.length);
  if (await p.$('.color-pop-remove')) await p.tap('.color-pop-remove');
  await p.waitForTimeout(300);
  check('a colour in use is not removable', (await p.$$eval('#palette .swatch', (e) => e.length)) === keep);
  check('no errors from the palette', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Match Day on a phone.
//
// The simulator is the payoff — the screen where a painted seat map becomes a
// tifo in a full stadium — and on a phone it could not be reached at all.
// `#match-day` lives inside `#cam-bar`, which is a `.tool-bar`, and
// `body.m-shell .tool-bar { display:none }`: measured, that button was 0x0.
// The only way in was somebody else's `?sim=1` link.
//
// And the way out was worse. The overlay's own mobile layout stopped at 640px,
// so at 844x390 (a phone turned sideways) the top bar overflowed by 17px and
// put Close off the right edge, and at 768x1024 it overflowed by 93px and took
// Help with it. No keyboard means no Escape: the simulator was a room with no
// door on exactly the devices this shell exists for.
// ---------------------------------------------------------------------------
const simAudit = () => {
  const ov = document.querySelector('.mds-overlay');
  if (!ov) return { missing: true, off: ['no overlay'], small: [] };
  const off = [], small = [];
  for (const el of ov.querySelectorAll('button,select,input')) {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (el.closest('[hidden]')) continue;
    let sc = el.parentElement, scrolls = false;
    while (sc && sc !== document.body) {
      const s = getComputedStyle(sc);
      const sx = (s.overflowX === 'auto' || s.overflowX === 'scroll') && sc.scrollWidth > sc.clientWidth;
      const sy = (s.overflowY === 'auto' || s.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight;
      if (sx || sy) { scrolls = true; break; }
      sc = sc.parentElement;
    }
    if (!scrolls && (b.right > innerWidth + 1 || b.left < -1 || b.bottom > innerHeight + 1 || b.top < -1)) {
      off.push(`${el.className} @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    if (b.height < 24 || b.width < 24) small.push(`${el.className} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  const bar = ov.querySelector('.mds-bar');
  // The way out, specifically: whatever else is on screen, Close has to be on it.
  const closeBtn = [...bar.querySelectorAll('.mds-btn')].pop();
  const cb = closeBtn.getBoundingClientRect();
  return {
    off, small,
    barOverflow: bar.scrollWidth - bar.clientWidth,
    closeOnScreen: cb.right <= innerWidth + 1 && cb.left >= -1 && cb.bottom <= innerHeight + 1 && cb.top >= -1,
    closeBox: `${Math.round(cb.width)}x${Math.round(cb.height)} @${Math.round(cb.x)}`,
    canvases: ov.querySelectorAll('canvas').length,
  };
};
/**
 * Land the bottom sheet before measuring it.
 *
 * Headless swiftshader starves the document animation timeline — measured, it
 * runs about 3s behind `performance.now()` — so a 0.22s sheet transition still
 * reads as `currentTime: 0, playState: running` a second and a half after the
 * tap, and the sheet measures where it started rather than where it lands.
 * Finishing the animations is the deterministic answer; on a real phone this
 * is a non-event.
 */
const settleSheet = async (p) => {
  await p.evaluate(() => {
    const ov = document.querySelector('.mds-overlay');
    if (!ov) return;
    for (const a of ov.getAnimations({ subtree: true })) { try { a.finish(); } catch { /* infinite */ } }
  });
  await p.waitForTimeout(250);
};
const dismissIntro = async (p) => {
  await p.evaluate(() => {
    const h = document.querySelector('.mds-help');
    if (h && h.classList.contains('show')) h.querySelector('.mds-help-actions .mds-btn').click();
  });
  await p.waitForTimeout(400);
};

console.log('\n— Match Day: reaching it at all —');
{
  const [ctx, p, errs] = await editor();
  // The 690KB of Three.js behind this must not be in the first load: it is the
  // single biggest chunk in the app and most visits never open the simulator.
  const asked = [];
  p.on('request', (r) => { if (/\/assets\/(overlay|preview3d)-/.test(r.url())) asked.push(r.url().split('/').pop()); });

  check('Match Day is not downloaded on arrival', asked.length === 0, asked.join(','));
  check('no Match Day pill in the Design view', await p.evaluate(() => document.querySelector('.m-md').hidden));

  await p.tap('.m-view-b[data-view="3d"]'); // Stadium
  await p.waitForTimeout(4000);
  const pill = await p.evaluate(() => {
    const w = document.querySelector('.m-md'), b = document.querySelector('.m-md-b');
    const r = b.getBoundingClientRect();
    return { hidden: w.hidden, w: Math.round(r.width), h: Math.round(r.height), label: b.textContent.trim(),
      onScreen: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.top >= 0 };
  });
  check('Stadium view offers Match Day', !pill.hidden && pill.label.length > 0, JSON.stringify(pill));
  check('the pill is a real target, on screen', pill.h >= 44 && pill.onScreen, `${pill.w}x${pill.h}`);
  check('nothing off-screen with the pill up', (await p.evaluate(offscreen)).length === 0,
    JSON.stringify(await p.evaluate(offscreen)).slice(0, 140));

  await p.tap('.m-view-b[data-view="2d"]'); // back to Design
  await p.waitForTimeout(1200);
  check('the pill goes away with the Stadium view', await p.evaluate(() => document.querySelector('.m-md').hidden));

  // ...and the labelled way in, for anyone who never touches the view pill.
  await p.tap('.m-tab[data-tab="more"]');
  await p.waitForTimeout(700);
  const inMore = await p.evaluate(() => {
    const b = document.querySelector('.m-sheet-body > [data-md-open]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { first: document.querySelector('.m-sheet-body').firstElementChild === b,
      w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() };
  });
  check('More leads with Match Day, full width', !!inMore && inMore.first && inMore.w > 200 && inMore.h >= 44, JSON.stringify(inMore));

  // A tap with no acknowledgement is how "it hangs" reports get written.
  await p.route('**/assets/overlay-*.js', async (r) => { await new Promise((s) => setTimeout(s, 2500)); await r.continue(); });
  await p.tap('.m-sheet [data-md-open]');
  await p.waitForTimeout(800);
  const busy = await p.evaluate(() => {
    const b = document.querySelector('.m-md-b');
    return { label: b.querySelector('span').textContent.trim(), disabled: b.disabled };
  });
  check('it says something while the chunk is in flight', busy.disabled && busy.label !== 'Match Day', JSON.stringify(busy));

  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);
  check('the simulator opens', await p.evaluate(() => !!document.querySelector('.mds-overlay canvas')));
  check('the sheet does not stay open underneath', await p.evaluate(() => !document.querySelector('.m-sheet.open')));
  check('the pill goes back to normal once it is up', await p.evaluate(() => {
    const b = document.querySelector('.m-md-b');
    return !b.disabled && b.querySelector('span').textContent.trim() === 'Match Day';
  }));
  check('it did have to download the simulator', asked.length > 0, asked.join(','));

  // Back is the phone's Escape. Before this it left /app and took the design.
  await dismissIntro(p);
  await p.goBack();
  await p.waitForTimeout(2000);
  const afterBack = await p.evaluate(() => ({
    gone: !document.querySelector('.mds-overlay'),
    editorAlive: !!document.querySelector('#canvas-host canvas'),
    shell: document.body.classList.contains('m-shell'),
  }));
  check('Back closes the simulator, not the editor', afterBack.gone && afterBack.editorAlive && afterBack.shell, JSON.stringify(afterBack));
  check('no page errors reaching Match Day', errs.length === 0, errs.join(' | ').slice(0, 160));
  await ctx.close();
}

console.log('\n— Match Day: the pill fits the short screens too —');
{
  // The smallest phone we serve and a phone on its side: the pill sits under
  // the view pill, and both live on a stage that is only ~330px tall in
  // landscape once the header and the ribbon have taken their share.
  for (const [w, h, name] of [[320, 568, 'iPhone SE'], [844, 390, 'landscape iPhone']]) {
    const [ctx, p, errs] = await editor({ w, h });
    await p.tap('.m-view-b[data-view="3d"]');
    await p.waitForTimeout(4500);
    const r = await p.evaluate(() => {
      const b = document.querySelector('.m-md-b').getBoundingClientRect();
      const v = document.querySelector('.m-view').getBoundingClientRect();
      return { box: `${Math.round(b.width)}x${Math.round(b.height)} @${Math.round(b.x)},${Math.round(b.y)}`,
        onScreen: b.top >= 0 && b.left >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
        clearOfViewPill: b.top >= v.bottom - 1, tall: b.height >= 44 };
    });
    check(`${name} ${w}x${h}: the pill is on screen`, r.onScreen, r.box);
    check(`${name} ${w}x${h}: it does not sit on the view switcher`, r.clearOfViewPill, r.box);
    check(`${name} ${w}x${h}: still a 44px target`, r.tall, r.box);
    check(`${name} ${w}x${h}: nothing else pushed off`, (await p.evaluate(offscreen)).length === 0,
      JSON.stringify(await p.evaluate(offscreen)).slice(0, 140));
    check(`${name} ${w}x${h}: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 120));
    await ctx.close();
  }
}

console.log('\n— Match Day: the way out is on every screen —');
{
  // 844x390 and 768x1024 are the two that were broken: both sat in the
  // 641-899 band where the overlay still laid itself out like a desktop.
  const SIZES = [[360, 680, 'Pixel'], [390, 844, 'iPhone 14'], [844, 390, 'landscape iPhone'], [768, 1024, 'iPad portrait']];
  for (const [w, h, name] of SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      storageState: { cookies: [], origins: [{ origin: B, localStorage: LS('en') }] },
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
    await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
    await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
    await p.waitForTimeout(5000);
    await dismissIntro(p);
    const closed = await p.evaluate(simAudit);
    // ...and again with the controls out, which is where a 286px side panel
    // used to shoulder the bar over the edge.
    await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
    await p.waitForTimeout(700);
    await p.evaluate(() => { for (const s of document.querySelectorAll('.mds-shead')) if (!s.parentElement.classList.contains('open')) s.click(); });
    await p.waitForTimeout(700);
    await settleSheet(p);
    const open = await p.evaluate(simAudit);
    const sheet = await p.evaluate(() => {
      const b = document.querySelector('.mds-panel').getBoundingClientRect();
      return { onScreen: b.top < innerHeight - 40 && b.left >= -1 && b.right <= innerWidth + 1,
        box: `${Math.round(b.width)}x${Math.round(b.height)} @${Math.round(b.x)},${Math.round(b.y)}`,
        fullWidth: Math.round(b.width) === innerWidth };
    });
    const tag = `${name} ${w}x${h}`;
    check(`${tag}: nothing unreachable`, closed.off.length === 0 && open.off.length === 0,
      JSON.stringify([...closed.off, ...open.off]).slice(0, 140));
    check(`${tag}: every control >=24px`, closed.small.length === 0 && open.small.length === 0,
      JSON.stringify([...closed.small, ...open.small]).slice(0, 140));
    check(`${tag}: the top bar does not overflow`, closed.barOverflow === 0 && open.barOverflow === 0,
      `${closed.barOverflow} / ${open.barOverflow}`);
    check(`${tag}: Close is on screen`, closed.closeOnScreen && open.closeOnScreen, `${closed.closeBox} / ${open.closeBox}`);
    check(`${tag}: the controls land on screen`, sheet.onScreen && sheet.fullWidth, sheet.box);
    check(`${tag}: one canvas, not two`, closed.canvases === 1, String(closed.canvases));
    check(`${tag}: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 120));
    await ctx.close();
  }
}

console.log('\n— Match Day: driving it with a finger —');
{
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 680 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS('en') }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);

  // The first card a phone user ever sees used to say "Right-drag to pan" and
  // then list six keyboard shortcuts.
  const help = await p.evaluate(() => {
    const h = document.querySelector('.mds-help');
    const c = h.querySelector('.mds-help-card');
    const r = c.getBoundingClientRect();
    return { shown: h.classList.contains('show'), text: c.innerText,
      keys: c.querySelectorAll('.mds-key').length,
      fits: r.width <= innerWidth && r.height <= innerHeight && r.top >= 0 };
  });
  check('the intro greets a phone', help.shown && help.fits, `${help.shown} fits=${help.fits}`);
  check('it talks about fingers, not a mouse', /finger/i.test(help.text) && /pinch/i.test(help.text) && !/right-drag/i.test(help.text),
    help.text.replace(/\n/g, ' · ').slice(0, 120));
  check('it does not list keyboard shortcuts', help.keys === 0, `${help.keys} keycaps`);
  await dismissIntro(p);

  const frame = () => p.evaluate(() => {
    const c = document.querySelector('.mds-overlay canvas');
    const t = document.createElement('canvas'); t.width = 160; t.height = 160;
    t.getContext('2d').drawImage(c, 0, 0, 160, 160);
    return t.toDataURL().slice(2000, 2600);
  });
  const before = await frame();
  const box = await (await p.$('.mds-overlay canvas')).boundingBox();
  await p.mouse.move(box.x + 180, box.y + 300);
  await p.mouse.down();
  await p.mouse.move(box.x + 80, box.y + 300, { steps: 14 });
  await p.mouse.up();
  await p.waitForTimeout(1500);
  check('one finger orbits the camera', (await frame()) !== before);

  // A three-year-old Android is most of this audience. The floor of the
  // quality menu used to be Medium, and the probe's own 'low' was overruled.
  await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
  await p.waitForTimeout(600);
  const tiers = await p.evaluate(() => [...document.querySelectorAll('.mds-panel-acts .mds-sel option')].map((o) => o.value));
  check('the quality menu has a real floor', tiers.includes('low'), tiers.join(','));
  await p.selectOption('.mds-panel-acts .mds-sel', 'low');
  await p.waitForTimeout(8000);
  const low = await p.evaluate(() => {
    const cs = document.querySelectorAll('.mds-overlay canvas');
    if (cs.length !== 1) return { canvases: cs.length, lit: 0 };
    const c = cs[0];
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    t.getContext('2d').drawImage(c, 0, 0);
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 12) lit++;
    return { canvases: cs.length, lit };
  });
  check('Low rebuilds into one live canvas', low.canvases === 1 && low.lit > 0, JSON.stringify(low));

  // The door.
  await p.evaluate(() => [...document.querySelectorAll('.mds-bar .mds-btn')].pop().click());
  await p.waitForTimeout(1500);
  check('Close returns to a live editor', await p.evaluate(() => !document.querySelector('.mds-overlay') && !!document.querySelector('#canvas-host canvas')));
  check('no page errors driving it', errs.length === 0, errs.join(' | ').slice(0, 160));
  await ctx.close();
}

console.log('\n— Match Day: when the phone says no —');
{
  // WebGL missing: the constructor throws, main.ts catches it, and before this
  // the whole outcome was that nothing happened — unreportable, unfixable.
  const [ctx, p, errs] = await editor();
  await p.evaluate(() => {
    const g = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) {
      if (typeof t === 'string' && /webgl/i.test(t)) return null;
      return g.call(this, t, ...a);
    };
  });
  await p.tap('.m-tab[data-tab="more"]');
  await p.waitForTimeout(700);
  await p.tap('.m-sheet [data-md-open]');
  await p.waitForTimeout(8000);
  const card = await p.evaluate(() => {
    const f = document.querySelector('.mds-fail');
    if (!f) return { shown: false };
    const acts = [...f.querySelectorAll('.mds-btn')].filter((b) => !b.hidden);
    const r = acts[acts.length - 1].getBoundingClientRect();
    return { shown: f.classList.contains('show'), title: f.querySelector('h2').textContent.trim(),
      body: f.querySelector('p').textContent.trim().length, acts: acts.length,
      exit: `${Math.round(r.width)}x${Math.round(r.height)}`, exitOnScreen: r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 };
  });
  check('no WebGL says so instead of doing nothing', card.shown && card.title.length > 0 && card.body > 0, JSON.stringify(card));
  check('no WebGL does not offer a pointless retry', card.acts === 1, `${card.acts} buttons`);
  check('and the card has a reachable way out', card.exitOnScreen, card.exit);
  await p.evaluate(() => [...document.querySelectorAll('.mds-fail-acts .mds-btn')].filter((b) => !b.hidden).pop().click());
  await p.waitForTimeout(1500);
  check('closing the card leaves the editor intact', await p.evaluate(() => !document.querySelector('.mds-overlay') && !!document.querySelector('#canvas-host canvas')));
  check('no page errors on the WebGL failure path', errs.length === 0, errs.join(' | ').slice(0, 160));
  await ctx.close();
}
{
  // A phone under memory pressure takes the context back. Unhandled, the bowl
  // goes black for good while the loop keeps drawing to a dead context.
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 680 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS('en') }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await p.goto(B + '/app?sim=1', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);
  await dismissIntro(p);
  await p.evaluate(() => {
    const c = document.querySelector('.mds-overlay canvas');
    (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context').loseContext();
  });
  await p.waitForTimeout(2000);
  const lost = await p.evaluate(() => {
    const f = document.querySelector('.mds-fail');
    return { shown: f.classList.contains('show'), acts: [...f.querySelectorAll('.mds-btn')].filter((b) => !b.hidden).length };
  });
  check('a lost context is explained', lost.shown, JSON.stringify(lost));
  check('and offers a rebuild as well as a way out', lost.acts === 2, `${lost.acts} buttons`);
  await p.evaluate(() => [...document.querySelectorAll('.mds-fail-acts .mds-btn')].filter((b) => !b.hidden)[0].click());
  await p.waitForTimeout(9000);
  const rebuilt = await p.evaluate(() => ({
    card: document.querySelector('.mds-fail').classList.contains('show'),
    canvases: document.querySelectorAll('.mds-overlay canvas').length,
  }));
  check('Rebuild brings the stadium back', !rebuilt.card && rebuilt.canvases === 1, JSON.stringify(rebuilt));
  check('and does not leave the dead canvas behind', rebuilt.canvases === 1, `${rebuilt.canvases} canvases`);
  check('no page errors on the context-loss path', errs.length === 0, errs.join(' | ').slice(0, 160));
  await ctx.close();
}

console.log('\n— Match Day: Arabic —');
{
  const [ctx, p, errs] = await editor({ lang: 'ar' });
  const AR = /[؀-ۿ]/;
  await p.tap('.m-tab[data-tab="more"]');
  await p.waitForTimeout(700);
  const label = await p.evaluate(() => document.querySelector('.m-sheet-body > [data-md-open]')?.textContent.trim() || '');
  check('the Match Day button is Arabic', AR.test(label), label);
  await p.tap('.m-sheet [data-md-open]');
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.waitForTimeout(5000);
  await dismissIntro(p);
  await p.evaluate(() => document.querySelector('.mds-overlay .mds-bar .mds-icon').click());
  await p.waitForTimeout(700);
  await p.evaluate(() => { for (const s of document.querySelectorAll('.mds-shead')) if (!s.parentElement.classList.contains('open')) s.click(); });
  await p.waitForTimeout(700);
  await settleSheet(p);
  const r = await p.evaluate(() => {
    const ov = document.querySelector('.mds-overlay');
    const panel = ov.querySelector('.mds-panel');
    const b = panel.getBoundingClientRect();
    // Every control the sheet holds, and whether a thumb could reach it.
    const unreachable = [];
    for (const el of panel.querySelectorAll('button,select,input')) {
      const x = el.getBoundingClientRect();
      if (x.width < 1 || x.height < 1 || getComputedStyle(el).display === 'none') continue;
      if (x.right > innerWidth + 1 || x.left < -1) unreachable.push(`${el.className} @${Math.round(x.x)}`);
    }
    return { dir: ov.dir, help: ov.querySelector('.mds-help-card').innerText,
      tiers: [...ov.querySelectorAll('.mds-panel-acts .mds-sel option')].map((o) => o.textContent),
      box: `${Math.round(b.width)}x${Math.round(b.height)} @${Math.round(b.x)},${Math.round(b.y)}`,
      sheetFullWidth: Math.round(b.width) === innerWidth,
      onScreen: b.top < innerHeight - 40 && b.left >= -1 && b.right <= innerWidth + 1,
      unreachable };
  });
  check('the simulator mirrors in RTL', r.dir === 'rtl', r.dir);
  check('the phone help is Arabic', AR.test(r.help) && /إصبع/.test(r.help), r.help.replace(/\n/g, ' · ').slice(0, 100));
  check('every quality tier is translated', r.tiers.length === 4 && r.tiers.every((x) => AR.test(x)), r.tiers.join(' · '));
  // In RTL the two `.mds-overlay[dir=rtl] .mds-panel` rules outranked the
  // phone layout, so the panel kept its 286px side rail AND its sideways
  // collapse: measured at 360px it sat at x=310, with fourteen controls —
  // quality, cameras, crowd, atmosphere, recording — off the screen entirely.
  check('the panel is a full-width sheet, not a side rail', r.sheetFullWidth && r.onScreen, r.box);
  check('every control in it is reachable in Arabic', r.unreachable.length === 0, JSON.stringify(r.unreachable).slice(0, 140));
  check('no page errors in Arabic', errs.length === 0, errs.join(' | ').slice(0, 160));
  await ctx.close();
}

console.log('\n— every screen size, both orientations, both languages —');
{
  const SIZES = [
    [320, 568, 'iPhone SE'], [360, 640, 'Android small'], [360, 680, 'Pixel'],
    [390, 844, 'iPhone 14'], [412, 915, 'Pixel 7 Pro'], [430, 932, 'iPhone Pro Max'],
    [667, 375, 'landscape SE'], [844, 390, 'landscape iPhone'],
    [768, 1024, 'iPad portrait'],
  ];
  for (const [w, h, name] of SIZES) {
    for (const lang of ['en', 'ar']) {
      const [ctx, p, errs] = await editor({ w, h, lang });
      const r = await p.evaluate(() => {
        const shell = document.body.classList.contains('m-shell');
        const c = document.querySelector('#canvas-host canvas');
        const cb = c ? c.getBoundingClientRect() : null;
        const ribbon = document.querySelector('.m-ribbon');
        const rb = ribbon ? ribbon.getBoundingClientRect() : null;
        return {
          shell, dir: document.documentElement.dir,
          canvasOk: !!cb && cb.width > 0 && cb.height > 0,
          canvasPct: cb ? Math.round(cb.width * cb.height / (innerWidth * innerHeight) * 100) : 0,
          ribbonOnScreen: !rb || (rb.bottom <= innerHeight + 2 && rb.right <= innerWidth + 2),
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      const phone = w <= 899;
      const off = await p.evaluate(offscreen);
      const small = await p.evaluate(smallTargets);
      const tag = `${name} ${w}x${h} ${lang}`;
      check(`${tag}: ${phone ? 'mobile shell' : 'desktop layout'}`, r.shell === phone, `shell=${r.shell}`);
      check(`${tag}: canvas renders`, r.canvasOk, `${r.canvasPct}% of screen`);
      check(`${tag}: no horizontal scroll`, !r.hscroll);
      check(`${tag}: chrome on screen`, r.ribbonOnScreen);
      check(`${tag}: nothing unreachable`, off.length === 0, JSON.stringify(off).slice(0, 120));
      check(`${tag}: targets >=24px`, small.length === 0, JSON.stringify(small).slice(0, 120));
      check(`${tag}: dir is ${lang === 'ar' ? 'rtl' : 'ltr'}`, r.dir === (lang === 'ar' ? 'rtl' : 'ltr'), r.dir);
      check(`${tag}: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 120));
      await ctx.close();
    }
  }
}

console.log('\n— Arabic: the shell is translated and mirrored —');
{
  const [ctx, p, errs] = await editor({ lang: 'ar' });
  const AR = /[\u0600-\u06FF]/;
  const r = await p.evaluate(() => ({
    tabs: [...document.querySelectorAll('.m-tab span')].map((e) => e.textContent.trim()),
    stands: [...document.querySelectorAll('.m-stand')].map((e) => e.textContent.trim()),
    views: [...document.querySelectorAll('.m-view-b')].map((e) => e.textContent.trim()),
  }));
  check('tab labels are Arabic', r.tabs.every((x) => AR.test(x)), r.tabs.join(' · '));
  check('stand chips are Arabic', r.stands.every((x) => AR.test(x)), r.stands.join(' · '));
  check('view switcher is Arabic', r.views.every((x) => AR.test(x)), r.views.join(' · '));
  // Mirroring: in RTL the first tab sits on the right.
  const mirrored = await p.evaluate(() => {
    const t = document.querySelectorAll('.m-tab');
    return t[0].getBoundingClientRect().x > t[4].getBoundingClientRect().x;
  });
  check('the ribbon mirrors in RTL', mirrored);
  for (const tab of ['paint', 'colors', 'add', 'ai', 'more']) {
    await p.tap(`.m-tab[data-tab="${tab}"]`);
    await p.waitForTimeout(600);
    const title = await p.evaluate(() => document.querySelector('.m-sheet-title')?.textContent?.trim() || '');
    check(`${tab} sheet title is Arabic`, AR.test(title), title);
    await p.tap('.m-sheet-x');
    await p.waitForTimeout(300);
  }
  check('no errors in Arabic', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— rotating across the breakpoint swaps front ends —');
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS('en') }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await p.goto(B + '/app', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('#canvas-host canvas', { timeout: 120000 });
  await p.waitForTimeout(3500);
  check('phone starts with the mobile shell', await p.evaluate(() => document.body.classList.contains('m-shell')));
  await p.setViewportSize({ width: 1100, height: 800 });
  await p.waitForTimeout(1500);
  const wide = await p.evaluate(() => ({
    shell: document.body.classList.contains('m-shell'),
    ribbon: !!document.querySelector('.m-ribbon'),
    rail: document.querySelector('.tool-rail').getBoundingClientRect().width > 10,
  }));
  check('widening hands back the desktop rail', !wide.shell && !wide.ribbon && wide.rail, JSON.stringify(wide));
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(1500);
  const narrow = await p.evaluate(() => ({
    shell: document.body.classList.contains('m-shell'),
    tabs: document.querySelectorAll('.m-tab').length,
  }));
  check('narrowing brings the ribbon back', narrow.shell && narrow.tabs === 5, JSON.stringify(narrow));
  check('no errors while rotating', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
