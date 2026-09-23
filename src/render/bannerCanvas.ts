import type { ToolId } from '../core/types';
import type { BannerDoc, BannerItem, BannerSize, ImageItem, ShapeItem, TextItem } from '../core/banner';
import { aspectOf, bannerFacts, isPlaced, makeStroke, PANEL_MAX_M, estimateSize } from '../core/banner';
import type { BannerStore } from '../core/banner';
import { drawBanner, hitTest, itemBounds, onBannerImageReady, strokePath } from './bannerRender';

/**
 * The banner artboard — the 2D surface you draw a banner on.
 *
 * Deliberately NOT the Pixi editor. That surface exists to tint sixty thousand
 * instanced particles as fast as a finger can move, and every one of its
 * decisions follows from that. A banner is a handful of smooth curves on a
 * sheet of fabric: the right tool is a 2D context, where a stroke is a stroke
 * rather than a quantised row of seats.
 *
 * What it does share with the seat editor is every convention a user has
 * already learned — the same nine tools on the same keys, the same two-finger
 * pan, two-finger-tap undo and double-tap fit. Two drawing surfaces in one app
 * that behave differently under the same finger is worse than one that is
 * missing a feature.
 */

/** A snap the artboard can make, and the guide it draws when it does. */
interface Snap {
  /** Axis: 'x' or 'y'. */
  axis: 'x' | 'y';
  /** Position in banner units. */
  at: number;
  /** i18n-free label: a short token the view renders. */
  label: string;
}

export interface BannerCanvasHooks {
  /** Eyedropper picked a colour off the artboard. */
  onColorPick: ((hex: string) => void) | null;
  /** A tool that places something was clicked; coords are banner units. */
  onPlaceStamp: ((x: number, y: number) => void) | null;
  /** Selection changed (item id, or null). */
  onSelect: ((id: string | null) => void) | null;
  /** Undo/redo availability may have changed. */
  onHistory: (() => void) | null;
  /** Two-finger tap. */
  onTwoFingerTap: (() => void) | null;
  /** Double tap / double click on empty space. */
  onDoubleTap: (() => void) | null;
  /** Zoom changed, for the toolbar's readout. */
  onZoom: ((pct: number) => void) | null;
}

const HANDLE_PX = 11;
const ROTATE_OFFSET_PX = 26;

type Handle = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w' | 'rot';

export class BannerCanvas implements BannerCanvasHooks {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: HTMLElement;
  private readonly store: BannerStore;
  private ro: ResizeObserver | null = null;
  private unsubStore: (() => void) | null = null;
  private unsubImg: (() => void) | null = null;
  private raf = 0;

  tool: ToolId = 'brush';
  color = '#e11d2a';
  /** Brush width in METRES, so "20 cm" means 20 cm of fabric at any zoom. */
  brushM = 0.35;
  /** Show the 3 m panel seams. */
  showSeams = true;
  /** Show centre lines, thirds and the legible-type band. */
  showGuides = true;
  /** Snap placed items to the banner's own geometry. */
  snap = true;
  /**
   * How big this banner really is, in metres.
   *
   * The seams, the ruler, the legible-type band and the brush width are all
   * facts about a physical sheet, so they have to come from the size the
   * blocks actually give it on this ground. The view supplies that; the
   * catalogue average is only the fallback for a surface with no stand.
   */
  sizeOf: (doc: BannerDoc) => BannerSize = estimateSize;
  /** The words on the legible-type band, given its height in metres. */
  capLabel: ((m: number) => string) | null = null;

  onColorPick: ((hex: string) => void) | null = null;
  onPlaceStamp: ((x: number, y: number) => void) | null = null;
  onSelect: ((id: string | null) => void) | null = null;
  onHistory: (() => void) | null = null;
  onTwoFingerTap: (() => void) | null = null;
  onDoubleTap: (() => void) | null = null;
  onZoom: ((pct: number) => void) | null = null;

  // View transform: banner units -> css px.
  private scale = 600;
  /**
   * The scale at which the whole banner fits, which is what 100% means here.
   *
   * An absolute percentage is meaningless for a banner: a 40 m sheet at "100%"
   * of anything is either a postage stamp or twelve screens wide. Fit is the
   * reading a designer actually wants — 100% is the whole thing, 400% is four
   * times into it.
   */
  private fitScale = 600;
  private originX = 0;
  private originY = 0;

