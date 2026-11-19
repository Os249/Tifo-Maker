/**
 * Buying Pro in a real browser (payments v1), against a real server and a
 * stand-in Moyasar on test keys, in the preview:
 *
 *   off              /pro is the coming-soon page, as before
 *   the owner        /pro sells Pro: the price, "Get Pro", the methods; the
 *                    price question and "tell me" step aside; "Get Pro" goes
 *                    to Moyasar's page (stood in for here); coming back paid,
 *                    the page says Pro is on and the server has given it;
 *                    coming back unpaid, it says nothing was charged; holding
 *                    a month, the button gives way to the date
 *   in Arabic, phone the same page in Arabic, nothing off the screen
 *   someone else     on the same server, outside the preview: the
 *                    coming-soon page, and the buying routes are not there
 *   /legal           the payment terms stay out while Pro is not on sale to
 *                    everyone
 *   /admin           the order, with its refund
 *
 * Self-contained: it boots its own server on memory repos, and a stand-in
 * Moyasar API on another port. Needs a build:
 *   npm run build && node e2e-pay.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const PORT = 8941;
const PORT_OFF = 8942;
const FAKE = 8943;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const SHOTS = process.env.PAY_SHOTS || '';
const ADMIN_PW = 'e2e pay admin password';
const out = [];

// ---- a stand-in Moyasar: invoices that the test pays (or not) ----
const invoices = new Map();
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!/^Basic /.test(req.headers.authorization || '')) return send(401, { type: 'authentication_error' });
    const m = /^\/v1\/invoices(?:\/([0-9a-f-]{36}))?$/.exec(req.url || '');
    if (req.method === 'POST' && m && !m[1]) {
      const b = JSON.parse(body || '{}');
      const id = randomUUID();
      const inv = { id, status: 'initiated', amount: b.amount, currency: b.currency, description: b.description, url: `https://checkout.moyasar.test/invoices/${id}`, success_url: b.success_url, back_url: b.back_url, metadata: b.metadata, payments: [] };
      invoices.set(id, inv);
      return send(201, inv);
    }
    if (req.method === 'GET' && m?.[1]) return invoices.has(m[1]) ? send(200, invoices.get(m[1])) : send(404, { type: 'record_not_found' });
    const r = /^\/v1\/payments\/([0-9a-f-]{36})\/refund$/.exec(req.url || '');
    if (req.method === 'POST' && r) {
      for (const inv of invoices.values()) {
        const p = inv.payments.find((x) => x.id === r[1]);
        if (p) { p.status = 'refunded'; p.refunded = p.amount; inv.status = 'refunded'; return send(200, p); }
      }
      return send(404, { type: 'record_not_found' });
    }
    send(404, { type: 'not_found' });
  });
});
await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
const payInvoice = (id) => {
  const inv = invoices.get(id);
  inv.status = 'paid';
  inv.payments.push({ id: randomUUID(), status: 'paid', amount: inv.amount, currency: inv.currency, refunded: 0, source: { type: 'applepay' } });
};

const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PUBLIC_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const server = boot(PORT, {
  PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pay_fan,pay_held', AI_ADMIN_PASSWORD: ADMIN_PW,
  PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234', MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
});
// The same build with the switch left as it ships: off.
const serverOff = boot(PORT_OFF, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pay_fan', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234' });
const stop = () => { for (const s of [server, serverOff]) { try { s.kill(); } catch { /* gone */ } } fake.close(); };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up(B)) || !(await up(OFF))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
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
  return { token };
};
const fan = await account('pay_fan');
const other = await account('pay_other');
const fanOff = await account('pay_fan', OFF);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errs = [];
const page = async (token, { lang = 'en', w = 1440, h = 900 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  // Moyasar's own page, stood in for: the test pays the invoice itself.
  await ctx.route('https://checkout.moyasar.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Moyasar</title><h1>Moyasar (stand-in)</h1>' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };

// =====================================================================
console.log('\n— payments off (the switch as it ships) —');
{
  const st = await api('/api/pro', fanOff.token, {}, OFF);
  check('/api/pro: Pro on in the preview, nothing to buy', st.json?.live === true && st.json.offer?.paymentsOpen === false, JSON.stringify(st.json?.offer ?? null).slice(0, 120));
  check('the buying routes are not there', (await api('/api/pro/pay/checkout', fanOff.token, { method: 'POST', body: '{}' }, OFF)).status === 404);
  const { ctx, p } = await page(fanOff.token);
  await p.goto(`${OFF}/pro`, { waitUntil: 'networkidle' });
  check('/pro is the coming-soon page: the price question, no buy button', await waitFor(p, () => /Help us price Pro/.test(document.getElementById('pp-h')?.textContent || '') && !!document.querySelector('form#ps-ask') && !document.querySelector('[data-act="buy"]')));
  await ctx.close();
  const legal = await (await fetch(`${OFF}/legal`)).text();
  check('/legal: no payment terms', !/Moyasar|ميسّر|data-pay="sale"/.test(legal) && /Right now the site is free/.test(legal));
}

// =====================================================================
console.log('\n— the owner, in the preview, on test keys —');
let orderId = null;
{
  const { ctx, p } = await page(fan.token);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro sells Pro: the hero says so', await waitFor(p, () => /Go Pro for a month/.test(document.getElementById('pp-h')?.textContent || '') && /Pay once on Moyasar/.test(document.querySelector('.ps-steps')?.textContent || '')));
  const ui = await p.evaluate(() => ({
    price: document.querySelector('.pb-price')?.textContent?.trim(),
    btn: document.querySelector('[data-act="buy"]')?.textContent,
    ask: !!document.querySelector('form#ps-ask'),
    act: !document.getElementById('pp-act')?.hidden,
    blue: [...document.querySelectorAll('main .pp-btn:not(.quiet)')].map((b) => b.textContent),
    refundFaq: !document.getElementById('pp-faq-refund')?.hidden,
  }));
  check('…the price and "Get Pro", in the Pro column', /^SAR \d+(\.\d\d)? for 30 days$/.test(ui.price || '') && /^Get Pro for SAR \d+(\.\d\d)?$/.test(ui.btn || ''), JSON.stringify(ui));
  check('…the price question and "tell me" step aside', !ui.ask && !ui.act);
  check('…one blue button on the page', ui.blue.length === 1, ui.blue.join('|'));
  check('…and the refund question is in the FAQ', ui.refundFaq);
  await shot(p, 'pay-desktop-en');
  await p.click('[data-act="buy"]');
  check('"Get Pro" goes to Moyasar\'s page', await waitFor(p, () => location.host === 'checkout.moyasar.test'));
  const inv = [...invoices.values()].pop();
  check('…an invoice for the price, in riyals, on test keys', inv && inv.currency === 'SAR' && inv.amount >= 100 && /^http:\/\/127\.0\.0\.1:8941\/pro\?order=/.test(inv.success_url), JSON.stringify(inv ?? {}).slice(0, 200));
  orderId = new URL(inv.success_url).searchParams.get('order');

  // "Back" on Moyasar's page without paying: said at once, nothing charged.
  check('"Back" on Moyasar\'s page names the order', /^http:\/\/127\.0\.0\.1:8941\/pro\?order=[0-9a-f-]{36}&back=1$/.test(inv.back_url || ''), inv.back_url);
  await p.goto(inv.back_url, { waitUntil: 'domcontentloaded' });
  check('"Back": "You left the payment page before paying, so nothing was charged"', await waitFor(p, () => /left the payment page before paying, so nothing was charged/.test(document.getElementById('pp-paid')?.textContent || ''), null, 8000));
  check('…and both left the address bar', await p.evaluate(() => !location.search.includes('order=') && !location.search.includes('back=')));
  // Back without paying, after the page closed: nothing charged.
  invoices.get(inv.id).status = 'expired';
  await p.goto(inv.success_url, { waitUntil: 'domcontentloaded' });
  check('back unpaid: "nothing was charged"', await waitFor(p, () => /nothing was charged/.test(document.getElementById('pp-paid')?.textContent || '')));
  check('…and the order left the address bar', await p.evaluate(() => !location.search.includes('order=')));
  check('…still free', (await api('/api/pro', fan.token)).json.plan === 'free');

  // Again, and this time pay.
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await waitFor(p, () => !!document.querySelector('[data-act="buy"]'));
  await p.click('[data-act="buy"]');
  await waitFor(p, () => location.host === 'checkout.moyasar.test');
  const inv2 = [...invoices.values()].pop();
  check('a second press makes a new invoice once the first has lapsed', inv2.id !== inv.id);
  orderId = new URL(inv2.success_url).searchParams.get('order');
  await p.goto(inv2.success_url, { waitUntil: 'domcontentloaded' });
  check('back before Moyasar confirms: "checking"', await waitFor(p, () => /Checking your payment/.test(document.getElementById('pp-paid')?.textContent || ''), null, 5000));
  payInvoice(inv2.id);
  check('…then "Payment received! Pro is on until …"', await waitFor(p, () => /Payment received! Pro is on until/.test(document.getElementById('pp-paid')?.textContent || '')));
  const st = (await api('/api/pro', fan.token)).json;
  check('the server gave a month of Pro, paid (the Supporter crown)', st.plan === 'monthly' && st.supporter === true && st.pass && Date.parse(st.pass.endsAt) - Date.parse(st.pass.startsAt) === 30 * 86400000, JSON.stringify(st.pass));
  check('holding a month: the date instead of a buy button', await waitFor(p, () => !document.querySelector('[data-act="buy"]') && /You have Pro until/.test(document.querySelector('.pb-buy')?.textContent || '')));
  check('…and the hero says which plan', await p.evaluate(() => !document.getElementById('pp-you')?.hidden));
  await shot(p, 'pay-paid-en');
  check('the receipt was sent', /\[email:dev\] to=pay_fan@tifomaker-e2e\.org \| \[TEST\] /.test(out.join('')));
  await ctx.close();
}

// =====================================================================
console.log('\n— in Arabic, on a phone —');
{
  const held = await account('pay_held');
  const { ctx, p } = await page(held.token, { lang: 'ar', w: 390, h: 844 });
  await p.goto(`${B}/ar/pro`, { waitUntil: 'networkidle' });
  check('Arabic: the sale hero and the button', await waitFor(p, () => /خذ المميّزة لمدة شهر/.test(document.getElementById('pp-h')?.textContent || '') && /^اشترك بـ\d+(\.\d\d)? ريال$/.test(document.querySelector('[data-act="buy"]')?.textContent || '')));
  const fit = await p.evaluate(() => {
    const btn = document.querySelector('[data-act="buy"]');
    const b = btn.getBoundingClientRect();
    const box = btn.parentElement;
    const cs = getComputedStyle(box);
    const inner = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { over: document.documentElement.scrollWidth - innerWidth, w: Math.round(b.width), inner: Math.round(inner), h: Math.round(b.height), first: document.querySelector('.pp-plan.pro') === [...document.querySelectorAll('.pp-plan')].sort((a, z) => a.getBoundingClientRect().top - z.getBoundingClientRect().top)[0] };
  });
  check('…nothing off the side, the button full width and easy to tap, Pro first', fit.over <= 0 && Math.abs(fit.w - fit.inner) <= 1 && fit.h >= 44 && fit.first, JSON.stringify(fit));
  await p.locator('.pb-buy').scrollIntoViewIfNeeded();
  await shot(p, 'pay-phone-ar');
  await ctx.close();
}

// =====================================================================
console.log('\n— someone outside the preview —');
{
  check('cannot buy', (await api('/api/pro/pay/checkout', other.token, { method: 'POST', body: '{}' })).status === 404);
  check('cannot read the owner\'s order', (await api(`/api/pro/pay/order/${orderId}`, other.token)).status === 404);
  const { ctx, p } = await page(other.token);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('sees the coming-soon page', await waitFor(p, () => /Help us price Pro/.test(document.getElementById('pp-h')?.textContent || '') && !document.querySelector('[data-act="buy"]')));
  await ctx.close();
  const legal = await (await fetch(`${B}/legal`)).text();
  check('/legal: no payment terms on test keys in a preview', !/Moyasar|data-pay="sale"/.test(legal));
}

// =====================================================================
console.log('\n— /admin —');
{
  const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).json?.token;
  const list = (await api('/api/admin/pro/orders', null, { headers: { 'x-ai-unlock': unlock } })).json;
  const o = list?.orders?.find((x) => x.id === orderId);
  check('the order, paid with Apple Pay, refundable, Pro not used', o?.status === 'paid' && o.method === 'applepay' && o.refundable === true && o.used === 0 && o.test === true, JSON.stringify(o));
  const { ctx, p } = await page(null, { w: 1360, h: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', ADMIN_PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="pro"]');
  const shown = await waitFor(p, () => /On, with TEST keys/.test(document.body.textContent) && !!document.querySelector('.order-refund'), null, 15000);
  check('/admin Pro tab: the switches and the order with a refund button', shown);
  if (shown) {
    await shot(p, 'pay-admin');
    await p.click('.order-refund');
    check('…the first press asks', /Sure\? Refund SAR/.test(await p.locator('.order-refund').first().textContent()));
    await p.click('.order-refund');
    check('…the second refunds, and Pro ends', await waitFor(p, () => /Refunded\. The money goes back/.test(document.getElementById('order-out')?.textContent || '')) && (await api('/api/pro', fan.token)).json.plan === 'free');
  }
  await ctx.close();
}

check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
stop();
console.log(`\ne2e-pay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
