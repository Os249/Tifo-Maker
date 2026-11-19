/**
 * Refunds, told and asked for (19 Nov 2026): the refund email and the site's
 * one-time notice, refund requests from the account page with the owner's
 * Approve and Decline, the PRO_AUTO_REFUND switch, the purchase list and
 * receipts, and cancelling auto-renew from the account page and the email's
 * link. payments.test.mts (v1) and payments2.test.mts (v2) are unchanged.
 *
 * Adversarial where money and trust are: it tries to get the refund email
 * sent twice (the same refund seen from /admin, the webhook, ten deliveries
 * at once and two servers), or not at all (the mail service down when the
 * refund is made); to ask for a refund of someone else's order, of one that
 * is too old, unpaid or already asked for; to be refunded twice; to be
 * auto-refunded after using Pro, or over and over; to answer a request
 * without being the admin; and to see or dismiss another account's notice.
 * Runs on the memory stores, and the store's own guards again on Postgres
 * when DATABASE_URL is set.
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
import { MemoryProRepository, PgProRepository } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository, type PaymentRepository, type ProOrder } from '../src/payRepo';
import { ProService } from '../src/pro';
import {
  MoyasarError,
  type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type MoyasarToken, type NewInvoice, type TokenCharge,
} from '../src/moyasar';
import {
  PaymentService, REFUND_DAYS, autoRefundOn, payLegal, paymentsStatus, type FormConfig, type RefundRequestNotice, type RenewNotice,
} from '../src/payments';
import { receiptEmail } from '../src/payReceipt';
import { refundDeclinedEmail, refundEmail, refundOwnerEmail, refundReceivedEmail } from '../src/payRefundMail';
import { cancelUrlOf, renewEmail } from '../src/payRenewMail';
import type { EmailMessage, EmailSender } from '../src/email';

const DAY = 24 * 3600_000;
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

/** Moyasar, as far as this file needs it: payments made on the form, refunds, tokens. */
class FakeMoyasar implements MoyasarApi {
  payments = new Map<string, MoyasarPayment>();
  tokens = new Map<string, MoyasarToken>();
  refunds: string[] = [];
  failRefund = false;

  async createInvoice(_i: NewInvoice): Promise<MoyasarInvoice> { throw new MoyasarError(0, 'not_used'); }
  async invoice(_id: string): Promise<MoyasarInvoice> { throw new MoyasarError(404, 'record_not_found'); }

  async refund(paymentId: string): Promise<MoyasarPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new MoyasarError(404, 'record_not_found');
    if (this.failRefund) throw new MoyasarError(400, 'invalid_request_error');
    // Moyasar refunds a payment once: a second ask is refused.
    if (p.status === 'refunded') throw new MoyasarError(400, 'invalid_request_error');
    this.refunds.push(paymentId);
    p.status = 'refunded';
    p.refunded = p.amount;
    return { ...p };
  }

  async payment(id: string): Promise<MoyasarPayment | null> {
    const p = this.payments.get(id);
    return p ? { ...p, metadata: { ...p.metadata } } : null;
  }

  async chargeToken(_c: TokenCharge): Promise<MoyasarPayment> { throw new MoyasarError(0, 'not_used'); }

  async token(id: string): Promise<MoyasarToken | null> {
    const t = this.tokens.get(id);
    return t ? { ...t } : null;
  }

  async deleteToken(id: string): Promise<boolean> {
    this.tokens.delete(id);
    return true;
  }

  /** The fan pays on Moyasar's form: a payment under the id the server chose, and a token when the card is saved. */
  formPay(f: FormConfig, orderId: string, o: { save?: boolean; company?: string; type?: string } = {}): MoyasarPayment {
    let token: string | null = null;
    if (o.save) {
      token = `token_${randomUUID().replace(/-/g, '')}`;
      this.tokens.set(token, { id: token, status: 'active', brand: o.company ?? 'visa', lastFour: '1111', month: 12, year: 2030 });
    }
    const p: MoyasarPayment = {
      id: f.givenId, status: 'paid', amount: f.amount, currency: 'SAR', refunded: 0, sourceType: o.type ?? 'creditcard', company: o.company ?? 'visa',
      token, message: null, responseCode: null, transactionUrl: null, invoiceId: null, metadata: { order_id: orderId },
    };
    this.payments.set(p.id, p);
    return p;
  }

  /** A refund made in Moyasar's dashboard, behind the site's back. */
  dashboardRefund(paymentId: string, amount?: number): MoyasarPayment {
    const p = this.payments.get(paymentId)!;
    p.refunded = amount ?? p.amount;
    if (amount === undefined || amount >= p.amount) p.status = 'refunded';
    return p;
  }
}

/** A payment as Moyasar's webhook carries it. */
const hookPayment = (p: MoyasarPayment) => ({
  id: p.id, status: p.status, amount: p.amount, currency: p.currency, refunded: p.refunded, metadata: p.metadata,
  source: { type: p.sourceType, company: p.company, token: p.token, message: p.message, response_code: p.responseCode },
});

const FORM_ENV = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY, MOYASAR_PUBLISHABLE_KEY: PK_LIVE, PRO_CHECKOUT: 'form', MOYASAR_WEBHOOK_SECRET: HOOK };
const RENEW_ENV = { ...FORM_ENV, PRO_AUTORENEW: 'on' };
const AUTO_ENV = { ...FORM_ENV, PRO_AUTO_REFUND: 'on' };
const HOOK_ONLY = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_VERIFY: 'webhook', MOYASAR_PUBLISHABLE_KEY: PK_LIVE, MOYASAR_WEBHOOK_SECRET: HOOK };

/** A payment service on memory stores, a fake Moyasar, a clock the test moves, and every email it asks for. */
function world(env: Record<string, string> = FORM_ENV, api: 'fake' | 'none' = 'fake') {
  const state = { now: new Date('2027-02-01T09:00:00Z'), mailUp: true };
  const proRepo = new MemoryProRepository();
  const payRepo = new MemoryPaymentRepository(proRepo);
  const moyasar = new FakeMoyasar();
  const pro = new ProService(proRepo, { now: () => state.now, savedDesigns: async () => 1, env });
  const refundMails: ProOrder[] = [];
  const mailTries: string[] = [];
  const requestMails: RefundRequestNotice[] = [];
  const renewNotices: RenewNotice[] = [];
  const receipts: { order: string; nextAt: string | null | undefined }[] = [];
  const make = (e: Record<string, string> = env) => new PaymentService(payRepo, pro, api === 'fake' ? moyasar : null, {
    env: e, base: 'https://tifomaker.test',
    onPaid: async (o, _end, _sub, nextAt) => { receipts.push({ order: o.id, nextAt }); },
    onRefunded: async (o) => {
      mailTries.push(o.id);
      if (!state.mailUp) return false;
      refundMails.push(o);
      return true;
    },
    onRequest: async (n) => { requestMails.push(n); },
    notify: async (n) => { renewNotices.push(n); return true; },
  });
  const pay = make();
  const buyer = (name: string) => ({ id: randomUUID(), username: name, email: `${name}@example.test`, emailVerified: true });
  const buy = async (b: ReturnType<typeof buyer>, o: Parameters<FakeMoyasar['formPay']>[2] & { keep?: boolean } = {}) => {
    const c = await pay.checkout(b, 'en', 'https://tifomaker.test');
    assert.ok(c.ok && 'form' in c, `checkout: ${JSON.stringify(c)}`);
    if (o.keep) assert.equal(await pay.setKeep(b.id, c.orderId, true), true);
    const payment = moyasar.formPay(c.form, c.orderId, { ...o, save: o.save ?? o.keep });
    const order = (await pay.orderFor(b.id, c.orderId))!;
    assert.equal(order.status, 'paid');
    return { order, payment, form: c.form };
  };
  const hasPro = async (userId: string): Promise<boolean> => (await proRepo.activePasses(userId, state.now)).some((p) => p.plan === 'monthly');
  /** Use Pro once on the pass the account holds (an AI design). */
  const usePro = async (userId: string): Promise<void> => {
    const t = await pro.take(userId, 'std', await pro.plan(userId));
    assert.equal(t.ok, true, 'a Pro use is counted');
  };
  const forward = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  const mailsFor = (orderId: string): number => refundMails.filter((o) => o.id === orderId).length;
  return { state, proRepo, payRepo, moyasar, pro, pay, make, refundMails, mailTries, requestMails, renewNotices, receipts, buyer, buy, hasPro, usePro, forward, mailsFor };
}

// ------------------------------------------------------------ 1. switches ---
{
  assert.equal(autoRefundOn(FORM_ENV), false, 'automatic refunds are off unless asked for');
  assert.equal(autoRefundOn(AUTO_ENV), true);
  assert.equal(autoRefundOn({ ...AUTO_ENV, PRO_AUTO_REFUND: 'yes' }), false, 'only "on" is on');
  assert.equal(autoRefundOn({ ...AUTO_ENV, PRO_PAYMENTS: 'off' }), false, 'never while payments are off');
  assert.equal(autoRefundOn({ ...HOOK_ONLY, PRO_AUTO_REFUND: 'on' }), false, 'nor with no secret key to refund with');
  assert.deepEqual([paymentsStatus(FORM_ENV).autoRefund, paymentsStatus(AUTO_ENV).autoRefund], [false, true]);
  assert.deepEqual([paymentsStatus({ ...HOOK_ONLY, PRO_AUTO_REFUND: 'on' }).autoRefundAsked, paymentsStatus({ ...HOOK_ONLY, PRO_AUTO_REFUND: 'on' }).autoRefund], [true, false]);
  assert.equal(REFUND_DAYS, 7);
  console.log('payments3.test: switches checked');
}

