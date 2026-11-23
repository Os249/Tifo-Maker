/**
 * The three plans of 22 Nov 2026 in a real browser (docs/pro-three-plans.md):
 * /pro as one price list (the match pass, the month and the year), the year
 * bought and held, the plans named on the Post it sheet, the "What Pro adds"
 * sheet, the sheet after the gift and the account page, and what /legal and
 * /admin say. Against real servers on memory stores and a stand-in Moyasar
 * (scripts/fake-moyasar.mjs). No real key, card or email: the keys are
 * made-up ones of the live shape, and email goes to the log.
 *
 * Two servers: one with the new switches on (PRO_YEAR, PRO_THREE_PLANS), one
 * on sale as it is today with neither, where nothing new may show.
 *
 * Self-contained: it boots its own servers. Needs a build:
 *   npm run build && node e2e-pro-plans.mjs
 * PLANS_SHOTS=<folder> also saves screenshots of every screen it checks.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8961;      // the year and the three-plan page on
const PORT_OFF = 8962;  // on sale as it is today: neither
const FAKE = 8963;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const ADMIN_PW = 'e2e plans admin password';
const PK = 'pk_live_FAKEfake1234';
const SK = 'sk_live_FAKEfake1234'; // made up, of the live shape: only the stand-in ever sees it
const SHOTS = process.env.PLANS_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];

const moyasar = fakeMoyasar();
await moyasar.listen(FAKE);

const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
      AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_ADMIN_PASSWORD: ADMIN_PW, PUBLIC_URL: `http://127.0.0.1:${port}`,
      PRO_MODE: '', PRO_PREVIEW_USERS: '', PRO_CHECKOUT: '', MOYASAR_PUBLISHABLE_KEY: '', MOYASAR_VERIFY: '', PRO_AUTORENEW: '', PRO_AUTORENEW_MADA: '', MOYASAR_PROXY_URL: '',
      MOYASAR_METHODS: '', APPLE_PAY_DOMAIN_ASSOCIATION: '', MOYASAR_WEBHOOK_SECRET: '', MOYASAR_SECRET_KEY: '', PRO_PAYMENTS: '', PRO_AUTO_REFUND: '',
      PRO_LAUNCH_PRICE_UNTIL: '', PRO_PRICE_DISPLAY: '', PRO_DISCOUNT_LICENCE: '', PRO_FOUNDERS_BONUS: 'off',
      PRO_MONTHLY_PRICE: '', PRO_MATCH_PASS: '', PRO_MATCH_PRICE: '', PRO_MATCH_DAYS: '', PRO_AUTO_GIFT: '', PRO_GIFT_MAILS: '', PRO_POST_OFFERS: '',
      PRO_YEAR: '', PRO_YEAR_PRICE: '', PRO_THREE_PLANS: '',
      MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
      LAUNCH_JOB: 'off', LAUNCH_MAIL_TO_LOG: 'on',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
/** On sale as on the live site after the turnaround: the price setting, the match pass, Pro on Post it. */
const TODAY = {
  PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: SK, MOYASAR_PUBLISHABLE_KEY: PK, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: 'e2e-webhook-secret-of-some-length',
  PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on', PRO_POST_OFFERS: 'on',
};
const servers = [boot(PORT, { ...TODAY, PRO_YEAR: 'on', PRO_THREE_PLANS: 'on' }), boot(PORT_OFF, TODAY)];
const stop = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } moyasar.close(); };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 160; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
for (const base of [B, OFF]) {
  if (!(await up(base))) { console.error('server never came up\n' + out.join('').slice(-3000)); stop(); process.exit(1); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const codeFor = async (email) => {
  for (let i = 0; i < 60; i++) {
    const mine = out.join('').split('[email:dev] to=').filter((x) => x.startsWith(`${email} |`)).map((x) => /Your TifoMaker code: (\d{6})/.exec(x)).filter(Boolean).pop();
    if (mine) return mine[1];
    await sleep(250);
  }
  return null;
};
const account = async (username, base = B, verify = true) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  for (let i = 0; verify && i < 5; i++) {
    const v = await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) }, base);
    if (v.status < 300) break;
    if (i === 4) throw new Error(`could not verify ${username}: ${v.status} ${JSON.stringify(v.json)}`);
    await sleep(700);
  }
  return { token, email, username };
};
/** Buy the way the payment form does: the server's order, a payment at "Moyasar" under its id, 3-D Secure, the return. */
const buy = async (who, product = 'monthly', src = 'page', base = B) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: JSON.stringify({ lang: 'en', product, src }) }, base);
  if (!c.json?.form) throw new Error(`checkout: ${c.status} ${JSON.stringify(c.json)}`);
  const f = c.json.form;
  const made = await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl,
      metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: '4111111111111111', month: '12', year: '30', cvc: '123' },
    }),
  });
  if (made.status !== 201) throw new Error(`payment: ${made.status}`);
  moyasar.finish3ds(f.givenId, 'paid');
  const seen = await api(`/api/pro/pay/order/${c.json.order}`, who.token, {}, base);
  if (seen.json?.status !== 'paid') throw new Error(`not paid: ${JSON.stringify(seen.json)}`);
  return { order: c.json.order, form: f, seen: seen.json };
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !x ? '' : '  ' + x}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] }));
const errs = [];
/** A page as a fan has it: the language, the theme, the consent choice, the first-run layers already seen, and the account when there is one. */
const page = async (token, { lang = 'en', w = 1440, h = 900, scheme = 'light', consent = 'essential' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang, consent, scheme]) => {
    try {
      const keys = {
        tifo_consent_v1: consent, tifo_lang_v1: lang, tifo_theme_v1: scheme,
        tifo_guide_v1: 'done', tifo_view_v1: '3d', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_post_nudge_v1: '1',
      };
      for (const [k, v] of Object.entries(keys)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, consent, scheme]);
  /** The funnel events this page sent: read where the page hands them to the browser (a beacon's body cannot be read from outside). */
  const events = [];
  await ctx.exposeBinding('__planEvent', (_src, name) => { events.push(name); });
  await ctx.addInitScript(() => {
    const beacon = navigator.sendBeacon?.bind(navigator);
    if (!beacon) return;
    navigator.sendBeacon = (url, data) => {
      if (/\/api\/events$/.test(String(url)) && data && typeof data.text === 'function') void data.text().then((t) => { try { window.__planEvent(JSON.parse(t).name); } catch { /* */ } });
      return beacon(url, data);
    };
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p, events };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name, full = false) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); };
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const proUrl = (lang, base = B) => `${base}${lang === 'ar' ? '/ar/pro' : '/pro'}`;
/** What the price list shows, read off the page. */
const readList = (p) => p.evaluate(() => {
  const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
  const cols = [...document.querySelectorAll('.pt-col')].map((c) => ({
    plan: c.dataset.plan, text: c.innerText.replace(/\s+/g, ' ').trim(), asked: c.dataset.asked === '1',
    btn: c.querySelector('.pp-btn') ? { act: c.querySelector('.pp-btn').dataset.act, product: c.querySelector('.pp-btn').dataset.product, blue: solid(c.querySelector('.pp-btn')), h: Math.round(c.querySelector('.pp-btn').getBoundingClientRect().height), text: c.querySelector('.pp-btn').textContent.trim() } : null,
    top: Math.round(c.getBoundingClientRect().top), left: Math.round(c.getBoundingClientRect().left), bottom: Math.round(c.getBoundingClientRect().bottom),
  }));
  const open = document.getElementById('pp-open');
  return {
    cols, all: open?.innerText ?? '', html: open?.innerHTML ?? '',
    blues: [...document.querySelectorAll('#main a, #main button, .nav-cta')].filter((el) => el.offsetParent && solid(el)).length,
    trust: [...document.querySelectorAll('.pt-trust li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
    trustTop: Math.round(document.querySelector('.pt-trust')?.getBoundingClientRect().top ?? 0), listBottom: Math.round(document.querySelector('.pt-list')?.getBoundingClientRect().bottom ?? 0),
    table: [...document.querySelectorAll('.pt-table tbody tr')].map((tr) => [...tr.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim())),
    faq: [...document.querySelectorAll('.pp-faq details')].filter((d) => !d.hidden).map((d) => d.querySelector('summary')?.textContent.trim()),
    h1: document.getElementById('pp-h')?.textContent.trim() ?? '', old: !!document.querySelector('.pp-plan'), steps: !!document.querySelector('.ps-steps')?.offsetParent,
    pics: [...document.querySelectorAll('.pt-show img')].map((i) => i.getAttribute('src')),
  };
});
/** Words that would make a standing price look like a licensed discount or a pressure sale. */
const PRESSURE = /<s[ >]|line-through|was SAR|\bsave\b|% off|\d+%|discount|months? free|most popular|best ?seller|hurry|ends in|limited time|only \d+ left|خصم(?!\s*منك)|تخفيض|الأكثر مبيع|لفترة محدودة|شهرين مجان/i;

const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).json?.token;
const asBoss = { 'x-ai-unlock': unlock };
const unlockOff = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) }, OFF)).json?.token;

