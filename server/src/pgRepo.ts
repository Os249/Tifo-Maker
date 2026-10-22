import pg from 'pg';
import { aiPeriod, REVISIONS_KEPT } from './repo';
import type {
  AuthRepository,
  AiUsage,
  AiUsageRepository,
  DesignMeta,
  ProjectItem,
  DesignRecord,
  DesignRepository,
  DiffBytes,
  FacetBase,
  FacetScope,
  GalleryItem,
  GalleryQuery,
  Lead,
  LeadsRepository,
  NewDesign,
  AiEventInput,
  AiEventsRepository,
  AiBudgetRepository,
  AiFailReason,
  AiMode,
  AiOutcome,
  AiStats,
  RevisionRow,
  SeedDesign,
  ShareStats,
  UserRow,
  EventsRepository,
  FunnelStep,
  PhotoMeta,
  ReportItem,
  PhotoReviewItem,
} from './repo';
import { normalizeTags } from './memoryRepo';
import { costStats, LIMIT_REASONS, modeOutcomes, type AiGroup } from './aiStats';
import { designFacets } from '../../src/core/facets';

const META_COLS =
  'id, title, title_ar, template_id, template_version, palette, revision_count, is_public, owner_id, created_at, updated_at, description, allow_remix, remixed_from, view_count, pinned, deleted_at, origin, taken_down_at';

function rowToMeta(r: Record<string, unknown>): DesignMeta {
  return {
    id: String(r.id),
    title: String(r.title),
    titleAr: (r.title_ar as string) ?? null,
    templateId: String(r.template_id),
    templateVersion: Number(r.template_version),
    palette: (typeof r.palette === 'string' ? JSON.parse(r.palette) : r.palette) as string[],
    revisionCount: Number(r.revision_count),
    isPublic: Boolean(r.is_public),
    ownerId: r.owner_id ? String(r.owner_id) : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    description: (r.description as string) ?? null,
    allowRemix: r.allow_remix === undefined ? true : r.allow_remix !== false,
    remixedFrom: r.remixed_from ? String(r.remixed_from) : null,
    viewCount: r.view_count == null ? 0 : Number(r.view_count),
    pinned: r.pinned === true,
    deletedAt: r.deleted_at ? new Date(r.deleted_at as string).toISOString() : null,
    origin: (r.origin as string) ?? null,
    takenDown: r.taken_down_at != null,
  };
}

/**
 * The gallery projection, in one place.
 *
 * listPublic and getPublicItem have to agree exactly: the feed and the single
 * design a notification opens are the same card, and the moment they drift the
 * card changes when you arrive at it from a different direction. view_count was
 * missing from the feed's column list for exactly that reason — it is in
 * META_COLS, so `rowToMeta` read `undefined` and every card in the feed showed
 * zero views while /t/:id showed the real number.
 */
/**
 * A card's comment count (performance plan P1.11), counted the way
 * PgSocialRepository.listComments returns the thread: the design's comments
 * joined to their authors. /community used to fetch all 60 threads of a page
 * just to show their lengths. Only ever selected for public designs (every
 * query using it has `d.is_public` in its WHERE), whose threads are public.
 * One index scan per card on comments_design_idx.
 */
const COMMENT_COUNT =
  `(SELECT count(*)::int FROM comments c JOIN users cu ON cu.id = c.author_id WHERE c.design_id = d.id) AS comment_count`;

const GALLERY_COLS =
  `d.id, d.title, d.title_ar, d.template_id, d.template_version, d.palette, d.revision_count,
   d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score, d.is_template,
   d.description, d.allow_remix, d.remixed_from, d.view_count,
   coalesce(u.username, 'unknown') AS owner_name,
   ru.username AS remixed_from_name, rd.title AS remixed_from_title,
   (d.thumbnail IS NOT NULL) AS has_thumbnail,
   coalesce((SELECT array_agg(t.slug ORDER BY t.slug) FROM design_tags dt
             JOIN tags t ON t.id = dt.tag_id WHERE dt.design_id = d.id), '{}') AS tags,
   EXISTS (SELECT 1 FROM design_photos dp WHERE dp.design_id = d.id) AS has_photo,
   ${COMMENT_COUNT}`;

const GALLERY_JOINS =
  `FROM designs d
   LEFT JOIN users u ON u.id = d.owner_id
   LEFT JOIN designs rd ON rd.id = d.remixed_from AND rd.is_public
   LEFT JOIN users ru ON ru.id = rd.owner_id`;
// The source's title and creator only while the source is public: a remix card
// showed the source's CURRENT title after it was made private or taken down,
// so anyone could read a private design's title through it (audit round four).
// \`remixed_from\` (the id) stays, so the lineage is not lost.

function rowToGalleryItem(r: Record<string, unknown>): GalleryItem {
  // A gallery card is public: no owner-only fields (they would only ever hold
  // defaults here, but the memory store leaves the keys out, and so does this).
  const { pinned: _p, deletedAt: _d, origin: _o, takenDown: _t, ...shared } = rowToMeta(r);
  return {
    ...shared,
    ownerName: String(r.owner_name),
    hasThumbnail: Boolean(r.has_thumbnail),
    likeScore: Number(r.like_score ?? 0),
    myVote: Number(r.my_vote ?? 0),
    isTemplate: Boolean(r.is_template),
    tags: (r.tags as string[]) ?? [],
    hasPhoto: Boolean(r.has_photo),
    remixedFromName: (r.remixed_from_name as string) ?? null,
    remixedFromTitle: (r.remixed_from_title as string) ?? null,
    commentCount: Number(r.comment_count ?? 0),
  };
}

/** Postgres AI quota store. consume() is atomic via a conditional UPSERT. */
export class PgAiUsageRepository implements AiUsageRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string, limit: number): Promise<AiUsage> {
    const r = await this.pool.query('SELECT used, period FROM ai_usage WHERE user_id = $1', [userId]);
    const row = r.rows[0];
    const used = row && row.period === aiPeriod() ? Number(row.used) : 0;
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  async consume(userId: string, limit: number): Promise<{ allowed: boolean } & AiUsage> {
    // Monthly meter: a new period resets the count to 1; within a period it
    // increments only while under the limit. No row returned ⇒ over quota.
    const period = aiPeriod();
    const r = await this.pool.query(
      `INSERT INTO ai_usage (user_id, used, period) VALUES ($1, 1, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET used = CASE WHEN ai_usage.period = $3 THEN ai_usage.used + 1 ELSE 1 END,
             period = $3,
             updated_at = now()
         WHERE ai_usage.period <> $3 OR ai_usage.used < $2
       RETURNING used`,
      [userId, limit, period],
    );
    if (r.rows[0]) {
      const used = Number(r.rows[0].used);
      return { allowed: true, used, limit, remaining: Math.max(0, limit - used) };
    }
    return { allowed: false, ...(await this.get(userId, limit)) };
  }
}

const OUTCOMES: AiOutcome[] = ['model', 'cache', 'quick', 'quota', 'busy', 'blocked', 'invalid'];
const zero = (): Record<AiOutcome, number> & { all: number } => ({
  model: 0, cache: 0, quick: 0, quota: 0, busy: 0, blocked: 0, invalid: 0, all: 0,
});

/** Postgres daily AI budget: one row per UTC day, see ai_budget in schema.sql. */
export class PgAiBudgetRepository implements AiBudgetRepository {
  constructor(private readonly pool: pg.Pool) {}

  async load(day: string): Promise<{ calls: number; pictures: number }> {
    const r = await this.pool.query('SELECT calls, pictures FROM ai_budget WHERE day = $1', [day]);
    return { calls: Number(r.rows[0]?.calls ?? 0), pictures: Number(r.rows[0]?.pictures ?? 0) };
  }

