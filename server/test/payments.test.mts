/**
 * Buying Pro (payments v1): the switches, the routes end to end against a
 * fake Moyasar, and the Moyasar client's own care with its key.
 *
 * Adversarial, like pro.test.mts: it tries to buy while payments are off, to
 * buy with a test key from outside the preview, to read someone else's order,
 * to get Pro from a forged callback or webhook, to be paid twice for one
 * invoice by racing the callback, the webhook and the return, to get Pro for
 * an invoice paid at the wrong amount, to refund without being the admin, and
 * to refund late. Runs on the memory stores, and the order store again on
 * Postgres when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository, PgProRepository } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository } from '../src/payRepo';
import { ProService } from '../src/pro';
import { OFFER } from '../src/proPlan';
import { MoyasarClient, MoyasarError, readInvoice, type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type NewInvoice } from '../src/moyasar';
import { PaymentService, REFUND_DAYS, moyasarKeyKind, payLegal, paymentsOn, paymentsOpenFor, paymentsPublic, priceHalalas } from '../src/payments';
import { receiptEmail } from '../src/payReceipt';
import type { EmailMessage, EmailSender } from '../src/email';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const DAY = 24 * 3600_000;
const TEST_KEY = 'sk_test_FAKEfake1234'; // under 20 after the prefix: not a real key, and not one secret-scan.mjs flags
const LIVE_KEY = 'sk_live_FAKEfake1234';
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

/** Moyasar, as far as Pro uses it: invoices that can be paid, refunded, or left. */
class FakeMoyasar implements MoyasarApi {
  invoices = new Map<string, MoyasarInvoice>();
  made: NewInvoice[] = [];
  reads = 0;
  failRefund = false;
  failCreate = false;

  async createInvoice(i: NewInvoice): Promise<MoyasarInvoice> {
    if (this.failCreate) throw new MoyasarError(503, 'api_error');
    this.made.push(i);
    const id = randomUUID();
    const inv: MoyasarInvoice = { id, status: 'initiated', amount: i.amount, currency: i.currency, url: `https://checkout.moyasar.test/invoices/${id}`, payments: [], metadata: { ...i.metadata } };
    this.invoices.set(id, inv);
    return { ...inv };
  }
  async invoice(id: string): Promise<MoyasarInvoice> {
    this.reads++;
    const inv = this.invoices.get(id);
    if (!inv) throw new MoyasarError(404, 'record_not_found');
    return JSON.parse(JSON.stringify(inv)) as MoyasarInvoice;
  }
  async refund(paymentId: string): Promise<MoyasarPayment> {
    for (const inv of this.invoices.values()) {
      const p = inv.payments.find((x) => x.id === paymentId);
      if (!p) continue;
      if (this.failRefund) throw new MoyasarError(400, 'invalid_request_error');
      p.status = 'refunded';
      p.refunded = p.amount;
      inv.status = 'refunded';
      return { ...p };
    }
    throw new MoyasarError(404, 'record_not_found');
  }
  /** The fan pays (Apple Pay by default), at the invoice's amount unless told otherwise. */
  pay(invoiceId: string, amount?: number, currency = 'SAR'): void {
    const inv = this.invoices.get(invoiceId)!;
    inv.status = 'paid';
    if (amount !== undefined) inv.amount = amount;
    inv.currency = currency;
    inv.payments.push({ id: randomUUID(), status: 'paid', amount: inv.amount, currency, refunded: 0, sourceType: 'applepay' });
  }
}

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

const ALL_OFF = { PRO_MODE: undefined, PRO_PREVIEW_USERS: undefined, PRO_PAYMENTS: undefined, MOYASAR_SECRET_KEY: undefined, MOYASAR_WEBHOOK_SECRET: undefined };