// --------------------------------------------- 2. the refund email, once ---
{
  // From /admin.
  const w = world();
  const fan = w.buyer('refund_admin');
  const { order } = await w.buy(fan);
  assert.equal(await w.hasPro(fan.id), true);
  assert.equal(w.refundMails.length, 0, 'nothing is said before a refund');
  const r = await w.pay.refund(order.id);
  assert.equal(r.ok, true);
  assert.equal(await w.hasPro(fan.id), false, 'the refund ended the pass');
  assert.equal(w.mailsFor(order.id), 1, 'the fan is emailed');
  // Asked again, read again, told again by Moyasar: still one email, and no second refund.
  assert.deepEqual(await w.pay.refund(order.id), { ok: false, reason: 'not_paid' });
  await w.pay.orderFor(fan.id, order.id);
  await w.pay.reconcile((await w.payRepo.get(order.id))!);
  for (let i = 0; i < 5; i++) assert.equal(await w.pay.webhook({ secret_token: HOOK, type: 'payment_refunded', live: true, data: hookPayment(w.moyasar.payments.get(order.paymentId!)!) }), 'done');
  await w.pay.runRenewals();
  assert.equal(w.mailsFor(order.id), 1, 'exactly once per refund, from /admin');
  assert.equal(w.moyasar.refunds.length, 1, 'and the money went back once');
  const after = (await w.payRepo.get(order.id))!;
  assert.ok(after.refundMailAt && after.refundedAt);

  // What it says: the order, the amount, the date, that Pro ended, how the money comes back, who to ask.
  const mail = refundEmail({ order: after, to: fan.email, base: 'https://tifomaker.test', contact: 'help@tifomaker.test' });
  assert.equal(mail.to, fan.email);
  assert.ok(!/^\[TEST\]/.test(mail.subject), 'real money is not called a test');
  for (const part of [mail.html, mail.text ?? '']) {
    assert.ok(part.includes('SAR 19') && part.includes('19.99 ريال'), 'the amount, in both languages');
    assert.ok(part.includes(order.paymentId!), 'the reference');
    assert.ok(/1 February 2027/.test(part), 'the date');
    assert.ok(/has ended/.test(part) && part.includes('انتهى'), 'that Pro ended');
    assert.ok(/the way you paid|same card or wallet/.test(part) && /few working days/.test(part) && /depends on your bank|depending on your bank/.test(part), 'how and when the money comes back, honestly');
    assert.ok(part.includes('help@tifomaker.test'), 'who to ask');
    assert.ok(part.includes('https://tifomaker.test/account#pro'), 'the way to their purchases');
  }
  assert.ok(mail.html.includes('dir="rtl"') && mail.html.includes('dir="ltr"'), 'the receipt\'s two-language layout');
  // A test-mode refund says it is a test.
  const testMail = refundEmail({ order: { ...after, testMode: true }, to: fan.email, base: 'https://tifomaker.test', contact: 'c' });
  assert.match(testMail.subject, /^\[TEST\]/);
  assert.ok(testMail.html.includes('This is a test refund: no real money moved.') && testMail.html.includes('استرداد تجريبي') && testMail.text!.startsWith('TEST:'));
  // A partial refund says how much actually went back.
  assert.ok(refundEmail({ order: { ...after, refunded: 500 }, to: fan.email, base: 'https://tifomaker.test', contact: 'c' }).html.includes('SAR 5') );

  // From Moyasar's dashboard, through the webhook: ten deliveries at once, on two servers.
  const w2 = world();
  const fan2 = w2.buyer('refund_hook');
  const b2 = await w2.buy(fan2);
  w2.moyasar.dashboardRefund(b2.payment.id);
  const second = w2.make();
  const event = { secret_token: HOOK, type: 'payment_refunded', live: true, data: hookPayment(w2.moyasar.payments.get(b2.payment.id)!) };
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? second : w2.pay).webhook(event)));
  assert.ok(answers.every((a) => a === 'done'));
  assert.equal((await w2.payRepo.get(b2.order.id))!.status, 'refunded');
  assert.equal(await w2.hasPro(fan2.id), false, 'the webhook ended the pass');
  assert.equal(w2.mailsFor(b2.order.id), 1, 'exactly once per refund, from the webhook, however many deliveries');
  assert.equal(w2.mailTries.length, 1, 'only one of them even tried');
  assert.equal(await w2.pay.webhook({ ...event, secret_token: 'not-the-secret-at-all-no' }), 'refused');
  // And /admin pressing Refund on it afterwards changes nothing.
  assert.deepEqual(await w2.pay.refund(b2.order.id), { ok: false, reason: 'not_paid' });
  assert.equal(w2.mailsFor(b2.order.id), 1);
  assert.equal(w2.moyasar.refunds.length, 0, 'the site never refunded it a second time');

  // No secret key on the server: the webhook's own word ends the pass, and the email still goes once.
  const w3 = world(HOOK_ONLY, 'none');
  const fan3 = w3.buyer('refund_hook_only');
  const c3 = await w3.pay.checkout(fan3, 'ar', 'https://tifomaker.test');
  assert.ok(c3.ok && 'form' in c3);
  const p3 = w3.moyasar.formPay(c3.form, c3.orderId);
  assert.equal(await w3.pay.webhook({ secret_token: HOOK, type: 'payment_paid', live: true, data: hookPayment(p3) }), 'done');
  assert.equal(await w3.hasPro(fan3.id), true);
  assert.deepEqual(await w3.pay.refund(c3.orderId), { ok: false, reason: 'dashboard' }, 'no key: the refund is made in Moyasar\'s dashboard');
  const gone = { ...hookPayment(p3), status: 'refunded', refunded: p3.amount };
  for (let i = 0; i < 3; i++) await w3.pay.webhook({ secret_token: HOOK, type: 'payment_refunded', live: true, data: gone });
  assert.equal(await w3.hasPro(fan3.id), false);
  assert.equal(w3.mailsFor(c3.orderId), 1, 'once, in the webhook-only mode too');
  assert.equal(await w3.pay.webhook({ secret_token: HOOK, type: 'payment_refunded', live: false, data: gone }), 'ignored', 'test money never touches a live order');

  // The mail service is down when the refund is made: the email is owed, and the job sends it once.
  const w4 = world();
  const fan4 = w4.buyer('refund_mail_down');
  const b4 = await w4.buy(fan4);
  w4.state.mailUp = false;
  assert.equal((await w4.pay.refund(b4.order.id)).ok, true, 'the refund itself does not wait for the email');
  assert.equal(w4.mailsFor(b4.order.id), 0);
  assert.equal((await w4.payRepo.get(b4.order.id))!.refundMailAt, null, 'not marked as sent');
  await w4.pay.runRenewals();
  assert.equal(w4.mailsFor(b4.order.id), 0, 'still down: still owed');
  w4.state.mailUp = true;
  await Promise.all([w4.pay.runRenewals(), w4.make().runRenewals(), w4.make().runRenewals()]);
  await w4.pay.runRenewals();
  assert.equal(w4.mailsFor(b4.order.id), 1, 'sent once when the mail service is back, from three servers running the job');
  // ...and never while payments are switched off.
  const w5 = world();
  const b5 = await w5.buy(w5.buyer('refund_then_off'));
  w5.state.mailUp = false;
  await w5.pay.refund(b5.order.id);
  w5.state.mailUp = true;
  await w5.make({ ...FORM_ENV, PRO_PAYMENTS: 'off' }).runRenewals();
  assert.equal(w5.mailsFor(b5.order.id), 0, 'nothing is sent while payments are off');

  // An order whose account is gone has nobody to tell.
  const w6 = world();
  const fan6 = w6.buyer('refund_deleted');
  const b6 = await w6.buy(fan6);
  w6.payRepo.forgetUser(fan6.id);
  assert.equal((await w6.pay.refund(b6.order.id)).ok, true);
  assert.equal(w6.mailTries.length, 0);
  console.log('payments3.test: the refund email is sent exactly once, from /admin and from the webhook');
}

