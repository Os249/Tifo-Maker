/**
 * The three plans of 22 Nov 2026: the year as a third thing to buy
 * (PRO_YEAR, PRO_YEAR_PRICE) and the three-plan page's switch
 * (PRO_THREE_PLANS). docs/pro-three-plans.md has it in plain words.
 *
 * Adversarial where money is. It tries to buy a year with the switch off, at
 * another price or in another currency, to have it renew or keep a card, to
 * carry the founders bonus, to get two passes for one order, to stack a year
 * on a year, and to change what the month and the match pass cost or last by
 * switching the new things on. Everything is off by default, and that is
 * checked first.
 *
 * Runs on the memory stores, and the order store's own guards again on
 * Postgres when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { SALE_KEYS, keysOf, saleKey } from '../../src/ui/proSaleCopy';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository, type ProOrder } from '../src/payRepo';
import { memoryLaunch, type LaunchAccount } from '../src/launchRepo';
import { ProService, type ProAccount } from '../src/pro';
import { MoyasarError, type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type MoyasarToken, type NewInvoice, type TokenCharge } from '../src/moyasar';
import { PaymentService, payLegal, paymentsPublic, type FormConfig } from '../src/payments';
import { LaunchService } from '../src/proLaunch';
import { giftEmail } from '../src/proGiftMail';
import { receiptEmail } from '../src/payReceipt';
import { refundEmail, refundReceivedEmail } from '../src/payRefundMail';
import { OFFER, PRODUCTS, YEAR_WITHIN_DAYS, asProduct, matchPass, threePlansOn, yearPlan, yearPriceInvalid, type Product } from '../src/proPlan';
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

const LIVE = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY, MOYASAR_PUBLISHABLE_KEY: PK_LIVE, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: HOOK, PRO_FOUNDERS_BONUS: 'off' };
/** On sale as Osamh has it today, with the year and the three-plan page switched on. */
const ALL = { ...LIVE, PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on', PRO_YEAR: 'on', PRO_THREE_PLANS: 'on' };

interface Person extends ProAccount { username: string }

/** Pro and payments on memory stores, sharing one clock the test moves. */
function world(env: Record<string, string> = ALL) {
  const state = { now: new Date(T0) };
  const people = new Map<string, Person>();
  const accountOf = (id: string): LaunchAccount | null => {
    const p = people.get(id);
    return p ? { username: p.username, email: p.email, verified: p.emailVerified } : null;
  };
  const proRepo = new MemoryProRepository();
  const payRepo = new MemoryPaymentRepository(proRepo);
  const launchRepo = memoryLaunch(proRepo, payRepo, accountOf);
  const moyasar = new FakeMoyasar();
  const pro = new ProService(proRepo, { now: () => state.now, savedDesigns: async () => 0, env });
  let payRef: PaymentService | null = null;
  const launch = new LaunchService(launchRepo, payRepo, { env, now: () => state.now, gapMs: 0, isPublic: () => !!payRef?.on() && paymentsPublic(env), canSend: () => false });
  const pay = new PaymentService(payRepo, pro, moyasar, { env, base: 'https://tifomaker.test', founders: launch, notify: async () => true });
  payRef = pay;
  const person = (name: string): Person => {
    const x: Person = { id: randomUUID(), username: name, email: `${name}@example.test`, emailVerified: true };
    people.set(x.id, x);
    return x;
  };
  const buyer = (p: Person) => ({ id: p.id, username: p.username, email: p.email, emailVerified: p.emailVerified });
  const tryCheckout = (p: Person, product: Product, src: string | null = null) => pay.checkout(buyer(p), 'en', 'https://tifomaker.test', { product, src });
  const checkout = async (p: Person, product: Product = 'monthly', src: string | null = null) => {
    const c = await tryCheckout(p, product, src);
    assert.ok(c.ok && 'form' in c, `checkout: ${JSON.stringify(c)}`);
    return c;
  };
  const buy = async (p: Person, product: Product = 'monthly') => {
    const c = await checkout(p, product);
    moyasar.formPay(c.form, c.orderId);
    const order = (await pay.orderFor(p.id, c.orderId))!;
    assert.equal(order.status, 'paid');
    return { order, form: c.form };
  };
  const forward = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  const span = async (p: Person) => (await proRepo.allPasses(p.id)).map((x) => ({ plan: x.plan, from: Date.parse(x.startsAt), to: Date.parse(x.endsAt), revoked: !!x.revokedAt }));
  return { state, proRepo, payRepo, launchRepo, moyasar, pro, pay, person, buyer, tryCheckout, checkout, buy, forward, span };
}

// ----------------------------------------------------- 1. the settings ---
{
  // Off by default: a deploy changes nothing.
  assert.deepEqual([yearPlan({}).on, threePlansOn({}), yearPriceInvalid({})], [false, false, false]);
  // The year: SAR 89.99 for 365 days unless its price is set; its length is not a setting.
  assert.deepEqual(yearPlan({ PRO_YEAR: 'on' }), { on: true, halalas: 8999, days: 365 });
  assert.deepEqual([OFFER.year.price, OFFER.year.days], [89.99, 365]);
  assert.deepEqual(yearPlan({ PRO_YEAR: 'on', PRO_YEAR_PRICE: '79.99' }), { on: true, halalas: 7999, days: 365 });
  assert.deepEqual(yearPlan({ PRO_YEAR: 'on', PRO_YEAR_PRICE: '100' }), { on: true, halalas: 10000, days: 365 }, 'SAR 100 is the most one payment may be');
  // A price that is not one, or over the one-payment ceiling (12 months at 9.99 would be 119.88): ignored, never sold at it, and /admin is told.
  for (const bad of ['119.88', '100.01', '0', 'free', '89,99', '-1']) {
    assert.equal(yearPlan({ PRO_YEAR: 'on', PRO_YEAR_PRICE: bad }).halalas, 8999, `"${bad}" falls back to SAR 89.99`);
    assert.equal(yearPriceInvalid({ PRO_YEAR_PRICE: bad }), true);
  }
  assert.equal(yearPlan({ PRO_YEAR: 'yes' }).on, false, 'only "on" is on');
  assert.equal(yearPlan({ PRO_YEAR_PRICE: '50' }).on, false, 'a price alone sells nothing');
  assert.deepEqual([threePlansOn({ PRO_THREE_PLANS: 'on' }), threePlansOn({ PRO_THREE_PLANS: 'true' })], [true, false]);
  // The products: three, and anything unknown is the month.
  assert.deepEqual(PRODUCTS, ['monthly', 'match', 'year']);
  assert.deepEqual(['year', 'match', 'monthly', 'season', undefined, 5].map(asProduct), ['year', 'match', 'monthly', 'monthly', 'monthly', 'monthly']);
  assert.equal(YEAR_WITHIN_DAYS, 37);
  // The page's words: the three-plan hero and answer only when asked for, and "Keep Pro on" keeps its own answer.
  assert.deepEqual(['pb.title', 'pb.lead', 'pp.faq.a2'].map((k) => saleKey(k, { form: true, renew: false, plans: true })), ['pt.title', 'pt.lead', 'pt.faq.a2']);
  assert.deepEqual(['pb.title', 'pb.lead', 'pp.faq.a2'].map((k) => saleKey(k, { form: true, renew: false })), ['pb.title', 'pb.lead', 'pp.faq.a2'], 'with the switch off the words are the old ones');
  assert.equal(saleKey('pp.faq.a2', { form: true, renew: true, plans: true }), 'pr.faq.a2');
  assert.ok(SALE_KEYS.some(([soon, sale]) => keysOf(soon, sale).includes('pt.title')));
  console.log('plans.test: the settings checked');
}

// ------------------------------------------------------- 2. the year ---
{
  // The switch off: it cannot be bought, whatever the browser sends, and the others are untouched.
  const off = world({ ...LIVE, PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on' });
  const a = off.person('year_off');
  assert.deepEqual(await off.tryCheckout(a, 'year'), { ok: false, reason: 'off' });
  assert.equal(off.pay.year().on, false);
  assert.deepEqual([(await off.checkout(a)).form.amount, (await off.checkout(off.person('year_off_m'), 'match')).form.amount], [999, 499]);
  // The switch on where nothing is sold: still nothing.
  assert.equal(world({ PRO_YEAR: 'on' }).pay.year().on, false, 'the year is not sold where Pro is not');

  const w = world();
  const fan = w.person('year_fan');
  const c = await w.checkout(fan, 'year', 'page');
  // The server's price and length: SAR 89.99 for 365 days. No renewal is offered with it, and no founders offer.
  assert.deepEqual([c.form.amount, c.form.currency, c.form.product, c.form.days, c.form.renew, c.form.founder], [8999, 'SAR', 'year', 365, null, null]);
  assert.ok(/a year: 365 days/.test(c.form.description));
  const o0 = (await w.payRepo.get(c.orderId))!;
  assert.deepEqual([o0.product, o0.days, o0.amount, o0.src, o0.status], ['year', 365, 8999, 'page', 'pending']);
  // Nothing until Moyasar says it is paid.
  assert.equal((await w.pro.plan(fan.id)).plan, 'free');
  w.moyasar.formPay(c.form, c.orderId);
  const paid = (await w.pay.orderFor(fan.id, c.orderId))!;
  assert.equal(paid.status, 'paid');
  assert.deepEqual(await w.span(fan), [{ plan: 'monthly', from: T0.getTime(), to: T0.getTime() + 365 * DAY, revoked: false }], 'the same Pro, for 365 days');
  // One pass per paid order, however many times it is confirmed.
  await Promise.all([w.pay.reconcile(paid), w.pay.reconcile(paid), w.pay.orderFor(fan.id, c.orderId)]);
  assert.equal((await w.proRepo.allPasses(fan.id)).length, 1, 'one pass per paid order');
  // Nobody is charged twice: pressing again while it runs is refused, for every plan.
  for (const p of PRODUCTS) assert.equal(((await w.tryCheckout(fan, p)) as { reason?: string }).reason, 'held', `${p}: a year is held`);
  // It runs the whole year, ends by itself, and nothing renews it.
  w.forward(364 * DAY);
  assert.equal((await w.pro.plan(fan.id)).plan, 'monthly', 'still Pro on day 364');
  w.forward(DAY + 1000);
  assert.equal((await w.pro.plan(fan.id)).plan, 'free', 'the year ends after 365 days');
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'a year is never charged again');
  assert.equal(await w.payRepo.subFor(fan.id), null);

  // Paid at another amount (the month's, the match pass's, a riyal) or in another currency: nobody gets anything, a person looks.
  for (const wrong of [{ amount: 999 }, { amount: 499 }, { amount: 100 }, { amount: 8998 }, { currency: 'USD' }]) {
    const cheat = w.person(`year_cheat_${wrong.amount ?? wrong.currency}`);
    const cc = await w.checkout(cheat, 'year');
    w.moyasar.formPay(cc.form, cc.orderId, wrong);
    assert.equal((await w.pay.orderFor(cheat.id, cc.orderId))!.status, 'review', `paid ${JSON.stringify(wrong)}: no pass`);
    assert.equal((await w.pro.plan(cheat.id)).plan, 'free');
  }
  // A month's order cannot be paid as a year's, or the other way: each order has its own payment.
  assert.equal(await w.pay.orderFor(w.person('year_stranger').id, c.orderId), null, "another account's order is no order at all");

  // It never renews: a tick for "Keep Pro on" is refused, and a card saved with it is deleted at once.
  const R = world({ ...ALL, PRO_AUTORENEW: 'on' });
  const keeper = R.person('year_keeper');
  const kc = await R.checkout(keeper, 'year');
  assert.equal(kc.form.renew, null, 'the box is not offered with a year');
  assert.equal(await R.pay.setKeep(keeper.id, kc.orderId, true), false, 'a year cannot be asked to renew');
  R.moyasar.formPay(kc.form, kc.orderId, { save: true });
  await R.pay.orderFor(keeper.id, kc.orderId);
  assert.equal(await R.payRepo.subFor(keeper.id), null, 'no subscription from a year');
  assert.equal(R.moyasar.tokens.size, 0, 'a card saved with it is deleted');
  // The month, in the same shop, still offers it.
  const mc = await R.checkout(R.person('year_monthly'));
  assert.ok(mc.form.renew && mc.form.product === 'monthly');

  // No founders bonus on a year, even for a founder inside the window.
  const F = world({ ...ALL, PRO_FOUNDERS_BONUS: 'on' });
  const founder = F.person('year_founder');
  await F.proRepo.notify(founder.id);
  await F.launchRepo.begin(F.state.now);
  F.forward(HOUR);
  const fc = await F.checkout(founder, 'year');
  assert.equal(fc.form.founder, null);
  F.moyasar.formPay(fc.form, fc.orderId);
  const fo = (await F.pay.orderFor(founder.id, fc.orderId))!;
  assert.deepEqual([fo.status, fo.bonusDays], ['paid', 0], 'a year carries no founders bonus');
  const fs = (await F.span(founder))[0];
  assert.equal(fs.to - fs.from, 365 * DAY);

  // A refund ends the pass, like any order, and the account can buy again.
  const refundee = w.person('year_refund');
  const rb = await w.buy(refundee, 'year');
  assert.equal((await w.pro.plan(refundee.id)).plan, 'monthly');
  assert.equal((await w.pay.refund(rb.order.id)).ok, true);
  assert.equal((await w.pro.plan(refundee.id)).plan, 'free', 'a refund ends the year');
  assert.equal((await w.payRepo.get(rb.order.id))!.status, 'refunded');
  assert.equal((await w.checkout(refundee, 'monthly')).form.amount, 999);

  // The price is the setting's, read at the moment of the order; an order keeps the price it was made at.
  const P = world({ ...ALL, PRO_YEAR_PRICE: '79.99' });
  assert.equal((await P.checkout(P.person('year_priced'), 'year')).form.amount, 7999);
  console.log('plans.test: the year checked');
}

// ------------------------------------------ 3. buying over Pro already held ---
{
  const w = world();
  // A month holder may buy the year at any time: it starts when the month ends, so no day is lost and none overlaps.
  const up = w.person('held_upgrade');
  await w.buy(up, 'monthly');
  w.forward(5 * DAY);
  for (const p of ['monthly', 'match'] as const) assert.equal(((await w.tryCheckout(up, p)) as { reason?: string }).reason, 'held', `${p}: 25 days of Pro left`);
  await w.buy(up, 'year');
  const s = await w.span(up);
  assert.equal(s.length, 2);
  assert.deepEqual([s[1].from, s[1].to - s[1].from], [s[0].to, 365 * DAY], 'the year starts when the month ends');
  // Now a year is held: nothing more can be bought until near its end.
  for (const p of PRODUCTS) assert.equal(((await w.tryCheckout(up, p)) as { reason?: string }).reason, 'held');

  // A match pass holder too.
  const m = w.person('held_match');
  await w.buy(m, 'match');
  await w.buy(m, 'year');
  const ms = await w.span(m);
  assert.deepEqual([ms[1].from, ms[1].to - ms[1].from], [ms[0].to, 365 * DAY]);

  // A year holder: another year only once the first is within the window (37 days), a month only in the last week.
  const y = w.person('held_year');
  await w.buy(y, 'year');
  w.forward(300 * DAY);
  assert.equal(((await w.tryCheckout(y, 'year')) as { reason?: string }).reason, 'held', '65 days left: not yet');
  w.forward(30 * DAY);
  assert.equal(((await w.tryCheckout(y, 'monthly')) as { reason?: string }).reason, 'held', '35 days left: a month waits for the last week');
  const again = await w.buy(y, 'year');
  assert.equal(again.order.amount, 8999);
  const ys = await w.span(y);
  assert.deepEqual([ys[1].from, ys[1].to - ys[1].from], [ys[0].to, 365 * DAY], 'the second year follows the first');

  // An order made while buying was allowed, paid after a long pass arrived: paid is paid, and it starts after what is held.
  const late = w.person('held_late');
  const lc = await w.checkout(late, 'monthly');
  await w.buy(late, 'year');
  w.moyasar.formPay(lc.form, lc.orderId);
  assert.equal((await w.pay.orderFor(late.id, lc.orderId))!.status, 'paid');
  const ls = await w.span(late);
  assert.deepEqual([ls.length, ls[1].from], [2, ls[0].to], 'nothing paid for overlaps');
  console.log('plans.test: buying over Pro already held checked');
}

// --------------------------- 4. the month and the match pass, exactly as they were ---
{
  // With every new switch on, what the two older products cost, last and promise does not move.
  const before = world({ ...LIVE, PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on', PRO_AUTORENEW: 'on' });
  const after = world({ ...ALL, PRO_AUTORENEW: 'on' });
  for (const product of ['monthly', 'match'] as const) {
    const [x, y] = [await before.checkout(before.person(`same_${product}`), product), await after.checkout(after.person(`same_${product}`), product)];
    const shape = (f: FormConfig) => [f.amount, f.currency, f.product, f.days, f.description, f.methods, f.networks, f.renew ? [f.renew.price, f.renew.days] : null, f.founder];
    assert.deepEqual(shape(y.form), shape(x.form), `${product}: the same order with the new switches on`);
  }
  assert.deepEqual(matchPass(ALL), { on: true, halalas: 499, days: 3 });
  // Someone who bought before the change: their pass runs as it did, they can add a month in its last week, and it follows on.
  const w = world();
  const old = w.person('same_holder');
  await w.buy(old, 'monthly');
  w.forward(24 * DAY);
  await w.buy(old, 'monthly');
  const s = await w.span(old);
  assert.deepEqual([s[0].to - s[0].from, s[1].from, s[1].to - s[1].from], [30 * DAY, s[0].to, 30 * DAY]);
  const mp = w.person('same_match');
  await w.buy(mp, 'match');
  const ms = await w.span(mp);
  assert.equal(ms[0].to - ms[0].from, 72 * HOUR);
  console.log('plans.test: the month and the match pass checked');
}

// ---------------------------------------------------- 5. /legal and the emails ---
{
  const html = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  // Nothing about the year is served until it is sold.
  const plain = payLegal(html, true, false, { match: { price: 499, hours: 72 } });
  assert.ok(!/The year\.|السنة\./.test(plain) && !plain.includes('{{') && !plain.includes('<template data-pay'));
  assert.ok(!/The year\./.test(payLegal(html, false, false, { year: { price: 8999, days: 365 } })), 'not while Pro is not on sale');
  // Its terms, with the settings' numbers, in both languages: the whole price, the length, that it never renews, what
  // "a month" of it means, the 7 days, and the money back if the service stops.
  const year = payLegal(html, true, false, { year: { price: 8999, days: 365 } });
  for (const re of [/same Pro for 365 days/, /one payment of SAR 89\.99/, /"SAR 7\.50 a month"/, /divided by twelve/, /not a monthly charge/, /It never renews/, /within 7 days of paying/, /if I stop providing Pro before your year ends/]) assert.ok(re.test(year), String(re));
  for (const re of [/لمدة 365 يوم/, /89\.99 ريال/, /«7\.50 ريال بالشهر»/, /مقسومة على 12/, /ما تتجدد أبد/, /خلال 7 أيام من الدفع/, /إذا وقّفت خدمة برو قبل ما تخلص سنتك/]) assert.ok(re.test(year), String(re));
  assert.ok(!year.includes('{{'));
  // No word of the licensed kind: the year is a standing price, never a "discount", "offer" or "free months".
  const yearOnly = year.split('<b>The year.</b>')[1].split('</p>')[0] + year.split('<b>السنة.</b>')[1].split('</p>')[0];
  // ("ينخصم", charged, and "الباقة المجانية", the free plan, are other words: the pattern looks for the nouns alone.)
  assert.ok(!/discount|save \d|% off|months? free|(^|\s)(ال)?خصم|تخفيض|(^|\s)(ال)?عرض|مجاناً|شهرين مجان/i.test(yearOnly), 'the year is never called a discount or an offer');

  const order = (product: Product, days: number, amount: number, more: Partial<ProOrder> = {}): ProOrder => ({
    id: randomUUID(), userId: randomUUID(), amount, currency: 'SAR', days, lang: 'en', status: 'paid', testMode: false, createdAt: T0.toISOString(), paidAt: T0.toISOString(),
    invoiceId: null, invoiceUrl: null, paymentId: randomUUID(), method: 'creditcard', refunded: 0, refundedAt: null, note: null, kind: 'form', keep: false, keepAt: null,
    attemptedAt: null, subscriptionId: null, cycle: 0, fail: null, brand: 'visa', refundMailAt: null, refundSeenAt: null, bonusDays: 0, product, src: null, ...more,
  } as unknown as ProOrder);
  const mail = { to: 'fan@example.test', base: 'https://tifomaker.test', contact: 'owner@example.test' };
  // The receipt: a year named as one, its whole price, its end date, and that it never renews.
  const ends = new Date(T0.getTime() + 365 * DAY).toISOString();
  const r = receiptEmail({ order: order('year', 365, 8999), endsAt: ends, ...mail });
  assert.ok(/TifoMaker Pro, a year: 365 days \(one payment, never renewed\)/.test(r.html) && /SAR 89\.99/.test(r.html) && /تيفو ميكر برو، سنة: 365 يوم \(دفعة وحدة، وما تتجدد\)/.test(r.html));
  const rText = r.text ?? '';
  assert.ok(/a year: 365 days/.test(rText) && /Pro runs until/.test(rText) && /Refund within 7 days if unused/.test(rText));
  // The month's and the match pass's receipts say what they always said.
  assert.ok(/TifoMaker Pro, 30 days \(one payment, no auto-renewal\)/.test(receiptEmail({ order: order('monthly', 30, 999), endsAt: ends, ...mail }).html));
  assert.ok(/match pass, 72 hours \(one payment, never renewed\)/.test(receiptEmail({ order: order('match', 3, 499), endsAt: ends, ...mail }).html));
  // The refund emails name what ends: the year, the match pass, or the month.
  const refunded = order('year', 365, 8999, { status: 'refunded', refunded: 8999, refundedAt: T0.toISOString() } as Partial<ProOrder>);
  const rf = refundEmail({ order: refunded, ...mail });
  assert.ok(/The year of Pro this order paid for has ended/.test(rf.html) && /سنة برو اللي دفعتها بهالطلب انتهت/.test(rf.html) && /SAR 89\.99|89\.99/.test(rf.html) && /year of Pro it paid for has ended/.test(rf.text ?? ''));
  const req = { id: randomUUID(), orderId: refunded.id, userId: refunded.userId, at: T0.toISOString() } as never;
  assert.ok(/that year of Pro ends/.test(refundReceivedEmail({ order: order('year', 365, 8999), request: req, ...mail }).html));
  assert.ok(/that match pass ends/.test(refundReceivedEmail({ order: order('match', 3, 499), request: req, ...mail }).html));
  assert.ok(/that month of Pro ends/.test(refundReceivedEmail({ order: order('monthly', 30, 999), request: req, ...mail }).html), 'the month reads as it did');
  // The email after the gift names the year only to a fan who asked for offers, and only while it is sold.
  const gift = (yr: { price: number; days: number } | null) => giftEmail({
    kind: 'end', to: mail.to, base: mail.base, contact: mail.contact, days: 7, endsAt: T0.toISOString(), stopUrl: 'https://tifomaker.test/pro?nomail=x', stopPost: 'https://tifomaker.test/x',
    offer: { monthly: 999, monthlyDays: 30, match: null, year: yr, autoRenew: false },
  }).html;
  assert.ok(/Or a year: 365 days for SAR 89\.99, one payment, never renewed\./.test(gift({ price: 8999, days: 365 })) && /أو سنة: 365 يوم بـ89\.99 ريال/.test(gift({ price: 8999, days: 365 })));
  assert.ok(!/a year/.test(gift(null)));
  console.log('plans.test: /legal and the emails checked');
}

// ------------------------------------------------------ 6. over the routes ---
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
  PRO_LAUNCH_PRICE_UNTIL: undefined, PRO_PRICE_DISPLAY: undefined, PRO_DISCOUNT_LICENCE: undefined, PRO_FOUNDERS_BONUS: 'off',
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
    adminUsernames: ['boss_plans'], aiAdminPassword: 'plans admin password',
  });
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'plans admin password' } })).json().token as string;
  const post = (url: string, token: string | null, payload: object = {}) => app.inject({ method: 'POST', url, ...(token ? { headers: bearer(token) } : {}), payload });
  const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, ...(token ? { headers: bearer(token) } : {}) });
  const boss = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-ai-unlock': unlock } });
  const proOf = async (token: string | null) => (await get('/api/pro', token)).json() as Record<string, any>;
  const fan = await reg(app, 'p_fan');
  await auth.markEmailVerified(fan.id);

  // On sale as today, none of the new switches: /api/pro says nothing new, and the year cannot be bought.
  setEnv({ ...LIVE, PRO_MONTHLY_PRICE: '9.99', PRO_MATCH_PASS: 'on' });
  for (const o of [await proOf(null), await proOf(fan.token)]) {
    assert.deepEqual([o.offer.year, o.offer.plans, o.offer.monthly.price, o.offer.match], [undefined, undefined, 9.99, { price: 4.99, days: 3, hours: 72 }], 'with the switches off a deploy changes nothing for a fan');
  }
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: 'year' })).statusCode, 404, 'the year cannot be bought while it is off');
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: 'season' })).statusCode, 400);
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: ['year'] })).statusCode, 400);
  const offAdmin = (await boss('/api/admin/pro')).json().settings;
  assert.deepEqual([offAdmin.year, offAdmin.threePlans], [{ asked: false, price: 89.99, days: 365, priceInvalid: false }, false]);

  // Each switch alone: the year is named only when sold; the page is the price list only when asked.
  setEnv({ PRO_YEAR: 'on' });
  assert.deepEqual([(await proOf(null)).offer.year, (await proOf(null)).offer.plans], [{ price: 89.99, days: 365, perMonth: 7.5 }, undefined]);
  setEnv({ PRO_YEAR: undefined, PRO_THREE_PLANS: 'on' });
  assert.deepEqual([(await proOf(null)).offer.year, (await proOf(null)).offer.plans], [undefined, true]);
  // Both, with a price that cannot be sold: the default stands and /admin says so.
  setEnv({ PRO_YEAR: 'on', PRO_YEAR_PRICE: '119.88' });
  assert.equal((await proOf(fan.token)).offer.year.price, 89.99);
  assert.equal((await boss('/api/admin/pro')).json().settings.year.priceInvalid, true);
  setEnv({ PRO_YEAR_PRICE: undefined });
  // Where Pro is not on sale, neither is said.
  setEnv({ PRO_PAYMENTS: undefined });
  assert.deepEqual([(await proOf(null)).offer?.year, (await proOf(null)).offer?.plans], [undefined, undefined]);
  setEnv({ PRO_PAYMENTS: 'on' });

  // Buying: the browser names the product and the place; the server sets the price and the length.
  const co = await post('/api/pro/pay/checkout', fan.token, { lang: 'ar', product: 'year', src: 'export', amount: 1, days: 9999, price: 0.01 });
  assert.equal(co.statusCode, 200, co.body);
  const form = co.json().form as FormConfig;
  assert.deepEqual([form.amount, form.product, form.days], [8999, 'year', 365], 'nothing the browser sends changes the price or the length');
  moyasar.formPay(form, co.json().order);
  const ov = (await get(`/api/pro/pay/order/${co.json().order}`, fan.token)).json();
  assert.deepEqual([ov.status, ov.product], ['paid', 'year']);
  assert.equal((await proOf(fan.token)).plan, 'monthly', 'the year is Pro');
  const receipt = outbox.sent.find((m) => /receipt/i.test(m.subject));
  assert.ok(receipt && /a year: 365 days/.test(receipt.html) && /SAR 89\.99/.test(receipt.html), 'the receipt names the year');
  // The account's purchases, and /admin's orders, name the product.
  const mine = (await get('/api/pro/purchases', fan.token)).json();
  assert.ok(JSON.stringify(mine).includes('"product":"year"'), 'the purchases list names the year');
  const orders = (await boss('/api/admin/pro/orders')).json().orders as { product: string; days: number; src: string | null; amount: number }[];
  assert.deepEqual(orders.filter((o) => o.product === 'year').map((o) => [o.days, o.src, o.amount]), [[365, 'export', 89.99]]);
  // Pressing again is refused: a year is held.
  assert.equal((await post('/api/pro/pay/checkout', fan.token, { lang: 'en', product: 'year' })).statusCode, 409);

  // The funnel: the plan list seen, a plan chosen and paid, by where and by plan. Names that are not ours are dropped.
  for (const [s, name] of [['s1', 'pro_plans_page'], ['s1', 'pro_pick_year_page'], ['s2', 'pro_plans_page'], ['s2', 'pro_pick_monthly_page'], ['s3', 'pro_plans_export'], ['s3', 'pro_pick_match_export'], ['s3', 'year_bought'], ['s4', 'pro_pick_season_page'], ['s4', 'pro_plans_nowhere']]) {
    await app.inject({ method: 'POST', url: '/api/events', payload: { session: s, name } });
  }
  assert.equal((await get('/api/admin/pro/funnel', fan.token)).statusCode, 403, "the funnel is the admin's");
  const fun = (await boss('/api/admin/pro/funnel?days=30')).json();
  const at = (place: string) => fun.places.find((p: { place: string }) => p.place === place);
  assert.deepEqual([at('page').plans, at('page').pick, at('page').year], [2, { monthly: 1, match: 0, year: 1 }, 0]);
  assert.deepEqual([at('export').plans, at('export').pick, at('export').year, at('export').monthly], [1, { monthly: 0, match: 1, year: 0 }, 1, 0]);
  assert.deepEqual([fun.paid.year, fun.paid.revenueBy.year, fun.steps.year_bought, fun.notSaid.year], [1, 89.99, 1, 0]);
  await app.close();
  console.log('plans.test: the routes checked');
}
restore();

