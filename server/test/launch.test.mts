/**
 * Pro's launch (19 Nov 2026; proLaunch.ts): the launch price and how it is
 * shown, the launch moment and the founders list, the one founders email,
 * and the founders bonus with every edge the owner asked for.
 *
 * Adversarial where a promise or money is: it tries to get a launch recorded
 * (or an email sent) on a test key, in preview and with payments off; to get
 * the email sent twice (two servers at once, a restart, a refused send, the
 * admin's "send now"); to get the bonus just after the deadline, without
 * being a founder, twice, on a second purchase, after a refund, with test
 * money, from two confirmations at once and from two orders at once; and to
 * be charged the launch price on a renewal. Runs on the memory stores, and
 * the stores' own guards again on Postgres when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository } from '../src/payRepo';
import { MemoryLaunchRepository, PgLaunchRepository, memoryLaunch, type FounderMail, type LaunchAccount } from '../src/launchRepo';
import { ProService } from '../src/pro';
import {
  MoyasarError,
  type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type MoyasarToken, type NewInvoice, type TokenCharge,
} from '../src/moyasar';
import { PaymentService, payLegal, paymentsPublic, priceHalalas, type FormConfig, type RenewNotice } from '../src/payments';
import {
  FOUNDER_BONUS_DAYS, FOUNDER_GRACE_HOURS, FOUNDER_WINDOW_HOURS, LaunchService, MAIL_TRIES, bonusInTime, founderBonusOn, founderDeadline,
  launchHalalas, launchPriceUntil, launchPriceUntilInvalid, priceAt, priceDisplay, priceStatus, regularHalalas,
} from '../src/proLaunch';
import { founderEmail } from '../src/proLaunchMail';
import { receiptEmail } from '../src/payReceipt';
import { renewEmail } from '../src/payRenewMail';
import { OFFER } from '../src/proPlan';
import type { EmailMessage, EmailSender } from '../src/email';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TEST_KEY = 'sk_test_FAKEfake1234'; // under 20 after the prefix: not a real key, and not one secret-scan.mjs flags
const LIVE_KEY = 'sk_live_FAKEfake1234';
const PK_TEST = 'pk_test_FAKEfake1234';
const PK_LIVE = 'pk_live_FAKEfake1234';
const HOOK = 'a-webhook-secret-of-some-length';

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

class FakeMoyasar implements MoyasarApi {
  payments = new Map<string, MoyasarPayment>();
  tokens = new Map<string, MoyasarToken>();
  charges: TokenCharge[] = [];
  async createInvoice(_i: NewInvoice): Promise<MoyasarInvoice> { throw new MoyasarError(0, 'not_used'); }
  async invoice(_id: string): Promise<MoyasarInvoice> { throw new MoyasarError(404, 'record_not_found'); }
  async refund(paymentId: string): Promise<MoyasarPayment> {
    const p = this.payments.get(paymentId);
    if (!p || p.status === 'refunded') throw new MoyasarError(400, 'invalid_request_error');
    p.status = 'refunded';
    p.refunded = p.amount;
    return { ...p };
  }
  async payment(id: string): Promise<MoyasarPayment | null> {
    const p = this.payments.get(id);
    return p ? { ...p, metadata: { ...p.metadata } } : null;
  }
  async chargeToken(c: TokenCharge): Promise<MoyasarPayment> {
    this.charges.push(c);
    const p: MoyasarPayment = {
      id: c.givenId, status: 'paid', amount: c.amount, currency: 'SAR', refunded: 0, sourceType: 'creditcard', company: 'visa',
      token: null, message: null, responseCode: null, transactionUrl: null, invoiceId: null, metadata: { ...c.metadata },
    };
    this.payments.set(p.id, p);
    return { ...p };
  }
  async token(id: string): Promise<MoyasarToken | null> {
    const t = this.tokens.get(id);
    return t ? { ...t } : null;
  }
  async deleteToken(id: string): Promise<boolean> {
    this.tokens.delete(id);
    return true;
  }
  formPay(f: FormConfig, orderId: string, o: { save?: boolean } = {}): MoyasarPayment {
    let token: string | null = null;
    if (o.save) {
      token = `token_${randomUUID().replace(/-/g, '')}`;
      this.tokens.set(token, { id: token, status: 'active', brand: 'visa', lastFour: '1111', month: 12, year: 2035 });
    }
    const p: MoyasarPayment = {
      id: f.givenId, status: 'paid', amount: f.amount, currency: 'SAR', refunded: 0, sourceType: 'creditcard', company: 'visa',
      token, message: null, responseCode: null, transactionUrl: null, invoiceId: null, metadata: { order_id: orderId },
    };
    this.payments.set(p.id, p);
    return p;
  }
}

const LIVE = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY, MOYASAR_PUBLISHABLE_KEY: PK_LIVE, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: HOOK };
/** The founders offer needs no switch: it starts with the launch. */
const OFFER_ON = { ...LIVE };
/** The one way to have no offer. */
const OFFER_OFF = { ...LIVE, PRO_FOUNDERS_BONUS: 'off' };
/** The launch price runs until 15 Jan 2027 (Riyadh). */
const PRICED = { ...OFFER_ON, PRO_LAUNCH_PRICE_UNTIL: '2027-01-15' };
const RENEW = { ...PRICED, PRO_AUTORENEW: 'on' };
const T0 = new Date('2026-12-01T09:00:00Z');

interface Person { id: string; username: string; email: string | null; emailVerified: boolean }

/** A payment service and a launch service on memory stores, sharing one clock the test moves. */
function world(env: Record<string, string> = PRICED) {
  const state = { now: new Date(T0), mailUp: true, mailLive: true };
  const people = new Map<string, Person>();
  const accountOf = (id: string): LaunchAccount | null => {
    const p = people.get(id);
    return p ? { username: p.username, email: p.email, verified: p.emailVerified } : null;
  };
  const proRepo = new MemoryProRepository();
  const payRepo = new MemoryPaymentRepository(proRepo);
  const launchRepo = memoryLaunch(proRepo, payRepo, accountOf);
  const moyasar = new FakeMoyasar();
  const pro = new ProService(proRepo, { now: () => state.now, savedDesigns: async () => 1, env });
  const mails: FounderMail[] = [];
  const tries: string[] = [];
  const notices: RenewNotice[] = [];
  let payRef: PaymentService | null = null;
  const makeLaunch = (e: Record<string, string> = env) => new LaunchService(launchRepo, payRepo, {
    env: e, now: () => state.now, gapMs: 0,
    isPublic: () => !!payRef?.on() && paymentsPublic(e),
    canSend: () => state.mailLive,
    send: async (f) => {
      tries.push(f.userId);
      if (!state.mailUp) throw new Error('resend send failed: 503');
      mails.push(f);
    },
  });
  const launch = makeLaunch();
  const makePay = (e: Record<string, string> = env, l: LaunchService = launch) => new PaymentService(payRepo, pro, moyasar, {
    env: e, base: 'https://tifomaker.test', founders: l,
    notify: async (n) => { notices.push(n); return true; },
  });
  const pay = makePay();
  payRef = pay;
  const person = (name: string, o: { verified?: boolean; email?: string | null } = {}): Person => {
    const p: Person = { id: randomUUID(), username: name, email: o.email === undefined ? `${name}@example.test` : o.email, emailVerified: o.verified ?? true };
    people.set(p.id, p);
    return p;
  };
  /** "Tell me when Pro opens". */
  const asks = async (p: Person): Promise<void> => { await proRepo.notify(p.id); };
  /** An answer to the price question, signed in (as the route does it: the answer, then the list). */
  const answers = async (p: Person, amount = 15): Promise<void> => {
    await proRepo.putPriceAnswer({ voter: `u:${p.id}`, userId: p.id, amount, currency: 'SAR', lang: 'ar', comment: null, wontPay: amount === 0, source: 'page', absorb: null, max: 1000 });
  };
  const checkout = async (p: Person, s: PaymentService = pay) => {
    const c = await s.checkout(p, 'en', 'https://tifomaker.test');
    assert.ok(c.ok && 'form' in c, `checkout: ${JSON.stringify(c)}`);
    return c;
  };
  const buy = async (p: Person, o: { keep?: boolean } = {}, s: PaymentService = pay) => {
    const c = await checkout(p, s);
    if (o.keep) assert.equal(await s.setKeep(p.id, c.orderId, true), true);
    moyasar.formPay(c.form, c.orderId, { save: o.keep });
    const order = (await s.orderFor(p.id, c.orderId))!;
    assert.equal(order.status, 'paid');
    return { order, form: c.form };
  };
  /** How many days of Pro the pass an order bought runs for. */
  const passDays = async (p: Person, passId: string | null): Promise<number> => {
    const pass = (await proRepo.allPasses(p.id)).find((x) => x.id === passId)!;
    return Math.round((Date.parse(pass.endsAt) - Date.parse(pass.startsAt)) / DAY);
  };
  const hasPro = async (p: Person): Promise<boolean> => (await proRepo.activePasses(p.id, state.now)).some((x) => x.plan === 'monthly');
  const forward = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  const at = (d: Date) => { state.now = new Date(d); };
  return { state, people, proRepo, payRepo, launchRepo, moyasar, pro, pay, launch, makeLaunch, makePay, mails, tries, notices, person, asks, answers, checkout, buy, passDays, hasPro, forward, at };
}

