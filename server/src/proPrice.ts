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

export interface PriceInput {
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  device: string | null;
}

/** The body of POST /api/pro/price, checked. Nothing in it is trusted beyond its shape. */
export function readPriceInput(body: unknown): { ok: true; input: PriceInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const amount = b.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > PRICE_MAX) {
    return { ok: false, error: `amount must be a number from 0 to ${PRICE_MAX}` };
  }
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
  return {
    ok: true,
    input: { amount: Math.round(amount * 100) / 100, currency: b.currency as PriceCurrency, lang, comment: c.comment, device },
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
 * Where the answers fall, in steps that suit each currency: the first band
 * is exactly 0 ("nothing"), then up to each edge, then the last edge and
 * above. SAR 19 was the planned price; USD 5 is about the same.
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
  /** How many answers fall in each band: [0], then (0, e1), [e1, e2), ..., [last, max]. */
  bands: number[];
}

export function summarize(all: { amount: number; currency: PriceCurrency; account: boolean }[]): Record<PriceCurrency, PriceSummary> {
  const out = {} as Record<PriceCurrency, PriceSummary>;
  for (const cur of PRICE_CURRENCIES) {
    const mine = all.filter((a) => a.currency === cur);
    const xs = mine.map((a) => a.amount).sort((a, b) => a - b);
    const acc = mine.filter((a) => a.account).map((a) => a.amount).sort((a, b) => a - b);
    const edges = PRICE_BANDS[cur];
    const bands = new Array<number>(edges.length + 2).fill(0);
    for (const x of xs) {
      if (x === 0) bands[0]++;
      else {
        let i = edges.findIndex((e) => x < e);
        if (i < 0) i = edges.length;
        bands[i + 1]++;
      }
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
