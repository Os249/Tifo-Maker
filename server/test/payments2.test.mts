/**
 * Payments v2: the fixed-IP proxy, Moyasar's payment form, the webhook-only
 * mode and auto-renew ("Keep Pro on"), against a fake Moyasar on a clock the
 * test holds. payments.test.mts still covers v1, unchanged.
 *
 * Adversarial where money is: it tries to be charged twice for one renewal by
 * running the job twice at once (and from two servers), to be charged with no
 * reminder, with no opt-in, after cancelling, after a refund, after deleting
 * the account, on an expired card, and after a time-out that leaves the
 * outcome unknown; to get Pro from a forged or mismatched webhook with no
 * secret key on the server; to tick "Keep Pro on" for someone else; and to
 * send the proxy's password, or anything but Moyasar's traffic, somewhere it
 * should not go. Runs on the memory stores, and the store's locks again on
 * Postgres when DATABASE_URL is set.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository, PgProRepository } from '../src/proRepo';
import { MemoryPaymentRepository, PgPaymentRepository, type PaymentRepository } from '../src/payRepo';
import { ProService } from '../src/pro';
import { OFFER } from '../src/proPlan';
import {
  MoyasarClient, MoyasarError, failReason, readPayment, readToken,
  type MoyasarApi, type MoyasarInvoice, type MoyasarPayment, type MoyasarToken, type NewInvoice, type TokenCharge,
} from '../src/moyasar';
import { readProxyUrl, tunnelFetch } from '../src/moyasarProxy';
import {
  PaymentService, REMIND_DAYS, RETRY_DAYS, autoRenewOn, checkoutKind, formMethods, payKeyKind, payLegal, paymentsOn, paymentsOpenFor,
  paymentsPublic, paymentsStatus, priceHalalas, verifyMode, type FormConfig, type RenewNotice,
} from '../src/payments';
import { cancelUrlOf, renewEmail } from '../src/payRenewMail';
import { receiptEmail } from '../src/payReceipt';
import { configWarnings, type ConfigWarning } from '../src/preflight';
import type { EmailMessage, EmailSender } from '../src/email';

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
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

/** Moyasar, as far as payments v2 uses it: payments under ids the server chose, tokens, token charges. */
class FakeMoyasar implements MoyasarApi {
  payments = new Map<string, MoyasarPayment>();
  tokens = new Map<string, MoyasarToken>();
  /** Token charges that reached "Moyasar" (whether or not the answer got back). */
  charges: TokenCharge[] = [];
  reads = 0;
  /** How the next token charges go. */
  mode: 'paid' | 'decline' | 'expired' | '3ds' | 'timeout_after' | 'timeout_before' | 'refuse' | 'down' = 'paid';
  deleteFails = false;
  readFails = false;

  async createInvoice(_i: NewInvoice): Promise<MoyasarInvoice> { throw new MoyasarError(0, 'not_used'); }
  async invoice(_id: string): Promise<MoyasarInvoice> { throw new MoyasarError(404, 'record_not_found'); }

  async refund(paymentId: string): Promise<MoyasarPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new MoyasarError(404, 'record_not_found');
    p.status = 'refunded';
    p.refunded = p.amount;
    return { ...p };
  }

  async payment(id: string): Promise<MoyasarPayment | null> {
    this.reads++;
    if (this.readFails) throw new MoyasarError(0, 'proxy');
    const p = this.payments.get(id);
    return p ? { ...p, metadata: { ...p.metadata } } : null;
  }

  async chargeToken(c: TokenCharge): Promise<MoyasarPayment> {
    if (this.mode === 'down') throw new MoyasarError(503, 'api_error');
    if (this.mode === 'timeout_before') throw new MoyasarError(0, 'timeout');
    if (this.mode === 'refuse') throw new MoyasarError(400, 'invalid_request_error');
    // One payment per id, as Moyasar's given_id promises: the same id again is the same payment.
    const there = this.payments.get(c.givenId);
    if (there) return { ...there };
    const t = this.tokens.get(c.token);
    if (!t || t.status !== 'active') throw new MoyasarError(400, 'invalid_request_error');
    this.charges.push(c);
    const p: MoyasarPayment = {
      id: c.givenId, status: 'paid', amount: c.amount, currency: c.currency, refunded: 0, sourceType: 'creditcard', company: t.brand, token: c.token,
      message: 'APPROVED', responseCode: '00', transactionUrl: null, invoiceId: null, metadata: { ...c.metadata },
    };
    if (this.mode === 'decline') Object.assign(p, { status: 'failed', message: 'INSUFFICIENT FUNDS', responseCode: '51' });
    if (this.mode === 'expired') Object.assign(p, { status: 'failed', message: 'EXPIRED CARD', responseCode: '54' });
    if (this.mode === '3ds') Object.assign(p, { status: 'initiated', message: null, responseCode: null, transactionUrl: 'https://bank.test/3ds' });
    this.payments.set(p.id, p);
    if (this.mode === 'timeout_after') throw new MoyasarError(0, 'timeout');
    return { ...p };
  }

  async token(id: string): Promise<MoyasarToken | null> {
    const t = this.tokens.get(id);
    return t ? { ...t } : null;
  }

  async deleteToken(id: string): Promise<boolean> {
    if (this.deleteFails) throw new MoyasarError(0, 'network');
    this.tokens.delete(id);
    return true;
  }

  /**
   * The fan pays on Moyasar's form in a browser: a payment under the id the
   * server chose, and a token when the form was asked to save the card.
   */
  formPay(f: FormConfig, orderId: string, o: { save?: boolean; company?: string; type?: string; amount?: number; status?: string; message?: string; code?: string; tokenStatus?: string; expYear?: number; expMonth?: number; names?: string } = {}): MoyasarPayment {
    let token: string | null = null;
    if (o.save) {
      token = `token_${randomUUID().replace(/-/g, '')}`;
      this.tokens.set(token, { id: token, status: o.tokenStatus ?? 'active', brand: o.company ?? 'visa', lastFour: '1111', month: o.expMonth ?? 12, year: o.expYear ?? 2030 });
    }
    const p: MoyasarPayment = {
      id: f.givenId, status: o.status ?? 'paid', amount: o.amount ?? f.amount, currency: 'SAR', refunded: 0, sourceType: o.type ?? 'creditcard', company: o.company ?? 'visa',
      token, message: o.message ?? null, responseCode: o.code ?? null, transactionUrl: null, invoiceId: null, metadata: { order_id: o.names ?? orderId },
    };
    this.payments.set(p.id, p);
    return p;
  }
}

/** A payment as Moyasar's webhook carries it. */
const hookPayment = (p: MoyasarPayment) => ({
  id: p.id, status: p.status, amount: p.amount, currency: p.currency, refunded: p.refunded, metadata: p.metadata,
  source: { type: p.sourceType, company: p.company, token: p.token, message: p.message, response_code: p.responseCode },
});

const FORM_ENV = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY, MOYASAR_PUBLISHABLE_KEY: PK_LIVE, PRO_CHECKOUT: 'form' };
const RENEW_ENV = { ...FORM_ENV, PRO_AUTORENEW: 'on' };

/** A payment service on memory stores, a fake Moyasar and a clock the test moves. */
function world(env: Record<string, string> = RENEW_ENV, api: 'fake' | 'none' = 'fake') {
  const state = { now: new Date('2027-01-01T09:00:00Z'), mailUp: true };
  const proRepo = new MemoryProRepository();
  const payRepo = new MemoryPaymentRepository(proRepo);
  const moyasar = new FakeMoyasar();
  const pro = new ProService(proRepo, { now: () => state.now, savedDesigns: async () => 1, env });
  const notices: RenewNotice[] = [];
  const receipts: { order: string; kind: string; renews: boolean }[] = [];
  const make = (e: Record<string, string> = env) => new PaymentService(payRepo, pro, api === 'fake' ? moyasar : null, {
    env: e, base: 'https://tifomaker.test',
    notify: async (n) => {
      if (!state.mailUp) return false;
      notices.push(n);
      return true;
    },
    onPaid: async (o, _end, s) => { receipts.push({ order: o.id, kind: o.kind, renews: s?.status === 'active' }); },
  });
  const pay = make();
  const buyer = (name: string) => ({ id: randomUUID(), username: name, email: `${name}@example.test`, emailVerified: true });
  const passEnd = async (userId: string): Promise<number | null> => {
    const p = (await proRepo.activePasses(userId, state.now)).filter((x) => x.plan === 'monthly');
    return p.length ? Math.max(...p.map((x) => Date.parse(x.endsAt))) : null;
  };
  /** Buy a month on the form; with keep, tick "Keep Pro on" first. */
  const buy = async (b: ReturnType<typeof buyer>, o: Parameters<FakeMoyasar['formPay']>[2] & { keep?: boolean } = {}) => {
    const c = await pay.checkout(b, 'en', 'https://tifomaker.test');
    assert.ok(c.ok && 'form' in c, `checkout: ${JSON.stringify(c)}`);
    if (o.keep) assert.equal(await pay.setKeep(b.id, c.orderId, true), true, 'the tick is recorded');
    const p = moyasar.formPay(c.form, c.orderId, { ...o, save: o.save ?? o.keep });
    const order = (await pay.orderFor(b.id, c.orderId))!;
    return { order, payment: p, form: c.form };
  };
  const at = (ms: number) => { state.now = new Date(ms); };
  const forward = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  return { state, proRepo, payRepo, moyasar, pro, pay, make, notices, receipts, buyer, buy, passEnd, at, forward };
}

