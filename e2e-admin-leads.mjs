/**
 * Club enquiries, read in /admin, end to end in a browser.
 *
 * The For clubs form stored every message, and /admin showed how many there
 * were and nothing else: the only way to read one was the database, and nothing
 * told the owner that a club had written.
 *
 *   - an enquiry sent through /api/leads is listed under Feedback, newest
 *     first, with who sent it, a reply link and the message as typed (escaped)
 *   - it counts as waiting (the tab's number and the Overview) until
 *     "Mark handled" is pressed, and can be reopened
 *   - the server hands a mail to the sender, addressed to FEEDBACK_TO only
 *
 * Starts its own server on :8974 (in memory) from the built dist. No mail
 * leaves: without a provider key the development sender only logs.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORT = 8974;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e-admin-leads-password';
const OWNER = 'owner@example.test';
const OUT = process.env.LEADS_SHOTS || 'preview-out/e2e-admin-leads';
mkdirSync(OUT, { recursive: true });

const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', AI_ADMIN_PASSWORD: PW, FEEDBACK_TO: OWNER },
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

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const send = (payload) => fetch(`${B}/api/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

check('a club enquiry is accepted', (await send({ name: 'Sara Al-Otaibi', email: 'sara@club.example', organization: 'Al Example FC', orgType: 'club', message: 'We want a tifo for the derby.\n<img src=x onerror=alert(1)>' })).status === 201);
check('and one with only a name and an address', (await send({ name: 'Second Sender', email: 'second@agency.example' })).status === 201);
check('reading them needs the admin', (await fetch(`${B}/api/admin/leads`)).status === 403);
await new Promise((r) => setTimeout(r, 300));
const log = out.join('');
check('the server handed the owner a mail about it', log.includes(OWNER) && /club enquiry/i.test(log), log.slice(-300).replace(/\s+/g, ' '));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
await p.fill('#p', PW);
await p.evaluate(() => document.getElementById('login-form').requestSubmit());
await p.waitForFunction(() => !!document.querySelector('.tab[data-tab="feedback"]'), null, { timeout: 30000 });

const badge = () => p.evaluate(() => (document.querySelector('.tab[data-tab="feedback"] .pill')?.textContent || '').trim());
check('the Feedback tab counts the two enquiries as waiting', await badge() === '2', await badge());
const board = await p.evaluate(() => document.getElementById('dash-body')?.innerText || '');
check('and the Overview says so in "Waiting for you"', /Club enquiries not marked handled/i.test(board), board.slice(0, 200).replace(/\s+/g, ' '));

await p.evaluate(() => document.querySelector('.tab[data-tab="feedback"]').click());
await p.waitForFunction(() => document.querySelectorAll('.leadrow').length === 2, null, { timeout: 10000 }).catch(() => {});
const rows = await p.evaluate(() => [...document.querySelectorAll('.leadrow')].map((r) => ({
  text: r.innerText.replace(/\s+/g, ' '),
  mail: r.querySelector('.fbmail')?.getAttribute('href'),
  img: r.querySelectorAll('img').length,
})));
check('both are listed, the newest first', rows.length === 2 && /Second Sender/.test(rows[0]?.text) && /Sara Al-Otaibi/.test(rows[1]?.text), JSON.stringify(rows.map((r) => r.text.slice(0, 60))));
check('with the club, its kind and the message', /Al Example FC · Club/.test(rows[1]?.text ?? '') && /We want a tifo for the derby/.test(rows[1]?.text ?? ''), rows[1]?.text);
check('a reply link to the sender', rows[1]?.mail === 'mailto:sara@club.example', rows[1]?.mail);
check('what was typed is shown as text, never run', rows[1]?.img === 0 && /<img src=x/.test(rows[1]?.text ?? ''));
check('an enquiry with no message says so', /No message/.test(rows[0]?.text ?? ''), rows[0]?.text);
await p.screenshot({ path: `${OUT}/admin-club-enquiries.png`, fullPage: false });

await p.evaluate(() => document.querySelectorAll('.lead-handle')[1].click());
await p.waitForFunction(() => document.querySelectorAll('.leadrow').length === 1, null, { timeout: 10000 }).catch(() => {});
check('"Mark handled" takes it off the waiting list', (await p.evaluate(() => document.querySelectorAll('.leadrow').length)) === 1 && await badge() === '1', await badge());
await p.evaluate(() => document.querySelector('.lead-filter[data-lead="all"]').click());
await p.waitForFunction(() => document.querySelectorAll('.leadrow').length === 2, null, { timeout: 10000 }).catch(() => {});
const all = await p.evaluate(() => [...document.querySelectorAll('.leadrow')].map((r) => ({ t: r.innerText.replace(/\s+/g, ' '), b: r.querySelector('.lead-handle')?.textContent })));
check('"Everything" still shows it, marked handled, with Reopen', all.length === 2 && /handled/.test(all[1]?.t ?? '') && all[1]?.b === 'Reopen', JSON.stringify(all.map((r) => r.b)));
await p.reload({ waitUntil: 'networkidle' });
await p.waitForFunction(() => !!document.querySelector('.tab[data-tab="feedback"]'), null, { timeout: 30000 });
check('and it is still handled after a reload (the server kept it)', await badge() === '1', await badge());
check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
stop();
console.log(`\nadmin leads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
