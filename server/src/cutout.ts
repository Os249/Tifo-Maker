/**
 * Smart cut-out: a person (or anything) lifted out of a photo, background and
 * all, as a transparent PNG.
 *
 * Bria's RMBG 2.0 through Cloudflare Workers AI, on the same Cloudflare
 * account the picture backup already uses (AI_CLOUDFLARE_ACCOUNT_ID and
 * AI_CLOUDFLARE_API_TOKEN), at about $0.018 a picture. The model answers with
 * a LINK to the result, hosted for a few days, which the server downloads.
 *
 * That download is the part that needs care: a URL that came back from a
 * third party is fetched by our server. So it is fetched only over HTTPS,
 * only from hosts on an allow-list (AI_CUTOUT_RESULT_HOSTS adds to it), only
 * when every address the name resolves to is public, without following
 * redirects, with a size cap and a time limit, and only kept if the bytes are
 * a PNG. A link anywhere else is refused, not fetched.
 *
 * What is sent: the picture the person chose, with its metadata (GPS, device,
 * owner) removed first, and the moderation flags on so the provider refuses
 * abusive pictures. Nothing is stored by us: the result goes straight back to
 * the editor, which keeps it in the person's project like any picture.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { envNum } from './env';
import { sniffImage, stripImageMetadata } from './imageMeta';

export const CUTOUT_MODEL = 'bria/remove-background';
export const CUTOUT_PRICE_USD = 0.018;
/** The largest picture accepted from the editor (it sends at most 1,536 px). */
export const MAX_CUTOUT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 12 * 1024 * 1024;

const DEFAULT_RESULT_HOSTS = ['cloudflare.com', 'bria.ai', 'r2.cloudflarestorage.com', 'r2.dev'];

/** Name resolution for the result link; tests put a fake one in place. */
type Resolve = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;
let resolver: Resolve = (host, opts) => lookup(host, opts);
export function useLookupForTests(fn: Resolve | null): void {
  resolver = fn ?? ((host, opts) => lookup(host, opts));
}