// ------------------------------------------------- 1. switches and readers ---
{
  // Everything new is off unless its own variable is set: with v1's variables alone, nothing changes.
  const v1 = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY };
  assert.equal(verifyMode(v1), 'api');
  assert.equal(checkoutKind(v1), 'invoice', 'the hosted invoice stays the default');
  assert.equal(autoRenewOn(v1), false);
  assert.equal(paymentsStatus(v1).proxy, false);
  assert.equal(checkoutKind({ ...v1, MOYASAR_PUBLISHABLE_KEY: PK_LIVE }), 'invoice', 'a publishable key alone does not switch the checkout');
  assert.equal(checkoutKind({ ...v1, PRO_CHECKOUT: 'form' }), 'invoice', 'nor PRO_CHECKOUT=form without the key');
  assert.equal(checkoutKind({ ...v1, PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK_TEST }), 'invoice', 'a test publishable key beside a live secret key is refused');
  assert.equal(checkoutKind({ ...v1, PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: 'sk_live_FAKEfake9999' }), 'invoice', 'a secret key is never taken as the publishable one');
  assert.equal(paymentsStatus({ ...v1, PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK_TEST }).formRefused, true);
  assert.equal(checkoutKind(FORM_ENV), 'form');
  assert.equal(autoRenewOn(FORM_ENV), false, 'the form alone does not renew anything');
  assert.equal(autoRenewOn({ ...v1, PRO_AUTORENEW: 'on' }), false, 'auto-renew needs the form');
  assert.equal(autoRenewOn(RENEW_ENV), true);
  assert.equal(autoRenewOn({ ...RENEW_ENV, PRO_AUTORENEW: 'yes' }), false, 'only "on" is on');
  assert.equal(autoRenewOn({ ...RENEW_ENV, PRO_PAYMENTS: 'off' }), false);

  // The webhook-only mode: no secret key, a publishable key and the webhook's secret instead.
  const hookOnly = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_VERIFY: 'webhook', MOYASAR_PUBLISHABLE_KEY: PK_LIVE, MOYASAR_WEBHOOK_SECRET: HOOK };
  assert.equal(verifyMode(hookOnly), 'webhook');
  assert.equal(paymentsOn(hookOnly), true);
  assert.equal(checkoutKind(hookOnly), 'form', 'without a secret key there is no invoice to make');
  assert.equal(payKeyKind(hookOnly), 'live');
  assert.equal(paymentsPublic(hookOnly), true);
  assert.equal(paymentsOn({ ...hookOnly, MOYASAR_WEBHOOK_SECRET: undefined }), false, 'no webhook secret: nothing could ever be paid, so it is off');
  assert.equal(paymentsOn({ ...hookOnly, MOYASAR_WEBHOOK_SECRET: 'short' }), false);
  assert.equal(paymentsOn({ ...hookOnly, MOYASAR_PUBLISHABLE_KEY: undefined }), false);
  assert.equal(autoRenewOn({ ...hookOnly, PRO_AUTORENEW: 'on' }), false, 'a saved card cannot be charged without the secret key');
  assert.equal(paymentsOpenFor('someone', { ...hookOnly, MOYASAR_PUBLISHABLE_KEY: PK_TEST }), false, 'a test publishable key sells only to the preview, as a test secret key does');
  assert.equal(paymentsOpenFor('osamh', { ...hookOnly, MOYASAR_PUBLISHABLE_KEY: PK_TEST, PRO_PREVIEW_USERS: 'osamh' }), true);
  assert.equal(paymentsPublic({ ...hookOnly, MOYASAR_PUBLISHABLE_KEY: PK_TEST }), false);

  // What the form offers: cards alone until more is asked for and can work.
  assert.deepEqual(formMethods({}), ['creditcard']);
  assert.deepEqual(formMethods({ MOYASAR_METHODS: 'creditcard, applepay ,stcpay' }, false), ['creditcard', 'stcpay'], 'no Apple Pay until its domain file is served');
  assert.deepEqual(formMethods({ MOYASAR_METHODS: 'creditcard,applepay,stcpay' }, true), ['creditcard', 'applepay', 'stcpay']);
  assert.deepEqual(formMethods({ MOYASAR_METHODS: 'samsungpay,bitcoin' }, true), ['creditcard'], 'unknown or unready methods fall back to cards');
  assert.deepEqual(formMethods({ MOYASAR_METHODS: 'samsungpay', MOYASAR_SAMSUNG_SERVICE_ID: 'svc' }), ['samsungpay']);

  // The legal page: the auto-renew terms only when on sale with auto-renew on.
  const legal = readFileSync(new URL('../../legal.html', import.meta.url), 'utf8');
  const off = payLegal(legal, false, true);
  assert.ok(!/data-pay="(sale|renew|once)"|auto-renew|Keep Pro on|خلّ برو شغّال/i.test(off), 'not on sale: nothing about renewing, whatever the switch');
  const once = payLegal(legal, true, false);
  assert.ok(!/data-pay=/.test(once) && once.includes('It does not renew') && !/Keep Pro on|token/i.test(once), 'on sale without auto-renew: the v1 terms, word for word');
  assert.ok(once.includes('within 7 days of paying') && once.includes('خلال 7 أيام من الدفع'));
  const renew = payLegal(legal, true, true);
  assert.ok(!/data-pay=/.test(renew) && !renew.includes('It does not renew:'), 'with auto-renew the "does not renew" line gives way');
  for (const must of [
    'it is never ticked for you', 'renew every 30 days', '3 days before every renewal', 'never charged without that email', 'with one click',
    'Pro stays on until the days you\'ve already paid for end', 'the 7-day refund below applies to each one', 'auto-renew stops by itself', 'a "token"',
    'I never see or store the card number', 'when you delete your account', 'within 7 days of paying',
  ]) assert.ok(renew.includes(must), `the auto-renew terms say: ${must}`);
  for (const must of ['ما أحد يعلّم عليه عنك', 'قبل كل تجديد بـ3 أيام', 'بضغطة وحدة', 'خلال 7 أيام من الدفع', 'توكن', 'حذفت حسابك']) assert.ok(renew.includes(must), `and in Arabic: ${must}`);
  assert.equal((renew.match(/Auto-renew \("Keep Pro on"\)/g) ?? []).length, 1);

  // Why a payment failed, as the page's kinds (Moyasar's "3DS errors" and response codes).
  const why = (message: string | null, responseCode: string | null = null) => failReason({ message, responseCode });
  assert.equal(why('3DS: Card authentication declined.'), 'auth');
  assert.equal(why('3DS: Authentication error occurred.'), 'auth');
  assert.equal(why('3DS: The authentication session has expired.'), 'cancelled');
  assert.equal(why('3DS: The challenge was bypassed and the transaction was declined.'), 'cancelled');
  assert.equal(why('3DS: The authentication is unavailable, please try again later or contact issuer bank if problem persisted.'), 'unavailable');
  assert.equal(why('3DS: The card is not enrolled in 3DS service.'), 'unavailable');
  assert.equal(why('No matching 3D Secure service for the transaction.'), 'unavailable');
  assert.equal(why('3DS: The authentication attempt was rejected by the issuer bank.'), 'rejected');
  assert.equal(why('3DS: The card has been reported as stolen.'), 'rejected');
  assert.equal(why('3DS: service error occurred.'), 'error');
  assert.equal(why('3DS: request timed out.'), 'error');
  assert.equal(why('3DS-DS: 3DS and Directory Server connection error'), 'error');
  assert.equal(why('3DS: The card has expired.'), 'expired_card');
  assert.equal(why('BLOCKED: Unauthenticated Transaction'), 'auth');
  assert.equal(why('INSUFFICIENT FUNDS', '51'), 'funds');
  assert.equal(why('whatever', '54'), 'expired_card');
  assert.equal(why('EXPIRED CARD'), 'expired_card');
  assert.equal(why('DO NOT HONOUR', '05'), 'declined');
  assert.equal(why('TIMED_OUT'), 'error');
  assert.equal(why(null), 'declined');

  // Reading what Moyasar sends: only the fields used, each checked; never a card number.
  const p = readPayment({
    id: 'B5F3A0C6-0000-4000-8000-000000000001', status: 'paid', amount: 1900, currency: 'sar', refunded: 0, metadata: { order_id: 'x', n: 5 },
    source: { type: 'creditcard', company: 'MADA', number: 'XXXX-XXXX-XXXX-1111', token: 'token_abcDEF123456', message: 'APPROVED', response_code: '00', transaction_url: 'javascript:alert(1)' },
  });
  assert.equal(p.company, 'mada');
  assert.equal(p.token, 'token_abcDEF123456');
  assert.equal(p.transactionUrl, null, 'only an https address is kept');
  assert.deepEqual(p.metadata, { order_id: 'x' });
  assert.ok(!JSON.stringify(p).includes('XXXX'), 'not even the masked number is kept');
  assert.equal(readPayment({ source: { type: 'applepay', token: '{"paymentData":"..."}' } }).token, null, 'an Apple Pay payload in "token" is not a saved-card token');
  assert.equal(readPayment(null).id, '');
  const t = readToken({ id: 'token_abcDEF123456', status: 'active', brand: 'Visa', last_four: '1111', month: '12', year: '30', number: '4111111111111111' });
  assert.deepEqual(t, { id: 'token_abcDEF123456', status: 'active', brand: 'visa', lastFour: '1111', month: 12, year: 2030 });
  assert.equal(readToken({ year: 2031, last_four: '11' }).lastFour, null);

  // The proxy's address: read without ever being repeated.
  assert.deepEqual(readProxyUrl('http://fixie:s3cr%40t@proxy.example:8080'), { host: 'proxy.example', port: 8080, secure: false, auth: 'fixie:s3cr@t' });
  assert.deepEqual(readProxyUrl(' https://proxy.example '), { host: 'proxy.example', port: 443, secure: true, auth: null });
  for (const bad of ['', '   ', 'proxy.example:80', 'socks5://proxy.example:1080', 'http://', 'not a url']) assert.equal(readProxyUrl(bad), null, `not a proxy: "${bad}"`);

  // Startup warnings name a variable and never print its value.
  const warn = (env: Record<string, string>) => configWarnings({ NODE_ENV: 'production', PUBLIC_URL: 'https://tifomaker.org', ...env } as NodeJS.ProcessEnv);
  const said = (env: Record<string, string>, key: string) => warn(env).filter((x: ConfigWarning) => x.key === key).map((x: ConfigWarning) => x.effect).join(' ');
  assert.match(said({ ...v1, PRO_CHECKOUT: 'form' }, 'MOYASAR_PUBLISHABLE_KEY'), /still goes to Moyasar's hosted page/);
  assert.match(said({ ...v1, PRO_CHECKOUT: 'form', MOYASAR_PUBLISHABLE_KEY: PK_TEST }, 'MOYASAR_PUBLISHABLE_KEY'), /test key beside a live secret key/);
  assert.match(said({ ...v1, PRO_AUTORENEW: 'on' }, 'PRO_AUTORENEW'), /not offered and nothing renews/);
  assert.match(said({ ...hookOnly, PRO_AUTORENEW: 'on' }, 'PRO_AUTORENEW'), /needs the secret key/);
  assert.match(said({ ...hookOnly, MOYASAR_SECRET_KEY: LIVE_KEY }, 'MOYASAR_SECRET_KEY'), /is set but not used/);
  const proxySecret = 'http://user:hunter2-very-secret@proxy.example:80';
  assert.equal(said({ ...v1, MOYASAR_PROXY_URL: proxySecret }, 'MOYASAR_PROXY_URL'), '', 'a good proxy address: nothing to say');
  assert.match(said({ ...v1, MOYASAR_PROXY_URL: 'hunter2-very-secret' }, 'MOYASAR_PROXY_URL'), /is not an http/);
  assert.ok(!JSON.stringify(warn({ ...v1, MOYASAR_PROXY_URL: 'hunter2-very-secret' })).includes('hunter2'), 'the proxy value is never repeated');
  assert.ok(!JSON.stringify(warn({ ...RENEW_ENV, MOYASAR_PROXY_URL: proxySecret })).match(/hunter2|sk_live|pk_live/), 'nor any key');
  assert.equal(warn(RENEW_ENV).filter((x: ConfigWarning) => /MOYASAR|PRO_/.test(x.key)).length, 0, 'the full set, set right: no warning');
  console.log('payments2.test: switches and readers checked');
}

