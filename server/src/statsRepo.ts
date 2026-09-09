/**
 * Admin analytics — read-only aggregates for the /admin dashboard.
 *
 * Self-contained like stadiumRepo.ts: one interface with a Memory stub (dev) and
 * a Postgres implementation (production). EVERY query is wrapped so a single
 * failure degrades to a zero/empty value instead of failing the whole overview —
 * the dashboard always renders something. No writes and no DDL, so it is
 * completely boot-safe: nothing here runs until an admin opens the dashboard.
 */

import type pg from 'pg';

export interface DayPoint {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface AdminOverview {
  generatedAt: string;
  mode: 'postgres' | 'memory';
  totals: {
    users: number;
    designs: number;
    publicDesigns: number;
    templates: number;
    aiGenerations: number;
    aiUsers: number;
    leads: number;
    photos: number;
    verifiedPhotos: number;
    comments: number;
    follows: number;
    votes: number;
    totalViews: number;
    shares: number;
  };
  recent7d: { signups: number; designs: number; leads: number; aiActiveUsers: number };
  moderation: { openReports: number; unverifiedPhotos: number; pendingStadiums: number; approvedStadiums: number };
  series: { sessions: DayPoint[]; signups: DayPoint[]; designs: DayPoint[] };
  topDesigns: { id: string; title: string; views: number; likeScore: number }[];
  topStadiums: { templateId: string; count: number }[];
}

/**
 * Sharing, aggregated site-wide.
 *
 * Source is the design_shares table, which has been recording every press of a
 * platform button since sharing shipped - so this panel has history behind it
 * rather than starting from the day it was built.
 *
 * Two kinds live in that table and they mean different things:
 *   'share' - somebody pressed a platform button in the share modal. It is an
 *             INTENT: the platform takes over from there and nothing can tell
 *             whether the message was ever sent.
 *   'open'  - somebody arrived on the shared link.
 * Adding them together would be meaningless, so they are kept apart everywhere.
 */
export interface ShareSummary {
  days: number;
  /** Platform buttons pressed in the window. */
  shares: number;
  /** Shared links opened in the window. */
  opens: number;
  /** How many distinct designs were shared at all. */
  designsShared: number;
  /** Presses per destination, most-shared first. */
  platforms: { key: string; shares: number; opens: number }[];
  /** Daily presses and opens, oldest first. */
  daily: { day: string; shares: number; opens: number }[];
  /** The tifos people actually pass around. */
  topDesigns: { id: string; title: string; owner: string | null; shares: number }[];
}

export interface AdminStatsRepository {
  overview(): Promise<AdminOverview>;
  /** Site-wide sharing over the last `days`. */
  shares(days: number): Promise<ShareSummary>;
}

const ZERO_TOTALS: AdminOverview['totals'] = {
  users: 0, designs: 0, publicDesigns: 0, templates: 0, aiGenerations: 0, aiUsers: 0,
  leads: 0, photos: 0, verifiedPhotos: 0, comments: 0, follows: 0, votes: 0, totalViews: 0, shares: 0,
};

/** What the in-memory stats repo needs to aggregate sharing without SQL. */
export interface MemoryShareSource {
  shareLogAll(): { designId: string; title: string; owner: string | null; platform: string; kind: string; at: number }[];
}

/**
 * Dev/in-memory mode has no SQL store, so the overview stays empty-but-valid.
 * Sharing is the exception: the memory design repo keeps a share log, so when
 * one is handed in the Sharing panel works in dev exactly as it does against
 * Postgres. That matters because it is the only way to see the panel render
 * with real numbers before it reaches production.
 */
export class MemoryAdminStatsRepository implements AdminStatsRepository {
  constructor(private readonly source?: MemoryShareSource) {}

  async overview(): Promise<AdminOverview> {
    return {
      generatedAt: new Date().toISOString(),
      mode: 'memory',
      totals: { ...ZERO_TOTALS },
      recent7d: { signups: 0, designs: 0, leads: 0, aiActiveUsers: 0 },
      moderation: { openReports: 0, unverifiedPhotos: 0, pendingStadiums: 0, approvedStadiums: 0 },
      series: { sessions: [], signups: [], designs: [] },
      topDesigns: [],
      topStadiums: [],
    };
  }

