/**
 * The club kit's and the credit line's calls to the account (Pro;
 * server/src/kitRoutes.ts). Loaded only with the code that needs them (the
 * club kit, the credit line), never at the editor's start.
 *
 * Every call says how it went in a way the store can act on: `offline` (no
 * answer: the network, a timeout, the server down) is kept for later, while
 * `refused` (the server answered no) is not tried again as it is.
 */
import { authHeaders, isSignedIn } from './api';

const API = '/api/pro';
/** An answer later than this is treated as no answer: the fan works from what this browser keeps. */
const TIMEOUT_MS = 8000;

export interface AccountLogo {
  hash: string;
  w: number;
  h: number;
}

export interface AccountKit {
  id: string;
  name: string;
  colours: string[];
  font: string;
  at: number;
  logos: AccountLogo[];
}

export type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; offline: true }
  | { ok: false; offline: false; status: number; code?: string };

async function call<T>(path: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<Answer<T>> {
  if (!isSignedIn()) return { ok: false, offline: false, status: 401 };
  let res: Response;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    res = await fetch(`${API}${path}`, { ...init, signal, cache: 'no-store' });
  } catch {
    return { ok: false, offline: true };
  }
  // A server that is down or restarting answers 5xx: that is "try later", not "no".
  if (res.status >= 500) return { ok: false, offline: true };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return { ok: false, offline: false, status: res.status, ...(typeof body?.code === 'string' ? { code: body.code } : {}) };
  }
  try {
    return { ok: true, value: await read(res) };
  } catch {
    return { ok: false, offline: true };
  }
}

const json = (body: unknown): RequestInit => ({ headers: authHeaders(true), body: JSON.stringify(body) });

/** The account's kits, as the server keeps them (logos by hash). */
export function listAccountKits(): Promise<Answer<AccountKit[]>> {
  return call('/kits', { headers: authHeaders(false) }, async (r) => {
    const d = (await r.json()) as { kits?: unknown };
    return Array.isArray(d.kits) ? (d.kits as AccountKit[]) : [];
  });
}

/** Save a kit. Each logo is a hash the account holds already, or a PNG's base64. */
export function putAccountKit(
  kit: { id: string; name: string; colours: string[]; font: string; at: number },
  logos: ({ hash: string } | { png: string })[],
): Promise<Answer<AccountKit>> {
  return call(`/kits/${encodeURIComponent(kit.id)}`, { method: 'PUT', ...json({ ...kit, logos }) }, async (r) => ((await r.json()) as { kit: AccountKit }).kit);
}

export function deleteAccountKit(id: string): Promise<Answer<boolean>> {
  return call(`/kits/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders(false) }, async () => true);
}

export function accountLogo(hash: string): Promise<Answer<Blob>> {
  return call(`/kits/logos/${encodeURIComponent(hash)}`, { headers: authHeaders(false) }, (r) => r.blob());
}

export function getAccountCredit(): Promise<Answer<string>> {
  return call('/credit', { headers: authHeaders(false) }, async (r) => String(((await r.json()) as { credit?: unknown }).credit ?? ''));
}

export function putAccountCredit(credit: string): Promise<Answer<string>> {
  return call('/credit', { method: 'PUT', ...json({ credit }) }, async (r) => String(((await r.json()) as { credit?: unknown }).credit ?? ''));
}

/**
 * Which session this is, without the session itself: the first 16 hex
 * characters of the SHA-256 of its bearer token. The kits this browser keeps
 * for an account are shown offline only to the session that kept them, so a
 * shared computer never shows one person's kits to the next.
 */
export async function sessionTag(): Promise<string | null> {
  const bearer = authHeaders(false).authorization;
  if (!bearer || !globalThis.crypto?.subtle) return null;
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
    return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
