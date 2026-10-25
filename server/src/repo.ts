/** Storage layer contracts. Routes own gzip/diff/auth logic; repos own rows. */
import { createHash } from 'node:crypto';
import type { FeedPosition } from './feedCursor';

import type { AiFailReason } from './aiFailure';
export type { AiFailReason } from './aiFailure';

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
  /** Pinned to the top of its owner's Projects page. Private to the owner. */
  pinned?: boolean;
  /**
   * When the owner moved it to the Trash, or null. A trashed design is private
   * while it sits there and is deleted for good 30 days later.
   */
  deletedAt?: string | null;
  /** How the project began, when that is worth a badge: 'ai' for now. */
  origin?: string | null;
  /**
   * A moderator took it down. Permanent: it can never be made public again by
   * its owner, from the editor, the Trash or a copy (audit round four).
   */
  takenDown?: boolean;
}

/** One card on the owner's Projects page. */
export interface ProjectItem extends DesignMeta {
  hasThumbnail: boolean;
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
  /**
   * How many comments the design's thread holds: exactly the number
   * `GET /api/designs/:id/comments` returns, so the feed can show it without
   * fetching every thread (performance plan P1.11). Only ever on a public
   * design's card, whose thread is public too.
   */
  commentCount: number;
}

/** Which public designs a facet count is over: the four scopes the feed's tabs ask for. */
export interface FacetScope {
  excludeTemplates?: boolean;
  templatesOnly?: boolean;
}

/** What the filter chips can offer for one scope, counted over public designs only. */
export interface FacetBase {
  total: number;
  /** Colour family -> how many public designs carry it. */
  colors: Record<string, number>;
  /** Club id -> how many public designs are that club's. */
  clubs: Record<string, number>;
}

export type GallerySort = 'recent' | 'likes';

/** A page of the feed, and where the next one starts (null: this was the last). */
export interface FeedPage {
  items: GalleryItem[];
  next: FeedPosition | null;
}

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

/**
 * How many revisions a design keeps. The history list shows at most 200, and
 * nothing replays older ones, so anything past this is storage without a use:
 * one owner could otherwise append without limit (audit round four).
 */
