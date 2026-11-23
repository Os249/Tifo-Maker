/**
 * The turnaround of 22 Nov 2026: the price as a setting, the match pass, the
 * gift that starts by itself and its three emails, and what /api/pro and
 * /admin say about them. docs/pro-turnaround.md has it in plain words.
 *
 * Adversarial where a promise or money is. It tries to get the gift twice,
 * without a verified email, on a throwaway address, after holding Pro and
 * with the switch off; to get an email sent twice, after "stop these emails",
 * or carrying a price to someone who never asked for offers; to buy a match
 * pass at another price, have it renew, carry the founders bonus, or give two
 * passes for one order; and to be charged, on a renewal, more than the price
 * the page shows. Everything is off by default, and that is checked first.
 *
 * Runs on the memory stores, and the stores' own guards again on Postgres
 * when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { GIFT_SOON_HOURS, MemoryProRepository, PgProRepository, giftMailDue } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository } from '../src/payRepo';
import { memoryLaunch, type LaunchAccount } from '../src/launchRepo';
import { ProService, type ProAccount } from '../src/pro';
import { MoyasarError, type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type MoyasarToken, type NewInvoice, type TokenCharge } from '../src/moyasar';
import { PaymentService, payLegal, paymentsPublic, type FormConfig } from '../src/payments';
import { LaunchService, priceAt, priceStatus, regularHalalas } from '../src/proLaunch';
import { GiftMailService } from '../src/proGift';
import { giftEmail } from '../src/proGiftMail';
import { receiptEmail } from '../src/payReceipt';
import { OFFER, PRICE_MAX_HALALAS, autoGiftOn, giftMailsOn, matchPass, monthlyPriceInvalid, monthlyPriceSetting, postOffersOn, readPrice } from '../src/proPlan';
import type { EmailMessage, EmailSender } from '../src/email';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const LIVE_KEY = 'sk_live_FAKEfake1234'; // not a real key, and not one secret-scan.mjs flags
const PK_LIVE = 'pk_live_FAKEfake1234';
const HOOK = 'a-webhook-secret-of-some-length';
const T0 = new Date('2026-12-01T09:00:00Z');

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
  /** The fan pays on the form: `amount` and `currency` can be forced, to try paying something else. */
  formPay(f: FormConfig, orderId: string, o: { save?: boolean; amount?: number; currency?: string } = {}): MoyasarPayment {
    let token: string | null = null;
    if (o.save) {
      token = `token_${randomUUID().replace(/-/g, '')}`;
      this.tokens.set(token, { id: token, status: 'active', brand: 'visa', lastFour: '1111', month: 12, year: 2035 });
    }
    const p: MoyasarPayment = {
      id: f.givenId, status: 'paid', amount: o.amount ?? f.amount, currency: o.currency ?? 'SAR', refunded: 0, sourceType: 'creditcard', company: 'visa',
      token, message: null, responseCode: null, transactionUrl: null, invoiceId: null, metadata: { order_id: orderId },
    };
    this.payments.set(p.id, p);
    return p;
  }
}

const LIVE = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY, MOYASAR_PUBLISHABLE_KEY: PK_LIVE, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: HOOK };

interface Person extends ProAccount { username: string }

/** Pro, payments and the gift's emails on memory stores, sharing one clock the test moves. */
function world(env: Record<string, string> = LIVE, o: { saved?: number } = {}) {
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
  const pro = new ProService(proRepo, { now: () => state.now, savedDesigns: async () => o.saved ?? 0, env });
  let payRef: PaymentService | null = null;
  const launch = new LaunchService(launchRepo, payRepo, { env, now: () => state.now, gapMs: 0, isPublic: () => !!payRef?.on() && paymentsPublic(env), canSend: () => false });
  const pay = new PaymentService(payRepo, pro, moyasar, { env, base: 'https://tifomaker.test', founders: launch, notify: async () => true });
  payRef = pay;
  const sent: { kind: string; to: string; msg: EmailMessage }[] = [];
  const mails = new GiftMailService(proRepo, {
    env, now: () => state.now, gapMs: 0,
    canSend: () => state.mailLive,
    send: async (msg) => {
      if (!state.mailUp) throw new Error('resend send failed: 503');
      sent.push({ kind: /ended/.test(msg.subject) ? 'end' : /end soon/.test(msg.subject) ? 'soon' : 'start', to: msg.to, msg });
    },
    accountOf: async (id) => {
      const p = people.get(id);
      return p ? { email: p.email, emailVerified: p.emailVerified } : null;
    },
    holdsPro: async (id) => (await pro.plan(id)).plan === 'monthly',
    compose: (kind, g, to) => {
      const m = pay.match();
      return giftEmail({
        kind, to, base: 'https://tifomaker.test', contact: 'owner@example.test', days: OFFER.gift.days, endsAt: g.endsAt,
        stopUrl: `https://tifomaker.test/pro?nomail=${g.stopToken}`, stopPost: `https://tifomaker.test/api/pro/mail/stop?t=${g.stopToken}`,
        offer: kind === 'end' && g.offersOk ? { monthly: priceAt(state.now, env).halalas, monthlyDays: 30, match: m.on ? { price: m.halalas, hours: m.days * 24 } : null, autoRenew: false } : null,
      });
    },
  });
  const person = (name: string, p: { verified?: boolean; email?: string | null } = {}): Person => {
    const x: Person = { id: randomUUID(), username: name, email: p.email === undefined ? `${name}@example.test` : p.email, emailVerified: p.verified ?? true };
    people.set(x.id, x);
    return x;
  };
  const buyer = (p: Person) => ({ id: p.id, username: p.username, email: p.email, emailVerified: p.emailVerified });
  const checkout = async (p: Person, product: 'monthly' | 'match' = 'monthly', src: string | null = null) => {
    const c = await pay.checkout(buyer(p), 'en', 'https://tifomaker.test', { product, src });
    assert.ok(c.ok && 'form' in c, `checkout: ${JSON.stringify(c)}`);
    return c;
  };
  const buy = async (p: Person, product: 'monthly' | 'match' = 'monthly', how: { keep?: boolean } = {}) => {
    const c = await checkout(p, product);
    if (how.keep) assert.equal(await pay.setKeep(p.id, c.orderId, true), true);
    moyasar.formPay(c.form, c.orderId, { save: how.keep });
    const order = (await pay.orderFor(p.id, c.orderId))!;
    assert.equal(order.status, 'paid');
    return { order, form: c.form };
  };
  const forward = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  return { state, people, proRepo, payRepo, launchRepo, moyasar, pro, pay, mails, sent, person, buyer, checkout, buy, forward };
}

