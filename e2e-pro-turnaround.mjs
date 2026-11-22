/**
 * The turnaround of 22 Nov 2026 in a real browser (docs/pro-turnaround.md):
 * the price as a setting and the match pass on /pro, the gift that starts by
 * itself (its welcome, and the card when it ends), Pro's versions and the
 * account offer on the Post it sheet, and what /admin and /legal say.
 * Against real servers on memory stores and a stand-in Moyasar
 * (scripts/fake-moyasar.mjs). No real key, card or email: the keys are
 * made-up ones of the live shape, and email goes to the log.
 *
 * Two servers: one with every new switch on, one with none of them, where
 * nothing new may show.
 *
 * Self-contained: it boots its own servers. Needs a build:
 *   npm run build && node e2e-pro-turnaround.mjs
 * TURN_SHOTS=<folder> also saves screenshots of every screen it checks.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { fakeMoyasar } from './scripts/fake-moyasar.mjs';

const PORT = 8971;      // every new switch on
const PORT_OFF = 8972;  // on sale as it is today: none of the new switches
const FAKE = 8973;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const ADMIN_PW = 'e2e turnaround admin password';
const PK = 'pk_live_FAKEfake1234';
const SK = 'sk_live_FAKEfake1234'; // made up, of the live shape: only the stand-in ever sees it
const SHOTS = process.env.TURN_SHOTS || '';
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
      MOYASAR_API_BASE: `http://127.0.0.1:${FAKE}/v1`,
      // No job sends anything here: the emails are read from /admin's preview, and the log stands in for the mail service.
      LAUNCH_JOB: 'off', LAUNCH_MAIL_TO_LOG: 'on',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const SALE = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: SK, MOYASAR_PUBLISHABLE_KEY: PK, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: 'e2e-webhook-secret-of-some-length' };
/** The first day at the regular price, were the launch price still running: left set, as it is on the live site. */
const untilDay = new Date(Date.now() + 40 * 24 * 3600_000 + 3 * 3600_000).toISOString().slice(0, 10);
const servers = [
  boot(PORT, { ...SALE, PRO_LAUNCH_PRICE_UNTIL: untilDay, PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on', PRO_AUTO_GIFT: 'on', PRO_GIFT_MAILS: 'on', PRO_POST_OFFERS: 'on' }),
  boot(PORT_OFF, { ...SALE, PRO_LAUNCH_PRICE_UNTIL: untilDay }),
];
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
const mails = (email, subject) => [...out.join('').matchAll(/\[email:dev\] to=(\S+) \| ([^\n]*)/g)].filter((m) => m[1] === email && subject.test(m[2])).length;
/** Buy the way the payment form does: the server's order, a payment at "Moyasar" under its id, 3-D Secure, the return. */
const buy = async (who, product = 'monthly', base = B) => {
  const c = await api('/api/pro/pay/checkout', who.token, { method: 'POST', body: JSON.stringify({ lang: 'en', product, src: 'post' }) }, base);
  if (!c.json?.form) throw new Error(`checkout: ${JSON.stringify(c.json)}`);
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
/** A page as a fan has it: the language, the consent choice, the first-run layers already seen, and the account when there is one. */
const page = async (token, { lang = 'en', w = 1440, h = 900, scheme = 'light', consent = 'essential', seen = true } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(([tok, lang, consent, seen]) => {
    try {
      const keys = { tifo_consent_v1: consent, tifo_lang_v1: lang };
      if (seen) Object.assign(keys, {
        tifo_guide_v1: 'done', tifo_view_v1: '3d', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_post_nudge_v1: '1',
      });
      for (const [k, v] of Object.entries(keys)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, consent, seen]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const shot = async (p, name, full = false) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); };
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() || '', sel);
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
/** Open the editor on a new club tifo and wait for it to be there to post. */
const openEditor = async (p, base = B) => {
  await p.goto(`${base}/projects?new=1&e2e`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.querySelectorAll('.st-club').length >= 8, null, 90000);
  await p.evaluate(() => document.querySelector('.st-club[data-club="nassr"]')?.click());
  await waitFor(p, () => document.querySelector('.st-opt.on')?.dataset.start === 'club', null, 10000);
  await p.evaluate(() => document.getElementById('st-go')?.click());
  return waitFor(p, () => !!document.getElementById('post-tifo') && !!document.getElementById('rail-anim'), null, 90000);
};
/** Press Post it and wait for the sheet's picture (or its "could not make it"). */
const openPost = async (p) => {
  await p.waitForTimeout(2500);
  await p.evaluate(() => document.getElementById('post-tifo')?.click());
  await waitFor(p, () => !!document.querySelector('[data-post-sheet] .pm-pic') || /\S/.test(document.querySelector('[data-post-sheet] .pm-wait')?.textContent ?? '') && !document.querySelector('[data-post-sheet] .pm-wait')?.textContent.includes('…'), null, 60000);
  return p.evaluate(() => !!document.querySelector('[data-post-sheet] .pm-pic'));
};

const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).json?.token;
const asBoss = { 'x-ai-unlock': unlock };
const unlockOff = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) }, OFF)).json?.token;

