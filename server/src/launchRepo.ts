/**
 * Where Pro's launch is kept (proLaunch.ts has the rules): the moment Pro went
 * on sale, the founders as they stood at that moment, what became of each
 * founder's one email, and who asked for no such emails. In memory for
 * development and tests, in Postgres in production (pro_launch, pro_founders,
 * pro_mail_stops in schema.sql).
 *
 * The promises the launch rests on, kept by both stores:
 *  - begin() records the launch once, ever, and copies the founders in the
 *    same step. Called by two servers in the same second, one records it and
 *    both read the same moment back.
 *  - claimMail() is true for exactly one caller per founder, for good: a row
 *    that was claimed is never claimed again unless mailFailed() gave it back
 *    (the mail service refused the message, so nothing went out).
 *  - The founders bonus is taken once per account, ever: bonus_order_id is
 *    set by a single UPDATE that only changes a row where it is still empty.
 *    In Postgres payRepo.markPaid() runs that UPDATE inside the transaction
 *    that marks the order paid; the memory store's claimBonus() is what the
 *    memory payment store calls at the same point.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { MemoryProRepository } from './proRepo';

/** How an account came to be a founder: "Tell me when Pro opens", the price question, or both. */
export type FounderSource = 'notify' | 'price' | 'both';

export interface Founder {
  userId: string;
  source: FounderSource;
  createdAt: string;
  mailClaimedAt: string | null;
  mailSentAt: string | null;
  mailTries: number;
  mailError: string | null;
  /** Why the email was not sent and will not be: the fan asked for none, or the address is gone. */
  mailSkip: 'stopped' | 'no_email' | null;
  /** Opens the "stop these emails" link. Not a session: it can only turn such emails off. */
  stopToken: string;
  /** The order the founders bonus went to. Set once, ever. */
  bonusOrderId: string | null;
  bonusAt: string | null;
}

export interface FounderRow extends Founder {
  username: string | null;
}

/** A founder whose email is still owed, with where to send it as the account stands now. */
export interface FounderMail {
  userId: string;
  username: string | null;
  email: string | null;
  verified: boolean;
  stopToken: string;
}

export interface FounderCandidates {
  total: number;
  notify: number;
  price: number;
  both: number;
  rows: { username: string | null; source: FounderSource }[];
}

export interface LaunchRepository {
  launch(): Promise<{ launchedAt: string } | null>;
  /** Record the launch (once) and copy the founders in the same step. `first` for the one caller that recorded it. */
  begin(now: Date): Promise<{ first: boolean; launchedAt: string; founders: number }>;
  /** Who would be a founder if Pro went on sale now: accounts with a verified email on either list. */
  candidates(limit: number): Promise<FounderCandidates>;
  founder(userId: string): Promise<Founder | null>;
  founderByStopToken(token: string): Promise<Founder | null>;
  list(limit: number): Promise<FounderRow[]>;
  /** Founders still owed their email (not sent, not claimed, not skipped, under `maxTries`), oldest first. */
  unsent(limit: number, maxTries: number): Promise<FounderMail[]>;
  claimMail(userId: string, now: Date): Promise<boolean>;
  mailSent(userId: string, now: Date): Promise<void>;
  /** The mail service refused it: the claim is given back and the try counted. */
  mailFailed(userId: string, error: string): Promise<void>;
  /** It will not be sent. True the first time. */
  mailSkipped(userId: string, why: 'stopped' | 'no_email', now: Date): Promise<boolean>;
  /** Give the refused sends their tries back (the admin's "Send now"). Never touches a sent or claimed row. */
  retryFailed(): Promise<number>;
  /** This account wants no emails of this kind. */
  stopMail(userId: string, now: Date, via: string): Promise<void>;
  mailStopped(userId: string): Promise<boolean>;
}

const newStopToken = (): string => randomBytes(24).toString('base64url');
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

/** An account as the memory store needs to see it. */
export interface LaunchAccount {
  username: string;
  email: string | null;
  verified: boolean;
}

// ---------------------------------------------------------------- memory ---

export class MemoryLaunchRepository implements LaunchRepository {
  private at: string | null = null;
  private founders = new Map<string, Founder>();
  private stops = new Set<string>();

  /** `pro` holds the two lists; `accountOf` reads an account as it stands now (null: deleted). */
  constructor(private readonly pro: MemoryProRepository, private readonly accountOf: (userId: string) => LaunchAccount | null) {}

