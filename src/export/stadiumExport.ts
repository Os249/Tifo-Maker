import type { SeatMap } from '../core/types';
import type { DesignStore } from '../core/design';
import { buildReveal, type RevealId } from '../core/reveal';
import { encodeGif } from '../core/gif';
import type { Preview3D } from '../render/preview3d';

/**
 * Stadium animation export (Phase: video/GIF of the 3D bowl).
 *
 * Reuses the existing reveal ordering (core/reveal) and the dependency-free GIF
 * encoder (core/gif). The 3D bowl is full-colour (lit + anti-aliased), so unlike
 * the flat-design GIF path we capture pixels off the live WebGL canvas:
 *   • VIDEO  → MediaRecorder over a 2D compositing canvas' captureStream. The
 *              compositing canvas is also where the watermark is burned in, so
 *              every recorded frame carries "tifomaker.org" regardless of the DOM.
 *   • GIF    → step the reveal clock offline, read each frame's pixels, quantise
 *              to a small palette (design colours + scene colours + white for the
 *              watermark), then feed the existing encodeGif().
 *
 * Both drive Preview3D.applyReveal() exactly like the live RevealPlayer, so the
 * exported animation matches what plays on screen. No-shows reuse
 * Preview3D.setNoShows() (the existing 10% mask).
 */

const FADE = 0.08; // must match RevealPlayer.fade so export == on-screen playback

export interface StadiumExportOpts {
  reveal: RevealId;
  durationSec: number;
  fps: number;
  noShows: boolean;
  watermark: string;
  /** GIF only: cap output width (height derives from the canvas aspect). */
  gifWidth?: number;
}

/** Per-seat visibility at a clock value — identical math to RevealPlayer. */
function visAt(delays: Float32Array, clock: number): (seat: number) => number {
  return (seat: number) => {
    const t = (clock - delays[seat]) / FADE;
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  };
}

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  if (!text) return;
  const fontSize = Math.max(11, Math.round(h * 0.03));
  const pad = Math.round(fontSize * 0.7);
  ctx.save();
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  const tw = ctx.measureText(text).width;
  const x = w - pad;
  const y = h - pad;
  // Subtle dark backing keeps it legible over both dark sky and bright cards.
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.fillRect(x - tw - 8, y - fontSize, tw + 12, fontSize + 8);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Pick a MediaRecorder mime the browser actually supports. */
export function pickVideoMime(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  if (typeof MediaRecorder !== 'undefined') {
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch {
        /* isTypeSupported can throw on some engines */
      }
    }
  }
  return 'video/webm';
}

export function videoExportSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream === 'function'
  );
}

type CapturableCanvas = HTMLCanvasElement & { captureStream(frameRate?: number): MediaStream };

interface PlayHandle {
  /** 2D compositing canvas (what gets recorded / shown as the live preview). */
  canvas: HTMLCanvasElement;
  /** Runs one reveal pass (clock 0→1 over durationSec) compositing each frame. */
  run: () => Promise<void>;
  /** Restore the live design + camera loop after a pass. */
  finish: () => void;
}

/**
 * Build a compositing surface and a reveal-playback driver. The 3D preview's
 * own render loop is paused so we drive frames deterministically; finish()
 * restores it. The returned canvas mirrors the bowl + watermark each frame.
 */
function buildPlayback(
  preview: Preview3D,
  map: SeatMap,
  opts: StadiumExportOpts,
  scale = 1,
): PlayHandle {
  const src = preview.canvas;
  const W = Math.max(2, Math.round(src.width * scale));
  const H = Math.max(2, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: scale < 1 })!;
  const delays = buildReveal(map, opts.reveal);

  // Pause the preview's internal RAF so our reveal stepping isn't fighting it.
  preview.stop();
  preview.setNoShows(opts.noShows);

  const renderFrameAt = (clock: number): void => {
    preview.applyReveal(clock >= 1 ? null : visAt(delays, clock));
    preview.renderOnce();
    ctx.drawImage(src, 0, 0, W, H);
    drawWatermark(ctx, W, H, opts.watermark);
  };

  const run = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = (): void => {
        const elapsed = (performance.now() - start) / 1000;
        const clock = Math.min(1, elapsed / opts.durationSec);
        renderFrameAt(clock);
        if (clock < 1) requestAnimationFrame(tick);
        else setTimeout(resolve, 350); // hold the finished tifo a beat
      };
      // Prime frame 0 immediately so the preview canvas is never blank.
      renderFrameAt(0);
      requestAnimationFrame(tick);
    });

  const finish = (): void => {
    preview.applyReveal(null);
    preview.start();
  };

  return { canvas, run, finish };
}

