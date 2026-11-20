/**
 * The public pages' header (21 Nov 2026), in a real browser: the same header on
 * every page, the places as tabs (in the bar on a desktop, at the bottom of the
 * screen on a phone, with no menu button), the one "new tifo", the account
 * button and its menu, and the gold ring and crown on the letter of an account
 * whose Pro is running. On a phone and a desktop, in English and Arabic.
 *
 * Self-contained: it boots its own server on memory repos and a stand-in
 * Moyasar (scripts/fake-moyasar.mjs). Needs a build:
 *   npm run build && node e2e-header.mjs
 *
 * HEADER_SHOTS=<folder> saves screenshots there.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8986;
const FAKE = 8987;
const B = `http://127.0.0.1:${PORT}`;
const PK = 'pk_test_FAKEfake1234';
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
    AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_ADMIN_PASSWORD: 'e2e header admin password', PUBLIC_URL: B,
    PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'hd_free,hd_pro', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234',
    PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK, PRO_AUTORENEW: '', MOYASAR_WEBHOOK_SECRET: 'e2e-webhook-secret-of-some-length',
    PRO_AUTORENEW_MADA: '', MOYASAR_PROXY_URL: '', MOYASAR_METHODS: '', APPLE_PAY_DOMAIN_ASSOCIATION: '', MOYASAR_VERIFY: '', PRO_AUTO_REFUND: '',
    MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } moyasar.close(); };
process.on('exit', stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { up = await fetch(`${B}/health`).then((r) => r.ok).catch(() => false); if (!up) await sleep(500); }
  if (!up) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }
}
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await sleep(250);
  }
  return null;
};
const account = async (username) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  return { token, username };
};
const buy = async (who) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: '{"lang":"en"}' });
  if (!c.json?.form) throw new Error(`checkout: ${JSON.stringify(c.json)}`);
  const f = c.json.form;
  const made = await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl,
      metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: '4111111111111111', month: '12', year: '30', cvc: '123' } }),
  });
  if (made.status !== 201) throw new Error(`payment: ${made.status}`);
  moyasar.finish3ds(f.givenId, 'paid');
  await api(`/api/pro/pay/order/${c.json.order}`, who.token);
};

const SHOTS = process.env.HEADER_SHOTS || '';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errs = [];
const open = async (token, path, { lang = 'en', w = 1440, h = 900, theme = 'light' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang, theme]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_lang_v1: lang, tifo_theme_v1: theme })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      // Once per tab: a page that signs out and loads again must stay signed out.
      if (tok && !sessionStorage.getItem('seeded')) { localStorage.setItem('tifo_token_v1', tok); sessionStorage.setItem('seeded', '1'); }
    } catch { /* */ }
  }, [token, lang, theme]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}${path}`, { waitUntil: 'networkidle' });
  if (token) await p.waitForFunction(() => document.querySelector('header.nav')?.dataset.user === '1', null, { timeout: 20000 }).catch(() => {});
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
/** The header as it is on screen. */
const look = (p) => p.evaluate(() => {
  const h = document.querySelector('header.nav');
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const phone = innerWidth <= 860;
  const tabs = h.querySelector('.nav-tabs');
  const tr = tabs.getBoundingClientRect();
  const all = [...h.querySelectorAll('a, button')].filter(vis);
  const bar = all.filter((e) => !phone || !e.closest('.nav-tabs')).map((e) => e.getBoundingClientRect()).sort((a, b) => a.left - b.left);
  let overlap = 0;
  for (let i = 1; i < bar.length; i++) if (bar[i].left < bar[i - 1].right - 1) overlap++;
  return {
    tabs: [...tabs.querySelectorAll('a')].filter(vis).map((a) => a.getAttribute('href')),
    cur: [...tabs.querySelectorAll('[aria-current="page"]')].filter(vis)[0]?.getAttribute('href') ?? null,
    atBottom: Math.round(innerHeight - tr.bottom) === 0 && getComputedStyle(tabs).position === 'fixed',
    inBar: tr.top >= h.getBoundingClientRect().top && tr.bottom <= h.getBoundingClientRect().bottom + 1,
    right: [...h.querySelectorAll('.nav-links > *')].filter(vis).map((e) => e.id || e.className.split(' ')[0]),
    blue: all.filter((e) => /rgb\(28, 111, 224\)/.test(getComputedStyle(e.classList.contains('nav-make') ? e.querySelector('.nav-make-dot') : e).backgroundColor)).map((e) => e.className.split(' ')[0]),
    small: all.filter((e) => e.getBoundingClientRect().height < (phone ? 44 : 40)).map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().height)}`),
    overlap, off: all.filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1).length,
    over: document.documentElement.scrollWidth - innerWidth,
    burger: !!document.querySelector('.mnav-burger, .mnav-drawer'),
    pad: parseFloat(getComputedStyle(document.body).paddingBottom),
  };
});
const menuRows = (p) => p.evaluate(() => [...document.querySelectorAll('#nav-menu .nav-mi')].filter((e) => e.offsetParent).map((e) => e.textContent.trim()));