// ---------------------------------------------------------- 1. switches ---
{
  assert.equal(moyasarKeyKind({}), null);
  assert.equal(moyasarKeyKind({ MOYASAR_SECRET_KEY: TEST_KEY }), 'test');
  assert.equal(moyasarKeyKind({ MOYASAR_SECRET_KEY: LIVE_KEY }), 'live');
  assert.equal(moyasarKeyKind({ MOYASAR_SECRET_KEY: 'pk_live_abcdefghijklmnop' }), null, 'a publishable key is not a secret key');
  assert.equal(moyasarKeyKind({ MOYASAR_SECRET_KEY: 'sk_live_' }), null);

  assert.equal(paymentsOn({}), false, 'off by default');
  assert.equal(paymentsOn({ MOYASAR_SECRET_KEY: LIVE_KEY }), false, 'a key alone turns nothing on');
  assert.equal(paymentsOn({ PRO_PAYMENTS: 'on' }), false, 'the switch alone neither');
  assert.equal(paymentsOn({ PRO_PAYMENTS: 'yes', MOYASAR_SECRET_KEY: LIVE_KEY }), false, 'only "on" is on');
  assert.equal(paymentsOn({ PRO_PAYMENTS: ' ON ', MOYASAR_SECRET_KEY: LIVE_KEY }), true);

  const test = { PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: TEST_KEY, PRO_PREVIEW_USERS: 'Osamh' };
  assert.equal(paymentsOpenFor('osamh', { ...test, PRO_MODE: 'preview' }), true, 'the owner, in the preview, with a test key');
  assert.equal(paymentsOpenFor('someone', { ...test, PRO_MODE: 'preview' }), false, 'nobody else');
  assert.equal(paymentsOpenFor('someone', { ...test, PRO_MODE: 'on' }), false, 'a test key never sells outside the preview, even with Pro on for everyone');
  assert.equal(paymentsOpenFor('osamh', { ...test, PRO_MODE: 'off' }), false, 'Pro off: nothing to buy');
  assert.equal(paymentsOpenFor(null, { ...test, PRO_MODE: 'on' }), false, 'signed out: nothing');
  const live = { PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY };
  assert.equal(paymentsOpenFor('someone', { ...live, PRO_MODE: 'on' }), true);
  assert.equal(paymentsOpenFor('someone', { ...live, PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'osamh' }), false, 'live key in preview: still only the preview');
  assert.equal(paymentsPublic({ ...live, PRO_MODE: 'on' }), true);
  assert.equal(paymentsPublic({ ...test, PRO_MODE: 'on' }), false, 'never public on a test key');
  assert.equal(paymentsPublic({ ...live, PRO_MODE: 'preview' }), false);

  // The legal page: the coming-soon line until Pro is on sale to everyone, then the terms.
  const legal = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  const off = payLegal(legal, false);
  assert.ok(!/data-pay="sale"|Moyasar|ميسّر/.test(off), 'off: no payment terms anywhere in the page');
  assert.equal((off.match(/data-pay="soon"/g) ?? []).length, 2, 'off: the coming-soon line, in both languages');
  const on = payLegal(legal, true);
  assert.ok(!/data-pay=/.test(on), 'on sale: the coming-soon line is gone and the terms are unwrapped');
  assert.ok(on.includes('within 7 days of paying') && on.includes('خلال 7 أيام من الدفع'), 'the refund promise, in both languages');
  assert.ok(on.includes('If you buy Pro:') && on.includes('إذا اشتريت المميّزة:'), 'and what is kept about a purchase');
  assert.equal(on.includes(`within ${REFUND_DAYS} days`), true, 'the page and the code promise the same window');

  assert.equal(priceHalalas(), Math.round(OFFER.monthly.price * 100));
  assert.ok(priceHalalas() >= 100, 'Moyasar takes at least one riyal');
  console.log('payments.test: switches checked');
}

