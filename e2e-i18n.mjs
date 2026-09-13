/**
 * Arabic coverage guard.
 *
 * The site drifted back into English because nothing failed when a string
 * shipped without a translation: the editor's whole runtime UI layer had no
 * t() call in it, and index.html's tooltips and dropdowns had no data-i18n.
 * Nobody notices until an Arabic-speaking user files a bug.
 *
 * So this loads every page and opens every modal with tifo_lang_v1=ar and
 * fails on any text that is still English. "Still English" means the string is
 * predominantly Latin script — a translated string that happens to contain
 * "PDF" or "tifomaker.org" is fine, a string that is entirely Latin words is
 * not — minus an explicit allow-list of things that stay in English on purpose.
 */
import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());

const AR_LS = [
  { name: 'tifo_lang_v1', value: 'ar' },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
];
const state = (extra = []) => ({ cookies: [], origins: [{ origin: B, localStorage: [...AR_LS, ...extra] }] });

/**
 * Kept in English deliberately: the brand, file formats, units, hex colours,
 * the language toggle (it names the OTHER language), single-letter keyboard
 * hints and avatar initials, and the social handles.
 */
const ALLOW = new Set([
  'TIFO', 'MAKER', 'TIFOMAKER', 'tifomaker.org', 'English', 'العربية',
  'PNG', 'JPG', 'SVG', 'PDF', 'CSV', 'GIF', 'WebM', 'MP4', 'QR', 'AI', 'RTL',
  'CSV + PDF', '@OS99GameDev', '@OSNGameDev', 'Zaunfahne',
]);
const ALLOW_RE = [
  /^[^\p{L}]*$/u,                         // digits, punctuation, symbols only
  /^[A-Za-z]$/,                            // single letters: kbd hints, avatar initial
  /^\.?[a-z0-9]{2,5}$/,                    // file extensions and short codes
  /^\d[\d.,]*\s*(k\+?|px|ms|s|MB|KB)?$/i,  // measurements
  /^#[0-9a-fA-F]{3,8}$/,                   // hex colours
  /^[\w.+-]+@[\w.-]+$/,                    // emails
  /^https?:\/\//,
];
const AR_SCRIPT = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;

function suspect(s) {
  const t = s.trim();
  if (!t || ALLOW.has(t)) return false;
  if (ALLOW_RE.some((r) => r.test(t))) return false;
  if (AR_SCRIPT.test(t)) return false;                  // translated; Latin tokens inside are fine
  const words = t.match(LATIN_WORD);
  return !!words && words.length >= 1;
}

function scrapePage() {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const s = (n.textContent || '').trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE)$/.test(el.tagName)) continue;
    if (el.closest('[hidden],[inert],[lang="en"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    out.push({ text: s.slice(0, 120), where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (el.closest('[hidden],[inert],[lang="en"]') || el.hasAttribute('hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) out.push({ text: v.trim().slice(0, 120), where: `@${a} ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` });
    }
  }
  for (const sel of document.querySelectorAll('select')) {
    if (sel.closest('[hidden]')) continue;
    const r = sel.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    for (const o of sel.options) if (o.textContent.trim()) out.push({ text: o.textContent.trim().slice(0, 120), where: `option ${sel.id ? '#' + sel.id : ''}` });
  }
  return out;
}

let pass = 0, fail = 0;
const report = (surface, rows) => {
  const bad = [];
  const seen = new Set();
  for (const r of rows) {
    if (!suspect(r.text)) continue;
    const k = r.text + r.where;
    if (seen.has(k)) continue;
    seen.add(k);
    bad.push(r);
  }
  if (bad.length === 0) { pass++; console.log(`  PASS  ${surface}`); return; }
  fail++;
  console.log(`  FAIL  ${surface} — ${bad.length} untranslated`);
  for (const b of bad.slice(0, 12)) console.log(`          [${b.where}] ${b.text}`);
  if (bad.length > 12) console.log(`          … and ${bad.length - 12} more`);
};

async function page(path, { width = 1440, height = 960, wait = 2500, extraLs = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, storageState: state(extraLs) });
  const p = await ctx.newPage();
  p.on('pageerror', () => {});
  await p.goto(B + path, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(wait);
  return [ctx, p];
}

console.log('\n— pages in Arabic —');
for (const [path, name] of [['/', 'landing'], ['/community', 'community'], ['/clubs', 'clubs'],
                            ['/legal', 'legal'], ['/reset', 'reset'], ['/d/nope', 'shared viewer (phone)']]) {
  const [ctx, p] = await page(path, path === '/d/nope' ? { width: 390, height: 844, wait: 4000 } : {});
  report(name, await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— the phone gate —');
{
  const [ctx, p] = await page('/app', { width: 360, height: 680, wait: 1500 });
  report('phone gate', await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— the editor and its panels —');
{
  const [ctx, p] = await page('/app', { wait: 6000 });
  await p.evaluate(() => { document.querySelector('.ob-skip')?.click(); });
  await p.waitForTimeout(1200);
  report('editor', await p.evaluate(scrapePage));
  const sections = await p.evaluate(() => [...document.querySelectorAll('#panel .panel-section')].map((s) => s.id).filter(Boolean));
  for (const id of sections) {
    await p.evaluate((i) => { const el = document.getElementById(i); if (el) { el.classList.remove('ctx-hidden'); el.hidden = false; } }, id);
  }
  await p.waitForTimeout(600);
  report('editor panels', await p.evaluate(scrapePage));
  for (const [sel, name] of [['#rail-stadium', 'stadium panel'], ['#rail-ai', 'AI panel'],
                             ['#rail-anim', 'animation panel'], ['#banner-studio-btn', 'Banner Studio'],
                             ['#gallery', 'gallery modal'], ['#signin', 'auth modal']]) {
    await p.click(sel, { timeout: 4000, force: true }).catch(() => {});
    await p.waitForTimeout(1500);
    report(name, await p.evaluate(scrapePage));
    await p.keyboard.press('Escape').catch(() => {});
    await p.evaluate(() => document.querySelectorAll('.auth-backdrop,.feed-backdrop,.bstudio-overlay').forEach((e) => e.remove()));
    await p.waitForTimeout(400);
  }
  await ctx.close();
}

console.log('\n— first run (onboarding + cookie banner) —');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [{ name: 'tifo_lang_v1', value: 'ar' }] }] } });
  const p = await ctx.newPage();
  p.on('pageerror', () => {});
  await p.goto(B + '/app', { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(5000);
  report('onboarding + consent', await p.evaluate(scrapePage));
  await ctx.close();
}

console.log(`\n  ${pass} surfaces clean, ${fail} with untranslated text`);
await browser.close();
process.exit(fail ? 1 : 0);
