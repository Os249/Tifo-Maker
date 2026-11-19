/**
 * Pro's launch in a real browser (server/src/proLaunch.ts): the launch price
 * as /pro words it, the header link, the founders list and email from /admin,
 * the founders offer before paying, on the receipt and on the account page,
 * and "stop these emails". Against real servers on memory stores and a
 * stand-in Moyasar (scripts/fake-moyasar.mjs). No real key, card or email:
 * the keys are made-up ones of the live shape (Pro is only "on sale for real"
 * with a live key), Moyasar is the stand-in, and email goes to the log.
 *
 * Self-contained: it boots its own servers. Needs a build:
 *   npm run build && node e2e-launch.mjs
 * LAUNCH_SHOTS=<folder> also saves screenshots of every screen it checks.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8961;        // on sale for real: the launch price in plain words, the founders offer (it comes with the launch), auto-renew on
const PORT_STRIKE = 8962; // the same with PRO_PRICE_DISPLAY=strike and a licence number
const PORT_BARE = 8963;   // on sale with no launch price and the founders offer switched off: 19.99, no offer
const PORT_SOON = 8964;   // not on sale: the coming-soon page, untouched
const FAKE = 8965;
const B = `http://127.0.0.1:${PORT}`;
const STRIKE = `http://127.0.0.1:${PORT_STRIKE}`;
const BARE = `http://127.0.0.1:${PORT_BARE}`;
const SOON = `http://127.0.0.1:${PORT_SOON}`;
const ADMIN_PW = 'e2e launch admin password';
const PK = 'pk_live_FAKEfake1234';
const SK = 'sk_live_FAKEfake1234'; // made up, of the live shape: only the stand-in ever sees it
const SHOTS = process.env.LAUNCH_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);

/** The first day at the regular price: 40 days from now, as a Riyadh date. */
const untilDay = new Date(Date.now() + 40 * 24 * 3600_000 + 3 * 3600_000).toISOString().slice(0, 10);

const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
      AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_ADMIN_PASSWORD: ADMIN_PW, PUBLIC_URL: `http://127.0.0.1:${port}`,
      PRO_MODE: '', PRO_PREVIEW_USERS: '', PRO_CHECKOUT: '', MOYASAR_PUBLISHABLE_KEY: '', MOYASAR_VERIFY: '', PRO_AUTORENEW: '', PRO_AUTORENEW_MADA: '', MOYASAR_PROXY_URL: '',
      MOYASAR_METHODS: '', APPLE_PAY_DOMAIN_ASSOCIATION: '', MOYASAR_WEBHOOK_SECRET: '', MOYASAR_SECRET_KEY: '', PRO_PAYMENTS: '', PRO_AUTO_REFUND: '',
      PRO_LAUNCH_PRICE_UNTIL: '', PRO_PRICE_DISPLAY: '', PRO_DISCOUNT_LICENCE: '', PRO_FOUNDERS_BONUS: '',
      MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
      // The launch job is run from /admin here, and the log stands in for the mail service (neither works in production).
      LAUNCH_JOB: 'off', LAUNCH_MAIL_TO_LOG: 'on',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const SALE = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: SK, MOYASAR_PUBLISHABLE_KEY: PK, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: 'e2e-webhook-secret-of-some-length' };
