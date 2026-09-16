/**
 * Add-an-image probe.
 *
 * Does what a user does — pick a file, place it, look at the canvas — and then
 * asserts the placed picture is VISIBLE, by decoding a screenshot and counting
 * the test image's own two colours. "It's in the object layer" is not the claim
 * the user is making; "I can see it" is.
 *
 * Swiftshader draws the same pixels a GPU does, only slower, so the visibility
 * verdict is trustworthy headless. The timings are NOT — treat them as a
 * ceiling, and read them only as a comparison between two runs of this script.
 */
import { chromium, type Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { readPng } from './lib/readPng.mjs';

const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const OUT = process.env.OUT ?? '/tmp/image-ux';
mkdirSync(OUT, { recursive: true });

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, x: unknown = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

/** Count the test picture's magenta field and cyan bar in a screenshot. */
function countInk(buf: Buffer): { magenta: number; cyan: number } {
  const png = readPng(buf);
  let magenta = 0;
  let cyan = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 100 && g < 90 && b > 55 && b < 200) magenta++;
    else if (r < 95 && g > 100 && b > 100) cyan++;
  }
  return { magenta, cyan };
}

/** Put a PNG of the given size on the real <input type=file>, as a picker would. */
async function pickFile(page: Page, w: number, h: number): Promise<void> {
  await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ff00aa';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#00ffee';
      g.fillRect(w * 0.2, h * 0.35, w * 0.6, h * 0.3);
      const png: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([png], 'test-photo.png', { type: 'image/png' }));
      const input = document.getElementById('import-file') as HTMLInputElement;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [w, h],
  );
}