// --------------------------------------------------------------- 1. price ---
{
  assert.deepEqual([regularHalalas(), launchHalalas()], [1999, 1399], 'the two prices, in halalas');
  assert.deepEqual([OFFER.monthly.price, OFFER.monthly.launchPrice, OFFER.monthly.days], [19.99, 13.99, 30]);
  // No date: no launch price at all.
  assert.equal(launchPriceUntil({}), null);
  assert.deepEqual([priceAt(T0, {}).halalas, priceAt(T0, {}).launch, priceAt(T0, {}).until], [1999, false, null]);
  assert.equal(priceHalalas(T0, {}), 1999);
  // A Riyadh day: 13.99 until 14 Jan 23:59:59 Riyadh (20:59:59 UTC), 19.99 from 15 Jan 00:00 Riyadh.
  const env = { PRO_LAUNCH_PRICE_UNTIL: '2027-01-15' };
  assert.equal(launchPriceUntil(env)!.toISOString(), '2027-01-14T21:00:00.000Z');
  assert.equal(priceAt(new Date('2027-01-14T20:59:59Z'), env).halalas, 1399, 'the last second of the launch price');
  assert.equal(priceAt(new Date('2027-01-14T21:00:00Z'), env).halalas, 1999, 'the regular price from that day, with nobody touching the code');
  assert.equal(priceAt(new Date('2027-06-01T00:00:00Z'), env).launch, false);
  assert.equal(priceAt(T0, env).until, '2027-01-14T21:00:00.000Z');
  assert.equal(priceAt(new Date('2027-01-14T21:00:00Z'), env).until, null, 'once it has ended nothing is said about it');
  assert.equal(launchPriceUntil({ PRO_LAUNCH_PRICE_UNTIL: '2027-01-15T12:00:00+03:00' })!.toISOString(), '2027-01-15T09:00:00.000Z', 'an exact instant is taken as written');
  // A date that is not one: no launch price (the regular price), and it is said.
  for (const bad of ['soon', '15/01/2027', '2027-02-31', '2027-13-01', '2027-01-15 12:00']) {
    assert.equal(launchPriceUntil({ PRO_LAUNCH_PRICE_UNTIL: bad }), null, bad);
    assert.equal(launchPriceUntilInvalid({ PRO_LAUNCH_PRICE_UNTIL: bad }), true, bad);
    assert.equal(priceAt(T0, { PRO_LAUNCH_PRICE_UNTIL: bad }).halalas, 1999, bad);
  }
  assert.equal(launchPriceUntilInvalid({}), false);

  // The display: plain unless BOTH the switch and a licence number are given.
  assert.deepEqual(priceDisplay({}), { mode: 'plain', licence: null });
  assert.deepEqual(priceDisplay({ PRO_PRICE_DISPLAY: 'strike' }), { mode: 'plain', licence: null }, 'no crossed-out price without a licence number');
  assert.deepEqual(priceDisplay({ PRO_DISCOUNT_LICENCE: '12345' }), { mode: 'plain', licence: null }, 'a number alone changes nothing');
  assert.deepEqual(priceDisplay({ PRO_PRICE_DISPLAY: 'strike', PRO_DISCOUNT_LICENCE: '<script>' }), { mode: 'plain', licence: null }, 'not anything can be a licence number');
  assert.deepEqual(priceDisplay({ PRO_PRICE_DISPLAY: 'STRIKE', PRO_DISCOUNT_LICENCE: ' 4400012345 ' }), { mode: 'strike', licence: '4400012345' });
  assert.equal(priceAt(T0, { ...env, PRO_PRICE_DISPLAY: 'strike', PRO_DISCOUNT_LICENCE: '4400012345' }).display, 'strike');
  assert.equal(priceAt(new Date('2027-03-01T00:00:00Z'), { ...env, PRO_PRICE_DISPLAY: 'strike', PRO_DISCOUNT_LICENCE: '4400012345' }).display, 'plain', 'nothing is crossed out once the launch price has ended');
  const st = priceStatus(T0, { ...env, PRO_PRICE_DISPLAY: 'strike' });
  assert.deepEqual([st.now, st.regular, st.launch, st.display, st.strikeRefused, st.untilInvalid, st.untilPassed], [13.99, 19.99, true, 'plain', true, false, false]);
  assert.equal(priceStatus(new Date('2027-03-01T00:00:00Z'), env).untilPassed, true);

  assert.equal(founderBonusOn({}), true, 'the founders offer comes with the launch: nothing to switch on');
  assert.equal(founderBonusOn({ PRO_FOUNDERS_BONUS: 'on' }), true);
  assert.equal(founderBonusOn({ PRO_FOUNDERS_BONUS: 'no' }), true, 'only "off" is off');
  assert.equal(founderBonusOn({ PRO_FOUNDERS_BONUS: ' OFF ' }), false);
  assert.deepEqual([FOUNDER_WINDOW_HOURS, FOUNDER_BONUS_DAYS, FOUNDER_GRACE_HOURS], [72, 30, 6]);
  console.log('launch.test: the price and its display checked');
}

// ------------------------------------------- 2. the rule for being in time ---
{
  const L = new Date('2026-12-01T09:00:00Z');
  const D = founderDeadline(L);
  assert.equal(D.toISOString(), '2026-12-04T09:00:00.000Z', '72 hours from the launch moment');
  const order = (madeAt: Date, o: { kind?: 'form' | 'invoice' | 'renewal'; testMode?: boolean } = {}) => ({ createdAt: madeAt.toISOString(), kind: o.kind ?? 'form' as const, testMode: o.testMode ?? false });
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
  assert.equal(bonusInTime(order(plus(L, HOUR)), L, plus(L, 2 * HOUR)), true);
  assert.equal(bonusInTime(order(plus(D, -2000)), L, plus(D, -1000)), true, 'confirmed a second before the deadline');
  assert.equal(bonusInTime(order(plus(D, -1000)), L, D), true, 'confirmed on the deadline itself');
  assert.equal(bonusInTime(order(plus(D, 1000)), L, plus(D, 2000)), false, 'made and paid just after it');
  assert.equal(bonusInTime(order(plus(D, -60_000)), L, plus(D, 20 * 60_000)), true, 'paid at 71:59, confirmed twenty minutes late');
  assert.equal(bonusInTime(order(plus(D, -60_000)), L, plus(D, FOUNDER_GRACE_HOURS * HOUR)), true, 'the last moment of the grace');
  assert.equal(bonusInTime(order(plus(D, -60_000)), L, plus(D, FOUNDER_GRACE_HOURS * HOUR + 1000)), false, 'an order left open for hours is not in time');
  assert.equal(bonusInTime(order(plus(L, -HOUR)), L, plus(L, HOUR)), false, 'an order made before the launch (a preview purchase)');
  assert.equal(bonusInTime(order(plus(L, HOUR), { testMode: true }), L, plus(L, 2 * HOUR)), false, 'never with test money');
  assert.equal(bonusInTime(order(plus(L, HOUR), { kind: 'renewal' }), L, plus(L, 2 * HOUR)), false, 'never a renewal');
  assert.equal(bonusInTime(order(plus(L, HOUR), { kind: 'invoice' }), L, plus(L, 2 * HOUR)), true, 'the hosted page counts like the form');
  console.log('launch.test: the deadline rule checked');
}

