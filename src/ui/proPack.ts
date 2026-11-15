/**
 * The designer pack: one tifo, at every size a client or a fan page asks
 * for, each framed by hand.
 *
 *   Feed 4:5 (2160 × 2700) · Feed 3:4 (2160 × 2880) · Square (2160 × 2160)
 *   Wide 16:9 (3840 × 2160) · Story 9:16 (2160 × 3840)
 *   and the tifo's art alone on a clear background (PNG), for Photoshop.
 *
 * A size is not a crop of one picture: each is drawn again by Match Day's
 * camera (simulator/film.ts filmStill), in the film's light, at its own
 * shape and full size. So "move it in the frame" is the camera turning and
 * the lens tightening, and nothing is ever stretched or left soft. The
 * preview is that same camera at a small size, redrawn as the picture is
 * dragged or zoomed; each size keeps its own framing.
 *
 * Free to try: the preview is drawn for anyone Pro is on for. A download is
 * a Pro item and asks once (proGate.ts), with the tifo shown both ways;
 * "Export without Pro items" is today's free picture (`free`).
 *
 * Loaded when the sheet first opens; its words come with it.
 */
import './proPoster.css';
import './proPack.css';
import { escapeHtml } from '../core/escape';
import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';
import { zipStore } from '../core/zipStore';
import { drawWatermark } from '../export/stadiumExport';
import type { MatchDaySimulator } from '../render/simulator/index';
import { SPLIT_TELLS, tifoSplit } from '../render/simulator/tifoSplit';
import { drawCreditLine } from './creditLine';
import { containDialog } from './dialogFocus';
import { getLang, t, tv } from './i18n';
import { matchDayDeps } from './matchDayDeps';
import { CROWN_SVG } from './pro';
import { exportGate } from './proGate';
import { offscreenMatchDay } from './proFilm';

export interface PackSheetDeps {
  /** The project's name: the files'. */
  title(): string;
  /** Without the tifomaker.org mark (a member's default, ui/proMark.ts). */
  clean(): boolean;
  creditLine?: string;
  /** The Pro items the design carries besides the pack (proGate.designProItems). */
  designItems(): string[];
  /** "Export without Pro items": the free picture, after the sheet has closed. Resolves with the status line. */
  free(): Promise<string>;
  /** That free picture, not saved, for the export sheet's "both ways". */
  freeStill?(): Promise<HTMLCanvasElement | null>;
  say(msg: string): void;
}

export type PackFormat = 'feed45' | 'feed34' | 'square' | 'wide' | 'story';

/** Each size, and how its camera frames the tifo to start with (filmPlan's hold). */
export const PACK_FORMATS: Record<PackFormat, { width: number; height: number; fillW: number; fillH: number; centreY: number }> = {
  feed45: { width: 2160, height: 2700, fillW: 0.9, fillH: 0.46, centreY: 0.06 },
  feed34: { width: 2160, height: 2880, fillW: 0.9, fillH: 0.44, centreY: 0.06 },
  square: { width: 2160, height: 2160, fillW: 0.88, fillH: 0.6, centreY: 0 },
  wide: { width: 3840, height: 2160, fillW: 0.78, fillH: 0.8, centreY: -0.04 },
  story: { width: 2160, height: 3840, fillW: 0.92, fillH: 0.42, centreY: 0.04 },
};
const ORDER: PackFormat[] = ['feed45', 'feed34', 'square', 'wide', 'story'];

/** Where the fan has put the tifo in one size: its middle (-1..1 each way) and how tight the lens is. */
interface Framing {
  x: number;
  y: number;
  zoom: number;
}
const ZOOM = { min: 0.5, max: 1.8 };
const REACH = 0.9;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Kept for the visit: the size on show and each size's framing. */
let kept: { format: PackFormat; framing: Partial<Record<PackFormat, Framing>> } = { format: 'feed45', framing: {} };

/** The preview's longest side, px. */
const PREVIEW_EDGE = 720;
const MARK = 'tifomaker.org';

/**
 * The tifo's art alone: every painted seat as its card, on a clear
 * background, cropped to the art. Null when nothing is painted. The longest
 * side is `edge` px, short of drawing a card larger than 48 px.
 */
