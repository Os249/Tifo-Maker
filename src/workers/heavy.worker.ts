/// <reference lib="webworker" />
import { generateSeatMap } from '../core/seatmap';
import { templateById } from '../core/stadiumCatalog';
import { encodeGif } from '../core/gif';
import type { SeatMap } from '../core/types';

/**
 * Background worker for the two genuinely heavy, pure operations:
 *  - seat-map generation (superellipse sampling + neighbor graph), 140-250ms
 *  - GIF frame encoding (LZW over N frames), can run into hundreds of ms
 *
 * Both already side-effect-free, so they move here unchanged. Typed-array
 * fields are transferred (zero-copy) back to the main thread. The editor uses
 * these via an async wrapper and falls back to synchronous calls if Workers
 * are unavailable.
 */

type Req =
  | { id: number; kind: 'seatmap'; templateId: string }
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

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  if (msg.kind === 'seatmap') {
    const tpl = templateById(msg.templateId);
    if (!tpl) {
      (self as unknown as Worker).postMessage({ id: msg.id, error: `unknown template ${msg.templateId}` });
      return;
    }
    const map = generateSeatMap(tpl);
    (self as unknown as Worker).postMessage({ id: msg.id, map }, seatMapTransfer(map));
  } else if (msg.kind === 'gif') {
    const frames = msg.frames.map((b) => new Uint8Array(b));
    const bytes = encodeGif(frames, msg.w, msg.h, msg.table, msg.delayCs);
    (self as unknown as Worker).postMessage({ id: msg.id, gif: bytes.buffer }, [bytes.buffer] as Transferable[]);
  }
};