// ----------------------------------------------------- 1. the settings ---
{
  // Off by default: a deploy changes nothing.
  assert.deepEqual([autoGiftOn({}), giftMailsOn({}), postOffersOn({}), monthlyPriceSetting({}), matchPass({}).on], [false, false, false, null, false]);
  assert.equal(giftMailsOn({ PRO_GIFT_MAILS: 'on' }), false, 'the emails need the automatic gift too');
  assert.equal(giftMailsOn({ PRO_GIFT_MAILS: 'on', PRO_AUTO_GIFT: 'on' }), true);
  for (const [v, h] of [['9.99', 999], ['10', 1000], ['4.5', 450], ['100', 10000], ['1', 100]] as const) assert.equal(readPrice(v), h, v);
  // Not a price, under SAR 1, or over what one payment may be (Moyasar's SAR 100): refused, never sold.
  for (const bad of ['', 'free', '9,99', '0.5', '0', '-5', '100.01', '250', '9.999', '1e2', ' ']) assert.equal(readPrice(bad), null, `"${bad}" is not a price`);
  assert.equal(PRICE_MAX_HALALAS, 10000);
  assert.deepEqual([monthlyPriceInvalid({ PRO_MONTHLY_PRICE: '250' }), monthlyPriceInvalid({ PRO_MONTHLY_PRICE: '9.99' }), monthlyPriceInvalid({})], [true, false, false]);

  // The price is a setting. Unset: the launch price and its date decide, as before.
  const launchEnv = { PRO_LAUNCH_PRICE_UNTIL: '2027-01-15' };
  assert.deepEqual([priceAt(T0, launchEnv).halalas, priceAt(T0, launchEnv).launch, regularHalalas(launchEnv)], [1399, true, 1999]);
  // Set: it IS the price. No launch price beside it, nothing said about a later price, and renewals are at it.
  const priced = { ...launchEnv, PRO_MONTHLY_PRICE: '9.99' };
  const p = priceAt(T0, priced);
  assert.deepEqual([p.halalas, p.regular, p.launch, p.until, p.display, regularHalalas(priced)], [999, 999, false, null, 'plain', 999]);
  assert.deepEqual([priceStatus(T0, priced).setting, priceStatus(T0, priced).now], [true, 9.99]);
  // A setting that cannot be read is ignored: the old prices stand, and /admin is told.
  assert.deepEqual([priceAt(T0, { ...launchEnv, PRO_MONTHLY_PRICE: '999' }).halalas, priceStatus(T0, { PRO_MONTHLY_PRICE: '999' }).settingInvalid], [1399, true]);

  // The match pass: its defaults, its own numbers, and bad ones fall back.
  assert.deepEqual(matchPass({ PRO_MATCH_PASS: 'on' }), { on: true, halalas: 499, days: 3 });
  assert.deepEqual(matchPass({ PRO_MATCH_PASS: 'on', PRO_MATCH_PRICE: '3.99', PRO_MATCH_DAYS: '2' }), { on: true, halalas: 399, days: 2 });
  assert.deepEqual(matchPass({ PRO_MATCH_PASS: 'on', PRO_MATCH_PRICE: '500', PRO_MATCH_DAYS: '0' }), { on: true, halalas: 499, days: 3 });
  assert.equal(matchPass({ PRO_MATCH_PASS: 'yes' }).on, false, 'only "on" is on');
  console.log('turnaround.test: the settings checked');
}

