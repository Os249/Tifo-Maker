/**
 * Where Pro's orders are kept (payments v1, 12 Nov 2026): one row per "Get
 * Pro" press, from the Moyasar invoice it made to the pass it paid for. In
 * memory for development and tests, in Postgres in production (pro_orders,
 * schema.sql).
 *
 * The promises the payment code rests on, kept by both stores:
 *  - markPaid() gives one pass per order, ever. Called twice at once (the
 *    fan's return, Moyasar's callback and its webhook can all arrive in the
 *    same second), one call grants and the others see "already paid". In
 *    Postgres the order row is locked for the length of the grant, and the
 *    pass carries the invoice in pro_passes.payment_id, which is UNIQUE.
 *  - markRefunded() revokes the order's pass in the same step.
 *  - An order outlives its account: deleting the account empties user_id
 *    (and its passes go), and the amount, dates and Moyasar's reference stay
 *    as the record of a sale.
 *
 * Payments v2 (16 Nov 2026) adds two things.
 *
 * Orders paid on Moyasar's payment form (kind 'form') and renewals (kind
 * 'renewal') carry their payment's id from the start: this server chooses it
 * (a UUID) and Moyasar creates the payment under it, so the payment an order
 * waits for is known before any browser says anything.
 *
 * Auto-renew ("Keep Pro on", pro_subscriptions): at most one row per account,
 * holding Moyasar's token for the saved card (never a card number), the
 * card's last four digits and expiry, and when the next renewal is due. More
 * promises, kept by both stores:
 *  - claimCharge() gives at most one live renewal order per subscription and
 *    cycle. Two jobs at once (two instances, a restart mid-run) get the same
 *    order or nothing: in Postgres the subscription row is locked for the
 *    claim and a unique index covers (subscription, cycle) for every order
 *    that is not a failed attempt. The order's payment id is fixed when it is
 *    made, and Moyasar creates one payment per id, so asking twice is still
 *    one charge.
 *  - claimReminder() sends one reminder per renewal date.
 *  - A token that is no longer wanted (cancelled, replaced, the account
 *    deleted) goes into pro_token_trash in the same step that takes it off
 *    the subscription, and stays there until Moyasar has deleted it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PASS_COLS, rowToPass, type MemoryProRepository, type ProPass } from './proRepo';

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'failed' | 'expired' | 'review';
/** How an order is paid: Moyasar's hosted invoice page (v1), its form on /pro, or a renewal on a saved card. */
export type OrderKind = 'invoice' | 'form' | 'renewal';

export interface ProOrder {
  id: string;
  /** Null once the account is deleted. */
  userId: string | null;
  /** Halalas. */
  amount: number;
  currency: 'SAR';
  /** The pass it buys, in days. */
  days: number;
  lang: 'en' | 'ar';
  /** Made with Moyasar's test keys: no real money moved. */
  testMode: boolean;
  status: OrderStatus;
  invoiceId: string | null;
  /** Moyasar's page for this invoice, to send the fan back to while it is open. */
  invoiceUrl: string | null;
  /** The payment that paid the order (a refund goes to it). For 'form' and 'renewal' orders, chosen here when the order is made. */
  paymentId: string | null;
  /** How it was paid: 'applepay', 'creditcard', 'stcpay', ... */
  method: string | null;
  passId: string | null;
  /** Why an order needs a look ('review'), or what happened to it. */
  note: string | null;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  /** Halalas refunded. */
  refunded: number;
  kind: OrderKind;
  /** The fan ticked "Keep Pro on" for this order, and when. Never true unless they did. */
  keep: boolean;
  keepAt: string | null;
  /** The form on /pro sent a payment for this order (the browser's word: only decides whether the order is offered again). */
  attemptedAt: string | null;
  /** A renewal: whose, and which one. */
  subscriptionId: string | null;
  cycle: number | null;
  /** Why it did not go through, as a kind the page has words for (moyasar.ts FailKind). */
  fail: string | null;
  /** The card's scheme as Moyasar names it ('mada', 'visa', 'master'), when it said. Never a number. */
  brand: string | null;
  /** When the refund email was taken to be sent (claimRefundMail): once per order. */
  refundMailAt: string | null;
  /** When the site's one-time refund notice was shown to the fan. */
  refundSeenAt: string | null;
  /** Extra days its pass was given on top of `days`: the founders bonus (proLaunch.ts). 0 for every other order. */
  bonusDays: number;
}

export interface ProOrderRow extends ProOrder {
  username: string | null;
}

// ------------------------------------------------------ refund requests ---

export type RefundRequestStatus = 'pending' | 'approved' | 'declined';