export const REVISIONS_KEPT = 200;

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
  /** See DesignMeta.origin. */
  origin?: string | null;
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
  /**
   * Every design an owner has, trashed ones included, newest edit first, for
   * the Projects page. Uncapped on purpose: listByOwner stops at 200, and a
   * project that silently drops off the end of your own list is a lost project.
   */
  listProjects(ownerId: string): Promise<ProjectItem[]>;
  /** Pin or unpin. Deliberately leaves updated_at alone: pinning is not an edit. */
  setPinned(id: string, pinned: boolean): Promise<DesignMeta | null>;
  /**
   * Move to the Trash. The design goes private while it is there, and
   * remembers whether it was published so a restore can put that back.
   */
  trash(id: string): Promise<DesignMeta | null>;
  /** Take it back out of the Trash, published again if it was before. */
  restore(id: string): Promise<DesignMeta | null>;
  /** Delete one design for good. */
  purge(id: string): Promise<boolean>;
  /** Delete for good everything trashed before `cutoff`. Returns how many. */
  purgeTrashed(cutoff: Date): Promise<number>;
  /** Delete all of an owner's designs (used by account deletion). */
  deleteByOwner(ownerId: string): Promise<void>;
  listPublic(query: GalleryQuery): Promise<GalleryItem[]>;
  /**
   * One page of the community feed and the position the next one starts after
   * (performance plan P3.4). The same rows, in the same order, as listPublic
   * with the same query; `after` (a position from a previous page's `next`)
   * only adds "after this row" to the WHERE, so every filter still applies.
   * `next` is null on the last page.
   */
  listPublicPage(query: GalleryQuery & { after?: FeedPosition | null }): Promise<FeedPage>;
  /**
   * How many public designs a feed query would return, without fetching them:
   * the "N tifos" on the filter panel's confirm button. Same rules as
   * listPublic (public only, the same filters), no paging.
   */
  countPublic(query: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId' | 'sort'>): Promise<number>;
  /**
   * The colour and club counts for one scope of the feed, counted from the
   * stored facet columns (performance plan P1.12). Public designs only.
   */
  facetBase(scope: FacetScope): Promise<FacetBase>;
  /**
   * One person's PUBLIC designs, newest first, at most `limit`: a profile's
   * "created" list. Never listByOwner, which is the owner's own list and
   * includes their private designs.
   */
  listPublicByOwner(ownerId: string, opts: { viewerId?: string | null; limit: number }): Promise<GalleryItem[]>;
  /** Ids and last edits of public designs, newest first, for the sitemap. */
  listPublicIds(limit: number): Promise<{ id: string; updatedAt: string }[]>;
  /**
   * One public design as a feed card, or null if it is private or gone.
   *
   * The same projection listPublic returns, for the cases that arrive at a
   * single design rather than a page of them: a notification being opened, a
   * /community?t=<id> link. Loading a 60-card page to find one card was the
   * alternative.
   */
  getPublicItem(id: string, viewerId?: string | null): Promise<GalleryItem | null>;
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
  /**
   * The design's scene — its banners, gzipped JSON. Null when it has none.
   *
   * Kept off the design row and out of the save path on purpose: see the
   * comment on `design_scenes` in schema.sql. A scene that fails to save must
   * not be able to take a tifo down with it.
   */
  getScene(id: string): Promise<Buffer | null>;
  /**
   * Store a scene, with the sha-256 of its bytes in the same write (P2.5):
   * the anonymous view keys its stripped copy by that hash, so the hash can
   * never describe other bytes than the ones stored.
   */
  putScene(id: string, sceneGz: Buffer): Promise<boolean>;
  /**
   * Who may see a design's scene, and the stored hash of it, without reading
   * the scene (P2.5): visibility, owner and hash only. Null when there is no
   * such design. `hash` is null for a scene stored before hashes were, or none.
   */
  getSceneMeta(id: string): Promise<SceneMeta | null>;
  /** The scene and its stored hash, read together (P2.5). Null when it has none. */
  getSceneRow(id: string): Promise<{ gz: Buffer; hash: string | null } | null>;
  /**
   * Who may see a design's thumbnail and the stored sha-256 of the picture,
   * without the picture (P2.4). Null when there is no such design.
   */
  getThumbnailMeta(id: string): Promise<ThumbnailMeta | null>;
  /** The same with the picture, in one read (P2.4). */
  getThumbnailRow(id: string): Promise<(ThumbnailMeta & { png: Buffer | null }) | null>;
  /**
   * Fill in the hashes of pictures and scenes stored before hashes were, from
   * the stored bytes themselves. With an id, that one design (a view found it
   * missing); without, every row, in small batches (at boot, on the
   * maintenance pool). Returns how many were filled.
   */
  backfillHashes(id?: string): Promise<number>;
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

/** What the thumbnail route needs before it decides to send a picture (P2.4). */
export interface ThumbnailMeta {
  isPublic: boolean;
  ownerId: string | null;
  /** sha-256 (hex) of the stored picture; null when unknown (stored before hashes) or none. */
  hash: string | null;
  hasThumbnail: boolean;
}

/** What the scene route needs before it decides to read a scene (P2.5). */
export interface SceneMeta {
  isPublic: boolean;
  ownerId: string | null;
  /** sha-256 (hex) of the stored scene; null when unknown or there is none. */
  hash: string | null;
  hasScene: boolean;
}

/** sha-256 of stored bytes, as hex: the same text Postgres's encode(sha256(x), 'hex') gives. */
export const contentHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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
  /** The design a comment is on, or null when there is no such comment. */
  commentDesign(commentId: string): Promise<string | null>;
  /**
   * Delete a comment (its author or the design's owner). Replies to it stay,
   * with no parent: they are other people's words, and the thread shows them
   * at the top level.
   */
  deleteComment(commentId: string, requesterId: string): Promise<boolean>;

  // ---- notifications ----
  /** Fan out a "new public post" notification to all the author's followers. */
  notifyFollowersOfPost(authorId: string, designId: string): Promise<void>;
  /**
   * Tell a creator their design is the Tifo of the Day on the home page.
   *
   * The site itself is the actor here, not a person, so the notification is
   * stored with no actor_id — which the column already allows and the feed
   * already renders ("Someone" is replaced by the featured wording client-side).
   */
  notifyFeatured(userId: string, designId: string): Promise<void>;
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
  /** null for an account that only ever signed in with a provider. */
  passwordHash: string | null;
  /** null until the user adds an email (pre-launch accounts have none). */
  email: string | null;
  /** ISO timestamp when the current email was verified, else null. */
  emailVerifiedAt: string | null;
  /** Paid entitlement: unlimited AI. */
  isPro: boolean;
  /**
   * False only while an account is wearing a name we invented for it.
   *
   * A provider gives us an email, never a handle, and the handle is the public
   * part. Until the owner picks one, `requireUser` refuses everything except
   * the handful of routes needed to pick it.
   */
  usernameChosen: boolean;
}

