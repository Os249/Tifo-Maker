/**
 * Pro fonts: the words on the stand's own seats, before and after they land.
 *
 * Mounted by ui/proFonts.ts (so only for an account Pro is on for), under the
 * Text tool's bar and under a text layer's words in the layer panel. A font
 * list shows a face drawn smooth at 16 px; a tifo is the same face one card a
 * seat, and that is where a face that looked fine in the list breaks up. So
 * this shows, for the words being typed or the layer selected:
 *
 *  - the words exactly as they will be (or are) on the seats: the layer's own
 *    raster (core/objects ensureGrid, which draws a Pro voice seat-aware,
 *    core/seatText) stamped on this ground's seat map where they will land,
 *    over the design's own colours, one rectangle a seat;
 *  - what the face's measured floor says about it there (core/seatText
 *    seatVerdict): it reads; it reads because its thin strokes were drawn
 *    thicker; it needs taller letters; the stand is too shallow for it; it is
 *    a banners-only face. With the fix one tap away: the height it needs, or
 *    the face that reads smallest;
 *  - every Pro face the same way, small, on the same spot: a tap picks it.
 *
 * Where the words land: the Text tool's words where the pointer last rested
 * on the seats (the middle of the view until it has); a layer's where it is.
 * Drawn a beat after the last change, and only while it can be seen.
 */
import './seatPreview.css';
import type { ProToolsContext } from './proTools';
import { PRO_VOICES, isProVoice, seatsVoice } from '../core/proVoices';
import { seatVerdict, type SeatVerdict } from '../core/seatText';
import { ensureGrid, type TextObject } from '../core/objects';
import { fontCssOf, renderTextCanvas } from '../core/text';
import { stampObject } from '../core/layers';
import { EDITOR_UNITS } from '../core/seatmap';
import { standIndexOfU } from '../core/tifoSpec';
import { loadProFonts, loadTifoFonts } from '../core/tifoFonts';
import { onLangChange, t, tv } from './i18n';

/** The Pro voices that go on seats, in the pickers' order. */
const SEAT_VOICES = PRO_VOICES.filter((v) => v.seats !== false).map((v) => v.id);
const nameOf = (id: string): string => PRO_VOICES.find((v) => v.id === id)?.name ?? id;

/** What to preview: words, their face, letter height in rows, arc, colour, and where. */
export interface SeatWords {
  text: string;
  fontId: string;
  glyphRows: number;
  arcDeg: number;
  colorIndex: number;
  cx: number;
  cy: number;
  rotation: number;
}

/** One preview panel: the seats, the verdict and its fixes, and the faces strip. */
export interface SeatPanel {
  readonly root: HTMLElement;
  /** Draw it again, a beat from now (the words, the face or the spot changed). */
  refresh(): void;
}

interface PanelOpts {
  /** The words to show now, or null for nothing (no words, no text layer). */
  words(): SeatWords | null;
  /** Make the letters this many rows tall. */
  setRows(rows: number): void;
  /** Set the words in this face (the panel's picker does it, so undo and the crown follow). */
  useFont(id: string): void;
}

/** A stand's depth in rows, by tier and side, for this seat map. */
function standRows(ctx: ProToolsContext): (tier: number, side: number) => number {
  const rows = new Map<number, Set<number>>();
  const m = ctx.map;
  for (let i = 0; i < m.count; i++) {
    const k = m.tierOf[i] * 4 + standIndexOfU(m.uv[i * 2]);
    let s = rows.get(k);
    if (!s) rows.set(k, (s = new Set()));
    s.add(m.rowOf[i]);
  }
  return (tier, side) => rows.get(tier * 4 + side)?.size ?? 0;
}

/**
 * The middle of each stand (tier and side), for words with nowhere to land
 * yet: the middle of the stand nearest the middle of the view. The east
 * stand straddles the seam, so its far half counts from the near side.
 */
export function standMiddles(ctx: ProToolsContext): Map<number, { x: number; y: number }> {
  const m = ctx.map;
  const W = EDITOR_UNITS.width;
  const sum = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i < m.count; i++) {
    const side = standIndexOfU(m.uv[i * 2]);
    const k = m.tierOf[i] * 4 + side;
    let x = m.xy[i * 2];
    if (side === 0 && x > W / 2) x -= W;
    const a = sum.get(k) ?? { x: 0, y: 0, n: 0 };
    a.x += x;
    a.y += m.xy[i * 2 + 1];
    a.n++;
    sum.set(k, a);
  }
  const out = new Map<number, { x: number; y: number }>();
  for (const [k, a] of sum) out.set(k, { x: (a.x / a.n + W) % W, y: a.y / a.n });
  return out;
}

