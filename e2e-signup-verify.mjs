/**
 * The "verify your email" step after an email sign-up, end to end in a real
 * browser (bug report, 27 Oct 2026).
 *
 * What happened: someone signed up with an email and a password, the site
 * signed them in, the email with the 6-digit code arrived and told them to
 * type it on the site, and the site never asked for it. The only box that took
 * the code was on /account, and nothing pointed there. It was never a
 * Cloudflare or caching fault: no version of the sign-up dialog had the step.
 *
 * Now the dialog turns into the step as soon as the account exists. This
 * suite holds that in place, from every way in, in English and Arabic, on a
 * desktop and a phone, and checks the parts around it that must NOT change:
 * Google sign-in has no step (Google has verified the address), signing in to
 * an existing account has no step, and an account that leaves the step without
 * verifying is still refused everything an unverified account is refused.
 *
 * Self-contained: boots its own server on 8918 (memory store, console mail, a
 * short resend cooldown) and reads the codes the console sender prints. Google
 * is configured, with its two server-side endpoints answered by a stub in a
 * temp file (not the repo) and its consent screen answered by the browser, so
 * the real callback, the real account rules and the real handoff all run.
 * Needs a build first:  npm run build && node e2e-signup-verify.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8918;
const B = `http://127.0.0.1:${PORT}`;
// Long enough that "straight away" is still inside it on a slow machine.
const COOLDOWN_MS = 20000;
const PW = 'harbor-kite-moss-31';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// ---- Google, as far as the server can tell -------------------------------
// The browser's "code" is the profile itself, base64url JSON, so each test
// says who Google vouches for. The token endpoint hands it back as the access
// token and the userinfo endpoint reads it out again.
const dir = mkdtempSync(join(tmpdir(), 'tm-google-'));
const stub = join(dir, 'google.mjs');
writeFileSync(stub, `
const real = globalThis.fetch;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://oauth2.googleapis.com/token') {
    const code = new URLSearchParams(String(init?.body ?? '')).get('code') || '';
    return json({ access_token: 'stub.' + code });
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
    const auth = new Headers(init?.headers).get('authorization') || '';
    const who = JSON.parse(Buffer.from(auth.replace(/^Bearer stub\\./, ''), 'base64url').toString('utf8'));
    return json({ sub: who.sub, email: who.email, email_verified: who.verified, name: 'Fan' });
  }
  return real(input, init);
};`);
const googleCode = (who) => Buffer.from(JSON.stringify(who)).toString('base64url');

// ---- server --------------------------------------------------------------
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', '--import', stub, 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', PUBLIC_URL: B,
    VERIFY_RESEND_COOLDOWN_MS: String(COOLDOWN_MS), GOOGLE_CLIENT_ID: 'e2e-client-id', GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ADMIN_USERNAMES: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

/** Every code the console mail sender has printed for an address, oldest first. */
const codesFor = (email) => {
  const codes = [];
  for (const m of out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)) {
    if (m[1] === email) codes.push(m[2]);
  }
  return codes;
};
const api = async (path, token, body, method = body === undefined ? 'GET' : 'POST') => {
  const r = await fetch(B + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, json };
};

// Something to like and something to add a photo to, from another account.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tpl = (await (await fetch(B + '/api/templates')).json())[0];
const designFor = async (token, title) => (await api('/api/designs', token, {
  title, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#c8102e'],
  cellsGzB64: gzipSync(Buffer.alloc(tpl.seatCount, 1)).toString('base64'), thumbnailPngB64: png.toString('base64'),
})).json;
const maker = await api('/api/auth/register', null, { username: 'sv' + Date.now().toString(36), password: PW, email: `sv${Date.now()}@example.test`, acceptedVersion: '2026-06-27' });
const shown = await designFor(maker.json.token, 'Something to like');
await api(`/api/designs/${shown.id}`, maker.json.token, { isPublic: true }, 'PATCH');

/**
 * What an unverified account is refused, asked of the server directly with the
 * session the browser holds. Each returns the status and the reason code.
 */
async function restrictions(token) {
  const mine = await designFor(token, 'Mine');
  const ai = await api('/api/ai/generate', token, { prompt: '' });
  const vote = await api(`/api/designs/${shown.id}/vote`, token, { value: 1 });
  const photo = await api(`/api/designs/${mine.id}/photos`, token, { imageB64: png.toString('base64'), width: 1, height: 1, caption: 'north stand' });
  const link = await api('/api/account/link/google', token, {});
  return {
    ai: `${ai.status} ${ai.json?.reason ?? ''}`.trim(),
    vote: `${vote.status} ${vote.json?.code ?? ''}`.trim(),
    photo: `${photo.status} ${photo.json?.code ?? ''}`.trim(),
    link: `${link.status} ${link.json?.code ?? ''}`.trim(),
  };
}

