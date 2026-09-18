/**
 * Email verification, driven through the real site in a real browser.
 *
 * Why this exists: every server test of Resend passed while the button was
 * broken in production. The tests called the route directly; the browser sent
 * `content-type: application/json` with no body, and the server answered 400
 * before the route ran, every time. Only something that presses the actual
 * button can tell those two apart.
 *
 * Self-contained: it boots its own server (memory repos, console mail, a short
 * resend cooldown) and reads the codes the console sender prints.
 * Needs a build first:  npm run build && node e2e-verify.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8913;
const B = `http://127.0.0.1:${PORT}`;
const COOLDOWN_MS = 2500;

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

// ---- server --------------------------------------------------------------
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', VERIFY_RESEND_COOLDOWN_MS: String(COOLDOWN_MS) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}
/** Every code the console mail sender has printed for an address, oldest first. */
const codesFor = (email) => {
  const log = out.join('');
  const codes = [];
  for (const m of log.matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)) {
    if (m[1] === email) codes.push(m[2]);
  }
  return codes;
};

// ---- browser -------------------------------------------------------------
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
const waitFor = (fn, arg = null, ms = 60000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const setVal = (sel, v) => page.evaluate(([s, val]) => {
  const el = document.querySelector(s);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, v]);

/** Every request to the resend route, with what the browser sent and got back. */
const resends = [];
/** The listener below is async, so the page can be ahead of the record. */
const seen = async (n) => {
  for (let i = 0; i < 100 && resends.length < n; i++) await new Promise((r) => setTimeout(r, 50));
  return resends.length >= n;
};
page.on('requestfinished', async (req) => {
  if (!req.url().endsWith('/api/auth/verify/resend')) return;
  const res = await req.response();
  resends.push({ contentType: (await req.allHeaders())['content-type'] ?? null, status: res?.status() ?? 0 });
});

try {
  const EMAIL = `fan${Date.now()}@example.test`;

  console.log('\n— signing up in the editor —');
  // Pretend the provider refused this one message, to see the client read the
  // flag from the right response. The server really did send it.
  await page.route('**/api/auth/register', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, emailSent: false } });
  });
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded' });
  await waitFor(() => { const s = document.getElementById('stat'); return s && /seats/.test(s.textContent || ''); }, null, 90000);
  await page.evaluate(() => document.getElementById('signin')?.click());
  await waitFor(() => !!document.querySelector('.auth-backdrop .auth-form'));
  await page.evaluate(() => document.querySelector('.auth-tab[data-mode="signup"]').click());
  await waitFor(() => document.querySelector('.auth-tab[data-mode="signup"]')?.classList.contains('active'));
  await setVal('.auth-form input[name=identity]', EMAIL);
  await setVal('.auth-form input[name=password]', 'harbor-kite-moss-31');
  await setVal('.auth-form input[name=confirm]', 'harbor-kite-moss-31');
  await page.evaluate(() => document.querySelector('.auth-form .auth-submit').click());
  check('the account is created', await waitFor(() => !document.querySelector('.auth-backdrop')));
  const msg = await waitFor(() => /could not send the verification email/i.test(document.getElementById('message')?.textContent || ''), null, 15000);
  check('a registration whose email was refused says so, instead of "signed in as"', msg, JSON.stringify(await text('#message')));
  await page.unroute('**/api/auth/register');
  check('the registration email went out', codesFor(EMAIL).length === 1, `${codesFor(EMAIL).length} message(s)`);

  console.log('\n— the account page, pressing the real buttons —');
  await page.goto(B + '/account', { waitUntil: 'domcontentloaded' });
  check('the address shows as not verified', await waitFor(() => document.getElementById('ac-email-badge')?.dataset.state === 'pending'));
  check('the code box is offered', await page.evaluate(() => !document.getElementById('ac-verify')?.hidden));

  // Straight after signing up: the message is already on its way.
  await page.evaluate(() => document.getElementById('ac-resend').click());
  await waitFor(() => /already on its way/i.test(document.getElementById('ac-email-msg')?.textContent || ''), null, 10000);
  await seen(1);
  check('Resend reaches the server: it is not a 400', resends.length === 1 && resends[0].status !== 400, JSON.stringify(resends));
  check('...and sends no JSON content-type without a body', resends[0]?.contentType === null, String(resends[0]?.contentType));
  check('straight after signing up it answers with the cooldown', resends[0]?.status === 429 && /already on its way/i.test(await text('#ac-email-msg')), JSON.stringify(await text('#ac-email-msg')));
  check('...and sends nothing, so the first code still stands', codesFor(EMAIL).length === 1);

  await page.waitForTimeout(COOLDOWN_MS + 400);
  await page.evaluate(() => document.getElementById('ac-resend').click());
  const sent = await waitFor(() => /new code is on its way/i.test(document.getElementById('ac-email-msg')?.textContent || ''), null, 10000);
  await seen(2);
  check('once the wait is over, Resend sends a new code', sent && resends[1]?.status === 202, `${resends[1]?.status} ${JSON.stringify(await text('#ac-email-msg'))}`);
  const codes = codesFor(EMAIL);
  check('...which really went out, with a different code', codes.length === 2 && codes[0] !== codes[1], JSON.stringify(codes));

  await setVal('#ac-code', codes[0]);
  const wrong = await waitFor(() => /not right/i.test(document.getElementById('ac-email-msg')?.textContent || ''), null, 10000);
  check('the replaced code is refused, with the tries left', wrong && /4/.test(await text('#ac-email-msg')), JSON.stringify(await text('#ac-email-msg')));

  await setVal('#ac-code', codes[1]);
  const done = await waitFor(() => /verified/i.test(document.getElementById('ac-email-msg')?.textContent || ''), null, 10000);
  check('the new code verifies the address', done, JSON.stringify(await text('#ac-email-msg')));
  check('...and the badge says so', await waitFor(() => document.getElementById('ac-email-badge')?.dataset.state === 'ok', null, 10000));

  console.log('\n— an open tab still running the old code —');
  // Someone with the site open from before the deploy still sends the old
  // request; the server must take it too.
  const legacy = await page.evaluate(async () => {
    const r = await fetch('/api/auth/verify/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('tifo_token_v1')}` },
    });
    return { status: r.status, body: await r.text() };
  });
  check('the old header-without-body request is answered by the route', legacy.status === 200 && /alreadyVerified/.test(legacy.body), `${legacy.status} ${legacy.body.slice(0, 60)}`);

  console.log('\n— the AI panel, for someone who has just signed up (in Arabic) —');
  // The panel resends on its own when it meets an unverified account. It used
  // to announce "I just re-sent the link" without waiting, in English, while
  // the request was a 400.
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx2.addInitScript(() => { try { localStorage.setItem('tifo_lang_v1', 'ar'); } catch { /* none */ } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  const aiResends = [];
  p2.on('requestfinished', async (req) => {
    if (!req.url().endsWith('/api/auth/verify/resend')) return;
    aiResends.push((await req.response())?.status() ?? 0);
  });
  const wait2 = (fn, arg = null, ms = 60000) => p2.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const set2 = (sel, v) => p2.evaluate(([q, val]) => {
    const el = document.querySelector(q);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [sel, v]);
  const EMAIL2 = `fan${Date.now()}b@example.test`;
  await p2.goto(B + '/app', { waitUntil: 'domcontentloaded' });
  await wait2(() => { const s = document.getElementById('stat'); return s && /\d/.test(s.textContent || ''); }, null, 90000);
  await p2.evaluate(() => document.getElementById('signin')?.click());
  await wait2(() => !!document.querySelector('.auth-backdrop .auth-form'));
  await p2.evaluate(() => document.querySelector('.auth-tab[data-mode="signup"]').click());
  await set2('.auth-form input[name=identity]', EMAIL2);
  await set2('.auth-form input[name=password]', 'harbor-kite-moss-31');
  await set2('.auth-form input[name=confirm]', 'harbor-kite-moss-31');
  await p2.evaluate(() => document.querySelector('.auth-form .auth-submit').click());
  await wait2(() => !document.querySelector('.auth-backdrop'));
  await set2('#ai-prompt', 'Giant eagle covering the south stand in black and gold');
  await p2.evaluate(() => document.getElementById('ai-generate')?.click());
  const carded = await wait2(() => {
    const st = document.getElementById('ai-state');
    return !!st && !st.hidden && /وثّق بريدك/.test(st.textContent || '');
  }, null, 30000);
  const card = await p2.evaluate(() => ({
    title: document.querySelector('#ai-state .ai-state-title span')?.textContent ?? '',
    buttons: Array.from(document.querySelectorAll('#ai-state .ai-state-actions button')).map((b) => b.textContent),
  }));
  for (let i = 0; i < 40 && aiResends.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
  check('an unverified account is told to verify, in Arabic', carded, JSON.stringify(card.title));
  check('...the automatic resend reached the server as a cooldown, not a 400', aiResends.length === 1 && aiResends[0] === 429, JSON.stringify(aiResends));
  check('...so the card says the code is already in the email', /الرمز موجود في الرسالة/.test(card.title), JSON.stringify(card.title));
  check('...and offers somewhere to type it', card.buttons.includes('اكتب الرمز'), JSON.stringify(card.buttons));
  check('...and the signup email was the only one sent', codesFor(EMAIL2).length === 1, `${codesFor(EMAIL2).length} message(s)`);
  await ctx2.close();

  check('no page errors', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
