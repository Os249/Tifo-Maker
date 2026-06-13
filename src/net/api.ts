import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';

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
let token: string | null = null;

export const isSignedIn = (): boolean => token !== null;

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
  token = data.token;
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
  token = data.token;
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

export interface GalleryItem {
  id: string;
  title: string;
  ownerName: string;
  hasThumbnail: boolean;
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
): Promise<{ title: string; isPublic: boolean; ownerIsMe: boolean }> {
  const data = (await expectOk(await fetch(`${API}/designs/${id}`, { headers: authHeaders(false) }))) as {
    title: string;
    palette: string[];
    cellsGzB64: string;
    isPublic: boolean;
    ownerId: string | null;
  };
  const cells = await gunzip(fromB64(data.cellsGzB64));
  store.setPalette(data.palette.slice(0, 8));
  store.loadCells(cells);
  let ownerIsMe = false;
  if (token) {
    const me = (await expectOk(await fetch(`${API}/me`, { headers: authHeaders(false) }))) as { id: string };
    ownerIsMe = me.id === data.ownerId;
  }
  return { title: data.title, isPublic: data.isPublic, ownerIsMe };
}

export async function listGallery(): Promise<GalleryItem[]> {
  return (await expectOk(await fetch(`${API}/gallery`))) as GalleryItem[];
}

export const thumbnailUrl = (id: string): string => `${API}/designs/${id}/thumbnail.png`;
