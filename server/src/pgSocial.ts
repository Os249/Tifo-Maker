import pg from 'pg';
import type {
  SocialRepository,
  DesignMeta,
  PublicProfile,
  CommentItem,
  NotificationItem,
} from './repo';

/** Postgres social layer: remix lineage, follow graph, comments, notifications. */
export class PgSocialRepository implements SocialRepository {
  constructor(private readonly pool: pg.Pool) {}

  // ---- creator explanation + remix ----

  async setPublishMeta(
    designId: string,
    ownerId: string,
    description: string | null,
    allowRemix: boolean,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE designs SET description = $3, allow_remix = $4
       WHERE id = $1 AND owner_id = $2`,
      [designId, ownerId, description?.slice(0, 2000) ?? null, allowRemix],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remix(sourceId: string, newOwnerId: string, title: string): Promise<DesignMeta | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Only public + remixable designs can be remixed. Lock the source row.
      const src = await client.query(
        `SELECT id, template_id, template_version, palette, cells, owner_id, allow_remix, is_public
         FROM designs WHERE id = $1 FOR SHARE`,
        [sourceId],
      );
      if (src.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const s = src.rows[0];
      if (!s.is_public || s.allow_remix === false) {
        await client.query('ROLLBACK');
        return null;
      }
      // Duplicate the data into a brand-new private design owned by the remixer,
      // stamping remixed_from for attribution. The original is never mutated.
      const ins = await client.query(
        `INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, is_public, remixed_from)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7)
         RETURNING id, title, template_id, template_version, palette, revision_count,
                   is_public, owner_id, created_at, updated_at, description, allow_remix, remixed_from`,
        // palette is JSONB: it comes back from SELECT as a parsed JS array, so it
        // must be re-serialized on the way back in (node-pg would otherwise send a
        // JS array as a Postgres array literal, which JSONB rejects → 500).
        [title, s.template_id, s.template_version, typeof s.palette === 'string' ? s.palette : JSON.stringify(s.palette), s.cells, newOwnerId, sourceId],
      );
      // Notify the original creator that their work was remixed.
      if (s.owner_id && s.owner_id !== newOwnerId) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, kind, design_id)
           VALUES ($1, $2, 'remix', $3)`,
          [s.owner_id, newOwnerId, ins.rows[0].id],
        );
      }
      await client.query('COMMIT');
      return rowToMeta(ins.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- follow graph ----

  async follow(followerId: string, followeeId: string): Promise<boolean> {
    if (followerId === followeeId) return false;
    const res = await this.pool.query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [followerId, followeeId],
    );
    if ((res.rowCount ?? 0) > 0) {
      await this.pool.query(
        `INSERT INTO notifications (user_id, actor_id, kind) VALUES ($1, $2, 'new_follower')`,
        [followeeId, followerId],
      );
    }
    return true;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    await this.pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, followeeId]);
    return true;
  }

  async getProfile(userId: string, viewerId?: string | null): Promise<PublicProfile | null> {
    const res = await this.pool.query(
      `SELECT u.id, u.username, u.handle,
              (SELECT count(*)::int FROM follows WHERE followee_id = u.id) AS followers,
              (SELECT count(*)::int FROM follows WHERE follower_id = u.id) AS following,
              (SELECT count(*)::int FROM designs WHERE owner_id = u.id AND is_public) AS designs,
              ${viewerId ? `EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id)` : 'false'} AS is_following
       FROM users u WHERE u.id = $1`,
      viewerId ? [userId, viewerId] : [userId],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      id: String(r.id),
      username: String(r.username),
      handle: r.handle ?? null,
      followerCount: Number(r.followers),
      followingCount: Number(r.following),
      designCount: Number(r.designs),
      isFollowing: Boolean(r.is_following),
    };
  }

  async searchUsers(query: string, limit: number): Promise<PublicProfile[]> {
    const q = query.trim().replace(/^@/, '').toLowerCase();
    if (!q) return [];
    const res = await this.pool.query(
      `SELECT u.id, u.username, u.handle,
              (SELECT count(*)::int FROM follows WHERE followee_id = u.id) AS followers,
              (SELECT count(*)::int FROM follows WHERE follower_id = u.id) AS following,
              (SELECT count(*)::int FROM designs WHERE owner_id = u.id AND is_public) AS designs
       FROM users u
       WHERE lower(u.username) LIKE $1 OR lower(coalesce(u.handle,'')) LIKE $1
       ORDER BY followers DESC LIMIT $2`,
      [`${q}%`, limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      username: String(r.username),
      handle: r.handle ?? null,
      followerCount: Number(r.followers),
      followingCount: Number(r.following),
      designCount: Number(r.designs),
    }));
  }

  // ---- comments ----

  async addComment(designId: string, authorId: string, body: string, parentId: string | null): Promise<CommentItem | null> {
    const text = body.trim().slice(0, 2000);
    if (!text) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO comments (design_id, author_id, parent_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, design_id, author_id, parent_id, body, created_at`,
        [designId, authorId, parentId, text],
      );
      const row = ins.rows[0];
      // Notify the design owner (if it's not their own comment).
      const owner = await client.query('SELECT owner_id FROM designs WHERE id = $1', [designId]);
      const ownerId = owner.rows[0]?.owner_id as string | undefined;
      if (ownerId && ownerId !== authorId) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, kind, design_id, comment_id)
           VALUES ($1, $2, 'comment', $3, $4)`,
          [ownerId, authorId, designId, row.id],
        );
      }
      await client.query('COMMIT');
      const name = await this.pool.query('SELECT username FROM users WHERE id = $1', [authorId]);
      return {
        id: String(row.id),
        designId: String(row.design_id),
        authorId: String(row.author_id),
        authorName: name.rows[0]?.username ?? 'user',
        parentId: row.parent_id ?? null,
        body: row.body,
        createdAt: new Date(row.created_at).toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listComments(designId: string): Promise<CommentItem[]> {
    const res = await this.pool.query(
      `SELECT c.id, c.design_id, c.author_id, c.parent_id, c.body, c.created_at, u.username
       FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.design_id = $1 ORDER BY c.created_at ASC`,
      [designId],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      designId: String(r.design_id),
      authorId: String(r.author_id),
      authorName: String(r.username),
      parentId: r.parent_id ?? null,
      body: r.body,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async deleteComment(commentId: string, requesterId: string): Promise<boolean> {
    // Author OR the design owner may delete a comment.
    const res = await this.pool.query(
      `DELETE FROM comments c USING designs d
       WHERE c.id = $1 AND c.design_id = d.id
         AND (c.author_id = $2 OR d.owner_id = $2)`,
      [commentId, requesterId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---- notifications ----

  /**
   * Fan out a "new public post" notification to all of the author's followers.
   * Called by the routes layer when a design is published. Done as a single
   * INSERT…SELECT so it scales to large follower counts.
   */
  async notifyFollowersOfPost(authorId: string, designId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO notifications (user_id, actor_id, kind, design_id)
       SELECT f.follower_id, $1, 'follow_post', $2 FROM follows f WHERE f.followee_id = $1`,
      [authorId, designId],
    );
  }

  async listNotifications(userId: string, limit: number): Promise<NotificationItem[]> {
    const res = await this.pool.query(
      `SELECT n.id, n.kind, n.actor_id, n.design_id, n.comment_id, n.read_at, n.created_at,
              a.username AS actor_name, d.title AS design_title
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN designs d ON d.id = n.design_id
       WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      actorId: r.actor_id ?? null,
      actorName: r.actor_name ?? null,
      designId: r.design_id ?? null,
      designTitle: r.design_title ?? null,
      commentId: r.comment_id ?? null,
      readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    const res = await this.pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async markNotificationsRead(userId: string, id?: string): Promise<void> {
    if (id) {
      await this.pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = $2 AND read_at IS NULL', [userId, id]);
    } else {
      await this.pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
    }
  }
}

function rowToMeta(r: Record<string, unknown>): DesignMeta {
  return {
    id: String(r.id),
    title: String(r.title),
    templateId: String(r.template_id),
    templateVersion: Number(r.template_version),
    palette: r.palette as string[],
    revisionCount: Number(r.revision_count),
    isPublic: Boolean(r.is_public),
    ownerId: r.owner_id ? String(r.owner_id) : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    description: (r.description as string) ?? null,
    allowRemix: r.allow_remix !== false,
    remixedFrom: r.remixed_from ? String(r.remixed_from) : null,
  };
}
