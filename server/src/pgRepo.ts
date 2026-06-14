import pg from 'pg';
import type {
  AuthRepository,
  DesignMeta,
  DesignRecord,
  DesignRepository,
  DiffBytes,
  GalleryItem,
  GalleryQuery,
  NewDesign,
  RevisionRow,
  UserRow,
} from './repo';

const META_COLS =
  'id, title, template_id, template_version, palette, revision_count, is_public, owner_id, created_at, updated_at';

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
  };
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
    if (query.search && query.search.trim()) {
      params.push(`%${query.search.trim()}%`);
      where += ` AND d.title ILIKE $${params.length}`;
    }
    // Optionally annotate each row with the viewer's vote.
    let voteSelect = '0 AS my_vote';
    if (query.viewerId) {
      params.push(query.viewerId);
      voteSelect = `coalesce(v.value, 0) AS my_vote`;
      // join handled below via the param index
    }
    const viewerJoin = query.viewerId
      ? `LEFT JOIN design_votes v ON v.design_id = d.id AND v.user_id = $${params.length}`
      : '';
    const order = query.sort === 'likes' ? 'd.like_score DESC, d.updated_at DESC' : 'd.updated_at DESC';
    const res = await this.pool.query(
      `SELECT d.id, d.title, d.template_id, d.template_version, d.palette, d.revision_count,
              d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score,
              coalesce(u.username, 'unknown') AS owner_name,
              (d.thumbnail IS NOT NULL) AS has_thumbnail,
              ${voteSelect}
       FROM designs d
       LEFT JOIN users u ON u.id = d.owner_id
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
              d.is_public, d.owner_id, d.created_at, d.updated_at, d.like_score,
              coalesce(u.username, 'unknown') AS owner_name,
              (d.thumbnail IS NOT NULL) AS has_thumbnail, 1 AS my_vote
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
