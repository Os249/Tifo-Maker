import { t } from './i18n';

/**
 * Phone editor shell.
 *
 * The desktop editor is a three-column layout: a 14-button tool rail, a canvas,
 * and a 312px properties panel. Dropped into 360px the rail became a 752px row
 * with `overflow-x:auto` and no affordance, so eight tools — Shapes, Pan,
 * Select, Banner Studio, Stadium, AI, Animation and Save — sat past the right
 * edge where nobody found them. The image-import bar was worse at 1270px, with
 * "Place" at x=708 and "Cancel" at x=1173: a user who picked a photo had no
 * reachable way to place it or back out, which is exactly the "adding an image
 * hangs" report we got.
 *
 * This does not re-implement the editor. It is a presentation layer: it builds
 * a five-tab ribbon and a set of bottom sheets, and drives the SAME controls the
 * desktop UI uses by proxying clicks to them. One engine, one set of panel
 * sections, a front end that fits a thumb.
 *
 * Layout (see the sheet CSS in floodlight.css):
 *
 *   top bar         title · undo · redo · save
 *   canvas          everything else floats over it
 *     view pill     2D / 3D          (Split is dropped: two 180px panes is
 *                                     worse than useless on a phone)
 *     stand chips   All · N · E · S · W  ← the "how do I get behind the goal"
 *     zoom pill     − % + fit
 *   ribbon          Paint · Colours · Add · AI · More
 *
 * Sheets cap at 60dvh so the canvas stays visible while you change a setting —
 * NN/g's guidance for non-modal sheets — and every sheet carries a real close
 * button, not just a drag handle.
 */

/**
 * Everything narrower than a comfortable desktop gets this shell.
 *
 * 899, not 767: measured at 768x1024 (iPad portrait) and 844x390 (a phone in
 * landscape) the desktop three-column layout overflows horizontally and pushes
 * the sign-in button off the top edge. Those widths used to be hidden behind
 * the desktop-only gate; now that phones are let in, the shell has to cover the
 * whole band the desktop layout cannot serve.
 */
export const PHONE_MAX = 899;

type TabId = 'paint' | 'colors' | 'add' | 'ai' | 'more';

interface Tab {
  id: TabId;
  icon: string;
  labelKey: string;
}

const TABS: Tab[] = [
  { id: 'paint', icon: 'ti-brush', labelKey: 'mb.paint' },
  { id: 'colors', icon: 'ti-palette', labelKey: 'ed.colors' },
  { id: 'add', icon: 'ti-plus', labelKey: 'mb.add' },
  { id: 'ai', icon: 'ti-sparkles', labelKey: 'mb.ai' },
  { id: 'more', icon: 'ti-dots', labelKey: 'mb.more' },
];

/** Tools that belong in the Paint sheet, in the order a thumb wants them. */
const PAINT_TOOLS = [
  { tool: 'brush', icon: 'ti-brush', key: 'ed.brush' },
  { tool: 'fill', icon: 'ti-bucket-droplet', key: 'ed.tool.fill' },
  { tool: 'eraser', icon: 'ti-eraser', key: 'ed.tool.eraser' },
  { tool: 'eyedropper', icon: 'ti-color-picker', key: 'ed.tool.eyedrop' },
  { tool: 'select', icon: 'ti-pointer', key: 'ed.tool.select' },
  { tool: 'pan', icon: 'ti-arrows-move', key: 'ed.tool.pan' },
];

/** Tools that ADD something to the design. */
const ADD_TOOLS = [
  { tool: 'text', icon: 'ti-typography', key: 'ed.tool.text' },
  { tool: 'import', icon: 'ti-photo', key: 'ed.tool.import' },
  { tool: 'shape', icon: 'ti-shape', key: 'ed.tool.shapes' },
];

const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

/** Click a control that exists but is not visible in this layout. */
const proxy = (sel: string): void => {
  const target = document.querySelector<HTMLElement>(sel);
  target?.click();
};

export interface MobileShell {
  /** Re-read state the editor owns (active tool, zoom) into the ribbon. */
  sync(): void;
  destroy(): void;
}

