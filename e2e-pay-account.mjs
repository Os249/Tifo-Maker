/**
 * "Pro and purchases" in a real browser (19 Nov 2026): the account page's
 * purchase list, receipts and "Request a refund", the owner's queue in
 * /admin, the one-time notice after a refund, auto-renew's one button, and
 * the PRO_AUTO_REFUND switch, against real servers and a stand-in Moyasar
 * (scripts/fake-moyasar.mjs). Orders are paid through the API the payment
 * form uses (the form itself is e2e-pay-form.mjs's subject).
 *
 * Self-contained: it boots its own servers on memory repos. Needs a build:
 *   npm run build && node e2e-pay-account.mjs
 *
 * PAY_SHOTS=<folder> saves screenshots of each new piece there.
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8961;        // the form, a secret key, auto-renew on: requests wait for the owner
const PORT_AUTO = 8962;   // the same, with PRO_AUTO_REFUND=on
const PORT_OFF = 8963;    // nothing set at all: the site as it is today
const FAKE = 8964;
const B = `http://127.0.0.1:${PORT}`;
const AUTO = `http://127.0.0.1:${PORT_AUTO}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const ADMIN_PW = 'e2e account admin password';
const HOOK_SECRET = 'e2e-webhook-secret-of-some-length';
const PK = 'pk_test_FAKEfake1234';
const OWNER = 'osamah9070@gmail.com';
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);

const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
      AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PUBLIC_URL: '', AI_ADMIN_PASSWORD: ADMIN_PW,
      PRO_MODE: '', PRO_PREVIEW_USERS: '', PRO_CHECKOUT: '', MOYASAR_PUBLISHABLE_KEY: '', MOYASAR_VERIFY: '', PRO_AUTORENEW: '', PRO_AUTORENEW_MADA: '', MOYASAR_PROXY_URL: '',
      MOYASAR_METHODS: '', APPLE_PAY_DOMAIN_ASSOCIATION: '', MOYASAR_WEBHOOK_SECRET: '', MOYASAR_SECRET_KEY: '', PRO_PAYMENTS: '', PRO_AUTO_REFUND: '',
      MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const PREVIEW = 'acc_fan,acc_two,acc_three,acc_hook,acc_keep,acc_new,acc_ar,acc_auto,acc_gift';
const ON = {
  PRO_MODE: 'preview', PRO_PREVIEW_USERS: PREVIEW, PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234',
  PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK, PRO_AUTORENEW: 'on', MOYASAR_WEBHOOK_SECRET: HOOK_SECRET,
};
const servers = [
  boot(PORT, { ...ON, PUBLIC_URL: B }),
  boot(PORT_AUTO, { ...ON, PUBLIC_URL: AUTO, PRO_AUTO_REFUND: 'on' }),
  boot(PORT_OFF, {}),
];
const stop = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } moyasar.close(); };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
for (const base of [B, AUTO, OFF]) {
  if (!(await up(base))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }
}

const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await sleep(250);
  }
  return null;
};
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  return { token, email, username };
};
/** How many emails with this subject the dev mail log shows for an address. */
const mails = (email, subject) => [...out.join('').matchAll(/\[email:dev\] to=(\S+) \| ([^\n]*)/g)].filter((m) => m[1] === email && subject.test(m[2])).length;
const mailsSoon = async (email, subject, n) => {
  for (let i = 0; i < 40 && mails(email, subject) < n; i++) await sleep(150);
  return mails(email, subject);
};

const VISA = '4111111111111111';
const MADA = '4201320111111010';
/** Buy a month the way the payment form does: the server's order, a payment at "Moyasar" under its id, 3-D Secure, the return. */
const buy = async (who, { card = VISA, keep = false, base = B } = {}) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: '{"lang":"en"}' }, base);
  if (!c.json?.form) throw new Error(`checkout: ${JSON.stringify(c.json)}`);
  const f = c.json.form;
  if (keep) await api('/api/pro/pay/keep', who.token, { method: 'POST', body: JSON.stringify({ order: c.json.order, keep: true }) }, base);
  const made = await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl,
      metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: card, month: '12', year: '30', cvc: '123', ...(keep ? { save_card: true } : {}) },
    }),
  });
  if (made.status !== 201) throw new Error(`payment: ${made.status}`);
  moyasar.finish3ds(f.givenId, 'paid');
  const seen = await api(`/api/pro/pay/order/${c.json.order}`, who.token, {}, base);
  if (seen.json?.status !== 'paid') throw new Error(`not paid: ${JSON.stringify(seen.json)}`);
  return { order: c.json.order, payment: f.givenId };
};