  private eligible(): { userId: string; source: FounderSource }[] {
    const notify = new Set(this.pro.notifyIds());
    const price = new Set(this.pro.priceUserIds());
    const out: { userId: string; source: FounderSource }[] = [];
    for (const id of new Set([...notify, ...price])) {
      const a = this.accountOf(id);
      if (!a || !a.email || !a.verified) continue;
      out.push({ userId: id, source: notify.has(id) && price.has(id) ? 'both' : notify.has(id) ? 'notify' : 'price' });
    }
    return out;
  }

  async launch(): Promise<{ launchedAt: string } | null> {
    return this.at ? { launchedAt: this.at } : null;
  }

  async begin(now: Date): Promise<{ first: boolean; launchedAt: string; founders: number }> {
    // No await before the moment is set: a second call in the same tick finds it recorded.
    if (this.at) return { first: false, launchedAt: this.at, founders: this.founders.size };
    this.at = now.toISOString();
    for (const e of this.eligible()) {
      this.founders.set(e.userId, {
        userId: e.userId, source: e.source, createdAt: this.at, mailClaimedAt: null, mailSentAt: null, mailTries: 0, mailError: null,
        mailSkip: null, stopToken: newStopToken(), bonusOrderId: null, bonusAt: null,
      });
    }
    return { first: true, launchedAt: this.at, founders: this.founders.size };
  }

  async candidates(limit: number): Promise<FounderCandidates> {
    const all = this.eligible();
    return {
      total: all.length,
      notify: all.filter((e) => e.source === 'notify').length,
      price: all.filter((e) => e.source === 'price').length,
      both: all.filter((e) => e.source === 'both').length,
      rows: all.slice(0, limit).map((e) => ({ username: this.accountOf(e.userId)?.username ?? null, source: e.source })),
    };
  }

  async founder(userId: string): Promise<Founder | null> {
    const f = this.founders.get(userId);
    return f ? { ...f } : null;
  }

  async founderByStopToken(token: string): Promise<Founder | null> {
    const f = [...this.founders.values()].find((x) => x.stopToken === token);
    return f ? { ...f } : null;
  }

  async list(limit: number): Promise<FounderRow[]> {
    return [...this.founders.values()].slice(0, limit).map((f) => ({ ...f, username: this.accountOf(f.userId)?.username ?? null }));
  }

  async unsent(limit: number, maxTries: number): Promise<FounderMail[]> {
    return [...this.founders.values()]
      .filter((f) => !f.mailSentAt && !f.mailClaimedAt && !f.mailSkip && f.mailTries < maxTries)
      .slice(0, limit)
      .map((f) => {
        const a = this.accountOf(f.userId);
        return { userId: f.userId, username: a?.username ?? null, email: a?.email ?? null, verified: !!a?.verified, stopToken: f.stopToken };
      });
  }

  async claimMail(userId: string, now: Date): Promise<boolean> {
    const f = this.founders.get(userId);
    // Decided with no await before it: a second claim in the same tick sees it taken.
    if (!f || f.mailSentAt || f.mailClaimedAt || f.mailSkip) return false;
    f.mailClaimedAt = now.toISOString();
    return true;
  }

  async mailSent(userId: string, now: Date): Promise<void> {
    const f = this.founders.get(userId);
    if (f) f.mailSentAt = now.toISOString();
  }

  async mailFailed(userId: string, error: string): Promise<void> {
    const f = this.founders.get(userId);
    if (!f || f.mailSentAt) return;
    f.mailClaimedAt = null;
    f.mailTries++;
    f.mailError = error.slice(0, 200);
  }

  async mailSkipped(userId: string, why: 'stopped' | 'no_email', _now: Date): Promise<boolean> {
    const f = this.founders.get(userId);
    if (!f || f.mailSentAt || f.mailClaimedAt || f.mailSkip) return false;
    f.mailSkip = why;
    return true;
  }

  async retryFailed(): Promise<number> {
    let n = 0;
    for (const f of this.founders.values()) {
      if (!f.mailSentAt && !f.mailClaimedAt && !f.mailSkip && f.mailTries > 0) {
        f.mailTries = 0;
        n++;
      }
    }
    return n;
  }

  async stopMail(userId: string, _now: Date, _via: string): Promise<void> {
    this.stops.add(userId);
  }

  async mailStopped(userId: string): Promise<boolean> {
    return this.stops.has(userId);
  }

