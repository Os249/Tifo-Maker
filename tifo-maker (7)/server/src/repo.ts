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
  listPublic(): Promise<GalleryItem[]>;
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
  createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns the user id for a live (unexpired) token hash. */
  getUserIdByToken(tokenHash: string): Promise<string | null>;
  deleteToken(tokenHash: string): Promise<void>;
}