const servers = [
  boot(PORT, { ...SALE, PRO_AUTORENEW: 'on', PRO_LAUNCH_PRICE_UNTIL: untilDay }),
  boot(PORT_STRIKE, { ...SALE, PRO_LAUNCH_PRICE_UNTIL: untilDay, PRO_PRICE_DISPLAY: 'strike', PRO_DISCOUNT_LICENCE: '4400012345' }),
  boot(PORT_BARE, { ...SALE, PRO_FOUNDERS_BONUS: 'off' }),
  boot(PORT_SOON, {}),
];
const stop = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } moyasar.close(); };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 160; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
for (const base of [B, STRIKE, BARE, SOON]) {
  if (!(await up(base))) { console.error('server never came up\n' + out.join('').slice(-3000)); stop(); process.exit(1); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const codeFor = async (email) => {
  for (let i = 0; i < 60; i++) {
    // One logged email at a time: a message with no code in it (the founders email) must not swallow the next one's.
    const mine = out.join('').split('[email:dev] to=').filter((x) => x.startsWith(`${email} |`)).map((x) => /Your TifoMaker code: (\d{6})/.exec(x)).filter(Boolean).pop();
    if (mine) return mine[1];
    await sleep(250);
  }
  return null;
};
const account = async (username, base = B, verify = true) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  // Verified for certain before anything is built on it: the code is read from the server's log, which can lag.
  for (let i = 0; verify && i < 5; i++) {
    const v = await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) }, base);
    if (v.status < 300) break;
    if (i === 4) throw new Error(`could not verify ${username}: ${v.status} ${JSON.stringify(v.json)}`);
    await sleep(700);
  }
  return { token, email, username };
};
const mails = (email, subject) => [...out.join('').matchAll(/\[email:dev\] to=(\S+) \| ([^\n]*)/g)].filter((m) => m[1] === email && subject.test(m[2])).length;
const mailsSoon = async (email, subject, n) => {
  for (let i = 0; i < 40 && mails(email, subject) < n; i++) await sleep(150);
  return mails(email, subject);
};
/** Buy a month the way the payment form does: the server's order, a payment at "Moyasar" under its id, 3-D Secure, the return. */
const buy = async (who, base = B) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: '{"lang":"en"}' }, base);
  if (!c.json?.form) throw new Error(`checkout: ${JSON.stringify(c.json)}`);
  const f = c.json.form;
  const made = await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl,
      metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: '4111111111111111', month: '12', year: '30', cvc: '123' },
    }),
  });
  if (made.status !== 201) throw new Error(`payment: ${made.status}`);
  moyasar.finish3ds(f.givenId, 'paid');
  const seen = await api(`/api/pro/pay/order/${c.json.order}`, who.token, {}, base);
  if (seen.json?.status !== 'paid') throw new Error(`not paid: ${JSON.stringify(seen.json)}`);
  return { order: c.json.order, form: f, seen: seen.json };
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !x ? '' : '  ' + x}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errs = [];
const page = async (token, { lang = 'en', w = 1440, h = 900, scheme = 'light' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name, full = false) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); };
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() || '', sel);
/** Nothing on the page is wider than the page (a phone that scrolls sideways). */
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// The accounts, made before the launch: who asked to be told, who answered the price question, who did neither.
const founder = await account('lf_founder');
const priced = await account('lf_priced');
const arFounder = await account('lf_arabic');
const plain = await account('lf_plain');
const unverified = await account('lf_unverified', B, false);
for (const f of [founder, arFounder, unverified]) await api('/api/pro/notify', f.token, { method: 'POST', body: '{}' });
await api('/api/pro/price', priced.token, { method: 'POST', body: JSON.stringify({ amount: 15, currency: 'SAR', lang: 'ar', source: 'page' }) });
const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).json?.token;
const asBoss = { 'x-ai-unlock': unlock };