// ------------------------------------------ 3. the site's one-time notice ---
{
  const w = world();
  const fan = w.buyer('notice_fan');
  const other = w.buyer('notice_other');
  const { order } = await w.buy(fan);
  await w.buy(other);
  assert.equal(await w.pay.refundNotice(fan.id), null, 'nothing to say while it is paid');
  await w.pay.refund(order.id);
  assert.equal((await w.pay.refundNotice(fan.id))!.id, order.id, 'the refund is waiting to be said');
  assert.equal(await w.pay.refundNotice(other.id), null, 'to its own account only');
  assert.equal(await w.pay.seenRefund(other.id, order.id), false, 'someone else cannot dismiss it');
  assert.equal(await w.pay.seenRefund(fan.id, randomUUID()), false, 'nor an order that is not there');
  assert.equal((await w.pay.refundNotice(fan.id))!.id, order.id, 'none of that hid it');
  assert.equal(await w.pay.seenRefund(fan.id, order.id), true);
  assert.equal(await w.pay.refundNotice(fan.id), null, 'shown once');
  assert.equal(await w.pay.seenRefund(fan.id, order.id), false, 'and marked once');
  // Two refunds waiting are one card, not two in a row.
  w.forward(8 * DAY);
  const a = await w.buy(fan);
  w.forward(31 * DAY);
  const b = await w.buy(fan);
  await w.pay.refund(a.order.id, true);
  await w.pay.refund(b.order.id);
  assert.equal(await w.pay.seenRefund(fan.id, b.order.id), true);
  assert.equal(await w.pay.refundNotice(fan.id), null);
  // An old refund nobody was told about is not dug up months later.
  const w2 = world();
  const late = w2.buyer('notice_old');
  const o2 = await w2.buy(late);
  await w2.pay.refund(o2.order.id);
  w2.forward(31 * DAY);
  assert.equal(await w2.pay.refundNotice(late.id), null);
  console.log('payments3.test: the in-site notice is shown once');
}

// ------------------------------------- 4. refund requests: who, and when ---
{
  const w = world();
  const fan = w.buyer('ask_fan');
  const other = w.buyer('ask_other');
  const { order } = await w.buy(fan);
  const theirs = await w.buy(other);

  // Not the fan's own order, or no order at all.
  assert.deepEqual(await w.pay.requestRefund(fan.id, theirs.order.id, 'mine now'), { ok: false, reason: 'none' }, 'someone else\'s order is no order');
  assert.deepEqual(await w.pay.requestRefund(fan.id, randomUUID(), null), { ok: false, reason: 'none' });
  assert.equal(await w.payRepo.requestForOrder(theirs.order.id), null, 'nothing was recorded against it');
  // An order that was never paid.
  const window_ = w.buyer('ask_unpaid');
  const open = await w.pay.checkout(window_, 'en', 'https://tifomaker.test');
  assert.ok(open.ok && 'form' in open);
  assert.deepEqual(await w.pay.requestRefund(window_.id, open.orderId, null), { ok: false, reason: 'not_paid' });
  assert.deepEqual(await w.pay.purchases(window_.id), [], 'an order that was opened and never sent is not a purchase');
  w.forward(8 * DAY);
  // Too old: the first order was paid 8 days ago.
  assert.deepEqual(await w.pay.requestRefund(fan.id, order.id, 'please'), { ok: false, reason: 'late' }, 'past the 7 days');
  assert.equal(await w.payRepo.requestForOrder(order.id), null);
  assert.equal(w.requestMails.length, 0, 'none of those emailed anyone');
  const list = await w.pay.purchases(fan.id);
  assert.deepEqual(list.map((p) => [p.order.id, p.refund.state]), [[order.id, 'late']], 'the list says why: too late');
  assert.equal(Date.parse(list[0].refund.until!) - Date.parse(order.paidAt!), REFUND_DAYS * DAY);

  // In time, to the minute.
  const w2 = world();
  const f2 = w2.buyer('ask_edge');
  const b2 = await w2.buy(f2);
  w2.forward(REFUND_DAYS * DAY);
  assert.equal((await w2.pay.purchases(f2.id))[0].refund.state, 'open');
  w2.forward(1000);
  assert.equal((await w2.pay.purchases(f2.id))[0].refund.state, 'late');
  assert.deepEqual(await w2.pay.requestRefund(f2.id, b2.order.id, null), { ok: false, reason: 'late' });

  // A request in time: recorded once, and it does NOT refund by itself.
  const w3 = world();
  const f3 = w3.buyer('ask_ok');
  const b3 = await w3.buy(f3, { company: 'mada' });
  assert.deepEqual((await w3.pay.purchases(f3.id)).map((p) => [p.refund.state, p.refund.used, p.order.brand, p.order.method]), [['open', false, 'mada', 'creditcard']]);
  const asked = await w3.pay.requestRefund(f3.id, b3.order.id, '  changed my\u0000 mind \n\n really  ');
  assert.deepEqual(asked, { ok: true, state: 'requested' });
  assert.equal(await w3.hasPro(f3.id), true, 'by default nothing is refunded automatically');
  assert.equal(w3.moyasar.refunds.length, 0);
  assert.equal(w3.refundMails.length, 0);
  assert.deepEqual(w3.requestMails.map((n) => [n.kind, n.order.id]), [['received', b3.order.id]], 'the owner and the fan are told it arrived');
  const rq = (await w3.payRepo.requestForOrder(b3.order.id))!;
  assert.deepEqual([rq.status, rq.note, rq.used, rq.auto, rq.userId], ['pending', 'changed my mind really', 0, false, f3.id], 'the note is kept, tidied');
  assert.deepEqual(await w3.pay.requestRefund(f3.id, b3.order.id, 'again'), { ok: false, reason: 'already' }, 'one request per order');
  const twice = await Promise.all(Array.from({ length: 5 }, () => w3.pay.requestRefund(f3.id, b3.order.id, null)));
  assert.ok(twice.every((x) => !x.ok));
  assert.equal(w3.requestMails.length, 1);
  assert.equal((await w3.pay.purchases(f3.id))[0].refund.state, 'requested');
  assert.equal((await w3.pay.refundRequests()).length, 1);

  // "Used" is what the fan and the owner are shown; it does not block asking.
  const w4 = world();
  const f4 = w4.buyer('ask_used');
  const b4 = await w4.buy(f4);
  await w4.usePro(f4.id);
  assert.equal((await w4.pay.purchases(f4.id))[0].refund.used, true);
  assert.deepEqual(await w4.pay.requestRefund(f4.id, b4.order.id, null), { ok: true, state: 'requested' });
  assert.equal((await w4.payRepo.requestForOrder(b4.order.id))!.used, 1, 'the owner sees it was used when they asked');

  // The emails a request owes.
  const base = { order: b3.order, request: rq, to: f3.email, base: 'https://tifomaker.test', contact: 'help@tifomaker.test' };
  const got = refundReceivedEmail(base);
  assert.ok(got.html.includes('SAR 19') && got.html.includes('within 3 working days') && got.html.includes('خلال 3 أيام عمل') && /Pro stays on/.test(got.html));
  const no = refundDeclinedEmail({ ...base, request: { ...rq, status: 'declined', declineReason: 'Pro was used <b>12</b> times' } });
  assert.ok(no.html.includes('Pro was used &lt;b&gt;12&lt;/b&gt; times'), 'the reason, and nothing in it is markup');
  assert.ok(no.text!.includes('Pro was used <b>12</b> times') && /Pro stays on/.test(no.html) && no.html.includes('help@tifomaker.test'));
  const owner = refundOwnerEmail({ order: b3.order, request: { ...rq, note: '<script>x</script>' }, username: 'ask_ok', to: 'owner@tifomaker.test', base: 'https://tifomaker.test' });
  assert.equal(owner.to, 'owner@tifomaker.test');
  assert.ok(/Refund request from @ask_ok: SAR 19/.test(owner.subject) && owner.html.includes('Pro not used') && owner.html.includes('&lt;script&gt;') && !owner.html.includes('<script>') && owner.html.includes('/admin'));
  assert.ok(refundOwnerEmail({ order: b4.order, request: (await w4.payRepo.requestForOrder(b4.order.id))!, username: null, to: 'o@t.test', base: 'https://tifomaker.test' }).html.includes('Pro used: 1 use counted'));
  console.log('payments3.test: a request on an order that is too old, unpaid or not the fan\'s own is refused');
}

