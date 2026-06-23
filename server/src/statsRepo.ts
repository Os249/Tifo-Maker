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

export interface AdminStatsRepository {
  overview(): Promise<AdminOverview>;
}

const ZERO_TOTALS: AdminOverview['totals'] = {
  users: 0, designs: 0, publicDesigns: 0, templates: 0, aiGenerations: 0, aiUsers: 0,
  leads: 0, photos: 0, verifiedPhotos: 0, comments: 0, follows: 0, votes: 0, totalViews: 0, shares: 0,
};

/** Dev/in-memory mode has no SQL store; return an empty-but-valid overview. */
export class MemoryAdminStatsRepository implements AdminStatsRepository {
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
}
