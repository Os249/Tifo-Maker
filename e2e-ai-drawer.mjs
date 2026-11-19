/**
 * The AI drawer in a real browser: the two doors, their counters, the gates,
 * and AI Critique from the first press to an applied and undone fix.
 *
 * Needs the server on a built dist (BASE, default :8911). The model is not
 * asked: /api/ai/quota, /api/ai/review and /api/ai/review/chat are answered
 * here, so what is checked is the editor: what is shown before anything is
 * spent, what a fix does to the design, and that one undo takes it back.
 * The server's half is server/test/review.test.mts.
 *
 *   BASE=http://127.0.0.1:8787 node e2e-ai-drawer.mjs
 */
import { chromium } from 'playwright';

const B = process.env.BASE || 'http://127.0.0.1:8911';
const SHOTS = process.env.SHOTS || '';
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const LS = (lang = 'en', extra = []) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v2', value: '1' }, { name: 'tifo_price_ask_v1', value: '{"n":2,"until":0}' }, { name: 'tifo_guide_v1', value: 'done' },
  { name: 'tifo_banner_tour_v1', value: '1' }, { name: 'tifo_view_v1', value: '2d' },
  ...extra,
];
const in2days = new Date(Date.now() + 2 * 86400000).toISOString();
const allowance = (kind, remaining, limit) => ({ kind, used: limit - remaining, limit, remaining, period: 'week', resetAt: in2days });
const LIMITS = {
  free: { std: [{ period: 'day', limit: 10 }], critique: [{ period: 'week', limit: 3 }], chat: [{ period: 'week', limit: 20 }] },
  pro: { std: [{ period: 'day', limit: 15 }], critique: [{ period: 'day', limit: 6 }, { period: 'month', limit: 40 }], chat: [{ period: 'day', limit: 40 }] },
};
const flat = (o) => ({ layer: null, stand: null, text: null, rows: null, color: null, colorHex: null, fromColor: null, toColor: null, toColorHex: null, outlineSeats: null, axis: null, merge: null, ...o });

/** An editor whose AI routes are answered by `ai` (a mutable object of what to say next). */
async function editor({ lang = 'en', viewport = { width: 1440, height: 900 }, ai = null, ls = [] } = {}) {
  const ctx = await browser.newContext({ viewport, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, ls) }] } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  if (ai) {
    ai.calls = [];
    await ctx.addInitScript(() => { try { localStorage.setItem('tifo_token_v1', 'e2e-not-a-real-token'); } catch { /* */ } });
    const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await p.route('**/api/ai/quota', (r) => json(r, ai.quota.status ?? 200, ai.quota.body));
    await p.route('**/api/ai/review', (r) => { ai.calls.push({ path: 'review', body: r.request().postDataJSON() }); const a = ai.review; return json(r, a.status ?? 200, a.body); });
    await p.route('**/api/ai/review/chat', (r) => { ai.calls.push({ path: 'chat', body: r.request().postDataJSON() }); const a = ai.chat; return json(r, a.status ?? 200, a.body); });
    // The rest of the account's calls: answered as "nobody special", so a made-up token signs nobody out.
    await p.route('**/api/me', (r) => json(r, 200, { id: 'u1', username: 'e2e_fan', email: 'e2e@example.test', emailVerified: true, hasPassword: true }));
    await p.route('**/api/pro', (r) => json(r, 200, { live: false, signedIn: true }));
  }
  await p.goto(B + '/app?new=1&e2e=1', { waitUntil: 'load', timeout: 90000 });
  await p.waitForFunction(() => !!window.__tifo, null, { timeout: 60000 });
  await p.waitForTimeout(700);
  return { ctx, p, errs };
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
const visible = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); return !!n && !n.hidden && n.getClientRects().length > 0; }, sel);
/** Light blue everywhere and the words "kings of asia" as a text layer on the north stand. */
const design = (p) => p.evaluate(() => {
  const { store, objects, map } = window.__tifo;
  store.changePalette(['#262a33', '#8cc8f5', '#ffffff', '#f2c230', '#7dbdee']);
  store.transform((i) => (map.xy[i * 2 + 1] % 40 < 20 ? 1 : 4));
  const W = map.bounds.maxX - map.bounds.minX;
  const t = objects.addText({ cx: map.bounds.minX + W * 0.25, cy: (map.bounds.minY + map.bounds.maxY) / 2, width: 420, height: 64, colorIndex: 2, tier: null, text: 'kings of asia', fontCss: 'Inter, sans-serif', fontId: 'inter', arcDeg: 0, heightSeats: 6 });
  objects.select(null);
  return t.id;
});
const layer = (p, id) => p.evaluate((i) => { const o = window.__tifo.objects.get(i); return o ? { text: o.text, rows: o.heightSeats, outline: o.outline ?? null, color: o.colorIndex } : null; }, id);
const seats = (p, hex) => p.evaluate((h) => { const { store } = window.__tifo; const k = store.palette.indexOf(h); let n = 0; if (k >= 0) for (let i = 0; i < store.cells.length; i++) if (store.cells[i] === k) n++; return n; }, hex);