async function run(label: string, imgW: number, imgH: number, lang: 'en' | 'ar' = 'en'): Promise<void> {
  console.log(`\n— ${label} (${imgW}x${imgH}${lang === 'ar' ? ', Arabic' : ''}) —`);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_tour_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'all');
      localStorage.setItem('tifo_lang_v1', l);
    } catch { /* ignore */ }
  }, lang);
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => {
    // The container has no egress and no session, so a blocked fetch and a 401
    // from /api/me are the harness's environment, not the editor's behaviour.
    const txt = m.text();
    if (m.type() === 'error' && !/ERR_TUNNEL|401 \(Unauthorized\)|Failed to load resource/.test(txt)) {
      errs.push('console: ' + txt.slice(0, 200));
    }
  });
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('#canvas-host canvas', { timeout: 60000 });
  await page.waitForTimeout(2500);

  const t0 = Date.now();
  await pickFile(page, imgW, imgH);
  await page.waitForFunction(() => !(document.getElementById('import-bar') as HTMLElement).hidden, { timeout: 30000 }).catch(() => {});
  const armMs = Date.now() - t0;

  const armed = await page.evaluate(() => ({
    tool: document.querySelector('.tool.active')?.getAttribute('data-tool') ?? '',
    bar: !(document.getElementById('import-bar') as HTMLElement).hidden,
    name: document.getElementById('import-name')?.textContent ?? '',
    size: document.getElementById('import-size-out')?.textContent ?? '',
  }));
  check('picking a file arms the import tool', armed.tool === 'import' && armed.bar, `${armed.name} ${armed.size}`);

  // The .tb-field wrappers exist for the phone sheet and must be invisible to
  // the desktop layout. `display:contents` is what guarantees that: the wrapper
  // generates no box, so the bar's flex children are the same boxes, in the
  // same order, as before the wrappers were added. If that rule is ever lost
  // the bar reflows into stacked blocks, so assert the rule AND the order.
  const row = await page.evaluate(() => {
    const bar = document.getElementById('import-bar')!;
    const fields = [...bar.querySelectorAll('.tb-field')];
    const boxed = fields.filter((f) => getComputedStyle(f).display !== 'contents').length;
    const ctrls = [...bar.querySelectorAll('label, select, button, input[type=range], span[id]')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0);
    // Reading order: each control starts at or after the previous one, allowing
    // for wraps onto a new line. (RTL runs the other way, hence the dir check.)
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    let outOfOrder = 0;
    for (let i = 1; i < ctrls.length; i++) {
      const p = ctrls[i - 1];
      const c = ctrls[i];
      const sameLine = Math.abs(c.top - p.top) < 8;
      if (sameLine && (rtl ? c.right > p.right + 1 : c.left < p.left - 1)) outOfOrder++;
    }
    return { fields: fields.length, boxed, outOfOrder, h: Math.round(bar.getBoundingClientRect().height) };
  });
  check('the wrappers are invisible to the desktop layout', row.fields === 6 && row.boxed === 0, JSON.stringify(row));
  check('the controls still read in document order', row.outOfOrder === 0, JSON.stringify(row));

  const clip = { x: 0, y: 130, width: 1500, height: 600 };
  await page.selectOption('#import-place', '0.5'); // West stand — deterministic
  await page.waitForTimeout(200);
  const before = countInk(await page.screenshot({ clip }));

  const t1 = Date.now();
  await page.click('#import-apply');
  await page.waitForTimeout(900);
  const placeMs = Date.now() - t1;

  const shot = await page.screenshot({ clip });
  writeFileSync(`${OUT}/${label.replace(/\W+/g, '-')}.png`, shot);
  const after = countInk(shot);

  const panel = await page.evaluate(() => ({
    kind: document.getElementById('obj-kind')?.textContent ?? '',
    controls: !(document.getElementById('obj-controls') as HTMLElement).hidden,
    msg: document.getElementById('message')?.textContent ?? '',
    tool: document.querySelector('.tool.active')?.getAttribute('data-tool') ?? '',
  }));
  check('the properties panel shows it', panel.controls && panel.kind.includes('test-photo'), panel.kind);
  if (lang === 'ar') {
    // The whole point: an Arabic editor that answers in English is the bug the
    // screenshots showed. Latin here means a sentence was left hard-coded.
    const strayLatin = (txt: string): string[] =>
      txt.split(/\s+/).filter((w) => /[A-Za-z]{4,}/.test(w) && !/test-photo\.png/.test(w));
    check('the status line is Arabic', strayLatin(panel.msg).length === 0, `${panel.msg} :: ${strayLatin(panel.msg).join(' ')}`);
    check('so is the size readout', strayLatin(armed.size).length === 0, armed.size);
    check('the editor is in RTL', await page.evaluate(() => document.documentElement.getAttribute('dir') === 'rtl'));
  }
  check(
    'THE PICTURE IS ON SCREEN',
    after.magenta - before.magenta > 2000 && after.cyan - before.cyan > 400,
    `magenta ${before.magenta}→${after.magenta}  cyan ${before.cyan}→${after.cyan}`,
  );
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`  · arm ${armMs}ms · place ${placeMs}ms · "${panel.msg.slice(0, 70)}"`);

  // Now drag it and make sure it survives, since that is the next thing anyone does.
  const box = (await page.locator('#canvas-host canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  const t2 = Date.now();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * 0.5 + i * 6, box.y + box.height * 0.5 + i * 2);
  }
  const dragMs = Date.now() - t2;
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = countInk(await page.screenshot({ clip }));
  check('it survives a drag', dragged.magenta - before.magenta > 2000, `magenta ${dragged.magenta}`);
  console.log(`  · 12 drag moves in ${dragMs}ms (${(dragMs / 12).toFixed(1)}ms each)`);

  await ctx.close();
}

