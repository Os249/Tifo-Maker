/**
 * Retention: the sweeps that keep the tables that only grow bounded
 * (performance plan P3.5). Data minimisation is the point; the speed is that
 * each sweep finds what it removes through an index (RETENTION_INDEXES in
 * schema.ts) instead of reading its whole table.
 *
 * Every period here is at least as long as the longest look-back of anything
 * that reads the rows, and of every security control in particular. The
 * periods and that reasoning are written down in SECURITY-CHECKS.md (§9):
 * change one here, change it there.
 *
 * How they run: after listen and every six hours (server.ts), on the
 * maintenance pool, one table at a time. Each works in batches of
 * RETENTION_BATCH rows, each batch its own short transaction with a statement
 * and a lock time limit, and stops once its time budget is spent (the rest
 * waits for the next run). They take row locks on rows nobody else writes
 * (expired, read, months old), so a request never waits on them. Each logs
 * one line. A rollup deletes the raw rows and adds them to its aggregate in
 * one statement: a row is counted once, never twice and never lost.
 *
 * Postgres only. The memory stores are for development and start empty.
 */

/** Rows per batch. */
export const RETENTION_BATCH = 5_000;
/** How long one batch may run before it is cancelled (and retried next run). */
export const RETENTION_STATEMENT_MS = 10_000;
/** How long a batch waits for a row lock before giving up. */
export const RETENTION_LOCK_MS = 2_000;
/** Total time one sweep spends per run. */
export const RETENTION_BUDGET_MS = 30_000;

/**
 * The periods (SECURITY-CHECKS.md §9 has the reasoning for each).
 *
 * READ_NOTIFICATIONS_DAYS: what the plan asked for. Unread ones are kept, and
 * so are `new_follower` and `follow_post` of any age: they are what makes
 * "told once per follower, ever" and "once per design per follower" hold
 * (audit round four, pgSocial.ts), and those look back for ever.
 *
 * RAW_DAYS (ai_events, design_shares): the admin windows reach back 365 days
 * at most (the route clamps ?days), so raw rows are kept 400 and nothing a
 * window shows ever comes from a rollup. The all-time figures add the rollup.
 */
export const RETENTION = {
  READ_NOTIFICATIONS_DAYS: 180,
  RAW_DAYS: 400,
  AI_BUDGET_DAYS: 400,
} as const;
/** Notification kinds a de-duplication check reads; never swept (see above). */
export const DEDUPE_NOTIFICATION_KINDS = ['new_follower', 'follow_post'] as const;
/** The longest window the admin's AI and sharing panels can ask for (routes.ts clamps ?days to this). */
export const ADMIN_WINDOW_MAX_DAYS = 365;

/** A pg client: query and release. */
interface Client {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(destroy?: boolean): void;
}
export interface RetentionPool {
  connect(): Promise<Client>;
}

/** What one sweep did. */
export interface SweepResult {
  job: string;
  removed: number;
  batches: number;
  ms: number;
  /** True when it stopped on its time budget with more left to do. */
  more: boolean;
  error?: string;
}

/**
 * One sweep: a statement removing at most $1 rows, returning how many it
 * removed as `n`. Each finds its batch first (through its index) and then
 * removes those rows by primary key: `= ANY (ARRAY(SELECT …))`, never
 * `IN (SELECT …)`, which the planner answered with a hash join over a scan of
 * the whole table on every batch (measured: 370 ms a batch on 300k visits).
 */
export interface Sweep {
  job: string;
  /** What it keeps and why, for the log line. */
  rule: string;
  sql: string;
  /**
   * Run first, in the same transaction: locks (FOR KEY SHARE, in id order)
   * the rows the batch's rollup will point at. A rollup's foreign key takes
   * that lock anyway, but only after the batch's rows are held, the opposite
   * order to a deletion of the parent (the parent, then its rows by cascade):
   * the two deadlocked, and Postgres cancelled the deletion (measured). With
   * the parents locked first, a deletion waits for the batch, or the batch
   * for the deletion, never both. What it returns (`id`) is the statement's
   * $2: the batch takes only rows whose parent is locked, so a deletion that
   * lands between the two statements cannot slip an unlocked one in.
   */
  lock?: string;
}

/**
 * The start of the UTC day `days` before today, as SQL. Rollups take whole
 * days only, so a day is never split between raw rows and its aggregate.
 */
const dayCutoff = (days: number): string =>
  `((date_trunc('day', now() AT TIME ZONE 'utc') - interval '${Math.floor(days)} days') AT TIME ZONE 'utc')`;

/**
 * A rollup's batch: the oldest rows past the cutoff, in a total order (the id
 * breaks ties), so the lock statement and the batch pick the same rows.
 */