// --------------------------------------------- 2. the Moyasar client itself ---
{
  const calls: { url: string; init: RequestInit }[] = [];
  const id = randomUUID();
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith('/invoices') && init.method === 'POST') {
      return new Response(JSON.stringify({ id, status: 'initiated', amount: 1900, currency: 'SAR', url: `https://checkout.moyasar.com/invoices/${id}`, metadata: { order_id: 'x', junk: 5 } }), { status: 201 });
    }
    if (String(url).includes('/refund')) return new Response(JSON.stringify({ type: 'invalid_request_error', message: `nope ${TEST_KEY}` }), { status: 400 });
    return new Response(JSON.stringify({ id: randomUUID(), status: 'paid', amount: 1900, currency: 'sar', url: 'https://x' }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new MoyasarClient(TEST_KEY, { fetch: fakeFetch, base: 'https://api.moyasar.test/v1/' });
  const inv = await c.createInvoice({ amount: 1900, currency: 'SAR', description: 'd', callbackUrl: 'https://a/cb', successUrl: 'https://a/ok', backUrl: 'https://a/back', expiresAt: new Date('2026-11-13T00:00:00Z'), metadata: { order_id: 'x' } });
  assert.equal(inv.id, id);
  assert.deepEqual(inv.metadata, { order_id: 'x' }, 'only string metadata is kept');
  assert.equal(calls[0].url, 'https://api.moyasar.test/v1/invoices');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Basic ${Buffer.from(`${TEST_KEY}:`).toString('base64')}`, 'Basic auth: the key, then an empty password');
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.amount, 1900);
  assert.equal(sent.expired_at, '2026-11-13T00:00:00.000Z');
  assert.equal(sent.callback_url, 'https://a/cb');
  await assert.rejects(c.invoice('../payments'), (e: Error) => e instanceof MoyasarError && e.type === 'bad_id', 'nothing but an id goes into a path');
  await assert.rejects(c.refund('x/../../y'), MoyasarError);
  await assert.rejects(c.invoice(randomUUID()), (e: Error) => e instanceof MoyasarError && e.type === 'bad_invoice', 'an invoice that is not the one asked for is refused');
  await assert.rejects(
    c.refund(randomUUID()),
    (e: Error) => e instanceof MoyasarError && e.status === 400 && !e.message.includes(TEST_KEY) && !JSON.stringify(e).includes(TEST_KEY),
    'an error carries the status and type, never the key or the provider\'s message',
  );
  await assert.rejects(c.createInvoice({ amount: 50, currency: 'SAR', description: 'd', callbackUrl: '', successUrl: '', backUrl: '', expiresAt: new Date(), metadata: {} }), MoyasarError, 'under a riyal is refused before asking');
  const down = new MoyasarClient(TEST_KEY, { fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
  await assert.rejects(down.invoice(randomUUID()), (e: Error) => e instanceof MoyasarError && e.type === 'network');
  assert.equal(readInvoice(null).id, '', 'anything at all reads as an empty invoice, never a throw');
  console.log('payments.test: the Moyasar client checked');
}

// ------------------------------------------------- 3. the routes, end to end ---
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
    adminUsernames: ['boss_pay'], aiAdminPassword: 'pay admin password',
  });
  const owner = await reg(app, 'osamh_pay');
  await auth.markEmailVerified(owner.id);
  const fan = await reg(app, 'fan_pay');
  await auth.markEmailVerified(fan.id);
  const unverified = await reg(app, 'unverified_pay');
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'pay admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };

  const checkout = (token: string, lang = 'en') => app.inject({ method: 'POST', url: '/api/pro/pay/checkout', headers: bearer(token), payload: { lang } });
  const order = (token: string, id: string) => app.inject({ method: 'GET', url: `/api/pro/pay/order/${id}`, headers: bearer(token) });
  const proOf = async (token: string) => (await app.inject({ method: 'GET', url: '/api/pro', headers: bearer(token) })).json() as Record<string, any>;
  const webhook = (payload: object) => app.inject({ method: 'POST', url: '/api/pro/pay/webhook', payload });

  // --- off: as if none of it existed
  for (const env of [{}, { PRO_PAYMENTS: 'on' }, { MOYASAR_SECRET_KEY: LIVE_KEY, PRO_MODE: 'on' }]) {
    const back = setEnv(env);
    assert.equal((await checkout(owner.token)).statusCode, 404, `off (${JSON.stringify(env)}): no checkout`);
    assert.equal((await order(owner.token, randomUUID())).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/pro/pay/invoice', payload: { id: randomUUID() } })).statusCode, 404);
    assert.equal((await webhook({ secret_token: HOOK })).statusCode, 404);
    back();
  }
  assert.equal(moyasar.made.length, 0, 'nothing reached Moyasar while off');
  {
    const back = setEnv({ PRO_MODE: 'on' });
    const me = await proOf(owner.token);
    assert.equal(me.offer.paymentsOpen, false, 'Pro on, payments off: no buy button');
    back();
  }

  // --- the preview, on test keys: only the owner
  const preview = setEnv({ PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'osamh_pay', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: TEST_KEY });
  assert.equal((await proOf(owner.token)).offer.paymentsOpen, true, 'the owner sees the buy button');
  assert.equal((await checkout(fan.token)).statusCode, 404, 'a fan outside the preview cannot buy');
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/pay/checkout', payload: {} })).statusCode, 401, 'signed out cannot buy');
  {
    const back = setEnv({ PRO_PREVIEW_USERS: 'osamh_pay,unverified_pay' });
    const r = await checkout(unverified.token);
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().reason, 'verify', 'a receipt needs a verified email');
    back();
  }
  {
    const back = setEnv({ PRO_MODE: 'on' });
    assert.equal((await checkout(fan.token)).statusCode, 404, 'test key, Pro on for everyone: still only the preview can buy');
    back();
  }

  const c1 = await checkout(owner.token, 'ar');
  assert.equal(c1.statusCode, 200, c1.body);
  const { order: orderId, url } = c1.json() as { order: string; url: string };
  assert.match(url, /^https:\/\/checkout\.moyasar\.test\//, 'the fan is sent to Moyasar\'s own page');
  const made = moyasar.made[0];
  assert.equal(made.amount, priceHalalas());
  assert.equal(made.currency, 'SAR');
  assert.equal(made.successUrl, `https://tifomaker.test/ar/pro?order=${orderId}`, 'back to the Arabic page, naming the order');
  assert.equal(made.callbackUrl, 'https://tifomaker.test/api/pro/pay/invoice');
  assert.equal(made.metadata.order_id, orderId);
  assert.ok(made.expiresAt.getTime() - Date.now() <= 61 * 60_000, 'the page takes payment for an hour at most');
  const again = await checkout(owner.token);
  assert.equal(again.json().order, orderId, 'pressing again goes back to the open invoice');
  assert.equal(moyasar.made.length, 1, 'without making another');

  const inv = (await payRepo.get(orderId))!.invoiceId!;
  assert.equal((await order(owner.token, orderId)).json().status, 'pending', 'not paid yet');
  assert.equal((await order(fan.token, orderId)).statusCode, 404, 'someone else\'s order is no order at all');
  assert.equal((await order(owner.token, 'not-a-uuid')).statusCode, 404);

  // Forged news is only a nudge: nothing is believed until Moyasar says so.
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/pay/invoice', payload: { id: inv, status: 'paid', amount: priceHalalas() } })).statusCode, 200);
  assert.equal((await payRepo.get(orderId))!.status, 'pending', 'a forged "paid" callback gives nothing');
  assert.equal((await proOf(owner.token)).plan, 'free');

  // The webhook is closed without its secret, and refuses a wrong one.
  assert.equal((await webhook({ secret_token: HOOK, type: 'payment_paid', data: { invoice_id: inv } })).statusCode, 404, 'no webhook secret set: the route is closed');
  const hook = setEnv({ MOYASAR_WEBHOOK_SECRET: HOOK });
  assert.equal((await webhook({ secret_token: 'wrong-secret-of-some-length!!', type: 'payment_paid', data: { invoice_id: inv } })).statusCode, 401);
  assert.equal((await webhook({ type: 'payment_paid', data: { invoice_id: inv } })).statusCode, 401, 'no secret at all');

  // Adding the webhook in Moyasar's dashboard: its code shows on /admin.
  assert.equal((await webhook({ type: 'webhook_verification', secret_token: 'wrong-secret-of-some-length!!', data: { verification_code: '111111' } })).statusCode, 401, 'a wrong secret is refused even here');
  assert.equal((await webhook({ type: 'webhook_verification', data: { verification_code: '<b>x</b>' } })).statusCode, 200);
  assert.equal((await webhook({ type: 'webhook_verification', secret_token: HOOK, data: { verification_code: 482913 } })).statusCode, 200);
  {
    const v = (await app.inject({ method: 'GET', url: '/api/admin/pro/orders', headers: asBoss })).json().verification;
    assert.deepEqual(v?.code, '482913', 'the code is shown to the admin, and only a code');
  }

  // Paid: the return, the callback and the webhook all at once give one pass.
  moyasar.pay(inv);
  const raced = await Promise.all([
    order(owner.token, orderId),
    app.inject({ method: 'POST', url: '/api/pro/pay/invoice', payload: { id: inv } }),
    webhook({ secret_token: HOOK, type: 'payment_paid', live: false, data: { id: randomUUID(), invoice_id: inv } }),
    webhook({ secret_token: HOOK, type: 'payment_paid', live: false, data: { id: randomUUID(), invoice_id: inv } }),
    order(owner.token, orderId),
  ]);
  for (const r of raced) assert.equal(r.statusCode, 200, r.body);
  const passes = (await proRepo.allPasses(owner.id)).filter((p) => p.source === 'payment');
  assert.equal(passes.length, 1, 'one pass for one payment, however many times it is reported');
  assert.equal(Date.parse(passes[0].endsAt) - Date.parse(passes[0].startsAt), OFFER.monthly.days * DAY);
  const done = (await order(owner.token, orderId)).json();
  assert.equal(done.status, 'paid');
  assert.equal(done.endsAt, passes[0].endsAt);
  const me = await proOf(owner.token);
  assert.equal(me.plan, 'monthly', 'Pro is on');
  assert.equal(me.supporter, true, 'and it is a paid one: the Supporter crown');
  const paidOrder = (await payRepo.get(orderId))!;
  assert.equal(paidOrder.method, 'applepay');
  assert.equal(paidOrder.testMode, true);
  const receipts = outbox.sent.filter((m) => /receipt/i.test(m.subject));
  assert.equal(receipts.length, 1, 'one receipt');
  assert.equal(receipts[0].to, 'osamh_pay@example.test');
  assert.match(receipts[0].subject, /^\[TEST\]/, 'a test payment says so');
  assert.ok(receipts[0].html.includes(inv) && receipts[0].text!.includes(`${REFUND_DAYS} days`));

  // Holding a month: no second purchase until its last week.
  const held = await checkout(owner.token);
  assert.equal(held.statusCode, 409);
  assert.equal(held.json().reason, 'held');
  assert.equal(held.json().endsAt, passes[0].endsAt);

  // A webhook for test money while on a live key (or the reverse) is not ours.
  {
    const back = setEnv({ MOYASAR_SECRET_KEY: LIVE_KEY, PRO_MODE: 'on' });
    assert.equal((await webhook({ secret_token: HOOK, live: false, data: { invoice_id: inv } })).statusCode, 200);
    back();
  }

  // --- refunds: the admin only
  for (const headers of [undefined, bearer(owner.token)]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/refund', ...(headers ? { headers } : {}), payload: { orderId } })).statusCode, 403, 'nobody refunds themselves');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro/orders', ...(headers ? { headers } : {}) })).statusCode, 403);
  }
  const list = (await app.inject({ method: 'GET', url: '/api/admin/pro/orders', headers: asBoss })).json() as Record<string, any>;
  assert.equal(list.orders[0].id, orderId);
  assert.equal(list.orders[0].username, 'osamh_pay');
  assert.equal(list.orders[0].used, 0, 'Pro not used yet');
  assert.equal(list.orders[0].refundable, true);
  assert.equal(list.status.key, 'test');
  assert.ok(!JSON.stringify(list).includes(TEST_KEY), 'the key never leaves the server');
  assert.equal(list.stats.test, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/refund', headers: asBoss, payload: { orderId: 'x' } })).statusCode, 400);
  moyasar.failRefund = true;
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/refund', headers: asBoss, payload: { orderId } })).statusCode, 502, 'Moyasar refused: said so');
  assert.equal((await payRepo.get(orderId))!.status, 'paid', 'and nothing changed');
  moyasar.failRefund = false;
  const refunded = await app.inject({ method: 'POST', url: '/api/admin/pro/refund', headers: asBoss, payload: { orderId } });
  assert.equal(refunded.statusCode, 200, refunded.body);
  assert.equal((await payRepo.get(orderId))!.status, 'refunded');
  assert.equal((await proOf(owner.token)).plan, 'free', 'the pass went with the money');
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/refund', headers: asBoss, payload: { orderId } })).statusCode, 409, 'not twice');
  // A refunded order is never paid again by a late report.
  await app.inject({ method: 'POST', url: '/api/pro/pay/invoice', payload: { id: inv } });
  assert.equal((await proRepo.activePasses(owner.id, new Date())).length, 0);

  // --- paid at the wrong amount: a person looks, nobody gets Pro
  const c2 = await checkout(owner.token);
  assert.equal(c2.statusCode, 200, c2.body);
  const o2 = c2.json().order as string;
  const inv2 = (await payRepo.get(o2))!.invoiceId!;
  moyasar.pay(inv2, 100);
  await webhook({ secret_token: HOOK, type: 'payment_paid', data: { invoice_id: inv2 } });
  assert.equal((await payRepo.get(o2))!.status, 'review');
  assert.equal((await proOf(owner.token)).plan, 'free', 'one riyal does not buy a month');
  assert.equal((await order(owner.token, o2)).json().status, 'pending', 'the fan sees it as still being checked');

  // --- refunded in Moyasar's dashboard: the webhook takes the pass back
  const c3 = await checkout(owner.token);
  const o3 = c3.json().order as string;
  const inv3 = (await payRepo.get(o3))!.invoiceId!;
  moyasar.pay(inv3);
  await order(owner.token, o3);
  assert.equal((await proOf(owner.token)).plan, 'monthly');
  const pay3 = moyasar.invoices.get(inv3)!.payments[0].id;
  await moyasar.refund(pay3);
  await webhook({ secret_token: HOOK, type: 'payment_refunded', data: { id: pay3, invoice_id: inv3 } });
  assert.equal((await payRepo.get(o3))!.status, 'refunded');
  assert.equal((await proOf(owner.token)).plan, 'free');

  // --- Moyasar down when buying: said plainly, nothing half-made
  moyasar.failCreate = true;
  const down = await checkout(owner.token);
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().reason, 'unavailable');
  moyasar.failCreate = false;

  // --- a day's worth of presses
  let last = 200;
  for (let i = 0; i < 12 && last !== 429; i++) {
    // Each open invoice lapses unpaid, so the next press makes a new order.
    for (const x of moyasar.invoices.values()) if (x.status === 'initiated') x.status = 'expired';
    for (const x of await payRepo.recentFor(owner.id, new Date(0))) if (x.status === 'pending') await order(owner.token, x.id);
    last = (await checkout(owner.token)).statusCode;
  }
  assert.equal(last, 429, 'ten orders a day, then no more');

  hook();
  preview();
  console.log('payments.test: routes checked');
}