// --------------------------------------------------- 2. the gift, alone ---
{
  // The switch off: exactly the old gift. No saved design, no offer; with one, an offer that waits for Accept.
  const off = world(LIVE);
  const a = off.person('gift_off');
  assert.deepEqual(await off.pro.giftFor(a), { state: 'none' }, 'without a saved design there was no gift, and with the switch off there still is none');
  const offSaved = world(LIVE, { saved: 1 });
  const b = offSaved.person('gift_off_saved');
  assert.deepEqual(await offSaved.pro.giftFor(b), { state: 'offered', days: 7 }, 'the old gift waits to be accepted');
  assert.equal((await offSaved.pro.plan(b.id)).plan, 'free');

  const ON = { ...LIVE, PRO_AUTO_GIFT: 'on' };
  const w = world(ON);
  // A verified email, no saved design at all: Pro for 7 days, by itself, on the first visit.
  const fan = w.person('gift_fan');
  const g1 = await w.pro.giftFor(fan, 'ar');
  assert.ok(g1.state === 'active' && g1.auto === true && g1.welcome === true, JSON.stringify(g1));
  assert.equal(Date.parse((g1 as { endsAt: string }).endsAt) - w.state.now.getTime(), 7 * DAY);
  assert.equal((await w.pro.plan(fan.id)).plan, 'gift');
  assert.deepEqual([(await w.proRepo.gift(fan.id))!.auto, (await w.proRepo.gift(fan.id))!.lang], [true, 'ar']);
  // Asked again, any number of times: the same gift, never another.
  for (let i = 0; i < 3; i++) await w.pro.giftFor(fan);
  assert.equal((await w.proRepo.allPasses(fan.id)).length, 1, 'one pass, however often the page asks');
  // Two visits at once (two tabs): one gift.
  const twin = w.person('gift_twin');
  await Promise.all([w.pro.giftFor(twin), w.pro.giftFor(twin), w.pro.giftFor(twin)]);
  assert.equal((await w.proRepo.allPasses(twin.id)).length, 1, 'two tabs, one gift');

  // Not without a verified email, not on a throwaway address, not with no address at all.
  assert.deepEqual(await w.pro.giftFor(w.person('gift_unverified', { verified: false })), { state: 'none' });
  assert.deepEqual(await w.pro.giftFor(w.person('gift_throwaway', { email: 'someone@yopmail.com' })), { state: 'none' });
  assert.deepEqual(await w.pro.giftFor(w.person('gift_noemail', { email: null })), { state: 'none' });
  // A new account: nothing until the email is verified, then at once.
  const fresh = w.person('gift_fresh', { verified: false });
  assert.equal((await w.pro.giftFor(fresh)).state, 'none');
  fresh.emailVerified = true;
  assert.equal((await w.pro.giftFor(fresh)).state, 'active', 'it starts when the email is verified');

  // Never to an account that has held Pro: bought, or given by hand.
  const paid = w.person('gift_paid');
  await w.buy(paid);
  assert.deepEqual(await w.pro.giftFor(paid), { state: 'none' }, 'a buyer is not given a trial of what they hold');
  const granted = w.person('gift_granted');
  await w.proRepo.grantPass({ userId: granted.id, plan: 'monthly', startsAt: new Date(T0.getTime() - 60 * DAY), endsAt: new Date(T0.getTime() - 30 * DAY), source: 'admin', createdBy: null });
  assert.deepEqual(await w.pro.giftFor(granted), { state: 'none' }, 'nor an account whose Pro has already ended');

  // An offer made before the switch (the old Accept card, never pressed) starts on the next visit.
  const waiting = w.person('gift_waiting');
  await w.proRepo.offerGift(waiting.id, new Date(T0.getTime() - 10 * DAY));
  const g2 = await w.pro.giftFor(waiting);
  assert.ok(g2.state === 'active' && g2.auto === true, 'the old offer starts by itself now');
  // ...but not if its holder bought Pro meanwhile.
  const bought = w.person('gift_waiting_bought');
  await w.proRepo.offerGift(bought.id, new Date(T0.getTime() - 10 * DAY));
  await w.buy(bought);
  assert.deepEqual(await w.pro.giftFor(bought), { state: 'offered', days: 7 }, 'an old offer to someone who has since bought Pro does not start');
  assert.equal((await w.pro.plan(bought.id)).plan, 'monthly');

  // The welcome: said once, on any device.
  assert.equal(await w.pro.giftWelcomed(fan), true);
  assert.equal(await w.pro.giftWelcomed(fan), false, 'the welcome is marked once');
  const g3 = await w.pro.giftFor(fan);
  assert.ok(g3.state === 'active' && g3.welcome === undefined && g3.offersOk === false);
  // "Email me Pro's offers": only its holder's own tick says yes, and it can be unticked.
  assert.equal(await w.pro.giftOffersOk(fan, true), true);
  assert.equal(((await w.pro.giftFor(fan)) as { offersOk?: boolean }).offersOk, true);
  assert.equal(await w.pro.giftOffersOk(fan, false), true);
  assert.equal((await w.proRepo.gift(fan.id))!.offersOkAt, null);
  assert.equal(await w.pro.giftOffersOk(w.person('gift_nobody', { verified: false }), true), false, 'an account with no gift has nothing to tick');

  // What they made with Pro: counted only while the gift is the Pro they hold, by known-looking keys, and bounded.
  assert.equal(await w.pro.giftUsed(fan, ['pexp.item.vertical', 'pro.mark.option', 'pexp.item.vertical']), true);
  assert.equal(await w.pro.giftUsed(fan, ['pexp.item.vertical']), true);
  assert.deepEqual((await w.proRepo.gift(fan.id))!.uses, { 'pexp.item.vertical': 2, 'pro.mark.option': 1 }, 'one count per export, not per mention');
  for (const junk of [null, 'pexp.item.hd', [], [42], ['<script>'], ['a b'], [''], ['x'.repeat(60)], [{ k: 1 }]]) assert.equal(await w.pro.giftUsed(fan, junk), false, `junk is not counted: ${JSON.stringify(junk)}`);
  assert.equal(await w.pro.giftUsed(fan, Array.from({ length: 40 }, (_, i) => `k.item${i}`)), true);
  assert.ok(Object.keys((await w.proRepo.gift(fan.id))!.uses).length <= 12, 'a browser cannot grow the list without end');
  assert.equal(await w.pro.giftUsed(paid, ['pexp.item.vertical']), false, 'a paying member is not on a gift: nothing is counted');

  // It ends by itself after 7 days: back to Free, and nothing made is touched.
  w.forward(7 * DAY + 1000);
  assert.equal((await w.pro.plan(fan.id)).plan, 'free', 'the gift ends by itself');
  const g4 = await w.pro.giftFor(fan);
  assert.ok(g4.state === 'used' && g4.auto === true && g4.endCard === true, JSON.stringify(g4));
  assert.equal((g4 as { made: { items: Record<string, number> } }).made.items['pexp.item.vertical'], 2, 'the end card is told what they made');
  assert.equal(await w.pro.giftUsed(fan, ['pexp.item.hd']), false, 'nothing is counted once it has ended');
  // The end card: once.
  assert.equal(await w.pro.giftEndSeen(fan), true);
  assert.equal(await w.pro.giftEndSeen(fan), false);
  const g5 = await w.pro.giftFor(fan);
  assert.ok(g5.state === 'used' && g5.endCard === undefined, 'the end card is offered once');
  // Once per account, ever: it does not start again, now or later.
  w.forward(90 * DAY);
  assert.equal((await w.pro.giftFor(fan)).state, 'used');
  assert.equal((await w.proRepo.allPasses(fan.id)).length, 1, 'once per account, ever');
  assert.equal((await w.proRepo.acceptGift(fan.id, w.state.now, 7, { auto: true })).ok, false, 'the store itself refuses a second start');
  // An end card nobody opened does not wait for ever.
  const late = w.person('gift_late');
  await w.pro.giftFor(late);
  w.forward(7 * DAY + 15 * DAY);
  assert.equal(((await w.pro.giftFor(late)) as { endCard?: boolean }).endCard, undefined, 'a gift that ended over a fortnight ago says nothing');

  // PRO_MODE off: nobody gets anything, whatever the gift's switch says.
  const dark = world({ ...ON, PRO_MODE: 'off' });
  assert.deepEqual(await dark.pro.giftFor(dark.person('gift_dark')), { state: 'none' });
  // Preview: only the preview's own accounts.
  const prev = world({ ...ON, PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'osamh' });
  assert.equal((await prev.pro.giftFor(prev.person('osamh'))).state, 'active');
  assert.deepEqual(await prev.pro.giftFor(prev.person('somebody')), { state: 'none' });
  console.log('turnaround.test: the automatic gift checked');
}

