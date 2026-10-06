/**
 * Growth: tagged links, Post it, and phones. Built after the 29 Sep 2026 review.
 *
 *   npm run test:growth      (needs `npm run build` first: it serves dist/)
 *
 *   1. Phones get a still stadium, not the 3D engine; thumbnails wait for the
 *      scroll; Arabic browsers get Arabic; tags leave the address bar.
 *   2. A tagged visit is counted by name, a shared-link visit under "Shared by
 *      visitors", and "Links opened" counts it (it read 0 forever before).
 *   3. First run: Start from your club draws the bowl, opens the stadium, and
 *      the one-time "Post it?" card offers the picture, whose links are tagged.
 *   4. Publishing opens the share window with tagged links.
 *   5. The admin link builder makes the link you asked for.
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8917;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e growth admin password 2026';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', AI_ADMIN_PASSWORD: PW, ADMIN_USERNAMES: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up on ' + B + '\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const api = async (path, token, body, method = 'POST', headers = {}) => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const unlock = (await api('/api/ai/unlock', null, { password: PW })).token;
const admin = (path) => api(path, null, undefined, 'GET', { 'x-ai-unlock': unlock });

// Headless Chrome says so in its user agent, and the visit log files that under
// bots, where it would be invisible to every number this suite reads.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: IPHONE };
const WIDE = { viewport: { width: 1400, height: 900 }, userAgent: DESKTOP };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const open = async (opts, ls = []) => {
  const ctx = await browser.newContext({ locale: 'en-US', ...opts });
  await ctx.addInitScript((pairs) => { try { for (const [k, v] of pairs) localStorage.setItem(k, v); } catch { /* */ } }, [['tifo_consent_v1', 'all'], ...ls]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return p;
};
const until = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------
console.log('\n— 1. the home page on a phone —');
{
  const p = await open(PHONE);
  const asked = [];
  p.on('request', (r) => asked.push(r.url()));
  await p.goto(`${B}/?utm_source=x&utm_medium=post&utm_campaign=reveal-1`, { waitUntil: 'load' });
  const still = await until(p, () => { const i = document.querySelector('#hero-3d img.hero-still'); return !!i && i.complete && i.naturalWidth > 0; }, null, 20000);
  await p.waitForTimeout(2500);
  check('the hero is the still picture', still);
  check('and the 3D engine was never downloaded', !asked.some((u) => /preview3d-.*\.js/.test(u)), asked.filter((u) => /preview3d/.test(u)).join(' '));
  check('the tags have left the address bar', await p.evaluate(() => !/utm_/.test(location.search)), await p.evaluate(() => location.href));
  check('the gallery is not fetched before anyone scrolls to it', !asked.some((u) => u.includes('/api/gallery')));
  const cta = await p.evaluate(() => { const a = document.querySelector('.cta-row a.btn'); return a ? Math.round(a.getBoundingClientRect().bottom) : 9999; });
  check('"Start designing" is on the first screen, above the cookie bar', cta < 844 * 0.62, `bottom at ${cta}px of 844`);
  await p.evaluate(() => document.getElementById('showcase')?.scrollIntoView());
  const fetched = await until(p, () => performance.getEntriesByType('resource').some((e) => e.name.includes('/api/gallery')), null, 15000);
  check('scrolling there fetches it', fetched);
  const tapped = await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#hero-3d img.hero-still')?.click(); return true; });
  const live = tapped && await until(p, () => !!document.querySelector('#hero-3d canvas'), null, 60000);
  check('a tap on the still starts the live stadium', live);
  check('no horizontal scroll on a phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.context().close();
}
{
  const p = await open(WIDE);
  const asked = [];
  p.on('request', (r) => asked.push(r.url()));
  await p.goto(`${B}/`, { waitUntil: 'load' });
  const live = await until(p, () => !!document.querySelector('#hero-3d canvas'), null, 60000);
  check('a desktop still gets the live 3D stadium', live && asked.some((u) => /preview3d-.*\.js/.test(u)));
  await p.context().close();
}
{
  const ar = await open({ ...PHONE, locale: 'ar-SA' });
  await ar.goto(`${B}/`, { waitUntil: 'load' });
  const a = await ar.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, cta: document.querySelector('.cta-row a.btn')?.textContent?.trim() }));
  check('an Arabic browser gets Arabic, right to left', a.dir === 'rtl' && a.lang === 'ar' && /[؀-ۿ]/.test(a.cta ?? ''), JSON.stringify(a));
  await ar.context().close();
  const chose = await open({ ...PHONE, locale: 'ar-SA' }, [['tifo_lang_v1', 'en']]);
  await chose.goto(`${B}/`, { waitUntil: 'load' });
  check('but a language picked with the toggle wins', await chose.evaluate(() => document.documentElement.dir === 'ltr' && document.documentElement.lang === 'en'));
  await chose.context().close();
  const en = await open({ ...PHONE, locale: 'en-GB' });
  await en.goto(`${B}/`, { waitUntil: 'load' });
  check('and an English browser keeps English', await en.evaluate(() => document.documentElement.lang === 'en'));
  await en.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 2. what the visit log makes of tagged links —');
{
  const p = await open(PHONE);
  await p.goto(`${B}/?utm_source=whatsapp&utm_medium=share&utm_campaign=tifo`, { waitUntil: 'load' });
  await p.waitForTimeout(600);
  await p.context().close();
  const tr = await admin('/api/admin/traffic?days=7');
  check('your tagged link shows up by name', (tr.campaigns ?? []).some((c) => c.key === 'x / reveal-1'), JSON.stringify(tr.campaigns));
  check('a link passed on from a share button is "Shared by visitors", by platform', (tr.shared ?? []).some((c) => c.key === 'whatsapp'), JSON.stringify(tr.shared));
  check('and it is a source of its own', (tr.sources ?? []).some((s) => s.key === 'shared'), JSON.stringify(tr.sources));
  const sh = await admin('/api/admin/shares?days=7');
  check('"Links opened" counts it (it read 0 forever before)', sh.opens >= 1 && (sh.platforms ?? []).some((x) => x.key === 'whatsapp' && x.opens >= 1), JSON.stringify({ opens: sh.opens, platforms: sh.platforms }));
}

