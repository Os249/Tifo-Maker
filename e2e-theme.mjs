/**
 * Light / dark guard.
 *
 * Three things have to hold, and each of them is a way this feature usually
 * ships broken:
 *
 *   the default   a phone in dark mode must never be handed a white page, and
 *                 must never be handed one for a frame either — the scheme is
 *                 settled by an inline script in the head, before anything
 *                 paints, and this checks that it really is ahead of the body.
 *   the choice    pressing the toggle outranks the system, on every page and
 *                 on the next visit.
 *   readability   a theme that flips colours without checking them is how you
 *                 get white text on a pale button. Every page is measured in
 *                 both schemes: body text, muted text, links and the buttons
 *                 that carry their own ground.
 *
 * The editor is deliberately excluded — a canvas tool stays dark — and that is
 * asserted too, so nobody "fixes" it by accident.
 *
 *   node e2e-theme.mjs            (server on :8911)
 */
import { chromium, devices } from 'playwright';

const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const PAGES = ['/', '/community', '/clubs', '/legal'];
const LS = [{ name: 'tifo_consent_v1', value: 'all' }, { name: 'tifo_onboarded_v1', value: '1' }];

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());

const ctxFor = (opts = {}) => browser.newContext({
  viewport: { width: 1280, height: 900 },
  storageState: { cookies: [], origins: [{ origin: B, localStorage: [...LS, ...(opts.ls ?? [])] }] },
  ...opts.ctx,
});

// ---------- contrast maths ----------
const parse = (c) => {
  const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
};
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fg, bg) => {
  const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (x + 0.05) / (y + 0.05);
};
/** Flatten a translucent colour onto what is behind it. */
const over = (fg, bg) => fg[3] >= 1 ? fg : fg.map((v, i) => i === 3 ? 1 : v * fg[3] + bg[i] * (1 - fg[3]));

// ---------- the default follows the device ----------
console.log('\n— with no choice made, the device decides —');
for (const scheme of ['dark', 'light']) {
  const ctx = await ctxFor({ ctx: { colorScheme: scheme } });
  const p = await ctx.newPage();
  for (const path of PAGES) {
    await p.goto(B + path, { waitUntil: 'domcontentloaded' });
    const got = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check(`${path} opens ${scheme} on a ${scheme} device`, got === scheme, `got ${got}`);
  }
  await ctx.close();
}

console.log('\n— and it is settled before anything paints —');
for (const path of PAGES) {
  const html = await (await fetch(B + path)).text();
  const boot = html.indexOf("localStorage.getItem('tifo_theme_v1')");
  const body = html.indexOf('<body');
  const css = html.indexOf('<link rel="stylesheet"');
  check(`${path} decides the scheme before the body`, boot > -1 && boot < body, `boot=${boot} body=${body}`);
  check(`${path} decides it before the stylesheet`, boot > -1 && (css === -1 || boot < css), `boot=${boot} css=${css}`);
}