// ---- browser -------------------------------------------------------------
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }));
const DESK = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const errs = [];

async function open(opts, lang, theme = 'light') {
  const ctx = await browser.newContext({
    ...opts,
    colorScheme: theme,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [
      { name: 'tifo_lang_v1', value: lang }, { name: 'tifo_consent_v1', value: 'essential' }, { name: 'tifo_theme_v1', value: theme },
      { name: 'tifo_guide_v1', value: 'done' }, { name: 'tifo_onboarded_v1', value: '1' }, { name: 'tifo_post_nudge_v1', value: '1' }] }] },
  });
  // Google's consent screen, answered at once with whoever the test chose. A
  // route sees only the first request of a redirect chain, so it takes the
  // request that starts the sign-in, lets the server answer it (state cookie
  // and all), and sends the browser straight on to the callback with a code.
  let who = null;
  await ctx.route(/\/api\/auth\/google(\?|$)/, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const loc = res.headers()['location'] || '';
    if (!loc.startsWith('https://accounts.google.com/')) return route.fulfill({ response: res });
    const u = new URL(loc);
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', googleCode(who));
    back.searchParams.set('state', u.searchParams.get('state'));
    return route.fulfill({ status: 302, headers: { ...res.headers(), location: back.toString() } });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return { ctx, p, asGoogle: (w) => { who = w; } };
}
const waitFor = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const setVal = (p, sel, v) => p.evaluate(([s, val]) => {
  const el = document.querySelector(s);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, v]);
const token = (p) => p.evaluate(() => localStorage.getItem('tifo_token_v1'));
const me = async (p) => { const t = await token(p); return t ? (await api('/api/me', t)).json : null; };

/** Open the dialog from where a visitor would, on that page and screen. */
async function openDialog(p, where, phone) {
  if (where === 'editor') {
    await p.goto(B + (p.__lang === 'ar' ? '/ar' : '') + '/app?new=1', { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => /\d/.test(document.getElementById('stat')?.textContent || ''), null, 90000);
    if (phone) {
      await p.evaluate(() => document.getElementById('avatar')?.click());
      await p.waitForTimeout(250);
      await p.evaluate(() => document.getElementById('menu-signup')?.click());
    } else {
      await p.evaluate(() => document.getElementById('signin')?.click());
    }
  } else if (where === 'account') {
    await p.goto(B + (p.__lang === 'ar' ? '/ar' : '') + '/account', { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('ac-gate-signup') && !document.getElementById('ac-gate-signup').closest('[hidden]'));
    await p.evaluate(() => document.getElementById('ac-gate-signup').click());
  } else {
    await p.goto(B + (p.__lang === 'ar' ? '/ar' : '') + '/' + where, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('auth-btn')?.onclick || !!document.getElementById('auth-btn'));
    await p.waitForTimeout(400);
    await p.evaluate(() => document.getElementById('auth-btn')?.click());
  }
  return waitFor(p, () => !!document.querySelector('.auth-backdrop .auth-form'), null, 30000);
}
async function signUp(p, email) {
  await p.evaluate(() => document.querySelector('.auth-tab[data-mode="signup"]')?.click());
  await waitFor(p, () => document.querySelector('.auth-tab[data-mode="signup"]')?.classList.contains('active'));
  await setVal(p, '.auth-form input[name=identity]', email);
  await setVal(p, '.auth-form input[name=password]', PW);
  await setVal(p, '.auth-form input[name=confirm]', PW);
  await p.evaluate(() => document.querySelector('.auth-form .auth-submit').click());
  return waitFor(p, () => { const s = document.querySelector('.auth-verify'); return !!s && !s.hidden && s.getBoundingClientRect().height > 0; }, null, 20000);
}
/** Everything about the step a check needs, read in one go. */
const step = (p) => p.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const m = q('.auth-modal');
  const r = m?.getBoundingClientRect();
  const msg = q('.auth-verify-msg');
  return {
    open: !!q('.auth-backdrop'),
    shown: vis(q('.auth-verify')),
    formShown: vis(q('.auth-form')), tabsShown: vis(q('.auth-tabs')), googleShown: vis(q('.auth-providers')),
    email: q('.auth-verify-email')?.textContent ?? '',
    sentLine: vis(q('.auth-verify-to')),
    msg: vis(msg) ? msg.textContent : '', tone: msg?.dataset.tone ?? '',
    focused: document.activeElement?.getAttribute('name') ?? '',
    label: m?.getAttribute('aria-label') ?? '', dir: m?.getAttribute('dir') ?? '',
    title: q('.auth-verify-h')?.textContent ?? '',
    text: q('.auth-verify')?.innerText ?? '',
    fits: r ? r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 : false,
    hscroll: document.documentElement.scrollWidth > innerWidth + 1,
    targets: ['.auth-code', '.auth-verify .auth-submit', '.auth-resend', '.auth-later'].map((s) => Math.round(q(s)?.getBoundingClientRect().height ?? 0)),
  };
});
const closed = (p) => waitFor(p, () => !document.querySelector('.auth-backdrop'), null, 30000);

