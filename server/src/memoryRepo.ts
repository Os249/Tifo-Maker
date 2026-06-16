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
  EventsRepository,
  PhotoMeta,
  ReportItem,
  PhotoReviewItem,
  FunnelStep,
} from './repo';

interface Row extends DesignRecord {
  thumbnail: Buffer | null;
  revisions: { seq: number; diff: DiffBytes; snapshot: Buffer | null; createdAt: string }[];
  /** userId → vote value (+1/-1). */
  votes: Map<string, number>;
  votedAt: Map<string, number>;
  isTemplate: boolean;
  tags: string[];
}

/** In-memory repositories: dev mode and route tests. Same contracts as Postgres. */
export class MemoryDesignRepository implements DesignRepository {
  private rows = new Map<string, Row>();
  constructor(private readonly usernames: (id: string | null) => string = () => 'unknown') {}

  private meta(r: Row): DesignMeta {
    const { id, title, templateId, templateVersion, palette, revisionCount, isPublic, ownerId, createdAt, updatedAt, description, allowRemix, remixedFrom } = r;
    return { id, title, templateId, templateVersion, palette: [...palette], revisionCount, isPublic, ownerId, createdAt, updatedAt, description: description ?? null, allowRemix: allowRemix !== false, remixedFrom: remixedFrom ?? null };
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
      isTemplate: false,
      tags: [],
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
    const source = r.remixedFrom ? this.rows.get(r.remixedFrom) : null;
    return {
      ...this.meta(r),
      ownerName: this.usernames(r.ownerId),
      hasThumbnail: r.thumbnail !== null,
      likeScore: this.score(r),
      myVote: viewerId ? (r.votes.get(viewerId) ?? 0) : 0,
      isTemplate: r.isTemplate,
      tags: [...r.tags],
      hasPhoto: this.photos.some((p) => p.designId === r.id),
      remixedFromName: source ? this.usernames(source.ownerId) : null,
      remixedFromTitle: source ? source.title : null,
    };
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    let rows = [...this.rows.values()].filter((r) => r.isPublic);
    if (query.templatesOnly) rows = rows.filter((r) => r.isTemplate);
    if (query.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(q));
    }
    if (query.tags && query.tags.length > 0) {
      const want = query.tags.map((t) => t.toLowerCase());
      rows = rows.filter((r) => want.every((t) => r.tags.includes(t)));
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

  // ---- social helpers (used by MemorySocialRepository) ----
  ownerOf(id: string): string | null {
    return this.rows.get(id)?.ownerId ?? null;
  }
  publicCountOf(ownerId: string): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.ownerId === ownerId && r.isPublic) n++;
    return n;
  }
  async getMeta(id: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    return r ? this.meta(r) : null;
  }
  setPublishMetaMem(designId: string, ownerId: string, description: string | null, allowRemix: boolean): boolean {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return false;
    r.description = description?.slice(0, 2000) ?? null;
    r.allowRemix = allowRemix;
    return true;
  }
  async remixMem(sourceId: string, newOwnerId: string, title: string): Promise<DesignMeta | null> {
    const r = this.rows.get(sourceId);
    if (!r || !r.isPublic || r.allowRemix === false) return null;
    const meta = await this.create({
      title,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      palette: r.palette,
      cellsGz: r.cellsGz,
      ownerId: newOwnerId,
      thumbnailPng: r.thumbnail,
    });
    const row = this.rows.get(meta.id);
    if (row) row.remixedFrom = sourceId;
    return { ...meta, remixedFrom: sourceId };
  }

  async setTags(designId: string, ownerId: string, slugs: string[]): Promise<string[] | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    r.tags = normalizeTags(slugs);
    return [...r.tags];
  }

  async setTemplate(designId: string, ownerId: string, isTemplate: boolean): Promise<boolean | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    r.isTemplate = isTemplate;
    return r.isTemplate;
  }

  async popularTags(limit: number): Promise<{ slug: string; kind: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (!r.isPublic) continue;
      for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([slug, count]) => ({ slug, kind: 'topic', count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private reports: { id: string; targetType: string; targetId: string; reporterId: string | null; reason: string; status: string; createdAt: string }[] = [];
  async report(targetType: 'design' | 'comment', targetId: string, reporterId: string | null, reason: string): Promise<string> {
    const id = randomUUID();
    this.reports.push({ id, targetType, targetId, reporterId, reason, status: 'open', createdAt: new Date().toISOString() });
    return id;
  }

  private photos: (PhotoMeta & { image: Buffer })[] = [];
  async addPhoto(designId: string, ownerId: string, image: Buffer, width: number, height: number, caption: string | null): Promise<string | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    const id = randomUUID();
    this.photos.push({ id, designId, image, width, height, caption, isVerified: false, createdAt: new Date().toISOString() });
    return id;
  }
  async listPhotos(designId: string): Promise<PhotoMeta[]> {
    return this.photos
      .filter((p) => p.designId === designId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ image: _image, ...meta }) => meta);
  }
  async getPhoto(photoId: string): Promise<{ image: Buffer } | null> {
    const p = this.photos.find((x) => x.id === photoId);
    return p ? { image: p.image } : null;
  }
  async deletePhoto(photoId: string, ownerId: string): Promise<boolean> {
    const p = this.photos.find((x) => x.id === photoId);
    if (!p) return false;
    const r = this.rows.get(p.designId);
    if (!r || r.ownerId !== ownerId) return false;
    this.photos = this.photos.filter((x) => x.id !== photoId);
    return true;
  }

  async listReports(status: string, limit: number): Promise<ReportItem[]> {
    return this.reports
      .filter((r) => r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => {
        const d = r.targetType === 'design' ? this.rows.get(r.targetId) : undefined;
        return {
          id: r.id,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          status: r.status,
          createdAt: r.createdAt,
          targetTitle: d?.title ?? null,
          targetOwner: d ? this.usernames(d.ownerId) : null,
          targetIsPublic: d ? d.isPublic : null,
          targetHasThumbnail: d?.thumbnail != null,
        };
      });
  }

  async setReportStatus(reportId: string, status: string): Promise<boolean> {
    const r = this.reports.find((x) => x.id === reportId);
    if (!r) return false;
    r.status = status;
    return true;
  }

  async takedownDesign(designId: string): Promise<boolean> {
    const d = this.rows.get(designId);
    if (!d) return false;
    d.isPublic = false;
    for (const r of this.reports) {
      if (r.targetType === 'design' && r.targetId === designId && r.status === 'open') r.status = 'actioned';
    }
    return true;
  }

  async listUnverifiedPhotos(limit: number): Promise<PhotoReviewItem[]> {
    return this.photos
      .filter((p) => !p.isVerified)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        designId: p.designId,
        designTitle: this.rows.get(p.designId)?.title ?? null,
        caption: p.caption,
        createdAt: p.createdAt,
      }));
  }

  async setPhotoVerified(photoId: string, verified: boolean): Promise<boolean> {
    const p = this.photos.find((x) => x.id === photoId);
    if (!p) return false;
    p.isVerified = verified;
    return true;
  }

  async deletePhotoAsModerator(photoId: string): Promise<boolean> {
    const before = this.photos.length;
    this.photos = this.photos.filter((x) => x.id !== photoId);
    return this.photos.length < before;
  }
}

/** Lowercase, hyphenate, dedupe, cap to a sane count + length. */
export function normalizeTags(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
    if (out.length >= 8) break;
  }
  return out;
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

  // ---- social helpers ----
  private handles = new Map<string, string>(); // userId → handle
  handleOf(id: string): string | null {
    return this.handles.get(id) ?? null;
  }
  setHandle(id: string, handle: string): void {
    this.handles.set(id, handle);
  }
  allUsers(): { id: string; username: string }[] {
    return [...this.users.values()].map((u) => ({ id: u.id, username: u.username }));
  }
}

/** In-memory events repo (dev + tests). Holds events in an array. */
export class MemoryEventsRepository implements EventsRepository {
  private events: { sessionId: string; name: string; signedIn: boolean; at: number }[] = [];

  async record(sessionId: string, name: string, signedIn: boolean): Promise<void> {
    this.events.push({ sessionId, name, signedIn, at: Date.now() });
  }

  async funnel(steps: string[], days: number): Promise<FunnelStep[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return steps.map((name) => {
      const sessions = new Set(
        this.events.filter((e) => e.name === name && e.at >= cutoff).map((e) => e.sessionId),
      );
      return { name, sessions: sessions.size };
    });
  }
}
