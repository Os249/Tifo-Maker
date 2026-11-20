/**
 * The account page in five areas (20 Nov 2026), in a real browser: the summary
 * with its next steps, the list of areas and their addresses (the old ones
 * included), the code box that comes first, every form's states (idle, working,
 * done, failed) with its errors beside the field they are about, the one blue
 * button, delete asked twice, and "Pro and billing" for a member. On a phone
 * and a desktop, in English and Arabic.
 *
 * Self-contained: it boots its own server on memory repos and a stand-in
 * Moyasar (scripts/fake-moyasar.mjs). Needs a build:
 *   npm run build && node e2e-account.mjs
 *
 * ACCOUNT_SHOTS=<folder> saves screenshots there.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8981;
const FAKE = 8984;
const B = `http://127.0.0.1:${PORT}`;
const PK = 'pk_test_FAKEfake1234';
const PW = 'harbor-kite-moss-31';
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
    AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_ADMIN_PASSWORD: 'e2e account admin password', PUBLIC_URL: B,
    PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'ar_new,ar_free,ar_pro,ar_fan', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: 'sk_test_FAKEfake1234',
    PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK, PRO_AUTORENEW: 'on', MOYASAR_WEBHOOK_SECRET: 'e2e-webhook-secret-of-some-length',
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
const account = async (username, verify = true) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: PW, email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  if (verify) await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  return { token, email, username };
};
/** Buy a month the way the payment form does, with "Keep Pro on" ticked. */
const buy = async (who) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: '{"lang":"en"}' });
  if (!c.json?.form) throw new Error(`checkout: ${JSON.stringify(c.json)}`);
  const f = c.json.form;
  await api('/api/pro/pay/keep', who.token, { method: 'POST', body: JSON.stringify({ order: c.json.order, keep: true }) });
  const made = await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl,
      metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: '4111111111111111', month: '12', year: '30', cvc: '123', save_card: true },
    }),
  });
  if (made.status !== 201) throw new Error(`payment: ${made.status}`);
  moyasar.finish3ds(f.givenId, 'paid');
  await api(`/api/pro/pay/order/${c.json.order}`, who.token);
};

const SHOTS = process.env.ACCOUNT_SHOTS || '';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errs = [];
const open = async (token, { lang = 'en', w = 1440, h = 900, hash = '' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_lang_v1: lang, tifo_theme_v1: 'light' })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok && localStorage.getItem('tifo_token_v1') === null) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/account${hash}`, { waitUntil: 'networkidle' });
  if (token) await p.waitForFunction(() => !document.getElementById('ac-sections')?.hidden, null, { timeout: 20000 }).catch(() => {});
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
/** What is on screen: the area, the visible blue buttons, controls under 44px, fields without a label, and whether the page runs off the side. */
const look = (p) => p.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const main = document.getElementById('main');
  return {
    area: main.dataset.area,
    blue: [...main.querySelectorAll('.ac-btn.primary')].filter(vis).map((b) => b.textContent.trim()),
    small: [...main.querySelectorAll('button, a, input, textarea, summary')].filter(vis).filter((e) => e.getBoundingClientRect().height < 44).map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().height)}`),
    unlabelled: [...main.querySelectorAll('input, textarea')].filter(vis).filter((i) => !i.labels?.length && !i.getAttribute('aria-label')).map((i) => i.id),
    over: document.documentElement.scrollWidth - innerWidth,
    panes: [...main.querySelectorAll('.ac-area')].filter(vis).map((a) => a.id),
  };
});
/** Where a message sits: beside the field with this id, and that field marked as the one to fix. */
const beside = (p, msgId, fieldId) => p.evaluate(([m, f]) => {
  const msg = document.getElementById(m); const field = document.getElementById(f);
  return !!msg && !!field && msg.parentElement === field.closest('.ac-field') && field.getAttribute('aria-invalid') === 'true' && (field.getAttribute('aria-describedby') || '').split(' ').includes(m) && msg.dataset.tone === 'bad';
}, [msgId, fieldId]);

const fresh = await account('ar_new', false);
const free = await account('ar_free');
const member = await account('ar_pro');
const fan = await account('ar_fan');
const leaver = await account('ar_leaver');
await buy(member);