// =====================================================================
console.log('\n— every new switch off: nothing changes for a fan —');
{
  const st = (await api('/api/pro', null, {}, OFF)).json;
  check('/api/pro: the launch price as today, no match pass, no Post it flag, no automatic gift', st?.offer?.monthly?.price === 13.99 && !!st.offer.launch && !st.offer.match && !st.offer.post && !st.offer.autoGift, JSON.stringify(st?.offer).slice(0, 240));
  const fan = await account('to_fan', OFF);
  const mine = (await api('/api/pro', fan.token, {}, OFF)).json;
  check('a verified account with no saved design gets no gift, as before', mine?.gift?.state === 'none' && mine.plan === 'free', JSON.stringify(mine?.gift));
  check('the match pass cannot be bought', (await api('/api/pro/pay/checkout', fan.token, { method: 'POST', body: '{"lang":"en","product":"match"}' }, OFF)).status === 404);
  const legal = await (await fetch(`${OFF}/legal`)).text();
  check('/legal says nothing of a match pass or free days', !/The match pass|باقة المباراة|free days|المجانية\./.test(legal) && !legal.includes('{{'));
  const adm = (await api('/api/admin/pro', null, { headers: { 'x-ai-unlock': unlockOff } }, OFF)).json;
  check('/admin reads every switch as off', adm?.settings && !adm.settings.autoGift && !adm.settings.giftMails && !adm.settings.postOffers && adm.settings.monthlyPrice === null && !adm.settings.match.asked, JSON.stringify(adm?.settings));
  {
    const { ctx, p } = await page(null);
    await p.goto(`${OFF}/pro`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('pb-buy'));
    check('/pro: SAR 13.99 and the launch line, and no match pass', /13\.99/.test(await text(p, '.pb-price')) && !!(await text(p, '#pb-launch')) && await p.evaluate(() => !document.getElementById('pb-match')));
    await ctx.close();
  }
  {
    const { ctx, p } = await page(null);
    const there = await openEditor(p, OFF);
    const pic = there && await openPost(p);
    await p.waitForTimeout(1500);
    check('the Post it sheet is what it always was: no Pro block, no account line', there && await p.evaluate(() => !!document.querySelector('[data-post-sheet]') && !document.querySelector('.pp2')), `editor ${there}, picture ${pic}`);
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— /pro: the price is the setting, and the match pass beside it —');
{
  const st = (await api('/api/pro', null)).json;
  check('/api/pro: SAR 9.99, no launch price beside it, the match pass at SAR 4.99 for 72 hours', st?.offer?.monthly?.price === 9.99 && !st.offer.launch && st.offer.match?.price === 4.99 && st.offer.match.hours === 72 && st.offer.post === true && st.offer.autoGift === true, JSON.stringify(st?.offer).slice(0, 300));
  for (const [lang, w, h, name] of [['ar', 390, 844, 'pro-ar-phone'], ['en', 1440, 900, 'pro-en-desktop']]) {
    const { ctx, p } = await page(null, { lang, w, h });
    await p.goto(`${B}${lang === 'ar' ? '/ar/pro' : '/pro'}`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('pb-match'));
    const all = await p.evaluate(() => document.getElementById('pp-open')?.innerText ?? '');
    check(`${name}: SAR 9.99 for 30 days, and no other price for the month anywhere on the page`, /9\.99/.test(await text(p, '.pb-price')) && !/13\.99|19\.99/.test(all), all.match(/1[39]\.99[^\n]*/)?.[0] ?? '');
    check(`${name}: nothing says a later price ("from <date> the price will be")`, await p.evaluate(() => !document.getElementById('pb-launch')));
    const match = await text(p, '#pb-match');
    check(`${name}: the match pass says its whole price, its hours, one payment and that it never renews`, /4\.99/.test(match) && /72/.test(match) && (lang === 'ar' ? /دفعة وحدة/.test(match) && /ما تتجدد/.test(match) : /one payment/.test(match) && /never renews/.test(match)), match);
    check(`${name}: one blue button (the month); the match pass is quiet`, await p.evaluate(() => {
      const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
      const btns = [...document.querySelectorAll('#pb-buy .pp-btn')];
      return btns.length === 2 && solid(btns[0]) && !solid(btns[1]);
    }));
    check(`${name}: nothing is wider than the page`, await fits(p));
    if (lang === 'ar') check('ar: the page reads right to left, with Western digits', await p.evaluate(() => document.documentElement.dir === 'rtl') && !/[٠-٩]/.test(all));
    await p.evaluate(() => document.getElementById('pb-buy')?.scrollIntoView({ block: 'start' }));
    await shot(p, name, true);
    await ctx.close();
  }
  // Arriving from a Get Pro link elsewhere: the place leaves the address bar, and the match pass asked for is marked.
  {
    const { ctx, p } = await page(null, { consent: 'all' });
    await p.goto(`${B}/pro?from=post&plan=match`, { waitUntil: 'domcontentloaded' });
    await waitFor(p, () => !!document.getElementById('pb-match'));
    check('/pro?from=post&plan=match: the address is cleaned, and the match pass is the one marked', await p.evaluate(() => location.search === '' && document.getElementById('pb-match')?.dataset.asked === '1'));
    await ctx.close();
  }
  const legal = await (await fetch(`${B}/legal`)).text();
  check('/legal: the match pass and the free days, with the numbers, in both languages', /same Pro for 72 hours/.test(legal) && /one payment of SAR 4\.99/.test(legal) && /لمدة 72 ساعة/.test(legal) && /The 7 free days\./.test(legal) && /Emails about the free days/.test(legal) && !legal.includes('{{') && !/a month of Pro costs SAR 13\.99/.test(legal));
}

// =====================================================================
console.log('\n— the gift starts by itself, and says so once —');
const giftFan = await account('tg_fan');
{
  // Signed up and verified, never saved a design: the first visit starts it.
  const { ctx, p } = await page(giftFan.token, { lang: 'ar', w: 390, h: 844, consent: 'all' });
  await p.goto(`${B}/ar/projects`, { waitUntil: 'domcontentloaded' });
  const shown = await waitFor(p, () => !!document.querySelector('[data-pro-welcome] .pro-sheet'), null, 30000);
  check('ar phone: the welcome opens on the first visit', shown);
  const w = await p.evaluate(() => {
    const s = document.querySelector('[data-pro-welcome] .pro-sheet');
    const box = s?.querySelector('[data-act="offers"]');
    const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
    return { text: s?.innerText ?? '', ticked: box?.checked, primaries: [...(s?.querySelectorAll('button, a') ?? [])].filter(solid).length, dir: getComputedStyle(s).direction };
  });
  check('it says 7 days, free, no card, and that it ends by itself', /7/.test(w.text) && /مجانًا/.test(w.text) && /بدون بطاقة/.test(w.text) && /ينتهي لحاله/.test(w.text), w.text.slice(0, 200));
  check('it points at one thing to try: the vertical video', /الفيديو الطولي/.test(w.text) && /سناب/.test(w.text));
  check('"email me Pro news and offers" is there and NOT ticked', w.ticked === false);
  check('one blue button, right to left', w.primaries === 1 && w.dir === 'rtl', JSON.stringify(w));
  check('nothing is wider than the phone', await fits(p));
  await p.waitForTimeout(700);
  await shot(p, 'welcome-ar-phone');
  await p.evaluate(() => document.querySelector('[data-pro-welcome] [data-act="go"]')?.click());
  await waitFor(p, () => !document.querySelector('[data-pro-welcome]'));
  await p.waitForTimeout(800);
  const st = (await api('/api/pro', giftFan.token)).json;
  check('the server has it: Pro on as a gift for 7 days, the welcome marked, offers by email still off', st?.plan === 'gift' && st.gift.state === 'active' && st.gift.auto === true && !st.gift.welcome && st.gift.offersOk === false, JSON.stringify(st?.gift));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  check('the welcome is said once: not again on the next visit', await p.evaluate(() => !document.querySelector('[data-pro-welcome]')));
  await ctx.close();
  check('no email went out for it here (the job is off in this suite, as on a server with PRO_GIFT_MAILS off)', mails(giftFan.email, /Pro is on|برو شغّال/) === 0);
}
{
  // English, desktop, in the editor: the button opens the export with the vertical video picked, and ticking the box is kept.
  const fan = await account('tg_desk');
  const { ctx, p } = await page(fan.token, { consent: 'all' });
  const there = await openEditor(p);
  const shown = there && await waitFor(p, () => !!document.querySelector('[data-pro-welcome] .pro-sheet'), null, 40000);
  check('en desktop, in the editor: the welcome opens', shown);
  const t1 = await text(p, '[data-pro-welcome] .pro-sheet');
  check('it reads: Pro is on, 7 days, free, no card, ends by itself; try the vertical video', /Pro is on for you: 7 days, free/.test(t1) && /No card/.test(t1) && /ends by itself/.test(t1) && /Try the vertical video/.test(t1), t1.slice(0, 220));
  await p.waitForTimeout(700);
  await shot(p, 'welcome-en-desktop');
  await p.evaluate(() => { document.querySelector('[data-pro-welcome] [data-act="offers"]')?.click(); document.querySelector('[data-pro-welcome] [data-act="go"]')?.click(); });
  const picked = await waitFor(p, () => document.getElementById('sx-size')?.value === 'vertical', null, 15000);
  check('"Try the vertical video" opens the export with Vertical 9:16 picked', picked);
  check('the header shows the countdown chip', await waitFor(p, () => { const c = document.querySelector('.pro-head-chip'); return !!c && !c.hidden && /\d/.test(c.textContent); }, null, 15000));
  await p.waitForTimeout(600);
  check('ticking the box is kept on the server', (await api('/api/pro', fan.token)).json?.gift?.offersOk === true);
  await ctx.close();
}
{
  // Not verified yet: nothing. Verified: it starts.
  const fresh = await account('tg_fresh', B, false);
  check('an unverified email gets no gift', (await api('/api/pro', fresh.token)).json?.gift?.state === 'none');
  await api('/api/auth/verify/code', fresh.token, { method: 'POST', body: JSON.stringify({ code: await codeFor(fresh.email) }) });
  const after = (await api('/api/pro', fresh.token)).json;
  check('once the email is verified the gift starts, and the same answer already says Pro is on', after?.gift?.state === 'active' && after.plan === 'gift', JSON.stringify(after?.gift));
}

// =====================================================================
console.log('\n— the card when the gift ends —');
{
  // The server's own rules for the end are in server/test/turnaround.test.mts (it needs a clock to move). Here the
  // page is given the answer the server gives after a gift, to see the card itself.
  const fan = await account('tg_ended', B, false);
  for (const [lang, w, h, name] of [['ar', 390, 844, 'giftend-ar-phone'], ['en', 1440, 900, 'giftend-en-desktop']]) {
    const { ctx, p } = await page(fan.token, { lang, w, h, consent: 'all' });
    let seenPosts = 0;
    await p.route('**/api/pro', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.plan = 'free';
      body.pass = null;
      body.gift = { state: 'used', endedAt: new Date(Date.now() - 3600_000).toISOString(), auto: true, endCard: true, made: { items: { 'pexp.item.vertical': 3, 'pro.mark.option': 2, 'gw.made.other': 1 }, ai: 4 } };
      await route.fulfill({ response: res, json: body });
    });
    await p.route('**/api/pro/gift/end-seen', async (route) => { seenPosts++; await route.fulfill({ status: 200, json: { ok: true } }); });
    await p.goto(`${B}${lang === 'ar' ? '/ar/projects' : '/projects'}`, { waitUntil: 'domcontentloaded' });
    const shown = await waitFor(p, () => !!document.querySelector('[data-pro-gift-end] .pro-sheet'), null, 30000);
    check(`${name}: the end card opens`, shown);
    const c = await p.evaluate(() => {
      const s = document.querySelector('[data-pro-gift-end] .pro-sheet');
      const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 90 && (c[3] ?? 1) > 0.5; };
      const get = s?.querySelector('[data-act="get"]');
      return { text: s?.innerText ?? '', items: [...(s?.querySelectorAll('.pro-items li') ?? [])].map((li) => li.textContent.trim()), href: get?.getAttribute('href') ?? '', get: get?.textContent.trim() ?? '', blues: [...(s?.querySelectorAll('a, button') ?? [])].filter(solid).length, later: !!s?.querySelector('[data-act="later"]'), match: s?.querySelector('[data-act="match"]')?.getAttribute('href') ?? '' };
    });
    check(`${name}: it lists what they made with Pro, most used first`, c.items.length === 4 && (lang === 'ar' ? /فيديو طولي/.test(c.items[0]) : /Vertical 9:16 video/.test(c.items[0])), JSON.stringify(c.items));
    check(`${name}: it says what stays theirs and what Pro did`, lang === 'ar' ? /يبقى لك/.test(c.text) && /علامة tifomaker\.org/.test(c.text) : /stays yours/.test(c.text) && /tifomaker\.org mark again/.test(c.text));
    check(`${name}: one blue button to keep Pro at the price it is now, and "Not now" beside it`, c.blues === 1 && /9\.99/.test(c.get) && /\/pro\?from=giftend$/.test(c.href) && c.later, JSON.stringify(c).slice(0, 300));
    check(`${name}: the match pass is one quiet line`, /from=giftend&plan=match/.test(c.match) && /4\.99/.test(c.text) && /72/.test(c.text));
    check(`${name}: no timer and no pre-ticked box`, await p.evaluate(() => !document.querySelector('[data-pro-gift-end] input, [data-pro-gift-end] [class*="timer"], [data-pro-gift-end] [class*="count"]')));
    check(`${name}: the server is told it was shown`, seenPosts >= 1);
    check(`${name}: nothing is wider than the page`, await fits(p));
    await p.waitForTimeout(700);
    await shot(p, name);
    await p.evaluate(() => document.querySelector('[data-pro-gift-end] [data-act="later"]')?.click());
    check(`${name}: "Not now" closes it`, await waitFor(p, () => !document.querySelector('[data-pro-gift-end]'), null, 5000));
    await ctx.close();
  }
}