  async add(day: string, calls: number, pictures: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_budget (day, calls, pictures) VALUES ($1, $2, $3)
       ON CONFLICT (day) DO UPDATE SET calls = ai_budget.calls + EXCLUDED.calls,
         pictures = ai_budget.pictures + EXCLUDED.pictures, updated_at = now()`,
      [day, calls, pictures],
    );
  }
}

/** A design is a 'model' outcome in std or super; Polish and photo successes are not designs. */
const DESIGN_SQL = `outcome = 'model' AND mode IN ('std', 'super')`;

/** Postgres AI history. One row per request — see the ai_events comment in schema.sql. */
export class PgAiEventsRepository implements AiEventsRepository {
  /**
   * `maintenance` is the small pool for slow, non-request work (server/src/db.ts,
   * performance plan P1.26); it defaults to the one pool where only one exists.
   */
  constructor(private readonly pool: pg.Pool, private readonly maintenance: pg.Pool = pool) {}

  async record(e: AiEventInput): Promise<void> {
    const int = (v: number | null | undefined, max: number): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null;
    await this.pool.query(
      `INSERT INTO ai_events (user_id, mode, outcome, reason, detail, via,
         model, latency_ms, tokens_in, tokens_out, tokens_thought, tokens_cached, calls, pictures, cost_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [e.userId, e.mode, e.outcome, e.reason ?? null, e.detail ? e.detail.slice(0, 400) : null, e.via ?? null,
        e.model ? e.model.slice(0, 80) : null, int(e.latencyMs, 2_000_000_000),
        int(e.tokensIn, 2_000_000_000), int(e.tokensOut, 2_000_000_000), int(e.tokensThought, 2_000_000_000), int(e.tokensCached, 2_000_000_000),
        int(e.calls, 32_000), int(e.pictures, 32_000), int(e.costMicros, Number.MAX_SAFE_INTEGER)],
    );
  }

  async stats(days: number): Promise<AiStats> {
    const since = `${days} days`;
    // 'model' counts DESIGNS: a successful Polish or photo reading lands in
    // `all` only, so the "premium generations" figures mean what they always did.
    const outcomeOf = `CASE WHEN outcome = 'model' AND mode NOT IN ('std', 'super') THEN 'other' ELSE outcome END`;
    const [tot, win, perDay, top, cap, modes, metered, first, fails, recent, groupRows, measuredFirst] = await Promise.all([
      this.maintenance.query(`SELECT ${outcomeOf} AS outcome, count(*)::int AS n FROM ai_events GROUP BY 1`),
      this.maintenance.query(
        `SELECT ${outcomeOf} AS outcome, count(*)::int AS n FROM ai_events WHERE at > now() - $1::interval GROUP BY 1`,
        [since],
      ),
      this.maintenance.query(
        `SELECT to_char(at AT TIME ZONE 'utc','YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE ${DESIGN_SQL})::int   AS model,
                count(*) FILTER (WHERE outcome = 'quick')::int   AS quick,
                count(*) FILTER (WHERE outcome = 'blocked')::int AS blocked
         FROM ai_events WHERE at > now() - $1::interval GROUP BY day ORDER BY day`,
        [since],
      ),
      this.maintenance.query(
        `SELECT coalesce(u.username, 'admin / unlocked') AS username,
                count(*) FILTER (WHERE e.outcome = 'model' AND e.mode IN ('std', 'super'))::int AS model,
                count(*) FILTER (WHERE e.outcome = 'quick')::int AS quick,
                count(*) FILTER (WHERE e.outcome = 'quota')::int AS quota,
                count(*)::int AS total, max(e.at) AS last
         FROM ai_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.at > now() - $1::interval
         GROUP BY 1 ORDER BY model DESC, total DESC LIMIT 20`,
        [since],
      ),
      // Not windowed: "has anyone ever hit the cap" is the question.
      this.maintenance.query(
        `SELECT coalesce(u.username, 'admin / unlocked') AS username,
                count(*)::int AS times, max(e.at) AS last
         FROM ai_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.outcome = 'quota' GROUP BY 1 ORDER BY times DESC LIMIT 20`,
      ),
      this.maintenance.query(
        `SELECT mode, count(*)::int AS n FROM ai_events WHERE at > now() - $1::interval GROUP BY mode`,
        [since],
      ),
      this.maintenance.query('SELECT count(*)::int AS n FROM ai_usage WHERE used > 0'),
      this.maintenance.query('SELECT min(at) AS first FROM ai_events'),
      this.maintenance.query(
        `SELECT reason, count(*)::int AS n, max(at) AS last FROM ai_events
         WHERE reason IS NOT NULL AND at > now() - $1::interval
         GROUP BY reason ORDER BY n DESC, last DESC`,
        [since],
      ),
      this.maintenance.query(
        `SELECT e.at, e.user_id, u.username, e.via, e.mode, e.outcome, e.reason, e.detail
         FROM ai_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.reason IS NOT NULL AND e.at > now() - $1::interval
         ORDER BY e.at DESC, e.id DESC LIMIT 50`,
        [since],
      ),
      // Day × mode × outcome × model: the shape the cost panel is built from
      // (aiStats.ts), so memory and Postgres cannot disagree.
      this.maintenance.query(
        `SELECT to_char(at AT TIME ZONE 'utc','YYYY-MM-DD') AS day, mode, outcome, model,
                count(*)::int AS n,
                count(*) FILTER (WHERE reason = ANY($2::text[]))::int AS limited,
                count(*) FILTER (WHERE calls IS NOT NULL)::int AS measured,
                count(*) FILTER (WHERE calls IS NOT NULL AND cost_micros IS NULL)::int AS unpriced,
                coalesce(sum(cost_micros) FILTER (WHERE calls IS NOT NULL), 0)::bigint AS cost,
                coalesce(sum(tokens_in), 0)::bigint AS tin, coalesce(sum(tokens_out), 0)::bigint AS tout,
                coalesce(sum(tokens_thought), 0)::bigint AS tthought, coalesce(sum(tokens_cached), 0)::bigint AS tcached,
                coalesce(sum(pictures), 0)::int AS pictures,
                coalesce(sum(latency_ms) FILTER (WHERE calls IS NOT NULL), 0)::bigint AS lat_sum,
                count(latency_ms) FILTER (WHERE calls IS NOT NULL)::int AS lat_n
         FROM ai_events WHERE at > now() - $1::interval GROUP BY 1, 2, 3, 4`,
        [since, [...LIMIT_REASONS]],
      ),
      this.maintenance.query('SELECT min(at) AS first FROM ai_events WHERE calls IS NOT NULL'),
    ]);

    const groups: AiGroup[] = groupRows.rows.map((r) => ({
      day: String(r.day), mode: String(r.mode) as AiMode, outcome: String(r.outcome) as AiOutcome,
      model: r.model ? String(r.model) : null, n: Number(r.n), limited: Number(r.limited), measured: Number(r.measured), unpriced: Number(r.unpriced),
      costMicros: Number(r.cost), tokensIn: Number(r.tin), tokensOut: Number(r.tout), tokensThought: Number(r.tthought),
      tokensCached: Number(r.tcached), pictures: Number(r.pictures), latencySum: Number(r.lat_sum), latencyN: Number(r.lat_n),
    }));

    const fold = (rows: { outcome: string; n: number }[]) => {
      const out = zero();
      for (const r of rows) {
        if ((OUTCOMES as string[]).includes(r.outcome)) out[r.outcome as AiOutcome] = Number(r.n);
        out.all += Number(r.n);
      }
      return out;
    };
    const m = { std: 0, super: 0, polish: 0, photo: 0 };
    for (const r of modes.rows) {
      const k = r.mode as AiMode;
      if (k in m) m[k] += Number(r.n);
    }
    return {
      days,
      since: first.rows[0]?.first ? new Date(first.rows[0].first).toISOString() : null,
      totals: fold(tot.rows),
      window: fold(win.rows),
      perDay: perDay.rows.map((r) => ({ day: String(r.day), model: Number(r.model), quick: Number(r.quick), blocked: Number(r.blocked) })),
      topUsers: top.rows.map((r) => ({
        username: String(r.username), model: Number(r.model), quick: Number(r.quick),
        quota: Number(r.quota), total: Number(r.total), last: new Date(r.last).toISOString(),
      })),
      hitCap: cap.rows.map((r) => ({ username: String(r.username), times: Number(r.times), last: new Date(r.last).toISOString() })),
      modes: m,
      meteredAccounts: Number(metered.rows[0]?.n ?? 0),
      failures: fails.rows.map((r) => ({ reason: String(r.reason) as AiFailReason, count: Number(r.n), last: new Date(r.last).toISOString() })),
      recentFailures: recent.rows.map((r) => ({
        at: new Date(r.at).toISOString(),
        // Signed out behind the admin password is still somebody: say which door.
        username: r.username ? String(r.username) : r.via === 'password' ? 'admin password (signed out)' : 'deleted account',
        via: r.via === 'password' ? 'password' : null,
        mode: String(r.mode) as AiMode,
        outcome: String(r.outcome) as AiOutcome,
        reason: String(r.reason) as AiFailReason,
        detail: r.detail ? String(r.detail) : '',
      })),
      modeOutcomes: modeOutcomes(groups),
      cost: costStats(groups, measuredFirst.rows[0]?.first ? new Date(measuredFirst.rows[0].first).toISOString() : null),
    };
  }
}