export function tifoArt(map: SeatMap, store: DesignStore, edge = 4096): HTMLCanvasElement | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < map.count; i++) {
    if (store.cells[i] === 0) continue;
    const x = map.xy[i * 2];
    const y = map.xy[i * 2 + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return null;
  // A card on the unrolled bowl: 3.2 across, 6.8 down (the strip's own, net/api renderStripCanvas).
  const cw = 3.2;
  const ch = 6.8;
  const bw = x1 - x0 + cw;
  const bh = y1 - y0 + ch;
  const scale = Math.min(edge / Math.max(bw, bh), 48 / cw);
  const pad = Math.round(scale * 2);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bw * scale) + pad * 2);
  c.height = Math.max(1, Math.round(bh * scale) + pad * 2);
  const g = c.getContext('2d')!;
  const sw = Math.max(1, Math.round(cw * scale));
  const sh = Math.max(1, Math.round(ch * scale));
  for (let col = 1; col < store.palette.length; col++) {
    g.fillStyle = store.palette[col];
    for (let i = 0; i < map.count; i++) {
      if (store.cells[i] !== col) continue;
      g.fillRect(Math.round((map.xy[i * 2] - x0) * scale) + pad, Math.round((map.xy[i * 2 + 1] - y0) * scale) + pad, sw, sh);
    }
  }
  return c;
}