/** The seat nearest an editor point: its tier and side. */
export function seatNear(ctx: ProToolsContext, x: number, y: number): { tier: number; side: number } | null {
  const m = ctx.map;
  const W = EDITOR_UNITS.width;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < m.count; i++) {
    let dx = Math.abs(m.xy[i * 2] - x);
    if (dx > W / 2) dx = W - dx;
    const dy = m.xy[i * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best < 0 ? null : { tier: m.tierOf[best], side: standIndexOfU(m.uv[best * 2]) };
}

/** A layer for these words, sized the way the Text tool sizes one (toolbar placeTextAt). */
function layerFor(w: SeatWords): TextObject | null {
  const css = fontCssOf(w.fontId);
  const r = renderTextCanvas(w.text, css, w.arcDeg);
  if (!r) return null;
  const scale = (w.glyphRows * EDITOR_UNITS.rowPx) / r.glyphHeight;
  return {
    id: 'qf-preview', kind: 'text', cx: w.cx, cy: w.cy, rotation: w.rotation,
    width: r.canvas.width * scale, height: r.canvas.height * scale,
    colorIndex: w.colorIndex, tier: null, text: w.text, fontCss: css, fontId: w.fontId,
    arcDeg: w.arcDeg, heightSeats: w.glyphRows,
  };
}

/** A token's colour from the page, for drawing on a canvas. */
function token(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Draw a layer on the seats into `canvas` (CSS size `cssW` x `cssH`): the
 * seats round it in the design's colours, its own seats in its colour, no
 * seat (an aisle, a gangway) as the panel's ground.
 */
function drawOnSeats(ctx: ProToolsContext, canvas: HTMLCanvasElement, o: TextObject, cssW: number, cssH: number, ground: string): number {
  const palette = ctx.store.palette;
  ensureGrid(o, palette);
  const W = EDITOR_UNITS.width;
  const st = stampObject(ctx.map, o, o.grid ?? null, null, W, null, null);
  const mark = new Map<number, number>();
  for (let j = 0; j < st.seats.length; j++) mark.set(st.seats[j], st.vals[j]);
  // The layer's box, turned, and a margin of 3 rows and 8 seats.
  const a = (o.rotation * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(a)) * o.width + Math.abs(Math.sin(a)) * o.height) / 2 + 8 * EDITOR_UNITS.colPx;
  const hh = (Math.abs(Math.sin(a)) * o.width + Math.abs(Math.cos(a)) * o.height) / 2 + 3 * EDITOR_UNITS.rowPx;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const k = Math.min((cssW * dpr) / (2 * hw), (cssH * dpr) / (2 * hh));
  canvas.width = Math.max(1, Math.round(2 * hw * k));
  canvas.height = Math.max(1, Math.round(2 * hh * k));
  // Shown at the size it was drawn for, never wider than its box.
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = 'auto';
  const g = canvas.getContext('2d');
  if (!g) return st.seats.length;
  g.fillStyle = ground;
  g.fillRect(0, 0, canvas.width, canvas.height);
  const m = ctx.map;
  const cells = ctx.store.cells;
  // A seat is 3.2 x 8 units; a hair of the ground between seats once they are big enough to show it.
  const gap = k >= 0.9 ? Math.min(1, k * 0.4) : 0;
  const sw = Math.max(0.6, EDITOR_UNITS.colPx * k - gap);
  const sh = Math.max(0.6, EDITOR_UNITS.rowPx * k - gap);
  for (let i = 0; i < m.count; i++) {
    let dx = m.xy[i * 2] - o.cx;
    if (dx > W / 2) dx -= W;
    else if (dx < -W / 2) dx += W;
    const dy = m.xy[i * 2 + 1] - o.cy;
    if (dx < -hw || dx > hw || dy < -hh || dy > hh) continue;
    const v = mark.get(i);
    g.fillStyle = palette[v ?? cells[i]] ?? palette[0];
    g.fillRect((dx + hw) * k - sw / 2, (dy + hh) * k - sh / 2, sw, sh);
  }
  return st.seats.length;
}

/** Build a panel. `where` is put before or after the element given. */
export function seatPanel(ctx: ProToolsContext, opts: PanelOpts, place: (root: HTMLElement) => void): SeatPanel {
  const rows = standRows(ctx);
  const root = document.createElement('div');
  root.className = 'qf-seat';
  root.dataset.k = 'qf-seat';
  const head = document.createElement('div');
  head.className = 'qf-head';
  const title = document.createElement('span');
  title.className = 'qf-title';
  const where = document.createElement('span');
  where.className = 'qf-where';
  head.append(title, where);
  const view = document.createElement('canvas');
  view.className = 'qf-view';
  view.setAttribute('role', 'img');
  const verdict = document.createElement('div');
  verdict.className = 'qf-verdict';
  verdict.setAttribute('aria-live', 'polite');
  const say = document.createElement('span');
  say.className = 'qf-say';
  const fixes = document.createElement('span');
  fixes.className = 'qf-fixes';
  verdict.append(say, fixes);
  const allHead = document.createElement('div');
  allHead.className = 'qf-allhead';
  const tiles = document.createElement('div');
  tiles.className = 'qf-tiles';
  const main = document.createElement('div');
  main.className = 'qf-main';
  main.append(head, view, verdict);
  const all = document.createElement('div');
  all.className = 'qf-all';
  all.append(allHead, tiles);
  root.append(main, all);
  place(root);

  const tileFor = new Map<string, { btn: HTMLButtonElement; canvas: HTMLCanvasElement; name: HTMLSpanElement }>();
  for (const id of SEAT_VOICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qf-tile';
    btn.dataset.font = id;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'qf-tile-name';
    name.textContent = nameOf(id);
    btn.append(canvas, name);
    btn.addEventListener('click', () => opts.useFont(id));
    tiles.appendChild(btn);
    tileFor.set(id, { btn, canvas, name });
  }

  const paintWords = (): void => {
    title.textContent = t('qf.seat.title');
    view.setAttribute('aria-label', t('qf.seat.aria'));
    allHead.textContent = t('qf.all');
  };
  paintWords();

  let faces: Promise<void> | null = null;
  let timer = 0;
  let last = '';
  const draw = async (): Promise<void> => {
    timer = 0;
    // Nothing to show (another tool, a banner, a picture selected): the
    // panel folds away, and is drawn again when there is.
    const w = root.isConnected ? opts.words() : null;
    root.classList.toggle('qf-empty', !w);
    if (!w) { last = ''; return; }
    faces ??= Promise.all([loadTifoFonts(), loadProFonts()]).then(() => undefined);
    await faces;
    const key = JSON.stringify([w, ctx.store.palette, document.documentElement.lang]);
    if (key === last) return;
    last = key;
    const ground = token(root, '--ink-0', '#0d1016');
    const o = layerFor(w);
    if (!o) return;
    drawOnSeats(ctx, view, o, Math.max(200, Math.min(560, root.clientWidth || 320)), 132, ground);
    const near = seatNear(ctx, w.cx, w.cy);
    const deep = near ? rows(near.tier, near.side) : 0;
    where.textContent = deep ? tv('qf.seat.where', { rows: deep, h: Math.round(w.glyphRows) }) : '';
    showVerdict(w, deep);
    for (const id of SEAT_VOICES) {
      const tile = tileFor.get(id)!;
      const to = layerFor({ ...w, fontId: id });
      if (!to) continue;
      drawOnSeats(ctx, tile.canvas, to, 120, 40, ground);
      const v = seatVerdict(id, w.text, w.glyphRows, deep, SEAT_VOICES);
      const no = !!v && (v.state === 'small' || v.state === 'shallow');
      tile.btn.classList.toggle('no', no);
      tile.btn.setAttribute('aria-pressed', String(id === w.fontId));
      tile.btn.setAttribute('aria-label', tv(no ? 'qf.tile.no' : 'qf.tile.ok', { font: nameOf(id) }));
    }
  };

  const fixBtn = (label: string, run: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qf-fix';
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  };

  const showVerdict = (w: SeatWords, deep: number): void => {
    fixes.textContent = '';
    const v: SeatVerdict | null = isProVoice(w.fontId)
      ? seatVerdict(w.fontId, w.text, w.glyphRows, deep, SEAT_VOICES, seatsVoice(w.fontId))
      : null;
    verdict.hidden = !v;
    root.dataset.state = v?.state ?? '';
    if (!v) return;
    const font = nameOf(w.fontId);
    switch (v.state) {
      case 'reads': say.textContent = t('qf.v.reads'); break;
      case 'thickened': say.textContent = t('qf.v.thickened'); break;
      case 'small':
        say.textContent = tv('qf.v.small', { font, n: v.needRows });
        fixes.append(fixBtn(tv('qf.fix.taller', { n: v.needRows }), () => opts.setRows(v.needRows)));
        break;
      case 'shallow': say.textContent = tv('qf.v.shallow', { font, rows: deep, n: v.needRows }); break;
      case 'banner': say.textContent = tv('qf.v.banner', { font }); break;
    }
    // A banners-only face's own stand-in first: the seat face nearest it in spirit.
    const instead = v.state === 'banner' ? PRO_VOICES.find((x) => x.id === w.fontId)?.instead ?? v.tryFont : v.tryFont;
    if (instead && v.state !== 'reads' && v.state !== 'thickened') {
      const id = instead;
      fixes.append(fixBtn(tv('qf.fix.use', { font: nameOf(id) }), () => opts.useFont(id)));
    }
  };

  const refresh = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void draw(), 140);
  };
  onLangChange(() => {
    paintWords();
    last = '';
    refresh();
  });
  return { root, refresh };
}