  async shares(days: number): Promise<ShareSummary> {
    const out: ShareSummary = {
      days, shares: 0, opens: 0, designsShared: 0, platforms: [], daily: [], topDesigns: [],
    };
    if (!this.source) return out;

    const since = Date.now() - days * 864e5;
    const rows = this.source.shareLogAll().filter((r) => r.at >= since);

    const platform = new Map<string, { shares: number; opens: number }>();
    const daily = new Map<string, { shares: number; opens: number }>();
    const design = new Map<string, { title: string; owner: string | null; shares: number }>();
    const sharedIds = new Set<string>();

    for (const r of rows) {
      const isOpen = r.kind === 'open';
      if (isOpen) out.opens += 1;
      else {
        out.shares += 1;
        sharedIds.add(r.designId);
      }

      const p = platform.get(r.platform) ?? { shares: 0, opens: 0 };
      if (isOpen) p.opens += 1; else p.shares += 1;
      platform.set(r.platform, p);

      const key = new Date(r.at).toISOString().slice(0, 10);
      const d = daily.get(key) ?? { shares: 0, opens: 0 };
      if (isOpen) d.opens += 1; else d.shares += 1;
      daily.set(key, d);

      if (!isOpen) {
        const e = design.get(r.designId) ?? { title: r.title, owner: r.owner, shares: 0 };
        e.shares += 1;
        design.set(r.designId, e);
      }
    }

    out.designsShared = sharedIds.size;
    out.platforms = [...platform.entries()]
      .map(([key, v]) => ({ key, shares: v.shares, opens: v.opens }))
      .sort((a, b) => b.shares - a.shares || b.opens - a.opens)
      .slice(0, 20);
    out.daily = [...daily.entries()]
      .map(([day, v]) => ({ day, shares: v.shares, opens: v.opens }))
      .sort((a, b) => a.day.localeCompare(b.day));
    out.topDesigns = [...design.entries()]
      .map(([id, v]) => ({ id, title: v.title, owner: v.owner, shares: v.shares }))
      .sort((a, b) => b.shares - a.shares)
      .slice(0, 8);
    return out;
  }
}

export class PgAdminStatsRepository implements AdminStatsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Run a query that yields a single numeric scalar; 0 on any failure. */
  private async scalar(sql: string): Promise<number> {
    try {
      const r = await this.pool.query(sql);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) return 0;
      const v = Number(Object.values(row)[0]);
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  /** Run a per-day grouped query (columns: day, count); [] on any failure. */
  private async daily(sql: string): Promise<DayPoint[]> {
    try {
      const r = await this.pool.query(sql);
      return (r.rows as Record<string, unknown>[]).map((row) => ({
        day: String(row.day).slice(0, 10),
        count: Number(row.count) || 0,
      }));
    } catch {
      return [];
    }
  }

  async overview(): Promise<AdminOverview> {
    let totals: AdminOverview['totals'] = { ...ZERO_TOTALS };
    let recent7d = { signups: 0, designs: 0, leads: 0, aiActiveUsers: 0 };
    const moderation = { openReports: 0, unverifiedPhotos: 0, pendingStadiums: 0, approvedStadiums: 0 };

    // Core scalars in one round-trip. Every table referenced here is created by
    // schema.sql on boot, so the combined query is safe in production.
    try {
      const r = await this.pool.query(
        'SELECT ' +
          '(SELECT count(*) FROM users) AS users, ' +
          '(SELECT count(*) FROM designs) AS designs, ' +
          '(SELECT count(*) FROM designs WHERE is_public) AS public_designs, ' +
          '(SELECT count(*) FROM designs WHERE is_template AND is_public) AS templates, ' +
          '(SELECT COALESCE(sum(used),0) FROM ai_usage) AS ai_generations, ' +
          '(SELECT count(*) FROM ai_usage WHERE used > 0) AS ai_users, ' +
          '(SELECT count(*) FROM leads) AS leads, ' +
          '(SELECT count(*) FROM design_photos) AS photos, ' +
          '(SELECT count(*) FROM design_photos WHERE is_verified) AS verified_photos, ' +
          '(SELECT count(*) FROM comments) AS comments, ' +
          '(SELECT count(*) FROM follows) AS follows, ' +
          '(SELECT count(*) FROM design_votes) AS votes, ' +
          '(SELECT COALESCE(sum(view_count),0) FROM designs) AS total_views, ' +
          "(SELECT count(*) FROM design_shares WHERE kind='share') AS shares, " +
          "(SELECT count(*) FROM moderation_reports WHERE status='open') AS open_reports, " +
          '(SELECT count(*) FROM design_photos WHERE NOT is_verified) AS unverified_photos, ' +
          "(SELECT count(*) FROM users WHERE created_at > now() - interval '7 days') AS signups7d, " +
          "(SELECT count(*) FROM designs WHERE created_at > now() - interval '7 days') AS designs7d, " +
          "(SELECT count(*) FROM leads WHERE created_at > now() - interval '7 days') AS leads7d, " +
          "(SELECT count(*) FROM ai_usage WHERE updated_at > now() - interval '7 days') AS ai_active7d",
      );
      const x = (r.rows[0] ?? {}) as Record<string, unknown>;
      const n = (k: string): number => Number(x[k]) || 0;
      totals = {
        users: n('users'), designs: n('designs'), publicDesigns: n('public_designs'), templates: n('templates'),
        aiGenerations: n('ai_generations'), aiUsers: n('ai_users'), leads: n('leads'), photos: n('photos'),
        verifiedPhotos: n('verified_photos'), comments: n('comments'), follows: n('follows'), votes: n('votes'),
        totalViews: n('total_views'), shares: n('shares'),
      };
      recent7d = { signups: n('signups7d'), designs: n('designs7d'), leads: n('leads7d'), aiActiveUsers: n('ai_active7d') };
      moderation.openReports = n('open_reports');
      moderation.unverifiedPhotos = n('unverified_photos');
    } catch {
      /* leave zeros — dashboard still renders */
    }

    // community_stadiums is created best-effort (Wave E), so query it separately
    // to keep a missing table from zeroing everything above.
    moderation.pendingStadiums = await this.scalar("SELECT count(*) FROM community_stadiums WHERE status='pending'");
    moderation.approvedStadiums = await this.scalar("SELECT count(*) FROM community_stadiums WHERE status='approved'");

    const win = "created_at > now() - interval '30 days'";
    const sessions = await this.daily(
      "SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(DISTINCT session_id) AS count " +
        "FROM events WHERE name='landed' AND " + win + ' GROUP BY 1 ORDER BY 1',
    );
    const signups = await this.daily(
      "SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*) AS count " +
        'FROM users WHERE ' + win + ' GROUP BY 1 ORDER BY 1',
    );
    const designsDaily = await this.daily(
      "SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*) AS count " +
        'FROM designs WHERE ' + win + ' GROUP BY 1 ORDER BY 1',
    );

    let topDesigns: AdminOverview['topDesigns'] = [];
    try {
      const r = await this.pool.query(
        'SELECT id, title, view_count, like_score FROM designs WHERE is_public ORDER BY view_count DESC NULLS LAST LIMIT 6',
      );
      topDesigns = (r.rows as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        title: String(row.title ?? 'Untitled'),
        views: Number(row.view_count) || 0,
        likeScore: Number(row.like_score) || 0,
      }));
    } catch {
      topDesigns = [];
    }