// ------------------------------------------------- 2. the fixed-IP proxy ---
{
  // A local HTTPS "Moyasar" behind a local CONNECT proxy. The certificate is made here with openssl; without it, skipped.
  let tls: { key: Buffer; cert: Buffer } | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'tifo-proxy-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    tls = { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch {
    tls = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Refusals that never touch the network.
  const unused = readProxyUrl('http://u:p@127.0.0.1:9')!;
  const guarded = tunnelFetch(unused, { allowHosts: ['api.moyasar.com'] });
  await assert.rejects(guarded('http://api.moyasar.com/v1/invoices'), (e: Error) => e.name === 'ProxyError' && /not https/.test(e.message), 'never in the clear');
  await assert.rejects(guarded('https://evil.example/v1/invoices'), (e: Error) => e.name === 'ProxyError' && /host not allowed/.test(e.message), 'only Moyasar goes through the proxy');
  await assert.rejects(guarded('https://api.moyasar.com.evil.example/x'), (e: Error) => e.name === 'ProxyError');

  // The proxy down: the client says "proxy", with nothing of the address or its password.
  const downClient = new MoyasarClient(LIVE_KEY, { base: 'https://api.moyasar.com/v1', fetch: tunnelFetch(readProxyUrl('http://fixie:hunter2@127.0.0.1:9')!, { allowHosts: ['api.moyasar.com'], connectMs: 3000 }) });
  await assert.rejects(downClient.invoice(randomUUID()), (e: Error) => e instanceof MoyasarError && e.type === 'proxy' && e.status === 0 && !/hunter2|fixie|127\.0\.0\.1/.test(e.message + JSON.stringify(e)));

  if (!tls) {
    console.log('payments2.test: openssl not found; the proxy tunnel checks that need a certificate are skipped');
  } else {
    const seen: { method: string; url: string; auth: string }[] = [];
    const id = randomUUID();
    const target = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? '') });
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url?.includes('/payments/') ? { id, status: 'paid', amount: 1900, currency: 'SAR', echo: body } : { id, status: 'paid', amount: 1900, currency: 'SAR', url: 'https://x' }));
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as net.AddressInfo).port;

    // The proxy: records what it was asked and every byte it carried.
    const connects: { target: string; auth: string }[] = [];
    let carried = Buffer.alloc(0);
    let refuse: number | null = null;
    const proxy = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
    proxy.on('connect', (req, client, head) => {
      connects.push({ target: req.url ?? '', auth: String(req.headers['proxy-authorization'] ?? '') });
      if (refuse) { client.end(`HTTP/1.1 ${refuse} Refused\r\n\r\n`); return; }
      const [, port] = (req.url ?? '').split(':');
      const up = net.connect(Number(port), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        client.on('data', (c: Buffer) => { carried = Buffer.concat([carried, c]); });
        client.pipe(up);
        up.pipe(client);
      });
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as net.AddressInfo).port;

    const through = tunnelFetch(readProxyUrl(`http://fixie:hunter2@127.0.0.1:${proxyPort}`)!, { allowHosts: ['localhost'], tls: { ca: tls.cert } });
    const client = new MoyasarClient(LIVE_KEY, { base: `https://localhost:${targetPort}/v1`, fetch: through });
    const inv = await client.invoice(id);
    assert.equal(inv.id, id, 'the call arrived, through the tunnel');
    assert.equal(connects.length, 1);
    assert.equal(connects[0].target, `localhost:${targetPort}`, 'the proxy was asked for a tunnel to the API, nothing else');
    assert.equal(connects[0].auth, `Basic ${Buffer.from('fixie:hunter2').toString('base64')}`, 'with the proxy\'s own credentials');
    assert.equal(seen[0].auth, `Basic ${Buffer.from(`${LIVE_KEY}:`).toString('base64')}`, 'Moyasar got the secret key');
    assert.equal(seen[0].url, `/v1/invoices/${id}`);
    const wire = carried.toString('latin1');
    assert.ok(carried.length > 200 && !wire.includes(LIVE_KEY) && !wire.includes(Buffer.from(`${LIVE_KEY}:`).toString('base64')) && !wire.includes('/v1/invoices') && !wire.includes('authorization'),
      'TLS is end to end: the proxy carried ciphertext, never the key, the path or a header');
    assert.equal((await client.payment(id))?.status, 'paid');
    assert.equal(await client.deleteToken('token_abcDEF123456'), true, 'a 204 with no body comes through');
    assert.equal(seen.at(-1)!.method, 'DELETE');

    // Moyasar's certificate is still checked inside the tunnel: an unknown one is refused.
    const untrusting = new MoyasarClient(LIVE_KEY, { base: `https://localhost:${targetPort}/v1`, fetch: tunnelFetch(readProxyUrl(`http://127.0.0.1:${proxyPort}`)!, { allowHosts: ['localhost'] }) });
    await assert.rejects(untrusting.invoice(id), (e: Error) => e instanceof MoyasarError && e.type === 'proxy');
    // The proxy refuses (wrong password, quota): said as "proxy", nothing charged, nothing leaked.
    refuse = 407;
    await assert.rejects(client.invoice(id), (e: Error) => e instanceof MoyasarError && e.type === 'proxy' && !/hunter2/.test(e.message));
    refuse = null;
    // And a checkout behind a dead proxy tells the fan payments cannot be reached.
    {
      const w = world(FORM_ENV);
      w.moyasar.readFails = true;
      const r = await w.pay.checkout(w.buyer('behind_proxy'), 'en', 'https://tifomaker.test');
      assert.deepEqual(r, { ok: false, reason: 'unavailable' }, '"payments can\'t be reached, nothing was charged"');
      assert.equal((await w.payRepo.list(10)).length, 0, 'and no order was made');
    }
    target.close();
    proxy.close();
    console.log('payments2.test: the proxy tunnel checked (TLS end to end)');
  }
}

// ------------------------------------------------- 3. the payment form ---
{
  const w = world(FORM_ENV);
  const fan = w.buyer('form_fan');
  const c = await w.pay.checkout(fan, 'ar', 'https://tifomaker.test');
  assert.ok(c.ok && 'form' in c);
  const f = c.form;
  assert.equal(f.publishableKey, PK_LIVE, 'the publishable key, the only key a browser ever gets');
  assert.ok(!JSON.stringify(c).includes('sk_live'), 'never the secret key');
  assert.equal(f.amount, priceHalalas());
  assert.equal(f.callbackUrl, `https://tifomaker.test/ar/pro?order=${c.orderId}`);
  assert.match(f.givenId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a payment id of the server\'s choosing (UUID v4, as the form requires)');
  assert.deepEqual(f.methods, ['creditcard']);
  assert.equal(f.renew, null, 'no "Keep Pro on" while auto-renew is off');
  assert.equal(f.applePay, null);
  const o0 = (await w.payRepo.get(c.orderId))!;
  assert.equal(o0.kind, 'form');
  assert.equal(o0.paymentId, f.givenId);
  assert.equal(o0.keep, false);
  assert.equal(await w.pay.setKeep(fan.id, c.orderId, true), false, 'auto-renew off: the box cannot be ticked, even by asking the server directly');

  // Opened and not sent: the same order again. Sent: a new one.
  const again = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(again.ok && again.orderId === c.orderId && 'form' in again && again.form.givenId === f.givenId);
  await w.pay.attempted(fan.id, c.orderId);
  const next = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(next.ok && next.orderId !== c.orderId && 'form' in next && next.form.givenId !== f.givenId, 'an order whose form was sent is never offered again');
  assert.equal(await w.pay.attempted(randomUUID(), next.orderId), false, 'someone else cannot mark it');

  // Nothing at Moyasar: pending. A browser cannot say otherwise.
  assert.equal((await w.pay.orderFor(fan.id, next.orderId))!.status, 'pending');
  assert.equal(await w.pay.orderFor(randomUUID(), next.orderId), null, 'someone else\'s order is no order');

  // Paid at the wrong amount, in the wrong currency, or naming another order: a person looks.
  const form2 = (next as { form: FormConfig }).form;
  w.moyasar.formPay(form2, next.orderId, { amount: 100 });
  assert.equal((await w.pay.orderFor(fan.id, next.orderId))!.status, 'review', 'one riyal does not buy a month');
  assert.equal(await w.passEnd(fan.id), null);
  const c3 = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(c3.ok && 'form' in c3);
  w.moyasar.formPay(c3.form, c3.orderId, { names: randomUUID() });
  assert.equal((await w.pay.orderFor(fan.id, c3.orderId))!.status, 'review', 'a payment naming another order gives nothing');

  // Failed: settled, with why.
  const c4 = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(c4.ok && 'form' in c4);
  w.moyasar.formPay(c4.form, c4.orderId, { status: 'failed', message: '3DS: The authentication attempt was rejected by the issuer bank.' });
  const failed = (await w.pay.orderFor(fan.id, c4.orderId))!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fail, 'rejected');

  // 3-D Secure not finished: still pending.
  const c5 = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(c5.ok && 'form' in c5);
  const waiting = w.moyasar.formPay(c5.form, c5.orderId, { status: 'initiated' });
  assert.equal((await w.pay.orderFor(fan.id, c5.orderId))!.status, 'pending');
  // Then paid: the return, the webhook and a second return at once give one pass.
  waiting.status = 'paid';
  const hooked = w.make({ ...FORM_ENV, MOYASAR_WEBHOOK_SECRET: HOOK });
  const results = await Promise.all([
    w.pay.orderFor(fan.id, c5.orderId),
    hooked.webhook({ type: 'payment_paid', live: true, secret_token: HOOK, data: hookPayment(waiting) }),
    w.pay.orderFor(fan.id, c5.orderId),
    hooked.webhook({ type: 'payment_paid', live: true, secret_token: HOOK, data: { id: waiting.id } }),
  ]);
  assert.equal(results[1], 'done');
  const passes = (await w.proRepo.allPasses(fan.id)).filter((p) => p.source === 'payment');
  assert.equal(passes.length, 1, 'one pass for one payment');
  assert.equal(Date.parse(passes[0].endsAt) - Date.parse(passes[0].startsAt), OFFER.monthly.days * DAY);
  assert.equal(w.receipts.length, 1, 'one receipt');
  assert.equal(w.receipts[0].renews, false);
  // With a secret key, a webhook is only a nudge: a forged "paid" for an unpaid order gives nothing.
  {
    const other = w.buyer('forged');
    const c6 = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
    assert.ok(c6.ok && 'form' in c6);
    assert.equal(await hooked.webhook({ type: 'payment_paid', live: true, secret_token: HOOK, data: { id: c6.form.givenId, status: 'paid', amount: priceHalalas(), currency: 'SAR', metadata: { order_id: c6.orderId } } }), 'done');
    assert.equal((await w.payRepo.get(c6.orderId))!.status, 'pending', 'the server read Moyasar, which has no such payment');
    assert.equal(await w.passEnd(other.id), null);
  }
  // A refund: through /admin, the pass ends.
  const refunded = await w.pay.refund(c5.orderId);
  assert.equal(refunded.ok, true);
  assert.equal(await w.passEnd(fan.id), null);
  // The ten-a-day limit still holds on the form.
  let last: unknown = null;
  for (let i = 0; i < 12; i++) {
    const r = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
    last = r;
    if (!r.ok) break;
    await w.pay.attempted(fan.id, r.orderId);
  }
  assert.deepEqual(last, { ok: false, reason: 'busy' });
  console.log('payments2.test: the payment form checked');
}

// ------------------------------------------------- 4. no secret key (MOYASAR_VERIFY=webhook) ---
{
  const HOOK_ENV = { PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_VERIFY: 'webhook', MOYASAR_PUBLISHABLE_KEY: PK_LIVE, MOYASAR_WEBHOOK_SECRET: HOOK };
  const w = world(HOOK_ENV, 'none');
  assert.equal(w.pay.on(), true, 'on with no Moyasar client at all');
  assert.equal(w.pay.renewOn(), false);
  const fan = w.buyer('hook_fan');
  const c = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(c.ok && 'form' in c && c.form.renew === null);
  const good = (over: Partial<MoyasarPayment> = {}): MoyasarPayment => ({
    id: c.form.givenId, status: 'paid', amount: priceHalalas(), currency: 'SAR', refunded: 0, sourceType: 'creditcard', company: 'visa', token: null, metadata: { order_id: c.orderId }, ...over,
  });
  const send = (data: unknown, over: Record<string, unknown> = {}) => w.pay.webhook({ id: 'evt', type: 'payment_paid', live: true, secret_token: HOOK, data, ...over });
  const status = async () => (await w.payRepo.get(c.orderId))!.status;

  // The return alone gives nothing: there is nobody to ask.
  assert.equal((await w.pay.orderFor(fan.id, c.orderId))!.status, 'pending');
  // Everything that must be refused or ignored, before the real one.
  assert.equal(await send(hookPayment(good()), { secret_token: 'wrong-secret-of-some-length!!!!' }), 'refused');
  assert.equal(await send(hookPayment(good()), { secret_token: undefined }), 'refused');
  assert.equal(await send(hookPayment(good()), { live: false }), 'ignored', 'test money on a live key');
  assert.equal(await send(hookPayment(good()), { live: undefined }), 'ignored', 'an event that does not say which mode it is for');
  assert.equal(await send(hookPayment(good({ id: randomUUID() }))), 'ignored', 'a payment this server never chose an id for');
  assert.equal(await send({ ...hookPayment(good()), id: 'not-an-id' }), 'ignored');
  assert.equal(await send(hookPayment(good()), { type: 'balance_transferred' }), 'ignored');
  assert.equal(await send(hookPayment(good({ status: 'initiated' }))), 'done');
  assert.equal(await status(), 'pending', 'nothing yet');
  assert.equal(await w.passEnd(fan.id), null);

  // A second order, to show what a mismatch does: review, never Pro.
  const other = w.buyer('hook_other');
  const c2 = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
  assert.ok(c2.ok && 'form' in c2);
  const base2: MoyasarPayment = { id: c2.form.givenId, status: 'paid', amount: priceHalalas(), currency: 'SAR', refunded: 0, sourceType: 'creditcard', metadata: { order_id: c2.orderId } };
  await send(hookPayment({ ...base2, amount: 100 }));
  assert.equal((await w.payRepo.get(c2.orderId))!.status, 'review', 'paid at another amount');
  const c3 = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
  assert.ok(c3.ok && 'form' in c3);
  await send(hookPayment({ id: c3.form.givenId, status: 'paid', amount: priceHalalas(), currency: 'USD', refunded: 0, sourceType: 'creditcard', metadata: { order_id: c3.orderId } }));
  assert.equal((await w.payRepo.get(c3.orderId))!.status, 'review', 'in another currency');
  const c4 = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
  assert.ok(c4.ok && 'form' in c4);
  await send(hookPayment({ id: c4.form.givenId, status: 'paid', amount: priceHalalas(), currency: 'SAR', refunded: 0, sourceType: 'creditcard', metadata: {} }));
  assert.equal((await w.payRepo.get(c4.orderId))!.status, 'review', 'not naming the order: in this mode the event must');
  assert.equal(await w.passEnd(other.id), null);

  // Failed: settled, with why.
  const c5 = await w.pay.checkout(other, 'en', 'https://tifomaker.test');
  assert.ok(c5.ok && 'form' in c5);
  await send(hookPayment({ id: c5.form.givenId, status: 'failed', amount: priceHalalas(), currency: 'SAR', refunded: 0, sourceType: 'creditcard', message: 'INSUFFICIENT FUNDS', responseCode: '51', metadata: { order_id: c5.orderId } }), { type: 'payment_failed' });
  assert.equal((await w.payRepo.get(c5.orderId))!.fail, 'funds');

  // The real one, five times at once: one pass.
  const all = await Promise.all(Array.from({ length: 5 }, () => send(hookPayment(good()))));
  assert.ok(all.every((x) => x === 'done'));
  assert.equal(await status(), 'paid');
  assert.equal((await w.proRepo.allPasses(fan.id)).filter((p) => p.source === 'payment').length, 1, 'one pass per paid order');
  assert.equal(w.receipts.length, 1);
  // A token in the event is never kept in this mode (nothing could charge it): it goes to the trash to be deleted.
  // Refunds: not from /admin, and a dashboard refund ends the pass.
  assert.deepEqual(await w.pay.refund(c.orderId), { ok: false, reason: 'dashboard' });
  assert.equal(await send(hookPayment(good({ status: 'refunded', refunded: priceHalalas() })), { type: 'payment_refunded' }), 'done');
  assert.equal(await status(), 'refunded');
  assert.equal(await w.passEnd(fan.id), null, 'every refund ends its pass');
  assert.equal(await send(hookPayment(good())), 'done');
  assert.equal(await status(), 'refunded', 'a late "paid" never pays a refunded order again');
  // The renewals job has nothing to do here, ever.
  assert.deepEqual(await w.pay.runRenewals(), { reminded: 0, charged: 0, failed: 0, ended: 0, postponed: 0 });
  console.log('payments2.test: the webhook-only mode checked');
}