// =====================================================================
const SHOTS = process.env.PAY_SHOTS || '';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

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
const waitFor = (p, fn, arg = null, ms = 20000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name, sel = null) => {
  if (!SHOTS) return;
  if (sel) await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {});
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const openAccount = async (p, base = B, path = '/account') => {
  await p.goto(`${base}${path}#pro`, { waitUntil: 'networkidle' });
  return waitFor(p, () => !document.getElementById('ac-sections')?.hidden);
};

const fan = await account('acc_fan');
const two = await account('acc_two');
const three = await account('acc_three');
const hooked = await account('acc_hook');
const keeper = await account('acc_keep');
const fresh = await account('acc_new');
const arFan = await account('acc_ar');
const outsider = await account('acc_outside');
const lucky = await account('acc_auto', AUTO);
const offFan = await account('acc_fan', OFF);
const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).json?.token;
const asBoss = { 'x-ai-unlock': unlock };

// =====================================================================
console.log('\n— nothing set: the site as it is today —');
{
  const st = (await api('/api/pro', offFan.token, {}, OFF)).json;
  check('/api/pro says nothing of purchases or refunds', st && !('purchases' in st) && !('refundNotice' in st), JSON.stringify(st).slice(0, 120));
  check('no purchases route', (await api('/api/pro/purchases', offFan.token, {}, OFF)).status === 404);
  check('no refund to ask for', (await api('/api/pro/purchases/refund', offFan.token, { method: 'POST', body: JSON.stringify({ order: '00000000-0000-4000-8000-000000000000' }) }, OFF)).status === 404);
  const { ctx, p } = await page(offFan.token);
  await openAccount(p, OFF);
  await sleep(600);
  const seen = await p.evaluate(() => ({ pro: document.getElementById('pro')?.hidden, pu: !!document.querySelector('.pu, .pu-order, .pro-refunded, [data-act="get"]'), link: document.querySelector('.ac-link[data-to="billing"]')?.hidden, plan: document.getElementById('ac-sum-plan')?.hidden, area: document.getElementById('main')?.dataset.area }));
  check('the account page has no Pro: no section, no purchases, no billing area in the list, no plan in the summary', seen.pro === true && !seen.pu && seen.link === true && seen.plan === true, JSON.stringify(seen));
  check('…and the old #pro address lands on the overview, not on an empty area', seen.area === 'overview' || seen.area === 'profile', String(seen.area));
  await p.goto(`${OFF}/projects`, { waitUntil: 'networkidle' });
  check('My projects shows no refund card', await p.evaluate(() => !document.querySelector('.pro-card-refund:not([hidden])')));
  const legal = await (await fetch(`${OFF}/legal`)).text();
  check('/legal says nothing of refund requests', !/Request a refund|Pro and purchases|اطلب استرداد/.test(legal));
  await ctx.close();
}

// =====================================================================
console.log('\n— Pro on sale to this account, nothing bought yet —');
{
  const { ctx, p } = await page(fresh.token);
  await openAccount(p);
  check('one area, "Pro and billing", opened by #pro, with the plan', await waitFor(p, () => document.getElementById('main')?.dataset.area === 'billing' && document.getElementById('pro-ac-h')?.textContent === 'Pro and billing' && /Free/.test(document.querySelector('#pro .ac-value')?.textContent || '')), await text(p, '#pro'));
  const ui = await p.evaluate(() => ({ get: document.querySelector('#pro [data-act="get"]')?.textContent, href: document.querySelector('#pro [data-act="get"]')?.getAttribute('href'), list: !!document.querySelector('#pro .pu-order'), empty: document.querySelector('#pro .pu .ac-empty')?.textContent, what: !!document.querySelector('#pro [data-act="what"]'), gold: document.querySelector('#pro [data-act="get"]')?.classList.contains('pro-btn'), note: document.querySelector('#pro .pro-plan .ac-note')?.textContent }));
  check('…one calm invitation: "TifoMaker stays free", a gold-tinted "Get Pro" link to /pro and "What Pro adds"', ui.get === 'Get Pro for SAR 19.99' && ui.href === '/pro' && ui.gold === true && ui.what && /TifoMaker stays free/.test(ui.note || ''), JSON.stringify(ui));
  check('…and no purchases yet, said where the receipts will be', !ui.list && /No purchases yet/.test(ui.empty || ''), JSON.stringify(ui));
  await shot(p, 'account-never-bought', '#pro');
  await ctx.close();
  const o = await page(outsider.token);
  await openAccount(o.p);
  await sleep(500);
  check('an account Pro is not on sale to sees none of it', await o.p.evaluate(() => document.getElementById('pro')?.hidden === true));
  await o.ctx.close();
}

