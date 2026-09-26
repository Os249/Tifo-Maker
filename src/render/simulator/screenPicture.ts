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
  const out = palette.slice(1).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
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
    // The unrolled bowl, exactly as the design view shows it.
    const m = src.map;
    const b = m.bounds;
    const sx = w / (b.maxX - b.minX || 1);
    const sy = h / (b.maxY - b.minY || 1);
    g.fillStyle = '#1b1e25';
    g.fillRect(0, 0, w, h);
    const pw = Math.max(1, Math.ceil(3.2 * sx));
    const ph = Math.max(1, Math.ceil(6.4 * sy));
    for (let i = 0; i < m.count; i++) {
      const c = src.cells[i];
      if (!c) continue;
      g.fillStyle = src.palette[c] ?? '#1b1e25';
      g.fillRect((m.xy[i * 2] - b.minX) * sx - pw / 2, (m.xy[i * 2 + 1] - b.minY) * sy - ph / 2, pw, ph);
    }
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
