/**
 * Pro: the plan's periods, the allowances, the 7-day gift, the admin's passes,
 * the AI routes on the new limits and the smart cut-out.
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
import { FREE_WINDOWS, OFFER, PLAN_WINDOWS, liveFor, periodEnd, periodKey, periodStart, proMode } from '../src/proPlan';
import { cutoutPicture, fetchResult, hostAllowed, isPrivateAddress, useLookupForTests } from '../src/cutout';

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
  assert.deepEqual(FREE_WINDOWS.super, [{ period: 'week', limit: 3 }]);
  assert.deepEqual(FREE_WINDOWS.std, [{ period: 'day', limit: 10 }]);
  assert.equal(FREE_WINDOWS.cutout[0].limit, 1);
  assert.deepEqual(PLAN_WINDOWS.season.super, [{ period: 'day', limit: 10 }, { period: 'month', limit: 150 }]);
  assert.equal(OFFER.match.price, 9);
  assert.equal(OFFER.season.price, 99);
  assert.equal(OFFER.gift.days, 7);
  assert.equal(OFFER.paymentsOpen, false, 'no buy button goes anywhere until there is a payment provider');
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
  // One at a time: 3 Super a week, then no.
  for (let i = 1; i <= 3; i++) {
    const t = await svc.take(userA, 'super', 'free');
    assert.equal(t.ok, true, `${label}: Super ${i} of 3`);
    assert.equal(t.allowance.remaining, 3 - i);
  }
  const fourth = await svc.take(userA, 'super', 'free');
  assert.equal(fourth.ok, false, `${label}: a 4th Super in the week is refused`);
  assert.equal(fourth.ticket.n, 0, `${label}: a refusal takes nothing`);
  // A refund gives exactly one back.
  const again = await svc.take(userA, 'std', 'free');
  await svc.giveBack(userA, again.ticket);
  assert.equal((await svc.allowance(userA, 'std', 'free')).used, 0, `${label}: a refunded use is not counted`);
  await svc.giveBack(userA, again.ticket);
  assert.equal((await svc.allowance(userA, 'std', 'free')).used, 0, `${label}: a refund never goes below 0`);
  // All at once: 12 racing for 3 get exactly 3.
  const racing = await Promise.all(Array.from({ length: 12 }, () => svc.take(userB, 'super', 'free')));
  assert.equal(racing.filter((r) => r.ok).length, 3, `${label}: twelve at once still get exactly 3`);
  // Two windows are all-or-nothing: the day has room, the month is full.
  const monthKey = periodKey('month', new Date());
  await repo.take(userB, 'cutout', [{ key: monthKey, limit: 60 }], 60);
  const both = await svc.take(userB, 'cutout', 'season');
  assert.equal(both.ok, false, `${label}: a full month refuses even with the day free`);
  assert.equal((await svc.allowance(userB, 'cutout', 'season')).remaining, 0, `${label}: the binding window is the month`);
  const dayKey = periodKey('day', new Date());
  assert.deepEqual(await repo.used(userB, 'cutout', [dayKey]), [0], `${label}: and the day was not touched`);
  // The gift: offered once, accepted once.
  assert.equal(await repo.gift(userA), null);
  const offered = await repo.offerGift(userA, new Date(Date.now() + 86_400_000), new Date());
  const offeredAgain = await repo.offerGift(userA, new Date(Date.now() + 9 * 86_400_000), new Date());
  assert.equal(offeredAgain.claimBy, offered.claimBy, `${label}: a second offer changes nothing`);
  const accepts = await Promise.all(Array.from({ length: 6 }, () => repo.acceptGift(userA, new Date(), 7)));
  assert.equal(accepts.filter((a) => a.ok).length, 1, `${label}: six Accepts at once make one pass`);
  assert.equal((await repo.activePasses(userA, new Date())).filter((p) => p.plan === 'gift').length, 1, `${label}: one gift pass`);
  assert.deepEqual(await repo.acceptGift(userA, new Date(), 7), { ok: false, reason: 'used' });
  await repo.offerGift(userB, new Date(Date.now() - 1000), new Date(Date.now() - 2000));
  assert.deepEqual(await repo.acceptGift(userB, new Date(), 7), { ok: false, reason: 'expired' }, `${label}: a lapsed gift cannot be taken`);
  // Supporters are paid passes only.
  const sup0 = await repo.supporters([userA, userB], new Date());
  assert.equal(sup0.size, 0, `${label}: a gift is not the Supporter crown`);
  const season = await repo.grantPass({ userId: userB, plan: 'season', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000), source: 'admin', createdBy: null });
  assert.deepEqual([...(await repo.supporters([userA, userB], new Date()))], [userB], `${label}: a season pass is`);
  assert.equal((await svc.plan(userB)).plan, 'season');
  assert.equal(await repo.revokePass(season.id, new Date()), true);
  assert.equal(await repo.revokePass(season.id, new Date()), false, `${label}: a pass is revoked once`);
  assert.equal((await svc.plan(userB)).plan, 'free', `${label}: a revoked pass gives nothing`);
  // "Tell me": once each.
  assert.equal(await repo.notify(userA), true);
  assert.equal(await repo.notify(userA), false);
  const st = await repo.stats(new Date());
  assert.equal(st.notify, 1);
  assert.equal(st.gifts.accepted, 1);
}

await storePromises('memory', new MemoryProRepository(), 'mem-user-a', 'mem-user-b');

// ------------------------------------------------ 5. the routes, end to end ---
const restoreBase = setEnv({ PRO_MODE: undefined, PRO_PREVIEW_USERS: undefined, AI_CLOUDFLARE_ACCOUNT_ID: undefined, AI_CLOUDFLARE_API_TOKEN: undefined, AI_CUTOUT: undefined });
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const proRepo = new MemoryProRepository();
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

  // Off: nothing at all, signed in or out.
  assert.deepEqual((await get()).json(), { live: false, signedIn: false });
  assert.deepEqual((await get(fan.token)).json(), { live: false, signedIn: true }, 'off: not even a hint of Pro');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token) })).statusCode, 404, 'off: the gift route is not there');
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/cutout', headers: bearer(fan.token), payload: { image: pngUrl() } })).statusCode, 404, 'off: the cut-out is not there');

  // Preview: only the named account.
  let restore = setEnv({ PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'fan_pro,unverified_pro,throwaway_pro,nodesign_pro' });
  assert.deepEqual((await get()).json(), { live: false, signedIn: false }, 'preview: signed out sees nothing');
  assert.deepEqual((await get(other.token)).json(), { live: false, signedIn: true }, 'preview: an account not on the list sees nothing');
  const mine = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(mine.live, true);
  assert.equal(mine.plan, 'free');
  assert.equal(mine.allowances.super.limit, 3);
  assert.equal(mine.allowances.std.limit, 10);
  assert.equal(mine.gift.state, 'offered', 'a verified account with a saved design is offered the gift');
  assert.equal(mine.offer.paymentsOpen, false);
  // The Pro page's table comes from the same settings the server enforces.
  assert.deepEqual(mine.offer.limits.free.super, FREE_WINDOWS.super, 'the page shows the free plan the server applies');
  assert.deepEqual(mine.offer.limits.season.super, PLAN_WINDOWS.season.super);
  assert.deepEqual(mine.offer.limits.match.cutout, PLAN_WINDOWS.match.cutout);
  assert.equal((await get(unverified.token)).json().gift.state, 'none', 'an unverified email gets no gift');
  assert.equal((await get(throwaway.token)).json().gift.state, 'none', 'a throwaway address gets no gift');
  assert.equal((await get(noDesign.token)).json().gift.state, 'none', 'no saved design yet, no gift yet');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(unverified.token) })).statusCode, 403, 'unverified cannot accept');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(throwaway.token) })).statusCode, 409, 'a throwaway address cannot accept');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(other.token) })).statusCode, 404, 'outside the preview, there is no gift');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/gift/accept' })).statusCode, 401, 'signed out cannot accept');

  // Nothing the browser sends changes a plan or a limit.
  const forged = await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token), payload: { days: 365, plan: 'season', endsAt: '2099-01-01' } });
  assert.equal(forged.statusCode, 200);
  const endsAt = Date.parse((forged.json() as { endsAt: string }).endsAt);
  assert.ok(Math.abs(endsAt - (Date.now() + 7 * 86_400_000)) < 60_000, 'the gift is 7 days from now, whatever was asked for');
  const after = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(after.plan, 'gift');
  assert.equal(after.gift.state, 'active');
  assert.equal(after.allowances.super.limit, 10, 'the gift has the gift ceilings');
  assert.equal(after.supporter, false, 'a gift does not carry the Supporter crown');
  const twice = await app.inject({ method: 'POST', url: '/api/pro/gift/accept', headers: bearer(fan.token) });
  assert.equal(twice.statusCode, 409, 'the gift is accepted once');
  assert.equal((twice.json() as { reason: string }).reason, 'used');

  // Notify: once each, signed in only.
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/notify' })).statusCode, 401);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(fan.token) })).json(), { ok: true, already: false });
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(fan.token) })).json(), { ok: true, already: true });
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/notify', headers: bearer(other.token) })).statusCode, 404, 'outside the preview, nothing to ask about');

  // Admin: closed to everyone else, validated, audited.
  for (const headers of [undefined, bearer(fan.token)]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro', ...(headers ? { headers } : {}) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/grant', ...(headers ? { headers } : {}), payload: { username: 'fan_pro', plan: 'season' } })).statusCode, 403, 'nobody grants themselves a pass');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/revoke', ...(headers ? { headers } : {}), payload: { passId: '00000000-0000-0000-0000-000000000000' } })).statusCode, 403);
  }
  const asBoss = { 'x-ai-unlock': unlock };
  const bad = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/api/admin/pro/grant', headers: asBoss, payload: payload as object })).statusCode;
  assert.equal(await bad({ username: 'fan_pro', plan: 'gift' }), 400, 'a gift is accepted, never granted');
  assert.equal(await bad({ username: 'fan_pro', plan: 'platinum' }), 400);
  assert.equal(await bad({ username: 'fan_pro', plan: 'season', days: 0 }), 400);
  assert.equal(await bad({ username: 'fan_pro', plan: 'season', days: 9999 }), 400);
  assert.equal(await bad({ username: 'fan_pro', plan: 'season', days: 2.5 }), 400);
  assert.equal(await bad({ username: "'; drop table--", plan: 'season' }), 400);
  assert.equal(await bad({ username: 'nobody_here', plan: 'season' }), 404);
  const granted = await app.inject({ method: 'POST', url: '/api/admin/pro/grant', headers: asBoss, payload: { username: 'fan_pro', plan: 'season' } });
  assert.equal(granted.statusCode, 200);
  assert.equal((granted.json() as { pass: { endsAt: string } }).pass.endsAt, OFFER.season.endsAt, 'a season pass without days runs to the season end');
  const fanNow = (await get(fan.token)).json() as Record<string, any>;
  assert.equal(fanNow.plan, 'season', 'the most generous pass wins');
  assert.equal(fanNow.supporter, true);
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
  const seasonId = look.account.passes.find((p: { plan: string }) => p.plan === 'season').id as string;
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
  assert.equal(anon.offer.season.price, 99);
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
    assert.equal(q.allowances.super.limit, 3);
    assert.equal(q.allowances.super.period, 'week');

    // A busy model gives the use back.
    const busy = await gen('super');
    assert.equal(busy.json().reason, 'busy');
    assert.ok(providerCalls > 0, 'the model was asked');
    assert.equal((await proRepo.used(fan.id, 'super', [periodKey('week', new Date())]))[0], 0, 'a Super that did not come is not counted');

    // Used up: refused before any model is asked, with what the card needs.
    await proRepo.take(fan.id, 'super', [{ key: periodKey('week', new Date()), limit: 3 }], 3);
    const before = providerCalls;
    const out = (await gen('super')).json() as Record<string, any>;
    assert.equal(out.needsChoice, true);
    assert.equal(out.reason, 'quota');
    assert.equal(out.kind, 'super');
    assert.equal(out.quota.remaining, 0);
    assert.equal(out.quota.period, 'week');
    assert.ok(Date.parse(out.quota.resetAt) > Date.now(), 'and when it comes back');
    assert.equal(providerCalls, before, 'no model call for a used-up allowance');
    // Standard is its own allowance.
    const std = (await gen('std')).json() as Record<string, any>;
    assert.notEqual(std.reason, 'quota', 'Super used up does not stop Standard');

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
  let mode: 'ok' | 'fail' | 'evil' = 'ok';
  let sent = '';
  const restore = setEnv({ PRO_MODE: 'on', AI_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), AI_CLOUDFLARE_API_TOKEN: 'test-token', AI_CUTOUT: undefined });
  useLookupForTests(publicDns);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.cloudflare.com/')) {
      sent = String(init?.body ?? '');
      if (mode === 'fail') return new Response('{"errors":[{"message":"boom"}]}', { status: 500 });
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
    const failed = await cut(pngUrl());
    assert.equal(failed.statusCode, 502);
    assert.ok(!/boom|cloudflare|bria|token/i.test(failed.body), `the provider's words stay on the server: ${failed.body}`);
    assert.equal(await week(), 0, 'a failed cut-out is given back');

    mode = 'evil';
    assert.equal((await cut(pngUrl())).statusCode, 502, 'a result link off the list is not fetched');
    assert.equal(await week(), 0);

    mode = 'ok';
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
    await storePromises('postgres', new PgProRepository(pool), a, b);
    // Deleting an account takes its Pro rows with it.
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b]]);
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM pro_passes WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_gifts WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_allowance WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_notify WHERE user_id = ANY($1::uuid[])) AS n`,
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
