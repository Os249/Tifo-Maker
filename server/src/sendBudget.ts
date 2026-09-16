/**
 * How many emails one key may cause, and how often.
 *
 * The per-IP rate limit (10 a minute on the auth routes) says nothing about who
 * RECEIVES the mail. One IP could send a victim a password-reset email every six
 * seconds, and a handful of IPs could spend the provider's whole daily allowance
 * (Resend's free tier is 100 a day), after which verification and reset emails
 * silently stop for everyone. So each route that sends mail also asks this, with
 * a key naming the recipient or the account behind the request.
 *
 * In memory, like the other per-process counters. It forgets on restart, which
 * is the safe direction: a restart can grant a few extra sends, never block one.
 */
export interface BudgetRule {
  /** Minimum gap between two sends for the same key. 0 = none. */
  cooldownMs: number;
  /** Most sends for the same key in any 24 hours. */
  perDay: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 20_000;

export class SendBudget {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Try to spend one send. Returns 0 and records it when allowed, otherwise the
   * number of seconds until the key may send again.
   */
  take(key: string, rule: BudgetRule): number {
    const wait = this.waitFor(key, rule);
    if (wait > 0) return wait;
    const t = this.now();
    const list = this.hits.get(key) ?? [];
    list.push(t);
    this.hits.delete(key); // re-insert so Map order tracks recency
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.prune(t);
    return 0;
  }

  /** Seconds until the key may send, without spending anything. */
  waitFor(key: string, rule: BudgetRule): number {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((at) => t - at < DAY_MS);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    const last = list[list.length - 1];
    if (last !== undefined && rule.cooldownMs > 0 && t - last < rule.cooldownMs) {
      return Math.max(1, Math.ceil((rule.cooldownMs - (t - last)) / 1000));
    }
    if (list.length >= rule.perDay) {
      return Math.max(1, Math.ceil((list[0] + DAY_MS - t) / 1000));
    }
    return 0;
  }

  /** Give back the most recent send, when the send it paid for did not happen. */
  refund(key: string): void {
    const list = this.hits.get(key);
    if (!list?.length) return;
    list.pop();
    if (!list.length) this.hits.delete(key);
  }

  private prune(t: number): void {
    for (const [k, list] of this.hits) {
      if (!list.length || t - list[list.length - 1] >= DAY_MS) this.hits.delete(k);
    }
    // Still too many live keys: drop the least recently used. Under a flood of
    // distinct recipients this forgets old ones rather than growing without end.
    while (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/** The limits each mail-sending path uses. */
export const RESET_TO_ADDRESS: BudgetRule = { cooldownMs: 5 * 60_000, perDay: 5 };
export const VERIFY_TO_ADDRESS: BudgetRule = { cooldownMs: 60_000, perDay: 5 };
/**
 * Verification messages one account can trigger in a day, whatever the path.
 * Also what bounds guessing a 6-digit code: 10 codes x 5 tries = 50 guesses a
 * day, against 7,200 with only the per-code limit.
 */
export const VERIFY_BY_ACCOUNT: BudgetRule = { cooldownMs: 0, perDay: 10 };