/** Postgres design repository. Diffs and snapshots append in one transaction. */
export class PgDesignRepository implements DesignRepository {
  /**
   * `maintenance` is the small pool for slow, non-request work (server/src/db.ts,
   * performance plan P1.26); it defaults to the one pool where only one exists.
   */
  constructor(private readonly pool: pg.Pool, private readonly maintenance: pg.Pool = pool) {}

  async create(d: NewDesign): Promise<DesignMeta> {
    const res = await this.pool.query(
      `INSERT INTO designs (title, title_ar, template_id, template_version, palette, cells, owner_id, thumbnail, origin)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING ${META_COLS}`,
      [d.title, d.titleAr ?? null, d.templateId, d.templateVersion, JSON.stringify(d.palette), d.cellsGz, d.ownerId, d.thumbnailPng, d.origin ?? null],
    );
    await this.syncFacets(res.rows[0].id as string, { title: d.title, titleAr: d.titleAr, palette: d.palette });
    return rowToMeta(res.rows[0]);
  }

  async listByOwner(ownerId: string): Promise<DesignMeta[]> {
    const res = await this.pool.query(
      `SELECT ${META_COLS} FROM designs WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
      [ownerId],
    );
    return res.rows.map(rowToMeta);
  }

  async listTitlesByOwner(ownerId: string): Promise<string[]> {
    const res = await this.pool.query('SELECT title FROM designs WHERE owner_id = $1', [ownerId]);
    return res.rows.map((r) => String(r.title));
  }

  async seedDesigns(ownerId: string, items: SeedDesign[]): Promise<number> {
    if (items.length === 0) return 0;
    const client = await this.maintenance.connect();
    try {
      await client.query('BEGIN');

      // Resolve every tag slug in the whole batch in two statements.
      const slugs = [...new Set(items.flatMap((i) => i.tags))];
      const tagId = new Map<string, number>();
      if (slugs.length) {
        await client.query(
          'INSERT INTO tags (slug) SELECT unnest($1::text[]) ON CONFLICT (slug) DO NOTHING',
          [slugs],
        );
        const rows = await client.query('SELECT id, slug FROM tags WHERE slug = ANY($1::text[])', [slugs]);
        for (const r of rows.rows) tagId.set(String(r.slug), Number(r.id));
      }

      // Designs and their tag links, a hundred at a time — enough to make the
      // round trips negligible, small enough to stay far inside Postgres's
      // parameter limit.
      const CHUNK = 100;
      let written = 0;
      for (let at = 0; at < items.length; at += CHUNK) {
        const chunk = items.slice(at, at + CHUNK);
        const params: unknown[] = [ownerId];
        const values = chunk.map((d) => {
          const p = params.length;
          params.push(d.title, d.titleAr, d.templateId, d.templateVersion,
            JSON.stringify(d.palette), d.cellsGz, d.thumbnailPng);
          return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}::jsonb, $${p + 6}, $${p + 7}, $1, true, true)`;
        });
        const res = await client.query(
          `INSERT INTO designs
             (title, title_ar, template_id, template_version, palette, cells, thumbnail,
              owner_id, is_public, is_template)
           VALUES ${values.join(', ')} RETURNING id, title`,
          params,
        );
        written += res.rowCount ?? 0;