// ---------------------------------------- 4. the rules, on a clock we hold ---
{
  let now = new Date('2026-12-01T10:00:00Z');
  const proRepo = new MemoryProRepository();
  const payRepo = new MemoryPaymentRepository(proRepo);
  const moyasar = new FakeMoyasar();
  const pro = new ProService(proRepo, { now: () => now, savedDesigns: async () => 1, env: { PRO_MODE: 'on' } });
  const env = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY };
  const pay = new PaymentService(payRepo, pro, moyasar, { env });
  const buyer = { id: randomUUID(), username: 'buyer', email: 'b@example.test', emailVerified: true };

  // A month given by hand, ending in 5 days: a bought one starts when it ends.
  await proRepo.grantPass({ userId: buyer.id, plan: 'monthly', startsAt: now, endsAt: new Date(now.getTime() + 5 * DAY), source: 'admin', createdBy: null });
  const r = await pay.checkout(buyer, 'en', 'https://tifomaker.test');
  assert.ok(r.ok);
  const o = (await payRepo.get(r.ok ? r.orderId : ''))!;
  assert.equal(o.testMode, false, 'live key: real money');
  moyasar.pay(o.invoiceId!);
  const paid = await pay.reconcile(o);
  const pass = (await proRepo.allPasses(buyer.id)).find((p) => p.id === paid.passId)!;
  assert.equal(pass.startsAt, new Date(now.getTime() + 5 * DAY).toISOString(), 'nothing is lost by renewing early');

  // Late: past the refund window only on purpose.
  now = new Date(now.getTime() + (REFUND_DAYS + 1) * DAY);
  assert.deepEqual(await pay.refund(o.id), { ok: false, reason: 'late' });
  const late = await pay.refund(o.id, true);
  assert.equal(late.ok, true, 'the owner can still choose to refund');

  // A gift running does not push a bought month back.
  const giftee = { id: randomUUID(), username: 'giftee', email: 'g@example.test', emailVerified: true };
  await proRepo.offerGift(giftee.id, now);
  await proRepo.acceptGift(giftee.id, now, 7);
  assert.deepEqual(await pay.startFor(giftee.id, now), { start: now });

  // Off: a service with no key does nothing at all.
  const off = new PaymentService(payRepo, pro, null, { env });
  assert.equal(off.on(), false);
  assert.deepEqual(await off.checkout(buyer, 'en', 'https://x'), { ok: false, reason: 'off' });

  // The receipt reads right in both languages.
  const mail = receiptEmail({ order: { ...paid, testMode: false }, to: 'b@example.test', endsAt: pass.endsAt, base: 'https://tifomaker.org', contact: 'help@example.test' });
  assert.ok(!mail.subject.includes('TEST'));
  assert.ok(mail.html.includes('lang="ar"') || mail.html.includes('dir="rtl"'), 'Arabic block');
  assert.ok(mail.text!.includes(`SAR ${OFFER.monthly.price}`));
  console.log('payments.test: rules checked');
}
restore();