// ---------------------------------------------------------------------------
console.log('\n— 3. first run: start from your club, then post it —');
for (const [label, opts] of [['desktop', WIDE], ['phone', PHONE]]) {
  const p = await open(opts, [['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v1', '1']]);
  await p.goto(`${B}/app?new=1&e2e`, { waitUntil: 'domcontentloaded' });
  const dialog = await until(p, () => document.querySelectorAll('.ob-club-chip').length >= 8, null, 90000);
  check(`${label}: the welcome dialog opens on "Start from your club"`, dialog);
  const first = await p.evaluate(() => document.activeElement?.classList.contains('ob-club-chip'));
  check(`${label}: and a club has the focus`, !!first);
  await p.evaluate(() => [...document.querySelectorAll('.ob-club-chip')].find((b) => b.dataset.club === 'Al Hilal')?.click());
  const inStadium = await until(p, () => { const h = document.getElementById('preview-host'); return !!h && !h.hidden && !!h.querySelector('canvas'); }, null, 90000);
  check(`${label}: one tap draws the bowl and opens the stadium`, inStadium);
  await until(p, () => /[?&]local=/.test(location.search), null, 30000);
  const design = await p.evaluate(() => {
    const { store } = window.__tifo;
    let painted = 0;
    for (let i = 0; i < store.cells.length; i++) if (store.cells[i]) painted++;
    return { pal: store.palette.join(' ').toLowerCase(), painted: painted / store.cells.length, local: /[?&]local=/.test(location.search) };
  });
  check(`${label}: in the club's colours, kept as a project`, design.pal.includes('#0033a0') && design.painted > 0.5 && design.local, JSON.stringify(design).slice(0, 200));
  const nudge = await until(p, () => !!document.querySelector('.pm-nudge'), null, 15000);
  check(`${label}: the one-time "Post it?" card appears`, nudge);
  if (label === 'phone') {
    check('phone: Post it sits beside Match Day', await p.evaluate(() => { const b = document.querySelector('.m-md .m-post'); return !!b && b.getBoundingClientRect().width > 0; }));
    const clash = await p.evaluate(() => {
      const r = (el) => el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null;
      const a = r(document.querySelector('.m-md')); const z = r(document.querySelector('.zoom-pill'));
      return !!a && !!z && a.right > z.left && a.left < z.right && a.bottom > z.top && a.top < z.bottom;
    });
    check('phone: and nothing on the stadium view overlaps it', !clash);
  }
  await p.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
  await p.evaluate(() => document.querySelector('.pm-nudge .pm-main')?.click());
  const pic = await until(p, () => { const i = document.querySelector('.pm-overlay img.pm-pic'); return !!i && i.complete && i.naturalWidth === 1080 && i.naturalHeight === 1350; }, null, 60000);
  check(`${label}: the picture is made, 1080×1350`, pic);
  const drawn = pic && await p.evaluate(() => {
    const img = document.querySelector('.pm-overlay img.pm-pic');
    const c = document.createElement('canvas'); c.width = 108; c.height = 135;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 108, 135);
    const d = g.getImageData(0, 0, 108, 108).data; let bright = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 180) bright++;
    return bright / (108 * 108);
  });
  check(`${label}: and it shows the stadium, not a blank`, drawn > 0.04, String(drawn));
  const buttons = await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b, .pm-overlay .pm-main')].map((b) => b.textContent.trim()));
  check(`${label}: Download, Post on X, WhatsApp and Copy link are offered`, ['Download', 'Post on X', 'WhatsApp', 'Copy link'].every((w) => buttons.some((b) => b.includes(w))), buttons.join(' | '));
  await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b')].find((b) => b.textContent.includes('Post on X'))?.click());
  const xLink = await p.evaluate(() => window.__opened[0] ?? '');
  const inner = decodeURIComponent(new URL(xLink || 'https://x.invalid/').searchParams.get('url') ?? '');
  check(`${label}: the X link is tagged as a shared post`, /utm_source=x&utm_medium=share&utm_campaign=post/.test(inner), inner);
  if (label === 'desktop') {
    const dl = p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b')].find((b) => b.textContent.includes('Download'))?.click());
    const file = await dl;
    check('desktop: Download saves a PNG named after the tifo', !!file && /-tifomaker\.png$/.test(file.suggestedFilename()), file?.suggestedFilename());
  }
  await p.keyboard.press('Escape');
  check(`${label}: Escape closes it`, await until(p, () => !document.querySelector('.pm-overlay'), null, 5000));
  // Once per browser: back in 3D later, no second card.
  await p.evaluate(async () => { document.getElementById('view-2d')?.click(); await new Promise((r) => setTimeout(r, 300)); document.getElementById('view-3d')?.click(); });
  await p.waitForTimeout(2600);
  check(`${label}: the card is shown only once`, await p.evaluate(() => !document.querySelector('.pm-nudge')));
  await p.context().close();
}
{
  const funnel = await admin('/api/funnel?days=7');
  const n = (k) => (funnel.steps ?? []).find((s) => s.name === k)?.sessions ?? 0;
  check('the funnel counts "Opened Post it" and "Shared it"', n('post_opened') >= 2 && n('shared') >= 2, JSON.stringify({ post_opened: n('post_opened'), shared: n('shared') }));
}