const AI_BATCH = `SELECT id, user_id, outcome FROM ai_events WHERE at < ${dayCutoff(RETENTION.RAW_DAYS)} ORDER BY at, id LIMIT $1`;
const SHARE_BATCH = `SELECT id, design_id FROM design_shares WHERE created_at < ${dayCutoff(RETENTION.RAW_DAYS)} ORDER BY created_at, id LIMIT $1`;

export const SWEEPS: readonly Sweep[] = [
  {
    job: 'auth_tokens',
    rule: 'expired sessions',
    // A session opens nothing once expires_at has passed (getSessionUser);
    // nothing reads an expired row again.
    sql: `WITH gone AS (
            DELETE FROM auth_tokens WHERE token_hash = ANY (ARRAY(
              SELECT token_hash FROM auth_tokens WHERE expires_at < now() LIMIT $1))
            RETURNING 1)
          SELECT count(*)::int AS n FROM gone`,
  },
  {
    job: 'email_tokens',
    rule: 'used or expired links, codes and sign-in tickets',
    // Single use and short-lived (link 24 h, code 10 min, reset 1 h, sign-in
    // ticket 2 min); consuming one requires used_at IS NULL and expires_at in
    // the future, so a used or expired row can never be consumed again.
    sql: `WITH gone AS (
            DELETE FROM email_tokens WHERE token_hash = ANY (ARRAY(
              SELECT token_hash FROM email_tokens WHERE used_at IS NOT NULL OR expires_at < now() LIMIT $1))
            RETURNING 1)
          SELECT count(*)::int AS n FROM gone`,
  },
  {
    job: 'notifications',
    rule: `read and older than ${RETENTION.READ_NOTIFICATIONS_DAYS} days; unread, ${DEDUPE_NOTIFICATION_KINDS.join(' and ')} kept`,
    sql: `WITH gone AS (
            DELETE FROM notifications WHERE id = ANY (ARRAY(
              SELECT id FROM notifications
               WHERE read_at IS NOT NULL AND created_at < now() - interval '${RETENTION.READ_NOTIFICATIONS_DAYS} days'
                 AND kind <> ALL (ARRAY[${DEDUPE_NOTIFICATION_KINDS.map((k) => `'${k}'`).join(', ')}])
               LIMIT $1))
            RETURNING 1)
          SELECT count(*)::int AS n FROM gone`,
  },
  {
    job: 'ai_events',
    rule: `rolled up per day after ${RETENTION.RAW_DAYS} days`,
    // One statement: the raw rows go and their aggregates arrive together.
    // Grouped first, so no upsert meets the same key twice.
    // Only the cap counts point at an account (ai_quota_hits).
    lock: `SELECT u.id FROM users u
            WHERE u.id IN (SELECT b.user_id FROM (${AI_BATCH}) b WHERE b.outcome = 'quota')
            ORDER BY u.id FOR KEY SHARE OF u`,
    sql: `WITH gone AS (
            DELETE FROM ai_events WHERE id = ANY (ARRAY(
              SELECT b.id FROM (${AI_BATCH}) b
               WHERE b.outcome <> 'quota' OR b.user_id IS NULL OR b.user_id = ANY ($2::uuid[])))
            RETURNING user_id, at, mode, outcome, reason, model, latency_ms, tokens_in, tokens_out,
                      tokens_thought, tokens_cached, calls, pictures, cost_micros),
          daily AS (
            INSERT INTO ai_events_daily (day, mode, outcome, reason, model, n, measured, unpriced, cost_micros,
                                         tokens_in, tokens_out, tokens_thought, tokens_cached, pictures,
                                         latency_sum, latency_n, first_at, first_measured_at)
            SELECT to_char(at AT TIME ZONE 'utc', 'YYYY-MM-DD'), mode, outcome, coalesce(reason, ''), coalesce(model, ''),
                   count(*)::int,
                   count(*) FILTER (WHERE calls IS NOT NULL)::int,
                   count(*) FILTER (WHERE calls IS NOT NULL AND cost_micros IS NULL)::int,
                   coalesce(sum(cost_micros) FILTER (WHERE calls IS NOT NULL), 0)::bigint,
                   coalesce(sum(tokens_in), 0)::bigint, coalesce(sum(tokens_out), 0)::bigint,
                   coalesce(sum(tokens_thought), 0)::bigint, coalesce(sum(tokens_cached), 0)::bigint,
                   coalesce(sum(pictures), 0)::int,
                   coalesce(sum(latency_ms) FILTER (WHERE calls IS NOT NULL), 0)::bigint,
                   count(latency_ms) FILTER (WHERE calls IS NOT NULL)::int,
                   min(at), min(at) FILTER (WHERE calls IS NOT NULL)
              FROM gone GROUP BY 1, 2, 3, 4, 5
            ON CONFLICT (day, mode, outcome, reason, model) DO UPDATE SET
              n = ai_events_daily.n + EXCLUDED.n,
              measured = ai_events_daily.measured + EXCLUDED.measured,
              unpriced = ai_events_daily.unpriced + EXCLUDED.unpriced,
              cost_micros = ai_events_daily.cost_micros + EXCLUDED.cost_micros,
              tokens_in = ai_events_daily.tokens_in + EXCLUDED.tokens_in,
              tokens_out = ai_events_daily.tokens_out + EXCLUDED.tokens_out,
              tokens_thought = ai_events_daily.tokens_thought + EXCLUDED.tokens_thought,
              tokens_cached = ai_events_daily.tokens_cached + EXCLUDED.tokens_cached,
              pictures = ai_events_daily.pictures + EXCLUDED.pictures,
              latency_sum = ai_events_daily.latency_sum + EXCLUDED.latency_sum,
              latency_n = ai_events_daily.latency_n + EXCLUDED.latency_n,
              first_at = LEAST(ai_events_daily.first_at, EXCLUDED.first_at),
              first_measured_at = LEAST(ai_events_daily.first_measured_at, EXCLUDED.first_measured_at)
            RETURNING 1),
          hits AS (
            INSERT INTO ai_quota_hits (user_id, times, last_at)
            SELECT user_id, count(*)::int, max(at) FROM gone
             WHERE outcome = 'quota' AND user_id IS NOT NULL GROUP BY user_id
            ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET
              times = ai_quota_hits.times + EXCLUDED.times, last_at = GREATEST(ai_quota_hits.last_at, EXCLUDED.last_at)
            RETURNING 1),
          nobody AS (
            INSERT INTO ai_quota_hits (user_id, times, last_at)
            SELECT NULL::uuid, count(*)::int, max(at) FROM gone WHERE outcome = 'quota' AND user_id IS NULL HAVING count(*) > 0
            ON CONFLICT ((user_id IS NULL)) WHERE user_id IS NULL DO UPDATE SET
              times = ai_quota_hits.times + EXCLUDED.times, last_at = GREATEST(ai_quota_hits.last_at, EXCLUDED.last_at)
            RETURNING 1)
          SELECT (SELECT count(*) FROM gone)::int AS n,
                 (SELECT count(*) FROM daily)::int AS "daily rows written",
                 (SELECT count(*) FROM hits)::int + (SELECT count(*) FROM nobody)::int AS "cap counts written"`,
  },
  {
    job: 'design_shares',
    rule: `rolled up per day after ${RETENTION.RAW_DAYS} days`,
    lock: `SELECT d.id FROM designs d
            WHERE d.id IN (SELECT b.design_id FROM (${SHARE_BATCH}) b)
            ORDER BY d.id FOR KEY SHARE OF d`,
    sql: `WITH gone AS (
            DELETE FROM design_shares WHERE id = ANY (ARRAY(
              SELECT b.id FROM (${SHARE_BATCH}) b WHERE b.design_id = ANY ($2::uuid[])))
            RETURNING design_id, platform, kind, created_at),
          daily AS (
            INSERT INTO design_shares_daily (day, design_id, platform, kind, n)
            SELECT to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD'), design_id, platform, kind, count(*)::int
              FROM gone GROUP BY 1, 2, 3, 4
            ON CONFLICT (design_id, day, platform, kind) DO UPDATE SET n = design_shares_daily.n + EXCLUDED.n
            RETURNING 1)
          SELECT (SELECT count(*) FROM gone)::int AS n, (SELECT count(*) FROM daily)::int AS "daily rows written"`,
  },
  {
    job: 'ai_budget',
    rule: `days older than ${RETENTION.AI_BUDGET_DAYS} (the budget reads today's only)`,
    sql: `WITH gone AS (
            DELETE FROM ai_budget WHERE day = ANY (ARRAY(
              SELECT day FROM ai_budget
               WHERE day < to_char((now() AT TIME ZONE 'utc') - interval '${RETENTION.AI_BUDGET_DAYS} days', 'YYYY-MM-DD') LIMIT $1))
            RETURNING 1)
          SELECT count(*)::int AS n FROM gone`,
  },
];