// ------------------------------------------------- 5. approve and decline ---
{
  const w = world();
  const fan = w.buyer('decide_fan');
  const { order } = await w.buy(fan);
  await w.pay.requestRefund(fan.id, order.id, 'not for me');
  const rq = (await w.payRepo.requestForOrder(order.id))!;
  assert.deepEqual(await w.pay.decideRequest(randomUUID(), 'approve', null), { ok: false, reason: 'none' });

  // Decline: a reason is required, and it reaches the fan; Pro stays.
  for (const bad of [null, '', '  ', 'no']) assert.deepEqual(await w.pay.decideRequest(rq.id, 'decline', bad), { ok: false, reason: 'reason' });
  assert.equal((await w.payRepo.requestById(rq.id))!.status, 'pending');
  assert.deepEqual(await w.pay.decideRequest(rq.id, 'decline', '  Pro was used   on three designs '), { ok: true, status: 'declined' });
  const declined = (await w.payRepo.requestById(rq.id))!;
  assert.deepEqual([declined.status, declined.declineReason, declined.auto], ['declined', 'Pro was used on three designs', false]);
  assert.ok(declined.decidedAt);
  assert.equal(await w.hasPro(fan.id), true, 'declined: Pro stays on');
  assert.equal(w.moyasar.refunds.length, 0);
  assert.equal(w.refundMails.length, 0);
  const told = w.requestMails.filter((n) => n.kind === 'declined');
  assert.equal(told.length, 1);
  assert.equal(told[0].request.declineReason, 'Pro was used on three designs');
  const mine = (await w.pay.purchases(fan.id))[0];
  assert.deepEqual([mine.refund.state, mine.refund.reason], ['declined', 'Pro was used on three designs'], 'the account page says why');
  // Answered is answered: not twice, not the other way, and not asked again.
  assert.deepEqual(await w.pay.decideRequest(rq.id, 'approve', null), { ok: false, reason: 'decided' });
  assert.deepEqual(await w.pay.decideRequest(rq.id, 'decline', 'again, with a reason'), { ok: false, reason: 'decided' });
  assert.deepEqual(await w.pay.requestRefund(fan.id, order.id, null), { ok: false, reason: 'already' });
  assert.equal(w.moyasar.refunds.length, 0);
  // The owner can still refund it by hand from the orders table, and that tells the fan.
  assert.equal((await w.pay.refund(order.id)).ok, true);
  assert.equal(w.mailsFor(order.id), 1);
  assert.equal((await w.payRepo.requestById(rq.id))!.status, 'declined', 'the old answer stays as the record');

  // Approve: Moyasar refuses first, and nothing is half done.
  const w2 = world();
  const f2 = w2.buyer('decide_ok');
  const b2 = await w2.buy(f2);
  await w2.pay.requestRefund(f2.id, b2.order.id, null);
  const r2 = (await w2.payRepo.requestForOrder(b2.order.id))!;
  w2.moyasar.failRefund = true;
  assert.deepEqual(await w2.pay.decideRequest(r2.id, 'approve', null), { ok: false, reason: 'failed' });
  assert.equal((await w2.payRepo.requestById(r2.id))!.status, 'pending', 'still waiting');
  assert.equal(await w2.hasPro(f2.id), true);
  assert.equal(w2.refundMails.length, 0, 'nobody is told of a refund that did not happen');
  w2.moyasar.failRefund = false;
  // Approve, pressed five times at once: one refund, one email, one answer.
  w2.forward(20 * DAY); // answered late: the request was made in time, so it is still honoured
  const five = await Promise.all(Array.from({ length: 5 }, () => w2.pay.decideRequest(r2.id, 'approve', null)));
  assert.ok(five.some((x) => x.ok), JSON.stringify(five));
  assert.equal(w2.moyasar.refunds.length, 1, 'refunded once');
  assert.equal((await w2.payRepo.get(b2.order.id))!.status, 'refunded');
  assert.equal(await w2.hasPro(f2.id), false, 'the refund ended the pass');
  assert.equal(w2.mailsFor(b2.order.id), 1, 'the fan gets the refund email, once');
  const done = (await w2.payRepo.requestById(r2.id))!;
  assert.deepEqual([done.status, done.auto, done.declineReason], ['approved', false, null]);
  assert.deepEqual(await w2.pay.decideRequest(r2.id, 'decline', 'changed my mind'), { ok: false, reason: 'decided' });
  assert.equal((await w2.pay.purchases(f2.id))[0].refund.state, 'refunded');
  assert.equal((await w2.pay.refundNotice(f2.id))!.id, b2.order.id, 'and the site says so, once');

  // A request answered from elsewhere: refunded from the orders table, or in Moyasar's dashboard.
  const w3 = world();
  const f3 = w3.buyer('decide_elsewhere');
  const b3 = await w3.buy(f3);
  await w3.pay.requestRefund(f3.id, b3.order.id, null);
  w3.moyasar.dashboardRefund(b3.payment.id);
  await w3.pay.webhook({ secret_token: HOOK, type: 'payment_refunded', live: true, data: hookPayment(w3.moyasar.payments.get(b3.payment.id)!) });
  assert.equal((await w3.payRepo.requestForOrder(b3.order.id))!.status, 'approved', 'the refund itself closes the request');
  assert.equal(w3.mailsFor(b3.order.id), 1);

  // No secret key: Approve cannot refund from here, and says where to.
  const w4 = world(HOOK_ONLY, 'none');
  const f4 = w4.buyer('decide_hook');
  const c4 = await w4.pay.checkout(f4, 'en', 'https://tifomaker.test');
  assert.ok(c4.ok && 'form' in c4);
  const p4 = w4.moyasar.formPay(c4.form, c4.orderId);
  await w4.pay.webhook({ secret_token: HOOK, type: 'payment_paid', live: true, data: hookPayment(p4) });
  assert.deepEqual(await w4.pay.requestRefund(f4.id, c4.orderId, null), { ok: true, state: 'requested' });
  const r4 = (await w4.payRepo.requestForOrder(c4.orderId))!;
  assert.deepEqual(await w4.pay.decideRequest(r4.id, 'approve', null), { ok: false, reason: 'dashboard' });
  assert.equal((await w4.payRepo.requestById(r4.id))!.status, 'pending');
  await w4.pay.webhook({ secret_token: HOOK, type: 'payment_refunded', live: true, data: { ...hookPayment(p4), status: 'refunded', refunded: p4.amount } });
  assert.equal((await w4.payRepo.requestById(r4.id))!.status, 'approved');
  assert.equal(w4.mailsFor(c4.orderId), 1);
  console.log('payments3.test: approve and decline checked');
}

// ---------------------------------------- 6. the auto-refund switch ---
{
  // Off (the default): covered above, nothing is refunded by asking.
  const w = world(AUTO_ENV);
  const fan = w.buyer('auto_fan');
  const { order } = await w.buy(fan);
  // In time and not used: refunded at once, with the refund email and no "we received it".
  assert.deepEqual(await w.pay.requestRefund(fan.id, order.id, 'bought by mistake'), { ok: true, state: 'refunded' });
  assert.equal(w.moyasar.refunds.length, 1);
  assert.equal(await w.hasPro(fan.id), false, 'the pass ended');
  assert.equal(w.mailsFor(order.id), 1, 'the refund email, once');
  assert.equal(w.requestMails.length, 0, 'the owner is not asked');
  const rq = (await w.payRepo.requestForOrder(order.id))!;
  assert.deepEqual([rq.status, rq.auto, rq.used], ['approved', true, 0], 'recorded as the switch\'s doing');
  assert.deepEqual(await w.pay.requestRefund(fan.id, order.id, null), { ok: false, reason: 'refunded' }, 'no refund twice');
  assert.equal(w.moyasar.refunds.length, 1);
  // The same account again: never automatically twice (buy, refund, buy, refund costs a fee each time).
  w.forward(DAY);
  const again = await w.buy(fan);
  assert.deepEqual(await w.pay.requestRefund(fan.id, again.order.id, null), { ok: true, state: 'requested' }, 'the second one waits for the owner');
  assert.equal(w.moyasar.refunds.length, 1);
  assert.equal(await w.hasPro(fan.id), true);
  assert.equal(w.requestMails.filter((n) => n.kind === 'received').length, 1);

  // Pro was used: it waits for the owner.
  const used = w.buyer('auto_used');
  const bu = await w.buy(used);
  await w.usePro(used.id);
  assert.deepEqual(await w.pay.requestRefund(used.id, bu.order.id, null), { ok: true, state: 'requested' });
  assert.equal(await w.hasPro(used.id), true, 'used Pro is not refunded by itself');
  assert.equal((await w.payRepo.requestForOrder(bu.order.id))!.auto, false);
  // Too old, or not theirs: refused exactly as with the switch off.
  const old = w.buyer('auto_old');
  const bo = await w.buy(old);
  w.forward(8 * DAY);
  assert.deepEqual(await w.pay.requestRefund(old.id, bo.order.id, null), { ok: false, reason: 'late' });
  assert.deepEqual(await w.pay.requestRefund(old.id, bu.order.id, null), { ok: false, reason: 'none' });
  assert.equal(w.moyasar.refunds.length, 1, 'neither moved any money');

  // Moyasar refuses the automatic refund: the request is kept for the owner, and nobody is told "refunded".
  const w2 = world(AUTO_ENV);
  const f2 = w2.buyer('auto_refused');
  const b2 = await w2.buy(f2);
  w2.moyasar.failRefund = true;
  assert.deepEqual(await w2.pay.requestRefund(f2.id, b2.order.id, null), { ok: true, state: 'requested' });
  assert.equal((await w2.payRepo.requestForOrder(b2.order.id))!.status, 'pending');
  assert.equal(await w2.hasPro(f2.id), true);
  assert.deepEqual([w2.refundMails.length, w2.requestMails.length], [0, 1]);

  // Five presses at once with the switch on: one request, one refund, one email.
  const w3 = world(AUTO_ENV);
  const f3 = w3.buyer('auto_race');
  const b3 = await w3.buy(f3);
  const all = await Promise.all(Array.from({ length: 5 }, () => w3.pay.requestRefund(f3.id, b3.order.id, null)));
  assert.equal(all.filter((x) => x.ok).length, 1);
  assert.equal(w3.moyasar.refunds.length, 1);
  assert.equal(w3.mailsFor(b3.order.id), 1);

  // The switch set where it cannot work (no secret key): requests simply wait.
  const w4 = world({ ...HOOK_ONLY, PRO_AUTO_REFUND: 'on' }, 'none');
  const f4 = w4.buyer('auto_nokey');
  const c4 = await w4.pay.checkout(f4, 'en', 'https://tifomaker.test');
  assert.ok(c4.ok && 'form' in c4);
  await w4.pay.webhook({ secret_token: HOOK, type: 'payment_paid', live: true, data: hookPayment(w4.moyasar.formPay(c4.form, c4.orderId)) });
  assert.deepEqual(await w4.pay.requestRefund(f4.id, c4.orderId, null), { ok: true, state: 'requested' });
  assert.equal(await w4.hasPro(f4.id), true);
  console.log('payments3.test: the auto-refund switch checked');
}

