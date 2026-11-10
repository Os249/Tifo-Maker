/**
 * "What would you pay for a month of Pro?" (8 Nov 2026).
 *
 * Until Pro goes on sale, /pro shows the two plans with no price on Pro:
 * instead it asks every visitor what a month of it is worth to them, in
 * riyals or US dollars, with an optional comment. Osamh reads the answers on
 * /admin (Pro tab) and sets the price from them.
 *
 * One answer per account, or per browser for a visitor who is signed out; a
 * second answer replaces the first. A browser is known by a random key it
 * makes for itself and keeps in localStorage; only the key's SHA-256 is
 * stored, so the table holds nothing that leads back to a person who did not
 * sign in. Signed out, the key is all there is, so a new browser key from
 * one address counts against that address's day (GUEST_NEW_PER_DAY), on top
 * of the route's rate limit.
 *
 * "Not for me" (10 Nov 2026) is an answer too: kept with amount 0 and
 * wontPay, counted apart from the prices, so the median is of what the
 * people who would pay would pay. A typed 0 means the same and is kept the
 * same way. Each answer says where it was given: the /pro page or the card
 * the editor shows a signed-in fan once (src/ui/priceAsk.ts).
 *
 * Everything here is plain checking and counting; storage is the Pro
 * repository's (proRepo.ts), the routes are in proRoutes.ts.
 */
import { createHash } from 'node:crypto';

export type PriceCurrency = 'SAR' | 'USD';
export const PRICE_CURRENCIES: readonly PriceCurrency[] = ['SAR', 'USD'];

/** The highest amount anyone can give, in either currency. */
export const PRICE_MAX = 999;
/** The comment's length, in characters (code points), as the form allows. */
export const COMMENT_MAX = 200;
/** Answers kept at most. Past it a new voter is turned away; nobody's answer is pushed out. */
export const PRICE_ANSWERS_MAX = 50_000;
/** New signed-out answers one address may add in a day (changing one's own answer is free). */
export const GUEST_NEW_PER_DAY = 20;

/** A browser's own key: random, URL-safe, made by the page (src/proPage.ts). */
const DEVICE = /^[A-Za-z0-9_-]{22,64}$/;

/** Who answered: an account ('u:' + id) or a browser ('d:' + SHA-256 of its key). */
export const accountVoter = (userId: string): string => `u:${userId}`;
export const deviceVoter = (key: string): string => `d:${createHash('sha256').update(key).digest('hex')}`;

/** A browser key as sent (header or body), or null when it is not one. */
export function deviceKey(v: unknown): string | null {
  return typeof v === 'string' && DEVICE.test(v) ? v : null;
}

/**
 * The comment as it is kept: one line, no control characters, no
 * direction overrides (they could make the admin table read differently
 * from what was typed), at most COMMENT_MAX characters. Empty means none.
 */
export function cleanComment(v: unknown): { ok: true; comment: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, comment: null };
  if (typeof v !== 'string') return { ok: false };
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...s].length > COMMENT_MAX) return { ok: false };
  return { ok: true, comment: s || null };
}

/** Where an answer was given. */
export type PriceSource = 'page' | 'editor';

export interface PriceInput {
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  device: string | null;
  /** "Not for me": would not pay for Pro at all (amount is then 0). */
  wontPay: boolean;
  source: PriceSource;
}

/** The body of POST /api/pro/price, checked. Nothing in it is trusted beyond its shape. */
export function readPriceInput(body: unknown): { ok: true; input: PriceInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.wontPay !== undefined && typeof b.wontPay !== 'boolean') return { ok: false, error: 'wontPay must be true or false' };
  // "Not for me" needs no amount; any other answer does.
  const amount = b.wontPay === true && b.amount === undefined ? 0 : b.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > PRICE_MAX) {
    return { ok: false, error: `amount must be a number from 0 to ${PRICE_MAX}` };
  }
  const source = b.source === undefined ? 'page' : b.source === 'page' || b.source === 'editor' ? b.source : null;
  if (!source) return { ok: false, error: 'source must be page or editor' };
  if (!PRICE_CURRENCIES.includes(b.currency as PriceCurrency)) return { ok: false, error: 'currency must be SAR or USD' };
  const lang = b.lang === 'ar' ? 'ar' : b.lang === 'en' ? 'en' : null;
  if (!lang) return { ok: false, error: 'lang must be en or ar' };
  const c = cleanComment(b.comment);
  if (!c.ok) return { ok: false, error: `the comment must be text of at most ${COMMENT_MAX} characters` };
  let device: string | null = null;
  if (b.device !== undefined && b.device !== null) {
    device = deviceKey(b.device);
    if (!device) return { ok: false, error: 'the browser key is not valid' };
  }
  const rounded = Math.round(amount * 100) / 100;
  // Nothing at all is "not for me", however it was said.
  const wontPay = b.wontPay === true || rounded === 0;
  return {
    ok: true,
    input: { amount: wontPay ? 0 : rounded, currency: b.currency as PriceCurrency, lang, comment: c.comment, device, wontPay, source },
  };
}