// =====================================================================
console.log('\n— signed out —');
{
  const { ctx, p } = await open(null, { w: 390, h: 844 });
  const s = await p.evaluate(() => ({ gate: !document.getElementById('ac-gate').hidden, shell: document.getElementById('ac-sections').hidden, blue: [...document.querySelectorAll('.ac-btn.primary')].filter((b) => b.offsetParent).map((b) => b.textContent) }));
  check('the way in, and nothing of the account', s.gate && s.shell && s.blue.join() === 'Sign in', JSON.stringify(s));
  await ctx.close();
}

console.log('\n— a phone, an address not verified yet: the code comes first —');
{
  const { ctx, p } = await open(fresh.token, { w: 390, h: 844 });
  await waitFor(p, () => !document.getElementById('ac-verify').hidden);
  const s = await p.evaluate(() => {
    const top = (id) => Math.round(document.getElementById(id).getBoundingClientRect().top + scrollY);
    return { verify: top('ac-verify'), sum: top('ac-summary'), code: top('ac-code'), links: [...document.querySelectorAll('.ac-link')].filter((a) => a.offsetParent).map((a) => a.dataset.to), warn: document.querySelector('.ac-link[data-to="security"]').hasAttribute('data-warn'),
      badge: document.getElementById('ac-sum-email-badge').textContent, step: document.getElementById('ac-sum-email-step').textContent, name: document.getElementById('ac-sum-name').textContent, plan: document.getElementById('ac-sum-plan-name').textContent, planStep: document.getElementById('ac-sum-plan-step').textContent };
  });
  const v = await look(p);
  check('the overview: the code box is above the summary, and on the first screen', v.area === 'overview' && s.verify < s.sum && s.code < 844 && v.panes.length === 0, JSON.stringify({ ...s, area: v.area }));
  check('the summary: who I am, "Not verified yet" with "Enter the code", and the plan with its step', s.name === '@ar_new' && s.badge === 'Not verified yet' && s.step === 'Enter the code' && s.plan === 'Free' && s.planStep === 'See what Pro adds', JSON.stringify(s));
  check('the five areas, with a mark on the one that needs something', s.links.join() === 'profile,security,billing,data,danger' && s.warn, s.links.join());
  check('one blue button: Verify', v.blue.join() === 'Verify', v.blue.join());
  check('44px targets, every field labelled, nothing off the side', v.small.length === 0 && v.unlabelled.length === 0 && v.over <= 0, JSON.stringify(v));
  await shot(p, 'phone-unverified-overview');

  await p.click('#ac-sum-email-step');
  check('"Enter the code" puts the cursor in the code box', await p.evaluate(() => document.activeElement?.id === 'ac-code'));
  await p.fill('#ac-code', '12');
  await p.click('#ac-code-submit');
  check('too short: said beside the box', (await beside(p, 'ac-verify-msg', 'ac-code')) && /all six digits/.test(await text(p, '#ac-verify-msg')), await text(p, '#ac-verify-msg'));
  const real = await codeFor(fresh.email);
  const wrongCode = real === '000000' ? '111111' : '000000';
  await p.fill('#ac-code', wrongCode);
  check('a wrong code: the tries left, beside the box, and the box emptied', (await waitFor(p, () => /tries left/.test(document.getElementById('ac-verify-msg').textContent))) && (await beside(p, 'ac-verify-msg', 'ac-code')) && (await p.inputValue('#ac-code')) === '', await text(p, '#ac-verify-msg'));
  await p.click('#ac-resend');
  check('Send a new code, too soon: the wait is said and counted down on the button', await waitFor(p, () => { const b = document.getElementById('ac-resend'); return b.disabled && /^Send a new code in \d+s$/.test(b.textContent) && /already on its way/.test(document.getElementById('ac-verify-msg').textContent); }), await text(p, '#ac-resend'));
  await p.fill('#ac-code', real);
  check('the right code: the box goes and "Email verified" stays in its place', await waitFor(p, () => document.getElementById('ac-verify').hidden && !document.getElementById('ac-verified').hidden && /Email verified/.test(document.getElementById('ac-verified').textContent)));
  check('…and the summary and the list say so', await p.evaluate(() => document.getElementById('ac-sum-email-badge').dataset.state === 'ok' && document.getElementById('ac-sum-email-step').hidden && !document.querySelector('.ac-link[data-to="security"]').hasAttribute('data-warn') && document.getElementById('ac-nav-security').textContent === 'Email verified'));
  check('…with no blue button left', (await look(p)).blue.length === 0);
  await ctx.close();
}