// =====================================================================
console.log('\n— Post it: Pro where the fan already is —');
{
  // Signed out.
  for (const [lang, w, h, name] of [['ar', 390, 844, 'post-ar-phone'], ['en', 1440, 900, 'post-en-desktop']]) {
    const { ctx, p } = await page(null, { lang, w, h, consent: 'all' });
    const there = await openEditor(p);
    // With the switch on, the first save already offers the account (it waited for the second one before).
    await p.waitForTimeout(2500); // the editor wires its buttons a moment after it shows
    const t0 = Date.now();
    await p.evaluate(() => (document.getElementById('save-top') ?? document.getElementById('save'))?.click());
    const first = await waitFor(p, () => { const o = document.getElementById('account-offer'); return !!o && !o.hidden && !!o.querySelector('.ao-go'); }, null, 15000);
    check(`${name}, signed out: the first save offers the account, and the tifo is saved without one`, first, `after ${Date.now() - t0} ms`);
    await p.evaluate(() => document.querySelector('#account-offer .ao-dismiss')?.click());
    const pic = there && await openPost(p);
    const block = await waitFor(p, () => !!document.querySelector('[data-post-sheet] .pp2 .pp2-sum'), null, 20000);
    check(`${name}, signed out: the sheet makes its picture and carries Pro's part under its own buttons`, there && pic && block, `editor ${there}, picture ${pic}, block ${block}`);
    const s = await p.evaluate(() => {
      const card = document.querySelector('[data-post-sheet] .pm-card');
      const kids = [...card.children];
      const acts = card.querySelector('.pm-actions');
      const solid = (el) => { const c = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0]; return c[2] > 150 && c[0] < 110 && (c[3] ?? 1) > 0.5; };
      return {
        order: kids.indexOf(acts) < kids.indexOf(card.querySelector('.pp2')),
        free: [...acts.querySelectorAll('button')].map((b) => b.textContent.trim()),
        bodyHidden: card.querySelector('.pp2-body')?.hidden,
        line: card.querySelector('.pa-text')?.textContent ?? '',
        how: [...card.querySelectorAll('.pa-acts [data-how]')].filter((b) => !b.hidden).map((b) => b.dataset.how),
        note: card.querySelector('.pa-note')?.textContent ?? '',
        bluesInPro: [...card.querySelectorAll('.pp2 button, .pp2 a')].filter(solid).length,
        dir: getComputedStyle(card.querySelector('.pp2')).direction,
      };
    });
    check(`${name}: the free picture's buttons come first and are all still there`, s.order && s.free.length >= 4, JSON.stringify(s.free));
    check(`${name}: the Pro versions start closed: one row, nothing pushed at the fan`, s.bodyHidden === true);
    check(`${name}: one line offers an account and the 7 days, and says posting stays free without one`, (lang === 'ar' ? /احفظ تيفوك في حساب/.test(s.line) && /7/.test(s.line) && /مجاني حتى بدون حساب/.test(s.note) : /Save your tifo to an account and get 7 days of Pro free/.test(s.line) && /Posting stays free without one/.test(s.note)) && s.how.includes('email'), JSON.stringify(s));
    check(`${name}: nothing blue in Pro's part: the blue button stays the sheet's own`, s.bluesInPro === 0 && s.dir === (lang === 'ar' ? 'rtl' : 'ltr'));
    await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2-sum')?.click());
    const o = await p.evaluate(() => {
      const b = document.querySelector('[data-post-sheet] .pp2-body');
      return { open: !b.hidden, list: [...b.querySelectorAll('.pp2-list li')].map((li) => li.textContent.trim()), see: !!b.querySelector('[data-act="see"]'), text: b.innerText, inputs: b.querySelectorAll('input').length, get: b.querySelectorAll('[data-act="get"]').length };
    });
    check(`${name}: opened, it lists the three Pro versions in plain words`, o.open && o.list.length === 3 && (lang === 'ar' ? /سناب/.test(o.list[0]) && /Full HD/.test(o.list[1]) && /4K/.test(o.list[2]) : /Vertical video for Snap, TikTok and WhatsApp status/.test(o.list[0]) && /Full HD, without the tifomaker\.org mark/.test(o.list[1]) && /4K poster/.test(o.list[2])), JSON.stringify(o.list));
    check(`${name}: a preview of their own tifo is offered before any price`, o.see);
    check(`${name}: signed out, the way on is the free account (one offer, said once), not a second sales button`, o.get === 0 && (lang === 'ar' ? /الحساب المجاني/.test(o.text) : /A free account gets all of it for 7 days, free/.test(o.text)), o.text.slice(0, 200));
    check(`${name}: no pre-ticked box, and "posting the picture is always free" is said`, o.inputs === 0 && (lang === 'ar' ? /نشر الصورة مجاني دايم/.test(o.text) : /Posting the picture is always free/.test(o.text)));
    check(`${name}: nothing is wider than the page`, await fits(p));
    await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2')?.scrollIntoView({ block: 'center' }));
    await shot(p, name);
    if (lang === 'en') {
      // The preview: the fan's own tifo as the vertical video, small and with the mark. Free to look at.
      await p.evaluate(() => document.querySelector('[data-post-sheet] [data-act="see"]')?.click());
      const seen = await waitFor(p, () => { const n = document.querySelector('[data-post-sheet] .pp2-see .pp2-note')?.textContent ?? ''; return /small preview|could not be made/.test(n); }, null, 90000);
      const what = await p.evaluate(() => ({ note: document.querySelector('[data-post-sheet] .pp2-see .pp2-note')?.textContent ?? '', canvas: !!document.querySelector('[data-post-sheet] canvas.pp2-film') }));
      check('the preview plays (or says plainly that this device cannot make it), and says it is small and marked', seen && (what.canvas ? /with the mark/.test(what.note) : /could not be made/.test(what.note)), JSON.stringify(what));
      await p.waitForTimeout(1500);
      await shot(p, 'post-en-desktop-preview');
      // The free path is untouched by all of it: Download still saves the picture.
      const dl = p.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await p.evaluate(() => [...document.querySelectorAll('[data-post-sheet] .pm-row button')].find((b) => b.querySelector('.ti-download'))?.click());
      // A design with no Pro items asks nothing: the picture just downloads.
      const file = await dl;
      check('the free picture still downloads in one tap, with no sheet in the way', !!file && /tifomaker\.png$/.test(file.suggestedFilename()), file ? file.suggestedFilename() : 'no download');
    }
    await ctx.close();
  }
  // The offer was counted, for a visitor who allowed counting.
  const fun = (await api('/api/admin/pro/funnel?days=7', null, { headers: asBoss })).json;
  const row = fun?.places?.find((x) => x.place === 'post');
  check('/admin\'s Pro funnel counted the offer on Post it, the previews and the account offers', row?.saw >= 1 && fun.steps.signup_offer_post >= 1 && fun.steps.pro_preview_post >= 1, JSON.stringify({ row, steps: fun?.steps }));
}
{
  // Signed in, without Pro and with no gift to come (email not verified): Get Pro in plain words, with the match pass beside it.
  const plain = await account('tp_plain', B, false);
  const { ctx, p } = await page(plain.token, { consent: 'all' });
  const there = await openEditor(p);
  await openPost(p);
  await waitFor(p, () => !!document.querySelector('[data-post-sheet] .pp2-sum'), null, 20000);
  check('signed in: no account line', there && await p.evaluate(() => !document.querySelector('[data-post-sheet] .pa-line')));
  await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2-sum')?.click());
  const o = await p.evaluate(() => {
    const b = document.querySelector('[data-post-sheet] .pp2-body');
    return { text: b.innerText, get: [...b.querySelectorAll('[data-act="get"]')].map((a) => a.getAttribute('href')), labels: [...b.querySelectorAll('[data-act="get"]')].map((a) => a.textContent.trim()) };
  });
  check('the price in plain words: SAR 9.99 for 30 days, one payment; or SAR 4.99 for a 72-hour match pass', /Pro is SAR 9\.99 for 30 days, one payment\./.test(o.text) && /Or SAR 4\.99 for a 72-hour match pass\./.test(o.text), o.text.slice(0, 260));
  check('Get Pro and Match pass go to /pro, saying where from', o.get.length === 2 && /\/pro\?from=post$/.test(o.get[0]) && /\/pro\?from=post&plan=match$/.test(o.get[1]) && o.labels[0] === 'Get Pro' && o.labels[1] === 'Match pass', JSON.stringify(o));
  check('no crossed-out price, no "was", no percentage, no deadline', !/<s[ >]|was SAR|%|\bonly\b|hurry|ends in/i.test(await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2')?.innerHTML ?? '')));
  await shot(p, 'post-en-desktop-getpro');
  await ctx.close();
}
{
  // With Pro running (the gift): the three just work. No price, no offer.
  const { ctx, p } = await page(giftFan.token, { consent: 'all' });
  const there = await openEditor(p);
  await openPost(p);
  await waitFor(p, () => !!document.querySelector('[data-post-sheet] .pp2-sum'), null, 20000);
  await p.evaluate(() => document.querySelector('[data-post-sheet] .pp2-sum')?.click());
  const o = await p.evaluate(() => {
    const b = document.querySelector('[data-post-sheet] .pp2-body');
    return { text: b.innerText, make: [...b.querySelectorAll('[data-make]')].map((x) => x.dataset.make), get: b.querySelectorAll('[data-act="get"]').length };
  });
  check('with the gift running: "Pro is on for you", and buttons that make the vertical and Full HD videos', there && /Pro is on for you/.test(o.text) && o.make.includes('vertical') && o.make.includes('landscape') && o.get === 0 && !/SAR/.test(o.text), JSON.stringify(o));
  await shot(p, 'post-en-desktop-with-pro');
  await ctx.close();
}

// =====================================================================
console.log('\n— buying the match pass —');
{
  const fan = await account('tm_buyer', B, false);
  check('an unverified email cannot buy it', (await api('/api/pro/pay/checkout', fan.token, { method: 'POST', body: '{"lang":"en","product":"match"}' })).status === 403);
  await api('/api/auth/verify/code', fan.token, { method: 'POST', body: JSON.stringify({ code: await codeFor(fan.email) }) });
  // Verifying started the 7 days; a match pass bought now is Pro they paid for, beside them.
  const b = await buy(fan, 'match');
  check('the order is SAR 4.99 for 3 days, whatever the browser might have sent', b.form.amount === 499 && b.form.days === 3 && b.form.product === 'match' && b.form.renew === null, JSON.stringify(b.form).slice(0, 200));
  const st = (await api('/api/pro', fan.token)).json;
  check('Pro is on, paid, for 72 hours', st?.plan === 'monthly' && Math.round((Date.parse(st.pass.endsAt) - Date.parse(st.pass.startsAt)) / 3600_000) === 72, JSON.stringify(st?.pass));
  check('the receipt went to the log, saying what was bought', mails(fan.email, /receipt/i) === 1 && /match pass, 72 hours \(one payment, never renewed\)/.test(out.join('')));
  const pu = (await api('/api/pro/purchases', fan.token)).json;
  check('the purchases list has it as a match pass, refundable for 7 days', pu?.orders?.[0]?.product === 'match' && pu.orders[0].amount === 4.99 && pu.orders[0].refund.state === 'open', JSON.stringify(pu?.orders?.[0]).slice(0, 260));
  {
    const { ctx, p } = await page(fan.token);
    await p.goto(`${B}/account`, { waitUntil: 'domcontentloaded' });
    const seen = await waitFor(p, () => /match pass, 72 hours/.test(document.querySelector('.pu-order')?.textContent ?? ''), null, 30000);
    check('the account page names it: "Pro match pass, 72 hours", SAR 4.99', seen && /4\.99/.test(await text(p, '.pu-order')), await text(p, '.pu-order'));
    await ctx.close();
  }
  // The return from paying: /pro says so, in the match pass's own words.
  {
    const other = await account('tm_return');
    const c = await api('/api/pro/pay/checkout', other.token, { method: 'POST', body: '{"lang":"en","product":"match"}' });
    const f = c.json.form;
    await fetch(`http://127.0.0.1:${FAKE}/v1/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishable_api_key: PK, given_id: f.givenId, amount: f.amount, currency: f.currency, description: f.description, callback_url: f.callbackUrl, metadata: { order_id: c.json.order }, source: { type: 'creditcard', name: 'Test Fan', number: '4111111111111111', month: '12', year: '30', cvc: '123' } }),
    });
    moyasar.finish3ds(f.givenId, 'paid');
    const { ctx, p } = await page(other.token, { consent: 'all' });
    await p.goto(`${B}/pro?order=${c.json.order}`, { waitUntil: 'domcontentloaded' });
    const said = await waitFor(p, () => /match pass is on until/.test(document.getElementById('pp-paid')?.textContent ?? ''), null, 30000);
    check('back from paying: "Your match pass is on until ..."', said, await text(p, '#pp-paid'));
    await ctx.close();
  }
  const adm = (await api('/api/admin/pro/funnel?days=7', null, { headers: asBoss })).json;
  check('/admin counts the paid match passes, by the place the checkout named', adm?.paid?.match >= 1 && adm.places.find((x) => x.place === 'post')?.match >= 1, JSON.stringify(adm?.paid));
}

// =====================================================================
console.log('\n— /admin: the switches, the gifts, the emails —');
{
  const adm = (await api('/api/admin/pro', null, { headers: asBoss })).json;
  check('the switches as the server reads them', adm?.settings?.autoGift && adm.settings.giftMails && adm.settings.postOffers && adm.settings.monthlyPrice === 9.99 && adm.settings.match.asked && adm.settings.match.price === 4.99, JSON.stringify(adm?.settings));
  check('gifts started by themselves are counted apart from the old Accept button, with who bought', adm?.giftsStarted?.auto?.started >= 4 && adm.giftsStarted.accept.started === 0 && adm.giftsStarted.auto.boughtDuring >= 1, JSON.stringify(adm?.giftsStarted));
  for (const [kind, offer, name] of [['start', '', 'email-start'], ['soon', '', 'email-soon'], ['end', '', 'email-end'], ['end', '&offer=1', 'email-end-offer']]) {
    const m = (await api(`/api/admin/pro/gift/email?json=1&kind=${kind}${offer}`, null, { headers: asBoss })).json;
    const html = m?.html ?? '';
    check(`${name}: Arabic and English, a stop link, ${offer ? 'the price marked as an advertisement with the seller named' : 'and no price'}`,
      /lang="ar"/.test(html) && /lang="en"/.test(html) && /pro\?nomail=/.test(html) && /Stop these emails/.test(html) && /أوقف هالرسائل/.test(html) &&
      (offer ? /Advertisement: to keep Pro, it is SAR 9\.99 for 30 days/.test(html) && /72 hours for SAR 4\.99/.test(html) && /FL-216888773/.test(html) && /إعلان/.test(html) : !/SAR \d|ريال/.test(html)), m?.subject);
    if (SHOTS && html) {
      writeFileSync(`${SHOTS}/${name}.html`, html);
      const { ctx, p } = await page(null, { w: 640, h: 900 });
      await p.setContent(html, { waitUntil: 'domcontentloaded' });
      await shot(p, name, true);
      await ctx.close();
    }
  }
  {
    const { ctx, p } = await page(null, { w: 1440, h: 1000 });
    await p.goto(`${B}/admin`, { waitUntil: 'domcontentloaded' });
    await p.evaluate((pw) => { const f = document.querySelector('input[type="password"]'); if (f) { f.value = pw; f.form?.requestSubmit?.(); } }, ADMIN_PW);
    const inside = await waitFor(p, () => !!document.querySelector('.tab[data-tab="pro"]'), null, 30000);
    await p.evaluate(() => document.querySelector('.tab[data-tab="pro"]')?.click());
    const painted = inside && await waitFor(p, () => /switches/i.test(document.body.innerText) && /pro funnel/i.test(document.body.innerText) && /gifts started/i.test(document.body.innerText) && /Where the offer was seen/i.test(document.body.innerText), null, 30000);
    check('/admin, Pro tab: the switches, the gifts started and the Pro funnel are on the page', painted);
    const t = await p.evaluate(() => document.body.innerText);
    check('the funnel table has every place and both plans', /Post it/.test(t) && /Export sheet/.test(t) && /After the gift/.test(t) && /A limit card/.test(t) && /Paid: monthly/.test(t) && /Paid: match pass/.test(t));
    await p.evaluate(() => [...document.querySelectorAll('h2')].find((h) => /Switches/.test(h.textContent))?.scrollIntoView({ block: 'start' }));
    await shot(p, 'admin-pro');
    await ctx.close();
  }
}

console.log('');
check('no page threw an error', errs.length === 0, errs.slice(0, 4).join(' | '));
await browser.close();
stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