const pngOf = (c: HTMLCanvasElement): Promise<Blob | null> => new Promise((r) => c.toBlob(r, 'image/png'));

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function openPackSheet(deps: PackSheetDeps): Promise<void> {
  const md = matchDayDeps();
  if (!md) return;
  const lang: 'en' | 'ar' = getLang() === 'ar' ? 'ar' : 'en';
  let format: PackFormat = kept.format;
  const framing: Record<PackFormat, Framing> = Object.fromEntries(ORDER.map((k) => [k, { x: 0, y: 0, zoom: 1, ...kept.framing[k] }])) as Record<PackFormat, Framing>;
  const keep = (): void => {
    kept = { format, framing: { ...framing } };
  };

  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop qv-poster-backdrop';
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  root.innerHTML =
    `<div class="pro-sheet qv-poster qv-pack" role="dialog" aria-modal="true" aria-labelledby="qv-k-title">` +
    `<button type="button" class="pro-sheet-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>` +
    `<div class="qv-poster-head"><span class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</span>` +
    `<div><h2 id="qv-k-title">${escapeHtml(t('pack.title'))}</h2><p class="qv-lead"></p></div></div>` +
    `<div class="qv-poster-body">` +
    `<div class="qv-pack-stage">` +
    `<div class="qv-preview"><canvas tabindex="0" role="img" aria-label="${escapeHtml(t('pack.preview'))}"></canvas><p class="qv-wait" role="status" aria-live="polite"></p></div>` +
    `<p class="qv-pack-hint">${escapeHtml(t('pack.drag'))}</p>` +
    `</div>` +
    `<div class="qv-form">` +
    (tifoSplit(md.map.uv, md.map.count, (i) => md.store.cells[i] !== 0) >= SPLIT_TELLS ? `<p class="qv-p-split">${escapeHtml(t('qv.p.split'))}</p>` : '') +
    `<div class="qv-row"><span class="qv-label">${escapeHtml(t('pack.size'))}</span>` +
    `<div class="qv-pack-sizes" role="radiogroup" aria-label="${escapeHtml(t('pack.size'))}">` +
    ORDER.map((k) => {
      const s = PACK_FORMATS[k];
      return `<label class="qv-pack-size"><input type="radio" name="pack-format" value="${k}"${k === format ? ' checked' : ''} />` +
        `<span><i class="qv-pack-shape" data-k="${k}" aria-hidden="true"></i><b>${escapeHtml(t(`pack.f.${k}`))}</b><small>&#x2066;${s.width} × ${s.height}&#x2069;</small></span></label>`;
    }).join('') +
    `</div></div>` +
    `<label class="qv-field qv-pack-zoom"><span>${escapeHtml(t('pack.zoom'))}</span>` +
    `<input type="range" name="pack-zoom" min="${ZOOM.min * 100}" max="${ZOOM.max * 100}" step="1" value="100" /></label>` +
    `<button type="button" class="pro-text-btn qv-pack-reset">${escapeHtml(t('pack.reset'))}</button>` +
    `<div class="pro-actions">` +
    `<button type="button" class="pro-btn qv-download" data-get="one">${CROWN_SVG}<span>${escapeHtml(t('pack.one'))}</span></button>` +
    `<button type="button" class="pro-alt" data-get="all">${escapeHtml(t('pack.all'))}</button>` +
    `<button type="button" class="pro-alt" data-get="art">${escapeHtml(t('pack.art'))}</button>` +
    `</div>` +
    `<p class="qv-status" role="status" aria-live="polite"></p>` +
    `</div></div></div>`;
  const $ = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  const canvas = $<HTMLCanvasElement>('.qv-preview canvas');
  const wait = $('.qv-wait');
  const status = $('.qv-status');
  const lead = $('.qv-lead');
  const zoom = $<HTMLInputElement>('input[name="pack-zoom"]');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-get]')];
  document.body.appendChild(root);

  let closed = false;
  let close: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    close = (): void => {
      if (closed) return;
      closed = true;
      release();
      root.remove();
      resolve();
    };
  });
  const release = containDialog(root, () => close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('.pro-sheet-close').addEventListener('click', () => close());

  const paintWords = (): void => {
    const s = PACK_FORMATS[format];
    lead.textContent = tv('pack.lead', { name: t(`pack.f.${format}`), w: s.width, h: s.height });
    zoom.value = String(Math.round(framing[format].zoom * 100));
  };

  // ---- drawing: one picture at a time, and only the newest framing asked for ----
  let sim: MatchDaySimulator | null = null;
  let drawing: Promise<void> = Promise.resolve();
  let wanted = 0;
  /** The picture of `k` as framed, at w × h, with the mark and the credit line an export carries. */
  const picture = async (k: PackFormat, w: number, h: number, dress: boolean): Promise<HTMLCanvasElement | null> => {
    if (!sim) return null;
    const { filmStill } = await import('../render/simulator/film');
    const base = PACK_FORMATS[k];
    const fr = framing[k];
    const c = await filmStill(sim.filmHost(), w, h, { fillW: base.fillW * fr.zoom, fillH: base.fillH * fr.zoom, centreY: clamp(base.centreY + fr.y, -REACH, REACH), centreX: clamp(fr.x, -REACH, REACH) });
    if (dress) {
      const g = c.getContext('2d')!;
      const marked = !deps.clean();
      if (marked) drawWatermark(g, w, h, MARK);
      if (deps.creditLine) drawCreditLine(g, w, h, deps.creditLine, { avoid: marked ? 'right' : null });
    }
    return c;
  };
  /** The last picture the camera drew, and the framing it was drawn for. */
  let shown: ({ pic: HTMLCanvasElement; format: PackFormat } & Framing) | null = null;
  /**
   * Put the last picture on the preview where the framing now has it: slid
   * and scaled in 2D, which is instant, until the camera has drawn the new
   * framing (a third of a second on a desktop). The mark and the credit line
   * are drawn over it, where an export has them.
   */
  const present = (): void => {
    if (!shown || shown.format !== format) return;
    const fr = framing[format];
    const w = canvas.width;
    const h = canvas.height;
    const g = canvas.getContext('2d')!;
    const z = fr.zoom / shown.zoom;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0a0f1a';
    g.fillRect(0, 0, w, h);
    g.translate(w / 2 + ((fr.x - shown.x) * w) / 2, h / 2 - ((fr.y - shown.y) * h) / 2);
    g.scale(z, z);
    g.drawImage(shown.pic, -w / 2, -h / 2, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const marked = !deps.clean();
    if (marked) drawWatermark(g, w, h, MARK);
    if (deps.creditLine) drawCreditLine(g, w, h, deps.creditLine, { avoid: marked ? 'right' : null });
  };
  const redraw = (): void => {
    const mine = ++wanted;
    drawing = drawing.then(async () => {
      // A newer framing was asked for while this one waited: draw that one only.
      if (closed || mine !== wanted) return;
      const s = PACK_FORMATS[format];
      const k = PREVIEW_EDGE / Math.max(s.width, s.height);
      const w = Math.round(s.width * k);
      const h = Math.round(s.height * k);
      try {
        const k0 = format;
        const at = { ...framing[k0] };
        const pic = await picture(k0, w, h, false);
        if (!pic || closed) return;
        shown = { pic, format: k0, ...at };
        // The fan moved on while it was drawn: the newer framing is next in line, slide this one to it meanwhile.
        if (k0 !== format) return;
        canvas.width = w;
        canvas.height = h;
        canvas.dataset.shape = h > w ? 'portrait' : 'landscape';
        present();
        canvas.dataset.ready = '1';
        wait.textContent = '';
      } catch (e) {
        console.warn('[tifo] the pack preview failed', e);
        wait.textContent = t('pack.failed');
      }
    });
  };

  // ---- moving the tifo in the frame: drag, the slider, the wheel, the keys ----
  const move = (dx: number, dy: number): void => {
    const fr = framing[format];
    fr.x = clamp(fr.x + dx, -REACH, REACH);
    fr.y = clamp(fr.y + dy, -REACH, REACH);
    keep();
    present();
    redraw();
  };
  const setZoom = (z: number): void => {
    framing[format].zoom = clamp(z, ZOOM.min, ZOOM.max);
    zoom.value = String(Math.round(framing[format].zoom * 100));
    keep();
    present();
    redraw();
  };
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    // The picture follows the finger: its middle is -1..1 across the frame.
    move(((e.clientX - drag.x) / Math.max(1, r.width)) * 2, (-(e.clientY - drag.y) / Math.max(1, r.height)) * 2);
    drag = { x: e.clientX, y: e.clientY };
  });
  const drop = (): void => {
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(framing[format].zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 0.05;
    const by: Record<string, () => void> = {
      ArrowLeft: () => move(-step, 0), ArrowRight: () => move(step, 0), ArrowUp: () => move(0, step), ArrowDown: () => move(0, -step),
      '+': () => setZoom(framing[format].zoom * 1.06), '=': () => setZoom(framing[format].zoom * 1.06), '-': () => setZoom(framing[format].zoom / 1.06),
    };
    const go = by[e.key];
    if (!go) return;
    e.preventDefault();
    go();
  });
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.name === 'pack-zoom') setZoom(Number(el.value) / 100);
    else if (el.name === 'pack-format') {
      format = el.value as PackFormat;
      keep();
      paintWords();
      delete canvas.dataset.ready;
      wait.textContent = t('qv.p.drawingPreview');
      redraw();
    }
  });
  $('.qv-pack-reset').addEventListener('click', () => {
    framing[format] = { x: 0, y: 0, zoom: 1 };
    keep();
    paintWords();
    present();
    redraw();
  });

  // ---- the downloads ----
  /** `k` at its full size, or the largest this device will draw (half, then a third). */
  const full = async (k: PackFormat): Promise<HTMLCanvasElement | null> => {
    const s = PACK_FORMATS[k];
    for (const div of [1, 2, 3]) {
      try {
        const pic = await picture(k, Math.round(s.width / div), Math.round(s.height / div), true);
        if (pic) return pic;
      } catch (e) {
        console.warn('[tifo] the pack could not draw', k, 'at 1/' + div, e);
      }
    }
    return null;
  };
  const bytes = async (c: HTMLCanvasElement): Promise<Uint8Array | null> => {
    const blob = await pngOf(c);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  const say = (msg: string): void => {
    status.textContent = msg;
    deps.say(msg);
  };
  const get = async (what: 'one' | 'all' | 'art'): Promise<void> => {
    const how = await exportGate([t('pack.item'), ...deps.designItems()], {
      free: async () => (deps.freeStill ? deps.freeStill() : null),
      pro: async () => (canvas.dataset.ready ? canvas : null),
    });
    if (how === null) return;
    if (how === 'free') {
      close();
      deps.say(await deps.free());
      return;
    }
    await drawing;
    const name = deps.title();
    if (what === 'art') {
      const art = tifoArt(md.map, md.store);
      const blob = art ? await pngOf(art) : null;
      if (!art || !blob) {
        say(t(art ? 'pack.failed' : 'pack.noArt'));
        return;
      }
      save(blob, `${name}-tifo-art.png`);
      say(tv('pack.artSaved', { w: art.width, h: art.height }));
      return;
    }
    if (what === 'one') {
      status.textContent = tv('pack.making', { name: t(`pack.f.${format}`) });
      const pic = await full(format);
      const blob = pic ? await pngOf(pic) : null;
      if (!pic || !blob) {
        say(t('pack.failed'));
        return;
      }
      save(blob, `${name}-${format}-${pic.width}x${pic.height}.png`);
      const s = PACK_FORMATS[format];
      say(tv('pack.saved', { name: t(`pack.f.${format}`), w: pic.width, h: pic.height, mb: mb(blob.size) }) + (pic.width < s.width ? ` ${tv('pack.smaller', { w: pic.width, h: pic.height })}` : ''));
      return;
    }
    // All of them, and the art, in one ZIP.
    const files: { name: string; data: Uint8Array }[] = [];
    for (let i = 0; i < ORDER.length; i++) {
      if (closed) return;
      const k = ORDER[i];
      status.textContent = tv('pack.makingN', { n: i + 1, total: ORDER.length, name: t(`pack.f.${k}`) });
      const pic = await full(k);
      const data = pic ? await bytes(pic) : null;
      if (pic && data) files.push({ name: `${name}-${k}-${pic.width}x${pic.height}.png`, data });
    }
    const art = tifoArt(md.map, md.store);
    const artData = art ? await bytes(art) : null;
    if (artData) files.push({ name: `${name}-tifo-art.png`, data: artData });
    if (!files.length) {
      say(t('pack.failed'));
      return;
    }
    const zip = zipStore(files);
    save(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }), `${name}-designer-pack.zip`);
    say(tv('pack.savedAll', { n: files.length, mb: mb(zip.length) }));
  };
  for (const b of buttons) {
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      for (const x of buttons) x.disabled = true;
      status.textContent = '';
      try {
        await get(b.dataset.get as 'one' | 'all' | 'art');
      } catch (e) {
        console.warn('[tifo] the pack failed', e);
        status.textContent = t('pack.failed');
      } finally {
        for (const x of buttons) x.disabled = false;
      }
    });
  }

  paintWords();
  wait.textContent = t('qv.p.drawingPreview');
  try {
    await offscreenMatchDay(async (s) => {
      sim = s;
      redraw();
      await done;
      await drawing;
      sim = null;
    });
  } catch {
    wait.textContent = t('pack.failed');
    await done;
  }
}