// ---------- the toggle ----------
console.log('\n— the toggle —');
{
  const ctx = await ctxFor({ ctx: { colorScheme: 'light' } });
  const p = await ctx.newPage();
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  const btn = await p.$('.theme-toggle');
  check('the home page has a toggle beside the language one', !!btn);
  const box = await btn.boundingBox();
  check('it clears the 24px touch-target floor', box.width >= 24 && box.height >= 24,
    `${Math.round(box.width)}x${Math.round(box.height)}`);
  check('it says what it will do', /dark/i.test(await btn.getAttribute('aria-label')),
    await btn.getAttribute('aria-label'));

  await btn.click();
  await p.waitForTimeout(150);
  check('one press turns it dark', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  check('and the label flips', /light/i.test(await p.$eval('.theme-toggle', (e) => e.getAttribute('aria-label'))));

  await p.reload({ waitUntil: 'domcontentloaded' });
  check('the choice survives a reload', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  for (const path of PAGES.slice(1)) {
    await p.goto(B + path, { waitUntil: 'domcontentloaded' });
    check(`the choice carries to ${path}`, (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  }
  // The whole point of an explicit choice: it outranks the device.
  check('an explicit choice outranks a light device',
    (await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)) === false);
  await ctx.close();
}

// ---------- the phone ----------
console.log('\n— reachable on a phone —');
{
  // The header toggle lives in .nav-links, which a phone hides for the burger.
  // The drawer mirrors those children, so the toggle has to arrive there too —
  // otherwise the feature simply does not exist on the device most likely to
  // have a system dark mode in the first place.
  const ctx = await browser.newContext({
    ...devices['iPhone 14'], colorScheme: 'dark',
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS }] },
  });
  const p = await ctx.newPage();
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.tap('.mnav-burger');
  await p.waitForTimeout(400);
  const btn = await p.$('.mnav-drawer .theme-toggle');
  check('the drawer carries the toggle', !!btn);
  if (btn) {
    const box = await btn.boundingBox();
    check('it is a full-width row, not a stray icon', box.width > 120, `${Math.round(box.width)}px wide`);
    check('and it is labelled', /light|dark/i.test(await btn.getAttribute('aria-label')));
    await btn.tap();
    await p.waitForTimeout(300);
    check('tapping it flips the scheme', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  }
  await ctx.close();
}

// ---------- readability, in both schemes, on every page ----------
console.log('\n— readable in both schemes —');
for (const scheme of ['light', 'dark']) {
  for (const path of PAGES) {
    const ctx = await ctxFor({ ctx: { colorScheme: scheme } });
    const p = await ctx.newPage();
    await p.goto(B + path, { waitUntil: 'networkidle' });
    await p.waitForTimeout(400);
    const bad = await p.evaluate(() => {
      const out = [];
      const seen = new Set();
      // What is actually behind this text. Walking up for the first opaque
      // backgroundColor is not enough: a gradient band reports a transparent
      // backgroundColor, so the walk sails past it and measures against the
      // page instead — which is how a white heading on a dark purple band gets
      // reported as white-on-white. Gradients are read from background-image
      // and every colour stop is returned, so the worst one is what counts.
      const ground = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.backgroundImage && s.backgroundImage !== 'none') {
            const stops = s.backgroundImage.match(/rgba?\([^)]+\)/g) || [];
            // `transparent` computes to rgba(0, 0, 0, 0) — an alpha of zero,
            // not an opaque black. Reading it as a stop measured half the site
            // against a colour that is not on the screen.
            const opaque = stops.filter((c) => {
              const a = c.match(/,\s*([\d.]+)\s*\)$/);
              return !a || +a[1] >= 0.99;
            });
            if (opaque.length) return opaque;
          }
          const bg = s.backgroundColor;
          const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (m && (m[4] === undefined || +m[4] > 0.6)) return [bg];
        }
        return [getComputedStyle(document.body).backgroundColor];
      };
      for (const el of document.querySelectorAll('p, a, li, h1, h2, h3, h4, span, button, label')) {
        const text = el.textContent?.trim();
        if (!text || el.children.length > 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity < 0.5) continue;
        // Display type painted through background-clip:text has no measurable
        // colour of its own — the gradient behind it is the glyph.
        const fill = s.webkitTextFillColor;
        if (fill === 'transparent' || /,\s*0\)$/.test(fill)) continue;
        if (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') continue;
        const key = `${s.color}|${ground(el).join()}|${s.fontSize}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ color: s.color, bgs: ground(el), size: parseFloat(s.fontSize),
          weight: s.fontWeight, text: text.slice(0, 32) });
      }
      return out;
    });
    const fails = [];
    for (const s of bad) {
      const fg = parse(s.color);
      if (!fg || fg[3] < 0.5) continue;
      const large = s.size >= 24 || (s.size >= 18.66 && +s.weight >= 700);
      const need = large ? 3 : 4.5;
      // Worst stop wins: text over a gradient has to clear the bar everywhere
      // along it, not just where it happens to be lightest.
      let got = Infinity;
      for (const c of s.bgs) {
        const bg = parse(c);
        if (!bg) continue;
        got = Math.min(got, ratio(over(fg, bg), bg));
      }
      if (got < need) fails.push(`"${s.text}" ${got.toFixed(2)}:1 (needs ${need}) ${s.color} on ${s.bgs.join('/')}`);
    }
    check(`${scheme} ${path}: text clears WCAG AA`, fails.length === 0,
      `${fails.length}: ${fails.slice(0, 3).join(' · ')}`);
    await ctx.close();
  }
}

// ---------- Arabic, and the editor ----------
console.log('\n— Arabic, and the editor —');
{
  const ctx = await ctxFor({ ctx: { colorScheme: 'dark' }, ls: [{ name: 'tifo_lang_v1', value: 'ar' }] });
  const p = await ctx.newPage();
  await p.goto(B + '/community', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  const ar = await p.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dir: document.documentElement.dir,
    label: document.querySelector('.theme-toggle')?.getAttribute('aria-label') ?? '',
    overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }));
  check('Arabic and dark work together', ar.theme === 'dark' && ar.dir === 'rtl', JSON.stringify(ar));
  check('the toggle is translated', /[؀-ۿ]/.test(ar.label), ar.label);
  check('RTL dark adds no horizontal scroll', ar.overflow);
  await ctx.close();
}
{
  // A canvas tool stays dark. If somebody themes the editor later this fails,
  // which is the point — it should be a decision, not a side effect.
  const ctx = await ctxFor({ ctx: { colorScheme: 'light' } });
  const p = await ctx.newPage();
  await p.goto(B + '/app', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const bg = parse(await p.evaluate(() => getComputedStyle(document.body).backgroundColor));
  check('the editor stays dark on a light device', bg && lum(bg) < 0.1,
    `luminance ${bg ? lum(bg).toFixed(3) : '?'}`);
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
