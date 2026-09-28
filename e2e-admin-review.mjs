/**
 * The three things in the 2026-09 report, end to end in a real browser.
 *
 *  1. When the model fails, the editor's card says what a person can act on —
 *     in their language — and never the provider's reply. The report's
 *     screenshot showed `gemini "gemini-3.5-flash": HTTP 503: { "error": …`
 *     inside the Arabic card and again, in English, on the status line.
 *  2. /admin → AI names the reason, the account and what the provider said.
 *  3. The review queues open with the admin PASSWORD session, inside the
 *     dashboard: they used to need an ADMIN_USERNAMES account, so following
 *     "4 pending stadiums" from the dashboard ended in a 403.
 *
 * Boots its own server on 8914 with the Gemini endpoint answering 503, exactly
 * the reply in the screenshot. The stub lives in a temp file, not the repo.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8914;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e-admin-password';
const dir = mkdtempSync(join(tmpdir(), 'tm-ai503-'));
const stub = join(dir, 'ai503.mjs');
writeFileSync(stub, `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('generativelanguage.googleapis.com')) {
    return new Response('{ "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } }', { status: 503 });
  }
  return real(input, init);
};`);

const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', '--import', stub, 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '',
    AI_ADMIN_PASSWORD: PW, GEMINI_API_KEY: 'AIzaE2EFAKEKEY0000000', AI_PROVIDER: 'gemini', AI_RETRY_DELAY_MS: '100',
    ADMIN_USERNAMES: '', AI_MODEL_PREMIUM: '', AI_MODEL_FAST: '',
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

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const api = async (path, token, body, method = 'POST') => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

// ---- seed: an ordinary account, three stadium submissions, a photo, a report ----
const stamp = Date.now().toString(36).slice(-5);
const reg = async (u) => (await api('/api/auth/register', null, { username: u, password: 'harbor-kite-moss-31', email: `${u}@example.test`, acceptedVersion: 'test' })).token;
const fanName = `fan${stamp}`;
const fan = await reg(fanName);
const templates = await (await fetch(`${B}/api/templates`)).json();
const tpl = templates[0];
// The shipped templates are TypeScript; read two of them through tsx.
const [KOP_TEMPLATE, OVAL_TEMPLATE] = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e',
  "import('./src/core/template.ts').then((m) => process.stdout.write(JSON.stringify([m.KOP_TEMPLATE, m.OVAL_TEMPLATE])))"], { encoding: 'utf8' }));
const subs = [];
for (const [t, name] of [[KOP_TEMPLATE, 'Kop End'], [OVAL_TEMPLATE, 'Oval Ground'], [KOP_TEMPLATE, 'Second Kop']]) {
  if (t) subs.push(await api('/api/stadiums', fan, { template: t, name: `${name} ${stamp}`, country: 'Egypt' }));
}
const cells = Buffer.alloc(tpl.seatCount, 1);
const { gzipSync } = await import('node:zlib');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const design = await api('/api/designs', fan, { title: `Reported ${stamp}`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#000000', '#c8102e'], cellsGzB64: gzipSync(cells).toString('base64'), thumbnailPngB64: png.toString('base64') });
const photo = await api(`/api/designs/${design.id}/photos`, fan, { imageB64: png.toString('base64'), width: 1, height: 1, caption: 'north stand' });
await api('/api/report', fan, { targetType: 'design', targetId: design.id, reason: 'spam' });
check('seeded the queues', subs.length === 3 && !!photo.photoId, JSON.stringify({ subs: subs.length, photo }));

const unlock = (await api('/api/ai/unlock', null, { password: PW })).token;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const newPage = async (ls, viewport = { width: 1440, height: 900 }) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((pairs) => { try { for (const [k, v] of pairs) localStorage.setItem(k, v); } catch { /* */ } }, [
    ['tifo_consent_v1', 'essential'], ['tifo_onboarded_v1', '1'], ['tifo_news_banners_v1', '1'], ['tifo_banner_tour_v1', '1'], ...ls,
  ]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return p;
};
const RAW = /gemini|HTTP|503|high demand|UNAVAILABLE|AIza|\{ ?"error/i;
const readCard = (p) => p.evaluate(() => ({
  title: document.querySelector('#ai-state .ai-state-title span')?.textContent ?? '',
  body: document.querySelector('#ai-state .ai-state-body')?.textContent ?? '',
  actions: [...document.querySelectorAll('#ai-state .ai-state-actions button')].map((b) => b.textContent ?? ''),
  bar: document.getElementById('message')?.textContent ?? '',
}));

// ---- 1. the editor, Arabic, admin password unlocked: the screenshot's case ----
{
  const p = await newPage([['tifo_lang_v1', 'ar'], ['tifo_ai_unlock_v1', unlock]]);
  await p.goto(`${B}/app?new=1`, { waitUntil: 'networkidle' });
  await p.click('#rail-ai');
  await p.fill('#ai-prompt', 'نسر ذهبي على المدرج الجنوبي');
  await p.click('#ai-generate-super');
  await p.waitForSelector('#ai-state:not([hidden])', { timeout: 60000 });
  const c = await readCard(p);
  check('Arabic card: a sentence, not the provider reply', !RAW.test(c.title + c.body), JSON.stringify(c));
  check('Arabic card: says the AI is busy, in Arabic', /مزدحم/.test(c.title) && /لم يُخصم شيء/.test(c.body), c.title);
  check('status line: translated, and no raw reply', !RAW.test(c.bar) && /تعذّر التنفيذ الآن/.test(c.bar), c.bar);
  check('the two ways forward are still there', c.actions.some((a) => /المصمّم السريع/.test(a)) && c.actions.some((a) => /يتاح خلال/.test(a)), c.actions.join(' | '));
  check('an admin gets a way to the reason, not the reason inline', c.actions.some((a) => /للمشرف/.test(a)), c.actions.join(' | '));
  await p.context().close();
}

// ---- the same failure in English, from the plain Generate button ----
{
  const p = await newPage([['tifo_lang_v1', 'en'], ['tifo_ai_unlock_v1', unlock]]);
  await p.goto(`${B}/app?new=1`, { waitUntil: 'networkidle' });
  await p.click('#rail-ai');
  await p.fill('#ai-prompt', 'Giant eagle on the south stand');
  await p.click('#ai-generate');
  await p.waitForSelector('#ai-state:not([hidden])', { timeout: 60000 });
  const c = await readCard(p);
  check('English card: plain words', c.title === 'The AI is very busy right now' && /Nothing was charged/.test(c.body) && !RAW.test(c.title + c.body + c.bar), JSON.stringify(c));
  check('English status line', c.bar === 'AI: could not deliver just now', c.bar);
  await p.context().close();
}

// ---- 2 + 3. the dashboard ----
{
  const p = await newPage([], { width: 1360, height: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });

  // Board → Library, in-page.
  await p.click('.tab[data-tab="board"]');
  const board = await p.evaluate(() => [...document.querySelectorAll('a.card')].map((a) => [a.textContent, a.getAttribute('href')]));
  check('board cards point at the Library tab, not the editor', board.length >= 3 && board.every(([, h]) => h === '#library' || h === '#security'), JSON.stringify(board));
  await p.click('a.card[href="#library"]');
  await p.waitForSelector('.qitem', { timeout: 15000 });
  const lib = await p.evaluate(() => ({
    hash: location.hash,
    stadiums: document.querySelectorAll('.qitem[data-kind="stadium"]').length,
    plans: document.querySelectorAll('.qitem[data-kind="stadium"] .qpic svg rect').length,
    photos: document.querySelectorAll('.qitem[data-kind="photo"]').length,
    reports: document.querySelectorAll('.qitem[data-kind="report"]').length,
    submitter: document.querySelector('.qitem[data-kind="stadium"] .qmeta')?.textContent ?? '',
    over: document.documentElement.scrollWidth - innerWidth,
  }));
  check('the queue is reviewable with the password session', lib.hash === '#library' && lib.stadiums === 3 && lib.photos === 1 && lib.reports === 1, JSON.stringify(lib));
  check('each stadium shows its seat plan and who sent it', lib.plans > 20 && lib.submitter.includes('@'), `${lib.plans} rects · ${lib.submitter}`);
  await p.waitForFunction(() => !!document.querySelector('.qitem[data-kind="photo"] .qpic img'), null, { timeout: 15000 }).catch(() => {});
  check('the photo loads with the token', await p.evaluate(() => /^data:image\//.test(document.querySelector('.qitem[data-kind="photo"] .qpic img')?.getAttribute('src') ?? '')));

  // Decisions.
  await p.click('.qitem[data-kind="stadium"] button[data-act="approve"]');
  await p.waitForFunction(() => document.querySelectorAll('.qitem[data-kind="stadium"]').length === 2, null, { timeout: 10000 }).catch(() => {});
  p.once('dialog', (d) => d.accept());
  await p.click('.qitem[data-kind="stadium"] button[data-act="reject"]');
  await p.waitForFunction(() => document.querySelectorAll('.qitem[data-kind="stadium"]').length === 1, null, { timeout: 10000 }).catch(() => {});
  await p.click('.qitem[data-kind="photo"] button[data-act="verify"]');
  await p.waitForFunction(() => !document.querySelector('.qitem[data-kind="photo"]'), null, { timeout: 10000 }).catch(() => {});
  p.once('dialog', (d) => d.accept());
  await p.click('.qitem[data-kind="report"] button[data-act="takedown"]');
  await p.waitForFunction(() => !document.querySelector('.qitem[data-kind="report"]'), null, { timeout: 10000 }).catch(() => {});
  const after = await p.evaluate(() => ({
    items: document.querySelectorAll('.qitem').length,
    badge: document.querySelector('.tab[data-tab="library"] .pill')?.textContent ?? '0',
    errs: [...document.querySelectorAll('.qerr')].map((e) => e.textContent).filter(Boolean),
  }));
  check('approve, reject, verify and take down all go through', after.items === 1 && after.badge === '1' && !after.errs.length, JSON.stringify(after));
  const community = await (await fetch(`${B}/api/stadiums/community`)).json();
  check('the approved stadium is live in the picker', community.stadiums.some((s) => s.name === `Kop End ${stamp}` || s.name === `Second Kop ${stamp}` || s.name === `Oval Ground ${stamp}`), community.stadiums.map((s) => s.name).join(', '));
  const taken = await (await fetch(`${B}/api/designs/${design.id}`)).status;
  check('the taken-down design is no longer public', taken === 404 || taken === 403, String(taken));

  // The AI tab: reason, account, provider text.
  await p.click('.tab[data-tab="ai"]');
  await p.waitForSelector('.why', { timeout: 10000 });
  const ai = await p.evaluate(() => ({
    reasons: [...document.querySelectorAll('.why .wl')].map((e) => e.textContent),
    rows: [...document.querySelectorAll('td.detail')].map((e) => e.textContent),
    who: [...document.querySelectorAll('td.name')].map((e) => e.textContent),
  }));
  check('why it failed: the reason in words', ai.reasons.includes('Provider overloaded'), ai.reasons.join(', '));
  check('recent failures carry what the provider said', ai.rows.length >= 2 && ai.rows.every((r) => /HTTP 503/.test(r) && /high demand/.test(r)), ai.rows[0]);
  check('the API key is not in the table', !ai.rows.some((r) => r.includes('AIzaE2EFAKEKEY')));
  check('and which door the request came through', ai.who.some((w) => /admin password/.test(w)), ai.who.join(' | '));

  // Phone width: no sideways scroll on the queue.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('.tab[data-tab="library"]');
  check('on a phone the queue fits the width', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0));
  await p.context().close();
}

// ---- the gate itself, from outside ----
const plain = await fetch(`${B}/api/admin/queue`, { headers: { authorization: `Bearer ${fan}` } });
check('an ordinary account is still refused', plain.status === 403, String(plain.status));
const cookieOnly = await fetch(`${B}/api/admin/queue`, { headers: { cookie: `tm_admin=${encodeURIComponent(unlock)}` } });
check('the admin cookie alone is not enough (header only)', cookieOnly.status === 401, String(cookieOnly.status));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail ? 1 : 0);