console.log('\n— a phone: one area at a time, each with its address —');
{
  const { ctx, p } = await open(free.token, { w: 390, h: 844 });
  await p.click('.ac-link[data-to="security"]');
  await waitFor(p, () => document.getElementById('main').dataset.area === 'security');
  let v = await look(p);
  const s = await p.evaluate(() => ({ hash: location.hash, sum: !!document.getElementById('ac-summary').offsetParent, list: !!document.getElementById('ac-areas').offsetParent, back: !!document.getElementById('ac-backlink').offsetParent, focus: document.activeElement?.id, top: scrollY }));
  check('Sign-in and security is its own screen at #security, with the way back', s.hash === '#security' && v.panes.join() === 'security' && !s.sum && !s.list && s.back && s.focus === 'ac-h-security' && s.top === 0, JSON.stringify(s));
  check('…44px targets, labels, nothing off the side', v.small.length === 0 && v.unlabelled.length === 0 && v.over <= 0, JSON.stringify(v));
  await p.click('#ac-backlink');
  check('back to the overview', await waitFor(p, () => document.getElementById('main').dataset.area === 'overview' && !!document.getElementById('ac-summary').offsetParent));
  for (const [hash, area, card] of [['#pro', 'billing', 'pro'], ['#billing', 'billing', null], ['#sec-danger', 'danger', 'sec-danger'], ['#sec-email', 'security', 'sec-email'], ['#sec-password', 'security', 'sec-password'], ['#sec-name', 'profile', 'sec-name'], ['#sec-data', 'data', 'sec-data'], ['#data', 'data', null], ['#danger', 'danger', null], ['#profile', 'profile', null]]) {
    await p.goto(`${B}/account${hash}`, { waitUntil: 'networkidle' });
    await p.reload({ waitUntil: 'networkidle' });
    const ok = await waitFor(p, ([a, c]) => document.getElementById('main').dataset.area === a && !!document.getElementById(a).offsetParent && (!c || !!document.getElementById(c)?.offsetParent), [area, card], 8000);
    check(`/account${hash} opens ${area}`, ok, await p.evaluate(() => document.getElementById('main').dataset.area));
    v = await look(p);
    if (v.small.length || v.unlabelled.length || v.over > 0) check(`…${area}: 44px targets, labels, nothing off the side`, false, JSON.stringify(v));
  }
  await p.goto(`${B}/account#nothing-here`, { waitUntil: 'networkidle' });
  check('an address that names nothing is the overview', await waitFor(p, () => document.getElementById('main').dataset.area === 'overview'));
  await ctx.close();
}

console.log('\n— a desktop: the list beside the open area —');
{
  const { ctx, p } = await open(free.token);
  let v = await look(p);
  const s = await p.evaluate(() => ({ cur: document.querySelector('.ac-link[aria-current="page"]')?.dataset.to, sum: !!document.getElementById('ac-summary').offsetParent, list: !!document.getElementById('ac-areas').offsetParent, listLeft: document.getElementById('ac-areas').getBoundingClientRect().right <= document.getElementById('profile').getBoundingClientRect().left }));
  check('with no address the first area is open, marked in the list, under the summary', v.panes.join() === 'profile' && s.cur === 'profile' && s.sum && s.list && s.listLeft, JSON.stringify({ ...s, panes: v.panes }));
  await p.click('.ac-link[data-to="data"]');
  check('the list changes the area and the mark, and nothing else', await waitFor(p, () => location.hash === '#data' && document.querySelector('.ac-link[aria-current="page"]')?.dataset.to === 'data' && !!document.getElementById('data').offsetParent && !document.getElementById('profile').offsetParent && !!document.getElementById('ac-summary').offsetParent));
  await p.click('#ac-export');
  check('Download my data: working, then "Downloaded."', await waitFor(p, () => document.getElementById('ac-export-msg').textContent === 'Downloaded.' && document.getElementById('ac-export-msg').dataset.tone === 'ok' && !document.getElementById('ac-export').disabled));
  await shot(p, 'desktop-data');
  await ctx.close();
}

