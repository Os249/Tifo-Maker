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
  /** Creator's explanation/backstory, shown in the 3D preview. */
  description?: string | null;
  /** Whether others may remix this design. */
  allowRemix?: boolean;
  /** Lineage: the design this was remixed from, if any. */
  remixedFrom?: string | null;
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
  /** If remixed, the original creator's handle/name for attribution. */
  remixedFromName?: string | null;
  remixedFromTitle?: string | null;
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

// ============ social layer ============

export interface PublicProfile {
  id: string;
  username: string;
  handle: string | null;
  followerCount: number;
  followingCount: number;
  designCount: number;
  /** Whether the viewing user follows this profile. */
  isFollowing?: boolean;
}

export interface CommentItem {
  id: string;
  designId: string;
  authorId: string;
  authorName: string;
  parentId: string | null;
  body: string;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: string;
  actorId: string | null;
  actorName: string | null;
  designId: string | null;
  designTitle: string | null;
  commentId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SocialRepository {
  // ---- creator explanation + remix ----
  /** Set a design's description/explanation + remix permission (owner only). */
  setPublishMeta(designId: string, ownerId: string, description: string | null, allowRemix: boolean): Promise<boolean>;
  /**
   * Remix a public, remixable design into a new owner's account: duplicates the
   * data without mutating the original, stamping remixed_from for attribution.
   * Returns the new design, or null if not remixable / not found.
   */
  remix(sourceId: string, newOwnerId: string, title: string): Promise<DesignMeta | null>;

  // ---- follow graph ----
  follow(followerId: string, followeeId: string): Promise<boolean>;
  unfollow(followerId: string, followeeId: string): Promise<boolean>;
  /** Public profile by user id, with counts and (optional) viewer follow state. */
  getProfile(userId: string, viewerId?: string | null): Promise<PublicProfile | null>;
  /** Search users by username/handle prefix. */
  searchUsers(query: string, limit: number): Promise<PublicProfile[]>;

  // ---- comments ----
  addComment(designId: string, authorId: string, body: string, parentId: string | null): Promise<CommentItem | null>;
  listComments(designId: string): Promise<CommentItem[]>;
  deleteComment(commentId: string, requesterId: string): Promise<boolean>;

  // ---- notifications ----
  /** Fan out a "new public post" notification to all the author's followers. */
  notifyFollowersOfPost(authorId: string, designId: string): Promise<void>;
  /** Recent notifications for a user, newest first. */
  listNotifications(userId: string, limit: number): Promise<NotificationItem[]>;
  /** Count of unread notifications. */
  unreadCount(userId: string): Promise<number>;
  /** Mark all (or one) notification read. */
  markNotificationsRead(userId: string, id?: string): Promise<void>;
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

// ============ B2B leads ============

export interface Lead {
  name: string;
  email: string;
  organization?: string | null;
  orgType?: string | null;
  message?: string | null;
}

export interface LeadsRepository {
  /** Store a B2B enterprise lead from the For Clubs page. */
  createLead(lead: Lead): Promise<{ id: string }>;
}

// ============ AI Tifo Designer quota ============

export interface AiUsage {
  /** Generations consumed so far by this account. */
  used: number;
  /** The free ceiling applied. */
  limit: number;
  /** Generations remaining (never negative). */
  remaining: number;
}

export interface AiUsageRepository {
  /** Read a user's current usage WITHOUT consuming a credit. */
  get(userId: string, limit: number): Promise<AiUsage>;
  /**
   * Atomically consume one credit if the user is under `limit`. Returns whether
   * it was allowed plus the resulting usage. Safe under concurrent calls.
   */
  consume(userId: string, limit: number): Promise<{ allowed: boolean } & AiUsage>;
}