/** A fan's request for the refund the terms promise. At most one per order, ever. */
export interface RefundRequest {
  id: string;
  orderId: string;
  /** Null once the account is deleted. */
  userId: string | null;
  status: RefundRequestStatus;
  /** What the fan wrote with it, if anything. */
  note: string | null;
  /** How much of Pro's allowances the order's pass had used when they asked: 0 is "not used". */
  used: number;
  /** Refunded by the PRO_AUTO_REFUND switch, not by a person. */
  auto: boolean;
  declineReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface RefundRequestRow extends RefundRequest {
  username: string | null;
  order: ProOrder | null;
}

export interface NewOrder {
  userId: string;
  amount: number;
  days: number;
  lang: 'en' | 'ar';
  testMode: boolean;
  now: Date;
  /** Default 'invoice'. */
  kind?: OrderKind;
  /** For 'form' and 'renewal': the id the payment will be created under. */
  paymentId?: string;
}

export interface PaidWith {
  paymentId: string;
  method: string | null;
  /** The card's scheme, when Moyasar said ('mada', 'visa', ...). */
  brand?: string | null;
  now: Date;
  /** The pass to give. Ignored when the account is gone. */
  startsAt: Date;
  endsAt: Date;
  /**
   * The founders bonus this payment is in time for, in days (0 or absent:
   * none). Given only if the order's account is a founder that has never had
   * it: the store takes that claim in the same step that marks the order
   * paid, and then makes the pass that much longer.
   */
  bonusDays?: number;
}

export type PaidResult =
  | { ok: true; first: boolean; order: ProOrder; pass: ProPass | null }
  | { ok: false; reason: 'none' | 'refunded' | 'review' };

// ---------------------------------------------------------- auto-renew ---

/**
 * active     will renew on nextChargeAt
 * failing    a renewal did not go through; trying again on nextChargeAt
 * cancelled  the fan (or the admin, or a refund) turned it off
 * ended      it stopped by itself: the retries ran out, or the card expired
 */
export type SubStatus = 'active' | 'failing' | 'cancelled' | 'ended';

export interface ProSubscription {
  id: string;
  userId: string;
  status: SubStatus;
  /** Moyasar's token for the saved card. Null once it is no longer wanted (it is deleted at Moyasar too). */
  token: string | null;
  /** 'creditcard', 'applepay', 'samsungpay'. */
  method: string | null;
  brand: string | null;
  lastFour: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** Halalas charged at each renewal: the price the fan agreed to. */
  amount: number;
  days: number;
  lang: 'en' | 'ar';
  testMode: boolean;
  /** Which renewal comes next: 1 is the first after the purchase. */
  cycle: number;
  /** When the fan ticked "Keep Pro on". */
  optedInAt: string;
  nextChargeAt: string | null;
  /** The renewal date the last reminder was about, and when it was sent. */
  remindedFor: string | null;
  remindedAt: string | null;
  /** Failed tries at the renewal that is due. */
  attempts: number;
  lastError: string | null;
  /** Opens the one-click cancel link in the emails. Not a session: it can only turn renewal off. */
  cancelToken: string;
  cancelledAt: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface ProSubscriptionRow extends ProSubscription {
  username: string | null;
}

export interface NewSubscription {
  userId: string;
  token: string;
  method: string | null;
  brand: string | null;
  lastFour: string | null;
  expMonth: number | null;
  expYear: number | null;
  amount: number;
  days: number;
  lang: 'en' | 'ar';
  testMode: boolean;
  optedInAt: Date;
  nextChargeAt: Date;
  now: Date;
}

export interface SubPatch {
  status?: 'active' | 'failing';
  nextChargeAt?: Date;
  attempts?: number;
  lastError?: string | null;
  cycle?: number;
  /** True: forget the reminder (the date moved, so the fan is told again). */
  clearReminder?: boolean;
  /**
   * Only if the subscription still stands where the caller saw it: this many
   * failed tries, on this cycle. Two jobs acting on the same news then change
   * it (and email the fan) once between them.
   */
  ifAttempts?: number;
  ifCycle?: number;
}

export interface ChargeClaim {
  order: ProOrder;
  /** The order was already there (an earlier run made it): look at its payment before charging anything. */
  resumed: boolean;
}

export interface PaymentRepository {
  create(o: NewOrder): Promise<ProOrder>;
  /** The invoice made for an order. Only a pending order without one takes it. */
  attachInvoice(orderId: string, invoiceId: string, url: string): Promise<boolean>;
  get(orderId: string): Promise<ProOrder | null>;
  byInvoice(invoiceId: string): Promise<ProOrder | null>;
  /** The order waiting for (or paid by) this payment id. */
  byPayment(paymentId: string): Promise<ProOrder | null>;
  /** An account's orders made since `since`, newest first. */
  recentFor(userId: string, since: Date): Promise<ProOrder[]>;
  /** Pay an order: grant its pass and mark it paid, once (see the file's note). */
  markPaid(orderId: string, w: PaidWith): Promise<PaidResult>;
  /** A pending order that will not be paid (failed, expired), or one that needs a look. `fail` says why, for the page. */
  settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null, fail?: string | null): Promise<boolean>;
  /** A paid order refunded (here or in Moyasar's dashboard): its pass is revoked with it. */
  markRefunded(orderId: string, amount: number, now: Date): Promise<boolean>;
  /** The newest orders, for /admin. */
  list(limit: number): Promise<ProOrderRow[]>;
  stats(): Promise<{ paid: number; refunded: number; pending: number; review: number; revenue: number; test: number }>;

  /** "Keep Pro on" ticked or unticked on a pending order of this account's. */
  setKeep(orderId: string, userId: string, keep: boolean, now: Date): Promise<boolean>;
  /** The form sent a payment for this pending order of this account's. */
  markAttempted(orderId: string, userId: string, now: Date): Promise<boolean>;

  subFor(userId: string): Promise<ProSubscription | null>;
  subById(id: string): Promise<ProSubscription | null>;
  subByCancelToken(token: string): Promise<ProSubscription | null>;
  /** Start (or replace) an account's subscription. A token it replaces goes to the trash in the same step. */
  saveSub(n: NewSubscription): Promise<ProSubscription>;
  /** Subscriptions that renew (active or failing) on or before `before`, soonest first. */
  subsDue(before: Date, limit: number): Promise<ProSubscription[]>;
  /**
   * Take the one reminder for an active subscription's renewal on `forDate`,
   * moving the renewal to that date. False when it was already taken for that
   * date, or the subscription no longer renews.
   */
  claimReminder(id: string, forDate: Date, now: Date): Promise<boolean>;
  /** The reminder could not be sent after all: it is owed again, and the renewal goes back to the date it had. */
  unclaimReminder(id: string, backTo: Date): Promise<void>;
  /**
   * The renewal order for the subscription's current cycle: made now, or the
   * one already there. Null when nothing is due (not active or failing, no
   * token, not yet time, or an active one whose reminder has not gone out).
   */
  claimCharge(id: string, now: Date, paymentId: string): Promise<ChargeClaim | null>;
  /** The live order (not a failed try) for a subscription's cycle, if there is one. */
  cycleOrder(id: string, cycle: number): Promise<ProOrder | null>;
  patchSub(id: string, p: SubPatch, now: Date): Promise<boolean>;
  /**
   * A renewal try failed: its order is settled as failed and the subscription
   * moves to its retry date, in ONE step, and only if the subscription still
   * stands where the caller saw it (ifAttempts, ifCycle). Until that step is
   * done the cycle keeps its live order, so no other job can start another
   * try; after it, the subscription is not due. False: another job got here
   * first.
   */
  failAttempt(id: string, orderId: string, p: { ifAttempts: number; ifCycle: number; attempts: number; lastError: string; nextChargeAt: Date; note: string; fail: string }, now: Date): Promise<boolean>;
  /**
   * Stop renewing: the token comes off the subscription and into the trash in
   * one step. False when it was not renewing any more.
   */
  endSub(id: string, status: 'cancelled' | 'ended', reason: string, now: Date): Promise<boolean>;
  /** The account is being deleted: its token to the trash, its subscription gone. */
  dropSubFor(userId: string, now: Date): Promise<void>;
  listSubs(limit: number): Promise<ProSubscriptionRow[]>;
  /** A token Moyasar must still be asked to delete. */
  trash(token: string, now: Date): Promise<void>;
  trashed(limit: number): Promise<string[]>;
  untrash(token: string): Promise<void>;

  // Refunds, told and asked for (19 Nov 2026).
  /**
   * Take the one refund email for a refunded order. True for exactly one
   * caller, however many notice the refund at once (/admin, the webhook, two
   * servers); false when it was already taken, or the order is not refunded.
   */
  claimRefundMail(orderId: string, now: Date): Promise<boolean>;
  /** The email could not be sent after all: it is owed again. */
  unclaimRefundMail(orderId: string): Promise<void>;
  /** Refunded orders (since `since`) whose email was never taken, oldest first. */
  unmailedRefunds(since: Date, limit: number): Promise<ProOrder[]>;
  /** An account's refunded orders (since `since`) whose notice on the site has not been shown, newest first. */
  unseenRefunds(userId: string, since: Date): Promise<ProOrder[]>;
  /** The notice was shown. True the first time, for the order's own account only. */
  markRefundSeen(userId: string, orderId: string, now: Date): Promise<boolean>;
  /** A refund request for an order. Null when the order already has one: one per order, ever. */
  createRequest(r: { orderId: string; userId: string; note: string | null; used: number; now: Date }): Promise<RefundRequest | null>;
  requestById(id: string): Promise<RefundRequest | null>;
  requestForOrder(orderId: string): Promise<RefundRequest | null>;
  requestsFor(userId: string): Promise<RefundRequest[]>;
  /** The requests for /admin: the open ones first (oldest first), then the newest answered. */
  listRequests(limit: number): Promise<RefundRequestRow[]>;
  /** Answer a request. True for one caller: only a pending request is answered. */
  decideRequest(id: string, status: 'approved' | 'declined', d: { reason: string | null; auto: boolean }, now: Date): Promise<boolean>;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const newCancelToken = (): string => randomBytes(24).toString('base64url');
/** The order states that count as "this cycle has an order": everything but a failed or lapsed try. */
const LIVE: OrderStatus[] = ['pending', 'paid', 'refunded', 'review'];

// ---------------------------------------------------------------- memory ---

export class MemoryPaymentRepository implements PaymentRepository {
  private orders = new Map<string, ProOrder>();
  private subs = new Map<string, ProSubscription>();
  private bin = new Set<string>();
  private requests = new Map<string, RefundRequest>();