console.log('\n— the display name —');
{
  const { ctx, p } = await open(fan.token, { hash: '#profile' });
  check('Save waits for a change, and no admin field is shown', await p.evaluate(() => document.getElementById('ac-name-save').disabled && !document.getElementById('ac-name-adminpw').offsetParent && !document.getElementById('ac-name-adminpw-label').offsetParent));
  await p.fill('#ac-name', 'no');
  check('once changed, Save is the one blue button', (await look(p)).blue.join() === 'Save');
  await p.click('#ac-name-save');
  check('too short: the rule, beside the field', (await beside(p, 'ac-name-msg', 'ac-name')) && /3 to 24 characters/.test(await text(p, '#ac-name-msg')));
  await p.fill('#ac-name', 'ar_free');
  await p.click('#ac-name-save');
  check('a taken name: said beside the field', (await waitFor(p, () => document.getElementById('ac-name-msg').dataset.tone === 'bad' && !/Saving/.test(document.getElementById('ac-name-msg').textContent))) && (await beside(p, 'ac-name-msg', 'ac-name')), await text(p, '#ac-name-msg'));
  await p.fill('#ac-name', 'ar_fan_two');
  await p.click('#ac-name-save');
  check('a free name: "You are now @ar_fan_two", in the summary and the list too', await waitFor(p, () => document.getElementById('ac-name-msg').textContent === 'You are now @ar_fan_two.' && document.getElementById('ac-sum-name').textContent === '@ar_fan_two' && document.getElementById('ac-nav-profile').textContent === '@ar_fan_two' && !document.getElementById('ac-name').hasAttribute('aria-invalid')), await text(p, '#ac-name-msg'));
  await ctx.close();
}

