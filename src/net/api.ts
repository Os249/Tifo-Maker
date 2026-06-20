import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';
import type { TifoSpec } from '../core/tifoSpec';

/**
 * Browser client for the Tifo Maker API. Cells gzip client-side with
 * CompressionStream (a 60k design is ~300 B on the wire); thumbnails are
 * rendered client-side on save, exactly as the blueprint planned — the server
 * never rasterizes anything.
 *
 * The bearer token lives in module memory: a page refresh signs you out.
 * Swapping in persistent storage is a product decision for later.
 */

const API = '/api';
const TOKEN_KEY = 'tifo_token_v1';
// Restore a persisted session on load so auth survives navigation between the
// editor, the community page, and share links (all separate page loads).
let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session stays in-memory for this page */
  }
}

export const isSignedIn = (): boolean => token !== null;

/** Sign out: clear the persisted session. */
export function signOut(): void {
  setToken(null);
}

function authHeaders(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- auth ----------

export async function login(username: string, password: string): Promise<string> {
  const data = (await expectOk(
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  )) as { token: string; username: string };
  setToken(data.token);
  return data.username;
}

export async function register(username: string, password: string): Promise<string> {
  const data = (await expectOk(
    await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  )) as { token: string; username: string };
  setToken(data.token);
  return data.username;
}

// ---------- codecs ----------

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- thumbnail ----------

/** Render the design to a small PNG strip (the gallery card image). */
export function makeThumbnailB64(map: SeatMap, store: DesignStore): string {
  const W = 420;
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const scale = W / bw;
  const H = Math.max(24, Math.round(bh * scale) + 4);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#14171f';
  ctx.fillRect(0, 0, W, H);
  const colors = store.palette.map((hex, i) => (i === 0 ? '#262a33' : hex));
  for (let c = 0; c < colors.length; c++) {
    ctx.fillStyle = colors[c];
    for (let i = 0; i < map.count; i++) {
      if (store.cells[i] !== c) continue;
      const x = (map.xy[i * 2] - map.bounds.minX) * scale;
      const y = (map.xy[i * 2 + 1] - map.bounds.minY) * scale + 2;
      ctx.fillRect(x, y, Math.max(0.6, 3.2 * scale), Math.max(1, 8 * scale * 0.85));
    }
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

// ---------- designs ----------

export interface SavedMeta {
  id: string;
  title: string;
  isPublic: boolean;
  updatedAt: string;
}

/** Create (no id) or overwrite (with id) a design, including a fresh thumbnail. */
export async function saveDesign(
  store: DesignStore,
  map: SeatMap,
  templateId: string,
  templateVersion: number,
  title: string,
  id: string | null,
): Promise<SavedMeta> {
  const cellsGzB64 = toB64(await gzip(store.cells));
  const thumbnailPngB64 = makeThumbnailB64(map, store);
  const payload = id
    ? { palette: store.palette, cellsGzB64, thumbnailPngB64 }
    : { title, templateId, templateVersion, palette: store.palette, cellsGzB64, thumbnailPngB64 };
  const res = await fetch(id ? `${API}/designs/${id}` : `${API}/designs`, {
    method: id ? 'PUT' : 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(payload),
  });
  return (await expectOk(res)) as SavedMeta;
}

export async function setPublic(id: string, isPublic: boolean): Promise<SavedMeta> {
  const res = await fetch(`${API}/designs/${id}`, {
    method: 'PATCH',
    headers: authHeaders(true),
    body: JSON.stringify({ isPublic }),
  });
  return (await expectOk(res)) as SavedMeta;
}

/** Fetch a design (must be public or yours) and load it into the store. */
export async function loadDesign(
  store: DesignStore,
  id: string,
): Promise<{ title: string; isPublic: boolean; ownerIsMe: boolean; templateId: string; templateVersion: number }> {
  const data = (await expectOk(await fetch(`${API}/designs/${id}`, { headers: authHeaders(false) }))) as {
    title: string;
    palette: string[];
    cellsGzB64: string;
    isPublic: boolean;
    ownerId: string | null;
    templateId: string;
    templateVersion: number;
  };
  const cells = await gunzip(fromB64(data.cellsGzB64));
  store.setPalette(data.palette.slice(0, 256));
  store.loadCells(cells);
  let ownerIsMe = false;
  if (token) {
    const me = (await expectOk(await fetch(`${API}/me`, { headers: authHeaders(false) }))) as { id: string };
    ownerIsMe = me.id === data.ownerId;
  }
  return {
    title: data.title,
    isPublic: data.isPublic,
    ownerIsMe,
    templateId: data.templateId,
    templateVersion: data.templateVersion,
  };
}

/** Fetch a design's template id/version without loading cells (for share-link boot). */
export async function fetchDesignTemplate(id: string): Promise<{ templateId: string; templateVersion: number }> {
  const data = (await expectOk(await fetch(`${API}/designs/${id}`, { headers: authHeaders(false) }))) as {
    templateId: string;
    templateVersion: number;
  };
  return { templateId: data.templateId, templateVersion: data.templateVersion };
}

/** Canonical shareable link for a design: https://host/d/:id */
export function shareUrl(id: string): string {
  return `${location.origin}/d/${id}`;
}

export interface GalleryItem {
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string;
  hasThumbnail: boolean;
  likeScore: number;
  myVote: number;
  updatedAt: string;
  isTemplate: boolean;
  tags: string[];
  hasPhoto: boolean;
  description?: string | null;
  allowRemix?: boolean;
  remixedFrom?: string | null;
  remixedFromName?: string | null;
  remixedFromTitle?: string | null;
}

export type GallerySort = 'recent' | 'likes';

export async function listGallery(
  opts: { sort?: GallerySort; search?: string; tags?: string[]; templatesOnly?: boolean } = {},
): Promise<GalleryItem[]> {
  const params = new URLSearchParams();
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.search) params.set('search', opts.search);
  if (opts.tags && opts.tags.length) params.set('tags', opts.tags.join(','));
  if (opts.templatesOnly) params.set('templates', '1');
  const qs = params.toString();
  return (await expectOk(await fetch(`${API}/gallery${qs ? `?${qs}` : ''}`, { headers: authHeaders(false) }))) as GalleryItem[];
}

/** Most-used tags across public designs (for filter chips). */
export async function listPopularTags(): Promise<{ slug: string; kind: string; count: number }[]> {
  return (await expectOk(await fetch(`${API}/tags`))) as { slug: string; kind: string; count: number }[];
}

/** Replace a design's tags (owner only). */
export async function setDesignTags(id: string, tags: string[]): Promise<string[]> {
  const res = (await expectOk(
    await fetch(`${API}/designs/${id}/tags`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ tags }) }),
  )) as { tags: string[] };
  return res.tags;
}