  // Gesture state.
  private drawing: { item: ReturnType<typeof makeStroke> } | null = null;
  private panning = false;
  private lastPx = 0;
  private lastPy = 0;
  private dragItem: { id: string; handle: Handle | null; ox: number; oy: number; start: BannerItem } | null = null;
  private activeSnaps: Snap[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private gestureStart = 0;
  private gestureMoved = 0;
  private lastTapAt = 0;

  private constructor(host: HTMLElement, store: BannerStore) {
    this.host = host;
    this.store = store;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'banner-canvas';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  static create(host: HTMLElement, store: BannerStore): BannerCanvas {
    const bc = new BannerCanvas(host, store);
    bc.watchHost();
    bc.bindPointer();
    bc.unsubStore = store.onChange(() => bc.requestDraw());
    bc.unsubImg = onBannerImageReady(() => bc.requestDraw());
    bc.resize();
    bc.fitToView();
    return bc;
  }

  destroy(): void {
    this.ro?.disconnect();
    this.ro = null;
    this.unsubStore?.();
    this.unsubImg?.();
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  /**
   * Keep the drawing surface the size of its box.
   *
   * The seat editor learned this the hard way: `resizeTo` only listens to
   * WINDOW resize, so opening a tool bar above the canvas shortened the host
   * and left the surface overhanging by 95 px — with every click landing 18
   * rows off. The banner bar opens above this canvas the same way, so the
   * observer is here from the first commit rather than after the bug.
   */
  private watchHost(): void {
    if (typeof ResizeObserver === 'undefined') return;
    let w = 0;
    let h = 0;
    let top = 0;
    let left = 0;
    this.ro = new ResizeObserver(() => {
      const r = this.host.getBoundingClientRect();
      const nw = Math.round(r.width);
      const nh = Math.round(r.height);
      if (nw === w && nh === h) return;
      const first = w === 0 || h === 0;
      // A jump, not a nudge: the stadium opening beside the artboard halves
      // it, and a banner framed for the whole width hung off both sides.
      const jump = !first && (Math.abs(nw - w) > w * 0.2 || Math.abs(nh - h) > h * 0.2);
      // Where the box moved to on screen. The text, shape and import bars
      // open ABOVE this canvas, which pushes its top edge down by the bar's
      // height — and the banner, drawn from the canvas's own top, jumped
      // down with it, then back up when the bar closed. Placing a word moved
      // it half a bar away from where it had been clicked.
      const dTop = first ? 0 : r.top - top;
      const dLeft = first ? 0 : r.left - left;
      w = nw;
      h = nh;
      top = r.top;
      left = r.left;
      if (!nw || !nh) return; // hidden — nothing to size to
      this.resize();
      // Refit when arriving from nothing (first paint, or coming back from
      // another view) or when the box changed shape outright. A small resize
      // mid-session is not a request to re-frame — and it is not a reason for
      // the banner to move on screen either.
      if (first || jump) this.fitToView();
      else {
        this.originX -= dLeft;
        this.originY -= dTop;
        this.requestDraw();
      }
    });
    this.ro.observe(this.host);
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(r.width * dpr));
    this.canvas.height = Math.max(2, Math.round(r.height * dpr));
  }

  private get cssW(): number {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return this.canvas.width / dpr;
  }
  private get cssH(): number {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return this.canvas.height / dpr;
  }

  fitToView(): void {
    const doc = this.store.active;
    const aspect = doc ? aspectOf(doc) : 0.5;
    const pad = 46;
    const w = Math.max(40, this.cssW - pad * 2);
    const h = Math.max(40, this.cssH - pad * 2);
    this.scale = Math.min(w, h / aspect);
    this.fitScale = this.scale;
    this.originX = (this.cssW - this.scale) / 2;
    this.originY = (this.cssH - this.scale * aspect) / 2;
    this.emitZoom();
    this.requestDraw();
  }

  /** Zoom about the view's centre by a factor. */
  zoomBy(factor: number): void {
    this.zoomAt(factor, this.cssW / 2, this.cssH / 2);
  }

  private zoomAt(factor: number, px: number, py: number): void {
    const next = Math.max(40, Math.min(24000, this.scale * factor));
    const k = next / this.scale;
    this.originX = px - (px - this.originX) * k;
    this.originY = py - (py - this.originY) * k;
    this.scale = next;
    this.emitZoom();
    this.requestDraw();
  }

  private emitZoom(): void {
    this.onZoom?.(this.zoomPct);
  }

  /** Zoom as a percentage of "the whole banner on screen". */
  get zoomPct(): number {
    return Math.max(1, Math.round((this.scale / Math.max(1, this.fitScale)) * 100));
  }

  // -------------------------------------------------------------------------
  // Coordinates
  // -------------------------------------------------------------------------

  /** CSS-pixel point -> banner units. */
  private toDoc(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.originX) / this.scale, y: (py - this.originY) / this.scale };
  }