// ------------------------- 3. no launch on a test key, in preview, or off ---
{
  for (const [name, env] of [
    ['a test key', { ...OFFER_ON, MOYASAR_SECRET_KEY: TEST_KEY, MOYASAR_PUBLISHABLE_KEY: PK_TEST, PRO_PREVIEW_USERS: 'f_test' }],
    ['preview', { ...OFFER_ON, PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'f_test' }],
    ['payments off', { ...OFFER_ON, PRO_PAYMENTS: 'off' }],
    ['Pro off', { ...OFFER_ON, PRO_MODE: 'off' }],
  ] as const) {
    const w = world(env);
    const fan = w.person('f_test');
    await w.asks(fan);
    const r = await w.launch.tick();
    assert.deepEqual([r.held, r.launched, r.sent], ['off', false, 0], name);
    assert.equal(await w.launchRepo.launch(), null, `${name}: no launch is recorded`);
    assert.equal(await w.launchRepo.founder(fan.id), null, `${name}: nobody is a founder`);
    assert.equal(w.tries.length, 0, `${name}: no email is even tried`);
    assert.equal(await w.launch.offerFor(fan.id), null);
    assert.equal(await w.launch.viewFor(fan.id, true), null);
    // The admin's "send now" is the same job: it cannot start a launch either.
    assert.equal((await w.launch.tick(true)).held, 'off', name);
    // Before the launch /admin shows who would be a founder.
    const a = await w.launch.admin();
    assert.deepEqual([a.launchedAt, a.founders.total, a.mail, a.bought], [null, 1, null, null], name);
    // And a purchase in preview with a test key gets no bonus, whatever the switch says.
    if (name === 'a test key') {
      const { order } = await w.buy(fan);
      assert.deepEqual([order.bonusDays, order.testMode, await w.passDays(fan, order.passId)], [0, true, 30]);
    }
  }
  console.log('launch.test: nothing happens on a test key, in preview or while off');
}

// ------------------------------------- 4. the launch and the founders list ---
{
  const w = world();
  const told = w.person('f_told');           // pressed "Tell me when Pro opens"
  const priced = w.person('f_priced');       // answered the price question
  const both = w.person('f_both');
  const wont = w.person('f_wont');           // answered "not for me": still told they would hear first
  const unverified = w.person('f_unverified', { verified: false });
  const noMail = w.person('f_nomail', { email: null, verified: false });
  const stranger = w.person('f_stranger');
  const late = w.person('f_late');
  await w.asks(told);
  await w.answers(priced);
  await w.asks(both);
  await w.answers(both, 20);
  await w.answers(both, 25); // a changed answer is still one account
  await w.answers(wont, 0);
  await w.asks(unverified);
  await w.asks(noMail);
  // A guest's answer has no account behind it.
  await w.proRepo.putPriceAnswer({ voter: `d:${'a'.repeat(64)}`, userId: null, amount: 10, currency: 'SAR', lang: 'ar', comment: null, wontPay: false, source: 'page', absorb: null, max: 1000 });

  const before = await w.launch.admin();
  assert.deepEqual([before.founders.total, before.founders.notify, before.founders.price, before.founders.both], [4, 1, 2, 1], 'the preview counts each account once, verified emails only');
  assert.equal(await w.launchRepo.launch(), null, 'looking at the preview records nothing');

  const r1 = await w.launch.tick();
  assert.deepEqual([r1.launched, r1.sent, r1.failed, r1.held], [true, 4, 0, null]);
  const l = (await w.launchRepo.launch())!;
  assert.equal(l.launchedAt, T0.toISOString(), 'the launch moment is the server clock when Pro was first found on sale');
  for (const [p, source] of [[told, 'notify'], [priced, 'price'], [both, 'both'], [wont, 'price']] as const) {
    assert.equal((await w.launchRepo.founder(p.id))?.source, source, p.username);
  }
  for (const p of [unverified, noMail, stranger]) assert.equal(await w.launchRepo.founder(p.id), null, `${p.username} is not a founder`);
  assert.deepEqual(w.mails.map((m) => m.email).sort(), [both, priced, told, wont].map((p) => p.email).sort(), 'one email each, to the account\'s own address');

  // Recorded once: later runs, a second server and a "restart" all read the same moment and add nobody.
  w.forward(5 * 60_000);
  await w.asks(late);          // asked after the launch
  w.people.get(unverified.id)!.emailVerified = true; // verified after the launch
  const second = w.makeLaunch();
  const [a, b, c] = await Promise.all([w.launch.tick(), second.tick(), w.makeLaunch().tick()]);
  assert.deepEqual([a.launched, b.launched, c.launched, a.sent + b.sent + c.sent], [false, false, false, 0]);
  assert.equal((await w.launchRepo.launch())!.launchedAt, T0.toISOString(), 'a restart does not reset the launch moment');
  assert.equal((await w.launchRepo.begin(w.state.now)).first, false);
  assert.equal(await w.launchRepo.founder(late.id), null, 'the list is the one taken at the launch');
  assert.equal(await w.launchRepo.founder(unverified.id), null);
  assert.equal(w.mails.length, 4, 'and nobody is emailed again');
  for (let i = 0; i < 5; i++) await w.launch.tick(true);
  assert.equal(w.mails.length, 4, '"send now" sends nothing to an account that has had it');

  const after = await w.launch.admin();
  assert.deepEqual([after.founders.total, after.mail, after.bought, after.ended], [4, { sent: 4, waiting: 0, failed: 0, unknown: 0, skipped: 0 }, { inTime: 0, refunded: 0 }, false]);
  assert.equal(after.deadline, new Date(T0.getTime() + 72 * HOUR).toISOString());
  console.log('launch.test: the launch is recorded once and the founders are the list at that moment');
}

// ------------------------------------------------- 5. the email, only once ---
{
  // The mail service is down at the launch: nothing is lost, nothing is doubled.
  const w = world();
  for (const n of ['m_a', 'm_b', 'm_c']) await w.asks(w.person(n));
  w.state.mailUp = false;
  const down = await w.launch.tick();
  assert.deepEqual([down.launched, down.sent, down.failed], [true, 0, 3]);
  assert.equal((await w.launch.admin()).mail!.failed, 3);
  w.state.mailUp = true;
  const up = await w.launch.tick();
  assert.deepEqual([up.sent, up.failed], [3, 0], 'sent on the next run');
  assert.equal(w.mails.length, 3);
  assert.equal((await w.launch.tick()).sent, 0);
  // Tries run out: it stops by itself, and "send now" gives it another set.
  const w2 = world();
  const stuck = w2.person('m_stuck');
  await w2.asks(stuck);
  w2.state.mailUp = false;
  for (let i = 0; i < MAIL_TRIES + 3; i++) await w2.launch.tick();
  assert.equal(w2.tries.length, MAIL_TRIES, `a refused send is tried ${MAIL_TRIES} times, not for ever`);
  w2.state.mailUp = true;
  assert.equal((await w2.launch.tick()).sent, 0, 'out of tries: the job leaves it');
  assert.equal((await w2.launch.tick(true)).sent, 1, 'the admin\'s "send now" tries again');
  assert.equal((await w2.launch.tick(true)).sent, 0, 'once');
  assert.equal(w2.mails.length, 1);

  // Email that is not really being delivered (no mail key): nothing is marked sent.
  const w3 = world();
  const waits = w3.person('m_waits');
  await w3.asks(waits);
  w3.state.mailLive = false;
  const held = await w3.launch.tick();
  assert.deepEqual([held.launched, held.held, held.sent], [true, 'mail', 0], 'the launch is recorded; the email waits for real delivery');
  assert.equal(w3.tries.length, 0);
  w3.state.mailLive = true;
  assert.equal((await w3.launch.tick()).sent, 1);

  // Two servers send at the same moment: one copy each.
  const w4 = world();
  const many = await Promise.all(Array.from({ length: 25 }, async (_, i) => { const p = w4.person(`m_many${i}`); await w4.asks(p); return p; }));
  const other = w4.makeLaunch();
  for (let i = 0; i < 6; i++) await Promise.all([w4.launch.tick(), other.tick(), w4.makeLaunch().tick()]);
  assert.equal(w4.mails.length, many.length, 'every founder is emailed');
  assert.equal(new Set(w4.mails.map((m) => m.userId)).size, many.length, 'and none twice');

  // A server that stops between taking a founder and sending: that founder is "not known", and is not sent again.
  const w5 = world();
  const lost = w5.person('m_lost');
  await w5.asks(lost);
  await w5.launchRepo.begin(w5.state.now);
  assert.equal(await w5.launchRepo.claimMail(lost.id, w5.state.now), true);
  assert.equal(await w5.launchRepo.claimMail(lost.id, w5.state.now), false, 'a claim is taken once');
  for (let i = 0; i < 3; i++) await w5.launch.tick(true);
  assert.equal(w5.mails.length, 0, 'never a second copy, even at the cost of the first');
  assert.equal((await w5.launch.admin()).mail!.unknown, 1);

  // Asked for no such emails, or the address went, between the launch and the send.
  const w6 = world();
  const stopped = w6.person('m_stopped');
  const gone = w6.person('m_gone');
  const fine = w6.person('m_fine');
  for (const p of [stopped, gone, fine]) await w6.asks(p);
  w6.state.mailLive = false;
  await w6.launch.tick();
  const token = (await w6.launchRepo.founder(stopped.id))!.stopToken;
  assert.equal(await w6.launch.stopMail('not-a-token'), false);
  assert.equal(await w6.launch.stopMail('x'.repeat(32)), false, 'a token that is nobody\'s stops nothing');
  assert.equal(await w6.launch.stopMail(token), true);
  assert.equal(await w6.launch.stopMail(token), true, 'pressing it twice is fine');
  w6.people.get(gone.id)!.email = null;
  w6.state.mailLive = true;
  const r6 = await w6.launch.tick();
  assert.deepEqual([r6.sent, r6.skipped], [1, 2]);
  assert.deepEqual(w6.mails.map((m) => m.userId), [fine.id]);
  assert.equal((await w6.launch.tick(true)).sent, 0, 'a skipped founder stays skipped');
  assert.equal((await w6.launch.admin()).mail!.skipped, 2);

  // After the offer's deadline the email about it is not sent.
  const w7 = world();
  const tardy = w7.person('m_tardy');
  await w7.asks(tardy);
  w7.state.mailLive = false;
  await w7.launch.tick();
  w7.state.mailLive = true;
  w7.forward(72 * HOUR);
  assert.deepEqual([(await w7.launch.tick()).held, (await w7.launch.tick(true)).held, w7.mails.length], ['ended', 'ended', 0]);

  // The day's budget: the job waits rather than spend the allowance other emails need.
  const w8 = world();
  for (let i = 0; i < 6; i++) await w8.asks(w8.person(`m_budget${i}`));
  let left = 4;
  const sent: string[] = [];
  const tight = new LaunchService(w8.launchRepo, w8.payRepo, {
    env: PRICED, now: () => w8.state.now, gapMs: 0, isPublic: () => true,
    takeBudget: () => left-- > 0, giveBudget: () => { left++; },
    send: async (f) => { sent.push(f.userId); },
  });
  const r8 = await tight.tick();
  assert.deepEqual([r8.sent, r8.held], [4, 'budget']);
  left = 10;
  assert.equal((await tight.tick()).sent, 2);
  assert.equal(new Set(sent).size, 6);
  console.log('launch.test: the founders email goes once, whatever fails or races');
}

