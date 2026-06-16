import { randomUUID } from 'node:crypto';
import type {
  SocialRepository,
  DesignMeta,
  PublicProfile,
  CommentItem,
  NotificationItem,
} from './repo';
import type { MemoryDesignRepository } from './memoryRepo';
import type { MemoryAuthRepository } from './memoryRepo';

/**
 * In-memory social layer (dev + tests). Shares the design + auth memory repos so
 * it can read designs/usernames and create remixes through the design repo.
 */
export class MemorySocialRepository implements SocialRepository {
  private followsSet = new Set<string>(); // `${follower}->${followee}`
  private comments: (CommentItem & {})[] = [];
  private notifs: (NotificationItem & { userId: string })[] = [];

  constructor(
    private readonly designs: MemoryDesignRepository,
    private readonly auth: MemoryAuthRepository,
  ) {}

  private key(a: string, b: string): string {
    return `${a}->${b}`;
  }
  private notify(userId: string, n: Omit<NotificationItem, 'id' | 'createdAt' | 'readAt'>): void {
    this.notifs.push({
      ...n,
      id: randomUUID(),
      userId,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  }
  private name(id: string | null): string | null {
    return id ? this.auth.usernameOf(id) : null;
  }

  async setPublishMeta(designId: string, ownerId: string, description: string | null, allowRemix: boolean): Promise<boolean> {
    return this.designs.setPublishMetaMem(designId, ownerId, description, allowRemix);
  }

  async remix(sourceId: string, newOwnerId: string, title: string): Promise<DesignMeta | null> {
    const meta = await this.designs.remixMem(sourceId, newOwnerId, title);
    if (!meta) return null;
    const srcOwner = this.designs.ownerOf(sourceId);
    if (srcOwner && srcOwner !== newOwnerId) {
      this.notify(srcOwner, { kind: 'remix', actorId: newOwnerId, actorName: this.name(newOwnerId), designId: meta.id, designTitle: meta.title, commentId: null });
    }
    return meta;
  }

  async follow(followerId: string, followeeId: string): Promise<boolean> {
    if (followerId === followeeId) return false;
    const k = this.key(followerId, followeeId);
    if (!this.followsSet.has(k)) {
      this.followsSet.add(k);
      this.notify(followeeId, { kind: 'new_follower', actorId: followerId, actorName: this.name(followerId), designId: null, designTitle: null, commentId: null });
    }
    return true;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    this.followsSet.delete(this.key(followerId, followeeId));
    return true;
  }

  private followers(userId: string): string[] {
    const out: string[] = [];
    for (const k of this.followsSet) {
      const [f, t] = k.split('->');
      if (t === userId) out.push(f);
    }
    return out;
  }
  private following(userId: string): string[] {
    const out: string[] = [];
    for (const k of this.followsSet) {
      const [f, t] = k.split('->');
      if (f === userId) out.push(t);
    }
    return out;
  }

  async getProfile(userId: string, viewerId?: string | null): Promise<PublicProfile | null> {
    const username = this.auth.usernameOf(userId);
    if (!username) return null;
    return {
      id: userId,
      username,
      handle: this.auth.handleOf(userId),
      followerCount: this.followers(userId).length,
      followingCount: this.following(userId).length,
      designCount: this.designs.publicCountOf(userId),
      isFollowing: viewerId ? this.followsSet.has(this.key(viewerId, userId)) : false,
    };
  }

  async searchUsers(query: string, limit: number): Promise<PublicProfile[]> {
    const q = query.trim().replace(/^@/, '').toLowerCase();
    if (!q) return [];
    const out: PublicProfile[] = [];
    for (const { id, username } of this.auth.allUsers()) {
      const handle = this.auth.handleOf(id);
      if (username.toLowerCase().startsWith(q) || (handle && handle.toLowerCase().startsWith(q))) {
        const p = await this.getProfile(id);
        if (p) out.push(p);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async addComment(designId: string, authorId: string, body: string, parentId: string | null): Promise<CommentItem | null> {
    const text = body.trim().slice(0, 2000);
    if (!text) return null;
    const c: CommentItem = {
      id: randomUUID(),
      designId,
      authorId,
      authorName: this.auth.usernameOf(authorId) ?? 'user',
      parentId,
      body: text,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(c);
    const owner = this.designs.ownerOf(designId);
    if (owner && owner !== authorId) {
      this.notify(owner, { kind: 'comment', actorId: authorId, actorName: c.authorName, designId, designTitle: null, commentId: c.id });
    }
    return c;
  }

  async listComments(designId: string): Promise<CommentItem[]> {
    return this.comments.filter((c) => c.designId === designId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteComment(commentId: string, requesterId: string): Promise<boolean> {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return false;
    const owner = this.designs.ownerOf(c.designId);
    if (c.authorId !== requesterId && owner !== requesterId) return false;
    this.comments = this.comments.filter((x) => x.id !== commentId);
    return true;
  }

  async notifyFollowersOfPost(authorId: string, designId: string): Promise<void> {
    const title = (await this.designs.getMeta?.(designId))?.title ?? null;
    for (const f of this.followers(authorId)) {
      this.notify(f, { kind: 'follow_post', actorId: authorId, actorName: this.name(authorId), designId, designTitle: title, commentId: null });
    }
  }

  async listNotifications(userId: string, limit: number): Promise<NotificationItem[]> {
    return this.notifs
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ userId: _u, ...n }) => n);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notifs.filter((n) => n.userId === userId && n.readAt === null).length;
  }

  async markNotificationsRead(userId: string, id?: string): Promise<void> {
    for (const n of this.notifs) {
      if (n.userId === userId && n.readAt === null && (!id || n.id === id)) n.readAt = new Date().toISOString();
    }
  }
}