/** Flag/unflag a design as a community template (owner only). */
export async function setDesignTemplate(id: string, isTemplate: boolean): Promise<boolean> {
  const res = (await expectOk(
    await fetch(`${API}/designs/${id}/template`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify({ isTemplate }),
    }),
  )) as { isTemplate: boolean };
  return res.isTemplate;
}

/** Report a public design for moderation. */
/** Report a public design for moderation. */
export async function reportDesign(id: string, reason: string): Promise<void> {
  await expectOk(
    await fetch(`${API}/report`, {
      method: 'POST',
      headers: authHeaders(false),
      body: JSON.stringify({ targetType: 'design', targetId: id, reason }),
    }),
  );
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

/** A design's real match-day photos (newest first). */
export async function listPhotos(designId: string): Promise<PhotoMeta[]> {
  return (await expectOk(await fetch(`${API}/designs/${designId}/photos`))) as PhotoMeta[];
}

export const photoUrl = (photoId: string): string => `${API}/photos/${photoId}`;

/**
 * Resize an image file to fit within maxDim (longest edge) as a JPEG, keeping
 * uploads lean, then upload it as a match-day photo. Returns the new photo id.
 */
export async function uploadPhoto(
  designId: string,
  file: File,
  caption: string,
  maxDim = 1600,
): Promise<string> {
  const { dataUrl, width, height } = await resizeToJpeg(file, maxDim);
  const imageB64 = dataUrl.split(',')[1];
  const res = (await expectOk(
    await fetch(`${API}/designs/${designId}/photos`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ imageB64, width, height, caption }),
    }),
  )) as { photoId: string };
  return res.photoId;
}

