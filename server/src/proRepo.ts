/**
 * Where Pro is kept: passes, the 7-day gift, the allowance counters and the
 * "tell me when Pro opens" list. In memory for development and tests, in
 * Postgres in production (tables in schema.sql, "Pro" at the end).
 *
 * Two promises every implementation keeps, because money and fairness rest on
 * them:
 *  - take() is all-or-nothing and safe under concurrent calls: two requests
 *    racing for the last Super design cannot both get it, and a request that
 *    passes the day's ceiling but not the month's takes neither.
 *  - acceptGift() succeeds once per account, ever. The gift row is keyed by
 *    the account and only moves from offered to accepted.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AllowanceKind, PassPlan } from './proPlan';
import { LEGACY_PAID_PLANS, PAID_PLANS, PASS_PLANS, normalizePlan } from './proPlan';
import type { PriceCurrency } from './proPrice';

export interface ProPass {
  id: string;
  userId: string;
  plan: PassPlan;
  startsAt: string;
  endsAt: string;
  /** 'gift' (accepted gift), 'admin' (granted by hand), 'payment' (bought). */
  source: 'gift' | 'admin' | 'payment';
  createdAt: string;
  revokedAt: string | null;
}

/** The 7-day gift. It has no claim-by date: an offer waits until it is started. */
export interface ProGift {
  userId: string;
  offeredAt: string;
  acceptedAt: string | null;
  passId: string | null;
}

/** One counter to bump: the stored key of a period and its ceiling. */
export interface AllowanceSlot {
  key: string;
  limit: number;
}

export interface ProStats {
  gifts: { offered: number; accepted: number; active: number };
  passes: Record<PassPlan, number>;
  notify: number;
}

/** One answer to "what would you pay for a month of Pro?" (proPrice.ts). */
export interface PriceAnswer {
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An answer as /admin lists it: whose it was, if anyone's. */
export interface PriceAnswerRow extends PriceAnswer {
  /** The account that answered; null for a visitor who was signed out (or an account since renamed away). */
  username: string | null;
}

export interface PriceAnswerPut {
  /** proPrice accountVoter() or deviceVoter(). */
  voter: string;
  userId: string | null;
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  /** A browser's voter whose answer this one replaces too: answered signed out, then signed in. */
  absorb: string | null;
  /** Answers kept at most: a new voter past it is turned away ('full'). */
  max: number;
}

export interface ProRepository {
  /**
   * Add `n` to every slot, or to none. ok=false when any slot would pass its
   * limit; `used` is what each slot holds after (or still holds, on refusal).
   */
  take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }>;
  /** Hand back what take() added (the result was not delivered). Never below 0. */
  give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void>;
  used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]>;

  activePasses(userId: string, now: Date): Promise<ProPass[]>;
  allPasses(userId: string): Promise<ProPass[]>;
  grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass>;
  revokePass(passId: string, now: Date): Promise<boolean>;
  /** Of these accounts, the ones holding a paid pass right now. */
  supporters(userIds: string[], now: Date): Promise<Set<string>>;

  gift(userId: string): Promise<ProGift | null>;
  /** Create the offer if there is none; return whatever is there. */
  offerGift(userId: string, now: Date): Promise<ProGift>;
  /**
   * Turn an offered gift into a pass of `days` days starting now. Refused when
   * there is no offer or it was already accepted.
   */
  acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }>;

  /** Record "tell me when Pro opens". Returns false when already recorded. */
  notify(userId: string): Promise<boolean>;
  notified(userId: string): Promise<boolean>;

  /**
   * Keep a voter's answer to the price question, replacing any earlier one
   * of theirs (and the absorbed browser's). 'full' when `max` answers are
   * kept already and this voter has none: nobody's answer is pushed out.
   */
  putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'>;
  priceAnswer(voter: string): Promise<PriceAnswer | null>;
  /** Every answer's amount (for the summary) and the newest `limit` in full, newest first. */
  priceAnswers(limit: number): Promise<{ all: { amount: number; currency: PriceCurrency; account: boolean }[]; newest: PriceAnswerRow[] }>;

  stats(now: Date): Promise<ProStats>;
  /** Drop allowance counters nobody has touched for this long. */
  purgeAllowances(before: Date): Promise<number>;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

