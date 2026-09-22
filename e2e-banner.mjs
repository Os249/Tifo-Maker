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
async function openApp(width, height, lang) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: lang === 'ar' ? 'ar' : 'en-US' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('tifo_lang_v1', l);
      localStorage.setItem('tifo_onboarded_v1', '1');
      localStorage.setItem('tifo_consent_v1', 'essential');
      localStorage.setItem('tifo_draw_hint_v1', '1');
    } catch { /* storage off */ }
  }, lang);
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

// ---------------------------------------------------------------------------

console.log('\n— desktop: the fourth view exists and draws —');
{
  const { ctx, page, errs } = await openApp(1500, 900, 'en');
  check('Banner sits in the view switcher', !!(await page.$('#view-banner')));
  await page.click('#view-banner');
  await page.waitForTimeout(1000);

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
  await page.click('#view-banner');
  await page.waitForTimeout(900);
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
  await page.click('#view-banner');
  await page.waitForTimeout(900);
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
  const hidden = await page.evaluate(() => {
    const raw = localStorage.getItem('tifo_banners_v1');
    if (!raw) return false;
    const m = JSON.parse(raw);
    for (const b of m.banners ?? []) b.visible = false;
    localStorage.setItem('tifo_banners_v1', JSON.stringify(m));
    return (m.banners ?? []).length > 0;
  });
  check('a banner was stored to hide', hidden);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
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
  await page.evaluate(() => {
    const raw = localStorage.getItem('tifo_banners_v1');
    const m = JSON.parse(raw);
    for (const b of m.banners ?? []) { b.visible = true; b.bg = '#ff00ff'; b.material = 'solid'; }
    localStorage.setItem('tifo_banners_v1', JSON.stringify(m));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('#view-3d');
  await page.waitForTimeout(9000);
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

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