// --------------------------------- 7. purchases, receipts, auto-renew cancel ---
{
  const w = world(RENEW_ENV);
  const fan = w.buyer('list_fan');
  const stranger = w.buyer('list_stranger');
  assert.deepEqual(await w.pay.purchases(fan.id), [], 'nothing bought: nothing listed');
  // Opened and never sent: not a purchase.
  const opened = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(opened.ok);
  assert.deepEqual(await w.pay.purchases(fan.id), []);
  const { order, payment } = await w.buy(fan, { keep: true });
  const list = await w.pay.purchases(fan.id);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].order.id, list[0].order.status, list[0].refund.state, list[0].order.brand], [order.id, 'paid', 'open', 'visa']);
  assert.equal(list[0].endsAt, (await w.proRepo.activePasses(fan.id, w.state.now))[0].endsAt, 'with when its Pro ends');
  assert.deepEqual(await w.pay.purchases(stranger.id), [], 'nobody else\'s list has it');

  // The receipt again: to its owner, not twice in a minute, and it still says when it renews.
  const before = w.receipts.length;
  assert.equal(await w.pay.resendReceipt(stranger.id, order.id), 'none', 'not someone else\'s receipt');
  assert.equal(await w.pay.resendReceipt(fan.id, randomUUID()), 'none');
  assert.equal(await w.pay.resendReceipt(fan.id, order.id), 'sent');
  assert.equal(await w.pay.resendReceipt(fan.id, order.id), 'wait');
  assert.equal(w.receipts.length, before + 1);
  assert.equal(w.receipts.at(-1)!.nextAt, (await w.pay.renewalFor(fan.id))!.nextChargeAt, 'with the next renewal\'s real date');
  w.forward(6 * 60_000);
  assert.equal(await w.pay.resendReceipt(fan.id, order.id), 'sent');

  // Auto-renew, cancelled from the account page: off at once, the card deleted, Pro kept, an email.
  const sub = (await w.pay.renewalFor(fan.id))!;
  assert.deepEqual([sub.status, w.moyasar.tokens.has(payment.token!)], ['active', true]);
  assert.equal(await w.pay.stopRenewing(stranger.id, 'account page'), false, 'someone with none turns nothing off');
  assert.equal((await w.pay.renewalFor(fan.id))!.status, 'active');
  assert.equal(await w.pay.stopRenewing(fan.id, 'account page'), true);
  const off = (await w.pay.renewalFor(fan.id))!;
  assert.deepEqual([off.status, off.token, off.nextChargeAt, off.endReason], ['cancelled', null, null, 'account page']);
  assert.equal(w.moyasar.tokens.has(payment.token!), false, 'the saved card is deleted at Moyasar');
  assert.equal(await w.hasPro(fan.id), true, 'Pro stays on until the paid days end');
  assert.equal(w.renewNotices.filter((n) => n.kind === 'cancelled').length, 1, 'and an email confirms it');
  assert.equal(await w.pay.stopRenewing(fan.id, 'account page'), false, 'once');
  // Nothing is charged after that, whatever the job does.
  w.forward(40 * DAY);
  const run = await w.pay.runRenewals();
  assert.deepEqual([run.reminded, run.charged], [0, 0]);
  // A receipt sent again after cancelling promises no renewal.
  assert.equal(await w.pay.resendReceipt(fan.id, order.id), 'sent');
  assert.equal(w.receipts.at(-1)!.nextAt, null);

  // The reminder's cancel link works on its own: no sign-in, one click, and it leads nowhere else.
  const keeper = w.buyer('list_keeper');
  const kb = await w.buy(keeper, { keep: true });
  const ks = (await w.pay.renewalFor(keeper.id))!;
  const reminder = renewEmail({ notice: { kind: 'reminder', sub: ks, chargeAt: ks.nextChargeAt! }, to: keeper.email, base: 'https://tifomaker.test', contact: 'c' });
  const link = cancelUrlOf('https://tifomaker.test', ks);
  assert.ok(reminder.html.includes(link.replace(/&/g, '&amp;')) && reminder.text!.includes(link), 'the reminder carries the one-click link');
  assert.ok(reminder.html.includes('https://tifomaker.test/account#pro'), 'and the way to the account page');
  const token = new URL(link).searchParams.get('stop')!;
  assert.deepEqual(await w.pay.cancelByLink('x'.repeat(40)), { ok: false });
  const stopped = await w.pay.cancelByLink(token);
  assert.ok(stopped.ok && stopped.was, 'the link turns it off by itself');
  assert.equal((await w.pay.renewalFor(keeper.id))!.status, 'cancelled');
  assert.equal(w.moyasar.tokens.has(kb.payment.token!), false);
  assert.equal(await w.hasPro(keeper.id), true);
  const again = await w.pay.cancelByLink(token);
  assert.ok(again.ok && !again.was, 'pressed again: still off, and it says so');

  // A refund turns auto-renew off too, and its receipt says refunded rather than promising a renewal.
  const third = w.buyer('list_refunded');
  const tb = await w.buy(third, { keep: true });
  assert.equal((await w.pay.renewalFor(third.id))!.status, 'active');
  await w.pay.refund(tb.order.id);
  assert.equal((await w.pay.renewalFor(third.id))!.status, 'cancelled');
  assert.equal(w.renewNotices.filter((n) => n.kind === 'cancelled' && n.sub.userId === third.id).length, 0, 'one email about it (the refund\'s), not two');
  assert.equal(w.mailsFor(tb.order.id), 1);
  const refunded = (await w.payRepo.get(tb.order.id))!;
  const rc = receiptEmail({ order: refunded, to: third.email, endsAt: null, base: 'https://tifomaker.test', contact: 'c', renew: { nextAt: w.state.now.toISOString(), cancelUrl: 'https://tifomaker.test/pro?stop=x' } });
  assert.ok(rc.html.includes('This order was refunded on') && !rc.html.includes('Auto-renew is on') && !rc.html.includes('You can ask for a full refund'));

  // An order that did not go through is listed for a month, then dropped.
  const failer = w.buyer('list_failed');
  const fc = await w.pay.checkout(failer, 'en', 'https://tifomaker.test');
  assert.ok(fc.ok && 'form' in fc);
  w.moyasar.payments.set(fc.form.givenId, { ...w.moyasar.formPay(fc.form, fc.orderId), status: 'failed', message: 'INSUFFICIENT FUNDS', responseCode: '51' });
  await w.pay.orderFor(failer.id, fc.orderId);
  const failed = await w.pay.purchases(failer.id);
  assert.deepEqual(failed.map((p) => [p.order.status, p.refund.state]), [['failed', 'none']]);
  assert.deepEqual(await w.pay.requestRefund(failer.id, fc.orderId, null), { ok: false, reason: 'not_paid' });
  w.forward(31 * DAY);
  assert.deepEqual(await w.pay.purchases(failer.id), []);
  console.log('payments3.test: purchases, receipts and auto-renew cancel checked');
}

// ------------------------------------- 8. the promises say the same thing ---
{
  const legal = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  const on = payLegal(legal, true, false);
  const off = payLegal(legal, false, false);
  assert.ok(on.includes('within 7 days of paying') && on.includes('خلال 7 أيام من الدفع'));
  assert.ok(on.includes('under "Pro and purchases", press "Request a refund"') && on.includes('href="/account#pro"'), 'how to ask, from the account page');
  assert.ok(on.includes('تحت «برو ومشترياتك» اضغط «اطلب استرداد»') && on.includes('href="/ar/account#pro"'), 'and in Arabic');
  assert.ok(on.includes('within 3 working days') && on.includes('خلال 3 أيام عمل'));
  assert.ok(!off.includes('Request a refund') && !off.includes('اطلب استرداد') && !off.includes('Pro and purchases'), 'none of it is served while Pro is not on sale');
  const strings = readFileSync(new URL('../../src/ui/i18n/strings.ts', import.meta.url), 'utf8');
  assert.ok(strings.includes("'ac.pro.titleBuy': { en: 'Pro and purchases', ar: 'برو ومشترياتك' }"), 'the section is called what /legal and the receipt call it');
  assert.ok(strings.includes("'pu.rf.ask': { en: 'Request a refund', ar: 'اطلب استرداد' }"));
  const order = { ...(await (async () => { const w = world(); return (await w.buy(w.buyer('promise_fan'))).order; })()) };
  const rc = receiptEmail({ order, to: 'f@example.test', endsAt: null, base: 'https://tifomaker.test', contact: 'help@tifomaker.test' });
  assert.ok(rc.html.includes(`within ${REFUND_DAYS} days of paying if you haven&#39;t used Pro`) && rc.html.includes('under &quot;Pro and purchases&quot;, press &quot;Request a refund&quot;') && rc.html.includes('https://tifomaker.test/account#pro'));
  assert.ok(rc.html.includes(`خلال ${REFUND_DAYS} أيام من الدفع إذا ما استخدمت برو`) && rc.html.includes('«برو ومشترياتك»') && rc.html.includes('«اطلب استرداد»'));
  assert.ok(rc.text!.includes('ask on your account page (https://tifomaker.test/account#pro)'));
  console.log('payments3.test: /legal, the receipt and the account page promise the same refund');
}