/** Where does the time actually go? Times the synchronous handlers in-page. */
async function timings(): Promise<void> {
  console.log('\n— where the main thread goes (swiftshader: a ceiling, not a spec) —');
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_tour_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'all');
    } catch { /* ignore */ }
  });
  const page = await ctx.newPage();
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('#canvas-host canvas', { timeout: 60000 });
  await page.waitForTimeout(2500);
  const decode = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const [label, w, h] of [['900x600', 900, 600], ['4032x3024', 4032, 3024]] as [string, number, number][]) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ff00aa'; g.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const t = performance.now();
      const bmp = await createImageBitmap(blob);
      out['decode ' + label] = Math.round(performance.now() - t);
      out['bytes ' + label] = Math.round((bmp.width * bmp.height * 4) / 1024 / 1024);
      bmp.close();
    }
    return out;
  });
  console.log('  ' + JSON.stringify(decode));
  await pickFile(page, 4032, 3024);
  await page.waitForTimeout(1200);
  await page.selectOption('#import-place', '0.5');
  const block = await page.evaluate(() => {
    const t = performance.now();
    (document.getElementById('import-apply') as HTMLButtonElement).click();
    return Math.round(performance.now() - t);
  });
  console.log(`  placement blocks the main thread for ${block}ms`);

  // The per-move JS cost of a drag. Driving the height slider walks the SAME
  // path a pointermove does — mutateSelected -> notify -> overlay.sync() plus
  // every DOM listener — without a frame in between, so this is the JS bill a
  // phone pays 60-120 times a second while a finger is down. (The screenshot
  // timings above are swiftshader's rasteriser, not this.)
  const perMove = await page.evaluate(() => {
    const slider = document.getElementById('obj-height') as HTMLInputElement;
    if (!slider || (document.getElementById('obj-controls') as HTMLElement).hidden) return -1;
    for (let i = 0; i < 20; i++) { slider.value = String(20 + (i % 8)); slider.dispatchEvent(new Event('input', { bubbles: true })); } // warm
    const t = performance.now();
    for (let i = 0; i < 200; i++) { slider.value = String(20 + (i % 8)); slider.dispatchEvent(new Event('input', { bubbles: true })); }
    return (performance.now() - t) / 200;
  });
  console.log(`  each drag move costs ${perMove.toFixed(2)}ms of JS`);
  await ctx.close();
}