// ------------------------------------------------- 5. "Keep Pro on": the opt-in ---
{
  const w = world();
  const fan = w.buyer('keeper');
  const c = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(c.ok && 'form' in c);
  assert.ok(c.form.renew, 'offered');
  assert.equal(c.form.renew!.price, OFFER.monthly.price);
  assert.equal(c.form.renew!.nextAt, new Date(w.state.now.getTime() + OFFER.monthly.days * DAY).toISOString(), 'the first renewal date, shown before paying');
  assert.equal(c.form.renew!.mada, true, 'mada renews like any other card, by default');
  assert.equal((await w.payRepo.get(c.orderId))!.keep, false, 'never ticked for the fan');
  // Only the order's own account, while it is open.
  assert.equal(await w.pay.setKeep(randomUUID(), c.orderId, true), false, 'not someone else');
  assert.equal(await w.pay.setKeep(fan.id, randomUUID(), true), false);
  assert.equal(await w.pay.setKeep(fan.id, c.orderId, true), true);
  const ticked = (await w.payRepo.get(c.orderId))!;
  assert.equal(ticked.keep, true);
  assert.equal(ticked.keepAt, w.state.now.toISOString(), 'when they agreed is recorded');
  // Opening the form again starts unticked again.
  const again = await w.pay.checkout(fan, 'en', 'https://tifomaker.test');
  assert.ok(again.ok && again.orderId === c.orderId);
  assert.equal((await w.payRepo.get(c.orderId))!.keep, false, 'a form opened again is unticked again');

  // Paid without the tick, though Moyasar saved the card (a tampered form): no auto-renew, and the token is deleted.
  const p1 = w.moyasar.formPay(c.form, c.orderId, { save: true });
  const o1 = (await w.pay.orderFor(fan.id, c.orderId))!;
  assert.equal(o1.status, 'paid');
  assert.equal(await w.pay.renewalFor(fan.id), null, 'no opt-in, no subscription');
  assert.equal(w.moyasar.tokens.has(p1.token!), false, 'a card nobody asked to keep is deleted at once');
  assert.equal(await w.pay.setKeep(fan.id, c.orderId, true), false, 'and it cannot be ticked after paying');
  assert.equal(w.receipts[0].renews, false);

  // Ticked and paid with Visa: auto-renew starts, due when the month ends.
  const visa = w.buyer('visa_fan');
  const b = await w.buy(visa, { keep: true });
  const sub = (await w.pay.renewalFor(visa.id))!;
  assert.equal(sub.status, 'active');
  assert.equal(sub.token, b.payment.token);
  assert.equal(sub.amount, priceHalalas());
  assert.equal(sub.nextChargeAt, new Date(await w.passEnd(visa.id) as number).toISOString());
  assert.equal(sub.optedInAt, w.state.now.toISOString());
  assert.deepEqual([sub.brand, sub.lastFour, sub.expMonth, sub.expYear], ['visa', '1111', 12, 2030]);
  assert.equal(w.receipts.at(-1)!.renews, true, 'the receipt says it renews');

  // mada, ticked: it renews like any other card.
  const mada = w.buyer('mada_fan');
  const m = await w.buy(mada, { keep: true, company: 'mada' });
  assert.equal(m.order.status, 'paid');
  assert.equal((await w.pay.renewalFor(mada.id))?.status, 'active', 'mada renews by default');
  assert.equal((await w.pay.renewalFor(mada.id))?.brand, 'mada');
  // If Moyasar turns out not to charge mada tokens, the renewal fails like any declined card:
  // nothing charged, retried, then auto-renew ends by itself.
  {
    const end = (await w.passEnd(mada.id))!;
    const before = { now: w.state.now, mode: w.moyasar.mode, charges: w.moyasar.charges.length };
    w.at(end - REMIND_DAYS * DAY - HOUR);
    await w.pay.runRenewals();
    w.moyasar.mode = 'refuse';
    w.at(end + HOUR);
    await w.pay.runRenewals();
    assert.equal((await w.pay.renewalFor(mada.id))!.status, 'failing');
    for (const d of RETRY_DAYS) {
      w.forward(d * DAY + HOUR);
      await w.pay.runRenewals();
    }
    assert.equal((await w.pay.renewalFor(mada.id))!.status, 'ended', 'a mada token Moyasar will not charge ends auto-renew without fuss');
    assert.equal(w.moyasar.charges.length, before.charges, 'and nothing was ever charged');
    assert.equal(w.moyasar.tokens.has(m.payment.token!), false);
    w.moyasar.mode = before.mode;
    w.state.now = before.now;
  }
  // PRO_AUTORENEW_MADA=off: the month is given, the card is not kept, and the form says so beforehand.
  {
    const w2 = world({ ...RENEW_ENV, PRO_AUTORENEW_MADA: 'off' });
    const fan2 = w2.buyer('mada_off');
    const c2 = await w2.pay.checkout(fan2, 'en', 'https://tifomaker.test');
    assert.ok(c2.ok && 'form' in c2 && c2.form.renew?.mada === false);
    const m2 = await w2.buy(fan2, { keep: true, company: 'mada' });
    assert.equal(m2.order.status, 'paid');
    assert.equal(await w2.pay.renewalFor(fan2.id), null, 'mada keeps the one-time pass');
    assert.equal(w2.moyasar.tokens.has(m2.payment.token!), false, 'and its token is deleted');
    const visa = w2.buyer('visa_still');
    await w2.buy(visa, { keep: true });
    assert.equal((await w2.pay.renewalFor(visa.id))?.status, 'active', 'other cards still renew');
  }
  // STC Pay has no card to save; Apple Pay does.
  const stc = w.buyer('stc_fan');
  await w.buy(stc, { keep: true, type: 'stcpay', save: false });
  assert.equal(await w.pay.renewalFor(stc.id), null);
  const apple = w.buyer('apple_fan');
  await w.buy(apple, { keep: true, type: 'applepay' });
  assert.equal((await w.pay.renewalFor(apple.id))?.method, 'applepay');
  // A token that is not active cannot be charged: not kept.
  const cold = w.buyer('cold_token');
  const cb = await w.buy(cold, { keep: true, tokenStatus: 'initiated' });
  assert.equal(await w.pay.renewalFor(cold.id), null);
  assert.equal(w.moyasar.tokens.has(cb.payment.token!), false);
  // Moyasar cannot be reached to delete a token: it waits in the trash, and goes at the next run.
  const late = w.buyer('late_delete');
  w.moyasar.deleteFails = true;
  const lb = await w.buy(late, { keep: true, tokenStatus: 'initiated' });
  assert.equal(w.moyasar.tokens.has(lb.payment.token!), true);
  assert.deepEqual(await w.payRepo.trashed(10), [lb.payment.token]);
  w.moyasar.deleteFails = false;
  await w.pay.runRenewals();
  assert.equal(w.moyasar.tokens.has(lb.payment.token!), false, 'deleted at the next run');
  assert.deepEqual(await w.payRepo.trashed(10), []);
  console.log('payments2.test: the opt-in checked');
}