// ------------------------------------------------ 9. the routes, end to end ---
const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
  }
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
  MOYASAR_PROXY_URL: undefined, MOYASAR_METHODS: undefined, APPLE_PAY_DOMAIN_ASSOCIATION: undefined, MOYASAR_SAMSUNG_SERVICE_ID: undefined, PRO_AUTO_REFUND: undefined,
};
const restore = setEnv(ALL_OFF);
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const proRepo = new MemoryProRepository((id) => auth.usernameOf(id));
  const payRepo = new MemoryPaymentRepository(proRepo, (id) => auth.usernameOf(id));
  const moyasar = new FakeMoyasar();
  const outbox = new Outbox();
  const app = await buildApp(designs, auth, templates, {
    social: new MemorySocialRepository(designs, auth), leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(),
    aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
    pro: proRepo, payments: payRepo, moyasar, emailSender: outbox, publicUrl: 'https://tifomaker.test',
    adminUsernames: ['boss_pay3'], aiAdminPassword: 'pay3 admin password',
  });
  const fan = await reg(app, 'r_fan');
  const other = await reg(app, 'r_other');
  const hooked = await reg(app, 'r_hooked');
  const never = await reg(app, 'r_never');
  for (const u of [fan, other, hooked, never]) await auth.markEmailVerified(u.id);
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'pay3 admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };
  const post = (url: string, token: string | null, payload: object = {}) => app.inject({ method: 'POST', url, ...(token ? { headers: bearer(token) } : {}), payload });
  const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, ...(token ? { headers: bearer(token) } : {}) });
  const boss = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: asBoss, ...(payload ? { payload } : {}) });
  const proOf = async (token: string) => (await get('/api/pro', token)).json() as Record<string, any>;
  const mailTo = (who: string, re: RegExp) => outbox.sent.filter((m) => m.to === who && re.test(m.subject));
  const OWNER = 'osamah9070@gmail.com';

  // --- everything off: nothing new exists for anyone.
  {
    const me = await proOf(fan.token);
    assert.ok(!('purchases' in me) && !('refundNotice' in me), '/api/pro says nothing new');
    assert.equal((await get('/api/pro/purchases', fan.token)).statusCode, 404, 'no purchases route for an account with none');
    assert.equal((await get('/api/pro/purchases', null)).statusCode, 401);
    assert.equal((await post('/api/pro/purchases/refund', fan.token, { order: randomUUID() })).statusCode, 404);
    assert.equal((await post('/api/pro/purchases/receipt', fan.token, { order: randomUUID() })).statusCode, 404);
    const q = await boss('GET', '/api/admin/pro/refund-requests');
    assert.equal(q.statusCode, 200);
    assert.deepEqual([q.json().requests, q.json().auto], [[], false]);
  }

  // --- Pro on sale, on the form.
  const on = setEnv({ ...FORM_ENV });
  const buyNow = async (who: { token: string }, o: Parameters<FakeMoyasar['formPay']>[2] = {}) => {
    const c = await post('/api/pro/pay/checkout', who.token, { lang: 'en' });
    assert.equal(c.statusCode, 200, c.body);
    const { order, form } = c.json() as { order: string; form: FormConfig };
    const p = moyasar.formPay(form, order, o);
    assert.equal((await get(`/api/pro/pay/order/${order}`, who.token)).json().status, 'paid');
    return { order, payment: p };
  };
  // Never bought: an empty list while Pro is on sale, and nothing in /api/pro.
  assert.deepEqual((await get('/api/pro/purchases', never.token)).json().orders, []);
  assert.ok(!('purchases' in (await proOf(never.token))));

  const mine = await buyNow(fan, { company: 'mada' });
  assert.equal((await proOf(fan.token)).purchases, true, 'the account page is told there is something to list');
  const list = await get('/api/pro/purchases', fan.token);
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  const row = list.json().orders[0];
  assert.deepEqual(
    [list.json().refundDays, list.json().orders.length, row.id, row.status, row.amount, row.days, row.method, row.brand, row.test, row.renewal, row.refund.state, row.refund.used],
    [7, 1, mine.order, 'paid', 19.99, 30, 'creditcard', 'mada', false, false, 'open', false],
  );
  assert.ok(row.paidAt && row.endsAt && row.reference === mine.payment.id);
  assert.ok(!/sk_live|pk_live|token_/.test(list.body), 'no key and no token in it');
  assert.deepEqual((await get('/api/pro/purchases', other.token)).json().orders, [], 'someone else sees none of it');

  // The receipt again: its owner only, to the account's own address, and not twice in a row.
  assert.equal((await post('/api/pro/purchases/receipt', null, { order: mine.order })).statusCode, 401);
  assert.equal((await post('/api/pro/purchases/receipt', other.token, { order: mine.order })).statusCode, 404);
  assert.equal((await post('/api/pro/purchases/receipt', fan.token, { order: 'x' })).statusCode, 400);
  const receiptsBefore = mailTo('r_fan@example.test', /receipt/i).length;
  assert.equal(receiptsBefore, 1);
  assert.equal((await post('/api/pro/purchases/receipt', fan.token, { order: mine.order, to: 'thief@example.test' })).statusCode, 200);
  assert.equal(mailTo('r_fan@example.test', /receipt/i).length, 2);
  assert.equal(mailTo('thief@example.test', /./).length, 0, 'never to an address the request names');
  const waitAns = await post('/api/pro/purchases/receipt', fan.token, { order: mine.order });
  assert.deepEqual([waitAns.statusCode, waitAns.json().reason], [429, 'wait']);

  // Asking for a refund: signed in, one's own order, a real body.
  assert.equal((await post('/api/pro/purchases/refund', null, { order: mine.order })).statusCode, 401);
  for (const bad of [{}, { order: 'x' }, { order: mine.order, note: 5 }, { order: mine.order, note: 'x'.repeat(2001) }]) {
    assert.equal((await post('/api/pro/purchases/refund', fan.token, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 60));
  }
  const notMine = await post('/api/pro/purchases/refund', other.token, { order: mine.order, note: 'give it to me' });
  assert.deepEqual([notMine.statusCode, notMine.json().reason], [404, 'none'], 'not the fan\'s own order: refused, as if it were not there');
  assert.equal(await payRepo.requestForOrder(mine.order), null);
  const asked = await post('/api/pro/purchases/refund', fan.token, { order: mine.order, note: 'Bought it for the wrong account' });
  assert.deepEqual([asked.statusCode, asked.json().state], [200, 'requested']);
  assert.equal((await proOf(fan.token)).plan, 'monthly', 'asking refunds nothing by itself');
  assert.equal(moyasar.refunds.length, 0);
  assert.equal(mailTo(OWNER, /Refund request from @r_fan: SAR 19/).length, 1, 'the owner is emailed');
  assert.equal(mailTo('r_fan@example.test', /We got your refund request/).length, 1, 'and the fan hears it arrived');
  const dup = await post('/api/pro/purchases/refund', fan.token, { order: mine.order });
  assert.deepEqual([dup.statusCode, dup.json().reason], [409, 'already']);
  assert.equal((await get('/api/pro/purchases', fan.token)).json().orders[0].refund.state, 'requested');
  // Too old, over HTTP: an order paid eight days ago.
  const aged = await buyNow(other);
  const agedRow = (payRepo as unknown as { orders: Map<string, ProOrder> }).orders.get(aged.order)!;
  agedRow.paidAt = new Date(Date.now() - 8 * DAY).toISOString();
  const tooOld = await post('/api/pro/purchases/refund', other.token, { order: aged.order });
  assert.deepEqual([tooOld.statusCode, tooOld.json().reason], [409, 'late'], 'past the 7 days: refused');
  assert.equal((await get('/api/pro/purchases', other.token)).json().orders[0].refund.state, 'late');
  assert.equal(await payRepo.requestForOrder(aged.order), null);

  // The export carries the request.
  const exp = (await get('/api/account/export', fan.token)).json();
  assert.equal(exp.pro.refundRequests.length, 1);
  assert.deepEqual(
    [exp.pro.refundRequests[0].status, exp.pro.refundRequests[0].note, exp.pro.refundRequests[0].orderReference, exp.pro.refundRequests[0].refundedAutomatically, exp.pro.refundRequests[0].proUsesCountedWhenAsked],
    ['pending', 'Bought it for the wrong account', mine.order, false, 0],
  );
  assert.ok(exp.pro.refundRequests[0].askedAt && exp.pro.refundRequests[0].answeredAt === null);
  assert.equal(exp.pro.orders[0].cardBrand, 'mada');
  assert.deepEqual((await get('/api/account/export', never.token)).json().pro.refundRequests, []);

  // /admin: the queue, closed to everyone else.
  for (const headers of [undefined, bearer(fan.token)]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro/refund-requests', ...(headers ? { headers } : {}) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/refund-request', ...(headers ? { headers } : {}), payload: { id: randomUUID(), action: 'approve' } })).statusCode, 403, 'nobody approves their own refund');
  }
  assert.equal(moyasar.refunds.length, 0);
  const queue = (await boss('GET', '/api/admin/pro/refund-requests')).json();
  assert.equal(queue.requests.length, 1);
  const q = queue.requests[0];
  assert.deepEqual([q.username, q.status, q.note, q.usedThen, q.usedNow, q.order.amount, q.order.inTime, q.order.brand], ['r_fan', 'pending', 'Bought it for the wrong account', 0, 0, 19.99, true, 'mada']);
  for (const bad of [{}, { id: 'x', action: 'approve' }, { id: q.id }, { id: q.id, action: 'refund' }]) {
    assert.equal((await boss('POST', '/api/admin/pro/refund-request', bad)).statusCode, 400);
  }
  assert.equal((await boss('POST', '/api/admin/pro/refund-request', { id: randomUUID(), action: 'approve' })).statusCode, 404);
  const noReason = await boss('POST', '/api/admin/pro/refund-request', { id: q.id, action: 'decline' });
  assert.deepEqual([noReason.statusCode, noReason.json().reason], [400, 'reason'], 'a decline needs its reason');
  // Moyasar refuses: said so, nothing changes.
  moyasar.failRefund = true;
  assert.equal((await boss('POST', '/api/admin/pro/refund-request', { id: q.id, action: 'approve' })).statusCode, 502);
  moyasar.failRefund = false;
  assert.equal((await proOf(fan.token)).plan, 'monthly');
  // Approve.
  const ok = await boss('POST', '/api/admin/pro/refund-request', { id: q.id, action: 'approve' });
  assert.deepEqual([ok.statusCode, ok.json().status], [200, 'approved'], ok.body);
  assert.equal((await payRepo.get(mine.order))!.status, 'refunded');
  assert.equal((await proOf(fan.token)).plan, 'free', 'the refund ended Pro');
  assert.equal(moyasar.refunds.length, 1);
  assert.equal(mailTo('r_fan@example.test', /Your TifoMaker Pro refund/).length, 1, 'the refund email');
  const again = await boss('POST', '/api/admin/pro/refund-request', { id: q.id, action: 'approve' });
  assert.deepEqual([again.statusCode, again.json().reason], [409, 'decided']);
  assert.equal((await boss('POST', '/api/admin/pro/refund', { orderId: mine.order })).statusCode, 409, 'and not refunded twice from the orders table');
  assert.equal(moyasar.refunds.length, 1);
  assert.equal(mailTo('r_fan@example.test', /Your TifoMaker Pro refund/).length, 1, 'still one refund email');
  const told = (await boss('GET', '/api/admin/pro/orders')).json().orders.find((x: { id: string }) => x.id === mine.order);
  assert.deepEqual([told.status, told.told], ['refunded', true], '/admin shows the fan was emailed');
  assert.equal((await get('/api/account/export', fan.token)).json().pro.refundRequests[0].status, 'approved');

  // The site's notice: once, to its own account.
  const notice = (await proOf(fan.token)).refundNotice;
  assert.deepEqual([notice.order, notice.amount, notice.test], [mine.order, 19.99, false]);
  assert.ok(!('refundNotice' in (await proOf(other.token))));
  assert.equal((await post('/api/pro/refund-notice/seen', null, { order: mine.order })).statusCode, 401);
  assert.equal((await post('/api/pro/refund-notice/seen', fan.token, { order: 'x' })).statusCode, 400);
  assert.equal((await post('/api/pro/refund-notice/seen', other.token, { order: mine.order })).json().seen, false, 'someone else cannot dismiss it');
  assert.ok('refundNotice' in (await proOf(fan.token)));
  assert.equal((await post('/api/pro/refund-notice/seen', fan.token, { order: mine.order })).json().seen, true);
  assert.ok(!('refundNotice' in (await proOf(fan.token))), 'shown once');
  assert.equal((await post('/api/pro/refund-notice/seen', fan.token, { order: mine.order })).json().seen, false);
  const after = (await get('/api/pro/purchases', fan.token)).json().orders[0];
  assert.deepEqual([after.status, after.refund.state, after.refunded, after.endsAt], ['refunded', 'refunded', 19.99, null]);

  // Decline, over HTTP: the fan is emailed the reason and keeps Pro.
  const second = await buyNow(never);
  assert.equal((await post('/api/pro/purchases/refund', never.token, { order: second.order })).statusCode, 200);
  const q2 = (await boss('GET', '/api/admin/pro/refund-requests')).json().requests.find((x: { status: string }) => x.status === 'pending');
  assert.equal(q2.username, 'r_never');
  const no = await boss('POST', '/api/admin/pro/refund-request', { id: q2.id, action: 'decline', reason: 'Pro was used on <i>four</i> designs' });
  assert.deepEqual([no.statusCode, no.json().status], [200, 'declined']);
  const declined = mailTo('r_never@example.test', /About your refund request/);
  assert.equal(declined.length, 1);
  assert.ok(declined[0].html.includes('Pro was used on &lt;i&gt;four&lt;/i&gt; designs') && !declined[0].html.includes('<i>four</i>'));
  assert.equal((await proOf(never.token)).plan, 'monthly');
  const seen = (await get('/api/pro/purchases', never.token)).json().orders[0].refund;
  assert.deepEqual([seen.state, seen.reason], ['declined', 'Pro was used on <i>four</i> designs']);
  assert.equal(mailTo('r_never@example.test', /Your TifoMaker Pro refund/).length, 0);

  // A refund made in Moyasar's dashboard, arriving by webhook three times: one email, and the notice.
  const theirs = await buyNow(hooked);
  moyasar.dashboardRefund(theirs.payment.id);
  const event = { secret_token: HOOK, type: 'payment_refunded', live: true, data: hookPayment(moyasar.payments.get(theirs.payment.id)!) };
  assert.equal((await post('/api/pro/pay/webhook', null, { ...event, secret_token: 'wrong-secret-of-some-length' })).statusCode, 401);
  assert.equal((await proOf(hooked.token)).plan, 'monthly', 'a forged refund ends nothing');
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/pro/pay/webhook', null, event)).statusCode, 200);
  assert.equal((await proOf(hooked.token)).plan, 'free');
  assert.equal(mailTo('r_hooked@example.test', /Your TifoMaker Pro refund/).length, 1, 'exactly one refund email from the webhook');
  assert.equal((await proOf(hooked.token)).refundNotice.order, theirs.order);
  assert.equal(moyasar.refunds.length, 1, 'the site refunded nothing itself');

  // Purchases stay visible to their owner after payments are switched off, and a request still gets through.
  const last = await buyNow(hooked);
  on();
  const offList = await get('/api/pro/purchases', hooked.token);
  assert.equal(offList.statusCode, 200, 'an account that bought something still sees it');
  assert.equal(offList.json().orders.length, 2);
  assert.equal((await post('/api/pro/purchases/refund', hooked.token, { order: last.order })).statusCode, 200, 'the promise outlives the switch');
  const stuck = (await boss('GET', '/api/admin/pro/refund-requests')).json().requests.find((x: { status: string }) => x.status === 'pending');
  const cannot = await boss('POST', '/api/admin/pro/refund-request', { id: stuck.id, action: 'approve' });
  assert.deepEqual([cannot.statusCode, cannot.json().reason], [409, 'off'], 'refunding needs payments on, and says so');

  // The auto-refund switch, over HTTP.
  const auto = setEnv({ ...AUTO_ENV });
  const lucky = await reg(app, 'r_lucky');
  await auth.markEmailVerified(lucky.id);
  const lb = await buyNow(lucky);
  assert.equal((await boss('GET', '/api/admin/pro/orders')).json().status.autoRefund, true);
  const instant = await post('/api/pro/purchases/refund', lucky.token, { order: lb.order });
  assert.deepEqual([instant.statusCode, instant.json().state], [200, 'refunded']);
  assert.equal((await proOf(lucky.token)).plan, 'free');
  assert.equal(mailTo('r_lucky@example.test', /Your TifoMaker Pro refund/).length, 1);
  assert.equal(mailTo(OWNER, /@r_lucky/).length, 0, 'nobody is asked');
  const autoRow = (await boss('GET', '/api/admin/pro/refund-requests')).json().requests.find((x: { username: string }) => x.username === 'r_lucky');
  assert.deepEqual([autoRow.status, autoRow.auto], ['approved', true]);
  assert.equal((await get('/api/account/export', lucky.token)).json().pro.refundRequests[0].refundedAutomatically, true);
  auto();
  await app.close();
  console.log('payments3.test: routes checked');
}
restore();