/** A phone. The desktop import bar is display:none under .m-shell. */
async function phone(): Promise<void> {
  console.log('\n— phone (390x844) —');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_tour_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'all');
    } catch { /* ignore */ }
  });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('#canvas-host canvas', { timeout: 60000 });
  await page.waitForTimeout(2500);
  check('the phone shell mounted', await page.evaluate(() => document.body.classList.contains('m-shell')));

  // The same sheet plumbing carries Text and Shapes, and it was broken the same
  // way: open('add') toggles, so picking a tool from the open Add sheet simply
  // closed it and the options were never shown.
  await page.tap('.m-tab[data-tab="add"]');
  await page.waitForTimeout(400);
  for (const [tool, barId] of [['text', 'text-bar'], ['shape', 'shape-bar']] as [string, string][]) {
    await page.tap(`.m-tool[data-tool="${tool}"]`);
    await page.waitForTimeout(500);
    const shown = await page.evaluate((id) => {
      const bar = document.getElementById(id)!;
      const r = bar.getBoundingClientRect();
      return { inSheet: !!bar.closest('.m-sheet'), open: !!document.querySelector('.m-sheet.open'), onScreen: r.height > 0 && r.top < innerHeight };
    }, barId);
    check(`the ${tool} options open in a sheet`, shown.inSheet && shown.open && shown.onScreen, JSON.stringify(shown));
    // Tapping the tab you came in through goes BACK to its grid, not away.
    await page.tap('.m-tab[data-tab="add"]');
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => ({
      open: !!document.querySelector('.m-sheet.open'),
      tools: document.querySelectorAll('.m-sheet .m-tool').length,
    }));
    check(`...and the Add tab goes back to the grid from ${tool}`, back.open && back.tools === 3, JSON.stringify(back));
  }
  await page.tap('.m-sheet-x');
  await page.waitForTimeout(400);
  await pickFile(page, 2400, 1600);
  await page.waitForTimeout(1500);
  const seen = await page.evaluate(() => {
    const bar = document.getElementById('import-bar')!;
    const r = bar.getBoundingClientRect();
    const apply = document.getElementById('import-apply')!.getBoundingClientRect();
    return {
      hidden: (bar as HTMLElement).hidden,
      display: getComputedStyle(bar).display,
      onScreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight,
      applyReachable: apply.width > 0 && apply.right <= innerWidth + 1 && apply.bottom <= innerHeight + 1,
      inSheet: !!bar.closest('.m-sheet'),
      sheetOpen: !!document.querySelector('.m-sheet.open'),
    };
  });
  check('after picking a photo the phone can SEE the import options', seen.onScreen, JSON.stringify(seen));
  check('...and can reach Place', seen.applyReachable, `display=${seen.display}`);
  writeFileSync(`${OUT}/phone-1-options.png`, await page.screenshot());

  await page.tap('#import-apply');
  await page.waitForTimeout(900);
  writeFileSync(`${OUT}/phone-2-placed.png`, await page.screenshot());
  const after = await page.evaluate(() => ({
    sheetOpen: !!document.querySelector('.m-sheet.open'),
    kind: document.getElementById('obj-kind')?.textContent ?? '',
    msg: document.getElementById('message')?.textContent ?? '',
  }));
  check('placing closes the sheet so the bowl is visible', !after.sheetOpen, JSON.stringify(after));
  check('the object exists afterwards', after.kind.includes('test-photo'), after.kind);

  // "I placed it, now what?" must be answerable without opening anything.
  writeFileSync(`${OUT}/phone-3-objbar.png`, await page.screenshot());
  const bar = await page.evaluate(() => {
    const b = document.querySelector('.m-objbar') as HTMLElement | null;
    if (!b || b.hidden) return { shown: false, buttons: [] as { t: string; w: number; h: number }[] };
    const r = b.getBoundingClientRect();
    return {
      shown: r.width > 0 && r.top < innerHeight && r.bottom > 0,
      buttons: [...b.querySelectorAll('button')].map((x) => {
        const q = x.getBoundingClientRect();
        return { t: (x.textContent || x.getAttribute('aria-label') || '').trim(), w: Math.round(q.width), h: Math.round(q.height) };
      }),
    };
  });
  check('a selected object offers its actions on screen', bar.shown, JSON.stringify(bar.buttons));
  const clash = await page.evaluate(() => {
    const a = document.querySelector('.m-objbar')!.getBoundingClientRect();
    const hit: string[] = [];
    for (const sel of ['.m-stands', '.m-ribbon', '.m-view']) {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      if (b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hit.push(sel);
    }
    return hit;
  });
  check('...without sitting on top of another control', clash.length === 0, clash.join(','));
  check('every action is a 44px target', bar.buttons.length === 3 && bar.buttons.every((x) => x.h >= 44 && x.w >= 44), JSON.stringify(bar.buttons));

  await page.tap('.m-objbar-b.primary');
  await page.waitForTimeout(800);
  writeFileSync(`${OUT}/phone-4-baked.png`, await page.screenshot());
  const baked = await page.evaluate(() => ({
    msg: document.getElementById('message')?.textContent ?? '',
    barGone: (document.querySelector('.m-objbar') as HTMLElement).hidden,
  }));
  check('one tap bakes it', /\d/.test(baked.msg) && baked.barGone, JSON.stringify(baked));

  // Backing out of the sheet must back out of import mode too, or the editor is
  // left in a mode whose only controls are off-screen — the same dead end by a
  // different route.
  await pickFile(page, 800, 600);
  await page.waitForTimeout(1200);
  await page.tap('.m-sheet-x');
  await page.waitForTimeout(600);
  const backedOut = await page.evaluate(() => ({
    sheetOpen: !!document.querySelector('.m-sheet.open'),
    tool: document.querySelector('.tool-rail .tool.active')?.getAttribute('data-tool') ?? '',
    bar: !(document.getElementById('import-bar') as HTMLElement).hidden,
  }));
  check('closing the import sheet leaves import mode', !backedOut.sheetOpen && backedOut.tool !== 'import' && !backedOut.bar, JSON.stringify(backedOut));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/**
 * The decoder itself, compiled from the real source and run in a real browser.
 *
 * A placed picture looking right does not prove the bitmap was capped — an
 * uncapped one looks identical right up until it meets a GPU whose
 * MAX_TEXTURE_SIZE it exceeds, and then it is silently missing. So measure the
 * bitmap.
 */
async function decoder(): Promise<void> {
  console.log('\n— decodeImportBitmap —');
  const bundle = await build({
    entryPoints: ['src/core/importImage.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__ii',
    target: 'es2022',
  });
  const code = bundle.outputFiles[0].text;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(B + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // page.evaluate, not addScriptTag: the app ships a real CSP ('script-src
  // self'), so an inline <script> is refused — as it should be.
  // ...and the hand-off must be explicit: esbuild's IIFE declares `var __ii`,
  // which inside evaluate's function wrapper is a local, not a global.
  await page.evaluate(code + '\nglobalThis.__ii = __ii;');
  const r = await page.evaluate(async () => {
    const ii = (window as unknown as { __ii: { decodeImportBitmap: (b: Blob, m?: number) => Promise<ImageBitmap>; IMPORT_MAX_EDGE: number } }).__ii;
    const out: { label: string; w: number; h: number }[] = [];
    for (const [w, h] of [[900, 600], [4032, 3024], [3024, 4032], [8160, 6120], [2048, 2048], [2049, 1]] as [number, number][]) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ff00aa';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#00ffee';
      g.fillRect(0, 0, Math.max(1, w / 2), Math.max(1, h / 2));
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const bmp = await ii.decodeImportBitmap(blob);
      out.push({ label: `${w}x${h}`, w: bmp.width, h: bmp.height });
      bmp.close();
    }
    return { out, cap: ii.IMPORT_MAX_EDGE };
  });
  console.log('  ' + r.out.map((x) => `${x.label} → ${x.w}x${x.h}`).join('  ·  '));

  // The cap adds a second resample, so it has to pay for itself. Compare the
  // two decodes head to head on the size that matters.
  const cost = await page.evaluate(async () => {
    const ii = (window as unknown as { __ii: { decodeImportBitmap: (b: Blob) => Promise<ImageBitmap> } }).__ii;
    const c = document.createElement('canvas');
    c.width = 4032;
    c.height = 3024;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff00aa';
    g.fillRect(0, 0, 4032, 3024);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
    let plain = 0;
    let capped = 0;
    for (let i = 0; i < 3; i++) {
      let t = performance.now();
      const a = await createImageBitmap(blob);
      plain += performance.now() - t;
      const aMb = (a.width * a.height * 4) / 1048576;
      a.close();
      t = performance.now();
      const b = await ii.decodeImportBitmap(blob);
      capped += performance.now() - t;
      const bMb = (b.width * b.height * 4) / 1048576;
      b.close();
      if (i === 2) return { plain: plain / 3, capped: capped / 3, aMb, bMb };
    }
    return { plain: 0, capped: 0, aMb: 0, bMb: 0 };
  });
  console.log(
    `  4032x3024: plain decode ${cost.plain.toFixed(0)}ms / ${cost.aMb.toFixed(0)}MB · capped ${cost.capped.toFixed(0)}ms / ${cost.bMb.toFixed(0)}MB`,
  );
  check('the cap saves at least 3x the memory', cost.aMb / cost.bMb >= 3, `${cost.aMb.toFixed(0)} → ${cost.bMb.toFixed(0)} MB`);
  check('nothing comes back over the cap', r.out.every((x) => Math.max(x.w, x.h) <= r.cap), `cap ${r.cap}`);
  check('anything already small is untouched', r.out[0].w === 900 && r.out[0].h === 600);
  check('a 4:3 phone photo keeps its aspect', Math.abs(r.out[1].w / r.out[1].h - 4 / 3) < 0.01, `${r.out[1].w}x${r.out[1].h}`);
  check('portrait keeps its aspect too', Math.abs(r.out[2].h / r.out[2].w - 4 / 3) < 0.01, `${r.out[2].w}x${r.out[2].h}`);
  check('a 48MP shot comes down to the cap', Math.max(r.out[3].w, r.out[3].h) === r.cap, `${r.out[3].w}x${r.out[3].h}`);
  check('exactly at the cap is not resampled', r.out[4].w === r.out[4].h && r.out[4].w === r.cap);
  check('an extreme aspect never rounds to zero', r.out[5].w >= 1 && r.out[5].h >= 1, `${r.out[5].w}x${r.out[5].h}`);
  await ctx.close();
}

await decoder();
await run('small photo', 900, 600);
await run('phone photo', 4032, 3024);
await run('arabic', 1200, 800, 'ar');
await phone();
await timings();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
