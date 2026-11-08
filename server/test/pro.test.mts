/**
 * Pro: the plan's periods (a pass's own month among them), the allowances,
 * the 7-day gift (which never expires), the admin's months of Pro, the AI
 * routes on the new limits and the smart cut-out.
 *
 * Mostly adversarial, like security.test.mts: it tries to take more than the
 * allowance (one at a time and all at once), to accept the gift twice, to
 * accept one it should not have, to grant itself a pass, to use the cut-out
 * where Pro is off, and to make the server fetch a cut-out from somewhere it
 * should not. Runs on the memory stores, and the store-level checks again on
 * Postgres when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository, PgProRepository, type ProRepository } from '../src/proRepo';
import { ProService, isThrowawayEmail } from '../src/pro';
import { AI_ON_PRO, CYCLE_DAYS, FREE_WINDOWS, OFFER, PHOTO_ON_PRO, PLAN_WINDOWS, cycleOf, liveFor, normalizePlan, periodEnd, periodKey, periodStart, proMode } from '../src/proPlan';
import { cutoutConfigured, cutoutForDesign, cutoutPicture, fetchResult, hostAllowed, isPrivateAddress, localCutoutUrl, useLookupForTests } from '../src/cutout';
import { configWarnings } from '../src/preflight';
import { kitContext } from '../src/aiRoutes';
import { GUEST_NEW_PER_DAY, GuestPace, accountVoter, cleanComment, deviceVoter, readPriceInput, summarize } from '../src/proPrice';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** A real, tiny PNG (w x h, RGBA), so the metadata stripper accepts it. */
function png(w = 2, h = 2): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4), 0x7f);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = png();
const pngUrl = (b: Buffer = PNG) => `data:image/png;base64,${b.toString('base64')}`;

async function reg(app: FastifyInstance, u: string, email = `${u}@example.test`): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'quartz-lantern-echo7', email, acceptedVersion: 'test' } });
  assert.equal(r.statusCode < 300, true, `register ${u}: ${r.body}`);
  const token = (r.json() as { token: string }).token;
  const id = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  return { token, id };
}
async function makeDesign(app: FastifyInstance, token: string, isPublic = false): Promise<string> {
  const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  const id = (d.json() as { id: string }).id;
  if (isPublic) await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } });
  return id;
}

// ------------------------------------------------------------ 1. periods ---
{
  // Saturday 25 Oct 2026, 20:59 UTC is still Saturday 23:59 in Riyadh; one
  // minute later it is Sunday 00:00 and a new week.
  const sat = new Date('2026-10-31T20:59:00Z');
  const sun = new Date('2026-10-31T21:00:00Z');
  assert.equal(periodKey('week', sat), 'w:2026-10-25', 'the week that started Sunday 25 Oct');
  assert.equal(periodKey('week', sun), 'w:2026-11-01', 'Sunday 00:00 Riyadh is a new week');
  assert.equal(periodStart('week', sun).toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(periodEnd('week', sat).toISOString(), '2026-10-31T21:00:00.000Z', 'the week ends at Sunday 00:00 Riyadh');
  assert.equal(periodKey('day', new Date('2026-10-28T20:59:59Z')), 'd:2026-10-28');
  assert.equal(periodKey('day', new Date('2026-10-28T21:00:00Z')), 'd:2026-10-29', 'a day turns at 00:00 Riyadh, 21:00 UTC');
  assert.equal(periodKey('month', new Date('2026-10-31T21:00:00Z')), 'm:2026-11', 'and a month too');
  assert.equal(periodEnd('month', new Date('2026-12-15T00:00:00Z')).toISOString(), '2026-12-31T21:00:00.000Z');
  // The numbers the plan promises, read from the one settings file.
  assert.deepEqual(FREE_WINDOWS.std, [{ period: 'day', limit: 10 }, { period: 'month', limit: 40 }], 'free: 10 designs a day, 40 a month');
  assert.deepEqual(FREE_WINDOWS.polish, [{ period: 'week', limit: 3 }]);
  assert.deepEqual(FREE_WINDOWS.photo, [{ period: 'week', limit: 2 }]);
  assert.equal(FREE_WINDOWS.cutout[0].limit, 1);
  assert.equal('super' in FREE_WINDOWS, false, 'no Super allowance: every design is the one pipeline');
  // More AI designs and Polish are off the Pro list until they rate 8 (proPlan AI_ON_PRO).
  const PRO_STD = [{ period: 'day', limit: 15 }, { period: 'cycle', limit: 70 }];
  assert.deepEqual(PLAN_WINDOWS.monthly.std, AI_ON_PRO ? PRO_STD : FREE_WINDOWS.std);
  assert.deepEqual(PLAN_WINDOWS.monthly.polish, AI_ON_PRO ? [{ period: 'day', limit: 10 }, { period: 'cycle', limit: 20 }] : FREE_WINDOWS.polish);
  // Stadium from a photo is off the Pro list until it rates 8 (proPlan PHOTO_ON_PRO).
  assert.deepEqual(PLAN_WINDOWS.monthly.photo, PHOTO_ON_PRO ? [{ period: 'day', limit: 3 }, { period: 'cycle', limit: 10 }] : FREE_WINDOWS.photo);
  assert.deepEqual(PLAN_WINDOWS.monthly.cutout, [{ period: 'day', limit: 5 }, { period: 'cycle', limit: 15 }]);
  assert.equal(PLAN_WINDOWS.gift, PLAN_WINDOWS.monthly, 'the gift is all of Pro');
  for (const k of (['std', 'polish', 'photo', 'cutout'] as const).filter((x) => (x !== 'photo' || PHOTO_ON_PRO) && ((x !== 'std' && x !== 'polish') || AI_ON_PRO))) {
    assert.ok(PLAN_WINDOWS.monthly[k].some((w) => w.period === 'cycle'), `${k}: Pro has a month's ceiling`);
  }
  // A member who uses every last one stays near the ~$2.50 a month the plan allows for.
  const cost = { std: 0.022, polish: 0.013, photo: 0.04, cutout: 0.018 };
  const month = (k: keyof typeof cost) => (PLAN_WINDOWS.monthly[k].find((w) => w.period === 'cycle')?.limit ?? 0) * cost[k];
  assert.ok(month('std') + month('polish') + month('photo') + month('cutout') <= 2.5, 'the most one month of Pro can cost');
  // On sale, Pro always gives more designs than Free, by the day and by the month.
  if (AI_ON_PRO) assert.ok(PLAN_WINDOWS.monthly.std[0].limit > FREE_WINDOWS.std[0].limit && PLAN_WINDOWS.monthly.std[1].limit > FREE_WINDOWS.std[1].limit);
  assert.equal(OFFER.monthly.price, 19);
  assert.equal(OFFER.monthly.days, 30);
  assert.equal(OFFER.gift.days, 7);
  assert.equal('claimBy' in OFFER.gift, false, 'the gift has no claim-by date');
  assert.equal(OFFER.paymentsOpen, false, 'no buy button goes anywhere until there is a payment provider');
  // The legacy plan names read as a month of Pro.
  assert.equal(normalizePlan('season'), 'monthly');
  assert.equal(normalizePlan('match'), 'monthly');
  assert.equal(normalizePlan('gift'), 'gift');
  // A pass's month is its own 30 days, not the calendar's.
  const day = 86_400_000;
  const start = Date.parse('2026-10-20T10:00:00Z');
  const month30 = { id: 'p1', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 30 * day).toISOString() };
  assert.equal(CYCLE_DAYS, 30);
  const c0 = cycleOf(month30, new Date(start + 12 * day));
  assert.equal(c0.key, 'c:p1:0', 'the 1st of November is still the month that began on 20 October');
  assert.equal(c0.end.toISOString(), month30.endsAt);
  const long = { id: 'p2', startsAt: month30.startsAt, endsAt: new Date(start + 90 * day).toISOString() };
  const c1 = cycleOf(long, new Date(start + 31 * day));
  assert.equal(c1.key, 'c:p2:1', 'a 90-day grant has three months of allowance');
  assert.equal(c1.end.toISOString(), new Date(start + 60 * day).toISOString());
  const gift = { id: 'g1', startsAt: month30.startsAt, endsAt: new Date(start + 7 * day).toISOString() };
  assert.equal(cycleOf(gift, new Date(start + day)).end.toISOString(), gift.endsAt, "the gift's month is the gift");
}