export function mountMobileShell(): MobileShell | null {
  if (!window.matchMedia(`(max-width: ${PHONE_MAX}px)`).matches) return null;
  document.body.classList.add('m-shell');

  const stage = document.querySelector<HTMLElement>('.stage');
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!stage || !workspace) return null;

  // ---------- sheet ----------
  const scrim = el('div', 'm-scrim');
  const sheet = el('div', 'm-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'false'); // non-modal: the canvas stays live
  const grab = el('div', 'm-grab');
  const head = el('div', 'm-sheet-head');
  const title = el('h2', 'm-sheet-title');
  const closeBtn = el('button', 'm-sheet-x', '<i class="ti ti-x" aria-hidden="true"></i>') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('common.close'));
  head.append(title, closeBtn);
  const bodyEl = el('div', 'm-sheet-body');
  sheet.append(grab, head, bodyEl);
  document.body.append(scrim, sheet);

  let openTab: TabId | null = null;

  const closeSheet = (): void => {
    openTab = null;
    sheet.classList.remove('open');
    scrim.classList.remove('show');
    for (const b of ribbonBtns) b.classList.remove('active');
    // Hand the panel back to whatever the desktop code expects.
    document.getElementById('panel')?.classList.remove('open');
  };

  closeBtn.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  // Back button dismisses, per NN/g: a sheet that swallows Back breaks the page.
  window.addEventListener('popstate', () => { if (openTab) closeSheet(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openTab) closeSheet(); });

  // Drag the grab handle (or the header) down to dismiss.
  let dragY: number | null = null;
  const onDragStart = (e: PointerEvent): void => {
    dragY = e.clientY;
    sheet.style.transition = 'none';
  };
  const onDragMove = (e: PointerEvent): void => {
    if (dragY === null) return;
    const dy = Math.max(0, e.clientY - dragY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const onDragEnd = (e: PointerEvent): void => {
    if (dragY === null) return;
    const dy = Math.max(0, e.clientY - dragY);
    dragY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 70) closeSheet();
  };
  for (const handle of [grab, head]) {
    handle.addEventListener('pointerdown', onDragStart as EventListener);
  }
  window.addEventListener('pointermove', onDragMove as EventListener);
  window.addEventListener('pointerup', onDragEnd as EventListener);
  window.addEventListener('pointercancel', onDragEnd as EventListener);

  // ---------- sheet contents ----------
  /** Move a live panel section into the sheet, and put it back on close. */
  const homes = new Map<string, { parent: Node; next: Node | null }>();
  const lend = (id: string): HTMLElement | null => {
    const node = document.getElementById(id);
    if (!node) return null;
    if (!homes.has(id)) homes.set(id, { parent: node.parentNode!, next: node.nextSibling });
    node.classList.remove('ctx-hidden');
    node.hidden = false;
    bodyEl.appendChild(node);
    return node;
  };
  const returnAll = (): void => {
    for (const [id, home] of homes) {
      const node = document.getElementById(id);
      if (node && node.parentNode === bodyEl) home.parent.insertBefore(node, home.next);
    }
  };

  const toolGrid = (tools: typeof PAINT_TOOLS): HTMLElement => {
    const grid = el('div', 'm-tools');
    for (const spec of tools) {
      const b = el('button', 'm-tool') as HTMLButtonElement;
      b.type = 'button';
      b.dataset.tool = spec.tool;
      b.innerHTML = `<i class="ti ${spec.icon}" aria-hidden="true"></i><span>${t(spec.key)}</span>`;
      b.addEventListener('click', () => {
        proxy(`.tool-rail [data-tool="${spec.tool}"]`);
        for (const o of grid.querySelectorAll('.m-tool')) o.classList.remove('on');
        b.classList.add('on');
        sync();
        // Adding something needs its own bar, which we surface as a sheet.
        if (spec.tool === 'text' || spec.tool === 'shape') showToolBar(spec.tool);
        else if (spec.tool === 'import') closeSheet();
      });
      grid.appendChild(b);
    }
    return grid;
  };

  /** The text / shape / import option rows are desktop-width; host them here. */
  const showToolBar = (tool: string): void => {
    const barId = tool === 'text' ? 'text-bar' : tool === 'shape' ? 'shape-bar' : 'import-bar';
    bodyEl.textContent = '';
    title.textContent = t(tool === 'text' ? 'ed.tool.text' : tool === 'shape' ? 'ed.shape' : 'ed.tool.import');
    lend(barId);
    open('add');
  };

  const buildPaint = (): void => {
    title.textContent = t('mb.paint');
    bodyEl.textContent = '';
    bodyEl.appendChild(toolGrid(PAINT_TOOLS));
    lend('ctx-brush');
    lend('ctx-objects');
  };
  const buildColors = (): void => {
    title.textContent = t('ed.colors');
    bodyEl.textContent = '';
    lend('ctx-colors');
  };
  const buildAdd = (): void => {
    title.textContent = t('mb.add');
    bodyEl.textContent = '';
    bodyEl.appendChild(toolGrid(ADD_TOOLS));
    const banner = el('button', 'm-wide') as HTMLButtonElement;
    banner.type = 'button';
    banner.innerHTML = `<i class="ti ti-flag" aria-hidden="true"></i> ${t('ed.bannerStudio')}`;
    banner.addEventListener('click', () => { closeSheet(); proxy('#banner-studio-btn'); });
    bodyEl.appendChild(banner);
  };
  const buildAi = (): void => {
    title.textContent = t('mb.ai');
    bodyEl.textContent = '';
    lend('ctx-ai');
  };
  const buildMore = (): void => {
    title.textContent = t('mb.more');
    bodyEl.textContent = '';
    const grid = el('div', 'm-tools');
    for (const [icon, key, sel] of [
      ['ti-building-stadium', 'ed.rail.stadiumT', '#rail-stadium'],
      ['ti-movie', 'ed.rail.animT', '#rail-anim'],
      ['ti-device-floppy', 'ed.rail.saveT', '#rail-save'],
      ['ti-photo', 'ed.gallery', '#gallery'],
    ] as [string, string, string][]) {
      const b = el('button', 'm-tool') as HTMLButtonElement;
      b.type = 'button';
      b.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i><span>${t(key)}</span>`;
      b.addEventListener('click', () => {
        // These open desktop panel modes; let them, then host the result here.
        proxy(sel);
        const id = sel === '#rail-stadium' ? 'ctx-stadium-config'
          : sel === '#rail-anim' ? 'ctx-reveal'
            : sel === '#rail-save' ? 'ctx-save' : null;
        if (!id) { closeSheet(); return; }
        title.textContent = t(key);
        bodyEl.textContent = '';
        lend(id);
        if (sel === '#rail-save') { lend('ctx-production'); lend('ctx-history'); }
        if (sel === '#rail-anim') lend('ctx-stadium-export');
      });
      grid.appendChild(b);
    }
    bodyEl.appendChild(grid);
    lend('ctx-stadium');
  };

  const BUILD: Record<TabId, () => void> = {
    paint: buildPaint, colors: buildColors, add: buildAdd, ai: buildAi, more: buildMore,
  };

  function open(tab: TabId): void {
    returnAll();
    if (openTab === tab) { closeSheet(); return; }
    openTab = tab;
    BUILD[tab]();
    sheet.classList.add('open');
    scrim.classList.add('show');
    for (const b of ribbonBtns) b.classList.toggle('active', b.dataset.tab === tab);
    bodyEl.scrollTop = 0;
    sync(); // mark whichever tool is already active, not just after a tap
  }

  // ---------- ribbon ----------
  const ribbon = el('nav', 'm-ribbon');
  ribbon.setAttribute('aria-label', t('ed.a11y.tools'));
  const ribbonBtns: HTMLButtonElement[] = [];
  for (const tab of TABS) {
    const b = el('button', 'm-tab') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.tab = tab.id;
    b.innerHTML = `<i class="ti ${tab.icon}" aria-hidden="true"></i><span>${t(tab.labelKey)}</span>`;
    b.addEventListener('click', () => open(tab.id));
    ribbon.appendChild(b);
    ribbonBtns.push(b);
  }
  document.body.appendChild(ribbon);

  // ---------- canvas overlays ----------
  // View switcher. Split is deliberately absent: two ~180px panes on a phone
  // shows neither the design nor the stadium.
  const viewPill = el('div', 'm-view');
  const mk2d = el('button', 'm-view-b on', `<i class="ti ti-layout-grid" aria-hidden="true"></i> ${t('ed.view.design')}`) as HTMLButtonElement;
  const mk3d = el('button', 'm-view-b', `<i class="ti ti-building-stadium" aria-hidden="true"></i> ${t('ed.view.stadium')}`) as HTMLButtonElement;
  mk2d.type = 'button'; mk3d.type = 'button';
  mk2d.addEventListener('click', () => { proxy('#view-2d'); mk2d.classList.add('on'); mk3d.classList.remove('on'); });
  mk3d.addEventListener('click', () => { proxy('#view-3d'); mk3d.classList.add('on'); mk2d.classList.remove('on'); });
  viewPill.append(mk2d, mk3d);
  stage.appendChild(viewPill);

  // Stand chips — the direct answer to "I want to design behind the goal and I
  // cannot get there". #section-nav does exactly this and was display:none.
  const stands = el('div', 'm-stands');
  stands.setAttribute('role', 'group');
  stands.setAttribute('aria-label', t('mb.jump'));
  const STANDS: [string, string][] = [
    ['all', 'mb.all'], ['north', 'dir.north'], ['east', 'dir.east'],
    ['south', 'dir.south'], ['west', 'dir.west'],
  ];
  let onStand = 'all';
  const standBtns: HTMLButtonElement[] = [];
  for (const [id, key] of STANDS) {
    const b = el('button', 'm-stand' + (id === 'all' ? ' on' : '')) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.stand = id;
    b.textContent = t(key);
    b.addEventListener('click', () => {
      onStand = id;
      for (const o of standBtns) o.classList.toggle('on', o === b);
      if (id === 'all') { proxy('#fit'); return; }
      // #section-nav holds one cell per section, grouped by stand. Jump to the
      // middle section of that stand: it is the one a tifo is centred on.
      const groups = document.querySelectorAll('#section-nav .section-stand');
      const order = ['north', 'east', 'south', 'west'];
      const g = groups[order.indexOf(id)] as HTMLElement | undefined;
      const cells = g?.querySelectorAll<HTMLButtonElement>('.section-cell');
      if (cells && cells.length) cells[Math.floor(cells.length / 2)].click();
    });
    stands.appendChild(b);
    standBtns.push(b);
  }
  stage.appendChild(stands);

  // ---------- top bar: undo / redo where a thumb can reach them ----------
  const topRight = document.querySelector('.topbar-right');
  const histWrap = el('div', 'm-hist');
  for (const [icon, sel, key] of [
    ['ti-arrow-back-up', '#undo', 'ed.undo'],
    ['ti-arrow-forward-up', '#redo', 'ed.redo'],
  ] as [string, string, string][]) {
    const b = el('button', 'm-hist-b', `<i class="ti ${icon}" aria-hidden="true"></i>`) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-label', t(key));
    b.addEventListener('click', () => proxy(sel));
    histWrap.appendChild(b);
  }
  topRight?.insertBefore(histWrap, topRight.firstChild);

  // The header only fits one row once the standalone language and sign-up
  // buttons move into the avatar menu, where Gallery and Community already
  // live. Both remain one tap away; the header gains ~53px for the canvas.
  document.getElementById('menu-signup')?.addEventListener('click', () => proxy('#signin'));
  document.getElementById('menu-lang')?.addEventListener('click', () => proxy('#lang-toggle'));

  // ---------- sync ----------
  function sync(): void {
    const active = document.querySelector('.tool-rail .tool.active') as HTMLElement | null;
    const tool = active?.dataset.tool;
    for (const b of sheet.querySelectorAll<HTMLElement>('.m-tool[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === tool);
    }
  }
  const zoomObserver = new MutationObserver(() => {
    // Any canvas navigation that is not a stand jump drops the chip highlight.
    if (onStand !== 'all') return;
    for (const o of standBtns) o.classList.toggle('on', o.dataset.stand === 'all');
  });
  const zoomEl = document.getElementById('zoom-level');
  if (zoomEl) zoomObserver.observe(zoomEl, { childList: true, characterData: true, subtree: true });

  return {
    sync,
    destroy(): void {
      returnAll();
      zoomObserver.disconnect();
      document.body.classList.remove('m-shell');
      ribbon.remove(); sheet.remove(); scrim.remove(); viewPill.remove(); stands.remove(); histWrap.remove();
    },
  };
}
