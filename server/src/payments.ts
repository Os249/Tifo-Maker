/**
 * Buying Pro (payments v1, 12 Nov 2026): a month of Pro for one payment on
 * Moyasar's hosted page, no renewal, refunds by hand within 7 days.
 *
 * OFF until Osamh turns it on. Three switches, all on the server:
 *
 *   PRO_PAYMENTS=on          the switch. Anything else (unset) is off: no
 *                            price, no buy button, /pro stays the coming-soon
 *                            page, and none of these routes do anything.
 *   MOYASAR_SECRET_KEY       sk_test_... or sk_live_... from Moyasar's
 *                            dashboard. Without one, payments stay off.
 *   MOYASAR_WEBHOOK_SECRET   the secret typed into Moyasar's webhook settings
 *                            (Settings -> Webhooks), so a webhook can be told
 *                            from a stranger's POST. Optional: without it the
 *                            webhook route is closed and a payment is still
 *                            seen through the invoice's own callback and the
 *                            fan's return.
 *
 * Who may buy also follows PRO_MODE: only an account Pro is on for. And a
 * TEST key only ever sells to the accounts in PRO_PREVIEW_USERS, whatever
 * PRO_MODE says, because Moyasar's test cards are public: on the live site
 * with a test key, anyone else could get Pro with a test card number. So the
 * order of switching on is:
 *
 *   1. PRO_MODE=preview, PRO_PREVIEW_USERS=<you>, PRO_PAYMENTS=on and the test
 *      keys: you buy Pro on tifomaker.org with a test card; nobody else sees
 *      anything.
 *   2. The live keys once Moyasar approves the account: you buy it for real
 *      once and refund yourself from /admin.
 *   3. PRO_MODE=on: everyone.
 *
 * How a payment becomes Pro: "Get Pro" makes an order and a Moyasar invoice
 * (POST /api/pro/pay/checkout) and the page goes to the invoice's URL. When
 * the fan has paid, three things can tell the server, in any order and any
 * number of times: the fan coming back to /pro?order=..., Moyasar's POST to
 * the invoice's callback_url, and Moyasar's webhook. Each one only says "look
 * at this order": reconcile() reads the invoice from Moyasar's API with the
 * secret key and gives the pass if, and only if, Moyasar says it is paid in
 * full, in riyals, for this order's amount. payRepo.markPaid() gives one pass
 * per order however many times that happens.
 */
import { timingSafeEqual } from 'node:crypto';
import { MoyasarError, isMoyasarId, type MoyasarApi, type MoyasarInvoice } from './moyasar';
import type { PaymentRepository, ProOrder } from './payRepo';
import { OFFER, liveFor, previewUsers, proMode } from './proPlan';
import type { ProService } from './pro';

// ------------------------------------------------------------- switches ---

export type KeyKind = 'live' | 'test';

/** The key's kind from its prefix, or null when there is none (or it is not a secret key). */
export function moyasarKeyKind(env: NodeJS.ProcessEnv = process.env): KeyKind | null {
  const k = (env.MOYASAR_SECRET_KEY ?? '').trim();
  if (/^sk_live_[A-Za-z0-9]{8,}$/.test(k)) return 'live';
  if (/^sk_test_[A-Za-z0-9]{8,}$/.test(k)) return 'test';
  return null;
}

/** PRO_PAYMENTS=on and a secret key: payments can run at all. */
export function paymentsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PRO_PAYMENTS ?? '').trim().toLowerCase() === 'on' && moyasarKeyKind(env) !== null;
}

/**
 * Whether this account sees a price and a buy button: payments on, Pro on for
 * the account, and with a test key only the preview's own accounts.
 */
export function paymentsOpenFor(username: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!paymentsOn(env) || !username || !liveFor(username, env)) return false;
  if (moyasarKeyKind(env) === 'test') return previewUsers(env).has(username.toLowerCase());
  return true;
}

/**
 * Pro is on sale to everyone, for real: live key, PRO_MODE=on. The signed-out
 * /pro shows the price, and the legal page shows the payment terms.
 */
export function paymentsPublic(env: NodeJS.ProcessEnv = process.env): boolean {
  return paymentsOn(env) && moyasarKeyKind(env) === 'live' && proMode(env) === 'on';
}

/** The webhook's shared secret, when one is set (at least 16 characters, or it is not used). */
function webhookSecret(env: NodeJS.ProcessEnv): string | null {
  const s = (env.MOYASAR_WEBHOOK_SECRET ?? '').trim();
  return s.length >= 16 ? s : null;
}

