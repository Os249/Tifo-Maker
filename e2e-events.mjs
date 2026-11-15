/**
 * Tifo events in the interface: the admin makes an event on /admin, fans
 * enter and vote on /events/<address>, and the admin confirms the result, in
 * a real browser against a real server. The clock is moved by changing the
 * event's times through the admin's own route, the way the admin can.
 *
 *   no event       nothing on the home or community page, and /events says so;
 *   the admin      the Events tab: the form, "Fill the usual dates", the card;
 *   announced      the page with the theme and dates, the band on the home
 *                  and community pages, one way on ("Start a tifo");
 *   open           signed out, "Sign in to enter"; signed in, the picker and
 *                  "You are in"; change and take out;
 *   voting         a Vote button on every entry but your own, no counts in
 *                  the page, an unverified account is told why not; Arabic on
 *                  a phone, right to left, nothing wider than the screen;
 *   closed         "Result soon", no counts; the admin's card proposes three,
 *                  takes one out with a reason, and confirms;
 *   result         the podium with the counts, the reason for the entry taken
 *                  out, the winner's Pro pass, the band naming the winner.
 *
 * Self-contained: it boots its own server on memory repos. Needs a build:
 *   npm run build && node e2e-events.mjs
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8941;
const B = `http://127.0.0.1:${PORT}`;
const out = [];
const ADMIN_PW = 'e2e events admin password';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', MOYASAR_SECRET_KEY: '', PRO_MODE: 'on', AI_ADMIN_PASSWORD: ADMIN_PW,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await fetch(`${B}/health`).then((r) => r.ok).catch(() => false);
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, { token, unlock, method = 'GET', body } = {}) => {
  const r = await fetch(B + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(unlock ? { 'x-ai-unlock': unlock } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
const PW = 'harbor-kite-moss-31';
const signUp = async (username, verify) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', { method: 'POST', body: { username, password: PW, email, acceptedVersion: 'test' } });
  const token = r.json?.token;
  if (verify) await api('/api/auth/verify/code', { token, method: 'POST', body: { code: await codeFor(email) } });
  return { username, token };
};
const [tpl] = (await api('/api/templates')).json;
const cellsGzB64 = gzipSync(new Uint8Array(tpl.seatCount)).toString('base64');
const makeTifo = async (u, title) => {
  const d = await api('/api/designs', { token: u.token, method: 'POST', body: { title, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64 } });
  await api(`/api/designs/${d.json.id}`, { token: u.token, method: 'PATCH', body: { isPublic: true } });
  return d.json.id;
};

const browser = await chromium.launch();
const errors = [];
const LS = { tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}' };
const open = async ({ user = null, lang = 'en', width = 1440, height = 900, mobile = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({ ...ls, tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [user ? user.token : null, lang, LS]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return p;
};
const text = async (p, sel) => ((await p.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const idle = (p, url) => p.goto(B + url, { waitUntil: 'networkidle' });
const blueButtons = (p) => p.evaluate(() => [...document.querySelectorAll('main .evp-btn:not(.quiet)')].filter((b) => b.offsetParent !== null).length);

try {
  const unlock = (await api('/api/ai/unlock', { method: 'POST', body: { password: ADMIN_PW } })).json.token;
  const amal = await signUp('ev_amal', true);
  const badr = await signUp('ev_badr', true);
  const cyra = await signUp('ev_cyra', true);
  const dana = await signUp('ev_dana', false); // never verifies an email
  const oldTifo = await makeTifo(amal, 'Last season');

  console.log('\nNo event');
  const anon = await open();
  await idle(anon, '/');
  await anon.waitForTimeout(1500);
  check('the home page has no band', (await anon.locator('#ev-band').count()) === 0);
  check('its nav has Events, after Community', (await anon.evaluate(() => [...document.querySelectorAll('header.nav .nav-links > a')].map((a) => a.getAttribute('href')).slice(0, 2).join())) === '/community,/events');
  await idle(anon, '/community');
  await anon.waitForTimeout(1500);
  check('nor the community page', (await anon.locator('#ev-band').count()) === 0);
  await idle(anon, '/events');
  check('/events says there is none', /No event right now/.test(await text(anon, '#ev-index-none')));
  check('and marks itself in the nav', (await anon.getAttribute('header.nav .nav-links > a[href="/events"]', 'aria-current')) === 'page');
  await idle(anon, '/events/the-derby');
  check('an address with no event says so', /not here/.test(await text(anon, '#ev-index-none')));

  console.log('\nThe admin makes one');
  const adm = await open();
  await adm.goto(`${B}/admin#events`, { waitUntil: 'domcontentloaded' });
  await adm.fill('#p', ADMIN_PW);
  await adm.press('#p', 'Enter');
  await adm.waitForSelector('#ev-save', { timeout: 30000 });
  check('the Events tab opens from /admin#events', /Tifo events/i.test(await text(adm, '#dash-body h2')));
  await adm.click('#ev-save');
  check('an empty form is not sent', /title/i.test(await text(adm, '#ev-out')) && (await adm.locator('.ev-card').count()) === 0);
  await adm.fill('#ev-title-en', 'The Derby');
  await adm.fill('#ev-title-ar', 'الديربي');
  await adm.fill('#ev-line-en', 'One night, two colours.');
  await adm.fill('#ev-line-ar', 'ليلة وحدة ولونين.');
  await adm.click('#ev-fill');
  check('"Fill the usual dates" fills all four', await adm.evaluate(() => ['ev-announce', 'ev-open', 'ev-vote', 'ev-close'].every((id) => document.getElementById(id).value.length === 16)));
  await adm.click('#ev-save');
  await adm.waitForSelector('.ev-card', { timeout: 15000 });
  check('the event is made at the address from its title', /\/events\/the-derby/.test(await text(adm, '#ev-out')));
  check('its card says Announced', /Announced/.test(await text(adm, '.ev-card .badge')));
  const events = async () => (await api('/api/admin/events', { unlock })).json.events;
  let ev = (await events())[0];
  const setTimes = async (t) => {
    const r = await api(`/api/admin/events/${ev.id}`, { unlock, method: 'POST', body: { titleEn: ev.titleEn, titleAr: ev.titleAr, lineEn: ev.lineEn, lineAr: ev.lineAr, slug: ev.slug, prizeDays: 30, ...t } });
    if (!r.json?.ok) throw new Error('times: ' + JSON.stringify(r.json));
    ev = (await events()).find((x) => x.id === ev.id);
  };
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const DAY = 24 * 3600_000;

  console.log('\nAnnounced');
  await idle(anon, '/events/the-derby');
  check('the page shows the theme', (await text(anon, '#ev-title')) === 'The Derby' && /two colours/.test(await text(anon, '#ev-line')));
  check('and when entries open', /Entries open/.test(await text(anon, '#ev-when')));
  check('one way on: Start a tifo', (await blueButtons(anon)) === 1 && /Start a tifo/.test(await text(anon, '#ev-acts')));
  check('the prize is said', /30 days of Pro/.test(await text(anon, '#ev-prize')));
  await idle(anon, '/');
  await anon.waitForSelector('#ev-band', { timeout: 15000 });
  check('the home page has the band, linking to the event', /The Derby/.test(await text(anon, '#ev-band')) && (await anon.getAttribute('#ev-band a', 'href')) === '/events/the-derby');
  await idle(anon, '/community');
  await anon.waitForSelector('#ev-band', { timeout: 15000 });
  check('and the community page', /The Derby/.test(await text(anon, '#ev-band')));

  console.log('\nOpen for entries');
  const t0 = Date.now() - 1000;
  await setTimes({ announceAt: new Date(t0).toISOString(), openAt: new Date(t0 + 500).toISOString(), voteAt: at(2 * DAY), closeAt: at(4 * DAY) });
  const tifo = { amal: await makeTifo(amal, 'Amal derby'), amal2: await makeTifo(amal, 'Amal second'), badr: await makeTifo(badr, 'Badr derby'), cyra: await makeTifo(cyra, 'Cyra derby'), dana: await makeTifo(dana, 'Dana derby') };
  await idle(anon, '/events/the-derby');
  check('signed out: Sign in to enter', (await blueButtons(anon)) === 1 && /Sign in to enter/.test(await text(anon, '#ev-acts')));
  check('no entries yet, and it says so', /No entries yet/.test(await text(anon, '#ev-hint')));
  const fan = await open({ user: amal });
  await idle(fan, '/events/the-derby');
  check('signed in: Enter one of my tifos', (await blueButtons(fan)) === 1 && /Enter one of my tifos/.test(await text(fan, '#ev-acts')));
  await fan.click('[data-act="pick"]');
  await fan.waitForSelector('[data-pick]', { timeout: 15000 });
  const offered = await fan.evaluate(() => [...document.querySelectorAll('[data-pick]')].map((b) => b.textContent.trim()).sort());
  check('the picker offers the tifos made since the announcement, not the old one', offered.join('|') === 'Amal derby|Amal second', offered.join('|'));
  check('and says why the old one is not there', /before the announcement/.test(await text(fan, '#ev-pick-note')));
  await fan.click(`[data-pick="${tifo.amal}"]`);
  await fan.waitForSelector('[data-act="leave"]', { timeout: 15000 });
  check('entering says so', /You are in\. Good luck/.test(await text(fan, '#ev-msg')) && /Amal derby/.test(await text(fan, '.evp-in')));
  check('the entry is on the page, marked as yours', (await fan.locator(`.tifo-card.mine[data-design="${tifo.amal}"] .evp-tag`).count()) === 1);
  check('no blue button is left once entered', (await blueButtons(fan)) === 0);
  await fan.click('[data-act="pick"]');
  await fan.waitForSelector('[data-pick][aria-current="true"]', { timeout: 15000 });
  await fan.click(`[data-pick="${tifo.amal2}"]`);
  await fan.waitForFunction((id) => !!document.querySelector(`.tifo-card.mine[data-design="${id}"]`), tifo.amal2, { timeout: 15000 });
  check('changing the entry replaces it', (await fan.locator('#ev-grid .tifo-card').count()) === 1);
  await fan.click('[data-act="leave"]');
  await fan.waitForSelector('[data-act="pick"]:not(.quiet)', { timeout: 15000 });
  check('taking it out empties the list', (await fan.locator('#ev-grid .tifo-card').count()) === 0 && /Your entry is out/.test(await text(fan, '#ev-msg')));
  for (const [u, id] of [[amal, tifo.amal], [badr, tifo.badr], [cyra, tifo.cyra], [dana, tifo.dana]]) await api('/api/events/the-derby/enter', { token: u.token, method: 'POST', body: { designId: id } });
  check('the old tifo is refused by the server too', (await api('/api/events/the-derby/enter', { token: badr.token, method: 'POST', body: { designId: oldTifo } })).status === 403);

  console.log('\nVoting');
  await setTimes({ announceAt: ev.announceAt, openAt: ev.openAt, voteAt: at(-1000), closeAt: at(2 * DAY) });
  await idle(fan, '/events/the-derby');
  check('four entries, each with its card', (await fan.locator('#ev-grid .tifo-card').count()) === 4);
  check('a Vote button on every entry but your own', (await fan.locator('[data-vote]').count()) === 3 && (await fan.locator(`[data-design="${tifo.amal}"] [data-vote]`).count()) === 0);
  check('the vote buttons are big enough to press', await fan.evaluate(() => [...document.querySelectorAll('[data-vote]')].every((b) => b.getBoundingClientRect().height >= 44)));
  check('no blue button: a vote is a tint', (await blueButtons(fan)) === 0);
  await fan.click(`[data-vote="${tifo.badr}"]`);
  await fan.waitForSelector(`[data-vote="${tifo.badr}"][aria-pressed="true"]`, { timeout: 15000 });
  check('a vote shows as Voted', /Voted/.test(await text(fan, `[data-vote="${tifo.badr}"]`)));
  await fan.click(`[data-vote="${tifo.badr}"]`);
  await fan.waitForSelector(`[data-vote="${tifo.badr}"][aria-pressed="false"]`, { timeout: 15000 });
  await fan.click(`[data-vote="${tifo.badr}"]`);
  await fan.waitForSelector(`[data-vote="${tifo.badr}"][aria-pressed="true"]`, { timeout: 15000 });
  check('and can be taken back and given again', true);
  check('no count anywhere on the page', !/Votes: \d/.test(await text(fan, '#main')) && (await fan.locator('.evp-votes').count()) === 0);
  const pageJson = JSON.stringify((await api('/api/events/the-derby', { token: amal.token })).json);
  check('nor in what the server sends', !/"votes":\d|counted|allVotes/.test(pageJson.replace(/"votes":\[[^\]]*\]/, '')));
  // More votes: Badr 3 (amal, cyra, and dana's is refused), Cyra 2, Amal 1.
  for (const [u, id] of [[cyra, tifo.badr], [badr, tifo.cyra], [amal, tifo.cyra], [badr, tifo.amal]]) await api('/api/events/the-derby/vote', { token: u.token, method: 'POST', body: { designId: id, on: true } });
  const unverified = await open({ user: dana });
  await idle(unverified, '/events/the-derby');
  await unverified.click(`[data-vote="${tifo.badr}"]`);
  await unverified.waitForFunction(() => document.getElementById('ev-msg').textContent.trim().length > 0, null, { timeout: 15000 });
  check('an account with no verified email is told why its vote is not taken', /Verify your email to vote/.test(await text(unverified, '#ev-msg')) && (await unverified.getAttribute(`[data-vote="${tifo.badr}"]`, 'aria-pressed')) === 'false');
  await idle(anon, '/events/the-derby');
  check('signed out: Sign in to vote', (await blueButtons(anon)) === 1 && /Sign in to vote/.test(await text(anon, '#ev-acts')));
  const phone = await open({ user: cyra, lang: 'ar', width: 390, height: 844, mobile: true });
  await idle(phone, '/ar/events/the-derby');
  check('Arabic: the page is right to left, in Arabic', (await phone.evaluate(() => document.documentElement.dir)) === 'rtl' && (await text(phone, '#ev-title')) === 'الديربي' && /التصويت/.test(await text(phone, '#ev-stage')));
  check('Arabic: no English left in its own words', !/[A-Za-z]{4,}/.test((await text(phone, '.evp-rules')) + (await text(phone, '#ev-when')) + (await text(phone, '#ev-hint'))));
  check('a phone: nothing wider than the screen', (await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  check('a phone: vote buttons are big enough to press', await phone.evaluate(() => [...document.querySelectorAll('[data-vote]')].every((b) => b.getBoundingClientRect().height >= 44)));

  console.log('\nClosed, and the admin confirms');
  await setTimes({ announceAt: ev.announceAt, openAt: ev.openAt, voteAt: at(-3000), closeAt: at(-1000) });
  await idle(anon, '/events/the-derby');
  check('the page says the result is being checked', /Result soon/.test(await text(anon, '#ev-stage')) && /being checked/.test(await text(anon, '#ev-when')));
  check('still no counts', (await anon.locator('.evp-votes').count()) === 0 && (await anon.locator('[data-vote]').count()) === 0);
  await adm.reload({ waitUntil: 'domcontentloaded' });
  await adm.waitForSelector('.ev-confirm', { timeout: 30000 });
  check('the admin card says it is waiting for the admin', /Waiting for you/.test(await text(adm, '.ev-card .badge')));
  const adminRows = await adm.evaluate(() => [...document.querySelectorAll('.ev-card tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | ')).filter((x) => /derby/.test(x)));
  check('and lists the entries with their counted votes', adminRows.some((r) => /^1 \| Badr derby \| @ev_badr \| .* \| 2 \| 2 \|/.test(r)) && adminRows.some((r) => /^2 \| Cyra derby/.test(r)), adminRows.join(' / '));
  await adm.click(`.ev-out[data-design="${tifo.dana}"]`);
  check('taking an entry out needs a reason', /reason/i.test(await text(adm, '#ev-out')));
  await adm.fill(`.ev-reason[data-design="${tifo.dana}"]`, 'Uses a club crest');
  await adm.click(`.ev-out[data-design="${tifo.dana}"]`);
  await adm.waitForSelector(`.ev-back[data-design="${tifo.dana}"]`, { timeout: 15000 });
  check('with one, it is taken out', /Taken out/.test(await text(adm, '#ev-out')));
  let asked = '';
  adm.on('dialog', (d) => { asked = d.message(); void d.accept(); });
  await adm.click('.ev-confirm');
  await adm.waitForFunction(() => /Result confirmed/.test(document.getElementById('ev-out')?.textContent || ''), null, { timeout: 15000 });
  check('confirming asks first, naming the winner and the prize', /Badr derby/.test(asked) && /@ev_badr/.test(asked) && /30 days of Pro/.test(asked), asked);
  check('and says the pass was given', /prize pass was given/.test(await text(adm, '#ev-out')));
  check('the card is a record now: nothing left to change', (await adm.locator('.ev-card .ev-edit, .ev-card .ev-confirm, .ev-card .ev-cancel, .ev-card .ev-out').count()) === 0);
  const passes = (await api('/api/admin/pro?username=ev_badr', { unlock })).json.account.passes;
  check('the winner holds exactly one Pro pass', passes.length === 1 && passes[0].plan === 'monthly', JSON.stringify(passes));
  check('nobody else does', (await api('/api/admin/pro?username=ev_cyra', { unlock })).json.account.passes.length === 0);

  console.log('\nThe result');
  await idle(anon, '/events/the-derby');
  const podium = await anon.evaluate(() => [...document.querySelectorAll('#ev-podium .tifo-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  check('the podium: winner, second, third, with their counts', podium.length === 3 && /Badr derby.*Winner.*Votes: 2/.test(podium[0]) && /Cyra derby.*Second.*Votes: 2/.test(podium[1]) && /Amal derby.*Third.*Votes: 1/.test(podium[2]), podium.join(' / '));
  check('the entry taken out is listed with its reason', /Dana derby/.test(await text(anon, '#ev-out-list')) && /Uses a club crest/.test(await text(anon, '#ev-out-list')));
  check('a podium tifo is not listed twice', (await anon.locator('#ev-grid .tifo-card').count()) === 0);
  await idle(anon, '/');
  await anon.waitForSelector('#ev-band', { timeout: 15000 });
  check('the home page names the winner', /Winner: "Badr derby" by @ev_badr/.test(await text(anon, '#ev-band')));
  await idle(anon, '/events');
  check('/events lists it as a record', /The Derby/.test(await text(anon, '#ev-list')) && /Result/.test(await text(anon, '#ev-list')));
  check('no page raised an error', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the suite ran to its end', false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  await browser.close();
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
