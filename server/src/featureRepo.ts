/**
 * Tifo of the day — the record of which published design was on the home page
 * on which day.
 *
 * One row per UTC day. That row is what makes the pick STABLE: everyone who
 * loads the home page that day sees the same tifo, across instances and across
 * restarts, the creator is told exactly once, and the picker can see which
 * designs have already had their turn so nothing repeats while there is still
 * something new to show.
 *
 * `day` is TEXT, not DATE, deliberately: node-pg parses a DATE into a Date at
 * LOCAL midnight, so formatting it back can land on the day before for anyone
 * west of UTC. The value stored here is always the UTC 'YYYY-MM-DD' the picker
 * computed, and it is only ever compared as a string.
 *
 * Self-contained (memory + Postgres) like the stadium and feedback stores, and
 * init() is called BEST-EFFORT at boot: if the table cannot be created the
 * section simply does not appear, which must never be a failed deploy.
 */

import type pg from 'pg';

export interface FeatureRow {
  /** UTC day, 'YYYY-MM-DD'. */
  day: string;
  designId: string;
}

export interface DailyFeatureRepository {
  /**
   * Take `day` for `designId`, unless it is already taken.
   *
   * `inserted` is false when somebody got there first — another instance, or
   * this one before a restart — and `designId` is then whoever actually holds
   * the day. That is what keeps it to one notification per feature however many
   * processes are serving the site.
   */
  claim(day: string, designId: string): Promise<{ designId: string; inserted: boolean }>;
  /**
   * Overwrite a day's pick. Only used when the design holding the day has since
   * been deleted, made private or taken down, so the day goes to a live one.
   */
  replace(day: string, designId: string): Promise<void>;
  /** Days already featured, newest first. One row per day, so this stays small. */
  history(limit?: number): Promise<FeatureRow[]>;
}

export class MemoryDailyFeatureRepository implements DailyFeatureRepository {
  /** day → designId. */
  private readonly days = new Map<string, string>();

  async claim(day: string, designId: string): Promise<{ designId: string; inserted: boolean }> {
    const held = this.days.get(day);
    if (held) return { designId: held, inserted: false };
    this.days.set(day, designId);
    return { designId, inserted: true };
  }

  async replace(day: string, designId: string): Promise<void> {
    this.days.set(day, designId);
  }

  async history(limit = 400): Promise<FeatureRow[]> {
    return [...this.days.entries()]
      .map(([day, designId]) => ({ day, designId }))
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, limit);
  }
}

export class PgDailyFeatureRepository implements DailyFeatureRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent table creation. Called best-effort at boot (must not fail boot). */
  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS daily_features (
         day        TEXT PRIMARY KEY,
         design_id  UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await this.pool.query('CREATE INDEX IF NOT EXISTS daily_features_design_idx ON daily_features (design_id)');
  }

  async claim(day: string, designId: string): Promise<{ designId: string; inserted: boolean }> {
    // ON CONFLICT DO NOTHING is the whole race: two instances picking the same
    // second produce one row, and the loser is told who won rather than getting
    // an error or a second notification out.
    const ins = await this.pool.query(
      `INSERT INTO daily_features (day, design_id) VALUES ($1, $2)
       ON CONFLICT (day) DO NOTHING
       RETURNING design_id`,
      [day, designId],
    );
    if ((ins.rowCount ?? 0) > 0) return { designId: String(ins.rows[0].design_id), inserted: true };
    const held = await this.pool.query('SELECT design_id FROM daily_features WHERE day = $1', [day]);
    return { designId: String(held.rows[0]?.design_id ?? designId), inserted: false };
  }

  async replace(day: string, designId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO daily_features (day, design_id) VALUES ($1, $2)
       ON CONFLICT (day) DO UPDATE SET design_id = EXCLUDED.design_id, created_at = now()`,
      [day, designId],
    );
  }

  async history(limit = 400): Promise<FeatureRow[]> {
    const res = await this.pool.query(
      'SELECT day, design_id FROM daily_features ORDER BY day DESC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => ({ day: String(r.day), designId: String(r.design_id) }));
  }
}
