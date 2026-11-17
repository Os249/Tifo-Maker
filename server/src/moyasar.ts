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
 * Payments v2 (16 Nov 2026) adds what the payment form and renewals need:
 * read a payment by its id, charge a saved card (a token), read a token and
 * delete one. Still no card number here, ever: a token is Moyasar's name for a
 * card it keeps, and this server holds only that name, the card's last four
 * digits and its expiry. Every call can go through a fixed-IP proxy
 * (MOYASAR_PROXY_URL, moyasarProxy.ts); nothing else does.
 *
 * API: https://docs.moyasar.com (Basic auth, the secret key as the user name
 * and an empty password; amounts in the smallest unit, halalas for SAR).
 */

export const MOYASAR_API = 'https://api.moyasar.com/v1';

/** Moyasar's ids are UUIDs. Nothing else goes into a request path. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMoyasarId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** Moyasar's token ids. Nothing else goes into a token path or a charge. */
const TOKEN = /^token_[A-Za-z0-9]{8,100}$/;
export const isMoyasarToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

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
  /** The card's scheme as Moyasar names it: 'mada', 'visa', 'master', ... (payments v2). */
  company?: string | null;
  /** The token made when the card was saved with this payment ('token_...'), if one was. */
  token?: string | null;
  /** Why it failed, in Moyasar's or the bank's words. Read for its kind only (failReason), never shown. */
  message?: string | null;
  /** The bank's two-character answer ('00' approved, '51' no funds, '54' expired card), when there is one. */
  responseCode?: string | null;
  /** Where 3-D Secure happens, while the payment waits for it. */
  transactionUrl?: string | null;
  invoiceId?: string | null;
  metadata?: Record<string, string>;
}

/** A saved card, as far as renewals need it. Never a card number: the last four digits and the expiry. */
export interface MoyasarToken {
  id: string;
  /** 'initiated' (not verified yet), 'active' (can be charged), 'inactive' (verification failed, or the card expired). */
  status: string;
  brand: string | null;
  lastFour: string | null;
  month: number | null;
  year: number | null;
}

/** A charge on a saved card, made by the server with no fan present. */
export interface TokenCharge {
  /** Becomes the payment's id: asking twice with the same one is one payment (Moyasar's idempotency). */
  givenId: string;
  /** Halalas. */
  amount: number;
  currency: 'SAR';
  description: string;
  token: string;
  /** Moyasar requires one for a token payment; nobody is ever sent there. */
  callbackUrl: string;
  metadata: Record<string, string>;
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
  /*
   * Payments v2 (the payment form, renewals). Optional, so a stand-in that
   * only knows invoices still fits; the payment code checks before calling.
   */
  /** A payment by its id, or null when Moyasar has none by that id (nothing was ever created). */
  payment?(id: string): Promise<MoyasarPayment | null>;
  /** Charge a saved card. A decline comes back as a payment with status 'failed', not as an error. */
  chargeToken?(c: TokenCharge): Promise<MoyasarPayment>;
  token?(id: string): Promise<MoyasarToken | null>;
  /** Forget a saved card at Moyasar. True when it is gone (now, or already). */
  deleteToken?(id: string): Promise<boolean>;
}