        // Match rows back by title rather than by position. Postgres does
        // return RETURNING rows in insertion order, but tags landing on the
        // wrong design is a silent, permanent kind of wrong, and titles are
        // unique across the library anyway.
        const idOf = new Map<string, string>(res.rows.map((r) => [String(r.title), String(r.id)]));
        const links: string[] = [];
        const linkParams: unknown[] = [];
        chunk.forEach((d) => {
          const rowId = idOf.get(d.title);
          if (!rowId) return;
          for (const slug of normalizeTags(d.tags)) {
            const id = tagId.get(slug);
            if (id === undefined) continue;
            const p = linkParams.length;
            linkParams.push(rowId, id);
            links.push(`($${p + 1}::uuid, $${p + 2}::int)`); // tags.id is a SERIAL, not a uuid
          }
        });
        if (links.length) {
          await client.query(
            `INSERT INTO design_tags (design_id, tag_id) VALUES ${links.join(', ')} ON CONFLICT DO NOTHING`,
            linkParams,
          );
        }
      }

      await client.query('COMMIT');
      return written;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listProjects(ownerId: string): Promise<ProjectItem[]> {
    const res = await this.pool.query(
      `SELECT ${META_COLS}, thumbnail IS NOT NULL AS has_thumbnail FROM designs
       WHERE owner_id = $1 ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    return res.rows.map((r) => ({ ...rowToMeta(r), hasThumbnail: Boolean(r.has_thumbnail) }));
  }

  async setPinned(id: string, pinned: boolean): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET pinned = $2 WHERE id = $1 RETURNING ${META_COLS}`,
      [id, pinned],
    );
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
  }

  async trash(id: string): Promise<DesignMeta | null> {
    // One statement, so a design can never be half in the Trash: private and
    // dated together, with what it was remembered for the restore. The CASE
    // keeps a second trash of the same design from overwriting that memory
    // with the "private" it was given the first time.
    const res = await this.pool.query(
      `UPDATE designs SET
         trashed_public = CASE WHEN deleted_at IS NULL THEN is_public ELSE trashed_public END,
         is_public = false,
         deleted_at = coalesce(deleted_at, now())
       WHERE id = $1 RETURNING ${META_COLS}`,
      [id],
    );
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
  }

  async restore(id: string): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET
         is_public = CASE WHEN taken_down_at IS NOT NULL THEN false WHEN deleted_at IS NULL THEN is_public ELSE trashed_public END,
         trashed_public = false,
         deleted_at = NULL
       WHERE id = $1 RETURNING ${META_COLS}`,
      [id],
    );
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
  }

  async purge(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM designs WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async purgeTrashed(cutoff: Date): Promise<number> {
    const res = await this.maintenance.query('DELETE FROM designs WHERE deleted_at IS NOT NULL AND deleted_at < $1', [cutoff]);
    return res.rowCount ?? 0;
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    await this.maintenance.query('DELETE FROM designs WHERE owner_id = $1', [ownerId]);
  }

  /**
   * Recompute a design's filter facets.
   *
   * One statement, called after anything that changes a title or a palette,
   * rather than five bespoke column lists spliced into five INSERTs. The extra
   * round trip is an indexed single-row update; the alternative is five places
   * to forget, on paths I cannot exercise from a test without a database.
   *
   * Best-effort on purpose: a design that saved correctly must not fail because
   * a filter facet did not. `backfillFacets` picks up anything that slipped.
   */
  private async syncFacets(id: string, d: { title?: string | null; titleAr?: string | null; palette: readonly string[] }): Promise<void> {
    const f = designFacets(d);
    await this.pool
      .query('UPDATE designs SET colors = $2::text[], club_id = $3 WHERE id = $1', [id, f.colors, f.clubId])
      .catch(() => undefined);
  }

  /**
   * Fill in facets for rows written before they existed, or by a path that
   * forgot. Runs at boot, reads only what it needs, and is a no-op once done.
   */
  async backfillFacets(limit = 5000): Promise<number> {
    const res = await this.maintenance.query<{ id: string; title: string; title_ar: string | null; palette: string[] }>(
      `SELECT id, title, title_ar, palette FROM designs WHERE colors = '{}' LIMIT $1`,
      [limit],
    );
    if (!res.rowCount) return 0;
    // One statement, not one per row. The template library is 619 designs, and
    // 619 serial round trips is fine against a unix socket and minutes across a
    // network — the same trap seedDesigns already had to be dug out of.
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of res.rows) {
      const f = designFacets({ title: r.title, titleAr: r.title_ar, palette: r.palette });
      params.push(r.id, f.colors, f.clubId);
      const n = params.length;
      values.push(`($${n - 2}::uuid, $${n - 1}::text[], $${n}::text)`);
    }
    await this.maintenance.query(
      `UPDATE designs d SET colors = v.colors, club_id = v.club_id
         FROM (VALUES ${values.join(', ')}) AS v(id, colors, club_id)
        WHERE d.id = v.id`,
      params,
    );
    return res.rowCount;
  }

  /**
   * The WHERE every public feed query shares, filters appended to `params`.
   * It always starts with `d.is_public`: nothing built on it can return a
   * private, trashed or taken-down design (those are all is_public = false).
   */
  private publicWhere(query: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId' | 'sort'> & { ownerId?: string }, params: unknown[]): string {
    let where = 'd.is_public';
    if (query.templatesOnly) where += ' AND d.is_template';
    if (query.excludeTemplates) where += ' AND NOT d.is_template';
    // ANY of the requested colours, not all: somebody filtering red and gold
    // wants the red ones and the gold ones, which is how a colour chip row reads.
    if (query.colors && query.colors.length > 0) {
      params.push(query.colors);
      where += ` AND d.colors && $${params.length}::text[]`;
    }
    if (query.clubId) {
      params.push(query.clubId);
      where += ` AND d.club_id = $${params.length}`;
    }
    if (query.ownerId) {
      params.push(query.ownerId);
      where += ` AND d.owner_id = $${params.length}`;
    }
    if (query.search && query.search.trim()) {
      params.push(`%${query.search.trim()}%`);
      where += ` AND d.title ILIKE $${params.length}`;
    }
    // Tag intersection: design must carry ALL requested slugs.
    if (query.tags && query.tags.length > 0) {
      params.push(query.tags.map((t) => t.toLowerCase()));
      const p = params.length;
      params.push(query.tags.length);
      where +=
        ` AND d.id IN (SELECT dt.design_id FROM design_tags dt JOIN tags t ON t.id = dt.tag_id` +
        ` WHERE t.slug = ANY($${p}::text[]) GROUP BY dt.design_id HAVING count(DISTINCT t.id) = $${params.length})`;
    }
    return where;
  }

  /**
   * Bring every design's stored facets in line with the rules as they are in
   * this build. Runs at boot, after the library is seeded, on the
   * maintenance pool (performance plan P1.12).
   *
   * The feed's facet counts and its colour and club filters both read the
   * stored columns, so the columns have to be right, and two things could leave
   * them wrong: a best-effort syncFacets that failed (a design that saved while
   * its facet update did not), and a change to the rules themselves (a club or
   * an alias added to clubs.ts, a colour boundary moved), which used to reach
   * old designs never. Reads only id, titles, palette and the two columns, a
   * page at a time, and writes only the rows that differ; updated_at is left
   * alone, so the feed's order does not move.
   */
  async resyncFacets(): Promise<number> {
    let changed = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const res = await this.maintenance.query<{ id: string; title: string; title_ar: string | null; palette: string[]; colors: string[]; club_id: string | null }>(
        'SELECT id, title, title_ar, palette, colors, club_id FROM designs WHERE id > $1 ORDER BY id LIMIT 2000',
        [after],
      );
      if (!res.rowCount) break;
      const values: string[] = [];
      const params: unknown[] = [];
      for (const r of res.rows) {
        const f = designFacets({ title: r.title, titleAr: r.title_ar, palette: r.palette });
        if (f.colors.join(',') === (r.colors ?? []).join(',') && f.clubId === (r.club_id ?? null)) continue;
        params.push(r.id, f.colors, f.clubId, r.title, r.title_ar, JSON.stringify(r.palette));
        const n = params.length;
        values.push(`($${n - 5}::uuid, $${n - 4}::text[], $${n - 3}::text, $${n - 2}::text, $${n - 1}::text, $${n}::jsonb)`);
      }
      if (values.length) {
        // Only over the title and palette these facets were worked out from:
        // this runs while people are saving, and a rename or repaint that
        // landed since the read has already written its own facets.
        await this.maintenance.query(
          `UPDATE designs d SET colors = v.colors, club_id = v.club_id
             FROM (VALUES ${values.join(', ')}) AS v(id, colors, club_id, title, title_ar, palette)
            WHERE d.id = v.id AND d.title = v.title AND d.title_ar IS NOT DISTINCT FROM v.title_ar AND d.palette = v.palette`,
          params,
        );
        changed += values.length;
      }
      after = String(res.rows[res.rows.length - 1].id);
      if (res.rowCount < 2000) break;
    }
    return changed;
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    return this.queryPublic(query);
  }

  private async queryPublic(query: GalleryQuery & { ownerId?: string }): Promise<GalleryItem[]> {
    const params: unknown[] = [];
    const where = this.publicWhere(query, params);
    let voteSelect = '0 AS my_vote';
    if (query.viewerId) {
      params.push(query.viewerId);
      voteSelect = `coalesce(v.value, 0) AS my_vote`;
    }
    const viewerJoin = query.viewerId
      ? `LEFT JOIN design_votes v ON v.design_id = d.id AND v.user_id = $${params.length}`
      : '';
    // d.id breaks ties so paging is stable: the template library is seeded in a
    // single boot, so hundreds of rows share updated_at to the millisecond and
    // an unbroken tie can repeat or skip rows between pages.
    const order = query.sort === 'likes'
      ? 'd.like_score DESC, d.updated_at DESC, d.id DESC'
      : 'd.updated_at DESC, d.id DESC';
    // Callers that want everything (sitemap, crawler feed) pass no limit; the
    // 5000 ceiling is a backstop, not a page size.
    params.push(Math.min(5000, query.limit ?? 5000));
    const limitP = params.length;
    params.push(Math.max(0, query.offset ?? 0));
    const offsetP = params.length;
    const res = await this.pool.query(
      `SELECT ${GALLERY_COLS}, ${voteSelect}
       ${GALLERY_JOINS}
       ${viewerJoin}
       WHERE ${where} ORDER BY ${order} LIMIT $${limitP} OFFSET $${offsetP}`,
      params,
    );
    return res.rows.map(rowToGalleryItem);
  }

  async countPublic(query: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId' | 'sort'>): Promise<number> {
    const params: unknown[] = [];
    const where = this.publicWhere(query, params);
    const res = await this.pool.query(`SELECT count(*)::int AS n FROM designs d WHERE ${where}`, params);
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Colour and club counts for one scope, from the stored facet columns, in
   * one statement. It used to fetch every public design's full card (up to
   * 5,000, with the joins and per-row subqueries) and classify each in
   * JavaScript, on every call: 707 KB read and ~135 ms at 2,155 public designs,
   * growing with each one published, and a `total` stuck at 5,000 past that
   * (performance plan P1.12). The columns are written from the same
   * designFacets() at every save (syncFacets) and are what the feed's own
   * filters already use, so the counts now agree with what a chip returns.
   */
  async facetBase(scope: FacetScope): Promise<FacetBase> {
    let where = 'd.is_public';
    if (scope.templatesOnly) where += ' AND d.is_template';
    if (scope.excludeTemplates) where += ' AND NOT d.is_template';
    const res = await this.pool.query(
      `WITH pub AS (SELECT d.colors, d.club_id FROM designs d WHERE ${where})
       SELECT (SELECT count(*)::int FROM pub) AS total,
              (SELECT coalesce(json_object_agg(c, n), '{}'::json)
                 FROM (SELECT c, count(*)::int AS n FROM pub, unnest(pub.colors) AS c GROUP BY c) x) AS colors,
              (SELECT coalesce(json_object_agg(club_id, n), '{}'::json)
                 FROM (SELECT club_id, count(*)::int AS n FROM pub WHERE club_id IS NOT NULL GROUP BY club_id) y) AS clubs`,
    );
    const r = res.rows[0] ?? {};
    return {
      total: Number(r.total ?? 0),
      colors: (r.colors ?? {}) as Record<string, number>,
      clubs: (r.clubs ?? {}) as Record<string, number>,
    };
  }

  async listPublicByOwner(ownerId: string, opts: { viewerId?: string | null; limit: number }): Promise<GalleryItem[]> {
    // The feed's own query with the owner added to its WHERE, so it is public
    // only by construction, served by designs_owner_updated_idx and capped.
    return this.queryPublic({ sort: 'recent', ownerId, viewerId: opts.viewerId, limit: Math.min(200, Math.max(1, Math.floor(opts.limit))) });
  }

  async listPublicIds(limit: number): Promise<{ id: string; updatedAt: string }[]> {
    // Two columns, not the full card: the sitemap read every public design's
    // card to use these two (performance plan P1.12).
    const res = await this.pool.query(
      'SELECT id, updated_at FROM designs WHERE is_public ORDER BY updated_at DESC, id DESC LIMIT $1',
      [Math.min(50_000, Math.max(0, Math.floor(limit)))],
    );
    return res.rows.map((r) => ({ id: String(r.id), updatedAt: new Date(r.updated_at as string).toISOString() }));
  }

  async getPublicItem(id: string, viewerId?: string | null): Promise<GalleryItem | null> {
    const params: unknown[] = [id];
    let voteSelect = '0 AS my_vote';
    let viewerJoin = '';
    if (viewerId) {
      params.push(viewerId);
      voteSelect = 'coalesce(v.value, 0) AS my_vote';
      viewerJoin = `LEFT JOIN design_votes v ON v.design_id = d.id AND v.user_id = $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT ${GALLERY_COLS}, ${voteSelect}
       ${GALLERY_JOINS}
       ${viewerJoin}
       WHERE d.id = $1 AND d.is_public`,
      params,
    );
    return res.rows[0] ? rowToGalleryItem(res.rows[0]) : null;
  }

  async vote(
    designId: string,
    userId: string,
    value: -1 | 0 | 1,
  ): Promise<{ likeScore: number; myVote: number } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT 1 FROM designs WHERE id = $1 AND is_public', [designId]);
      if (exists.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      if (value === 0) {
        await client.query('DELETE FROM design_votes WHERE design_id = $1 AND user_id = $2', [designId, userId]);
      } else {
        await client.query(
          `INSERT INTO design_votes (design_id, user_id, value) VALUES ($1, $2, $3)
           ON CONFLICT (design_id, user_id) DO UPDATE SET value = EXCLUDED.value, created_at = now()`,
          [designId, userId, value],
        );
      }
      // Recompute the denormalized score from the source of truth.
      const sum = await client.query(
        'SELECT coalesce(sum(value), 0)::int AS score FROM design_votes WHERE design_id = $1',
        [designId],
      );
      const likeScore = Number(sum.rows[0].score);
      await client.query('UPDATE designs SET like_score = $2 WHERE id = $1', [designId, likeScore]);
      await client.query('COMMIT');
      return { likeScore, myVote: value };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listLikedBy(userId: string): Promise<GalleryItem[]> {
    const res = await this.pool.query(
      `SELECT d.id, d.title, d.title_ar, d.template_id, d.template_version, d.palette, d.revision_count,
              d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score, d.is_template,
              coalesce(u.username, 'unknown') AS owner_name,
              (d.thumbnail IS NOT NULL) AS has_thumbnail, 1 AS my_vote,
              coalesce((SELECT array_agg(t.slug ORDER BY t.slug) FROM design_tags dt
                        JOIN tags t ON t.id = dt.tag_id WHERE dt.design_id = d.id), '{}') AS tags,
              EXISTS (SELECT 1 FROM design_photos dp WHERE dp.design_id = d.id) AS has_photo,
              ${COMMENT_COUNT}
       FROM design_votes vt
       JOIN designs d ON d.id = vt.design_id AND d.is_public
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE vt.user_id = $1 AND vt.value = 1
       ORDER BY vt.created_at DESC LIMIT 200`,
      [userId],
    );
    return res.rows.map((r) => ({
      ...rowToMeta(r),
      ownerName: String(r.owner_name),
      hasThumbnail: Boolean(r.has_thumbnail),
      likeScore: Number(r.like_score ?? 0),
      myVote: 1,
      isTemplate: Boolean(r.is_template),
      tags: (r.tags as string[]) ?? [],
      hasPhoto: Boolean(r.has_photo),
      commentCount: Number(r.comment_count ?? 0),
    }));
  }

  async get(id: string): Promise<DesignRecord | null> {
    const res = await this.pool.query(`SELECT ${META_COLS}, cells FROM designs WHERE id = $1`, [id]);
    if (res.rowCount === 0) return null;
    return { ...rowToMeta(res.rows[0]), cellsGz: res.rows[0].cells as Buffer };
  }

  async updateCells(
    id: string,
    cellsGz: Buffer,
    palette: string[],
    thumbnailPng: Buffer | null,
  ): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET cells = $2, palette = $3::jsonb,
              thumbnail = coalesce($4, thumbnail), updated_at = now()
       WHERE id = $1 RETURNING ${META_COLS}`,
      [id, cellsGz, JSON.stringify(palette), thumbnailPng],
    );
    if (!res.rowCount) return null;
    const meta = rowToMeta(res.rows[0]);
    await this.syncFacets(id, { title: meta.title, titleAr: meta.titleAr, palette });
    return meta;
  }

  async getScene(id: string): Promise<Buffer | null> {
    const res = await this.pool.query('SELECT scene FROM design_scenes WHERE design_id = $1', [id]);
    return res.rowCount ? (res.rows[0].scene as Buffer) : null;
  }

  async putScene(id: string, sceneGz: Buffer): Promise<boolean> {
    // ON CONFLICT rather than a read-then-write: two tabs of the same design
    // saving at once is ordinary, and the loser of that race should overwrite
    // rather than error.
    const res = await this.pool.query(
      `INSERT INTO design_scenes (design_id, scene, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (design_id) DO UPDATE SET scene = EXCLUDED.scene, updated_at = now()`,
      [id, sceneGz],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET title = coalesce($2, title),
         is_public = CASE WHEN taken_down_at IS NOT NULL THEN false ELSE coalesce($3, is_public) END,
         updated_at = now()
       WHERE id = $1 RETURNING ${META_COLS}`,
      [id, patch.title ?? null, patch.isPublic ?? null],
    );
    if (!res.rowCount) return null;
    const meta = rowToMeta(res.rows[0]);
    // The title decides the club, so a rename can change which filter a design
    // falls under.
    if (patch.title !== undefined) await this.syncFacets(id, { title: meta.title, titleAr: meta.titleAr, palette: meta.palette });
    return meta;
  }

  async getThumbnail(id: string): Promise<Buffer | null> {
    const res = await this.pool.query('SELECT thumbnail FROM designs WHERE id = $1', [id]);
    return res.rowCount && res.rows[0].thumbnail ? (res.rows[0].thumbnail as Buffer) : null;
  }

  async appendRevision(
    id: string,
    diff: DiffBytes,
    newCellsGz: Buffer,
    snapshot: Buffer | null,
  ): Promise<DesignMeta | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const bumped = await client.query(
        `UPDATE designs SET revision_count = revision_count + 1, cells = $2, updated_at = now()
         WHERE id = $1 RETURNING ${META_COLS}`,
        [id, newCellsGz],
      );
      if (bumped.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const meta = rowToMeta(bumped.rows[0]);
      await client.query(
        `INSERT INTO design_revisions (design_id, seq, diff_indices, diff_before, diff_after, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, meta.revisionCount, diff.indices, diff.before, diff.after, snapshot],
      );
      await client.query('DELETE FROM design_revisions WHERE design_id = $1 AND seq <= $2', [id, meta.revisionCount - REVISIONS_KEPT]);
      await client.query('COMMIT');
      return meta;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRevisions(id: string, limit: number): Promise<RevisionRow[]> {
    const res = await this.pool.query(
      `SELECT seq, octet_length(diff_indices) AS ilen, snapshot IS NOT NULL AS has_snapshot, created_at
       FROM design_revisions WHERE design_id = $1 ORDER BY seq DESC LIMIT $2`,
      [id, limit],
    );
    return res.rows.map((r) => ({
      seq: Number(r.seq),
      changed: Number(r.ilen) / 4,
      hasSnapshot: Boolean(r.has_snapshot),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  async fork(id: string, title: string, ownerId: string): Promise<DesignMeta | null> {
    // A copy of a design a moderator took down is taken down with it, in the
    // same statement, so there is no moment and no failure in which the copy
    // exists without its takedown (audit round six).
    const res = await this.pool.query(
      `INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, thumbnail, taken_down_at)
       SELECT $2, template_id, template_version, palette, cells, $3, thumbnail, taken_down_at FROM designs WHERE id = $1
       RETURNING ${META_COLS}`,
      [id, title, ownerId],
    );
    if (!res.rowCount) return null;
    const meta = rowToMeta(res.rows[0]);
    await this.syncFacets(meta.id, { title: meta.title, titleAr: meta.titleAr, palette: meta.palette });
    return meta;
  }

  async setTags(designId: string, ownerId: string, slugs: string[]): Promise<string[] | null> {
    const owns = await this.pool.query('SELECT 1 FROM designs WHERE id = $1 AND owner_id = $2', [designId, ownerId]);
    if (owns.rowCount === 0) return null;
    const clean = normalizeTags(slugs);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM design_tags WHERE design_id = $1', [designId]);
      for (const slug of clean) {
        const t = await client.query(
          `INSERT INTO tags (slug) VALUES ($1) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
          [slug],
        );
        await client.query('INSERT INTO design_tags (design_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          designId,
          t.rows[0].id,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return clean;
  }

  async setTemplate(designId: string, ownerId: string, isTemplate: boolean): Promise<boolean | null> {
    const res = await this.pool.query(
      'UPDATE designs SET is_template = $3 WHERE id = $1 AND owner_id = $2 RETURNING is_template',
      [designId, ownerId, isTemplate],
    );
    return res.rowCount ? Boolean(res.rows[0].is_template) : null;
  }

  async popularTags(limit: number): Promise<{ slug: string; kind: string; count: number }[]> {
    const res = await this.pool.query(
      `SELECT t.slug, t.kind, count(*)::int AS count
       FROM design_tags dt JOIN tags t ON t.id = dt.tag_id
       JOIN designs d ON d.id = dt.design_id AND d.is_public
       GROUP BY t.slug, t.kind ORDER BY count DESC, t.slug LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ slug: String(r.slug), kind: String(r.kind), count: Number(r.count) }));
  }

  async report(
    targetType: 'design' | 'comment',
    targetId: string,
    reporterId: string | null,
    reason: string,
  ): Promise<string> {
    const res = await this.pool.query(
      `INSERT INTO moderation_reports (target_type, target_id, reporter_id, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [targetType, targetId, reporterId, reason.slice(0, 500)],
    );
    return String(res.rows[0].id);
  }

  async addPhoto(
    designId: string,
    ownerId: string,
    image: Buffer,
    width: number,
    height: number,
    caption: string | null,
  ): Promise<string | null> {
    const owns = await this.pool.query('SELECT 1 FROM designs WHERE id = $1 AND owner_id = $2', [designId, ownerId]);
    if (owns.rowCount === 0) return null;
    const res = await this.pool.query(
      `INSERT INTO design_photos (design_id, image, width, height, caption)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [designId, image, width, height, caption?.slice(0, 200) ?? null],
    );
    return String(res.rows[0].id);
  }

  async listPhotos(designId: string): Promise<PhotoMeta[]> {
    const res = await this.pool.query(
      `SELECT id, design_id, width, height, caption, is_verified, created_at
       FROM design_photos WHERE design_id = $1 ORDER BY created_at DESC`,
      [designId],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      designId: String(r.design_id),
      width: Number(r.width),
      height: Number(r.height),
      caption: r.caption ?? null,
      isVerified: Boolean(r.is_verified),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async getPhoto(photoId: string): Promise<{ image: Buffer; designId: string } | null> {
    const res = await this.pool.query('SELECT image, design_id FROM design_photos WHERE id = $1', [photoId]);
    return res.rowCount
      ? { image: res.rows[0].image as Buffer, designId: String(res.rows[0].design_id) }
      : null;
  }

  async deletePhoto(photoId: string, ownerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM design_photos dp USING designs d
       WHERE dp.id = $1 AND dp.design_id = d.id AND d.owner_id = $2`,
      [photoId, ownerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listReports(status: string, limit: number): Promise<ReportItem[]> {
    const res = await this.pool.query(
      `SELECT m.id, m.target_type, m.target_id, m.reason, m.status, m.created_at,
              d.title AS target_title, coalesce(u.username, NULL) AS target_owner,
              d.is_public AS target_is_public, (d.thumbnail IS NOT NULL) AS target_has_thumbnail
       FROM moderation_reports m
       LEFT JOIN designs d ON d.id = m.target_id AND m.target_type = 'design'
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE m.status = $1
       ORDER BY m.created_at DESC LIMIT $2`,
      [status, limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      reason: String(r.reason),
      status: String(r.status),
      createdAt: new Date(r.created_at).toISOString(),
      targetTitle: r.target_title ?? null,
      targetOwner: r.target_owner ?? null,
      targetIsPublic: r.target_is_public ?? null,
      targetHasThumbnail: Boolean(r.target_has_thumbnail),
    }));
  }

  async setReportStatus(reportId: string, status: string): Promise<boolean> {
    const res = await this.pool.query('UPDATE moderation_reports SET status = $2 WHERE id = $1', [reportId, status]);
    return (res.rowCount ?? 0) > 0;
  }

  async takedownDesign(designId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        'UPDATE designs SET is_public = false, trashed_public = false, taken_down_at = coalesce(taken_down_at, now()) WHERE id = $1',
        [designId],
      );
      await client.query(
        `UPDATE moderation_reports SET status = 'actioned'
         WHERE target_type = 'design' AND target_id = $1 AND status = 'open'`,
        [designId],
      );
      await client.query('COMMIT');
      return (upd.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listUnverifiedPhotos(limit: number): Promise<PhotoReviewItem[]> {
    const res = await this.pool.query(
      `SELECT p.id, p.design_id, p.caption, p.created_at, d.title AS design_title
       FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id
       WHERE p.is_verified = false
       ORDER BY p.created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      designId: String(r.design_id),
      designTitle: r.design_title ?? null,
      caption: r.caption ?? null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async setPhotoVerified(photoId: string, verified: boolean): Promise<boolean> {
    const res = await this.pool.query('UPDATE design_photos SET is_verified = $2 WHERE id = $1', [photoId, verified]);
    return (res.rowCount ?? 0) > 0;
  }

  async deletePhotoAsModerator(photoId: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM design_photos WHERE id = $1', [photoId]);
    return (res.rowCount ?? 0) > 0;
  }

  // ---- sharing system ----
  async incrementView(id: string): Promise<number> {
    const r = await this.pool.query('UPDATE designs SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count', [id]);
    return r.rows[0] ? Number(r.rows[0].view_count) : 0;
  }

  async recordShare(designId: string, platform: string, kind: 'share' | 'open'): Promise<void> {
    await this.pool.query('INSERT INTO design_shares (design_id, platform, kind) VALUES ($1, $2, $3)', [designId, platform, kind]);
  }

  async shareStats(id: string): Promise<ShareStats> {
    const v = await this.pool.query('SELECT view_count FROM designs WHERE id = $1', [id]);
    const views = v.rows[0] ? Number(v.rows[0].view_count) : 0;
    const rows = await this.pool.query(
      'SELECT platform, kind, count(*)::int AS n FROM design_shares WHERE design_id = $1 GROUP BY platform, kind',
      [id],
    );
    let shares = 0;
    let opens = 0;
    const byPlatform: Record<string, number> = {};
    for (const row of rows.rows) {
      const n = Number(row.n);
      if (row.kind === 'open') opens += n;
      else {
        shares += n;
        byPlatform[String(row.platform)] = (byPlatform[String(row.platform)] ?? 0) + n;
      }
    }
    return { views, shares, opens, byPlatform };
  }

  async setOgImage(id: string, ownerId: string, image: Buffer): Promise<boolean> {
    const res = await this.pool.query('UPDATE designs SET og_image = $1 WHERE id = $2 AND owner_id = $3', [image, id, ownerId]);
    return (res.rowCount ?? 0) > 0;
  }

  async getOgImage(id: string): Promise<Buffer | null> {
    const r = await this.pool.query('SELECT og_image FROM designs WHERE id = $1', [id]);
    return (r.rows[0]?.og_image as Buffer | undefined) ?? null;
  }
}

/** Map a users row (incl. email columns) to a UserRow. */
function mapUserRow(r: {
  id: unknown;
  username: unknown;
  password_hash: unknown;
  email?: unknown;
  email_verified_at?: unknown;
  is_pro?: unknown;
  username_chosen?: unknown;
}): UserRow {
  return {
    id: String(r.id),
    username: String(r.username),
    passwordHash: r.password_hash == null ? null : String(r.password_hash),
    email: r.email == null ? null : String(r.email),
    emailVerifiedAt: r.email_verified_at == null ? null : new Date(r.email_verified_at as string).toISOString(),
    isPro: r.is_pro === true,
    // Absent from a SELECT that does not ask for it — and "we did not look" must
    // read as "yes", or a query that forgot the column would lock the owner out
    // of their own account behind a prompt they already answered.
    usernameChosen: r.username_chosen !== false,
  };
}

export class PgAuthRepository implements AuthRepository {
  /**
   * `maintenance` is the small pool for slow, non-request work (server/src/db.ts,
   * performance plan P1.26); it defaults to the one pool where only one exists.
   */
  constructor(private readonly pool: pg.Pool, private readonly maintenance: pg.Pool = pool) {}

  async createUser(
    username: string,
    passwordHash: string | null,
    opts: {
      email?: string | null;
      acceptedVersion?: string | null;
      emailVerified?: boolean;
      usernameChosen?: boolean;
    } = {},
  ): Promise<UserRow | null> {
    const acceptedVersion = opts.acceptedVersion ?? null;
    const acceptedAt = acceptedVersion ? new Date() : null;
    // Only a provider that told us it verified the address gets to skip the
    // code-in-your-inbox step.
    const verifiedAt = opts.email && opts.emailVerified ? new Date() : null;
    try {
      const res = await this.pool.query(
        // Names are unique ignoring case, as in the memory store: "Alice" next to
        // "alice" is an impersonation, not a second person (audit round four).
        `INSERT INTO users (username, password_hash, email, accepted_terms_version, accepted_terms_at, email_verified_at, username_chosen)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower($1))
         RETURNING id, username, password_hash, email, email_verified_at, username_chosen, is_pro`,
        [username, passwordHash, opts.email ?? null, acceptedVersion, acceptedAt, verifiedAt, opts.usernameChosen !== false],
      );
      return res.rowCount ? mapUserRow(res.rows[0]) : null;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null; // username or email taken
      throw err;
    }
  }

  async getUserByName(username: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at, username_chosen, is_pro FROM users WHERE username = $1',
      [username],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at, username_chosen, is_pro FROM users WHERE id = $1',
      [id],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at, username_chosen, is_pro FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async setEmail(userId: string, email: string, acceptedVersion?: string | null, expectedHash?: string | null): Promise<boolean> {
    // One transaction, so the move and the end of the old address's reset links
    // happen together or (a taken address, a changed password, any error) not at
    // all. Two statements, not one: the DELETE must see a reset link that was
    // being stored while the UPDATE waited for the row (createEmailTokenForAddress
    // holds it), and one statement sees only what existed when it began.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE users
            SET email = $2,
                email_verified_at = NULL,
                accepted_terms_version = COALESCE($3, accepted_terms_version),
                accepted_terms_at = CASE WHEN $3 IS NULL THEN accepted_terms_at ELSE now() END
          WHERE id = $1 AND (NOT $4 OR password_hash IS NOT DISTINCT FROM $5)`,
        [userId, email, acceptedVersion ?? null, expectedHash !== undefined, expectedHash ?? null],
      );
      if (!res.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset_password'", [userId]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === '23505') return false; // email taken
      throw err;
    } finally {
      client.release();
    }
  }

  async markEmailVerified(userId: string, email?: string): Promise<boolean> {
    const res = email === undefined
      ? await this.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId])
      : await this.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND lower(email) = lower($2)', [userId, email]);
    return (res.rowCount ?? 0) > 0;
  }

  async setUsername(userId: string, username: string): Promise<boolean> {
    try {
      // Settling on a name is what clears the flag — including confirming the
      // one we suggested, which is still the owner choosing it.
      const res = await this.pool.query(
        `UPDATE users SET username = $2, username_chosen = true
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM users o WHERE lower(o.username) = lower($2) AND o.id <> $1)`,
        [userId, username],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false; // name taken
      throw err;
    }
  }

  async hasChosenUsername(userId: string): Promise<boolean> {
    const res = await this.pool.query('SELECT username_chosen FROM users WHERE id = $1', [userId]);
    return res.rowCount ? res.rows[0].username_chosen !== false : true;
  }

  async setPro(userId: string, isPro: boolean): Promise<void> {
    await this.pool.query('UPDATE users SET is_pro = $2 WHERE id = $1', [userId, isPro]);
  }

  async createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash, userId, expiresAt],
    );
  }

  async getUserIdByToken(tokenHash: string): Promise<string | null> {
    const res = await this.pool.query(
      'SELECT user_id FROM auth_tokens WHERE token_hash = $1 AND expires_at > now()',
      [tokenHash],
    );
    return res.rowCount ? String(res.rows[0].user_id) : null;
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', [tokenHash]);
  }

  async createEmailTokenForAddress(
    userId: string,
    email: string,
    tokenHash: string,
    purpose: string,
    expiresAt: Date,
  ): Promise<boolean> {
    // FOR SHARE: an email change waits for this to finish (and then removes it),
    // or this waits for the change and finds the address gone.
    const res = await this.pool.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
       SELECT $1, u.id, $3, $4 FROM (
         SELECT id FROM users WHERE id = $2 AND lower(email) = lower($5) FOR SHARE
       ) u`,
      [tokenHash, userId, purpose, expiresAt, email],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async createEmailToken(userId: string, tokenHash: string, purpose: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, userId, purpose, expiresAt],
    );
  }

  async consumeEmailToken(tokenHash: string, purpose: string): Promise<string | null> {
    // Single-use + atomic: only the first caller to flip used_at gets the row back.
    const res = await this.pool.query(
      `UPDATE email_tokens SET used_at = now()
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash, purpose],
    );
    return res.rowCount ? String(res.rows[0].user_id) : null;
  }

  async deleteEmailTokens(userId: string, purpose: string): Promise<void> {
    await this.pool.query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  }

  async deleteUserTokens(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
  }

  async replacePassword(
    userId: string,
    passwordHash: string,
    opts: {
      dropIdentities?: boolean;
      keepResetLinks?: boolean;
      expectedHash?: string | null;
      newSession?: { tokenHash: string; expiresAt: Date };
    } = {},
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Order matters for everything racing this (see repo.ts). The account row
      // first: two of these on one account then queue rather than deadlock, a
      // sign-in or an email change holding it finishes first, and one arriving
      // later waits and re-reads it. NO KEY UPDATE, the lock the UPDATE below
      // takes anyway, so inserts that only reference the account are not held.
      const row = await client.query('SELECT password_hash FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
      if (!row.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      if (opts.expectedHash !== undefined && (row.rows[0].password_hash ?? null) !== opts.expectedHash) {
        await client.query('ROLLBACK');
        return false; // the password changed since the caller checked it
      }
      // Then its sessions: a provider link holding one finishes before the
      // identities are read below, or waits and finds it gone.
      await client.query('SELECT 1 FROM auth_tokens WHERE user_id = $1 FOR UPDATE', [userId]);
      if (opts.dropIdentities) await client.query('DELETE FROM oauth_identities WHERE user_id = $1', [userId]);
      await client.query(
        opts.keepResetLinks
          ? "DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'oauth_handoff'"
          : "DELETE FROM email_tokens WHERE user_id = $1 AND purpose IN ('reset_password', 'oauth_handoff')",
        [userId],
      );
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      await client.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
      if (opts.newSession) {
        await client.query('INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
          opts.newSession.tokenHash,
          userId,
          opts.newSession.expiresAt,
        ]);
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async upgradePasswordHash(userId: string, expected: string, next: string): Promise<boolean> {
    const res = await this.pool.query('UPDATE users SET password_hash = $3 WHERE id = $1 AND password_hash = $2', [
      userId,
      expected,
      next,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async createTokenIfPassword(userId: string, verifiedHash: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    // FOR SHARE waits behind a password change's UPDATE of the same row and
    // then re-reads it, so a sign-in checked against the old password stores
    // nothing once the new one has landed.
    const res = await this.pool.query(
      `INSERT INTO auth_tokens (token_hash, user_id, expires_at)
       SELECT $1, u.id, $3 FROM (SELECT id FROM users WHERE id = $2 AND password_hash = $4 FOR SHARE) u`,
      [tokenHash, userId, expiresAt, verifiedHash],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async createHandoffIfLinked(
    userId: string,
    provider: string,
    providerUserId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
       SELECT $1, i.user_id, 'oauth_handoff', $5 FROM (
         SELECT user_id FROM oauth_identities
          WHERE provider = $2 AND provider_user_id = $3 AND user_id = $4 FOR SHARE
       ) i`,
      [tokenHash, provider, providerUserId, userId, expiresAt],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async exchangeHandoff(ticketHash: string, tokenHash: string, expiresAt: Date): Promise<string | null> {
    // One statement: the ticket is spent and the session stored together, so a
    // reset cannot land between the two.
    const res = await this.pool.query(
      `WITH spent AS (
         UPDATE email_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = 'oauth_handoff' AND used_at IS NULL AND expires_at > now()
          RETURNING user_id
       )
       INSERT INTO auth_tokens (token_hash, user_id, expires_at)
       SELECT $2, user_id, $3 FROM spent
       RETURNING user_id`,
      [ticketHash, tokenHash, expiresAt],
    );
    return res.rowCount ? String(res.rows[0].user_id) : null;
  }

  async deleteUser(userId: string): Promise<void> {
    // The account's comments go with it (by cascade), but other people's
    // replies to them stay, at the top of their thread. Without this the
    // cascade on comments.parent_id took them too (audit round five).
    const client = await this.maintenance.connect();
    try {
      await client.query('BEGIN');
      // Locked first, so a reply arriving meanwhile waits and then fails
      // cleanly (409) instead of being accepted and then cascaded away.
      await client.query('SELECT id FROM comments WHERE author_id = $1 FOR UPDATE', [userId]);
      await client.query(
        `UPDATE comments SET parent_id = NULL
         WHERE author_id <> $1 AND parent_id IN (SELECT id FROM comments WHERE author_id = $1)`,
        [userId],
      );
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- federated identities ----

  async getUserIdByIdentity(provider: string, providerUserId: string): Promise<string | null> {
    const res = await this.pool.query(
      'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId],
    );
    return res.rowCount ? String(res.rows[0].user_id) : null;
  }

  async linkIdentity(provider: string, providerUserId: string, userId: string): Promise<boolean> {
    // ON CONFLICT DO NOTHING, then report whether a row landed: two browsers
    // finishing the same callback at once must not produce two accounts, and
    // the primary key is the only thing that can decide that race.
    const res = await this.pool.query(
      `INSERT INTO oauth_identities (provider, provider_user_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [provider, providerUserId, userId],
    );
    if (res.rowCount) return true;
    // Already there: fine if it is already ours, a refusal if it is someone else's.
    const owner = await this.getUserIdByIdentity(provider, providerUserId);
    return owner === userId;
  }

  async linkIdentityForSession(
    provider: string,
    providerUserId: string,
    userId: string,
    sessionTokenHash: string,
  ): Promise<boolean> {
    // FOR SHARE on the session: a reset or password change locks the account's
    // sessions before it reads the identities, so it either waits for this
    // link and then removes it, or ends the session first and this stores nothing.
    const res = await this.pool.query(
      `INSERT INTO oauth_identities (provider, provider_user_id, user_id)
       SELECT $1, $2, t.user_id FROM (
         SELECT user_id FROM auth_tokens
          WHERE token_hash = $4 AND user_id = $3 AND expires_at > now() FOR SHARE
       ) t
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [provider, providerUserId, userId, sessionTokenHash],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async unlinkIdentity(provider: string, userId: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM oauth_identities WHERE provider = $1 AND user_id = $2', [
      provider,
      userId,
    ]);
    return !!res.rowCount;
  }

  async identitiesFor(userId: string): Promise<string[]> {
    const res = await this.pool.query(
      'SELECT provider FROM oauth_identities WHERE user_id = $1 ORDER BY provider',
      [userId],
    );
    return res.rows.map((r: { provider: unknown }) => String(r.provider));
  }
}

/** Postgres events repo. Append-only inserts; funnel via one grouped query. */
export class PgEventsRepository implements EventsRepository {
  /**
   * `maintenance` is the small pool for slow, non-request work (server/src/db.ts,
   * performance plan P1.26); it defaults to the one pool where only one exists.
   */
  constructor(private readonly pool: pg.Pool, private readonly maintenance: pg.Pool = pool) {}

  async record(sessionId: string, name: string, signedIn: boolean): Promise<void> {
    await this.pool.query(
      'INSERT INTO events (session_id, name, signed_in) VALUES ($1, $2, $3)',
      [sessionId.slice(0, 64), name.slice(0, 40), signedIn],
    );
  }

  async purge(before: Date): Promise<number> {
    const res = await this.maintenance.query('DELETE FROM events WHERE created_at < $1', [before]);
    return res.rowCount ?? 0;
  }

  async funnel(steps: string[], days: number): Promise<FunnelStep[]> {
    const res = await this.maintenance.query(
      `SELECT name, count(DISTINCT session_id)::int AS sessions
       FROM events
       WHERE name = ANY($1::text[]) AND created_at >= now() - ($2::int * interval '1 day')
       GROUP BY name`,
      [steps, days],
    );
    const map = new Map<string, number>(res.rows.map((r) => [String(r.name), Number(r.sessions)]));
    // Preserve the requested order so the caller can show drop-off.
    return steps.map((name) => ({ name, sessions: map.get(name) ?? 0 }));
  }
}

/** Postgres B2B leads store. */
export class PgLeadsRepository implements LeadsRepository {
  constructor(private readonly pool: pg.Pool) {}
  async createLead(lead: Lead): Promise<{ id: string }> {
    const res = await this.pool.query(
      `INSERT INTO leads (name, email, organization, org_type, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        lead.name.slice(0, 200),
        lead.email.slice(0, 200),
        lead.organization?.slice(0, 200) ?? null,
        lead.orgType?.slice(0, 40) ?? null,
        lead.message?.slice(0, 4000) ?? null,
      ],
    );
    return { id: String(res.rows[0].id) };
  }
}