const isBroken = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && (code.startsWith('08') || code === '57P01');
};

/**
 * Run one sweep to completion or to its budget. Never throws: a failure is
 * reported in the result (and the next run tries again).
 */
export async function runSweep(
  pool: RetentionPool,
  sweep: Pick<Sweep, 'job' | 'sql' | 'lock'>,
  opts: { batch?: number; budgetMs?: number; statementMs?: number; lockMs?: number } = {},
): Promise<SweepResult & { extra: Record<string, number> }> {
  const batch = opts.batch ?? RETENTION_BATCH;
  const budget = opts.budgetMs ?? RETENTION_BUDGET_MS;
  const started = Date.now();
  const out = { job: sweep.job, removed: 0, batches: 0, ms: 0, more: false, extra: {} as Record<string, number> } as SweepResult & { extra: Record<string, number> };
  for (;;) {
    let client: Client | null = null;
    let broken = false;
    let n = 0;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.round(opts.statementMs ?? RETENTION_STATEMENT_MS))}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.round(opts.lockMs ?? RETENTION_LOCK_MS))}ms'`);
      const locked = sweep.lock ? (await client.query(sweep.lock, [batch])).rows.map((x) => String(x.id)) : null;
      const r = await client.query(sweep.sql, locked ? [batch, locked] : [batch]);
      await client.query('COMMIT');
      const row = r.rows[0] ?? {};
      n = Number(row.n ?? 0);
      for (const [k, v] of Object.entries(row)) if (k !== 'n') out.extra[k] = (out.extra[k] ?? 0) + Number(v ?? 0);
    } catch (e) {
      broken = isBroken(e);
      if (client) await client.query('ROLLBACK').catch(() => { broken = true; });
      out.error = (e as Error).message;
      break;
    } finally {
      client?.release(broken);
    }
    out.batches++;
    out.removed += n;
    if (n < batch) break;
    if (Date.now() - started >= budget) {
      out.more = true;
      break;
    }
  }
  out.ms = Date.now() - started;
  return out;
}

