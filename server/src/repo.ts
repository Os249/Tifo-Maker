/** Storage layer contracts. Routes own gzip/diff/auth logic; repos own rows. */

export interface DesignMeta {
  id: string;
  title: string;
  /** Arabic title, when the design has one. Set by the starter library, which
   *  ships bilingual names; null for anything a person saved. */
  titleAr?: string | null;
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
  /** Public view count (sharing system). */
  viewCount?: number;
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
  /**
   * Exclude the shipped template library.
   *
   * 619 seeded designs against a handful of real ones means the newest page is
   * almost entirely @tifomaker, and the people the community page exists for are
   * buried under it. This is the other half of `templatesOnly`.
   */
  excludeTemplates?: boolean;
  /** Colour families (see core/facets). A design matches if it carries ANY of them. */
  colors?: string[];
  /** A single club id (see core/facets). */
  clubId?: string;
  /** Page size. Omitted means "no cap" — only the sitemap and the crawler feed
   *  want that; every user-facing list passes one. */
  limit?: number;
  offset?: number;
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
  titleAr?: string | null;
  templateId: string;
  templateVersion: number;
  palette: string[];
  cellsGz: Buffer;
  ownerId: string;
  thumbnailPng: Buffer | null;
}

/** One design for the bulk seeding path. */
export interface SeedDesign {
  title: string;
  titleAr: string | null;
  templateId: string;
  templateVersion: number;
  palette: string[];
  cellsGz: Buffer;
  thumbnailPng: Buffer | null;
  tags: string[];
}

export interface DiffBytes {
  indices: Buffer;
  before: Buffer;
  after: Buffer;
}

export interface DesignRepository {
  create(d: NewDesign): Promise<DesignMeta>;
  listByOwner(ownerId: string): Promise<DesignMeta[]>;
  /** Every title an owner has, with no cap. listByOwner is a profile list and
   *  stops at 200; the template seeder needs the whole set to know what it has
   *  already published, or it re-adds the library on every restart. */
  listTitlesByOwner(ownerId: string): Promise<string[]>;
  /**
   * Insert many designs, already public and flagged as templates, with their
   * tags. One call instead of create + patchMeta + setTemplate + setTags per
   * design: that was about seventeen round trips each, so seeding the 619-design
   * library meant ten thousand serial queries — fine against a socket, minutes
   * against a database across a network. Returns how many were written.
   */
  seedDesigns(ownerId: string, items: SeedDesign[]): Promise<number>;
  /** Delete all of an owner's designs (used by account deletion). */
  deleteByOwner(ownerId: string): Promise<void>;
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
  /** Returns the bytes AND the parent design id, so the caller can apply the
   *  same visibility rule the rest of the design routes use. */
  getPhoto(photoId: string): Promise<{ image: Buffer; designId: string } | null>;
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

  // ---- sharing system ----
  /** Increment a design's public view counter; returns the new total. */
  incrementView(id: string): Promise<number>;
  /** Log a share/open event for a platform (best-effort analytics). */
  recordShare(designId: string, platform: string, kind: 'share' | 'open'): Promise<void>;
  /** Aggregate share analytics for a design. */
  shareStats(id: string): Promise<ShareStats>;
  /** Store the branded social-card image (owner only). Returns false if not owner / not found. */
  setOgImage(id: string, ownerId: string, image: Buffer): Promise<boolean>;
  /** Fetch the branded social-card image bytes, or null. */
  getOgImage(id: string): Promise<Buffer | null>;
}

export interface ShareStats {
  views: number;
  shares: number;
  opens: number;
  byPlatform: Record<string, number>;
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
  /** null until the user adds an email (pre-launch accounts have none). */
  email: string | null;
  /** ISO timestamp when the current email was verified, else null. */
  emailVerifiedAt: string | null;
  /** Paid entitlement: unlimited AI. */
  isPro: boolean;
}