// ------------------------------------------- 1b. the club kit for the AI ---
{
  const line = kitContext({ name: 'Blue Waves', colours: ['#0033a0', '#FFFFFF', 'red', '#ffd700'], font: 'x' });
  assert.match(line, /"Blue Waves"/, 'the kit\'s name goes to the designer');
  assert.match(line, /#0033a0, #ffffff, #ffd700|#0033a0, #FFFFFF, #ffd700/i, 'and its colours, the ones that are colours');
  assert.equal(kitContext({ name: 'x', colours: [] }), '', 'no colours, nothing sent');
  assert.equal(kitContext('kit'), '', 'only an object is read');
  assert.ok(!/\n|"[^"]*"[^"]*"[^"]*"/.test(kitContext({ name: 'a"b\nc', colours: ['#000000'] })), 'a name cannot break out of its quotes or line');
  assert.equal((kitContext({ colours: Array.from({ length: 20 }, (_, i) => `#1234${(16 + i).toString(16)}`) }).match(/#1234[0-9a-f]{2}/g) ?? []).length, 8, 'at most 8 colours');
}

// --------------------------------------------------------------- 2. mode ---
{
  const env = (m?: string, users?: string) => ({ PRO_MODE: m, PRO_PREVIEW_USERS: users }) as NodeJS.ProcessEnv;
  assert.equal(proMode(env()), 'off', 'off unless told otherwise');
  assert.equal(proMode(env('ON ')), 'on');
  assert.equal(proMode(env('yes')), 'off', 'an unknown word is off, not on');
  assert.equal(liveFor('osamh', env()), false);
  assert.equal(liveFor('osamh', env('preview', 'Osamh, other')), true, 'preview names match ignoring case and spaces');
  assert.equal(liveFor('someone', env('preview', 'osamh')), false);
  assert.equal(liveFor(null, env('preview', 'osamh')), false);
  assert.equal(liveFor('anyone', env('on')), true);
}

// ------------------------------------------------- 3. throwaway addresses ---
{
  assert.equal(isThrowawayEmail('fan@mailinator.com'), true);
  assert.equal(isThrowawayEmail('fan@mx.mailinator.com'), true, 'a subdomain of a throwaway service counts');
  assert.equal(isThrowawayEmail('fan@gmail.com'), false);
  assert.equal(isThrowawayEmail('fan@outlook.sa'), false);
  assert.equal(isThrowawayEmail('no-at-sign'), true, 'not an address at all is not a gift address');
}

// ------------------------------------------------ 4. the store's promises ---
async function storePromises(label: string, repo: ProRepository, userA: string, userB: string): Promise<void> {
  const svc = new ProService(repo, { savedDesigns: async () => 1, env: { PRO_MODE: 'on' } as NodeJS.ProcessEnv });
  // One at a time: 3 Polishes a week, then no.
  for (let i = 1; i <= 3; i++) {
    const t = await svc.take(userA, 'polish', 'free');
    assert.equal(t.ok, true, `${label}: Polish ${i} of 3`);
    assert.equal(t.allowance.remaining, 3 - i);
  }
  const fourth = await svc.take(userA, 'polish', 'free');
  assert.equal(fourth.ok, false, `${label}: a 4th Polish in the week is refused`);
  assert.equal(fourth.ticket.n, 0, `${label}: a refusal takes nothing`);
  // A refund gives exactly one back.
  const again = await svc.take(userA, 'std', 'free');
  await svc.giveBack(userA, again.ticket);
  assert.equal((await svc.allowance(userA, 'std', 'free')).used, 0, `${label}: a refunded use is not counted`);
  await svc.giveBack(userA, again.ticket);
  assert.equal((await svc.allowance(userA, 'std', 'free')).used, 0, `${label}: a refund never goes below 0`);
  // All at once: 12 racing for 3 get exactly 3.
  const racing = await Promise.all(Array.from({ length: 12 }, () => svc.take(userB, 'polish', 'free')));
  assert.equal(racing.filter((r) => r.ok).length, 3, `${label}: twelve at once still get exactly 3`);
  // Free's month: 40 designs used, the day still has room, and nothing more.
  const monthKey = periodKey('month', new Date());
  const dayKey = periodKey('day', new Date());
  await repo.take(userB, 'std', [{ key: monthKey, limit: 40 }], 40);
  const freeMonth = await svc.take(userB, 'std', 'free');
  assert.equal(freeMonth.ok, false, `${label}: a free month of 40 designs refuses the 41st, even with the day free`);
  assert.equal(freeMonth.allowance.period, 'month', `${label}: and says it is the month`);
  assert.equal(freeMonth.allowance.resetAt, periodEnd('month', new Date()).toISOString(), `${label}: back on the 1st, Riyadh time`);
  assert.deepEqual(await repo.used(userB, 'std', [dayKey]), [0], `${label}: the day was not touched`);
  // The gift: offered once, accepted once, and never lapsing.
  assert.equal(await repo.gift(userA), null);
  const offered = await repo.offerGift(userA, new Date());
  const offeredAgain = await repo.offerGift(userA, new Date(Date.now() + 9 * 86_400_000));
  assert.equal(offeredAgain.offeredAt, offered.offeredAt, `${label}: a second offer changes nothing`);
  assert.equal('claimBy' in offered, false, `${label}: an offer has no claim-by date`);
  const accepts = await Promise.all(Array.from({ length: 6 }, () => repo.acceptGift(userA, new Date(), 7)));
  assert.equal(accepts.filter((a) => a.ok).length, 1, `${label}: six Accepts at once make one pass`);
  assert.equal((await repo.activePasses(userA, new Date())).filter((p) => p.plan === 'gift').length, 1, `${label}: one gift pass`);
  assert.deepEqual(await repo.acceptGift(userA, new Date(), 7), { ok: false, reason: 'used' });
  // Offered two years ago and only started now: still the whole 7 days.
  await repo.offerGift(userB, new Date(Date.now() - 730 * 86_400_000));
  const late = await repo.acceptGift(userB, new Date(), 7);
  assert.equal(late.ok, true, `${label}: a gift waits for its holder, however long`);
  // Supporters are paid passes only.
  const sup0 = await repo.supporters([userA, userB], new Date());
  assert.equal(sup0.size, 0, `${label}: a gift is not the Supporter crown`);
  const month = await repo.grantPass({ userId: userB, plan: 'monthly', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 30 * 86_400_000), source: 'admin', createdBy: null });
  assert.deepEqual([...(await repo.supporters([userA, userB], new Date()))], [userB], `${label}: a month of Pro is`);
  const held = await svc.plan(userB);
  assert.equal(held.plan, 'monthly', `${label}: the paid month wins over the gift`);
  assert.equal(held.pass?.id, month.id);
  // Pro's month is the pass's own: all-or-nothing with the day, and keyed by the pass.
  const cycle = cycleOf(month, new Date());
  await repo.take(userB, 'cutout', [{ key: cycle.key, limit: 15 }], 15);
  const both = await svc.take(userB, 'cutout', held);
  assert.equal(both.ok, false, `${label}: a full month of Pro refuses even with the day free`);
  assert.equal(both.allowance.period, 'month', `${label}: the binding window is the month`);
  assert.equal(both.allowance.resetAt, cycle.end.toISOString(), `${label}: back when the pass's 30 days are up`);
  assert.deepEqual(await repo.used(userB, 'cutout', [dayKey]), [0], `${label}: and the day was not touched`);
  const giftHeld = { plan: 'gift' as const, pass: (await repo.activePasses(userB, new Date())).find((p) => p.plan === 'gift')! };
  assert.equal((await svc.take(userB, 'cutout', giftHeld)).ok, true, `${label}: another pass is another month`);
  assert.equal(await repo.revokePass(month.id, new Date()), true);
  assert.equal(await repo.revokePass(month.id, new Date()), false, `${label}: a pass is revoked once`);
  assert.equal((await svc.plan(userB)).plan, 'gift', `${label}: a revoked month gives nothing; the gift is left`);
  // "Tell me": once each.
  assert.equal(await repo.notify(userA), true);
  assert.equal(await repo.notify(userA), false);
  const st = await repo.stats(new Date());
  assert.equal(st.notify, 1);
  assert.equal(st.gifts.accepted, 2);

  // The price question: one answer per voter, replaced when they answer again;
  // a browser's answer becomes the account's; past the ceiling, nobody new.
  const key = (c: string) => `${c}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(30, c).slice(0, 30);
  const browser = deviceVoter(key('b'));
  const other = deviceVoter(key('c'));
  const mine = accountVoter(userA);
  const put = (voter: string, userId: string | null, amount: number, max = 100_000, absorb: string | null = null) =>
    repo.putPriceAnswer({ voter, userId, amount, currency: userId ? 'USD' : 'SAR', lang: userId ? 'en' : 'ar', comment: userId ? null : 'store-test', absorb, max });
  assert.equal(await put(browser, null, 12.5), 'saved');
  const first = await repo.priceAnswer(browser);
  assert.deepEqual(first && { amount: first.amount, currency: first.currency, lang: first.lang, comment: first.comment }, { amount: 12.5, currency: 'SAR', lang: 'ar', comment: 'store-test' }, `${label}: kept as given`);
  assert.equal(await put(browser, null, 15), 'saved');
  assert.equal((await repo.priceAnswer(browser))?.amount, 15, `${label}: a second answer replaces the first`);
  assert.equal(await put(mine, userA, 20, 100_000, browser), 'saved');
  assert.equal(await repo.priceAnswer(browser), null, `${label}: the browser's answer is taken over by the account`);
  const taken = await repo.priceAnswer(mine);
  assert.equal(taken?.amount, 20);
  assert.equal(taken?.createdAt, first?.createdAt, `${label}: and keeps when it was first given`);
  const total = (await repo.priceAnswers(1)).all.length;
  assert.equal(await put(other, null, 9, total), 'full', `${label}: at the ceiling a new voter is turned away`);
  assert.equal(await repo.priceAnswer(other), null);
  assert.equal(await put(mine, userA, 25, total), 'saved', `${label}: but anyone already in may change their answer`);
  const listed = await repo.priceAnswers(5);
  assert.equal(listed.newest[0].amount, 25, `${label}: newest first`);
  assert.ok(listed.all.some((a) => a.amount === 25 && a.currency === 'USD' && a.account), `${label}: every answer is counted, with whether an account gave it`);
}

await storePromises('memory', new MemoryProRepository(), 'mem-user-a', 'mem-user-b');

// ---------------------------------------------- 4b. the price question's rules ---
{
  const ok = (b: unknown) => readPriceInput(b);
  const base = { amount: 15, currency: 'SAR', lang: 'ar', device: 'k'.repeat(24) };
  assert.equal(ok(base).ok, true);
  assert.equal(ok({ ...base, device: undefined }).ok, true, 'the key is the route\'s business: signed in needs none');
  for (const bad of [
    null, 'x', {}, { ...base, amount: -0.01 }, { ...base, amount: 999.01 }, { ...base, amount: '15' }, { ...base, amount: Infinity },
    { ...base, currency: 'EUR' }, { ...base, currency: 'sar' }, { ...base, lang: 'fr' }, { ...base, lang: undefined },
    { ...base, comment: 7 }, { ...base, comment: 'x'.repeat(201) }, { ...base, device: 'short' }, { ...base, device: '../../etc/passwd/../..' }, { ...base, device: 12 },
  ]) assert.equal(ok(bad).ok, false, `refused: ${JSON.stringify(bad)?.slice(0, 80)}`);
  const r = ok({ ...base, amount: 14.999 });
  assert.equal(r.ok && r.input.amount, 15, 'rounded to two places');
  assert.equal(ok({ ...base, amount: 0 }).ok, true, '"nothing" is an answer');
  assert.equal(ok({ ...base, amount: 999 }).ok, true);
  // The comment: one clean line, no hidden direction marks, 200 characters at most (counted as characters, not UTF-16 units).
  assert.deepEqual(cleanComment('  غالي\u202e شوي \n\t\u0000 جداً '), { ok: true, comment: 'غالي شوي جداً' });
  assert.deepEqual(cleanComment('   '), { ok: true, comment: null }, 'blank is no comment');
  assert.deepEqual(cleanComment('⚽'.repeat(200)), { ok: true, comment: '⚽'.repeat(200) }, '200 emoji fit, though each is two UTF-16 units');
  assert.equal(cleanComment('⚽'.repeat(201)).ok, false);
  // Voters: an account by its id, a browser only by its key's hash.
  assert.equal(accountVoter('abc'), 'u:abc');
  assert.match(deviceVoter('k'.repeat(24)), /^d:[0-9a-f]{64}$/);
  assert.ok(!deviceVoter('k'.repeat(24)).includes('kkkk'), 'the key itself is never kept');
  // The summary: the median and quartiles as Postgres's percentile_cont, bands per currency.
  const sum = summarize([
    { amount: 0, currency: 'SAR', account: false }, { amount: 10, currency: 'SAR', account: true }, { amount: 15, currency: 'SAR', account: true },
    { amount: 20, currency: 'SAR', account: false }, { amount: 999, currency: 'SAR', account: false }, { amount: 4, currency: 'USD', account: false },
  ]);
  assert.deepEqual([sum.SAR.n, sum.SAR.accounts, sum.SAR.median, sum.SAR.p25, sum.SAR.p75, sum.SAR.min, sum.SAR.max, sum.SAR.accountsMedian], [5, 2, 15, 10, 20, 0, 999, 12.5]);
  assert.equal(sum.SAR.mean, 208.8);
  // Bands for SAR: 0 | under 5 | 5-10 | 10-15 | 15-20 | 20-30 | 30-50 | 50+
  assert.deepEqual(sum.SAR.bands, [1, 0, 0, 1, 1, 1, 0, 1]);
  assert.deepEqual([sum.USD.n, sum.USD.median, sum.USD.accountsMedian], [1, 4, null]);
  // USD: 0 | under 1 | 1-2 | 2-3 | 3-5 | 5-10 | 10-20 | 20+
  assert.deepEqual(sum.USD.bands, [0, 0, 0, 0, 1, 0, 0, 0]);
  // The signed-out pace: per address, per Riyadh day.
  const pace = new GuestPace(2);
  const day = new Date('2026-11-08T10:00:00Z');
  assert.equal(pace.take('1.1.1.1', day), true);
  assert.equal(pace.take('1.1.1.1', day), true);
  assert.equal(pace.take('1.1.1.1', day), false, 'the third new answer from one address in a day is refused');
  assert.equal(pace.take('2.2.2.2', day), true, 'another address is its own');
  assert.equal(pace.take('1.1.1.1', new Date('2026-11-08T21:00:00Z')), true, 'a new day in Riyadh starts at 21:00 UTC');
}

// ------------------------------------------------ 5. the routes, end to end ---
const restoreBase = setEnv({ PRO_MODE: undefined, PRO_PREVIEW_USERS: undefined, AI_CLOUDFLARE_ACCOUNT_ID: undefined, AI_CLOUDFLARE_API_TOKEN: undefined, AI_CUTOUT: undefined });
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const proRepo = new MemoryProRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, {
    social, leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
    aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
    pro: proRepo, adminUsernames: ['boss_pro'], aiAdminPassword: 'pro admin password',
  });
  const fan = await reg(app, 'fan_pro');
  await auth.markEmailVerified(fan.id);
  await makeDesign(app, fan.token, true);
  const other = await reg(app, 'other_pro');
  await auth.markEmailVerified(other.id);
  await makeDesign(app, other.token);
  const unverified = await reg(app, 'unverified_pro');
  await makeDesign(app, unverified.token);
  const throwaway = await reg(app, 'throwaway_pro', 'someone@mailinator.com');
  await auth.markEmailVerified(throwaway.id);
  await makeDesign(app, throwaway.token);
  const noDesign = await reg(app, 'nodesign_pro');
  await auth.markEmailVerified(noDesign.id);
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'pro admin password' } })).json().token as string;

  const get = (token?: string) => app.inject({ method: 'GET', url: '/api/pro', ...(token ? { headers: bearer(token) } : {}) });

  // Off: Pro is not on for anyone, so everyone sees the coming-soon plans:
  // the allowances, and no price.
  const soonOut = (await get()).json() as Record<string, any>;
  assert.deepEqual(Object.keys(soonOut).sort(), ['live', 'signedIn', 'soon']);
  assert.equal(soonOut.live, false);
  assert.deepEqual(soonOut.soon.limits.free.std, FREE_WINDOWS.std, 'the free plan the server applies');
  assert.deepEqual(soonOut.soon.limits.pro.cutout, [{ period: 'day', limit: 5 }, { period: 'month', limit: 15 }]);
  assert.deepEqual(soonOut.soon.gift, { days: 7 });
  assert.ok(!/price|SAR|paymentsOpen/.test(JSON.stringify(soonOut)), 'no price anywhere');
  assert.deepEqual((await get(fan.token)).json(), { live: false, signedIn: true, soon: soonOut.soon, notified: false }, 'off: the same plans, and whether they asked to be told');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token) })).statusCode, 404, 'off: the gift route is not there');
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/cutout', headers: bearer(fan.token), payload: { image: pngUrl() } })).statusCode, 404, 'off: the cut-out is not there');

  // Preview: only the named account.
  let restore = setEnv({ PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'fan_pro,unverified_pro,throwaway_pro,nodesign_pro' });
  assert.deepEqual((await get()).json(), { live: false, signedIn: false, soon: soonOut.soon }, 'preview: signed out sees the coming-soon plans');
  assert.deepEqual((await get(other.token)).json(), { live: false, signedIn: true, soon: soonOut.soon, notified: false }, 'preview: an account not on the list sees the same, nothing about the preview');
  const mine = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(mine.live, true);
  assert.equal(mine.plan, 'free');
  assert.equal(mine.allowances.super, undefined, 'no Super allowance');
  assert.equal(mine.allowances.std.limit, 10);
  assert.equal(mine.allowances.std.period, 'day');
  assert.equal(mine.gift.state, 'offered', 'a verified account with a saved design is offered the gift');
  assert.equal(mine.gift.claimBy, undefined, 'and it has no date to claim it by');
  assert.equal(mine.offer.paymentsOpen, false);
  assert.deepEqual(mine.offer.monthly, { price: 19, days: 30 });
  assert.equal(mine.offer.season, undefined, 'one plan: no Season Pass');
  assert.equal(mine.offer.match, undefined, 'and no Match Pass');
  // The Pro page's table comes from the same settings the server enforces.
  assert.deepEqual(mine.offer.limits.free.std, FREE_WINDOWS.std, 'the page shows the free plan the server applies');
  assert.deepEqual(mine.offer.limits.pro.cutout, [{ period: 'day', limit: 5 }, { period: 'month', limit: 15 }], "a pass's own month reads as a month");
  assert.deepEqual(mine.offer.limits.pro.std, AI_ON_PRO ? [{ period: 'day', limit: 15 }, { period: 'month', limit: 70 }] : FREE_WINDOWS.std, 'designs: what the plan gives');
  assert.deepEqual(Object.keys(mine.offer.limits), ['free', 'pro'], 'two columns: Free against Pro');
  assert.deepEqual(mine.soon, soonOut.soon, 'the coming-soon plans are the same for an account in the preview');
  assert.equal((await get(unverified.token)).json().gift.state, 'none', 'an unverified email gets no gift');
  assert.equal((await get(throwaway.token)).json().gift.state, 'none', 'a throwaway address gets no gift');
  assert.equal((await get(noDesign.token)).json().gift.state, 'none', 'no saved design yet, no gift yet');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(unverified.token) })).statusCode, 403, 'unverified cannot accept');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(throwaway.token) })).statusCode, 409, 'a throwaway address cannot accept');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(other.token) })).statusCode, 404, 'outside the preview, there is no gift');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept' })).statusCode, 401, 'signed out cannot accept');

  // Nothing the browser sends changes a plan or a limit.
  const forged = await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token), payload: { days: 365, plan: 'monthly', endsAt: '2099-01-01' } });
  assert.equal(forged.statusCode, 200);
  const endsAt = Date.parse((forged.json() as { endsAt: string }).endsAt);
  assert.ok(Math.abs(endsAt - (Date.now() + 7 * 86_400_000)) < 60_000, 'the gift is 7 days from now, whatever was asked for');
  const after = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(after.plan, 'gift');
  assert.equal(after.gift.state, 'active');
  assert.equal(after.allowances.std.limit, AI_ON_PRO ? 15 : 10, "the gift has Pro's ceilings");
  assert.equal(after.allowances.cutout.limit, 5);
  assert.equal(after.supporter, false, 'a gift does not carry the Supporter crown');
  const twice = await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token) });
  assert.equal(twice.statusCode, 409, 'the gift is accepted once');
  assert.equal((twice.json() as { reason: string }).reason, 'used');

  // Notify: once each, signed in only, any account (the coming-soon page offers it to everyone).
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/notify' })).statusCode, 401);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(fan.token) })).json(), { ok: true, already: false });
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(fan.token) })).json(), { ok: true, already: true });
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(other.token) })).json(), { ok: true, already: false }, 'outside the preview too');
  assert.equal((await get(other.token)).json().notified, true, '…and /api/pro says so');

  // The price question: anyone, signed in or out, one answer each.
  const price = (payload: unknown, headers: Record<string, string> = {}, ip = '10.9.0.1') =>
    app.inject({ method: 'POST', url: '/api/pro/price', headers, payload: payload as object, remoteAddress: ip });
  const priceOf = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/pro/price', headers }).then((r) => r.json());
  const prices = () => app.inject({ method: 'GET', url: '/api/admin/pro/prices', headers: { 'x-ai-unlock': unlock } }).then((r) => r.json() as Record<string, any>);
  const key1 = 'a'.repeat(32);
  assert.equal((await price({ amount: 15, currency: 'SAR', lang: 'ar' })).statusCode, 400, 'signed out, a browser key is needed');
  assert.equal((await price({ amount: 15, currency: 'EUR', lang: 'ar', device: key1 })).statusCode, 400, 'only riyals and dollars');
  assert.equal((await price({ amount: 1e6, currency: 'SAR', lang: 'ar', device: key1 })).statusCode, 400);
  assert.equal((await price('15', { 'content-type': 'text/plain' })).statusCode, 400, 'a form post from another site carries no JSON');
  const g1 = await price({ amount: 14.999, currency: 'SAR', lang: 'ar', comment: '  غالي\u202e شوي \n ', device: key1 });
  assert.equal(g1.statusCode, 200, g1.body);
  assert.deepEqual(g1.json().answer, { amount: 15, currency: 'SAR', comment: 'غالي شوي' }, 'rounded to halalas, the comment one clean line');
  const again = await app.inject({ method: 'GET', url: '/api/pro/price', headers: { 'x-price-device': key1 } });
  assert.deepEqual(again.json(), { answer: { amount: 15, currency: 'SAR', comment: 'غالي شوي' } }, 'the browser sees its answer again');
  assert.equal(again.headers['cache-control'], 'no-store');
  assert.deepEqual(await priceOf({}), { answer: null }, 'no key, no answer');
  assert.deepEqual(await priceOf({ 'x-price-device': 'b'.repeat(32) }), { answer: null }, "another browser sees nothing of this one's");
  await price({ amount: 10, currency: 'USD', lang: 'en', device: key1 });
  let seen = await prices();
  assert.equal(seen.total, 1, 'answering again replaces the first');
  assert.deepEqual({ ...seen.rows[0], at: undefined }, { at: undefined, amount: 10, currency: 'USD', lang: 'en', username: null, comment: null });
  // Signing in: the account answers, and this browser's answer becomes the account's.
  const acct = await price({ amount: 19, currency: 'SAR', lang: 'ar', device: key1 }, bearer(other.token));
  assert.equal(acct.statusCode, 200);
  seen = await prices();
  assert.equal(seen.total, 1, 'one answer, not two');
  assert.equal(seen.rows[0].username, 'other_pro', 'named by its account');
  assert.equal(seen.rows[0].amount, 19);
  assert.deepEqual(await priceOf(bearer(other.token)), { answer: { amount: 19, currency: 'SAR', comment: null } });
  // Another account, no browser key; "nothing" and a formula-shaped comment are just answers.
  assert.equal((await price({ amount: 0, currency: 'USD', lang: 'en', comment: '=HYPERLINK("http://x")' }, bearer(fan.token))).statusCode, 200);
  seen = await prices();
  assert.equal(seen.total, 2);
  assert.deepEqual([seen.summary.SAR.n, seen.summary.SAR.accounts, seen.summary.SAR.median, seen.summary.USD.n, seen.summary.USD.median], [1, 1, 19, 1, 0]);
  assert.equal(seen.rows[0].comment, '=HYPERLINK("http://x")', 'kept as typed: /admin escapes it and the CSV disarms it');
  assert.deepEqual(seen.bands, { SAR: [5, 10, 15, 20, 30, 50], USD: [1, 2, 3, 5, 10, 20] });
  // Only the admin reads them.
  for (const headers of [undefined, bearer(fan.token)]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro/prices', ...(headers ? { headers } : {}) })).statusCode, 403);
  }
  // Signed out, new answers from one address are paced by the day; changing one's own is not.
  const keyN = (i: number) => `p${String(i).padStart(31, '0')}`;
  for (let i = 0; i < GUEST_NEW_PER_DAY; i++) assert.equal((await price({ amount: 5, currency: 'SAR', lang: 'ar', device: keyN(i) }, {}, '10.9.0.77')).statusCode, 200, `new answer ${i + 1}`);
  const paced = await price({ amount: 5, currency: 'SAR', lang: 'ar', device: keyN(99) }, {}, '10.9.0.77');
  assert.equal(paced.statusCode, 429, 'one more new browser from the same address today is refused');
  assert.equal(paced.json().reason, 'pace');
  assert.equal((await price({ amount: 6, currency: 'SAR', lang: 'ar', device: keyN(0) }, {}, '10.9.0.77')).statusCode, 200, 'changing an answer already given still works');
  assert.equal((await price({ amount: 6, currency: 'SAR', lang: 'ar', device: keyN(99) }, {}, '10.9.0.78')).statusCode, 200, 'another address is its own');
  // The account's own copy of its data has its answer.
  const exported = (await app.inject({ method: 'GET', url: '/api/account/export', headers: bearer(other.token) })).json() as Record<string, any>;
  assert.deepEqual({ ...exported.pro.priceAnswer, at: undefined }, { amount: 19, currency: 'SAR', comment: null, at: undefined });

  // Admin: closed to everyone else, validated, audited.
  for (const headers of [undefined, bearer(fan.token)]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro', ...(headers ? { headers } : {}) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/grant', ...(headers ? { headers } : {}), payload: { username: 'fan_pro', plan: 'monthly' } })).statusCode, 403, 'nobody grants themselves Pro');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/revoke', ...(headers ? { headers } : {}), payload: { passId: '00000000-0000-0000-0000-000000000000' } })).statusCode, 403);
  }
  const asBoss = { 'x-ai-unlock': unlock };
  const bad = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/api/admin/pro/grant', headers: asBoss, payload: payload as object })).statusCode;
  assert.equal(await bad({ username: 'fan_pro', plan: 'gift' }), 400, 'a gift is accepted, never granted');
  assert.equal(await bad({ username: 'fan_pro', plan: 'platinum' }), 400);
  for (const old of ['season', 'match', 'group']) assert.equal(await bad({ username: 'fan_pro', plan: old }), 400, `the old ${old} plan is gone`);
  assert.equal(await bad({ username: 'fan_pro', plan: 'monthly', days: 0 }), 400);
  assert.equal(await bad({ username: 'fan_pro', plan: 'monthly', days: 9999 }), 400);
  assert.equal(await bad({ username: 'fan_pro', plan: 'monthly', days: 2.5 }), 400);
  assert.equal(await bad({ username: "'; drop table--", plan: 'monthly' }), 400);
  assert.equal(await bad({ username: 'nobody_here', plan: 'monthly' }), 404);
  const granted = await app.inject({ method: 'POST', url: '/api/admin/pro/grant', headers: asBoss, payload: { username: 'fan_pro', plan: 'monthly' } });
  assert.equal(granted.statusCode, 200);
  const grantedEnds = Date.parse((granted.json() as { pass: { endsAt: string } }).pass.endsAt);
  assert.ok(Math.abs(grantedEnds - (Date.now() + 30 * 86_400_000)) < 60_000, 'a month of Pro without days is 30 days');
  const fanNow = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(fanNow.plan, 'monthly', 'the paid month wins over the gift');
  assert.equal(fanNow.supporter, true);
  assert.equal(fanNow.allowances.std.limit, AI_ON_PRO ? 15 : 10);
  const look = (await app.inject({ method: 'GET', url: '/api/admin/pro?username=fan_pro', headers: asBoss })).json() as Record<string, any>;
  assert.equal(look.mode, 'preview');
  assert.equal(look.account.passes.length, 2);
  assert.equal(look.throwawayList.loaded, true);

  // The Supporter crown: in the community for previewing viewers only.
  const gallery = async (token?: string) => (await app.inject({ method: 'GET', url: '/api/gallery', ...(token ? { headers: bearer(token) } : {}) })).json() as Array<Record<string, unknown>>;
  const fanCard = (items: Array<Record<string, unknown>>) => items.find((i) => i.ownerId === fan.id);
  assert.equal(fanCard(await gallery(fan.token))?.ownerSupporter, true, 'a previewing viewer sees the crown');
  assert.equal(fanCard(await gallery(other.token))?.ownerSupporter, undefined, 'nobody else does during the preview');
  assert.equal(fanCard(await gallery())?.ownerSupporter, undefined);
  const profile = (await app.inject({ method: 'GET', url: `/api/users/${fan.id}/profile`, headers: bearer(other.token) })).json() as Record<string, unknown>;
  assert.equal(profile.supporter, false);

  // The account's data export includes its passes and gift.
  const exp = (await app.inject({ method: 'GET', url: '/api/account/export', headers: bearer(fan.token) })).json() as Record<string, any>;
  assert.equal(exp.pro.passes.length, 2);
  assert.ok(exp.pro.gift?.acceptedAt);

  // Revoke.
  const seasonId = look.account.passes.find((p: { plan: string }) => p.plan === 'monthly').id as string;
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/revoke', headers: asBoss, payload: { passId: 'not-a-uuid' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/revoke', headers: asBoss, payload: { passId: seasonId } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/revoke', headers: asBoss, payload: { passId: seasonId } })).statusCode, 404);
  assert.equal(((await get(fan.token)).json() as Record<string, unknown>).plan, 'gift');
  restore();

  // On: signed out sees the offer, never anyone's data; everyone gets the rules.
  restore = setEnv({ PRO_MODE: 'on' });
  const anon = (await get()).json() as Record<string, any>;
  assert.equal(anon.live, true);
  assert.equal(anon.signedIn, false);
  assert.equal(anon.allowances, undefined);
  assert.equal(anon.offer.monthly.price, 19);
  assert.equal(((await get(other.token)).json() as Record<string, unknown>).live, true);
  assert.equal(fanCard(await gallery())?.ownerSupporter, undefined, 'the crown follows the pass: none now');
  restore();
}

