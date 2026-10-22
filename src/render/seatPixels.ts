import type { SeatMap } from '../core/types';

/**
 * Seats drawn straight into pixels, for the two small pictures the editor
 * keeps up to date while you paint: the mini-map and a local project's card
 * picture (performance plan P1.1 and P1.6).
 *
 * Both used to be drawn seat by seat with `fillRect` on a canvas and encoded
 * as a PNG. The mini-map then decoded that PNG again just to shrink it into a
 * 138 × 30 box, once per painted frame: 136 PNG encodes in one test stroke on
 * the Bernabeu, 47 ms to 2 s each. Here every seat's pixel is worked out once
 * per seat map, and a redraw is one pass over the seats into an ImageData.
 */

/** The colour an empty seat is drawn in, everywhere a seat is a pixel. */
const EMPTY_SEAT = 0x262a33;
/** The ground behind the seats. */
const BACKDROP = 0x14171f;

/** '#rrggbb' or '#rgb' as 0xRRGGBB; anything else is drawn mid grey rather than black. */
function rgbOf(hex: string): number {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  if (/^[0-9a-f]{6}$/i.test(h)) return parseInt(h, 16);
  if (/^[0-9a-f]{3}$/i.test(h)) return parseInt(h[0] + h[0] + h[1] + h[1] + h[2] + h[2], 16);
  return 0x808080;
}

/** The palette as 0xRRGGBB, index 0 the empty seat. */
function paletteRgb(palette: readonly string[]): Uint32Array {
  const out = new Uint32Array(256);
  for (let k = 0; k < palette.length && k < 256; k++) out[k] = k === 0 ? EMPTY_SEAT : rgbOf(palette[k]);
  return out;
}

/**
 * The mini-map: each pixel the average of the seats that fall in it, laid
 * over the backdrop by how much of the pixel they cover, which is what the
 * old 800 px strip scaled down into the box looked like.
 */
export class MiniMapPixels {
  private readonly pixelOf: Int32Array;
  /** How much of each pixel the seats cover (0..1), and how many seats it holds. */
  private readonly cover: Float32Array;
  private readonly seats: Uint16Array;
  private readonly sum: Uint32Array;
  readonly image: ImageData;

  constructor(map: SeatMap, readonly width: number, readonly height: number) {
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round(height));
    this.image = new ImageData(W, H);
    this.pixelOf = new Int32Array(map.count);
    this.seats = new Uint16Array(W * H);
    this.cover = new Float32Array(W * H);
    this.sum = new Uint32Array(W * H * 3);
    // The strip the old mini-map was scaled from: 800 px wide, seats as
    // whole-pixel rectangles (see renderStripCanvas in net/api.ts).
    const { minX, minY, maxX, maxY } = map.bounds;
    const bw = Math.max(1e-6, maxX - minX);
    const bh = Math.max(0, maxY - minY);
    const S = 800;
    const scale = S / bw;
    const SH = Math.max(24, Math.round(bh * scale) + 4);
    const sw = Math.max(1, Math.round(3.2 * scale));
    const sh = Math.max(1, Math.round(8 * scale * 0.85));
    const kx = W / S;
    const ky = H / SH;
    for (let i = 0; i < map.count; i++) {
      const cx = Math.round((map.xy[i * 2] - minX) * scale) + sw / 2;
      const cy = Math.round((map.xy[i * 2 + 1] - minY) * scale + 2) + sh / 2;
      const px = Math.min(W - 1, Math.max(0, Math.floor(cx * kx)));
      const py = Math.min(H - 1, Math.max(0, Math.floor(cy * ky)));
      const p = py * W + px;
      this.pixelOf[i] = p;
      if (this.seats[p] < 65535) this.seats[p]++;
    }
    // One strip pixel is kx × ky of a mini-map pixel; a seat covers sw × sh strip pixels.
    const seatArea = sw * sh * kx * ky;
    for (let p = 0; p < W * H; p++) this.cover[p] = Math.min(1, this.seats[p] * seatArea);
  }

  /** Redraw from the seats as they are now. */
  paint(cells: Uint8Array, palette: readonly string[]): ImageData {
    const rgb = paletteRgb(palette);
    const { sum, seats, cover, pixelOf } = this;
    sum.fill(0);
    const n = Math.min(cells.length, pixelOf.length);
    for (let i = 0; i < n; i++) {
      const c = rgb[cells[i]];
      const o = pixelOf[i] * 3;
      sum[o] += c >> 16;
      sum[o + 1] += (c >> 8) & 255;
      sum[o + 2] += c & 255;
    }
    const d = this.image.data;
    const br = BACKDROP >> 16;
    const bg = (BACKDROP >> 8) & 255;
    const bb = BACKDROP & 255;
    for (let p = 0, o = 0; p < seats.length; p++, o += 4) {
      const k = seats[p];
      const f = cover[p];
      if (k === 0) {
        d[o] = br;
        d[o + 1] = bg;
        d[o + 2] = bb;
      } else {
        d[o] = Math.round(br + (sum[p * 3] / k - br) * f);
        d[o + 1] = Math.round(bg + (sum[p * 3 + 1] / k - bg) * f);
        d[o + 2] = Math.round(bb + (sum[p * 3 + 2] / k - bb) * f);
      }
      d[o + 3] = 255;
    }
    return this.image;
  }
}