// ---------------------------------------------------- 3. the gift's emails ---
{
  // When each is due.
  const s = T0.getTime();
  const e = s + 7 * DAY;
  assert.deepEqual([giftMailDue('start', s, e, s + HOUR), giftMailDue('start', s, e, s + 25 * HOUR), giftMailDue('start', s, e, e + 1)], [true, false, false]);
  assert.deepEqual([giftMailDue('soon', s, e, e - 27 * HOUR), giftMailDue('soon', s, e, e - 25 * HOUR), giftMailDue('soon', s, e, e - 2 * HOUR)], [false, true, false]);
  assert.deepEqual([giftMailDue('end', s, e, e - 1), giftMailDue('end', s, e, e + HOUR), giftMailDue('end', s, e, e + 49 * HOUR)], [false, true, false]);
  assert.equal(GIFT_SOON_HOURS, 26);

  const GIFT = { ...LIVE, PRO_AUTO_GIFT: 'on' };
  // The gift on, its emails off: nothing is ever sent.
  const quiet = world(GIFT);
  await quiet.pro.giftFor(quiet.person('mail_quiet'));
  assert.deepEqual(await quiet.mails.tick(), { sent: 0, failed: 0, skipped: 0, held: 'off' });
  quiet.forward(8 * DAY);
  assert.equal((await quiet.mails.tick()).held, 'off');
  assert.equal(quiet.sent.length, 0, 'no email while PRO_GIFT_MAILS is off');

  const MAILS = { ...GIFT, PRO_GIFT_MAILS: 'on' };
  const w = world(MAILS);
  const fan = w.person('mail_fan');
  await w.pro.giftFor(fan);
  // Email is not really being delivered (a console sender): nothing is marked sent.
  w.state.mailLive = false;
  assert.equal((await w.mails.tick()).held, 'mail');
  assert.deepEqual(w.proRepo.giftMailsOf(fan.id), {});
  w.state.mailLive = true;
  // The mail service refuses: nothing went, and it is owed again.
  w.state.mailUp = false;
  assert.deepEqual([(await w.mails.tick()).failed, w.sent.length], [1, 0]);
  assert.deepEqual(w.proRepo.giftMailsOf(fan.id), {}, 'a refused send is not marked as sent');
  w.state.mailUp = true;
  assert.equal((await w.mails.tick()).sent, 1);
  assert.deepEqual(w.sent.map((m) => [m.kind, m.to]), [['start', 'mail_fan@example.test']]);
  // Never twice: the job again, two jobs at once, a restart (a second service on the same store).
  await w.mails.tick();
  await Promise.all([w.mails.tick(), w.mails.tick()]);
  assert.equal(w.sent.length, 1, 'the start email is sent once');
  assert.equal(await w.proRepo.claimGiftMail(fan.id, 'start', w.state.now), false, 'the store gives each email to one caller, ever');
  // Mid-gift: nothing is due.
  w.forward(3 * DAY);
  assert.deepEqual((await w.mails.tick()).sent, 0);
  // About a day before it ends.
  w.forward(3 * DAY);
  assert.deepEqual([(await w.mails.tick()).sent, w.sent.at(-1)!.kind], [1, 'soon']);
  await w.mails.tick();
  assert.equal(w.sent.length, 2);
  // When it has ended.
  w.forward(DAY + HOUR);
  assert.deepEqual([(await w.mails.tick()).sent, w.sent.at(-1)!.kind], [1, 'end']);
  await w.mails.tick();
  w.forward(30 * DAY);
  await w.mails.tick();
  assert.deepEqual(w.sent.map((m) => m.kind), ['start', 'soon', 'end'], 'three emails in all, each once');

  // What they say. None carries a price or a way to buy, unless the fan asked for Pro's offers.
  for (const m of w.sent) {
    const all = `${m.msg.subject}\n${m.msg.html}\n${m.msg.text}`;
    assert.ok(!/SAR \d|ريال|Advertisement|إعلان|\/pro"|See Pro/.test(all.replace(/pro\?nomail=/g, '')), `the ${m.kind} email carries no price and nothing to buy`);
    assert.ok(/pro\?nomail=[A-Za-z0-9_-]{24,}/.test(m.msg.html) && /Stop these emails/.test(m.msg.html) && /أوقف هالرسائل/.test(m.msg.html), `the ${m.kind} email has a working stop link in both languages`);
    assert.ok(m.msg.headers?.['List-Unsubscribe']?.includes('/api/pro/mail/stop?t=') && m.msg.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
    assert.ok(/dir="rtl" lang="ar"/.test(m.msg.html) && /dir="ltr" lang="en"/.test(m.msg.html), 'Arabic and English, in the receipt layout');
    assert.ok(!all.includes('undefined') && !all.includes('NaN') && !all.includes('{{'));
  }
  assert.ok(/No card was taken and nothing will be charged/.test(w.sent[0].msg.html) && /ما أخذنا منك بطاقة/.test(w.sent[0].msg.html));
  assert.ok(/Nothing was charged/.test(w.sent[2].msg.html) && /Everything you made is still there/.test(w.sent[2].msg.html));

  // With their own tick, and only then, the end email says what Pro costs, as an advertisement with the seller named.
  const keen = w.person('mail_keen');
  await w.pro.giftFor(keen);
  await w.pro.giftOffersOk(keen, true);
  w.forward(7 * DAY + HOUR);
  await w.mails.tick();
  const offer = w.sent.filter((m) => m.to === 'mail_keen@example.test' && m.kind === 'end')[0].msg;
  assert.ok(/Advertisement: to keep Pro, it is SAR 19\.99 for 30 days/.test(offer.html) && /إعلان/.test(offer.html) && /FL-216888773/.test(offer.html) && /Stop these emails/.test(offer.html), 'the price is an advertisement, labelled, with the seller and the stop link');

  // "Stop these emails": no more of them, and the link can do nothing else.
  const stopper = w.person('mail_stopper');
  await w.pro.giftFor(stopper);
  await w.mails.tick();
  const startMail = w.sent.filter((m) => m.to === 'mail_stopper@example.test')[0].msg;
  const token = /pro\?nomail=([A-Za-z0-9_-]+)/.exec(startMail.html)![1];
  assert.equal(await w.mails.stopMail('not-a-token'), false);
  assert.equal(await w.mails.stopMail('x'.repeat(32)), false, 'a made-up token stops nothing');
  assert.equal(await w.mails.stopMail(token), true);
  assert.equal(await w.proRepo.mailStopped(stopper.id), true);
  w.forward(6 * DAY);
  const r1 = await w.mails.tick();
  w.forward(2 * DAY);
  const r2 = await w.mails.tick();
  assert.equal(w.sent.filter((m) => m.to === 'mail_stopper@example.test').length, 1, 'nothing after "stop these emails"');
  assert.ok(r1.skipped + r2.skipped >= 2, 'the emails not owed are put away, not left to be looked at again');

  // An address that stopped being verified, or went: not emailed.
  const gone = w.person('mail_gone');
  await w.pro.giftFor(gone);
  gone.emailVerified = false;
  await w.mails.tick();
  assert.equal(w.sent.filter((m) => m.to === 'mail_gone@example.test').length, 0);
  // Bought Pro during the gift: the start email went, but nothing is "ending" for them.
  const buyer = w.person('mail_buyer');
  await w.pro.giftFor(buyer);
  await w.mails.tick();
  await w.buy(buyer);
  w.forward(6 * DAY);
  await w.mails.tick();
  w.forward(2 * DAY);
  await w.mails.tick();
  assert.deepEqual(w.sent.filter((m) => m.to === 'mail_buyer@example.test').map((m) => m.kind), ['start'], 'a fan who bought Pro is not told it is ending');

  // The old Accept gift never had emails and gets none.
  const old = world(MAILS, { saved: 1 });
  const acc = old.person('mail_old');
  await old.proRepo.offerGift(acc.id, old.state.now);
  await old.proRepo.acceptGift(acc.id, old.state.now, 7);
  await old.mails.tick();
  old.forward(6 * DAY);
  await old.mails.tick();
  old.forward(2 * DAY);
  await old.mails.tick();
  assert.equal(old.sent.length, 0, 'a gift started from the Accept button gets no emails');

  // A gift that started long before the emails were switched on gets no late "it started".
  const before = world(GIFT);
  const early = before.person('mail_early');
  await before.pro.giftFor(early);
  before.forward(3 * DAY);
  const later = new GiftMailService(before.proRepo, {
    env: MAILS, now: () => before.state.now, gapMs: 0, send: async (m) => { before.sent.push({ kind: 'x', to: m.to, msg: m }); },
    accountOf: async () => ({ email: 'mail_early@example.test', emailVerified: true }), holdsPro: async () => false,
    compose: (kind, g, to) => giftEmail({ kind, to, base: 'https://tifomaker.test', contact: 'c@example.test', days: 7, endsAt: g.endsAt, stopUrl: 'https://tifomaker.test/pro?nomail=x', stopPost: 'https://tifomaker.test/x' }),
  });
  assert.equal((await later.tick()).sent, 0, 'no "it started" three days late');
  console.log('turnaround.test: the gift emails checked');
}

// --------------------------------------------------- 4. the match pass ---
{
  // The switch off: it cannot be bought, whatever the browser sends.
  const off = world(LIVE);
  const a = off.person('match_off');
  assert.deepEqual(await off.pay.checkout(off.buyer(a), 'en', 'https://tifomaker.test', { product: 'match' }), { ok: false, reason: 'off' });
  assert.equal(off.pay.match().on, false);
  assert.equal((await off.checkout(a)).form.amount, 1999, 'the month is untouched');

  const MATCH = { ...LIVE, PRO_MATCH_PASS: 'on' };
  const w = world(MATCH);
  const fan = w.person('match_fan');
  const c = await w.checkout(fan, 'match', 'post');
  // The server's price and length: SAR 4.99 for 3 days. No renewal is offered with it, and no founders offer.
  assert.deepEqual([c.form.amount, c.form.currency, c.form.product, c.form.days, c.form.renew, c.form.founder], [499, 'SAR', 'match', 3, null, null]);
  assert.ok(/match pass: 72 hours/.test(c.form.description));
  const o0 = (await w.payRepo.get(c.orderId))!;
  assert.deepEqual([o0.product, o0.days, o0.amount, o0.src, o0.status], ['match', 3, 499, 'post', 'pending']);
  // Nothing until Moyasar says it is paid.
  assert.equal((await w.pro.plan(fan.id)).plan, 'free');
  w.moyasar.formPay(c.form, c.orderId);
  const paid = (await w.pay.orderFor(fan.id, c.orderId))!;
  assert.equal(paid.status, 'paid');
  const passes = await w.proRepo.allPasses(fan.id);
  assert.equal(passes.length, 1);
  assert.deepEqual([passes[0].plan, passes[0].source, Date.parse(passes[0].endsAt) - Date.parse(passes[0].startsAt)], ['monthly', 'payment', 72 * HOUR], 'the same Pro, for 72 hours');
  assert.equal((await w.pro.plan(fan.id)).plan, 'monthly');
  // One pass per paid order, however many times it is confirmed.
  await Promise.all([w.pay.reconcile(paid), w.pay.reconcile(paid), w.pay.orderFor(fan.id, c.orderId)]);
  assert.equal((await w.proRepo.allPasses(fan.id)).length, 1, 'one pass per paid order');
  // It ends by itself, and nothing renews it.
  w.forward(72 * HOUR + 1000);
  assert.equal((await w.pro.plan(fan.id)).plan, 'free', 'the match pass ends after its hours');
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'a match pass is never charged again');
  assert.equal(await w.payRepo.subFor(fan.id), null);

  // Paid at another amount, or in another currency: nobody gets anything, a person looks.
  for (const wrong of [{ amount: 100 }, { amount: 1999 }, { currency: 'USD' }]) {
    const cheat = w.person(`match_cheat_${wrong.amount ?? wrong.currency}`);
    const cc = await w.checkout(cheat, 'match');
    w.moyasar.formPay(cc.form, cc.orderId, wrong);
    assert.equal((await w.pay.orderFor(cheat.id, cc.orderId))!.status, 'review', `paid ${JSON.stringify(wrong)}: no pass`);
    assert.equal((await w.pro.plan(cheat.id)).plan, 'free');
  }
  // Another account's order is no order at all.
  assert.equal(await w.pay.orderFor(w.person('match_stranger').id, c.orderId), null);

  // It never renews: a tick for "Keep Pro on" is refused, and a card saved with it is deleted at once.
  const R = world({ ...MATCH, PRO_AUTORENEW: 'on' });
  const keeper = R.person('match_keeper');
  const kc = await R.checkout(keeper, 'match');
  assert.equal(kc.form.renew, null, 'the box is not offered with a match pass');
  assert.equal(await R.pay.setKeep(keeper.id, kc.orderId, true), false, 'a match pass cannot be asked to renew');
  R.moyasar.formPay(kc.form, kc.orderId, { save: true });
  await R.pay.orderFor(keeper.id, kc.orderId);
  assert.equal(await R.payRepo.subFor(keeper.id), null, 'no subscription from a match pass');
  assert.equal(R.moyasar.tokens.size, 0, 'a card saved with it is deleted');
  // The month, in the same shop, still offers it.
  const mc = await R.checkout(R.person('match_monthly'));
  assert.ok(mc.form.renew && mc.form.product === 'monthly');

  // No founders bonus on a match pass, even for a founder inside the window.
  const F = world(MATCH);
  const founder = F.person('match_founder');
  await F.proRepo.notify(founder.id);
  await F.launchRepo.begin(F.state.now);
  F.forward(HOUR);
  const fc = await F.checkout(founder, 'match');
  assert.equal(fc.form.founder, null);
  F.moyasar.formPay(fc.form, fc.orderId);
  const fo = (await F.pay.orderFor(founder.id, fc.orderId))!;
  assert.deepEqual([fo.status, fo.bonusDays], ['paid', 0], 'a match pass carries no founders bonus');
  assert.equal(Date.parse((await F.proRepo.allPasses(founder.id))[0].endsAt) - Date.parse((await F.proRepo.allPasses(founder.id))[0].startsAt), 72 * HOUR);

  // A refund ends the pass, like any order.
  const refundee = w.person('match_refund');
  const rb = await w.buy(refundee, 'match');
  assert.equal((await w.pro.plan(refundee.id)).plan, 'monthly');
  assert.equal((await w.pay.refund(rb.order.id)).ok, true);
  assert.equal((await w.pro.plan(refundee.id)).plan, 'free', 'a refund ends the match pass');
  assert.equal((await w.payRepo.get(rb.order.id))!.status, 'refunded');

  // Bought while holding Pro for under a week more: it starts when that Pro ends, so nothing paid for overlaps.
  const stacker = w.person('match_stack');
  const first = await w.buy(stacker, 'match');
  const second = await w.buy(stacker, 'match');
  const sp = await w.proRepo.allPasses(stacker.id);
  const p1 = sp.find((x) => x.id === first.order.passId)!;
  const p2 = sp.find((x) => x.id === second.order.passId)!;
  assert.equal(p2.startsAt, p1.endsAt, 'the second pass starts where the first ends');
  // Holding a month with more than a week left: come back later, as for a month.
  const holder = w.person('match_holder');
  await w.buy(holder);
  const held = await w.pay.checkout(w.buyer(holder), 'en', 'https://tifomaker.test', { product: 'match' });
  assert.ok(!held.ok && held.reason === 'held');
  // An unverified email cannot buy either product.
  const unv = await w.pay.checkout(w.buyer(w.person('match_unverified', { verified: false })), 'en', 'https://tifomaker.test', { product: 'match' });
  assert.ok(!unv.ok && unv.reason === 'verify');
  // An open month order is not handed back for a match pass press, nor the other way round.
  const mixer = w.person('match_mixer');
  const m1 = await w.checkout(mixer, 'monthly');
  const m2 = await w.checkout(mixer, 'match');
  const m3 = await w.checkout(mixer, 'match');
  assert.notEqual(m1.orderId, m2.orderId);
  assert.equal(m2.orderId, m3.orderId, 'the same open match order is offered again, not a new one each press');
  assert.deepEqual([m1.form.amount, m2.form.amount], [1999, 499]);

  // Its own numbers from the settings; and what /admin counts.
  const C = world({ ...MATCH, PRO_MATCH_PRICE: '3.99', PRO_MATCH_DAYS: '2' });
  const cf = await C.checkout(C.person('match_custom'), 'match');
  assert.deepEqual([cf.form.amount, cf.form.days], [399, 2]);
  const counted = await w.payRepo.paidOrders(new Date(0), 100);
  assert.ok(counted.some((x) => x.product === 'match' && x.src === 'post' && !x.refunded) && counted.some((x) => x.product === 'match' && x.refunded));
  // The receipt says what was bought.
  const rc = receiptEmail({ order: paid, to: 'f@example.test', endsAt: passes[0].endsAt, base: 'https://tifomaker.test', contact: 'owner@example.test' });
  assert.ok(/match pass, 72 hours \(one payment, never renewed\)/.test(rc.html) && /باقة المباراة 72 ساعة/.test(rc.html) && /SAR 4\.99/.test(rc.html));
  console.log('turnaround.test: the match pass checked');
}

// ------------------------------------------- 5. the monthly price setting ---
{
  const PRICED = { ...LIVE, PRO_MONTHLY_PRICE: '9.99', PRO_LAUNCH_PRICE_UNTIL: '2027-01-15', PRO_AUTORENEW: 'on' };
  const w = world(PRICED);
  const fan = w.person('price_fan');
  const c = await w.checkout(fan);
  assert.equal(c.form.amount, 999, 'the setting is what is charged');
  assert.equal(c.form.renew!.price, 9.99, 'and what "Keep Pro on" says each renewal costs');
  // A subscription started at the new price renews at it.
  const kept = await w.buy(fan, 'monthly', { keep: true });
  assert.equal(kept.order.amount, 999);
  assert.equal((await w.payRepo.subFor(fan.id))!.amount, 999);

  // A fan who ticked the box when renewals were SAR 19.99 is charged the price the page shows now, never more.
  const OLD = { ...LIVE, PRO_AUTORENEW: 'on' };
  const old = world(OLD);
  const early = old.person('price_early');
  await old.buy(early, 'monthly', { keep: true });
  assert.equal((await old.payRepo.subFor(early.id))!.amount, 1999);
  // The price comes down: the same stores, a server reading the new setting.
  const now = new PaymentService(old.payRepo, old.pro, old.moyasar, { env: { ...OLD, PRO_MONTHLY_PRICE: '9.99' }, base: 'https://tifomaker.test', notify: async () => true });
  old.forward(27 * DAY + 2 * HOUR);
  await now.runRenewals(); // the reminder
  assert.equal((await old.payRepo.subFor(early.id))!.amount, 999, 'the subscription follows the price down before the reminder states it');
  old.forward(3 * DAY);
  await now.runRenewals();
  assert.deepEqual(old.moyasar.charges.map((x) => x.amount), [999], 'the renewal is charged the price shown, not the one it was started at');
  // It never goes up by itself: a price that rose is not passed on to a running subscription.
  const up = new PaymentService(old.payRepo, old.pro, old.moyasar, { env: { ...OLD, PRO_MONTHLY_PRICE: '29.99' }, base: 'https://tifomaker.test', notify: async () => true });
  old.forward(27 * DAY + 2 * HOUR);
  await up.runRenewals();
  assert.equal((await old.payRepo.subFor(early.id))!.amount, 999, 'a subscription is never raised here');
  assert.equal(await old.payRepo.lowerSubAmount((await old.payRepo.subFor(early.id))!.id, 50, old.state.now), false, 'nor lowered under SAR 1');
  console.log('turnaround.test: the price setting checked');
}

// ----------------------------------------------------------- 6. /legal ---
{
  const html = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  // Nothing new is served until its switch is on.
  const plain = payLegal(html, true, false);
  assert.ok(!/The match pass|باقة المباراة|free days|المجانية/.test(plain) && !plain.includes('{{') && !plain.includes('<template data-pay'));
  // The match pass's terms, with the settings' numbers, in both languages; only while Pro is on sale.
  const match = payLegal(html, true, false, { match: { price: 499, hours: 72 } });
  assert.ok(/same Pro for 72 hours/.test(match) && /one payment of SAR 4\.99/.test(match) && /It never renews/.test(match) && /within 7 days of paying/.test(match));
  assert.ok(/لمدة 72 ساعة/.test(match) && /4\.99 ريال/.test(match) && /ما تتجدد أبد/.test(match) && !match.includes('{{'));
  assert.ok(!/The match pass/.test(payLegal(html, false, false, { match: { price: 499, hours: 72 } })), 'not while Pro is not on sale');
  // The free days, and the privacy text for their emails only when the emails are on.
  const gift = payLegal(html, true, false, { gift: { days: 7, mails: false } });
  assert.ok(/The 7 free days\./.test(gift) && /No card is asked for/.test(gift) && /أيام برو الـ7 المجانية/.test(gift) && !/Emails about the free days/.test(gift) && !gift.includes('{{'));
  const mails = payLegal(html, true, false, { gift: { days: 7, mails: true } });
  assert.ok(/Emails about the free days/.test(mails) && /it is never ticked for you/.test(mails) && /رسائل عن الأيام المجانية/.test(mails) && /link that stops them all/.test(mails));
  assert.ok(/receipts, and notices about Pro on your account/.test(html) && /والإيصالات، وتنبيهات برو على حسابك/.test(html), 'the privacy text names the emails the site sends');
  console.log('turnaround.test: /legal checked');
}

// ------------------------------------------------------ 7. over the routes ---
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
  PRO_MONTHLY_PRICE: undefined, PRO_MATCH_PASS: undefined, PRO_MATCH_PRICE: undefined, PRO_MATCH_DAYS: undefined,
  PRO_AUTO_GIFT: undefined, PRO_GIFT_MAILS: undefined, PRO_POST_OFFERS: undefined,
  PRO_YEAR: undefined, PRO_YEAR_PRICE: undefined, PRO_THREE_PLANS: undefined,
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
  const app = await buildApp(designs, auth, templates, {
    social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
    aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)), events: new MemoryEventsRepository(),
    pro: proRepo, payments: payRepo, launch: launchRepo, launchGapMs: 0, moyasar, emailSender: outbox, publicUrl: 'https://tifomaker.test',
    adminUsernames: ['boss_turn'], aiAdminPassword: 'turnaround admin password',
  });
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'turnaround admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };
  const post = (url: string, token: string | null, payload: object = {}) => app.inject({ method: 'POST', url, ...(token ? { headers: bearer(token) } : {}), payload });
  const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, ...(token ? { headers: bearer(token) } : {}) });
  const boss = (url: string) => app.inject({ method: 'GET', url, headers: asBoss });
  const proOf = async (token: string | null) => (await get('/api/pro', token)).json() as Record<string, any>;
  const fan = await reg(app, 't_fan');
  await auth.markEmailVerified(fan.id);

  // Everything off: /api/pro says nothing new, signed in or out, and the new routes give nothing away.
  setEnv({ ...LIVE });
  const outOff = await proOf(null);
  assert.deepEqual([outOff.offer.match, outOff.offer.post, outOff.offer.autoGift, outOff.offer.monthly.price], [undefined, undefined, undefined, 19.99]);
  const inOff = await proOf(fan.token);
  assert.deepEqual([inOff.gift.state, inOff.offer.match, inOff.offer.post, inOff.plan], ['none', undefined, undefined, 'free'], 'with the switches off a deploy changes nothing for a fan');
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: 'match' })).statusCode, 404, 'the match pass cannot be bought while it is off');
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: 'season' })).statusCode, 400);

  // Switched on: the page is told what it needs, and nothing it must not decide.
  setEnv({ PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on', PRO_AUTO_GIFT: 'on', PRO_POST_OFFERS: 'on', PRO_LAUNCH_PRICE_UNTIL: '2027-01-15' });
  const out = await proOf(null);
  assert.deepEqual([out.offer.monthly.price, out.offer.launch, out.offer.match, out.offer.post, out.offer.autoGift], [9.99, undefined, { price: 4.99, days: 3, hours: 72 }, true, true]);
  const me = await proOf(fan.token);
  assert.deepEqual([me.gift.state, me.gift.auto, me.gift.welcome, me.plan, me.offer.monthly.price], ['active', true, true, 'gift', 9.99], 'the gift starts on the first visit after the switch');
  // The gift's small routes: signed in only, and each once.
  for (const url of ['/api/pro/gift/welcomed', '/api/pro/gift/end-seen', '/api/pro/gift/used', '/api/pro/gift/offers']) assert.equal((await post(url, null)).statusCode, 401, `${url} needs a sign-in`);
  assert.equal((await post('/api/pro/gift/offers', fan.token, { ok: 'yes' })).statusCode, 400);
  assert.equal((await post('/api/pro/gift/welcomed', fan.token, { offers: true })).statusCode, 200);
  const after = await proOf(fan.token);
  assert.deepEqual([after.gift.welcome, after.gift.offersOk], [undefined, true]);
  assert.equal((await post('/api/pro/gift/used', fan.token, { items: ['pexp.item.vertical', 'not a key!'] })).statusCode, 200);
  assert.deepEqual((await proRepo.gift(fan.id))!.uses, { 'pexp.item.vertical': 1 });

  // Buying: the browser names the product and the place; the server sets the price.
  const co = await post('/api/pro/pay/checkout', fan.token, { lang: 'ar', product: 'match', src: 'post', amount: 1, days: 400, price: 0.01 });
  assert.equal(co.statusCode, 200, co.body);
  const form = co.json().form as FormConfig;
  assert.deepEqual([form.amount, form.product, form.days], [499, 'match', 3], 'nothing the browser sends changes the price or the length');
  moyasar.formPay(form, co.json().order);
  const ov = (await get(`/api/pro/pay/order/${co.json().order}`, fan.token)).json();
  assert.deepEqual([ov.status, ov.product], ['paid', 'match']);
  assert.equal((await proOf(fan.token)).plan, 'monthly', 'the match pass is Pro');
  const receipt = outbox.sent.find((m) => /receipt/i.test(m.subject));
  assert.ok(receipt && /match pass, 72 hours/.test(receipt.html) && /SAR 4\.99/.test(receipt.html));
  // A place that is not one of ours is not kept.
  const other = await reg(app, 't_other');
  await auth.markEmailVerified(other.id);
  const co2 = await post('/api/pro/pay/checkout', other.token, { lang: 'en', src: '<script>alert(1)</script>' });
  assert.equal((await payRepo.get(co2.json().order))!.src, null);
  assert.equal(co2.json().form.amount, 999, 'the month costs the setting');

  // /admin: the switches as the server reads them, the gifts, the funnel. The admin's only.
  for (const url of ['/api/admin/pro/funnel', '/api/admin/pro/gift/email', '/api/admin/pro/gift/mails']) {
    assert.equal((await get(url, fan.token)).statusCode, 403, `${url} is the admin's`);
    assert.equal((await get(url, null)).statusCode, 403);
  }
  const admin = (await boss('/api/admin/pro')).json();
  assert.deepEqual(admin.settings, { autoGift: true, giftMails: false, postOffers: true, monthlyPrice: 9.99, monthlyPriceInvalid: false, match: { asked: true, price: 4.99, days: 3 },
    // The year and the three-plan page (server/test/plans.test.mts): off here, as everywhere until switched on.
    year: { asked: false, price: 89.99, days: 365, priceInvalid: false }, threePlans: false });
  assert.deepEqual([admin.giftsStarted.auto.started, admin.giftsStarted.auto.running, admin.giftsStarted.auto.boughtDuring, admin.giftsStarted.accept.started], [1, 1, 1, 0], 'one gift started (the other account has not been back), and its holder bought while it ran');
  await app.inject({ method: 'POST', url: '/api/events', payload: { session: 's1', name: 'pro_offer_post' } });
  await app.inject({ method: 'POST', url: '/api/events', payload: { session: 's1', name: 'pro_get_post' } });
  await app.inject({ method: 'POST', url: '/api/events', payload: { session: 's2', name: 'pro_offer_post' } });
  await app.inject({ method: 'POST', url: '/api/events', payload: { session: 's2', name: 'pro_offer_nowhere' } });
  const fun = (await boss('/api/admin/pro/funnel?days=30')).json();
  const row = fun.places.find((p: { place: string }) => p.place === 'post');
  assert.deepEqual([row.saw, row.pressed, row.monthly, row.match, fun.paid.match, fun.paid.monthly], [2, 1, 0, 1, 1, 0], 'saw, pressed and paid, by where and by plan');
  // Each email as it would go out, for the admin to read; with a price only when asked for that version.
  for (const kind of ['start', 'soon', 'end']) {
    const r = await boss(`/api/admin/pro/gift/email?kind=${kind}&json=1`);
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().html.includes('pro?nomail=') && !/SAR \d/.test(r.json().html), `the ${kind} email has no price`);
  }
  assert.ok(/SAR 9\.99 for 30 days/.test((await boss('/api/admin/pro/gift/email?kind=end&offer=1&json=1')).json().html) && /72 hours for SAR 4\.99/.test((await boss('/api/admin/pro/gift/email?kind=end&offer=1&json=1')).json().html));
  // No email went to anyone: the gift's emails are still off.
  assert.equal(outbox.sent.filter((m) => /days of Pro|Pro is on/.test(m.subject)).length, 0, 'no gift email while PRO_GIFT_MAILS is off');

  // The stop link of a gift email works with no sign-in, and only stops.
  const token = /nomail=([A-Za-z0-9_-]+)/.exec(`nomail=${(proRepo as unknown as { stopTokens: Map<string, string> }).stopTokens.get(fan.id)}`)![1];
  assert.equal((await post('/api/pro/mail/stop', null, { t: 'x'.repeat(30) })).statusCode, 404);
  assert.equal((await post('/api/pro/mail/stop', null, { t: token })).statusCode, 200);
  assert.equal(await proRepo.mailStopped(fan.id), true);

  // /legal follows the switches at boot; here only that the page still serves.
  await app.close();
  console.log('turnaround.test: the routes checked');
}
restore();
setEnv(ALL_OFF);

