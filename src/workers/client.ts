import { generateSeatMap } from '../core/seatmap';
// Not the catalogue: one ground's league is loaded for an id (performance plan P2.7).
import { isShipped, loadTemplate } from '../core/stadiumLoad';
import { isValidTemplate } from '../core/templateValidate';
import { encodeGif, renderRevealFrames, type GifOptions } from '../core/gif';
import type { DesignStore } from '../core/design';
import type { SeatMap, StadiumTemplate } from '../core/types';

/**
 * Main-thread client for the heavy worker. Generation and GIF encoding run off
 * the UI thread so the 76k oval never blocks paint. Falls back to synchronous
 * execution where Workers are unavailable (older embeds, tests) or when the
 * worker fails, errors or takes too long. The worker is created on first use,
 * or earlier with warmHeavyWorker().
 *
 * It is a same-origin module worker, served from /assets under the CSP's
 * script-src 'self'. Never a blob: or data: worker (that would need the CSP
 * loosened), and never an inline one.
 */

let worker: Worker | null = null;
/** The worker failed to load or crashed: everything runs here from now on. */
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/**
 * Long enough for the biggest ground on a slow phone (Bernabeu: ~0.6 s warm,
 * ~2.5 s at a 4x slower CPU), short enough that a stuck worker does not leave
 * the editor waiting: past it, the main thread does the work.
 */
const TIMEOUT_MS = 20_000;

function failAll(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (broken || typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./heavy.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number } & Record<string, unknown>>) => {
      const p = pending.get(e.data?.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      p.resolve(e.data);
    };
    // A script that will not load, or a worker that crashed: answer every
    // waiting request now (they fall back), and stop asking it.
    worker.onerror = (e) => {
      e.preventDefault?.();
      broken = true;
      worker?.terminate();
      worker = null;
      failAll('worker failed');
    };
    worker.onmessageerror = () => failAll('worker message could not be read');
    return worker;
  } catch {
    broken = true;
    return null;
  }
}

function call<T>(req: Record<string, unknown>): Promise<T> {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A worker this slow is stuck, not busy: retire it, and let this and
      // anything queued behind it run here.
      pending.delete(id);
      reject(new Error('worker timed out'));
      broken = true;
      worker?.terminate();
      worker = null;
      failAll('worker timed out');
    }, TIMEOUT_MS);
    pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
    try {
      w.postMessage({ ...req, id });
    } catch (err) {
      // A template that cannot be copied (DataCloneError): this one runs here.
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error('postMessage failed'));
    }
  });
}

/**
 * Start the worker now, so it has loaded by the time the first seat map is
 * asked for (performance plan P1.8). Safe to call more than once.
 */
export function warmHeavyWorker(): void {
  ensureWorker();
}

/**
 * The template to build, checked before anything builds it.
 *
 * A ground we ship is trusted as it is. Anything else (a custom stadium from
 * this browser's storage, a community one from the server) is held to the
 * same rules the server applies on submission (isValidTemplate), here, before
 * it reaches the generator on either thread. "We ship" is by identity, never
 * by id (core/stadiumLoad.ts isShipped).
 */
async function resolveTemplate(t: string | StadiumTemplate): Promise<StadiumTemplate> {
  const tpl = typeof t === 'string' ? await loadTemplate(t) : t;
  if (!tpl) throw new Error(`unknown template ${String(t)}`);
  if (!(await isShipped(tpl)) && !isValidTemplate(tpl as unknown)) throw new Error(`invalid stadium template ${String(tpl.id)}`);
  return tpl;
}

/**
 * Generate a seat map off-thread, falling back to synchronous generation.
 * Takes a template id (resolved through the catalogue, custom and community
 * grounds included) or the template itself.
 */
export async function generateSeatMapAsync(t: string | StadiumTemplate): Promise<SeatMap> {
  const tpl = await resolveTemplate(t);
  try {
    const res = await call<{ map?: SeatMap; error?: string }>({ kind: 'seatmap', template: tpl });
    if (res.map) return res.map;
  } catch {
    /* fall through */
  }
  return generateSeatMap(tpl);
}

/** Encode a reveal GIF; frames are computed on the main thread (cheap) and LZW
 *  encoding (the expensive part) runs in the worker when available. */
export async function exportRevealGifAsync(
  map: SeatMap,
  store: DesignStore,
  options: Partial<GifOptions>,
): Promise<Blob> {
  const opts: GifOptions = {
    reveal: 'sweep-lr',
    width: 480,
    frames: 36,
    fps: 18,
    fade: 0.08,
    ...options,
  };
  const { frames, w, h, table } = renderRevealFrames(map, store, opts);
  const delayCs = Math.max(2, Math.round(100 / opts.fps));
  try {
    const buffers = frames.map((f) => f.buffer) as ArrayBuffer[];
    const res = await call<{ gif?: ArrayBuffer }>(
      { kind: 'gif', frames: buffers, w, h, table, delayCs },
    );
    if (res.gif) return new Blob([res.gif], { type: 'image/gif' });
  } catch {
    /* fall through */
  }
  const bytes = encodeGif(frames, w, h, table, delayCs);
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}
