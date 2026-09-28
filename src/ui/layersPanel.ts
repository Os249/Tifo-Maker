import type { Editor } from '../render/editor';
import type { DesignStore } from '../core/design';
import type { Composer } from '../core/composer';
import { MAX_PICTURES, type ObjectLayer, type TifoObject } from '../core/objects';
import { objectValueAt } from '../core/layers';
import { t, tv, onLangChange, getLang } from './i18n';

/**
 * The Layers list.
 *
 * Every text, picture and shape is a layer of its own, above the paint, for
 * the life of the project — nobody has to make layers or choose one before
 * painting. This list is the stack as it is: the top row is in front, Paint is
 * always the bottom row, and banners (which hang on the stadium rather than
 * sitting on its seats) have a row of their own that opens Banner Studio.
 *
 * What it follows, from the tools people already know (Figma, Canva,
 * Procreate): the list and the canvas select together; a name is renamed by
 * double-clicking it; rows are reordered by dragging, with a line showing
 * exactly where the row will land — drawn from the same calculation that does
 * the drop, so the two can never disagree; the eye and the lock show on hover
 * with a mouse, always on touch, and always when they are ON, so a hidden or
 * locked layer is never a mystery.
 */

export interface LayersPanelDeps {
  objects: ObjectLayer;
  composer: Composer;
  store: DesignStore;
  editor: Editor;
  list: HTMLElement;
  empty: HTMLElement;
  tag: HTMLElement;
  bannerCount: () => number;
  onOpenBanners: () => void;
  /** A row was picked: select it on the canvas (the toolbar switches to Select). */
  onPick: (id: string) => void;
  /** Merge one layer into the paint (the toolbar reports it). */
  onMerge: (id: string) => void;
}

export interface LayersPanel {
  render(): void;
  startRename(id: string): void;
}

/** What a layer is called in the list: the name it was given, or what it is. */
export function layerName(o: TifoObject): string {
  if (o.label) return o.label;
  switch (o.kind) {
    case 'text': {
      const words = o.text.trim() || t('ly.kind.text');
      return getLang() === 'ar' ? `«${words}»` : `“${words}”`;
    }
    case 'image':
      return o.name === 'AI image' ? t('ly.kind.ai') : o.name.replace(/\.(png|jpe?g|webp|gif|svg|heic|avif|bmp)$/i, '') || t('ly.kind.image');
    case 'shape': {
      const key = `shape.${o.shape}`;
      const name = t(key);
      return name === key ? o.shape : name;
    }
    case 'cells':
      return t('ly.kind.cells');
  }
}

/** The second line: what it is, and anything about it worth knowing at a glance. */
export function layerDetail(o: TifoObject): string {
  const parts: string[] = [];
  parts.push(
    o.kind === 'text' ? t('ly.kind.text')
      : o.kind === 'image' ? (o.name === 'AI image' ? t('ly.kind.ai') : t('ly.kind.image'))
        : o.kind === 'shape' ? t('ly.kind.shape')
          : t('ly.kind.cells'),
  );
  if (o.keep && o.keep.stand !== 'all') parts.push(tv('ly.detail.keep', { stand: t(`dir.${o.keep.stand}`) }));
  else if (o.keep?.stands?.length) parts.push(t('ly.detail.keepArea'));
  if (o.tier === 0) parts.push(t('ly.detail.lower'));
  if (o.tier === 1) parts.push(t('ly.detail.upper'));
  if (o.touch) parts.push(t('ly.detail.touched'));
  if (Math.round(o.rotation) !== 0) parts.push(`${Math.round(o.rotation)}°`);
  return parts.join(' · ');
}

