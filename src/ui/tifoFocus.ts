/**
 * The part of the tifo to show: chosen by the fan, not by the camera.
 *
 * Reported on 19 Nov 2026: the poster, the proposal page, the designer pack
 * and the vertical film each framed "the tifo" for a design that goes round
 * the ground, or is wider than the picture, by showing whichever stretch the
 * camera happened to face. Nobody had asked the fan which part mattered.
 *
 * This is the asking: the tifo laid flat (the seat map's own unrolled plan),
 * and a box dragged over the part to show. The seats in the box are what
 * Match Day's cameras are worked out from (MatchDaySimulator.setTifoFocus):
 * the film's stage camera stands across from them, a picture is framed on
 * them, and a vertical film holds on them instead of panning across the
 * whole tifo. Every card still goes up; only where the camera looks changes.
 * With no box the camera chooses, as it always did.
 *
 * One choice for the visit, kept per ground and shared by every export: the
 * poster, the pack, the proposal, the Reel, the editor's Pro video sizes and
 * Match Day's own film.
 */
import './tifoFocus.css';
import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';
import { tifoFootprint } from '../render/simulator/cameras';
import { t } from './i18n';

/** The box, as fractions (0..1) of the painted art's own bounds on the unrolled plan. */
export interface TifoFocus {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A card on the unrolled bowl (net/api renderStripCanvas, proPack tifoArt). */
const CARD = { w: 3.2, h: 6.8 };
/** Fewer cards than this is a mark, not a part of a tifo to frame (cameras.ts tifoFootprint). */
const FEWEST = 24;
/** The smallest box, as a share of the art each way. */
const SMALLEST = 0.06;

let kept: { ground: string; focus: TifoFocus } | null = null;
const listeners = new Set<() => void>();

/** The part chosen for this ground in this visit, or null: the camera chooses. */
export function tifoFocus(ground: string): TifoFocus | null {
  return kept && kept.ground === ground ? kept.focus : null;
}

function setFocus(ground: string, focus: TifoFocus | null): void {
  kept = focus ? { ground, focus } : null;
  for (const l of listeners) l();
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The painted cards' bounds on the unrolled plan, or null when nothing is painted. */
function artBox(map: SeatMap, store: DesignStore): Box | null {
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
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0 + CARD.w, h: y1 - y0 + CARD.h };
}

/**
 * The seats in `focus`: 1 for each painted seat whose card's middle is in the
 * box. Null when there is no box, or it holds too few cards to frame.
 */
export function focusSeats(map: SeatMap, store: DesignStore, focus: TifoFocus | null): Uint8Array | null {
  const art = focus ? artBox(map, store) : null;
  if (!focus || !art) return null;
  const ax0 = art.x + focus.x0 * art.w;
  const ax1 = art.x + focus.x1 * art.w;
  const ay0 = art.y + focus.y0 * art.h;
  const ay1 = art.y + focus.y1 * art.h;
  const out = new Uint8Array(map.count);
  let n = 0;
  for (let i = 0; i < map.count; i++) {
    if (store.cells[i] === 0) continue;
    const x = map.xy[i * 2] + CARD.w / 2;
    const y = map.xy[i * 2 + 1] + CARD.h / 2;
    if (x < ax0 || x > ax1 || y < ay0 || y > ay1) continue;
    out[i] = 1;
    n++;
  }
  return n >= FEWEST ? out : null;
}

/** The chosen part's seats for this design, ready for MatchDaySimulator.setTifoFocus. */
export function chosenSeats(d: { map: SeatMap; store: DesignStore; template: { id: string } }): Uint8Array | null {
  return focusSeats(d.map, d.store, tifoFocus(d.template.id));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface FocusPicker {
  root: HTMLElement;
  /** Take it off the page and stop listening. */
  destroy(): void;
}

/**
 * The picker: the tifo flat, a box to drag over it, and "Let the camera
 * choose". `onChange` runs when the choice changes, here or in another
 * picker on the page.
 */
export function focusPicker(d: { map: SeatMap; store: DesignStore; template: { id: string } }, onChange: () => void): FocusPicker {
  const ground = d.template.id;
  const root = document.createElement('div');
  root.className = 'tf';
  const art = artBox(d.map, d.store);
  if (!art) {
    root.hidden = true;
    return { root, destroy: () => {} };
  }
  // A design round the whole bowl has no camera of its own (tifoFootprint is null): say why a part is worth choosing.
  const round = !tifoFootprint(d.map, (i) => d.store.cells[i] !== 0);
  const label = document.createElement('span');
  label.className = 'tf-label';
  label.textContent = t('focus.label');
  const stage = document.createElement('div');
  stage.className = 'tf-art';
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t('focus.aria'));
  stage.append(canvas);
  const hint = document.createElement('p');
  hint.className = 'tf-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'pro-text-btn tf-all';
  all.textContent = t('focus.all');
  root.append(label, stage, hint, all);

  // The art, drawn once: every painted seat as its card, the canvas the art's own shape (a low strip is given room to drag in).
  const W = 720;
  const scale = Math.min(W / art.w, 300 / art.h);
  const aw = Math.max(1, Math.round(art.w * scale));
  const ah = Math.max(1, Math.round(art.h * scale));
  const cw = aw;
  const ch = Math.max(ah, 56);
  const oy = Math.round((ch - ah) / 2);
  canvas.width = cw;
  canvas.height = ch;
  const base = document.createElement('canvas');
  base.width = cw;
  base.height = ch;
  {
    const g = base.getContext('2d')!;
    const sw = Math.max(1, Math.ceil(CARD.w * scale));
    const sh = Math.max(1, Math.ceil(CARD.h * scale));
    for (let col = 1; col < d.store.palette.length; col++) {
      g.fillStyle = d.store.palette[col];
      for (let i = 0; i < d.map.count; i++) {
        if (d.store.cells[i] !== col) continue;
        g.fillRect(Math.round((d.map.xy[i * 2] - art.x) * scale), oy + Math.round((d.map.xy[i * 2 + 1] - art.y) * scale), sw, sh);
      }
    }
  }

  /** The box being shown: the kept one, or the one under the finger. */
  let box: TifoFocus | null = tifoFocus(ground);
  let few = false;
  const paint = (): void => {
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, cw, ch);
    g.drawImage(base, 0, 0);
    if (box) {
      const x = box.x0 * aw;
      const y = oy + box.y0 * ah;
      const w = (box.x1 - box.x0) * aw;
      const h = (box.y1 - box.y0) * ah;
      // Everything outside the box is dimmed: four bands round it.
      g.fillStyle = 'rgba(6, 10, 18, 0.66)';
      g.fillRect(0, 0, cw, y);
      g.fillRect(0, y + h, cw, ch - y - h);
      g.fillRect(0, y, x, h);
      g.fillRect(x + w, y, cw - x - w, h);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(6, 10, 18, 0.9)';
      g.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      g.lineWidth = 2;
      g.strokeStyle = '#ffffff';
      g.strokeRect(x, y, w, h);
      g.fillStyle = '#ffffff';
      for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) g.fillRect(hx - 5, hy - 5, 10, 10);
    }
    hint.textContent = t(few ? 'focus.few' : box ? 'focus.on' : round ? 'focus.hintRound' : 'focus.hint');
    all.hidden = !box;
    root.dataset.on = box ? '1' : '';
  };

  /** Keep the box (or none), tell every picker and whoever asked. Too few cards in it: no box, and say so. */
  const commit = (next: TifoFocus | null): void => {
    few = !!next && !focusSeats(d.map, d.store, next);
    const now = few ? null : next;
    const before = tifoFocus(ground);
    box = now;
    if (JSON.stringify(now) === JSON.stringify(before)) {
      paint();
      return;
    }
    setFocus(ground, now);
  };
  const listen = (): void => {
    box = tifoFocus(ground);
    paint();
    onChange();
  };
  listeners.add(listen);

  // ---- the box: drawn, moved or resized by a corner ----
  const at = (e: PointerEvent): { x: number; y: number; px: number } => {
    const r = canvas.getBoundingClientRect();
    const k = cw / Math.max(1, r.width);
    return { x: clamp(((e.clientX - r.left) * k) / aw, 0, 1), y: clamp(((e.clientY - r.top) * k - oy) / ah, 0, 1), px: k };
  };
  type Drag = { kind: 'new'; ax: number; ay: number } | { kind: 'move'; dx: number; dy: number } | { kind: 'size'; ax: number; ay: number };
  let drag: Drag | null = null;
  let before: TifoFocus | null = null;
  /** Where the finger went down, on the screen: a tap is judged by how far it moved there, not on the picture. */
  let downAt = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    const p = at(e);
    before = box;
    downAt = { x: e.clientX, y: e.clientY };
    drag = { kind: 'new', ax: p.x, ay: p.y };
    if (box) {
      // Within a finger of a corner: that corner moves, the opposite one stays.
      const reachX = (16 * p.px) / aw;
      const reachY = (16 * p.px) / ah;
      const nearX = Math.abs(p.x - box.x0) <= reachX ? box.x1 : Math.abs(p.x - box.x1) <= reachX ? box.x0 : null;
      const nearY = Math.abs(p.y - box.y0) <= reachY ? box.y1 : Math.abs(p.y - box.y1) <= reachY ? box.y0 : null;
      if (nearX !== null && nearY !== null) drag = { kind: 'size', ax: nearX, ay: nearY };
      else if (p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1) drag = { kind: 'move', dx: p.x - box.x0, dy: p.y - box.y0 };
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === 'move' && box) {
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const x0 = clamp(p.x - drag.dx, 0, 1 - w);
      const y0 = clamp(p.y - drag.dy, 0, 1 - h);
      box = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else if (drag.kind !== 'move') {
      box = { x0: Math.min(drag.ax, p.x), y0: Math.min(drag.ay, p.y), x1: Math.max(drag.ax, p.x), y1: Math.max(drag.ay, p.y) };
    }
    few = false;
    paint();
  });
  const drop = (cancelled: boolean, moved = 0): void => {
    if (!drag) return;
    const was = drag;
    drag = null;
    canvas.classList.remove('dragging');
    if (cancelled || !box) {
      box = before;
      paint();
      return;
    }
    let { x0, y0, x1, y1 } = box;
    if (was.kind === 'new') {
      // A tap is not a box; a stroke along a low strip means that stretch, top to bottom.
      if (moved < 8) {
        box = before;
        paint();
        return;
      }
      if ((y1 - y0) * ah < 14) {
        y0 = 0;
        y1 = 1;
      }
    }
    if (x1 - x0 < SMALLEST) {
      const m = clamp((x0 + x1) / 2, SMALLEST / 2, 1 - SMALLEST / 2);
      x0 = m - SMALLEST / 2;
      x1 = m + SMALLEST / 2;
    }
    if (y1 - y0 < SMALLEST) {
      const m = clamp((y0 + y1) / 2, SMALLEST / 2, 1 - SMALLEST / 2);
      y0 = m - SMALLEST / 2;
      y1 = m + SMALLEST / 2;
    }
    commit({ x0, y0, x1, y1 });
  };
  canvas.addEventListener('pointerup', (e) => drop(false, Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)));
  canvas.addEventListener('pointercancel', () => drop(true));

  // The keys: arrows move the box, Shift with an arrow resizes it, Delete clears it. The first key puts a box in the middle.
  let settle = 0;
  canvas.addEventListener('keydown', (e) => {
    const step = 0.03;
    const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if ((e.key === 'Delete' || e.key === 'Backspace') && box) {
      e.preventDefault();
      commit(null);
      return;
    }
    const by = dir[e.key];
    if (!by) return;
    e.preventDefault();
    const b = box ?? { x0: 0.3, y0: 0, x1: 0.7, y1: 1 };
    if (!box) box = b;
    else if (e.shiftKey) box = { x0: b.x0, y0: b.y0, x1: clamp(b.x1 + by[0], b.x0 + SMALLEST, 1), y1: clamp(b.y1 + by[1], b.y0 + SMALLEST, 1) };
    else {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const x0 = clamp(b.x0 + by[0], 0, 1 - w);
      const y0 = clamp(b.y0 + by[1], 0, 1 - h);
      box = { x0, y0, x1: x0 + w, y1: y0 + h };
    }
    few = false;
    paint();
    // The pictures are drawn again once the keys rest.
    window.clearTimeout(settle);
    settle = window.setTimeout(() => commit(box), 350);
  });
  all.addEventListener('click', () => commit(null));

  paint();
  return {
    root,
    destroy: () => {
      window.clearTimeout(settle);
      listeners.delete(listen);
      root.remove();
    },
  };
}