// ----------------------------------------------- 10. Postgres: the guards ---
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  try {
    const repo: PaymentRepository = new PgPaymentRepository(pool);
    const proRepo = new PgProRepository(pool);
    const mkUser = async (): Promise<string> => String((await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [`pay3_${randomUUID().slice(0, 18)}`])).rows[0].id);
    const userId = await mkUser();
    const stranger = await mkUser();
    const now = new Date();
    const mkPaid = async (who = userId): Promise<ProOrder> => {
      const given = randomUUID();
      const o = await repo.create({ userId: who, amount: 1900, days: 30, lang: 'en', testMode: true, now, kind: 'form', paymentId: given });
      const r = await repo.markPaid(o.id, { paymentId: given, method: 'creditcard', brand: 'mada', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY) });
      assert.ok(r.ok && r.first);
      return (await repo.get(o.id))!;
    };

    const o = await mkPaid();
    assert.deepEqual([o.brand, o.refundMailAt, o.refundSeenAt], ['mada', null, null], 'the card\'s scheme is kept with the order');
    // The email cannot be claimed for an order that is not refunded.
    assert.equal(await repo.claimRefundMail(o.id, now), false);
    assert.equal(await repo.markRefundSeen(userId, o.id, now), false);
    assert.equal(await repo.markRefunded(o.id, 1900, now), true);
    // Twenty servers notice the refund at once: one of them sends the email.
    const claims = await Promise.all(Array.from({ length: 20 }, () => repo.claimRefundMail(o.id, now)));
    assert.equal(claims.filter(Boolean).length, 1, 'ONE refund email from twenty claims at once');
    assert.equal((await repo.unmailedRefunds(new Date(now.getTime() - DAY), 50)).some((x) => x.id === o.id), false);
    await repo.unclaimRefundMail(o.id);
    assert.equal((await repo.unmailedRefunds(new Date(now.getTime() - DAY), 50)).some((x) => x.id === o.id), true, 'owed again after a failed send');
    assert.equal((await repo.unmailedRefunds(new Date(now.getTime() + DAY), 50)).some((x) => x.id === o.id), false, 'but not for ever');
    assert.equal(await repo.claimRefundMail(o.id, now), true);
    // The notice: its own account, once, from ten tabs at once.
    assert.deepEqual((await repo.unseenRefunds(userId, new Date(0))).map((x) => x.id), [o.id]);
    assert.deepEqual(await repo.unseenRefunds(stranger, new Date(0)), []);
    assert.equal(await repo.markRefundSeen(stranger, o.id, now), false, 'not someone else');
    const seen = await Promise.all(Array.from({ length: 10 }, () => repo.markRefundSeen(userId, o.id, now)));
    assert.equal(seen.filter(Boolean).length, 1);
    assert.deepEqual(await repo.unseenRefunds(userId, new Date(0)), []);

    // A request: one per order, from ten presses at once; answered once.
    const o2 = await mkPaid();
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.createRequest({ orderId: o2.id, userId, note: `press ${i}`, used: 0, now })));
    assert.equal(made.filter(Boolean).length, 1, 'ONE request from ten presses at once');
    const rq = made.find(Boolean)!;
    assert.deepEqual([rq.status, rq.used, rq.auto, rq.decidedAt, rq.userId, rq.orderId], ['pending', 0, false, null, userId, o2.id]);
    assert.equal((await repo.requestForOrder(o2.id))!.id, rq.id);
    assert.equal((await repo.requestById(rq.id))!.note, rq.note);
    assert.deepEqual((await repo.requestsFor(userId)).map((x) => x.id), [rq.id]);
    assert.deepEqual(await repo.requestsFor(stranger), []);
    // The database's own rules.
    await assert.rejects(pool.query(`UPDATE pro_refund_requests SET status = 'declined', decided_at = now() WHERE id = $1`, [rq.id]), 'a decline always has its reason');
    await assert.rejects(pool.query(`UPDATE pro_refund_requests SET status = 'approved' WHERE id = $1`, [rq.id]), 'an answer always has its date');
    await assert.rejects(pool.query(`UPDATE pro_refund_requests SET status = 'refunded' WHERE id = $1`, [rq.id]));
    await assert.rejects(pool.query(`INSERT INTO pro_refund_requests (order_id, user_id) VALUES ($1, $2)`, [o2.id, userId]), /pro_refund_requests_order_id_key/, 'one request per order, by the database itself');
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.decideRequest(rq.id, i % 2 ? 'approved' : 'declined', { reason: 'used', auto: false }, now)));
    assert.equal(answers.filter(Boolean).length, 1, 'ONE answer from ten at once');
    const answered = (await repo.requestById(rq.id))!;
    assert.ok(answered.status !== 'pending' && answered.decidedAt);
    assert.equal(answered.declineReason, answered.status === 'declined' ? 'used' : null);
    assert.equal(await repo.decideRequest(rq.id, 'approved', { reason: null, auto: true }, now), false, 'answered is answered');

    // The queue: open ones first (oldest first), with the order and the name.
    const o3 = await mkPaid(stranger);
    const o4 = await mkPaid(stranger);
    const first = (await repo.createRequest({ orderId: o3.id, userId: stranger, note: null, used: 2, now: new Date(now.getTime() - 3600_000) }))!;
    const later = (await repo.createRequest({ orderId: o4.id, userId: stranger, note: 'x', used: 0, now }))!;
    const rows = (await repo.listRequests(500)).filter((x) => [rq.id, first.id, later.id].includes(x.id));
    assert.deepEqual(rows.map((x) => x.id), [first.id, later.id, rq.id]);
    assert.deepEqual([rows[0].order!.id, rows[0].order!.status, rows[0].used, rows[0].status], [o3.id, 'paid', 2, 'pending']);
    assert.match(rows[0].username ?? '', /^pay3_/);
    assert.equal(await repo.decideRequest(later.id, 'approved', { reason: null, auto: true }, now), true);
    assert.deepEqual([(await repo.requestById(later.id))!.auto, (await repo.requestById(later.id))!.declineReason], [true, null]);

    // The whole path on Postgres, from five servers at once: one refund email, one answer.
    {
      const u5 = await mkUser();
      const fake = new FakeMoyasar();
      const pro = new ProService(proRepo, { now: () => new Date(), savedDesigns: async () => 1, env: AUTO_ENV });
      const mails: string[] = [];
      const five = Array.from({ length: 5 }, () => new PaymentService(repo, pro, fake, { env: AUTO_ENV, base: 'https://tifomaker.test', onRefunded: async (x) => { mails.push(x.id); return true; } }));
      const c = await five[0].checkout({ id: u5, username: 'pg_refund', email: 'pg3@example.test', emailVerified: true }, 'en', 'https://tifomaker.test');
      assert.ok(c.ok && 'form' in c, JSON.stringify(c));
      const p = fake.formPay(c.form, c.orderId);
      await Promise.all(five.map((s) => s.orderFor(u5, c.orderId)));
      // Asked for from five tabs at once with the auto-refund switch on.
      const asks = await Promise.all(five.map((s) => s.requestRefund(u5, c.orderId, null)));
      assert.equal(asks.filter((x) => x.ok).length, 1, 'one request');
      assert.equal(fake.refunds.length, 1, 'ONE refund at Moyasar');
      assert.equal(mails.filter((x) => x === c.orderId).length, 1, 'ONE refund email');
      assert.equal((await repo.get(c.orderId))!.status, 'refunded');
      assert.equal((await proRepo.activePasses(u5, new Date())).length, 0, 'the pass ended');
      // And then Moyasar's webhook says so too, on every server.
      await Promise.all(five.map((s) => s.webhook({ secret_token: HOOK, type: 'payment_refunded', live: true, data: hookPayment(fake.payments.get(p.id)!) })));
      assert.equal(mails.filter((x) => x === c.orderId).length, 1, 'still one');
      const done = (await repo.requestForOrder(c.orderId))!;
      assert.deepEqual([done.status, done.auto], ['approved', true]);
      await pool.query('DELETE FROM users WHERE id = $1', [u5]);
    }

    // The account is deleted: its requests stay as the record, with no owner; an order deleted takes its request.
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const kept = (await repo.requestById(rq.id))!;
    assert.deepEqual([kept.userId, kept.orderId], [null, o2.id]);
    await pool.query('DELETE FROM pro_orders WHERE id = $1', [o2.id]);
    assert.equal(await repo.requestById(rq.id), null);
    await pool.query('DELETE FROM users WHERE id = $1', [stranger]);
    await pool.query(`DELETE FROM pro_orders WHERE user_id IS NULL AND test_mode AND created_at >= $1`, [new Date(now.getTime() - 1000)]);
    await pool.query(`DELETE FROM pro_orders WHERE user_id IS NULL AND created_at >= $1 AND kind = 'form'`, [new Date(now.getTime() - 1000)]);
    console.log('payments3.test: postgres guards checked');
  } finally {
    await pool.end();
  }
} else {
  console.log('payments3.test: DATABASE_URL not set; Postgres checks skipped');
}

void TEST_KEY;
void PK_TEST;
console.log('payments3.test: all checks passed');
