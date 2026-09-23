/**
 * The Banner view, end to end.
 *
 * The rule this suite is built around comes from the image-import bug: that one
 * passed every DOM assertion we had while the canvas stayed black. So nothing
 * here asks the DOM whether drawing happened. It reads PIXELS back off the
 * artboard, and it reads the banner's stored display list back out of the
 * document — two independent answers to "did that stroke exist", neither of
 * which a broken renderer can fake.
 *
 * Five profiles, because the two live bug reports that started the phone work
 * were both written in Arabic and the tablet band is where controls have
 * fallen off a bar before: desktop, a phone upright, a phone on its side, an
 * iPad portrait at exactly 768x1024, and an Arabic RTL desktop.
 *
 *   node e2e-banner.mjs        (needs the app on :8911)
 */
import { chromium } from 'playwright';

const B = 'http://127.0.0.1:8911';
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());

let pass = 0;
let fail = 0;
const check = (n, ok, x = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

/** Open /app, get past the first-run bits, and hand back a live page. */
async function openApp(width, height, lang, { fresh = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: lang === 'ar' ? 'ar' : 'en-US' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  // "Fresh" is somebody who has not yet seen the banners news or the banner
  // tour — set once, so a reload keeps whatever the page itself stored.
  await page.addInitScript(({ l, fresh }) => {
    try {
      localStorage.setItem('tifo_lang_v1', l);
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'essential');
      localStorage.setItem('tifo_draw_hint_v1', '1');
      if (!fresh) {
        localStorage.setItem('tifo_news_banners_v1', '1');
        localStorage.setItem('tifo_banner_tour_v1', '1');
      }
    } catch { /* storage off */ }
  }, { l: lang, fresh });
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1400);
  return { ctx, page, errs };
}

/** A cheap, stable fingerprint of what is actually painted on the artboard. */
const artboardHash = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('#banner-host canvas');
    if (!c) return -1;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 613) h = (h * 31 + d[i]) >>> 0;
    return h;
  });

/** Drag a stroke across the artboard in fractions of its box. */
async function drawOn(page, pts) {
  const box = await page.$eval('#banner-host canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w * pts[0][0], box.y + box.h * pts[0][1]);
  await page.mouse.down();
  for (const [u, v] of pts.slice(1)) await page.mouse.move(box.x + box.w * u, box.y + box.h * v);
  await page.mouse.up();
  await page.waitForTimeout(220);
}

const storedBanner = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('tifo_banners_v1') || 'null');
    } catch {
      return null;
    }
  });

/**
 * Into the Banner view, and — unless told not to — make a banner there.
 *
 * A tifo starts with no banner now, so every section that draws on one makes
 * it first, through the same empty state a person would use.
 */
async function openBanner(page, { make = true, kind = 'stand', via = '#view-banner' } = {}) {
  await page.click(via);
  await page.waitForTimeout(900);
  if (!make) return;
  const btn = await page.$(`#bn-empty:not([hidden]) button[data-kind="${kind}"]`);
  if (btn) {
    await btn.click();
    await page.waitForTimeout(700);
  }
}

/**
 * Change what is stored, from a page that is not the app.
 *
 * The app writes its banners with its draft on the way out of the page, so a
 * change made underneath a running editor is put straight back by the reload
 * that was meant to pick it up.
 */
