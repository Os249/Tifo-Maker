import pg from 'pg';
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
  RevisionRow,
  UserRow,
  EventsRepository,
  FunnelStep,
  PhotoMeta,
  ReportItem,
  PhotoReviewItem,
} from './repo';
import { normalizeTags } from './memoryRepo';

const META_COLS =
  'id, title, template_id, template_version, palette, revision_count, is_public, owner_id, created_at, updated_at, description, allow_remix, remixed_from';

function rowToMeta(r: Record<string, unknown>): DesignMeta {
  return {
    id: String(r.id),
    title: String(r.title),
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
  };
}

/** Postgres AI quota store. consume() is atomic via a conditional UPSERT. */
export class PgAiUsageRepository implements AiUsageRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string, limit: number): Promise<AiUsage> {
    const r = await this.pool.query('SELECT used FROM ai_usage WHERE user_id = $1', [userId]);
    const used = r.rows[0] ? Number(r.rows[0].used) : 0;
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  async consume(userId: string, limit: number): Promise<{ allowed: boolean } & AiUsage> {
    // First generation inserts used=1; later ones increment ONLY while under the
    // limit (the WHERE on DO UPDATE). No matching row returned ⇒ over quota.
    const r = await this.pool.query(
      `INSERT INTO ai_usage (user_id, used) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET used = ai_usage.used + 1, updated_at = now()
         WHERE ai_usage.used < $2
       RETURNING used`,
      [userId, limit],
    );
    if (r.rows[0]) {
      const used = Number(r.rows[0].used);
      return { allowed: true, used, limit, remaining: Math.max(0, limit - used) };
    }
    return { allowed: false, ...(await this.get(userId, limit)) };
  }
}

/** Postgres design repository. Diffs and snapshots append in one transaction. */
export class PgDesignRepository implements DesignRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(d: NewDesign): Promise<DesignMeta> {
    const res = await this.pool.query(
      `INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, thumbnail)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING ${META_COLS}`,
      [d.title, d.templateId, d.templateVersion, JSON.stringify(d.palette), d.cellsGz, d.ownerId, d.thumbnailPng],
    );
    return rowToMeta(res.rows[0]);
  }

  async listByOwner(ownerId: string): Promise<DesignMeta[]> {
    const res = await this.pool.query(
      `SELECT ${META_COLS} FROM designs WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 200`,
      [ownerId],
    );
    return res.rows.map(rowToMeta);
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    const params: unknown[] = [];
    let where = 'd.is_public';
    if (query.templatesOnly) where += ' AND d.is_template';
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
    const order = query.sort === 'likes' ? 'd.like_score DESC, d.updated_at DESC' : 'd.updated_at DESC';
    const res = await this.pool.query(
      `SELECT d.id, d.title, d.template_id, d.template_version, d.palette, d.revision_count,
              d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score, d.is_template,
              d.description, d.allow_remix, d.remixed_from,
              coalesce(u.username, 'unknown') AS owner_name,
              ru.username AS remixed_from_name, rd.title AS remixed_from_title,
              (d.thumbnail IS NOT NULL) AS has_thumbnail,
              coalesce((SELECT array_agg(t.slug ORDER BY t.slug) FROM design_tags dt
                        JOIN tags t ON t.id = dt.tag_id WHERE dt.design_id = d.id), '{}') AS tags,
              EXISTS (SELECT 1 FROM design_photos dp WHERE dp.design_id = d.id) AS has_photo,
              ${voteSelect}
       FROM designs d
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN designs rd ON rd.id = d.remixed_from
       LEFT JOIN users ru ON ru.id = rd.owner_id
       ${viewerJoin}
       WHERE ${where} ORDER BY ${order} LIMIT 200`,
      params,
    );
    return res.rows.map((r) => ({
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
    }));
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
      `SELECT d.id, d.title, d.template_id, d.template_version, d.palette, d.revision_count,
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
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
  }

  async patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null> {
    const res = await this.pool.query(
      `UPDATE designs SET title = coalesce($2, title), is_public = coalesce($3, is_public), updated_at = now()
       WHERE id = $1 RETURNING ${META_COLS}`,
      [id, patch.title ?? null, patch.isPublic ?? null],
    );
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
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
    return res.rowCount ? rowToMeta(res.rows[0]) : null;
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

  async getPhoto(photoId: string): Promise<{ image: Buffer } | null> {
    const res = await this.pool.query('SELECT image FROM design_photos WHERE id = $1', [photoId]);
    return res.rowCount ? { image: res.rows[0].image as Buffer } : null;
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
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createUser(username: string, passwordHash: string): Promise<UserRow | null> {
    try {
      const res = await this.pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash',
        [username, passwordHash],
      );
      const r = res.rows[0];
      return { id: String(r.id), username: String(r.username), passwordHash: String(r.password_hash) };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null; // unique_violation
      throw err;
    }
  }

  async getUserByName(username: string): Promise<UserRow | null> {
    const res = await this.pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return { id: String(r.id), username: String(r.username), passwordHash: String(r.password_hash) };
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query('SELECT id, username, password_hash FROM users WHERE id = $1', [id]);
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return { id: String(r.id), username: String(r.username), passwordHash: String(r.password_hash) };
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
