/**
 * Storage for the security operations (SOC) view on /admin.
 *
 * THREE TABLES, ALL SMALL BY CONSTRUCTION
 *   soc_events  counts, not rows per request. One row per minute per
 *               (kind, source, route, account), so a flood of ten thousand
 *               failed logins from one address in a minute is one row with
 *               count = 10000. An attack cannot turn this table into the
 *               denial of service it is recording.
 *   soc_audit   one row per admin action (sign-in, takedown, review, test
 *               email). Rare by nature.
 *   soc_alerts  one row per alert email decided, sent or not. Also what keeps
 *               "at most one email per alert type per hour" true across a
 *               restart or a deploy.
 *
 * WHAT IS NEVER STORED
 *   No IP address. `source` is a keyed hash of the address (see soc.ts): the
 *   key lives in the environment or only in memory, never in this database,
 *   so reading these tables does not reveal who anyone is. No user agent, no
 *   query string, no request body. `subject` is a public @username, and only
 *   when a request named an account that exists.
 *
 * Everything is kept for RETENTION_DAYS and then deleted by purge().
 *
 * Same shape as the other repositories: an interface, an in-memory version for
 * development and tests, and a Postgres version. Queries degrade to empty
 * answers rather than breaking the dashboard.
 */
import type pg from 'pg';

export const RETENTION_DAYS = 30;

export const SOC_KINDS = [
  'login_failed',
  'login_ok',
  'register_conflict',
  'reset_requested',
  'code_failed',
  'code_exhausted',
  'mail_refused',
  'password_change_failed',
  'admin_unlock_failed',
  'admin_denied',
  'rate_limited',
  'oversized_body',
  'scanner_probe',
  'bot_trap',
  'upload_refused',
  'server_error',
  // Signing in with a provider. A refused link is the interesting one: it is
  // what an attacker sees when they have pre-registered someone else's address
  // and the victim then signs in with Google.
  'oauth_linked',
  'oauth_link_refused',
] as const;
export type SocKind = (typeof SOC_KINDS)[number];

export type SocCategory = 'signin' | 'admin' | 'abuse' | 'errors' | 'normal';

/** Which panel a kind belongs to. login_ok is context, not an attack. */
export const SOC_CATEGORY: Readonly<Record<SocKind, SocCategory>> = {
  login_failed: 'signin',
  login_ok: 'normal',
  register_conflict: 'signin',
  reset_requested: 'signin',
  code_failed: 'signin',
  code_exhausted: 'signin',
  mail_refused: 'signin',
  password_change_failed: 'signin',
  admin_unlock_failed: 'admin',
  admin_denied: 'admin',
  rate_limited: 'abuse',
  oversized_body: 'abuse',
  scanner_probe: 'abuse',
  bot_trap: 'abuse',
  upload_refused: 'abuse',
  server_error: 'errors',
  oauth_linked: 'normal',
  oauth_link_refused: 'signin',
};

export function isSocKind(v: unknown): v is SocKind {
  return typeof v === 'string' && (SOC_KINDS as readonly string[]).includes(v);
}

/** One aggregated count: how many times `kind` happened in this minute. */
export interface SocEventRow {
  /** Start of the minute, epoch milliseconds. */
  minute: number;
  kind: SocKind;
  /** Keyed hash of the client address, '' when there was none. */
  source: string;
  /** The route pattern (/api/auth/login), never a query string. */
  route: string;
  /** A public @username the request named, or ''. */
  subject: string;
  count: number;
}

export interface SocAuditInput {
  at?: Date;
  actor: string;
  action: string;
  target: string | null;
  outcome: 'ok' | 'denied' | 'failed';
  source: string;
  detail: Record<string, string | number | boolean | null> | null;
}
export interface SocAuditRow extends Omit<SocAuditInput, 'at'> {
  id: string;
  at: string;
}

export interface SocAlertInput {
  at?: Date;
  rule: string;
  count: number;
  windowMin: number;
  delivered: boolean;
  error: string | null;
  summary: string;
}
export interface SocAlertRow extends Omit<SocAlertInput, 'at'> {
  id: string;
  at: string;
}