// ---------------------------------------- 6. the AI routes on the allowances ---
{
  const realFetch = globalThis.fetch;
  const restore = setEnv({ PRO_MODE: 'on', GEMINI_API_KEY: 'AIzaSyTESTKEY0000000000', AI_PROVIDER: 'gemini', AI_RETRY_DELAY_MS: '50', ANTHROPIC_API_KEY: undefined });
  let providerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('generativelanguage.googleapis.com')) {
      providerCalls++;
      return new Response('{ "error": { "code": 503, "message": "busy", "status": "UNAVAILABLE" } }', { status: 503 });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const proRepo = new MemoryProRepository();
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)), pro: proRepo,
    });
    const fan = await reg(app, 'fan_ai_pro');
    await auth.markEmailVerified(fan.id);
    const gen = (mode: 'super' | 'std') => app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: `red and white stripes ${Math.random()}`, mode } });

    // The quota route speaks the new allowances.
    const q = (await app.inject({ method: 'GET', url: '/api/ai/quota', headers: bearer(fan.token) })).json() as Record<string, any>;
    assert.equal(q.live, true);
    assert.equal(q.allowances.std.limit, 10);
    assert.equal(q.allowances.std.period, 'day');
    assert.equal(q.allowances.super, undefined, 'no Super allowance');

    // A busy model gives the use back.
    const busy = await gen('super');
    assert.equal(busy.json().reason, 'busy');
    assert.ok(providerCalls > 0, 'the model was asked');
    assert.equal((await proRepo.used(fan.id, 'std', [periodKey('day', new Date())]))[0], 0, 'a design that did not come is not counted');
    assert.equal((await proRepo.used(fan.id, 'super' as never, [periodKey('week', new Date())]))[0], 0, 'and mode: "super" spends no allowance of its own');

    // Used up: refused before any model is asked, with what the card needs.
    await proRepo.take(fan.id, 'std', [{ key: periodKey('day', new Date()), limit: 10 }], 10);
    const before = providerCalls;
    const out = (await gen('std')).json() as Record<string, any>;
    assert.equal(out.needsChoice, true);
    assert.equal(out.reason, 'quota');
    assert.equal(out.kind, 'std');
    assert.equal(out.quota.remaining, 0);
    assert.equal(out.quota.period, 'day');
    assert.ok(Date.parse(out.quota.resetAt) > Date.now(), 'and when it comes back');
    assert.equal(providerCalls, before, 'no model call for a used-up allowance');
    // Asking for "super" is no way round it: it is the same allowance.
    const sup = (await gen('super')).json() as Record<string, any>;
    assert.equal(sup.reason, 'quota', 'mode: "super" is metered as a design like any other');
    assert.equal(sup.kind, 'std');
    assert.equal(providerCalls, before);

    // Polish: one that fails (the model is busy) is handed back, and the
    // editor is told the count as it stands.
    const spec = { palette: ['#000000', '#ffffff'], layers: [{ id: 'L0', kind: 'fill', region: 'all', colorIndex: 1 }] };
    const failedPolish = (await app.inject({ method: 'POST', url: '/api/ai/critique', headers: bearer(fan.token), payload: { spec } })).json() as Record<string, any>;
    assert.ok(failedPolish.cause, 'the busy model is reported');
    assert.equal(failedPolish.quota?.remaining, 3, 'the editor is told the Polish came back');
    assert.equal((await proRepo.used(fan.id, 'polish', [periodKey('week', new Date())]))[0], 0, 'a failed Polish is not counted');
    // A used-up allowance answers quota and leaves the design alone.
    await proRepo.take(fan.id, 'polish', [{ key: periodKey('week', new Date()), limit: 3 }], 3);
    const pol = await app.inject({ method: 'POST', url: '/api/ai/critique', headers: bearer(fan.token), payload: { spec } });
    assert.equal(pol.statusCode, 200, pol.body);
    assert.equal((pol.json() as Record<string, unknown>).reason, 'quota', 'Polish used up');
    assert.equal((pol.json() as Record<string, any>).quota.kind, 'polish');
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
}

