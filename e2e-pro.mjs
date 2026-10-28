/**
 * Pro in the interface: what a person sees and can do, in a real browser
 * against a real server with PRO_MODE=preview.
 *
 *   not on the list  nothing about Pro anywhere: no gift card, no chip, no
 *                    counts, no cut-out button, no mark option, /pro "not open";
 *   on the list      the gift card on My projects ("Later" puts it away); the
 *                    AI panel's counts and the limit card (one blue way on, one
 *                    quiet alternative); the export sheet for the mark; smart
 *                    cut-out (asks first, swaps the picture, puts the original
 *                    back, and costs nothing when it fails); accepting the gift
 *                    (the header chip, the account's plan, the Pro page);
 *   in Arabic        the account's plan and the chip's word;
 *   PRO_MODE off     /pro is a 404 and /api/pro says nothing.
 *
 * Self-contained: it boots its own servers on memory repos. Needs a build:
 *   npm run build && node e2e-pro.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8937;
const PORT_OFF = 8938;
const B = `http://127.0.0.1:${PORT}`;
const out = [];
const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pro_fan' });
const serverOff = boot(PORT_OFF, { PRO_MODE: 'off' });
const stop = () => { for (const s of [server, serverOff]) { try { s.kill(); } catch { /* gone */ } } };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up(B)) || !(await up(`http://127.0.0.1:${PORT_OFF}`))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

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
const [tpl] = (await api('/api/templates')).json;
const cellsGzB64 = gzipSync(new Uint8Array(tpl.seatCount)).toString('base64');
/** A verified account with one saved design (what the gift asks for). */
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64 }) }, base);
  return { token, design: d.json?.id };
};
const fan = await account('pro_fan');
const other = await account('pro_other');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const page = async (token, { lang = 'en', w = 1440, h = 900, ls = {} } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_lang_v1: lang, ...ls })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, ls]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const editor = async (token, design, opts = {}) => {
  const { ctx, p } = await page(token, opts);
  await p.goto(`${B}${opts.lang === 'ar' ? '/ar' : ''}/app?project=${design}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!window.__tifo, null, 90000);
  return { ctx, p };
};
const PNG = readFileSync('public/apple-touch-icon.png');

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const st = await api('/api/pro', other.token);
  check('/api/pro says only that it is not on', st.status === 200 && JSON.stringify(st.json) === JSON.stringify({ live: false, signedIn: true }), JSON.stringify(st.json));
  const { ctx, p } = await page(other.token);
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const pj = await p.evaluate(() => ({ card: !!document.querySelector('.pro-card:not([hidden])'), chip: !!document.querySelector('.pro-head-chip:not([hidden])') }));
  check('My projects: no gift card, no countdown chip', !pj.card && !pj.chip, JSON.stringify(pj));
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro says Pro is not open, and shows no price', await waitFor(p, () => !document.getElementById('pp-closed').hidden && document.getElementById('pp-open').hidden && !/SAR/.test(document.body.innerText)));
  await ctx.close();
  const e = await editor(other.token, other.design);
  await e.p.setInputFiles('#import-file', { name: 'captain.png', mimeType: 'image/png', buffer: PNG });
  await waitFor(e.p, () => !document.getElementById('import-bar').hidden);
  await e.p.waitForTimeout(800);
  const ed = await e.p.evaluate(() => ({
    cut: !!document.querySelector('.cut-field:not([hidden])'),
    mark: !document.querySelector('#sx-nomark')?.closest('label')?.hidden,
    left: !document.querySelector('.ai-whole-left')?.hidden,
    // Visible ones: the markup may be in the page, unshown, like any closed panel's.
    crown: [...document.querySelectorAll('.pro-crown')].filter((c) => c.getClientRects().length > 0).length,
  }));
  check('editor: no cut-out button, no mark option, no counts, no crowns', !ed.cut && !ed.mark && !ed.left && ed.crown === 0, JSON.stringify(ed));
  const cut = await api('/api/ai/cutout', other.token, { method: 'POST', body: JSON.stringify({ image: `data:image/png;base64,${PNG.toString('base64')}` }) });
  check('…and the cut-out route does not exist for it', cut.status === 404, String(cut.status));
  await e.ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list —');
{
  const { ctx, p } = await page(fan.token);
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  check('My projects shows the gift card', await waitFor(p, () => /A gift for you: 7 days of Pro/.test(document.querySelector('.pro-card:not([hidden]) h2')?.textContent || '')));
  check('…saying when it waits until, with the year', /2027/.test(await p.locator('.pro-card p').first().textContent()));
  await p.click('.pro-card [data-act="quiet"]');
  check('"Later" puts it away', await waitFor(p, () => !!document.querySelector('.pro-card[hidden]')));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  check('…and it stays away after a reload', await p.evaluate(() => !document.querySelector('.pro-card:not([hidden])')));
  await p.evaluate(() => localStorage.removeItem('tifo_gift_later_v1'));
  await ctx.close();
}
{
  const { ctx, p } = await editor(fan.token, fan.design);
  await p.click('#rail-ai');
  check('AI panel: the day\'s designs, counted', await waitFor(p, () => /^10 of 10 designs left today$/.test(document.getElementById('ai-quota')?.textContent || '')));
  check('…and the week\'s Super designs beside Whole stadium', await p.evaluate(() => document.querySelector('.ai-whole-left')?.textContent === '3 left'));
  await p.check('#ai-whole');
  check('ticking Whole stadium counts Super instead', await waitFor(p, () => /^3 of 3 Super designs left this week$/.test(document.getElementById('ai-quota')?.textContent || '')));
  // The server's answer when the week's three are used, as it sends it.
  const resetAt = new Date(Date.now() + 2 * 86400e3).toISOString();
  await p.route('**/api/ai/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ needsChoice: true, reason: 'quota', kind: 'super', plan: 'free', retryAfterSec: 172800, quota: { admin: false, used: 3, limit: 3, remaining: 0, resetInSec: 172800, live: true, kind: 'super', period: 'week', resetAt, plan: 'free' } }),
  }));
  await p.fill('#ai-prompt', 'Giant eagle over the south stand');
  await p.click('#ai-generate');
  check('the limit card says what ran out', await waitFor(p, () => /That's all 3 Super designs for this week/.test(document.querySelector('#ai-state .ai-state-title')?.textContent || '')));
  const acts = await p.evaluate(() => [...document.querySelectorAll('#ai-state .ai-state-actions button')].map((b) => [b.textContent, b.classList.contains('primary')]));
  check('…one blue way on (the gift) and one quiet alternative', acts.length === 2 && acts[0][0] === 'Use my Pro gift' && acts[0][1] && acts[1][0] === 'Use a standard design' && !acts[1][1], JSON.stringify(acts));
  check('…and the crown beside Whole stadium, now that the free ones are used', await p.evaluate(() => !!document.querySelector('.ai-whole-left .pro-chip')));
  await p.locator('#ai-state .ai-state-actions button').first().click();
  check('the gift sheet opens from the card, and says when it would end', await waitFor(p, () => /Your 7-day Pro gift/.test(document.querySelector('.pro-sheet h2')?.textContent || '') && !!document.querySelector('.pro-sheet .pro-when')));
  await p.keyboard.press('Escape');
  check('Escape closes it without starting anything', await waitFor(p, () => !document.querySelector('.pro-sheet-backdrop')) && (await api('/api/pro', fan.token)).json.gift.state === 'offered');
  await p.unroute('**/api/ai/generate');

  // The stadium video's mark.
  await p.click('#rail-anim');
  check('Stadium animation offers the mark-free export, crowned', await waitFor(p, () => { const l = document.getElementById('sx-nomark')?.closest('label'); return !!l && !l.hidden && !!l.querySelector('.pro-chip'); }));
  await p.check('#sx-nomark');
  await p.click('#sx-export');
  check('exporting it as a free account opens the export sheet', await waitFor(p, () => /This export uses a Pro item/.test(document.querySelector('.pro-sheet h2')?.textContent || '')));
  const sheet = await p.evaluate(() => ({ items: [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent), free: document.querySelector('[data-act="free"]')?.textContent, note: document.querySelector('.pro-note')?.textContent }));
  check('…naming the item, with the free way out and "saving is always free"', sheet.items[0] === 'Without the tifomaker.org mark' && sheet.free === 'Export without Pro items' && /always free/.test(sheet.note), JSON.stringify(sheet));
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.pro-sheet-backdrop'));

  // Smart cut-out: no provider configured here, so a real call fails and costs nothing.
  await p.setInputFiles('#import-file', { name: 'captain.png', mimeType: 'image/png', buffer: PNG });
  check('importing a picture shows Smart cut-out', await waitFor(p, () => !!document.querySelector('.cut-field:not([hidden]) .cut-btn')));
  await p.click('.cut-btn');
  check('the first time, it asks first and says where the picture goes', await waitFor(p, () => /Cloudflare/.test(document.querySelector('.pro-sheet .pro-note')?.textContent || '') && /last one this week/.test(document.querySelector('.pro-sheet')?.textContent || '')));
  await p.click('.pro-sheet [data-act="go"]');
  check('a failed cut-out says so', await waitFor(p, () => /not available right now|did not work/.test(document.getElementById('message')?.textContent || '')));
  const left = (await api('/api/pro', fan.token)).json.allowances.cutout.remaining;
  check('…and the week\'s cut-out is still there', left === 1, String(left));
  check('…and the button is ready again', await p.evaluate(() => !document.querySelector('.cut-btn').disabled && /Smart cut-out/.test(document.querySelector('.cut-btn').textContent)));
  // A working one, as the server would answer.
  await p.route('**/api/ai/cutout', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: `data:image/png;base64,${PNG.toString('base64')}`, quota: null }) }));
  await p.click('.cut-btn');
  check('the last one of the week is asked about again', await waitFor(p, () => !!document.querySelector('.pro-sheet [data-act="go"]')));
  await p.click('.pro-sheet [data-act="go"]');
  check('a cut-out swaps the picture and offers the original back', await waitFor(p, () => /Use the original/.test(document.querySelector('.cut-btn')?.textContent || '') && /Cut out/.test(document.getElementById('message')?.textContent || '')));
  await p.click('.cut-btn');
  check('"Use the original" puts it back', await waitFor(p, () => /Smart cut-out/.test(document.querySelector('.cut-btn')?.textContent || '')));
  await p.click('#import-cancel');
  check('cancelling the import takes the button away', await waitFor(p, () => !!document.querySelector('.cut-field[hidden]')));
  await ctx.close();
}
{
  // Accepting the gift, from My projects.
  const { ctx, p } = await page(fan.token);
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  await waitFor(p, () => !!document.querySelector('.pro-card:not([hidden])'));
  await p.click('.pro-card [data-act="main"]');
  await waitFor(p, () => !!document.querySelector('.pro-sheet [data-act="start"]'));
  await p.click('.pro-sheet [data-act="start"]');
  check('Start runs the gift', await waitFor(p, () => /Your Pro gift is on/.test(document.querySelector('.pro-sheet h2')?.textContent || '')));
  const st = (await api('/api/pro', fan.token)).json;
  check('…the server says so: the gift plan, 7 days from now', st.plan === 'gift' && Math.abs(Date.parse(st.pass.endsAt) - Date.now() - 7 * 86400e3) < 120e3, JSON.stringify({ plan: st.plan, ends: st.pass?.endsAt }));
  await p.click('.pro-sheet [data-act="done"]');
  check('the gift card goes, and the header counts down', await waitFor(p, () => !document.querySelector('.pro-card:not([hidden])') && /Pro · 7 days left/.test(document.querySelector('.pro-head-chip:not([hidden])')?.textContent || '')));
  const again = await p.evaluate(() => fetch('/api/pro/gift/accept', { method: 'POST', headers: { authorization: `Bearer ${localStorage.getItem('tifo_token_v1')}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status));
  check('a second accept from the page is refused', again === 409, String(again));
  await p.goto(`${B}/account`, { waitUntil: 'networkidle' });
  check('Account: the plan, when it ends, and five allowances', await waitFor(p, () => {
    const s = document.getElementById('pro');
    return !!s && !s.hidden && /Pro gift/.test(s.textContent) && /Ends/.test(s.textContent) && s.querySelectorAll('.pro-meter').length === 5;
  }));
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro: three plans, and "you have" instead of a button', await waitFor(p, () => document.querySelectorAll('.pp-plan').length === 3 && !document.getElementById('pp-you').hidden && document.getElementById('pp-act').hidden));
  await ctx.close();
}
{
  const { ctx, p } = await page(fan.token, { lang: 'ar' });
  await p.goto(`${B}/ar/account`, { waitUntil: 'networkidle' });
  check('in Arabic: "باقتك" and the gift\'s name', await waitFor(p, () => { const s = document.getElementById('pro'); return !!s && !s.hidden && /باقتك/.test(s.textContent) && /الهدية المميّزة/.test(s.textContent); }));
  await p.goto(`${B}/ar/projects`, { waitUntil: 'networkidle' });
  check('…and the chip says مميّز', await waitFor(p, () => /^مميّز · باقي 7 أيام$/.test(document.querySelector('.pro-head-chip:not([hidden])')?.textContent || '')));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('…with nothing scrolling sideways', over <= 0, String(over));
  await ctx.close();
}

// =====================================================================
console.log('\n— PRO_MODE off —');
{
  const OFF = `http://127.0.0.1:${PORT_OFF}`;
  const r = await fetch(`${OFF}/pro`);
  check('/pro is a 404', r.status === 404, String(r.status));
  const ar = await fetch(`${OFF}/ar/pro`);
  check('…in Arabic too', ar.status === 404, String(ar.status));
  const u = await account('pro_fan', OFF);
  const st = await api('/api/pro', u.token, {}, OFF);
  check('/api/pro says nothing, even to a name that would be on the list', JSON.stringify(st.json) === JSON.stringify({ live: false, signedIn: true }), JSON.stringify(st.json));
  const q = await api('/api/ai/quota', u.token, {}, OFF);
  check('the AI quota is the old hourly one', q.status === 200 && !q.json.live && !q.json.allowances, JSON.stringify(q.json));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