// -------------------------------------------------------- 6. the bonus ---
{
  const w = world();
  const founder = w.person('b_founder');
  const edge = w.person('b_edge');
  const grace = w.person('b_grace');
  const slow = w.person('b_slow');
  const tooLate = w.person('b_late');
  const plain = w.person('b_plain');       // not a founder
  const refunder = w.person('b_refund');
  for (const p of [founder, edge, grace, slow, tooLate, refunder]) await w.asks(p);
  await w.launch.tick();
  const L = T0;
  const D = founderDeadline(L);

  // The offer as the account sees it before paying.
  const view = await w.launch.viewFor(founder.id, true);
  assert.deepEqual(view, { state: 'open', until: D.toISOString(), bonusDays: 30, total: 60 });
  assert.equal(await w.launch.viewFor(founder.id, false), null, 'nothing to say to an account that cannot buy');
  assert.equal(await w.launch.viewFor(plain.id, true), null, 'nor to an account that is not a founder');

  // A founder in the window: 60 days for the launch price, said on the form before paying.
  w.forward(HOUR);
  const c = await w.checkout(founder);
  assert.deepEqual(c.form.founder, { until: D.toISOString(), bonusDays: 30, total: 60 });
  assert.equal(c.form.amount, 1399, 'the launch price is what is charged');
  w.moyasar.formPay(c.form, c.orderId);
  // Moyasar's return, its webhook and the page asking, all at once: one pass, one bonus.
  const seen = await Promise.all([
    w.pay.orderFor(founder.id, c.orderId), w.pay.orderFor(founder.id, c.orderId), w.pay.orderFor(founder.id, c.orderId),
    w.pay.webhook({ secret_token: HOOK, type: 'payment_paid', live: true, data: { id: c.form.givenId, metadata: { order_id: c.orderId } } }),
    w.pay.reconcile((await w.payRepo.get(c.orderId))!),
  ]);
  assert.ok(seen.slice(0, 3).every((o) => (o as { status: string }).status === 'paid'));
  const paid = (await w.payRepo.get(c.orderId))!;
  assert.deepEqual([paid.status, paid.amount, paid.days, paid.bonusDays], ['paid', 1399, 30, 30]);
  assert.equal((await w.proRepo.allPasses(founder.id)).length, 1, 'one pass per paid order');
  assert.equal(await w.passDays(founder, paid.passId), 60, '30 days bought and 30 given');
  assert.deepEqual(await w.launch.viewFor(founder.id, true), { state: 'used', until: D.toISOString(), bonusDays: 30, total: 60, order: paid.id });
  assert.equal(await w.launch.offerFor(founder.id), null, 'the offer is not made twice');

  // Not a founder: the same price, 30 days.
  const p1 = await w.buy(plain);
  assert.deepEqual([p1.form.founder, p1.order.amount, p1.order.bonusDays, await w.passDays(plain, p1.order.passId)], [null, 1399, 0, 30]);

  // Confirmed a second before the deadline.
  w.at(new Date(D.getTime() - 1000));
  const e = await w.buy(edge);
  assert.deepEqual([e.order.bonusDays, await w.passDays(edge, e.order.passId)], [30, 60], 'just before the deadline');

  // Paid at 71:59, confirmed a little after the deadline: the order was made in time.
  w.at(new Date(D.getTime() - 60_000));
  const g = await w.checkout(grace);
  assert.ok(g.form.founder, 'the offer was shown before paying');
  const s = await w.checkout(slow);
  w.moyasar.formPay(g.form, g.orderId);
  w.at(new Date(D.getTime() + 25 * 60_000));
  const gPaid = (await w.pay.orderFor(grace.id, g.orderId))!;
  assert.deepEqual([gPaid.status, gPaid.bonusDays, await w.passDays(grace, gPaid.passId)], ['paid', 30, 60], 'the bank took its time; the founder is not punished for it');
  // The same order left open and paid hours later is not in time.
  w.moyasar.formPay(s.form, s.orderId);
  w.at(new Date(D.getTime() + FOUNDER_GRACE_HOURS * HOUR + 60_000));
  const sPaid = (await w.pay.orderFor(slow.id, s.orderId))!;
  assert.deepEqual([sPaid.status, sPaid.bonusDays, await w.passDays(slow, sPaid.passId)], ['paid', 0, 30], 'past the grace: a month, and no bonus');

  // Just after the deadline: no offer shown, none given.
  w.at(new Date(D.getTime() + 1000));
  assert.equal(await w.launch.viewFor(tooLate.id, true), null);
  const t = await w.buy(tooLate);
  assert.deepEqual([t.form.founder, t.order.bonusDays, await w.passDays(tooLate, t.order.passId)], [null, 0, 30], 'just after the deadline');

  // A second purchase by a founder who had the bonus: 30 days.
  w.at(new Date(L.getTime() + 2 * HOUR));
  const again = w.person('b_again');
  // (made a founder directly, in a world of its own, to buy twice inside the window)
  const w2 = world();
  await w2.asks(again);
  w2.people.set(again.id, again);
  await w2.launch.tick();
  const first = await w2.buy(again);
  assert.equal(first.order.bonusDays, 30);
  w2.forward(54 * DAY); // inside the last week of the 60 days, when another month can be added
  const more = await w2.buy(again);
  assert.deepEqual([more.order.bonusDays, more.form.founder], [0, null], 'a second purchase gets no bonus');
  const passes = (await w2.proRepo.allPasses(again.id)).map((p) => Math.round((Date.parse(p.endsAt) - Date.parse(p.startsAt)) / DAY)).sort();
  assert.deepEqual(passes, [30, 60]);

  // A refund ends the pass, the bonus with it, and the bonus is not given again.
  w.at(new Date(L.getTime() + 3 * HOUR));
  const r = await w.buy(refunder);
  assert.equal(r.order.bonusDays, 30);
  assert.equal(await w.hasPro(refunder), true);
  assert.equal((await w.pay.refund(r.order.id)).ok, true);
  assert.equal(await w.hasPro(refunder), false, 'the refund ended all 60 days');
  assert.ok((await w.proRepo.allPasses(refunder.id)).every((p) => p.revokedAt), 'no pass is left');
  assert.equal(await w.launch.viewFor(refunder.id, true), null, 'nothing is shown as a founder benefit after the refund');
  w.forward(HOUR);
  const r2 = await w.buy(refunder);
  assert.deepEqual([r2.form.founder, r2.order.bonusDays, await w.passDays(refunder, r2.order.passId)], [null, 0, 30], 'once per account, ever: not again after a refund');

  // /admin: who bought in time, and who was refunded.
  const adm = await w.launch.admin();
  assert.deepEqual(adm.bought, { inTime: 3, refunded: 1 });
  assert.equal(adm.founders.rows.find((x) => x.username === 'b_founder')?.bought, true);

  // A gift and a month given by hand are not orders: no bonus is ever attached to them.
  const gifted = w.person('b_gifted');
  await w.proRepo.grantPass({ userId: gifted.id, plan: 'monthly', startsAt: w.state.now, endsAt: new Date(w.state.now.getTime() + 30 * DAY), source: 'admin', createdBy: null });
  assert.equal(Math.round((Date.parse((await w.proRepo.allPasses(gifted.id))[0].endsAt) - w.state.now.getTime()) / DAY), 30);
  console.log('launch.test: the bonus is given in time, once, and goes with a refund');
}