// ---------------------------------------------------------------------------
console.log('\n— 4. publishing opens the share window, with tagged links —');
{
  const stamp = Date.now().toString(36).slice(-5);
  const reg = await api('/api/auth/register', null, { username: `pub${stamp}`, password: 'harbor-kite-moss-31', email: `pub${stamp}@example.test`, acceptedVersion: 'test' });
  const p = await open(WIDE, [['tifo_token_v1', reg.token], ['tifo_onboarded_v1', '1'], ['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v1', '1'], ['tifo_post_nudge_v1', '1']]);
  await p.goto(`${B}/app?new=1`, { waitUntil: 'domcontentloaded' });
  await until(p, () => /[?&]project=/.test(location.search), null, 90000);
  await p.evaluate(() => document.getElementById('publish-design')?.click());
  const dlg = await until(p, () => !!document.querySelector('.pub-go'), null, 30000);
  if (dlg) await p.evaluate(() => document.querySelector('.pub-go')?.click());
  const modal = await until(p, () => !!document.querySelector('.sm-overlay .sm-link'), null, 30000);
  check('the share window opens as soon as it is published', dlg && modal);
  const link = await p.evaluate(() => document.querySelector('.sm-overlay .sm-link')?.value ?? '');
  check('its link is the tifo page, tagged', /\/t\/[0-9a-f-]{36}\?utm_source=copy&utm_medium=share&utm_campaign=tifo$/.test(link), link);
  await p.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 5. the admin link builder —');
{
  const p = await open({ viewport: { width: 1360, height: 1000 } });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="traffic"]');
  const has = await until(p, () => !!document.getElementById('lb-url'), null, 15000);
  check('Where from has the link builder', has);
  await p.selectOption('#lb-platform', 'tiktok');
  await p.selectOption('#lb-spot', 'bio');
  await p.selectOption('#lb-page', '/projects?new=1');
  await p.fill('#lb-name', 'Reveal Video 1');
  const url = await p.inputValue('#lb-url');
  check('it builds the link asked for', url === `${B}/projects?new=1&utm_source=tiktok&utm_medium=bio&utm_campaign=reveal-video-1`, url);
  const shared = await p.evaluate(() => [...document.querySelectorAll('.card .lt')].some((e) => e.textContent === 'Shared by visitors'));
  check('and "Shared by visitors" has its own panel', shared);
  const badge = await p.evaluate(() => document.querySelector('.tab[data-tab="traffic"] .pill')?.textContent ?? '');
  check('the Where from tab badge shows page views again', /\d/.test(badge), badge);
  await p.context().close();
}

await browser.close();
stop();
if (errs.length) console.log('page errors:\n  ' + [...new Set(errs)].join('\n  '));
check('no page errors', errs.length === 0);
console.log(`\ngrowth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
