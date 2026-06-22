import { generateSeatMap } from '../core/seatmap';
import { templateById } from '../core/stadiumCatalog';
import { encodeGif, renderRevealFrames, type GifOptions } from '../core/gif';
import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';

/**
 * Main-thread client for the heavy worker. Generation and GIF encoding run off
 * the UI thread so the 76k oval never blocks paint. Falls back to synchronous
 * execution where Workers are unavailable (older embeds, tests). The worker is
 * created lazily on first use.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (value: unknown) => void>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./heavy.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number } & Record<string, unknown>>) => {
      const cb = pending.get(e.data.id);
      if (cb) {
        pending.delete(e.data.id);
        cb(e.data);
      }
    };
    return worker;
  } catch {
    return null;
  }
}

function call<T>(req: Record<string, unknown>): Promise<T> {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<T>((resolve) => {
    pending.set(id, (v) => resolve(v as T));
    w.postMessage({ ...req, id });
  });
}

/** Generate a seat map off-thread, falling back to synchronous generation. */
export async function generateSeatMapAsync(templateId: string): Promise<SeatMap> {
  try {
    const res = await call<{ map?: SeatMap; error?: string }>({ kind: 'seatmap', templateId });
    if (res.map) return res.map;
  } catch {
    /* fall through */
  }
  const tpl = templateById(templateId);
  if (!tpl) throw new Error(`unknown template ${templateId}`);
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
