import pg from 'pg';
import { aiPeriod } from './repo';
import type {
  AuthRepository,
  AiUsage,
  AiUsageRepository,
  DesignMeta,
  DesignRecord,
  DesignRepository,
  DiffBytes,
  GalleryItem,
  GalleryQuery,
  Lead,
  LeadsRepository,
  NewDesign,
  AiEventsRepository,
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
import { designFacets } from '../../src/core/facets';

const META_COLS =
  'id, title, title_ar, template_id, template_version, palette, revision_count, is_public, owner_id, created_at, updated_at, description, allow_remix, remixed_from, view_count';

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
const GALLERY_COLS =
  `d.id, d.title, d.title_ar, d.template_id, d.template_version, d.palette, d.revision_count,
   d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score, d.is_template,
   d.description, d.allow_remix, d.remixed_from, d.view_count,
   coalesce(u.username, 'unknown') AS owner_name,
   ru.username AS remixed_from_name, rd.title AS remixed_from_title,
   (d.thumbnail IS NOT NULL) AS has_thumbnail,
   coalesce((SELECT array_agg(t.slug ORDER BY t.slug) FROM design_tags dt
             JOIN tags t ON t.id = dt.tag_id WHERE dt.design_id = d.id), '{}') AS tags,
   EXISTS (SELECT 1 FROM design_photos dp WHERE dp.design_id = d.id) AS has_photo`;

const GALLERY_JOINS =
  `FROM designs d
   LEFT JOIN users u ON u.id = d.owner_id
   LEFT JOIN designs rd ON rd.id = d.remixed_from
   LEFT JOIN users ru ON ru.id = rd.owner_id`;

function rowToGalleryItem(r: Record<string, unknown>): GalleryItem {
  return {
    ...rowToMeta(r),
    ownerName: String(r.owner_name),
    hasThumbnail: Boolean(r.has_thumbnail),
    likeScore: Number(r.like_score ?? 0),
    myVote: Number(r.my_vote ?? 0),
    isTemplate: Boolean(r.is_template),
    tags: (r.tags as string[]) ?? [],
    hasPhoto: Boolean(r.has_photo),
    remixedFromName: (r.remixed_from_name as string) ?? null,
    remixedFromTitle: (r.remixed_from_title as string) ?? null,
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

/** Postgres AI history. One row per request — see the ai_events comment in schema.sql. */
export class PgAiEventsRepository implements AiEventsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async record(e: { userId: string | null; mode: 'std' | 'super'; outcome: AiOutcome }): Promise<void> {
    await this.pool.query(
      'INSERT INTO ai_events (user_id, mode, outcome) VALUES ($1, $2, $3)',
      [e.userId, e.mode, e.outcome],
    );
  }

  async stats(days: number): Promise<AiStats> {
    const since = `${days} days`;
    const [tot, win, perDay, top, cap, modes, metered, first] = await Promise.all([
      this.pool.query('SELECT outcome, count(*)::int AS n FROM ai_events GROUP BY outcome'),
      this.pool.query(
        `SELECT outcome, count(*)::int AS n FROM ai_events WHERE at > now() - $1::interval GROUP BY outcome`,
        [since],
      ),
      this.pool.query(
        `SELECT to_char(at AT TIME ZONE 'utc','YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE outcome = 'model')::int   AS model,
                count(*) FILTER (WHERE outcome = 'quick')::int   AS quick,
                count(*) FILTER (WHERE outcome = 'blocked')::int AS blocked
         FROM ai_events WHERE at > now() - $1::interval GROUP BY day ORDER BY day`,
        [since],
      ),
      this.pool.query(
        `SELECT coalesce(u.username, 'admin / unlocked') AS username,
                count(*) FILTER (WHERE e.outcome = 'model')::int AS model,
                count(*) FILTER (WHERE e.outcome = 'quick')::int AS quick,
                count(*) FILTER (WHERE e.outcome = 'quota')::int AS quota,
                count(*)::int AS total, max(e.at) AS last
         FROM ai_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.at > now() - $1::interval
         GROUP BY 1 ORDER BY model DESC, total DESC LIMIT 20`,
        [since],
      ),
      // Not windowed: "has anyone ever hit the cap" is the question.
      this.pool.query(
        `SELECT coalesce(u.username, 'admin / unlocked') AS username,
                count(*)::int AS times, max(e.at) AS last
         FROM ai_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.outcome = 'quota' GROUP BY 1 ORDER BY times DESC LIMIT 20`,
      ),
      this.pool.query(
        `SELECT mode, count(*)::int AS n FROM ai_events WHERE at > now() - $1::interval GROUP BY mode`,
        [since],
      ),
      this.pool.query('SELECT count(*)::int AS n FROM ai_usage WHERE used > 0'),
      this.pool.query('SELECT min(at) AS first FROM ai_events'),
    ]);

    const fold = (rows: { outcome: string; n: number }[]) => {
      const out = zero();
      for (const r of rows) {
        if ((OUTCOMES as string[]).includes(r.outcome)) out[r.outcome as AiOutcome] = Number(r.n);
        out.all += Number(r.n);
      }
      return out;
    };
    const m = { std: 0, super: 0 };
    for (const r of modes.rows) {
      if (r.mode === 'super') m.super = Number(r.n); else m.std += Number(r.n);
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
    };
  }
}

/** Postgres design repository. Diffs and snapshots append in one transaction. */
export class PgDesignRepository implements DesignRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(d: NewDesign): Promise<DesignMeta> {
    const res = await this.pool.query(
      `INSERT INTO designs (title, title_ar, template_id, template_version, palette, cells, owner_id, thumbnail)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING ${META_COLS}`,
      [d.title, d.titleAr ?? null, d.templateId, d.templateVersion, JSON.stringify(d.palette), d.cellsGz, d.ownerId, d.thumbnailPng],
    );
    await this.syncFacets(res.rows[0].id as string, { title: d.title, titleAr: d.titleAr, palette: d.palette });
    return rowToMeta(res.rows[0]);
  }

  async listByOwner(ownerId: string): Promise<DesignMeta[]> {
    const res = await this.pool.query(
      `SELECT ${META_COLS} FROM designs WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 200`,
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
    const client = await this.pool.connect();
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

  async deleteByOwner(ownerId: string): Promise<void> {
    await this.pool.query('DELETE FROM designs WHERE owner_id = $1', [ownerId]);
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
    const res = await this.pool.query<{ id: string; title: string; title_ar: string | null; palette: string[] }>(
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
    await this.pool.query(
      `UPDATE designs d SET colors = v.colors, club_id = v.club_id
         FROM (VALUES ${values.join(', ')}) AS v(id, colors, club_id)
        WHERE d.id = v.id`,
      params,
    );
    return res.rowCount;
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    const params: unknown[] = [];
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
              EXISTS (SELECT 1 FROM design_photos dp WHERE dp.design_id = d.id) AS has_photo
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

  async patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET title = coalesce($2, title), is_public = coalesce($3, is_public), updated_at = now()
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
    const res = await this.pool.query(
      `INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, thumbnail)
       SELECT $2, template_id, template_version, palette, cells, $3, thumbnail FROM designs WHERE id = $1
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
      const upd = await client.query('UPDATE designs SET is_public = false WHERE id = $1', [designId]);
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
}): UserRow {
  return {
    id: String(r.id),
    username: String(r.username),
    passwordHash: String(r.password_hash),
    email: r.email == null ? null : String(r.email),
    emailVerifiedAt: r.email_verified_at == null ? null : new Date(r.email_verified_at as string).toISOString(),
    isPro: r.is_pro === true,
  };
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createUser(
    username: string,
    passwordHash: string,
    opts: { email?: string | null; acceptedVersion?: string | null } = {},
  ): Promise<UserRow | null> {
    const acceptedVersion = opts.acceptedVersion ?? null;
    const acceptedAt = acceptedVersion ? new Date() : null;
    try {
      const res = await this.pool.query(
        `INSERT INTO users (username, password_hash, email, accepted_terms_version, accepted_terms_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, password_hash, email, email_verified_at`,
        [username, passwordHash, opts.email ?? null, acceptedVersion, acceptedAt],
      );
      return mapUserRow(res.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null; // username or email taken
      throw err;
    }
  }

  async getUserByName(username: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at FROM users WHERE username = $1',
      [username],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at FROM users WHERE id = $1',
      [id],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, email, email_verified_at FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return res.rowCount ? mapUserRow(res.rows[0]) : null;
  }

  async setEmail(userId: string, email: string, acceptedVersion?: string | null): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `UPDATE users
           SET email = $2,
               email_verified_at = NULL,
               accepted_terms_version = COALESCE($3, accepted_terms_version),
               accepted_terms_at = CASE WHEN $3 IS NULL THEN accepted_terms_at ELSE now() END
         WHERE id = $1`,
        [userId, email, acceptedVersion ?? null],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false; // email taken
      throw err;
    }
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
  }

  async setUsername(userId: string, username: string): Promise<boolean> {
    try {
      const res = await this.pool.query('UPDATE users SET username = $2 WHERE id = $1', [userId, username]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false; // name taken
      throw err;
    }
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

  async deleteUser(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
}

/** Postgres events repo. Append-only inserts; funnel via one grouped query. */
export class PgEventsRepository implements EventsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async record(sessionId: string, name: string, signedIn: boolean): Promise<void> {
    await this.pool.query(
      'INSERT INTO events (session_id, name, signed_in) VALUES ($1, $2, $3)',
      [sessionId.slice(0, 64), name.slice(0, 40), signedIn],
    );
  }

  async funnel(steps: string[], days: number): Promise<FunnelStep[]> {
    const res = await this.pool.query(
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
