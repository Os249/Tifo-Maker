/**
 * The whole painting experience, driven the way a person drives it.
 *
 * Every check here asks "did the thing the user wanted actually happen", and
 * gets its answer from what the editor itself reports: the per-colour seat
 * counts on the palette swatches (store.onDirty re-renders them, so they are
 * live), the status line, and the canvas pixels. No internals are reached into,
 * because the bug that prompted this audit passed every DOM assertion we had
 * while the canvas stayed empty.
 *
 * Timings from a swiftshader container are a ceiling, not a spec. Pixel and
 * count verdicts are real.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readPng } from './lib/readPng.mjs';

const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const OUT = process.env.OUT ?? '/tmp/editor-audit';
const ONLY = process.env.ONLY ?? '';
mkdirSync(OUT, { recursive: true });

let pass = 0;
const fails: { section: string; name: string; detail: string }[] = [];
let section = '';
const sect = (s: string): void => {
  section = s;
  console.log(`\n— ${s} —`);
};
/** Click that reports instead of throwing, so one dead control can't end the run. */
async function tryClick(page: Page, sel: string, what = sel): Promise<boolean> {
  try {
    await page.click(sel, { timeout: 4000 });
    return true;
  } catch (e) {
    const why = await page.evaluate((s2) => {
      const el = document.querySelector(s2) as HTMLElement | null;
      if (!el) return 'missing from the DOM';
      if ((el as HTMLButtonElement).disabled) return 'disabled';
      const r = el.getBoundingClientRect();
      const sec = el.closest('.panel-section') as HTMLElement | null;
      const where = sec ? ` in ${sec.id}${sec.classList.contains('ctx-hidden') ? ' (ctx-hidden)' : ''}` : '';
      if (r.width === 0 || r.height === 0) return `zero-size${where}`;
      if (r.bottom < 0 || r.top > innerHeight) return `scrolled out of view${where}`;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
      if (top && top !== el && !el.contains(top)) {
        return `covered by ${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}.${top.className}`.slice(0, 80) + where;
      }
      return `no obvious reason${where}`;
    }, sel).catch(() => 'unknown');
    check(`${what} is clickable`, false, why + ' — ' + String((e as Error).message).split('\n')[0]);
    return false;
  }
}

const check = (name: string, ok: boolean, detail: unknown = ''): boolean => {
  if (ok) pass++;
  else fails.push({ section, name, detail: String(detail) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
};

// ---------------------------------------------------------------- page setup

async function open(
  browser: Browser,
  opts: { width?: number; height?: number; lang?: 'en' | 'ar'; touch?: boolean } = {},
): Promise<{ page: Page; errs: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1500, height: opts.height ?? 900 },
    hasTouch: opts.touch ?? false,
    isMobile: opts.touch ?? false,
    deviceScaleFactor: opts.touch ? 2 : 1,
  });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_tour_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'all');
      localStorage.setItem('tifo_lang_v1', l);
      localStorage.removeItem('tifo_draft_v1');
    } catch { /* ignore */ }
  }, opts.lang ?? 'en');
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 180)));
  page.on('console', (m) => {
    const t = m.text();
    // No egress and no session in this container: a blocked fetch and a 401
    // from /api/me are the harness's environment, not the editor's behaviour.
    if (m.type() === 'error' && !/ERR_TUNNEL|401 \(Unauthorized\)|Failed to load resource|ERR_NAME_NOT_RESOLVED/.test(t)) {
      errs.push('console: ' + t.slice(0, 180));
    }
  });
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('#canvas-host canvas', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#palette .swatch').length > 0, { timeout: 60000 });
  await page.waitForTimeout(1200);
  return { page, errs, close: () => ctx.close() };
}