// ---------------------- 7. two orders of one founder confirmed at once ---
{
  const w = world();
  const fan = w.person('race_fan');
  await w.asks(fan);
  await w.launch.tick();
  w.forward(HOUR);
  const mk = () => w.payRepo.create({ userId: fan.id, amount: 1399, days: 30, lang: 'en', testMode: false, now: w.state.now, kind: 'form', paymentId: randomUUID() });
  const orders = await Promise.all([mk(), mk(), mk(), mk()]);
  const start = w.state.now;
  const results = await Promise.all(orders.map((o) => w.payRepo.markPaid(o.id, { paymentId: o.paymentId!, method: 'creditcard', now: start, startsAt: start, endsAt: new Date(start.getTime() + 30 * DAY), bonusDays: 30 })));
  const got = results.map((r) => (r.ok ? r.order.bonusDays : -1));
  assert.deepEqual(got.slice().sort((a, b) => a - b), [0, 0, 0, 30], 'four paid orders at once: one bonus');
  // And the same order marked paid many times is one pass.
  const again = await Promise.all(Array.from({ length: 6 }, () => w.payRepo.markPaid(orders[0].id, { paymentId: orders[0].paymentId!, method: 'creditcard', now: start, startsAt: start, endsAt: new Date(start.getTime() + 30 * DAY), bonusDays: 30 })));
  assert.ok(again.every((r) => r.ok && !r.first));
  assert.equal((await w.proRepo.allPasses(fan.id)).length, 4);
  // The switch off: no offer, no bonus, whatever the list says.
  const w2 = world(OFFER_OFF);
  const quiet = w2.person('race_quiet');
  await w2.asks(quiet);
  await w2.launch.tick();
  assert.ok(await w2.launchRepo.founder(quiet.id), 'still a founder, and still emailed');
  assert.equal(w2.mails.length, 1);
  assert.equal(await w2.launch.viewFor(quiet.id, true), null);
  const q = await w2.buy(quiet);
  assert.deepEqual([q.form.founder, q.order.bonusDays, q.order.amount], [null, 0, 1999], 'with the offer off (and no launch date) a month is a month at the regular price');
  console.log('launch.test: one bonus per account under any race, and none while the offer is off');
}

// ------------------------------------ 8. a founder already holding Pro ---
{
  const w = world();
  const holder = w.person('held_founder');
  const other = w.person('held_plain');
  await w.asks(holder);
  for (const p of [holder, other]) await w.proRepo.grantPass({ userId: p.id, plan: 'monthly', startsAt: w.state.now, endsAt: new Date(w.state.now.getTime() + 20 * DAY), source: 'admin', createdBy: null });
  await w.launch.tick();
  w.forward(HOUR);
  const refused = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
  assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, 'held'], 'anyone else holding a long pass is told to come back in its last week');
  const { order } = await w.buy(holder);
  const pass = (await w.proRepo.allPasses(holder.id)).find((p) => p.id === order.passId)!;
  assert.equal(order.bonusDays, 30);
  assert.equal(Date.parse(pass.startsAt), T0.getTime() + 20 * DAY, 'the bought month starts when the Pro they hold ends');
  assert.equal(Math.round((Date.parse(pass.endsAt) - Date.parse(pass.startsAt)) / DAY), 60);
  console.log('launch.test: a founder who already holds Pro can still take the offer');
}

// ------------------------------- 9. auto-renew: 19.99, after the 60 days ---
{
  const w = world(RENEW);
  const fan = w.person('rn_founder');
  const plain = w.person('rn_plain');
  await w.asks(fan);
  await w.launch.tick();
  w.forward(HOUR);
  const start = w.state.now;
  const c = await w.checkout(fan);
  assert.deepEqual([c.form.amount, c.form.renew?.price, c.form.renew?.days], [1399, 19.99, 30], '13.99 now, then 19.99 every 30 days: both said before paying');
  assert.equal(c.form.renew!.nextAt, new Date(start.getTime() + 60 * DAY).toISOString(), 'a founder\'s first renewal date is after the 60 days');
  const order0 = (await w.payRepo.get(c.orderId))!;
  assert.equal(order0.keep, false, 'auto-renew is never ticked for the fan');
  assert.equal(await w.pay.setKeep(fan.id, c.orderId, true), true);
  w.moyasar.formPay(c.form, c.orderId, { save: true });
  const paid = (await w.pay.orderFor(fan.id, c.orderId))!;
  assert.deepEqual([paid.amount, paid.bonusDays], [1399, 30]);
  const sub = (await w.payRepo.subFor(fan.id))!;
  assert.deepEqual([sub.status, sub.amount, sub.days], ['active', 1999, 30], 'renewals are the regular price');
  assert.equal(sub.nextChargeAt, new Date(start.getTime() + 60 * DAY).toISOString(), 'the first renewal is due when the 60 days end');
  // Someone who is not a founder: first renewal after 30 days, at 19.99 too.
  const cp = await w.checkout(plain);
  assert.equal(cp.form.renew!.nextAt, new Date(w.state.now.getTime() + 30 * DAY).toISOString());

  // Nothing at day 30.
  w.at(new Date(start.getTime() + 30 * DAY + HOUR));
  const mid = await w.pay.runRenewals();
  assert.deepEqual([mid.reminded, mid.charged, w.moyasar.charges.length], [0, 0, 0], 'nothing is charged, or even announced, after 30 days');
  assert.equal(await w.hasPro(fan), true);
  // The reminder three days before day 60, saying it is the first renewal after 60 days and what it costs.
  w.at(new Date(start.getTime() + 57 * DAY + HOUR));
  const rem = await w.pay.runRenewals();
  assert.deepEqual([rem.reminded, rem.charged], [1, 0]);
  const n = w.notices.find((x) => x.kind === 'reminder' && x.sub.userId === fan.id)!;
  assert.ok(n.kind === 'reminder' && n.firstDays === 60, 'the reminder knows this follows a founder\'s 60 days');
  const mail = renewEmail({ notice: n, to: fan.email!, base: 'https://tifomaker.test', contact: 'owner@example.test' });
  assert.ok(mail.html.includes('SAR 19.99') && mail.html.includes('19.99 ريال'), 'the reminder states 19.99');
  assert.ok(!mail.html.includes('13.99'), 'and never the launch price');
  assert.ok(/Your first 60 days/.test(mail.html) && mail.html.includes('أول 60 يوم'), 'and that the 60 days end that day');
  // The charge once the 60 days are over (the reminder went out a little under three days before day 60, so the
  // renewal moved to exactly three days after it, as the promise has it): 19.99, once.
  w.at(new Date(start.getTime() + 60 * DAY + 60_000));
  assert.equal((await w.pay.runRenewals()).charged, 0, 'never sooner than three days after the reminder');
  w.at(new Date(start.getTime() + 60 * DAY + 2 * HOUR));
  const ch = await w.pay.runRenewals();
  await w.pay.runRenewals();
  assert.deepEqual([ch.charged, w.moyasar.charges.length, w.moyasar.charges[0].amount], [1, 1, 1999], 'one renewal charge, at the regular price');
  const renewal = (await w.payRepo.recentFor(fan.id, new Date(0))).find((o) => o.kind === 'renewal')!;
  assert.deepEqual([renewal.status, renewal.amount, renewal.bonusDays, await w.passDays(fan, renewal.passId)], ['paid', 1999, 0, 30], 'a renewal is 30 days and carries no bonus');
  // The next reminder is an ordinary one.
  w.at(new Date(start.getTime() + 87 * DAY + 4 * HOUR));
  await w.pay.runRenewals();
  const n2 = w.notices.filter((x) => x.kind === 'reminder' && x.sub.userId === fan.id)[1];
  assert.ok(n2 && n2.kind === 'reminder' && n2.firstDays === undefined);
  console.log('launch.test: auto-renew is 19.99, and a founder\'s first renewal comes after the 60 days');
}