// --------------------------------------------------------- 5. Postgres ---
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repo = new PgPaymentRepository(pool);
    const proRepo = new PgProRepository(pool);
    const u = await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [`pay_pg_${Date.now()}`]);
    const userId = String(u.rows[0].id);
    const now = new Date();
    const o = await repo.create({ userId, amount: 1900, days: 30, lang: 'en', testMode: true, now });
    const inv = randomUUID();
    assert.equal(await repo.attachInvoice(o.id, inv, `https://checkout.moyasar.com/invoices/${inv}`), true);
    assert.equal(await repo.attachInvoice(o.id, randomUUID(), 'https://x'), false, 'an order takes one invoice');
    assert.equal((await repo.byInvoice(inv))!.id, o.id);
    const w = { paymentId: randomUUID(), method: 'applepay', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY) };
    // Ten reports of the same payment at once: one pass.
    const all = await Promise.all(Array.from({ length: 10 }, () => repo.markPaid(o.id, w)));
    assert.equal(all.filter((x) => x.ok && x.first).length, 1, 'one grant');
    const passes = (await proRepo.allPasses(userId)).filter((p) => p.source === 'payment');
    assert.equal(passes.length, 1, 'one pass in the table');
    assert.equal(await proRepo.passUse(userId, passes[0].id), 0);
    await proRepo.take(userId, 'std', [{ key: `c:${passes[0].id}:0`, limit: 70 }], 3);
    assert.equal(await proRepo.passUse(userId, passes[0].id), 3, 'a pass\'s own months are counted');
    assert.equal(await repo.markRefunded(o.id, 1900, now), true);
    assert.equal(await repo.markRefunded(o.id, 1900, now), false, 'once');
    assert.equal((await proRepo.activePasses(userId, now)).length, 0, 'the refund ended the pass');
    assert.deepEqual(await repo.markPaid(o.id, w), { ok: false, reason: 'refunded' });
    await assert.rejects(pool.query(`INSERT INTO pro_orders (user_id, amount, days, lang, test_mode) VALUES ($1, 50, 30, 'en', true)`, [userId]), 'under a riyal');
    await assert.rejects(pool.query(`INSERT INTO pro_orders (user_id, amount, days, lang, test_mode, currency) VALUES ($1, 1900, 30, 'en', true, 'USD')`, [userId]), 'another currency');
    await assert.rejects(pool.query(`UPDATE pro_orders SET invoice_url = 'javascript:alert(1)' WHERE id = $1`, [o.id]), 'a page that is not https');
    // The account goes; the record of the sale stays, without it.
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const kept = (await repo.get(o.id))!;
    assert.equal(kept.userId, null);
    assert.equal(kept.status, 'refunded');
    assert.equal(kept.passId, null);
    await pool.query('DELETE FROM pro_orders WHERE id = $1', [o.id]);
    console.log('payments.test: postgres store checks passed');
  } finally {
    await pool.end();
  }
} else {
  console.log('payments.test: DATABASE_URL not set; Postgres store checks skipped');
}

console.log('payments.test: all checks passed');
