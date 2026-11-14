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
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PASS_COLS, rowToPass, type MemoryProRepository, type ProPass } from './proRepo';

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'failed' | 'expired' | 'review';

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
  /** The payment that paid the invoice (a refund goes to it). */
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
}

export interface ProOrderRow extends ProOrder {
  username: string | null;
}

export interface NewOrder {
  userId: string;
  amount: number;
  days: number;
  lang: 'en' | 'ar';
  testMode: boolean;
  now: Date;
}

export interface PaidWith {
  paymentId: string;
  method: string | null;
  now: Date;
  /** The pass to give. Ignored when the account is gone. */
  startsAt: Date;
  endsAt: Date;
}

export type PaidResult =
  | { ok: true; first: boolean; order: ProOrder; pass: ProPass | null }
  | { ok: false; reason: 'none' | 'refunded' | 'review' };

export interface PaymentRepository {
  create(o: NewOrder): Promise<ProOrder>;
  /** The invoice made for an order. Only a pending order without one takes it. */
  attachInvoice(orderId: string, invoiceId: string, url: string): Promise<boolean>;
  get(orderId: string): Promise<ProOrder | null>;
  byInvoice(invoiceId: string): Promise<ProOrder | null>;
  /** An account's orders made since `since`, newest first. */
  recentFor(userId: string, since: Date): Promise<ProOrder[]>;
  /** Pay an order: grant its pass and mark it paid, once (see the file's note). */
  markPaid(orderId: string, w: PaidWith): Promise<PaidResult>;
  /** A pending order that will not be paid (failed, expired), or one that needs a look. */
  settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null): Promise<boolean>;
  /** A paid order refunded (here or in Moyasar's dashboard): its pass is revoked with it. */
  markRefunded(orderId: string, amount: number, now: Date): Promise<boolean>;
  /** The newest orders, for /admin. */
  list(limit: number): Promise<ProOrderRow[]>;
  stats(): Promise<{ paid: number; refunded: number; pending: number; review: number; revenue: number; test: number }>;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

// ---------------------------------------------------------------- memory ---

export class MemoryPaymentRepository implements PaymentRepository {
  private orders = new Map<string, ProOrder>();

  /** `pro` is the memory Pro store, where the passes live; `nameOf` names an account for /admin. */
  constructor(private readonly pro: MemoryProRepository, private readonly nameOf: (userId: string) => string | null = () => null) {}

  private copy(o: ProOrder | undefined): ProOrder | null {
    return o ? { ...o } : null;
  }

  async create(o: NewOrder): Promise<ProOrder> {
    const order: ProOrder = {
      id: randomUUID(), userId: o.userId, amount: o.amount, currency: 'SAR', days: o.days, lang: o.lang, testMode: o.testMode,
      status: 'pending', invoiceId: null, invoiceUrl: null, paymentId: null, method: null, passId: null, note: null,
      createdAt: o.now.toISOString(), paidAt: null, refundedAt: null, refunded: 0,
    };
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
    o.paymentId = w.paymentId;
    o.method = w.method;
    let pass: ProPass | null = null;
    if (o.userId) {
      pass = await this.pro.grantPass({ userId: o.userId, plan: 'monthly', startsAt: w.startsAt, endsAt: w.endsAt, source: 'payment', createdBy: null });
      o.passId = pass.id;
    } else {
      o.note = 'paid after the account was deleted: no pass given';
    }
    return { ok: true, first: true, order: { ...o }, pass };
  }

  async settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null): Promise<boolean> {
    const o = this.orders.get(orderId);
    // Review can be put on a paid order too (an amount that does not match is found after the fact).
    if (!o || (o.status !== 'pending' && !(status === 'review' && o.status !== 'refunded'))) return false;
    o.status = status;
    o.note = note;
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
}

// -------------------------------------------------------------- postgres ---

const ORDER_COLS =
  'o.id, o.user_id, o.amount, o.currency, o.days, o.lang, o.test_mode, o.status, o.invoice_id, o.invoice_url, o.payment_id, ' +
  'o.method, o.pass_id, o.note, o.created_at, o.paid_at, o.refunded_at, o.refunded';

function rowToOrder(r: Record<string, unknown>): ProOrder {
  const s = (v: unknown): string | null => (v == null ? null : String(v));
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
  };
}

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(o: NewOrder): Promise<ProOrder> {
    const r = await this.pool.query(
      `INSERT INTO pro_orders AS o (user_id, amount, currency, days, lang, test_mode, created_at)
       VALUES ($1, $2, 'SAR', $3, $4, $5, $6) RETURNING ${ORDER_COLS}`,
      [o.userId, o.amount, o.days, o.lang, o.testMode, o.now],
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
      if (o.userId) {
        // The invoice names the pass, and payment_id is UNIQUE: one pass per invoice even past this lock.
        const p = await client.query(
          `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source, payment_id)
           VALUES ($1, 'monthly', $2, $3, 'payment', $4)
           ON CONFLICT (payment_id) DO NOTHING RETURNING ${PASS_COLS}`,
          [o.userId, w.startsAt, w.endsAt, `moyasar:${o.invoiceId ?? o.id}`],
        );
        pass = p.rows[0] ? rowToPass(p.rows[0]) : null;
      }
      const u = await client.query(
        `UPDATE pro_orders AS o SET status = 'paid', paid_at = $2, payment_id = $3, method = $4, pass_id = COALESCE($5, o.pass_id),
           note = CASE WHEN o.user_id IS NULL THEN 'paid after the account was deleted: no pass given' ELSE o.note END
         WHERE o.id = $1 RETURNING ${ORDER_COLS}`,
        [orderId, w.now, w.paymentId, w.method, pass?.id ?? null],
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

  async settle(orderId: string, status: 'failed' | 'expired' | 'review', note: string | null): Promise<boolean> {
    const r = await this.pool.query(
      status === 'review'
        ? `UPDATE pro_orders SET status = 'review', note = $2 WHERE id = $1 AND status <> 'refunded'`
        : `UPDATE pro_orders SET status = $3, note = $2 WHERE id = $1 AND status = 'pending'`,
      status === 'review' ? [orderId, note] : [orderId, note, status],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markRefunded(orderId: string, amount: number, now: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query(
        `UPDATE pro_orders SET status = 'refunded', refunded = $2, refunded_at = $3 WHERE id = $1 AND status = 'paid' RETURNING pass_id`,
        [orderId, amount, now],
      );
      if (!u.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      if (u.rows[0].pass_id) {
        await client.query('UPDATE pro_passes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [u.rows[0].pass_id, now]);
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
}