// =====================================================================
console.log('\n— not on sale: nothing of the launch shows —');
{
  const html = await (await fetch(`${SOON}/pro`)).text();
  check('the header still says "Pro · soon"', /data-i18n="nav\.proSoon">Pro · soon</.test(html) && !/data-i18n="nav\.pro"/.test(html));
  check('/pro is sent as the coming-soon page: its own words, not for search engines, no link card', /data-i18n="ps\.title">Help us price Pro</.test(html) && /<meta name="robots" content="noindex"/.test(html) && !/og:title|class="on-sale"/.test(html) && /<details id="pp-faq-refund" hidden>/.test(html));
  const st = (await api('/api/pro', null, {}, SOON)).json;
  check('/api/pro has no price, no launch and no founder', !st?.offer && !('founder' in (st ?? {})), JSON.stringify(st).slice(0, 200));
  const legal = await (await fetch(`${SOON}/legal`)).text();
  check('/legal says nothing of a launch price, a founders offer or VAT', !/launch price|founders offer|No VAT|\{\{/i.test(legal));
  const adm = (await api('/api/admin/pro/launch', null, { headers: asBoss }, SOON)).json;
  check('/admin: not launched, and "send now" starts nothing', adm?.launchedAt === null && adm.public === false && (await api('/api/admin/pro/launch/send', null, { method: 'POST', headers: asBoss, body: '{}' }, SOON)).json?.held === 'off');
}

// =====================================================================
console.log('\n— on sale: the header link and the launch price, in plain words —');
{
  for (const path of ['/', '/pro', '/community', '/clubs', '/events', '/ar/pro', '/ar/community']) {
    const html = await (await fetch(B + path)).text();
    const ar = path.startsWith('/ar');
    check(`${path}: the header says just "${ar ? 'برو' : 'Pro'}"`, !/nav\.proSoon/.test(html) && (ar ? /data-i18n="nav\.pro">برو</ : /data-i18n="nav\.pro">Pro</).test(html));
  }
  // The page as the server sends it, before any script: what a link's preview card and a slow phone's first second show.
  for (const [path, title, h1, lead] of [
    ['/pro', 'TifoMaker Pro: the match-day film, the 4K poster and more', 'Go Pro for a month', /free and stays free: nothing essential will ever need Pro/],
    ['/ar/pro', 'تيفو ميكر برو: فيلم يوم المباراة وبوستر 4K وأكثر', 'خذ برو لمدة شهر', /مجاني ويبقى مجاني/],
  ]) {
    const html = await (await fetch(B + path)).text();
    const one = (re) => (html.match(re) || []).length === 1;
    check(`${path} is sent on sale: the title, a description and one link card`, html.includes(`<title>${title}</title>`) && one(/<title>/g) && one(/<meta name="description"/g) && one(/property="og:title"/g) && one(/property="og:image"/g) && /name="twitter:card" content="summary_large_image"/.test(html) && html.includes(`<link rel="canonical" href="${B}${path}"`));
    check(`${path}: for search engines now, and nothing of "coming soon" in it`, !/noindex/.test(html) && !/data-i18n="ps\.(eyebrow|title|lead|step\d\.[tb])"/.test(html) && !/Help us price Pro|ساعدنا نحدد سعر/.test(html));
    check(`${path}: the hero already says Pro is to buy, and that TifoMaker stays free`, html.includes(`data-i18n="pb.title">${h1}<`) && lead.test(/data-i18n="pr\.lead">([^<]*)</.exec(html)?.[1] ?? '') && /<div id="pp-open" class="on-sale">/.test(html) && /<details id="pp-faq-refund">/.test(html) && /<details id="pp-faq-who">/.test(html));
    check(`${path}: no price in the HTML: the price is /api/pro's to say`, !/13\.99|19\.99/.test(html));
  }
  {
    // A slow connection: /api/pro has not answered yet, and the page already reads as on sale.
    const { ctx, p } = await page(null, { lang: 'ar', w: 390, h: 844 });
    let release;
    const held = new Promise((r) => { release = r; });
    await p.route('**/api/pro', async (r) => { await held; await r.continue(); });
    await p.goto(`${B}/ar/pro`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const first = await p.evaluate(() => ({ h1: document.getElementById('pp-h')?.textContent, eyebrow: document.querySelector('.pp-eyebrow')?.textContent, busy: document.getElementById('pp-plans')?.getAttribute('aria-busy') }));
    check('before /api/pro answers, a phone already shows the on-sale hero in Arabic, never "coming soon"', first.h1 === 'خذ برو لمدة شهر' && !/قريباً/.test(first.eyebrow || '') && first.busy === 'true', JSON.stringify(first));
    await shot(p, 'pro-launch-first-paint-phone-ar');
    release();
    check('…and then the price', await waitFor(p, () => /13\.99/.test(document.querySelector('.pb-price')?.textContent || '')));
    await ctx.close();
  }
  {
    // /api/pro does not answer at all: no price question, no "tell me when it opens"; a way to try again.
    const { ctx, p } = await page(null);
    let down = true;
    await p.route('**/api/pro', (r) => (down ? r.abort() : r.continue()));
    await p.goto(`${B}/pro`, { waitUntil: 'domcontentloaded' });
    check('the price cannot be fetched: the page says so, with "Try again", and asks nothing', await waitFor(p, () => /The price didn't load/.test(document.getElementById('pp-load-failed')?.textContent || '') && !document.querySelector('form#ps-ask') && document.getElementById('pp-act')?.hidden === true && /Go Pro for a month/.test(document.getElementById('pp-h')?.textContent || '')));
    down = false;
    await p.click('#pp-load-failed [data-act="reload"]');
    check('…"Try again" brings the price', await waitFor(p, () => /SAR 13\.99/.test(document.querySelector('.pb-price')?.textContent || '')));
    await ctx.close();
  }
  const { ctx, p } = await page(null);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('signed out: SAR 13.99 for 30 days', await waitFor(p, () => /SAR 13\.99\s*for 30 days/.test(document.querySelector('.pb-price')?.textContent?.replace(/\s+/g, ' ') || '')), await text(p, '.pb-price'));
  const launch = await text(p, '#pb-launch');
  check('…"Launch price. From <date> the price will be SAR 19.99."', /^Launch price\. From \d{1,2} \w+ 20\d\d the price will be SAR 19\.99\.$/.test(launch), launch);
  const ui = await p.evaluate(() => ({
    struck: document.querySelectorAll('.pb-buy s, .pb-buy del, .pb-was').length,
    words: document.querySelector('.pp-plan.pro')?.textContent || '',
    once: document.querySelector('.pb-once')?.textContent || '',
    founder: !!document.getElementById('pb-founder'),
    nav: document.querySelector('.nav-pro span')?.textContent,
    blue: [...document.querySelectorAll('main .pp-btn:not(.quiet)')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()),
  }));
  check('…no crossed-out price, and no word "discount" or "sale"', ui.struck === 0 && !/discount|% off|\bsale\b|was SAR/i.test(ui.words));
  check('…the whole price: no VAT is added', /no VAT is added/.test(ui.once), ui.once);
  check('…renewal is a choice, said beside the price', /renews only if you tick "Keep Pro on"/.test(ui.once));
  check('…no founders offer shown to a visitor', ui.founder === false);
  check('…one blue button, with the price on it: "Get Pro for SAR 13.99"', ui.blue.length === 1 && ui.blue[0] === 'Get Pro for SAR 13.99', JSON.stringify(ui.blue));
  const quiet = await p.evaluate(() => ({ cta: getComputedStyle(document.getElementById('auth-btn')).backgroundColor, note: document.getElementById('pb-signin-note')?.textContent }));
  check('…the header\'s "Sign up" is quiet beside it, and the line under the button says what comes first', /rgba\(0, 0, 0, 0\)|transparent/.test(quiet.cta) && /sign up or sign in first, then pay/.test(quiet.note || ''), JSON.stringify(quiet));
  await p.click('[data-act="buy-signin"]');
  check('…pressing it signed out opens the dialog on "Sign up"', await waitFor(p, () => !!document.querySelector('.auth-modal .auth-tab.active[data-mode="signup"]'), null, 15000));
  // Someone who already has an account signs in there, and the page carries on to the payment by itself:
  // the press they made had the price on it.
  const walkin = await account('launch_walkin');
  let checkouts = 0;
  p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/pro\/pay\/checkout$/.test(r.url())) checkouts++; });
  await p.click('.auth-modal .auth-tab[data-mode="signin"]');
  await p.fill('.auth-modal input[name="identity"]', walkin.username);
  await p.fill('.auth-modal input[name="password"]', 'harbor-kite-moss-31');
  await p.click('.auth-modal .auth-form .auth-submit');
  check('…signed in from that button, the checkout starts without a second press', await waitFor(p, () => !document.querySelector('.auth-modal') && !document.querySelector('[data-act="buy-signin"]'), null, 20000) && (await (async () => { for (let i = 0; i < 40 && !checkouts; i++) await sleep(250); return checkouts === 1; })()), String(checkouts));
  const card = await (await fetch(`${B}/pro`)).text();
  const img = /property="og:image" content="([^"]+)"/.exec(card)?.[1] ?? '';
  const got = img ? await fetch(img) : null;
  check('the link card is Pro\'s own picture, and it is there', /\/pro\/og-pro\.png$/.test(img) && got?.status === 200 && /image\/png/.test(got.headers.get('content-type') || ''), img);
  const map = await (await fetch(`${B}/sitemap.xml`)).text();
  check('/pro is in the sitemap, in both languages; and not where Pro is not on sale', map.includes(`<loc>${B}/pro</loc>`) && map.includes(`<loc>${B}/ar/pro</loc>`) && !(await (await fetch(`${SOON}/sitemap.xml`)).text()).includes('/pro</loc>'));
  check('…and the header link says "Pro"', ui.nav === 'Pro', ui.nav);
  await shot(p, 'pro-launch-signedout-desktop-en');
  await ctx.close();

  const legal = await (await fetch(`${B}/legal`)).text();
  check('/legal: the launch price terms, with both prices and the date', /The launch price\.<\/b> For orders made before \d{1,2} \w+ 20\d\d \(Riyadh time\), a month of Pro costs SAR 13\.99\. From that date the price is SAR 19\.99/.test(legal) && !legal.includes('{{'));
  check('/legal: the founders offer terms', /The founders offer\./.test(legal) && /within 72 hours/.test(legal) && /once per account/.test(legal) && /refunded, the extra days end with it/.test(legal));
  check('/legal: the price is the whole amount, no VAT, a receipt not a tax invoice', /No VAT is charged, because I am not registered for VAT/.test(legal) && /not a tax invoice/.test(legal));
  check('/legal: the seller and the freelance document', /Osamh Alsharekh/.test(legal) && /FL-216888773/.test(legal));
  check('/legal: auto-renew is never ticked, renews at the regular price, with a reminder and one-click cancel', /never ticked for you/.test(legal) && /the regular price, which can be more than a launch price/.test(legal) && /3 days before every renewal/.test(legal));
  const legalAr = await (await fetch(`${B}/ar/legal`)).text();
  check('/ar/legal: the same terms in Arabic, with the same numbers', /سعر الإطلاق\./.test(legalAr) && /بـ13\.99 ريال/.test(legalAr) && /السعر 19\.99 ريال/.test(legalAr) && /عرض المؤسسين\./.test(legalAr) && /خلال 72 ساعة/.test(legalAr) && /FL-216888773/.test(legalAr) && !legalAr.includes('{{'));
}