// ------------------------------------- 6b. a stadium photo of no ground ---
{
  // pq-photo: a photo the readings call "no ground" (a dressing room, a pub)
  // delivers nothing and is not counted; a photo of a ground is.
  const realFetch = globalThis.fetch;
  const restore = setEnv({ PRO_MODE: 'on', GEMINI_API_KEY: 'AIzaSyTESTKEY0000000000', AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: undefined });
  let reply: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const proRepo = new MemoryProRepository();
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)), pro: proRepo,
    });
    const fan = await reg(app, 'fan_photo_pro');
    await auth.markEmailVerified(fan.id);
    const image = 'data:image/jpeg;base64,' + Buffer.alloc(600, 7).toString('base64');
    const read = () => app.inject({ method: 'POST', url: '/api/stadium/photo', headers: bearer(fan.token), payload: { image } });
    const used = async () => (await proRepo.used(fan.id, 'photo', [periodKey('week', new Date())]))[0];

    reply = { view: 'none', tiers: { value: 2, sure: 'high' }, seats: { value: ['#c8102e'], sure: 'high' } };
    const pub = await read();
    assert.equal(pub.statusCode, 200, pub.body);
    const p = pub.json() as Record<string, any>;
    assert.equal(p.noGround, true, 'the browser is told the photo shows no ground');
    assert.deepEqual(p.known, {}, 'and nothing from it is used');
    assert.equal(await used(), 0, 'and it is not counted');

    reply = { view: 'bowl', tiers: { value: 2, sure: 'high' }, sides: { value: 'straight', sure: 'medium' }, seats: { value: ['#c8102e'], sure: 'high' } };
    const ground = (await read()).json() as Record<string, any>;
    assert.equal(ground.noGround, false);
    assert.equal(ground.known.tiers, 2);
    assert.equal(ground.known.shape, 'square', 'straight sides reach the browser');
    assert.deepEqual(ground.known.seatColours, ['#c8102e'], 'and so does the seats\' colour');
    assert.equal(await used(), 1, 'a photo of a ground is counted');
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
}