/**
 * A local project's card picture: the unrolled bowl, W px wide, pixel for
 * pixel what `makeStripDataUrl` (core/projects.ts) draws with `fillRect`,
 * only written into an ImageData instead. Seats are painted colour by colour
 * in seat order, as there, so where two rectangles overlap the same one wins.
 */
export function stripPixels(map: SeatMap, cells: Uint8Array, palette: readonly string[], W = 480): ImageData {
  const { minX, minY, maxX, maxY } = map.bounds;
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(0, maxY - minY);
  const scale = W / bw;
  const H = Math.max(16, Math.round(bh * scale) + 2);
  const img = new ImageData(W, H);
  const d = img.data;
  for (let o = 0; o < d.length; o += 4) {
    d[o] = BACKDROP >> 16;
    d[o + 1] = (BACKDROP >> 8) & 255;
    d[o + 2] = BACKDROP & 255;
    d[o + 3] = 255;
  }
  const rgb = paletteRgb(palette);
  const w = Math.max(1, Math.round(3.2 * scale));
  const h = Math.max(1, Math.round(8 * scale * 0.85));
  const n = Math.min(cells.length, map.count);
  const colours = Math.min(256, Math.max(1, palette.length));
  // Seats in colour order, stable within a colour: a counting sort.
  const start = new Uint32Array(colours + 1);
  for (let i = 0; i < n; i++) if (cells[i] < colours) start[cells[i] + 1]++;
  for (let c = 0; c < colours; c++) start[c + 1] += start[c];
  const order = new Uint32Array(start[colours]);
  const at = start.slice(0, colours);
  for (let i = 0; i < n; i++) if (cells[i] < colours) order[at[cells[i]]++] = i;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const c = rgb[cells[i]];
    const r = c >> 16;
    const g = (c >> 8) & 255;
    const b = c & 255;
    const x0 = Math.round((map.xy[i * 2] - minX) * scale);
    const y0 = Math.round((map.xy[i * 2 + 1] - minY) * scale + 1);
    const xa = Math.max(0, x0);
    const xb = Math.min(W, x0 + w);
    const ya = Math.max(0, y0);
    const yb = Math.min(H, y0 + h);
    for (let y = ya; y < yb; y++) {
      for (let x = xa, o = (y * W + xa) * 4; x < xb; x++, o += 4) {
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
      }
    }
  }
  return img;
}

/** A CPU-backed canvas holding these pixels, ready to encode without a GPU read-back. */
export function canvasOf(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d', { willReadFrequently: true })?.putImageData(img, 0, 0);
  return c;
}

/**
 * A canvas as a `data:` URL, encoded off the main thread (`toBlob`) and read
 * back with a FileReader. A data: URL and not a blob: one: the Content
 * Security Policy allows images from 'self' and data: only.
 */
export function dataUrlOf(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) return resolve(null);
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      }, type, quality);
    } catch {
      resolve(null);
    }
  });
}