export interface KindTotals {
  kind: SocKind;
  day: number;
  week: number;
  month: number;
}
export interface SocSummary {
  totals: KindTotals[];
  /** Last 48 hours, one entry per hour that had anything, by category. */
  hourly: { hour: string; signin: number; admin: number; abuse: number; errors: number }[];
  /** Last 30 days, by category. */
  daily: { day: string; signin: number; admin: number; abuse: number; errors: number }[];
  /** Busiest hashed sources in the last 24 hours (attacks only, not login_ok). */
  topSources: { source: string; total: number; kinds: SocKind[] }[];
  /** Accounts with the most failed sign-ins in the last 7 days. */
  topSubjects: { subject: string; failures: number; sources: number }[];
  /** Routes that refused the most requests in the last 24 hours. */
  topRoutes: { kind: SocKind; route: string; total: number }[];
}

export interface SocRepository {
  addEvents(rows: SocEventRow[]): Promise<void>;
  summary(now?: Date): Promise<SocSummary>;
  addAudit(entry: SocAuditInput): Promise<void>;
  listAudit(limit: number): Promise<SocAuditRow[]>;
  addAlert(alert: SocAlertInput): Promise<void>;
  /** Alerts decided since `since`, newest first. */
  alertsSince(since: Date): Promise<SocAlertRow[]>;
  listAlerts(limit: number): Promise<SocAlertRow[]>;
  /** Delete everything older than the retention window. Returns rows removed. */
  purge(now?: Date): Promise<number>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ATTACK = (k: SocKind): boolean => SOC_CATEGORY[k] !== 'normal';

const emptySummary = (): SocSummary => ({ totals: [], hourly: [], daily: [], topSources: [], topSubjects: [], topRoutes: [] });

type Cats = { signin: number; admin: number; abuse: number; errors: number };
const zeroCats = (): Cats => ({ signin: 0, admin: 0, abuse: 0, errors: 0 });
const addCat = (c: Cats, kind: SocKind, n: number): void => {
  const cat = SOC_CATEGORY[kind];
  if (cat !== 'normal') c[cat] += n;
};

/** Routes worth listing under "what was refused". */
const REFUSAL_KINDS: SocKind[] = ['rate_limited', 'oversized_body', 'admin_denied', 'scanner_probe', 'upload_refused'];

// ============ in memory ============

export class MemorySocRepository implements SocRepository {
  private events = new Map<string, SocEventRow>();
  private audit: (SocAuditRow & { t: number })[] = [];
  private alerts: (SocAlertRow & { t: number })[] = [];
  private seq = 0;

  async addEvents(rows: SocEventRow[]): Promise<void> {
    for (const r of rows) {
      const key = `${r.minute}|${r.kind}|${r.source}|${r.route}|${r.subject}`;
      const have = this.events.get(key);
      if (have) have.count += r.count;
      else this.events.set(key, { ...r });
    }
  }