// ---------------------------------------------------------------- memory ---

export class MemoryProRepository implements ProRepository {
  private counters = new Map<string, { used: number; at: number }>();
  private passes: ProPass[] = [];
  private gifts = new Map<string, ProGift>();
  private notifies = new Set<string>();
  private prices = new Map<string, PriceAnswer & { userId: string | null; seq: number }>();
  private priceSeq = 0;

  /** `nameOf` names an account for /admin's list (the memory auth store's usernameOf). */
  constructor(private readonly nameOf: (userId: string) => string | null = () => null) {}

  private ck(userId: string, kind: AllowanceKind, key: string): string {
    return `${userId}|${kind}|${key}`;
  }

  async take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }> {
    // Synchronous from here on: nothing can interleave inside one call.
    const now = slots.map((s) => this.counters.get(this.ck(userId, kind, s.key))?.used ?? 0);
    const fits = slots.every((s, i) => n >= 0 && now[i] + n <= s.limit);
    if (!fits) return { ok: false, used: now };
    const after = now.map((u, i) => {
      const v = u + n;
      this.counters.set(this.ck(userId, kind, slots[i].key), { used: v, at: Date.now() });
      return v;
    });
    return { ok: true, used: after };
  }

  async give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void> {
    for (const key of keys) {
      const k = this.ck(userId, kind, key);
      const c = this.counters.get(k);
      if (c) c.used = Math.max(0, c.used - n);
    }
  }

  async used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]> {
    return keys.map((key) => this.counters.get(this.ck(userId, kind, key))?.used ?? 0);
  }

  async activePasses(userId: string, now: Date): Promise<ProPass[]> {
    const t = now.getTime();
    return this.passes.filter(
      (p) => p.userId === userId && !p.revokedAt && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t,
    );
  }

  async allPasses(userId: string): Promise<ProPass[]> {
    return this.passes.filter((p) => p.userId === userId);
  }

  async grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass> {
    const pass: ProPass = {
      id: randomUUID(),
      userId: p.userId,
      plan: p.plan,
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      source: p.source,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.passes.push(pass);
    return pass;
  }

  async revokePass(passId: string, now: Date): Promise<boolean> {
    const p = this.passes.find((x) => x.id === passId);
    if (!p || p.revokedAt) return false;
    p.revokedAt = now.toISOString();
    return true;
  }

  async supporters(userIds: string[], now: Date): Promise<Set<string>> {
    const out = new Set<string>();
    const want = new Set(userIds);
    const t = now.getTime();
    for (const p of this.passes) {
      if (want.has(p.userId) && !p.revokedAt && PAID_PLANS.includes(p.plan) && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t) {
        out.add(p.userId);
      }
    }
    return out;
  }

  async gift(userId: string): Promise<ProGift | null> {
    const g = this.gifts.get(userId);
    return g ? { ...g } : null;
  }

  async offerGift(userId: string, now: Date): Promise<ProGift> {
    const have = this.gifts.get(userId);
    if (have) return { ...have };
    const g: ProGift = { userId, offeredAt: now.toISOString(), acceptedAt: null, passId: null };
    this.gifts.set(userId, g);
    return { ...g };
  }

  async acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }> {
    const g = this.gifts.get(userId);
    if (!g) return { ok: false, reason: 'none' };
    if (g.acceptedAt) return { ok: false, reason: 'used' };
    // Marked before the pass exists, so a second call in the same tick is refused.
    g.acceptedAt = now.toISOString();
    const pass = await this.grantPass({
      userId, plan: 'gift', startsAt: now, endsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000), source: 'gift', createdBy: null,
    });
    g.passId = pass.id;
    return { ok: true, pass };
  }

  async notify(userId: string): Promise<boolean> {
    if (this.notifies.has(userId)) return false;
    this.notifies.add(userId);
    return true;
  }

  async notified(userId: string): Promise<boolean> {
    return this.notifies.has(userId);
  }

  async putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'> {
    const had = this.prices.get(a.voter);
    const absorbed = a.absorb && a.absorb !== a.voter ? this.prices.get(a.absorb) : undefined;
    if (!had && !absorbed && this.prices.size >= a.max) return 'full';
    if (absorbed) this.prices.delete(a.absorb!);
    const now = new Date().toISOString();
    this.prices.set(a.voter, {
      amount: a.amount, currency: a.currency, lang: a.lang, comment: a.comment, userId: a.userId,
      createdAt: had?.createdAt ?? absorbed?.createdAt ?? now, updatedAt: now, seq: ++this.priceSeq,
    });
    return 'saved';
  }

  async priceAnswer(voter: string): Promise<PriceAnswer | null> {
    const p = this.prices.get(voter);
    return p ? { amount: p.amount, currency: p.currency, lang: p.lang, comment: p.comment, createdAt: p.createdAt, updatedAt: p.updatedAt } : null;
  }

  async priceAnswers(limit: number): Promise<{ all: { amount: number; currency: PriceCurrency; account: boolean }[]; newest: PriceAnswerRow[] }> {
    const rows = [...this.prices.values()].sort((x, y) => y.seq - x.seq);
    return {
      all: rows.map((p) => ({ amount: p.amount, currency: p.currency, account: !!p.userId })),
      newest: rows.slice(0, limit).map((p) => ({
        amount: p.amount, currency: p.currency, lang: p.lang, comment: p.comment, createdAt: p.createdAt, updatedAt: p.updatedAt,
        username: p.userId ? this.nameOf(p.userId) : null,
      })),
    };
  }

  async stats(now: Date): Promise<ProStats> {
    const t = now.getTime();
    const live = this.passes.filter((p) => !p.revokedAt && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t);
    const passes = Object.fromEntries(PASS_PLANS.map((pl) => [pl, live.filter((p) => p.plan === pl).length])) as Record<PassPlan, number>;
    const gifts = [...this.gifts.values()];
    return {
      gifts: {
        offered: gifts.length,
        accepted: gifts.filter((g) => g.acceptedAt).length,
        active: passes.gift,
      },
      passes,
      notify: this.notifies.size,
    };
  }

  async purgeAllowances(before: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.counters) {
      if (v.at < before.getTime()) {
        this.counters.delete(k);
        n++;
      }
    }
    return n;
  }
}

