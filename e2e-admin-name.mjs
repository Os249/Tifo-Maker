/**
 * An allow-listed admin name nobody holds is reserved, end to end in a browser.
 *
 * October 2026: ADMIN_USERNAMES on the live site named "osamah", no account had
 * it, and admin rights follow the name, so the first person to end up with that
 * handle was a moderator. Sign-up derives the handle from the email, so anyone
 * whose address started "osamah@" would have got it without even trying.
 *
 *   - signing up with osamah@… now gets another handle (the client retries, as
 *     it does for any taken one) and no admin rights
 *   - renaming onto it in Account is refused
 *   - with the admin password unlocked in the same browser (the AI panel's
 *     unlock token), the rename claims it and the account is the admin
 *
 * Starts its own server on :8914 (in memory) from the built dist.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORT = 8914;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e-admin-name-password';
const OUT = 'preview-out/e2e-admin-name';
mkdirSync(OUT, { recursive: true });

const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', AI_ADMIN_PASSWORD: PW, ADMIN_USERNAMES: 'osamah' },
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

async function context() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [{ name: 'tifo_lang_v1', value: 'en' }, { name: 'tifo_consent_v1', value: 'essential' }] }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  return { ctx, p, errs };
}
/** Create an account through the real dialog, as a visitor would. */
async function signUp(p, email) {
  await p.goto(B + '/community', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForFunction(() => document.getElementById('auth-btn'), null, { timeout: 60000 });
  await p.evaluate(() => document.getElementById('auth-btn').click());
  await p.waitForSelector('.auth-modal');
  await p.click('.auth-tab[data-mode="signup"]');
  await p.fill('.auth-form input[name="identity"]', email);
  await p.fill('.auth-form input[name="password"]', 'harbor-kite-moss-31');
  await p.fill('.auth-form input[name="confirm"]', 'harbor-kite-moss-31');
  await p.click('.auth-form .auth-submit');
  await p.waitForFunction(() => !!localStorage.getItem('tifo_token_v1'), null, { timeout: 15000 }).catch(() => {});
}
const me = (p) => p.evaluate(async () => {
  const tok = localStorage.getItem('tifo_token_v1');
  if (!tok) return null;
  return (await fetch('/api/me', { headers: { authorization: `Bearer ${tok}` } })).json();
});
async function rename(p, name) {
  await p.goto(B + '/account', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('#ac-name');
  await p.fill('#ac-name', name);
  await p.click('#ac-name-save');
  await p.waitForFunction(() => { const m = document.getElementById('ac-name-msg'); return !!m && !!m.textContent && !/saving/i.test(m.textContent); }, null, { timeout: 15000 }).catch(() => {});
  return p.$eval('#ac-name-msg', (e) => e.textContent ?? '');
}

console.log('\n— a visitor whose email starts with the admin name —');
{
  const { ctx, p, errs } = await context();
  await signUp(p, 'osamah@example.test');
  const m = await me(p);
  check('sign-up still succeeds', !!m?.username, JSON.stringify(m));
  check('with another handle, not the reserved one', !!m && m.username !== 'osamah' && /^osamah\d{4}$/.test(m.username), m?.username);
  check('and no admin rights', m?.isAdmin === false);
  const msg = await rename(p, 'osamah');
  check('renaming onto it in Account is refused, in words', msg === 'That name is taken.', msg);
  check('…and the name did not change', (await me(p))?.username !== 'osamah');
  await p.screenshot({ path: `${OUT}/refused.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— the operator, with the admin password unlocked in this browser —');
{
  const { ctx, p, errs } = await context();
  await signUp(p, 'owner@example.test');
  const before = await me(p);
  check('an ordinary account first', before?.username === 'owner' && before?.isAdmin === false, JSON.stringify(before));
  // Exactly what the AI panel's unlock stores.
  const unlocked = await p.evaluate(async (pw) => {
    const r = await fetch('/api/ai/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    const j = await r.json();
    if (j.token) localStorage.setItem('tifo_ai_unlock_v1', j.token);
    return !!j.token;
  }, PW);
  check('the admin password unlocks', unlocked);
  const msg = await rename(p, 'osamah');
  check('the rename claims the reserved name', /osamah/.test(msg) && !/taken/i.test(msg), msg);
  const after = await me(p);
  check('and the account is the admin', after?.username === 'osamah' && after?.isAdmin === true, JSON.stringify(after));
  await p.screenshot({ path: `${OUT}/claimed.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
stop();
console.log(`\nadmin name: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