// =====================================================================
console.log('\n— the new switches off: nothing changes for a fan —');
{
  const st = (await api('/api/pro', null, {}, OFF)).json;
  check('/api/pro: the month and the match pass as today, no year, no three-plan page', st?.offer?.monthly?.price === 9.99 && st.offer.match?.price === 4.99 && !st.offer.year && !st.offer.plans, JSON.stringify(st?.offer).slice(0, 300));
  const fan = await account('po_fan', OFF);
  check('the year cannot be bought', (await api('/api/pro/pay/checkout', fan.token, { method: 'POST', body: '{"lang":"en","product":"year"}' }, OFF)).status === 404);
  const legal = await (await fetch(`${OFF}/legal`)).text();
  check('/legal says nothing of a year', !/<b>The year\.<\/b>|<b>السنة\.<\/b>/.test(legal) && !legal.includes('{{'));
  const adm = (await api('/api/admin/pro', null, { headers: { 'x-ai-unlock': unlockOff } }, OFF)).json;
  check('/admin reads both new switches as off', adm?.settings && adm.settings.year?.asked === false && adm.settings.threePlans === false, JSON.stringify(adm?.settings));
  const raw = await (await fetch(`${OFF}/pro`)).text();
  check('/pro is sent as it was: no three-plan class, the old title', !/plans3/.test(raw) && /data-i18n="pb\.title"/.test(raw));
  {
    const { ctx, p } = await page(null);
    await p.goto(proUrl('en', OFF), { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('pb-match'));
    const o = await p.evaluate(() => ({ list: !!document.querySelector('.pt-list'), cards: document.querySelectorAll('.pp-plan').length, match: !!document.getElementById('pb-match'), text: document.getElementById('pp-open').innerText, steps: !!document.querySelector('.ps-steps')?.offsetParent, show: !!document.querySelector('.pp-show')?.offsetParent }));
    check('/pro: Free against Pro with the match pass under the month, as before; no price list, no year', !o.list && o.cards === 2 && o.match && o.steps && o.show && !/89\.99|365/.test(o.text), JSON.stringify({ ...o, text: '' }));
    await shot(p, 'off-pro-en-desktop', true);
    await ctx.close();
  }
  {
    // The account page and its "What Pro adds" sheet name no other plan.
    const { ctx, p } = await page(fan.token);
    await p.goto(`${OFF}/account#pro`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.querySelector('.pro-ac-get'));
    check('the account page: Get Pro as before, and no plans named', await p.evaluate(() => !document.querySelector('[data-plans]') && /Get Pro for SAR 9\.99/.test(document.querySelector('.pro-ac-get')?.textContent ?? '') && document.querySelector('.pro-ac-get')?.getAttribute('href') === '/pro'));
    await p.evaluate(() => document.querySelector('#pro [data-act="what"]')?.click());
    await waitFor(p, () => !!document.querySelector('.pro-sheet [data-act="get"]'));
    check('the "What Pro adds" sheet: the match pass in its one quiet line, as before', await p.evaluate(() => !document.querySelector('.pro-sheet [data-plans]') && !!document.querySelector('.pro-sheet [data-act="match"]') && /Get Pro for SAR 9\.99/.test(document.querySelector('.pro-sheet [data-act="get"]')?.textContent ?? '')));
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— /pro: one price list, three plans —');
{
  const st = (await api('/api/pro', null)).json;
  check('/api/pro: the year at SAR 89.99 for 365 days (SAR 7.50 a month), and the three-plan page', st?.offer?.year?.price === 89.99 && st.offer.year.days === 365 && st.offer.year.perMonth === 7.5 && st.offer.plans === true && st.offer.monthly.price === 9.99 && st.offer.match?.price === 4.99, JSON.stringify(st?.offer).slice(0, 300));
  const raw = await (await fetch(`${B}/pro`)).text();
  check('the page is sent already laid out as the price list, with its own title', /id="pp-open" class="on-sale plans3"/.test(raw) && /data-i18n="pt\.title">Your tifo, the way it looks on match day</.test(raw) && !/SAR \d/.test(raw.split('<main')[1] ?? ''), 'no price is ever in the HTML');
  for (const [lang, w, h, scheme] of [['ar', 390, 844, 'light'], ['ar', 390, 844, 'dark'], ['en', 1440, 900, 'light'], ['en', 1440, 900, 'dark'], ['en', 390, 844, 'light'], ['ar', 1440, 900, 'dark']]) {
    const name = `pro-${lang}-${w}-${scheme}`;
    const { ctx, p } = await page(null, { lang, w, h, scheme });
    await p.goto(proUrl(lang), { waitUntil: 'domcontentloaded' });
    const there = await waitFor(p, () => document.querySelectorAll('.pt-col').length === 3 && !!document.querySelector('.pt-table'));
    const o = await readList(p);
    const by = Object.fromEntries(o.cols.map((c) => [c.plan, c]));
    const ar = lang === 'ar';
    check(`${name}: three plans, shortest first: the match pass, the month, the year`, there && o.cols.map((c) => c.plan).join() === 'match,monthly,year' && !o.old && !o.steps);
    check(`${name}: each says its length and its whole price`, ar
      ? /72 ساعة/.test(by.match?.text) && /4\.99 ريال/.test(by.match.text) && /30 يوم/.test(by.monthly.text) && /9\.99 ريال/.test(by.monthly.text) && /365 يوم/.test(by.year.text) && /89\.99 ريال/.test(by.year.text)
      : /72 hours/.test(by.match?.text) && /SAR 4\.99/.test(by.match.text) && /30 days/.test(by.monthly.text) && /SAR 9\.99/.test(by.monthly.text) && /365 days/.test(by.year.text) && /SAR 89\.99/.test(by.year.text), JSON.stringify(o.cols.map((c) => c.text)));
    check(`${name}: a price per day on every plan, and the year's price per month`, ar
      ? /1\.66 ريال باليوم/.test(by.match?.text) && /0\.33 ريال باليوم/.test(by.monthly.text) && /0\.25 ريال باليوم/.test(by.year.text) && /يعني 7\.50 ريال بالشهر/.test(by.year.text)
      : /SAR 1\.66 a day/.test(by.match?.text) && /SAR 0\.33 a day/.test(by.monthly.text) && /SAR 0\.25 a day/.test(by.year.text) && /Works out at SAR 7\.50 a month/.test(by.year.text));
    check(`${name}: the match pass says it is the same Pro as the month, only shorter`, ar ? /نفس برو حق الشهر بالضبط، بس مدته أقصر/.test(by.match?.text) : /The same Pro as the month, only shorter/.test(by.match?.text));
    check(`${name}: the month is marked as our pick, and nothing is called most popular`, (ar ? /اللي ننصح فيه/ : /Our pick/).test(by.monthly?.text) && !(ar ? /اللي ننصح فيه/ : /Our pick/).test(by.match.text + by.year.text));
    check(`${name}: one blue button on the screen, the month's; the others are outlines`, o.blues === 1 && by.monthly?.btn?.blue && !by.match.btn.blue && !by.year.btn.blue, `${o.blues} blue`);
    check(`${name}: each button names its plan and its price`, ar
      ? /خذ باقة المباراة بـ4\.99 ريال/.test(by.match?.btn.text) && /خذ الشهر بـ9\.99 ريال/.test(by.monthly.btn.text) && /خذ السنة بـ89\.99 ريال/.test(by.year.btn.text)
      : /Get a match pass · SAR 4\.99/.test(by.match?.btn.text) && /Get the month · SAR 9\.99/.test(by.monthly.btn.text) && /Get the year · SAR 89\.99/.test(by.year.btn.text));
    check(`${name}: one payment, never renews, and the whole price with no VAT, said above the plans`, ar ? /دفعة وحدة، وما يتجدد لحاله أبد/.test(o.all) && /ضريبة قيمة مضافة/.test(o.all) : /One payment\. It never renews by itself\./.test(o.all) && /no VAT is added/.test(o.all));
    check(`${name}: the refund promise, Moyasar and "nothing renews" right under the list`, o.trust.length === 3 && o.trustTop - o.listBottom < 40 && (ar
      ? /ترجع لك فلوسك كاملة خلال 7 أيام/.test(o.trust[0]) && /بطاقتك عند ميسّر/.test(o.trust[1]) && /ما يتجدد شي لحاله/.test(o.trust[2])
      : /All your money back within 7 days/.test(o.trust[0]) && /Moyasar handles your card/.test(o.trust[1]) && /Nothing renews by itself/.test(o.trust[2])), JSON.stringify(o.trust));
    check(`${name}: no crossed-out price, no percentage, no "save", no deadline, no "most popular"`, !PRESSURE.test(o.html), (o.html.match(PRESSURE) || [''])[0]);
    check(`${name}: no timer and nothing pre-ticked`, await p.evaluate(() => !document.querySelector('#pp-open input[type="checkbox"], #pp-open [class*="timer"], #pp-open [class*="countdown"]')));
    check(`${name}: one table of Free against Pro, with the server's limits`, o.table.length >= 8 && o.table.some((r) => /3/.test(r[1]) && /15/.test(r[2])) && o.table.some((r) => /^1 /.test(r[1]) || /1/.test(r[1]) && /6/.test(r[2])), JSON.stringify(o.table.slice(0, 5)));
    check(`${name}: what Pro makes is shown: the vertical video, the 4K poster, the film`, o.pics.join() === '/pro/reel-cut.webp,/pro/poster.webp,/pro/film.webp');
    check(`${name}: the first question is the difference between the plans`, ar ? /وش الفرق بين الباقات/.test(o.faq[0]) : /difference between the plans/.test(o.faq[0]), o.faq[0]);
    check(`${name}: the hero sells what Pro makes`, ar ? /تيفوك مثل ما يطلع يوم المباراة/.test(o.h1) : /Your tifo, the way it looks on match day/.test(o.h1));
    check(`${name}: nothing is wider than the page`, await fits(p));
    if (w < 600) {
      check(`${name}: on a phone the plans are stacked, each button a finger tall`, by.match.top < by.monthly.top && by.monthly.top < by.year.top && o.cols.every((c) => c.btn.h >= 44) && o.cols.every((c) => c.left === o.cols[0].left));
      check(`${name}: every target in the page is at least 44px`, await p.evaluate(() => [...document.querySelectorAll('#pp-open button, #pp-open a, #pp-open summary')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().height >= 43.5)));
    } else {
      check(`${name}: on a desktop the three plans sit side by side`, by.match.top === by.monthly.top && by.monthly.top === by.year.top && new Set(o.cols.map((c) => c.left)).size === 3);
    }
    if (ar) check(`${name}: the page reads right to left, with Western digits, and the month is not left of the year`, await p.evaluate(() => document.documentElement.dir === 'rtl') && !/[٠-٩]/.test(o.all) && (w < 600 || by.match.left > by.year.left));
    check(`${name}: the theme is the one asked for`, await p.evaluate((s) => (document.documentElement.dataset.theme || 'light') === s, scheme));
    await shot(p, name, true);
    await p.evaluate(() => document.querySelector('.pt-list')?.scrollIntoView({ block: 'start' }));
    await shot(p, `${name}-list`);
    if (lang === 'en' && w > 600 && scheme === 'light') {
      // Free or with Pro: the film's switch swaps the picture, and says which is showing.
      await p.evaluate(() => document.querySelector('.pt-seg [data-film="free"]')?.click());
      check('the film shows the same tifo free or with Pro, a tap apart', await p.evaluate(() => document.getElementById('pt-film')?.getAttribute('src') === '/pro/free-video.webp' && document.querySelector('.pt-seg [data-film="free"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.pt-seg [data-film="pro"]')?.getAttribute('aria-pressed') === 'false'));
      // The language switch keeps the page a price list.
      await p.evaluate(() => document.getElementById('lang-toggle')?.click());
      await p.waitForTimeout(400);
      check('switching language repaints the same list in Arabic', await p.evaluate(() => document.querySelectorAll('.pt-col').length === 3 && /365 يوم/.test(document.querySelector('.pt-col[data-plan="year"]')?.innerText ?? '') && /وش الفرق بين الباقات/.test(document.getElementById('pt-faq-plans')?.innerText ?? '')));
    }
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— /pro: counting, arriving from a link, and buying —');
{
  // A visitor who allowed counting: the plan list seen, and the plan pressed.
  const { ctx, p, events } = await page(null, { consent: 'all' });
  await p.goto(`${B}/pro?from=export&plan=year`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.querySelectorAll('.pt-col').length === 3);
  await p.waitForTimeout(800);
  check('/pro?from=export&plan=year: the address is cleaned, and the year is the plan marked and in view', await p.evaluate(() => location.search === '' && document.querySelector('.pt-col[data-plan="year"]')?.dataset.asked === '1' && !document.querySelector('.pt-col[data-plan="monthly"]')?.dataset.asked && document.querySelector('.pt-col[data-plan="year"]').getBoundingClientRect().top < innerHeight));
  check('the page counts the offer and the plan list as seen', events.includes('pro_offer_page') && events.includes('pro_plans_page'), events.join());
  await p.evaluate(() => document.querySelector('.pt-col[data-plan="year"] .pp-btn')?.click());
  await waitFor(p, () => !!document.querySelector('[role="dialog"], .auth-modal, dialog[open]'), null, 15000);
  await p.waitForTimeout(500);
  check('pressing the year, signed out: counted as the year chosen on the page, and sign-up opens before any payment', events.includes('pro_pick_year_page') && events.includes('pro_get_page') && await p.evaluate(() => !!document.querySelector('[role="dialog"], .auth-modal, dialog[open]')), events.join());
  await ctx.close();
}
{
  // A visitor who did not allow counting sends nothing.
  const { ctx, p, events } = await page(null, { consent: 'essential' });
  await p.goto(`${B}/pro`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.querySelectorAll('.pt-col').length === 3);
  await p.waitForTimeout(800);
  check('without consent nothing is counted', events.length === 0, events.join());
  await ctx.close();
}
const buyer = await account('pp_buyer');
{
  const { ctx, p } = await page(buyer.token, { consent: 'all' });
  await p.goto(`${B}/pro`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.querySelectorAll('.pt-col .pp-btn[data-act="buy"]').length === 3);
  check('signed in with a verified email: every plan has its own buy button', await p.evaluate(() => [...document.querySelectorAll('.pt-col .pp-btn')].map((b) => `${b.dataset.act}:${b.dataset.product}`).join() === 'buy:match,buy:monthly,buy:year'));
  // The year's button opens the payment form under the plans, saying what is being paid for.
  await p.evaluate(() => document.querySelector('.pt-col[data-plan="year"] .pp-btn')?.click());
  const opened = await waitFor(p, () => !document.getElementById('pb-form')?.hidden && !!document.getElementById('pt-paying'), null, 20000);
  const f = await p.evaluate(() => ({
    paying: document.getElementById('pt-paying')?.textContent ?? '', lit: [...document.querySelectorAll('.pt-col[data-paying]')].map((c) => c.dataset.plan).join(),
    btns: [...document.querySelectorAll('.pt-col .pp-btn')].filter((b) => b.offsetParent).length, keep: !!document.getElementById('pb-keep'), close: !!document.querySelector('[data-act="form-close"]'),
  }));
  check('the year: the form opens under the list and says "Year · 365 days · SAR 89.99"', opened && /Year · 365 days · SAR 89\.99/.test(f.paying) && f.lit === 'year', JSON.stringify(f));
  check('while one plan is being paid for, the other buttons step aside, and no "Keep Pro on" box is offered with a year', f.btns === 0 && !f.keep && f.close);
  const order = (await api('/api/admin/pro/orders', null, { headers: asBoss })).json?.orders?.find((o) => o.username === 'pp_buyer');
  check('the order is the server\'s: a year, 365 days, SAR 89.99, from the page', order?.product === 'year' && order.days === 365 && order.amount === 89.99 && order.src === 'page' && order.status === 'pending', JSON.stringify(order));
  await shot(p, 'pro-en-desktop-year-form');
  await p.evaluate(() => document.querySelector('[data-act="form-close"]')?.click());
  check('"Not now" closes it and the three buttons are back', await waitFor(p, () => document.getElementById('pb-form')?.hidden && [...document.querySelectorAll('.pt-col .pp-btn')].filter((b) => b.offsetParent).length === 3 && !document.querySelector('.pt-col[data-paying]'), null, 5000));
  await ctx.close();
}
{
  // Paid (through the stand-in, as the form would): the year is on, the page says until when, and nothing more is sold to its holder.
  const paid = await buy(buyer, 'year', 'page');
  const { ctx, p, events } = await page(buyer.token, { consent: 'all' });
  await p.goto(`${B}/pro?order=${paid.order}`, { waitUntil: 'domcontentloaded' });
  const said = await waitFor(p, () => /Your year of Pro is on until/.test(document.getElementById('pp-paid')?.textContent ?? ''), null, 30000);
  check('back from paying: "Your year of Pro is on until ..." and the receipt is on its way', said, await p.evaluate(() => document.getElementById('pp-paid')?.textContent ?? ''));
  await p.waitForTimeout(600);
  check('the purchase is counted by plan', events.includes('year_bought') && events.includes('pro_paid'), events.join());
  const o = await p.evaluate(() => ({ state: document.querySelector('.pt-state')?.innerText ?? '', btns: document.querySelectorAll('.pt-col .pp-btn').length, cols: document.querySelectorAll('.pt-col').length }));
  check('holding a year: the list says until when, and no plan can be bought again until near its end', /You have Pro until/.test(o.state) && /last week/.test(o.state) && o.btns === 0 && o.cols === 3, JSON.stringify(o));
  const me = (await api('/api/pro', buyer.token)).json;
  const days = Math.round((Date.parse(me?.pass?.endsAt) - Date.now()) / 86400000);
  check('the pass runs 365 days', me?.plan === 'monthly' && days === 365, `${me?.plan} ${days}`);
  for (const product of ['year', 'monthly', 'match']) check(`pressing again is refused: ${product}`, (await api('/api/pro/pay/checkout', buyer.token, { method: 'POST', body: JSON.stringify({ lang: 'en', product }) })).status === 409);
  await shot(p, 'pro-en-desktop-year-held', true);
  await ctx.close();
  const receipt = out.join('').split('[email:dev] to=').filter((x) => x.startsWith(`${buyer.email} |`)).some((x) => /receipt/i.test(x.split('\n')[0]));
  check('a receipt went to the buyer (to the log here: no real email)', receipt);
}
{
  // Holding a month: the year can be bought now, and it is the one blue button; the month and the match pass wait.
  const monthly = await account('pp_monthly');
  await buy(monthly, 'monthly', 'page');
  const { ctx, p } = await page(monthly.token);
  await p.goto(`${B}/pro`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.pt-state'));
  const o = await readList(p);
  const state = await p.evaluate(() => document.querySelector('.pt-state')?.innerText ?? '');
  check('holding a month: only the year has a button, it is the one blue button, and the page says it starts when the month ends', o.cols.filter((c) => c.btn).map((c) => c.plan).join() === 'year' && o.cols.find((c) => c.plan === 'year').btn.blue && o.blues === 1 && /You can get the year now: it starts when this Pro ends/.test(state), state);
  const got = await buy(monthly, 'year', 'page');
  const me = (await api('/api/pro/purchases', monthly.token)).json;
  check('the year bought over a month starts when the month ends: 395 days of Pro in all, none overlapping', got.seen.status === 'paid' && Math.round((Date.parse(got.seen.endsAt) - Date.now()) / 86400000) === 395, JSON.stringify({ ends: got.seen.endsAt, n: me?.orders?.length }));
  await ctx.close();
}

// =====================================================================
console.log('\n— the same plans wherever Pro is sold —');
const free = await account('pp_free');
{
  for (const [lang, w, h, name] of [['en', 1440, 900, 'account-en-desktop'], ['ar', 390, 844, 'account-ar-phone']]) {
    const { ctx, p, events } = await page(free.token, { lang, w, h, consent: 'all' });
    await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/account#pro`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.querySelector('#pro [data-plans="account"]'));
    const a = await p.evaluate(() => {
      const box = document.querySelector('#pro [data-plans="account"]');
      return { get: document.querySelector('.pro-ac-get')?.textContent.trim(), href: document.querySelector('.pro-ac-get')?.getAttribute('href'), text: box?.innerText ?? '', links: [...(box?.querySelectorAll('a') ?? [])].map((x) => x.getAttribute('href')), h: [...(box?.querySelectorAll('a') ?? [])].map((x) => Math.round(x.getBoundingClientRect().height)) };
    });
    const ar = lang === 'ar';
    check(`${name}: the month's button, then the match pass and the year named with their whole price and length`, (ar ? /خذ الشهر بـ9\.99 ريال/.test(a.get) && /باقة المباراة: 72 ساعة بـ4\.99 ريال/.test(a.text) && /سنة: 365 يوم بـ89\.99 ريال \(يعني 7\.50 ريال بالشهر\)/.test(a.text) && /نفس برو/.test(a.text)
      : /Get the month · SAR 9\.99/.test(a.get) && /Match pass: 72 hours for SAR 4\.99/.test(a.text) && /Year: 365 days for SAR 89\.99 \(SAR 7\.50 a month\)/.test(a.text) && /The same Pro/.test(a.text)), JSON.stringify(a));
    check(`${name}: each goes to /pro saying where from and which plan`, /\/pro\?from=account$/.test(a.href) && a.links.length === 2 && /from=account&plan=match$/.test(a.links[0]) && /from=account&plan=year$/.test(a.links[1]) && (w > 600 || a.h.every((x) => x >= 44)), JSON.stringify(a.links));
    await p.waitForTimeout(500);
    check(`${name}: the account page counts as a place the offer and the plans were seen`, events.includes('pro_offer_account') && events.includes('pro_plans_account'), events.join());
    check(`${name}: nothing is wider than the page`, await fits(p));
    await p.evaluate(() => document.getElementById('pro')?.scrollIntoView({ block: 'start' }));
    await shot(p, name);
    if (lang === 'en') {
      // "What Pro adds": the sheet behind every limit card.
      await p.evaluate(() => document.querySelector('#pro [data-act="what"]')?.click());
      await waitFor(p, () => !!document.querySelector('.pro-sheet [data-plans]'));
      const s = await p.evaluate(() => {
        const sh = document.querySelector('.pro-sheet');
        const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
        return { text: sh.innerText, get: sh.querySelector('[data-act="get"]')?.textContent.trim(), plans: [...sh.querySelectorAll('[data-act="plan"]')].map((x) => x.getAttribute('href')), blues: [...sh.querySelectorAll('a, button')].filter(solid).length, html: sh.innerHTML };
      });
      check('the "What Pro adds" sheet: one blue button for the month, and the match pass and the year named under it', s.blues === 1 && /Get the month · SAR 9\.99/.test(s.get) && s.plans.length === 2 && /plan=match$/.test(s.plans[0]) && /plan=year$/.test(s.plans[1]) && /Year: 365 days for SAR 89\.99/.test(s.text), JSON.stringify({ get: s.get, plans: s.plans, blues: s.blues }));
      check('the sheet: the crown is not said to be the month\'s, and nothing reads as a discount', /The Supporter crown beside your name/.test(s.text) && !/with Pro monthly/.test(s.text) && !PRESSURE.test(s.html));
      await p.waitForTimeout(700);
      await shot(p, 'sheet-what-pro-adds');
      await p.evaluate(() => document.querySelector('.pro-sheet [data-act="plan"][data-plan="year"]')?.addEventListener('click', (e) => e.preventDefault()));
      await p.evaluate(() => document.querySelector('.pro-sheet [data-act="plan"][data-plan="year"]')?.click());
      await p.waitForTimeout(500);
      check('pressing the year on the sheet is counted as the year chosen there', events.includes('pro_pick_year_limit') && events.includes('pro_plans_limit'), events.join());
    }
    await ctx.close();
  }
}
{
  // The sheet after the gift: keep Pro for a month, with the other plans under it.
  const ended = await account('pp_ended', B, false);
  const { ctx, p } = await page(ended.token, { consent: 'all' });
  await p.route('**/api/pro', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.plan = 'free';
    body.pass = null;
    body.gift = { state: 'used', endedAt: new Date(Date.now() - 3600_000).toISOString(), auto: true, endCard: true, made: { items: { 'pexp.item.vertical': 3 }, ai: 2 } };
    await route.fulfill({ response: res, json: body });
  });
  await p.route('**/api/pro/gift/end-seen', (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await p.goto(`${B}/projects`, { waitUntil: 'domcontentloaded' });
  const shown = await waitFor(p, () => !!document.querySelector('[data-pro-gift-end] .pro-sheet [data-plans="giftend"]'), null, 30000);
  const c = await p.evaluate(() => {
    const s = document.querySelector('[data-pro-gift-end] .pro-sheet');
    const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
    return { text: s?.innerText ?? '', get: s?.querySelector('[data-act="get"]')?.textContent.trim() ?? '', plans: [...(s?.querySelectorAll('[data-act="plan"]') ?? [])].map((x) => x.getAttribute('href')), blues: [...(s?.querySelectorAll('a, button') ?? [])].filter(solid).length, later: !!s?.querySelector('[data-act="later"]') };
  });
  check('after the gift: one blue "Keep Pro for a month", the match pass and the year under it, and "Not now"', shown && c.blues === 1 && /Keep Pro for a month · SAR 9\.99/.test(c.get) && c.plans.length === 2 && /from=giftend&plan=match$/.test(c.plans[0]) && /from=giftend&plan=year$/.test(c.plans[1]) && c.later, JSON.stringify(c).slice(0, 400));
  await p.waitForTimeout(700);
  await shot(p, 'sheet-gift-end');
  await ctx.close();
}
{
  // The Post it sheet: the month's gold button, and the other plans named under it.
  const openEditor = async (p) => {
    await p.goto(`${B}/projects?new=1&e2e`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => document.querySelectorAll('.st-club').length >= 8, null, 90000);
    await p.evaluate(() => document.querySelector('.st-club[data-club="nassr"]')?.click());
    await waitFor(p, () => document.querySelector('.st-opt.on')?.dataset.start === 'club', null, 10000);
    await p.evaluate(() => document.getElementById('st-go')?.click());
    return waitFor(p, () => !!document.getElementById('post-tifo') && !!document.getElementById('rail-anim'), null, 90000);
  };
  const plain = await account('pp_post', B, false);
  for (const [lang, w, h, name] of [['en', 1440, 900, 'post-en-desktop'], ['ar', 390, 844, 'post-ar-phone']]) {
    const { ctx, p, events } = await page(plain.token, { lang, w, h, consent: 'all' });
    const there = await openEditor(p);
    await p.waitForTimeout(2500);
    await p.evaluate(() => document.getElementById('post-tifo')?.click());
    const sum = await waitFor(p, () => !!document.querySelector('[data-post-sheet] .pp2-sum'), null, 60000);
    await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2-sum')?.click());
    await waitFor(p, () => !!document.querySelector('[data-post-sheet] [data-plans="post"]'), null, 10000);
    const o = await p.evaluate(() => {
      const b = document.querySelector('[data-post-sheet] .pp2-body');
      const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
      return { text: b?.innerText ?? '', html: b?.innerHTML ?? '', get: [...(b?.querySelectorAll('[data-act="get"]') ?? [])].map((a) => a.getAttribute('href')), plans: [...(b?.querySelectorAll('[data-act="plan"]') ?? [])].map((a) => a.getAttribute('href')), blueInPro: [...(b?.querySelectorAll('a, button') ?? [])].filter(solid).length };
    });
    const ar = lang === 'ar';
    check(`${name}: the Post it sheet opens with Pro's part`, there && sum, `editor ${there}`);
    check(`${name}: the month in plain words, then the match pass and the year named under its button`, (ar
      ? /برو بـ9\.99 ريال لمدة 30 يوم، دفعة وحدة/.test(o.text) && /باقة المباراة: 72 ساعة بـ4\.99 ريال/.test(o.text) && /سنة: 365 يوم بـ89\.99 ريال/.test(o.text)
      : /Pro is SAR 9\.99 for 30 days, one payment\./.test(o.text) && /Match pass: 72 hours for SAR 4\.99/.test(o.text) && /Year: 365 days for SAR 89\.99 \(SAR 7\.50 a month\)/.test(o.text)), o.text.slice(0, 400));
    check(`${name}: one button for the month and two quiet links, each to /pro with its place and plan`, o.get.length === 1 && /\/pro\?from=post$/.test(o.get[0]) && o.plans.length === 2 && /from=post&plan=match$/.test(o.plans[0]) && /from=post&plan=year$/.test(o.plans[1]), JSON.stringify(o));
    check(`${name}: nothing in Pro's part is blue, and nothing reads as a discount`, o.blueInPro === 0 && !PRESSURE.test(o.html));
    await p.waitForTimeout(400);
    check(`${name}: the plans named on Post it are counted as seen there`, events.includes('pro_plans_post') && events.includes('pro_offer_post'), events.join());
    check(`${name}: nothing is wider than the page`, await fits(p));
    await p.evaluate(() => document.querySelector('[data-post-sheet] [data-plans="post"]')?.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(300);
    await shot(p, name);
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— purchases, the receipt, /legal and /admin —');
{
  const { ctx, p } = await page(buyer.token);
  await p.goto(`${B}/account#pro`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => /a year: 365 days/.test(document.getElementById('pro')?.innerText ?? ''), null, 30000);
  const t = await p.evaluate(() => document.getElementById('pro')?.innerText ?? '');
  check('the account page: the plan reads "Pro", and the purchase is "Pro, a year: 365 days" at SAR 89.99', /Pro, a year: 365 days/.test(t) && /SAR 89\.99/.test(t) && !/Pro monthly/.test(t), t.slice(0, 300));
  await p.evaluate(() => document.getElementById('pro')?.scrollIntoView({ block: 'start' }));
  await shot(p, 'account-year-purchase');
  await ctx.close();
}
{
  const legal = await (await fetch(`${B}/legal`)).text();
  check('/legal: the year\'s terms with its numbers, in both languages', /<b>The year\.<\/b> A year is the same Pro for 365 days, for one payment of SAR 89\.99/.test(legal) && /"SAR 7\.50 a month"/.test(legal) && /not a monthly charge/.test(legal) && /if I stop providing Pro before your year ends/.test(legal)
    && /<b>السنة\.<\/b>/.test(legal) && /لمدة 365 يوم/.test(legal) && /89\.99 ريال/.test(legal) && !legal.includes('{{'));
  check('/legal still has the match pass and the month\'s terms beside it', /same Pro for 72 hours/.test(legal) && /one payment of SAR 4\.99/.test(legal));
  const adm = (await api('/api/admin/pro', null, { headers: asBoss })).json;
  check('/admin reads the switches: the year on at SAR 89.99 for 365 days, the three-plan page on', adm?.settings?.year?.asked === true && adm.settings.year.price === 89.99 && adm.settings.year.days === 365 && adm.settings.threePlans === true, JSON.stringify(adm?.settings));
  const fun = (await api('/api/admin/pro/funnel?days=7', null, { headers: asBoss })).json;
  const at = (place) => fun?.places?.find((x) => x.place === place);
  check('/admin\'s funnel: the plan list seen and plans chosen by place, and the years paid, with their money', at('page')?.plans >= 1 && at('page').pick.year >= 1 && at('account')?.plans >= 1 && at('post')?.plans >= 1 && at('limit')?.pick.year >= 1 && fun.paid.year === 2 && fun.paid.revenueBy.year === 179.98 && at('page').year === 2 && fun.steps.year_bought >= 1, JSON.stringify({ page: at('page'), paid: fun?.paid }));
  {
    const { ctx, p } = await page(null, { w: 1440, h: 1000 });
    await p.goto(`${B}/admin`, { waitUntil: 'domcontentloaded' });
    await p.evaluate((pw) => { const f = document.querySelector('input[type="password"]'); if (f) { f.value = pw; f.form?.requestSubmit?.(); } }, ADMIN_PW);
    const inside = await waitFor(p, () => !!document.querySelector('.tab[data-tab="pro"]'), null, 30000);
    await p.evaluate(() => document.querySelector('.tab[data-tab="pro"]')?.click());
    const painted = inside && await waitFor(p, () => /PRO_YEAR/.test(document.body.innerText) && /Where the offer was seen/i.test(document.body.innerText), null, 30000);
    const t = await p.evaluate(() => document.body.innerText);
    check('/admin, Pro tab: the two new switches as the server reads them', painted && /PRO_YEAR\s+on: SAR 89\.99 for 365 days, one payment, never renews/.test(t) && /PRO_THREE_PLANS\s+on: \/pro is the three-plan page/.test(t), t.match(/PRO_YEAR[^\n]*/)?.[0] ?? '');
    check('the funnel table: the plan list seen, the plan chosen, and paid by each of the three plans', /Saw the plan list/i.test(t) && /Chose: match pass \/ month \/ year/i.test(t) && /Paid: match pass/i.test(t) && /Paid: monthly/i.test(t) && /Paid: year/i.test(t) && /Money kept \(SAR\)/i.test(t));
    await p.evaluate(() => [...document.querySelectorAll('h2')].find((h) => /Switches/i.test(h.textContent))?.scrollIntoView({ block: 'start' }));
    await shot(p, 'admin-pro');
    await p.evaluate(() => document.querySelector('.tab[data-tab="orders"]')?.click());
    const orders = await waitFor(p, () => /Plan/i.test(document.querySelector('table.tbl thead')?.innerText ?? '') && /Year/.test(document.querySelector('table.tbl tbody')?.innerText ?? ''), null, 30000);
    const rows = await p.evaluate(() => [...document.querySelectorAll('table.tbl tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ')));
    check('/admin, Orders: each order names its plan, its days and where it came from', orders && rows.some((r) => /@pp_buyer Year 365 days, from The Pro page SAR 89\.99/.test(r)) && rows.some((r) => /@pp_monthly Month 30 days/.test(r)), rows.slice(0, 4).join(' | '));
    await shot(p, 'admin-orders');
    await ctx.close();
  }
  // The receipt as it is sent, for a look (the suite's own checks of its words are in server/test/plans.test.mts).
  if (SHOTS) {
    const m = (await api('/api/admin/pro/orders', null, { headers: asBoss })).json?.orders?.find((o) => o.username === 'pp_buyer' && o.status === 'paid');
    writeFileSync(`${SHOTS}/year-order.json`, JSON.stringify(m ?? null, null, 2));
  }
}

console.log('');
check('no page threw an error', errs.length === 0, errs.slice(0, 4).join(' | '));
await browser.close();
stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