  /**
   * Take the founders bonus for an order, once per account, ever. What the
   * memory payment store calls while it marks the order paid; no await, so
   * two orders of one founder paid in the same tick give one bonus.
   */
  claimBonus(userId: string, orderId: string, now: Date): boolean {
    const f = this.founders.get(userId);
    if (!f || f.bonusOrderId) return false;
    f.bonusOrderId = orderId;
    f.bonusAt = now.toISOString();
    return true;
  }

  /** An account deleted (the tests' stand-in for ON DELETE CASCADE). */
  forgetUser(userId: string): void {
    this.founders.delete(userId);
    this.stops.delete(userId);
  }
}

/**
 * The memory launch store beside a memory payment store, joined the way the
 * two Postgres stores are joined by the database: the payment store asks this
 * one for the founders bonus while it marks an order paid.
 */
export function memoryLaunch(
  pro: MemoryProRepository,
  pay: { founders: { claimBonus(userId: string, orderId: string, now: Date): boolean } | null },
  accountOf: (userId: string) => LaunchAccount | null,
): MemoryLaunchRepository {
  const repo = new MemoryLaunchRepository(pro, accountOf);
  pay.founders = repo;
  return repo;
}

// -------------------------------------------------------------- postgres ---

const FOUNDER_COLS =
  'f.user_id, f.source, f.created_at, f.mail_claimed_at, f.mail_sent_at, f.mail_tries, f.mail_error, f.mail_skip, f.stop_token, f.bonus_order_id, f.bonus_at';

function rowToFounder(r: Record<string, unknown>): Founder {
  return {
    userId: String(r.user_id),
    source: r.source === 'notify' || r.source === 'price' ? r.source : 'both',
    createdAt: iso(r.created_at as string)!,
    mailClaimedAt: iso(r.mail_claimed_at as string | null),
    mailSentAt: iso(r.mail_sent_at as string | null),
    mailTries: Number(r.mail_tries ?? 0),
    mailError: r.mail_error == null ? null : String(r.mail_error),
    mailSkip: r.mail_skip === 'stopped' || r.mail_skip === 'no_email' ? r.mail_skip : null,
    stopToken: String(r.stop_token),
    bonusOrderId: r.bonus_order_id == null ? null : String(r.bonus_order_id),
    bonusAt: iso(r.bonus_at as string | null),
  };
}

/**
 * The accounts that count as founders, as one SELECT: a verified email, and
 * on the "tell me" list, or with an answer to the price question given while
 * signed in. Each account once, with how it got there.
 */
const ELIGIBLE = `
  SELECT u.id AS user_id, u.username,
         CASE WHEN n.user_id IS NOT NULL AND p.user_id IS NOT NULL THEN 'both'
              WHEN n.user_id IS NOT NULL THEN 'notify' ELSE 'price' END AS source
  FROM users u
  LEFT JOIN pro_notify n ON n.user_id = u.id
  LEFT JOIN (SELECT DISTINCT user_id FROM pro_price_answers WHERE user_id IS NOT NULL) p ON p.user_id = u.id
  WHERE u.email IS NOT NULL AND u.email_verified_at IS NOT NULL AND (n.user_id IS NOT NULL OR p.user_id IS NOT NULL)`;

export class PgLaunchRepository implements LaunchRepository {
  constructor(private readonly pool: pg.Pool) {}

  async launch(): Promise<{ launchedAt: string } | null> {
    const r = await this.pool.query('SELECT launched_at FROM pro_launch WHERE id');
    return r.rows[0] ? { launchedAt: iso(r.rows[0].launched_at as string)! } : null;
  }