// =====================================================================
console.log('\n— a gift: how many days are left —');
{
  const gifted = await account('acc_gift');
  const [tpl] = (await api('/api/templates')).json;
  const cellsGzB64 = gzipSync(new Uint8Array(tpl.seatCount)).toString('base64');
  await api('/api/designs', gifted.token, { method: 'POST', body: JSON.stringify({ title: 'gift wall', templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64 }) });
  await api('/api/pro', gifted.token);
  const took = await api('/api/pro/gift/accept', gifted.token, { method: 'POST', body: '{}' });
  const { ctx, p } = await page(gifted.token);
  await openAccount(p);
  check('the gift shows the day it ends and "7 days left"', took.status === 200 && (await waitFor(p, () => /Pro gift/.test(document.querySelector('#pro .ac-value')?.textContent || '') && document.querySelector('#pro [data-gift-left]')?.textContent === '7 days left' && /^Ends /.test(document.querySelector('#pro .ac-row .ac-badge[data-state="ok"]')?.textContent || ''))), await text(p, '#pro .ac-row'));
  check('…with the way to Pro for when it ends, and no purchases to list', await p.evaluate(() => document.querySelector('#pro [data-act="get"]')?.textContent === 'Get Pro for SAR 19.99' && !document.querySelector('#pro .pu-order') && /No purchases yet/.test(document.querySelector('#pro .pu .ac-empty')?.textContent || '')));
  check('…and what happens when the gift ends: back to Free, nothing charged', await p.evaluate(() => /the gift ends and your account goes back to Free\. Nothing is charged/.test(document.querySelector('#pro .pro-when')?.textContent || '')));
  await shot(p, 'account-gift', '#pro');
  await ctx.close();
}