/** The one line a sweep logs. */
export function sweepLine(r: SweepResult & { extra?: Record<string, number> }, rule: string): string {
  const extra = r.extra && Object.keys(r.extra).length ? ` (${Object.entries(r.extra).map(([k, v]) => `${v} ${k}`).join(', ')})` : '';
  if (r.error) return `[tifo] retention: ${r.job} (${rule}): stopped after ${r.removed} removed in ${r.ms} ms, tried again next run: ${r.error}`;
  return `[tifo] retention: ${r.job} (${rule}): ${r.removed} removed${extra} in ${r.ms} ms, ${r.batches} batch${r.batches === 1 ? '' : 'es'}${r.more ? ', more next run' : ''}`;
}

/**
 * Every sweep, one after another, then `others` (the purges that live in
 * their own repositories: funnel events, visits, the security log), each
 * logging its one line.
 */
export async function runRetention(
  pool: RetentionPool,
  opts: {
    log?: (line: string) => void;
    batch?: number;
    budgetMs?: number;
    others?: { job: string; rule: string; run: () => Promise<{ removed: number; extra?: Record<string, number>; batches?: number; more?: boolean } | number | void> }[];
  } = {},
): Promise<SweepResult[]> {
  const log = opts.log ?? ((l) => console.log(l));
  const results: SweepResult[] = [];
  for (const s of SWEEPS) {
    const r = await runSweep(pool, s, { batch: opts.batch, budgetMs: opts.budgetMs });
    log(sweepLine(r, s.rule));
    results.push(r);
  }
  for (const o of opts.others ?? []) {
    const started = Date.now();
    try {
      const got = await o.run();
      const removed = typeof got === 'number' ? got : got ? got.removed : 0;
      const r = {
        job: o.job, removed, ms: Date.now() - started,
        batches: typeof got === 'object' && got?.batches != null ? got.batches : 1,
        more: typeof got === 'object' && got?.more === true,
        extra: typeof got === 'object' && got?.extra ? got.extra : {},
      };
      log(sweepLine(r, o.rule));
      results.push(r);
    } catch (e) {
      const r = { job: o.job, removed: 0, batches: 0, ms: Date.now() - started, more: false, error: (e as Error).message };
      log(sweepLine(r, o.rule));
      results.push(r);
    }
  }
  return results;
}

/**
 * The same batch loop for a repository's own delete: `step(limit)` removes
 * at most `limit` rows and says how many. Used by the funnel events and the
 * visits, which keep their purges beside their tables.
 */
export async function inBatches(
  step: (limit: number) => Promise<number>,
  opts: { batch?: number; budgetMs?: number } = {},
): Promise<{ removed: number; batches: number; more: boolean }> {
  const batch = opts.batch ?? RETENTION_BATCH;
  const budget = opts.budgetMs ?? RETENTION_BUDGET_MS;
  const started = Date.now();
  let removed = 0;
  let batches = 0;
  for (;;) {
    const n = await step(batch);
    batches++;
    removed += n;
    if (n < batch) return { removed, batches, more: false };
    if (Date.now() - started >= budget) return { removed, batches, more: true };
  }
}