const free = await account('hd_free');
const member = await account('hd_pro');
await buy(member);
const PAGES = [['/', '/'], ['/community', '/community'], ['/events', '/events'], ['/projects', '/projects'], ['/clubs', '/clubs'], ['/pro', null], ['/account', null]];

// =====================================================================
console.log('\n— a desktop, signed out: one header on every page —');
{
  let first = null;
  for (const [path, cur] of PAGES) {
    const { ctx, p } = await open(null, path);
    const v = await look(p);
    const shape = JSON.stringify([v.tabs, v.right]);
    first ??= shape;
    check(`${path}: the same places and the same controls, in the same order`, shape === first && v.tabs.join() === '/,/community,/events,/projects,/clubs' && v.right.join() === 'nav-new,nav-pro,theme-toggle,lang-toggle,auth-btn', shape);
    check(`${path}: the places are in the bar, the page marks itself, nothing overlaps or runs off`, v.inBar && !v.atBottom && v.cur === cur && v.overlap === 0 && v.off === 0 && v.over <= 0 && v.small.length === 0 && !v.burger, JSON.stringify(v));
    const ownBlue = path === '/projects' || path === '/pro' || path === '/account';
    check(`${path}: "New tifo" is ${ownBlue ? 'quiet, the page has a blue step of its own' : 'the one blue thing in the header'}`, ownBlue ? v.blue.length === 0 : v.blue.join() === 'nav-new', v.blue.join());
    if (path === '/') await shot(p, 'desktop-out-home');
    await ctx.close();
  }
}

console.log('\n— a phone, signed out: the places are at the thumb —');
{
  for (const [path, cur] of PAGES) {
    const { ctx, p } = await open(null, path, { w: 390, h: 844 });
    const v = await look(p);
    check(`${path}: five tabs at the bottom of the screen, no menu button`, v.atBottom && v.tabs.join() === '/,/community,/projects?new=1,/events,/projects' && v.cur === (cur === '/clubs' ? null : cur) && !v.burger && v.pad >= 60, JSON.stringify({ tabs: v.tabs, cur: v.cur, pad: v.pad }));
    check(`${path}: the bar holds the language, Sign up and More; 44px targets, nothing overlaps or runs off`, v.right.join() === 'lang-toggle,auth-btn,nav-more' && v.small.length === 0 && v.overlap === 0 && v.off === 0 && v.over <= 0, JSON.stringify(v));
    if (path === '/') {
      await p.click('.nav-more');
      const rows = await menuRows(p);
      check('More: Pro, For clubs and the theme', rows.length === 3 && /^Pro/.test(rows[0]) && rows[1] === 'For clubs' && rows[2] === 'Dark mode', rows.join(' / '));
      await p.click('#nav-menu [data-act="theme"]');
      check('…the theme row turns the page dark, and says what it would do next', await waitFor(p, () => document.documentElement.dataset.theme === 'dark' && /Light mode/.test(document.querySelector('#nav-menu [data-act="theme"]')?.textContent || '')));
      await p.keyboard.press('Escape');
      check('…Escape puts the menu away and the focus back on its button', await p.evaluate(() => document.getElementById('nav-menu').hidden && document.activeElement?.classList.contains('nav-more')));
      await shot(p, 'phone-out-home');
      await p.click('#auth-btn');
      check('Sign up opens the dialog', await waitFor(p, () => !!document.querySelector('.auth-modal')));
    }
    await ctx.close();
  }
}

console.log('\n— signed in: the letter and its menu —');
{
  for (const path of ['/', '/community', '/projects', '/clubs', '/pro', '/account']) {
    const { ctx, p } = await open(free.token, path);
    const s = await p.evaluate(() => { const b = document.getElementById('auth-btn'); return { user: document.querySelector('header.nav').dataset.user, name: b.textContent.trim(), letter: b.dataset.letter, pro: b.hasAttribute('data-pro'), label: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width) }; });
    const v = await look(p);
    check(`${path}: the account is a letter, named for a screen reader, with no Pro ring`, s.user === '1' && s.name === '@hd_free' && s.letter === 'h' && !s.pro && s.label === '@hd_free' && s.w === 44, JSON.stringify(s));
    check(`${path}: Pro and the theme are no longer on the bar`, v.right.filter((x) => x !== 'notif-btn').join() === 'nav-new,lang-toggle,auth-btn' && v.overlap === 0 && v.off === 0, v.right.join());
    await ctx.close();
  }
  const { ctx, p } = await open(free.token, '/community');
  await p.click('#auth-btn');
  let rows = await menuRows(p);
  const head = await p.evaluate(() => ({ name: document.querySelector('#nav-menu .nav-menu-head b')?.textContent, plan: document.querySelector('#nav-menu .nav-menu-head span')?.textContent, expanded: document.getElementById('auth-btn').getAttribute('aria-expanded'), focus: document.activeElement?.textContent?.trim(), hrefs: [...document.querySelectorAll('#nav-menu a.nav-mi')].filter((a) => a.offsetParent).map((a) => a.getAttribute('href')) }));
  check('the menu: who, the plan, then Account, My projects, Pro, the theme, Sign out', head.name === '@hd_free' && head.plan === 'Free plan' && rows.join() === 'Account,My projects,Pro,Dark mode,Sign out' && head.hrefs.join() === '/account,/projects,/pro' && head.expanded === 'true' && head.focus === 'Account', JSON.stringify({ head, rows }));
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('End');
  check('the arrow keys move through it', await p.evaluate(() => document.activeElement?.textContent?.trim() === 'Sign out'));
  await p.mouse.click(8, 400);
  check('a click elsewhere puts it away', await p.evaluate(() => document.getElementById('nav-menu').hidden && document.getElementById('auth-btn').getAttribute('aria-expanded') === 'false'));
  await p.click('#lang-toggle');
  await p.click('#auth-btn');
  rows = await menuRows(p);
  check('in Arabic the menu is Arabic', rows.join() === 'الحساب,مشاريعي,برو,الوضع الليلي,تسجيل الخروج' && (await p.evaluate(() => document.querySelector('#nav-menu .nav-menu-head span').textContent)) === 'الباقة المجانية', rows.join());
  await p.click('#nav-menu [data-act="signout"]');
  check('Sign out: the page comes back with "Sign up"', await waitFor(p, () => !document.querySelector('header.nav')?.dataset.user && !document.getElementById('auth-btn')?.classList.contains('is-user') && !localStorage.getItem('tifo_token_v1')));
  await ctx.close();
}

