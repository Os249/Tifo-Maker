/**
 * Pro in the interface: what a person sees and can do, in a real browser
 * against a real server with PRO_MODE=preview.
 *
 *   not on the list  nothing about Pro but /pro, a coming-soon page: no gift
 *                    card, no chip, no counts, no cut-out button, no mark
 *                    option; /pro shows the plans with no price, asks what
 *                    a month is worth, and offers "tell me when it opens";
 *   the price question  signed out (English, desktop) and in Arabic on a
 *                    phone: the currency by language, Arabic digits, the
 *                    answer kept and changed, the header link on every
 *                    public page; the answers on /admin;
 *   on the list      the gift card on My projects ("Later" puts it away); the
 *                    AI panel's counts and the limit card (one blue way on, one
 *                    quiet alternative); the export sheet for the mark; smart
 *                    cut-out (asks first, swaps the picture, puts the original
 *                    back, and costs nothing when it fails); accepting the gift
 *                    (the header chip, the account's plan, the Pro page);
 *   in Arabic        the account's plan and the chip's word;
 *   PRO_MODE off     /pro is still the coming-soon page, and /api/pro says
 *                    nothing but the plans.
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
const ADMIN_PW = 'e2e pro admin password';
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pro_fan', AI_ADMIN_PASSWORD: ADMIN_PW });
/** Whether Pro sells more AI designs and Polishes (server/src/proPlan.ts), as the build the suite runs has it. */
const AI_ON_PRO = /export const AI_ON_PRO = true;/.test(readFileSync('server/src/proPlan.ts', 'utf8'));
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
  check('/api/pro says it is not on, with only the coming-soon plans', st.status === 200 && st.json.live === false && !!st.json.soon?.limits && !st.json.offer && !/price|SAR/.test(JSON.stringify(st.json)), JSON.stringify(st.json).slice(0, 200));
  const { ctx, p } = await page(other.token);
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const pj = await p.evaluate(() => ({ card: !!document.querySelector('.pro-card:not([hidden])'), chip: !!document.querySelector('.pro-head-chip:not([hidden])') }));
  check('My projects: no gift card, no countdown chip', !pj.card && !pj.chip, JSON.stringify(pj));
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro: coming soon, the two plans, and no price on either', await waitFor(p, () => document.querySelectorAll('.pp-plan').length === 2 && /coming soon/i.test(document.getElementById('pp-h')?.textContent || '') && !/SAR \d|\$\d|USD \d/.test(document.body.innerText)));
  check('…Free says it is free, Pro asks what it is worth', await p.evaluate(() => /Always free/.test(document.querySelector('#pp-plan-free')?.closest('.pp-plan')?.textContent || '') && !!document.querySelector('#pp-plan-pro')?.closest('.pp-plan')?.querySelector('form#ps-ask #ps-amount')));
  const notify = p.locator('#pp-act [data-act="notify"]');
  check('…and an account off the list can ask to be told when it opens, quietly', (await notify.count()) === 1 && await notify.evaluate((b) => b.classList.contains('quiet')));
  await notify.click();
  check('…which it can', await waitFor(p, () => /We'll tell you/.test(document.querySelector('#pp-act [data-act="notify"]')?.textContent || '') && /email you/.test(document.getElementById('pp-msg')?.textContent || '')));
  check('…and the server keeps it', (await api('/api/pro', other.token)).json.notified === true);
  check('one blue button on the page: Send my price', await p.evaluate(() => [...document.querySelectorAll('main .pp-btn:not(.quiet)')].map((b) => b.textContent).join('|') === 'Send my price'));
  await ctx.close();
  const e = await editor(other.token, other.design);
  await e.p.setInputFiles('#import-file', { name: 'captain.png', mimeType: 'image/png', buffer: PNG });
  await waitFor(e.p, () => !document.getElementById('import-bar').hidden);
  await e.p.waitForTimeout(800);
  const ed = await e.p.evaluate(() => ({
    cut: !!document.querySelector('.cut-field:not([hidden])'),
    mark: !!document.querySelector('#sx-nomark')?.closest('label') && !document.querySelector('#sx-nomark').closest('label').hidden,
    // The count beside "Whole stadium" went with the box (29 Oct 2026): none shown.
    left: !!document.querySelector('.ai-whole-left:not([hidden])'),
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
  const cardBody = await p.locator('.pro-card p').first().textContent();
  check('…saying it waits for them, with no date to claim it by', /waits for you/.test(cardBody) && !/20\d\d/.test(cardBody), cardBody);
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
  // Whole stadium is the only AI path since 29 Oct 2026 (2e3d8f9): its box,
  // and the week's Super count and crown beside it, are gone, and the panel's
  // designs are metered as AI designs (one allowance since 31 Oct).
  check('…and no Whole stadium box any more, nor a Super count beside it', await p.evaluate(() => !document.getElementById('ai-whole') && !document.querySelector('.ai-whole-left:not([hidden])') && !/Super/.test(document.getElementById('ai-quota')?.textContent || '')));
  // The server's answer when the month's 40 are used, as it sends it.
  const resetAt = new Date(Date.now() + 2 * 86400e3).toISOString();
  await p.route('**/api/ai/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ needsChoice: true, reason: 'quota', kind: 'std', plan: 'free', retryAfterSec: 172800, quota: { admin: false, used: 40, limit: 40, remaining: 0, resetInSec: 172800, live: true, kind: 'std', period: 'month', resetAt, plan: 'free' } }),
  }));
  await p.fill('#ai-prompt', 'Giant eagle over the south stand');
  await p.click('#ai-generate');
  check('the limit card says what ran out', await waitFor(p, () => /That's all 40 designs for this month/.test(document.querySelector('#ai-state .ai-state-title')?.textContent || '')));
  const acts = await p.evaluate(() => [...document.querySelectorAll('#ai-state .ai-state-actions button')].map((b) => [b.textContent, b.classList.contains('primary')]));
  if (AI_ON_PRO) {
    // More AI designs are on the Pro list (server/src/proPlan AI_ON_PRO, back
    // on 8 Nov 2026): one blue way on (the gift), one quiet alternative.
    check('…one blue way on (the gift) and one quiet alternative', acts.length === 2 && acts[0][0] === 'Use my Pro gift' && acts[0][1] && acts[1][0] === 'Use the Quick Designer' && !acts[1][1], JSON.stringify(acts));
    await p.locator('#ai-state .ai-state-actions button').first().click();
    check('the gift sheet opens from the card, and says when it would end', await waitFor(p, () => /Your 7-day Pro gift/.test(document.querySelector('.pro-sheet h2')?.textContent || '') && !!document.querySelector('.pro-sheet .pro-when')));
    await p.keyboard.press('Escape');
    check('Escape closes it without starting anything', await waitFor(p, () => !document.querySelector('.pro-sheet-backdrop')) && (await api('/api/pro', fan.token)).json.gift.state === 'offered');
  } else {
    // Off the list, Pro gives no more of them: running out sells nothing.
    check('…no Pro and no gift for designs Pro gives no more of: the Quick Designer, alone', acts.length === 1 && acts[0][0] === 'Use the Quick Designer' && acts[0][1] && !/Pro|gift/.test(await p.evaluate(() => document.querySelector('#ai-state')?.textContent || '')), JSON.stringify(acts));
  }
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
  check('the gift sheet says when it would end', !!(await p.$('.pro-sheet .pro-when')));
  const perks = await p.evaluate(() => [...document.querySelectorAll('.pro-sheet .pro-perks li')].map((l) => l.textContent));
  const listed = perks.some((x) => /cut-out/.test(x)) && perks.some((x) => /any export/.test(x)) && perks.some((x) => /9:16/.test(x)) && perks.some((x) => /Pro fonts/.test(x)) && perks.some((x) => /Club kit/.test(x)) && !perks.some((x) => /Super/.test(x));
  if (AI_ON_PRO) check('…listing all of Pro: more AI and Polishes, the cut-out, clean exports, the video sizes, styles and fonts, the club kit', listed && perks.length === 8 && /More AI designs/.test(perks[0]) && perks.some((x) => /Polish/.test(x)), JSON.stringify(perks));
  else check('…listing only what Pro adds: the cut-out, clean exports, the video sizes, styles and fonts, the club kit, and no more AI designs or Polishes', listed && perks.length === 5 && !perks.some((x) => /AI designs|Polish|limit cards/.test(x)), JSON.stringify(perks));
  await p.click('.pro-sheet [data-act="start"]');
  check('Start runs the gift', await waitFor(p, () => /Your Pro gift is on/.test(document.querySelector('.pro-sheet h2')?.textContent || '')));
  const st = (await api('/api/pro', fan.token)).json;
  check('…the server says so: the gift plan, 7 days from now', st.plan === 'gift' && Math.abs(Date.parse(st.pass.endsAt) - Date.now() - 7 * 86400e3) < 120e3, JSON.stringify({ plan: st.plan, ends: st.pass?.endsAt }));
  await p.click('.pro-sheet [data-act="done"]');
  check('the gift card goes, and the header counts down', await waitFor(p, () => !document.querySelector('.pro-card:not([hidden])') && /Pro · 7 days left/.test(document.querySelector('.pro-head-chip:not([hidden])')?.textContent || '')));
  const again = await p.evaluate(() => fetch('/api/pro/gift/accept', { method: 'POST', headers: { authorization: `Bearer ${localStorage.getItem('tifo_token_v1')}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status));
  check('a second accept from the page is refused', again === 409, String(again));
  await p.goto(`${B}/account`, { waitUntil: 'networkidle' });
  check('Account: the plan, when it ends, and four allowances', await waitFor(p, () => {
    const s = document.getElementById('pro');
    return !!s && !s.hidden && /Pro gift/.test(s.textContent) && /Ends/.test(s.textContent) && s.querySelectorAll('.pro-meter').length === 4 && !/Super/.test(s.textContent);
  }));
  const day = AI_ON_PRO ? 15 : 10;
  check(`…designs at ${AI_ON_PRO ? "Pro's" : 'the free'} day (AI_ON_PRO)`, await p.evaluate((n) => new RegExp(`${n} of ${n} designs left today`).test(document.getElementById('pro')?.textContent || ''), day));
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  check('/pro: two plans, and "you have" instead of the notify button', await waitFor(p, () => document.querySelectorAll('.pp-plan').length === 2 && !document.getElementById('pp-you').hidden && document.getElementById('pp-act').hidden));
  const pp = await p.evaluate(() => ({
    pro: document.querySelector('#pp-plan-pro')?.closest('.pp-plan')?.textContent || '',
    free: document.querySelector('#pp-plan-free')?.closest('.pp-plan')?.textContent || '',
    group: !!document.querySelector('.pp-group'),
    over: document.documentElement.scrollWidth - innerWidth,
  }));
  check('…Pro with no price but the question, and every new perk in its column', !/SAR \d|USD \d/.test(pp.pro) && /What would you pay for a month of Pro\?/.test(pp.pro) && /30 days of Pro/.test(pp.pro) && ['any export', '9:16', '4K poster', 'Portrait styles', 'Pro fonts', 'LED boards', 'Club kit', 'Supporter crown'].every((w) => pp.pro.includes(w)), pp.pro.slice(0, 400));
  check('…Free: always free, a cut-out a week, none of Pro\'s perks', /1 a week/.test(pp.free) && /Always free/.test(pp.free), pp.free.slice(0, 300));
  if (AI_ON_PRO) check('…AI designs and Polish rows: Free 10 a day and 40 a month, Pro 15 and 70; and the smart cut-out', /10 a day/.test(pp.free) && /40 a month/.test(pp.free) && /15 a day/.test(pp.pro) && /70 a month/.test(pp.pro) && /Polish/.test(pp.pro) && /Smart cut-out/.test(pp.pro));
  else check('…no AI designs or Polish rows: Pro adds none (AI_ON_PRO), but the smart cut-out is there', !/AI designs|Polish/.test(pp.pro + pp.free) && /Smart cut-out/.test(pp.pro));
  check('…no Match Pass, Season Pass or group band', !/Match Pass|Season Pass/.test(pp.pro + pp.free) && !pp.group);
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  check('…and on a phone the two plans stack, Pro (with the question) first, nothing scrolling sideways', await p.evaluate(() => {
    const free = document.querySelector('.pp-plan:not(.pro)').getBoundingClientRect();
    const pro = document.querySelector('.pp-plan.pro').getBoundingClientRect();
    return free.top >= pro.bottom - 1 && document.documentElement.scrollWidth <= innerWidth;
  }));
  await ctx.close();
}
{
  const { ctx, p } = await page(fan.token, { lang: 'ar' });
  await p.goto(`${B}/ar/account`, { waitUntil: 'networkidle' });
  check('in Arabic: "باقتك" and the gift\'s name', await waitFor(p, () => { const s = document.getElementById('pro'); return !!s && !s.hidden && /باقتك/.test(s.textContent) && /الهدية المميّزة/.test(s.textContent); }));
  await p.goto(`${B}/ar/pro`, { waitUntil: 'networkidle' });
  check('/ar/pro: المميّزة قريب، بدون سعر، وتسأل كم تدفع', await waitFor(p, () => /كم تدفع على شهر المميّزة/.test(document.querySelector('#pp-plan-pro')?.closest('.pp-plan')?.textContent || '') && !/\d+ ريال/.test(document.querySelector('#pp-plan-pro')?.closest('.pp-plan')?.textContent || '') && document.documentElement.dir === 'rtl'));
  await p.goto(`${B}/ar/projects`, { waitUntil: 'networkidle' });
  check('…and the chip says مميّز', await waitFor(p, () => /^مميّز · باقي 7 أيام$/.test(document.querySelector('.pro-head-chip:not([hidden])')?.textContent || '')));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('…with nothing scrolling sideways', over <= 0, String(over));
  await ctx.close();
}

// =====================================================================
console.log('\n— the price question —');
{
  // Signed out, in English, on a laptop.
  const { ctx, p } = await page(null);
  await p.goto(`${B}/pro`, { waitUntil: 'networkidle' });
  await waitFor(p, () => !!document.getElementById('ps-amount'));
  check('signed out: the question is there, in dollars for an English page', await p.evaluate(() => document.querySelector('input[name="ps-cur"]:checked')?.value === 'USD'));
  check('…and "tell me" asks to sign in, quietly', await p.evaluate(() => { const b = document.querySelector('#pp-act [data-act="signin"]'); return !!b && b.classList.contains('quiet') && /Sign in to be told/.test(b.textContent); }));
  await p.click('#ps-send');
  check('an empty answer is caught on the page, and said why', await waitFor(p, () => /from 0 to 999/.test(document.getElementById('ps-msg')?.textContent || '') && document.getElementById('ps-amount').getAttribute('aria-invalid') === 'true'));
  await p.fill('#ps-amount', '12.5');
  await p.fill('#ps-comment', 'Worth it for the 4K poster');
  await p.click('#ps-send');
  check('sent: thanks, with the answer as given', await waitFor(p, () => /^Thanks! You said USD 12\.50 a month\.$/.test(document.querySelector('.ps-thanks')?.textContent || '')));
  check('…focus on "Change my answer"', await p.evaluate(() => document.activeElement?.classList.contains('ps-change')));
  check('…this browser keeps its own key for it', await p.evaluate(() => /^[A-Za-z0-9_-]{22,64}$/.test(localStorage.getItem('tifo_price_key_v1') || '')));
  await p.reload({ waitUntil: 'networkidle' });
  check('after a reload the answer is still there', await waitFor(p, () => /USD 12\.50/.test(document.querySelector('.ps-thanks')?.textContent || '')));
  await p.click('.ps-change');
  check('"Change my answer" brings the form back, filled in', await waitFor(p, () => document.getElementById('ps-amount')?.value === '12.5' && document.getElementById('ps-comment')?.value === 'Worth it for the 4K poster'));
  await p.click('.ps-cur label:has(input[value="SAR"])');
  await p.fill('#ps-amount', '15');
  await p.click('#ps-send');
  check('…and riyals can be chosen on an English page', await waitFor(p, () => /You said SAR 15 a month/.test(document.querySelector('.ps-thanks')?.textContent || '')));
  check('no blue button left once answered: thanks and a quiet way to change it', await p.evaluate(() => document.querySelectorAll('main .pp-btn:not(.quiet)').length === 0));
  check('…nothing scrolling sideways', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // The header link, on every public page.
  for (const path of ['/', '/community', '/clubs', '/projects', '/account', '/pro']) {
    await p.goto(`${B}${path}`, { waitUntil: 'domcontentloaded' });
    const link = await p.evaluate(() => { const a = document.querySelector('a[href="/pro"]'); return a ? { text: a.textContent.trim(), crown: !!a.querySelector('.pro-crown'), shown: a.getClientRects().length > 0 } : null; });
    check(`${path}: "Pro · soon" with its crown in the header`, !!link && link.text === 'Pro · soon' && link.crown && link.shown, JSON.stringify(link));
  }
  await ctx.close();
}
{
  // In Arabic, on a phone: riyals first, Arabic digits, the question before the free plan.
  const { ctx, p } = await page(null, { lang: 'ar', w: 390, h: 844 });
  await p.goto(`${B}/ar/pro`, { waitUntil: 'networkidle' });
  await waitFor(p, () => !!document.getElementById('ps-amount'));
  check('/ar/pro: riyals for an Arabic page', await p.evaluate(() => document.querySelector('input[name="ps-cur"]:checked')?.value === 'SAR'));
  check('…the Pro card, with the question, comes first on a phone', await p.evaluate(() => document.querySelector('.pp-plan.pro').getBoundingClientRect().top < document.querySelector('.pp-plan:not(.pro)').getBoundingClientRect().top));
  check('…the free plan says مجانية دايماً', await p.evaluate(() => /مجانية دايماً/.test(document.querySelector('.pp-plan:not(.pro)')?.textContent || '')));
  await p.fill('#ps-amount', '١٥٫٥');
  await p.click('#ps-send');
  check('Arabic digits and the Arabic decimal mark are read: شكراً! قلت 15.50 ريال بالشهر', await waitFor(p, () => /^شكراً! قلت 15\.50 ريال بالشهر\.$/.test(document.querySelector('.ps-thanks')?.textContent || '')));
  check('…nothing scrolling sideways', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await p.goto(`${B}/ar/`, { waitUntil: 'domcontentloaded' });
  check('the Arabic header says المميّزة · قريباً', await waitFor(p, () => [...document.querySelectorAll('a')].some((a) => /\/pro$/.test(a.getAttribute('href') || '') && a.textContent.trim() === 'المميّزة · قريباً')));
  await ctx.close();
}
{
  // What a visitor types reaches /admin as text, and the CSV cannot run it.
  const key = 'e2eXss' + 'x'.repeat(26);
  await api('/api/pro/price', null, { method: 'POST', body: JSON.stringify({ amount: 7, currency: 'USD', lang: 'en', device: key, comment: '<img src=x onerror="window.__pwned=1">' }) });
  await api('/api/pro/price', null, { method: 'POST', body: JSON.stringify({ amount: 9, currency: 'SAR', lang: 'ar', device: key.replace('x', 'y'), comment: '=HYPERLINK("http://x","y")' }) });
  const { ctx, p } = await page(null, { w: 1360, h: 1000 });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', ADMIN_PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="pro"]');
  // textContent: the section titles are upper-cased by CSS, which innerText would show.
  check('/admin → Pro: "What would you pay for Pro?" with every answer', await waitFor(p, () => /What would you pay for Pro\?/.test(document.body.textContent) && /4 answers so far/.test(document.body.textContent)));
  const adm = await p.evaluate(() => ({
    sar: [...document.querySelectorAll('table tr')].find((tr) => tr.firstElementChild?.textContent === 'SAR')?.textContent || '',
    pwned: window.__pwned === 1 || !!document.querySelector('img[src="x"]'),
    typed: document.body.innerText.includes('<img src=x onerror="window.__pwned=1">'),
    who: document.body.innerText.includes('signed out'),
  }));
  check('…a median per currency (SAR: 15, 15.5, 9 → SAR 15)', /SAR 15\b/.test(adm.sar), adm.sar);
  check('…a comment shows as the text that was typed, never as markup', !adm.pwned && adm.typed, JSON.stringify(adm));
  check('…a signed-out answer says so', adm.who);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('#price-csv')]);
  const csv = readFileSync(await dl.path(), 'utf8');
  check('the CSV: every answer, Excel-readable Arabic, formulas disarmed', csv.charCodeAt(0) === 0xfeff && csv.split('\r\n').filter(Boolean).length === 5 && csv.includes('"\'=HYPERLINK(""http://x"",""y"")"') && /when_utc,amount,currency,page_language,account,comment/.test(csv), csv.slice(0, 300));
  await ctx.close();
}

// =====================================================================
console.log('\n— PRO_MODE off —');
{
  const OFF = `http://127.0.0.1:${PORT_OFF}`;
  const r = await fetch(`${OFF}/pro`);
  check('/pro is the coming-soon page, linked from every header', r.status === 200, String(r.status));
  const ar = await fetch(`${OFF}/ar/pro`);
  check('…in Arabic too', ar.status === 200, String(ar.status));
  const u = await account('pro_fan', OFF);
  const st = await api('/api/pro', u.token, {}, OFF);
  check('/api/pro says nothing but the plans, even to a name that would be on the list', st.json.live === false && !!st.json.soon && Object.keys(st.json).sort().join() === 'live,notified,signedIn,soon', JSON.stringify(st.json).slice(0, 200));
  const q = await api('/api/ai/quota', u.token, {}, OFF);
  check('the AI quota is the old hourly one', q.status === 200 && !q.json.live && !q.json.allowances, JSON.stringify(q.json));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
