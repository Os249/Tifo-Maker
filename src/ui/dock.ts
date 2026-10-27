/**
 * The seat strip as a dock under the stadium (Direction A, October 2026).
 *
 * Split shows the stadium on top and the strip under it. The split used to be
 * fixed at 58/42, so on a laptop the strip was a band about 300 px tall and the
 * only way to give it more room was to leave Split for Design. Now the line
 * between them is a handle: drag it (or focus it and use the arrow keys) to
 * give the strip more or less of the screen. The browser keeps the height.
 *
 * Only the layout changes here. The 2D editor and the 3D view each watch their
 * own host and resize themselves; when a drag ends, `onSettled` re-frames the
 * strip (the stand that is picked, or the whole bowl).
 */

const KEY = 'tifo_dock_v1';
/** The strip's share of the canvas, in percent. */
const MIN = 22;
const MAX = 78;
const DEFAULT = 42;
const STEP = 4;

function readDock(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN && v <= MAX ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function saveDock(v: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(v)));
  } catch {
    /* storage off: the height lasts until the page closes */
  }
}

export interface DockDeps {
  /** The canvas area: the stadium and the strip are its children. */
  wrap: HTMLElement;
  /** The handle between them (index.html, #dock-handle). */
  handle: HTMLElement;
  /** Called once a resize has finished, to re-frame the strip. */
  onSettled: () => void;
  /** The handle's spoken name, in the page's language. */
  label: () => string;
}

export function mountDock(deps: DockDeps): { set(v: number): void; get(): number } {
  const { wrap, handle } = deps;
  let dock = readDock();
  const apply = (v: number): void => {
    dock = Math.min(MAX, Math.max(MIN, v));
    wrap.style.setProperty('--dock', String(dock));
    handle.setAttribute('aria-valuenow', String(Math.round(dock)));
  };
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-valuemin', String(MIN));
  handle.setAttribute('aria-valuemax', String(MAX));
  handle.setAttribute('aria-label', deps.label());
  handle.tabIndex = 0;
  apply(dock);

  let settleTimer = 0;
  const settle = (): void => {
    window.clearTimeout(settleTimer);
    // After the hosts have taken their new size (their ResizeObservers run
    // after layout), not on top of it.
    settleTimer = window.setTimeout(() => requestAnimationFrame(deps.onSettled), 60);
  };

  let dragging: { id: number; top: number; height: number } | null = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    dragging = { id: e.pointerId, top: r.top, height: r.height };
    handle.setPointerCapture(e.pointerId);
    wrap.classList.add('docking');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const fromBottom = dragging.top + dragging.height - e.clientY;
    apply((fromBottom / dragging.height) * 100);
  });
  const end = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging = null;
    wrap.classList.remove('docking');
    saveDock(dock);
    settle();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Double-click puts it back where it started.
  handle.addEventListener('dblclick', () => {
    apply(DEFAULT);
    saveDock(dock);
    settle();
  });
  handle.addEventListener('keydown', (e) => {
    const k = e.key;
    let v: number | null = null;
    if (k === 'ArrowUp') v = dock + STEP;
    else if (k === 'ArrowDown') v = dock - STEP;
    else if (k === 'Home') v = MIN;
    else if (k === 'End') v = MAX;
    if (v === null) return;
    e.preventDefault();
    apply(v);
    saveDock(dock);
    settle();
  });
  return { set: (v) => { apply(v); saveDock(dock); settle(); }, get: () => dock };
}