// ------------------------------------------- 10. the launch price ends ---
{
  const w = world(PRICED);
  const early = w.person('p_early');
  const lateBuyer = w.person('p_late');
  const between = w.person('p_between');
  w.at(new Date('2027-01-14T20:30:00Z')); // half an hour before it ends
  const e = await w.buy(early);
  assert.equal(e.order.amount, 1399);
  // An order made at the launch price and paid after it ended keeps the price it showed.
  const c = await w.checkout(between);
  assert.equal(c.form.amount, 1399);
  w.at(new Date('2027-01-14T21:10:00Z'));
  w.moyasar.formPay(c.form, c.orderId);
  assert.deepEqual([(await w.pay.orderFor(between.id, c.orderId))!.status, (await w.payRepo.get(c.orderId))!.amount], ['paid', 1399]);
  // A new order after it: the regular price, with nobody having touched anything.
  const l = await w.buy(lateBuyer);
  assert.equal(l.order.amount, 1999);
  // An open order from before is not reused at the old price for a new press.
  const stale = w.person('p_stale');
  w.at(new Date('2027-01-14T20:50:00Z'));
  const c1 = await w.checkout(stale);
  w.at(new Date('2027-01-14T21:05:00Z'));
  const c2 = await w.checkout(stale);
  assert.deepEqual([c1.form.amount, c2.form.amount, c1.orderId === c2.orderId], [1399, 1999, false], 'a fresh press after the change makes a new order at the new price');
  console.log('launch.test: the launch price ends by itself');
}