    let topStadiums: AdminOverview['topStadiums'] = [];
    try {
      const r = await this.pool.query(
        'SELECT template_id, count(*) AS count FROM designs GROUP BY template_id ORDER BY count DESC LIMIT 8',
      );
      topStadiums = (r.rows as Record<string, unknown>[]).map((row) => ({
        templateId: String(row.template_id),
        count: Number(row.count) || 0,
      }));
    } catch {
      topStadiums = [];
    }

    return {
      generatedAt: new Date().toISOString(),
      mode: 'postgres',
      totals,
      recent7d,
      moderation,
      series: { sessions, signups, designs: designsDaily },
      topDesigns,
      topStadiums,
    };
  }

  /**
   * Sharing over a window. Four independent queries rather than one join, each
   * defensive: a single failure yields an empty section instead of blanking the
   * whole panel, which is the same contract overview() keeps.
   */
  async shares(days: number): Promise<ShareSummary> {
    const out: ShareSummary = {
      days, shares: 0, opens: 0, designsShared: 0, platforms: [], daily: [], topDesigns: [],
    };
    const window = "created_at >= now() - ($1::int * interval '1 day')";

    try {
      const r = await this.pool.query(
        `SELECT count(*) FILTER (WHERE kind = 'share')::int AS shares,
                count(*) FILTER (WHERE kind = 'open')::int  AS opens,
                count(DISTINCT design_id) FILTER (WHERE kind = 'share')::int AS designs_shared
           FROM design_shares WHERE ${window}`,
        [days],
      );
      const x = (r.rows[0] ?? {}) as Record<string, unknown>;
      out.shares = Number(x.shares) || 0;
      out.opens = Number(x.opens) || 0;
      out.designsShared = Number(x.designs_shared) || 0;
    } catch {
      /* keep zeros */
    }

    try {
      const r = await this.pool.query(
        `SELECT platform AS key,
                count(*) FILTER (WHERE kind = 'share')::int AS shares,
                count(*) FILTER (WHERE kind = 'open')::int  AS opens
           FROM design_shares WHERE ${window}
          GROUP BY 1 ORDER BY shares DESC, opens DESC LIMIT 20`,
        [days],
      );
      out.platforms = (r.rows as Record<string, unknown>[]).map((row) => ({
        key: String(row.key), shares: Number(row.shares) || 0, opens: Number(row.opens) || 0,
      }));
    } catch {
      out.platforms = [];
    }

    try {
      const r = await this.pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE kind = 'share')::int AS shares,
                count(*) FILTER (WHERE kind = 'open')::int  AS opens
           FROM design_shares WHERE ${window}
          GROUP BY 1 ORDER BY 1`,
        [days],
      );
      out.daily = (r.rows as Record<string, unknown>[]).map((row) => ({
        day: String(row.day).slice(0, 10), shares: Number(row.shares) || 0, opens: Number(row.opens) || 0,
      }));
    } catch {
      out.daily = [];
    }

    try {
      const r = await this.pool.query(
        `SELECT d.id, d.title, u.username AS owner, count(*)::int AS shares
           FROM design_shares s
           JOIN designs d ON d.id = s.design_id
           LEFT JOIN users u ON u.id = d.owner_id
          WHERE s.kind = 'share' AND s.${window}
          GROUP BY d.id, d.title, u.username
          ORDER BY shares DESC LIMIT 8`,
        [days],
      );
      out.topDesigns = (r.rows as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        title: String(row.title ?? 'Untitled'),
        owner: row.owner == null ? null : String(row.owner),
        shares: Number(row.shares) || 0,
      }));
    } catch {
      out.topDesigns = [];
    }

    return out;
  }
}