/** Live preview pass into a visible canvas — no recording, no download. */
export async function previewStadium(
  preview: Preview3D,
  map: SeatMap,
  opts: StadiumExportOpts,
  mountCtx: CanvasRenderingContext2D,
): Promise<void> {
  const play = buildPlayback(preview, map, opts, 1);
  const present = (): void => {
    mountCtx.canvas.width = play.canvas.width;
    mountCtx.canvas.height = play.canvas.height;
  };
  present();
  // Mirror each composited frame into the on-screen modal canvas.
  let raf = 0;
  const mirror = (): void => {
    mountCtx.drawImage(play.canvas, 0, 0);
    raf = requestAnimationFrame(mirror);
  };
  raf = requestAnimationFrame(mirror);
  try {
    await play.run();
  } finally {
    cancelAnimationFrame(raf);
    mountCtx.drawImage(play.canvas, 0, 0);
    play.finish();
  }
}

/** Record the reveal as a WebM (or browser-preferred) video blob. */
export async function exportStadiumVideo(
  preview: Preview3D,
  map: SeatMap,
  opts: StadiumExportOpts,
): Promise<{ blob: Blob; mime: string }> {
  if (!videoExportSupported()) {
    throw new Error('Video capture is not supported in this browser. Try GIF instead.');
  }
  const play = buildPlayback(preview, map, opts, 1);
  const mime = pickVideoMime();
  const stream = (play.canvas as CapturableCanvas).captureStream(opts.fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e: BlobEvent): void => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = (): void => resolve();
  });
  try {
    rec.start();
    await play.run();
    rec.stop();
    await stopped;
  } finally {
    play.finish();
    stream.getTracks().forEach((t) => t.stop());
  }
  return { blob: new Blob(chunks, { type: mime }), mime };
}

// ---- GIF (offline frame stepping + nearest-colour quantisation) ----

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Palette: scene colours + design swatches + black/white (for AA + watermark). */
function buildQuantPalette(store: DesignStore): number[][] {
  const cols: number[][] = [
    [0x26, 0x2a, 0x33], // empty / no-show card gray (matches Preview3D EMPTY_COLOR)
    [0x0a, 0x0c, 0x11], // scene background
    [0x17, 0x55, 0x2e], // pitch green
    [0x10, 0x13, 0x1a], // apron
    [0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff], // watermark + highlights
  ];
  for (let c = 1; c < store.palette.length; c++) cols.push(hexToRgb(store.palette[c]));
  // De-dupe and cap at the GIF maximum.
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const c of cols) {
    const k = c.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out.slice(0, 256);
}

function nearestIndex(pal: number[][], r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = pal[i][0] - r;
    const dg = pal[i][1] - g;
    const db = pal[i][2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Flatten the palette to a GIF colour table padded to a power of two. */
function flattenTable(pal: number[][]): number[] {
  let size = 2;
  while (size < pal.length) size *= 2;
  const table: number[] = [];
  for (let i = 0; i < size; i++) {
    const c = pal[i] ?? pal[0];
    table.push(c[0], c[1], c[2]);
  }
  return table;
}

export async function exportStadiumGif(
  preview: Preview3D,
  map: SeatMap,
  store: DesignStore,
  opts: StadiumExportOpts,
): Promise<Blob> {
  const targetW = Math.min(opts.gifWidth ?? 480, preview.canvas.width);
  const scale = targetW / preview.canvas.width;
  const play = buildPlayback(preview, map, opts, scale);
  const { canvas } = play;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const src = preview.canvas;
  const delays = buildReveal(map, opts.reveal);
  const pal = buildQuantPalette(store);
  // GIF fps is capped — large frame counts bloat the file and slow encode.
  const fps = Math.min(opts.fps, 15);
  const frameCount = Math.max(2, Math.round(opts.durationSec * fps));
  const frames: Uint8Array[] = [];

  try {
    for (let f = 0; f < frameCount; f++) {
      const clock = frameCount === 1 ? 1 : f / (frameCount - 1);
      preview.applyReveal(clock >= 1 ? null : visAt(delays, clock));
      preview.renderOnce();
      ctx.drawImage(src, 0, 0, W, H);
      drawWatermark(ctx, W, H, opts.watermark);
      const img = ctx.getImageData(0, 0, W, H).data;
      const buf = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) {
        buf[p] = nearestIndex(pal, img[p * 4], img[p * 4 + 1], img[p * 4 + 2]);
      }
      frames.push(buf);
      // Yield to the event loop so the tab stays responsive on big bowls.
      if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    play.finish();
  }

  const table = flattenTable(pal);
  const delayCs = Math.max(2, Math.round(100 / fps));
  const bytes = encodeGif(frames, W, H, table, delayCs);
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}