export interface AuthRepository {
  /**
   * Returns null if the username or email is already taken.
   *
   * `passwordHash` is null for an account created by signing in with a
   * provider. Such an account has no password until the owner sets one from
   * the account page, and `setPasswordHash` is what does that.
   */
  createUser(
    username: string,
    passwordHash: string | null,
    opts?: {
      email?: string | null;
      acceptedVersion?: string | null;
      emailVerified?: boolean;
      /** False for a provider sign-up: the name is ours, not theirs, until they say so. */
      usernameChosen?: boolean;
    },
  ): Promise<UserRow | null>;
  getUserByName(username: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  /** Case-insensitive email lookup (uniqueness checks + password reset). */
  getUserByEmail(email: string): Promise<UserRow | null>;
  /**
   * Attach or replace the caller's email (e.g. pre-launch accounts adding one).
   * Resets verification and spends every outstanding password-reset link, in
   * one step: a link already sent to the old address must not outlive the move,
   * and as a second write its failure was swallowed (audit round six). Returns
   * false if the email belongs to someone else, and then changes nothing.
   *
   * With `expectedHash` (null for an account without a password), the move
   * happens only while the password is still that one, and is otherwise false
   * too: an email change confirmed with the old password must not land after a
   * reset took the account back (audit round six).
   */
  setEmail(userId: string, email: string, acceptedVersion?: string | null, expectedHash?: string | null): Promise<boolean>;
  /** Mark the user's current email as verified now. */
  /**
   * Mark the email verified. With `email`, only while the account's address is
   * still that one (case-insensitive), in one statement; true when marked.
   */
  markEmailVerified(userId: string, email?: string): Promise<boolean>;
  /**
   * Rename the caller. Returns false if the name belongs to someone else.
   *
   * Attribution joins on the user rather than storing a copy of the name, so a
   * rename follows the person across every design they have ever published —
   * which is why this is safe to offer at all.
   */
  setUsername(userId: string, username: string): Promise<boolean>;
  /** Did this account pick its own @name, or is it still wearing ours? */
  hasChosenUsername(userId: string): Promise<boolean>;
  /** Set the paid (unlimited-AI) entitlement flag. */
  setPro(userId: string, isPro: boolean): Promise<void>;
  createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns the user id for a live (unexpired) token hash. */
  getUserIdByToken(tokenHash: string): Promise<string | null>;
  /**
   * The account a live session token opens, token and account read together
   * in one statement (performance plan P2.17): the token joined to its user,
   * `expires_at > now()`. Null for an unknown, expired or revoked token, and
   * for a deleted account, whose tokens go with it. The routes keep the
   * answer for the one request that asked and never longer, so a sign-out, a
   * password change or a deletion is refused on the very next request.
   */
  getSessionUser(tokenHash: string): Promise<UserRow | null>;
  deleteToken(tokenHash: string): Promise<void>;
  /** Store a single-use email/reset token (hashed), with a purpose + expiry. */
  createEmailToken(userId: string, tokenHash: string, purpose: string, expiresAt: Date): Promise<void>;
  /**
   * Store one only while the account's email is still `email`. A reset link
   * worked out for an address that an email change then replaced would
   * otherwise be mailed to the old address and work (audit round six).
   */
  createEmailTokenForAddress(userId: string, email: string, tokenHash: string, purpose: string, expiresAt: Date): Promise<boolean>;
  /** Consume a matching, unused, unexpired token; returns its user id and marks it used. */
  consumeEmailToken(tokenHash: string, purpose: string): Promise<string | null>;
  /** Invalidate any outstanding tokens of a purpose for a user (before issuing a new one). */
  deleteEmailTokens(userId: string, purpose: string): Promise<void>;
  /** Replace the user's password hash (change password / reset). */
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Invalidate all of a user's bearer tokens (e.g. force re-login after a reset). */
  deleteUserTokens(userId: string): Promise<void>;
  /**
   * A new password, and every other way into the account ended, as ONE step.
   *
   * Sets the hash, deletes every bearer token and every unexchanged Google/X
   * sign-in ticket, deletes every outstanding reset link unless
   * `keepResetLinks`, optionally removes the account's Google/X sign-ins (a
   * reset takes an account back from whoever connected them), and optionally
   * issues the one session the caller keeps. All of it happens or none of it
   * does: done as separate writes, a failure halfway left the old sessions
   * alive while the reply said "signed out everywhere" (audit round six).
   *
   * With `expectedHash` (null: the account has no password yet) it happens
   * only while the password is still that one, and is false otherwise: a
   * change confirmed with the old password must not land after a reset.
   *
   * Ordered so that nothing running at the same moment can slip a way in past
   * it: the account row is locked first, then its sessions, then identities
   * and tickets go, then the hash, then the tokens. See createTokenIfPassword,
   * createHandoffIfLinked, exchangeHandoff and linkIdentityForSession, which
   * check the same rows. False also when the account does not exist.
   */
  replacePassword(
    userId: string,
    passwordHash: string,
    opts?: {
      dropIdentities?: boolean;
      keepResetLinks?: boolean;
      expectedHash?: string | null;
      newSession?: { tokenHash: string; expiresAt: Date };
    },
  ): Promise<boolean>;
  /**
   * Store an upgraded hash only while the stored one is still `expected`.
   * A sign-in rehashing the old password must never write it back over a
   * password that a reset set while the sign-in was checking (audit round six).
   */
  upgradePasswordHash(userId: string, expected: string, next: string): Promise<boolean>;
  /**
   * Issue a session only while the account's password is still the one the
   * sign-in just verified. False, and nothing stored, when it changed: a
   * sign-in that overlapped a reset or a password change used to come away
   * with a session that outlived "signed out everywhere" (audit round six).
   */
  createTokenIfPassword(userId: string, verifiedHash: string, tokenHash: string, expiresAt: Date): Promise<boolean>;
  /**
   * Store a Google/X sign-in ticket only while that identity still opens this
   * account. False when a reset removed it in the meantime.
   */
  createHandoffIfLinked(
    userId: string,
    provider: string,
    providerUserId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean>;
  /**
   * Spend a sign-in ticket and issue the session for it, as one step. Returns
   * the account id, or null when the ticket is unknown, used, expired or was
   * cancelled by a reset.
   */
  exchangeHandoff(ticketHash: string, tokenHash: string, expiresAt: Date): Promise<string | null>;
  /** Permanently delete a user (account deletion). Cascades tokens/usage rows. */
  deleteUser(userId: string): Promise<void>;

  // ---- federated identities (Sign in with Google) ----
  /**
   * Which account owns this provider identity, if any.
   *
   * Keyed on the provider's id for the person, never their email — see
   * `oauth_identities` in schema.sql.
   */
  getUserIdByIdentity(provider: string, providerUserId: string): Promise<string | null>;
  /** Attach an identity. False when it already belongs to a different account. */
  linkIdentity(provider: string, providerUserId: string, userId: string): Promise<boolean>;
  /**
   * Attach one only while the session that asked for it is still live, in one
   * step. Checked first and written second, a reset landing in between left
   * the new sign-in on an account it had just taken back (audit round six).
   * False when the session is gone or the identity is someone else's.
   */
  linkIdentityForSession(provider: string, providerUserId: string, userId: string, sessionTokenHash: string): Promise<boolean>;
  /** Detach one. False when this user had no identity with that provider. */
  unlinkIdentity(provider: string, userId: string): Promise<boolean>;
  /** The providers this user can sign in with, for the account page. */
  identitiesFor(userId: string): Promise<string[]>;
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
  /** Delete events older than `before`; returns how many went. */
  purge(before: Date): Promise<number>;
}

/**
 * How long raw funnel events are kept. They were never deleted: anyone may
 * post one, at about 200 bytes a row, so the table only ever grew (audit round
 * five). The funnel reads at most 365 days back and the admin overview 30, so
 * a little over a year loses nothing either of them shows.
 */
export const EVENTS_RETENTION_DAYS = 400;

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

/** std/super are generations; polish (the vision critic) and photo (reading a
 *  ground photo) are the two other premium calls. Until October 2026 polish and
 *  photo were recorded only when they FAILED; their successes are recorded now
 *  too (outcome 'model'), and the design counts below leave them out. */
export type AiMode = 'std' | 'super' | 'polish' | 'photo';

/** What a request cost, measured from the provider's own usage numbers. */
export interface AiEventUsage {
  /** The model that answered (the one that failed last, when none did). */
  model?: string | null;
  /** Whole request, as the user waited for it. */
  latencyMs?: number | null;
  tokensIn?: number;
  /** Answer tokens, thinking excluded. */
  tokensOut?: number;
  tokensThought?: number;
  tokensCached?: number;
  /** Provider calls made, failed ones and retries included. */
  calls?: number;
  /** Pictures delivered for this request. */
  pictures?: number;
  /** Estimated list-price cost in millionths of a dollar; null when a price is unknown. */
  costMicros?: number | null;
}

export interface AiEventInput extends AiEventUsage {
  /** The signed-in account. With the admin password this is still the account
   *  the operator was signed into, when there is one — "by which user". */
  userId: string | null;
  mode: AiMode;
  outcome: AiOutcome;
  /** Why it failed (see aiFailure.ts). Null for a request that succeeded. */
  reason?: AiFailReason | null;
  /** Sanitized provider text for the operator. Never the prompt. */
  detail?: string | null;
  /** 'password' when the admin unlock token made the call. */
  via?: 'password' | null;
}

export interface AiEventsRepository {
  /** Best-effort: telemetry must never fail a generation. */
  record(e: AiEventInput): Promise<void>;
  stats(days: number): Promise<AiStats>;
}

/**
 * The daily AI budget, kept somewhere a deploy cannot wipe.
 *
 * AI_DAILY_BUDGET used to live in a variable, so every deploy or restart gave
 * the day a fresh 1,000 — and a day of Railway deploys multiplied the cap.
 * The route still counts in memory (it answers on every request); this is
 * where the count is read back from on start-up and written to as it grows.
 */
export interface AiBudgetRepository {
  /** What has been spent on a UTC day ("YYYY-MM-DD"). */
  load(day: string): Promise<{ calls: number; pictures: number }>;
  /** Add to a day's count. Best-effort: never fails a generation. */
  add(day: string, calls: number, pictures: number): Promise<void>;
}

/** Outcome counts for one mode. */
export type AiOutcomeCounts = Record<AiOutcome, number> & { all: number };
/**
 * Outcome counts for one mode, plus how many of its "busy" rows were OUR
 * limits (the daily budget, an account's daily share, no provider) rather
 * than the model failing. The reliability table leaves those out of the rate.
 */
export type AiModeOutcomes = AiOutcomeCounts & { limited: number };

/** What the AI cost in the window, from measured tokens (list prices). */
export interface AiCostStats {
  /** First request that carried token counts; nothing before it was measured. */
  measuredSince: string | null;
  /** Requests in the window that carried token counts. */
  measured: number;
  /** Estimated spend in the window, US dollars. */
  usd: number;
  /** Requests whose price could not be worked out (a model missing from the price table). */
  unpriced: number;
  perDay: { day: string; usd: number }[];
  /**
   * Per mode: requests measured, total and average cost per DELIVERED result.
   * perDelivered divides by priced deliveries only, and is null when none
   * was priced: an unknown price must never read as $0.
   */
  byMode: Record<AiMode, { measured: number; delivered: number; usd: number; perDelivered: number | null }>;
  tokens: { in: number; out: number; thought: number; cached: number };
  pictures: number;
  /** Which models answered delivered requests, most used first. usd is null when none of them could be priced. */
  models: { model: string; requests: number; usd: number | null }[];
  /** Average wait for a delivered result, per mode, in milliseconds. */
  latencyMs: Record<AiMode, number | null>;
}

/** One failed (or partly failed) request, for the admin "why" table. */
export interface AiFailureRow {
  at: string;
  username: string;
  via: 'password' | null;
  mode: AiMode;
  outcome: AiOutcome;
  reason: AiFailReason;
  detail: string;
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
  modes: { std: number; super: number; polish: number; photo: number };
  /** Accounts that have ever had a row in ai_usage (the meter), for contrast. */
  meteredAccounts: number;
  /** Failures in the window by reason, most frequent first. */
  failures: { reason: AiFailReason; count: number; last: string }[];
  /** The latest failures in the window, newest first (at most 50). */
  recentFailures: AiFailureRow[];
  /** Outcomes split by mode, so "how often does Super fail" has an answer. */
  modeOutcomes: Record<AiMode, AiModeOutcomes>;
  cost: AiCostStats;
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