/** Delete a photo (owner only). */
export async function deletePhoto(photoId: string): Promise<void> {
  await expectOk(await fetch(`${API}/photos/${photoId}`, { method: 'DELETE', headers: authHeaders(true) }));
}

/** Downscale an image to fit maxDim and re-encode as JPEG. Browser-side. */
async function resizeToJpeg(file: File, maxDim: number): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width, height };
}

/** Like (1), dislike (-1), or clear (0) a design. Returns the new score + vote. */
export async function voteDesign(id: string, value: 1 | -1 | 0): Promise<{ likeScore: number; myVote: number }> {
  return (await expectOk(
    await fetch(`${API}/designs/${id}/vote`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ value }),
    }),
  )) as { likeScore: number; myVote: number };
}

export interface ProfileData {
  id: string;
  username: string;
  created: GalleryItem[];
  liked: GalleryItem[];
  handle?: string | null;
  followerCount?: number;
  followingCount?: number;
  designCount?: number;
  isFollowing?: boolean;
}

export async function fetchProfile(userId: string): Promise<ProfileData> {
  return (await expectOk(await fetch(`${API}/users/${userId}/profile`, { headers: authHeaders(false) }))) as ProfileData;
}

/** The signed-in user's id + name, or null. */
export async function fetchMe(): Promise<{ id: string; username: string; isAdmin: boolean } | null> {
  if (!token) return null;
  try {
    return (await expectOk(await fetch(`${API}/me`, { headers: authHeaders(false) }))) as {
      id: string;
      username: string;
      isAdmin: boolean;
    };
  } catch {
    return null;
  }
}

// ---- moderation / trust review (admin only) ----
export interface ReportItem {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
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

export async function listReports(status = 'open'): Promise<ReportItem[]> {
  return (await expectOk(await fetch(`${API}/admin/reports?status=${status}`, { headers: authHeaders(true) }))) as ReportItem[];
}
export async function dismissReport(id: string): Promise<void> {
  await expectOk(await fetch(`${API}/admin/reports/${id}/dismiss`, { method: 'POST', headers: authHeaders(true) }));
}
export async function takedownDesign(id: string): Promise<void> {
  await expectOk(await fetch(`${API}/admin/designs/${id}/takedown`, { method: 'POST', headers: authHeaders(true) }));
}
export async function listUnverifiedPhotos(): Promise<PhotoReviewItem[]> {
  return (await expectOk(await fetch(`${API}/admin/photos/unverified`, { headers: authHeaders(true) }))) as PhotoReviewItem[];
}
export async function verifyPhoto(photoId: string, verified: boolean): Promise<void> {
  await expectOk(
    await fetch(`${API}/admin/photos/${photoId}/verify`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ verified }),
    }),
  );
}
export async function adminDeletePhoto(photoId: string): Promise<void> {
  await expectOk(await fetch(`${API}/admin/photos/${photoId}`, { method: 'DELETE', headers: authHeaders(true) }));
}

export const thumbnailUrl = (id: string): string => `${API}/designs/${id}/thumbnail.png`;

/** Request a server-rendered distribution PDF for the current (unsaved) design. */
export async function exportDistributionPdf(
  store: DesignStore,
  map: SeatMap,
  opts: { title: string; cardsPerBag: number; colorNames?: string[] },
): Promise<Blob> {
  const cellsGzB64 = toB64(await gzip(store.cells));
  const res = await fetch(`${API}/export/pdf`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      title: opts.title,
      templateId: map.templateRef.id,
      templateVersion: map.templateRef.version,
      palette: store.palette,
      cellsGzB64,
      cardsPerBag: opts.cardsPerBag,
      colorNames: opts.colorNames,
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(err.error ?? `export failed (${res.status})`);
  }
  return res.blob();
}

// ============ social client ============