// -------------------------------------------------------------- postgres ---

function rowToPass(r: Record<string, unknown>): ProPass {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    // A pass granted before Pro became one plan reads as a month of Pro.
    plan: normalizePlan(String(r.plan)),
    startsAt: iso(r.starts_at as string)!,
    endsAt: iso(r.ends_at as string)!,
    source: String(r.source) as ProPass['source'],
    createdAt: iso(r.created_at as string)!,
    revokedAt: iso(r.revoked_at as string | null),
  };
}

function rowToGift(r: Record<string, unknown>): ProGift {
  return {
    userId: String(r.user_id),
    offeredAt: iso(r.offered_at as string)!,
    acceptedAt: iso(r.accepted_at as string | null),
    passId: r.pass_id ? String(r.pass_id) : null,
  };
}

const PASS_COLS = 'id, user_id, plan, starts_at, ends_at, source, created_at, revoked_at';

function rowToPrice(r: Record<string, unknown>): PriceAnswer {
  return {
    // NUMERIC arrives as a string ("15.50"): a number again here.
    amount: Number(r.amount),
    currency: String(r.currency) as PriceCurrency,
    lang: r.lang === 'ar' ? 'ar' : 'en',
    comment: r.comment == null ? null : String(r.comment),
    createdAt: iso(r.created_at as string)!,
    updatedAt: iso(r.updated_at as string)!,
  };
}

export class PgProRepository implements ProRepository {
  constructor(private readonly pool: pg.Pool) {}