  private eventPx(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Pointer forgiveness in banner units — fatter for a finger than a mouse. */
  private slop(coarse: boolean): number {
    return ((coarse ? 16 : 7) / this.scale);
  }

  // -------------------------------------------------------------------------
  // Drawing the view
  // -------------------------------------------------------------------------

  requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw(): void {
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // Backdrop. Dark, like the seat canvas, so a white banner reads.
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const doc = this.store.active;
    if (!doc) {
      this.drawEmpty(ctx);
      return;
    }
    const aspect = aspectOf(doc);
    const w = this.scale;
    const h = this.scale * aspect;

    ctx.save();
    ctx.translate(this.originX, this.originY);

    // The fabric. A transparent banner gets a checkerboard so "nothing here"
    // is distinguishable from "white here" — they hang very differently.
    if (doc.bg) {
      ctx.fillStyle = doc.bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      this.drawChecker(ctx, w, h);
    }

    // Art, clipped to the fabric.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    drawBanner(ctx, doc, { scale: w, noBackground: true });
    // The stroke in progress is drawn live rather than pushed into the document
    // on every sample: a 300-point polyline re-serialised per pointer move is
    // the difference between a smooth line and a stuttering one.
    if (this.drawing && this.drawing.item.pts.length >= 2) {
      const it = this.drawing.item;
      ctx.save();
      if (it.erase) ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = it.color;
      ctx.lineWidth = Math.max(0.6, it.width * w);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokePath(ctx, it.pts, w);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    if (doc.material === 'mesh') this.drawMeshHint(ctx, w, h);
    // Guides drawn for a dark sheet vanish on a light one: pale yellow seams
    // on white fabric were simply not there. So they take the fabric's side.
    const ink = guideInk(doc.bg);
    if (this.showSeams) this.drawSeams(ctx, doc, w, h, ink);
    if (this.showGuides) this.drawGuides(ctx, doc, w, h, ink);

    // Fabric edge.
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    this.drawSelection(ctx, w);
    this.drawSnapGuides(ctx, w, h);
    ctx.restore();

    this.drawRulers(ctx, doc);
  }

  private drawEmpty(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = 'rgba(255,255,255,.42)';
    ctx.font = '500 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('—', this.cssW / 2, this.cssH / 2);
    ctx.textAlign = 'start';
  }

  private drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = 12;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.fillStyle = '#20242c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#272c35';
    for (let y = 0; y < h; y += s) {
      for (let x = ((y / s) % 2 === 0 ? 0 : s); x < w; x += s * 2) ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  /** A faint dot screen, so "this is mesh" is visible without punching alpha. */
  private drawMeshHint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const pitch = 5;
    if (this.scale < 200) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,10,14,.30)';
    for (let y = 0; y < h; y += pitch) {
      for (let x = ((y / pitch) % 2 === 0 ? 0 : pitch / 2); x < w; x += pitch) {
        ctx.fillRect(x, y, 1.4, 1.4);
      }
    }
    ctx.restore();
  }

  /**
   * The seams.
   *
   * This is the most useful line on the artboard and the app has never drawn
   * it. No printer makes fabric wider than about 3 m, so a banner wider than
   * that is sewn from panels and every join is visible from the far stand. A
   * portrait whose nose lands on a seam is the classic mistake.
   */
  private drawSeams(ctx: CanvasRenderingContext2D, doc: BannerDoc, w: number, h: number, ink: GuideInk): void {
    const panels = Math.max(1, Math.ceil(this.sizeOf(doc).widthM / PANEL_MAX_M - 1e-9));
    if (panels < 2) return;
    ctx.save();
    ctx.strokeStyle = ink.seam;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    for (let k = 1; k < panels; k++) {
      const x = Math.round((k / panels) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Centre lines, thirds and the legible-type band.
   *
   * The band across the top is the minimum cap height for the headline to read
   * from the far side of the pitch (D/40 — real banners sit between D/25 and
   * D/40, and Kaiserslautern's 4 m lettering on a 40 m sheet is in that band).
   * Type drawn shorter than the band will not survive the broadcast.
   */
  private drawGuides(ctx: CanvasRenderingContext2D, doc: BannerDoc, w: number, h: number, ink: GuideInk): void {
    ctx.save();
    ctx.strokeStyle = ink.third;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    // thirds
    for (let k = 1; k <= 2; k++) {
      const x = Math.round((k / 3) * w) + 0.5;
      const y = Math.round((k / 3) * h) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // centre
    ctx.strokeStyle = ink.centre;
    const cx = Math.round(w / 2) + 0.5;
    const cy = Math.round(h / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

    // legible cap-height band
    const facts = bannerFacts(doc, this.sizeOf(doc));
    const capPx = facts.headlineCapFrac * w;
    if (capPx > 6 && capPx < h * 0.9) {
      ctx.fillStyle = ink.bandFill;
      ctx.fillRect(0, 0, w, capPx);
      ctx.strokeStyle = ink.bandLine;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(capPx) + 0.5);
      ctx.lineTo(w, Math.round(capPx) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // Say what it is. An unlabelled green band across the top of the sheet
      // read as a selection, or as part of the design.
      const label = this.capLabel?.(Math.round(facts.headlineCapM * 10) / 10);
      if (label && capPx >= 16) {
        ctx.font = `600 ${Math.min(12, Math.max(10, capPx * 0.34))}px system-ui, sans-serif`;
        ctx.fillStyle = ink.bandText;
        ctx.textBaseline = 'middle';
        const rtl = document.documentElement.dir === 'rtl';
        ctx.textAlign = rtl ? 'right' : 'left';
        ctx.fillText(label, rtl ? w - 8 : 8, capPx / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }
    ctx.restore();
  }

  /**
   * Handles belong to the Select tool.
   *
   * `addItem` selects whatever was just added, which is right — reach for
   * Select and the thing you drew is already picked. Drawing the box while a
   * BRUSH is active is not: every stroke would leave a dashed rectangle round
   * itself, and the artboard would fill with them.
   */
  private drawSelection(ctx: CanvasRenderingContext2D, w: number): void {
    if (this.tool !== 'select') return;
    const it = this.store.selectedItem;
    if (!it) return;
    if (isPlaced(it)) {
      ctx.save();
      ctx.translate(it.cx * w, it.cy * w);
      ctx.rotate(((it.rot ?? 0) * Math.PI) / 180);
      const bw = it.w * w;
      const bh = it.h * w;
      ctx.strokeStyle = '#8b7cff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
      // rotation arm
      ctx.beginPath();
      ctx.moveTo(0, -bh / 2);
      ctx.lineTo(0, -bh / 2 - ROTATE_OFFSET_PX);
      ctx.stroke();
      const hs = HANDLE_PX;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6b5ce7';
      for (const [hx, hy] of [
        [-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2],
        [0, -bh / 2], [bw / 2, 0], [0, bh / 2], [-bw / 2, 0],
      ] as [number, number][]) {
        ctx.beginPath();
        ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, -bh / 2 - ROTATE_OFFSET_PX, hs / 2 + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }
    // A stroke or patch: outline its bounds, no handles (strokes are not boxes).
    const b = itemBounds(it);
    if (!b) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(139,124,255,.9)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x * w, b.y * w, b.w * w, b.h * w);
    ctx.restore();
  }

  private drawSnapGuides(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.activeSnaps.length === 0) return;
    ctx.save();
    ctx.strokeStyle = '#ff5db1';
    ctx.lineWidth = 1;
    for (const s of this.activeSnaps) {
      ctx.beginPath();
      if (s.axis === 'x') {
        const x = Math.round(s.at * w) + 0.5;
        ctx.moveTo(x, -18);
        ctx.lineTo(x, h + 18);
      } else {
        const y = Math.round(s.at * w) + 0.5;
        ctx.moveTo(-18, y);
        ctx.lineTo(w + 18, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A metre scale along the bottom, because a banner is a physical object. */
  private drawRulers(ctx: CanvasRenderingContext2D, doc: BannerDoc): void {
    const widthM = this.sizeOf(doc).widthM;
    const pxPerM = this.scale / widthM;
    if (pxPerM < 1.5) return;
    // Pick a step that lands near 70 px.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
    const step = steps.find((s) => s * pxPerM >= 60) ?? 100;
    const y = this.cssH - 16.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let m = 0; m <= widthM + 1e-6; m += step) {
      const x = Math.round(this.originX + m * pxPerM) + 0.5;
      if (x < -20 || x > this.cssW + 20) continue;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 6);
      ctx.stroke();
      ctx.fillText(`${+m.toFixed(2)}`, x + 3, y + 11);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Snapping
  // -------------------------------------------------------------------------

  /** Everything a placed item can snap to, in banner units. */
  private snapTargets(doc: BannerDoc): { xs: Snap[]; ys: Snap[] } {
    const aspect = aspectOf(doc);
    const xs: Snap[] = [
      { axis: 'x', at: 0.5, label: 'centre' },
      { axis: 'x', at: 0, label: 'edge' },
      { axis: 'x', at: 1, label: 'edge' },
      { axis: 'x', at: 1 / 3, label: 'third' },
      { axis: 'x', at: 2 / 3, label: 'third' },
    ];
    const panels = Math.max(1, Math.ceil(this.sizeOf(doc).widthM / PANEL_MAX_M - 1e-9));
    for (let k = 1; k < panels; k++) xs.push({ axis: 'x', at: k / panels, label: 'seam' });
    const ys: Snap[] = [
      { axis: 'y', at: aspect / 2, label: 'centre' },
      { axis: 'y', at: 0, label: 'edge' },
      { axis: 'y', at: aspect, label: 'edge' },
      { axis: 'y', at: aspect / 3, label: 'third' },
      { axis: 'y', at: (aspect * 2) / 3, label: 'third' },
    ];
    return { xs, ys };
  }

  /** Nudge a centre point onto whichever guide it is within a few pixels of. */
  private applySnap(doc: BannerDoc, x: number, y: number): { x: number; y: number } {
    this.activeSnaps = [];
    if (!this.snap) return { x, y };
    const tol = 7 / this.scale; // constant in PIXELS, so it feels the same at any zoom
    const { xs, ys } = this.snapTargets(doc);
    let ox = x;
    let oy = y;
    let bx: Snap | null = null;
    let by: Snap | null = null;
    for (const s of xs) if (Math.abs(x - s.at) < tol && (!bx || Math.abs(x - s.at) < Math.abs(x - bx.at))) bx = s;
    for (const s of ys) if (Math.abs(y - s.at) < tol && (!by || Math.abs(y - s.at) < Math.abs(y - by.at))) by = s;
    if (bx) { ox = bx.at; this.activeSnaps.push(bx); }
    if (by) { oy = by.at; this.activeSnaps.push(by); }
    return { x: ox, y: oy };
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('pointerleave', this.onLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.eventPx(e);
    this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
  };

  private onDown = (e: PointerEvent): void => {
    const doc = this.store.active;
    if (!doc) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.eventPx(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      // A second finger turns whatever is happening into a pan/zoom. The first
      // finger has already painted a dab — there is no way to know in advance —
      // so it is ROLLED BACK rather than committed. The seat editor learned
      // this: committing it meant the two-finger-tap undo spent itself undoing
      // an accident and nothing the user recognised changed.
      this.abortStroke();
      this.dragItem = null;
      const pts = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
      this.gestureStart = performance.now();
      this.gestureMoved = 0;
      return;
    }
    if (this.pointers.size > 2) return;

    const d = this.toDoc(p.x, p.y);
    const coarse = e.pointerType !== 'mouse';
    this.lastPx = p.x;
    this.lastPy = p.y;

    // Middle button, space-pan tool, or right button: pan.
    if (this.tool === 'pan' || e.button === 1 || e.button === 2) {
      this.panning = true;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    switch (this.tool) {
      case 'brush':
      case 'eraser': {
        this.store.begin();
        const item = makeStroke(this.color, this.brushM / this.sizeOf(doc).widthM, this.tool === 'eraser');
        item.pts.push(d.x, d.y);
        this.drawing = { item };
        this.requestDraw();
        return;
      }
      case 'eyedropper': {
        const hex = this.pickColour(p.x, p.y);
        if (hex) this.onColorPick?.(hex);
        return;
      }
      case 'fill': {
        void this.floodFill(d.x, d.y);
        return;
      }
      case 'select': {
        this.beginSelectDrag(doc, p, d, coarse);
        return;
      }
      case 'text':
      case 'shape':
      case 'import': {
        this.onPlaceStamp?.(d.x, d.y);
        return;
      }
      default:
        return;
    }
  };

  private onMove = (e: PointerEvent): void => {
    const doc = this.store.active;
    if (!doc) return;
    const p = this.eventPx(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);

    if (this.pinch && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const k = this.pinch.dist > 4 ? dist / this.pinch.dist : 1;
      this.gestureMoved += Math.abs(dist - this.pinch.dist) + Math.hypot(cx - this.pinch.cx, cy - this.pinch.cy);
      this.originX += cx - this.pinch.cx;
      this.originY += cy - this.pinch.cy;
      this.zoomAt(k, cx, cy);
      this.pinch = { dist, cx, cy };
      return;
    }

    if (this.panning) {
      this.originX += p.x - this.lastPx;
      this.originY += p.y - this.lastPy;
      this.lastPx = p.x;
      this.lastPy = p.y;
      this.requestDraw();
      return;
    }

    if (this.drawing) {
      // Coalesced events are the difference between a smooth curve and a
      // polygon on a 120 Hz screen that only delivers 60 pointer events.
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      for (const ce of events) {
        const cp = this.eventPx(ce);
        const cd = this.toDoc(cp.x, cp.y);
        const pts = this.drawing.item.pts;
        const n = pts.length;
        // Drop samples closer than a third of a pixel: they add nothing and
        // triple the size of the saved banner.
        if (n >= 2) {
          const dx = cd.x - pts[n - 2];
          const dy = cd.y - pts[n - 1];
          if (dx * dx + dy * dy < (0.33 / this.scale) ** 2) continue;
        }
        pts.push(cd.x, cd.y);
      }
      this.requestDraw();
      return;
    }

    if (this.dragItem) {
      this.moveDrag(doc, p);
      return;
    }

    // Hover cursor.
    if (this.tool === 'select') {
      const d = this.toDoc(p.x, p.y);
      const h = this.handleAt(p);
      this.canvas.style.cursor = h ? cursorFor(h) : hitTest(doc, d.x, d.y, this.slop(false)) ? 'move' : 'default';
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }

    if (this.pinch && this.pointers.size < 2) {
      const quick = performance.now() - this.gestureStart < 300 && this.gestureMoved < 14;
      this.pinch = null;
      if (quick) this.onTwoFingerTap?.();
      return;
    }

    if (this.panning) {
      this.panning = false;
      this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'default';
      return;
    }

    if (this.drawing) {
      this.commitStroke();
      return;
    }

    if (this.dragItem) {
      this.dragItem = null;
      this.activeSnaps = [];
      this.store.commit();
      this.onHistory?.();
      this.requestDraw();
      return;
    }

    // Double tap / double click on empty space fits the banner — the same
    // gesture the seat canvas uses, because a user should not have to remember
    // which surface they are on.
    const now = performance.now();
    if (now - this.lastTapAt < 320) {
      this.lastTapAt = 0;
      this.onDoubleTap?.();
    } else {
      this.lastTapAt = now;
    }
  };

  private onLeave = (): void => {
    if (this.drawing) this.commitStroke();
    this.panning = false;
  };

  private commitStroke(): void {
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    if (d.item.pts.length < 2) {
      this.store.cancel();
      this.requestDraw();
      return;
    }
    d.item.pts = simplify(d.item.pts, 0.4 / this.scale);
    this.store.addItem(d.item);
    this.store.commit();
    this.onHistory?.();
    this.requestDraw();
  }

  private abortStroke(): void {
    if (!this.drawing) return;
    this.drawing = null;
    this.store.cancel();
    this.requestDraw();
  }

  // -------------------------------------------------------------------------
  // Select / move / resize / rotate
  // -------------------------------------------------------------------------

  /** Which handle of the selected item is under a CSS-pixel point, if any. */
  private handleAt(p: { x: number; y: number }): Handle | null {
    const it = this.store.selectedItem;
    if (!it || !isPlaced(it)) return null;
    const w = this.scale;
    const rad = ((it.rot ?? 0) * Math.PI) / 180;
    const lx = p.x - this.originX - it.cx * w;
    const ly = p.y - this.originY - it.cy * w;
    // Into the item's own frame.
    const x = lx * Math.cos(-rad) - ly * Math.sin(-rad);
    const y = lx * Math.sin(-rad) + ly * Math.cos(-rad);
    const bw = (it.w * w) / 2;
    const bh = (it.h * w) / 2;
    const r = HANDLE_PX;
    const near = (hx: number, hy: number): boolean => Math.abs(x - hx) <= r && Math.abs(y - hy) <= r;
    if (near(0, -bh - ROTATE_OFFSET_PX)) return 'rot';
    if (near(-bw, -bh)) return 'nw';
    if (near(bw, -bh)) return 'ne';
    if (near(bw, bh)) return 'se';
    if (near(-bw, bh)) return 'sw';
    if (near(0, -bh)) return 'n';
    if (near(0, bh)) return 's';
    if (near(bw, 0)) return 'e';
    if (near(-bw, 0)) return 'w';
    return null;
  }

  private beginSelectDrag(doc: BannerDoc, p: { x: number; y: number }, d: { x: number; y: number }, coarse: boolean): void {
    const handle = this.handleAt(p);
    if (handle) {
      const it = this.store.selectedItem;
      if (!it) return;
      this.store.begin();
      this.dragItem = { id: it.id, handle, ox: d.x, oy: d.y, start: { ...it } };
      return;
    }
    const hit = hitTest(doc, d.x, d.y, this.slop(coarse));
    this.store.selectItem(hit ? hit.id : null);
    this.onSelect?.(hit ? hit.id : null);
    if (!hit) return;
    this.store.begin();
    this.dragItem = { id: hit.id, handle: null, ox: d.x, oy: d.y, start: { ...hit } };
  }

  private moveDrag(doc: BannerDoc, p: { x: number; y: number }): void {
    const drag = this.dragItem;
    if (!drag) return;
    const d = this.toDoc(p.x, p.y);
    const start = drag.start;

    if (!drag.handle) {
      if (isPlaced(start)) {
        const raw = { x: start.cx + (d.x - drag.ox), y: start.cy + (d.y - drag.oy) };
        const snapped = this.applySnap(doc, raw.x, raw.y);
        this.store.patchItem(drag.id, { cx: snapped.x, cy: snapped.y } as Partial<BannerItem>);
      } else if (start.kind === 'stroke') {
        const dx = d.x - drag.ox;
        const dy = d.y - drag.oy;
        const pts = start.pts.slice();
        for (let i = 0; i < pts.length; i += 2) {
          pts[i] += dx;
          pts[i + 1] += dy;
        }
        this.store.patchItem(drag.id, { pts } as Partial<BannerItem>);
      } else if (start.kind === 'patch') {
        this.store.patchItem(drag.id, {
          x: start.x + (d.x - drag.ox),
          y: start.y + (d.y - drag.oy),
        } as Partial<BannerItem>);
      }
      this.requestDraw();
      return;
    }

    if (!isPlaced(start)) return;

    if (drag.handle === 'rot') {
      const ang = (Math.atan2(d.y - start.cy, d.x - start.cx) * 180) / Math.PI + 90;
      // 15° detents unless a fine drag is wanted — holding is not available on
      // a touchscreen, so the detent is generous and the numeric field exact.
      const snapped = this.snap ? Math.round(ang / 15) * 15 : ang;
      this.store.patchItem(drag.id, { rot: Math.round(snapped * 10) / 10 } as Partial<BannerItem>);
      this.requestDraw();
      return;
    }

    // Resize in the item's own frame so a rotated box grows along its own axes.
    const rad = ((start.rot ?? 0) * Math.PI) / 180;
    const dx = d.x - drag.ox;
    const dy = d.y - drag.oy;
    const lx = dx * Math.cos(-rad) - dy * Math.sin(-rad);
    const ly = dx * Math.sin(-rad) + dy * Math.cos(-rad);
    const h = drag.handle;
    const signX = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
    const signY = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
    const aspect = start.w / Math.max(1e-6, start.h);
    let nw = Math.max(0.004, start.w + lx * signX);
    let nh = Math.max(0.004, start.h + ly * signY);
    // Corners keep the aspect: a stretched crest or a squashed face is almost
    // never what was meant, and text re-rasterises rather than stretching.
    if (signX !== 0 && signY !== 0) {
      if (nw / aspect > nh) nh = nw / aspect;
      else nw = nh * aspect;
    }
    // The dragged edge moves; the opposite edge stays put.
    const cx = start.cx + ((nw - start.w) / 2) * signX * Math.cos(rad) - ((nh - start.h) / 2) * signY * Math.sin(rad);
    const cy = start.cy + ((nw - start.w) / 2) * signX * Math.sin(rad) + ((nh - start.h) / 2) * signY * Math.cos(rad);
    this.store.patchItem(drag.id, { w: nw, h: nh, cx, cy } as Partial<BannerItem>);
    this.requestDraw();
  }

  // -------------------------------------------------------------------------
  // Colour tools
  // -------------------------------------------------------------------------

  /** Read a pixel off the artboard. Returns null over the backdrop. */
  private pickColour(px: number, py: number): string | null {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const d = this.ctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
    if (d[3] < 8) return null;
    const hex = (n: number): string => n.toString(16).padStart(2, '0');
    return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
  }

  /**
   * Flood fill.
   *
   * There is no vector answer to "the region bounded by what is already drawn"
   * — it is a pixel question. So the banner is rendered at its own resolution,
   * flooded there, and only the filled pixels are kept, as a patch item clipped
   * to their bounding box. That keeps the rest of the document vector, keeps
   * the fill undoable and re-orderable like everything else, and keeps the
   * saved size proportional to what was actually filled.
   */
  private async floodFill(dx: number, dy: number): Promise<void> {
    const doc = this.store.active;
    if (!doc) return;
    const aspect = aspectOf(doc);
    if (dx < 0 || dy < 0 || dx > 1 || dy > aspect) return;
    // Resolution follows the artboard so the fill matches what you can see,
    // capped so a deep zoom cannot ask for a 20k-pixel buffer.
    const W = Math.max(256, Math.min(2048, Math.round(this.scale)));
    const H = Math.max(2, Math.round(W * aspect));
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return;
    if (doc.bg) {
      octx.fillStyle = doc.bg;
      octx.fillRect(0, 0, W, H);
    }
    drawBanner(octx, doc, { scale: W, noBackground: true });

    const img = octx.getImageData(0, 0, W, H);
    const data = img.data;
    const sx = Math.min(W - 1, Math.max(0, Math.round(dx * W)));
    const sy = Math.min(H - 1, Math.max(0, Math.round(dy * W)));
    const at = (x: number, y: number): number => (y * W + x) * 4;
    const seed = at(sx, sy);
    const target = [data[seed], data[seed + 1], data[seed + 2], data[seed + 3]];
    const fill = hexToRgb(this.color);
    if (!fill) return;
    if (
      Math.abs(target[0] - fill[0]) < 3 && Math.abs(target[1] - fill[1]) < 3 &&
      Math.abs(target[2] - fill[2]) < 3 && target[3] > 250
    ) return; // already this colour

    // Tolerance is generous because a smooth stroke has an antialiased edge:
    // an exact match stops one pixel short of every line and leaves a halo.
    const TOL = 40 * 40 * 3;
    const close = (o: number): boolean => {
      const da = data[o + 3] - target[3];
      if (da * da > 60 * 60) return false;
      const dr = data[o] - target[0];
      const dg = data[o + 1] - target[1];
      const db = data[o + 2] - target[2];
      return dr * dr + dg * dg + db * db <= TOL;
    };

    const seen = new Uint8Array(W * H);
    const out = new Uint8ClampedArray(W * H * 4);
    const stack = [sx, sy];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    let filled = 0;
    while (stack.length) {
      const y = stack.pop() as number;
      const x = stack.pop() as number;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const idx = y * W + x;
      if (seen[idx]) continue;
      const o = idx * 4;
      if (!close(o)) continue;
      seen[idx] = 1;
      out[o] = fill[0];
      out[o + 1] = fill[1];
      out[o + 2] = fill[2];
      out[o + 3] = 255;
      filled++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    if (filled === 0 || maxX < minX) return;

    const pw = maxX - minX + 1;
    const ph = maxY - minY + 1;
    const patch = document.createElement('canvas');
    patch.width = pw;
    patch.height = ph;
    const pctx = patch.getContext('2d');
    if (!pctx) return;
    const pimg = pctx.createImageData(pw, ph);
    for (let y = 0; y < ph; y++) {
      const srcRow = ((y + minY) * W + minX) * 4;
      pimg.data.set(out.subarray(srcRow, srcRow + pw * 4), y * pw * 4);
    }
    pctx.putImageData(pimg, 0, 0);

    this.store.begin();
    this.store.addItem({
      id: `p${Date.now().toString(36)}`,
      kind: 'patch',
      src: patch.toDataURL('image/png'),
      x: minX / W,
      y: minY / W,
      w: pw / W,
      h: ph / W,
    });
    this.store.commit();
    this.onHistory?.();
    this.requestDraw();
  }

  // -------------------------------------------------------------------------
  // Placing objects
  // -------------------------------------------------------------------------

  placeText(init: Omit<TextItem, 'id' | 'kind'>): TextItem {
    const it: TextItem = { ...init, id: `t${Date.now().toString(36)}`, kind: 'text' };
    this.store.begin();
    this.store.addItem(it);
    this.store.commit();
    this.onHistory?.();
    this.requestDraw();
    return it;
  }

  placeShape(init: Omit<ShapeItem, 'id' | 'kind'>): ShapeItem {
    const it: ShapeItem = { ...init, id: `h${Date.now().toString(36)}`, kind: 'shape' };
    this.store.begin();
    this.store.addItem(it);
    this.store.commit();
    this.onHistory?.();
    this.requestDraw();
    return it;
  }

  placeImage(init: Omit<ImageItem, 'id' | 'kind'>): ImageItem {
    const it: ImageItem = { ...init, id: `m${Date.now().toString(36)}`, kind: 'image' };
    this.store.begin();
    this.store.addItem(it);
    this.store.commit();
    this.onHistory?.();
    this.requestDraw();
    return it;
  }

  /** CSS pixels at the current zoom, in banner units: what one arrow-key nudge is. */
  pxToUnits(px: number): number {
    return px / Math.max(1, this.scale);
  }

  /** Centre of the current view, in banner units — where a stamp lands by default. */
  viewCentre(): { x: number; y: number } {
    return this.toDoc(this.cssW / 2, this.cssH / 2);
  }

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.canvas.style.cursor =
      tool === 'pan' ? 'grab'
      : tool === 'select' ? 'default'
      : tool === 'eyedropper' ? 'copy'
      : 'crosshair';
    if (tool !== 'select') {
      this.store.selectItem(null);
      this.onSelect?.(null);
    }
    this.requestDraw();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The colours the artboard's guides are drawn in, on a given fabric. */
interface GuideInk {
  seam: string;
  third: string;
  centre: string;
  bandFill: string;
  bandLine: string;
  bandText: string;
}
const INK_ON_DARK: GuideInk = {
  seam: 'rgba(255,214,102,.5)',
  third: 'rgba(120,180,255,.28)',
  centre: 'rgba(120,180,255,.5)',
  bandFill: 'rgba(80,220,160,.09)',
  bandLine: 'rgba(80,220,160,.45)',
  bandText: 'rgba(120,235,185,.85)',
};
const INK_ON_LIGHT: GuideInk = {
  seam: 'rgba(176,112,0,.6)',
  third: 'rgba(24,72,150,.3)',
  centre: 'rgba(24,72,150,.52)',
  bandFill: 'rgba(16,150,96,.1)',
  bandLine: 'rgba(10,122,78,.55)',
  bandText: 'rgba(6,98,62,.92)',
};
function guideInk(bg: string | null): GuideInk {
  const rgb = bg ? hexToRgb(bg) : null;
  if (!rgb) return INK_ON_DARK; // see-through: drawn over the dark checkerboard
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return y > 0.36 ? INK_ON_LIGHT : INK_ON_DARK;
}

function cursorFor(h: Handle): string {
  switch (h) {
    case 'rot': return 'grab';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'nw': case 'se': return 'nwse-resize';
    default: return 'nesw-resize';
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Ramer-Douglas-Peucker, run once when a stroke is released.
 *
 * A two-second drag at 120 Hz is 240 samples; almost all of them lie on the
 * curve the remaining ones already describe. Dropping them at a tolerance of
 * under half a pixel is invisible and typically removes 70-85% of the points —
 * which is the difference between a banner that fits in the design's save
 * payload and one that does not.
 */
export function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    if (b <= a + 1) continue;
    const ax = pts[a * 2];
    const ay = pts[a * 2 + 1];
    const bx = pts[b * 2];
    const by = pts[b * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t;
      const qy = ay + dy * t;
      const d = (px - qx) ** 2 + (py - qy) ** 2;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tol2 && worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return out;
}