// ------------------------------------------------- 6. renewals, on a clock we hold ---
{
  const w = world();
  const fan = w.buyer('renewer');
  const first = await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  const token = first.payment.token!;
  const charges = () => w.moyasar.charges.length;
  const reminders = () => w.notices.filter((n) => n.kind === 'reminder').length;

  // Long before: nothing.
  w.at(end0 - 10 * DAY);
  assert.deepEqual(await w.pay.runRenewals(), { reminded: 0, charged: 0, failed: 0, ended: 0, postponed: 0 });
  w.at(end0 - REMIND_DAYS * DAY - 7 * HOUR);
  await w.pay.runRenewals();
  assert.equal(reminders(), 0, 'not yet: the reminder goes out three days before, give or take the hour between jobs');

  // Three days before: the reminder, once, however many jobs run (and from two servers).
  w.at(end0 - REMIND_DAYS * DAY - HOUR);
  const second = w.make();
  await Promise.all([w.pay.runRenewals(), second.runRenewals(), w.pay.runRenewals(), second.runRenewals()]);
  assert.equal(reminders(), 1, 'one reminder');
  const rem = w.notices.find((n) => n.kind === 'reminder')!;
  assert.equal(rem.kind === 'reminder' && rem.chargeAt, new Date(end0).toISOString(), 'for the date the month ends');
  const mail = renewEmail({ notice: rem, to: fan.email, base: 'https://tifomaker.org', contact: 'help@example.test' });
  assert.match(mail.subject, /renews in 3 days/);
  assert.ok(mail.html.includes('dir="rtl"') || mail.html.includes('lang="ar"'), 'Arabic and English');
  assert.ok(mail.text!.includes(`SAR ${OFFER.monthly.price}`) && mail.html.includes('Visa ending 1111') && mail.html.includes('ريال'), 'the amount and the card');
  const sub0 = (await w.pay.renewalFor(fan.id))!;
  assert.ok(mail.html.includes(`/pro?stop=${sub0.cancelToken}`) && mail.text!.includes(cancelUrlOf('https://tifomaker.org', sub0)), 'the one-click cancel link');
  assert.ok(!mail.html.includes(token) && !mail.text!.includes(token), 'never the token');
  assert.ok(!mail.subject.includes('TEST'), 'live money: no TEST mark');

  // Between the reminder and the date: nothing is charged.
  w.at(end0 - DAY);
  await Promise.all([w.pay.runRenewals(), second.runRenewals()]);
  assert.equal(charges(), 0, 'not before the date');
  assert.equal(reminders(), 1);

  // The date: charged once, however many jobs run at once.
  w.at(end0 + 60_000);
  const runs = await Promise.all([w.pay.runRenewals(), second.runRenewals(), w.pay.runRenewals(), second.runRenewals(), w.make().runRenewals()]);
  assert.equal(charges(), 1, 'ONE charge for the period, from five jobs at once');
  assert.equal(runs.reduce((s, r) => s + r.charged, 0) >= 1, true);
  const charge = w.moyasar.charges[0];
  assert.equal(charge.amount, priceHalalas());
  assert.equal(charge.token, token);
  assert.equal(charge.currency, 'SAR');
  const end1 = (await w.passEnd(fan.id))!;
  assert.equal(end1 - end0, OFFER.monthly.days * DAY, 'thirty more days, starting where the last ended');
  const orders = await w.payRepo.recentFor(fan.id, new Date(0));
  const renewal = orders.find((o) => o.kind === 'renewal')!;
  assert.equal(renewal.status, 'paid');
  assert.equal(renewal.paymentId, charge.givenId, 'the order and the payment share the id the server chose');
  assert.equal(charge.metadata.order_id, renewal.id);
  assert.equal(orders.filter((o) => o.kind === 'renewal').length, 1, 'one order per renewal');
  assert.equal((await w.proRepo.allPasses(fan.id)).filter((p) => p.source === 'payment').length, 2, 'one pass per paid order');
  assert.deepEqual(w.receipts.at(-1), { order: renewal.id, kind: 'renewal', renews: true }, 'a receipt, like any order');
  const sub1 = (await w.pay.renewalFor(fan.id))!;
  assert.equal(sub1.cycle, 2);
  assert.equal(sub1.nextChargeAt, new Date(end1).toISOString(), 'the next one is due when the new month ends');
  assert.equal(sub1.status, 'active');
  // Run again and again: nothing more.
  for (let i = 0; i < 3; i++) await Promise.all([w.pay.runRenewals(), second.runRenewals()]);
  assert.equal(charges(), 1);
  assert.equal(reminders(), 1);
  const receipt = receiptEmail({ order: renewal, to: fan.email, endsAt: new Date(end1).toISOString(), base: 'https://tifomaker.org', contact: 'help@example.test', renew: { nextAt: new Date(end1).toISOString(), cancelUrl: cancelUrlOf('https://tifomaker.org', sub1) } });
  assert.ok(receipt.html.includes('automatic renewal') && receipt.html.includes('Turn off auto-renew') && receipt.text!.includes('Auto-renew is on') && !receipt.html.includes('no auto-renewal'));

  // A refund through /admin, like any order: the pass ends, and so does auto-renew (its token deleted).
  const refunded = await w.pay.refund(renewal.id);
  assert.equal(refunded.ok, true);
  assert.equal(await w.passEnd(fan.id), end0 > w.state.now.getTime() ? end0 : null, 'the refund ended the pass it paid for');
  assert.equal((await w.pay.renewalFor(fan.id))!.status, 'cancelled', 'nobody who asked for their money back is charged again');
  assert.equal(w.moyasar.tokens.has(token), false);
  w.forward(40 * DAY);
  await w.pay.runRenewals();
  assert.equal(charges(), 1, 'and nothing is charged after it');
  console.log('payments2.test: a renewal, its reminder and its races checked');
}

// ---- the reminder is a promise: no email, no charge
{
  const w = world();
  const fan = w.buyer('unreachable');
  await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  w.state.mailUp = false;
  w.at(end0 - REMIND_DAYS * DAY + HOUR);
  await w.pay.runRenewals();
  w.at(end0 + HOUR);
  await w.pay.runRenewals();
  w.at(end0 + 2 * DAY);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'the reminder could not be sent: nothing is charged, date or no date');
  // The mail is back two days late: reminded now, charged three days after that, not before.
  w.state.mailUp = true;
  await w.pay.runRenewals();
  const rem = w.notices.find((n) => n.kind === 'reminder')!;
  assert.equal(rem.kind === 'reminder' && rem.chargeAt, new Date(w.state.now.getTime() + REMIND_DAYS * DAY).toISOString(), 'the renewal moved to three days after the reminder');
  w.forward(REMIND_DAYS * DAY - HOUR);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'still inside the three days');
  w.forward(2 * HOUR);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 1, 'three days after the reminder: charged');
  assert.equal((await w.passEnd(fan.id))! - w.state.now.getTime(), OFFER.monthly.days * DAY, 'thirty days from the charge: no day was paid for twice');

  // Never reachable: auto-renew ends by itself rather than charge unannounced.
  const w2 = world();
  const ghost = w2.buyer('ghost');
  const gb = await w2.buy(ghost, { keep: true });
  const gEnd = (await w2.passEnd(ghost.id))!;
  w2.state.mailUp = false;
  for (let d = -3; d <= 9; d++) {
    w2.at(gEnd + d * DAY + HOUR);
    await w2.pay.runRenewals();
  }
  assert.equal(w2.moyasar.charges.length, 0);
  assert.equal((await w2.pay.renewalFor(ghost.id))!.status, 'ended');
  assert.equal((await w2.pay.renewalFor(ghost.id))!.endReason, 'unreachable');
  assert.equal(w2.moyasar.tokens.has(gb.payment.token!), false);
  console.log('payments2.test: no reminder, no charge');
}

// ---- failed renewals: retried a few times over a few days, then Pro ends without fuss
{
  const w = world();
  const fan = w.buyer('declined');
  const b = await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  w.at(end0 - REMIND_DAYS * DAY + HOUR);
  await w.pay.runRenewals();
  w.moyasar.mode = 'decline';
  w.at(end0 + HOUR);
  await Promise.all([w.pay.runRenewals(), w.make().runRenewals()]);
  assert.equal(w.moyasar.charges.length, 1, 'one try, even from two jobs');
  let sub = (await w.pay.renewalFor(fan.id))!;
  assert.equal(sub.status, 'failing');
  assert.equal(sub.attempts, 1);
  assert.equal(sub.lastError, 'funds');
  assert.equal(sub.nextChargeAt, new Date(w.state.now.getTime() + RETRY_DAYS[0] * DAY).toISOString());
  const failedMail = w.notices.filter((n) => n.kind === 'failed');
  assert.equal(failedMail.length, 1, 'the fan is emailed');
  const fm = renewEmail({ notice: failedMail[0], to: fan.email, base: 'https://tifomaker.org', contact: 'help@example.test' });
  assert.ok(/couldn't renew/.test(fm.subject) && fm.text!.includes('nothing was charged') && fm.html.includes('ما انخصم منك شي') && fm.html.includes('/pro?stop='));
  // Run again the same day: no second try.
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 1);
  // Each retry on its day; each its own order and its own payment id.
  for (let i = 0; i < RETRY_DAYS.length; i++) {
    w.forward(RETRY_DAYS[i] * DAY - HOUR);
    await w.pay.runRenewals();
    assert.equal(w.moyasar.charges.length, 1 + i, 'not before its day');
    w.forward(2 * HOUR);
    await Promise.all([w.pay.runRenewals(), w.make().runRenewals()]);
    assert.equal(w.moyasar.charges.length, 2 + i, `retry ${i + 1}, once`);
  }
  assert.equal(new Set(w.moyasar.charges.map((c) => c.givenId)).size, 1 + RETRY_DAYS.length, 'every try is its own payment');
  sub = (await w.pay.renewalFor(fan.id))!;
  assert.equal(sub.status, 'ended', 'after the last retry it stops by itself');
  assert.equal(sub.endReason, 'payment_failed');
  assert.equal(sub.token, null);
  assert.equal(w.moyasar.tokens.has(b.payment.token!), false, 'the card is deleted at Moyasar');
  assert.equal(w.notices.filter((n) => n.kind === 'failed').length, 1, 'one "it failed" email, not one per try');
  const ended = w.notices.filter((n) => n.kind === 'ended');
  assert.equal(ended.length, 1);
  assert.ok(renewEmail({ notice: ended[0], to: fan.email, base: 'https://tifomaker.org', contact: 'c' }).text!.includes('Nothing was charged'));
  assert.equal(await w.passEnd(fan.id), null, 'Pro ended when the paid days did; nothing was added');
  assert.equal((await w.payRepo.recentFor(fan.id, new Date(0))).filter((o) => o.kind === 'renewal' && o.status === 'failed').length, 1 + RETRY_DAYS.length);
  w.forward(60 * DAY);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 1 + RETRY_DAYS.length, 'and never again');

  // A retry that works: back to normal, one pass.
  const w2 = world();
  const lucky = w2.buyer('lucky');
  await w2.buy(lucky, { keep: true });
  const e2 = (await w2.passEnd(lucky.id))!;
  w2.at(e2 - REMIND_DAYS * DAY + HOUR);
  await w2.pay.runRenewals();
  w2.moyasar.mode = 'decline';
  w2.at(e2 + HOUR);
  await w2.pay.runRenewals();
  w2.moyasar.mode = 'paid';
  w2.forward(RETRY_DAYS[0] * DAY + HOUR);
  await w2.pay.runRenewals();
  const s2 = (await w2.pay.renewalFor(lucky.id))!;
  assert.equal(s2.status, 'active');
  assert.equal(s2.attempts, 0);
  assert.equal(s2.cycle, 2);
  assert.equal((await w2.passEnd(lucky.id))! - w2.state.now.getTime(), OFFER.monthly.days * DAY);
  assert.equal((await w2.proRepo.allPasses(lucky.id)).filter((p) => p.source === 'payment').length, 2);
  console.log('payments2.test: failed renewals checked');
}

// ---- expired cards: emailed to update, never charged
{
  // The card's expiry falls before the renewal date: no charge is tried at all.
  const w = world();
  const fan = w.buyer('expiring');
  const b = await w.buy(fan, { keep: true, expYear: 2027, expMonth: 1 }); // bought 1 Jan 2027; renews 31 Jan; the card ends January
  const end0 = (await w.passEnd(fan.id))!;
  const b2 = w.buyer('expiring_feb');
  await w.buy(b2, { keep: true, expYear: 2027, expMonth: 2 });
  w.at(end0 + 2 * DAY); // 2 February: the January card has expired, the February one has not
  await w.pay.runRenewals();
  assert.equal((await w.pay.renewalFor(fan.id))!.status, 'ended');
  assert.equal((await w.pay.renewalFor(fan.id))!.endReason, 'card_expired');
  assert.equal(w.moyasar.charges.length, 0, 'an expired card is not charged');
  assert.equal(w.moyasar.tokens.has(b.payment.token!), false);
  const exp = w.notices.filter((n) => n.kind === 'ended' && n.sub.userId === fan.id);
  assert.equal(exp.length, 1);
  const em = renewEmail({ notice: exp[0], to: fan.email, base: 'https://tifomaker.org', contact: 'c' });
  assert.ok(/card expired: update it/.test(em.subject) && em.html.includes('Update my card') && em.html.includes('حدّثها') && em.text!.includes('Nothing was charged'));
  assert.equal((await w.pay.renewalFor(b2.id))!.status, 'active', 'a card good through the month is fine');

  // The bank says "expired card" at the charge: ended at once, not retried for a week.
  const w2 = world();
  const fan2 = w2.buyer('bank_says_expired');
  await w2.buy(fan2, { keep: true });
  const e2 = (await w2.passEnd(fan2.id))!;
  w2.at(e2 - REMIND_DAYS * DAY + HOUR);
  await w2.pay.runRenewals();
  w2.moyasar.mode = 'expired';
  w2.at(e2 + HOUR);
  await w2.pay.runRenewals();
  assert.equal((await w2.pay.renewalFor(fan2.id))!.endReason, 'card_expired');
  assert.equal(w2.moyasar.charges.length, 1);
  w2.forward(10 * DAY);
  await w2.pay.runRenewals();
  assert.equal(w2.moyasar.charges.length, 1, 'no retries on an expired card');
  console.log('payments2.test: expired cards checked');
}