/** What /admin shows about the switches. Never a key. */
export function paymentsStatus(env: NodeJS.ProcessEnv = process.env) {
  return {
    switch: (env.PRO_PAYMENTS ?? '').trim().toLowerCase() === 'on',
    key: moyasarKeyKind(env),
    keySet: !!(env.MOYASAR_SECRET_KEY ?? '').trim(),
    webhook: !!webhookSecret(env),
    on: paymentsOn(env),
    public: paymentsPublic(env),
  };
}

// ---------------------------------------------------------------- rules ---

/** One month of Pro, in halalas. */
export const priceHalalas = (): number => Math.round(OFFER.monthly.price * 100);

/** Within this long of a pass's end, another month can be bought (it starts when the first ends). */
export const RENEW_WITHIN_DAYS = 7;
/** A refund is given within this long of paying (the terms say so). */
export const REFUND_DAYS = 7;
/** How long Moyasar's page takes payment. */
const INVOICE_MINUTES = 60;
/** An open order is sent back to its own page for this long, rather than making another invoice. */
const REUSE_MINUTES = 45;
/** "Get Pro" presses one account may make in a day. */
const ORDERS_PER_DAY = 10;

const DAY_MS = 24 * 3600_000;

export interface Buyer {
  id: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
}

export type CheckoutResult =
  | { ok: true; orderId: string; url: string }
  | { ok: false; reason: 'off' | 'verify' | 'held' | 'busy' | 'unavailable'; endsAt?: string };

export type RefundResult =
  | { ok: true; order: ProOrder }
  | { ok: false; reason: 'none' | 'not_paid' | 'late' | 'no_payment' | 'failed' | 'off' };

export interface PaymentServiceOptions {
  env?: NodeJS.ProcessEnv;
  /** Told once, when an order is first paid (the receipt). Failures are logged, never thrown. */
  onPaid?: (order: ProOrder, endsAt: string | null) => Promise<void>;
}

