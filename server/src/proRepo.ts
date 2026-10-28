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
import { PAID_PLANS, PASS_PLANS } from './proPlan';

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

export interface ProGift {
  userId: string;
  offeredAt: string;
  /** Accept before this, or the gift lapses. */
  claimBy: string;
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
  offerGift(userId: string, claimBy: Date, now: Date): Promise<ProGift>;
  /**
   * Turn an offered gift into a pass of `days` days starting now. Refused when
   * there is no offer, it was already accepted, or its claim date has passed.
   */
  acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' | 'expired' }>;

  /** Record "tell me when Pro opens". Returns false when already recorded. */
  notify(userId: string): Promise<boolean>;
  notified(userId: string): Promise<boolean>;

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

  async offerGift(userId: string, claimBy: Date, now: Date): Promise<ProGift> {
    const have = this.gifts.get(userId);
    if (have) return { ...have };
    const g: ProGift = { userId, offeredAt: now.toISOString(), claimBy: claimBy.toISOString(), acceptedAt: null, passId: null };
    this.gifts.set(userId, g);
    return { ...g };
  }

  async acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' | 'expired' }> {
    const g = this.gifts.get(userId);
    if (!g) return { ok: false, reason: 'none' };
    if (g.acceptedAt) return { ok: false, reason: 'used' };
    if (Date.parse(g.claimBy) <= now.getTime()) return { ok: false, reason: 'expired' };
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
    plan: String(r.plan) as PassPlan,
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
    claimBy: iso(r.claim_by as string)!,
    acceptedAt: iso(r.accepted_at as string | null),
    passId: r.pass_id ? String(r.pass_id) : null,
  };
}

const PASS_COLS = 'id, user_id, plan, starts_at, ends_at, source, created_at, revoked_at';

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
      [ids, PAID_PLANS, now],
    );
    return new Set(r.rows.map((x) => String(x.user_id)));
  }

  async gift(userId: string): Promise<ProGift | null> {
    const r = await this.pool.query('SELECT user_id, offered_at, claim_by, accepted_at, pass_id FROM pro_gifts WHERE user_id = $1', [userId]);
    return r.rows[0] ? rowToGift(r.rows[0]) : null;
  }

  async offerGift(userId: string, claimBy: Date, now: Date): Promise<ProGift> {
    await this.pool.query(
      'INSERT INTO pro_gifts (user_id, offered_at, claim_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
      [userId, now, claimBy],
    );
    return (await this.gift(userId))!;
  }

  async acceptGift(userId: string, now: Date, days: number): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' | 'expired' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row lock makes a second Accept wait for the first, then see it accepted.
      const g = await client.query('SELECT accepted_at, claim_by FROM pro_gifts WHERE user_id = $1 FOR UPDATE', [userId]);
      const row = g.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'none' };
      }
      if (row.accepted_at) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'used' };
      }
      if (new Date(row.claim_by).getTime() <= now.getTime()) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'expired' };
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
    for (const r of p.rows) if ((PASS_PLANS as string[]).includes(String(r.plan))) passes[r.plan as PassPlan] = Number(r.n);
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