// ---- a time-out leaves the outcome unknown: never a second charge
{
  for (const mode of ['timeout_after', 'timeout_before', 'down'] as const) {
    const w = world();
    const fan = w.buyer(`timeout_${mode}`);
    await w.buy(fan, { keep: true });
    const end0 = (await w.passEnd(fan.id))!;
    w.at(end0 - REMIND_DAYS * DAY + HOUR);
    await w.pay.runRenewals();
    w.moyasar.mode = mode;
    w.at(end0 + HOUR);
    await w.pay.runRenewals();
    const pending = (await w.payRepo.recentFor(fan.id, new Date(0))).find((o) => o.kind === 'renewal')!;
    assert.equal(pending.status, 'pending', `${mode}: the order waits, neither paid nor failed`);
    assert.equal((await w.pay.renewalFor(fan.id))!.attempts, 0, `${mode}: a fault on our side is not a failed try against the fan`);
    assert.equal(await w.passEnd(fan.id), null, 'no pass yet');
    // Moyasar answers again. Run from two servers at once, several times.
    w.moyasar.mode = 'paid';
    w.forward(HOUR);
    await Promise.all([w.pay.runRenewals(), w.make().runRenewals(), w.pay.runRenewals()]);
    await w.pay.runRenewals();
    assert.equal(w.moyasar.charges.length, 1, `${mode}: one charge in all`);
    assert.equal(w.moyasar.charges[0].givenId, pending.paymentId, `${mode}: under the id fixed with the order, so asking twice could only ever be one payment`);
    assert.equal(w.moyasar.payments.size, 2, 'the purchase and one renewal: nothing else exists at Moyasar');
    assert.equal((await w.proRepo.allPasses(fan.id)).filter((p) => p.source === 'payment').length, 2, 'one pass for it');
    assert.equal((await w.payRepo.recentFor(fan.id, new Date(0))).filter((o) => o.kind === 'renewal').length, 1, 'one order for it');
    assert.equal((await w.pay.renewalFor(fan.id))!.cycle, 2);
  }
  // Moyasar refuses the token outright (deactivated): a failed try, no payment, retried later.
  const w = world();
  const fan = w.buyer('refused_token');
  await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  w.at(end0 - REMIND_DAYS * DAY + HOUR);
  await w.pay.runRenewals();
  w.moyasar.mode = 'refuse';
  w.at(end0 + HOUR);
  await w.pay.runRenewals();
  assert.equal((await w.pay.renewalFor(fan.id))!.status, 'failing');
  assert.equal(w.moyasar.charges.length, 0);
  // The bank wants 3-D Secure, which nobody is there to do: a failed try, nothing charged.
  const w3 = world();
  const fan3 = w3.buyer('wants_3ds');
  await w3.buy(fan3, { keep: true });
  const e3 = (await w3.passEnd(fan3.id))!;
  w3.at(e3 - REMIND_DAYS * DAY + HOUR);
  await w3.pay.runRenewals();
  w3.moyasar.mode = '3ds';
  w3.at(e3 + HOUR);
  await w3.pay.runRenewals();
  assert.equal((await w3.pay.renewalFor(fan3.id))!.lastError, 'auth');
  assert.equal(await w3.passEnd(fan3.id), null);
  assert.equal((await w3.payRepo.recentFor(fan3.id, new Date(0))).find((o) => o.kind === 'renewal')!.status, 'failed');
  console.log('payments2.test: unknown outcomes checked: never a double charge');
}

// ---- cancelling: one click, Pro stays until the paid days end, and nothing is charged after
{
  const w = world();
  const fan = w.buyer('canceller');
  const b = await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  w.at(end0 - REMIND_DAYS * DAY + HOUR);
  await w.pay.runRenewals();
  assert.equal(w.notices.filter((n) => n.kind === 'reminder').length, 1);
  // From the account page.
  assert.equal(await w.pay.stopRenewing(fan.id, 'account page'), true);
  const sub = (await w.pay.renewalFor(fan.id))!;
  assert.equal(sub.status, 'cancelled');
  assert.equal(sub.token, null);
  assert.equal(w.moyasar.tokens.has(b.payment.token!), false, 'the token is deleted at Moyasar');
  assert.equal(await w.passEnd(fan.id), end0, 'Pro stays on until the paid days end');
  const said = w.notices.filter((n) => n.kind === 'cancelled');
  assert.equal(said.length, 1);
  assert.ok(renewEmail({ notice: said[0], to: fan.email, base: 'https://tifomaker.org', contact: 'c' }).text!.includes('nothing more will be charged'));
  assert.equal(await w.pay.stopRenewing(fan.id, 'again'), false, 'already off');
  w.at(end0 + HOUR);
  await Promise.all([w.pay.runRenewals(), w.make().runRenewals()]);
  w.forward(40 * DAY);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'cancelled before the date: never charged');
  assert.equal(await w.passEnd(fan.id), null);

  // From the email's link: no sign-in, and it can only turn renewal off.
  const linker = w.buyer('linker');
  await w.buy(linker, { keep: true });
  const s = (await w.pay.renewalFor(linker.id))!;
  assert.deepEqual(await w.pay.cancelByLink('nope'), { ok: false });
  assert.deepEqual(await w.pay.cancelByLink('x'.repeat(32)), { ok: false }, 'a made-up link turns nothing off');
  assert.equal((await w.pay.renewalFor(linker.id))!.status, 'active');
  const r = await w.pay.cancelByLink(s.cancelToken);
  assert.ok(r.ok && r.was && r.endsAt === new Date((await w.passEnd(linker.id))!).toISOString());
  assert.equal((await w.pay.renewalFor(linker.id))!.status, 'cancelled');
  const again = await w.pay.cancelByLink(s.cancelToken);
  assert.ok(again.ok && !again.was, 'pressed twice: still off, said plainly');

  // Bought again with the tick: a new subscription, a new link; the old link is dead.
  w.at((await w.passEnd(linker.id))! - 2 * DAY);
  const b2 = await w.buy(linker, { keep: true });
  const s2 = (await w.pay.renewalFor(linker.id))!;
  assert.equal(s2.status, 'active');
  assert.equal(s2.token, b2.payment.token);
  assert.notEqual(s2.cancelToken, s.cancelToken);
  assert.deepEqual(await w.pay.cancelByLink(s.cancelToken), { ok: false });

  // Switched off for everyone (PRO_AUTORENEW unset): nothing is charged, and cancelling still works.
  const offEnv = { ...FORM_ENV };
  const off = w.make(offEnv);
  w.at(Date.parse(s2.nextChargeAt!) + HOUR);
  assert.deepEqual(await off.runRenewals(), { reminded: 0, charged: 0, failed: 0, ended: 0, postponed: 0 });
  assert.equal(w.moyasar.charges.length, 0, 'the switch-off stops every charge');
  assert.equal(await off.stopRenewing(linker.id, 'account page'), true, 'and nobody is left unable to cancel');
  assert.equal(w.moyasar.tokens.has(b2.payment.token!), false);

  // /admin switches one off.
  const adm = w.buyer('admin_off');
  await w.buy(adm, { keep: true });
  const sa = (await w.pay.renewalFor(adm.id))!;
  assert.equal(await w.pay.adminCancel(sa.id), true);
  assert.equal(await w.pay.adminCancel(sa.id), false);
  assert.equal(await w.pay.adminCancel(randomUUID()), false);
  const listed = await w.pay.subscriptions();
  assert.ok(listed.rows.length >= 3 && listed.rows.every((x) => x.status !== 'active'));

  // Deleting the account: the token goes first, at Moyasar too.
  const gone = w.buyer('deleter');
  const gb = await w.buy(gone, { keep: true });
  await w.pay.forgetAccount(gone.id);
  assert.equal(await w.pay.renewalFor(gone.id), null);
  assert.equal(w.moyasar.tokens.has(gb.payment.token!), false);
  w.forward(40 * DAY);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0, 'nothing is ever charged to a deleted account');
  console.log('payments2.test: cancelling checked');
}

// ---- holding Pro past the renewal date: nothing is charged for days already held
{
  const w = world();
  const fan = w.buyer('gifted');
  await w.buy(fan, { keep: true });
  const end0 = (await w.passEnd(fan.id))!;
  // The owner gives them a month by hand, starting when theirs ends.
  await w.proRepo.grantPass({ userId: fan.id, plan: 'monthly', startsAt: new Date(end0), endsAt: new Date(end0 + 30 * DAY), source: 'admin', createdBy: null });
  w.at(end0 - REMIND_DAYS * DAY + HOUR);
  const r = await w.pay.runRenewals();
  assert.equal(r.postponed, 1);
  assert.equal(w.notices.length, 0, 'no reminder for a date that moved');
  assert.equal((await w.pay.renewalFor(fan.id))!.nextChargeAt, new Date(end0 + 30 * DAY).toISOString(), 'the renewal waits for the given month to end');
  w.at(end0 + HOUR);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 0);
  // Then it renews as usual: reminded three days before the new date, charged on it.
  w.at(end0 + 27 * DAY + HOUR);
  await w.pay.runRenewals();
  assert.equal(w.notices.filter((n) => n.kind === 'reminder').length, 1);
  w.at(end0 + 30 * DAY + HOUR);
  await w.pay.runRenewals();
  assert.equal(w.moyasar.charges.length, 1);

  // Test money and live money never mix: a subscription made on test keys is not charged on live keys.
  const wt = world({ ...RENEW_ENV, MOYASAR_SECRET_KEY: TEST_KEY, MOYASAR_PUBLISHABLE_KEY: PK_TEST, PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'tester' });
  const tester = wt.buyer('tester');
  await wt.buy(tester, { keep: true });
  assert.equal((await wt.pay.renewalFor(tester.id))!.testMode, true);
  const live = wt.make({ ...RENEW_ENV });
  wt.forward(31 * DAY);
  await live.runRenewals();
  assert.equal(wt.moyasar.charges.length + wt.notices.length, 0, 'not reminded and not charged on the other kind of key');
  const testReminderWorld = await wt.pay.runRenewals();
  assert.equal(testReminderWorld.reminded, 1);
  assert.match(renewEmail({ notice: wt.notices[0], to: 't@example.test', base: 'https://tifomaker.org', contact: 'c' }).subject, /^\[TEST\]/, 'a test reminder says so');
  console.log('payments2.test: postponing and test/live separation checked');
}