export class MoyasarError extends Error {
  constructor(readonly status: number, readonly type: string) {
    super(`Moyasar answered ${status}${type ? ` (${type})` : ''}`);
    this.name = 'MoyasarError';
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readMeta(v: unknown): Record<string, string> {
  const meta: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') meta[k] = x;
  }
  return meta;
}

/** A payment as Moyasar returned it (or sent it in a webhook), reduced to the fields used, each checked for its type. */
export function readPayment(p: unknown): MoyasarPayment {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const source = (o.source && typeof o.source === 'object' ? o.source : {}) as Record<string, unknown>;
  const token = str(source.token);
  const url = str(source.transaction_url);
  const code = str(source.response_code);
  return {
    id: str(o.id),
    status: str(o.status),
    amount: num(o.amount),
    currency: str(o.currency).toUpperCase(),
    refunded: num(o.refunded),
    sourceType: str(source.type).slice(0, 32) || null,
    company: str(source.company).toLowerCase().slice(0, 32) || null,
    // An Apple Pay payment carries a "token" of its own on the way in; only Moyasar's saved-card ids are kept.
    token: isMoyasarToken(token) ? token : null,
    message: str(source.message).slice(0, 200) || null,
    responseCode: /^[0-9A-Za-z]{2}$/.test(code) ? code : null,
    transactionUrl: /^https:\/\//.test(url) ? url : null,
    invoiceId: isMoyasarId(o.invoice_id) ? o.invoice_id : null,
    metadata: readMeta(o.metadata),
  };
}

export function readToken(v: unknown): MoyasarToken {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (x: unknown): number | null => {
    const y = typeof x === 'number' ? x : typeof x === 'string' && /^\d{1,4}$/.test(x) ? Number(x) : NaN;
    return Number.isInteger(y) ? y : null;
  };
  const year = n(o.year);
  const last = str(o.last_four);
  return {
    id: str(o.id),
    status: str(o.status),
    brand: str(o.brand).toLowerCase().slice(0, 32) || null,
    lastFour: /^\d{4}$/.test(last) ? last : null,
    month: n(o.month),
    // "30" and "2030" both mean 2030.
    year: year === null ? null : year < 100 ? 2000 + year : year,
  };
}

/**
 * Why a payment did not go through, as one of a few kinds the page has words
 * for. From the bank's code when there is one, otherwise from Moyasar's own
 * 3-D Secure messages (docs.moyasar.com, "3DS errors"); anything unknown is
 * 'declined'. The message itself is never shown to the fan or stored.
 *
 *   auth          3-D Secure was not passed (wrong code, declined by the bank's page)
 *   cancelled     the fan left 3-D Secure, or its session ran out
 *   unavailable   the card has no 3-D Secure, or it could not be reached for this card
 *   rejected      the bank refused the attempt outright (risk, a reported card)
 *   error         a fault at the bank's or Moyasar's end (time-outs, connection errors)
 *   funds         not enough money
 *   expired_card  the card has expired
 *   declined      the bank said no, without saying why
 */
export type FailKind = 'auth' | 'cancelled' | 'unavailable' | 'rejected' | 'error' | 'funds' | 'expired_card' | 'declined';
export const FAIL_KINDS: readonly FailKind[] = ['auth', 'cancelled', 'unavailable', 'rejected', 'error', 'funds', 'expired_card', 'declined'];

export function failReason(p: Pick<MoyasarPayment, 'message' | 'responseCode'>): FailKind {
  const code = p.responseCode ?? '';
  if (code === '51') return 'funds';
  if (code === '54' || code === '33') return 'expired_card';
  const m = (p.message ?? '').toLowerCase();
  if (/^3ds/.test(m) || m.includes('3d secure') || m.includes('unauthenticated')) {
    if (/card has expired/.test(m)) return 'expired_card';
    if (/session has expired|bypassed|cancel|abandon/.test(m)) return 'cancelled';
    if (/unavailable|not enrolled|no matching|unsupported/.test(m)) return 'unavailable';
    if (/rejected|stolen|fraud|security failure|frequency limit|maximum number/.test(m)) return 'rejected';
    if (/authentication declined|authentication error|confidence|unauthenticated|not authenticated|invalid card/.test(m)) return 'auth';
    return 'error';
  }
  if (/insufficient/.test(m)) return 'funds';
  if (/expired card/.test(m)) return 'expired_card';
  if (/timed?[ _]?out|connection error|unspecified failure/.test(m)) return 'error';
  return 'declined';
}

/** An invoice as Moyasar returned it, reduced to the fields used, each checked for its type. */
export function readInvoice(v: unknown): MoyasarInvoice {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    status: str(o.status),
    amount: num(o.amount),
    currency: str(o.currency).toUpperCase(),
    url: str(o.url),
    payments: Array.isArray(o.payments) ? o.payments.map(readPayment) : [],
    metadata: readMeta(o.metadata),
  };
}

export interface MoyasarClientOptions {
  base?: string;
  /** How the API is reached: the platform's fetch, or one that goes through the fixed-IP proxy (moyasarProxy.ts). */
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

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
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
      // A proxy that fails (MOYASAR_PROXY_URL) says only that: its address holds a password.
      const name = (e as Error).name;
      throw new MoyasarError(0, name === 'TimeoutError' ? 'timeout' : name === 'ProxyError' ? 'proxy' : 'network');
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

  async payment(id: string): Promise<MoyasarPayment | null> {
    if (!isMoyasarId(id)) throw new MoyasarError(0, 'bad_id');
    try {
      const p = readPayment(await this.call('GET', `/payments/${id}`));
      if (p.id.toLowerCase() !== id.toLowerCase()) throw new MoyasarError(0, 'bad_payment');
      return p;
    } catch (e) {
      if (e instanceof MoyasarError && e.status === 404) return null;
      throw e;
    }
  }

  async chargeToken(c: TokenCharge): Promise<MoyasarPayment> {
    if (!isMoyasarId(c.givenId)) throw new MoyasarError(0, 'bad_id');
    if (!isMoyasarToken(c.token)) throw new MoyasarError(0, 'bad_token');
    if (!Number.isInteger(c.amount) || c.amount < 100) throw new MoyasarError(0, 'bad_amount');
    const p = readPayment(
      await this.call('POST', '/payments', {
        given_id: c.givenId,
        amount: c.amount,
        currency: c.currency,
        description: c.description,
        callback_url: c.callbackUrl,
        source: { type: 'token', token: c.token },
        metadata: c.metadata,
      }),
    );
    // given_id becomes the id: anything else is not the payment that was asked for.
    if (p.id.toLowerCase() !== c.givenId.toLowerCase()) throw new MoyasarError(0, 'bad_payment');
    return p;
  }

  async token(id: string): Promise<MoyasarToken | null> {
    if (!isMoyasarToken(id)) throw new MoyasarError(0, 'bad_token');
    try {
      const t = readToken(await this.call('GET', `/tokens/${id}`));
      if (t.id !== id) throw new MoyasarError(0, 'bad_token');
      return t;
    } catch (e) {
      if (e instanceof MoyasarError && e.status === 404) return null;
      throw e;
    }
  }

  async deleteToken(id: string): Promise<boolean> {
    if (!isMoyasarToken(id)) throw new MoyasarError(0, 'bad_token');
    try {
      await this.call('DELETE', `/tokens/${id}`);
      return true;
    } catch (e) {
      // Already gone is gone.
      if (e instanceof MoyasarError && e.status === 404) return true;
      throw e;
    }
  }
}
