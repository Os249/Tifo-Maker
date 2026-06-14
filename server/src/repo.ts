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
}

export type GallerySort = 'recent' | 'likes';

export interface GalleryQuery {
  sort: GallerySort;
  search?: string;
  /** When set, annotate each item with this user's vote. */
  viewerId?: string | null;
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