// ------------------------------------------------------------- summary ---

/** The value below which `p` of the sorted values fall, interpolated (Postgres's percentile_cont). */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Where the prices fall, in steps that suit each currency: under the first
 * edge, then up to each edge, then the last edge and above ("nothing" is
 * "not for me", counted apart). SAR 19 was the planned price; USD 5 is
 * about the same.
 */
export const PRICE_BANDS: Record<PriceCurrency, number[]> = {
  SAR: [5, 10, 15, 20, 30, 50],
  USD: [1, 2, 3, 5, 10, 20],
};

export interface PriceSummary {
  n: number;
  /** Of them, answers from signed-in accounts. */
  accounts: number;
  median: number;
  mean: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  /** The median of the signed-in answers alone (null when there are none). */
  accountsMedian: number | null;
  /** How many prices fall in each band: (0, e1), [e1, e2), ..., [last, max]. */
  bands: number[];
}

/** One answer as the summary counts it. */
export interface PriceCounted {
  amount: number;
  currency: PriceCurrency;
  account: boolean;
  wontPay: boolean;
  source: PriceSource;
}

/** The prices, per currency: "not for me" answers are counted by summarizeAll, not here. */
export function summarize(all: PriceCounted[]): Record<PriceCurrency, PriceSummary> {
  const out = {} as Record<PriceCurrency, PriceSummary>;
  for (const cur of PRICE_CURRENCIES) {
    const mine = all.filter((a) => a.currency === cur && !a.wontPay);
    const xs = mine.map((a) => a.amount).sort((a, b) => a - b);
    const acc = mine.filter((a) => a.account).map((a) => a.amount).sort((a, b) => a - b);
    const edges = PRICE_BANDS[cur];
    const bands = new Array<number>(edges.length + 1).fill(0);
    for (const x of xs) {
      const i = edges.findIndex((e) => x < e);
      bands[i < 0 ? edges.length : i]++;
    }
    out[cur] = {
      n: xs.length,
      accounts: acc.length,
      median: r2(percentile(xs, 0.5)),
      mean: xs.length ? r2(xs.reduce((s, x) => s + x, 0) / xs.length) : 0,
      p25: r2(percentile(xs, 0.25)),
      p75: r2(percentile(xs, 0.75)),
      min: xs.length ? xs[0] : 0,
      max: xs.length ? xs[xs.length - 1] : 0,
      accountsMedian: acc.length ? r2(percentile(acc, 0.5)) : null,
      bands,
    };
  }
  return out;
}

/** Everything /admin shows above the list: the prices, who would not pay, and where answers came from. */
export function summarizeAll(all: PriceCounted[]) {
  const wont = all.filter((a) => a.wontPay);
  return {
    summary: summarize(all),
    wontPay: { n: wont.length, accounts: wont.filter((a) => a.account).length },
    sources: { page: all.filter((a) => a.source === 'page').length, editor: all.filter((a) => a.source === 'editor').length },
  };
}

// ------------------------------------------------------ signed-out pace ---

/**
 * New signed-out answers per address per Riyadh day, kept in memory (one
 * server). It forgets on a restart, which only ever lets a few more in.
 */
export class GuestPace {
  private seen = new Map<string, { day: string; n: number }>();
  constructor(private readonly perDay = GUEST_NEW_PER_DAY) {}

  /** Count one more for `ip` today; false when the day's are used. */
  take(ip: string, now: Date): boolean {
    const day = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    if (this.seen.size >= 20_000) {
      for (const [k, v] of this.seen) if (v.day !== day) this.seen.delete(k);
    }
    const cur = this.seen.get(ip);
    // Twenty thousand addresses in one day is not fans: refuse new ones rather than grow.
    if (!cur && this.seen.size >= 20_000) return false;
    const n = cur && cur.day === day ? cur.n : 0;
    if (n >= this.perDay) return false;
    this.seen.set(ip, { day, n: n + 1 });
    return true;
  }
}