// =====================================================================
console.log('\n— /admin before the launch: the founders list and the email —');
let frameHtml = '';
{
  check('the launch routes are the admin\'s', (await api('/api/admin/pro/launch', founder.token)).status === 403 && (await api('/api/admin/pro/launch/send', founder.token, { method: 'POST', body: '{}' })).status === 403);
  const pre = (await api('/api/admin/pro/launch', null, { headers: asBoss })).json;
  check('three founders: verified accounts on either list, each once', pre?.launchedAt === null && pre.founders.total === 3 && pre.founders.notify === 2 && pre.founders.both === 1, JSON.stringify(pre?.founders).slice(0, 200));
  check('…the unverified account and the one that did neither are not on it', !pre.founders.rows.some((r) => /unverified|plain/.test(r.username)));
  check('nothing has been sent', mails(founder.email, /Pro is open/) === 0);
  const { ctx, p } = await page(null, { w: 1360, h: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', ADMIN_PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="pro"]');
  check('Pro tab: "Launch and founders", with the count and the price now', await waitFor(p, () => {
    const h = [...document.querySelectorAll('h2.sec')].find((x) => x.textContent === 'Launch and founders');
    const t = document.body.textContent || '';
    return !!h && /Price now: SAR 13\.99/.test(t) && /SAR 19\.99 from/.test(t) && /Auto-renew always renews at SAR 19\.99/.test(t) && /no crossed-out price/.test(t);
  }, null, 20000));
  const frame = await p.evaluate(() => {
    document.getElementById('launch-mail').open = true;
    const f = document.getElementById('launch-frame');
    return { sandbox: f.getAttribute('sandbox'), doc: f.srcdoc };
  });
  frameHtml = frame.doc;
  check('…the email preview, in a frame that can run nothing', frame.sandbox === '' && /Pro is now on sale/.test(frame.doc) && /60 days for the price of 30/.test(frame.doc) && /SAR 13\.99/.test(frame.doc));
  check('…no address is listed, only usernames', !/@tifomaker-e2e\.org/.test(await p.evaluate(() => document.getElementById('content')?.textContent || document.body.textContent)));
  await p.evaluate(() => [...document.querySelectorAll('h2.sec')].find((x) => x.textContent === 'Launch and founders')?.scrollIntoView());
  await shot(p, 'admin-launch-before');
  await ctx.close();
}

// =====================================================================
console.log('\n— the launch: recorded once, one email each —');
let deadline = '';
{
  const sent = (await api('/api/admin/pro/launch/send', null, { method: 'POST', headers: asBoss, body: '{}' })).json;
  check('the launch is recorded and three emails go out', sent?.launched === true && sent.sent === 3 && sent.failed === 0, JSON.stringify(sent));
  check('…one to each founder', (await mailsSoon(founder.email, /Pro is open/, 1)) === 1 && mails(priced.email, /Pro is open/) === 1 && mails(arFounder.email, /Pro is open/) === 1);
  check('…none to the unverified account or to one that never asked', mails(unverified.email, /Pro is open/) === 0 && mails(plain.email, /Pro is open/) === 0);
  for (let i = 0; i < 3; i++) await api('/api/admin/pro/launch/send', null, { method: 'POST', headers: asBoss, body: '{}' });
  check('"send now" again and again: still one each', mails(founder.email, /Pro is open/) === 1 && mails(priced.email, /Pro is open/) === 1 && mails(arFounder.email, /Pro is open/) === 1);
  const adm = (await api('/api/admin/pro/launch', null, { headers: asBoss })).json;
  deadline = adm.deadline;
  check('/admin: launched, 3 sent, the deadline 72 hours on', !!adm.launchedAt && adm.mail.sent === 3 && adm.mail.waiting === 0 && Date.parse(adm.deadline) - Date.parse(adm.launchedAt) === 72 * 3600_000, JSON.stringify(adm.mail));
  // An account that asks after the launch is not a founder.
  const late = await account('lf_late');
  await api('/api/pro/notify', late.token, { method: 'POST', body: '{}' });
  await api('/api/admin/pro/launch/send', null, { method: 'POST', headers: asBoss, body: '{}' });
  check('asking after the launch makes nobody a founder', mails(late.email, /Pro is open/) === 0 && !('founder' in (await api('/api/pro', late.token)).json));
  const body = out.join('').split(`[email:dev] to=${founder.email} | `).find((x) => /^[^\n]*Pro is open/.test(x)) || '';
  check('the email: the offer, the exact deadline in Riyadh time, the price and when it changes', /60 days for the price of 30/.test(body) && /\(Riyadh time\)/.test(body) && /SAR 13\.99 for 30 days/.test(body) && /the price will be SAR 19\.99/.test(body), body.slice(0, 400));
  check('…who sells it, no VAT, the refund, and how to stop such emails', /FL-216888773/.test(body) && /No VAT is charged/.test(body) && /Full refund within 7 days/.test(body) && /\/pro\?nomail=[A-Za-z0-9_-]{24,64}/.test(body));
}

// =====================================================================
console.log('\n— the founders email, as a mail client draws it —');
{
  for (const [name, w] of [['desktop', 700], ['phone', 390]]) {
    const { ctx, p } = await page(null, { w, h: 900 });
    await p.setContent(frameHtml, { waitUntil: 'load' });
    const m = await p.evaluate(() => ({
      rtl: document.querySelector('td[dir="rtl"][lang="ar"]')?.textContent?.slice(0, 40) || '',
      en: document.querySelector('td[dir="ltr"][lang="en"]')?.textContent || '',
      buttons: [...document.querySelectorAll('a')].filter((a) => /^(See Pro|شوف برو)$/.test(a.textContent.trim())).map((a) => ({ href: a.getAttribute('href'), h: Math.round(a.getBoundingClientRect().height) })),
      wide: document.documentElement.scrollWidth <= window.innerWidth + 1,
      struck: document.querySelectorAll('s, del, strike').length,
      stop: [...document.querySelectorAll('a')].filter((a) => /nomail=/.test(a.getAttribute('href') || '')).map((a) => a.textContent.trim()),
    }));
    check(`${name}: Arabic first, right to left, then English`, /تيفو ميكر برو/.test(m.rtl) && /TifoMaker Pro is now on sale/.test(m.en));
    check(`${name}: a button to /pro in each language, big enough to tap`, m.buttons.length === 2 && /\/ar\/pro$/.test(m.buttons[0].href) && /\/pro$/.test(m.buttons[1].href) && m.buttons.every((b) => b.h >= 40), JSON.stringify(m.buttons));
    check(`${name}: a "stop these emails" link in each language, and no crossed-out price`, m.stop.length === 2 && m.struck === 0, JSON.stringify(m.stop));
    check(`${name}: it fits the screen`, m.wide);
    await shot(p, `founders-email-${name}`, true);
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— /pro for a founder: the offer before paying —');
let bought;
{
  const st = (await api('/api/pro', founder.token)).json;
  check('/api/pro tells the founder: open, 30 more days, 60 in all, until the deadline', st?.founder?.state === 'open' && st.founder.bonusDays === 30 && st.founder.total === 60 && st.founder.until === deadline, JSON.stringify(st?.founder));
  check('…and tells an account that is not a founder nothing', !('founder' in (await api('/api/pro', plain.token)).json));
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const { ctx, p } = await page(founder.token, { w, h });
    await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
    check(`${name}: "Founder: you get 2 months for the price of 1, until <date, time> (Riyadh time)"`, await waitFor(p, () => /^Founder: you get 2 months for the price of 1, until \d{1,2} \w+ 20\d\d(,| at)? \d\d:\d\d \(Riyadh time\)\./.test(document.querySelector('#pb-founder b')?.textContent || '')), await text(p, '#pb-founder'));
    const f = await text(p, '#pb-founder');
    check(`${name}: …with its terms: 60 days not 30, once, and a refund ends the extra days`, /this first purchase is 60 days, not 30/.test(f) && /Once, for your account/.test(f) && /refund, the extra days end with it/.test(f), f);
    check(`${name}: one blue button, "Get Pro for SAR 13.99"`, (await p.evaluate(() => [...document.querySelectorAll('main .pp-btn:not(.quiet)')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()).join('|'))) === 'Get Pro for SAR 13.99');
    check(`${name}: the page fits`, await fits(p));
    await p.locator('.pp-plan.pro').scrollIntoViewIfNeeded();
    await shot(p, `pro-launch-founder-${name}-en`);
    if (name === 'desktop') {
      // "Get Pro" opens the form: what is charged now, what each renewal costs, and when the first one is.
      await p.click('[data-act="buy"]');
      check('the form opens with "Keep Pro on" NOT ticked', await waitFor(p, () => document.getElementById('pb-keep') && document.getElementById('pb-keep').checked === false, null, 20000));
      const terms = await text(p, '#pb-keep-terms');
      check('…"SAR 13.99 now for your first 60 days as a founder, then SAR 19.99 every 30 days until you cancel"', /^SAR 13\.99 now for your first 60 days as a founder, then SAR 19\.99 every 30 days until you cancel\. The first renewal is on \d{1,2} \w+ 20\d\d\./.test(terms), terms);
      check('…with the reminder and the one-click cancel', /email you 3 days before each renewal/.test(terms) && /cancel with one click/.test(terms));
      const first = (await api('/api/pro/pay/checkout', founder.token, { method: 'POST', body: '{"lang":"en"}' })).json.form;
      check('…the first renewal date is 60 days on, and the form charges 1399 halalas', Math.round((Date.parse(first.renew.nextAt) - Date.now()) / (24 * 3600_000)) === 60 && first.amount === 1399 && first.renew.price === 19.99);
      await p.locator('.pb-buy').scrollIntoViewIfNeeded();
      await shot(p, 'pro-launch-founder-form-desktop-en');
    }
    await ctx.close();
  }
  // Someone who is not a founder: the same price, the ordinary terms, no offer.
  {
    const { ctx, p } = await page(plain.token);
    await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
    check('not a founder: the launch price, and no founders offer', (await waitFor(p, () => /SAR 13\.99/.test(document.querySelector('.pb-price')?.textContent || ''))) && !(await p.evaluate(() => !!document.getElementById('pb-founder'))));
    await p.click('[data-act="buy"]');
    await waitFor(p, () => !!document.getElementById('pb-keep'), null, 20000);
    const terms = await text(p, '#pb-keep-terms');
    check('…"SAR 13.99 now, then SAR 19.99 every 30 days until you cancel", first renewal in 30 days', /^SAR 13\.99 now, then SAR 19\.99 every 30 days until you cancel\. The first renewal is on/.test(terms) && !/founder/.test(terms), terms);
    await ctx.close();
  }

  // The founder pays.
  bought = await buy(founder);
  check('paid: the order says 30 days bought and 30 given', bought.seen.bonusDays === 30 && bought.seen.days === 30 && Math.round((Date.parse(bought.seen.endsAt) - Date.now()) / (24 * 3600_000)) === 60, JSON.stringify(bought.seen));
  check('the receipt shows the price paid and the bonus', (await mailsSoon(founder.email, /receipt/i, 1)) === 1 && /30 days \+ 30 founder days free \(60 days in all\): SAR 13\.99/.test(out.join('')));
  const two = await buy(plain);
  check('an account that is not a founder pays the same and gets 30 days', !two.seen.bonusDays && Math.round((Date.parse(two.seen.endsAt) - Date.now()) / (24 * 3600_000)) === 30);
  const adm = (await api('/api/admin/pro/launch', null, { headers: asBoss })).json;
  check('/admin counts one founder who bought in time', adm.bought.inTime === 1 && adm.founders.rows.find((r) => r.username === 'lf_founder')?.bought === true);
}

// =====================================================================
console.log('\n— back on /pro and the account page: the bonus shows —');
{
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const { ctx, p } = await page(founder.token, { w, h });
    await p.goto(`${B}/account#pro`, { waitUntil: 'networkidle' });
    check(`${name}: "Founder: your first purchase got 30 extra days free, 60 days in all"`, await waitFor(p, () => /Founder: your first purchase got 30 extra days free, 60 days in all\./.test(document.querySelector('#pro [data-founder="used"]')?.textContent || '')), await text(p, '#pro .pro-founder'));
    const row = await text(p, '#pro .pu-order');
    check(`${name}: the purchase: "Pro, 30 days + 30 founder days free", Paid, SAR 13.99`, /Pro, 30 days \+ 30 founder days free/.test(row) && /Paid/.test(row) && /SAR 13\.99/.test(row), row.slice(0, 200));
    check(`${name}: the header link says "Pro", and the page fits`, (await p.evaluate(() => document.querySelector('.ac-pro span')?.textContent)) === 'Pro' && (await fits(p)));
    await shot(p, `account-founder-${name}-en`);
    await ctx.close();
  }
  const { ctx, p } = await page(founder.token);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro no longer offers it: the bonus was taken', (await waitFor(p, () => !!document.querySelector('.pb-buy'))) && !(await p.evaluate(() => !!document.getElementById('pb-founder'))));
  await ctx.close();
}

// =====================================================================
console.log('\n— Arabic —');
{
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const { ctx, p } = await page(arFounder.token, { lang: 'ar', w, h });
    await p.goto(`${B}/ar/pro`, { waitUntil: 'networkidle' });
    check(`${name}: the price and the launch line in Arabic`, await waitFor(p, () => /13\.99 ريال/.test(document.querySelector('.pb-price')?.textContent || '') && /^سعر الإطلاق\. ومن يوم \d{1,2} \S+ 20\d\d يصير السعر 19\.99 ريال\.$/.test(document.getElementById('pb-launch')?.textContent || '')), await text(p, '#pb-launch'));
    const f = await text(p, '#pb-founder');
    check(`${name}: the founders offer in Arabic, with the deadline in Riyadh time`, /^مؤسس: لك شهرين بسعر شهر، لين \d{1,2} \S+ 20\d\d.*\d\d:\d\d \(بتوقيت الرياض\)\./.test(f) && /60 يوم بدل 30/.test(f), f);
    const page_ = await p.evaluate(() => ({ dir: document.documentElement.dir, nav: document.querySelector('.nav-pro span')?.textContent, latin: (document.querySelector('.pb-buy')?.textContent || '').match(/[A-Za-z]{4,}/g) }));
    check(`${name}: right to left, the header says "برو", no English left in the price box`, page_.dir === 'rtl' && page_.nav === 'برو' && !page_.latin, JSON.stringify(page_));
    check(`${name}: the page fits`, await fits(p));
    await p.locator('.pp-plan.pro').scrollIntoViewIfNeeded();
    await shot(p, `pro-launch-founder-${name}-ar`);
    if (name === 'desktop') {
      await p.click('[data-act="buy"]');
      await waitFor(p, () => !!document.getElementById('pb-keep'), null, 20000);
      const terms = await text(p, '#pb-keep-terms');
      check('the renewal terms in Arabic: 13.99 now for 60 days, then 19.99 every 30 days', /^13\.99 ريال الحين لأول 60 يوم لك كمؤسس، وبعدها 19\.99 ريال كل 30 يوم لين تلغي\. أول تجديد يوم/.test(terms), terms);
    }
    await ctx.close();
  }
  await buy(arFounder);
  const { ctx, p } = await page(arFounder.token, { lang: 'ar', w: 390, h: 844 });
  await p.goto(`${B}/ar/account#pro`, { waitUntil: 'networkidle' });
  check('the account page in Arabic: the founder line and the purchase', await waitFor(p, () => /مؤسس: أول شراء لك أخذ 30 يوم زيادة مجانًا، والمجموع 60 يوم\./.test(document.querySelector('#pro [data-founder="used"]')?.textContent || '') && /برو، 30 يوم \+ 30 يوم هدية المؤسسين/.test(document.querySelector('#pro .pu-order')?.textContent || '') && /13\.99 ريال/.test(document.querySelector('#pro .pu-amt')?.textContent || '')), await text(p, '#pro'));
  await shot(p, 'account-founder-phone-ar');
  await ctx.close();
}