export class PaymentService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly repo: PaymentRepository,
    readonly pro: ProService,
    /** Null when there is no key: every route then answers as if payments were off. */
    private readonly api: MoyasarApi | null,
    private readonly opts: PaymentServiceOptions = {},
  ) {
    this.env = opts.env ?? process.env;
  }

  on(): boolean {
    return !!this.api && paymentsOn(this.env);
  }

  openFor(username: string | null | undefined): boolean {
    return !!this.api && paymentsOpenFor(username, this.env);
  }

  testMode(): boolean {
    return moyasarKeyKind(this.env) !== 'live';
  }

  /**
   * When a new month would start for this account, or null when it already
   * holds Pro for longer than RENEW_WITHIN_DAYS: a bought month starts when
   * the Pro it holds (paid or given by hand) ends, so nothing is lost by
   * buying early. A running gift does not push it back: the paid month starts
   * now, and the gift's days run beside it.
   */
  async startFor(userId: string, now: Date): Promise<{ start: Date } | { held: string }> {
    const passes = (await this.pro.repo.activePasses(userId, now)).filter((p) => p.plan === 'monthly');
    if (!passes.length) return { start: now };
    const end = Math.max(...passes.map((p) => Date.parse(p.endsAt)));
    if (end - now.getTime() > RENEW_WITHIN_DAYS * DAY_MS) return { held: new Date(end).toISOString() };
    return { start: new Date(end) };
  }

  /** "Get Pro": an order and a Moyasar invoice, or the open one this account already has. */
  async checkout(b: Buyer, lang: 'en' | 'ar', base: string): Promise<CheckoutResult> {
    if (!this.api || !this.openFor(b.username)) return { ok: false, reason: 'off' };
    // The receipt goes to the email, and a verified one is the account's proof of being a person.
    if (!b.emailVerified || !b.email) return { ok: false, reason: 'verify' };
    const now = this.pro.now();
    const when = await this.startFor(b.id, now);
    if ('held' in when) return { ok: false, reason: 'held', endsAt: when.held };
    const amount = priceHalalas();
    const recent = await this.repo.recentFor(b.id, new Date(now.getTime() - DAY_MS));
    const open = recent.find(
      (o) => o.status === 'pending' && o.invoiceUrl && o.amount === amount && o.testMode === this.testMode() &&
        now.getTime() - Date.parse(o.createdAt) < REUSE_MINUTES * 60_000,
    );
    if (open?.invoiceUrl) return { ok: true, orderId: open.id, url: open.invoiceUrl };
    if (recent.length >= ORDERS_PER_DAY) return { ok: false, reason: 'busy' };

    const order = await this.repo.create({ userId: b.id, amount, days: OFFER.monthly.days, lang, testMode: this.testMode(), now });
    const page = lang === 'ar' ? '/ar/pro' : '/pro';
    try {
      const inv = await this.api.createInvoice({
        amount,
        currency: 'SAR',
        description: lang === 'ar' ? `تيفو ميكر برو: ${OFFER.monthly.days} يوم` : `TifoMaker Pro: ${OFFER.monthly.days} days`,
        callbackUrl: `${base}/api/pro/pay/invoice`,
        successUrl: `${base}${page}?order=${order.id}`,
        backUrl: `${base}${page}`,
        expiresAt: new Date(now.getTime() + INVOICE_MINUTES * 60_000),
        metadata: { order_id: order.id },
      });
      if (inv.amount !== amount || inv.currency !== 'SAR') throw new MoyasarError(0, 'bad_invoice');
      await this.repo.attachInvoice(order.id, inv.id, inv.url);
      return { ok: true, orderId: order.id, url: inv.url };
    } catch (e) {
      await this.repo.settle(order.id, 'failed', `the invoice could not be made: ${(e as Error).message}`.slice(0, 300)).catch(() => {});
      console.error(`[tifo] payments: an invoice could not be made (${(e as Error).message})`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Bring an order in line with what Moyasar says about its invoice. The
   * only place a pass is given for money, and the only input it trusts is
   * Moyasar's API answering this server's own key.
   */
  async reconcile(order: ProOrder): Promise<ProOrder> {
    if (!this.api || !order.invoiceId) return order;
    if (order.status === 'refunded' || order.status === 'review') return order;
    let inv: MoyasarInvoice;
    try {
      inv = await this.api.invoice(order.invoiceId);
    } catch (e) {
      console.error(`[tifo] payments: invoice ${order.invoiceId} could not be read (${(e as Error).message})`);
      return order;
    }
    const now = this.pro.now();
    if (inv.status === 'paid') {
      const paid = inv.payments.find((p) => p.status === 'paid' || p.status === 'captured');
      // Paid, but not what was asked: a person looks before anyone gets anything.
      const wrong =
        inv.amount !== order.amount ? `the invoice is for ${inv.amount} halalas, the order for ${order.amount}` :
        inv.currency !== 'SAR' ? `the invoice is in ${inv.currency}` :
        inv.metadata.order_id && inv.metadata.order_id !== order.id ? 'the invoice names another order' :
        paid && (paid.amount !== order.amount || paid.currency !== 'SAR') ? `the payment is ${paid.amount} ${paid.currency}` :
        null;
      if (wrong) {
        console.error(`[tifo] payments: order ${order.id} needs a look: ${wrong}`);
        await this.repo.settle(order.id, 'review', wrong);
        return (await this.repo.get(order.id)) ?? order;
      }
      if (order.status === 'paid') return order;
      const when = order.userId ? await this.startFor(order.userId, now) : { start: now };
      // Paid is paid: a month bought while holding a long pass starts when that pass ends.
      const start = 'start' in when ? when.start : new Date(when.held);
      const r = await this.repo.markPaid(order.id, {
        paymentId: paid?.id ?? '',
        method: paid?.sourceType ?? null,
        now,
        startsAt: start,
        endsAt: new Date(start.getTime() + order.days * DAY_MS),
      });
      if (!r.ok) return (await this.repo.get(order.id)) ?? order;
      if (r.first) {
        console.log(`[tifo] payments: order ${order.id} paid${order.testMode ? ' (test)' : ''}`);
        await this.opts.onPaid?.(r.order, r.pass?.endsAt ?? null).catch((e) => console.error(`[tifo] payments: the receipt for ${order.id} failed (${(e as Error).message})`));
      }
      return r.order;
    }
    if ((inv.status === 'refunded' || inv.status === 'voided') && order.status === 'paid') {
      // Refunded in Moyasar's dashboard rather than from /admin: the pass goes with the money.
      const refunded = inv.payments.reduce((s, p) => s + p.refunded, 0) || order.amount;
      await this.repo.markRefunded(order.id, Math.min(refunded, order.amount), now);
      return (await this.repo.get(order.id)) ?? order;
    }
    if (order.status === 'pending' && ['expired', 'canceled', 'failed', 'voided', 'refunded'].includes(inv.status)) {
      await this.repo.settle(order.id, inv.status === 'expired' || inv.status === 'canceled' ? 'expired' : 'failed', `the invoice is ${inv.status}`);
      return (await this.repo.get(order.id)) ?? order;
    }
    return order;
  }

  /** An order, as its owner asks after it (the return from Moyasar's page). */
  async orderFor(userId: string, orderId: string): Promise<ProOrder | null> {
    const o = await this.repo.get(orderId);
    if (!o || o.userId !== userId) return null;
    return o.status === 'pending' ? this.reconcile(o) : o;
  }

  /** Moyasar's POST to the invoice's callback_url: the invoice, untrusted. Only its id is used. */
  async invoiceNudge(body: unknown): Promise<void> {
    if (!this.on()) return;
    const id = (body && typeof body === 'object' ? (body as Record<string, unknown>).id : null);
    if (!isMoyasarId(id)) return;
    const o = await this.repo.byInvoice(id);
    if (o && o.status === 'pending') await this.reconcile(o);
  }

  /**
   * Moyasar's webhook. 'ignored' for anything that is not ours or not for
   * this key's mode; 'refused' when the secret does not match. Every event
   * that names one of our invoices reconciles that order: a payment, a
   * failure, a refund made in Moyasar's dashboard.
   */
  async webhook(body: unknown): Promise<'done' | 'ignored' | 'refused' | 'closed'> {
    const secret = webhookSecret(this.env);
    if (!this.on() || !secret) return 'closed';
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const given = typeof b.secret_token === 'string' ? b.secret_token : '';
    const x = Buffer.from(given);
    const y = Buffer.from(secret);
    if (x.length !== y.length || !timingSafeEqual(x, y)) return 'refused';
    if (typeof b.live === 'boolean' && b.live !== (moyasarKeyKind(this.env) === 'live')) return 'ignored';
    const data = (b.data && typeof b.data === 'object' ? b.data : {}) as Record<string, unknown>;
    const meta = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;
    let order: ProOrder | null = null;
    if (isMoyasarId(data.invoice_id)) order = await this.repo.byInvoice(data.invoice_id);
    if (!order && isMoyasarId(meta.order_id)) order = await this.repo.get(meta.order_id);
    if (!order) return 'ignored';
    await this.reconcile(order);
    return 'done';
  }

  /**
   * Refund an order in full and end its pass (/admin). Within REFUND_DAYS of
   * paying unless `late` says the owner chose to anyway. Whether Pro was
   * used is shown to the owner beside the button (passUse); the server does
   * not decide that, because "used" is a judgement (a design exported with
   * the Pro mark is a use the counters do not see).
   */
  async refund(orderId: string, late = false): Promise<RefundResult> {
    if (!this.api || !this.on()) return { ok: false, reason: 'off' };
    let o = await this.repo.get(orderId);
    if (!o) return { ok: false, reason: 'none' };
    if (o.status === 'pending') o = await this.reconcile(o);
    if (o.status !== 'paid') return { ok: false, reason: 'not_paid' };
    const now = this.pro.now();
    if (!late && o.paidAt && now.getTime() - Date.parse(o.paidAt) > REFUND_DAYS * DAY_MS) return { ok: false, reason: 'late' };
    if (!isMoyasarId(o.paymentId)) return { ok: false, reason: 'no_payment' };
    try {
      const p = await this.api.refund(o.paymentId);
      if (p.status !== 'refunded') throw new MoyasarError(0, `status_${p.status}`);
      await this.repo.markRefunded(o.id, p.refunded || o.amount, now);
    } catch (e) {
      console.error(`[tifo] payments: refunding order ${o.id} failed (${(e as Error).message})`);
      // Moyasar says to read the payment back before trying again: reconcile does, through the invoice.
      const again = await this.reconcile(o);
      if (again.status !== 'refunded') return { ok: false, reason: 'failed' };
    }
    return { ok: true, order: (await this.repo.get(o.id)) ?? o };
  }
}

/**
 * The legal page's payment terms (legal.html, `data-pay`): the coming-soon
 * paragraph until Pro is on sale to everyone, then the terms in its
 * <template data-pay="sale"> blocks instead. Off, the sale terms are taken out
 * of the page altogether, so nothing about them is served.
 */
export function payLegal(html: string, onSale: boolean): string {
  const sale = /<template data-pay="sale">([\s\S]*?)<\/template>\n?/g;
  const soon = /<p data-pay="soon">[\s\S]*?<\/p>\n?/g;
  return onSale ? html.replace(soon, '').replace(sale, '$1') : html.replace(sale, '');
}
