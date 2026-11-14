/**
 * Moyasar, the payment provider for Pro (payments v1, 12 Nov 2026).
 *
 * Only what Pro needs: make an invoice, read one back, refund a payment. An
 * invoice is Moyasar's own hosted payment page: the fan pays there (Apple
 * Pay, mada, cards, STC Pay, whatever the account has turned on) and comes
 * back to /pro. No card number, wallet token or payment form ever touches
 * this server or its pages; the server only ever learns "this invoice is
 * paid, for this amount".
 *
 * Nothing a browser or a webhook says is believed about money: the server
 * reads the invoice from Moyasar's API with its own secret key and acts on
 * that (payments.ts reconcile()).
 *
 * The secret key is read from the environment by the caller and kept in this
 * object only; it is never logged, never put in an error and never sent to a
 * browser. Errors carry Moyasar's error type and HTTP status and nothing else.
 *
 * API: https://docs.moyasar.com (Basic auth, the secret key as the user name
 * and an empty password; amounts in the smallest unit, halalas for SAR).
 */

export const MOYASAR_API = 'https://api.moyasar.com/v1';

/** Moyasar's ids are UUIDs. Nothing else goes into a request path. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMoyasarId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export type InvoiceStatus = 'initiated' | 'paid' | 'failed' | 'refunded' | 'canceled' | 'on_hold' | 'expired' | 'voided';

export interface MoyasarPayment {
  id: string;
  status: string;
  /** Halalas. */
  amount: number;
  currency: string;
  /** Halalas refunded so far. */
  refunded: number;
  /** 'creditcard', 'applepay', 'stcpay', ... */
  sourceType: string | null;
}

export interface MoyasarInvoice {
  id: string;
  status: InvoiceStatus | string;
  /** Halalas. */
  amount: number;
  currency: string;
  /** The hosted page the fan pays on. */
  url: string;
  payments: MoyasarPayment[];
  metadata: Record<string, string>;
}

export interface NewInvoice {
  /** Halalas, at least 100. */
  amount: number;
  currency: 'SAR';
  description: string;
  /** Moyasar POSTs the invoice here when it is paid (a nudge: it is read back, never believed). */
  callbackUrl: string;
  /** Where the fan is sent after paying. */
  successUrl: string;
  /** Where "back" on Moyasar's page goes. */
  backUrl: string;
  /** No payment after this. */
  expiresAt: Date;
  metadata: Record<string, string>;
}

/** What the payment code needs from Moyasar; the tests give it a fake. */
export interface MoyasarApi {
  createInvoice(i: NewInvoice): Promise<MoyasarInvoice>;
  invoice(id: string): Promise<MoyasarInvoice>;
  /** Refund a payment in full (no amount) or in part (halalas). */
  refund(paymentId: string, amount?: number): Promise<MoyasarPayment>;
}

export class MoyasarError extends Error {
  constructor(readonly status: number, readonly type: string) {
    super(`Moyasar answered ${status}${type ? ` (${type})` : ''}`);
    this.name = 'MoyasarError';
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readPayment(p: unknown): MoyasarPayment {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const source = (o.source && typeof o.source === 'object' ? o.source : {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    status: str(o.status),
    amount: num(o.amount),
    currency: str(o.currency).toUpperCase(),
    refunded: num(o.refunded),
    sourceType: str(source.type) || null,
  };
}

/** An invoice as Moyasar returned it, reduced to the fields used, each checked for its type. */
export function readInvoice(v: unknown): MoyasarInvoice {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const meta: Record<string, string> = {};
  if (o.metadata && typeof o.metadata === 'object') {
    for (const [k, x] of Object.entries(o.metadata as Record<string, unknown>)) if (typeof x === 'string') meta[k] = x;
  }
  return {
    id: str(o.id),
    status: str(o.status),
    amount: num(o.amount),
    currency: str(o.currency).toUpperCase(),
    url: str(o.url),
    payments: Array.isArray(o.payments) ? o.payments.map(readPayment) : [],
    metadata: meta,
  };
}

export interface MoyasarClientOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class MoyasarClient implements MoyasarApi {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly auth: string;

  constructor(secretKey: string, opts: MoyasarClientOptions = {}) {
    this.auth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
    this.base = (opts.base ?? MOYASAR_API).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: this.auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      // A timeout or a network failure: no status, and nothing of the request in the message.
      throw new MoyasarError(0, (e as Error).name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new MoyasarError(res.status, str(data?.type).slice(0, 60));
    return data;
  }

  async createInvoice(i: NewInvoice): Promise<MoyasarInvoice> {
    if (!Number.isInteger(i.amount) || i.amount < 100) throw new MoyasarError(0, 'bad_amount');
    const inv = readInvoice(
      await this.call('POST', '/invoices', {
        amount: i.amount,
        currency: i.currency,
        description: i.description,
        callback_url: i.callbackUrl,
        success_url: i.successUrl,
        back_url: i.backUrl,
        expired_at: i.expiresAt.toISOString(),
        metadata: i.metadata,
      }),
    );
    if (!isMoyasarId(inv.id) || !/^https:\/\//.test(inv.url)) throw new MoyasarError(0, 'bad_invoice');
    return inv;
  }

  async invoice(id: string): Promise<MoyasarInvoice> {
    if (!isMoyasarId(id)) throw new MoyasarError(0, 'bad_id');
    const inv = readInvoice(await this.call('GET', `/invoices/${id}`));
    if (inv.id !== id) throw new MoyasarError(0, 'bad_invoice');
    return inv;
  }

  async refund(paymentId: string, amount?: number): Promise<MoyasarPayment> {
    if (!isMoyasarId(paymentId)) throw new MoyasarError(0, 'bad_id');
    return readPayment(await this.call('POST', `/payments/${paymentId}/refund`, amount === undefined ? {} : { amount }));
  }
}