// =====================================================================
console.log('\n— "stop these emails" —');
{
  const body = out.join('').split(`[email:dev] to=${priced.email} | `).find((x) => /^[^\n]*Pro is open/.test(x)) || '';
  const link = /https?:\/\/\S+\/pro\?nomail=([A-Za-z0-9_-]{24,64})/.exec(body);
  check('the email carries the link', !!link);
  const token = link?.[1] ?? '';
  check('opening it with a GET stops nothing (a mail scanner follows links)', (await fetch(`${B}/api/pro/mail/stop?t=${token}`)).status === 404);
  const { ctx, p } = await page(null);
  await p.goto(`${B}/pro?nomail=${token}`, { waitUntil: 'networkidle' });
  check('the page stops them and says so, with no sign-in', await waitFor(p, () => /You won't get emails about Pro's news and offers\. Receipts and renewal reminders/.test(document.getElementById('pp-paid')?.textContent || '')), await text(p, '#pp-paid'));
  check('…and the token is gone from the address bar', !/nomail/.test(p.url()));
  await ctx.close();
  const bad = await page(null);
  await bad.p.goto(`${B}/pro?nomail=${'x'.repeat(32)}`, { waitUntil: 'networkidle' });
  check('a link that is nobody\'s says it did not work', await waitFor(bad.p, () => /This link didn't work/.test(document.getElementById('pp-paid')?.textContent || '')));
  await bad.ctx.close();
}

// =====================================================================
console.log('\n— the crossed-out price, only with a licence number —');
{
  const { ctx, p } = await page(null);
  await p.goto(`${STRIKE}/pro`, { waitUntil: 'networkidle' });
  check('SAR 13.99 with SAR 19.99 crossed out', await waitFor(p, () => /SAR 19\.99/.test(document.querySelector('.pb-price s.pb-was')?.textContent || '') && /SAR 13\.99/.test(document.querySelector('.pb-price b')?.textContent || '')), await text(p, '.pb-price'));
  const l = await text(p, '#pb-launch');
  check('…and the licence number printed beside it', /Discount licence no\. 4400012345\./.test(l) && /then SAR 19\.99/.test(l), l);
  check('…the crossed-out price is really crossed out, and named for a screen reader', await p.evaluate(() => getComputedStyle(document.querySelector('.pb-was')).textDecorationLine.includes('line-through') && /Regular price: SAR 19\.99/.test(document.querySelector('.pb-was').getAttribute('aria-label'))));
  await shot(p, 'pro-launch-strike-desktop-en');
  await ctx.close();
}

// =====================================================================
console.log('\n— no launch price, and the founders offer switched off: SAR 19.99 and no offer —');
{
  const who = await account('lf_bare', BARE);
  await api('/api/pro/notify', who.token, { method: 'POST', body: '{}' }, BARE);
  const sent = (await api('/api/admin/pro/launch/send', null, { method: 'POST', headers: { 'x-ai-unlock': (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) }, BARE)).json?.token }, body: '{}' }, BARE)).json;
  check('the founder is still emailed that Pro is open', sent?.launched === true && sent.sent === 1 && (await mailsSoon(who.email, /TifoMaker Pro is open/, 1)) === 1, JSON.stringify(sent));
  const body = out.join('').split(`[email:dev] to=${who.email} | `).find((x) => /^[^\n]*Pro is open/.test(x)) || '';
  check('…with no offer and no deadline in it, and the regular price', !/founders offer|60 days|extra month/i.test(body.split('[email:dev]')[0]) && /SAR 19\.99 for 30 days/.test(body) && !/13\.99/.test(body.split('[email:dev]')[0]));
  const { ctx, p } = await page(who.token);
  await p.goto(`${BARE}/pro`, { waitUntil: 'networkidle' });
  check('/pro: SAR 19.99, no launch line, no founders offer, "It never renews by itself"', (await waitFor(p, () => /SAR 19\.99/.test(document.querySelector('.pb-price')?.textContent || ''))) && (await p.evaluate(() => !document.getElementById('pb-launch') && !document.getElementById('pb-founder') && /It never renews by itself/.test(document.querySelector('.pb-once').textContent))));
  await ctx.close();
  const b = await buy(who, BARE);
  check('a month is a month: 1999 halalas, 30 days, no bonus', b.form.amount === 1999 && !b.seen.bonusDays && !b.form.founder);
  const legal = await (await fetch(`${BARE}/legal`)).text();
  check('/legal: no launch price and no founders offer terms', !/The launch price\.|The founders offer\.|\{\{/.test(legal) && /No VAT is charged/.test(legal));
}

check('no page threw an error', errs.length === 0, errs.join(' | '));
await browser.close();
stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