/** Painted seats per palette colour, straight off the live swatch labels. */
async function counts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const b of document.querySelectorAll<HTMLElement>('#palette .swatch')) {
      const label = b.getAttribute('aria-label') ?? '';
      const hex = /#[0-9a-f]{6}/i.exec(label)?.[0]?.toLowerCase() ?? b.title.slice(0, 7).toLowerCase();
      const n = Number((/([\d,]+)\s*\D*$/.exec(label)?.[1] ?? '0').replace(/,/g, ''));
      out[hex] = n;
    }
    return out;
  });
}
const total = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);
/**
 * Seats that changed colour between two readings.
 *
 * The bowl starts fully painted — every seat carries a palette index, so the
 * TOTAL is a constant 60,832 and tells you nothing about whether a brush
 * worked. What moves is the distribution, and half the summed absolute change
 * is the number of seats that swapped colour. Seats erased to index 0 leave the
 * swatches entirely, which is why the eraser is checked against the total.
 */
function changed(a: Record<string, number>, b: Record<string, number>): number {
  let sum = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs((b[k] ?? 0) - (a[k] ?? 0));
  return Math.round(sum / 2);
}

/** Canvas centre in page coordinates — measured to sit on the bowl at fit zoom. */
async function bowlPoint(page: Page, dx = 0, dy = 0): Promise<{ x: number; y: number }> {
  // Read the rect fresh every time. The Text / Image / Shape bars change the
  // canvas's size and position, and a person aims at where it is NOW.
  const box = (await page.locator('#canvas-host canvas').boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

const msg = (page: Page): Promise<string> =>
  page.evaluate(() => document.getElementById('message')?.textContent ?? '');
const tool = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector('.tool-rail .tool.active')?.getAttribute('data-tool') ?? '');
const zoom = (page: Page): Promise<string> =>
  page.evaluate(() => document.getElementById('zoom-level')?.textContent?.trim() ?? '');

/** Pick a tool through the rail, the way a user does. */
async function pick(page: Page, t: string): Promise<void> {
  await tryClick(page, `.tool-rail [data-tool="${t}"]`, `the ${t} tool`);
  await page.waitForTimeout(140);
}

/** How many pixels differ between two screenshots of the same region. */
function pixelsChanged(a: Buffer, b: Buffer): number {
  const x = readPng(a);
  const y = readPng(b);
  if (x.width !== y.width || x.height !== y.height) return -1;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 24) n++;
  }
  return n;
}

const CLIP = { x: 60, y: 130, width: 1380, height: 620 };

// ---------------------------------------------------------------- the checks

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());

const want = (name: string): boolean => !ONLY || ONLY.split(',').includes(name);

/** Run one section; a throw inside it is a finding, not the end of the audit. */
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  if (!want(name)) return;
  try {
    await fn();
  } catch (e) {
    check(`the "${name}" section ran to the end`, false, String((e as Error).message).split('\n')[0].slice(0, 160));
  }
}