  /**
   * Where the founders bonus is claimed (the memory launch store), when there
   * is one: asked while an order is marked paid, with no await in between.
   */
  founders: { claimBonus(userId: string, orderId: string, now: Date): boolean } | null = null;

  /** `pro` is the memory Pro store, where the passes live; `nameOf` names an account for /admin. */
  constructor(private readonly pro: MemoryProRepository, private readonly nameOf: (userId: string) => string | null = () => null) {}

  private copy(o: ProOrder | undefined): ProOrder | null {
    return o ? { ...o } : null;
  }

  async create(o: NewOrder): Promise<ProOrder> {
    const order: ProOrder = {
      id: randomUUID(), userId: o.userId, amount: o.amount, currency: 'SAR', days: o.days, lang: o.lang, testMode: o.testMode,
      status: 'pending', invoiceId: null, invoiceUrl: null, paymentId: o.paymentId ?? null, method: null, passId: null, note: null,
      createdAt: o.now.toISOString(), paidAt: null, refundedAt: null, refunded: 0,
      kind: o.kind ?? 'invoice', keep: false, keepAt: null, attemptedAt: null, subscriptionId: null, cycle: null, fail: null,
      brand: null, refundMailAt: null, refundSeenAt: null, bonusDays: 0,
    };
    if (order.paymentId && [...this.orders.values()].some((x) => x.kind !== 'invoice' && x.paymentId === order.paymentId)) throw new Error('payment id already used');
    this.orders.set(order.id, order);
    return { ...order };
  }

  async attachInvoice(orderId: string, invoiceId: string, url: string): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.invoiceId || o.status !== 'pending') return false;
    if ([...this.orders.values()].some((x) => x.invoiceId === invoiceId)) return false;
    o.invoiceId = invoiceId;
    o.invoiceUrl = url;
    return true;
  }

  async get(orderId: string): Promise<ProOrder | null> {
    return this.copy(this.orders.get(orderId));
  }

  async byInvoice(invoiceId: string): Promise<ProOrder | null> {
    return this.copy([...this.orders.values()].find((o) => o.invoiceId === invoiceId));
  }

  async byPayment(paymentId: string): Promise<ProOrder | null> {
    const id = paymentId.toLowerCase();
    return this.copy([...this.orders.values()].find((o) => o.paymentId?.toLowerCase() === id));
  }

