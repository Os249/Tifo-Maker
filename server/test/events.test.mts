/**
 * Tifo events (server/src/eventRoutes.ts, tifoEvents.ts, eventRepo.ts): one
 * event walked through every stage with the clock moved, and what a fan might
 * try against it at each one.
 *
 * It reads a draft and a cancelled event from outside; enters without a
 * session, with another account's tifo, a private one, one made before the
 * announcement, and twice; votes without a verified email, for its own entry,
 * twice, before voting and after it; reads the counts while votes are being
 * taken; confirms as a fan, and before voting has closed; and wins twice
 * inside 90 days. Runs on the memory stores, and the store's promises again on Postgres
 * when DATABASE_URL is set (schema.sql applied).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository } from '../src/proRepo';
import { MemoryEventRepository, PgEventRepository, type EventRepository, type TifoEvent } from '../src/eventRepo';
import { currentEvent, prizeTooSoon, rankEntries, readEventFields, shuffledFor, slugFrom, stageOf, voteCounts } from '../src/tifoEvents';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reg(app: FastifyInstance, u: string): Promise<{ token: string; id: string; name: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'quartz-lantern-echo7', email: `${u}@example.test`, acceptedVersion: 'test' } });
  assert.equal(r.statusCode < 300, true, `register ${u}: ${r.body}`);
  const token = (r.json() as { token: string }).token;
  const id = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  return { token, id, name: u };
}
async function makeDesign(app: FastifyInstance, token: string, title: string, isPublic = true): Promise<string> {
  const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  assert.equal(d.statusCode < 300, true, `design ${title}: ${d.body}`);
  const id = (d.json() as { id: string }).id;
  if (isPublic) await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } });
  return id;
}

// ---------------------------------------------------------- 1. the rules ---
{
  const at = (h: number) => new Date(Date.UTC(2026, 10, 20, 0) + h * HOUR).toISOString();
  const e = { announceAt: at(0), openAt: at(24), voteAt: at(72), closeAt: at(120), cancelledAt: null as string | null, confirmedAt: null as string | null };
  const stage = (h: number) => stageOf(e, new Date(at(h)));
  assert.deepEqual([stage(-1), stage(0), stage(23.9), stage(24), stage(71.9), stage(72), stage(119.9), stage(120), stage(999)],
    ['draft', 'announced', 'announced', 'open', 'open', 'voting', 'voting', 'closed', 'closed'], 'each stage starts on its own time and not a moment before');
  assert.equal(stageOf({ ...e, confirmedAt: at(130) }, new Date(at(140))), 'result', 'a confirmed event is its result');
  assert.equal(stageOf({ ...e, cancelledAt: at(1), confirmedAt: at(130) }, new Date(at(80))), 'cancelled', 'and a cancelled one is cancelled whatever else is true');

  // The form.
  const good = { titleEn: 'The Derby!', titleAr: 'الديربي', lineEn: 'One night.', lineAr: 'ليلة وحدة.', announceAt: at(0), openAt: at(24), voteAt: at(72), closeAt: at(120) };
  const f = readEventFields(good);
  assert.equal(f.ok && f.fields.slug, 'the-derby', 'the address comes from the English title');
  assert.equal(f.ok && f.fields.prizeDays, 30, 'a month of Pro unless told otherwise');
  assert.equal(slugFrom('  Żółć 2026 — final  '), 'zo-c-2026-final');
  const bad = (patch: Record<string, unknown>): boolean => !readEventFields({ ...good, ...patch }).ok;
  assert.ok(bad({ titleEn: '' }) && bad({ titleAr: '' }) && bad({ titleEn: 'x'.repeat(61) }) && bad({ lineEn: 'x'.repeat(201) }), 'titles and lines within their lengths');
  assert.ok(bad({ openAt: at(-1) }) && bad({ voteAt: at(24) }) && bad({ closeAt: at(72) }) && bad({ closeAt: 'soon' }), 'the four times in order, and real times');
  assert.ok(bad({ prizeDays: 91 }) && bad({ prizeDays: -1 }) && bad({ prizeDays: 1.5 }) && !bad({ prizeDays: 0 }), 'the prize is 0 to 90 whole days');
  assert.ok(bad({ slug: '../admin' }) && bad({ slug: 'A' }) && bad({ titleEn: 'ديربي' }) && !bad({ titleEn: 'ديربي', slug: 'derby' }), 'an address is small letters, digits and dashes');
  const overridden = readEventFields({ ...good, titleEn: 'Safe‮evil\u0007' });
  assert.equal(overridden.ok && overridden.fields.titleEn, 'Safe evil', 'direction overrides and controls are taken out of a title');

  // The result.
  const entry = (designId: string, userId: string, h: number, reason: string | null = null) => ({ eventId: 'e', designId, userId, enteredAt: at(h), disqualifiedReason: reason });
  const rows = [entry('a', 'ua', 30), entry('b', 'ub', 25), entry('c', 'uc', 26), entry('d', 'ud', 27, 'broke the rule'), entry('g', 'ug', 28)];
  const tally = new Map([['a', { counted: 3 }], ['b', { counted: 3 }], ['c', { counted: 1 }], ['d', { counted: 9 }], ['g', { counted: 9 }]]);
  assert.deepEqual(rankEntries(rows, tally, (id) => id !== 'g').map((r) => r.designId), ['b', 'a', 'c'],
    'most counted votes first, the earlier entry between equals; an entry taken out or no longer public is not ranked');
  assert.equal(voteCounts(at(71), at(72)), true);
  assert.equal(voteCounts(at(72), at(72)), false, 'an email verified as voting opened does not count');
  assert.equal(voteCounts(null, at(72)), false);
  const items = 'abcdefghij'.split('').map((x) => ({ designId: x }));
  const one = shuffledFor(items, 'seed-1').map((x) => x.designId).join('');
  assert.equal(shuffledFor(items, 'seed-1').map((x) => x.designId).join(''), one, 'one visitor sees one order every time');
  assert.notEqual(shuffledFor(items, 'seed-2').map((x) => x.designId).join(''), one, 'and the next visitor another');
  assert.equal([...one].sort().join(''), 'abcdefghij', 'with nobody left out');

  // Which event the home page speaks of.
  const ev = (slug: string, h0: number, extra: Partial<TifoEvent> = {}): TifoEvent => ({
    id: slug, slug, titleEn: slug, titleAr: slug, lineEn: '', lineAr: '', announceAt: at(h0), openAt: at(h0 + 24), voteAt: at(h0 + 72), closeAt: at(h0 + 120), prizeDays: 30,
    cancelledAt: null, confirmedAt: null, winnerDesign: null, secondDesign: null, thirdDesign: null, winnerUser: null, prizePass: null, createdAt: at(h0), ...extra,
  });
  const nowAt = new Date(at(80));
  assert.equal(currentEvent([], nowAt), null, 'no event, nothing to say');
  assert.equal(currentEvent([ev('draft', 100), ev('gone', 0, { cancelledAt: at(1) })], nowAt), null, 'a draft and a cancelled event are nobody\'s');
  assert.equal(currentEvent([ev('announced', 70), ev('open', 40), ev('voting', 0)], nowAt)?.slug, 'voting', 'the one furthest along');
  assert.equal(currentEvent([ev('old', -400, { confirmedAt: at(-200) }), ev('fresh', -200, { confirmedAt: at(0) })], nowAt)?.slug, 'fresh', 'a result is spoken of for a week');
  assert.equal(currentEvent([ev('old', -400, { confirmedAt: at(-200) })], nowAt), null);
  const won = ev('won', -400, { confirmedAt: at(0), winnerUser: 'u1', prizePass: 'p1' });
  assert.equal(prizeTooSoon([won], 'u1', new Date(at(89 * 24))), true, 'one prize per person per 90 days');
  assert.equal(prizeTooSoon([won], 'u1', new Date(at(91 * 24))), false);
  assert.equal(prizeTooSoon([{ ...won, prizePass: null }], 'u1', nowAt), false, 'a win with no prize does not delay the next prize');
  assert.equal(prizeTooSoon([won], 'u2', nowAt), false);
}

// ------------------------------------------- 2. one event, start to end ---
{
  const savedMode = process.env.PRO_MODE;
  process.env.PRO_MODE = 'on';
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const proRepo = new MemoryProRepository((id) => auth.usernameOf(id));
  const events = new MemoryEventRepository();
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const app = await buildApp(designs, auth, templates, {
    leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository((uid) => auth.usernameOf(uid)),
    pro: proRepo, tifoEvents: events, tifoEventsNow: now, adminUsernames: ['boss_ev'], aiAdminPassword: 'events admin password',
  });
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'events admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };
  const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? bearer(token) : {} });
  const post = (url: string, payload: unknown, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload: payload as object });
  const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;

  const amal = await reg(app, 'amal_ev');
  const badr = await reg(app, 'badr_ev');
  const cyra = await reg(app, 'cyra_ev');
  const dana = await reg(app, 'dana_ev');
  const late = await reg(app, 'late_ev');
  const plain = await reg(app, 'plain_ev'); // never verifies an email
  for (const u of [amal, badr, cyra, dana]) await auth.markEmailVerified(u.id);
  const oldTifo = await makeDesign(app, amal.token, 'Last year');
  await sleep(15);

  // With no event, nothing anywhere.
  assert.deepEqual(json(await get('/api/events/current')), { event: null });
  assert.deepEqual(json(await get('/api/events')), { events: [] });
  assert.equal((await get('/api/events/the-derby')).statusCode, 404);

  // Only the admin makes one.
  const t0 = Date.now();
  const form = {
    titleEn: 'The Derby', titleAr: 'الديربي', lineEn: 'One night, two colours.', lineAr: 'ليلة وحدة ولونين.',
    announceAt: new Date(t0 + HOUR).toISOString(), openAt: new Date(t0 + DAY).toISOString(), voteAt: new Date(t0 + 3 * DAY).toISOString(), closeAt: new Date(t0 + 5 * DAY).toISOString(),
    prizeDays: 30,
  };
  assert.equal((await post('/api/admin/events', form, {})).statusCode, 403, 'nobody makes an event without the admin\'s session');
  assert.equal((await post('/api/admin/events', form, bearer(amal.token))).statusCode, 403, 'a fan does not either');
  assert.equal((await get('/api/admin/events', amal.token)).statusCode, 403);
  assert.equal((await post('/api/admin/events', { ...form, closeAt: form.openAt }, asBoss)).statusCode, 400);
  const made = json(await post('/api/admin/events', form, asBoss));
  assert.equal(made.ok, true, JSON.stringify(made));
  const id = made.event.id as string;
  assert.equal(made.event.slug, 'the-derby');
  assert.equal((await post('/api/admin/events', form, asBoss)).statusCode, 409, 'one event per address');

  // A draft is the admin's alone.
  assert.equal((await get('/api/events/the-derby')).statusCode, 404, 'a draft is not public');
  assert.deepEqual(json(await get('/api/events/current')), { event: null });
  assert.equal(json(await get('/api/admin/events', undefined)).error, 'admin access required');
  const adminList = async () => json(await app.inject({ method: 'GET', url: '/api/admin/events', headers: asBoss })).events.find((x: any) => x.id === id);
  assert.equal((await adminList()).stage, 'draft');
  // Its address can change while nobody has seen it.
  assert.equal(json(await post(`/api/admin/events/${id}`, { ...form, slug: 'derby-night' }, asBoss)).event.slug, 'derby-night');
  assert.equal(json(await post(`/api/admin/events/${id}`, { ...form, slug: 'the-derby' }, asBoss)).event.slug, 'the-derby');

  // Announced: the theme and the dates, and nothing to do yet.
  offset = 2 * HOUR;
  // Tifos are made by the real clock, so the announcement is put just behind it: after 'Last year', before everything made from here on.
  form.announceAt = new Date(Date.now() - 5).toISOString();
  assert.equal(json(await post(`/api/admin/events/${id}`, form, asBoss)).ok, true);
  let page = json(await get('/api/events/the-derby'));
  assert.equal(page.event.stage, 'announced');
  assert.equal(page.event.stageEnds, form.openAt, 'it says when entries open');
  assert.deepEqual(page.entries, []);
  assert.equal(json(await get('/api/events/current')).event.slug, 'the-derby');
  assert.equal((await post(`/api/admin/events/${id}`, { ...form, slug: 'renamed' }, asBoss)).statusCode, 409, 'a public address does not change');
  const amalTifo = await makeDesign(app, amal.token, 'Amal derby');
  assert.equal(json(await post('/api/events/the-derby/enter', { designId: amalTifo }, bearer(amal.token))).code, 'closed', 'no entry before entries open');

  // Open.
  offset = DAY + HOUR;
  const badrTifo = await makeDesign(app, badr.token, 'Badr derby');
  const cyraTifo = await makeDesign(app, cyra.token, 'Cyra derby');
  const danaTifo = await makeDesign(app, dana.token, 'Dana derby');
  const plainTifo = await makeDesign(app, plain.token, 'Plain derby');
  const amalPrivate = await makeDesign(app, amal.token, 'Amal private', false);
  const amalSecond = await makeDesign(app, amal.token, 'Amal second');
  const enter = (u: { token: string }, designId: unknown) => post('/api/events/the-derby/enter', { designId }, bearer(u.token));
  assert.equal((await post('/api/events/the-derby/enter', { designId: amalTifo }, {})).statusCode, 401, 'entering needs an account');
  assert.equal((await enter(amal, 'not-an-id')).statusCode, 400);
  assert.equal(json(await enter(amal, badrTifo)).code, 'not_yours', 'another account\'s tifo is not yours to enter');
  assert.equal(json(await enter(amal, amalPrivate)).code, 'not_public', 'a private tifo is not entered');
  assert.equal(json(await enter(amal, oldTifo)).code, 'too_old', 'nor one made before the announcement');
  assert.equal(json(await enter(amal, amalTifo)).ok, true);
  assert.equal(json(await enter(amal, amalTifo)).ok, true, 'entering the same tifo again changes nothing');
  assert.equal(json(await enter(amal, amalSecond)).ok, true, 'entering another replaces the entry');
  assert.equal((await events.entries(id)).filter((x) => x.userId === amal.id).length, 1, 'one entry per account');
  assert.equal(json(await enter(amal, amalTifo)).ok, true);
  // Each entry a second after the last: two in the same millisecond would be ordered by their ids, and the result below is about who entered first.
  for (const [u, d] of [[badr, badrTifo], [cyra, cyraTifo], [dana, danaTifo], [plain, plainTifo]] as const) {
    offset += 1000;
    assert.equal(json(await enter(u, d)).ok, true);
  }
  const mine = json(await get('/api/events/the-derby/mine', amal.token));
  assert.deepEqual(mine.designs.map((d: any) => d.title).sort(), ['Amal derby', 'Amal second'], 'the picker offers what can be entered');
  assert.equal(mine.older, 1, 'and counts what is too old');
  assert.equal((await get('/api/events/the-derby/mine')).statusCode, 401);
  page = json(await get('/api/events/the-derby', amal.token));
  assert.equal(page.event.stage, 'open');
  assert.equal(page.entries.length, 5);
  assert.equal(page.me.entry, amalTifo);
  assert.equal(page.entries[0].votes, undefined);
  assert.equal(json(await post('/api/events/the-derby/vote', { designId: badrTifo, on: true }, bearer(amal.token))).code, 'closed', 'no vote before voting opens');
  // Dana leaves and comes back.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/events/the-derby/enter', headers: bearer(dana.token) })).statusCode, 200);
  assert.equal(json(await get('/api/events/the-derby')).entries.length, 4);
  assert.equal(json(await enter(dana, danaTifo)).ok, true);

  // Voting: entries frozen, votes taken and not shown.
  offset = 3 * DAY + HOUR;
  // "late" verified an email only after voting opened: its votes are taken and not counted.
  await auth.markEmailVerified(late.id);
  (auth.users.get('late_ev') as { emailVerifiedAt: string }).emailVerifiedAt = new Date(t0 + 3 * DAY + 30 * 60_000).toISOString();
  const vote = (u: { token: string }, designId: string, on = true) => post('/api/events/the-derby/vote', { designId, on }, bearer(u.token));
  assert.equal(json(await enter(amal, amalSecond)).code, 'closed', 'an entry does not change once voting has started');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/events/the-derby/enter', headers: bearer(amal.token) })).statusCode, 409);
  assert.equal((await post('/api/events/the-derby/vote', { designId: badrTifo, on: true }, {})).statusCode, 401);
  assert.equal(json(await vote(plain, badrTifo)).code, 'verify_first', 'a vote needs a verified email');
  assert.equal(json(await vote(amal, amalTifo)).code, 'own', 'nobody votes for their own entry');
  assert.equal((await vote(amal, oldTifo)).statusCode, 404, 'a tifo that is not an entry takes no vote');
  assert.equal((await post('/api/events/the-derby/vote', { designId: badrTifo }, bearer(amal.token))).statusCode, 400);
  // Badr 3 counted (amal, cyra, dana) and 1 uncounted (late); Cyra 2 (amal, badr); Amal 2 (badr, cyra) and entered before Cyra; Dana 1 (amal).
  for (const [u, d] of [[amal, badrTifo], [cyra, badrTifo], [dana, badrTifo], [late, badrTifo], [amal, cyraTifo], [badr, cyraTifo], [badr, amalTifo], [cyra, amalTifo], [amal, danaTifo]] as const) {
    assert.equal(json(await vote(u, d)).voted, true);
  }
  assert.equal(json(await vote(amal, badrTifo)).voted, true, 'voting twice is one vote');
  assert.equal((await events.tally(id)).get(badrTifo)?.all, 4);
  assert.equal((await events.tally(id)).get(badrTifo)?.counted, 3, 'a vote from an email verified after voting opened is kept and not counted');
  // A vote taken back, and given again.
  assert.equal(json(await vote(dana, badrTifo, false)).voted, false);
  assert.equal((await events.tally(id)).get(badrTifo)?.counted, 2);
  assert.equal(json(await vote(dana, badrTifo)).voted, true);
  page = json(await get('/api/events/the-derby', amal.token));
  assert.equal(page.event.stage, 'voting');
  assert.deepEqual([...page.me.votes].sort(), [badrTifo, cyraTifo, danaTifo].sort(), 'a voter sees their own votes');
  assert.ok(page.entries.every((x: any) => x.votes === undefined && x.place === undefined), 'and nobody sees the counts while votes are being taken');
  assert.ok(!JSON.stringify(page).includes('"counted"') && !JSON.stringify(page).includes('allVotes'));
  const orderOf = async (token?: string) => json(await get('/api/events/the-derby', token)).entries.map((x: any) => x.designId).join();
  assert.equal(await orderOf(amal.token), await orderOf(amal.token), 'one voter, one order');
  const orders = new Set([await orderOf(amal.token), await orderOf(badr.token), await orderOf(cyra.token), await orderOf(dana.token), await orderOf(late.token), await orderOf()]);
  assert.ok(orders.size > 1, 'and not the same order for everyone');
  // The admin takes one entry out, with a reason the page shows.
  assert.equal((await post(`/api/admin/events/${id}/disqualify`, { designId: plainTifo, reason: 'Broke the theme' }, bearer(amal.token))).statusCode, 403);
  assert.equal(json(await post(`/api/admin/events/${id}/disqualify`, { designId: plainTifo, reason: 'Broke the theme' }, asBoss)).reason, 'Broke the theme');
  page = json(await get('/api/events/the-derby'));
  assert.equal(page.entries.length, 4);
  assert.deepEqual(page.out.map((x: any) => [x.designId, x.reason]), [[plainTifo, 'Broke the theme']]);
  assert.equal((await vote(amal, plainTifo)).statusCode, 404, 'an entry taken out takes no vote');
  // The admin sees the counts, and whom the result would name.
  let seen = await adminList();
  assert.equal(seen.stage, 'voting');
  assert.deepEqual(seen.proposed, [badrTifo, amalTifo, cyraTifo], 'most counted votes, then the earlier entry');
  assert.equal(seen.entries.find((x: any) => x.designId === badrTifo).allVotes, 4);
  assert.equal(json(await post(`/api/admin/events/${id}/confirm`, {}, asBoss)).error, 'voting has not closed yet');

  // Closed: waiting for the admin.
  offset = 5 * DAY + HOUR;
  assert.equal(json(await vote(amal, danaTifo, false)).code, 'closed', 'a vote does not change after voting');
  page = json(await get('/api/events/the-derby'));
  assert.equal(page.event.stage, 'closed');
  assert.ok(page.entries.every((x: any) => x.votes === undefined), 'still no counts until the result is confirmed');
  assert.deepEqual(page.podium, []);
  // Cyra unpublishes her tifo: it is out of the result.
  await app.inject({ method: 'PATCH', url: `/api/designs/${cyraTifo}`, headers: bearer(cyra.token), payload: { isPublic: false } });
  seen = await adminList();
  assert.deepEqual(seen.proposed, [badrTifo, amalTifo, danaTifo], 'an unpublished entry is not in the result');
  assert.equal((await post(`/api/admin/events/${id}/confirm`, {}, bearer(badr.token))).statusCode, 403, 'a fan does not confirm a result');
  const confirmed = json(await post(`/api/admin/events/${id}/confirm`, {}, asBoss));
  assert.equal(confirmed.prize, 'given');
  assert.deepEqual(confirmed.winner, { designId: badrTifo, owner: 'badr_ev', votes: 3 });
  assert.equal((await post(`/api/admin/events/${id}/confirm`, {}, asBoss)).statusCode, 409, 'a result is confirmed once');
  const passes = await proRepo.allPasses(badr.id);
  assert.equal(passes.length, 1, 'exactly one pass for the winner');
  assert.equal(Math.round((Date.parse(passes[0].endsAt) - Date.parse(passes[0].startsAt)) / DAY), 30);
  assert.equal(passes[0].source, 'admin');
  for (const u of [amal, cyra, dana]) assert.equal((await proRepo.allPasses(u.id)).length, 0, 'and none for anyone else');

  // The result: the podium and the counts, for everyone, for good.
  page = json(await get('/api/events/the-derby'));
  assert.equal(page.event.stage, 'result');
  assert.deepEqual(page.podium.map((x: any) => [x.place, x.designId, x.votes]), [[1, badrTifo, 3], [2, amalTifo, 2], [3, danaTifo, 1]]);
  assert.equal(json(await get('/api/events/current')).event.winner.designId, badrTifo, 'the home page names the winner');
  for (const path of ['', '/cancel', '/disqualify']) {
    assert.equal((await post(`/api/admin/events/${id}${path}`, { ...form, designId: amalTifo, reason: 'x' }, asBoss)).statusCode, 409, 'a confirmed event is a record');
  }
  assert.equal((await post(`/api/admin/events/${id}/delete`, {}, asBoss)).statusCode, 409, 'an event with entries is not deleted');
  offset = 5 * DAY + HOUR + 8 * DAY;
  assert.deepEqual(json(await get('/api/events/current')), { event: null }, 'a week later the home page is quiet again');
  assert.equal(json(await get('/api/events')).events.length, 1, 'and the event stays as a record');
  assert.equal(json(await get('/api/events/the-derby')).podium.length, 3);

  // A second event inside 90 days: the same winner takes the title, not a second prize.
  const t1 = Date.now() + offset;
  const form2 = {
    titleEn: 'One word', titleAr: 'كلمة وحدة', lineEn: '', lineAr: '', prizeDays: 30,
    announceAt: new Date(t1 - HOUR).toISOString(), openAt: new Date(t1 + HOUR).toISOString(), voteAt: new Date(t1 + DAY).toISOString(), closeAt: new Date(t1 + 2 * DAY).toISOString(),
  };
  // The tifos are made by the real clock, so this event is announced before them on it too.
  const second = json(await post('/api/admin/events', { ...form2, announceAt: new Date(Date.now() - HOUR).toISOString() }, asBoss)).event;
  offset += 2 * HOUR;
  const badrTwo = await makeDesign(app, badr.token, 'Badr word');
  assert.equal(json(await post('/api/events/one-word/enter', { designId: badrTwo }, bearer(badr.token))).ok, true);
  offset += DAY;
  assert.equal(json(await post('/api/events/one-word/vote', { designId: badrTwo, on: true }, bearer(amal.token))).voted, true);
  offset += DAY;
  const again = json(await post(`/api/admin/events/${second.id}/confirm`, {}, asBoss));
  assert.equal(again.prize, 'too_soon');
  assert.equal(again.winner.designId, badrTwo);
  assert.equal((await proRepo.allPasses(badr.id)).length, 1, 'still one pass');

  // An event nobody voted in has no winner, and a cancelled one is nowhere.
  const t2 = Date.now() + offset;
  const third = json(await post('/api/admin/events', {
    titleEn: 'Quiet', titleAr: 'هدوء', announceAt: new Date(t2 - 3 * DAY).toISOString(), openAt: new Date(t2 - 2 * DAY).toISOString(),
    voteAt: new Date(t2 - DAY).toISOString(), closeAt: new Date(t2 - HOUR).toISOString(), prizeDays: 0,
  }, asBoss)).event;
  assert.equal(json(await post(`/api/admin/events/${third.id}/confirm`, {}, asBoss)).prize, 'no_winner');
  const fourth = json(await post('/api/admin/events', {
    titleEn: 'Called off', titleAr: 'ملغي', announceAt: new Date(t2 - HOUR).toISOString(), openAt: new Date(t2 + HOUR).toISOString(),
    voteAt: new Date(t2 + DAY).toISOString(), closeAt: new Date(t2 + 2 * DAY).toISOString(),
  }, asBoss)).event;
  assert.equal((await get('/api/events/called-off')).statusCode, 200);
  assert.equal(json(await post(`/api/admin/events/${fourth.id}/cancel`, {}, asBoss)).cancelled, true);
  assert.equal((await get('/api/events/called-off')).statusCode, 404, 'a cancelled event leaves every public page');
  assert.equal(json(await post(`/api/admin/events/${fourth.id}/cancel`, { cancelled: false }, asBoss)).cancelled, false);
  assert.equal((await get('/api/events/called-off')).statusCode, 200);
  assert.equal(json(await post(`/api/admin/events/${fourth.id}/delete`, {}, asBoss)).ok, true, 'an event nobody entered can be deleted');
  assert.equal((await get('/api/events/called-off')).statusCode, 404);
  assert.equal((await post('/api/admin/events/not-an-id/confirm', {}, asBoss)).statusCode, 404);

  await app.close();
  if (savedMode === undefined) delete process.env.PRO_MODE;
  else process.env.PRO_MODE = savedMode;
}

// ------------------------------------ 3. a server with no events at all ---
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, {});
  assert.equal((await app.inject({ method: 'GET', url: '/api/events/current' })).statusCode, 404, 'without the events store the routes do not exist');
  await app.close();
}

// ------------------------------- 4. the store's promises, on both stores ---
async function storePromises(label: string, repo: EventRepository, users: string[], tifos: string[]): Promise<void> {
  const [ua, ub, uc] = users;
  const [da, da2, db] = tifos;
  const t = (h: number) => new Date(Date.UTC(2027, 0, 10) + h * HOUR);
  const fields = (slug: string) => ({
    slug, titleEn: 'Store', titleAr: 'مخزن', lineEn: 'l', lineAr: 'س', announceAt: t(0).toISOString(), openAt: t(1).toISOString(), voteAt: t(2).toISOString(), closeAt: t(3).toISOString(), prizeDays: 7,
  });
  const slug = `store-${Date.now().toString(36)}`;
  const e = await repo.create(fields(slug));
  assert.ok(e, `${label}: an event is made`);
  assert.equal(await repo.create(fields(slug)), null, `${label}: one event per address`);
  const other = await repo.create(fields(`${slug}-b`));
  assert.ok(other);
  assert.equal(await repo.update(other.id, fields(slug)), null, `${label}: nor by renaming another onto it`);
  assert.equal((await repo.update(e.id, { ...fields(slug), titleEn: 'Renamed', prizeDays: 0 }))?.titleEn, 'Renamed');
  assert.equal((await repo.bySlug(slug))?.prizeDays, 0);
  assert.equal((await repo.byId(e.id))?.announceAt, t(0).toISOString(), `${label}: times come back as they went in`);
  assert.ok((await repo.list()).some((x) => x.id === e.id));
  // Entries: one per account, a design once.
  assert.equal(await repo.putEntry(e.id, ua, da, t(1)), 'ok');
  assert.equal(await repo.putEntry(e.id, ua, da, t(1.1)), 'ok');
  assert.equal(await repo.putEntry(e.id, ub, db, t(1.2)), 'ok');
  assert.equal(await repo.putEntry(e.id, ub, da, t(1.3)), 'taken', `${label}: a design is entered once`);
  assert.equal(await repo.vote(e.id, da, ub, true, t(2)), true);
  assert.equal(await repo.vote(e.id, da, ub, true, t(2)), false, `${label}: one vote per account per entry`);
  assert.equal(await repo.vote(e.id, da, uc, false, t(2)), true);
  assert.deepEqual((await repo.tally(e.id)).get(da), { counted: 1, all: 2 }, `${label}: counted votes and all votes`);
  assert.deepEqual(await repo.votesBy(e.id, ub), [da]);
  assert.equal(await repo.putEntry(e.id, ua, da2, t(1.5)), 'ok');
  const rows = await repo.entries(e.id);
  assert.deepEqual(rows.map((x) => [x.userId, x.designId]), [[ub, db], [ua, da2]], `${label}: entering another tifo replaces the entry, in the order entered`);
  assert.equal((await repo.tally(e.id)).get(da), undefined, `${label}: and the old entry's votes go with it`);
  assert.equal(await repo.disqualify(e.id, db, 'Broke the theme'), true);
  assert.equal((await repo.entries(e.id)).find((x) => x.designId === db)?.disqualifiedReason, 'Broke the theme');
  assert.equal(await repo.disqualify(e.id, db, null), true);
  assert.equal(await repo.disqualify(e.id, da, 'x'), false, `${label}: only an entry is taken out`);
  assert.equal(await repo.vote(e.id, db, ua, true, t(2)), true);
  assert.equal(await repo.unvote(e.id, db, ua), true);
  assert.equal(await repo.unvote(e.id, db, ua), false);
  assert.equal(await repo.vote(e.id, db, uc, true, t(2)), true);
  assert.equal(await repo.removeEntry(e.id, ub), true);
  assert.equal(await repo.removeEntry(e.id, ub), false);
  assert.equal((await repo.tally(e.id)).size, 0, `${label}: a removed entry takes its votes`);
  // Cancel, result, delete.
  assert.equal(await repo.setCancelled(e.id, true, t(4)), true);
  assert.equal((await repo.byId(e.id))?.cancelledAt, t(4).toISOString());
  assert.equal(await repo.setCancelled(e.id, false, t(4)), true);
  assert.equal((await repo.byId(e.id))?.cancelledAt, null);
  assert.equal(await repo.setResult(e.id, { confirmedAt: t(5).toISOString(), winnerDesign: da2, secondDesign: null, thirdDesign: null, winnerUser: ua, prizePass: null }), true);
  const done = await repo.byId(e.id);
  assert.deepEqual([done?.confirmedAt, done?.winnerDesign, done?.winnerUser, done?.secondDesign], [t(5).toISOString(), da2, ua, null]);
  assert.equal(await repo.remove(e.id), true);
  assert.equal(await repo.remove(other.id), true);
  assert.equal(await repo.byId(e.id), null);
  assert.deepEqual(await repo.entries(e.id), [], `${label}: a deleted event takes its entries`);
  console.log(`events.test: ${label} store promises hold (one address, one entry per account, a design once, one vote per entry, votes go with their entry)`);
}

const uid = () => randomUUID();
await storePromises('memory', new MemoryEventRepository(), [uid(), uid(), uid()], [uid(), uid(), uid()]);

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const stamp = Date.now();
    const mkUser = async (name: string) =>
      String((await pool.query(`INSERT INTO users (username, password_hash, email) VALUES ($1, 'x', $2) RETURNING id`, [name, `${name}@example.test`])).rows[0].id);
    const mkTifo = async (owner: string) =>
      String((await pool.query(
        `INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, is_public) VALUES ('Event tifo', 'x', 1, '[]'::jsonb, $2, $1, true) RETURNING id`,
        [owner, Buffer.from([0])],
      )).rows[0].id);
    const users = [await mkUser(`ev_pg_a_${stamp}`), await mkUser(`ev_pg_b_${stamp}`), await mkUser(`ev_pg_c_${stamp}`)];
    const tifos = [await mkTifo(users[0]), await mkTifo(users[0]), await mkTifo(users[1])];
    const repo = new PgEventRepository(pool);
    await storePromises('postgres', repo, users, tifos);
    // Rows go with their design and their account; the table refuses what the form would.
    const e = await repo.create({
      slug: `pg-${stamp.toString(36)}`, titleEn: 'Pg', titleAr: 'بي', lineEn: '', lineAr: '', prizeDays: 30,
      announceAt: '2027-01-01T00:00:00.000Z', openAt: '2027-01-02T00:00:00.000Z', voteAt: '2027-01-03T00:00:00.000Z', closeAt: '2027-01-04T00:00:00.000Z',
    });
    assert.ok(e);
    await repo.putEntry(e.id, users[0], tifos[0], new Date());
    await repo.putEntry(e.id, users[1], tifos[2], new Date());
    await repo.vote(e.id, tifos[0], users[2], true, new Date());
    await repo.setResult(e.id, { confirmedAt: new Date().toISOString(), winnerDesign: tifos[0], secondDesign: tifos[2], thirdDesign: null, winnerUser: users[0], prizePass: null });
    await pool.query('DELETE FROM designs WHERE id = $1', [tifos[0]]);
    assert.deepEqual((await repo.entries(e.id)).map((x) => x.designId), [tifos[2]], 'a deleted tifo leaves the event');
    assert.equal((await repo.tally(e.id)).size, 0, 'with its votes');
    assert.deepEqual([(await repo.byId(e.id))?.winnerDesign, (await repo.byId(e.id))?.winnerUser], [null, users[0]], 'and the result keeps who won');
    await assert.rejects(pool.query(`UPDATE tifo_events SET vote_at = open_at WHERE id = $1`, [e.id]), 'times out of order are refused by the table');
    await assert.rejects(pool.query(`UPDATE tifo_events SET slug = '../x' WHERE id = $1`, [e.id]), 'and an address that is a path');
    await assert.rejects(pool.query(`UPDATE tifo_events SET prize_days = 400 WHERE id = $1`, [e.id]), 'and a prize past 90 days');
    await pool.query('DELETE FROM designs WHERE owner_id = ANY($1::uuid[])', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    assert.equal(Number((await pool.query(
      `SELECT (SELECT count(*) FROM tifo_event_entries WHERE user_id = ANY($1::uuid[])) + (SELECT count(*) FROM tifo_event_votes WHERE user_id = ANY($1::uuid[])) AS n`, [users],
    )).rows[0].n), 0, 'an erased account leaves no entries or votes');
    assert.equal((await repo.byId(e.id))?.winnerUser, null);
    await repo.remove(e.id);
    console.log('events.test: postgres store checks passed');
  } finally {
    await pool.end();
  }
} else {
  console.log('events.test: DATABASE_URL not set, Postgres store checks skipped');
}

console.log('events: stages by the clock | the form | one event from draft to result (entries, votes hidden, late votes uncounted, one pass for the winner) | one prize per 90 days | cancel and delete');
