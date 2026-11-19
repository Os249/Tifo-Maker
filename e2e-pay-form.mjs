/**
 * Payments v2 in a real browser: Moyasar's payment form on /pro, the
 * webhook-only mode and "Keep Pro on", against real servers and a stand-in
 * Moyasar (scripts/fake-moyasar.mjs). The form itself is Moyasar's real
 * script, as bundled; only api.moyasar.com and the bank's 3-D Secure page are
 * stood in for.
 *
 * Self-contained: it boots its own servers on memory repos. Needs a build:
 *   npm run build && node e2e-pay-form.mjs
 *
 * `node e2e-pay-form.mjs --serve` only boots the form server (port 8951) and
 * the stand-in and stays up, to look at /pro by hand: sign up as pay_fan.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const SERVE = process.argv.includes('--serve');
const PORT = 8951;        // the form, a secret key, auto-renew on
const PORT_HOOK = 8952;   // the webhook-only mode: no secret key
const PORT_OFF = 8953;    // payments v1 exactly as it ships: none of the new variables
const FAKE = 8954;
const B = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'e2e pay admin password';
const HOOK_SECRET = 'e2e-webhook-secret-of-some-length';
// What Moyasar's dashboard gives for Apple Pay: one long hex string (this one is made up).
const APPLE_FILE = '7B227073704964223A22' + 'AB12CD34'.repeat(40);
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);

const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
      AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PUBLIC_URL: '', AI_ADMIN_PASSWORD: ADMIN_PW,
      // Nothing of payments v2 unless a server below asks for it.
      PRO_CHECKOUT: '', MOYASAR_PUBLISHABLE_KEY: '', MOYASAR_VERIFY: '', PRO_AUTORENEW: '', PRO_AUTORENEW_MADA: '', MOYASAR_PROXY_URL: '',
      MOYASAR_METHODS: '', APPLE_PAY_DOMAIN_ASSOCIATION: '', MOYASAR_WEBHOOK_SECRET: '', MOYASAR_SECRET_KEY: '', PRO_PAYMENTS: '',
      MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const PREVIEW = 'pay_fan,pay_keep,pay_mada,pay_ar,pay_hook';
const servers = [
  boot(PORT, {
    PRO_MODE: 'preview', PRO_PREVIEW_USERS: PREVIEW, PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234',
    PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: 'pk_test_FAKEfake1234', MOYASAR_METHODS: 'creditcard,applepay', APPLE_PAY_DOMAIN_ASSOCIATION: APPLE_FILE,
    // mada switched off here, to see the form say so and a mada payment stay one-time; the default (mada renews) is in payments2.test.mts.
    PRO_AUTORENEW: 'on', PRO_AUTORENEW_MADA: 'off', MOYASAR_WEBHOOK_SECRET: HOOK_SECRET, PUBLIC_URL: B,
  }),
];
if (!SERVE) {
  servers.push(
    boot(PORT_HOOK, {
      PRO_MODE: 'preview', PRO_PREVIEW_USERS: PREVIEW, PRO_PAYMENTS: 'on', MOYASAR_VERIFY: 'webhook',
      MOYASAR_PUBLISHABLE_KEY: 'pk_test_FAKEfake1234', MOYASAR_WEBHOOK_SECRET: HOOK_SECRET,
    }),
    boot(PORT_OFF, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: PREVIEW, PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234' }),
  );
}
const stop = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } moyasar.close(); };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
for (const port of SERVE ? [PORT] : [PORT, PORT_HOOK, PORT_OFF]) {
  if (!(await up(`http://127.0.0.1:${port}`))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }
}

const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  return { token, email };
};

if (SERVE) {
  const fan = await account('pay_fan');
  console.log(`\nform server: ${B}/pro   (stand-in Moyasar on ${FAKE})\nsigned-up account: pay_fan / harbor-kite-moss-31\ntoken for localStorage.tifo_token_v1: ${fan.token}\n`);
  await new Promise(() => {});
}

// =====================================================================
const HOOK = `http://127.0.0.1:${PORT_HOOK}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const SHOTS = process.env.PAY_SHOTS || '';
const VISA = '4111111111111111';
const MADA = '4201320111111010';
const NO_FUNDS = '4000000000000002';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errs = [];
/** Everything a page sent to OUR server, to prove no card ever goes there. */
const sentToUs = [];
/** Every other origin a page tried to reach. */
const reached = new Set();
const page = async (token, { lang = 'en', w = 1440, h = 900, scheme = 'dark' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  // Moyasar's API, stood in for: the form's own requests, passed on as they are.
  await ctx.route('https://api.moyasar.com/**', async (r) => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const headers = { 'content-type': 'application/json' };
    const auth = await req.headerValue('authorization');
    if (auth) headers.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${FAKE}${u.pathname}${u.search}`, { method: req.method(), headers, body: req.postData() ?? undefined });
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
  });
  // The bank's 3-D Secure page, stood in for: the test decides how it ends.
  await ctx.route('https://3ds.moyasar.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Bank</title><h1>3-D Secure (stand-in)</h1>' }));
  await ctx.route('https://applepay.cdn-apple.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '/* Apple Pay SDK (stand-in) */' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname === '127.0.0.1') sentToUs.push(`${req.method()} ${u.pathname}${u.search} ${req.postData() ?? ''}`);
    else if (u.protocol.startsWith('http')) reached.add(u.host);
  });
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name, full = false) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); };
const paidText = (p) => p.evaluate(() => document.getElementById('pp-paid')?.textContent || '');

/** Open the form: "Get Pro", then Moyasar's fields are there. */
const openForm = async (p) => {
  await waitFor(p, () => !!document.querySelector('[data-act="buy"]:not([hidden])'));
  await p.click('[data-act="buy"]');
  return waitFor(p, () => !!document.querySelector('#mysr input[name="mysr-cc-number"]'), null, 20000);
};
/** Type a card into Moyasar's form and press its Pay button. */
const typeCard = async (p, number) => {
  // Typed key by key, as a fan does: the form masks and checks each field as it is typed.
  for (const [name, text] of [['name', 'Test Fan'], ['number', number], ['exp', '1230'], ['csc', '123']]) {
    await p.locator(`#mysr input[name="mysr-cc-${name}"]`).click();
    await p.locator(`#mysr input[name="mysr-cc-${name}"]`).pressSequentially(text, { delay: 15 });
  }
  await p.click('#mysr button[type="submit"]');
};
/** The bank's page ends: back to the callback address, as Moyasar sends the fan. */
const end3ds = async (p, outcome) => {
  if (!(await p.waitForURL(/3ds\.moyasar\.test/, { timeout: 20000 }).then(() => true).catch(() => false))) return null;
  const id = new URL(p.url()).searchParams.get('id');
  const pay = moyasar.payments.get(id);
  const q = moyasar.finish3ds(id, outcome);
  await p.goto(`${pay.callback_url}&${q}`, { waitUntil: 'domcontentloaded' });
  return pay;
};

const fan = await account('pay_fan');
const keeper = await account('pay_keep');
const madaFan = await account('pay_mada');
const arFan = await account('pay_ar');
const other = await account('pay_other');
const fanOff = await account('pay_fan', OFF);
const hookFan = await account('pay_hook', HOOK);

// =====================================================================
console.log('\n— none of the new variables set: payments v1, untouched —');
{
  const SITE_CSP = "default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data:;connect-src 'self';object-src 'none';frame-ancestors 'none';base-uri 'self';form-action 'self';script-src-attr 'none';upgrade-insecure-requests";
  const pro = await fetch(`${OFF}/pro`);
  check('/pro carries the site-wide policy, byte for byte', pro.headers.get('content-security-policy') === SITE_CSP, pro.headers.get('content-security-policy') ?? '');
  const st = (await api('/api/pro', fanOff.token, {}, OFF)).json;
  check('/api/pro: on sale, and says nothing of a form or auto-renew', st?.offer?.paymentsOpen === true && !('checkout' in st.offer) && !('autoRenew' in st.offer), JSON.stringify(st?.offer ?? null).slice(0, 160));
  const c = await api('/api/pro/pay/checkout', fanOff.token, { method: 'POST', body: '{"lang":"en"}' }, OFF);
  check('"Get Pro" still makes a hosted invoice', c.status === 200 && /^https:\/\/checkout\.moyasar\.test\//.test(c.json?.url ?? '') && !c.json.form, JSON.stringify(c.json));
  check('no "Keep Pro on" to tick', (await api('/api/pro/pay/keep', fanOff.token, { method: 'POST', body: JSON.stringify({ order: c.json.order, keep: true }) }, OFF)).status === 409);
  check('no auto-renew to read', (await api('/api/pro/renew', fanOff.token, {}, OFF)).status === 404);
  check('no Apple Pay file', (await fetch(`${OFF}/.well-known/apple-developer-merchantid-domain-association`)).status === 404);
  const legal = await (await fetch(`${OFF}/legal`)).text();
  check('/legal says nothing of auto-renew', !/auto-renew|Keep Pro on|data-pay="renew"/i.test(legal));
  const { ctx, p } = await page(fanOff.token);
  await p.goto(`${OFF}/pro`, { waitUntil: 'networkidle' });
  check('/pro: "Pay once on Moyasar\'s secure page", as before', await waitFor(p, () => /Pay once on Moyasar's secure page/.test(document.querySelector('.ps-steps')?.textContent || '') && /It never renews by itself/.test(document.querySelector('.pb-once')?.textContent || '')));
  await ctx.close();
}

// =====================================================================
console.log('\n— the payment form (PRO_CHECKOUT=form) —');
{
  const pro = await fetch(`${B}/pro`);
  const csp = pro.headers.get('content-security-policy') ?? '';
  check('/pro allows exactly what the form needs', csp === "default-src 'self';script-src 'self' https://applepay.cdn-apple.com;style-src 'self' 'unsafe-inline';font-src 'self' https://applepay.cdn-apple.com;img-src 'self' data:;connect-src 'self' https://api.moyasar.com;object-src 'none';frame-ancestors 'none';base-uri 'self';form-action 'self';script-src-attr 'none';upgrade-insecure-requests", csp);
  const home = (await fetch(`${B}/account`)).headers.get('content-security-policy') ?? '';
  check('…and no other page does', !/moyasar|apple/.test(home) && /connect-src 'self';/.test(home), home);
  const file = await fetch(`${B}/.well-known/apple-developer-merchantid-domain-association`);
  check('Apple Pay\'s domain file is served, as plain text, at its exact path', file.status === 200 && /^text\/plain/.test(file.headers.get('content-type') ?? '') && (await file.text()) === APPLE_FILE);
  check('…and not under any other name', (await fetch(`${B}/.well-known/apple-developer-merchantid-domain-association.txt`)).status === 404);

  const { ctx, p } = await page(fan.token);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro says the form is here', await waitFor(p, () => /Pay here, on Moyasar's secure form/.test(document.querySelector('.ps-steps')?.textContent || '')));
  const before = moyasar.calls.length;
  check('"Get Pro" opens Moyasar\'s form in the Pro column, without leaving the page', (await openForm(p)) && new URL(p.url()).pathname === '/pro');
  const ui = await p.evaluate(() => ({
    inPro: !!document.querySelector('.pp-plan.pro #mysr'),
    buyHidden: document.querySelector('[data-act="buy"]')?.hidden,
    blue: [...document.querySelectorAll('main .pp-btn:not(.quiet), #mysr button[type="submit"]')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()),
    keep: document.getElementById('pb-keep') ? { checked: document.getElementById('pb-keep').checked, terms: document.querySelector('.pb-keep')?.textContent } : null,
    state: document.getElementById('pb-keep-state')?.textContent,
    fields: [...document.querySelectorAll('#mysr input')].map((i) => ({ n: i.name, h: Math.round(i.getBoundingClientRect().height) })),
    payH: Math.round(document.querySelector('#mysr button[type="submit"]').getBoundingClientRect().height),
  }));
  check('…one blue button on the page: the form\'s Pay', ui.inPro && ui.buyHidden === true && ui.blue.length === 1 && /^Pay/.test(ui.blue[0]), JSON.stringify(ui.blue));
  check('…"Keep Pro on" is there and NOT ticked', ui.keep?.checked === false && /Not ticked: one payment/.test(ui.state || ''), ui.state);
  check('…with the price, the next renewal date, the reminder and the cancel promise, and what can renew', /SAR 19\.99 now, then SAR 19\.99 every 30 days until you cancel\. The first renewal is on \d+ \w+ 20\d\d/.test(ui.keep?.terms || '') && /email you 3 days before/.test(ui.keep.terms) && /cancel with one click/.test(ui.keep.terms) && /mada cards can't renew yet/.test(ui.keep.terms), ui.keep?.terms);
  check('…fields and the Pay button are easy to tap', ui.fields.length === 4 && ui.fields.every((f) => f.h >= 44) && ui.payH >= 44, JSON.stringify(ui.fields));
  check('…nothing was sent to Moyasar by opening it (one read of the order\'s payment id, from the server)', moyasar.calls.slice(before).every((c) => c.method === 'GET' && c.key === 'sk'), JSON.stringify(moyasar.calls.slice(before).map((c) => `${c.method} ${c.path}`)));
  await p.locator('.pb-buy').scrollIntoViewIfNeeded();
  await shot(p, 'form-desktop-en-dark');

  // "Not now" closes it; opening again is the same order (nothing exists at Moyasar for it).
  const order1 = [...sentToUs].reverse().find((x) => x.startsWith('POST /api/pro/pay/checkout'));
  await p.click('[data-act="form-close"]');
  check('"Not now" closes the form and brings "Get Pro" back', await waitFor(p, () => document.getElementById('pb-form').hidden && !document.querySelector('[data-act="buy"]').hidden));

  // ---- every way the bank's page can end, and what the fan is told
  const outcomes = [
    ['auth', /didn't confirm it was you.*nothing was charged/],
    ['cancelled', /cancelled or ran out of time.*nothing was charged/],
    ['unavailable', /can't do the bank's online check.*nothing was charged/],
    ['rejected', /refused this payment.*nothing was charged/],
    ['error', /went wrong at the bank's end.*nothing was charged/],
  ];
  for (const [outcome, words] of outcomes) {
    await openForm(p);
    await typeCard(p, VISA);
    const pay = await end3ds(p, outcome);
    const said = (await waitFor(p, (re) => new RegExp(re).test(document.getElementById('pp-paid')?.textContent || ''), words.source, 15000));
    check(`3-D Secure "${outcome}": the page says so, and that nothing was charged`, !!pay && said, await paidText(p));
    if (outcome === 'auth') {
      check('…the address bar is clean (no order, payment id, status or message)', await p.evaluate(() => location.search === ''));
      check('…the payment was made under the id the server chose, naming the order', pay.metadata?.order_id && /^[0-9a-f-]{36}$/.test(pay.id) && (await api(`/api/pro/pay/order/${pay.metadata.order_id}`, fan.token)).json?.why === 'auth');
    }
  }
  check('…still free after five failures', (await api('/api/pro', fan.token)).json.plan === 'free');

  // ---- a card the bank declines at once (no 3-D Secure page at all)
  await openForm(p);
  await typeCard(p, NO_FUNDS);
  const declined = await waitFor(p, () => /enough balance.*nothing was charged/.test(document.getElementById('pp-paid')?.textContent || '') || /INSUFFICIENT|declin|fail/i.test(document.getElementById('mysr')?.textContent || ''), null, 15000);
  check('declined for no funds: said, nothing charged', declined, `${await paidText(p)} | ${(await p.evaluate(() => document.getElementById('mysr')?.textContent || '')).slice(0, 120)}`);

  // ---- the browser's Back button from the bank's page
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await openForm(p);
  await typeCard(p, VISA);
  await p.waitForURL(/3ds\.moyasar\.test/, { timeout: 20000 }).catch(() => {});
  await p.goBack({ waitUntil: 'domcontentloaded' });
  check('Back from the bank\'s page: /pro again, and "Get Pro" works (a new order, a new payment id)', (await openForm(p)) && (await p.evaluate(() => !!document.querySelector('#mysr input'))));
  const ids = moyasar.calls.filter((c) => c.method === 'POST' && c.path === '/v1/payments').map((c) => c.body.given_id);
  check('…every payment so far has its own id', new Set(ids).size === ids.length && ids.length >= 7, String(ids.length));

  // ---- and paying, not ticked: Pro, once, no card kept
  await typeCard(p, VISA);
  const paid = await end3ds(p, 'paid');
  check('paid: "Payment received! Pro is on until …"', await waitFor(p, () => /Payment received! Pro is on until/.test(document.getElementById('pp-paid')?.textContent || '')), await paidText(p));
  const st = (await api('/api/pro', fan.token)).json;
  check('…the server gave a month of Pro', st.plan === 'monthly' && st.supporter === true);
  const sent = moyasar.calls.filter((c) => c.method === 'POST' && c.path === '/v1/payments' && c.body.given_id === paid.id)[0];
  check('…the form asked Moyasar with the publishable key, never to save the card', sent?.key === 'pk' && sent.body.source.save_card !== true && paid.source.token === null, JSON.stringify(sent?.body?.source?.save_card));
  check('…no auto-renew, and the receipt promises none', (await api('/api/pro/renew', fan.token)).json?.sub === null && /\[email:dev\] to=pay_fan@tifomaker-e2e\.org \| \[TEST\] [^\n]*receipt/.test(out.join('')) && !/Auto-renew is on/.test(out.join('')));
  check('holding a month: the date instead of the button', await waitFor(p, () => !document.querySelector('[data-act="buy"]') && /You have Pro until/.test(document.querySelector('.pb-buy')?.textContent || '')));
  await ctx.close();
  void order1;
}

// =====================================================================
console.log('\n— no card ever reaches our server —');
{
  const cards = [VISA, MADA, NO_FUNDS, '4111 1111 1111 1111'];
  check('nothing sent to our server holds a card number or a CVC field', !sentToUs.some((x) => cards.some((c) => x.includes(c)) || /cvc|csc|"number"/i.test(x)), sentToUs.find((x) => /cvc|csc|"number"/i.test(x)) ?? '');
  check('nor do the server\'s logs', !cards.some((c) => out.join('').includes(c)));
  check('the pages reached only Moyasar, the bank and Apple beyond our own server', [...reached].every((h) => ['api.moyasar.com', '3ds.moyasar.test', 'applepay.cdn-apple.com'].includes(h)), [...reached].join(','));
}

// =====================================================================
console.log('\n— "Keep Pro on" (PRO_AUTORENEW=on) —');
let cancelLink = null;
{
  const { ctx, p } = await page(keeper.token, { scheme: 'light' });
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await openForm(p);
  await p.locator('.pb-buy').scrollIntoViewIfNeeded();
  await shot(p, 'form-desktop-en-light');
  await p.fill('#mysr input[name="mysr-cc-name"]', 'Typed Before Ticking');
  await p.click('#pb-keep');
  check('ticking it: the server is told first, then the form says the card will be saved', await waitFor(p, () => document.getElementById('pb-keep')?.checked === true && /Auto-renew is on for this payment/.test(document.getElementById('pb-keep-state')?.textContent || '') && !!document.querySelector('#mysr input[name="mysr-cc-number"]')));
  check('…as an explicit request from this account', sentToUs.some((x) => /^POST \/api\/pro\/pay\/keep .*"keep":true/.test(x)));
  await shot(p, 'form-keep-ticked');
  // Unticking takes it back.
  await p.click('#pb-keep');
  check('unticking it takes it back', await waitFor(p, () => document.getElementById('pb-keep')?.checked === false && /Not ticked/.test(document.getElementById('pb-keep-state')?.textContent || '')) && sentToUs.some((x) => /^POST \/api\/pro\/pay\/keep .*"keep":false/.test(x)));
  await p.click('#pb-keep');
  await waitFor(p, () => document.getElementById('pb-keep')?.checked === true && !!document.querySelector('#mysr input[name="mysr-cc-number"]'));
  await typeCard(p, VISA);
  const pay = await end3ds(p, 'paid');
  check('paid with it ticked: "…and renews that day"', await waitFor(p, () => /Pro is on until .* and renews that day/.test(document.getElementById('pp-paid')?.textContent || '')), await paidText(p));
  const sent = moyasar.calls.filter((c) => c.method === 'POST' && c.path === '/v1/payments' && c.body.given_id === pay.id)[0];
  check('…the form asked Moyasar to save the card, and Moyasar gave a token', sent?.body?.source?.save_card === true && /^token_/.test(pay.source.token ?? ''));
  const rn = (await api('/api/pro/renew', keeper.token)).json;
  const passEnd = (await api('/api/pro', keeper.token)).json.pass.endsAt;
  check('…auto-renew is on: SAR 19.99 every 30 days from the Visa ending 1111, due when the month ends', rn?.sub?.status === 'active' && rn.sub.amount === 19.99 && rn.sub.days === 30 && rn.sub.lastFour === '1111' && rn.sub.nextAt === passEnd && !JSON.stringify(rn).includes('token_'), JSON.stringify(rn));
  const mail = [...out.join('').matchAll(/\[email:dev\] to=pay_keep@tifomaker-e2e\.org \| \[TEST\] [^\n]*receipt[\s\S]*?Turn it off: (\S+)/g)].pop();
  cancelLink = mail?.[1] ?? null;
  check('…the receipt says it renews, when, for how much, with the one-click link', !!cancelLink && /\/pro\?stop=[A-Za-z0-9_-]{24,}$/.test(cancelLink), cancelLink ?? '');

  // The account page: when, how much, which card, and one button.
  await p.goto(`${B}/account#pro`, { waitUntil: 'networkidle' });
  check('/account: "Renews on … for SAR 19.99, from Visa ending 1111" and "Turn off auto-renew"', await waitFor(p, () => /Renews on .* for SAR 19.99, from Visa ending 1111/.test(document.querySelector('.pro-renew')?.textContent || '') && !!document.querySelector('[data-act="renew-off"]')), await p.evaluate(() => document.querySelector('.pro-renew')?.textContent || ''));
  await p.locator('.pro-renew').scrollIntoViewIfNeeded();
  await shot(p, 'account-renew');
  const exp = (await api('/api/account/export', keeper.token)).json;
  check('the data export says a card is saved and which, without the token', exp?.pro?.autoRenew?.cardSaved === true && exp.pro.autoRenew.lastFour === '1111' && !JSON.stringify(exp).includes('token_'), JSON.stringify(exp?.pro?.autoRenew));
  await p.click('[data-act="renew-off"]');
  check('one click turns it off: "Pro stays on until the days you paid for end"', await waitFor(p, () => /Auto-renew is off\. Pro stays on/.test(document.querySelector('.pro-renew')?.textContent || '') && !document.querySelector('[data-act="renew-off"]')), await p.evaluate(() => document.querySelector('.pro-renew')?.textContent || ''));
  check('…the saved card is deleted at Moyasar, and Pro is still on', !moyasar.tokens.has(pay.source.token) && (await api('/api/pro', keeper.token)).json.plan === 'monthly' && (await api('/api/pro/renew', keeper.token)).json.sub.status === 'cancelled');
  check('…and an email confirms it', /\[email:dev\] to=pay_keep@tifomaker-e2e\.org \| \[TEST\] [^\n]*auto-renew is off/.test(out.join('')));
  await ctx.close();
}

// ---- mada: the month is given, the card is not kept
{
  const { ctx, p } = await page(madaFan.token);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await openForm(p);
  await p.click('#pb-keep');
  await waitFor(p, () => document.getElementById('pb-keep')?.checked === true && !!document.querySelector('#mysr input[name="mysr-cc-number"]'));
  await typeCard(p, MADA);
  const pay = await end3ds(p, 'paid');
  check('mada with it ticked: Pro is on, as a one-time month, and the page says so', !!pay && (await waitFor(p, () => /Auto-renew couldn't be set up with this payment method.*nothing will be charged again/.test(document.getElementById('pp-paid')?.textContent || ''))), await paidText(p));
  check('…no auto-renew, and the token Moyasar made is deleted at once', pay?.source.company === 'mada' && (await api('/api/pro/renew', madaFan.token)).json?.sub === null && !moyasar.tokens.has(pay.source.token) && (await api('/api/pro', madaFan.token)).json.plan === 'monthly');

  // The one-click link from an email: no sign-in, and it can only turn renewal off.
  // (pay_mada has none; the link is pay_keep's, already off: the page still answers plainly.)
  const anon = await page(null);
  await anon.p.goto(cancelLink, { waitUntil: 'domcontentloaded' });
  check('the email\'s link, signed out: "Auto-renew is off … Pro stays on until …"', await waitFor(anon.p, () => /Auto-renew is off\. Nothing more will be charged/.test(document.getElementById('pp-paid')?.textContent || '')), await paidText(anon.p));
  check('…and the link leaves the address bar', await anon.p.evaluate(() => !location.search.includes('stop=')));
  await anon.p.goto(`${B}/pro?stop=${'x'.repeat(32)}`, { waitUntil: 'domcontentloaded' });
  check('a made-up link turns nothing off and says it didn\'t work', await waitFor(anon.p, () => /This link didn't work/.test(document.getElementById('pp-paid')?.textContent || '')));
  await anon.ctx.close();
  await ctx.close();
}

// =====================================================================
console.log('\n— in Arabic, on a phone —');
{
  const { ctx, p } = await page(arFan.token, { lang: 'ar', w: 390, h: 844 });
  await p.goto(`${B}/ar/pro`, { waitUntil: 'networkidle' });
  check('Arabic: the form opens', await openForm(p));
  const fit = await p.evaluate(() => {
    const box = document.querySelector('.pb-buy');
    const form = document.getElementById('mysr');
    const keep = document.querySelector('.pb-keep');
    return {
      over: document.documentElement.scrollWidth - innerWidth,
      formIn: form.getBoundingClientRect().left >= box.getBoundingClientRect().left - 1 && form.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1,
      keepH: Math.round(keep.getBoundingClientRect().height), dir: getComputedStyle(keep).direction,
      terms: keep.textContent, labels: [...document.querySelectorAll('#mysr label, #mysr legend')].map((l) => l.textContent),
      payH: Math.round(document.querySelector('#mysr button[type="submit"]').getBoundingClientRect().height),
      fonts: [...document.querySelectorAll('#mysr input')].map((i) => parseFloat(getComputedStyle(i).fontSize)),
      latin: /[A-Za-z]{4,}/.test((keep.textContent + document.getElementById('pb-keep-state').textContent + document.querySelector('[data-act="form-close"]').textContent).replace(/Apple Pay|Samsung Pay/g, '')),
    };
  });
  check('…nothing off the side, the form inside its box, right to left', fit.over <= 0 && fit.formIn && fit.dir === 'rtl', JSON.stringify({ over: fit.over, formIn: fit.formIn, dir: fit.dir }));
  check('…"Keep Pro on" in Arabic, with the date and the price, no English left', /خلّ برو شغّال: تجديد كل 30 يوم/.test(fit.terms) && /19\.99 ريال الحين، وبعدها 19\.99 ريال كل 30 يوم لين تلغي/.test(fit.terms) && !fit.latin, fit.terms);
  check('…Moyasar\'s own labels are Arabic too', fit.labels.length > 0 && fit.labels.every((l) => /[؀-ۿ]/.test(l)), fit.labels.join(' | '));
  check('…fields at 16px (no zoom on iPhone) and a 44px Pay button', fit.fonts.every((f) => f >= 16) && fit.payH >= 44, JSON.stringify(fit.fonts));
  await p.locator('.pb-keep').scrollIntoViewIfNeeded();
  await shot(p, 'form-phone-ar-top');
  await p.locator('#mysr button[type="submit"]').scrollIntoViewIfNeeded();
  await shot(p, 'form-phone-ar-form');
  await typeCard(p, VISA);
  await end3ds(p, 'cancelled');
  check('…back from the bank, in Arabic: on /ar/pro, nothing charged', await waitFor(p, () => location.pathname === '/ar/pro' && /ما انخصم منك شي/.test(document.getElementById('pp-paid')?.textContent || '')), await paidText(p));
  await shot(p, 'form-phone-ar-failed');
  await ctx.close();
  const en = await page(arFan.token, { w: 390, h: 844, scheme: 'light' });
  await en.p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await openForm(en.p);
  await en.p.locator('.pb-keep').scrollIntoViewIfNeeded();
  check('English on a phone: nothing off the side', (await en.p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await shot(en.p, 'form-phone-en-light');
  await en.ctx.close();
}

// =====================================================================
console.log('\n— someone outside the preview, and /admin —');
{
  check('cannot open a checkout', (await api('/api/pro/pay/checkout', other.token, { method: 'POST', body: '{}' })).status === 404);
  check('cannot tick "Keep Pro on" on someone else\'s order', (await api('/api/pro/pay/keep', other.token, { method: 'POST', body: JSON.stringify({ order: '00000000-0000-4000-8000-000000000000', keep: true }) })).status === 409);
  check('the admin lists are closed to them', (await api('/api/admin/pro/subscriptions', other.token)).status === 403 && (await api('/api/admin/pro/subscription/cancel', other.token, { method: 'POST', body: '{}' })).status === 403);
  const { ctx, p } = await page(null, { w: 1360, h: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', ADMIN_PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="pro"]');
  check('/admin Pro tab: how payments are set up, and the auto-renew table', await waitFor(p, () => /the payment form on \/pro \(creditcard, applepay\)/.test(document.body.textContent) && /auto-renew is ON \(mada excluded\)/.test(document.body.textContent) && /Auto-renew/.test(document.body.textContent) && /@pay_keep/.test(document.querySelector('.sub-off')?.closest('table')?.textContent ?? document.body.textContent), null, 15000));
  await p.evaluate(() => [...document.querySelectorAll('h2.sec')].find((h) => /Auto-renew/.test(h.textContent))?.scrollIntoView());
  await shot(p, 'admin-renew');
  await ctx.close();
}

// =====================================================================
console.log('\n— no secret key on the server (MOYASAR_VERIFY=webhook) —');
{
  const hook = (payload) => api('/api/pro/pay/webhook', null, { method: 'POST', body: JSON.stringify(payload) }, HOOK);
  const st = (await api('/api/pro', hookFan.token, {}, HOOK)).json;
  check('Pro is on sale, through the form, with no auto-renew', st?.offer?.paymentsOpen === true && st.offer.checkout === 'form' && !st.offer.autoRenew, JSON.stringify(st?.offer).slice(0, 200));
  const { ctx, p } = await page(hookFan.token);
  const callsBefore = moyasar.calls.length;
  await p.goto(`${HOOK}/pro`, { waitUntil: 'networkidle' });
  check('the form opens, with no "Keep Pro on"', (await openForm(p)) && (await p.evaluate(() => !document.getElementById('pb-keep'))));
  await typeCard(p, VISA);
  const pay = await end3ds(p, 'paid');
  check('back from the bank: "Checking your payment…" (the server cannot ask Moyasar)', await waitFor(p, () => /Checking your payment/.test(document.getElementById('pp-paid')?.textContent || ''), null, 8000), await paidText(p));
  check('…this server made no call to Moyasar at all', moyasar.calls.slice(callsBefore).every((c) => c.key === 'pk'), JSON.stringify(moyasar.calls.slice(callsBefore).filter((c) => c.key !== 'pk').map((c) => c.path)));
  const event = { id: 'evt', type: 'payment_paid', live: false, secret_token: HOOK_SECRET, data: moyasar.payments.get(pay.id) };
  check('a "paid" webhook without the secret is refused', (await hook({ ...event, secret_token: 'not-the-secret-at-all-no' })).status === 401 && (await api('/api/pro', hookFan.token, {}, HOOK)).json.plan === 'free');
  check('…one that says it is live money on a test key is ignored', (await hook({ ...event, live: true })).status === 200 && (await api('/api/pro', hookFan.token, {}, HOOK)).json.plan === 'free');
  check('…one for a payment id that is not this order gives nothing', (await hook({ ...event, data: { ...event.data, id: event.data.id.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } })).status === 200 && (await api('/api/pro', hookFan.token, {}, HOOK)).json.plan === 'free');
  check('Moyasar\'s webhook, with the secret: Pro turns on', (await hook(event)).status === 200 && (await api('/api/pro', hookFan.token, {}, HOOK)).json.plan === 'monthly');
  check('…and the page that was waiting says so', await waitFor(p, () => /Payment received! Pro is on until/.test(document.getElementById('pp-paid')?.textContent || ''), null, 20000), await paidText(p));
  const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) }, HOOK)).json?.token;
  const orders = (await api('/api/admin/pro/orders', null, { headers: { 'x-ai-unlock': unlock } }, HOOK)).json;
  const o = orders?.orders?.find((x) => x.status === 'paid');
  const refund = await api('/api/admin/pro/refund', null, { method: 'POST', headers: { 'x-ai-unlock': unlock }, body: JSON.stringify({ orderId: o?.id }) }, HOOK);
  check('/admin cannot refund here: "in Moyasar\'s dashboard"', orders?.status?.verify === 'webhook' && refund.status === 409 && refund.json?.reason === 'dashboard', JSON.stringify(refund.json));
  const refunded = { ...moyasar.payments.get(pay.id), status: 'refunded', refunded: 1999 };
  check('a refund made in Moyasar\'s dashboard arrives by webhook and ends the pass', (await hook({ ...event, type: 'payment_refunded', data: refunded })).status === 200 && (await api('/api/pro', hookFan.token, {}, HOOK)).json.plan === 'free');
  await ctx.close();
}

check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
stop();
console.log(`\ne2e-pay-form: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