console.log('\n— the password —');
{
  const { ctx, p } = await open(fan.token, { w: 390, h: 844, hash: '#security' });
  check('folded until asked for', await p.evaluate(() => document.getElementById('ac-pw-form').hidden && document.getElementById('ac-email-form').hidden && document.getElementById('ac-pw-edit').getAttribute('aria-expanded') === 'false'));
  await p.click('#ac-pw-edit');
  const s = await p.evaluate(() => ({ open: !document.getElementById('ac-pw-form').hidden, exp: document.getElementById('ac-pw-edit').getAttribute('aria-expanded'), label: document.getElementById('ac-pw-edit').textContent, note: document.getElementById('ac-pw-note').textContent, tip: document.querySelector('#ac-pw-form .pwf-hint').textContent, eyes: [...document.querySelectorAll('#ac-pw-form .ac-eye, #ac-pw-form .pwf-eye')].map((e) => [e.getAttribute('aria-label'), Math.round(e.getBoundingClientRect().height)]), focus: document.activeElement?.id }));
  check('Change opens it, with the cursor in the first field', s.open && s.exp === 'true' && s.label === 'Close' && s.focus === 'ac-pw-current', JSON.stringify(s));
  check('the rules and what a change does are said before anything is typed', /At least 12 characters/.test(s.tip) && /signs you out on every other device/.test(s.note), JSON.stringify([s.tip, s.note]));
  check('show and hide on the current and the new password, 44px each', s.eyes.length === 2 && s.eyes.every(([l, h]) => l === 'Show password' && h >= 44), JSON.stringify(s.eyes));
  let v = await look(p);
  check('its button is the one blue button, and everything is 44px', v.blue.join() === 'Change password' && v.small.length === 0 && v.unlabelled.length === 0 && v.over <= 0, JSON.stringify(v));
  await p.click('#ac-pw-save');
  check('nothing typed: asked for the current password, beside it', (await beside(p, 'ac-pw-msg', 'ac-pw-current')) && (await p.evaluate(() => document.activeElement?.id === 'ac-pw-current')), await text(p, '#ac-pw-msg'));
  await p.fill('#ac-pw-current', PW);
  await p.fill('#ac-pw-new', 'short');
  await p.click('#ac-pw-save');
  check('a short new password: said beside the new password', (await beside(p, 'ac-pw-msg', 'ac-pw-new')) && /at least 12 characters/.test(await text(p, '#ac-pw-msg')) && !(await p.evaluate(() => document.getElementById('ac-pw-current').hasAttribute('aria-invalid'))), await text(p, '#ac-pw-msg'));
  await p.fill('#ac-pw-new', 'velvet-comet-cedar-47');
  await p.fill('#ac-pw-again', 'velvet-comet-cedar-48');
  await p.click('#ac-pw-save');
  check('two that differ: said beside the confirmation', (await beside(p, 'ac-pw-msg', 'ac-pw-again')) && /do not match/.test(await text(p, '#ac-pw-msg')), await text(p, '#ac-pw-msg'));
  await p.fill('#ac-pw-again', 'velvet-comet-cedar-47');
  await p.fill('#ac-pw-current', 'not-my-password-at-all');
  await p.click('#ac-pw-save');
  check('a wrong current password: the server\'s refusal, beside the current password', (await waitFor(p, () => document.getElementById('ac-pw-msg').dataset.tone === 'bad' && document.getElementById('ac-pw-save').dataset.busy === undefined && document.getElementById('ac-pw-current').getAttribute('aria-invalid') === 'true')) && (await beside(p, 'ac-pw-msg', 'ac-pw-current')), await text(p, '#ac-pw-msg'));
  await shot(p, 'phone-password-error');
  await p.click('#ac-pw-current ~ .ac-eye');
  check('show: the current password can be read, and hidden again', await p.evaluate(() => document.getElementById('ac-pw-current').type === 'text' && document.querySelector('#ac-pw-current ~ .ac-eye').getAttribute('aria-label') === 'Hide password'));
  await p.fill('#ac-pw-current', PW);
  await p.click('#ac-pw-save');
  check('the right one: "Password changed. Every other device has been signed out.", and the form is put away', await waitFor(p, () => /Password changed\. Every other device has been signed out\./.test(document.getElementById('ac-pw-msg').textContent) && document.getElementById('ac-pw-msg').dataset.tone === 'ok' && document.getElementById('ac-pw-form').hidden && document.getElementById('ac-pw-edit').textContent === 'Change'), await text(p, '#ac-pw-msg'));
  check('…and the new password is the one that signs in', (await api('/api/auth/login', null, { method: 'POST', body: JSON.stringify({ username: 'ar_fan_two', password: 'velvet-comet-cedar-47' }) })).status === 200);
  await shot(p, 'phone-password-done');

  await p.click('#ac-pw-edit');
  await p.click('#ac-email-edit');
  check('one form at a time: opening the email puts the password away', await p.evaluate(() => !document.getElementById('ac-email-form').hidden && document.getElementById('ac-pw-form').hidden && document.getElementById('ac-pw-edit').getAttribute('aria-expanded') === 'false'));
  await p.fill('#ac-email', 'not-an-email');
  await p.click('#ac-email-save');
  check('not an address: said beside the email', await beside(p, 'ac-email-msg', 'ac-email'), await text(p, '#ac-email-msg'));
  await p.fill('#ac-email', 'ar_fan_new@tifomaker-e2e.org');
  await p.click('#ac-email-save');
  check('no password: asked for it, beside it', await beside(p, 'ac-email-msg', 'ac-email-pw'), await text(p, '#ac-email-msg'));
  await p.fill('#ac-email-pw', 'velvet-comet-cedar-47');
  await p.click('#ac-email-save');
  check('saved: the form is put away, and the code box for the new address is first on the screen', await waitFor(p, () => /Saved\. We sent a code/.test(document.getElementById('ac-email-msg').textContent) && document.getElementById('ac-email-form').hidden && !document.getElementById('ac-verify').hidden && !!document.getElementById('ac-verify').offsetParent && document.getElementById('ac-email-badge').dataset.state === 'pending' && document.getElementById('ac-verify').getBoundingClientRect().top < document.getElementById('sec-email').getBoundingClientRect().top), await text(p, '#ac-email-msg'));
  v = await look(p);
  check('…and Verify is the one blue button again', v.blue.join() === 'Verify', v.blue.join());
  await ctx.close();
}