  async begin(now: Date): Promise<{ first: boolean; launchedAt: string; founders: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The one row: of two servers at once, one inserts it and the other waits here, then inserts nothing.
      const made = await client.query('INSERT INTO pro_launch (id, launched_at) VALUES (true, $1) ON CONFLICT (id) DO NOTHING RETURNING launched_at', [now]);
      const first = (made.rowCount ?? 0) > 0;
      let founders = 0;
      if (first) {
        const ins = await client.query(
          `INSERT INTO pro_founders (user_id, source, created_at, stop_token)
           SELECT e.user_id, e.source, $1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
           FROM (${ELIGIBLE}) e
           ON CONFLICT (user_id) DO NOTHING`,
          [now],
        );
        founders = ins.rowCount ?? 0;
      }
      await client.query('COMMIT');
      const at = first ? iso(made.rows[0].launched_at as string)! : (await this.launch())!.launchedAt;
      if (!first) founders = Number((await this.pool.query('SELECT count(*)::int AS n FROM pro_founders')).rows[0]?.n ?? 0);
      return { first, launchedAt: at, founders };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async candidates(limit: number): Promise<FounderCandidates> {
    const [c, rows] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE source = 'notify')::int AS notify,
                count(*) FILTER (WHERE source = 'price')::int AS price, count(*) FILTER (WHERE source = 'both')::int AS both
         FROM (${ELIGIBLE}) e`,
      ),
      this.pool.query(`SELECT e.username, e.source FROM (${ELIGIBLE}) e ORDER BY e.username LIMIT $1`, [limit]),
    ]);
    const x = c.rows[0] ?? {};
    return {
      total: Number(x.total ?? 0), notify: Number(x.notify ?? 0), price: Number(x.price ?? 0), both: Number(x.both ?? 0),
      rows: rows.rows.map((r) => ({ username: r.username ? String(r.username) : null, source: (r.source === 'notify' || r.source === 'price' ? r.source : 'both') as FounderSource })),
    };
  }

  async founder(userId: string): Promise<Founder | null> {
    const r = await this.pool.query(`SELECT ${FOUNDER_COLS} FROM pro_founders f WHERE f.user_id = $1`, [userId]);
    return r.rows[0] ? rowToFounder(r.rows[0]) : null;
  }

  async founderByStopToken(token: string): Promise<Founder | null> {
    const r = await this.pool.query(`SELECT ${FOUNDER_COLS} FROM pro_founders f WHERE f.stop_token = $1`, [token]);
    return r.rows[0] ? rowToFounder(r.rows[0]) : null;
  }

  async list(limit: number): Promise<FounderRow[]> {
    const r = await this.pool.query(
      `SELECT ${FOUNDER_COLS}, u.username FROM pro_founders f LEFT JOIN users u ON u.id = f.user_id ORDER BY u.username LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ ...rowToFounder(x), username: x.username ? String(x.username) : null }));
  }

  async unsent(limit: number, maxTries: number): Promise<FounderMail[]> {
    const r = await this.pool.query(
      `SELECT f.user_id, f.stop_token, u.username, u.email, u.email_verified_at IS NOT NULL AS verified
       FROM pro_founders f JOIN users u ON u.id = f.user_id
       WHERE f.mail_sent_at IS NULL AND f.mail_claimed_at IS NULL AND f.mail_skip IS NULL AND f.mail_tries < $2
       ORDER BY f.mail_tries, f.created_at, f.user_id LIMIT $1`,
      [limit, maxTries],
    );
    return r.rows.map((x) => ({
      userId: String(x.user_id), username: x.username ? String(x.username) : null, email: x.email ? String(x.email) : null,
      verified: x.verified === true, stopToken: String(x.stop_token),
    }));
  }

  async claimMail(userId: string, now: Date): Promise<boolean> {
    // One UPDATE: of any number of callers at once, the row changes for one.
    const r = await this.pool.query(
      `UPDATE pro_founders SET mail_claimed_at = $2 WHERE user_id = $1 AND mail_claimed_at IS NULL AND mail_sent_at IS NULL AND mail_skip IS NULL`,
      [userId, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async mailSent(userId: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE pro_founders SET mail_sent_at = $2, mail_error = NULL WHERE user_id = $1', [userId, now]);
  }

  async mailFailed(userId: string, error: string): Promise<void> {
    await this.pool.query(
      'UPDATE pro_founders SET mail_claimed_at = NULL, mail_tries = mail_tries + 1, mail_error = $2 WHERE user_id = $1 AND mail_sent_at IS NULL',
      [userId, error.slice(0, 200)],
    );
  }

  async mailSkipped(userId: string, why: 'stopped' | 'no_email', _now: Date): Promise<boolean> {
    const r = await this.pool.query(
      'UPDATE pro_founders SET mail_skip = $2 WHERE user_id = $1 AND mail_sent_at IS NULL AND mail_claimed_at IS NULL AND mail_skip IS NULL',
      [userId, why],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async retryFailed(): Promise<number> {
    const r = await this.pool.query(
      'UPDATE pro_founders SET mail_tries = 0 WHERE mail_sent_at IS NULL AND mail_claimed_at IS NULL AND mail_skip IS NULL AND mail_tries > 0',
    );
    return r.rowCount ?? 0;
  }

  async stopMail(userId: string, now: Date, via: string): Promise<void> {
    await this.pool.query('INSERT INTO pro_mail_stops (user_id, created_at, via) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING', [userId, now, via.slice(0, 40)]);
  }

  async mailStopped(userId: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM pro_mail_stops WHERE user_id = $1', [userId]);
    return r.rows.length > 0;
  }
}