const quotaBody = (critique, chat) => ({ unlimited: false, used: 3, limit: 10, remaining: 7, resetInSec: 1800, review: { plan: 'free', critique: allowance('critique', critique, 3), chat: allowance('chat', chat, 20) }, limits: LIMITS });
const ANSWER = (id, critique = 1) => ({
  intent: { summary: 'A tifo for Al Hilal before the AFC final.', sure: true, question: null }, reply: null, counted: true,
  fixes: [
    { id: 'f1', why: 'Capitals read better from across the ground.', op: flat({ type: 'text.setCase', layer: id, text: 'KINGS OF ASIA' }) },
    { id: 'f2', why: 'Six rows cannot be read from the far stand.', op: flat({ type: 'text.resize', layer: id, rows: 14 }) },
    { id: 'f3', why: 'White on light blue melts away.', op: flat({ type: 'text.outline', layer: id, colorHex: '#0b2a6b', outlineSeats: 2 }) },
    { id: 'f4', why: 'A darker field makes the words stand out.', op: flat({ type: 'paint.replaceColor', stand: 'north', fromColor: 1, toColorHex: '#123a8c' }) },
    { id: 'f5', why: 'Two blues nobody can tell apart.', op: flat({ type: 'palette.merge', merge: [{ from: 4, to: 1 }] }) },
    { id: 'f6', why: 'A layer that is not there.', op: flat({ type: 'text.resize', layer: 't99', rows: 20 }) },
  ],
  ideas: [{ text: 'Add the trophy on the south stand.', brief: 'The AFC Champions League Elite trophy with a target over it, on the south stand' }],
  review: { plan: 'free', critique: allowance('critique', critique, 3), chat: allowance('chat', 14, 20) },
});