// ---------------------------------------------------------- 7. Postgres ---
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('plans.test: Postgres skipped (no DATABASE_URL)');
} else {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  try {
    const pay = new PgPaymentRepository(pool);
    const tag = randomUUID().slice(0, 8);
    const u = String((await pool.query(`INSERT INTO users (username, password_hash, email, email_verified_at) VALUES ($1, 'x', $2, now()) RETURNING id`, [`plans_${tag}`, `plans_${tag}@example.test`])).rows[0].id);
    const now = new Date();
    // The table takes the three products and nothing else; an order remembers which it is.
    const o = await pay.create({ userId: u, amount: 8999, days: 365, lang: 'ar', testMode: false, now, kind: 'form', paymentId: randomUUID(), product: 'year', src: 'page' });
    assert.deepEqual([o.product, o.src, o.days, o.amount], ['year', 'page', 365, 8999]);
    assert.equal((await pay.get(o.id))!.product, 'year');
    for (const p of ['monthly', 'match'] as const) assert.equal((await pay.create({ userId: u, amount: 999, days: 30, lang: 'en', testMode: false, now, kind: 'form', paymentId: randomUUID(), product: p })).product, p);
    await assert.rejects(pool.query(`UPDATE pro_orders SET product = 'season' WHERE id = $1`, [o.id]), 'the table takes only the three products');
    await assert.rejects(pool.query(`UPDATE pro_orders SET product = 'lifetime' WHERE id = $1`, [o.id]));
    // One pass per paid order, from six confirmations at once, and it runs 365 days.
    const start = new Date();
    const tries = await Promise.all(Array.from({ length: 6 }, () => pay.markPaid(o.id, { paymentId: o.paymentId!, method: 'creditcard', now: start, startsAt: start, endsAt: new Date(start.getTime() + 365 * DAY) })));
    assert.equal(tries.filter((r) => r.ok && r.first).length, 1, 'six confirmations: one pass');
    const passes = (await pool.query(`SELECT plan, starts_at, ends_at FROM pro_passes WHERE user_id = $1`, [u])).rows;
    assert.equal(passes.length, 1);
    assert.deepEqual([passes[0].plan, Math.round((new Date(passes[0].ends_at).getTime() - new Date(passes[0].starts_at).getTime()) / DAY)], ['monthly', 365]);
    assert.ok((await pay.paidOrders(new Date(start.getTime() - HOUR), 100)).some((x) => x.userId === u && x.product === 'year' && x.src === 'page' && x.amount === 8999));
    await pool.query('DELETE FROM users WHERE id = $1', [u]);
    console.log('plans.test: Postgres checked');
  } finally {
    await pool.end();
  }
}
console.log('plans.test: all assertions passed');
