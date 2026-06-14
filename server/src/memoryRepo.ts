import { randomUUID } from 'node:crypto';
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

interface Row extends DesignRecord {
  thumbnail: Buffer | null;
  revisions: { seq: number; diff: DiffBytes; snapshot: Buffer | null; createdAt: string }[];
  /** userId → vote value (+1/-1). */
  votes: Map<string, number>;
  votedAt: Map<string, number>;
}

/** In-memory repositories: dev mode and route tests. Same contracts as Postgres. */
export class MemoryDesignRepository implements DesignRepository {
  private rows = new Map<string, Row>();
  constructor(private readonly usernames: (id: string | null) => string = () => 'unknown') {}

  private meta(r: Row): DesignMeta {
    const { id, title, templateId, templateVersion, palette, revisionCount, isPublic, ownerId, createdAt, updatedAt } = r;
    return { id, title, templateId, templateVersion, palette: [...palette], revisionCount, isPublic, ownerId, createdAt, updatedAt };
  }

  async create(d: NewDesign): Promise<DesignMeta> {
    const now = new Date().toISOString();
    const row: Row = {
      id: randomUUID(),
      title: d.title,
      templateId: d.templateId,
      templateVersion: d.templateVersion,
      palette: [...d.palette],
      cellsGz: d.cellsGz,
      ownerId: d.ownerId,
      isPublic: false,
      thumbnail: d.thumbnailPng,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      revisions: [],
      votes: new Map(),
      votedAt: new Map(),
    };
    this.rows.set(row.id, row);
    return this.meta(row);
  }

  async listByOwner(ownerId: string): Promise<DesignMeta[]> {
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => this.meta(r));
  }

  private score(r: Row): number {
    let s = 0;
    for (const v of r.votes.values()) s += v;
    return s;
  }

  private galleryItem(r: Row, viewerId?: string | null): GalleryItem {
    return {
      ...this.meta(r),
      ownerName: this.usernames(r.ownerId),
      hasThumbnail: r.thumbnail !== null,
      likeScore: this.score(r),
      myVote: viewerId ? (r.votes.get(viewerId) ?? 0) : 0,
    };
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    let rows = [...this.rows.values()].filter((r) => r.isPublic);
    if (query.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(q));
    }
    rows.sort((a, b) =>
      query.sort === 'likes'
        ? this.score(b) - this.score(a) || b.updatedAt.localeCompare(a.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
    return rows.map((r) => this.galleryItem(r, query.viewerId));
  }

  async vote(
    designId: string,
    userId: string,
    value: -1 | 0 | 1,
  ): Promise<{ likeScore: number; myVote: number } | null> {
    const r = this.rows.get(designId);
    if (!r || !r.isPublic) return null;
    if (value === 0) {
      r.votes.delete(userId);
      r.votedAt.delete(userId);
    } else {
      r.votes.set(userId, value);
      r.votedAt.set(userId, Date.now());
    }
    return { likeScore: this.score(r), myVote: value };
  }

  async listLikedBy(userId: string): Promise<GalleryItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.isPublic && r.votes.get(userId) === 1)
      .sort((a, b) => (b.votedAt.get(userId) ?? 0) - (a.votedAt.get(userId) ?? 0))
      .map((r) => this.galleryItem(r, userId));
  }

  async get(id: string): Promise<DesignRecord | null> {
    const r = this.rows.get(id);
    return r ? { ...this.meta(r), cellsGz: r.cellsGz } : null;
  }

  async updateCells(id: string, cellsGz: Buffer, palette: string[], thumbnailPng: Buffer | null): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.cellsGz = cellsGz;
    r.palette = [...palette];
    if (thumbnailPng) r.thumbnail = thumbnailPng;
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (patch.title !== undefined) r.title = patch.title;
    if (patch.isPublic !== undefined) r.isPublic = patch.isPublic;
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async getThumbnail(id: string): Promise<Buffer | null> {
    return this.rows.get(id)?.thumbnail ?? null;
  }

  async appendRevision(id: string, diff: DiffBytes, newCellsGz: Buffer, snapshot: Buffer | null): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.revisionCount += 1;
    r.revisions.push({ seq: r.revisionCount, diff, snapshot, createdAt: new Date().toISOString() });
    r.cellsGz = newCellsGz;
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async listRevisions(id: string, limit: number): Promise<RevisionRow[]> {
    const r = this.rows.get(id);
    if (!r) return [];
    return r.revisions.slice(-limit).reverse().map((v) => ({
      seq: v.seq,
      changed: v.diff.indices.byteLength / 4,
      hasSnapshot: v.snapshot !== null,
      createdAt: v.createdAt,
    }));
  }

  async fork(id: string, title: string, ownerId: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return this.create({
      title,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      palette: r.palette,
      cellsGz: r.cellsGz,
      ownerId,
      thumbnailPng: r.thumbnail,
    });
  }
}

export class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRow>(); // by username
  private tokens = new Map<string, { userId: string; expiresAt: number }>();

  async createUser(username: string, passwordHash: string): Promise<UserRow | null> {
    if (this.users.has(username)) return null;
    const row: UserRow = { id: randomUUID(), username, passwordHash };
    this.users.set(username, row);
    return row;
  }

  async getUserByName(username: string): Promise<UserRow | null> {
    return this.users.get(username) ?? null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.id === id) return u;
    return null;
  }

  async createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.tokens.set(tokenHash, { userId, expiresAt: expiresAt.getTime() });
  }

  async getUserIdByToken(tokenHash: string): Promise<string | null> {
    const t = this.tokens.get(tokenHash);
    if (!t || t.expiresAt < Date.now()) return null;
    return t.userId;
  }

  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }

  usernameOf(id: string | null): string {
    for (const u of this.users.values()) if (u.id === id) return u.username;
    return 'unknown';
  }
}
