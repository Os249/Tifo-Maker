/**
 * The editor's width floor.
 *
 * This suite used to assert a desktop-only gate at 900px: phones had been let
 * into a layout built for 1400 and hit walls it could not serve, which is what
 * the two live bug reports were. Phones now have their own front end
 * (ui/mobileShell.ts), so the gate is no longer a policy about phones — it is a
 * floor for viewports too narrow for ANY layout, and the checks below hold the
 * new line: 320px and up opens the editor, narrower than that is turned away,
 * and the escape hatches still work.
 */
import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

async function probe(width, height, path = '/app', opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  // Which chunks the browser actually asks for is the point of the gate loading
  // before the editor: a phone should not download Pixi, Three and the toolbar
  // to be told to come back on a laptop.
  const scripts = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url().split('/').pop()); });
  await page.goto(B + path, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    gate: !!document.querySelector('.gate-root'),
    h1: document.querySelector('.gate-title')?.textContent || '',
    canvas: !!document.querySelector('#canvas-host canvas'),
    header: !!document.querySelector('body > header'),
    viewer: !!document.querySelector('.viewer-root'),
    links: [...document.querySelectorAll('.gate-btn')].map((a) => a.getAttribute('href')),
    dir: document.documentElement.getAttribute('dir'),
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    small: [...document.querySelectorAll('.gate-root a, .gate-root button')]
      .map((e) => { const b = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 20), w: Math.round(b.width), h: Math.round(b.height) }; })
      .filter((x) => x.h < 24 || x.w < 24),
  }));
  await ctx.close();
  return { ...r, errs, scripts };
}

console.log('\n— below the floor, the gate still turns people away —');
for (const [w, h, label] of [[280, 600, 'sub-320 window'], [300, 640, 'one under the line']]) {
  const r = await probe(w, h);
  check(`${label}: gate shown, editor never mounts`, r.gate && !r.canvas && !r.header, r.gate ? `"${r.h1}"` : `canvas=${r.canvas}`);
  check(`${label}: no horizontal scroll`, !r.hscroll);
  check(`${label}: no page errors`, r.errs.length === 0, r.errs.join(' | '));
  check(`${label}: offers community + home`, JSON.stringify(r.links) === '["/community","/"]', JSON.stringify(r.links));
  const heavy = r.scripts.filter((s) => /^(editor|toolbar|preview3d|overlay)-/.test(s));
  check(`${label}: editor/toolbar/three never downloaded`, heavy.length === 0, heavy.join(',') || '0 heavy chunks');
}

console.log('\n— every real phone now gets the editor —');
for (const [w, h, label] of [[320, 568, 'iPhone SE'], [360, 680, 'Android 360'], [390, 844, 'iPhone 390'],
                             [430, 932, 'Pro Max'], [768, 1024, 'iPad'], [900, 900, 'small laptop'], [1400, 900, 'desktop']]) {
  const r = await probe(w, h);
  check(`${label} ${w}x${h}: editor opens, no gate`, !r.gate && r.header, `canvas=${r.canvas}`);
}

console.log('\n— the escape hatches —');
let r = await probe(300, 640, '/app?editor=1');
check('?editor=1 still opens the editor below the floor', !r.gate && r.header);
r = await probe(300, 640, '/d/does-not-exist');
check('a shared link below the floor still gets the read-only viewer', r.viewer && !r.gate, `viewer=${r.viewer}`);

console.log('\n— Arabic (both bug reports were written in Arabic) —');
r = await probe(300, 640, '/app', {
  storageState: { cookies: [], origins: [{ origin: B, localStorage: [{ name: 'tifo_lang_v1', value: 'ar' }] }] },
});
check('the gate renders RTL with Arabic copy', r.dir === 'rtl' && /[؀-ۿ]/.test(r.h1), `dir=${r.dir} "${r.h1}"`);
check('Arabic: no horizontal scroll', !r.hscroll);

console.log('\n— resizing —');
{
  const ctx = await browser.newContext({ viewport: { width: 300, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(B + '/app', { waitUntil: 'networkidle' });
  const gated = await page.evaluate(() => !!document.querySelector('.gate-root'));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(4000);
  const widened = await page.evaluate(() => ({ gate: !!document.querySelector('.gate-root'), header: !!document.querySelector('body > header') }));
  check('widening past the floor hands over the editor', gated && !widened.gate && widened.header);

  // The reverse must NOT happen: tearing down a running editor because someone
  // dragged the window narrow would destroy their unsaved work. Entry-only.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(B + '/app', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.setViewportSize({ width: 300, height: 700 });
  await page.waitForTimeout(3000);
  const narrowed = await page.evaluate(() => ({ gate: !!document.querySelector('.gate-root'), header: !!document.querySelector('body > header') }));
  check('narrowing an OPEN editor never destroys the session', !narrowed.gate && narrowed.header);
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