// =====================================================================
console.log('\n— the purchase list, the receipt, and asking for a refund —');
let fanOrder;
{
  fanOrder = await buy(fan, { card: MADA });
  const { ctx, p } = await page(fan.token);
  await openAccount(p);
  check('the order is listed: what, when, how much, how it was paid, where it stands', await waitFor(p, () => {
    const o = document.querySelector('.pu-order');
    return !!o && /Pro, 30 days/.test(o.textContent) && /Paid/.test(o.querySelector('.ac-badge')?.textContent || '') && /SAR 19.99/.test(o.querySelector('.pu-amt')?.textContent || '') && /\d{1,2} \w+ 20\d\d · mada · Test payment/.test(o.querySelector('.pu-meta')?.textContent || '');
  }), await text(p, '.pu-order'));
  check('…with whether it still qualifies for a refund, and until when', /You can ask for a refund until \d{1,2} \w+ 20\d\d\./.test(await text(p, '.pu-refund')), await text(p, '.pu-refund'));
  check('…and the plan above it: Pro monthly, with the day it ends', await p.evaluate(() => /Pro monthly/.test(document.querySelector('#pro .ac-value')?.textContent || '') && /^Ends /.test(document.querySelector('#pro .ac-row .ac-badge')?.textContent || '')));
  check('no second blue button: the section\'s buttons are all plain', await p.evaluate(() => !document.querySelector('#pro .ac-btn.primary')));
  // The receipt: open it here, or send it again.
  await p.click('.pu-receipt > summary');
  const lines = await text(p, '.pu-lines');
  check('the receipt opens in place: item, amount, date, method, Pro until, reference', /Item\s*Pro, 30 days/.test(lines) && /Amount\s*SAR 19.99/.test(lines) && /Paid with\s*mada/.test(lines) && /Pro until/.test(lines) && lines.includes(fanOrder.payment), lines);
  await shot(p, 'account-purchase-desktop-en', '.pu');
  const before = mails(fan.email, /receipt/i);
  await p.click('[data-act="receipt"]');
  check('"Email me this receipt" sends it to the account\'s address', (await waitFor(p, () => /Sent to your email\./.test(document.querySelector('.pu-msg')?.textContent || ''))) && (await mailsSoon(fan.email, /receipt/i, before + 1)) === before + 1, await text(p, '.pu-msg'));
  check('…and the receipt stays open after it', await p.evaluate(() => document.querySelector('.pu-receipt')?.open === true));
  await p.click('[data-act="receipt"]');
  check('…pressed again straight away: "We sent it a moment ago", and no second email', (await waitFor(p, () => /We sent it a moment ago/.test(document.querySelector('.pu-msg')?.textContent || ''))) && mails(fan.email, /receipt/i) === before + 1);

  // Request a refund: two steps, and cancel takes it back.
  await p.click('[data-act="refund-ask"]');
  check('"Request a refund" asks first: the amount, what happens, an optional note', await waitFor(p, () => /Ask for SAR 19.99 back\? If it's approved, this month of Pro ends\./.test(document.querySelector('.pu-ask')?.textContent || '') && document.activeElement?.tagName === 'TEXTAREA'), await text(p, '.pu-ask'));
  await shot(p, 'account-refund-ask', '.pu-ask');
  await p.click('[data-act="refund-cancel"]');
  check('…Cancel takes it back, and nothing was asked', (await waitFor(p, () => !document.querySelector('.pu-ask') && !!document.querySelector('[data-act="refund-ask"]'))) && (await api('/api/admin/pro/refund-requests', null, { headers: asBoss })).json.requests.length === 0);
  await p.click('[data-act="refund-ask"]');
  await p.fill('.pu-ask textarea', 'Bought it on the wrong account');
  await p.click('[data-act="refund-send"]');
  check('sent: "Request sent…", and the order now says it was requested', await waitFor(p, () => /Request sent\. We've emailed you a confirmation/.test(document.querySelector('.pu-msg')?.textContent || '') && /Refund requested on .* within 3 working days, and Pro stays on/.test(document.querySelector('.pu-refund')?.textContent || '') && !document.querySelector('[data-act="refund-ask"]')), await text(p, '.pu-order'));
  check('…Pro is still on: a request refunds nothing by itself', (await api('/api/pro', fan.token)).json.plan === 'monthly' && !moyasar.calls.some((c) => /\/refund$/.test(c.path)));
  check('…the fan is emailed that it arrived, and the owner that it is waiting', (await mailsSoon(fan.email, /We got your refund request/, 1)) === 1 && (await mailsSoon(OWNER, /Refund request from @acc_fan: SAR 19.99/, 1)) === 1);
  await shot(p, 'account-refund-requested', '.pu');
  await ctx.close();
  check('someone else cannot ask for it, or see it', (await api('/api/pro/purchases/refund', two.token, { method: 'POST', body: JSON.stringify({ order: fanOrder.order }) })).status === 404 && (await api('/api/pro/purchases', two.token)).json.orders.length === 0);
}

// =====================================================================
console.log('\n— /admin: the refund requests queue —');
let twoOrder;
{
  twoOrder = await buy(two);
  await api('/api/pro/purchases/refund', two.token, { method: 'POST', body: JSON.stringify({ order: twoOrder.order }) });
  check('the queue is closed to everyone but the admin', (await api('/api/admin/pro/refund-requests', fan.token)).status === 403 && (await api('/api/admin/pro/refund-request', fan.token, { method: 'POST', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', action: 'approve' }) })).status === 403);
  const { ctx, p } = await page(null, { w: 1360, h: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', ADMIN_PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="pro"]');
  check('Pro tab: "Refund requests", two waiting, each with who, the order, Pro used or not, and what they wrote', await waitFor(p, () => {
    const h = [...document.querySelectorAll('h2.sec')].find((x) => x.textContent === 'Refund requests');
    const t = h?.nextElementSibling?.nextElementSibling;
    return !!t && /2 waiting for you/.test(h.nextElementSibling.textContent) && /@acc_fan/.test(t.textContent) && /@acc_two/.test(t.textContent) && /not used/.test(t.textContent) && /Bought it on the wrong account/.test(t.textContent) && /asked in time/.test(t.textContent) && t.querySelectorAll('.req-approve').length === 2 && t.querySelectorAll('.req-decline').length === 2;
  }, null, 20000));
  check('…and how payments are set up says requests wait for the owner', /refund requests wait for you/.test(await p.evaluate(() => document.body.textContent)));
  await p.evaluate(() => [...document.querySelectorAll('h2.sec')].find((h) => h.textContent === 'Refund requests')?.scrollIntoView());
  await shot(p, 'admin-refund-requests');
  // Decline @acc_fan: the reason is required, and emailed.
  const rowOf = (name) => p.locator('tr', { hasText: `@${name}` }).filter({ has: p.locator('.req-decline') });
  await rowOf('acc_fan').locator('.req-decline').click();
  await rowOf('acc_fan').locator('.req-decline').click();
  check('Decline asks for the reason first', await waitFor(p, () => /Write the reason first/.test(document.getElementById('req-out')?.textContent || '')));
  await rowOf('acc_fan').locator('.req-why').fill('You have another month running on this account');
  await rowOf('acc_fan').locator('.req-decline').click();
  check('declined: said so, and the fan is emailed the reason', (await waitFor(p, () => /Declined\. The fan has been emailed your reason, and keeps Pro\./.test(document.getElementById('req-out')?.textContent || ''))) && (await mailsSoon(fan.email, /About your refund request/, 1)) === 1 && /You have another month running on this account/.test(out.join('')));
  check('…the fan keeps Pro, and nothing was refunded', (await api('/api/pro', fan.token)).json.plan === 'monthly' && !moyasar.calls.some((c) => /\/refund$/.test(c.path)));
  // Approve @acc_two: two presses, then the refund.
  await rowOf('acc_two').locator('.req-approve').click();
  check('Approve asks once more before moving money', /Sure\? Refund SAR 19.99/.test(await rowOf('acc_two').locator('.req-approve').textContent()) && !moyasar.calls.some((c) => /\/refund$/.test(c.path)));
  await rowOf('acc_two').locator('.req-approve').click();
  check('approved: refunded at Moyasar once, the pass ended', (await waitFor(p, () => /Approved and refunded\. The pass has ended and the fan has been emailed\./.test(document.getElementById('req-out')?.textContent || ''))) && moyasar.calls.filter((c) => /\/refund$/.test(c.path)).length === 1 && (await api('/api/pro', two.token)).json.plan === 'free');
  check('…the queue shows both answers, and the orders table that the fan was emailed', await waitFor(p, () => /None waiting/.test(document.body.textContent) && /Approved \d{4}-\d\d-\d\d/.test(document.body.textContent) && /Declined \d{4}-\d\d-\d\d: You have another month running/.test(document.body.textContent) && /fan emailed/.test(document.body.textContent)));
  await p.evaluate(() => [...document.querySelectorAll('h2.sec')].find((h) => h.textContent === 'Refund requests')?.scrollIntoView());
  await shot(p, 'admin-refund-answered');
  await ctx.close();
}

// =====================================================================
console.log('\n— the fan is told: the email once, the notice once —');
{
  check('the refund email went to the fan exactly once, marked as a test', (await mailsSoon(two.email, /Your TifoMaker Pro refund/, 1)) === 1 && mails(two.email, /^\[TEST\] .*Your TifoMaker Pro refund/) === 1);
  const body = out.join('');
  check('…and says the amount, that Pro ended, how the money comes back, and who to ask', /We've refunded SAR 19.99 for TifoMaker Pro \(reference [0-9a-f-]{36}\)/.test(body) && /The month of Pro it paid for has ended/.test(body) && /usually within a few working days depending on your bank/.test(body) && /TEST: no real money moved/.test(body) && body.includes(`Your purchases: ${B}/account#pro`));
  // Refunding it again from the orders table, and Moyasar's webhook saying so too: still one email.
  const again = await api('/api/admin/pro/refund', null, { method: 'POST', headers: asBoss, body: JSON.stringify({ orderId: twoOrder.order }) });
  const event = { id: 'evt', type: 'payment_refunded', live: false, secret_token: HOOK_SECRET, data: moyasar.payments.get(twoOrder.payment) };
  for (let i = 0; i < 3; i++) await api('/api/pro/pay/webhook', null, { method: 'POST', body: JSON.stringify(event) });
  await sleep(500);
  check('refunded "again" from /admin and by three webhooks: refused, and still one email and one refund', again.status === 409 && mails(two.email, /Your TifoMaker Pro refund/) === 1 && moyasar.calls.filter((c) => /\/refund$/.test(c.path)).length === 1);

  // The next time they open Tifo Maker: a calm card, once.
  const { ctx, p } = await page(two.token);
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  check('My projects: "Your Pro payment was refunded", with the amount, the date and a link to their purchases', await waitFor(p, () => {
    const c = document.querySelector('.pro-card-refund:not([hidden])');
    return !!c && /Your Pro payment was refunded/.test(c.querySelector('h2')?.textContent || '') && /We refunded SAR 19.99 on \d{1,2} \w+ 20\d\d, so that month of Pro has ended\..*few working days.*It was a test payment/.test(c.textContent) && c.querySelector('a.pro-card-link')?.getAttribute('href') === '/account#pro';
  }), await text(p, '.pro-card-refund'));
  check('…a card like the page\'s other cards, not an alert', await p.evaluate(() => { const c = document.querySelector('.pro-card-refund'); return c.classList.contains('pro-card') && !c.matches('[role="alert"], [role="alertdialog"], dialog') && !document.querySelector('.dlg-backdrop, .modal-backdrop'); }));
  await shot(p, 'projects-refund-card', '.pro-card-refund');
  await p.reload({ waitUntil: 'networkidle' });
  await sleep(600);
  check('…shown once: gone on the next visit', await p.evaluate(() => !document.querySelector('.pro-card-refund:not([hidden])')) && !('refundNotice' in (await api('/api/pro', two.token)).json));
  // Their purchases say the same.
  await openAccount(p);
  check('the account page lists it as refunded, with how the money comes back', await waitFor(p, () => { const o = document.querySelector('.pu-order'); return !!o && o.dataset.status === 'refunded' && /Refunded/.test(o.querySelector('.ac-badge')?.textContent || '') && /Refunded on .*The money goes back the way you paid, usually within a few working days depending on your bank\./.test(o.querySelector('.pu-refund')?.textContent || '') && !o.querySelector('[data-act="refund-ask"]'); }), await text(p, '.pu-order'));
  check('…and no notice a second time', await p.evaluate(() => !document.querySelector('.pro-refunded')));
  await ctx.close();

  // The fan who was declined sees why, on the order.
  const d = await page(fan.token);
  await openAccount(d.p);
  check('a declined request shows its reason on the order, and no second ask', await waitFor(d.p, () => /Your refund request wasn't approved: You have another month running on this account/.test(document.querySelector('.pu-refund')?.textContent || '') && !document.querySelector('[data-act="refund-ask"]')), await text(d.p, '.pu-refund'));
  await d.ctx.close();
}

// =====================================================================
console.log('\n— a refund made in Moyasar\'s dashboard (the webhook) —');
{
  const o = await buy(hooked);
  // Refunded behind the site's back.
  Object.assign(moyasar.payments.get(o.payment), { status: 'refunded', refunded: 1999 });
  const event = { id: 'evt', type: 'payment_refunded', live: false, secret_token: HOOK_SECRET, data: moyasar.payments.get(o.payment) };
  check('a webhook without the secret ends nothing', (await api('/api/pro/pay/webhook', null, { method: 'POST', body: JSON.stringify({ ...event, secret_token: 'not-the-secret-at-all-no' }) })).status === 401 && (await api('/api/pro', hooked.token)).json.plan === 'monthly');
  const sent = await Promise.all([1, 2, 3, 4].map(() => api('/api/pro/pay/webhook', null, { method: 'POST', body: JSON.stringify(event) })));
  check('Moyasar\'s webhook, four deliveries at once: the pass ends', sent.every((r) => r.status === 200) && (await api('/api/pro', hooked.token)).json.plan === 'free');
  check('…and the fan gets exactly one refund email', (await mailsSoon(hooked.email, /Your TifoMaker Pro refund/, 1)) === 1 && (await sleep(600), mails(hooked.email, /Your TifoMaker Pro refund/)) === 1);
  // Opening the account page first: the notice is there, once, and My projects does not repeat it.
  const { ctx, p } = await page(hooked.token);
  await openAccount(p);
  check('the account page says it once, above the plan', await waitFor(p, () => /Your Pro payment was refunded/.test(document.querySelector('.pro-refunded')?.textContent || '') && /Free/.test(document.querySelector('#pro .ac-value')?.textContent || '')), await text(p, '.pro-refunded'));
  await shot(p, 'account-refunded-notice', '#pro');
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  await sleep(600);
  check('…and My projects does not say it again', await p.evaluate(() => !document.querySelector('.pro-card-refund:not([hidden])')));
  await openAccount(p);
  await sleep(400);
  check('…nor the account page on the next visit', await p.evaluate(() => !document.querySelector('.pro-refunded') && document.querySelector('.pu-order')?.dataset.status === 'refunded'));
  await ctx.close();
}

// =====================================================================
console.log('\n— auto-renew: seen and cancelled in the same place —');
{
  const o = await buy(keeper, { keep: true });
  const token = moyasar.payments.get(o.payment).source.token;
  const { ctx, p } = await page(keeper.token, { scheme: 'dark' });
  await openAccount(p);
  check('on, with the next renewal date, the amount and which card renews', await waitFor(p, () => /Renews on \d{1,2} \w+ 20\d\d for SAR 19.99, from Visa ending 1111\./.test(document.querySelector('.pro-renew')?.textContent || '') && !!document.querySelector('[data-act="renew-off"]')), await text(p, '.pro-renew'));
  check('…beside the purchase it came with', await p.evaluate(() => document.querySelectorAll('.pu-order').length === 1 && !!document.querySelector('#pro .pro-renew')));
  await shot(p, 'account-renew-dark', '#pro');
  await p.click('[data-act="renew-off"]');
  check('Cancel is one click: off, and Pro stays until the paid days end', (await waitFor(p, () => /Auto-renew is off\. Pro stays on until the days you paid for end\./.test(document.querySelector('.pro-renew')?.textContent || '') && !document.querySelector('[data-act="renew-off"]'))) && (await api('/api/pro', keeper.token)).json.plan === 'monthly' && (await api('/api/pro/renew', keeper.token)).json.sub.status === 'cancelled' && !moyasar.tokens.has(token));
  await ctx.close();
  // The reminder email's link works on its own, signed out.
  const k2 = await buy(three, { keep: true });
  const mail = [...out.join('').matchAll(/\[email:dev\] to=acc_three@tifomaker-e2e\.org \| \[TEST\] [^\n]*receipt[\s\S]*?Turn it off: (\S+)/g)].pop();
  const anon = await page(null);
  await anon.p.goto(mail[1], { waitUntil: 'domcontentloaded' });
  check('the email\'s cancel link works by itself, with no sign-in', (await waitFor(anon.p, () => /Auto-renew is off\. Nothing more will be charged/.test(document.getElementById('pp-paid')?.textContent || ''))) && (await api('/api/pro/renew', three.token)).json.sub.status === 'cancelled' && (await api('/api/pro', three.token)).json.plan === 'monthly', mail?.[1] ?? '');
  await anon.ctx.close();
  void k2;
}

// =====================================================================
console.log('\n— in Arabic, on a phone —');
{
  await buy(arFan, { card: MADA });
  const { ctx, p } = await page(arFan.token, { lang: 'ar', w: 390, h: 844 });
  await openAccount(p, B, '/ar/account');
  check('Arabic: the section and the order are there', await waitFor(p, () => document.getElementById('pro-ac-h')?.textContent === 'برو والفواتير' && /برو، 30 يوم/.test(document.querySelector('.pu-what')?.textContent || '') && /مدفوع/.test(document.querySelector('.pu-order .ac-badge')?.textContent || '') && /19\.99 ريال/.test(document.querySelector('.pu-amt')?.textContent || '') && /مدى/.test(document.querySelector('.pu-meta')?.textContent || '')), await text(p, '#pro'));
  await p.click('.pu-receipt > summary');
  await p.click('[data-act="refund-ask"]');
  await waitFor(p, () => !!document.querySelector('.pu-ask textarea'));
  const fit = await p.evaluate(() => {
    const sec = document.getElementById('pro');
    const clone = sec.cloneNode(true);
    for (const x of clone.querySelectorAll('bdi[dir="ltr"], .pro-chip')) x.remove();
    return {
      over: document.documentElement.scrollWidth - innerWidth,
      dir: getComputedStyle(sec).direction,
      // The site's own address is written as it is typed, in both languages.
      latin: (clone.textContent.replace(/tifomaker\.org/g, '').match(/[A-Za-z]{3,}/g) || []).join(','),
      taps: [...sec.querySelectorAll('button, a.ac-btn, summary')].filter((b) => b.offsetParent !== null).map((b) => Math.round(b.getBoundingClientRect().height)),
      font: parseFloat(getComputedStyle(sec.querySelector('.pu-ask textarea')).fontSize),
      inside: [...sec.querySelectorAll('.pu-order, .pu-ask, .pu-lines')].every((e) => e.getBoundingClientRect().left >= -1 && e.getBoundingClientRect().right <= innerWidth + 1),
    };
  });
  check('…right to left, nothing off the side, everything inside its card', fit.over <= 0 && fit.dir === 'rtl' && fit.inside, JSON.stringify({ over: fit.over, dir: fit.dir, inside: fit.inside }));
  check('…no English left in it', fit.latin === '', fit.latin);
  check('…every button is easy to tap (44px), and the note field does not zoom the page (16px)', fit.taps.length >= 4 && fit.taps.every((h) => h >= 44) && fit.font >= 16, JSON.stringify(fit.taps));
  await shot(p, 'account-phone-ar', '.pu');
  await p.locator('.pu-ask').scrollIntoViewIfNeeded();
  await shot(p, 'account-phone-ar-ask');
  await p.click('[data-act="refund-send"]');
  check('…the request goes through in Arabic too', await waitFor(p, () => /انرسل طلبك/.test(document.querySelector('.pu-msg')?.textContent || '') && /طلبت الاسترداد يوم/.test(document.querySelector('.pu-refund')?.textContent || '')), await text(p, '.pu-order'));
  await ctx.close();
  const en = await page(fan.token, { w: 390, h: 844, scheme: 'dark' });
  await openAccount(en.p);
  await waitFor(en.p, () => !!document.querySelector('.pu-order'));
  check('English on a phone: nothing off the side', (await en.p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await shot(en.p, 'account-phone-en-dark', '.pu');
  await en.ctx.close();
}

// =====================================================================
console.log('\n— the auto-refund switch (PRO_AUTO_REFUND=on) —');
{
  const refundsBefore = moyasar.calls.filter((c) => /\/refund$/.test(c.path)).length;
  const o = await buy(lucky, { base: AUTO });
  const st = (await api('/api/admin/pro/orders', null, { headers: { 'x-ai-unlock': (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) }, AUTO)).json?.token } }, AUTO)).json;
  check('/admin says requests are refunded automatically', st?.status?.autoRefund === true);
  const { ctx, p } = await page(lucky.token);
  await openAccount(p, AUTO);
  await waitFor(p, () => !!document.querySelector('[data-act="refund-ask"]'));
  await p.click('[data-act="refund-ask"]');
  await p.click('[data-act="refund-send"]');
  check('in time and unused: refunded at once, and the page says so', await waitFor(p, () => /Refunded\. The money goes back the way you paid, and this month of Pro has ended\./.test(document.querySelector('.pu-msg')?.textContent || '') && document.querySelector('.pu-order')?.dataset.status === 'refunded' && /Free/.test(document.querySelector('#pro .ac-value')?.textContent || '')), await text(p, '#pro'));
  check('…one refund at Moyasar, one refund email, and nobody asked', moyasar.calls.filter((c) => /\/refund$/.test(c.path)).length === refundsBefore + 1 && (await mailsSoon(lucky.email, /Your TifoMaker Pro refund/, 1)) === 1 && mails(OWNER, /@acc_auto/) === 0 && mails(lucky.email, /We got your refund request/) === 0);
  check('…the page already said it, so no notice follows', await p.evaluate(() => !document.querySelector('.pro-refunded')) && !('refundNotice' in (await api('/api/pro', lucky.token, {}, AUTO)).json));
  // A second purchase by the same account: never automatically twice.
  const second = await buy(lucky, { base: AUTO });
  const asked = await api('/api/pro/purchases/refund', lucky.token, { method: 'POST', body: JSON.stringify({ order: second.order }) }, AUTO);
  check('the same account again: the second request waits for the owner', asked.json?.state === 'requested' && (await api('/api/pro', lucky.token, {}, AUTO)).json.plan === 'monthly' && moyasar.calls.filter((c) => /\/refund$/.test(c.path)).length === refundsBefore + 1);
  await ctx.close();
  void o;
}

check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
stop();
console.log(`\ne2e-pay-account: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