// --------------------------------------------- 11. the emails and /legal ---
{
  const base = { to: 'founder@example.test', base: 'https://tifomaker.test', contact: 'owner@example.test', stopUrl: 'https://tifomaker.test/pro?nomail=tok', stopPost: 'https://tifomaker.test/api/pro/mail/stop?t=tok' };
  const deadline = '2026-12-04T09:00:00.000Z'; // 12:00 in Riyadh
  const m = founderEmail({ ...base, price: 1399, regular: 1999, launchUntil: '2027-01-14T21:00:00.000Z', offer: { deadline, bonusDays: 30 }, autoRenew: true });
  assert.ok(/Pro is open/.test(m.subject) && /برو انفتح/.test(m.subject));
  for (const part of [m.html, m.text!]) {
    assert.ok(part.includes('4 December 2026') && part.includes('12:00') && part.includes('Riyadh time'), 'the exact deadline, in Riyadh time');
    assert.ok(part.includes('60 days for the price of 30'), 'the offer');
    assert.ok(part.includes('SAR 13.99') && part.includes('SAR 19.99') && part.includes('15 January 2027'), 'the price, and when it changes');
    assert.ok(part.includes('13.99 ريال') && part.includes('بتوقيت الرياض'), 'in Arabic too');
    assert.ok(part.includes('FL-216888773') && /no VAT/i.test(part), 'who sells it, and that no VAT is charged');
    assert.ok(part.includes('https://tifomaker.test/pro?nomail=tok'), 'the stop link');
    assert.ok(!/\b(discount|sale price|% off|was SAR)\b/i.test(part) && !part.includes('خصم') && !part.includes('تخفيض'), 'no discount wording');
  }
  assert.ok(m.html.includes('href="https://tifomaker.test/pro"') && m.html.includes('href="https://tifomaker.test/ar/pro"'), 'a button to /pro in each language');
  assert.ok(m.html.includes('dir="rtl"') && m.html.indexOf('dir="rtl"') < m.html.indexOf('dir="ltr" lang="en"'), 'Arabic first, like the receipt');
  assert.ok(!/<s\b|<del\b|line-through/i.test(m.html), 'no crossed-out price');
  assert.ok(/once per|once,|مرة وحدة/.test(m.html) && /refunded, the free days go with it/.test(m.html), 'the terms');
  assert.deepEqual(m.headers, { 'List-Unsubscribe': '<https://tifomaker.test/api/pro/mail/stop?t=tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.ok(m.html.includes('you asked to hear when Pro opens') && !m.html.includes('your address was used for an account'), 'why they are getting it');
  // Without the offer: the news and the price, and no word of an offer or a deadline.
  const plain = founderEmail({ ...base, price: 1999, regular: 1999, launchUntil: null, offer: null, autoRenew: false });
  assert.ok(!/founders offer|extra month|60 days|هدية|عرض المؤسسين/.test(plain.html + plain.text) && plain.html.includes('SAR 19.99') && !plain.html.includes('13.99'));
  assert.ok(/does not renew by itself/.test(plain.html));

  // The receipt of a founder's order: what was bought, what was given, what the renewal will cost.
  const order = {
    id: randomUUID(), userId: 'u', amount: 1399, currency: 'SAR' as const, days: 30, lang: 'en' as const, testMode: false, status: 'paid' as const,
    invoiceId: null, invoiceUrl: null, paymentId: randomUUID(), method: 'creditcard', passId: 'p', note: null, createdAt: T0.toISOString(), paidAt: T0.toISOString(),
    refundedAt: null, refunded: 0, kind: 'form' as const, keep: true, keepAt: T0.toISOString(), attemptedAt: null, subscriptionId: null, cycle: null, fail: null,
    brand: 'visa', refundMailAt: null, refundSeenAt: null, bonusDays: 30, product: 'monthly' as const, src: null,
  };
  const rc = receiptEmail({ order, to: 'f@example.test', endsAt: new Date(T0.getTime() + 60 * DAY).toISOString(), base: 'https://tifomaker.test', contact: 'owner@example.test', renew: { nextAt: new Date(T0.getTime() + 60 * DAY).toISOString(), cancelUrl: 'https://tifomaker.test/pro?stop=x', amount: 1999 } });
  assert.ok(rc.html.includes('30 days + 30 founder days free (60 days in all)') && rc.html.includes('30 يوم هدية المؤسسين'), 'the receipt shows the bonus');
  assert.ok(rc.html.includes('Amount: SAR 13.99') && rc.html.includes('SAR 19.99 will be charged on 30 January 2027'), 'what was paid, and what the renewal costs');
  assert.ok(/no VAT is charged/.test(rc.html));
  const rc0 = receiptEmail({ order: { ...order, bonusDays: 0, keep: false }, to: 'f@example.test', endsAt: null, base: 'https://tifomaker.test', contact: 'owner@example.test' });
  assert.ok(!/founder/.test(rc0.html) && rc0.html.includes('30 days (one payment, no auto-renewal)'));

  // /legal: each block only when it is true.
  const html = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  const off = payLegal(html, false, false, { launch: { price: 1399, regular: 1999, until: '2027-01-14T21:00:00.000Z' }, founders: true });
  assert.ok(!/launch price|founders offer|سعر الإطلاق|عرض المؤسسين|No VAT/.test(off) && !off.includes('{{'), 'nothing about the launch is served while Pro is not on sale');
  const sale = payLegal(html, true, true);
  assert.ok(!/The launch price|The founders offer/.test(sale) && /No VAT is charged/.test(sale) && sale.includes('FL-216888773') && !sale.includes('{{'));
  const full = payLegal(html, true, true, { launch: { price: 1399, regular: 1999, until: '2027-01-14T21:00:00.000Z' }, founders: true });
  assert.ok(full.includes('before 15 January 2027 (Riyadh time), a month of Pro costs SAR 13.99') && full.includes('From that date the price is SAR 19.99'));
  assert.ok(full.includes('قبل 15 يناير 2027') && full.includes('بـ13.99 ريال') && full.includes('السعر 19.99 ريال'), 'the Arabic terms carry the same numbers');
  assert.ok(/within 72 hours/.test(full) && /once per account/.test(full) && /خلال 72 ساعة/.test(full) && /مرة وحدة لكل حساب/.test(full));
  assert.ok(!full.includes('{{') && !full.includes('<template data-pay'), 'every placeholder is filled');
  assert.ok(!/which today is nothing/.test(full));
  console.log('launch.test: the founders email, the receipt and /legal checked');
}

// --------------------------------------------------- 12. over the routes ---
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: generateSeatMap(DEFAULT_TEMPLATE).count }];
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<void> { this.sent.push(m); }
}
async function reg(app: FastifyInstance, u: string): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'quartz-lantern-echo7', email: `${u}@example.test`, acceptedVersion: 'test' } });
  assert.equal(r.statusCode < 300, true, `register ${u}: ${r.body}`);
  const token = (r.json() as { token: string }).token;
  const id = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  return { token, id };
}
const ALL_OFF = {
  PRO_MODE: undefined, PRO_PREVIEW_USERS: undefined, PRO_PAYMENTS: undefined, MOYASAR_SECRET_KEY: undefined, MOYASAR_WEBHOOK_SECRET: undefined,
  MOYASAR_PUBLISHABLE_KEY: undefined, PRO_CHECKOUT: undefined, MOYASAR_VERIFY: undefined, PRO_AUTORENEW: undefined, PRO_AUTORENEW_MADA: undefined,
  MOYASAR_PROXY_URL: undefined, MOYASAR_METHODS: undefined, PRO_AUTO_REFUND: undefined,
  PRO_LAUNCH_PRICE_UNTIL: undefined, PRO_PRICE_DISPLAY: undefined, PRO_DISCOUNT_LICENCE: undefined, PRO_FOUNDERS_BONUS: undefined,
};
const restore = setEnv(ALL_OFF);
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const proRepo = new MemoryProRepository((id) => auth.usernameOf(id));
  const payRepo = new MemoryPaymentRepository(proRepo, (id) => auth.usernameOf(id));
  const launchRepo = memoryLaunch(proRepo, payRepo, (id) => {
    const u = [...auth.users.values()].find((x) => x.id === id);
    return u ? { username: u.username, email: u.email, verified: !!u.emailVerifiedAt } : null;
  });
  const moyasar = new FakeMoyasar();
  const outbox = new Outbox();
  const clock = { now: new Date() };
  const app = await buildApp(designs, auth, templates, {
    social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
    aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
    pro: proRepo, payments: payRepo, launch: launchRepo, launchGapMs: 0, launchNow: () => clock.now, moyasar, emailSender: outbox, publicUrl: 'https://tifomaker.test',
    adminUsernames: ['boss_launch'], aiAdminPassword: 'launch admin password',
  });
  const fan = await reg(app, 'l_fan');
  const other = await reg(app, 'l_other');
  for (const u of [fan, other]) await auth.markEmailVerified(u.id);
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'launch admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };
  const post = (url: string, token: string | null, payload: object = {}) => app.inject({ method: 'POST', url, ...(token ? { headers: bearer(token) } : {}), payload });
  const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, ...(token ? { headers: bearer(token) } : {}) });
  const boss = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: asBoss, ...(payload ? { payload } : {}) });
  const proOf = async (token: string | null) => (await get('/api/pro', token)).json() as Record<string, any>;

  // "Tell me when Pro opens", while everything is off.
  assert.equal((await post('/api/pro/notify', fan.token)).statusCode, 200);
  assert.equal((await boss('POST', '/api/admin/pro/launch/send')).json().held, 'off', 'the admin cannot start a launch while Pro is not on sale');
  assert.equal(outbox.sent.filter((m) => /Pro is open/.test(m.subject)).length, 0);
  const pre =(await boss('GET', '/api/admin/pro/launch')).json();
  assert.deepEqual([pre.launchedAt, pre.public, pre.founders.total, pre.founders.rows[0].username, pre.price.now, pre.window.bonusOn], [null, false, 1, 'l_fan', 19.99, true]);
  assert.ok(/Pro is open/.test(pre.email.subject), 'the preview carries the email as it would go');
  for (const url of ['/api/admin/pro/launch', '/api/admin/pro/launch/email']) {
    assert.equal((await get(url, fan.token)).statusCode, 403, `${url} is the admin's`);
    assert.equal((await get(url, null)).statusCode, 403);
  }
  assert.equal((await post('/api/admin/pro/launch/send', fan.token)).statusCode, 403);
  const prev = await boss('GET', '/api/admin/pro/launch/email?offer=1');
  assert.ok(prev.statusCode === 200 && /text\/html/.test(String(prev.headers['content-type'])) && /default-src 'none'/.test(String(prev.headers['content-security-policy'])));
  assert.ok(prev.body.includes('60 days for the price of 30') && !(await boss('GET', '/api/admin/pro/launch/email?offer=0')).body.includes('60 days'));
  assert.ok(!('founder' in (await proOf(fan.token))), 'nothing about founders is said before the launch');

  // On sale for real, with the launch price and the offer.
  const day = new Date(clock.now.getTime() + 40 * DAY).toISOString().slice(0, 10);
  const live = setEnv({ ...RENEW, PRO_LAUNCH_PRICE_UNTIL: day });
  try {
    const sent = (await boss('POST', '/api/admin/pro/launch/send')).json();
    assert.deepEqual([sent.launched, sent.sent], [true, 1]);
    assert.equal(outbox.sent.filter((m) => /Pro is open/.test(m.subject)).length, 1);
    const mail = outbox.sent.find((m) => /Pro is open/.test(m.subject))!;
    assert.equal(mail.to, 'l_fan@example.test');
    assert.ok(mail.html.includes('SAR 13.99') && mail.html.includes('60 days for the price of 30') && /List-Unsubscribe/.test(Object.keys(mail.headers ?? {}).join()));
    assert.equal((await boss('POST', '/api/admin/pro/launch/send')).json().sent, 0, 'once per account');
    assert.equal(outbox.sent.filter((m) => /Pro is open/.test(m.subject)).length, 1);

    // What the pages are told.
    const anon = await proOf(null);
    assert.deepEqual([anon.offer.monthly.price, anon.offer.launch.regular, anon.offer.launch.display, anon.offer.renewPrice, 'licence' in anon.offer.launch], [13.99, 19.99, 'plain', 19.99, false]);
    assert.ok(!('founder' in anon));
    const me = await proOf(fan.token);
    assert.deepEqual([me.founder.state, me.founder.bonusDays, me.founder.total, me.offer.monthly.price], ['open', 30, 60, 13.99]);
    assert.ok(!('founder' in (await proOf(other.token))), 'an account that is not a founder is told nothing');

    // The founder buys: the order's own answer, the purchases list and the receipt all show the bonus.
    const c = (await post('/api/pro/pay/checkout', fan.token, { lang: 'en' })).json();
    assert.deepEqual([c.form.amount, c.form.founder.total, c.form.renew.price], [1399, 60, 19.99]);
    moyasar.formPay(c.form, c.order);
    const o = (await get(`/api/pro/pay/order/${c.order}`, fan.token)).json();
    assert.deepEqual([o.status, o.bonusDays, o.days], ['paid', 30, 30]);
    const list = (await get('/api/pro/purchases', fan.token)).json();
    assert.deepEqual([list.orders[0].amount, list.orders[0].days, list.orders[0].bonusDays], [13.99, 30, 30]);
    const receipt = outbox.sent.find((m) => /receipt/.test(m.subject))!;
    assert.ok(receipt.html.includes('30 founder days free') && receipt.html.includes('SAR 13.99'));
    assert.equal((await proOf(fan.token)).founder.state, 'used');
    const adm = (await boss('GET', '/api/admin/pro/launch')).json();
    assert.deepEqual([adm.bought.inTime, adm.mail.sent, adm.founders.rows[0].bought, adm.window.bonusOn, adm.price.now], [1, 1, true, true, 13.99]);
    assert.equal((await boss('GET', '/api/admin/pro/orders')).json().orders[0].bonusDays, 30);

    // "Stop these emails": the link's token, by POST only, from the page or from a mail client.
    const tok = (await launchRepo.founder(fan.id))!.stopToken;
    assert.equal((await app.inject({ method: 'GET', url: `/api/pro/mail/stop?t=${tok}` })).statusCode, 404, 'a GET (a mail scanner following the link) stops nothing');
    assert.equal(await launchRepo.mailStopped(fan.id), false);
    assert.equal((await post('/api/pro/mail/stop', null, { t: 'nope' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/pro/mail/stop?t=${tok}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' })).statusCode < 500, true);
    assert.equal((await post('/api/pro/mail/stop', null, { t: tok })).statusCode, 200);
    assert.equal(await launchRepo.mailStopped(fan.id), true);
  } finally {
    live();
  }
  // Switched off again: the pages go back to saying nothing, and what was given stays.
  assert.ok(!('offer' in (await proOf(null))) || (await proOf(null)).offer?.paymentsOpen !== true);
  await app.close();
  console.log('launch.test: the routes checked');
}
restore();

// ------------------------------------------------- 13. the same on Postgres ---
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  try {
    // The launch is one row for the whole database: this suite starts it clean (a test database only).
    await pool.query('DELETE FROM pro_founders');
    await pool.query('DELETE FROM pro_launch');
    const repo = new PgLaunchRepository(pool);
    const pay = new PgPaymentRepository(pool);
    const tag = randomUUID().slice(0, 8);
    const mkUser = async (name: string, o: { email?: boolean; verified?: boolean } = {}): Promise<string> => {
      const u = `ln_${tag}_${name}`;
      const r = await pool.query(
        `INSERT INTO users (username, password_hash, email, email_verified_at) VALUES ($1, 'x', $2, $3) RETURNING id`,
        [u, o.email === false ? null : `${u}@example.test`, o.email === false || o.verified === false ? null : new Date()],
      );
      return String(r.rows[0].id);
    };
    const told = await mkUser('told');
    const priced = await mkUser('priced');
    const both = await mkUser('both');
    const unverified = await mkUser('unverified', { verified: false });
    const stranger = await mkUser('stranger');
    for (const id of [told, both, unverified]) await pool.query('INSERT INTO pro_notify (user_id) VALUES ($1)', [id]);
    for (const id of [priced, both]) await pool.query(`INSERT INTO pro_price_answers (voter, user_id, amount, currency, lang) VALUES ($1, $2, 15, 'SAR', 'ar')`, [`u:${id}`, id]);
    await pool.query(`INSERT INTO pro_price_answers (voter, user_id, amount, currency, lang) VALUES ($1, NULL, 9, 'SAR', 'ar')`, [`d:${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`]);

    assert.equal(await repo.launch(), null);
    const mine = (rows: { username: string | null }[]) => rows.filter((r) => r.username?.startsWith(`ln_${tag}_`));
    const cand = await repo.candidates(10_000);
    assert.equal(mine(cand.rows).length, 3, 'verified accounts on either list, each once');
    assert.equal(cand.total, cand.notify + cand.price + cand.both);

    // Ten servers record the launch in the same instant: one does, and all read the same moment.
    const now = new Date();
    const begun = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.begin(new Date(now.getTime() + i))));
    assert.equal(begun.filter((b) => b.first).length, 1, 'the launch is recorded once');
    assert.equal(new Set(begun.map((b) => b.launchedAt)).size, 1, 'and every caller reads the same moment');
    assert.equal((await repo.launch())!.launchedAt, begun[0].launchedAt);
    assert.deepEqual([(await repo.founder(told))?.source, (await repo.founder(priced))?.source, (await repo.founder(both))?.source], ['notify', 'price', 'both']);
    assert.equal(await repo.founder(unverified), null);
    assert.equal(await repo.founder(stranger), null);
    const tokens = (await repo.list(10_000)).map((f) => f.stopToken);
    assert.ok(tokens.every((t) => /^[A-Za-z0-9_-]{24,64}$/.test(t)) && new Set(tokens).size === tokens.length, 'every founder has a stop token of their own');
    assert.equal((await repo.founderByStopToken((await repo.founder(told))!.stopToken))?.userId, told);
    // A founder made after the launch is nobody's doing: begin() again adds no one.
    const late = await mkUser('late');
    await pool.query('INSERT INTO pro_notify (user_id) VALUES ($1)', [late]);
    assert.equal((await repo.begin(new Date())).first, false);
    assert.equal(await repo.founder(late), null);

    // The email: twenty callers claim one founder; one gets it.
    const claims = await Promise.all(Array.from({ length: 20 }, () => repo.claimMail(told, now)));
    assert.equal(claims.filter(Boolean).length, 1, 'one claim per founder');
    assert.ok(!(await repo.unsent(10_000, MAIL_TRIES)).some((f) => f.userId === told), 'a claimed founder is not offered again');
    await repo.mailFailed(told, 'resend send failed: 503');
    assert.deepEqual([(await repo.founder(told))!.mailTries, (await repo.founder(told))!.mailClaimedAt], [1, null], 'a refused send is owed again');
    assert.equal(await repo.claimMail(told, now), true);
    await repo.mailSent(told, now);
    assert.equal(await repo.claimMail(told, now), false, 'never after it was sent');
    await repo.mailFailed(told, 'late news');
    assert.ok((await repo.founder(told))!.mailSentAt, 'a failure reported after the send does not undo it');
    assert.equal(await repo.retryFailed() >= 0, true);
    assert.equal(await repo.claimMail(told, now), false, '"send now" cannot send a second copy');
    assert.equal(await repo.mailSkipped(priced, 'stopped', now), true);
    assert.equal(await repo.claimMail(priced, now), false, 'a skipped founder is not sent');
    await repo.stopMail(both, now, 'email link');
    await repo.stopMail(both, now, 'email link');
    assert.deepEqual([await repo.mailStopped(both), await repo.mailStopped(told)], [true, false]);

    // The bonus: eight orders of one founder paid in the same instant; one carries it.
    const mk = async (who: string) => pay.create({ userId: who, amount: 1399, days: 30, lang: 'en', testMode: false, now, kind: 'form', paymentId: randomUUID() });
    const orders = await Promise.all(Array.from({ length: 8 }, () => mk(both)));
    const paidAll = await Promise.all(orders.map((o) => pay.markPaid(o.id, { paymentId: o.paymentId!, method: 'creditcard', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY), bonusDays: 30 })));
    const bonuses = paidAll.map((r) => (r.ok ? r.order.bonusDays : -1)).sort((a, b) => a - b);
    assert.deepEqual(bonuses, [0, 0, 0, 0, 0, 0, 0, 30], 'one bonus per account, whatever is paid at once');
    const winner = paidAll.find((r) => r.ok && r.order.bonusDays === 30)!;
    assert.ok(winner.ok && winner.pass && Math.round((Date.parse(winner.pass.endsAt) - Date.parse(winner.pass.startsAt)) / DAY) === 60, 'its pass is 60 days');
    assert.equal((await repo.founder(both))!.bonusOrderId, winner.ok ? winner.order.id : '');
    // One order marked paid ten times at once: one pass, one bonus.
    const solo = await mk(told);
    const many = await Promise.all(Array.from({ length: 10 }, () => pay.markPaid(solo.id, { paymentId: solo.paymentId!, method: 'creditcard', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY), bonusDays: 30 })));
    assert.equal(many.filter((r) => r.ok && r.first).length, 1);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM pro_passes WHERE user_id = $1', [told])).rows[0].n), 1);
    assert.equal((await pay.get(solo.id))!.bonusDays, 30);
    // An account that is not a founder asks for the bonus and gets none.
    const not = await mk(stranger);
    const np = await pay.markPaid(not.id, { paymentId: not.paymentId!, method: 'creditcard', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY), bonusDays: 30 });
    assert.ok(np.ok && np.order.bonusDays === 0 && np.pass && Math.round((Date.parse(np.pass.endsAt) - Date.parse(np.pass.startsAt)) / DAY) === 30);
    // A refund revokes the 60-day pass, and the claim stays taken.
    assert.equal(await pay.markRefunded(solo.id, 1399, now), true);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM pro_passes WHERE user_id = $1 AND revoked_at IS NULL', [told])).rows[0].n), 0);
    const after = await mk(told);
    const ap = await pay.markPaid(after.id, { paymentId: after.paymentId!, method: 'creditcard', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY), bonusDays: 30 });
    assert.ok(ap.ok && ap.order.bonusDays === 0, 'not again after a refund');
    // The database's own guards.
    await assert.rejects(pool.query(`INSERT INTO pro_launch (id, launched_at) VALUES (false, now())`), 'there is one launch row');
    await assert.rejects(pool.query(`UPDATE pro_orders SET bonus_days = 400 WHERE id = $1`, [after.id]), 'a bonus is at most 60 days');
    await assert.rejects(pool.query(`UPDATE pro_founders SET mail_sent_at = now(), mail_claimed_at = NULL WHERE user_id = $1`, [both]), 'sent means claimed');
    // Deleting the account takes its founder row and its stop with it.
    await pool.query('DELETE FROM users WHERE id = $1', [both]);
    assert.equal(await repo.founder(both), null);
    assert.equal(await repo.mailStopped(both), false);
    console.log('launch.test: the Postgres guards checked');
  } finally {
    await pool.query('DELETE FROM pro_founders').catch(() => {});
    await pool.query('DELETE FROM pro_launch').catch(() => {});
    await pool.end();
  }
} else {
  console.log('launch.test: Postgres skipped (no DATABASE_URL)');
}

void MemoryLaunchRepository;
console.log('launch.test: all assertions passed');