// ---- 1. the four painting tools -------------------------------------------
await run('paint', async () => {
  sect('brush, eraser, fill, eyedropper');
  const { page, errs, close } = await open(browser);

  const p = await bowlPoint(page);
  await pick(page, 'brush');
  // Paint with a colour the bowl is not already wearing, so the change shows.
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const base = await counts(page);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
  const afterClick = await counts(page);
  const clickSeats = changed(base, afterClick);
  check('a brush click paints seats', clickSeats > 0, `${clickSeats} seats`);

  await page.mouse.move(p.x - 220, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(p.x - 220 + i * 11, p.y + (i % 3));
  await page.mouse.up();
  await page.waitForTimeout(350);
  const strokeSeats = changed(afterClick, await counts(page));
  check('a drag paints a continuous stroke', strokeSeats > clickSeats, `click ${clickSeats} vs stroke ${strokeSeats}`);

  // Brush size has to change the footprint, or the slider is decoration.
  await page.evaluate(() => {
    const s = document.getElementById('brush-size') as HTMLInputElement;
    s.value = '1';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const beforeSmall = await counts(page);
  await page.mouse.click(p.x + 300, p.y - 40);
  await page.waitForTimeout(300);
  const small = changed(beforeSmall, await counts(page));
  await page.evaluate(() => {
    const s = document.getElementById('brush-size') as HTMLInputElement;
    s.value = '40';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const beforeBig = await counts(page);
  await page.mouse.click(p.x + 420, p.y - 40);
  await page.waitForTimeout(300);
  const big = changed(beforeBig, await counts(page));
  check('the brush-size slider changes the footprint', big > small * 3, `size 1 → ${small} seats, size 40 → ${big}`);

  // Eraser
  await page.evaluate(() => {
    const s = document.getElementById('brush-size') as HTMLInputElement;
    s.value = '20';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pick(page, 'eraser');
  const beforeErase = total(await counts(page));
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
  const afterErase = total(await counts(page));
  check('the eraser clears painted seats', afterErase < beforeErase, `${beforeErase} → ${afterErase}`);

  // Fill, both scopes
  await pick(page, 'fill');
  await page.selectOption('#fill-scope', 'section');
  const beforeSec = await counts(page);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(500);
  const sectionFill = changed(beforeSec, await counts(page));
  await page.selectOption('#fill-scope', 'global');
  const beforeGlob = await counts(page);
  await page.mouse.click(p.x - 400, p.y);
  await page.waitForTimeout(700);
  const globalFill = changed(beforeGlob, await counts(page));
  check('section fill paints one section', sectionFill > 0, `${sectionFill} seats`);
  check('global fill reaches much further', globalFill > sectionFill * 3, `section ${sectionFill} vs global ${globalFill}`);

  // Eyedropper: paint a known colour somewhere, select a different one, then
  // pick the first back off the canvas.
  const activeHex = () => page.evaluate(() =>
    document.querySelector('#palette .swatch.active')?.getAttribute('aria-label')?.match(/#[0-9a-f]{6}/i)?.[0] ?? '');
  await pick(page, 'brush');
  await page.evaluate(() => (document.querySelectorAll<HTMLElement>('#palette .swatch')[2]).click());
  const target = await activeHex();
  await page.mouse.click(p.x + 120, p.y + 30);
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.querySelectorAll<HTMLElement>('#palette .swatch')[0]).click());
  const other = await activeHex();
  await pick(page, 'eyedropper');
  await page.mouse.click(p.x + 120, p.y + 30);
  await page.waitForTimeout(300);
  const got = await activeHex();
  check('the eyedropper picks the colour it is over', got === target && target !== other,
    `painted ${target}, switched to ${other}, picked ${got}`);

  check('no page errors', errs.length === 0, errs.join(' | '));
  writeFileSync(`${OUT}/01-tools.png`, await page.screenshot({ clip: CLIP }));
  await close();
});

// ---- 2. undo / redo --------------------------------------------------------
await run('undo', async () => {
  sect('undo and redo');
  const { page, errs, close } = await open(browser);
  const p = await bowlPoint(page);
  await pick(page, 'brush');
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const k0 = JSON.stringify(await counts(page));
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
  const k1 = JSON.stringify(await counts(page));
  check('the stroke landed', k1 !== k0);
  // The button, not the shortcut: this is what a person actually reaches for.
  check('the undo BUTTON is live after a stroke', await page.evaluate(() =>
    !(document.getElementById('undo') as HTMLButtonElement).disabled), 'disabled right after painting');
  await tryClick(page, '#undo', 'undo');
  await page.waitForTimeout(350);
  check('undo takes a stroke back', JSON.stringify(await counts(page)) === k0);
  await tryClick(page, '#redo', 'redo');
  await page.waitForTimeout(350);
  check('redo puts it back', JSON.stringify(await counts(page)) === k1);

  // Ctrl+Z / Ctrl+Shift+Z are what anyone reaches for first.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(350);
  check('ctrl+z undoes', JSON.stringify(await counts(page)) === k0);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(350);
  check('ctrl+shift+z redoes', JSON.stringify(await counts(page)) === k1);

  // A fill is one undo step, not hundreds.
  await pick(page, 'fill');
  await page.selectOption('#fill-scope', 'section');
  await page.mouse.click(p.x - 150, p.y);
  await page.waitForTimeout(500);
  const k2 = JSON.stringify(await counts(page));
  check('the undo button is live after a fill', await page.evaluate(() =>
    !(document.getElementById('undo') as HTMLButtonElement).disabled));
  await tryClick(page, '#undo', 'undo after fill');
  await page.waitForTimeout(400);
  check('a fill undoes in one step', JSON.stringify(await counts(page)) === k1 && k2 !== k1);

  check('undo is disabled when there is nothing to undo', await page.evaluate(() => {
    for (let i = 0; i < 12; i++) (document.getElementById('undo') as HTMLButtonElement).click();
    return (document.getElementById('undo') as HTMLButtonElement).disabled;
  }));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 3. the palette --------------------------------------------------------
await run('palette', async () => {
  sect('the palette');
  const { page, errs, close } = await open(browser);
  const n0 = await page.evaluate(() => document.querySelectorAll('#palette .swatch').length);

  // Add a colour: pick a hex, then commit it.
  const picked = await page.evaluate(() => {
    const inp = document.querySelector('.color-trigger-input') as HTMLInputElement | null;
    if (!inp) return false;
    inp.value = '#ff00aa';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  check('the colour well has a picker behind it', picked);
  await tryClick(page, '#add-swatch');
  await page.waitForTimeout(300);
  const n1 = await page.evaluate(() => document.querySelectorAll('#palette .swatch').length);
  check('“+ Colour” adds a swatch', n1 === n0 + 1, `${n0} → ${n1}`);

  const p = await bowlPoint(page);
  await pick(page, 'brush');
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const beforeNew = await counts(page);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
  check('the new colour paints', changed(beforeNew, await counts(page)) > 0);

  // A preset swap must not silently recolour already-painted seats into
  // something else: the indices are what seats store.
  const paintedBefore = total(await counts(page));
  await page.selectOption('#preset', { index: 1 });
  await page.waitForTimeout(600);
  // Choosing a preset asks how to apply it — that modal is the feature, so
  // answer it rather than leaving its backdrop over the whole editor.
  const asked = await page.evaluate(() => {
    const dlg = document.querySelector('.dlg-backdrop');
    return dlg ? [...dlg.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) : [];
  });
  check('a preset asks how to apply it', asked.length >= 3, asked.join(' | '));
  await page.evaluate(() => {
    const dlg = document.querySelector('.dlg-backdrop');
    (dlg?.querySelectorAll('button')[0] as HTMLButtonElement | undefined)?.click();
  });
  await page.waitForTimeout(600);
  check('the dialog closes when answered', await page.evaluate(() => !document.querySelector('.dlg-backdrop')));
  const paintedAfter = total(await counts(page));
  check('switching preset keeps the painted seats painted', paintedAfter > 0, `${paintedBefore} → ${paintedAfter}`);

  // Patterns
  const beforePattern = await counts(page);
  await page.selectOption('#pattern', { index: 1 });
  await page.waitForTimeout(700);
  check('a pattern preset paints the bowl', changed(beforePattern, await counts(page)) > 500,
    `${changed(beforePattern, await counts(page))} seats`);
  check('the pattern says what it did', /\S/.test(await msg(page)), await msg(page));

  await pick(page, 'brush'); // #fill-base lives in ctx-stadium: brush / fill only
  const beforeBase = await counts(page);
  await tryClick(page, '#fill-base');
  await page.waitForTimeout(700);
  check('“fill base” covers the bowl', changed(beforeBase, await counts(page)) > 500,
    `${changed(beforeBase, await counts(page))} seats`);

  check('no page errors', errs.length === 0, errs.join(' | '));
  writeFileSync(`${OUT}/03-palette.png`, await page.screenshot({ clip: CLIP }));
  await close();
});

// ---- 4. selection ----------------------------------------------------------
await run('select', async () => {
  sect('the select tool');
  const { page, errs, close } = await open(browser);
  const p = await bowlPoint(page);
  await pick(page, 'fill');
  await page.selectOption('#fill-scope', 'global');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(700);

  await pick(page, 'select');
  await page.mouse.move(p.x - 200, p.y - 60);
  await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const region = await page.evaluate(() => ({
    shown: !(document.getElementById('region-actions') as HTMLElement).hidden,
    n: Number((document.getElementById('region-count')?.textContent ?? '0').replace(/,/g, '')),
  }));
  check('a marquee selects seats', region.shown && region.n > 0, JSON.stringify(region));

  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const beforeRecolor = await counts(page);
  await tryClick(page, '#region-recolor');
  await page.waitForTimeout(500);
  const afterRecolor = await counts(page);
  const moved = Object.keys(afterRecolor).some((k) => afterRecolor[k] !== (beforeRecolor[k] ?? 0));
  check('recolour repaints the selection', moved, JSON.stringify({ before: beforeRecolor, after: afterRecolor }));

  // Clear first: deleting a selection also clears it, so the Clear button is
  // legitimately gone afterwards and testing it then proves nothing.
  await tryClick(page, '#region-clear');
  await page.waitForTimeout(300);
  check('clear drops the selection', await page.evaluate(() =>
    (document.getElementById('region-actions') as HTMLElement).hidden));

  await page.mouse.move(p.x - 200, p.y - 60);
  await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const beforeDelete = total(await counts(page));
  await tryClick(page, '#region-delete');
  await page.waitForTimeout(500);
  const afterDelete = total(await counts(page));
  check('delete empties the selected seats', afterDelete < beforeDelete, `${beforeDelete} → ${afterDelete}`);

  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 5. text and shapes ----------------------------------------------------
await run('objects', async () => {
  sect('text and shapes');
  const { page, errs, close } = await open(browser);

  await pick(page, 'brush');
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click(); // a colour the bowl is not already wearing
  });
  await pick(page, 'text');
  await page.fill('#text-input', 'ZEEM');
  await page.waitForTimeout(400);
  const tp2 = await bowlPoint(page); // the bar just moved the canvas
  const beforeShot = await page.screenshot({ clip: CLIP });
  await page.mouse.click(tp2.x, tp2.y);
  await page.waitForTimeout(700);
  const afterShot = await page.screenshot({ clip: CLIP });
  const objShown = await page.evaluate(() => ({
    controls: !(document.getElementById('obj-controls') as HTMLElement).hidden,
    kind: document.getElementById('obj-kind')?.textContent ?? '',
  }));
  check('placing text creates an object', objShown.controls && objShown.kind.includes('ZEEM'), JSON.stringify(objShown));
  // How many pixels the placement actually changed. A fixed brightness
  // threshold does not work here: a 65%-alpha white glyph over a mixed bowl
  // lands just under any line you pick, which is how "the text is invisible"
  // and "my metric is wrong" look identical.
  const moved = pixelsChanged(beforeShot, afterShot);
  check('THE TEXT IS ON SCREEN before baking', moved > 2000, `${moved} pixels changed`);

  const beforeBake = await counts(page);
  await tryClick(page, '#obj-bake');
  await page.waitForTimeout(700);
  check('baking the text paints seats', changed(beforeBake, await counts(page)) > 0,
    `${changed(beforeBake, await counts(page))} seats`);
  check('the object is gone after baking', await page.evaluate(() =>
    (document.getElementById('obj-controls') as HTMLElement).hidden));

  await pick(page, 'shape');
  await page.selectOption('#shape-kind', 'star');
  await page.waitForTimeout(300);
  const sp = await bowlPoint(page, -260, 0);
  const beforeStar = await page.screenshot({ clip: CLIP });
  await page.mouse.click(sp.x, sp.y);
  await page.waitForTimeout(700);
  const afterStar = await page.screenshot({ clip: CLIP });
  check('placing a shape creates an object', await page.evaluate(() =>
    !(document.getElementById('obj-controls') as HTMLElement).hidden));
  const starMoved = pixelsChanged(beforeStar, afterStar);
  check('THE SHAPE IS ON SCREEN before baking', starMoved > 2000, `${starMoved} pixels changed`);

  // Move and resize through the panel, the non-drag path.
  await page.evaluate(() => {
    const h = document.getElementById('obj-height') as HTMLInputElement;
    h.value = '50';
    h.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const resized = await page.evaluate(() => (document.getElementById('obj-height-out')?.textContent ?? ''));
  check('the height slider resizes the object', resized === '50', resized);

  await pick(page, 'select'); // ctx-objects is the select tool's panel
  const objsBefore = await page.evaluate(() => document.getElementById('obj-kind')?.textContent ?? '');
  const beforeAll = await counts(page);
  await tryClick(page, '#obj-bake-all');
  await page.waitForTimeout(700);
  check('bake all commits everything', changed(beforeAll, await counts(page)) > 0,
    `was "${objsBefore}" → ${await msg(page)}`);
  // The tool bars sit ABOVE the canvas and shorten it. If the drawing surface
  // does not follow, its bottom hangs past the window and every click lands
  // higher than you aimed — which is how placed text ended up off the bowl.
  for (const t of ['brush', 'text', 'shape', 'import', 'select'] as const) {
    await pick(page, t);
    await page.waitForTimeout(350);
    const fit = await page.evaluate(() => {
      const host = document.getElementById('canvas-host')!;
      const cv = host.querySelector('canvas') as HTMLCanvasElement;
      const hb = host.getBoundingClientRect();
      const cb = cv.getBoundingClientRect();
      return { over: Math.round(cb.bottom - hb.bottom), below: Math.round(cb.bottom - innerHeight) };
    });
    check(`the canvas fits its box with the ${t} bar open`, fit.over <= 2 && fit.below <= 2, JSON.stringify(fit));
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  writeFileSync(`${OUT}/05-objects.png`, await page.screenshot({ clip: CLIP }));
  await close();
});

// ---- 6. mirror -------------------------------------------------------------
await run('mirror', async () => {
  sect('mirror painting');
  const { page, errs, close } = await open(browser);
  const p = await bowlPoint(page);
  await pick(page, 'brush');
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const m0 = await counts(page);
  await page.mouse.click(p.x - 300, p.y);
  await page.waitForTimeout(400);
  const plain = changed(m0, await counts(page));
  await page.check('#mirror');
  await page.waitForTimeout(200);
  const m1 = await counts(page);
  await page.mouse.click(p.x - 180, p.y); // a fresh spot, so nothing is already that colour
  await page.waitForTimeout(400);
  const mirrored = changed(m1, await counts(page));
  check('mirror paints both halves', mirrored > plain * 1.5, `plain ${plain} vs mirrored ${mirrored}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 7. navigation ---------------------------------------------------------
await run('nav', async () => {
  sect('zoom, pan, fit, sections, minimap');
  const { page, errs, close } = await open(browser);
  const z0 = await zoom(page);
  await tryClick(page, '#zoom-in');
  await page.waitForTimeout(300);
  const z1 = await zoom(page);
  check('zoom in changes the zoom', z1 !== z0, `${z0} → ${z1}`);
  await tryClick(page, '#zoom-out');
  await tryClick(page, '#zoom-out');
  await page.waitForTimeout(300);
  const z2 = await zoom(page);
  check('zoom out changes it back', z2 !== z1, `${z1} → ${z2}`);
  await tryClick(page, '#fit');
  await page.waitForTimeout(400);
  check('fit returns to the whole bowl', (await zoom(page)) !== z2, await zoom(page));

  // The minimap viewport must track the view, or it is a picture of nothing.
  const box = (await page.locator('#canvas-host canvas').boundingBox())!;
  const vp0 = await page.evaluate(() => {
    const e = document.getElementById('minimap-viewport')!;
    return e.style.cssText;
  });
  await page.mouse.move(box.x + 700, box.y + 400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  const vp1 = await page.evaluate(() => document.getElementById('minimap-viewport')!.style.cssText);
  check('the minimap follows the view', vp0 !== vp1, `${vp0.slice(0, 50)} → ${vp1.slice(0, 50)}`);

  await tryClick(page, '#fit');
  await page.waitForTimeout(300);
  const secs = await page.evaluate(() => document.querySelectorAll('#section-nav .section-cell').length);
  check('the section strip is built', secs > 8, `${secs} sections`);
  if (secs > 0) {
    const zBefore = await zoom(page);
    await page.evaluate(() => (document.querySelectorAll<HTMLElement>('#section-nav .section-cell')[3]).click());
    await page.waitForTimeout(600);
    check('clicking a section zooms to it', (await zoom(page)) !== zBefore, `${zBefore} → ${await zoom(page)}`);
  }

  await pick(page, 'pan');
  const zPan = await zoom(page);
  await page.mouse.move(box.x + 700, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 340, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('the pan tool pans without zooming', (await zoom(page)) === zPan, await zoom(page));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 8. keyboard -----------------------------------------------------------
await run('keys', async () => {
  sect('keyboard shortcuts');
  const { page, errs, close } = await open(browser);
  await tryClick(page, '#canvas-host');
  for (const [key, expect] of [['b', 'brush'], ['e', 'eraser'], ['f', 'fill'], ['i', 'eyedropper'],
    ['t', 'text'], ['s', 'shape'], ['v', 'select']] as [string, string][]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(200);
    check(`"${key}" selects ${expect}`, (await tool(page)) === expect, await tool(page));
  }
  await page.keyboard.press('z');
  await page.waitForTimeout(400);
  const zen = await page.evaluate(() => document.body.classList.contains('zen'));
  await page.keyboard.press('z');
  await page.waitForTimeout(400);
  const unzen = await page.evaluate(() => document.body.classList.contains('zen'));
  check('"z" toggles zen both ways', zen && !unzen, `${zen} → ${unzen}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 9. the reveal ---------------------------------------------------------
await run('reveal', async () => {
  sect('the reveal animation');
  const { page, errs, close } = await open(browser);
  const p = await bowlPoint(page);
  await pick(page, 'fill');
  await page.selectOption('#fill-scope', 'global');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(700);

  await pick(page, 'select'); // ctx-reveal shows for pan / select
  await page.evaluate(() => {
    const s = document.getElementById('reveal-scrub') as HTMLInputElement;
    s.value = '50';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const half = await page.screenshot({ clip: CLIP });
  await page.evaluate(() => {
    const s = document.getElementById('reveal-scrub') as HTMLInputElement;
    s.value = '100';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const full = await page.screenshot({ clip: CLIP });
  check('scrubbing the reveal changes the bowl', Buffer.compare(half, full) !== 0);

  await tryClick(page, '#reveal-reset');
  await page.waitForTimeout(400);
  await tryClick(page, '#reveal-play');
  await page.waitForTimeout(1500);
  const playing = await page.screenshot({ clip: CLIP });
  await page.waitForTimeout(3500);
  const done = await page.screenshot({ clip: CLIP });
  check('play animates', Buffer.compare(playing, done) !== 0);
  // A reveal must not leave the design dimmed once it is over.
  const after = total(await counts(page));
  check('the design survives the reveal', after > 0, `${after} seats`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  writeFileSync(`${OUT}/09-reveal.png`, done);
  await close();
});

// ---- 10. a phone -----------------------------------------------------------
await run('phone', async () => {
  sect('a phone (390x844)');
  const { page, errs, close } = await open(browser, { width: 390, height: 844, touch: true });
  check('the phone shell mounted', await page.evaluate(() => document.body.classList.contains('m-shell')));

  const box = (await page.locator('#canvas-host canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const f0 = await counts(page);
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(500);
  const f1 = await counts(page);
  check('a finger paints', changed(f0, f1) > 0, `${changed(f0, f1)} seats`);

  // Two-finger tap = undo, the Procreate convention the editor claims to honour.
  // Driven through CDP, not synthetic PointerEvents: a dispatched event never
  // gets pointer capture, and the editor's ghost-finger sweep drops any id the
  // browser is not holding — so a hand-made second finger is deleted on arrival.
  const cdp = await page.context().newCDPSession(page);
  const tp = (points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: points.length ? 'touchStart' : 'touchEnd',
      touchPoints: points.map((q, i) => ({ x: q.x, y: q.y, id: i + 1 })),
    });
  await tp([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
  await page.waitForTimeout(90);
  await tp([]);
  await page.waitForTimeout(700);
  const undone = await page.evaluate(() =>
    [...document.querySelectorAll('div')].some((d) => /Undone|تراجعنا|تراجع/.test(d.textContent ?? '') && (d.textContent ?? '').length < 40));
  check('a two-finger tap undoes', undone && changed(f0, await counts(page)) === 0,
    `toast=${undone}, ${changed(f0, await counts(page))} seats still different`);

  // The colours sheet has to be usable, not just present.
  await page.tap('.m-tab[data-tab="colors"]');
  await page.waitForTimeout(600);
  const colors = await page.evaluate(() => {
    const sheet = document.querySelector('.m-sheet.open');
    const sw = [...(sheet?.querySelectorAll<HTMLElement>('#palette .swatch') ?? [])];
    return {
      open: !!sheet,
      swatches: sw.length,
      tooSmall: sw.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length,
    };
  });
  check('the colours sheet shows the palette', colors.open && colors.swatches > 0, JSON.stringify(colors));
  check('swatches are tappable', colors.tooSmall === 0, `${colors.tooSmall} under 24px`);
  await page.tap('.m-sheet-x');
  await page.waitForTimeout(400);

  writeFileSync(`${OUT}/10-phone.png`, await page.screenshot());
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

// ---- 11. Arabic ------------------------------------------------------------
await run('arabic', async () => {
  sect('Arabic (RTL)');
  const { page, errs, close } = await open(browser, { lang: 'ar' });
  check('the editor is RTL', await page.evaluate(() => document.documentElement.getAttribute('dir') === 'rtl'));
  const p = await bowlPoint(page);
  await pick(page, 'brush');
  await page.evaluate(() => {
    const sw = document.querySelectorAll<HTMLElement>('#palette .swatch');
    sw[sw.length - 1].click();
  });
  const a0 = await counts(page);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('painting works in Arabic', changed(a0, await counts(page)) > 0);

  // Every sentence the status line can produce during a painting session.
  const seen: string[] = [];
  await tryClick(page, '#legibility');
  await page.waitForTimeout(500);
  seen.push(await msg(page));
  await pick(page, 'fill');
  await page.selectOption('#fill-scope', 'global');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(700);
  await page.selectOption('#pattern', { index: 1 });
  await page.waitForTimeout(600);
  seen.push(await msg(page));
  await tryClick(page, '#legibility');
  await page.waitForTimeout(600);
  seen.push(await msg(page));
  const latin = seen.filter((s) => /[A-Za-z]{4,}/.test(s));
  check('the status line never answers in English', latin.length === 0, latin.join(' | ') || seen.join(' | '));

  // Choosing a palette preset opens a modal. It was hard-coded English, which
  // is the whole dialog, in the middle of the most ordinary action there is.
  await page.selectOption('#preset', { index: 1 });
  await page.waitForTimeout(700);
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('.dlg-backdrop');
    return d ? (d.textContent ?? '').trim() : '';
  });
  check('the palette dialog is Arabic too', dlg !== '' && !/[A-Za-z]{4,}/.test(dlg), dlg.slice(0, 120));
  await page.evaluate(() => (document.querySelector('.dlg-backdrop button') as HTMLButtonElement | null)?.click());
  await page.waitForTimeout(300);

  writeFileSync(`${OUT}/11-arabic.png`, await page.screenshot({ clip: CLIP }));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await close();
});

await browser.close();

console.log(`\n${'='.repeat(64)}`);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFLAGGED:');
  for (const f of fails) console.log(`  [${f.section}] ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
}
process.exit(fails.length ? 1 : 0);