export interface PublicProfile {
  id: string;
  username: string;
  handle: string | null;
  followerCount: number;
  followingCount: number;
  designCount: number;
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

/** Set a design's creator explanation + remix permission (owner only). */
export async function setPublishMeta(id: string, description: string | null, allowRemix: boolean): Promise<void> {
  const res = await fetch(`${API}/designs/${id}/publish-meta`, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify({ description, allowRemix }),
  });
  if (!res.ok) throw new Error(`could not save publish details (${res.status})`);
}

/** Remix a public design into the caller's account; returns the new design id. */
export async function remixDesign(id: string, title?: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/designs/${id}/remix`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(e.error ?? `remix failed (${res.status})`);
  }
  return res.json() as Promise<{ id: string }>;
}

export async function followUser(userId: string): Promise<void> {
  const res = await fetch(`${API}/users/${userId}/follow`, { method: 'POST', headers: authHeaders(false) });
  if (!res.ok) throw new Error(`follow failed (${res.status})`);
}
export async function unfollowUser(userId: string): Promise<void> {
  const res = await fetch(`${API}/users/${userId}/follow`, { method: 'DELETE', headers: authHeaders(false) });
  if (!res.ok) throw new Error(`unfollow failed (${res.status})`);
}

export async function searchUsers(q: string): Promise<PublicProfile[]> {
  const res = await fetch(`${API}/users/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  return res.json() as Promise<PublicProfile[]>;
}

export async function listComments(designId: string): Promise<CommentItem[]> {
  const res = await fetch(`${API}/designs/${designId}/comments`);
  if (!res.ok) return [];
  return res.json() as Promise<CommentItem[]>;
}
export async function addComment(designId: string, body: string, parentId: string | null): Promise<CommentItem> {
  const res = await fetch(`${API}/designs/${designId}/comments`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ body, parentId }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(e.error ?? `comment failed (${res.status})`);
  }
  return res.json() as Promise<CommentItem>;
}
export async function deleteComment(commentId: string): Promise<void> {
  const res = await fetch(`${API}/comments/${commentId}`, { method: 'DELETE', headers: authHeaders(false) });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}

export async function listNotifications(): Promise<{ unread: number; items: NotificationItem[] }> {
  const res = await fetch(`${API}/notifications`, { headers: authHeaders(false) });
  if (!res.ok) return { unread: 0, items: [] };
  return res.json() as Promise<{ unread: number; items: NotificationItem[] }>;
}
export async function markNotificationsRead(id?: string): Promise<void> {
  await fetch(`${API}/notifications/read`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

// ============ B2B leads ============

export interface LeadInput {
  name: string;
  email: string;
  organization?: string;
  orgType?: string;
  message?: string;
}

/** Submit a B2B lead from the For Clubs page. */
export async function submitLead(lead: LeadInput): Promise<{ ok: boolean; id?: string }> {
  const res = await fetch(`${API}/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(lead),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(e.error ?? `submission failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean; id?: string }>;
}

// ---------- AI Tifo Designer ----------

export interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
  provider?: string;
}

export interface AiGenerateResult {
  spec: TifoSpec;
  quota: AiQuota;
  source: 'model' | 'offline';
}

/** Error thrown by generateAiTifo, carrying the HTTP status and (if any) quota. */
export interface AiError extends Error {
  status?: number;
  quota?: AiQuota;
}

/**
 * Ask the server to design a tifo from a prompt. Returns a validated TifoSpec
 * (the client compiles it to seats). On failure throws an AiError whose `status`
 * distinguishes 401 (sign in), 402 (out of free credits, with `quota`), etc.
 */
export async function generateAiTifo(prompt: string): Promise<AiGenerateResult> {
  const res = await fetch(`${API}/ai/generate`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ prompt }),
  });
  const data = (await res.json().catch(() => null)) as (AiGenerateResult & { error?: string; quota?: AiQuota }) | null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `generation failed (${res.status})`) as AiError;
    err.status = res.status;
    err.quota = data?.quota;
    throw err;
  }
  return data as AiGenerateResult;
}

/** Read the signed-in account's remaining AI generations. */
export async function fetchAiQuota(): Promise<AiQuota> {
  return (await expectOk(await fetch(`${API}/ai/quota`, { headers: authHeaders(false) }))) as AiQuota;
}
