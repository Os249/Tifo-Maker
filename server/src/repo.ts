/** Storage layer contracts. Routes own gzip/diff/auth logic; repos own rows. */

export interface DesignMeta {
  id: string;
  title: string;
  templateId: string;
  templateVersion: number;
  palette: string[];
  revisionCount: number;
  isPublic: boolean;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryItem extends DesignMeta {
  ownerName: string;
  hasThumbnail: boolean;
  likeScore: number;
  /** The requesting user's vote on this design: 1, -1, or 0/undefined. */
  myVote?: number;
  isTemplate: boolean;
  tags: string[];
  /** True when at least one real match-day photo is attached (Before/After). */
  hasPhoto: boolean;
}

export type GallerySort = 'recent' | 'likes';

export interface GalleryQuery {
  sort: GallerySort;
  search?: string;
  /** When set, annotate each item with this user's vote. */
  viewerId?: string | null;
  /** Filter to designs carrying ALL of these tag slugs. */
  tags?: string[];
  /** Only return designs flagged as templates. */
  templatesOnly?: boolean;
}

export interface DesignRecord extends DesignMeta {
  /** Gzipped cell buffer. */
  cellsGz: Buffer;
}

export interface RevisionRow {
  seq: number;
  changed: number;
  hasSnapshot: boolean;
  createdAt: string;
}

export interface NewDesign {
  title: string;
  templateId: string;
  templateVersion: number;
  palette: string[];
  cellsGz: Buffer;
  ownerId: string;
  thumbnailPng: Buffer | null;
}

export interface DiffBytes {
  indices: Buffer;
  before: Buffer;
  after: Buffer;
}

export interface DesignRepository {
  create(d: NewDesign): Promise<DesignMeta>;
  listByOwner(ownerId: string): Promise<DesignMeta[]>;
  listPublic(query: GalleryQuery): Promise<GalleryItem[]>;
  get(id: string): Promise<DesignRecord | null>;
  /** thumbnailPng null = keep existing. */
  updateCells(
    id: string,
    cellsGz: Buffer,
    palette: string[],
    thumbnailPng: Buffer | null,
  ): Promise<DesignMeta | null>;
  patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null>;
  getThumbnail(id: string): Promise<Buffer | null>;
  appendRevision(
    id: string,
    diff: DiffBytes,
    newCellsGz: Buffer,
    snapshot: Buffer | null,
  ): Promise<DesignMeta | null>;
  listRevisions(id: string, limit: number): Promise<RevisionRow[]>;
  fork(id: string, title: string, ownerId: string): Promise<DesignMeta | null>;
  /** Set a user's vote (1 like, -1 dislike, 0 clears it). Returns new score + vote. */
  vote(designId: string, userId: string, value: -1 | 0 | 1): Promise<{ likeScore: number; myVote: number } | null>;
  /** Public designs a user has liked (value = 1), newest first. */
  listLikedBy(userId: string): Promise<GalleryItem[]>;
  /** Replace a design's tags (slugs); only the owner should call. Returns the stored slugs. */
  setTags(designId: string, ownerId: string, slugs: string[]): Promise<string[] | null>;
  /** Flag/unflag a design as a template (owner only). */
  setTemplate(designId: string, ownerId: string, isTemplate: boolean): Promise<boolean | null>;
  /** Most-used tag slugs across public designs, for the filter chips. */
  popularTags(limit: number): Promise<{ slug: string; kind: string; count: number }[]>;
  /** File a moderation report against a public item. Returns the report id. */
  report(targetType: 'design' | 'comment', targetId: string, reporterId: string | null, reason: string): Promise<string>;
  /** Attach a real match-day photo to a design (owner only). Returns the photo id, or null if not owner. */
  addPhoto(designId: string, ownerId: string, image: Buffer, width: number, height: number, caption: string | null): Promise<string | null>;
  /** A design's photos (id, dimensions, caption, verified) newest first — no image bytes. */
  listPhotos(designId: string): Promise<PhotoMeta[]>;
  /** Raw bytes for one photo (for the image route). */
  getPhoto(photoId: string): Promise<{ image: Buffer } | null>;
  /** Delete a photo (owner of the parent design only). */
  deletePhoto(photoId: string, ownerId: string): Promise<boolean>;

  // ---- moderation / trust & safety (admin only at the route layer) ----
  /** Open reports, newest first, enriched with target context for review. */
  listReports(status: string, limit: number): Promise<ReportItem[]>;
  /** Set a report's status (open|reviewed|actioned). */
  setReportStatus(reportId: string, status: string): Promise<boolean>;
  /** Take a design down: make it private + mark its open reports actioned. */
  takedownDesign(designId: string): Promise<boolean>;
  /** Photos awaiting verification, newest first, with design context. */
  listUnverifiedPhotos(limit: number): Promise<PhotoReviewItem[]>;
  /** Set a photo's verified flag (moderator confirmation of a genuine match). */
  setPhotoVerified(photoId: string, verified: boolean): Promise<boolean>;
  /** Moderator override: delete any photo regardless of owner. */
  deletePhotoAsModerator(photoId: string): Promise<boolean>;
}

export interface ReportItem {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
  /** Context (present for design targets that still exist). */
  targetTitle: string | null;
  targetOwner: string | null;
  targetIsPublic: boolean | null;
  targetHasThumbnail: boolean;
}

export interface PhotoReviewItem {
  id: string;
  designId: string;
  designTitle: string | null;
  caption: string | null;
  createdAt: string;
}

export interface PhotoMeta {
  id: string;
  designId: string;
  width: number;
  height: number;
  caption: string | null;
  isVerified: boolean;
  createdAt: string;
}

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
}

export interface AuthRepository {
  /** Returns null if the username is taken. */
  createUser(username: string, passwordHash: string): Promise<UserRow | null>;
  getUserByName(username: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns the user id for a live (unexpired) token hash. */
  getUserIdByToken(tokenHash: string): Promise<string | null>;
  deleteToken(tokenHash: string): Promise<void>;
}

/** A single point in the conversion funnel, with how many unique sessions reached it. */
export interface FunnelStep {
  name: string;
  sessions: number;
}

export interface EventsRepository {
  /** Record one anonymous event. Best-effort; never throws on bad input upstream. */
  record(sessionId: string, name: string, signedIn: boolean): Promise<void>;
  /**
   * Funnel summary over the last `days`: for each named step, the count of
   * distinct sessions that fired it. Steps are returned in the given order so
   * the caller can render drop-off between consecutive stages.
   */
  funnel(steps: string[], days: number): Promise<FunnelStep[]>;
}