// -------------------------------------------------------- 7. the cut-out ---
{
  // The download rules, directly.
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('172.20.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true, 'the cloud metadata address');
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.0.1'), true);
  assert.equal(isPrivateAddress('104.16.1.1'), false);
  assert.equal(hostAllowed('examples.aig.cloudflare.com'), true);
  assert.equal(hostAllowed('cloudflare.com.evil.test'), false, 'a suffix is not a match');
  assert.equal(hostAllowed('evilcloudflare.com'), false);

  const publicDns = async () => [{ address: '104.16.1.1', family: 4 }];
  const privateDns = async () => [{ address: '10.0.0.5', family: 4 }];
  let fetched = 0;
  const okFetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    fetched++;
    assert.equal(init?.redirect, 'error', 'redirects are never followed');
    return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  assert.equal((await fetchResult('http://examples.aig.cloudflare.com/x.png', okFetch, publicDns)).ok, false, 'plain http is refused');
  assert.equal((await fetchResult('https://169.254.169.254/latest', okFetch, publicDns)).ok, false, 'an IP address is refused');
  assert.equal((await fetchResult('https://evil.test/x.png', okFetch, publicDns)).ok, false, 'a host off the list is refused');
  assert.equal((await fetchResult('https://user:pw@examples.aig.cloudflare.com/x.png', okFetch, publicDns)).ok, false);
  assert.equal((await fetchResult('https://examples.aig.cloudflare.com:8443/x.png', okFetch, publicDns)).ok, false, 'another port is refused');
  assert.equal((await fetchResult('https://examples.aig.cloudflare.com/x.png', okFetch, privateDns)).ok, false, 'a name that resolves privately is refused');
  assert.equal(fetched, 0, 'none of those were fetched');
  const good = await fetchResult('https://examples.aig.cloudflare.com/x.png', okFetch, publicDns);
  assert.equal(good.ok, true);
  const notPng = await fetchResult('https://examples.aig.cloudflare.com/x.png', (async () => new Response('<html>hi</html>', { status: 200 })) as typeof fetch, publicDns);
  assert.equal(notPng.ok, false, 'only a PNG is kept');
  const huge = await fetchResult('https://examples.aig.cloudflare.com/x.png', (async () => new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })) as typeof fetch, publicDns);
  assert.equal(huge.ok, false, 'a result larger than allowed is not read');

  // Through the route.
  const realFetch = globalThis.fetch;
  let mode: 'ok' | 'fail' | 'evil' | 'gateway' = 'ok';
  let sent = '';
  let lastBody = '';
  let calls = 0;
  const restore = setEnv({ PRO_MODE: 'on', AI_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), AI_CLOUDFLARE_API_TOKEN: 'test-token', AI_CUTOUT: undefined });
  useLookupForTests(publicDns);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.cloudflare.com/')) {
      calls++;
      lastBody = String(init?.body ?? '');
      if (calls === 1) sent = lastBody;
      if (mode === 'fail') return new Response('{"errors":[{"message":"boom"}]}', { status: 500 });
      if (mode === 'gateway' && lastBody.includes('moderation')) {
        return new Response('<html><head><title>api.cloudflare.com | 502: Bad gateway</title></head></html>', { status: 502, headers: { 'cf-ray': '8d00test' } });
      }
      const link = mode === 'evil' ? 'https://metadata.internal.test/latest' : 'https://examples.aig.cloudflare.com/out.png';
      return new Response(JSON.stringify({ result: { state: 'Completed', result: { image: link } } }), { status: 200 });
    }
    if (url.startsWith('https://examples.aig.cloudflare.com/')) return new Response(new Uint8Array(PNG), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const proRepo = new MemoryProRepository();
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)), pro: proRepo,
    });
    const fan = await reg(app, 'fan_cut_pro');
    await auth.markEmailVerified(fan.id);
    const unverified = await reg(app, 'fan_cut_unv');
    const cut = (image: unknown, token = fan.token) => app.inject({ method: 'POST', url: '/api/ai/cutout', headers: bearer(token), payload: { image } });
    const week = () => proRepo.used(fan.id, 'cutout', [periodKey('week', new Date())]).then((u) => u[0]);

    assert.equal((await app.inject({ method: 'POST', url: '/api/ai/cutout', payload: { image: pngUrl() } })).statusCode, 401, 'signed out');
    assert.equal((await cut(pngUrl(), unverified.token)).statusCode, 403, 'unverified');
    assert.equal((await cut('https://evil.test/x.png')).statusCode, 400, 'a link is not a picture');
    assert.equal((await cut('data:image/svg+xml;base64,PHN2Zz4=')).statusCode, 400, 'SVG is refused');
    assert.equal((await cut(`data:image/png;base64,${Buffer.from('<html>not a png</html>').toString('base64')}`)).statusCode, 400, 'the bytes must be what they claim');
    assert.equal(await week(), 0, 'none of those spent anything');

    mode = 'fail';
    calls = 0;
    const failed = await cut(pngUrl());
    // Not 502: Cloudflare in front of the site would put its own page in place of the answer.
    assert.equal(failed.statusCode, 503);
    assert.equal((failed.json() as { reason: string }).reason, 'failed', 'the editor says it did not work, not that it is busy');
    assert.ok(!/boom|cloudflare|bria|token/i.test(failed.body), `the provider's words stay on the server: ${failed.body}`);
    assert.equal(await week(), 0, 'a failed cut-out is given back');
    assert.equal(calls, 2, 'a server error is asked again once, with the image alone');
    assert.ok(!lastBody.includes('moderation') && lastBody.includes('"image":"data:image/png;base64,'), lastBody.slice(0, 120));

    // A gateway's error page instead of JSON, then the image alone works.
    mode = 'gateway';
    calls = 0;
    const healed = await cut(pngUrl());
    assert.equal(healed.statusCode, 200, healed.body);
    assert.equal(calls, 2);
    await proRepo.give(fan.id, 'cutout', [periodKey('week', new Date())], 1);

    mode = 'evil';
    const evil = await cut(pngUrl());
    assert.equal(evil.statusCode, 503, 'a result link off the list is not fetched');
    assert.equal(await week(), 0);

    mode = 'ok';
    calls = 0;
    const done = await cut(pngUrl());
    assert.equal(done.statusCode, 200, done.body);
    const body = done.json() as { image: string; quota: { remaining: number } };
    assert.ok(body.image.startsWith('data:image/png;base64,'));
    assert.equal(body.quota.remaining, 0, 'the free cut-out of the week is used');
    assert.ok(sent.includes('"visual_input_content_moderation":true'), 'moderation is on for the picture sent');
    assert.ok(!sent.includes('test-token'), 'the token goes in a header, never the body');
    const second = await cut(pngUrl());
    assert.equal(second.statusCode, 429, 'one free a week');
    assert.equal((second.json() as { reason: string }).reason, 'quota');

    // Not configured: says so and spends nothing.
    const r2 = setEnv({ AI_CUTOUT: 'off' });
    await proRepo.give(fan.id, 'cutout', [periodKey('week', new Date())], 1);
    assert.equal((await cut(pngUrl())).statusCode, 503);
    assert.equal(await week(), 0);
    r2();
  } finally {
    globalThis.fetch = realFetch;
    useLookupForTests(null);
    restore();
  }
  // cutoutPicture refuses anything but JPEG and PNG before calling anyone.
  const r3 = setEnv({ AI_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), AI_CLOUDFLARE_API_TOKEN: 't' });
  let called = false;
  const res = await cutoutPicture(Buffer.from('GIF89a........'), (async () => { called = true; return new Response('{}'); }) as typeof fetch, publicDns);
  assert.equal(res.ok, false);
  assert.equal(called, false);
  r3();
  // The test-only local model (AI_CUTOUT_LOCAL_URL): loopback http only, never in production.
  assert.equal(localCutoutUrl({ AI_CUTOUT_LOCAL_URL: 'http://127.0.0.1:8971/' } as NodeJS.ProcessEnv), 'http://127.0.0.1:8971/');
  assert.equal(localCutoutUrl({ AI_CUTOUT_LOCAL_URL: 'http://localhost:8971/' } as NodeJS.ProcessEnv), 'http://localhost:8971/');
  for (const bad of ['https://evil.example/', 'http://10.0.0.5:8971/', 'http://u:p@127.0.0.1:8971/', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(localCutoutUrl({ AI_CUTOUT_LOCAL_URL: bad } as NodeJS.ProcessEnv), null, bad);
  }
  assert.equal(localCutoutUrl({ AI_CUTOUT_LOCAL_URL: 'http://127.0.0.1:8971/', NODE_ENV: 'production' } as NodeJS.ProcessEnv), null, 'production ignores it');
  // With it, the same request goes to the local model, with no token, and its inline PNG comes back.
  const r4 = setEnv({ AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_CUTOUT_LOCAL_URL: 'http://127.0.0.1:8971/' });
  assert.equal(cutoutConfigured(), true);
  // A real 2 x 2 RGBA PNG, chunks and CRCs and all.
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
  let seenUrl = '';
  let seenAuth: string | null = 'unset';
  const local = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ success: true, result: { image: `data:image/png;base64,${png.toString('base64')}` } }), { status: 200 });
  }) as typeof fetch;
  const viaLocal = await cutoutPicture(png, local, publicDns);
  assert.equal(viaLocal.ok, true, JSON.stringify(viaLocal));
  assert.equal(seenUrl, 'http://127.0.0.1:8971/');
  assert.equal(seenAuth, null, 'no token is sent to it');
  // A Pro AI design's picture (cutoutForDesign): a data URL in, a PNG data URL out; junk refused before any call.
  const design = await cutoutForDesign(`data:image/png;base64,${png.toString('base64')}`, local, publicDns);
  assert.ok(design.url?.startsWith('data:image/png;base64,'), JSON.stringify(design));
  seenUrl = '';
  assert.equal((await cutoutForDesign('https://example.com/x.png', local, publicDns)).url, null);
  assert.equal(seenUrl, '', 'nothing is called for a picture that is not a data URL');
  r4();
  assert.equal(configWarnings({ NODE_ENV: 'production', AI_CUTOUT_LOCAL_URL: 'http://127.0.0.1:8971/' } as NodeJS.ProcessEnv).some((w) => w.key === 'AI_CUTOUT_LOCAL_URL'), true, 'production says the local model is ignored');
}
restoreBase();