  async recentFor(userId: string, since: Date): Promise<ProOrder[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId && Date.parse(o.createdAt) >= since.getTime())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => ({ ...o }));
  }

  async markPaid(orderId: string, w: PaidWith): Promise<PaidResult> {
    const o = this.orders.get(orderId);
    if (!o) return { ok: false, reason: 'none' };
    if (o.status === 'paid') return { ok: true, first: false, order: { ...o }, pass: null };
    if (o.status === 'refunded') return { ok: false, reason: 'refunded' };
    if (o.status === 'review') return { ok: false, reason: 'review' };
    // Decided before the first await, so a second call in the same tick sees "paid".
    o.status = 'paid';
    o.paidAt = w.now.toISOString();
    o.paymentId = w.paymentId || o.paymentId;
    o.method = w.method;
    o.brand = w.brand ?? null;
    o.fail = null;
    let pass: ProPass | null = null;
    if (o.userId) {
      // Once per account, ever: claimed here, before any await, so a second order of the same founder sees it taken.
      const bonus = w.bonusDays && w.bonusDays > 0 && this.founders?.claimBonus(o.userId, o.id, w.now) ? w.bonusDays : 0;
      o.bonusDays = bonus;
      const endsAt = new Date(w.endsAt.getTime() + bonus * 24 * 3600_000);
      pass = await this.pro.grantPass({ userId: o.userId, plan: 'monthly', startsAt: w.startsAt, endsAt, source: 'payment', createdBy: null });
      o.passId = pass.id;
    } else {
      o.note = 'paid after the account was deleted: no pass given';
    }
    return { ok: true, first: true, order: { ...o }, pass };
  }

  async settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null, fail: string | null = null): Promise<boolean> {
    const o = this.orders.get(orderId);
    // Review can be put on a paid order too (an amount that does not match is found after the fact).
    if (!o || (o.status !== 'pending' && !(status === 'review' && o.status !== 'refunded'))) return false;
    o.status = status;
    o.note = note;
    if (status !== 'review') o.fail = fail;
    return true;
  }

  async markRefunded(orderId: string, amount: number, now: Date): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'paid') return false;
    o.status = 'refunded';
    o.refunded = amount;
    o.refundedAt = now.toISOString();
    if (o.passId) await this.pro.revokePass(o.passId, now);
    return true;
  }

  async list(limit: number): Promise<ProOrderRow[]> {
    return [...this.orders.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((o) => ({ ...o, username: o.userId ? this.nameOf(o.userId) : null }));
  }

  async stats() {
    const all = [...this.orders.values()];
    const real = all.filter((o) => !o.testMode);
    return {
      paid: real.filter((o) => o.status === 'paid').length,
      refunded: real.filter((o) => o.status === 'refunded').length,
      pending: real.filter((o) => o.status === 'pending').length,
      review: all.filter((o) => o.status === 'review').length,
      revenue: real.filter((o) => o.status === 'paid').reduce((s, o) => s + o.amount, 0),
      test: all.length - real.length,
    };
  }

  async setKeep(orderId: string, userId: string, keep: boolean, now: Date): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.userId !== userId || o.status !== 'pending' || o.kind !== 'form') return false;
    o.keep = keep;
    o.keepAt = keep ? now.toISOString() : null;
    return true;
  }

  async markAttempted(orderId: string, userId: string, now: Date): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.userId !== userId || o.status !== 'pending' || o.kind !== 'form') return false;
    o.attemptedAt ??= now.toISOString();
    return true;
  }

  /** An account deleted (the tests' stand-in for ON DELETE): its orders lose their owner. */
  forgetUser(userId: string): void {
    for (const o of this.orders.values()) if (o.userId === userId) o.userId = null;
    for (const r of this.requests.values()) if (r.userId === userId) r.userId = null;
  }

  async subFor(userId: string): Promise<ProSubscription | null> {
    const s = this.subs.get(userId);
    return s ? { ...s } : null;
  }

  private subOf(id: string): ProSubscription | undefined {
    return [...this.subs.values()].find((s) => s.id === id);
  }

  async subById(id: string): Promise<ProSubscription | null> {
    const s = this.subOf(id);
    return s ? { ...s } : null;
  }

  async subByCancelToken(token: string): Promise<ProSubscription | null> {
    const s = [...this.subs.values()].find((x) => x.cancelToken === token);
    return s ? { ...s } : null;
  }

  async saveSub(n: NewSubscription): Promise<ProSubscription> {
    const old = this.subs.get(n.userId);
    if (old?.token && old.token !== n.token) this.bin.add(old.token);
    const s: ProSubscription = {
      id: old?.id ?? randomUUID(), userId: n.userId, status: 'active', token: n.token, method: n.method, brand: n.brand, lastFour: n.lastFour,
      expMonth: n.expMonth, expYear: n.expYear, amount: n.amount, days: n.days, lang: n.lang, testMode: n.testMode, cycle: old?.cycle ?? 1,
      optedInAt: n.optedInAt.toISOString(), nextChargeAt: n.nextChargeAt.toISOString(), remindedFor: null, remindedAt: null,
      attempts: 0, lastError: null, cancelToken: newCancelToken(), cancelledAt: null, endReason: null, createdAt: n.now.toISOString(),
    };
    this.subs.set(n.userId, s);
    return { ...s };
  }

  async subsDue(before: Date, limit: number): Promise<ProSubscription[]> {
    return [...this.subs.values()]
      .filter((s) => (s.status === 'active' || s.status === 'failing') && s.nextChargeAt !== null && Date.parse(s.nextChargeAt) <= before.getTime())
      .sort((a, b) => a.nextChargeAt!.localeCompare(b.nextChargeAt!))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async claimReminder(id: string, forDate: Date, now: Date): Promise<boolean> {
    const s = this.subOf(id);
    if (!s || s.status !== 'active' || !s.token) return false;
    if (s.remindedFor !== null && s.remindedFor === s.nextChargeAt) return false;
    s.nextChargeAt = s.remindedFor = forDate.toISOString();
    s.remindedAt = now.toISOString();
    return true;
  }

  async unclaimReminder(id: string, backTo: Date): Promise<void> {
    const s = this.subOf(id);
    if (!s || (s.status !== 'active' && s.status !== 'failing')) return;
    s.remindedFor = s.remindedAt = null;
    s.nextChargeAt = backTo.toISOString();
  }

  async claimCharge(id: string, now: Date, paymentId: string): Promise<ChargeClaim | null> {
    const s = this.subOf(id);
    if (!s || (s.status !== 'active' && s.status !== 'failing') || !s.token || !s.nextChargeAt) return null;
    if (Date.parse(s.nextChargeAt) > now.getTime()) return null;
    if (s.status === 'active' && s.remindedFor !== s.nextChargeAt) return null;
    const there = [...this.orders.values()].find((o) => o.kind === 'renewal' && o.subscriptionId === s.id && o.cycle === s.cycle && LIVE.includes(o.status));
    if (there) return { order: { ...there }, resumed: true };
    // No await between the look and the insert: a second claim in the same tick finds this order.
    const order: ProOrder = {
      id: randomUUID(), userId: s.userId, amount: s.amount, currency: 'SAR', days: s.days, lang: s.lang, testMode: s.testMode,
      status: 'pending', invoiceId: null, invoiceUrl: null, paymentId, method: null, passId: null, note: null,
      createdAt: now.toISOString(), paidAt: null, refundedAt: null, refunded: 0,
      kind: 'renewal', keep: false, keepAt: null, attemptedAt: null, subscriptionId: s.id, cycle: s.cycle, fail: null,
      brand: null, refundMailAt: null, refundSeenAt: null, bonusDays: 0,
    };
    this.orders.set(order.id, order);
    return { order: { ...order }, resumed: false };
  }

  async cycleOrder(id: string, cycle: number): Promise<ProOrder | null> {
    return this.copy([...this.orders.values()].find((o) => o.kind === 'renewal' && o.subscriptionId === id && o.cycle === cycle && LIVE.includes(o.status)));
  }

  async patchSub(id: string, p: SubPatch, _now: Date): Promise<boolean> {
    const s = this.subOf(id);
    if (!s || (s.status !== 'active' && s.status !== 'failing')) return false;
    if (p.ifAttempts !== undefined && s.attempts !== p.ifAttempts) return false;
    if (p.ifCycle !== undefined && s.cycle !== p.ifCycle) return false;
    if (p.status) s.status = p.status;
    if (p.nextChargeAt) s.nextChargeAt = p.nextChargeAt.toISOString();
    if (p.attempts !== undefined) s.attempts = p.attempts;
    if (p.lastError !== undefined) s.lastError = p.lastError;
    if (p.cycle !== undefined) s.cycle = p.cycle;
    if (p.clearReminder) s.remindedFor = s.remindedAt = null;
    return true;
  }

  async failAttempt(id: string, orderId: string, p: { ifAttempts: number; ifCycle: number; attempts: number; lastError: string; nextChargeAt: Date; note: string; fail: string }, _now: Date): Promise<boolean> {
    const s = this.subOf(id);
    if (!s || (s.status !== 'active' && s.status !== 'failing') || s.attempts !== p.ifAttempts || s.cycle !== p.ifCycle) return false;
    // No await in here: the order and the subscription change together.
    const o = this.orders.get(orderId);
    if (o && o.status === 'pending') {
      o.status = 'failed';
      o.note = p.note;
      o.fail = p.fail;
    }
    s.status = 'failing';
    s.attempts = p.attempts;
    s.lastError = p.lastError;
    s.nextChargeAt = p.nextChargeAt.toISOString();
    return true;
  }

  async endSub(id: string, status: 'cancelled' | 'ended', reason: string, now: Date): Promise<boolean> {
    const s = this.subOf(id);
    if (!s || (s.status !== 'active' && s.status !== 'failing')) return false;
    if (s.token) this.bin.add(s.token);
    s.token = null;
    s.status = status;
    s.nextChargeAt = null;
    s.cancelledAt = now.toISOString();
    s.endReason = reason.slice(0, 60);
    return true;
  }

  async dropSubFor(userId: string, _now: Date): Promise<void> {
    const s = this.subs.get(userId);
    if (!s) return;
    if (s.token) this.bin.add(s.token);
    this.subs.delete(userId);
    for (const o of this.orders.values()) if (o.subscriptionId === s.id) o.subscriptionId = null;
  }

  async listSubs(limit: number): Promise<ProSubscriptionRow[]> {
    return [...this.subs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((s) => ({ ...s, username: this.nameOf(s.userId) }));
  }

  async trash(token: string, _now: Date): Promise<void> {
    this.bin.add(token);
  }

  async trashed(limit: number): Promise<string[]> {
    return [...this.bin].slice(0, limit);
  }

  async untrash(token: string): Promise<void> {
    this.bin.delete(token);
  }

  async claimRefundMail(orderId: string, now: Date): Promise<boolean> {
    const o = this.orders.get(orderId);
    // Decided with no await before it: a second claim in the same tick sees it taken.
    if (!o || o.status !== 'refunded' || o.refundMailAt) return false;
    o.refundMailAt = now.toISOString();
    return true;
  }

  async unclaimRefundMail(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) o.refundMailAt = null;
  }

  async unmailedRefunds(since: Date, limit: number): Promise<ProOrder[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === 'refunded' && !o.refundMailAt && o.userId !== null && o.refundedAt !== null && Date.parse(o.refundedAt) >= since.getTime())
      .sort((a, b) => a.refundedAt!.localeCompare(b.refundedAt!))
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async unseenRefunds(userId: string, since: Date): Promise<ProOrder[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId && o.status === 'refunded' && !o.refundSeenAt && o.refundedAt !== null && Date.parse(o.refundedAt) >= since.getTime())
      .sort((a, b) => b.refundedAt!.localeCompare(a.refundedAt!))
      .map((o) => ({ ...o }));
  }

  async markRefundSeen(userId: string, orderId: string, now: Date): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.userId !== userId || o.status !== 'refunded' || o.refundSeenAt) return false;
    o.refundSeenAt = now.toISOString();
    return true;
  }

  async createRequest(r: { orderId: string; userId: string; note: string | null; used: number; now: Date }): Promise<RefundRequest | null> {
    if ([...this.requests.values()].some((x) => x.orderId === r.orderId)) return null;
    const rq: RefundRequest = {
      id: randomUUID(), orderId: r.orderId, userId: r.userId, status: 'pending', note: r.note, used: r.used, auto: false,
      declineReason: null, createdAt: r.now.toISOString(), decidedAt: null,
    };
    this.requests.set(rq.id, rq);
    return { ...rq };
  }

  async requestById(id: string): Promise<RefundRequest | null> {
    const r = this.requests.get(id);
    return r ? { ...r } : null;
  }

  async requestForOrder(orderId: string): Promise<RefundRequest | null> {
    const r = [...this.requests.values()].find((x) => x.orderId === orderId);
    return r ? { ...r } : null;
  }

  async requestsFor(userId: string): Promise<RefundRequest[]> {
    return [...this.requests.values()].filter((x) => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => ({ ...x }));
  }

  async listRequests(limit: number): Promise<RefundRequestRow[]> {
    const all = [...this.requests.values()];
    const open = all.filter((x) => x.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const done = all.filter((x) => x.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
    return [...open, ...done].slice(0, limit).map((x) => ({ ...x, username: x.userId ? this.nameOf(x.userId) : null, order: this.copy(this.orders.get(x.orderId)) }));
  }

  async decideRequest(id: string, status: 'approved' | 'declined', d: { reason: string | null; auto: boolean }, now: Date): Promise<boolean> {
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return false;
    r.status = status;
    r.declineReason = status === 'declined' ? (d.reason ?? '').slice(0, 500) : null;
    r.auto = d.auto;
    r.decidedAt = now.toISOString();
    return true;
  }
}

// -------------------------------------------------------------- postgres ---

const ORDER_COLS =
  'o.id, o.user_id, o.amount, o.currency, o.days, o.lang, o.test_mode, o.status, o.invoice_id, o.invoice_url, o.payment_id, ' +
  'o.method, o.pass_id, o.note, o.created_at, o.paid_at, o.refunded_at, o.refunded, ' +
  'o.kind, o.keep, o.keep_at, o.attempted_at, o.subscription_id, o.cycle, o.fail, o.brand, o.refund_mail_at, o.refund_seen_at, o.bonus_days';

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

function rowToOrder(r: Record<string, unknown>): ProOrder {
  return {
    id: String(r.id),
    userId: s(r.user_id),
    amount: Number(r.amount),
    currency: 'SAR',
    days: Number(r.days),
    lang: r.lang === 'ar' ? 'ar' : 'en',
    testMode: r.test_mode === true,
    status: String(r.status) as OrderStatus,
    invoiceId: s(r.invoice_id),
    invoiceUrl: s(r.invoice_url),
    paymentId: s(r.payment_id),
    method: s(r.method),
    passId: s(r.pass_id),
    note: s(r.note),
    createdAt: iso(r.created_at as string)!,
    paidAt: iso(r.paid_at as string | null),
    refundedAt: iso(r.refunded_at as string | null),
    refunded: Number(r.refunded ?? 0),
    kind: r.kind === 'form' || r.kind === 'renewal' ? r.kind : 'invoice',
    keep: r.keep === true,
    keepAt: iso(r.keep_at as string | null),
    attemptedAt: iso(r.attempted_at as string | null),
    subscriptionId: s(r.subscription_id),
    cycle: n(r.cycle),
    fail: s(r.fail),
    brand: s(r.brand),
    refundMailAt: iso(r.refund_mail_at as string | null),
    refundSeenAt: iso(r.refund_seen_at as string | null),
    bonusDays: Number(r.bonus_days ?? 0),
  };
}

/** A request's columns, each under a name of its own so they can sit beside an order's in one row. */
const REQUEST_COLS =
  'r.id AS r_id, r.order_id AS r_order_id, r.user_id AS r_user_id, r.status AS r_status, r.note AS r_note, r.used AS r_used, r.auto AS r_auto, ' +
  'r.decline_reason AS r_decline_reason, r.created_at AS r_created_at, r.decided_at AS r_decided_at';

function rowToRequest(r: Record<string, unknown>): RefundRequest {
  return {
    id: String(r.r_id),
    orderId: String(r.r_order_id),
    userId: s(r.r_user_id),
    status: String(r.r_status) as RefundRequestStatus,
    note: s(r.r_note),
    used: Number(r.r_used ?? 0),
    auto: r.r_auto === true,
    declineReason: s(r.r_decline_reason),
    createdAt: iso(r.r_created_at as string)!,
    decidedAt: iso(r.r_decided_at as string | null),
  };
}

const SUB_COLS =
  's.id, s.user_id, s.status, s.token, s.method, s.brand, s.last_four, s.exp_month, s.exp_year, s.amount, s.days, s.lang, s.test_mode, ' +
  's.cycle, s.opted_in_at, s.next_charge_at, s.reminded_for, s.reminded_at, s.attempts, s.last_error, s.cancel_token, s.cancelled_at, ' +
  's.end_reason, s.created_at';

function rowToSub(r: Record<string, unknown>): ProSubscription {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    status: String(r.status) as SubStatus,
    token: s(r.token),
    method: s(r.method),
    brand: s(r.brand),
    lastFour: s(r.last_four),
    expMonth: n(r.exp_month),
    expYear: n(r.exp_year),
    amount: Number(r.amount),
    days: Number(r.days),
    lang: r.lang === 'ar' ? 'ar' : 'en',
    testMode: r.test_mode === true,
    cycle: Number(r.cycle),
    optedInAt: iso(r.opted_in_at as string)!,
    nextChargeAt: iso(r.next_charge_at as string | null),
    remindedFor: iso(r.reminded_for as string | null),
    remindedAt: iso(r.reminded_at as string | null),
    attempts: Number(r.attempts ?? 0),
    lastError: s(r.last_error),
    cancelToken: String(r.cancel_token),
    cancelledAt: iso(r.cancelled_at as string | null),
    endReason: s(r.end_reason),
    createdAt: iso(r.created_at as string)!,
  };
}

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** One transaction: BEGIN, the work, COMMIT; ROLLBACK on a throw. */
  private async tx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async create(o: NewOrder): Promise<ProOrder> {
    const r = await this.pool.query(
      `INSERT INTO pro_orders AS o (user_id, amount, currency, days, lang, test_mode, created_at, kind, payment_id)
       VALUES ($1, $2, 'SAR', $3, $4, $5, $6, $7, $8) RETURNING ${ORDER_COLS}`,
      [o.userId, o.amount, o.days, o.lang, o.testMode, o.now, o.kind ?? 'invoice', o.paymentId ?? null],
    );
    return rowToOrder(r.rows[0]);
  }

  async attachInvoice(orderId: string, invoiceId: string, url: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_orders SET invoice_id = $2, invoice_url = $3 WHERE id = $1 AND invoice_id IS NULL AND status = 'pending'`,
      [orderId, invoiceId, url],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async get(orderId: string): Promise<ProOrder | null> {
    const r = await this.pool.query(`SELECT ${ORDER_COLS} FROM pro_orders o WHERE o.id = $1`, [orderId]);
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  }

  async byInvoice(invoiceId: string): Promise<ProOrder | null> {
    const r = await this.pool.query(`SELECT ${ORDER_COLS} FROM pro_orders o WHERE o.invoice_id = $1`, [invoiceId]);
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  }

  async byPayment(paymentId: string): Promise<ProOrder | null> {
    const r = await this.pool.query(`SELECT ${ORDER_COLS} FROM pro_orders o WHERE o.payment_id = $1 ORDER BY o.created_at LIMIT 1`, [paymentId.toLowerCase()]);
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  }

  async recentFor(userId: string, since: Date): Promise<ProOrder[]> {
    const r = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM pro_orders o WHERE o.user_id = $1 AND o.created_at >= $2 ORDER BY o.created_at DESC LIMIT 50`,
      [userId, since],
    );
    return r.rows.map(rowToOrder);
  }

  async markPaid(orderId: string, w: PaidWith): Promise<PaidResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT ${ORDER_COLS} FROM pro_orders o WHERE o.id = $1 FOR UPDATE`, [orderId]);
      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'none' };
      }
      const o = rowToOrder(cur.rows[0]);
      if (o.status === 'paid' || o.status === 'refunded' || o.status === 'review') {
        await client.query('ROLLBACK');
        return o.status === 'paid' ? { ok: true, first: false, order: o, pass: null } : { ok: false, reason: o.status };
      }
      let pass: ProPass | null = null;
      let bonus = 0;
      if (o.userId) {
        if (w.bonusDays && w.bonusDays > 0) {
          // The founders bonus, once per account, ever: this UPDATE changes the founder's row only while no order
          // has taken it. A second order of the same founder, paid in the same second, waits on the row and then
          // changes nothing. Inside this transaction, so the claim and the paid order stand or fall together.
          const c = await client.query(
            `UPDATE pro_founders SET bonus_order_id = $2, bonus_at = $3 WHERE user_id = $1 AND bonus_order_id IS NULL`,
            [o.userId, o.id, w.now],
          );
          if ((c.rowCount ?? 0) > 0) bonus = w.bonusDays;
        }
        // The invoice names the pass, and payment_id is UNIQUE: one pass per invoice even past this lock.
        const p = await client.query(
          `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source, payment_id)
           VALUES ($1, 'monthly', $2, $3, 'payment', $4)
           ON CONFLICT (payment_id) DO NOTHING RETURNING ${PASS_COLS}`,
          [o.userId, w.startsAt, new Date(w.endsAt.getTime() + bonus * 24 * 3600_000), `moyasar:${o.invoiceId ?? o.id}`],
        );
        pass = p.rows[0] ? rowToPass(p.rows[0]) : null;
      }
      const u = await client.query(
        `UPDATE pro_orders AS o SET status = 'paid', paid_at = $2, payment_id = COALESCE(NULLIF($3, ''), o.payment_id), method = $4,
           pass_id = COALESCE($5, o.pass_id), fail = NULL, brand = $6, bonus_days = $7,
           note = CASE WHEN o.user_id IS NULL THEN 'paid after the account was deleted: no pass given' ELSE o.note END
         WHERE o.id = $1 RETURNING ${ORDER_COLS}`,
        [orderId, w.now, w.paymentId, w.method, pass?.id ?? null, (w.brand ?? '').slice(0, 32) || null, pass ? bonus : 0],
      );
      await client.query('COMMIT');
      return { ok: true, first: true, order: rowToOrder(u.rows[0]), pass };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null, fail: string | null = null): Promise<boolean> {
    const r = await this.pool.query(
      status === 'review'
        ? `UPDATE pro_orders SET status = 'review', note = $2 WHERE id = $1 AND status <> 'refunded'`
        : `UPDATE pro_orders SET status = $3, note = $2, fail = $4 WHERE id = $1 AND status = 'pending'`,
      status === 'review' ? [orderId, note] : [orderId, note, status, fail],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markRefunded(orderId: string, amount: number, now: Date): Promise<boolean> {
    return this.tx(async (client) => {
      const u = await client.query(
        `UPDATE pro_orders SET status = 'refunded', refunded = $2, refunded_at = $3 WHERE id = $1 AND status = 'paid' RETURNING pass_id`,
        [orderId, amount, now],
      );
      if (!u.rows[0]) return false;
      if (u.rows[0].pass_id) {
        await client.query('UPDATE pro_passes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [u.rows[0].pass_id, now]);
      }
      return true;
    });
  }

  async list(limit: number): Promise<ProOrderRow[]> {
    const r = await this.pool.query(
      `SELECT ${ORDER_COLS}, u.username FROM pro_orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ ...rowToOrder(x), username: x.username ? String(x.username) : null }));
  }

  async stats() {
    const r = await this.pool.query(
      `SELECT count(*) FILTER (WHERE status = 'paid' AND NOT test_mode)::int AS paid,
              count(*) FILTER (WHERE status = 'refunded' AND NOT test_mode)::int AS refunded,
              count(*) FILTER (WHERE status = 'pending' AND NOT test_mode)::int AS pending,
              count(*) FILTER (WHERE status = 'review')::int AS review,
              COALESCE(sum(amount) FILTER (WHERE status = 'paid' AND NOT test_mode), 0)::int AS revenue,
              count(*) FILTER (WHERE test_mode)::int AS test
       FROM pro_orders`,
    );
    const x = r.rows[0] ?? {};
    return {
      paid: Number(x.paid ?? 0), refunded: Number(x.refunded ?? 0), pending: Number(x.pending ?? 0),
      review: Number(x.review ?? 0), revenue: Number(x.revenue ?? 0), test: Number(x.test ?? 0),
    };
  }

  async setKeep(orderId: string, userId: string, keep: boolean, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_orders SET keep = $3, keep_at = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END
       WHERE id = $1 AND user_id = $2 AND status = 'pending' AND kind = 'form'`,
      [orderId, userId, keep, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markAttempted(orderId: string, userId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_orders SET attempted_at = COALESCE(attempted_at, $3) WHERE id = $1 AND user_id = $2 AND status = 'pending' AND kind = 'form'`,
      [orderId, userId, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async subFor(userId: string): Promise<ProSubscription | null> {
    const r = await this.pool.query(`SELECT ${SUB_COLS} FROM pro_subscriptions s WHERE s.user_id = $1`, [userId]);
    return r.rows[0] ? rowToSub(r.rows[0]) : null;
  }

  async subById(id: string): Promise<ProSubscription | null> {
    const r = await this.pool.query(`SELECT ${SUB_COLS} FROM pro_subscriptions s WHERE s.id = $1`, [id]);
    return r.rows[0] ? rowToSub(r.rows[0]) : null;
  }

  async subByCancelToken(token: string): Promise<ProSubscription | null> {
    const r = await this.pool.query(`SELECT ${SUB_COLS} FROM pro_subscriptions s WHERE s.cancel_token = $1`, [token]);
    return r.rows[0] ? rowToSub(r.rows[0]) : null;
  }

  async saveSub(v: NewSubscription): Promise<ProSubscription> {
    return this.tx(async (c) => {
      const old = await c.query('SELECT token FROM pro_subscriptions WHERE user_id = $1 FOR UPDATE', [v.userId]);
      const before = old.rows[0]?.token as string | null | undefined;
      if (before && before !== v.token) await c.query('INSERT INTO pro_token_trash (token, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [before, v.now]);
      const r = await c.query(
        `INSERT INTO pro_subscriptions AS s (user_id, status, token, method, brand, last_four, exp_month, exp_year, amount, days, lang, test_mode,
           cycle, opted_in_at, next_charge_at, cancel_token, created_at, updated_at)
         VALUES ($1, 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $13, $14, $15, $15)
         ON CONFLICT (user_id) DO UPDATE SET status = 'active', token = EXCLUDED.token, method = EXCLUDED.method, brand = EXCLUDED.brand,
           last_four = EXCLUDED.last_four, exp_month = EXCLUDED.exp_month, exp_year = EXCLUDED.exp_year, amount = EXCLUDED.amount,
           days = EXCLUDED.days, lang = EXCLUDED.lang, test_mode = EXCLUDED.test_mode, opted_in_at = EXCLUDED.opted_in_at,
           next_charge_at = EXCLUDED.next_charge_at, reminded_for = NULL, reminded_at = NULL, attempts = 0, last_error = NULL,
           cancel_token = EXCLUDED.cancel_token, cancelled_at = NULL, end_reason = NULL, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING ${SUB_COLS}`,
        [v.userId, v.token, v.method, v.brand, v.lastFour, v.expMonth, v.expYear, v.amount, v.days, v.lang, v.testMode, v.optedInAt, v.nextChargeAt, newCancelToken(), v.now],
      );
      // Started again, the cycle count carries on where it was: an old renewal order never stands in for a new one.
      return rowToSub(r.rows[0]);
    });
  }

  async subsDue(before: Date, limit: number): Promise<ProSubscription[]> {
    const r = await this.pool.query(
      `SELECT ${SUB_COLS} FROM pro_subscriptions s
       WHERE s.status IN ('active', 'failing') AND s.next_charge_at IS NOT NULL AND s.next_charge_at <= $1
       ORDER BY s.next_charge_at LIMIT $2`,
      [before, limit],
    );
    return r.rows.map(rowToSub);
  }

  async claimReminder(id: string, forDate: Date, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_subscriptions SET next_charge_at = $2, reminded_for = $2, reminded_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'active' AND token IS NOT NULL AND (reminded_for IS NULL OR reminded_for <> next_charge_at)`,
      [id, forDate, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async unclaimReminder(id: string, backTo: Date): Promise<void> {
    await this.pool.query(
      `UPDATE pro_subscriptions SET reminded_for = NULL, reminded_at = NULL, next_charge_at = $2 WHERE id = $1 AND status IN ('active', 'failing')`,
      [id, backTo],
    );
  }

  async claimCharge(id: string, now: Date, paymentId: string): Promise<ChargeClaim | null> {
    return this.tx(async (c) => {
      // The subscription's row is held for the whole claim: a second job waits here, then finds the order below.
      const cur = await c.query(`SELECT ${SUB_COLS} FROM pro_subscriptions s WHERE s.id = $1 FOR UPDATE`, [id]);
      if (!cur.rows[0]) return null;
      const sub = rowToSub(cur.rows[0]);
      if ((sub.status !== 'active' && sub.status !== 'failing') || !sub.token || !sub.nextChargeAt) return null;
      if (Date.parse(sub.nextChargeAt) > now.getTime()) return null;
      if (sub.status === 'active' && sub.remindedFor !== sub.nextChargeAt) return null;
      const there = await c.query(
        `SELECT ${ORDER_COLS} FROM pro_orders o
         WHERE o.kind = 'renewal' AND o.subscription_id = $1 AND o.cycle = $2 AND o.status IN ('pending', 'paid', 'refunded', 'review')`,
        [sub.id, sub.cycle],
      );
      if (there.rows[0]) return { order: rowToOrder(there.rows[0]), resumed: true };
      // pro_orders_cycle_idx (unique) stands behind this insert: one live order per subscription and cycle.
      const made = await c.query(
        `INSERT INTO pro_orders AS o (user_id, amount, currency, days, lang, test_mode, created_at, kind, payment_id, subscription_id, cycle)
         VALUES ($1, $2, 'SAR', $3, $4, $5, $6, 'renewal', $7, $8, $9) RETURNING ${ORDER_COLS}`,
        [sub.userId, sub.amount, sub.days, sub.lang, sub.testMode, now, paymentId, sub.id, sub.cycle],
      );
      return { order: rowToOrder(made.rows[0]), resumed: false };
    });
  }

  async cycleOrder(id: string, cycle: number): Promise<ProOrder | null> {
    const r = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM pro_orders o
       WHERE o.kind = 'renewal' AND o.subscription_id = $1 AND o.cycle = $2 AND o.status IN ('pending', 'paid', 'refunded', 'review')`,
      [id, cycle],
    );
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  }

  async patchSub(id: string, p: SubPatch, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_subscriptions SET
         status = COALESCE($2, status),
         next_charge_at = COALESCE($3, next_charge_at),
         attempts = COALESCE($4, attempts),
         last_error = CASE WHEN $5 THEN $6 ELSE last_error END,
         cycle = COALESCE($7, cycle),
         reminded_for = CASE WHEN $8 THEN NULL ELSE reminded_for END,
         reminded_at = CASE WHEN $8 THEN NULL ELSE reminded_at END,
         updated_at = $9
       WHERE id = $1 AND status IN ('active', 'failing')
         AND ($10::int IS NULL OR attempts = $10) AND ($11::int IS NULL OR cycle = $11)`,
      [id, p.status ?? null, p.nextChargeAt ?? null, p.attempts ?? null, p.lastError !== undefined, p.lastError ?? null, p.cycle ?? null, p.clearReminder === true, now,
        p.ifAttempts ?? null, p.ifCycle ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async failAttempt(id: string, orderId: string, p: { ifAttempts: number; ifCycle: number; attempts: number; lastError: string; nextChargeAt: Date; note: string; fail: string }, now: Date): Promise<boolean> {
    return this.tx(async (c) => {
      // The same row lock claimCharge takes: a claim waits for this, then finds the subscription not due.
      const cur = await c.query(`SELECT status, attempts, cycle FROM pro_subscriptions WHERE id = $1 FOR UPDATE`, [id]);
      const row = cur.rows[0];
      if (!row || (row.status !== 'active' && row.status !== 'failing') || Number(row.attempts) !== p.ifAttempts || Number(row.cycle) !== p.ifCycle) return false;
      await c.query(`UPDATE pro_orders SET status = 'failed', note = $2, fail = $3 WHERE id = $1 AND status = 'pending'`, [orderId, p.note.slice(0, 300), p.fail]);
      await c.query(
        `UPDATE pro_subscriptions SET status = 'failing', attempts = $2, last_error = $3, next_charge_at = $4, updated_at = $5 WHERE id = $1`,
        [id, p.attempts, p.lastError.slice(0, 60), p.nextChargeAt, now],
      );
      return true;
    });
  }

  async endSub(id: string, status: 'cancelled' | 'ended', reason: string, now: Date): Promise<boolean> {
    return this.tx(async (c) => {
      const cur = await c.query(`SELECT token FROM pro_subscriptions WHERE id = $1 AND status IN ('active', 'failing') FOR UPDATE`, [id]);
      if (!cur.rows[0]) return false;
      const token = cur.rows[0].token as string | null;
      // Into the trash before it leaves the row: a token is never lost between the two.
      if (token) await c.query('INSERT INTO pro_token_trash (token, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [token, now]);
      await c.query(
        `UPDATE pro_subscriptions SET status = $2, token = NULL, next_charge_at = NULL, cancelled_at = $3, end_reason = $4, updated_at = $3 WHERE id = $1`,
        [id, status, now, reason.slice(0, 60)],
      );
      return true;
    });
  }

  async dropSubFor(userId: string, now: Date): Promise<void> {
    await this.tx(async (c) => {
      const cur = await c.query('SELECT id, token FROM pro_subscriptions WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!cur.rows[0]) return;
      const token = cur.rows[0].token as string | null;
      if (token) await c.query('INSERT INTO pro_token_trash (token, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [token, now]);
      await c.query('DELETE FROM pro_subscriptions WHERE id = $1', [cur.rows[0].id]);
    });
  }

  async listSubs(limit: number): Promise<ProSubscriptionRow[]> {
    const r = await this.pool.query(
      `SELECT ${SUB_COLS}, u.username FROM pro_subscriptions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ ...rowToSub(x), username: x.username ? String(x.username) : null }));
  }

  async trash(token: string, now: Date): Promise<void> {
    await this.pool.query('INSERT INTO pro_token_trash (token, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [token, now]);
  }

  async trashed(limit: number): Promise<string[]> {
    const r = await this.pool.query('SELECT token FROM pro_token_trash ORDER BY created_at LIMIT $1', [limit]);
    return r.rows.map((x) => String(x.token));
  }

  async untrash(token: string): Promise<void> {
    await this.pool.query('DELETE FROM pro_token_trash WHERE token = $1', [token]);
  }

  async claimRefundMail(orderId: string, now: Date): Promise<boolean> {
    // One UPDATE: of any number of callers at once, the row changes for one.
    const r = await this.pool.query(
      `UPDATE pro_orders SET refund_mail_at = $2 WHERE id = $1 AND status = 'refunded' AND refund_mail_at IS NULL`,
      [orderId, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async unclaimRefundMail(orderId: string): Promise<void> {
    await this.pool.query('UPDATE pro_orders SET refund_mail_at = NULL WHERE id = $1', [orderId]);
  }

  async unmailedRefunds(since: Date, limit: number): Promise<ProOrder[]> {
    const r = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM pro_orders o
       WHERE o.status = 'refunded' AND o.refund_mail_at IS NULL AND o.user_id IS NOT NULL AND o.refunded_at >= $1
       ORDER BY o.refunded_at LIMIT $2`,
      [since, limit],
    );
    return r.rows.map(rowToOrder);
  }

  async unseenRefunds(userId: string, since: Date): Promise<ProOrder[]> {
    const r = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM pro_orders o
       WHERE o.user_id = $1 AND o.status = 'refunded' AND o.refund_seen_at IS NULL AND o.refunded_at >= $2
       ORDER BY o.refunded_at DESC LIMIT 10`,
      [userId, since],
    );
    return r.rows.map(rowToOrder);
  }

  async markRefundSeen(userId: string, orderId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_orders SET refund_seen_at = $3 WHERE id = $1 AND user_id = $2 AND status = 'refunded' AND refund_seen_at IS NULL`,
      [orderId, userId, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async createRequest(q: { orderId: string; userId: string; note: string | null; used: number; now: Date }): Promise<RefundRequest | null> {
    // order_id is UNIQUE: of two requests for one order at once, one row is written.
    const r = await this.pool.query(
      `INSERT INTO pro_refund_requests AS r (order_id, user_id, note, used, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) DO NOTHING RETURNING ${REQUEST_COLS}`,
      [q.orderId, q.userId, q.note, q.used, q.now],
    );
    return r.rows[0] ? rowToRequest(r.rows[0]) : null;
  }

  async requestById(id: string): Promise<RefundRequest | null> {
    const r = await this.pool.query(`SELECT ${REQUEST_COLS} FROM pro_refund_requests r WHERE r.id = $1`, [id]);
    return r.rows[0] ? rowToRequest(r.rows[0]) : null;
  }

  async requestForOrder(orderId: string): Promise<RefundRequest | null> {
    const r = await this.pool.query(`SELECT ${REQUEST_COLS} FROM pro_refund_requests r WHERE r.order_id = $1`, [orderId]);
    return r.rows[0] ? rowToRequest(r.rows[0]) : null;
  }

  async requestsFor(userId: string): Promise<RefundRequest[]> {
    const r = await this.pool.query(`SELECT ${REQUEST_COLS} FROM pro_refund_requests r WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [userId]);
    return r.rows.map(rowToRequest);
  }

  async listRequests(limit: number): Promise<RefundRequestRow[]> {
    const r = await this.pool.query(
      `SELECT ${REQUEST_COLS}, u.username, ${ORDER_COLS}
       FROM pro_refund_requests r JOIN pro_orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = r.user_id
       ORDER BY (r.status = 'pending') DESC, CASE WHEN r.status = 'pending' THEN r.created_at END ASC, r.decided_at DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ ...rowToRequest(x), username: x.username ? String(x.username) : null, order: rowToOrder(x) }));
  }

  async decideRequest(id: string, status: 'approved' | 'declined', d: { reason: string | null; auto: boolean }, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pro_refund_requests SET status = $2, decline_reason = $3, auto = $4, decided_at = $5 WHERE id = $1 AND status = 'pending'`,
      [id, status, status === 'declined' ? (d.reason ?? '').slice(0, 500) : null, d.auto, now],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