// ------------------------------------------------- 7. the routes, end to end ---
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
  MOYASAR_PROXY_URL: undefined, MOYASAR_METHODS: undefined, APPLE_PAY_DOMAIN_ASSOCIATION: undefined, MOYASAR_SAMSUNG_SERVICE_ID: undefined,
};
const restore = setEnv(ALL_OFF);
{
  const APPLE = 'A1B2C3D4'.repeat(60);
  const applied = setEnv({ APPLE_PAY_DOMAIN_ASSOCIATION: APPLE });
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
    adminUsernames: ['boss_pay2'], aiAdminPassword: 'pay2 admin password',
  });
  applied();
  const fan = await reg(app, 'route_fan');
  await auth.markEmailVerified(fan.id);
  const other = await reg(app, 'route_other');
  await auth.markEmailVerified(other.id);
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'pay2 admin password' } })).json().token as string;
  const asBoss = { 'x-ai-unlock': unlock };
  const post = (url: string, token: string | null, payload: object = {}) => app.inject({ method: 'POST', url, ...(token ? { headers: bearer(token) } : {}), payload });
  const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, ...(token ? { headers: bearer(token) } : {}) });
  const proOf = async (token: string) => (await get('/api/pro', token)).json() as Record<string, any>;

  // Apple Pay's file: served from the variable, as text, at its exact path, whatever the switches.
  const file = await get('/.well-known/apple-developer-merchantid-domain-association', null);
  assert.equal(file.statusCode, 200);
  assert.match(String(file.headers['content-type']), /^text\/plain/);
  assert.equal(file.body, APPLE);
  assert.equal((await get('/.well-known/apple-developer-merchantid-domain-association.txt', null)).statusCode, 404, 'no extension, as Apple requires');

  // --- v1's variables alone: every new route is closed, and /api/pro says nothing new.
  const v1 = setEnv({ PRO_MODE: 'on', PRO_PAYMENTS: 'on', MOYASAR_SECRET_KEY: LIVE_KEY });
  {
    const me = await proOf(fan.token);
    assert.equal(me.offer.paymentsOpen, true);
    assert.ok(!('checkout' in me.offer) && !('autoRenew' in me.offer), 'the offer is exactly v1\'s');
    assert.equal((await get('/api/pro/renew', fan.token)).statusCode, 404, 'no auto-renew to read');
    assert.equal((await post('/api/pro/pay/keep', fan.token, { order: randomUUID(), keep: true })).statusCode, 409, 'nothing to tick');
    assert.equal((await post('/api/pro/renew/stop', null, { t: 'x'.repeat(32) })).statusCode, 404);
    const st = (await app.inject({ method: 'GET', url: '/api/admin/pro/orders', headers: asBoss })).json().status;
    assert.deepEqual([st.checkout, st.verify, st.autoRenew, st.proxy], ['invoice', 'api', false, false]);
  }
  v1();
  // --- everything off: the payment routes are not there at all.
  assert.equal((await post('/api/pro/pay/keep', fan.token, { order: randomUUID(), keep: true })).statusCode, 404);
  assert.equal((await post('/api/pro/pay/attempt', fan.token, { order: randomUUID() })).statusCode, 404);
  assert.equal((await get('/api/pro/renew', fan.token)).statusCode, 404);

  // --- the form and auto-renew on.
  const on = setEnv({ ...RENEW_ENV, MOYASAR_METHODS: 'creditcard,applepay', MOYASAR_WEBHOOK_SECRET: HOOK });
  const me = await proOf(fan.token);
  assert.equal(me.offer.checkout, 'form');
  assert.equal(me.offer.autoRenew, true);
  const signedOut = (await get('/api/pro', null)).json();
  assert.deepEqual([signedOut.offer.checkout, signedOut.offer.autoRenew], ['form', true]);
  const c = await post('/api/pro/pay/checkout', fan.token, { lang: 'en' });
  assert.equal(c.statusCode, 200, c.body);
  const { order: orderId, form } = c.json() as { order: string; form: FormConfig; url?: string };
  assert.ok(form && !c.json().url, 'a form to open, not a page to go to');
  assert.deepEqual(form.methods, ['creditcard', 'applepay'], 'Apple Pay is offered once its file is served');
  assert.deepEqual(form.applePay, { label: 'TifoMaker', country: 'SA' });
  assert.ok(!c.body.includes('sk_live'), 'the secret key never leaves the server');
  assert.equal(form.callbackUrl, `https://tifomaker.test/pro?order=${orderId}`);
  // "Keep Pro on": explicit, typed, the order's own account.
  assert.equal((await post('/api/pro/pay/keep', null, { order: orderId, keep: true })).statusCode, 401, 'signed out');
  assert.equal((await post('/api/pro/pay/keep', other.token, { order: orderId, keep: true })).statusCode, 409, 'someone else cannot tick it');
  for (const bad of [{ order: orderId }, { order: orderId, keep: 'true' }, { order: orderId, keep: 1 }, { order: 'x', keep: true }, { keep: true }]) {
    assert.equal((await post('/api/pro/pay/keep', fan.token, bad)).statusCode, 400, `only a real true or false: ${JSON.stringify(bad)}`);
  }
  assert.equal((await payRepo.get(orderId))!.keep, false, 'none of that ticked it');
  assert.equal((await post('/api/pro/pay/keep', fan.token, { order: orderId, keep: true })).statusCode, 200);
  assert.equal((await post('/api/pro/pay/attempt', other.token, { order: orderId })).statusCode, 200);
  assert.equal((await payRepo.get(orderId))!.attemptedAt, null, 'someone else\'s "attempt" does nothing');
  assert.equal((await post('/api/pro/pay/attempt', fan.token, { order: orderId })).statusCode, 200);
  // Paid on the form, 3-D Secure done.
  const p = moyasar.formPay(form, orderId, { save: true });
  const seen = (await get(`/api/pro/pay/order/${orderId}`, fan.token)).json();
  assert.deepEqual([seen.status, seen.kept, seen.renews, seen.why], ['paid', true, true, null]);
  assert.equal((await get(`/api/pro/pay/order/${orderId}`, other.token)).statusCode, 404);
  // The receipt says it renews, when, and how to stop.
  const receipt = outbox.sent.find((m) => /receipt/i.test(m.subject))!;
  assert.ok(receipt.html.includes('Auto-renew is on') && receipt.html.includes('/pro?stop=') && receipt.html.includes('التجديد التلقائي شغّال') && !receipt.html.includes('no auto-renewal'));
  assert.ok(!JSON.stringify(outbox.sent).includes(p.token!), 'no email ever carries the token');
  // The account's own view: never the token.
  const rn = await get('/api/pro/renew', fan.token);
  assert.equal(rn.statusCode, 200);
  assert.equal(rn.json().sub.status, 'active');
  assert.deepEqual([rn.json().sub.amount, rn.json().sub.days, rn.json().sub.lastFour, rn.json().offered, rn.json().paused], [OFFER.monthly.price, 30, '1111', true, false]);
  assert.ok(!rn.body.includes('token_') && !rn.body.includes('cancel'), 'neither the token nor the cancel link\'s secret');
  assert.equal((await get('/api/pro/renew', null)).statusCode, 401);
  assert.equal((await get('/api/pro/renew', other.token)).json().sub, null);
  // The export: that a card is saved and which, not the token.
  const exp = (await get('/api/account/export', fan.token)).json();
  assert.equal(exp.pro.autoRenew.cardSaved, true);
  assert.deepEqual([exp.pro.autoRenew.status, exp.pro.autoRenew.lastFour, exp.pro.autoRenew.brand, exp.pro.autoRenew.amount, exp.pro.autoRenew.everyDays], ['active', '1111', 'visa', OFFER.monthly.price, 30]);
  assert.ok(exp.pro.autoRenew.agreedAt && exp.pro.autoRenew.nextRenewalAt);
  assert.equal(exp.pro.orders[0].askedToRenew, true);
  assert.ok(!JSON.stringify(exp).includes('token_'), 'the token itself is not exported');
  assert.equal((await get('/api/account/export', other.token)).json().pro.autoRenew, null);
  // /admin: the list, closed to everyone else.
  for (const headers of [undefined, bearer(fan.token)]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/pro/subscriptions', ...(headers ? { headers } : {}) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/pro/subscription/cancel', ...(headers ? { headers } : {}), payload: { id: randomUUID() } })).statusCode, 403);
  }
  const subs = (await app.inject({ method: 'GET', url: '/api/admin/pro/subscriptions', headers: asBoss })).json();
  assert.equal(subs.on, true);
  assert.equal(subs.subscriptions.length, 1);
  assert.deepEqual([subs.subscriptions[0].username, subs.subscriptions[0].status, subs.subscriptions[0].lastFour], ['route_fan', 'active', '1111']);
  assert.ok(!JSON.stringify(subs).includes('token_'), 'not even the admin sees the token');
  const st = (await app.inject({ method: 'GET', url: '/api/admin/pro/orders', headers: asBoss })).json();
  assert.deepEqual([st.status.checkout, st.status.autoRenew, st.status.autoRenewMada, st.orders[0].kind, st.orders[0].keep], ['form', true, true, 'form', true]);
  assert.ok(!JSON.stringify(st).match(/sk_live|pk_live/), 'no key in the admin\'s view');

  // The email's link: a POST from the page, never the GET itself.
  const link = /\/pro\?stop=([A-Za-z0-9_-]+)/.exec(receipt.html)![1];
  assert.equal((await get(`/api/pro/renew/stop?t=${link}`, null)).statusCode, 404, 'a mail scanner following links cancels nothing');
  assert.equal((await payRepo.subFor(fan.id))!.status, 'active');
  assert.equal((await post('/api/pro/renew/stop', null, { t: 'x'.repeat(40) })).statusCode, 404);
  const stopped = await post('/api/pro/renew/stop', null, { t: link });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().endsAt, (await proOf(fan.token)).pass.endsAt, 'Pro stays on until the paid days end');
  assert.equal((await payRepo.subFor(fan.id))!.status, 'cancelled');
  assert.equal(moyasar.tokens.has(p.token!), false, 'the token is deleted at Moyasar');
  assert.equal((await proOf(fan.token)).plan, 'monthly');
  assert.ok(outbox.sent.some((m) => /auto-renew is off/i.test(m.subject) && m.to === 'route_fan@example.test'), 'and confirmed by email');
  assert.equal((await get('/api/account/export', fan.token)).json().pro.autoRenew.cardSaved, false);

  // The account page's button, on a second account; then deleting the account deletes the card.
  const c2 = (await post('/api/pro/pay/checkout', other.token, { lang: 'ar' })).json() as { order: string; form: FormConfig };
  await post('/api/pro/pay/keep', other.token, { order: c2.order, keep: true });
  const p2 = moyasar.formPay(c2.form, c2.order, { save: true });
  await get(`/api/pro/pay/order/${c2.order}`, other.token);
  assert.equal((await payRepo.subFor(other.id))!.status, 'active');
  assert.equal((await post('/api/pro/renew/cancel', null)).statusCode, 401);
  const off = await post('/api/pro/renew/cancel', other.token);
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().sub.status, 'cancelled');
  assert.equal(moyasar.tokens.has(p2.token!), false);
  // Turned off while the feature itself is switched off: still works.
  const third = await reg(app, 'route_third');
  await auth.markEmailVerified(third.id);
  const c3 = (await post('/api/pro/pay/checkout', third.token, { lang: 'en' })).json() as { order: string; form: FormConfig };
  await post('/api/pro/pay/keep', third.token, { order: c3.order, keep: true });
  const p3 = moyasar.formPay(c3.form, c3.order, { save: true });
  await get(`/api/pro/pay/order/${c3.order}`, third.token);
  assert.equal((await payRepo.subFor(third.id))!.status, 'active');
  {
    const paused = setEnv({ PRO_AUTORENEW: undefined });
    const view = (await get('/api/pro/renew', third.token)).json();
    assert.deepEqual([view.offered, view.paused, view.sub.status], [false, true, 'active'], 'switched off: the account is told nothing will be charged');
    paused();
  }
  // Deleting the account: the card is deleted at Moyasar before the account goes.
  const del = await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(third.token), payload: { password: 'quartz-lantern-echo7' } });
  assert.equal(del.statusCode, 204, del.body);
  assert.equal(moyasar.tokens.has(p3.token!), false, 'deleting the account deletes its token');
  assert.equal(await payRepo.subFor(third.id), null);
  on();
  console.log('payments2.test: routes checked');
}
restore();

