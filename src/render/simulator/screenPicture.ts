import type { SeatMap } from '../../core/types';

/**
 * What the big screens show.
 *
 *   - 'stadium' (default): the ground's name in Arabic and English, in the
 *     design's own colours. It needs nothing from anyone and can't be wrong.
 *   - 'tifo': the design itself, laid out flat, live — what the stadium's
 *     production crew puts up while a card display is being held.
 *   - 'image': a picture the user chose, a club badge say. It is read in the
 *     browser and never uploaded. We don't ship club crests: they are
 *     registered trademarks, and a fan choosing to put their own club's badge
 *     on their own render is a different thing from us distributing it.
 */
export type ScreenMode = 'stadium' | 'tifo' | 'image';

export interface ScreenSource {
  mode: ScreenMode;
  nameEn: string;
  nameAr: string;
  palette: string[];
  map?: SeatMap;
  cells?: Uint8Array;
  image?: CanvasImageSource & { width: number; height: number };
}

/** Palette colours that are actual colours (index 0 is "empty seat"). */
function inks(palette: string[]): string[] {
  const out = palette
    .slice(1)
    .map((c) => (/^#[0-9a-f]{3}$/i.test(c) ? '#' + [...c.slice(1)].map((d) => d + d).join('') : c))
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  return out.length ? out : ['#0b1d4d', '#ffffff'];
}

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** A thin LED-pixel grid over the picture, so it reads as a screen, not a poster. */
function ledGrid(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
}

/** Each seat's pixel rectangle on a w x h screen, cached per seat map. */
const rectCache = new WeakMap<SeatMap, { w: number; h: number; rects: Int32Array }>();
function seatRects(m: SeatMap, w: number, h: number): Int32Array {
  const hit = rectCache.get(m);
  if (hit && hit.w === w && hit.h === h) return hit.rects;
  const b = m.bounds;
  const sx = w / (b.maxX - b.minX || 1);
  const sy = h / (b.maxY - b.minY || 1);
  const pw = Math.max(1, Math.ceil(3.2 * sx));
  const ph = Math.max(1, Math.ceil(6.4 * sy));
  const rects = new Int32Array(m.count * 4);
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, Math.round(v)));
  for (let i = 0; i < m.count; i++) {
    const cx = (m.xy[i * 2] - b.minX) * sx;
    const cy = (m.xy[i * 2 + 1] - b.minY) * sy;
    rects[i * 4] = clamp(cx - pw / 2, w);
    rects[i * 4 + 1] = clamp(cy - ph / 2, h);
    rects[i * 4 + 2] = clamp(cx + pw / 2, w);
    rects[i * 4 + 3] = clamp(cy + ph / 2, h);
  }
  rectCache.set(m, { w, h, rects });
  return rects;
}

export function paintScreen(canvas: HTMLCanvasElement, src: ScreenSource): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const w = canvas.width;
  const h = canvas.height;
  const cols = inks(src.palette);
  const bg = cols.slice().sort((a, b) => lum(a) - lum(b))[0];
  const fg = cols.slice().sort((a, b) => lum(b) - lum(a))[0];
  const accent = cols.find((c) => c !== bg && c !== fg) ?? fg;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#05070b';
  g.fillRect(0, 0, w, h);

  if (src.mode === 'image' && src.image && src.image.width > 0) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const s = Math.min((w * 0.9) / src.image.width, (h * 0.9) / src.image.height);
    const iw = src.image.width * s;
    const ih = src.image.height * s;
    g.drawImage(src.image, (w - iw) / 2, (h - ih) / 2, iw, ih);
  } else if (src.mode === 'tifo' && src.map && src.cells) {
    // The unrolled bowl, exactly as the design view shows it. Written straight
    // into pixels: this runs up to four times a second while someone paints,
    // and 60k fillRect calls a go was the whole frame budget.
    const rects = seatRects(src.map, w, h);
    const img = g.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff251e1b); // #1b1e25, ABGR
    const abgr = src.palette.map((raw) => {
      // Palettes may carry #rgb as well as #rrggbb (tifoFormat accepts both).
      const hex = /^#[0-9a-f]{3}$/i.test(raw) ? '#' + [...raw.slice(1)].map((c) => c + c).join('') : raw;
      const n = parseInt(hex.slice(1), 16) || 0;
      return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
    });
    for (let i = 0; i < src.map.count; i++) {
      const c = src.cells[i];
      if (!c) continue;
      const col = abgr[c] ?? 0xff251e1b;
      const x0 = rects[i * 4];
      const y0 = rects[i * 4 + 1];
      const x1 = rects[i * 4 + 2];
      const y1 = rects[i * 4 + 3];
      for (let y = y0; y < y1; y++) px.fill(col, y * w + x0, y * w + x1);
    }
    g.putImageData(img, 0, 0);
  } else {
    // Stadium name, in the design's colours, with a band of the accent colour.
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, '#05070b');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.fillRect(0, h * 0.47, w, h * 0.06);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    g.font = `bold ${Math.round(h * 0.26)}px "Noto Kufi Arabic", "Cairo", system-ui, sans-serif`;
    g.fillText(src.nameAr, w / 2, h * 0.27, w * 0.92);
    g.font = `800 ${Math.round(h * 0.17)}px "Anton", "Archivo Black", system-ui, sans-serif`;
    g.fillText(src.nameEn.toUpperCase(), w / 2, h * 0.75, w * 0.92);
  }
  ledGrid(g, w, h);
}