  async take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }> {
    if (!slots.length) return { ok: true, used: [] };
    if (n < 0 || slots.some((s) => n > s.limit)) return { ok: false, used: await this.used(userId, kind, slots.map((s) => s.key)) };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const used: number[] = [];
      for (const s of slots) {
        // Insert at n (n <= limit was checked above) or add n while it fits.
        // A row that would pass its limit is left alone and returns nothing.
        const r = await client.query(
          `INSERT INTO pro_allowance (user_id, kind, period, used) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, kind, period) DO UPDATE
             SET used = pro_allowance.used + EXCLUDED.used, updated_at = now()
             WHERE pro_allowance.used + EXCLUDED.used <= $5
           RETURNING used`,
          [userId, kind, s.key, n, s.limit],
        );
        if (!r.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, used: await this.used(userId, kind, slots.map((x) => x.key)) };
        }
        used.push(Number(r.rows[0].used));
      }
      await client.query('COMMIT');
      return { ok: true, used };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void> {
    if (!keys.length || n <= 0) return;
    await this.pool.query(
      `UPDATE pro_allowance SET used = GREATEST(0, used - $4), updated_at = now()
       WHERE user_id = $1 AND kind = $2 AND period = ANY($3::text[])`,
      [userId, kind, keys, n],
    );
  }

  async used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]> {
    if (!keys.length) return [];
    const r = await this.pool.query(
      'SELECT period, used FROM pro_allowance WHERE user_id = $1 AND kind = $2 AND period = ANY($3::text[])',
      [userId, kind, keys],
    );
    const by = new Map<string, number>(r.rows.map((x) => [String(x.period), Number(x.used)]));
    return keys.map((k) => by.get(k) ?? 0);
  }

  async activePasses(userId: string, now: Date): Promise<ProPass[]> {
    const r = await this.pool.query(
      `SELECT ${PASS_COLS} FROM pro_passes
       WHERE user_id = $1 AND revoked_at IS NULL AND starts_at <= $2 AND ends_at > $2
       ORDER BY ends_at DESC`,
      [userId, now],
    );
    return r.rows.map(rowToPass);
  }

  async allPasses(userId: string): Promise<ProPass[]> {
    const r = await this.pool.query(`SELECT ${PASS_COLS} FROM pro_passes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]);
    return r.rows.map(rowToPass);
  }

  async grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass> {
    const r = await this.pool.query(
      `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PASS_COLS}`,
      [p.userId, p.plan, p.startsAt, p.endsAt, p.source, p.createdBy],
    );
    return rowToPass(r.rows[0]);
  }

  async revokePass(passId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query('UPDATE pro_passes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [passId, now]);
    return (r.rowCount ?? 0) > 0;
  }

  async supporters(userIds: string[], now: Date): Promise<Set<string>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return new Set();
    const r = await this.pool.query(
      `SELECT DISTINCT user_id FROM pro_passes
       WHERE user_id = ANY($1::uuid[]) AND plan = ANY($2::text[])
         AND revoked_at IS NULL AND starts_at <= $3 AND ends_at > $3`,
      [ids, [...PAID_PLANS, ...LEGACY_PAID_PLANS], now],
    );
    return new Set(r.rows.map((x) => String(x.user_id)));
  }

  async gift(userId: string): Promise<ProGift | null> {
    const r = await this.pool.query('SELECT user_id, offered_at, accepted_at, pass_id FROM pro_gifts WHERE user_id = $1', [userId]);
    return r.rows[0] ? rowToGift(r.rows[0]) : null;
  }

  async offerGift(userId: string, now: Date): Promise<ProGift> {
    // claim_by stays empty: the gift never expires (schema.sql, "Pro becomes one monthly plan").
    await this.pool.query(
      'INSERT INTO pro_gifts (user_id, offered_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [userId, now],
    );
    return (await this.gift(userId))!;
  }

  async acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row lock makes a second Accept wait for the first, then see it accepted.
      const g = await client.query('SELECT accepted_at FROM pro_gifts WHERE user_id = $1 FOR UPDATE', [userId]);
      const row = g.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'none' };
      }
      if (row.accepted_at) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'used' };
      }
      const ends = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const p = await client.query(
        `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source) VALUES ($1, 'gift', $2, $3, 'gift') RETURNING ${PASS_COLS}`,
        [userId, now, ends],
      );
      const pass = rowToPass(p.rows[0]);
      await client.query('UPDATE pro_gifts SET accepted_at = $2, pass_id = $3 WHERE user_id = $1', [userId, now, pass.id]);
      await client.query('COMMIT');
      return { ok: true, pass };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async notify(userId: string): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO pro_notify (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async notified(userId: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM pro_notify WHERE user_id = $1', [userId]);
    return r.rows.length > 0;
  }

  async putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The browser's answer goes first, so taking it over never meets the ceiling.
      const absorbed = a.absorb && a.absorb !== a.voter
        ? await client.query('DELETE FROM pro_price_answers WHERE voter = $1 RETURNING created_at', [a.absorb])
        : null;
      const since = absorbed?.rows[0]?.created_at ?? null;
      // Insert only under the ceiling, or over one's own answer. The count is
      // not locked: two racing new voters can pass it by one, which is fine
      // for a ceiling that only exists to stop the table growing for ever.
      const r = await client.query(
        `INSERT INTO pro_price_answers (voter, user_id, amount, currency, lang, comment, created_at)
         SELECT $1, $2, $3, $4, $5, $6, COALESCE($8::timestamptz, now())
         WHERE (SELECT count(*) FROM pro_price_answers) < $7
            OR EXISTS (SELECT 1 FROM pro_price_answers WHERE voter = $1)
         ON CONFLICT (voter) DO UPDATE
           SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, lang = EXCLUDED.lang,
               comment = EXCLUDED.comment, user_id = EXCLUDED.user_id, updated_at = now()`,
        [a.voter, a.userId, a.amount, a.currency, a.lang, a.comment, a.max, since],
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return 'full';
      }
      await client.query('COMMIT');
      return 'saved';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async priceAnswer(voter: string): Promise<PriceAnswer | null> {
    const r = await this.pool.query('SELECT amount, currency, lang, comment, created_at, updated_at FROM pro_price_answers WHERE voter = $1', [voter]);
    const x = r.rows[0];
    return x ? rowToPrice(x) : null;
  }

  async priceAnswers(limit: number): Promise<{ all: { amount: number; currency: PriceCurrency; account: boolean }[]; newest: PriceAnswerRow[] }> {
    const [all, newest] = await Promise.all([
      this.pool.query('SELECT amount, currency, user_id IS NOT NULL AS account FROM pro_price_answers'),
      this.pool.query(
        `SELECT p.amount, p.currency, p.lang, p.comment, p.created_at, p.updated_at, u.username
         FROM pro_price_answers p LEFT JOIN users u ON u.id = p.user_id
         ORDER BY p.updated_at DESC, p.id DESC LIMIT $1`,
        [limit],
      ),
    ]);
    return {
      all: all.rows.map((x) => ({ amount: Number(x.amount), currency: x.currency as PriceCurrency, account: !!x.account })),
      newest: newest.rows.map((x) => ({ ...rowToPrice(x), username: x.username ? String(x.username) : null })),
    };
  }

  async stats(now: Date): Promise<ProStats> {
    const [g, p, n] = await Promise.all([
      this.pool.query('SELECT count(*)::int AS offered, count(accepted_at)::int AS accepted FROM pro_gifts'),
      this.pool.query(
        `SELECT plan, count(*)::int AS n FROM pro_passes
         WHERE revoked_at IS NULL AND starts_at <= $1 AND ends_at > $1 GROUP BY plan`,
        [now],
      ),
      this.pool.query('SELECT count(*)::int AS n FROM pro_notify'),
    ]);
    const passes = Object.fromEntries(PASS_PLANS.map((pl) => [pl, 0])) as Record<PassPlan, number>;
    for (const r of p.rows) passes[normalizePlan(String(r.plan))] += Number(r.n);
    return {
      gifts: { offered: Number(g.rows[0]?.offered ?? 0), accepted: Number(g.rows[0]?.accepted ?? 0), active: passes.gift },
      passes,
      notify: Number(n.rows[0]?.n ?? 0),
    };
  }

  async purgeAllowances(before: Date): Promise<number> {
    const r = await this.pool.query('DELETE FROM pro_allowance WHERE updated_at < $1', [before]);
    return r.rowCount ?? 0;
  }
}