// ---------------------------------------------------------- 8. Postgres ---
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('turnaround.test: Postgres skipped (no DATABASE_URL)');
} else {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  try {
    const repo = new PgProRepository(pool);
    const pay = new PgPaymentRepository(pool);
    const mk = async (name: string): Promise<string> => {
      const r = await pool.query(`INSERT INTO users (username, password_hash, email, email_verified_at) VALUES ($1, 'x', $2, now()) RETURNING id`, [name, `${name}@example.test`]);
      return String(r.rows[0].id);
    };
    const tag = randomUUID().slice(0, 8);
    const u = await mk(`turn_${tag}_a`);
    const now = new Date();
    // The gift starts once, however many callers race for it.
    await repo.offerGift(u, now);
    const tries = await Promise.all(Array.from({ length: 6 }, () => repo.acceptGift(u, now, 7, { auto: true, lang: 'ar' })));
    assert.equal(tries.filter((t) => t.ok).length, 1, 'six starts at once: one gift');
    const passes = await repo.allPasses(u);
    assert.equal(passes.length, 1);
    const g = (await repo.gift(u))!;
    assert.deepEqual([g.auto, g.lang, g.welcomeAt, g.endSeenAt, g.uses, g.offersOkAt], [true, 'ar', null, null, {}, null]);
    // The welcome and the end card: each marked by one caller.
    assert.equal((await Promise.all([repo.giftMark(u, 'welcome', now), repo.giftMark(u, 'welcome', now), repo.giftMark(u, 'welcome', now)])).filter(Boolean).length, 1);
    assert.equal((await Promise.all([repo.giftMark(u, 'end', now), repo.giftMark(u, 'end', now)])).filter(Boolean).length, 1);
    // What was made: counted, bounded.
    await repo.giftUse(u, ['pexp.item.vertical', 'pro.mark.option'], 3);
    await repo.giftUse(u, ['pexp.item.vertical', 'pexp.item.hd', 'pexp.item.poster'], 3);
    assert.deepEqual((await repo.gift(u))!.uses, { 'pexp.item.vertical': 2, 'pro.mark.option': 1, 'pexp.item.hd': 1 }, 'no more than three different items are kept');
    assert.equal(await repo.giftOffersOk(u, true, now), true);
    assert.ok((await repo.gift(u))!.offersOkAt);
    // Each email: due, taken by one caller, given back, taken again.
    const due = await repo.giftsDue('start', now, 50);
    const mine = due.find((d) => d.userId === u)!;
    assert.ok(mine && mine.stopToken.length >= 24 && mine.offersOk === true && mine.lang === 'ar');
    assert.equal((await Promise.all(Array.from({ length: 5 }, () => repo.claimGiftMail(u, 'start', now)))).filter(Boolean).length, 1, 'five senders at once: one email');
    assert.ok(!(await repo.giftsDue('start', now, 50)).some((d) => d.userId === u), 'an email taken is not due');
    await repo.unclaimGiftMail(u, 'start');
    assert.ok((await repo.giftsDue('start', now, 50)).some((d) => d.userId === u), 'given back, it is due again');
    assert.ok(!(await repo.giftsDue('soon', now, 50)).some((d) => d.userId === u) && !(await repo.giftsDue('end', now, 50)).some((d) => d.userId === u));
    assert.ok((await repo.giftsDue('soon', new Date(now.getTime() + 6 * DAY), 50)).some((d) => d.userId === u));
    assert.ok((await repo.giftsDue('end', new Date(now.getTime() + 7 * DAY + HOUR), 50)).some((d) => d.userId === u));
    assert.equal(await repo.giftByStopToken(mine.stopToken), u);
    assert.equal(await repo.giftByStopToken('x'.repeat(32)), null);
    await repo.stopMail(u, now, 'gift email link');
    await repo.stopMail(u, now, 'gift email link');
    assert.equal(await repo.mailStopped(u), true);
    assert.ok((await repo.giftRows(5000)).some((r) => r.userId === u && r.auto));
    // An old Accept gift is not an automatic one, and is never due an email.
    const v = await mk(`turn_${tag}_b`);
    await repo.offerGift(v, now);
    await repo.acceptGift(v, now, 7);
    assert.equal((await repo.gift(v))!.auto, false);
    assert.ok(!(await repo.giftsDue('start', now, 500)).some((d) => d.userId === v));

    // Orders remember what they bought and where from; the store refuses anything else.
    const o = await pay.create({ userId: u, amount: 499, days: 3, lang: 'ar', testMode: false, now, kind: 'form', paymentId: randomUUID(), product: 'match', src: 'post' });
    assert.deepEqual([o.product, o.src, o.days, o.amount], ['match', 'post', 3, 499]);
    const plain = await pay.create({ userId: u, amount: 999, days: 30, lang: 'en', testMode: false, now, kind: 'form', paymentId: randomUUID(), src: 'not a place!' });
    assert.deepEqual([plain.product, plain.src], ['monthly', null]);
    await assert.rejects(pool.query(`UPDATE pro_orders SET product = 'season' WHERE id = $1`, [o.id]), 'the table takes only the two products');
    // One pass per paid order, from six confirmations at once.
    const start = new Date();
    const paidTries = await Promise.all(Array.from({ length: 6 }, () => pay.markPaid(o.id, { paymentId: o.paymentId!, method: 'creditcard', now: start, startsAt: start, endsAt: new Date(start.getTime() + 3 * DAY) })));
    assert.equal(paidTries.filter((r) => r.ok && r.first).length, 1, 'six confirmations: one pass');
    assert.ok((await pay.paidOrders(new Date(start.getTime() - HOUR), 100)).some((x) => x.userId === u && x.product === 'match' && x.src === 'post'));
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[u, v]]);
    console.log('turnaround.test: Postgres checked');
  } finally {
    await pool.end();
  }
}
console.log('turnaround.test: all assertions passed');
