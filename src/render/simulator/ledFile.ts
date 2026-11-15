/**
 * The LED boards as a file for the venue: one message as a flat strip at the
 * size the stadium's LED ribbon is driven at.
 *
 * A venue gives its ribbon's size in pixels (one real one: 10880 × 90), and
 * they differ, so the size is typed, never assumed. The strip is the board's
 * colour edge to edge with the words in the board's own lettering, repeated
 * along its length the way perimeter boards run a short line, with a dot
 * between. Flat: no floodlight shade and no panel seams, which belong to the
 * 3D boards and not to a file a screen controller plays.
 *
 * A picture only. A moving loop would need a video encoder for a 10,000 px
 * wide frame, which browsers do not have.
 */
import { BOARD_FONT, inkOn, rtlFirst } from './ledBoards';

/** What a canvas can hold and a ribbon could be. */
export const LED_FILE = { minW: 256, maxW: 16000, minH: 16, maxH: 1080, defaultW: 10880, defaultH: 90 } as const;

export function cleanFileSize(w: unknown, h: unknown): { width: number; height: number } {
  const n = (v: unknown, lo: number, hi: number, d: number): number => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x > 0 ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return { width: n(w, LED_FILE.minW, LED_FILE.maxW, LED_FILE.defaultW), height: n(h, LED_FILE.minH, LED_FILE.maxH, LED_FILE.defaultH) };
}

/** `text` on a strip w × h in `colour`. */
export function drawLedFile(text: string, colour: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = colour;
  g.fillRect(0, 0, w, h);
  const words = text.trim();
  if (!words) return c;
  g.fillStyle = inkOn(colour);
  let px = Math.round(h * 0.62);
  g.font = `${px}px ${BOARD_FONT}`;
  let tw = g.measureText(words).width;
  // One message wider than the whole strip: smaller, once.
  if (tw > w * 0.94) {
    px = Math.max(8, Math.floor((px * w * 0.94) / tw));
    g.font = `${px}px ${BOARD_FONT}`;
    tw = g.measureText(words).width;
  }
  // As many times as fit with a gap of about three letter-heights, spread evenly.
  const count = Math.max(1, Math.floor(w / (tw + h * 3)));
  const unit = w / count;
  g.direction = rtlFirst(words) ? 'rtl' : 'ltr';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < count; i++) {
    g.fillText(words, unit * (i + 0.5), h * 0.54);
    if (i > 0) {
      g.beginPath();
      g.arc(unit * i, h / 2, Math.max(1.5, h * 0.07), 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}