console.log('\n— delete: apart, and asked twice —');
{
  const { ctx, p } = await open(leaver.token, { w: 390, h: 844, hash: '#danger' });
  check('first only the button', await p.evaluate(() => !!document.getElementById('ac-delete').offsetParent && document.getElementById('ac-delete-confirm').hidden));
  await p.click('#ac-delete');
  const s = await p.evaluate(() => ({ open: !document.getElementById('ac-delete-confirm').hidden, ask: document.getElementById('ac-delete-ask').textContent, label: document.getElementById('ac-delete-name').labels?.[0]?.id, focus: document.activeElement?.id, sure: document.querySelector('.ac-sure').textContent }));
  check('then: are you sure, type your name (a labelled field), your password', s.open && s.ask === 'Type ar_leaver to confirm.' && s.label === 'ac-delete-ask' && s.focus === 'ac-delete-name' && /Are you sure/.test(s.sure), JSON.stringify(s));
  const v = await look(p);
  check('no blue button here, 44px targets', v.blue.length === 0 && v.small.length === 0 && v.unlabelled.length === 0 && v.over <= 0, JSON.stringify(v));
  await p.fill('#ac-delete-name', 'someone_else');
  await p.click('#ac-delete-go');
  check('the wrong name: said beside the name, and nothing deleted', (await beside(p, 'ac-delete-msg', 'ac-delete-name')) && (await api('/api/me', leaver.token)).status === 200, await text(p, '#ac-delete-msg'));
  await p.fill('#ac-delete-name', 'ar_leaver');
  await p.click('#ac-delete-go');
  check('no password: asked for it, beside it', await beside(p, 'ac-delete-msg', 'ac-delete-pw'), await text(p, '#ac-delete-msg'));
  await p.fill('#ac-delete-pw', 'not-the-password-12345');
  await p.click('#ac-delete-go');
  check('the wrong password: refused beside it, and still nothing deleted', (await waitFor(p, () => document.getElementById('ac-delete-msg').dataset.tone === 'bad' && document.getElementById('ac-delete-go').dataset.busy === undefined && document.getElementById('ac-delete-pw').getAttribute('aria-invalid') === 'true')) && (await api('/api/me', leaver.token)).status === 200, await text(p, '#ac-delete-msg'));
  await shot(p, 'phone-delete-confirm');
  await p.click('#ac-delete-cancel');
  check('Cancel puts it all away', await p.evaluate(() => document.getElementById('ac-delete-confirm').hidden && !!document.getElementById('ac-delete').offsetParent && document.activeElement?.id === 'ac-delete'));
  await p.click('#ac-delete');
  await p.fill('#ac-delete-name', 'ar_leaver');
  await p.fill('#ac-delete-pw', PW);
  await Promise.all([p.waitForURL((u) => new URL(u).pathname === '/', { timeout: 20000 }).catch(() => {}), p.click('#ac-delete-go')]);
  check('name and password right: the account is gone, and the page is the home page', new URL(p.url()).pathname === '/' && (await api('/api/me', leaver.token)).status === 401, p.url());
  await ctx.close();
}

