/// <reference lib="webworker" />
import { generateSeatMap } from '../core/seatmap';
import { encodeGif } from '../core/gif';
import type { SeatMap, StadiumTemplate } from '../core/types';

/**
 * Background worker for the two genuinely heavy, pure operations:
 *  - seat-map generation (superellipse sampling + neighbor graph), 140-250ms
 *  - GIF frame encoding (LZW over N frames), can run into hundreds of ms
 *
 * Both already side-effect-free, so they move here unchanged. Typed-array
 * fields are transferred (zero-copy) back to the main thread. The editor uses
 * these via an async wrapper and falls back to synchronous calls if Workers
 * are unavailable.
 *
 * The page sends the stadium itself, not its id (performance plan P1.16).
 * Resolving the id here meant bundling the whole stadium catalogue into the
 * worker (46 KB gzipped, evaluated again before the first seat map), and it
 * still could not see the grounds the page had registered at run time: a
 * custom or community stadium answered "unknown template" and was quietly
 * built on the main thread instead. The page resolves the template, checks a
 * stadium it did not ship (workers/client.ts), and hands it over.
 *
 * This file is loaded only as a same-origin module worker from /assets (the
 * CSP's script-src 'self'); never as a blob: or data: worker.
 */

type Req =
  | { id: number; kind: 'seatmap'; template: StadiumTemplate }
  | {
      id: number;
      kind: 'gif';
      frames: ArrayBuffer[]; // each a Uint8Array buffer of palette indices
      w: number;
      h: number;
      table: number[];
      delayCs: number;
    };

/** Collect a SeatMap's transferable ArrayBuffers for zero-copy postMessage. */
function seatMapTransfer(m: SeatMap): Transferable[] {
  return [
    m.xy.buffer,
    m.uv.buffer,
    m.pos3.buffer,
    m.tierOf.buffer,
    m.rowOf.buffer,
    m.sectionOf.buffer,
    m.neighbors.buffer,
    m.mirrorOf.buffer,
  ] as Transferable[];
}

const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  const id = msg && typeof msg === 'object' && typeof msg.id === 'number' ? msg.id : -1;
  // Every failure is an answer, so the page never waits on a request that
  // threw in here; it falls back to doing the work itself.
  try {
    if (msg.kind === 'seatmap') {
      if (!msg.template || typeof msg.template !== 'object') throw new Error('no template');
      const map = generateSeatMap(msg.template);
      post({ id, map }, seatMapTransfer(map));
    } else if (msg.kind === 'gif') {
      const frames = msg.frames.map((b) => new Uint8Array(b));
      const bytes = encodeGif(frames, msg.w, msg.h, msg.table, msg.delayCs);
      post({ id, gif: bytes.buffer }, [bytes.buffer] as Transferable[]);
    } else {
      throw new Error('unknown request');
    }
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : 'failed' });
  }
};