async function editStorage(page, fn, arg) {
  await page.goto(B + '/favicon.svg', { waitUntil: 'load' });
  await page.evaluate(fn, arg);
}
async function backToApp(page) {
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------

console.log('\n— desktop: the fourth view exists and draws —');
{
  const { ctx, page, errs } = await openApp(1500, 900, 'en');
  check('Banner sits in the view switcher', !!(await page.$('#view-banner')));
  await page.click('#view-banner');
  await page.waitForTimeout(1000);

  // Not everyone wants a banner. The view used to make one the first time it
  // opened, and it was saved with the tifo like any other — so everybody who
  // only LOOKED at this view had a banner on their North stand from then on.
  const none = await page.evaluate(() => ({
    card: (() => {
      const c = document.getElementById('bn-empty');
      if (!c || c.hidden) return false;
      const r = c.getBoundingClientRect();
      return r.width > 200 && r.height > 100;
    })(),
    rows: document.querySelectorAll('#bn-list .bn-li').length,
    stored: (() => { try { return JSON.parse(localStorage.getItem('tifo_banners_v1') || 'null')?.banners?.length ?? 0; } catch { return -1; } })(),
    bar: getComputedStyle(document.getElementById('banner-bar')).display === 'none',
    detail: document.getElementById('bn-detail')?.hidden === true,
    makers: document.querySelectorAll('#bn-empty button[data-kind], #bn-add-stand, #bn-add-hanging').length,
  }));
  check('a new tifo has no banner, and opening the Banner view does not make one', none.card && none.rows === 0 && none.stored === 0, JSON.stringify(none));
  check('with no banner there is no sheet to set up', none.bar && none.detail);
  check('the empty state offers both kinds', none.makers === 4, `${none.makers} buttons`);
  await page.click('#bn-empty button[data-kind="stand"]');
  await page.waitForTimeout(900);
  const made = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#bn-list .bn-li')].map((r) => r.textContent.trim().replace(/\s+/g, ' ')),
    card: document.getElementById('bn-empty')?.hidden === true,
    show: document.querySelectorAll('#bn-list .bn-li .bn-li-show').length,
  }));
  check('one click makes a banner, listed with its type and stand', made.rows.length === 1 && /Stand banner/.test(made.rows[0]) && made.card, JSON.stringify(made.rows));
  check('each banner has its own "Show in stadium"', made.show === 1);

  const s = await page.evaluate(() => ({
    canvas: !!document.querySelector('#banner-host canvas'),
    bar: document.getElementById('banner-bar')?.hidden === false,
    panel: getComputedStyle(document.getElementById('ctx-banner')).display !== 'none',
    seats: document.getElementById('canvas-host')?.hidden === true,
    facts: (document.getElementById('bn-facts')?.textContent || '').trim(),
    notes: document.querySelectorAll('.bn-note').length,
    body: document.body.classList.contains('banner-view'),
  }));
  check('artboard mounts', s.canvas);
  check('banner bar opens, seat canvas steps aside', s.bar && s.seats);
  check('placement panel is shown', s.panel && s.body);
  check('facts line is computed, not blank', s.facts.length > 10, s.facts);
  check('physical notes are listed', s.notes >= 1, `${s.notes} notes`);

  // The shape control, which is the only thing about a banner's geometry the
  // editor gets to say — its SIZE comes from the blocks it covers. Changing
  // the shape has to move the facts line, because the seam count and the
  // weight are computed from the sheet rather than stored on it.
  const shapeCheck = await page.evaluate(() => {
    const before = document.getElementById('bn-facts').textContent;
    const a = document.getElementById('bn-aspect');
    a.value = '180';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((r) => setTimeout(() => r({
      before,
      after: document.getElementById('bn-facts').textContent,
      label: document.getElementById('bn-aspect-out').textContent,
    }), 200));
  });
  check('the shape control moves the facts', shapeCheck.before !== shapeCheck.after, `${shapeCheck.before} -> ${shapeCheck.after}`);
  check('the shape reads as a ratio, not a decimal', /:/.test(shapeCheck.label), shapeCheck.label);
  await page.evaluate(() => {
    const a = document.getElementById('bn-aspect');
    a.value = '50';
    a.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  const before = await artboardHash(page);
  await drawOn(page, [[0.25, 0.4], [0.4, 0.3], [0.55, 0.5], [0.7, 0.35]]);
  const after = await artboardHash(page);
  check('a stroke changes real pixels', before !== after, `${before} -> ${after}`);

  await page.waitForTimeout(800);
  const doc = await storedBanner(page);
  const items = doc?.banners?.[0]?.items ?? [];
  check('the stroke is stored as a polyline, not a bitmap', items.length === 1 && items[0].kind === 'stroke', JSON.stringify(items.map((i) => i.kind)));
  check('the polyline is simplified, not every sample', items[0] && items[0].pts.length >= 4 && items[0].pts.length <= 80, `${items[0]?.pts.length} numbers`);

  check('Undo lights up for the banner', await page.$eval('#undo', (b) => !b.disabled));
  await page.click('#undo');
  await page.waitForTimeout(350);
  check('Undo puts the artboard back', (await artboardHash(page)) === before);
  await page.click('#redo');
  await page.waitForTimeout(350);
  check('Redo brings it back', (await artboardHash(page)) === after);

  // Tools reach the banner rather than the seats.
  await page.click('.tool-rail [data-tool="shape"]');
  await page.waitForTimeout(250);
  const box = await page.$eval('#banner-host canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width * 0.35, y: r.y + r.height * 0.6 };
  });
  await page.mouse.click(box.x, box.y);
  // The banner store writes to localStorage on a 600ms debounce; reading at
  // 500 was reading the state before the shape landed.
  await page.waitForTimeout(1100);
  const withShape = (await storedBanner(page))?.banners?.[0]?.items ?? [];
  check('the Shape tool places on the banner', withShape.some((i) => i.kind === 'shape'), JSON.stringify(withShape.map((i) => i.kind)));

  // Leaving and coming back.
  await page.click('#view-2d');
  await page.waitForTimeout(500);
  const left = await page.evaluate(() => ({
    seats: document.getElementById('canvas-host')?.hidden === false,
    banner: document.getElementById('banner-host')?.hidden === true,
    bar: document.getElementById('banner-bar')?.hidden === true,
    body: document.body.classList.contains('banner-view'),
  }));
  check('Design view comes back whole', left.seats && left.banner && left.bar && !left.body);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the banner reaches the bowl —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  await openBanner(page);
  await drawOn(page, [[0.2, 0.4], [0.5, 0.3], [0.8, 0.45]]);
  await page.waitForTimeout(400);
  await page.click('#bn-matchday');
  // The simulator is ~690KB and builds a whole scene; give it room.
  await page.waitForTimeout(12000);
  const sim = await page.evaluate(() => ({
    overlay: !!document.querySelector('.mds-overlay'),
    section: !!document.querySelector('[data-sec="banners"]'),
    options: [...(document.querySelector('[data-sec="banners"] select')?.options ?? [])].map((o) => o.textContent),
  }));
  check('Match Day opens from the Banner view', sim.overlay);
  check('the bowl has a Banners section', sim.section);
  check('the banner is listed there', (sim.options || []).length >= 1, JSON.stringify(sim.options));
  check('no page errors opening the bowl', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// The banner in the EDITOR's own bowl, not only in Match Day.
//
// Asked of pixels rather than of the DOM: the whole point is that the sheet is
// DRAWN there, and a scene-graph assertion would pass just as happily with a
// banner rendered somewhere off-camera or at zero size. So the check is to
// photograph the preview with the banner shown and again with it hidden, and
// require that the picture changed.
console.log('\n— the banner shows in the editor bowl —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  await openBanner(page);
  await drawOn(page, [[0.15, 0.35], [0.5, 0.2], [0.85, 0.4]]);
  await page.waitForTimeout(400);
  await page.click('#view-3d');
  // Three.js loads lazily here and the bowl has to build before it draws.
  await page.waitForTimeout(9000);
  const shotOf = async () => {
    const el = await page.$('#preview-host canvas');
    if (!el) return null;
    const b = await el.screenshot();
    let h = 2166136261;
    for (let i = 0; i < b.length; i += 7) { h ^= b[i]; h = Math.imul(h, 16777619); }
    return { hash: h >>> 0, bytes: b.length };
  };
  const withBanner = await shotOf();
  check('the editor bowl renders', !!withBanner, JSON.stringify(withBanner));
  // Hide every banner through the store the app already exposes, so this does
  // not depend on a control's markup.
  await editStorage(page, () => {});
  const hidden = await page.evaluate(() => {
    const raw = localStorage.getItem('tifo_banners_v1');
    if (!raw) return false;
    const m = JSON.parse(raw);
    for (const b of m.banners ?? []) b.visible = false;
    localStorage.setItem('tifo_banners_v1', JSON.stringify(m));
    return (m.banners ?? []).length > 0;
  });
  check('a banner was stored to hide', hidden);
  await backToApp(page);
  await page.click('#view-3d');
  await page.waitForTimeout(9000);
  const withoutBanner = await shotOf();
  check(
    'hiding the banner changes what the bowl draws',
    !!withBanner && !!withoutBanner && withBanner.hash !== withoutBanner.hash,
    `${withBanner?.hash} vs ${withoutBanner?.hash}`,
  );
  // The fabric is FABRIC, not a window.
  //
  // A solid banner with a background painted across it has no transparency
  // anywhere, and it was being drawn in the transparent pass anyway — so the
  // seats behind it showed faintly through, which is the one thing a sheet of
  // cloth does not do. Checked in pixels, because that is the only place the
  // symptom exists: give the banner a colour nothing else in the bowl uses,
  // find where it lands, and require the middle of it to be that colour and
  // nothing else.
  await editStorage(page, () => {
    const raw = localStorage.getItem('tifo_banners_v1');
    const m = JSON.parse(raw);
    for (const b of m.banners ?? []) { b.visible = true; b.bg = '#ff00ff'; b.material = 'solid'; }
    localStorage.setItem('tifo_banners_v1', JSON.stringify(m));
  });
  await backToApp(page);
  await page.click('#view-3d');
  await page.waitForTimeout(9000);
  // The CLOSEST camera, not the default one.
  //
  // This gate passed while thirty thousand seat cards were coming through the
  // fabric, because the default view is the whole bowl from 245 m up: the
  // banner was 177 px wide there and everything poking through it was smaller
  // than a pixel. A check that can only see gross faults is a check that
  // reports gross faults.
  await page.selectOption('#camera-preset', '0');
  await page.waitForTimeout(2500);
  const solid = await page.evaluate(() => {
    const cv = document.querySelector('#preview-host canvas');
    if (!cv) return null;
    const c2 = document.createElement('canvas');
    c2.width = cv.width;
    c2.height = cv.height;
    const g = c2.getContext('2d');
    g.drawImage(cv, 0, 0);
    const d = g.getImageData(0, 0, c2.width, c2.height).data;
    const isBanner = (i) => d[i] > 110 && d[i + 2] > 110 && d[i + 1] < d[i] * 0.72;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < c2.height; y++) {
      for (let x = 0; x < c2.width; x++) {
        if (!isBanner((y * c2.width + x) * 4)) continue;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (n < 400) return { found: n };
    // The middle half of the sheet, away from its edges and its curvature.
    const mx0 = Math.round(x0 + (x1 - x0) * 0.3);
    const mx1 = Math.round(x0 + (x1 - x0) * 0.7);
    const my0 = Math.round(y0 + (y1 - y0) * 0.3);
    const my1 = Math.round(y0 + (y1 - y0) * 0.7);
    let inside = 0;
    let foreign = 0;
    for (let y = my0; y <= my1; y++) {
      for (let x = mx0; x <= mx1; x++) {
        inside++;
        if (!isBanner((y * c2.width + x) * 4)) foreign++;
      }
    }
    return { found: n, inside, foreign, pct: inside ? foreign / inside : 1 };
  });
  check('the banner is found in the editor bowl', !!solid && solid.found > 400, JSON.stringify(solid));
  check(
    'nothing shows through the middle of the fabric',
    !!solid && solid.inside > 0 && solid.pct < 0.02,
    solid ? `${((solid.pct ?? 1) * 100).toFixed(1)}% of the middle is not the banner` : 'no reading',
  );
  check('no page errors in the editor bowl', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// The panel, the keys and the things on the sheet — each of which was broken
// in a way no screenshot of the default state could show.
console.log('\n— the Banner view\'s own controls —');
{
  const { ctx, page, errs } = await openApp(1500, 900, 'en');

  // A seat stroke first, so the SEAT editor has something to undo. Ctrl+Z in
  // the Banner view used to spend it: the key went to the seats, which are
  // not on screen, and a stroke vanished from a surface nobody was looking at.
  const seat = await page.$eval('#canvas-host canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 };
  });
  await page.mouse.move(seat.x - 60, seat.y);
  await page.mouse.down();
  for (let i = 0; i <= 8; i++) await page.mouse.move(seat.x - 60 + i * 15, seat.y + (i % 2) * 6);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const seatUndo = await page.$eval('#undo', (b) => !b.disabled);

  await openBanner(page);
  await page.waitForTimeout(300);

  // The pickers are there without Match Day. They used to come from an event
  // only an open simulator answered, and Match Day covers the whole screen —
  // so in practice nobody ever saw the block or tier pickers at all.
  const panel = await page.evaluate(() => {
    const shown = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
    };
    return {
      blocks: shown('bn-block') && document.getElementById('bn-block').options.length > 2,
      span: shown('bn-span') && document.getElementById('bn-span').options.length >= 1,
      tier: shown('bn-tier-row'),
      size: document.getElementById('bn-size-out')?.textContent ?? '',
      fabric: document.getElementById('bn-bg-none')?.checked === false,
      reveals: [...document.getElementById('bn-reveal').options].map((o) => o.value),
      brush: shown('bn-brush-block'),
      seatBrush: shown('ctx-brush'),
    };
  });
  check('the block pickers are there without Match Day', panel.blocks && panel.span, JSON.stringify(panel));
  check('the tier picker is there without Match Day', panel.tier);
  check('the size is measured on this ground, not estimated', /ground|ملعب/.test(panel.size) && !/about|حوالي/.test(panel.size), panel.size);
  check('a new banner is cloth, not see-through', panel.fabric);
  check('a stand banner offers only what it can do: unroll, or already up', panel.reveals.join() === 'unroll,cut', panel.reveals.join());
  check('the banner brush is shown for the brush, the seat brush is not', panel.brush && !panel.seatBrush);

  // A hanging banner offers its own motion instead.
  await page.selectOption('#bn-kind', 'hanging');
  await page.waitForTimeout(400);
  const hang = await page.evaluate(() => ({
    reveals: [...document.getElementById('bn-reveal').options].map((o) => o.value),
    preset: document.getElementById('bn-preset').value,
    tiers: [...document.getElementById('bn-tier').options].map((o) => o.value),
  }));
  check('a hanging banner offers: haul up, or already up', hang.reveals.join() === 'hoist,cut', hang.reveals.join());
  check('changing the type keeps the size preset', hang.preset === 'two', hang.preset);

  // Between two tiers the gap sets the shape — the artboard becomes the strip
  // the banner will be printed on, instead of a 2:1 sheet squashed in the bowl.
  if (hang.tiers.includes('1')) {
    const beforeStrip = await artboardHash(page);
    await page.selectOption('#bn-tier', '1');
    await page.waitForTimeout(600);
    const strip = await page.evaluate(() => ({
      locked: document.getElementById('bn-preset').disabled && document.getElementById('bn-aspect').disabled,
      note: getComputedStyle(document.getElementById('bn-fit-note')).display !== 'none',
      ratio: document.getElementById('bn-aspect-out').textContent,
    }));
    check('between two tiers the gap sets the shape', strip.locked && strip.note, JSON.stringify(strip));
    check('the artboard becomes the strip', (await artboardHash(page)) !== beforeStrip && /^(\d+):1$/.test(strip.ratio) && Number(strip.ratio.split(':')[0]) >= 5, strip.ratio);
    await page.selectOption('#bn-tier', '-1');
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => ({ ratio: document.getElementById('bn-aspect-out').textContent, locked: document.getElementById('bn-preset').disabled }));
    check('out of the gap, the shape is the user\'s again', back.ratio === '2:1' && !back.locked, JSON.stringify(back));
  }
  await page.selectOption('#bn-kind', 'stand');
  await page.waitForTimeout(400);

  // A word on the sheet, then pick it up, delete it, and bring it back.
  await page.click('.tool-rail [data-tool="text"]');
  await page.waitForTimeout(250);
  await page.fill('#text-input', 'ULTRAS');
  const mid = await page.$eval('#banner-host canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(1100);
  const placed = await page.evaluate(() => ({
    block: !document.getElementById('bn-item-block').hidden,
    name: document.getElementById('bn-item-name').textContent,
  }));
  check('a placed word is selected, with its actions beside it', placed.block && /ULTRAS/.test(placed.name), JSON.stringify(placed));
  // Clicked onto the middle, it lands on the middle — the text bar opening
  // above the artboard used to shift the sheet half a bar out from under it.
  await page.click('.tool-rail [data-tool="select"]');
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(400);
  check('clicking where it was placed picks it up', await page.evaluate(() => !document.getElementById('bn-item-block').hidden));
  await page.mouse.move(5, 5);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(900);
  const gone = ((await storedBanner(page))?.banners?.[0]?.items ?? []).some((i) => i.kind === 'text');
  check('Delete takes the selected word off the banner', !gone);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(900);
  const back = ((await storedBanner(page))?.banners?.[0]?.items ?? []).some((i) => i.kind === 'text');
  check('Ctrl+Z in the Banner view undoes the BANNER', back);
  // Undo everything the banner has, and then some.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  await page.click('#view-2d');
  await page.waitForTimeout(600);
  const seatStill = await page.$eval('#undo', (b) => !b.disabled);
  check('Ctrl+Z in the Banner view never touches the seats', seatUndo && seatStill, `seat undo before ${seatUndo}, after ${seatStill}`);

  // Beside the bowl: the banner and the stadium together, the camera on it.
  // Undo went back past the banner being made — it is the user's own edit,
  // so it should — which leaves the empty state; make a fresh one.
  await openBanner(page);
  await page.click('#bn-beside');
  await page.waitForTimeout(9000);
  const split = await page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const b = r('banner-host');
    const p = r('preview-host');
    return {
      side: b.width > 200 && p.width > 200 && Math.abs(b.top - p.top) < 2 && !document.getElementById('banner-host').hidden && !document.getElementById('preview-host').hidden,
      cam: document.getElementById('camera-preset').value,
      pressed: document.getElementById('bn-beside').getAttribute('aria-pressed'),
    };
  });
  check('"Split with the stadium" puts the bowl beside the banner', split.side && split.pressed === 'true', JSON.stringify(split));
  check('and points the bowl at the banner', split.cam === 'banner', split.cam);
  // An untouched banner is visible there: it is cloth, so it draws.
  const bright = await page.evaluate(() => {
    const cv = document.querySelector('#preview-host canvas');
    const c2 = document.createElement('canvas');
    c2.width = cv.width;
    c2.height = cv.height;
    const g = c2.getContext('2d');
    g.drawImage(cv, 0, 0);
    const d = g.getImageData(0, 0, c2.width, c2.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 180) n++;
    return n / (d.length / 4);
  });
  check('a banner nobody has drawn on yet is still there to see', bright > 0.03, `${(bright * 100).toFixed(1)}% of the bowl is fabric`);
  check('no page errors in the Banner view', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// Every banner in the list has its own way into the stadium: the Stadium
// view, the camera on that banner, and the banner actually in the picture.
console.log('\n— "Show in stadium" —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  await openBanner(page, { kind: 'stand' });
  const fabricShare = () => page.evaluate(() => {
    const cv = document.querySelector('#preview-host canvas');
    if (!cv) return -1;
    const c2 = document.createElement('canvas');
    c2.width = cv.width;
    c2.height = cv.height;
    const g = c2.getContext('2d');
    g.drawImage(cv, 0, 0);
    const d = g.getImageData(0, 0, c2.width, c2.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 180) n++;
    return n / (d.length / 4);
  });
  const where = () => page.evaluate(() => ({
    view: ['view-2d', 'view-banner', 'view-3d', 'view-split'].find((id) => document.getElementById(id)?.classList.contains('active')),
    bowl: document.getElementById('preview-host')?.hidden === false && document.getElementById('banner-host')?.hidden === true,
    cam: document.getElementById('camera-preset')?.value,
    msg: document.getElementById('message')?.textContent ?? '',
  }));
  await page.click('#bn-list .bn-li .bn-li-show');
  await page.waitForTimeout(9000);
  const first = await where();
  check('"Show in stadium" opens the Stadium view', first.view === 'view-3d' && first.bowl, JSON.stringify(first));
  check('with the camera on that banner, and says so', first.cam === 'banner' && /Banner 1/.test(first.msg), first.msg);
  const share1 = await fabricShare();
  check('the banner is in the picture', share1 > 0.03, `${(share1 * 100).toFixed(1)}% of the bowl is fabric`);
  const shot1 = await (await page.$('#preview-host canvas'))?.screenshot().catch(() => null);

  // A second one, of the other kind, from the list's own button — and its own
  // "Show in stadium" goes to IT, not to the first.
  await openBanner(page, { make: false });
  await page.click('#bn-add-hanging');
  await page.waitForTimeout(900);
  const rows = await page.$$('#bn-list .bn-li .bn-li-show');
  check('the list has a row and a button per banner', rows.length === 2, `${rows.length} rows`);
  await rows[1].click();
  await page.waitForTimeout(3500);
  const second = await where();
  const shot2 = await (await page.$('#preview-host canvas'))?.screenshot().catch(() => null);
  check('the second row shows the second banner', second.view === 'view-3d' && second.cam === 'banner' && /Banner 2/.test(second.msg), second.msg);
  check('and the camera moved to it', !!shot1 && !!shot2 && Buffer.compare(shot1, shot2) !== 0);

  // A tifo can go back to having none: the last one can be deleted, and the
  // camera that looked at banners stops being offered.
  await openBanner(page, { make: false });
  await page.click('#bn-del');
  await page.waitForTimeout(400);
  await page.click('#bn-del');
  await page.waitForTimeout(900);
  const gone = await page.evaluate(() => ({
    card: document.getElementById('bn-empty')?.hidden === false,
    stored: JSON.parse(localStorage.getItem('tifo_banners_v1') || '{"banners":[]}').banners.length,
    camOffered: !document.querySelector('#camera-preset option[value="banner"]')?.disabled,
    cam: document.getElementById('camera-preset')?.value,
  }));
  check('the last banner can be deleted, back to the empty state', gone.card && gone.stored === 0, JSON.stringify(gone));
  check('with no banner, the "Your banner" camera is not offered', !gone.camOffered && gone.cam !== 'banner', JSON.stringify(gone));
  check('no page errors showing banners in the stadium', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// A banner belongs to the tifo it was made in. Stored banners used to load
// whatever the canvas held, so a new tifo — a first visit, another stadium, a
// design from the gallery — opened with the last one's banners on it; and the
// banner the old Banner view made by itself turned up on every tifo that had
// ever looked at it.
console.log('\n— banners belong to their tifo —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  const banner = (over) => ({
    id: 'bn_x', name: 'Banner 1', kind: 'stand', aspect: 0.5, material: 'solid', fabricGsm: 110,
    netBacked: false, weightBar: true, bg: null, items: [],
    slot: { stand: 1, stands: 1, blockFrom: -1, blockSpan: 2, tier: -1 },
    reveal: 'unroll', revealMs: 5000, wind: 0.25, visible: true, ...over,
  });
  const listed = async () => {
    await page.click('#view-banner');
    await page.waitForTimeout(900);
    const names = await page.$$eval('#bn-list .bn-li .bn-li-name', (els) => els.map((e) => e.textContent));
    await page.click('#view-2d');
    await page.waitForTimeout(300);
    return names;
  };
  // A tifo with a draft: a stroke on the seats writes one.
  const c = await page.$eval('#canvas-host canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(c.x - 50, c.y);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) await page.mouse.move(c.x - 50 + i * 10, c.y + (i % 2) * 4);
  await page.mouse.up();
  await page.waitForTimeout(2200);

  await editStorage(page, (v) => localStorage.setItem('tifo_banners_v1', JSON.stringify(v)), { v: 1, banners: [banner({ id: 'bn_ghost' })] });
  await backToApp(page);
  check('the banner nobody made does not come back', (await listed()).length === 0);

  await editStorage(page, (v) => localStorage.setItem('tifo_banners_v1', JSON.stringify(v)), { v: 1, banners: [banner({ id: 'bn_mine', name: 'Mine', bg: '#ff0000' })] });
  await backToApp(page);
  check('a banner somebody made comes back with its tifo', JSON.stringify(await listed()) === '["Mine"]');

  await editStorage(page, (v) => {
    localStorage.setItem('tifo_banners_v1', JSON.stringify(v));
    localStorage.removeItem('tifo_draft_v1');
  }, { v: 1, banners: [banner({ id: 'bn_mine', name: 'Mine', bg: '#ff0000' })] });
  await backToApp(page);
  check('a brand-new tifo does not start with the last one\'s banners', (await listed()).length === 0);

  // A design opened from the gallery is another tifo, and it has its own
  // banners or none — never the ones that were on screen.
  await openBanner(page);
  const hadOne = (await page.$$('#bn-list .bn-li')).length === 1;
  await page.click('#view-2d');
  await page.waitForTimeout(300);
  // Through the account menu: at this width the header folds Gallery into it.
  if (await page.$eval('#gallery', (b) => b.getBoundingClientRect().width > 0)) await page.click('#gallery');
  else {
    await page.click('#avatar');
    await page.click('#menu-gallery');
  }
  const opened = await page.waitForSelector('.feed-card .feed-open', { timeout: 20000 }).then(() => true, () => false);
  if (opened) {
    await page.click('.feed-card .feed-open');
    await page.waitForTimeout(4000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);
  }
  // Its own banners or none: the gallery opens on the banner showcase now, so
  // the first design there has banners of its own. What must not be there is
  // the one this tifo had.
  const there = opened ? await listed() : [];
  check('a design opened from the gallery does not bring the last tifo\'s banner', hadOne && opened && !there.includes('Banner 1'),
    `made one: ${hadOne}, gallery opened: ${opened}, it has: ${there.join(', ') || 'none'}`);
  check('no page errors keeping banners with their tifo', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// Match Day's own Banners section, where East used to mean North.
console.log('\n— Match Day moves the banner where it is told —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  await page.evaluate(() => localStorage.setItem('mds_seen_intro', '1'));
  await openBanner(page);
  await page.click('#bn-matchday');
  await page.waitForTimeout(13000);
  const opened = await page.evaluate(() => document.querySelector('[data-sec="banners"]')?.classList.contains('open'));
  check('opened from the Banner view, Match Day opens on the banner', !!opened);
  const east = await page.evaluate(async () => {
    const sec = document.querySelector('[data-sec="banners"]');
    const stand = [...sec.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === '0') && [...s.options].some((o) => o.value === '3'));
    if (!stand) return 'no stand picker';
    stand.value = '0';
    stand.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const m = JSON.parse(localStorage.getItem('tifo_banners_v1') || 'null');
    return m?.banners?.[0]?.slot?.stand;
  });
  check('choosing East puts it on the East stand', east === 0, String(east));
  check('no page errors in Match Day', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— phones and tablets —');
for (const [w, h, label] of [[390, 844, 'phone upright'], [844, 390, 'phone on its side'], [768, 1024, 'iPad portrait']]) {
  const { ctx, page, errs } = await openApp(w, h, 'en');
  const phone = w <= 899 && h <= 899 ? true : w <= 899 || h <= 899;
  // The floating pill on a phone, the header's segmented control otherwise.
  const entry = await page.evaluate(() => ({
    pill: document.querySelectorAll('.m-view-b[data-view]').length,
    header: !!document.querySelector('#view-banner'),
  }));
  check(`${label}: there is a way into Banner`, entry.pill >= 3 || entry.header, JSON.stringify(entry));

  if (entry.pill >= 3) await page.click('.m-view-b[data-view="banner"]');
  else await page.click('#view-banner');
  await page.waitForTimeout(1200);
  const card = await page.evaluate(() => {
    const c = document.getElementById('bn-empty');
    if (!c || c.hidden) return null;
    const r = c.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: innerWidth, h: innerHeight };
  });
  check(`${label}: the empty state fits the screen`, !!card && card.l >= 0 && card.r <= card.w && card.t >= 0 && card.b <= card.h, JSON.stringify(card));
  await page.click('#bn-empty button[data-kind="stand"]');
  await page.waitForTimeout(800);

  const shown = await page.evaluate(() => {
    const c = document.querySelector('#banner-host canvas');
    const r = c?.getBoundingClientRect();
    return { canvas: !!c, w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) };
  });
  check(`${label}: the artboard fills its box`, shown.canvas && shown.w > 120 && shown.h > 120, `${shown.w}x${shown.h}`);

  // Nothing overflows the viewport sideways, and nothing is a 12px target.
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll('#banner-bar button, #banner-bar select, #banner-bar input, #ctx-banner button, #ctx-banner select, #ctx-banner input, .m-view-b')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // genuinely not on screen
      if (r.height < 24 || r.width < 24) small.push((el.id || el.className || el.tagName) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return {
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      small,
      pillFits: [...document.querySelectorAll('.m-view')].every((p) => p.getBoundingClientRect().right <= innerWidth + 1 && p.getBoundingClientRect().left >= -1),
    };
  });
  check(`${label}: no horizontal scroll`, !layout.hscroll);
  check(`${label}: nothing under 24px`, layout.small.length === 0, layout.small.slice(0, 4).join(', '));
  check(`${label}: the view pill fits the screen`, layout.pillFits);

  // Draw with a finger.
  const box = await page.$eval('#banner-host canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const before = await artboardHash(page);
  await page.touchscreen?.tap?.(box.x + box.w / 2, box.y + box.h / 2).catch(() => {});
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.5);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) await page.mouse.move(box.x + box.w * (0.3 + i * 0.03), box.y + box.h * (0.5 - i * 0.015));
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(`${label}: drawing works`, (await artboardHash(page)) !== before);
  check(`${label}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— Arabic —');
{
  const { ctx, page, errs } = await openApp(1500, 900, 'ar');
  const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
  check('the page is RTL', dir === 'rtl', String(dir));
  await page.click('#view-banner');
  await page.waitForTimeout(1000);
  const emptyAr = await page.evaluate(() => [...document.querySelectorAll('#bn-empty h3, #bn-empty p, #bn-empty button, #bn-list, #bn-add-stand, #bn-add-hanging')]
    .map((el) => (el.textContent || '').trim()).filter((x) => x && /^[\x00-\x7F]+$/.test(x)));
  check('the empty state is Arabic', emptyAr.length === 0, emptyAr.join(' | '));
  await page.click('#bn-empty button[data-kind="stand"]');
  await page.waitForTimeout(900);
  const ar = await page.evaluate(() => {
    const latin = [];
    for (const el of document.querySelectorAll('#banner-bar label, #banner-bar option, #ctx-banner h4, #ctx-banner label, #ctx-banner option, #ctx-banner button, .bn-note')) {
      const txt = (el.textContent || '').trim();
      // g/m² and the metre abbreviation are units, not prose.
      if (!txt || /^[\d\s.,×x/²°%-]+$/.test(txt) || /g\/m²|EN 13501/.test(txt)) continue;
      if (/^[\x00-\x7F]+$/.test(txt)) latin.push(txt.slice(0, 40));
    }
    return {
      latin,
      facts: (document.getElementById('bn-facts')?.textContent || '').trim(),
      notes: [...document.querySelectorAll('.bn-note')].map((n) => n.textContent.trim().slice(0, 30)),
    };
  });
  check('every banner label is translated', ar.latin.length === 0, ar.latin.slice(0, 5).join(' | '));
  check('the facts line is Arabic', /[؀-ۿ]/.test(ar.facts), ar.facts);
  check('the notes are Arabic', ar.notes.length > 0 && ar.notes.every((n) => /[؀-ۿ]/.test(n)), ar.notes.join(' | '));

  const before = await artboardHash(page);
  await drawOn(page, [[0.3, 0.4], [0.6, 0.5]]);
  check('drawing works in Arabic too', (await artboardHash(page)) !== before);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// "Banners are here": told once, to everyone who opens the editor.

/** Where the news card is, and what it points at. */
const newsState = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('news-card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const tab = [...document.querySelectorAll('.m-view-b[data-view="banner"], #view-banner')].find((e) => e.getBoundingClientRect().width > 0);
    const t = tab?.getBoundingClientRect();
    const a = c.querySelector('.news-arrow')?.getBoundingClientRect();
    const buttons = [...c.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return Math.min(q.width, q.height); });
    return {
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      under: t ? r.top >= t.bottom - 1 && r.top - t.bottom < 30 : false,
      arrowOnTab: t && a ? a.left + a.width / 2 > t.left && a.left + a.width / 2 < t.right : false,
      inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      smallest: Math.min(...buttons),
      text: c.textContent.replace(/\s+/g, ' ').trim(),
      focusInside: c.contains(document.activeElement),
    };
  });
const flag = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

console.log('\n— the banners news —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en', { fresh: true });
  await page.waitForSelector('#news-card', { timeout: 15000 }).catch(() => null);
  const n = await newsState(page);
  check('the news appears in the editor', !!n);
  check('it says banners are here', !!n && /Banners are here/.test(n.text) && /Try banners/.test(n.text), n?.text);
  check('it sits just under the Banner tab, pointing at it', !!n && n.under && n.arrowOnTab, JSON.stringify(n?.box));
  check('it is on the screen, with 24 px targets', !!n && n.inView && n.smallest >= 24, `${n?.smallest}`);
  check('it does not take focus from the page', !!n && !n.focusInside);
  check('it is not remembered before it is answered', (await flag(page, 'tifo_news_banners_v1')) === null);
  await page.click('#news-later');
  check('"Not now" puts it away', await page.waitForSelector('#news-card', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
  check('and it is remembered', (await flag(page, 'tifo_news_banners_v1')) === '1');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  check('it does not come back', !(await page.$('#news-card')));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  // Waits its turn: after the onboarding dialog, never on top of it.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('tifo_lang_v1', 'en'); localStorage.setItem('tifo_consent_v1', 'essential'); } } catch { /* */ } });
  await page.goto(B + '/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);
  const both = await page.evaluate(() => ({ ob: !!document.querySelector('.ob-backdrop'), news: !!document.getElementById('news-card') }));
  check('a first visit gets the onboarding dialog, and no news on top of it', both.ob && !both.news, JSON.stringify(both));
  await page.evaluate(() => (document.querySelector('.ob-skip') || document.querySelector('.ob-backdrop button'))?.click());
  const after = await page.waitForSelector('#news-card', { timeout: 15000 }).catch(() => null);
  check('the news follows once the dialog is closed', !!after);
  await ctx.close();
}
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en', { fresh: true });
  await page.waitForSelector('#news-card', { timeout: 15000 });
  await page.click('#news-try');
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({
    view: document.getElementById('view-banner')?.classList.contains('active'),
    news: !!document.getElementById('news-card'),
    tour: document.querySelector('.tour-overlay #tour-title')?.textContent,
  }));
  check('"Try banners" opens the Banner view', !!st.view);
  check('and the news goes', !st.news);
  check('and the Banner view\'s own tour starts', st.tour === 'This is the Banner view', st.tour);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  // Passed over: moving to another view ends it, rather than leaving it on
  // top of the Stadium view's camera bar.
  const { ctx, page } = await openApp(1400, 880, 'en', { fresh: true });
  await page.waitForSelector('#news-card', { timeout: 15000 });
  await page.click('#view-3d');
  // Waited for rather than slept on: the Stadium view builds its bowl on the
  // same thread, and the card's fade-out timer runs behind it.
  const gone = await page.waitForSelector('#news-card', { state: 'detached', timeout: 8000 }).then(() => true, () => false);
  check('switching view puts the news away', gone);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// The Banner view's tour: the first time it opens, skippable, and again on ask.

/** The tour as it stands: its step, and whether the spotlight is on the screen. */
const tourState = (page) =>
  page.evaluate(() => {
    const o = document.querySelector('.tour-overlay');
    if (!o) return null;
    const spot = o.querySelector('#tour-spot').getBoundingClientRect();
    const pop = o.querySelector('#tour-pop').getBoundingClientRect();
    const overlap = pop.left < spot.right && pop.right > spot.left && pop.top < spot.bottom && pop.bottom > spot.top;
    return {
      step: o.querySelector('#tour-step').textContent,
      title: o.querySelector('#tour-title').textContent,
      spotOnScreen: spot.width > 0 && spot.left > -10 && spot.right < innerWidth + 10,
      popOnScreen: pop.left >= 0 && pop.right <= innerWidth && pop.top >= 0 && pop.bottom <= innerHeight,
      overlap,
      scrolled: document.scrollingElement.scrollLeft + document.scrollingElement.scrollTop + document.body.scrollLeft,
    };
  });
async function walkTour(page) {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const s = await tourState(page);
    if (!s) break;
    seen.push(s);
    await page.click('#tour-next');
    await page.waitForTimeout(350);
  }
  return seen;
}

console.log('\n— the banner tour —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en', { fresh: true });
  await page.evaluate(() => localStorage.setItem('tifo_news_banners_v1', '1'));
  await page.click('#view-banner');
  await page.waitForTimeout(1300);
  const first = await tourState(page);
  check('opening the Banner view for the first time starts its tour', first?.title === 'This is the Banner view', first?.title);
  const steps = await walkTour(page);
  check('with no banner yet, it is about making one', steps.some((s) => s.title === 'Make your first one') && !steps.some((s) => s.title === 'The sheet'),
    steps.map((s) => s.title).join(' → '));
  check('every step points at something on the screen', steps.every((s) => s.spotOnScreen && s.popOnScreen));
  check('the card never covers what it describes', steps.every((s) => !s.overlap), steps.filter((s) => s.overlap).map((s) => s.title).join(', '));
  check('it never scrolls the page', steps.every((s) => s.scrolled === 0));
  check('finishing it is remembered', (await flag(page, 'tifo_banner_tour_v1')) === '1');
  await page.click('#view-2d');
  await page.waitForTimeout(400);
  await page.click('#view-banner');
  await page.waitForTimeout(1300);
  check('and it does not come back on the next open', !(await tourState(page)));

  // Again on ask, and about the banner once there is one.
  await page.click('#bn-empty button[data-kind="stand"]');
  await page.waitForTimeout(800);
  await page.click('#bn-tour');
  await page.waitForTimeout(700);
  const again = await walkTour(page);
  const titles = again.map((s) => s.title);
  check('"How banners work" runs it again', again.length > 0);
  check('with a banner, it walks the sheet, the list, the placement and match day',
    ['The sheet', 'Every banner in this tifo', 'Where it hangs', 'Match day'].every((t) => titles.includes(t)), titles.join(' → '));
  check('every step is on the screen, and the card never covers its control',
    again.every((s) => s.spotOnScreen && s.popOnScreen && !s.overlap), again.filter((s) => !s.spotOnScreen || !s.popOnScreen || s.overlap).map((s) => s.title).join(', '));
  check('it never scrolls the page', again.every((s) => s.scrolled === 0));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  // Skippable: Escape, and Skip.
  const { ctx, page } = await openApp(1400, 880, 'en', { fresh: true });
  await page.evaluate(() => localStorage.setItem('tifo_news_banners_v1', '1'));
  await page.click('#view-banner');
  await page.waitForTimeout(1300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape ends the tour', !(await tourState(page)));
  check('and that counts as seen', (await flag(page, 'tifo_banner_tour_v1')) === '1');
  await page.click('#bn-tour');
  await page.waitForTimeout(600);
  await page.click('#tour-skip');
  await page.waitForTimeout(300);
  check('"Skip tour" ends it too', !(await tourState(page)));
  // A tour that ended used to leave its Escape listener behind.
  await page.click('#bn-tour');
  await page.waitForTimeout(600);
  const open1 = !!(await tourState(page));
  await page.click('#tour-next');
  await page.waitForTimeout(300);
  check('a second run is not ended by the first one\'s leftovers', open1 && !!(await tourState(page)));
  await ctx.close();
}
{
  // A narrow laptop: the panel is a closed slide-over, so the tour leaves out
  // the steps that live in it rather than pointing past the edge.
  const { ctx, page } = await openApp(1024, 720, 'en', { fresh: true });
  await page.evaluate(() => localStorage.setItem('tifo_news_banners_v1', '1'));
  await page.click('#view-banner');
  await page.waitForTimeout(1300);
  const steps = await walkTour(page);
  check('1024 wide: the tour skips the closed panel', steps.length >= 2 && steps.every((s) => s.spotOnScreen && s.popOnScreen && s.scrolled === 0),
    steps.map((s) => `${s.title}${s.spotOnScreen ? '' : ' (off)'}`).join(' → '));
  // And the closed panel is out of reach of focus, which is what scrolled
  // the page sideways when anything focused it.
  const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('panel')).visibility);
  check('1024 wide: the closed panel cannot take focus', hidden === 'hidden', hidden);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); for (const [k, v] of [['tifo_lang_v1', 'en'], ['tifo_onboarded_v1', '1'], ['tifo_consent_v1', 'essential'], ['tifo_draw_hint_v1', '1']]) localStorage.setItem(k, v); } } catch { /* */ } });
  await page.goto(B + '/app?editor=1', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('#news-card', { timeout: 15000 }).catch(() => null);
  const n = await newsState(page);
  check('phone: the news points at the view pill\'s Banner', !!n && n.under && n.arrowOnTab && n.inView, JSON.stringify(n?.box));
  await page.tap('#news-try');
  await page.waitForTimeout(1500);
  const steps = await walkTour(page);
  check('phone: its own short tour', steps.length >= 2 && steps.length <= 4 && steps.every((s) => s.spotOnScreen && s.popOnScreen), steps.map((s) => s.title).join(' → '));
  check('phone: no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// "See it on match day" opens on the banner, and then the camera is yours.

console.log('\n— match day from the Banner view —');
{
  const { ctx, page, errs } = await openApp(1400, 880, 'en');
  await page.evaluate(() => localStorage.setItem('mds_seen_intro', '1'));
  await openBanner(page);
  await page.click('#bn-matchday');
  await page.waitForTimeout(14000);
  const { PNG } = await import('pngjs');
  const shot = async () => PNG.sync.read(await page.screenshot({ clip: { x: 320, y: 70, width: 1060, height: 780 } }));
  const changed = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 16) { if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) n++; } return n / (a.data.length / 16); };
  const block = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('[data-sec="banners"] .mds-field, [data-sec="banners"] label')].find((l) => /First block/.test(l.textContent));
    return (f?.querySelector('select') ?? f?.parentElement?.querySelector('select'))?.value ?? null;
  });
  const a0 = await shot();
  const b0 = await block();
  // Across the middle of the picture, which is the banner.
  await page.mouse.move(700, 450);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(700 + i * 15, 450 + i * 3);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const a1 = await shot();
  check('a drag across the banner looks around', changed(a0, a1) > 0.2, changed(a0, a1).toFixed(2));
  check('and leaves the banner where it was', (await block()) === b0, `${b0} → ${await block()}`);
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(800);
  check('the wheel zooms', changed(a1, await shot()) > 0.1);
  // Moving the banner is still there, one deliberate click away: pick it out,
  // then drag it.
  // Clicked from inside the page: a real click waits for the WebGL frame the
  // software renderer is still drawing, and times out here.
  await page.evaluate(() => [...document.querySelectorAll('[data-sec="banners"] button')].find((b) => b.textContent.trim() === 'Look at it')?.click());
  await page.waitForTimeout(1500);
  await page.mouse.click(700, 450);
  await page.waitForTimeout(500);
  await page.mouse.move(700, 450);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(700 + i * 22, 450);
  await page.mouse.up();
  await page.waitForTimeout(900);
  check('a banner picked out with a click drags along the stand', (await block()) !== b0, `${b0} → ${await block()}`);
  const hint = await page.evaluate(() => document.querySelector('.mds-hint')?.textContent || '');
  check('the panel says how to move a banner now', /pick it out/.test(hint), hint);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// The showcase: designs whose banners come with them.

console.log('\n— a design with banners, opened from the community —');
{
  const feed = await (await fetch(B + '/api/gallery?limit=3')).json();
  const kop = feed.find((d) => (d.tags || []).includes('banners') && /two banners/.test(d.title));
  check('the community opens on the banner showcase', feed.length === 3 && feed.every((d) => (d.tags || []).includes('banners')), feed.map((d) => d.title).join(' | '));
  if (kop) {
    const { ctx, page, errs } = await openApp(1400, 880, 'en');
    await page.goto(`${B}/app?design=${kop.id}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.click('#view-banner');
    await page.waitForTimeout(1200);
    const rows = await page.$$eval('#bn-list .bn-li .bn-li-meta', (m) => m.map((x) => x.textContent));
    check('its banners open with it', rows.length === 2 && rows.some((r) => /Stand banner/.test(r)) && rows.some((r) => /Hanging banner/.test(r)), rows.join(' | '));
    const mesh = await page.evaluate(() => document.getElementById('bn-material')?.value);
    check('as they were made: the stand banner is see-through mesh', mesh === 'mesh', mesh);
    check('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();

    const c2 = await browser.newContext({ viewport: { width: 1400, height: 880 } });
    const p2 = await c2.newPage();
    await p2.addInitScript(() => { localStorage.setItem('tifo_lang_v1', 'en'); localStorage.setItem('tifo_consent_v1', 'essential'); });
    await p2.goto(B + '/community', { waitUntil: 'networkidle', timeout: 60000 });
    await p2.waitForTimeout(2000);
    const badge = await p2.$$eval('.tifo-card', (cs) => cs.slice(0, 3).map((c) => !!c.querySelector('.badge.banners')));
    check('their cards say "With banners"', badge.length === 3 && badge.every(Boolean));
    await p2.click('.tifo-card .card-title');
    // The bowl is built in a worker and the banners follow it: waited for,
    // not slept on, because under load that is well past ten seconds.
    await p2.waitForSelector('#cam-bar .cam-banner', { timeout: 45000 }).catch(() => null);
    const cams = await p2.$$eval('#cam-bar .cam-banner', (bs) => bs.length);
    check('the preview offers a camera on each banner', cams >= 1, `${cams}`);
    await c2.close();
  }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