console.log('\n— a Pro member: the summary and "Pro and billing" —');
{
  const { ctx, p } = await open(member.token, { w: 390, h: 844 });
  await waitFor(p, () => !document.getElementById('ac-sum-plan').hidden && /Pro monthly/.test(document.getElementById('ac-sum-plan-name').textContent));
  let s = await p.evaluate(() => ({ plan: document.getElementById('ac-sum-plan-name').textContent, days: document.getElementById('ac-sum-plan-badge').textContent, sub: document.getElementById('ac-sum-plan-sub').textContent, step: document.getElementById('ac-sum-plan-step').textContent, href: document.getElementById('ac-sum-plan-step').getAttribute('href'), nav: document.getElementById('ac-nav-billing').textContent, badge: !!document.querySelector('#ac-sum-badge .supporter-badge') }));
  check('the summary: Pro monthly, the days left, the day it renews, and Manage', s.plan === 'Pro monthly' && /^\d+ days left$/.test(s.days) && /^Renews \d{1,2} \w+ 20\d\d$/.test(s.sub) && s.step === 'Manage' && s.href === '#billing' && /^Pro monthly · \d+ days left$/.test(s.nav) && s.badge, JSON.stringify(s));
  await shot(p, 'phone-pro-overview');
  await p.click('#ac-sum-plan-step');
  await waitFor(p, () => document.getElementById('main').dataset.area === 'billing' && !!document.querySelector('#pro .pu-order'));
  s = await p.evaluate(() => {
    const kids = [...document.getElementById('pro').children].map((c) => c.className.split(' ')[0]);
    return { kids, h: document.getElementById('pro-ac-h').textContent, days: document.querySelector('#pro [data-days-left]')?.textContent, bar: !!document.querySelector('#pro .pro-days-bar'), when: document.querySelector('#pro .pro-when')?.textContent, order: document.querySelector('#pro .pu-order')?.textContent };
  });
  check('the area reads as a bill: plan, auto-renew, when it ends, what is left, purchases', s.h === 'Pro and billing' && s.kids.indexOf('pro-plan') < s.kids.indexOf('pro-renew') && s.kids.indexOf('pro-renew') < s.kids.indexOf('pro-when') && s.kids.indexOf('pro-when') < s.kids.indexOf('pu') && /^\d+ days left$/.test(s.days) && s.bar, JSON.stringify(s.kids));
  check('when it ends, with auto-renew on: nothing changes', /Nothing changes: Pro renews by itself on \d{1,2} \w+ 20\d\d/.test(s.when), s.when);
  check('what was paid, how, the receipt and the refund', /Pro, 30 days/.test(s.order) && /SAR 19\.99/.test(s.order) && /Visa/.test(s.order) && /Receipt/.test(s.order) && /Request a refund/.test(s.order), s.order);
  let v = await look(p);
  check('no blue button in billing, 44px targets, nothing off the side', v.blue.length === 0 && v.small.length === 0 && v.unlabelled.length === 0 && v.over <= 0, JSON.stringify(v));
  await shot(p, 'phone-pro-billing');
  await p.click('#pro [data-act="renew-off"]');
  check('Turn off auto-renew: said, and "when it ends" now says what ends', await waitFor(p, () => /Auto-renew is off\. Pro stays on until the days you paid for end\./.test(document.getElementById('pro-renew-msg')?.textContent || '') && /your account goes back to Free\. Your tifos and projects stay as they are/.test(document.querySelector('#pro .pro-when')?.textContent || '')), await text(p, '#pro .pro-when'));
  check('…and the summary says "Ends", not "Renews"', await p.evaluate(() => /^Ends /.test(document.getElementById('ac-sum-plan-sub').textContent)));
  await ctx.close();
}

console.log('\n— Arabic, on a phone —');
{
  const { ctx, p } = await open(member.token, { lang: 'ar', w: 390, h: 844 });
  await waitFor(p, () => !document.getElementById('ac-sum-plan').hidden);
  const latin = () => p.evaluate(() => {
    const main = document.getElementById('main').cloneNode(true);
    for (const x of main.querySelectorAll('bdi, [dir="ltr"], .pro-chip, [hidden], input')) x.remove();
    // The site's address, a card's and a provider's name and the fan's own handle are written as they are.
    return (main.textContent.replace(/tifomaker\.org|Visa|Google|ar_pro/g, '').match(/[A-Za-z]{3,}/g) || []).join(',');
  });
  let v = await look(p);
  check('the overview: right to left, no English left, nothing off the side, 44px', (await p.evaluate(() => getComputedStyle(document.getElementById('main')).direction)) === 'rtl' && (await latin()) === '' && v.over <= 0 && v.small.length === 0, `${await latin()} ${JSON.stringify(v.small)}`);
  await shot(p, 'phone-ar-overview');
  for (const area of ['profile', 'security', 'billing', 'data', 'danger']) {
    await p.goto(`${B}/ar/account#${area}`, { waitUntil: 'networkidle' });
    await waitFor(p, (a) => document.getElementById('main').dataset.area === a && (a !== 'billing' || !!document.querySelector('#pro .pu-order')), area);
    if (area === 'security') await p.click('#ac-pw-edit');
    if (area === 'danger') await p.click('#ac-delete');
    v = await look(p);
    const l = await latin();
    check(`${area}: no English left, nothing off the side, 44px targets, labels`, l === '' && v.over <= 0 && v.small.length === 0 && v.unlabelled.length === 0, `${l} ${JSON.stringify(v)}`);
    if (area === 'security') check('…the password rules are in Arabic before anything is typed', /12 خانة على الأقل/.test(await text(p, '#ac-pw-form .pwf-hint')) && (await text(p, '#ac-pw-form .pwf-suggest')) === 'اقترح لي وحدة', await text(p, '#ac-pw-form .pwf-hint'));
    await shot(p, `phone-ar-${area}`);
  }
  await ctx.close();
}

check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\ne2e-account: ${pass} passed, ${fail} failed`);
await browser.close();
stop();
process.exit(fail ? 1 : 0);