export function mountLayersPanel(deps: LayersPanelDeps): LayersPanel {
  const { objects, store, editor, list, empty, tag } = deps;
  let renaming: string | null = null;
  let menu: HTMLElement | null = null;

  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
  };

  /** A tiny picture of the layer, drawn from its grid in the design's colours. */
  const drawThumb = (canvas: HTMLCanvasElement, o: TifoObject): void => {
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const g = o.grid ?? null;
    if (!g && !o.touch) return;
    const aspect = o.width / o.height;
    let w = W;
    let h = Math.round(W / aspect);
    if (h > H) {
      h = H;
      w = Math.max(1, Math.round(H * aspect));
    }
    const x0 = Math.floor((W - w) / 2);
    const y0 = Math.floor((H - h) / 2);
    const img = ctx.createImageData(w, h);
    const rgb = store.palette.map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = objectValueAt(g, o.touch ?? null, (x + 0.5) / w, (y + 0.5) / h);
        if (v < 0) continue;
        const c = rgb[v] ?? [128, 128, 128];
        const p = (y * w + x) * 4;
        img.data[p] = c[0];
        img.data[p + 1] = c[1];
        img.data[p + 2] = c[2];
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, x0, y0);
  };

  const icon = (name: string): string => `<i class="ti ${name}" aria-hidden="true"></i>`;

  const rowFor = (o: TifoObject): HTMLElement => {
    const sel = objects.selected?.id === o.id;
    const row = document.createElement('div');
    row.className = `ly-row${sel ? ' sel' : ''}${o.hidden ? ' is-hidden' : ''}${o.locked ? ' is-locked' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(sel));
    row.dataset.id = o.id;
    row.tabIndex = sel ? 0 : -1;

    const grip = document.createElement('span');
    grip.className = 'ly-grip';
    grip.innerHTML = icon('ti-grip-vertical');
    grip.title = t('ly.dragT');

    const thumb = document.createElement('canvas');
    thumb.className = 'ly-thumb';
    thumb.width = 40;
    thumb.height = 28;
    drawThumb(thumb, o);

    const text = document.createElement('span');
    text.className = 'ly-text';
    if (renaming === o.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ly-rename';
      input.maxLength = 60;
      input.value = o.label ?? (o.kind === 'text' ? o.text.trim() : layerName(o));
      input.setAttribute('aria-label', t('ly.renameA'));
      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        renaming = null;
        const v = input.value.trim();
        if (commit && v && v !== layerName(o)) objects.update(o.id, { label: v.slice(0, 60) });
        else render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      text.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const name = document.createElement('span');
      name.className = 'ly-name';
      name.textContent = layerName(o);
      name.title = t('ly.renameT');
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(o.id);
      });
      const sub = document.createElement('span');
      sub.className = 'ly-sub';
      sub.textContent = layerDetail(o);
      text.append(name, sub);
    }

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = `ly-tog ly-eye${o.hidden ? ' on' : ''}`;
    eye.innerHTML = icon(o.hidden ? 'ti-eye-off' : 'ti-eye');
    eye.setAttribute('aria-pressed', String(!!o.hidden));
    eye.setAttribute('aria-label', t(o.hidden ? 'ly.show' : 'ly.hide'));
    eye.title = t(o.hidden ? 'ly.showT' : 'ly.hideT');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      objects.update(o.id, { hidden: !o.hidden });
    });

    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = `ly-tog ly-lock${o.locked ? ' on' : ''}`;
    lock.innerHTML = icon(o.locked ? 'ti-lock' : 'ti-lock-open');
    lock.setAttribute('aria-pressed', String(!!o.locked));
    lock.setAttribute('aria-label', t(o.locked ? 'ly.unlock' : 'ly.lock'));
    lock.title = t(o.locked ? 'ly.unlockT' : 'ly.lockT');
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      objects.update(o.id, { locked: !o.locked });
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ly-more';
    more.innerHTML = icon('ti-dots');
    more.setAttribute('aria-label', t('ly.moreA'));
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(o, more);
    });

    for (const b of [eye, lock, more]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
    row.append(grip, thumb, text, eye, lock, more);

    row.addEventListener('click', () => {
      if (renaming) return;
      deps.onPick(o.id);
    });
    row.addEventListener('pointerenter', () => editor.objectOverlay?.setHighlight(o.id));
    row.addEventListener('pointerleave', () => editor.objectOverlay?.setHighlight(null));
    row.addEventListener('keydown', (e) => onRowKey(e, o));
    bindDrag(row, grip, o);
    return row;
  };

  const staticRow = (cls: string, iconName: string, name: string, sub: string, onClick?: () => void): HTMLElement => {
    const row = document.createElement('div');
    row.className = `ly-row ly-static ${cls}`;
    row.innerHTML = `<span class="ly-grip"></span><span class="ly-thumb ly-icon">${icon(iconName)}</span>`;
    const text = document.createElement('span');
    text.className = 'ly-text';
    const n = document.createElement('span');
    n.className = 'ly-name';
    n.textContent = name;
    const s = document.createElement('span');
    s.className = 'ly-sub';
    s.textContent = sub;
    text.append(n, s);
    row.appendChild(text);
    if (onClick) {
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.addEventListener('click', onClick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      });
      const go = document.createElement('span');
      go.className = 'ly-go';
      go.innerHTML = icon('ti-arrow-right');
      row.appendChild(go);
    } else {
      const pin = document.createElement('span');
      pin.className = 'ly-pin';
      pin.innerHTML = icon('ti-lock');
      pin.title = t('ly.paintPinnedT');
      row.appendChild(pin);
    }
    return row;
  };

  function render(): void {
    closeMenu();
    const all = objects.list();
    list.textContent = '';
    for (let k = all.length - 1; k >= 0; k--) list.appendChild(rowFor(all[k]));
    list.appendChild(staticRow('ly-paint', 'ti-brush', t('ly.paint'), t('ly.paintSub')));
    const banners = deps.bannerCount();
    list.appendChild(
      staticRow('ly-banners', 'ti-flag', t('ly.banners'), banners ? tv('ly.bannersSub', { n: banners }) : t('ly.bannersNone'), deps.onOpenBanners),
    );
    empty.hidden = all.length > 0;
    const pics = objects.pictureCount();
    tag.textContent = pics > 0 ? tv('ly.tag', { n: pics, max: MAX_PICTURES }) : all.length ? tv('ly.count', { n: all.length }) : '';
  }

  function startRename(id: string): void {
    renaming = id;
    render();
  }

  // ---- the ⋯ menu ------------------------------------------------------------

  function openMenu(o: TifoObject, anchor: HTMLElement): void {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'ly-menu';
    m.setAttribute('role', 'menu');
    const all = objects.list();
    const idx = all.findIndex((x) => x.id === o.id);
    const items: [string, string, () => void, boolean?][] = [
      ['ti-pencil', t('ly.rename'), () => startRename(o.id)],
      ['ti-copy', t('ly.duplicate'), () => objects.duplicate(o.id)],
      ['ti-stack-front', t('ly.forward'), () => objects.reorder(o.id, 'forward'), idx === all.length - 1],
      ['ti-stack-back', t('ly.backward'), () => objects.reorder(o.id, 'backward'), idx === 0],
      ['ti-arrow-bar-to-up', t('ly.toFront'), () => objects.reorder(o.id, 'front'), idx === all.length - 1],
      ['ti-arrow-bar-to-down', t('ly.toBack'), () => objects.reorder(o.id, 'back'), idx === 0],
      ['ti-arrow-merge', t('ly.merge'), () => deps.onMerge(o.id)],
      ['ti-trash', t('ly.delete'), () => objects.remove(o.id)],
    ];
    for (const [ic, label, run, disabled] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = ic === 'ti-trash' ? 'danger' : '';
      b.innerHTML = `${icon(ic)}<span></span>`;
      (b.lastChild as HTMLElement).textContent = label;
      b.disabled = !!disabled;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        run();
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    const rtl = document.documentElement.dir === 'rtl';
    const left = rtl ? Math.max(8, r.left) : Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    const top = r.bottom + 4 + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    menu = m;
    (m.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
    m.addEventListener('keydown', (e) => {
      const btns = [...m.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const at = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
        anchor.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        btns[(at + 1) % btns.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        btns[(at - 1 + btns.length) % btns.length]?.focus();
      }
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  });

  // ---- keyboard ----------------------------------------------------------------

  function onRowKey(e: KeyboardEvent, o: TifoObject): void {
    const rows = [...list.querySelectorAll<HTMLElement>('.ly-row[data-id]')];
    const at = rows.findIndex((r) => r.dataset.id === o.id);
    const focusRow = (i: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      deps.onPick(r.dataset.id!);
      requestAnimationFrame(() => (list.querySelector<HTMLElement>(`.ly-row[data-id="${r.dataset.id}"]`))?.focus());
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) objects.reorder(o.id, 'backward');
      else focusRow(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) objects.reorder(o.id, 'forward');
      else focusRow(at - 1);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRename(o.id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      deps.onPick(o.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      objects.remove(o.id);
    }
  }

  // ---- drag to reorder -----------------------------------------------------------

  let indicator: HTMLElement | null = null;
  function bindDrag(row: HTMLElement, grip: HTMLElement, o: TifoObject): void {
    const start = (e: PointerEvent, fromGrip: boolean): void => {
      if (e.button !== 0 || renaming) return;
      // Touch reorders from the grip only: a finger on the row scrolls the list.
      if (e.pointerType !== 'mouse' && !fromGrip) return;
      const y0 = e.clientY;
      let dragging = false;
      let target = -1;
      const rows = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.ly-row[data-id]')].filter((r) => r !== row);
      /** The list position the row would land in: the ONE calculation the line and the drop share. */
      const gapAt = (y: number): number => {
        const rs = rows();
        for (let g = 0; g < rs.length; g++) {
          const b = rs[g].getBoundingClientRect();
          if (y < b.top + b.height / 2) return g;
        }
        return rs.length;
      };
      const drawLine = (g: number): void => {
        const rs = rows();
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.className = 'ly-drop';
          list.appendChild(indicator);
        }
        const lb = list.getBoundingClientRect();
        const y = g < rs.length ? rs[g].getBoundingClientRect().top : rs[rs.length - 1].getBoundingClientRect().bottom;
        indicator.style.top = `${y - lb.top + list.scrollTop - 1}px`;
      };
      const move = (ev: PointerEvent): void => {
        if (!dragging && Math.abs(ev.clientY - y0) < 5) return;
        if (!dragging) {
          dragging = true;
          row.classList.add('dragging');
          try {
            (fromGrip ? grip : row).setPointerCapture(ev.pointerId);
          } catch {
            /* already released */
          }
        }
        ev.preventDefault();
        target = gapAt(ev.clientY);
        drawLine(target);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        indicator?.remove();
        indicator = null;
        row.classList.remove('dragging');
        if (!dragging || target < 0) return;
        // List position g (top to bottom, without this row) → stack index.
        const n = objects.list().length;
        objects.moveTo(o.id, n - 1 - target);
        // Swallow the click the pointerup is about to produce.
        const swallow = (ce: Event): void => {
          ce.stopPropagation();
          ce.preventDefault();
        };
        row.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    grip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      start(e, true);
    });
    row.addEventListener('pointerdown', (e) => start(e, false));
  }

  // Coalesced to one render a frame, and none mid-drag: a drag changes a
  // position every pointer move, and the list shows no positions.
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!renaming || !list.querySelector('.ly-rename')) render();
    });
  };
  // A new selection only moves the highlight: the rows stay, so a double-click
  // that begins by selecting a row still lands on the same row.
  const reselect = (): void => {
    const id = objects.selected?.id ?? null;
    for (const r of list.querySelectorAll<HTMLElement>('.ly-row[data-id]')) {
      const on = r.dataset.id === id;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
      r.tabIndex = on ? 0 : -1;
    }
  };
  objects.onChange((why) => {
    if (why === 'select') reselect();
    else if (!objects.live) schedule();
  });
  store.onPaletteChange(schedule);
  onLangChange(() => render());
  render();
  return { render, startRename };
}