// ------------------------------------------------- 8. Postgres: the locks ---
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  try {
    const repo: PaymentRepository = new PgPaymentRepository(pool);
    const proRepo = new PgProRepository(pool);
    const mkUser = async (): Promise<string> => String((await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [`pay2_${randomUUID().slice(0, 18)}`])).rows[0].id);
    const userId = await mkUser();
    const now = new Date();
    const token = `token_${randomUUID().replace(/-/g, '')}`;

    // A form order: the payment id is there from the start, unique, found by it.
    const given = randomUUID();
    const o = await repo.create({ userId, amount: 1900, days: 30, lang: 'en', testMode: true, now, kind: 'form', paymentId: given });
    assert.deepEqual([o.kind, o.paymentId, o.keep, o.attemptedAt], ['form', given, false, null]);
    assert.equal((await repo.byPayment(given.toUpperCase()))!.id, o.id);
    await assert.rejects(repo.create({ userId, amount: 1900, days: 30, lang: 'en', testMode: true, now, kind: 'form', paymentId: given }), 'a payment id belongs to one order');
    assert.equal(await repo.setKeep(o.id, await mkUser(), true, now), false, 'not someone else');
    assert.equal(await repo.setKeep(o.id, userId, true, now), true);
    assert.equal((await repo.get(o.id))!.keepAt, now.toISOString());
    assert.equal(await repo.markAttempted(o.id, userId, now), true);
    const w = { paymentId: given, method: 'creditcard', now, startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY) };
    const all = await Promise.all(Array.from({ length: 10 }, () => repo.markPaid(o.id, w)));
    assert.equal(all.filter((x) => x.ok && x.first).length, 1, 'one grant from ten at once');
    assert.equal(await repo.setKeep(o.id, userId, false, now), false, 'not after it is paid');
    await assert.rejects(pool.query(`UPDATE pro_orders SET kind = 'gift' WHERE id = $1`, [o.id]));
    assert.equal(await repo.settle(o.id, 'failed', 'x', 'auth'), false, 'a paid order is not failed');

    // A subscription: chargeable only with a token, never with one once it stops.
    const due = new Date(now.getTime() - HOUR);
    const sub = await repo.saveSub({ userId, token, method: 'creditcard', brand: 'visa', lastFour: '1111', expMonth: 12, expYear: 2030, amount: 1900, days: 30, lang: 'en', testMode: true, optedInAt: now, nextChargeAt: due, now });
    assert.deepEqual([sub.status, sub.cycle, sub.token, sub.attempts], ['active', 1, token, 0]);
    assert.equal((await repo.subByCancelToken(sub.cancelToken))!.id, sub.id);
    await assert.rejects(pool.query(`UPDATE pro_subscriptions SET token = NULL WHERE id = $1`, [sub.id]), 'a renewing subscription always has a card');
    await assert.rejects(pool.query(`UPDATE pro_subscriptions SET token = '4111111111111111' WHERE id = $1`, [sub.id]), 'and only ever a token, never a card number');
    await assert.rejects(pool.query(`UPDATE pro_subscriptions SET last_four = '41111111' WHERE id = $1`, [sub.id]));
    await assert.rejects(pool.query(`UPDATE pro_subscriptions SET status = 'cancelled' WHERE id = $1`, [sub.id]), 'stopped with a card still attached is refused');
    await assert.rejects(pool.query(`INSERT INTO pro_token_trash (token) VALUES ('4111111111111111')`));

    // No reminder yet: nothing to charge, even past the date.
    assert.equal(await repo.claimCharge(sub.id, now, randomUUID()), null, 'not without the reminder');
    // The reminder: one from twenty at once.
    const claims = await Promise.all(Array.from({ length: 20 }, () => repo.claimReminder(sub.id, due, now)));
    assert.equal(claims.filter(Boolean).length, 1, 'ONE reminder from twenty at once');
    // The charge: twenty jobs at once get one order between them.
    const got = await Promise.all(Array.from({ length: 20 }, () => repo.claimCharge(sub.id, now, randomUUID())));
    assert.ok(got.every((x) => x !== null));
    assert.equal(new Set(got.map((x) => x!.order.id)).size, 1, 'ONE renewal order from twenty claims at once');
    assert.equal(new Set(got.map((x) => x!.order.paymentId)).size, 1, 'and so one payment id');
    assert.equal(got.filter((x) => !x!.resumed).length, 1, 'made once; the rest found it');
    const order = got[0]!.order;
    assert.deepEqual([order.kind, order.subscriptionId, order.cycle, order.status, order.amount], ['renewal', sub.id, 1, 'pending', 1900]);
    assert.equal((await repo.cycleOrder(sub.id, 1))!.id, order.id);
    // The index stands behind the lock: a second live order for the cycle cannot be written at all.
    await assert.rejects(
      pool.query(`INSERT INTO pro_orders (user_id, amount, days, lang, test_mode, kind, payment_id, subscription_id, cycle) VALUES ($1, 1900, 30, 'en', true, 'renewal', $2, $3, 1)`, [userId, randomUUID(), sub.id]),
      /pro_orders_cycle_idx/,
      'one live renewal order per subscription and cycle, by the database itself',
    );
    // A failed try does not block the next one.
    assert.equal(await repo.settle(order.id, 'failed', 'declined', 'funds'), true);
    assert.equal(await repo.cycleOrder(sub.id, 1), null);
    assert.equal(await repo.patchSub(sub.id, { status: 'failing', attempts: 1, lastError: 'funds', nextChargeAt: due }, now), true);
    const retry = await repo.claimCharge(sub.id, now, randomUUID());
    assert.ok(retry && !retry.resumed && retry.order.id !== order.id);
    // Paid, ten times at once: one pass; then the cycle moves on.
    const paid = await Promise.all(Array.from({ length: 10 }, () => repo.markPaid(retry!.order.id, { ...w, paymentId: retry!.order.paymentId! })));
    assert.equal(paid.filter((x) => x.ok && x.first).length, 1);
    assert.equal((await proRepo.allPasses(userId)).filter((p) => p.source === 'payment').length, 2, 'one pass per paid order');
    assert.equal(await repo.patchSub(sub.id, { status: 'active', cycle: 2, attempts: 0, lastError: null, clearReminder: true, nextChargeAt: new Date(now.getTime() + 30 * DAY) }, now), true);
    const moved = (await repo.subById(sub.id))!;
    assert.deepEqual([moved.cycle, moved.status, moved.remindedFor, moved.lastError], [2, 'active', null, null]);
    assert.equal(await repo.claimCharge(sub.id, now, randomUUID()), null, 'not due again yet');
    assert.deepEqual((await repo.subsDue(new Date(now.getTime() + 31 * DAY), 10)).map((x) => x.id).includes(sub.id), true);
    assert.equal((await repo.subsDue(now, 10)).some((x) => x.id === sub.id), false);

    // Cancelled from five places at once: off once, and the token is in the trash in the same step.
    const ends = await Promise.all(Array.from({ length: 5 }, () => repo.endSub(sub.id, 'cancelled', 'test', now)));
    assert.equal(ends.filter(Boolean).length, 1);
    const off = (await repo.subById(sub.id))!;
    assert.deepEqual([off.status, off.token, off.nextChargeAt], ['cancelled', null, null]);
    assert.ok((await repo.trashed(1000)).includes(token), 'the token waits to be deleted at Moyasar');
    await repo.untrash(token);
    assert.equal(await repo.claimCharge(sub.id, new Date(now.getTime() + 60 * DAY), randomUUID()), null, 'a cancelled subscription is never claimed');
    assert.equal(await repo.claimReminder(sub.id, due, now), false);
    assert.equal(await repo.patchSub(sub.id, { status: 'active' }, now), false, 'and cannot be patched back on');

    // Started again: a new token, a new cancel link, and the old token in the trash.
    const t2 = `token_${randomUUID().replace(/-/g, '')}`;
    const t3 = `token_${randomUUID().replace(/-/g, '')}`;
    const s2 = await repo.saveSub({ userId, token: t2, method: 'creditcard', brand: 'visa', lastFour: '2222', expMonth: 1, expYear: 2031, amount: 1900, days: 30, lang: 'ar', testMode: true, optedInAt: now, nextChargeAt: due, now });
    assert.equal(s2.id, sub.id, 'one row per account');
    assert.notEqual(s2.cancelToken, sub.cancelToken);
    assert.equal(s2.cycle, 2, 'the cycle count carries on: an old order never stands in for a new one');
    await repo.saveSub({ userId, token: t3, method: 'creditcard', brand: 'visa', lastFour: '3333', expMonth: 1, expYear: 2031, amount: 1900, days: 30, lang: 'ar', testMode: true, optedInAt: now, nextChargeAt: due, now });
    assert.ok((await repo.trashed(1000)).includes(t2), 'a replaced token goes to the trash');
    await repo.untrash(t2);

    // The account is deleted: the token to the trash, the subscription gone, the orders kept without an owner.
    await repo.dropSubFor(userId, now);
    assert.equal(await repo.subFor(userId), null);
    assert.ok((await repo.trashed(1000)).includes(t3));
    await repo.untrash(t3);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const kept = (await repo.get(retry!.order.id))!;
    assert.deepEqual([kept.userId, kept.status, kept.subscriptionId, kept.kind], [null, 'paid', null, 'renewal'], 'the record of the sale stays');
    // And if the account row goes without the code (a cascade), the subscription goes with it.
    const u2 = await mkUser();
    await repo.saveSub({ userId: u2, token: `token_${randomUUID().replace(/-/g, '')}`, method: 'creditcard', brand: null, lastFour: null, expMonth: null, expYear: null, amount: 1900, days: 30, lang: 'en', testMode: true, optedInAt: now, nextChargeAt: due, now });
    await pool.query('DELETE FROM users WHERE id = $1', [u2]);
    assert.equal(await repo.subFor(u2), null);
    await pool.query(`DELETE FROM pro_orders WHERE user_id IS NULL AND test_mode AND created_at >= $1`, [new Date(now.getTime() - 1000)]);

    // The whole job on Postgres, from five servers at once: one reminder, one charge, one pass.
    {
      let clock = new Date();
      const u3 = await mkUser();
      const fake = new FakeMoyasar();
      const pro = new ProService(proRepo, { now: () => clock, savedDesigns: async () => 1, env: RENEW_ENV });
      const sent: RenewNotice[] = [];
      const mk = () => new PaymentService(repo, pro, fake, { env: RENEW_ENV, base: 'https://tifomaker.test', notify: async (n) => { sent.push(n); return true; } });
      const five = Array.from({ length: 5 }, mk);
      const buyer = { id: u3, username: 'pg_renewer', email: 'pg@example.test', emailVerified: true };
      const c = await five[0].checkout(buyer, 'en', 'https://tifomaker.test');
      assert.ok(c.ok && 'form' in c, JSON.stringify(c));
      assert.equal(await five[0].setKeep(u3, c.orderId, true), true);
      fake.formPay(c.form, c.orderId, { save: true });
      await Promise.all(five.map((s) => s.orderFor(u3, c.orderId)));
      const mine = (await repo.subFor(u3))!;
      assert.equal(mine.status, 'active');
      assert.equal((await proRepo.allPasses(u3)).filter((p) => p.source === 'payment').length, 1, 'one pass for the purchase, from five returns at once');
      const end = Date.parse(mine.nextChargeAt!);
      clock = new Date(end - REMIND_DAYS * DAY - HOUR);
      await Promise.all(five.map((s) => s.runRenewals()));
      assert.equal(sent.filter((n) => n.kind === 'reminder' && n.sub.userId === u3).length, 1, 'ONE reminder from five servers');
      clock = new Date(end + 60_000);
      await Promise.all(five.map((s) => s.runRenewals()));
      await Promise.all(five.map((s) => s.runRenewals()));
      assert.equal(fake.charges.length, 1, 'ONE charge from five servers running the job at once, twice');
      assert.equal((await proRepo.allPasses(u3)).filter((p) => p.source === 'payment').length, 2, 'one pass per paid order');
      const mineOrders = (await repo.recentFor(u3, new Date(0))).filter((x) => x.kind === 'renewal');
      assert.deepEqual(mineOrders.map((x) => x.status), ['paid'], 'one renewal order');
      const after = (await repo.subFor(u3))!;
      assert.deepEqual([after.cycle, after.status, after.attempts], [2, 'active', 0]);
      assert.equal(Date.parse(after.nextChargeAt!) - end, 30 * DAY, 'the next renewal is thirty days on, to the second');
      // A decline seen by five servers: one failed try counted, one email.
      fake.mode = 'decline';
      clock = new Date(end + 27 * DAY);
      await Promise.all(five.map((s) => s.runRenewals()));
      clock = new Date(end + 30 * DAY + 60_000);
      await Promise.all(five.map((s) => s.runRenewals()));
      assert.equal(fake.charges.length, 2);
      assert.equal((await repo.subFor(u3))!.attempts, 1, 'counted once');
      assert.equal(sent.filter((n) => n.kind === 'failed' && n.sub.userId === u3).length, 1, 'emailed once');
      // Cancel and delete: the token is gone at Moyasar, and nothing more is charged.
      await five[2].forgetAccount(u3);
      assert.equal(fake.tokens.size, 0);
      await pool.query('DELETE FROM users WHERE id = $1', [u3]);
      clock = new Date(end + 90 * DAY);
      await Promise.all(five.map((s) => s.runRenewals()));
      assert.equal(fake.charges.length, 2);
      await pool.query(`DELETE FROM pro_orders WHERE user_id IS NULL AND created_at >= $1`, [new Date(now.getTime() - 1000)]);
    }
    console.log('payments2.test: postgres locks checked');
  } finally {
    await pool.end();
  }
} else {
  console.log('payments2.test: DATABASE_URL not set; Postgres lock checks skipped');
}

console.log('payments2.test: all checks passed');