console.log('— signed out: the panel is all there, and says the one step —');
{
  const { ctx, p, errs } = await editor();
  await p.click('#rail-ai');
  await p.waitForSelector('#ai-open-create', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(700);
  check('the AI tab opens on the two doors', await visible(p, '#ai-home') && await visible(p, '#ai-door-create') && await visible(p, '#ai-door-review') && !(await visible(p, '#ai-prompt')));
  check('each door says what it does to the tifo', /Replaces what is on the stands/.test(await text(p, '#ai-door-create')) && /stays as it is until you press Apply/.test(await text(p, '#ai-door-review')));
  check('the one step is said: sign in', /Sign in to use the AI tools/.test(await text(p, '#ai-gate')) && /a review of your tifo every day/.test(await text(p, '#ai-gate')), await text(p, '#ai-gate'));
  check('the review is held back, Create still signs a visitor up', await p.evaluate(() => document.querySelector('#ai-open-review').disabled && !document.querySelector('#ai-open-create').disabled));
  const blue = await p.evaluate(() => [...document.querySelectorAll('#ai-home button.primary')].filter((b) => b.getClientRects().length).length);
  check('one blue button in the drawer', blue === 1, String(blue));
  await p.click('#ai-open-create');
  check('Create is the designer, with a way back', await visible(p, '#ai-prompt') && await visible(p, '#ai-back-create') && !(await visible(p, '#ai-home')));
  check('the old Polish button is gone', !(await p.evaluate(() => !!document.querySelector('#ai-polish'))));
  await p.click('#ai-back-create');
  check('back returns to the doors', await visible(p, '#ai-home'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await shot(p, 'drawer-signed-out');
  await ctx.close();
}

console.log('— not verified —');
{
  const ai = { quota: { status: 403, body: { error: 'Verify your email to use the AI Designer.', reason: 'verify', locked: true, limits: LIMITS } }, review: {}, chat: {} };
  const { ctx, p } = await editor({ ai });
  await p.click('#rail-ai');
  await p.waitForSelector('#ai-open-create', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(700);
  check('the one step is said: verify the email', /One step left: verify your email/.test(await text(p, '#ai-gate')), await text(p, '#ai-gate'));
  check('with a way to enter the code', /Enter the code/.test(await text(p, '#ai-gate')) && /Send it again/.test(await text(p, '#ai-gate')));
  await ctx.close();
}

console.log('— the counters, before anything is spent —');
{
  const ai = { quota: { body: quotaBody(2, 14) }, review: { body: {} }, chat: { body: {} } };
  const { ctx, p, errs } = await editor({ ai });
  await p.click('#rail-ai');
  await p.waitForSelector('#ai-open-create', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(700);
  check('Create has its counter on its door', /7 of 10 left this hour/.test(await text(p, '#ai-count-create')), await text(p, '#ai-count-create'));
  check('Review has its own', /2 of 3 left this week/.test(await text(p, '#ai-count-review')), await text(p, '#ai-count-review'));
  check('no gate for a verified account', (await text(p, '#ai-gate')) === '');
  check('Pro is not mentioned where Pro is off', !(await visible(p, '#ai-home-foot')));
  await p.click('#ai-open-review');
  check('an empty bowl has nothing to review, and says what to do', /no tifo to review yet/.test(await text(p, '#rv-body')) && /Open Create/.test(await text(p, '#rv-body')), await text(p, '#rv-body'));
  const id = await design(p);
  await p.click('#ai-back-review');
  await p.click('#ai-open-review');
  check('the button says what a review costs', /uses 1 of 2/.test(await text(p, '#rv-run')), await text(p, '#rv-run'));
  check('and the message counter is under the box', /Messages: 14 of 20 left this week/.test(await text(p, '#rv-chat-count')), await text(p, '#rv-chat-count'));
  check('nothing has been asked of the model yet', ai.calls.length === 0);

  ai.review = { body: ANSWER(id) };
  await p.click('#rv-run');
  await p.waitForSelector('.rv-fix');
  const sent = ai.calls[0].body;
  check('a review sends the design as text', typeof sent.design === 'string' && sent.design.includes('"kings of asia"') && sent.design.includes('palette:') && sent.design.includes('contrast='), sent.design?.slice(0, 160));
  check('one picture', typeof sent.image === 'string' && sent.image.startsWith('data:image/jpeg;base64,') && sent.image.length < 800000, `${Math.round((sent.image?.length ?? 0) / 1024)} KB`);
  check('what the design holds', sent.ctx.layers.some((l) => l.id === id && l.kind === 'text') && sent.ctx.paletteLength === 5 && sent.ctx.stands.length === 4);
  check('and the language', sent.lang === 'en');
  check('five fixes: the one for a missing layer is never shown', (await p.locator('.rv-fix').count()) === 5);
  check('the read of the tifo is shown, to confirm or correct', /A tifo for Al Hilal/.test(await text(p, '.rv-intent')) && /That's right/.test(await text(p, '.rv-intent')) && /No, let me say/.test(await text(p, '.rv-intent')));
  check('the counter moved', /1 of 3|Last one this week/.test(await text(p, '#ai-pill-review')), await text(p, '#ai-pill-review'));
  check('ideas are apart from fixes', /Bigger ideas/.test(await text(p, '.rv-sec')) && (await p.locator('.rv-idea').count()) === 1);
  check('nothing changed yet', (await layer(p, id)).text === 'kings of asia');
  check('a card shows before and after', /kings of asia.*KINGS OF ASIA/.test(await text(p, '.rv-fix:nth-of-type(1) .rv-preview') ?? await text(p, '.rv-fix .rv-preview')));
  await shot(p, 'drawer-review');

  // Apply, and take back.
  const fix = (n) => p.locator('.rv-fix').nth(n);
  await fix(0).locator('.rv-apply').click();
  check('Apply changes the design', (await layer(p, id)).text === 'KINGS OF ASIA');
  check('the card says so, with Undo', /Applied/.test(await fix(0).textContent()) && /Undo/.test(await fix(0).textContent()));
  await fix(0).locator('.link-btn').click();
  check('the card\'s Undo takes it back', (await layer(p, id)).text === 'kings of asia' && /Apply/.test(await fix(0).textContent()));
  await fix(0).locator('.rv-apply').click();
  await p.evaluate(() => window.__tifo.store.undo());
  check('so does the editor\'s own undo, in one step', (await layer(p, id)).text === 'kings of asia');
  await p.evaluate(() => window.__tifo.store.redo());

  await fix(1).locator('.rv-apply').click();
  check('a size fix sets the rows', (await layer(p, id)).rows === 14);
  const before = await p.evaluate(() => window.__tifo.store.palette.length);
  await fix(2).locator('.rv-apply').click();
  await p.waitForTimeout(300);
  const lined = await layer(p, id);
  check('an outline in a new colour: the layer has it and the palette grew by one', lined.outline?.seats === 2 && (await p.evaluate(() => window.__tifo.store.palette.length)) === before + 1);
  check('and it is on the seats', (await seats(p, '#0b2a6b')) > 50, String(await seats(p, '#0b2a6b')));
  await fix(3).locator('.rv-apply').click();
  await p.waitForTimeout(200);
  check('a background fix repaints its stand only', (await seats(p, '#123a8c')) > 1000 && (await seats(p, '#8cc8f5')) > 1000, `${await seats(p, '#123a8c')} / ${await seats(p, '#8cc8f5')}`);
  await p.evaluate(() => window.__tifo.store.undo());
  check('one undo takes the repaint and its colour back', (await seats(p, '#123a8c')) === 0 && (await p.evaluate(() => window.__tifo.store.palette.includes('#123a8c'))) === false);
  await fix(4).locator('.link-btn').click();
  check('Dismiss puts a card away', /is-gone/.test(await fix(4).getAttribute('class')));
  await shot(p, 'drawer-applied');

  // The design changed under an open fix.
  ai.review = { body: { ...ANSWER(id, 0), fixes: [{ id: 'f1', why: 'Bigger.', op: flat({ type: 'text.resize', layer: id, rows: 20 }) }], ideas: [] } };
  await p.locator('.rv-again').click();
  await p.waitForFunction(() => document.querySelectorAll('.rv-fix.is-open').length === 1);
  check('a second review keeps what was applied on the record', (await p.locator('.rv-fix.is-done').count()) >= 2);
  await p.evaluate((i) => window.__tifo.objects.update(i, { locked: true }), id);
  await p.locator('.rv-fix.is-open .rv-apply').click();
  check('a fix whose layer is now locked says it no longer applies', /no longer applies/.test(await text(p, '.rv-fix.is-stale')) && (await layer(p, id)).rows === 14);
  await p.evaluate((i) => window.__tifo.objects.update(i, { locked: false }), id);

  // Chat.
  ai.chat = { body: { intent: { summary: '', sure: true, question: null }, reply: 'Try two lines: English on top, Arabic below.', counted: true, fixes: [{ id: 'f1', why: 'A stronger line.', op: flat({ type: 'text.setText', layer: id, text: 'KINGS OF ASIA 2026' }) }], ideas: [], review: { plan: 'free', critique: allowance('critique', 0, 3), chat: allowance('chat', 13, 20) } } };
  await p.fill('#rv-input', 'make the slogan stronger');
  await p.press('#rv-input', 'Enter');
  await p.waitForSelector('.rv-bub.is-ai');
  const chatSent = ai.calls.find((c) => c.path === 'chat').body;
  check('a message goes with the design, the fixes so far and no picture', chatSent.message === 'make the slogan stronger' && !chatSent.image && /applied/.test(chatSent.fixes) && typeof chatSent.design === 'string');
  check('the reply is in the conversation', /Try two lines/.test(await text(p, '.rv-bub.is-ai')) && /make the slogan stronger/.test(await text(p, '.rv-bub.is-user')));
  check('with a new fix card', /New wording/.test(await text(p, '#rv-body')));
  check('the message counter moved', /13 of 20/.test(await text(p, '#rv-chat-count')), await text(p, '#rv-chat-count'));

  // Out of reviews: when it comes back, a calm way on, never a dead end.
  ai.review = { status: 429, body: { error: 'reviews used up for now', reason: 'quota', kind: 'critique', plan: 'free', review: { plan: 'free', critique: allowance('critique', 0, 3), chat: allowance('chat', 13, 20) } } };
  await p.locator('.rv-again').click();
  await p.waitForSelector('#rv-body .ai-state[data-tone="warn"]');
  const lim = await text(p, '#rv-body .ai-state[data-tone="warn"]');
  check('used up: what ran out and when it comes back', /all 3 reviews for this week/.test(lim) && /come back/.test(lim), lim);
  check('the fixes already there can still be used', /Carry on with the fixes you have/.test(lim) && (await p.locator('.rv-fix.is-open').count()) >= 1);
  check('no Pro offer where Pro is off', !/Pro/.test(lim));
  check('Create\'s counter did not move', /7 of 10/.test(await text(p, '#ai-pill-create') ?? await text(p, '#ai-count-create')));

  // An idea goes to Create with its brief; the review is still there on the way back.
  await p.locator('.rv-again').waitFor();
  ai.review = { body: { ...ANSWER(id, 0), fixes: [] } };
  await p.locator('.rv-again').click();
  await p.waitForSelector('.rv-idea');
  check('a clean review says the tifo is ready', /nothing needs fixing/.test(await text(p, '#rv-body')));
  await p.locator('.rv-idea .rv-apply').click();
  check('an idea is handed to Create with its brief', await visible(p, '#ai-create') && /AFC Champions League Elite trophy/.test(await p.inputValue('#ai-prompt')));
  check('and Create says it uses its own counter', /7 of 10/.test(await text(p, '#ai-pill-create')));
  await p.click('#ai-back-create');
  await p.click('#ai-open-review');
  check('the review is as it was left', (await p.locator('.rv-fix').count()) >= 3);

  // Busy.
  ai.review = { status: 503, body: { error: 'the AI review did not answer', reason: 'busy', cause: 'busy' } };
  await p.locator('.rv-again').click();
  await p.waitForSelector('#rv-body .ai-state[data-tone="bad"]');
  check('a review that did not come: nothing lost, and a way to try again', /unchanged and nothing was counted/.test(await text(p, '#rv-body .ai-state[data-tone="bad"]')) && /Try again/.test(await text(p, '#rv-body .ai-state[data-tone="bad"]')));

  // Full screen and back.
  await p.click('#ai-full');
  check('full screen: the tifo and the review, nothing else', await p.evaluate(() => document.body.classList.contains('ai-full') && getComputedStyle(document.querySelector('body > header')).display === 'none' && document.querySelector('#panel').getBoundingClientRect().width >= 430));
  await shot(p, 'drawer-full');
  await p.keyboard.press('Escape');
  check('Escape puts it back', await p.evaluate(() => !document.body.classList.contains('ai-full') && getComputedStyle(document.querySelector('body > header')).display !== 'none'));
  check('the drawer is wider than the tool panels', await p.evaluate(() => document.querySelector('#panel').getBoundingClientRect().width >= 370));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('— the tifo\'s intent: asked when unsure, kept when confirmed —');
{
  const ai = { quota: { body: quotaBody(3, 20) }, review: { body: {} }, chat: { body: {} } };
  const { ctx, p, errs } = await editor({ ai, ls: [{ name: 'tifo_ai_view_v1', value: 'review' }] });
  const id = await design(p);
  await p.click('#rail-ai');
  await p.waitForSelector('#ai-open-create', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(600);
  check('the drawer remembers the tool used last', await visible(p, '#ai-review') && !(await visible(p, '#ai-home')));
  ai.review = { body: { intent: { summary: '', sure: false, question: 'What are you trying to show?' }, reply: null, fixes: [], ideas: [], counted: false, review: { plan: 'free', critique: allowance('critique', 3, 3), chat: allowance('chat', 20, 20) } } };
  await p.click('#rv-run');
  await p.waitForSelector('.rv-bub.is-ai');
  check('unsure: it asks in the conversation', /What are you trying to show/.test(await text(p, '.rv-bub.is-ai')) && /does not use a message/.test(await text(p, '#rv-body')));
  check('and that review was not counted', /3 of 3/.test(await text(p, '#ai-pill-review')), await text(p, '#ai-pill-review'));
  ai.review = { body: ANSWER(id, 2) };
  await p.locator('#rv-body .rv-sugg .chip', { hasText: 'A derby' }).click();
  await p.waitForSelector('.rv-fix');
  const second = ai.calls.filter((c) => c.path === 'review')[1].body;
  check('the answer goes with the next review as the confirmed intent', second.intent === 'A derby');
  check('and no chat message was spent on it', !ai.calls.some((c) => c.path === 'chat'));
  check('the confirmed intent is shown as the person\'s own', /What your tifo is/.test(await text(p, '.rv-intent')) && /A derby/.test(await text(p, '.rv-intent')));
  await p.locator('.rv-intent .link-btn').click();
  await p.fill('#rv-input', 'A farewell for our captain');
  await p.press('#rv-input', 'Enter');
  check('correcting it is free too', /A farewell for our captain/.test(await text(p, '.rv-intent')) && !ai.calls.some((c) => c.path === 'chat'));
  check('it is kept for this project', /A farewell for our captain/.test(await p.evaluate(() => localStorage.getItem('tifo_ai_intent_v1') ?? '')));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('— Arabic, on a phone —');
{
  const ai = { quota: { body: quotaBody(1, 2) }, review: { body: {} }, chat: { body: {} } };
  const { ctx, p, errs } = await editor({ lang: 'ar', viewport: { width: 390, height: 844 }, ai });
  const id = await design(p);
  await p.locator('[data-tab="ai"]').first().click();
  await p.waitForSelector('#ai-open-create', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(700);
  check('the AI sheet opens on the two doors, in Arabic', await visible(p, '#ai-home') && /صمّم تيفو جديد/.test(await text(p, '#ai-door-create')) && /راجِع تيفوي/.test(await text(p, '#ai-door-review')));
  check('right to left', await p.evaluate(() => document.documentElement.dir === 'rtl'));
  check('the last review of the week is a warning before the wall', /آخر وحدة هالأسبوع/.test(await text(p, '#ai-count-review')) && (await p.evaluate(() => document.querySelector('#ai-count-review').dataset.level)) === 'low', await text(p, '#ai-count-review'));
  check('no English left on the doors', !/[A-Za-z]{4,}/.test((await text(p, '#ai-home')).replace(/AI/g, '')), await text(p, '#ai-home'));
  check('nothing runs off the side', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const small = await p.evaluate(() => [...document.querySelectorAll('#ai-home button')].filter((b) => b.getClientRects().length && b.getBoundingClientRect().height < 44).length);
  check('every button is a 44px target', small === 0, String(small));
  await shot(p, 'drawer-phone-ar-home');
  await p.click('#ai-open-review');
  ai.review = { body: { ...ANSWER(id, 0), intent: { summary: 'تيفو للهلال قبل نهائي آسيا.', sure: true, question: null }, fixes: [{ id: 'f1', why: 'الحروف الكبيرة تنقرأ أوضح من بعيد.', op: flat({ type: 'text.setCase', layer: id, text: 'KINGS OF ASIA' }) }] } };
  await p.click('#rv-run');
  await p.waitForSelector('.rv-fix');
  check('a fix card in Arabic', /الحروف صغيرة/.test(await text(p, '.rv-fix')) && /طبّق/.test(await text(p, '.rv-fix')) && /تجاهل/.test(await text(p, '.rv-fix')));
  await p.locator('.rv-fix .rv-apply').click();
  check('Apply works from the sheet', (await layer(p, id)).text === 'KINGS OF ASIA' && /تم التطبيق/.test(await text(p, '.rv-fix')));
  check('there is no full-screen button on a phone', !(await visible(p, '#ai-full')));
  check('nothing runs off the side in the review', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await shot(p, 'drawer-phone-ar-review');
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