  async summary(now: Date = new Date()): Promise<SocSummary> {
    const t = now.getTime();
    const totals = new Map<SocKind, KindTotals>();
    const hourly = new Map<string, Cats>();
    const daily = new Map<string, Cats>();
    const sources = new Map<string, { total: number; kinds: Set<SocKind> }>();
    const subjects = new Map<string, { failures: number; sources: Set<string> }>();
    const routes = new Map<string, { kind: SocKind; route: string; total: number }>();
    for (const r of this.events.values()) {
      const age = t - r.minute;
      if (age > RETENTION_DAYS * DAY || age < -HOUR) continue;
      const tot = totals.get(r.kind) ?? { kind: r.kind, day: 0, week: 0, month: 0 };
      tot.month += r.count;
      if (age <= 7 * DAY) tot.week += r.count;
      if (age <= DAY) tot.day += r.count;
      totals.set(r.kind, tot);
      const dayKey = new Date(r.minute).toISOString().slice(0, 10);
      const d = daily.get(dayKey) ?? zeroCats();
      addCat(d, r.kind, r.count);
      daily.set(dayKey, d);
      if (age <= 48 * HOUR) {
        const hourKey = new Date(Math.floor(r.minute / HOUR) * HOUR).toISOString();
        const h = hourly.get(hourKey) ?? zeroCats();
        addCat(h, r.kind, r.count);
        hourly.set(hourKey, h);
      }
      if (age <= DAY && r.source && ATTACK(r.kind)) {
        const s = sources.get(r.source) ?? { total: 0, kinds: new Set<SocKind>() };
        s.total += r.count;
        s.kinds.add(r.kind);
        sources.set(r.source, s);
      }
      if (age <= 7 * DAY && r.kind === 'login_failed' && r.subject) {
        const s = subjects.get(r.subject) ?? { failures: 0, sources: new Set<string>() };
        s.failures += r.count;
        if (r.source) s.sources.add(r.source);
        subjects.set(r.subject, s);
      }
      if (age <= DAY && r.route && REFUSAL_KINDS.includes(r.kind)) {
        const key = `${r.kind}|${r.route}`;
        const x = routes.get(key) ?? { kind: r.kind, route: r.route, total: 0 };
        x.total += r.count;
        routes.set(key, x);
      }
    }
    return {
      totals: [...totals.values()],
      hourly: [...hourly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, c]) => ({ hour, ...c })),
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c })),
      topSources: [...sources.entries()]
        .map(([source, s]) => ({ source, total: s.total, kinds: [...s.kinds].sort() }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
      topSubjects: [...subjects.entries()]
        .map(([subject, s]) => ({ subject, failures: s.failures, sources: s.sources.size }))
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 10),
      topRoutes: [...routes.values()].sort((a, b) => b.total - a.total).slice(0, 15),
    };
  }

  async addAudit(entry: SocAuditInput): Promise<void> {
    const at = entry.at ?? new Date();
    this.audit.push({ ...entry, id: String(++this.seq), at: at.toISOString(), t: at.getTime() });
  }

  async listAudit(limit: number): Promise<SocAuditRow[]> {
    return this.audit.slice().sort((a, b) => b.t - a.t).slice(0, limit).map(({ t: _t, ...row }) => row);
  }

  async addAlert(alert: SocAlertInput): Promise<void> {
    const at = alert.at ?? new Date();
    this.alerts.push({ ...alert, id: String(++this.seq), at: at.toISOString(), t: at.getTime() });
  }

  async alertsSince(since: Date): Promise<SocAlertRow[]> {
    return this.alerts
      .filter((a) => a.t >= since.getTime())
      .sort((a, b) => b.t - a.t)
      .map(({ t: _t, ...row }) => row);
  }

  async listAlerts(limit: number): Promise<SocAlertRow[]> {
    return this.alerts.slice().sort((a, b) => b.t - a.t).slice(0, limit).map(({ t: _t, ...row }) => row);
  }

  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = now.getTime() - RETENTION_DAYS * DAY;
    let removed = 0;
    for (const [k, r] of this.events) {
      if (r.minute < cutoff) {
        this.events.delete(k);
        removed++;
      }
    }
    const keepAudit = this.audit.filter((a) => a.t >= cutoff);
    const keepAlerts = this.alerts.filter((a) => a.t >= cutoff);
    removed += this.audit.length - keepAudit.length + this.alerts.length - keepAlerts.length;
    this.audit = keepAudit;
    this.alerts = keepAlerts;
    return removed;
  }
}

// ============ Postgres ============

