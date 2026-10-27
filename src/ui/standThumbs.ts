import type { SeatMap } from '../core/types';
import type { DesignStore } from '../core/design';
import { onLangChange, t } from './i18n';

/**
 * Stand buttons with a picture and a seat count (Direction B, October 2026).
 *
 * "All, North, East, South, West" said where you could go and nothing about
 * what was there. Each button now carries a small picture of that stand as it
 * is painted and how many seats it has, so an empty stand shows up as empty
 * before you go to it. The pictures follow the paint, a moment after it
 * stops (they are drawn in idle time, not on every brush event).
 *
 * The same buttons exist twice: the desktop's in the canvas (#stand-chips)
 * and the phone shell's (.m-stand). Both are found by their data-stand.
 */

type Pieces = Map<string, number[][]>;

const W = 56; // the picture, in CSS pixels
const H = 20;
const nf = new Intl.NumberFormat('en'); // Western digits in both languages (the design pass)

interface Thumb {
  seats: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

/** Draw the pictures again soon (the phone shell calls this once its buttons exist). */
let refresh: () => void = () => {};
export const refreshStandThumbs = (): void => refresh();

export function mountStandThumbs(map: SeatMap, store: DesignStore, pieces: Pieces): void {
  // The seats each picture shows: the stand's biggest piece (a stand the
  // strip's ends cut in two is drawn whole from its larger part), and the
  // whole strip for All.
  const thumbs = new Map<string, Thumb>();
  const frame = (seats: number[], count: number): Thumb => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of seats) {
      const x = map.xy[i * 2], y = map.xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { seats, minX, maxX, minY, maxY, count };
  };
  let total = 0;
  for (const [id, ps] of pieces) {
    const count = ps.reduce((n, p) => n + p.length, 0);
    total += count;
    thumbs.set(id, frame(ps.reduce((a, b) => (b.length > a.length ? b : a)), count));
  }
  const all: number[] = [];
  for (let i = 0; i < map.count; i++) all.push(i);
  thumbs.set('all', frame(all, map.count || total));

  const chips = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('#stand-chips .stand-chip[data-stand], .m-stand[data-stand]')];

  /** Give a button its picture and count, once; its name keeps its translation key. */
  const dress = (b: HTMLButtonElement): void => {
    if (b.querySelector('.st-thumb')) return;
    const th = thumbs.get(b.dataset.stand ?? '');
    if (!th) return;
    const key = b.getAttribute('data-i18n') ?? b.dataset.nameKey ?? '';
    const name = document.createElement('span');
    name.className = 'st-name';
    if (key) name.setAttribute('data-i18n', key);
    name.textContent = key ? t(key) : (b.textContent ?? '').trim();
    b.removeAttribute('data-i18n');
    const count = document.createElement('span');
    count.className = 'st-count';
    count.textContent = nf.format(th.count);
    const text = document.createElement('span');
    text.className = 'st-text';
    text.append(name, count);
    const canvas = document.createElement('canvas');
    canvas.className = 'st-thumb';
    canvas.setAttribute('aria-hidden', 'true');
    b.replaceChildren(canvas, text);
    b.classList.add('has-thumb');
    label(b);
  };
  const label = (b: HTMLButtonElement): void => {
    const th = thumbs.get(b.dataset.stand ?? '');
    const name = b.querySelector('.st-name')?.textContent ?? '';
    if (th) b.setAttribute('aria-label', `${name}, ${nf.format(th.count)} ${t('ed.seats')}`);
  };

  const emptyColour = (): string => getComputedStyle(document.documentElement).getPropertyValue('--line-1').trim() || '#2b3550';
  const rgb = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0x2b3550;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  const draw = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    const colours = store.palette.map(rgb);
    const empty = rgb(emptyColour());
    const cells = store.cells;
    for (const b of chips()) {
      dress(b);
      const th = thumbs.get(b.dataset.stand ?? '');
      const canvas = b.querySelector<HTMLCanvasElement>('.st-thumb');
      if (!th || !canvas) continue;
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      // Fit the stand into the picture, keeping its shape, centred.
      const sx = (pw - 2) / Math.max(1e-6, th.maxX - th.minX);
      const sy = (ph - 2) / Math.max(1e-6, th.maxY - th.minY);
      const s = Math.min(sx, sy);
      const ox = (pw - (th.maxX - th.minX) * s) / 2;
      const oy = (ph - (th.maxY - th.minY) * s) / 2;
      const img = ctx.createImageData(pw, ph);
      const px = img.data;
      for (const i of th.seats) {
        const x = Math.min(pw - 1, Math.max(0, Math.round(ox + (map.xy[i * 2] - th.minX) * s)));
        const y = Math.min(ph - 1, Math.max(0, Math.round(oy + (map.xy[i * 2 + 1] - th.minY) * s)));
        const c = cells[i] ? colours[cells[i]] ?? empty : empty;
        const o = (y * pw + x) * 4;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
        px[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
  };

  // Drawn a moment after the paint settles, never on every brush event.
  let timer = 0;
  const later = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(draw, { timeout: 800 });
      else draw();
    }, 450);
  };
  store.onDirty(later);
  store.onPaletteChange(later);
  store.onHistoryChange(later);
  onLangChange(() => { for (const b of chips()) label(b); });
  refresh = later;
  later();
}