console.log('\n— Pro is running: the ring and the crown —');
{
  for (const [path, w, lang] of [['/', 1440, 'en'], ['/community', 1440, 'en'], ['/projects', 390, 'ar'], ['/account', 390, 'en']]) {
    const { ctx, p } = await open(member.token, path, { w, h: w < 600 ? 844 : 900, lang });
    const ok = await waitFor(p, () => document.getElementById('auth-btn')?.hasAttribute('data-pro'));
    const s = await p.evaluate(() => { const b = document.getElementById('auth-btn'); return { ring: getComputedStyle(b, '::before').boxShadow, crown: !!b.querySelector('.nav-av-badge svg'), label: b.getAttribute('aria-label'), name: b.textContent.trim(), chip: !!document.querySelector('header.nav .pro-head-chip') }; });
    check(`${path} at ${w}: the letter wears a gold ring and the crown, and says so to a screen reader`, ok && /rgb\((217, 150, 31|245, 180, 60)\)/.test(s.ring) && s.crown && s.name === '@hd_pro' && /hd_pro/.test(s.label) && s.label !== '@hd_pro' && !s.chip, JSON.stringify(s));
    if (path === '/community') {
      await p.click('#auth-btn');
      const head = await p.evaluate(() => ({ plan: document.querySelector('#nav-menu .nav-menu-head span')?.textContent, gold: document.querySelector('#nav-menu .nav-mi.gold')?.textContent.trim(), href: document.querySelector('#nav-menu .nav-mi.gold')?.getAttribute('href') }));
      check('the menu says until when, and Manage Pro goes to billing', /^Pro · until \d{1,2} \w+ 20\d\d$/.test(head.plan || '') && head.gold === 'Manage Pro' && head.href === '/account#billing', JSON.stringify(head));
      await shot(p, 'desktop-pro-menu');
    }
    if (w === 390) {
      const v = await look(p);
      check(`${path} on a phone: the tabs at the bottom, the letter on the bar, nothing overlaps`, v.atBottom && v.right.join() === 'lang-toggle,auth-btn' && v.overlap === 0 && v.off === 0 && v.small.length === 0 && v.over <= 0, JSON.stringify(v));
      await p.click('#auth-btn');
      const rows = await menuRows(p);
      check('…and its menu also holds For clubs, which a phone has no tab for', rows.length === 6 && rows[3] === (lang === 'ar' ? 'للأندية' : 'For clubs'), rows.join(' / '));
      await shot(p, `phone-pro-${lang}`);
    }
    await ctx.close();
  }
  // A Free account never wears it.
  const { ctx, p } = await open(free.token, '/projects');
  await sleep(1500);
  check('an account on Free has no ring and no crown', await p.evaluate(() => !document.getElementById('auth-btn').hasAttribute('data-pro') && !document.querySelector('#auth-btn .nav-av-badge')));
  await ctx.close();
}

console.log('\n— a small laptop, and dark —');
{
  for (const w of [900, 1024, 1180]) {
    const { ctx, p } = await open(member.token, '/community', { w, h: 800, theme: 'dark', lang: w === 1024 ? 'ar' : 'en' });
    const v = await look(p);
    check(`${w}px: the places stay in the bar, nothing overlaps or runs off`, v.inBar && !v.atBottom && v.overlap === 0 && v.off === 0 && v.over <= 0, JSON.stringify(v));
    await shot(p, `laptop-${w}`);
    await ctx.close();
  }
}

check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\ne2e-header: ${pass} passed, ${fail} failed`);
await browser.close();
stop();
process.exit(fail ? 1 : 0);