function creds(): { id: string; token: string } | null {
  const id = (process.env.AI_CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = (process.env.AI_CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!/^[0-9a-f]{32}$/i.test(id) || !token) return null;
  return { id, token };
}

export function cutoutConfigured(): boolean {
  return creds() !== null && (process.env.AI_CUTOUT ?? '').trim().toLowerCase() !== 'off';
}

export function resultHosts(): string[] {
  const extra = (process.env.AI_CUTOUT_RESULT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
  return [...new Set([...DEFAULT_RESULT_HOSTS, ...extra])];
}

/** A host on the list, or a subdomain of one. */
export function hostAllowed(host: string, hosts = resultHosts()): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((ok) => h === ok || h.endsWith(`.${ok}`));
}

/** Loopback, private, link-local, shared, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true;
}

type Fail = { ok: false; kind: 'config' | 'credit' | 'refused' | 'provider' | 'timeout' | 'result'; status?: number; error: string };
export type CutoutResult = { ok: true; png: Buffer } | Fail;

const fail = (kind: Fail['kind'], error: string, status?: number): Fail => ({ ok: false, kind, error: error.slice(0, 400), status });

/** Read a response body, refusing more than `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) return null;
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Download the result from a link the model gave, under every rule above. */
export async function fetchResult(link: string, fetchImpl: typeof fetch = fetch, resolve: Resolve = resolver, timeoutMs = 20_000): Promise<CutoutResult> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return fail('result', 'the result link is not a URL');
  }
  if (url.protocol !== 'https:') return fail('result', `result link refused: ${url.protocol} is not https`);
  if (url.username || url.password) return fail('result', 'result link refused: it carries credentials');
  if (url.port && url.port !== '443') return fail('result', `result link refused: port ${url.port}`);
  const host = url.hostname;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return fail('result', 'result link refused: a bare IP address');
  if (!hostAllowed(host)) return fail('result', `result host ${host} is not allowed; add it to AI_CUTOUT_RESULT_HOSTS if it is the provider's`);
  try {
    const addrs = await resolve(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return fail('result', `result host ${host} resolves to a private address`);
  } catch {
    return fail('result', `result host ${host} did not resolve`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/png' } });
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    return fail(timeout ? 'timeout' : 'result', `downloading the result failed: ${(e as Error).message}`);
  }
  if (!res.ok) return fail('result', `downloading the result answered HTTP ${res.status}`, res.status);
  const body = await readCapped(res, MAX_RESULT_BYTES);
  if (!body) return fail('result', 'the result is larger than allowed');
  if (sniffImage(body) !== 'png') return fail('result', 'the result is not a PNG');
  const clean = stripImageMetadata(body);
  return clean ? { ok: true, png: clean } : fail('result', 'the result PNG did not parse');
}

/** Find the result in the model's answer: a link, or (if it ever comes inline) the image itself. */
function resultOf(j: unknown): string | null {
  const o = j as { result?: { image?: unknown; result?: { image?: unknown } }; image?: unknown } | null;
  const v = o?.result?.image ?? o?.result?.result?.image ?? o?.image;
  return typeof v === 'string' ? v : null;
}

/**
 * Cut the subject out of `picture` (JPEG or PNG bytes). Never throws; a
 * failure says which kind it was, for the admin AI tab and the editor's card.
 */
export async function cutoutPicture(picture: Buffer, fetchImpl: typeof fetch = fetch, resolve: Resolve = resolver): Promise<CutoutResult> {
  const c = creds();
  if (!c || !cutoutConfigured()) return fail('config', 'AI_CLOUDFLARE_ACCOUNT_ID / AI_CLOUDFLARE_API_TOKEN are not set (or AI_CUTOUT=off)');
  const kind = sniffImage(picture);
  if (kind !== 'jpeg' && kind !== 'png') return fail('refused', 'only JPEG and PNG are accepted');
  const clean = stripImageMetadata(picture);
  if (!clean) return fail('refused', 'the picture did not parse');
  const timeoutMs = envNum('AI_CUTOUT_TIMEOUT_MS', 45_000, 5_000, 90_000);
  let res: Response;
  try {
    res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${c.id}/ai/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CUTOUT_MODEL,
        input: {
          image: `data:image/${kind};base64,${clean.toString('base64')}`,
          preserve_alpha: true,
          visual_input_content_moderation: true,
          visual_output_content_moderation: true,
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    return fail(timeout ? 'timeout' : 'provider', `${CUTOUT_MODEL}: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const s = res.status;
    const said = text.replace(/\s+/g, ' ').slice(0, 300);
    if (s === 401 || s === 403) return fail('config', `${CUTOUT_MODEL}: HTTP ${s} (the token or the plan does not allow this model): ${said}`, s);
    if (s === 402 || s === 429) return fail('credit', `${CUTOUT_MODEL}: HTTP ${s}: ${said}`, s);
    if (s === 400 || s === 422) {
      return fail(/moderat|nsfw|inappropriate|policy/i.test(said) ? 'refused' : 'provider', `${CUTOUT_MODEL}: HTTP ${s}: ${said}`, s);
    }
    return fail('provider', `${CUTOUT_MODEL}: HTTP ${s}: ${said}`, s);
  }
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {
    return fail('provider', `${CUTOUT_MODEL}: the answer was not JSON`);
  }
  const out = resultOf(j);
  if (!out) {
    const state = (j as { result?: { state?: unknown }; state?: unknown })?.result?.state ?? (j as { state?: unknown })?.state;
    return fail('provider', `${CUTOUT_MODEL}: no result in the answer${state ? ` (state ${String(state).slice(0, 40)})` : ''}`);
  }
  if (out.startsWith('data:image/png;base64,')) {
    const png = Buffer.from(out.slice('data:image/png;base64,'.length), 'base64');
    if (png.length > MAX_RESULT_BYTES || sniffImage(png) !== 'png') return fail('result', 'the inline result is not a PNG');
    const stripped = stripImageMetadata(png);
    return stripped ? { ok: true, png: stripped } : fail('result', 'the result PNG did not parse');
  }
  return fetchResult(out, fetchImpl, resolve);
}