// ------------------------------------------------------------- 8. postgres ---
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const mk = async (name: string) =>
      String((await pool.query(
        `INSERT INTO users (username, password_hash, email) VALUES ($1, 'x', $2)
         ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [name, `${name}@example.test`],
      )).rows[0].id);
    const a = await mk(`pro_pg_a_${Date.now()}`);
    const b = await mk(`pro_pg_b_${Date.now()}`);
    const pgRepo = new PgProRepository(pool);
    await storePromises('postgres', pgRepo, a, b);
    // The admin's list names the account from the users table.
    const named = (await pgRepo.priceAnswers(10)).newest.find((r) => r.amount === 25 && r.currency === 'USD');
    assert.match(named?.username ?? '', /^pro_pg_a_/, 'an answer is named by its account');
    // The table refuses what the routes never send.
    await assert.rejects(pool.query(`INSERT INTO pro_price_answers (voter, amount, currency, lang) VALUES ('x', 1, 'SAR', 'en')`), 'a voter that is neither an account nor a hash');
    await assert.rejects(pool.query(`INSERT INTO pro_price_answers (voter, amount, currency, lang) VALUES ($1, 1000, 'SAR', 'en')`, [`d:${'0'.repeat(64)}`]), 'an amount past 999');
    await assert.rejects(pool.query(`INSERT INTO pro_price_answers (voter, amount, currency, lang) VALUES ($1, 1, 'EUR', 'en')`, [`d:${'0'.repeat(64)}`]), 'another currency');
    await assert.rejects(pool.query(`INSERT INTO pro_price_answers (voter, amount, currency, lang, comment) VALUES ($1, 1, 'SAR', 'en', $2)`, [`d:${'0'.repeat(64)}`, 'x'.repeat(201)]), 'a comment past 200');
    await pool.query(`DELETE FROM pro_price_answers WHERE user_id IS NULL AND comment = 'store-test'`);
    // Deleting an account takes its Pro rows with it.
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b]]);
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM pro_passes WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_gifts WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_allowance WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_notify WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_price_answers WHERE user_id = ANY($1::uuid[])) AS n`,
      [[a, b]],
    );
    assert.equal(Number(left.rows[0].n), 0, 'an erased account leaves no Pro rows');
    console.log('pro.test: postgres store checks passed');
  } finally {
    await pool.end();
  }
} else {
  console.log('pro.test: DATABASE_URL not set; Postgres store checks skipped');
}

console.log('pro.test: all checks passed');