export interface AuthRepository {
  /** Returns null if the username or email is already taken. */
  createUser(
    username: string,
    passwordHash: string,
    opts?: { email?: string | null; acceptedVersion?: string | null },
  ): Promise<UserRow | null>;
  getUserByName(username: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  /** Case-insensitive email lookup (uniqueness checks + password reset). */
  getUserByEmail(email: string): Promise<UserRow | null>;
  /**
   * Attach or replace the caller's email (e.g. pre-launch accounts adding one).
   * Resets verification. Returns false if the email belongs to someone else.
   */
  setEmail(userId: string, email: string, acceptedVersion?: string | null): Promise<boolean>;
  /** Mark the user's current email as verified now. */
  markEmailVerified(userId: string): Promise<void>;
  /**
   * Rename the caller. Returns false if the name belongs to someone else.
   *
   * Attribution joins on the user rather than storing a copy of the name, so a
   * rename follows the person across every design they have ever published —
   * which is why this is safe to offer at all.
   */
  setUsername(userId: string, username: string): Promise<boolean>;
  /** Set the paid (unlimited-AI) entitlement flag. */
  setPro(userId: string, isPro: boolean): Promise<void>;
  createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns the user id for a live (unexpired) token hash. */
  getUserIdByToken(tokenHash: string): Promise<string | null>;
  deleteToken(tokenHash: string): Promise<void>;
  /** Store a single-use email/reset token (hashed), with a purpose + expiry. */
  createEmailToken(userId: string, tokenHash: string, purpose: string, expiresAt: Date): Promise<void>;
  /** Consume a matching, unused, unexpired token; returns its user id and marks it used. */
  consumeEmailToken(tokenHash: string, purpose: string): Promise<string | null>;
  /** Invalidate any outstanding tokens of a purpose for a user (before issuing a new one). */
  deleteEmailTokens(userId: string, purpose: string): Promise<void>;
  /** Replace the user's password hash (change password / reset). */
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Invalidate all of a user's bearer tokens (e.g. force re-login after a reset). */
  deleteUserTokens(userId: string): Promise<void>;
  /** Permanently delete a user (account deletion). Cascades tokens/usage rows. */
  deleteUser(userId: string): Promise<void>;
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

/**
 * What happened to one AI request.
 *
 *  model   the premium model produced a design — the ONLY outcome that spends
 *          a credit, and the only one that costs money
 *  cache   an identical brief was served from the result cache, free
 *  quick   the free offline Quick Designer ran (their choice, or premium off)
 *  quota   the hourly cap was reached, so the user was offered the choice
 *  busy    the daily budget was spent, or the model failed to deliver
 *  blocked the prompt safety screen refused it
 *  invalid the request never got as far as a design (bad or over-long prompt)
 */
export type AiOutcome = 'model' | 'cache' | 'quick' | 'quota' | 'busy' | 'blocked' | 'invalid';

export interface AiEventsRepository {
  /** Best-effort: telemetry must never fail a generation. */
  record(e: { userId: string | null; mode: 'std' | 'super'; outcome: AiOutcome }): Promise<void>;
  stats(days: number): Promise<AiStats>;
}

export interface AiStats {
  days: number;
  /** Since the table started collecting — say so in the UI, it is not "ever". */
  since: string | null;
  totals: Record<AiOutcome, number> & { all: number };
  window: Record<AiOutcome, number> & { all: number };
  /** Premium generations per day in the window. */
  perDay: { day: string; model: number; quick: number; blocked: number }[];
  /** Busiest accounts in the window, most premium generations first. */
  topUsers: { username: string; model: number; quick: number; quota: number; total: number; last: string }[];
  /** Everyone who has ever been turned away by the hourly cap. */
  hitCap: { username: string; times: number; last: string }[];
  modes: { std: number; super: number };
  /** Accounts that have ever had a row in ai_usage (the meter), for contrast. */
  meteredAccounts: number;
}

/** Current hourly metering period, e.g. "2026-06-28T14" (UTC). Usage resets each hour. */
/**
 * The bucket a free-tier AI credit is counted against.
 *
 * Hourly by default, which is what shipped. Set AI_PERIOD=day for the
 * "one or two free designs a day" model — the credit then resets at 00:00 UTC
 * instead of on the hour. Nothing else in the quota path changes.
 */
export type AiPeriodUnit = 'hour' | 'day';
export function aiPeriodUnit(): AiPeriodUnit {
  return process.env.AI_PERIOD === 'day' ? 'day' : 'hour';
}

export function aiPeriod(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return aiPeriodUnit() === 'day' ? day : `${day}T${p(d.getUTCHours())}`;
}

/** Seconds until the current period rolls over (for "resets in …" UI). */
export function secondsToNextPeriod(d: Date = new Date()): number {
  const intoHour = d.getUTCMinutes() * 60 + d.getUTCSeconds();
  if (aiPeriodUnit() === 'hour') return 3600 - intoHour;
  return 86400 - (d.getUTCHours() * 3600 + intoHour);
}