export class PgSocRepository implements SocRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent, like the other tables that bootstrap on boot. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS soc_events (
        minute  TIMESTAMPTZ NOT NULL,
        kind    TEXT NOT NULL,
        source  TEXT NOT NULL DEFAULT '',
        route   TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        count   INTEGER NOT NULL,
        PRIMARY KEY (minute, kind, source, route, subject)
      )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS soc_events_minute_idx ON soc_events (minute DESC)');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS soc_audit (
        id      BIGSERIAL PRIMARY KEY,
        at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor   TEXT NOT NULL,
        action  TEXT NOT NULL,
        target  TEXT,
        outcome TEXT NOT NULL,
        source  TEXT NOT NULL DEFAULT '',
        detail  JSONB
      )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS soc_audit_at_idx ON soc_audit (at DESC)');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS soc_alerts (
        id         BIGSERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        rule       TEXT NOT NULL,
        count      INTEGER NOT NULL,
        window_min INTEGER NOT NULL,
        delivered  BOOLEAN NOT NULL,
        error      TEXT,
        summary    TEXT NOT NULL DEFAULT ''
      )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS soc_alerts_at_idx ON soc_alerts (at DESC)');
  }

  async addEvents(rows: SocEventRow[]): Promise<void> {
    if (!rows.length) return;
    // One statement for the whole batch. The caller never sends the same key
    // twice in one batch, which ON CONFLICT DO UPDATE requires.
    await this.pool.query(
      `INSERT INTO soc_events (minute, kind, source, route, subject, count)
       SELECT to_timestamp(m / 1000.0), k, s, r, sub, c
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[]) AS t(m, k, s, r, sub, c)
       ON CONFLICT (minute, kind, source, route, subject)
       DO UPDATE SET count = soc_events.count + EXCLUDED.count`,
      [
        rows.map((r) => r.minute),
        rows.map((r) => r.kind),
        rows.map((r) => r.source),
        rows.map((r) => r.route),
        rows.map((r) => r.subject),
        rows.map((r) => Math.min(r.count, 2_000_000_000)),
      ],
    );
  }

  async summary(now: Date = new Date()): Promise<SocSummary> {
    const t = now.getTime();
    const day = new Date(t - DAY);
    const week = new Date(t - 7 * DAY);
    const month = new Date(t - RETENTION_DAYS * DAY);
    const twoDays = new Date(t - 48 * HOUR);
    try {
      const [totals, hourly, daily, sources, subjects, routes] = await Promise.all([
        this.pool.query(
          `SELECT kind,
                  COALESCE(SUM(count) FILTER (WHERE minute >= $1), 0)::bigint AS day,
                  COALESCE(SUM(count) FILTER (WHERE minute >= $2), 0)::bigint AS week,
                  COALESCE(SUM(count), 0)::bigint AS month
             FROM soc_events WHERE minute >= $3 GROUP BY kind`,
          [day, week, month],
        ),
        this.pool.query(
          `SELECT date_trunc('hour', minute AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour, kind, SUM(count)::bigint AS n
             FROM soc_events WHERE minute >= $1 GROUP BY 1, 2`,
          [twoDays],
        ),
        this.pool.query(
          `SELECT to_char(minute AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, SUM(count)::bigint AS n
             FROM soc_events WHERE minute >= $1 GROUP BY 1, 2`,
          [month],
        ),
        this.pool.query(
          `SELECT source, SUM(count)::bigint AS total, array_agg(DISTINCT kind) AS kinds
             FROM soc_events
            WHERE minute >= $1 AND source <> '' AND kind <> 'login_ok'
            GROUP BY source ORDER BY total DESC LIMIT 10`,
          [day],
        ),
        this.pool.query(
          `SELECT subject, SUM(count)::bigint AS failures, COUNT(DISTINCT NULLIF(source, ''))::int AS sources
             FROM soc_events
            WHERE minute >= $1 AND kind = 'login_failed' AND subject <> ''
            GROUP BY subject ORDER BY failures DESC LIMIT 10`,
          [week],
        ),
        this.pool.query(
          `SELECT kind, route, SUM(count)::bigint AS total
             FROM soc_events
            WHERE minute >= $1 AND route <> '' AND kind = ANY($2::text[])
            GROUP BY kind, route ORDER BY total DESC LIMIT 15`,
          [day, REFUSAL_KINDS],
        ),
      ]);
      const byHour = new Map<string, Cats>();
      for (const r of hourly.rows as { hour: Date; kind: string; n: string }[]) {
        if (!isSocKind(r.kind)) continue;
        const key = new Date(r.hour).toISOString();
        const c = byHour.get(key) ?? zeroCats();
        addCat(c, r.kind, Number(r.n));
        byHour.set(key, c);
      }
      const byDay = new Map<string, Cats>();
      for (const r of daily.rows as { day: string; kind: string; n: string }[]) {
        if (!isSocKind(r.kind)) continue;
        const c = byDay.get(r.day) ?? zeroCats();
        addCat(c, r.kind, Number(r.n));
        byDay.set(r.day, c);
      }
      return {
        totals: (totals.rows as { kind: string; day: string; week: string; month: string }[])
          .filter((r) => isSocKind(r.kind))
          .map((r) => ({ kind: r.kind as SocKind, day: Number(r.day), week: Number(r.week), month: Number(r.month) })),
        hourly: [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, c]) => ({ hour, ...c })),
        daily: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => ({ day: d, ...c })),
        topSources: (sources.rows as { source: string; total: string; kinds: string[] }[]).map((r) => ({
          source: r.source,
          total: Number(r.total),
          kinds: (r.kinds ?? []).filter(isSocKind).sort(),
        })),
        topSubjects: (subjects.rows as { subject: string; failures: string; sources: number }[]).map((r) => ({
          subject: r.subject,
          failures: Number(r.failures),
          sources: Number(r.sources),
        })),
        topRoutes: (routes.rows as { kind: string; route: string; total: string }[])
          .filter((r) => isSocKind(r.kind))
          .map((r) => ({ kind: r.kind as SocKind, route: r.route, total: Number(r.total) })),
      };
    } catch {
      return emptySummary();
    }
  }

  async addAudit(entry: SocAuditInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO soc_audit (at, actor, action, target, outcome, source, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.at ?? new Date(), entry.actor, entry.action, entry.target, entry.outcome, entry.source, entry.detail ? JSON.stringify(entry.detail) : null],
    );
  }

  async listAudit(limit: number): Promise<SocAuditRow[]> {
    try {
      const res = await this.pool.query(
        `SELECT id, at, actor, action, target, outcome, source, detail FROM soc_audit ORDER BY at DESC LIMIT $1`,
        [limit],
      );
      return (res.rows as { id: string; at: Date; actor: string; action: string; target: string | null; outcome: SocAuditRow['outcome']; source: string; detail: SocAuditRow['detail'] }[]).map((r) => ({
        id: String(r.id),
        at: new Date(r.at).toISOString(),
        actor: r.actor,
        action: r.action,
        target: r.target,
        outcome: r.outcome,
        source: r.source,
        detail: r.detail,
      }));
    } catch {
      return [];
    }
  }

  async addAlert(alert: SocAlertInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO soc_alerts (at, rule, count, window_min, delivered, error, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [alert.at ?? new Date(), alert.rule, alert.count, alert.windowMin, alert.delivered, alert.error, alert.summary],
    );
  }

  private mapAlerts(rows: unknown[]): SocAlertRow[] {
    return (rows as { id: string; at: Date; rule: string; count: number; window_min: number; delivered: boolean; error: string | null; summary: string }[]).map((r) => ({
      id: String(r.id),
      at: new Date(r.at).toISOString(),
      rule: r.rule,
      count: Number(r.count),
      windowMin: Number(r.window_min),
      delivered: r.delivered,
      error: r.error,
      summary: r.summary,
    }));
  }

  async alertsSince(since: Date): Promise<SocAlertRow[]> {
    const res = await this.pool.query(
      `SELECT id, at, rule, count, window_min, delivered, error, summary FROM soc_alerts WHERE at >= $1 ORDER BY at DESC`,
      [since],
    );
    return this.mapAlerts(res.rows);
  }

  async listAlerts(limit: number): Promise<SocAlertRow[]> {
    try {
      const res = await this.pool.query(
        `SELECT id, at, rule, count, window_min, delivered, error, summary FROM soc_alerts ORDER BY at DESC LIMIT $1`,
        [limit],
      );
      return this.mapAlerts(res.rows);
    } catch {
      return [];
    }
  }

  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
    let removed = 0;
    for (const sql of [
      'DELETE FROM soc_events WHERE minute < $1',
      'DELETE FROM soc_audit WHERE at < $1',
      'DELETE FROM soc_alerts WHERE at < $1',
    ]) {
      const res = await this.pool.query(sql, [cutoff]);
      removed += res.rowCount ?? 0;
    }
    return removed;
  }
}