try {
  // ======================================================================
  console.log('\n— signing up in the editor (English, desktop) —');
  {
    const { ctx, p } = await open(DESK, 'en');
    p.__lang = 'en';
    const EMAIL = `sv-ed-${Date.now()}@example.test`;
    await openDialog(p, 'editor', false);
    check('signing up turns the dialog into "Verify your email"', await signUp(p, EMAIL));
    let s = await step(p);
    check('…in place of the sign-up form, the tabs and Google', s.open && s.shown && !s.formShown && !s.tabsShown && !s.googleShown, JSON.stringify(s));
    check('…naming the address the code went to', s.email === EMAIL && s.sentLine, s.email);
    check('…with the cursor already in the code box', s.focused === 'vcode', s.focused);
    check('…and the dialog named for it', s.label === 'Verify your email' && s.title === 'Verify your email', s.label);
    check('they are signed in from the moment the account exists', (await me(p))?.emailVerified === false);
    check('one email went out, with a code', codesFor(EMAIL).length === 1);

    const first = codesFor(EMAIL)[0];
    await setVal(p, '.auth-code', first === '123456' ? '654321' : '123456');
    await waitFor(p, () => document.querySelector('.auth-verify-msg')?.dataset.tone === 'bad', null, 10000);
    s = await step(p);
    check('a wrong code is refused, with the tries left', /not right/.test(s.msg) && /4/.test(s.msg) && s.open, s.msg);

    await p.evaluate(() => document.querySelector('.auth-resend').click());
    await waitFor(p, () => /on its way/.test(document.querySelector('.auth-verify-msg')?.textContent || ''), null, 10000);
    s = await step(p);
    check('"Send a new code" straight away says the first one is on its way', /already on its way/.test(s.msg), s.msg);
    check('…and sends nothing, so the first code still stands', codesFor(EMAIL).length === 1);

    await p.waitForTimeout(COOLDOWN_MS + 400);
    await p.evaluate(() => document.querySelector('.auth-resend').click());
    await waitFor(p, () => /new code is on its way/.test(document.querySelector('.auth-verify-msg')?.textContent || ''), null, 10000);
    const codes = codesFor(EMAIL);
    check('once the wait is over it sends a new code', codes.length === 2 && codes[0] !== codes[1], JSON.stringify(codes));
    await setVal(p, '.auth-code', codes[0]);
    await waitFor(p, () => /not right/.test(document.querySelector('.auth-verify-msg')?.textContent || ''), null, 10000);
    check('the replaced code no longer works', /not right/.test((await step(p)).msg));

    await setVal(p, '.auth-code', codes[1]);
    check('the new code verifies the address', await waitFor(p, () => /verified/i.test(document.querySelector('.auth-verify-msg')?.textContent || ''), null, 10000));
    check('…and the dialog closes by itself', await closed(p));
    check('…signed in, verified', (await me(p))?.emailVerified === true);
    check('the editor says who they are signed in as', await waitFor(p, () => /signed in as/.test(document.getElementById('message')?.textContent || ''), null, 5000),
      JSON.stringify(await p.evaluate(() => document.getElementById('message')?.textContent)));
    const r = await restrictions(await token(p));
    check('verified: the AI Designer, likes, photos and linking are open to them', r.ai === '400' && r.vote === '200' && /^20/.test(r.photo) && !/verify/.test(r.link), JSON.stringify(r));
    await ctx.close();
  }

  // ======================================================================
  console.log('\n— leaving the step without verifying —');
  for (const [where, lang, opts, how] of [['projects', 'ar', PHONE, 'Later'], ['community', 'en', PHONE, 'Escape'], ['editor', 'ar', DESK, 'the close button']]) {
    const { ctx, p } = await open(opts, lang);
    p.__lang = lang;
    const EMAIL = `sv-${where}-${lang}-${Date.now()}@example.test`;
    await openDialog(p, where, opts === PHONE);
    const ok = await signUp(p, EMAIL);
    const s = await step(p);
    const label = `${where}, ${lang === 'ar' ? 'Arabic' : 'English'}, ${opts === PHONE ? 'phone' : 'desktop'}`;
    check(`${label}: the step appears`, ok && s.shown && s.fits && !s.hscroll, JSON.stringify({ fits: s.fits, hscroll: s.hscroll }));
    if (lang === 'ar') {
      // Nothing English but the address and the digits.
      const latin = s.text.replace(EMAIL, '').match(/[A-Za-z]{3,}/g);
      check(`${label}: all in Arabic, right to left`, s.dir === 'rtl' && s.title === 'وثّق بريدك' && !latin, JSON.stringify(latin));
    }
    if (opts === PHONE) check(`${label}: every control is a 44px target`, s.targets.every((h) => h >= 44), JSON.stringify(s.targets));
    if (how === 'Later') await p.evaluate(() => document.querySelector('.auth-later').click());
    else if (how === 'Escape') await p.keyboard.press('Escape');
    else await p.evaluate(() => document.querySelector('.auth-close').click());
    check(`${label}: ${how} closes it, and they stay signed in`, await closed(p) && (await me(p))?.emailVerified === false);
    if (where === 'projects' || where === 'community') {
      check(`${label}: the header shows the account`, await waitFor(p, () => /^@/.test(document.getElementById('auth-btn')?.textContent?.trim() || ''), null, 10000),
        JSON.stringify(await p.evaluate(() => document.getElementById('auth-btn')?.textContent?.trim())));
    }
    const r = await restrictions(await token(p));
    check(`${label}: still refused the AI Designer, likes, photos and linking Google`,
      r.ai === '403 verify' && r.vote === '403 verify_first' && r.photo === '403 verify' && r.link === '403 verify_first', JSON.stringify(r));
    if (where === 'editor') {
      check(`${label}: the account page still offers the code box`, await (async () => {
        await p.goto(B + '/ar/account', { waitUntil: 'domcontentloaded' });
        return waitFor(p, () => document.getElementById('ac-email-badge')?.dataset.state === 'pending' && !document.getElementById('ac-verify')?.hidden);
      })());
    }
    await ctx.close();
  }

  // ======================================================================
  console.log('\n— the account page and the like button —');
  {
    const { ctx, p } = await open(DESK, 'en');
    p.__lang = 'en';
    const EMAIL = `sv-acct-${Date.now()}@example.test`;
    await openDialog(p, 'account', false);
    check('signing up from the account page shows the step too', await signUp(p, EMAIL));
    await p.evaluate(() => document.querySelector('.auth-later').click());
    check('…and Later opens the account page, with the code box', await waitFor(p, () => document.getElementById('ac-email-badge')?.dataset.state === 'pending' && !document.getElementById('ac-verify')?.hidden, null, 30000));
    await ctx.close();
  }
  {
    const { ctx, p } = await open(PHONE, 'ar');
    p.__lang = 'ar';
    const EMAIL = `sv-like-${Date.now()}@example.test`;
    await p.goto(`${B}/ar/t/${shown.id}`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('s-like') && !document.getElementById('s-like').disabled);
    // The button is in the page before its handler is: press until it answers.
    // Each press is a double tap, which must still open one dialog.
    for (let i = 0; i < 20 && !(await p.evaluate(() => !!document.querySelector('.auth-backdrop'))); i++) {
      await p.evaluate(() => { const like = document.getElementById('s-like'); like.click(); like.click(); });
      await waitFor(p, () => !!document.querySelector('.auth-backdrop'), null, 4000);
    }
    await waitFor(p, () => !!document.querySelector('.auth-backdrop .auth-form'));
    await p.waitForTimeout(800);
    check('a double tap on Like opens one dialog, not two', (await p.evaluate(() => document.querySelectorAll('.auth-backdrop').length)) === 1,
      String(await p.evaluate(() => document.querySelectorAll('.auth-backdrop').length)));
    check('liking while signed out leads to sign-up, then the step', await signUp(p, EMAIL));
    await setVal(p, '.auth-code', codesFor(EMAIL)[0]);
    check('verifying there closes the step', await closed(p));
    const liked = await waitFor(p, () => document.getElementById('s-like')?.getAttribute('aria-pressed') === 'true', null, 10000);
    check('…and the like they came to give goes through', liked, await p.evaluate(() => document.getElementById('s-like-n')?.textContent ?? ''));
    await ctx.close();
  }

  // ======================================================================
  console.log('\n— the email did not go out —');
  {
    const { ctx, p } = await open(DESK, 'en');
    p.__lang = 'en';
    const EMAIL = `sv-unsent-${Date.now()}@example.test`;
    // Pretend the provider refused this one message (the server really sent it).
    await p.route('**/api/auth/register', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), emailSent: false } });
    });
    await openDialog(p, 'editor', false);
    await signUp(p, EMAIL);
    let s = await step(p);
    check('the step says the email did not go out, instead of "we sent a code"', s.shown && !s.sentLine && /did not go out/.test(s.msg) && s.tone === 'bad', s.msg);
    await p.waitForTimeout(COOLDOWN_MS + 400);
    await p.evaluate(() => document.querySelector('.auth-resend').click());
    await waitFor(p, () => /new code is on its way/.test(document.querySelector('.auth-verify-msg')?.textContent || ''), null, 10000);
    s = await step(p);
    check('"Send a new code" sends one, and the step then names the address', s.sentLine && codesFor(EMAIL).length === 2, s.msg);
    await p.evaluate(() => document.querySelector('.auth-later').click());
    await closed(p);
    check('…so after Later the editor no longer says the email failed', await waitFor(p, () => /signed in as/.test(document.getElementById('message')?.textContent || ''), null, 5000),
      JSON.stringify(await p.evaluate(() => document.getElementById('message')?.textContent)));
    await ctx.close();
  }

  // ======================================================================
  console.log('\n— signing in, which has no step —');
  const verifiedEmail = `sv-verified-${Date.now()}@example.test`;
  const unverifiedEmail = `sv-unverified-${Date.now()}@example.test`;
  {
    // Two accounts made the way an earlier visit would have: one verified.
    const v = await api('/api/auth/register', null, { username: 'svv' + Date.now().toString(36), password: PW, email: verifiedEmail, acceptedVersion: '2026-06-27' });
    await api('/api/auth/verify/code', v.json.token, { code: codesFor(verifiedEmail)[0] });
    await api('/api/auth/register', null, { username: 'svu' + Date.now().toString(36), password: PW, email: unverifiedEmail, acceptedVersion: '2026-06-27' });
    check('(two accounts ready: one verified, one not)', (await api('/api/me', v.json.token)).json?.emailVerified === true);

    for (const [email, label] of [[verifiedEmail, 'a verified account'], [unverifiedEmail, 'an unverified account']]) {
      const { ctx, p } = await open(DESK, 'en');
      p.__lang = 'en';
      await openDialog(p, 'editor', false);
      await p.evaluate(() => document.querySelector('.auth-tab[data-mode="signin"]').click());
      await setVal(p, '.auth-form input[name=identity]', email);
      await setVal(p, '.auth-form input[name=password]', PW);
      await p.evaluate(() => document.querySelector('.auth-form .auth-submit').click());
      const gone = await closed(p);
      check(`signing in to ${label} closes the dialog with no step`, gone && (await me(p))?.email === email);
      await ctx.close();
    }
  }

  // ======================================================================
  console.log('\n— Google —');
  {
    const { ctx, p, asGoogle } = await open(DESK, 'en');
    p.__lang = 'en';
    const gmail = `sv-google-${Date.now()}@gmail.test`;
    asGoogle({ sub: 'g-new-' + Date.now(), email: gmail, verified: true });
    await openDialog(p, 'editor', false);
    await waitFor(p, () => !document.querySelector('.auth-providers')?.hidden, null, 10000);
    await p.evaluate(() => document.querySelector('.auth-provider').click());
    const back = await waitFor(p, () => !!localStorage.getItem('tifo_token_v1'), null, 60000);
    const m = await me(p);
    check('a new account through Google comes back signed in, verified by Google', back && m?.email === gmail && m?.emailVerified === true && m?.providers?.includes('google'), JSON.stringify(m));
    await p.waitForTimeout(1500);
    check('…and is never shown the verify step', !(await step(p)).shown);
    await ctx.close();
  }
  {
    // CVE-2026-53516 (see routes.ts): an unverified account is never linked
    // to, or whoever registered someone else's address with a password would
    // get their Google sign-in.
    const { ctx, p, asGoogle } = await open(DESK, 'en');
    p.__lang = 'en';
    const seen = [];
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) seen.push(f.url()); });
    asGoogle({ sub: 'g-unv-' + Date.now(), email: unverifiedEmail, verified: true });
    await openDialog(p, 'editor', false);
    await waitFor(p, () => !document.querySelector('.auth-providers')?.hidden, null, 10000);
    await p.evaluate(() => document.querySelector('.auth-provider').click());
    const told = await waitFor(p, () => /already uses that email/.test(document.getElementById('message')?.textContent || ''), null, 90000);
    check('Google with the address of an UNVERIFIED account is refused, and says why', told && seen.some((u) => /reason=verify_first/.test(u)) && !(await token(p)),
      JSON.stringify(await p.evaluate(() => document.getElementById('message')?.textContent)));
    await ctx.close();
  }
  // The Community page never traded the cookie the callback leaves, so Google
  // from there came back signed out (the cookie lapses unread in two minutes).
  {
    const { ctx, p, asGoogle } = await open(PHONE, 'en');
    p.__lang = 'en';
    asGoogle({ sub: 'g-ver-' + Date.now(), email: verifiedEmail, verified: true });
    await openDialog(p, 'community', true);
    await waitFor(p, () => !document.querySelector('.auth-providers')?.hidden, null, 10000);
    await p.evaluate(() => document.querySelector('.auth-provider').click());
    const back = await waitFor(p, () => location.pathname === '/community' && !!localStorage.getItem('tifo_token_v1'), null, 60000);
    const m = await me(p);
    check('Community: Google with the address of a verified account comes back signed into that account', back && m?.email === verifiedEmail && m?.emailVerified === true, JSON.stringify(m));
    check('…the header shows it, the address bar is clean, and there is no step', await waitFor(p, () => /^@/.test(document.getElementById('auth-btn')?.textContent?.trim() || ''), null, 10000)
      && !/signedin/.test(p.url()) && !(await step(p)).shown, p.url().replace(B, ''));
    await ctx.close();
  }
  {
    // Arabic: the same account, from the Arabic Community page.
    const { ctx, p, asGoogle } = await open(DESK, 'ar');
    p.__lang = 'ar';
    asGoogle({ sub: 'g-ver-ar-' + Date.now(), email: verifiedEmail, verified: true });
    await openDialog(p, 'community', false);
    await waitFor(p, () => !document.querySelector('.auth-providers')?.hidden, null, 10000);
    await p.evaluate(() => document.querySelector('.auth-provider').click());
    const back = await waitFor(p, () => !/accounts|callback/.test(location.href) && !!localStorage.getItem('tifo_token_v1'), null, 60000);
    await p.waitForTimeout(1500);
    check('Arabic: Google signs into the same verified account, with no step', back && (await me(p))?.email === verifiedEmail && !(await step(p)).shown, p.url().replace(B, ''));
    await ctx.close();
  }

  // ======================================================================
  console.log('\n— how it reads (public pages, light and dark) —');
  for (const theme of ['light', 'dark']) {
    const { ctx, p } = await open(DESK, 'en', theme);
    p.__lang = 'en';
    await openDialog(p, 'community', false);
    await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await signUp(p, `sv-${theme}-${Date.now()}@example.test`);
    const c = await p.evaluate(() => {
      const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.length >= 3 ? m : [0, 0, 0, 1]; };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; const v = parse(b); if (v.length < 4 || v[3] > 0.5) return v; } return [255, 255, 255]; };
      const ratio = (el) => { const a = lum(parse(getComputedStyle(el).color)), b = lum(bgOf(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      const out = {};
      for (const s of ['.auth-verify-h', '.auth-verify-to', '.auth-verify-why', '.auth-resend', '.auth-later', '.auth-verify-help', '.auth-code']) out[s] = +ratio(document.querySelector(s)).toFixed(2);
      return out;
    });
    check(`${theme}: every line of the step reads (4.5:1)`, Object.values(c).every((v) => v >= 4.5), JSON.stringify(c));
    await ctx.close();
  }

  check('no page errors', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
