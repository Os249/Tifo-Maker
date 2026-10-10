import { escapeHtml } from '../core/escape';
import type { Editor } from '../render/editor';
import type { DesignStore } from '../core/design';
import type { SeatMap, ToolId } from '../core/types';
import { PALETTE_PRESETS } from '../core/template';
import { PATTERN_PRESETS } from '../core/patterns';
import {
  makeThumbnailB64,
  takeClaimIntent,
} from '../net/api';
import { renderTextCanvas, TIFO_FONTS, type RenderedText } from '../core/text';
import { loadTifoFonts } from '../core/tifoFonts';
import { MAX_PICTURES, encodePictureSrc, rememberPicture, type ObjectLayer } from '../core/objects';
import type { Composer } from '../core/composer';
import { writeLayers } from '../core/layerStore';
import { mountLayersPanel, layerName } from './layersPanel';
import { MIN_LEGIBLE_RUN, findFragileSeats } from '../core/analysis';
import { RevealPlayer, REVEAL_PRESETS, revealEndsHidden, type RevealId } from '../core/reveal';
import { drumCallBeat, DRUM_CALL_MIN_LENGTH } from '../core/drumCall';
import { DrumTrack } from '../render/drumTrack';
import { fetchMe, isSignedIn, registrationEmailWasSent, saveDesign, saveScene, setPublic, setDesignTitle, exportMyData, deleteAccount } from '../net/api';
import { t as i18nT, tErr, tl, tv } from './i18n';
import { track, setAnalyticsSignedIn } from '../net/analytics';
import { buildTifoV2 } from '../core/tifoFormat';
import {
  buildDraft, createDraftWriter,
  type DraftWriteResult,
} from '../core/draft';
import { decodeImportBitmap, extractPhotoPalette, rasterize } from '../core/importImage';
import { BANNER_HISTORY_EVENT, bannerActive, bannerHost } from './bannerHost';
import { openAuthModal } from './authModal';
import { openGallery } from './gallery';
import { mountAiPanel } from './aiPanel';
import {
  createLocal, getLocal, keysFor, makeStripDataUrl, openUrl, purgeLocal, stashNewProject,
  newProjectUrl, thumbKey, updateLocal, writeEnvelope, writeRaw, type ProjectRef,
} from '../core/projects';
import { mountStadiumPanel } from './stadiumPanel';
import { openShareModal } from './shareModal';
import { EDITOR_UNITS } from '../core/seatmap';
import { templateById } from '../core/stadiumCatalog';
import { hasBlocks, sectionInfo } from '../core/blocks';
import { drawSymbol, SHAPE_ASPECT } from '../core/symbols';
import type { Preview3D } from '../render/preview3d';
import {
  exportStadiumVideo,
  exportStadiumGif,
  previewStadium,
  videoExportSupported,
  type StadiumExportOpts,
} from '../export/stadiumExport';

/**
 * Thin DOM layer over the editor engine. Holds UI state only — the design
 * buffer and rendering live entirely in core/ and render/. When the product
 * grows real chrome (galleries, dialogs, auth) this layer is replaced by
 * React + Zustand; the engine API below stays identical.
 */

/** Brief centred confirmation for a gesture that has no button to flash. */
let gestureToastEl: HTMLElement | null = null;
let gestureToastTimer = 0;
function gestureToast(text: string): void {
  if (!gestureToastEl) {
    gestureToastEl = document.createElement('div');
    gestureToastEl.className = 'gesture-toast';
    gestureToastEl.setAttribute('role', 'status');
    document.body.appendChild(gestureToastEl);
  }
  gestureToastEl.textContent = text;
  gestureToastEl.classList.add('show');
  window.clearTimeout(gestureToastTimer);
  gestureToastTimer = window.setTimeout(() => gestureToastEl?.classList.remove('show'), 900);
}

/**
 * The project the editor has open.
 *
 * `ref` is null for a design that is not yet anyone's project here: someone
 * else's tifo opened from a share link. The first edit makes it one (see
 * ensureProject). `pending` is set while main.ts is still laying out a brand-new
 * project (starter, first-run guide) and will call createProject itself, so the
 * first edit must not race it into existence.
 */
export interface ProjectCtx {
  ref: ProjectRef | null;
  pending?: boolean;
  /** Set when the copy in this browser holds changes the account has not got. */
  unsynced?: boolean;
}

/** What main.ts may ask of the toolbar once it is up. */
export interface ToolbarApi {
  /** Bring the laid-out canvas into existence as a project, in the account or this browser. */
  createProject(opts: { title: string; origin: 'ai' | null }): Promise<ProjectRef | null>;
  /** Generate from a prompt in the AI panel; name the project from the result if `autoName`. */
  generate(prompt: string, autoName: boolean): Promise<boolean>;
  /** Open the Publish flow, as if its button had been pressed. */
  publish(): void;
  /**
   * Draw a design from a brief with the free offline designer: no account, no
   * model, no quota. The first-run "Start from your club" uses it.
   */
  quickDesign(prompt: string): Promise<boolean>;
  /** What "Post it" needs: the name to print, and the public page if there is one. */
  postTarget(): { title: string; publicId: string | null };
  /** The key this project's banners are kept under in this browser, if any. */
  bannersKey(): string | null;
}

export function mountToolbar(
  root: HTMLElement,
  editor: Editor,
  store: DesignStore,
  map: SeatMap,
  objects: ObjectLayer,
  getPreview?: () => Preview3D | null,
  /** Design id carried by a restored local draft, so saving updates the original. */
  restoredDesignId?: string | null,
  /**
   * The scene — banners — so it can travel with the design.
   *
   * Passed in rather than imported, because this module has no business
   * knowing what a banner is: it hands the snapshot to the server and hands
   * whatever comes back to whoever does.
   */
  sceneIO?: { snapshot(): unknown; restore(scene: unknown): void; onChange?(fn: () => void): void; bannerCount?(): number },
  /** Which project is open. See ProjectCtx. */
  projectCtx?: ProjectCtx,
  /** The layer stack (see core/composer.ts). */
  composer?: Composer,
): ToolbarApi {
  const $ = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el;
  };

  // Tools
  const toolButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tool]'));
  const docTitle = $('#doc-title') as unknown as HTMLInputElement;
  const textBar = $('#text-bar');
  const importBar = $('#import-bar');
  const shapeBar = $('#shape-bar');
  let pendingImport: { bitmap: ImageBitmap; name: string } | null = null;
  let onEnterMode: (tool: ToolId) => void = () => {};
  let objectPanelHook: () => void = () => {};
  // Mobile options sheet — assigned once the panel + scrim exist (see chrome below).
  let openOptionsSheet: () => void = () => {};
  let setOptionsSheet: (open: boolean) => void = () => {};

  // ---- contextual properties panel ----
  // Each .panel-section carries data-panel listing the tools it belongs to
  // ("*" = always shown). On tool change we reveal only the matching sections
  // with a quick fade, so the panel shows just what's relevant to the tool.
  const panelSections = Array.from(root.querySelectorAll<HTMLElement>('.panel-section[data-panel]'));
  const orientNote = root.querySelector<HTMLElement>('.panel-orient');
  // Panel focus mode. 'design' = the original tool-contextual behavior (unchanged).
  // 'save' / 'animation' focus the panel onto sections tagged with data-menu, so
  // the left-rail Save button and the right Animation button each open just their
  // own options. Picking any paint tool returns to 'design'.
  let panelMode: 'design' | 'save' | 'animation' | 'ai' | 'stadium' = 'design';
  const railSaveBtn = root.querySelector<HTMLButtonElement>('#rail-save');
  const animOpenBtn = root.querySelector<HTMLButtonElement>('#rail-anim');
  const aiOpenBtn = root.querySelector<HTMLButtonElement>('#rail-ai');
  const stadiumOpenBtn = root.querySelector<HTMLButtonElement>('#rail-stadium');

  const showSection = (sec: HTMLElement, show: boolean): void => {
    if (show) {
      if (sec.style.display === 'none' || sec.classList.contains('ctx-hidden')) {
        sec.classList.remove('ctx-hidden');
        sec.style.display = '';
        sec.classList.remove('ctx-fade-in');
        void sec.offsetWidth;
        sec.classList.add('ctx-fade-in');
      }
    } else {
      sec.classList.add('ctx-hidden');
      sec.style.display = 'none';
    }
  };

  const applyContextPanel = (tool: ToolId): void => {
    // Exposed for the stylesheet, which hides the seat-only sections in the
    // Banner view while the panel is showing tools rather than a menu.
    document.body.dataset.panelMode = panelMode;
    for (const sec of panelSections) {
      let show: boolean;
      if (panelMode === 'design') {
        const tools = (sec.dataset.panel ?? '').split(/\s+/);
        show = tools.includes('*') || tools.includes(tool);
      } else {
        const menus = (sec.dataset.menu ?? '').split(/\s+/);
        show = menus.includes(panelMode);
      }
      showSection(sec, show);
    }
    // Orientation note only helps in design mode for the default brush tool.
    if (orientNote) orientNote.style.display = panelMode === 'design' && tool === 'brush' ? '' : 'none';
    if (railSaveBtn) railSaveBtn.classList.toggle('menu-active', panelMode === 'save');
    if (animOpenBtn) animOpenBtn.classList.toggle('menu-active', panelMode === 'animation');
    if (aiOpenBtn) aiOpenBtn.classList.toggle('menu-active', panelMode === 'ai');
    if (stadiumOpenBtn) stadiumOpenBtn.classList.toggle('menu-active', panelMode === 'stadium');
  };

  const setPanelMode = (mode: 'design' | 'save' | 'animation' | 'ai' | 'stadium'): void => {
    panelMode = mode;
    applyContextPanel(editor.tool);
  };
  railSaveBtn?.addEventListener('click', () => { const on = panelMode !== 'save'; setPanelMode(on ? 'save' : 'design'); setOptionsSheet(on); });
  animOpenBtn?.addEventListener('click', () => { const on = panelMode !== 'animation'; setPanelMode(on ? 'animation' : 'design'); setOptionsSheet(on); });
  aiOpenBtn?.addEventListener('click', () => { const on = panelMode !== 'ai'; setPanelMode(on ? 'ai' : 'design'); setOptionsSheet(on); });
  stadiumOpenBtn?.addEventListener('click', () => { const on = panelMode !== 'stadium'; setPanelMode(on ? 'stadium' : 'design'); setOptionsSheet(on); });

  const setTool = (tool: ToolId): void => {
    editor.tool = tool;
    panelMode = 'design'; // choosing a paint tool leaves any open menu
    for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool);
    editor.app.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    textBar.hidden = tool !== 'text';
    importBar.hidden = tool !== 'import';
    shapeBar.hidden = tool !== 'shape';
    if (tool !== 'text' && tool !== 'import' && tool !== 'shape') editor.hideStampPreview();
    if (tool === 'import' && !pendingImport) fileInput.click();
    if (tool !== 'select') editor.clearSelection();
    // The Banner view borrows this rail wholesale. Every tool keeps its icon,
    // its key and its tool bar; only the surface underneath changes.
    bannerHost.current?.setTool(tool);
    applyContextPanel(tool);
    onEnterMode(tool);
    objectPanelHook();
  };
  const TOOL_OPTS = new Set<ToolId>(['brush', 'eraser', 'fill', 'text', 'shape']);
  for (const b of toolButtons)
    b.addEventListener('click', () => {
      const tool = b.dataset.tool as ToolId;
      const reTap = editor.tool === tool; // re-tapping the active tool reveals its options
      setTool(tool);
      if (reTap && TOOL_OPTS.has(tool)) openOptionsSheet();
    });
  setTool('brush');

  // ---- Swatches panel (Photoshop-style colour model) ----
  // Seats store a palette INDEX; the palette is the design's living swatch set.
  // You can pick ANY colour (auto-added as a swatch), edit a swatch in place
  // (an intentional recolour of those seats), or load a preset/uploaded palette
  // with a choice to ADD its colours or REMAP the design onto them.
  const palEl = $('#palette');
  const fgWell = $('#fg-well') as unknown as HTMLButtonElement;
  const fgHex = $('#fg-hex');
  const addBtn = $('#add-swatch') as HTMLButtonElement;
  const colorCounts = (): number[] => {
    const counts = new Array(store.palette.length).fill(0);
    for (let i = 0; i < store.cells.length; i++) counts[store.cells[i]]++;
    return counts;
  };
  /**
   * A colour that has been PICKED but not added to the palette yet.
   *
   * Picking used to add on every `input` event, and a desktop picker fires that
   * continuously while you drag — so sliding through a gradient to look at a
   * colour deposited a swatch for every shade you passed, and the palette
   * filled with things nobody chose. Picking now only previews; the "+ Color"
   * button is what commits.
   */
  let pendingHex: string | null = null;
  const fgSub = document.querySelector('#ctx-colors .fg-sub');

  const reflectFg = (): void => {
    const active = store.palette[editor.colorIndex] ?? '#000000';
    const hex = pendingHex ?? active;
    fgWell.style.background = hex;
    fgHex.textContent = hex.toLowerCase();
    // One palette per design, whichever surface is in front of you.
    bannerHost.current?.setColor(hex);
    const unsaved = pendingHex !== null && store.palette.every((c) => c.toLowerCase() !== pendingHex);
    fgWell.classList.toggle('unsaved', unsaved);
    if (fgSub) fgSub.textContent = i18nT(unsaved ? 'ed.colors.notAdded' : 'ed.colors.painting');
    addBtn?.classList.toggle('ready', unsaved);
  };
  const renderPalette = (): void => {
    palEl.innerHTML = '';
    const counts = colorCounts();
    store.palette.forEach((hex, idx) => {
      if (idx === 0) return; // index 0 = empty seat = eraser
      const cell = document.createElement('div');
      cell.className = 'swatch-cell';
      const b = document.createElement('button');
      b.className = 'swatch' + (idx === editor.colorIndex ? ' active' : '');
      b.style.background = hex;
      b.title = `${hex} · ${counts[idx].toLocaleString()} ${i18nT('ed.seats')} · ${i18nT('ed.colors.editT')}`;
      b.setAttribute('aria-label', `${i18nT('ed.colors.swatch')} ${hex}, ${counts[idx].toLocaleString()} ${i18nT('ed.seats')}`);
      b.addEventListener('click', () => {
        editor.colorIndex = idx;
        pendingHex = null; // choosing a swatch settles it; nothing is pending
        if (editor.tool === 'eraser') setTool('brush');
        editor.refreshStampPreviewTint();
        renderPalette();
        reflectFg();
      });
      b.addEventListener('dblclick', () => openColorEditor(idx, b));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); openColorEditor(idx, b); });
      // Press and hold. A swatch could only be edited by double-clicking it and
      // only removed by right-clicking it, so on a phone a palette was
      // add-only: no second tap gesture, no right button. Hold is the gesture
      // touch already uses for "more about this thing".
      let holdTimer: number | undefined;
      const cancelHold = (): void => { window.clearTimeout(holdTimer); holdTimer = undefined; };
      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return; // mouse has dblclick and right-click
        cancelHold();
        holdTimer = window.setTimeout(() => { holdTimer = undefined; openColorEditor(idx, b); }, 450);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointermove', 'pointerleave'] as const) {
        b.addEventListener(ev, cancelHold);
      }
      const tally = document.createElement('span');
      tally.className = 'swatch-count';
      tally.textContent = counts[idx] >= 1000 ? `${(counts[idx] / 1000).toFixed(1)}k` : String(counts[idx]);
      cell.append(b, tally);
      palEl.appendChild(cell);
    });
  };
  renderPalette();
  reflectFg();
  editor.onColorPick = (idx) => {
    editor.colorIndex = idx;
    editor.refreshStampPreviewTint();
    renderPalette();
    reflectFg();
    setTool('brush'); // pick a colour, then paint with it immediately
  };
  store.onDirty(renderPalette);
  store.onDirty(() => track('paint_first'));

  // ---- AI Tifo Designer panel (rail "sparkles" button → panelMode 'ai') ----
  // Shared repaint after a panel changes the cells/palette (2D + 3D).
  const panelRefresh = (): void => {
    editor.rebuildPalette();
    editor.repaintAll();
    renderPalette();
    reflectFg();
    try { getPreview?.()?.recolorAll(); } catch { /* preview not yet created */ }
  };

  /**
   * A project made with "Generate with AI" is named by the first design the
   * AI applies — whether that comes straight back, or after a choice card
   * (busy, out of premium) and the Quick Designer. Then it is kept.
   */
  let aiNaming: { autoName: boolean } | null = null;
  const aiPanel = mountAiPanel({
    root, store, editor, map, objects, composer, getPreview, refresh: panelRefresh,
    onApplied: (spec) => {
      if (!aiNaming) return;
      const { autoName } = aiNaming;
      aiNaming = null;
      // 'AI tifo' is what the validator puts in when the model gave no title.
      const named = spec.title?.trim();
      if (autoName && named && named !== 'AI tifo') docTitle.value = named.slice(0, 80);
      void (async () => {
        if (ref?.kind === 'account') await saveToAccount(false);
        else draftWriter.flush();
      })();
    },
  });

  // ---- Stadium panel (rail "stadium" button → panelMode 'stadium') ----
  mountStadiumPanel({ root, map, store, objects, refresh: panelRefresh });

  /**
   * Put a real <input type="color"> over a control, so the user's own tap is
   * what opens the native picker.
   *
   * This used to build a hidden input at left:-9999px and call .click() on it.
   * Desktop browsers oblige; mobile ones will not open a picker for an input
   * that is not actually on screen, so "+ Color" and the paint well did nothing
   * at all on a phone — no picker, no error, nothing. Making the input the
   * thing being tapped needs no synthetic click and no permission from the
   * browser. The button underneath keeps its own click handler as the
   * keyboard path, and is what a screen reader still announces.
   */
  const wireColorPicker = (button: HTMLElement, onChoose: (hex: string) => void): HTMLInputElement => {
    const wrap = document.createElement('span');
    wrap.className = 'color-trigger';
    button.parentNode?.insertBefore(wrap, button);
    wrap.appendChild(button);

    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'color-trigger-input';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    wrap.appendChild(input);

    // `input` fires continuously while a desktop picker is dragged. That is
    // exactly why this previews instead of committing: the drag is the user
    // looking, not choosing.
    const choose = (): void => onChoose(input.value.toLowerCase());
    input.addEventListener('input', choose);
    input.addEventListener('change', choose);

    button.addEventListener('click', () => {
      input.value = /^#[0-9a-fA-F]{6}$/.test(pendingHex ?? store.palette[editor.colorIndex] ?? '')
        ? (pendingHex ?? store.palette[editor.colorIndex])
        : '#1c6fe0';
      input.click(); // keyboard: Enter on the button still opens the picker
    });
    return input;
  };

  const addAndSelect = (hex: string): void => {
    const idx = store.addSwatch(hex);
    editor.colorIndex = idx;
    pendingHex = null;
    if (editor.tool === 'eraser') setTool('brush');
    editor.rebuildPalette();
    editor.refreshStampPreviewTint();
    renderPalette();
    reflectFg();
  };

  /** Look at a colour without committing to it. */
  const preview = (hex: string): void => {
    pendingHex = hex;
    reflectFg();
  };

  // The well is the picker: tap the colour square, see the colour.
  const wellInput = wireColorPicker(fgWell, preview);

  // "+ Color" is the commit. With nothing previewed it opens the picker
  // instead, so it is never a button that does nothing.
  addBtn.addEventListener('click', () => {
    if (pendingHex && store.palette.every((c) => c.toLowerCase() !== pendingHex)) {
      addAndSelect(pendingHex);
      return;
    }
    wellInput.value = /^#[0-9a-fA-F]{6}$/.test(pendingHex ?? store.palette[editor.colorIndex] ?? '')
      ? (pendingHex ?? store.palette[editor.colorIndex])
      : '#1c6fe0';
    wellInput.click();
  });

  // Edit one swatch in place — recolours the seats using it (intentional).
  let colorPopover: HTMLElement | null = null;
  const openColorEditor = (idx: number, anchor: HTMLElement): void => {
    colorPopover?.remove();
    const pop = document.createElement('div');
    pop.className = 'color-pop';
    document.body.appendChild(pop);
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = store.palette[idx];
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = store.palette[idx];
    hex.maxLength = 7;
    const apply = (v: string): void => {
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
      store.setSwatch(idx, v.toLowerCase());
      editor.rebuildPalette();
      editor.repaintAll();
      editor.objectOverlay?.sync();
      renderPalette();
      reflectFg();
    };
    picker.addEventListener('input', () => {
      hex.value = picker.value;
      apply(picker.value);
    });
    hex.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) {
        picker.value = hex.value;
        apply(hex.value);
      }
    });

    const close = (): void => { pop.remove(); colorPopover = null; };

    // Removal used to be right-click only, which a touch screen has no way to
    // ask for. It lives here instead, under the same two guards: a colour still
    // painted on seats would silently repaint them, and a design needs one
    // colour besides the empty seat.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'color-pop-remove';
    remove.textContent = i18nT('ed.colors.remove');
    remove.addEventListener('click', () => {
      const used = colorCounts()[idx] ?? 0;
      if (used > 0) {
        message.textContent = i18nT('ed.colors.inUse').replace('{n}', used.toLocaleString());
        close();
        return;
      }
      if (store.palette.length <= 2) {
        message.textContent = i18nT('ed.colors.lastTwo');
        close();
        return;
      }
      const next = store.palette.filter((_, i) => i !== idx);
      store.setPalette(next);
      if (editor.colorIndex >= next.length) editor.colorIndex = next.length - 1;
      editor.rebuildPalette();
      editor.repaintAll();
      renderPalette();
      reflectFg();
      close();
    });

    const label = document.createElement('span');
    label.textContent = i18nT('ed.colors.edit');
    pop.append(label, picker, hex, remove);

    // Placed after it is in the DOM and has a width: a phone is narrow enough
    // that the old fixed 240px guess put it off the edge of the screen.
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.top = r.bottom + 6 + h <= window.innerHeight
      ? `${r.bottom + 6}px`
      : `${Math.max(8, r.top - h - 6)}px`;
    colorPopover = pop;

    setTimeout(() => {
      const away = (e: Event): void => {
        if (pop.contains(e.target as Node)) return;
        close();
        document.removeEventListener('pointerdown', away);
      };
      // pointerdown, not mousedown: on touch the synthesised mouse event only
      // arrives after the tap has already done something else.
      document.addEventListener('pointerdown', away);
    }, 0);
  };

  // Applying a palette (preset or uploaded) offers the add-or-remap choice via a
  // themed dialog (replaces the old native confirm). It's genuinely three-way, so
  // a labelled choice modal reads far clearer than an OK/Cancel boolean.
  const applyPalette = async (incoming: string[], label: string): Promise<void> => {
    if (incoming.length === 0) return;
    const { choiceModal } = await import('./modal');
    const choice = await choiceModal({
      title: tv('ed.dlg.applyPalette', { name: tl(label) }),
      message: i18nT('ed.dlg.applyHow'),
      choices: [
        { value: 'remap', label: i18nT('ed.dlg.remap'), hint: i18nT('ed.dlg.remapHint'), variant: 'primary' },
        { value: 'add', label: i18nT('ed.dlg.justAdd'), hint: i18nT('ed.dlg.justAddHint') },
      ],
      cancelLabel: i18nT('common.cancel'),
    });
    if (choice === null) return; // dismissed — do nothing
    if (choice === 'remap') {
      // Remap keeps index 0 (empty) as-is; remap the rest onto incoming.
      const withEmpty = incoming[0]?.toLowerCase() === store.palette[0]?.toLowerCase() ? incoming : [store.palette[0], ...incoming];
      store.remapToPalette(withEmpty);
      editor.rebuildPalette();
      editor.repaintAll();
    } else {
      store.addPaletteColors(incoming);
      editor.rebuildPalette();
    }
    if (editor.colorIndex >= store.palette.length) editor.colorIndex = store.palette.length - 1;
    renderPalette();
    reflectFg();
  };

  // Preset picker.
  const presetSel = $('#preset') as unknown as HTMLSelectElement;
  const presetPlaceholder = document.createElement('option');
  presetPlaceholder.value = '';
  presetPlaceholder.textContent = i18nT('ed.colors.choosePreset');
  presetSel.appendChild(presetPlaceholder);
  for (const name of Object.keys(PALETTE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = tl(name);
    presetSel.appendChild(opt);
  }
  presetSel.addEventListener('change', () => {
    if (!presetSel.value) return;
    // Preset palettes include index 0 (empty); pass the colour slots (skip 0).
    const full = PALETTE_PRESETS[presetSel.value];
    void applyPalette(full.slice(1), presetSel.value);
    presetSel.value = '';
  });

  // ---- user-uploadable palettes ----
  const myPalettesSel = $('#my-palettes') as unknown as HTMLSelectElement;
  const refreshMyPalettes = async (): Promise<void> => {
    const { listSavedPalettes } = await import('./paletteIo');
    const saved = listSavedPalettes();
    myPalettesSel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = saved.length ? i18nT('ed.colors.savedPlaceholder') : i18nT('ed.colors.noSaved');
    myPalettesSel.appendChild(ph);
    for (const p of saved) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.colors.length})`;
      myPalettesSel.appendChild(opt);
    }
  };
  void refreshMyPalettes();
  myPalettesSel.addEventListener('change', async () => {
    if (!myPalettesSel.value) return;
    const { listSavedPalettes } = await import('./paletteIo');
    const p = listSavedPalettes().find((x) => x.id === myPalettesSel.value);
    if (p) void applyPalette(p.colors, p.name);
    myPalettesSel.value = '';
  });

  // Import a palette from a file (.gpl/.hex/.txt/.json) or an image.
  const paletteFileInput = document.createElement('input');
  paletteFileInput.type = 'file';
  paletteFileInput.accept = '.gpl,.hex,.txt,.json,image/*';
  paletteFileInput.style.display = 'none';
  document.body.appendChild(paletteFileInput);
  $('#palette-import').addEventListener('click', () => paletteFileInput.click());
  paletteFileInput.addEventListener('change', async () => {
    const file = paletteFileInput.files?.[0];
    paletteFileInput.value = '';
    if (!file) return;
    try {
      if (file.type.startsWith('image/')) {
        const { extractPalette } = await import('../core/importImage');
        const bmp = await createImageBitmap(file);
        // Downscale to a small canvas; extractPalette wants raw pixels + size.
        const W = Math.min(160, bmp.width);
        const H = Math.max(1, Math.round((bmp.height / bmp.width) * W));
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0, W, H);
        bmp.close?.();
        const colors = extractPalette(ctx.getImageData(0, 0, W, H).data, W, H, 8);
        if (colors.length) void applyPalette(colors, file.name);
        else message.textContent = i18nT('ed.msg.paletteNoColors');
      } else {
        const text = await file.text();
        const { parsePaletteText } = await import('./paletteIo');
        const colors = parsePaletteText(text, file.name.toLowerCase());
        if (colors.length) void applyPalette(colors, file.name);
        else message.textContent = i18nT('ed.msg.paletteNoFile');
      }
    } catch (err) {
      message.textContent = tv('ed.msg.paletteFailed', { err: (err as Error).message });
    }
  });

  // Save the current swatches as a reusable palette + offer a .hex download.
  $('#palette-save').addEventListener('click', async () => {
    const colors = store.palette.slice(1).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
    if (colors.length === 0) {
      message.textContent = i18nT('ed.msg.addColorsFirst');
      return;
    }
    const { promptModal } = await import('./modal');
    const name = (await promptModal({
      title: i18nT('ed.dlg.namePalette'),
      placeholder: i18nT('ed.dlg.namePaletteHint'),
      defaultValue: i18nT('ed.dlg.myPalette'),
      confirmLabel: i18nT('ed.dlg.savePalette'),
      maxLength: 60,
    })) ?? '';
    if (name === '') return;
    const { saveUserPalette, serializePaletteHex } = await import('./paletteIo');
    saveUserPalette(name, colors);
    await refreshMyPalettes();
    message.textContent = tv('ed.msg.paletteSaved', { name });
    // Also offer a portable file.
    const blob = new Blob([serializePaletteHex(colors)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.hex`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Pattern presets: one undo step each, computed off the seat map.
  const patternSel = $('#pattern') as unknown as HTMLSelectElement;
  for (const p of PATTERN_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = tl(p.id);
    patternSel.appendChild(opt);
  }
  patternSel.addEventListener('change', () => {
    const preset = PATTERN_PRESETS.find((p) => p.id === patternSel.value);
    patternSel.value = '';
    if (!preset) return;
    store.transform(preset.cellAt(map));
    // tl(preset.id), not preset.name: LABEL_KEYS is keyed on the id, which is
    // also what the <option> labels use, so this cannot drift from the menu.
    message.textContent = tv('ed.msg.patternApplied', { name: tl(preset.id) });
  });

  // Text tool: real-font canvas rasterization → alpha mask → seat stamp.
  const textInput = $('#text-input') as unknown as HTMLInputElement;
  const textFont = $('#text-font') as unknown as HTMLSelectElement;
  for (const f of TIFO_FONTS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    opt.style.fontFamily = f.css;
    textFont.appendChild(opt);
  }
  const textSize = $('#text-size') as unknown as HTMLInputElement;
  const textSizeOut = $('#text-size-out');
  const textArc = $('#text-arc') as unknown as HTMLInputElement;
  const textArcOut = $('#text-arc-out');

  const currentFontCss = (): string =>
    TIFO_FONTS.find((f) => f.id === textFont.value)?.css ?? TIFO_FONTS[0].css;

  // Live ghost preview: rebuilt on text/font/arc edits, rescaled on size edits,
  // retinted on color changes. The editor positions it under the cursor.
  let previewRendered: RenderedText | null = null;
  const updateTextPreviewSize = (): void => {
    if (!previewRendered) return;
    const scale = (Number(textSize.value) * EDITOR_UNITS.rowPx) / previewRendered.glyphHeight;
    editor.setStampPreviewSize(previewRendered.canvas.width * scale, previewRendered.canvas.height * scale);
  };
  // Coalesce rapid slider/typing updates into one render per animation frame so
  // dragging stays smooth on large seat maps (value labels still update instantly).
  const rafThrottle = (fn: () => void): (() => void) => {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn();
      });
    };
  };
  const rebuildTextPreview = (): void => {
    previewRendered = renderTextCanvas(textInput.value, currentFontCss(), Number(textArc.value));
    editor.setStampPreview(previewRendered?.canvas ?? null, true);
    updateTextPreviewSize();
  };
  const rebuildTextPreviewT = rafThrottle(rebuildTextPreview);
  // The preview is drawn before the faces finish downloading; redraw once when
  // they land so the preview matches what placing will actually stamp.
  void loadTifoFonts().then(() => rebuildTextPreview());
  textInput.addEventListener('input', rebuildTextPreviewT);
  textFont.addEventListener('change', rebuildTextPreview);
  textArc.addEventListener('input', () => {
    textArcOut.textContent = textArc.value;
    rebuildTextPreviewT();
  });
  textSize.addEventListener('input', () => {
    textSizeOut.textContent = textSize.value;
    updateTextPreviewSize();
  });

  const placeTextAt = async (x: number, y: number): Promise<void> => {
    // Measuring a glyph before its face has arrived silently falls back to a
    // system font, and that mistake would be baked into the seats for good.
    await loadTifoFonts();
    if (bannerActive()) {
      // On a banner the text stays a live object with real colour, and it is
      // sized to the cap height that reads across the pitch rather than to a
      // number of seats — a banner has no seats to count.
      const ok = bannerHost.current?.placeText({
        text: textInput.value,
        fontId: textFont.value,
        arcDeg: Number(textArc.value),
        color: store.palette[editor.colorIndex] ?? '#ffffff',
      });
      if (!ok) {
        message.textContent = i18nT('ed.msg.typeTextFirst');
        return;
      }
      setTool('select');
      message.textContent = i18nT('bn.msg.placedOnBanner');
      return;
    }
    const rendered = renderTextCanvas(textInput.value, currentFontCss(), Number(textArc.value));
    if (!rendered) {
      message.textContent = i18nT('ed.msg.typeTextFirst');
      return;
    }
    const heightSeats = Number(textSize.value);
    const scale = (heightSeats * EDITOR_UNITS.rowPx) / rendered.glyphHeight;
    // Create a floating, movable object instead of baking into seats immediately.
    objects.addText({
      cx: x,
      cy: y,
      width: rendered.canvas.width * scale,
      height: rendered.canvas.height * scale,
      colorIndex: editor.colorIndex,
      tier: null,
      text: textInput.value,
      fontCss: currentFontCss(),
      fontId: textFont.value,
      arcDeg: Number(textArc.value),
      heightSeats,
    });
    editor.objectOverlay?.sync();
    setTool('select');
    message.textContent = i18nT('ed.obj.added').replace('{name}', textInput.value.trim());
  };

    // Custom font upload: FontFace API, available immediately in the font select.
  const fontUploadBtn = $('#text-font-upload') as unknown as HTMLButtonElement;
  const fontFileInput = $('#text-font-file') as unknown as HTMLInputElement;
  let customFontCount = 0;
  fontUploadBtn.addEventListener('click', () => fontFileInput.click());
  fontFileInput.addEventListener('change', async () => {
    const file = fontFileInput.files?.[0];
    fontFileInput.value = '';
    if (!file) return;
    try {
      const family = `tifo-custom-${++customFontCount}`;
      const face = new FontFace(family, await file.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      const name = file.name.replace(/\.[^.]+$/, '');
      TIFO_FONTS.push({ id: family, name, css: `"${family}", sans-serif` });
      const opt = document.createElement('option');
      opt.value = family;
      opt.textContent = name;
      opt.style.fontFamily = family;
      textFont.appendChild(opt);
      textFont.value = family;
      rebuildTextPreview();
      message.textContent = tv('ed.msg.fontLoaded', { name });
    } catch (err) {
      message.textContent = tv('ed.msg.fontFailed', { err: (err as Error).message });
    }
  });

  // Brush size
  const sizeInput = $('#brush-size') as unknown as HTMLInputElement;
  const sizeOut = $('#brush-size-out');
  sizeInput.addEventListener('input', () => {
    editor.brushRadius = Number(sizeInput.value);
    sizeOut.textContent = sizeInput.value;
  });

  // Fill scope
  const scopeSel = $('#fill-scope') as unknown as HTMLSelectElement;
  scopeSel.addEventListener('change', () => {
    editor.fillScope = scopeSel.value as 'section' | 'global';
  });

  // Grid toggle
  const gridChk = $('#grid') as unknown as HTMLInputElement;
  gridChk.addEventListener('change', () => editor.drawGrid(gridChk.checked));

  // Mirror painting
  const mirrorChk = $('#mirror') as unknown as HTMLInputElement;
  mirrorChk.addEventListener('change', () => {
    editor.mirror = mirrorChk.checked;
  });

  // Legibility check: flash fragile seats and report.
  const message = $('#message');
  $('#legibility').addEventListener('click', () => {
    const fragile = findFragileSeats(store.cells, map);
    if (fragile.length === 0) {
      message.textContent = tv('ed.msg.legibleOk', { n: MIN_LEGIBLE_RUN });
    } else {
      editor.flashSeats(fragile);
      message.textContent = tv('ed.msg.legibleThin', { n: fragile.length.toLocaleString(), min: MIN_LEGIBLE_RUN });
    }
  });

  // Undo / redo / fill-all / fit
  const undoBtn = $('#undo') as unknown as HTMLButtonElement;
  const redoBtn = $('#redo') as unknown as HTMLButtonElement;
  const refreshHistory = (): void => {
    // In the Banner view these buttons undo the banner, not the seats. Two
    // surfaces, two histories, one pair of buttons — which is what a user
    // expects, because only one of the two is in front of them.
    const b = bannerActive() ? bannerHost.current : null;
    undoBtn.disabled = b ? !b.canUndo : !store.canUndo;
    redoBtn.disabled = b ? !b.canRedo : !store.canRedo;
  };
  undoBtn.addEventListener('click', () => {
    if (bannerActive()) bannerHost.current?.undo();
    else store.undo();
    refreshHistory();
  });
  redoBtn.addEventListener('click', () => {
    if (bannerActive()) bannerHost.current?.redo();
    else store.redo();
    refreshHistory();
  });
  // Both, deliberately. onDirty covers a repaint that did not move the stacks
  // (an object bake reaching in through its own stroke); onHistoryChange covers
  // the case onDirty CANNOT see — a brush stroke commits on pointerup, after
  // its last flush, so without this the Undo button stayed greyed out until the
  // next stroke and was always one behind.
  store.onDirty(refreshHistory);
  store.onHistoryChange(refreshHistory);
  // The banner has its own history and its own store, and this module cannot
  // subscribe to a store whose chunk has not been downloaded yet.
  document.addEventListener(BANNER_HISTORY_EVENT, refreshHistory);
  refreshHistory();

  // Touch gestures land here: two fingers tapped = undo, double tap = fit.
  // A toast confirms the undo, because a gesture with no feedback reads as the
  // app having glitched rather than having done what you asked.
  editor.onTwoFingerTap = (): void => {
    if (!store.canUndo) return;
    store.undo();
    refreshHistory();
    gestureToast(i18nT('mb.undoTap'));
  };
  editor.onDoubleTap = (): void => {
    editor.fitToView();
    gestureToast(i18nT('mb.fitTap'));
  };

  // Fill the whole bowl with the ACTIVE painting colour (not a fixed slot).
  $('#fill-base').addEventListener('click', () => store.fillAll(editor.colorIndex));
  $('#fit').addEventListener('click', () => (bannerActive() ? bannerHost.current?.fit() : editor.fitToView()));

  // Image import mode: load a file, configure size (in seats), tier, dither,
  // alpha cutoff, then place by clicking (ghost preview) or via a stand preset.
  const fileInput = $('#import-file') as unknown as HTMLInputElement;
  const importName = $('#import-name');
  const importWidth = $('#import-width') as unknown as HTMLInputElement;
  const importSizeOut = $('#import-size-out');
  const importTier = $('#import-tier') as unknown as HTMLSelectElement;
  const importPlace = $('#import-place') as unknown as HTMLSelectElement;
  const importApply = $('#import-apply') as unknown as HTMLButtonElement;
  const ditherChk = $('#dither') as unknown as HTMLInputElement;
  const cutoutChk = $('#import-cutout') as unknown as HTMLInputElement;
  const realColorsChk = $('#real-colors') as unknown as HTMLInputElement;
  const importAlpha = $('#import-alpha') as unknown as HTMLInputElement;
  const importAlphaOut = $('#import-alpha-out');


  // Vertical centers for tier-targeted preset placement.
  const tierY: Record<string, number> = { both: (map.bounds.minY + map.bounds.maxY) / 2 };
  {
    const lo: Record<number, number> = {};
    const hi: Record<number, number> = {};
    for (let i = 0; i < map.count; i++) {
      const tier = map.tierOf[i];
      const y = map.xy[i * 2 + 1];
      lo[tier] = lo[tier] === undefined ? y : Math.min(lo[tier], y);
      hi[tier] = hi[tier] === undefined ? y : Math.max(hi[tier], y);
    }
    for (const tier of Object.keys(lo)) tierY[tier] = (lo[Number(tier)] + hi[Number(tier)]) / 2;
  }

  const importRect = (): { w: number; h: number; rows: number } => {
    const widthSeats = Number(importWidth.value);
    const w = widthSeats * EDITOR_UNITS.colPx;
    const h = pendingImport ? (w * pendingImport.bitmap.height) / pendingImport.bitmap.width : w;
    return { w, h, rows: Math.round(h / EDITOR_UNITS.rowPx) };
  };

  const refreshImportUI = (): void => {
    const { w, h, rows } = importRect();
    importSizeOut.textContent = i18nT('ed.import.size').replace('{w}', importWidth.value).replace('{n}', String(rows));
    // Place stays live in every mode. It used to switch OFF for "click on
    // canvas", which on a phone is a dead end: touch has no hover, so there is
    // no ghost to aim with, and the one button that could put the picture down
    // was greyed out. In click mode Place drops it in the middle of whatever
    // you are looking at — exactly where the ghost would have been.
    importApply.disabled = !pendingImport;
    editor.setStampPreviewSize(w, h);
  };

  /**
   * Tell the rest of the UI that an import is armed / finished.
   *
   * The phone shell hosts the import options in a bottom sheet, because the
   * desktop bar is `display:none` under `.m-shell` — a phone user who picked a
   * photo got no width, no tier, no Place and no Cancel, and no way back. It
   * cannot watch for that itself: only this module knows when a file has
   * actually decoded. A DOM event rather than a direct call, so the shell stays
   * a presentation layer and neither module imports the other.
   */
  const importArmed = (): void => {
    document.dispatchEvent(new CustomEvent('tifo:import-armed'));
  };
  const importDone = (): void => {
    document.dispatchEvent(new CustomEvent('tifo:import-done'));
  };

  const stampImageAt = (cx: number, cy: number): void => {
    if (!pendingImport) return;
    if (bannerActive()) {
      // A banner prints the picture, it does not quantize it to cards, so the
      // palette is left alone and the bitmap is embedded (downscaled) instead.
      editor.setStampPreview(null);
      bannerHost.current?.placeImage({ bitmap: pendingImport.bitmap, name: pendingImport.name });
      try {
        pendingImport.bitmap.close();
      } catch {
        /* older engines have no close(); GC will get it */
      }
      pendingImport = null;
      setTool('select');
      importDone();
      message.textContent = i18nT('bn.msg.placedOnBanner');
      return;
    }
    const { w, h } = importRect();
    // Release the cursor ghost FIRST. addImage notifies the overlay, which
    // builds the object's sprite synchronously, so anything after that point
    // would leave the same bitmap live in two GPU textures — 12MB each for a
    // phone photo. Correctness does not depend on the order (each texture is
    // its own; see render/ownTexture.ts) but the peak memory does. The ghost
    // is already invisible here: the click that got us here placed it.
    editor.setStampPreview(null);
    // "Real colours": add the picture's own dominant colours to the palette so
    // the imported art keeps its true look instead of only mapping to club cards.
    if (realColorsChk.checked) {
      const sampleCols = Math.min(200, Math.max(32, Math.round(w / 3)));
      const sampleRows = Math.max(2, Math.round((sampleCols * pendingImport.bitmap.height) / pendingImport.bitmap.width));
      const px = rasterize(pendingImport.bitmap, sampleCols, sampleRows);
      const extracted = extractPhotoPalette(px, sampleCols, sampleRows, 14, Number(importAlpha.value));
      if (extracted.length > 0) {
        // Append the picture's real colours as NEW swatches without disturbing
        // existing palette indices — every already-painted seat keeps its colour.
        // The image quantizes onto these swatches at bake time, so it still keeps
        // its true look. (The old setPalette() replaced the whole palette, so the
        // index→colour map shifted under every painted seat and recoloured the
        // entire stadium — with no undo, since a palette swap isn't a cell stroke.)
        store.addPaletteColors(extracted);
        editor.rebuildPalette();
        renderPalette();
        const presetSel = $('#preset') as unknown as HTMLSelectElement;
        presetSel.value = ''; // palette extended — no longer a named preset
      }
    }
    if (objects.pictureCount() >= MAX_PICTURES) {
      message.textContent = tv('ly.msg.pictureLimit', { n: MAX_PICTURES });
      return;
    }
    // The picture as it will be saved with the project: small enough that
    // twelve fit beside the banners, decoded again only to re-draw at a new size.
    const src = encodePictureSrc(pendingImport.bitmap);
    rememberPicture(src, pendingImport.bitmap);
    objects.addImage({
      cx,
      cy,
      width: w,
      height: h,
      colorIndex: 0,
      tier: importTier.value === 'both' ? null : Number(importTier.value),
      bitmap: pendingImport.bitmap,
      name: pendingImport.name,
      src,
      dither: ditherChk.checked,
      cutout: cutoutChk?.checked === true,
      alphaThreshold: Number(importAlpha.value),
    });
    // Keep the bitmap alive (the object now owns a reference); just exit import mode.
    pendingImport = null;
    setTool('select');
    importDone();
    const placed = objects.selected;
    message.textContent = i18nT('ed.import.placed').replace(
      '{name}',
      placed && placed.kind === 'image' ? placed.name : i18nT('ed.import.thePicture'),
    );
  };

  const cancelImport = (): void => {
    // Texture first, then the bitmap it was made from. Nothing renders between
    // these two lines today, but a texture pointing at a closed bitmap is the
    // kind of thing that only breaks once someone adds an await.
    editor.setStampPreview(null);
    pendingImport?.bitmap.close();
    pendingImport = null;
    importDone();
    if (editor.tool === 'import') setTool('brush');
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (!bannerActive() && objects.pictureCount() >= MAX_PICTURES) {
      message.textContent = tv('ly.msg.pictureLimit', { n: MAX_PICTURES });
      if (editor.tool === 'import') setTool('select');
      return;
    }
    message.textContent = i18nT('ed.import.reading');
    try {
      pendingImport?.bitmap.close();
      // decodeImportBitmap, not createImageBitmap: a phone camera hands you
      // 4000-8000px on the long edge, which is both a 47MB+ texture and, past
      // 4096, larger than many mobile GPUs will accept at all.
      pendingImport = { bitmap: await decodeImportBitmap(file), name: file.name };
      importName.textContent = file.name;
      setTool('import');
      editor.setStampPreview(pendingImport.bitmap, false);
      refreshImportUI();
      importArmed();
      message.textContent = i18nT('ed.import.armed');
    } catch (err) {
      message.textContent = i18nT('ed.import.failed').replace('{err}', (err as Error).message);
    }
  });
  importWidth.addEventListener('input', rafThrottle(refreshImportUI));
  importTier.addEventListener('change', refreshImportUI);
  importPlace.addEventListener('change', refreshImportUI);
  importAlpha.addEventListener('input', () => {
    importAlphaOut.textContent = importAlpha.value;
  });
  importApply.addEventListener('click', () => {
    if (!pendingImport) return;
    if (importPlace.value === 'click') {
      // No stand chosen → the centre of the current viewport, which is the one
      // place the user is demonstrably looking at.
      const view = editor.getViewportRect();
      stampImageAt(view.x + view.width / 2, view.y + view.height / 2);
      return;
    }
    const u = Number(importPlace.value);
    stampImageAt(u * EDITOR_UNITS.width, tierY[importTier.value] ?? tierY.both);
  });
  $('#import-cancel').addEventListener('click', cancelImport);

  // Shapes tool: vector primitives + symbols → 1-colour mask → seat stamp, placed
  // as a movable/resizable object (the exact pipeline the Text tool uses).
  const shapeKind = $('#shape-kind') as unknown as HTMLSelectElement;
  const shapeSize = $('#shape-size') as unknown as HTMLInputElement;
  const shapeSizeOut = $('#shape-size-out');
  const shapeAspect = (kind: string): number => SHAPE_ASPECT[kind] ?? 1;
  const renderShapeCanvas = (kind: string): HTMLCanvasElement => {
    const aspect = shapeAspect(kind);
    const c = document.createElement('canvas');
    c.height = 160;
    c.width = Math.max(8, Math.round(160 * aspect));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    drawSymbol(ctx, kind, c.width, c.height);
    return c;
  };
  const refreshShapePreview = (): void => {
    const kind = shapeKind.value;
    const h = Number(shapeSize.value) * EDITOR_UNITS.rowPx;
    editor.setStampPreview(renderShapeCanvas(kind), true); // tints to the active swatch
    editor.setStampPreviewSize(h * shapeAspect(kind), h);
  };
  const refreshShapePreviewT = rafThrottle(refreshShapePreview);
  shapeKind.addEventListener('change', refreshShapePreview);
  shapeSize.addEventListener('input', () => {
    shapeSizeOut.textContent = shapeSize.value;
    refreshShapePreviewT();
  });
  const placeShapeAt = (x: number, y: number): void => {
    const kind = shapeKind.value;
    if (bannerActive()) {
      bannerHost.current?.placeShape({ shape: kind, color: store.palette[editor.colorIndex] ?? '#ffffff' });
      setTool('select');
      message.textContent = i18nT('bn.msg.placedOnBanner');
      return;
    }
    const h = Number(shapeSize.value) * EDITOR_UNITS.rowPx;
    objects.addShape({
      cx: x,
      cy: y,
      width: h * shapeAspect(kind),
      height: h,
      colorIndex: editor.colorIndex,
      tier: null,
      shape: kind,
    });
    editor.objectOverlay?.sync();
    // Stay in the shape tool so multiple shapes can be dropped in a row, then
    // committed together with "Bake all". Switch to Select to fine-tune any one.
    // The <option>'s own label, which applyDom has already translated — a
    // second copy of sixteen shape names in the string table would only rot.
    message.textContent = i18nT('ed.obj.shapeAdded').replace(
      '{name}',
      shapeKind.selectedOptions[0]?.textContent?.trim() || kind,
    );
  };

  /**
   * A click on the BANNER artboard, in a tool that places something.
   *
   * The artboard cannot call these directly — the text string, the chosen
   * shape and the pending import all live in this module — so it announces the
   * click and the same three routines run, taking the banner branch. The
   * coordinates are carried by the artboard itself, which already knows where
   * the click landed.
   */
  document.addEventListener('tifo:banner-place', () => {
    if (editor.tool === 'text') void placeTextAt(0, 0);
    else if (editor.tool === 'shape') placeShapeAt(0, 0);
    else if (editor.tool === 'import') stampImageAt(0, 0);
  });

  // One shared placement-click callback, dispatched by the active mode.
  editor.onPlaceStamp = (x, y) => {
    if (editor.tool === 'text') void placeTextAt(x, y);
    else if (editor.tool === 'shape') placeShapeAt(x, y);
    else if (editor.tool === 'import' && importPlace.value === 'click') stampImageAt(x, y);
  };

  // Rebuild the right ghost when (re-)entering a stamp mode.
  onEnterMode = (tool) => {
    if (tool === 'text') rebuildTextPreview();
    else if (tool === 'shape') refreshShapePreview();
    else if (tool === 'import' && pendingImport) {
      editor.setStampPreview(pendingImport.bitmap, false);
      refreshImportUI();
    }
  };

  // Account + persistence (run `npm run server` alongside `npm run dev`).
  //
  // `ref` is the open project; `designId` stays as the account id the save
  // path has always used, and the two are only ever changed together, in
  // bindProject.
  let ref: ProjectRef | null = projectCtx?.ref ?? (restoredDesignId ? { kind: 'account', id: restoredDesignId } : null);
  let designId: string | null = ref?.kind === 'account' ? ref.id : null;
  let creationPending = projectCtx?.pending === true;
  /** The copy in this browser has changes the account does not have yet. */
  let unsynced = projectCtx?.unsynced === true;
  /** The title the account last saw, so a rename in the header reaches it on Save. */
  let serverTitle: string | null = ref?.kind === 'account' ? null : null;

  /** Point the page, the autosave and the save path at a project. */
  const bindProject = (next: ProjectRef): void => {
    ref = next;
    designId = next.kind === 'account' ? next.id : null;
    const keep: Record<string, string> = {};
    const now = new URLSearchParams(location.search);
    for (const k of ['sim', 'editor']) {
      const v = now.get(k);
      if (v) keep[k] = v;
    }
    const url = openUrl(next, keep);
    history.replaceState(null, '', url);
    try {
      sessionStorage.setItem('tifo_open_project', JSON.stringify({ url, banners: keysFor(next).banners }));
    } catch {
      /* only a sign-in round trip needs this */
    }
  };
  if (ref) bindProject(ref);
  const publicChk = $('#public') as unknown as HTMLInputElement;
  const signinBtn = $('#signin') as unknown as HTMLButtonElement;
  let myUserId: string | null = null;

  // The "Add match-day photo" control only makes sense once the design is saved
  // to the user's account (a photo attaches to a saved design id).
  const photoRow = document.getElementById('photo-row') as HTMLElement | null;
  const refreshPhotoRow = (): void => {
    if (photoRow) photoRow.hidden = !(designId && isSignedIn());
  };
  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.hidden = true;
  document.body.appendChild(photoInput);
  const addPhotoBtn = document.getElementById('add-photo') as HTMLButtonElement | null;
  addPhotoBtn?.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file || !designId) return;
    const { promptModal } = await import('./modal');
    const caption = (await promptModal({
      title: i18nT('ed.dlg.addCaption'),
      message: i18nT('ed.dlg.captionHint'),
      placeholder: i18nT('ed.dlg.captionPlaceholder'),
      confirmLabel: i18nT('ed.dlg.continue'),
      maxLength: 140,
    })) ?? '';
    addPhotoBtn && (addPhotoBtn.disabled = true);
    const original = addPhotoBtn?.innerHTML ?? '';
    if (addPhotoBtn) addPhotoBtn.textContent = i18nT('ed.dlg.uploading');
    try {
      const { uploadPhoto } = await import('../net/api');
      await uploadPhoto(designId, file, caption.trim());
      message.textContent = i18nT('ed.msg.photoAdded');
    } catch (err) {
      message.textContent = tv('ed.msg.photoFailed', { err: (err as Error).message });
    } finally {
      if (addPhotoBtn) {
        addPhotoBtn.disabled = false;
        addPhotoBtn.innerHTML = original;
      }
    }
  });

  const reflectSignedIn = (name: string, userId?: string, fresh = false): void => {
    signinBtn.textContent = name;
    signinBtn.classList.remove('signup-shine'); // stop pulsing once signed in
    signinBtn.hidden = true; // account actions move to the avatar menu
    if (userId) myUserId = userId;
    const avatar = document.getElementById('avatar');
    if (avatar) avatar.textContent = name[0].toUpperCase();
    const menuName = document.getElementById('avatar-menu-name');
    if (menuName) menuName.textContent = `@${name}`;
    // A registration whose verification email was refused still signs you in,
    // so without this the only clue is an inbox nothing is coming to.
    //
    // A session merely restored on load is not news, and must not write over
    // what the page just said about the project ("restored your unsaved
    // changes", "imported as a new project").
    if (fresh || !message.textContent) {
      message.textContent = registrationEmailWasSent()
        ? tv('ed.msg.signedInAs', { name })
        : i18nT('ac.verify.noEmailSent');
    }
    setAnalyticsSignedIn(true);
    if (fresh) track('signed_up'); // genuine auth this session, not a reload-restore
  };

  // Toggle the admin-only Moderation button. Defined here so all auth-success
  // and restore paths can call it. Server enforces admin on every endpoint too.
  const reflectAdmin = (isAdmin: boolean): void => {
    const b = document.getElementById('moderation') as HTMLButtonElement | null;
    if (b) b.hidden = !isAdmin;
  };

  // Clicking the header button when signed out → auth modal.
  signinBtn.addEventListener('click', async () => {
    if (isSignedIn() && myUserId) {
      // When signed in, the Sign up button is hidden; this path is a fallback.
      toggleAvatarMenu();
      return;
    }
    const name = await openAuthModal();
    if (name) {
      const me = await fetchMe();
      reflectSignedIn(name, me?.id, true);
      reflectAdmin(me?.isAdmin ?? false);
    }
  });

  // The avatar opens a small account menu (View profile / Community / Sign out).
  const avatarEl = document.getElementById('avatar');
  const avatarMenu = document.getElementById('avatar-menu');
  function toggleAvatarMenu(force?: boolean): void {
    if (!avatarMenu) return;
    const show = force ?? avatarMenu.hidden;
    avatarMenu.hidden = !show;
    avatarEl?.setAttribute('aria-expanded', String(show));
  }
  avatarEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Reflect auth state in which menu items show.
    const signed = isSignedIn();
    const profileItem = document.getElementById('menu-profile');
    const signoutItem = document.getElementById('menu-signout');
    const nameItem = document.getElementById('avatar-menu-name');
    if (profileItem) profileItem.hidden = !signed;
    if (signoutItem) signoutItem.hidden = !signed;
    const passwordItem = document.getElementById('menu-password');
    if (passwordItem) passwordItem.hidden = !signed;
    const exportItem = document.getElementById('menu-export');
    if (exportItem) exportItem.hidden = !signed;
    const deleteItem = document.getElementById('menu-delete');
    if (deleteItem) deleteItem.hidden = !signed;
    if (nameItem) nameItem.hidden = !signed;
    // The phone-only row. `menu-signup` was never in this list: .m-only is
    // revealed by body.m-shell whatever the state, so a signed-in user on a
    // phone saw "Sign up" sitting directly under their own username — and
    // because the myUserId restore is async, tapping it early could open the
    // auth modal on an account that was already signed in.
    const signupItem = document.getElementById('menu-signup');
    if (signupItem) signupItem.hidden = signed;
    const accountItem = document.getElementById('menu-account');
    if (accountItem) accountItem.hidden = !signed;
    toggleAvatarMenu();
  });
  // Close the menu on any outside click.
  document.addEventListener('click', (e) => {
    if (avatarMenu && !avatarMenu.hidden) {
      const wrap = (e.target as HTMLElement).closest('.avatar-wrap');
      if (!wrap) toggleAvatarMenu(false);
    }
  });
  /*
   * The avatar is a real <button> in the markup now, so Enter and Space work
   * without a keydown shim and it is in the tab order by itself.
   *
   * It no longer claims role="menu" / aria-haspopup="menu". It had the roles
   * but none of the behaviour the ARIA menu pattern requires - the items were
   * not menuitems and arrow keys did nothing - which is worse than saying
   * nothing: a screen reader user is promised menu navigation and finds a
   * list of buttons. As a plain popover of buttons everything works, and
   * nothing is announced that is not true. aria-expanded, which IS honoured,
   * stays; Escape still closes it and returns focus below.
   */
  if (avatarEl) avatarEl.setAttribute('aria-expanded', 'false');
  // Esc closes the avatar menu and returns focus to the avatar.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && avatarMenu && !avatarMenu.hidden) {
      toggleAvatarMenu(false);
      avatarEl?.focus();
    }
  });
  document.getElementById('menu-profile')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    if (myUserId) {
      const { openProfile } = await import('./profile');
      await openProfile(myUserId, (id) => void doLoad(id));
    }
  });
  document.getElementById('menu-community')?.addEventListener('click', () => {
    window.location.href = '/community';
  });
  // The only way to report a bug used to be leaving the site and finding the
  // developer on Twitter, which effectively meant bugs were never reported.
  document.getElementById('menu-feedback')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    const { openFeedbackModal } = await import('./feedbackModal');
    openFeedbackModal('bug');
  });

  // The header Gallery button is folded away on phones, so the menu carries it.
  document.getElementById('menu-gallery')?.addEventListener('click', () => {
    toggleAvatarMenu(false);
    ($('#gallery') as unknown as HTMLButtonElement).click();
  });
  document.getElementById('menu-account')?.addEventListener('click', () => {
    toggleAvatarMenu(false);
    window.location.href = '/account';
  });
  document.getElementById('menu-password')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    const { openChangePasswordModal } = await import('./changePasswordModal');
    openChangePasswordModal();
  });
  document.getElementById('menu-export')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    try {
      const data = await exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tifomaker-data.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* best-effort download */
    }
  });
  document.getElementById('menu-delete')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    if (!window.confirm(i18nT('ed.deleteConfirm'))) return;
    try {
      await deleteAccount();
      window.location.href = '/';
    } catch {
      /* ignore — stay on the page if deletion failed */
    }
  });
  document.getElementById('menu-tutorial')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    const { startTour } = await import('./tour');
    void startTour();
  });
  document.getElementById('menu-signout')?.addEventListener('click', async () => {
    toggleAvatarMenu(false);
    const { signOut } = await import('../net/api');
    signOut();
    setAnalyticsSignedIn(false);
    myUserId = null;
    // Reset the header to the signed-out state.
    if (avatarEl) avatarEl.textContent = 'U';
    signinBtn.hidden = false;
    signinBtn.classList.add('signup-shine');
    reflectAdmin(false);
    const photoRow2 = document.getElementById('photo-row');
    if (photoRow2) photoRow2.hidden = true;
    message.textContent = i18nT('ed.msg.signedOut');
    // An account project is not something to go on editing signed out: its
    // Save would have nowhere to go. Back to the list, which now shows this
    // browser's projects.
    if (ref?.kind === 'account') {
      draftWriter.flush();
      location.assign('/projects');
    }
  });

  // Restore session on load: if a token is present, show the name (no shine).
  void (async () => {
    const me = await fetchMe();
    if (me?.username) reflectSignedIn(me.username, me.id);
    if (me) reflectAdmin(me.isAdmin);
    refreshPhotoRow();
  })();

  const saveBtn = $('#save') as unknown as HTMLButtonElement;

  // Share button: opens the multi-platform share modal for the saved design.
  // (A design must be saved first so it has an id / public link.)
  root.querySelector<HTMLButtonElement>('#share-design')?.addEventListener('click', () => {
    if (!designId) {
      message.textContent = i18nT('ed.msg.saveBeforeShare');
      return;
    }
    openShareModal({ id: designId, title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder') });
  });

  // Download the current design as a portable .tifo file (JSON: template + palette + cells).
  const downloadLocal = (): void => {
    const title = docTitle.value.trim() || i18nT('ed.docTitlePlaceholder');
    // The seats as they are, flattened, for any reader of the format; and the
    // layers beside them, so this editor opens the file with everything still
    // movable.
    const v2 = buildTifoV2({
      title,
      generator: 'tifomaker-editor',
      templateId: map.templateRef.id,
      templateVersion: map.templateRef.version,
      palette: store.palette,
      cells: store.cells,
      editorLayers: composer?.toDoc() ?? null,
    });
    const blob = new Blob([JSON.stringify(v2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.tifo`;
    a.click();
    URL.revokeObjectURL(url);
    message.textContent = tv('ed.msg.downloaded', { name: title });
  };

  // Load a .tifo file back in — closes the download/upload loop. Validates with
  // the shared format module (accepts v1 and v2; migrates v1). If it targets a
  // different stadium, hands off through sessionStorage and reloads with the
  // right template so the seat count matches.
  const importTifoFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        message.textContent = i18nT('ed.msg.notJson');
        return;
      }
      const { validateTifo } = await import('../core/tifoFormat');
      // A file is a project of its own, on its own stadium. Opening it used to
      // replace whatever was on the canvas; with projects that would overwrite
      // the open one, so it opens as a new project instead and this one stays
      // exactly as it was. The new project validates it against its seat map.
      const stadiumId =
        (parsed as { stadium?: { templateId?: string } })?.stadium?.templateId ??
        (parsed as { templateId?: string })?.templateId;
      if (typeof stadiumId === 'string') {
        try {
          sessionStorage.setItem('tifo_pending_import', text);
        } catch {
          /* ignore quota */
        }
        draftWriter.flush();
        const fileTitle = (parsed as { meta?: { title?: string } })?.meta?.title || file.name.replace(/\.tifo$/i, '');
        stashNewProject({ title: fileTitle.slice(0, 80) || i18nT('ed.docTitlePlaceholder'), templateId: stadiumId });
        message.textContent = i18nT('ed.msg.openingStadium');
        location.assign(newProjectUrl(stadiumId, { import: '1' }));
        return;
      }
      const result = validateTifo(parsed, (id, v) =>
        id === map.templateRef.id && v === map.templateRef.version ? map.count : null,
      );
      if (!result.valid || !result.doc) {
        const first = result.errors[0];
        message.textContent = first ? `can\u2019t open: ${first.path ? first.path + ': ' : ''}${first.message}` : 'invalid .tifo file';
        return;
      }
      const { flattenLayers } = await import('../core/tifoFormat');
      // The file replaces the design, layers and all.
      objects.clear(false);
      store.setPalette(result.doc.palette.slice(0, 256));
      store.loadCells(flattenLayers(result.doc));
      if (result.doc.editor?.layers && composer?.loadDoc(result.doc.editor.layers, TIFO_FONTS)) {
        const { decodePictures } = await import('../core/objects');
        void decodePictures(objects.list());
      }
      const title = result.doc.meta?.title;
      if (title) docTitle.value = title;
      designId = null; // an imported file is a fresh working copy
      publicChk.checked = false;
      // A .tifo file carries seats, not banners, and the banners on screen
      // belong to the tifo it just replaced.
      sceneIO?.restore(null);
      sceneUnread = false;
      editor.rebuildPalette();
      editor.repaintAll();
      renderPalette();
      message.textContent = tv('ed.msg.opened', { name: title ?? file.name });
    } catch (err) {
      message.textContent = tv('ed.msg.openFailed', { err: (err as Error).message });
    }
  };

  // ================= local draft: the safety net =================
  // Every change is written to this browser, so nothing is ever lost by closing
  // the tab and nothing requires an account. See core/draft.ts for what this can
  // and cannot promise.
  const draftState = $('#draft-state') as unknown as HTMLElement;
  const accountOffer = $('#account-offer') as unknown as HTMLElement;
  let lastDraft: DraftWriteResult | null = null;

  // The header Save. The panel one stays for anyone already down there, but this
  // is the one almost everybody will use, because it is the only one on screen.
  const saveTopBtn = document.getElementById('save-top') as HTMLButtonElement | null;
  const saveStateTop = document.getElementById('save-state-top');

  /**
   * Which Save the user last pressed, so the result appears at that control.
   *
   * Both indicators used to be written at once, so "Saved in this browser" was
   * on screen twice - three times counting the account offer's own copy - which
   * reads as three separate things happening rather than one. The header is the
   * default because it is the one that is always visible, including on a first
   * load where the state came from a restored draft rather than a press.
   */
  let lastSaveTrigger: 'top' | 'panel' = 'top';

  const renderDraftState = (): void => {
    const show = (cls: string, text: string): void => {
      const inPanel = lastSaveTrigger === 'panel';
      draftState.className = cls;
      draftState.textContent = inPanel ? text : '';
      if (saveStateTop) {
        saveStateTop.className = cls.replace('draft-state', 'save-state-top');
        saveStateTop.textContent = inPanel ? '' : text;
        saveStateTop.hidden = inPanel || !text;
      }
    };
    if (!lastDraft) { show('draft-state', ''); return; }
    if (lastDraft.ok) {
      // Say where the work actually is. An account project with edits the
      // account has not got is NOT "saved to your account", however signed
      // in its owner is: those edits are in this browser until Save.
      if (ref?.kind === 'account') {
        show(unsynced ? 'draft-state pending' : 'draft-state ok', i18nT(unsynced ? 'draft.unsynced' : 'draft.savedAccount'));
      } else {
        show('draft-state ok', i18nT('draft.savedLocal'));
      }
      return;
    }
    show(
      'draft-state warn',
      lastDraft.reason === 'quota' || lastDraft.reason === 'too-big'
        ? i18nT('draft.full')
        : i18nT('draft.blocked'),
    );
  };

  /**
   * The card picture of a local project, redrawn a few seconds after the last
   * change. It is the only picture a project in this browser has, and a
   * Projects page of grey rectangles is a page nobody can find anything on.
   */
  let thumbTimer = 0;
  const scheduleThumb = (): void => {
    if (ref?.kind !== 'local') return;
    window.clearTimeout(thumbTimer);
    const id = ref.id;
    thumbTimer = window.setTimeout(() => {
      if (ref?.kind !== 'local' || ref.id !== id) return;
      const url = makeStripDataUrl(map, store);
      if (url) writeRaw(thumbKey(id), url);
    }, 2500);
  };

  /**
   * The layer stack, beside the draft. It carries the fingerprint of the
   * seats it flattens to, so a stack that did not get written before the tab
   * closed is never put on top of a newer draft (see core/layerStore.ts).
   */
  let layersWriting: Promise<unknown> = Promise.resolve();
  const writeLayersSoon = (): void => {
    if (!ref || !composer) return;
    const key = keysFor(ref).doc;
    const doc = composer.toDoc();
    layersWriting = layersWriting.then(() => writeLayers(key, doc));
  };

  const draftWriter = createDraftWriter(
    () =>
      // No project, nowhere to write: an unbound canvas is made a project by
      // its first edit (ensureProject), never silently autosaved into a key
      // that belongs to nothing.
      ref
        ? buildDraft({
            title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder'),
            templateId: map.templateRef.id,
            templateVersion: map.templateRef.version,
            palette: store.palette,
            cells: store.cells,
            // The layers are kept beside the draft, in IndexedDB (see
            // core/layerStore.ts); the draft itself holds the flattened seats.
            textObjects: [],
            designId,
            projectId: ref.kind === 'local' ? ref.id : null,
            dirty: ref.kind === 'account' && unsynced,
          })
        : null,
    (r) => {
      lastDraft = r;
      if (r.ok && ref?.kind === 'local') {
        updateLocal(ref.id, { title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder'), updatedAt: Date.now() });
        scheduleThumb();
      }
      renderDraftState();
      // The banners are kept beside the draft, in a key of their own, and
      // written with it so the two always describe the same tifo.
      if (r.ok) {
        document.dispatchEvent(new CustomEvent('tifo:draft-written'));
        writeLayersSoon();
      }
    },
    1200,
    (env) => writeEnvelope(keysFor(ref!).doc, env),
  );

  /**
   * Make the open canvas a project, if it is not one yet.
   *
   * Only an unbound canvas gets here: someone else's tifo from a share link,
   * edited for the first time. Editing it is making it yours, so it becomes
   * a project named after where it came from, in the account when there is
   * one and in this browser when there is not.
   */
  let ensuring: Promise<void> | null = null;
  const ensureProject = (): Promise<void> => {
    if (ref || creationPending) return Promise.resolve();
    if (!ensuring) {
      ensuring = api.createProject({ title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder'), origin: null })
        .then(() => undefined)
        .finally(() => { ensuring = null; });
    }
    return ensuring;
  };
  const edited = (): void => {
    unsynced = true;
    if (!ref) {
      void ensureProject().then(() => draftWriter.schedule());
      return;
    }
    draftWriter.schedule();
  };

  /**
   * True while this design's banners are unknown: its scene failed to load.
   *
   * Then the editor shows none, and a save must not write "none" over the
   * ones still safe on the server. It clears the moment somebody changes a
   * banner, because from then on what the editor holds is what they made.
   */
  let sceneUnread = false;

  store.onDirty(edited);
  objects.onChange((why) => { if (why !== 'select') edited(); }); // picking a layer is not an edit
  // A banner is part of the tifo: a design that is only a banner so far is
  // still work to keep, and it is the draft that says which tifo this is.
  sceneIO?.onChange?.(() => {
    sceneUnread = false;
    edited();
  });
  docTitle.addEventListener('input', edited);
  // A closing tab gets no timer callback, so flush synchronously on the way out.
  window.addEventListener('pagehide', () => draftWriter.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') draftWriter.flush();
  });

  // ================= save =================
  /** Persist to the signed-in account. Returns false and reports on failure. */
  const setSaveBusy = (busy: boolean): void => {
    saveBtn.disabled = busy;
    if (saveTopBtn) saveTopBtn.disabled = busy;
  };

  const saveToAccount = async (announce: boolean): Promise<boolean> => {
    setSaveBusy(true);
    try {
      const isNew = designId === null;
      const current = docTitle.value.trim() || i18nT('ed.docTitlePlaceholder');
      const title = isNew ? current : '';
      const movingLocal = ref?.kind === 'local' ? ref.id : null;
      const localMeta = movingLocal ? getLocal(movingLocal) : null;
      const meta = await saveDesign(store, map, map.templateRef.id, map.templateRef.version, title, designId, localMeta?.origin ?? null);
      // A name changed in the header reaches the account with the save. It
      // used to be sent only on the first save and on publishing, so a
      // project renamed later kept its old name everywhere else.
      if (!isNew && meta.id && current !== (serverTitle ?? meta.title)) {
        await setDesignTitle(meta.id, current).catch(() => {});
      }
      serverTitle = current;
      // Best-effort, and AFTER the design: the tifo is the thing that must not
      // be lost, and a banner too big for the cap should cost the banner, not
      // the design. The message says which happened rather than reporting a
      // success that was only half true.
      let sceneFailed = '';
      if (sceneIO && meta.id && !sceneUnread) {
        try {
          await saveScene(meta.id, sceneIO.snapshot());
        } catch (err) {
          sceneFailed = (err as Error).message;
        }
      }
      if (meta.id && (isNew || ref?.kind !== 'account')) {
        // Saved into the account for the first time: from here on this is an
        // account project. A local one it replaces is removed from the
        // browser, AFTER the account has it, never before.
        bindProject({ kind: 'account', id: meta.id });
        if (movingLocal) {
          purgeLocal(movingLocal);
          if (localMeta?.pinned) {
            const { setProjectPinned } = await import('../net/api');
            await setProjectPinned(meta.id, true).catch(() => {});
          }
        }
      }
      designId = meta.id ?? designId;
      unsynced = false;
      refreshPhotoRow();
      // Flush rather than schedule: the debounce would leave a ~1s window in
      // which the draft still says designId=null, and a tab closed inside it
      // would fork a duplicate on the next save.
      draftWriter.flush();
      if (announce) {
        message.textContent = sceneFailed
          ? tv('save.sceneFailed', { err: tErr(sceneFailed) })
          : i18nT('save.toAccount');
      }
      return true;
    } catch (err) {
      message.textContent = `${i18nT('save.failed')}: ${(err as Error).message}`;
      return false;
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * Sign in or sign up, then adopt the session. Returns true when signed in.
   *
   * `claim` is only meaningful on the provider path: pressing "Continue with
   * Google" leaves the page, so this function never returns and the caller's
   * next line never runs. The flag rides across the redirect instead, and the
   * block near the save buttons picks the claim up on the way back.
   */
  const ensureSignedIn = async (claim = false): Promise<boolean> => {
    if (isSignedIn()) return true;
    track('auth_opened');
    const name = await openAuthModal(claim);
    if (!name) return false;
    const me = await fetchMe();
    reflectSignedIn(name, me?.id, true); // fires signed_up when genuinely fresh
    reflectAdmin(me?.isAdmin ?? false);
    return true;
  };

  /**
   * Put the offer directly under the control that triggered it, clamped so it
   * can never hang off the edge of a narrow screen.
   */
  const placeOffer = (anchor: HTMLElement): void => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    accountOffer.style.width = `${w}px`;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    accountOffer.style.left = `${Math.round(left)}px`;
    accountOffer.style.top = `${Math.round(Math.min(r.bottom + 10, window.innerHeight - 24))}px`;
  };

  /**
   * The offer to keep work beyond this browser. Shown only AFTER a save has
   * already succeeded, so it reads as an upgrade rather than a toll: the user
   * can ignore it entirely and still have their tifo.
   */
  const showAccountOffer = (anchor: HTMLElement): void => {
    if (isSignedIn() || !accountOffer.hidden) return;
    track('account_prompt');
    accountOffer.hidden = false;
    // Anchor it to the button that was actually pressed. Fixed to the header one
    // it would ambush someone saving from the panel, and pinned in the panel it
    // is invisible to someone saving from the header - which is the whole bug.
    placeOffer(anchor);
    accountOffer.innerHTML =
      `<p class="ao-lead">${i18nT('offer.lead')}</p>` +
      `<button class="primary ao-go" type="button">${i18nT('offer.cta')}</button>` +
      `<button class="ao-dismiss" type="button">${i18nT('offer.later')}</button>`;
    accountOffer.querySelector('.ao-dismiss')!.addEventListener('click', () => {
      accountOffer.hidden = true;
    });
    // The offer renders below the Save button in a panel that scrolls. Pressing
    // Save near the bottom of the viewport put it entirely below the fold, with
    // nothing to say it had appeared: an offer nobody sees is the same as no
    // offer. 'nearest' is a no-op when it is already in view, so this only ever
    // moves the panel when it has to.
    accountOffer.scrollIntoView({
      block: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    accountOffer.querySelector('.ao-go')!.addEventListener('click', async () => {
      if (!(await ensureSignedIn(true))) return;
      accountOffer.hidden = true;
      // Claim: push the work they already made onto the brand-new account, so
      // they land on their tifo instead of an empty account. This can take a
      // few seconds on a big design, and reflectSignedIn has just overwritten
      // the message with "signed in as ...", so say what is still happening.
      await claimDraftOntoAccount();
    });
  };

  /**
   * Push the work they already made onto the account they just created, so they
   * land on their tifo instead of an empty account.
   *
   * This can take a few seconds on a big design, and whatever signed them in has
   * just overwritten the message with "signed in as ...", so it says what is
   * still happening.
   */
  const claimDraftOntoAccount = async (): Promise<void> => {
    message.textContent = i18nT('save.claiming');
    if (await saveToAccount(false)) {
      track('draft_claimed');
      message.textContent = i18nT('save.claimed');
    }
    renderDraftState();
    // Everything else this browser was holding goes into the account too, so
    // the Projects page they return to is complete. Quietly, in the
    // background: the tifo on screen is the one they are thinking about.
    const { claimAllLocal } = await import('../net/claimProjects');
    void claimAllLocal(ref?.kind === 'local' ? ref.id : undefined).catch(() => {});
  };

  // One action, reachable from two places. It always succeeds, and it never
  // asks a question first.
  const doSave = async (trigger: HTMLElement): Promise<void> => {
    // Report the result where the press happened, not in both places at once.
    lastSaveTrigger = trigger === saveTopBtn ? 'top' : 'panel';
    track('save_clicked');
    if (!isSignedIn()) {
      await ensureProject();
      draftWriter.flush(); // forces a write, so lastDraft reflects reality
      track('save_local');
      if (!lastDraft || !lastDraft.ok) {
        // Never claim a save that did not happen: point at the download instead.
        renderDraftState();
        message.textContent = i18nT('save.localFailed');
        return;
      }
      // The draft-state chip beside whichever Save was pressed already says
      // this. Repeating it here put the same sentence on screen twice, which
      // reads as two things having happened rather than one.
      message.textContent = '';
      showAccountOffer(trigger);
      return;
    }
    await saveToAccount(true);
  };

  saveBtn.addEventListener('click', () => void doSave(saveBtn));
  saveTopBtn?.addEventListener('click', () => void doSave(saveTopBtn));

  // Back from Google. The session was adopted in main() before the editor was
  // built; what is left is the half of the save flow the redirect interrupted.
  // Without this, someone who painted a tifo, pressed Save, and signed up with
  // Google would arrive at an empty account — the exact failure the save-flow
  // rewrite existed to fix, reintroduced by the redirect.
  if (takeClaimIntent()) {
    void (async () => {
      const me = await fetchMe();
      if (!me?.username) return;
      reflectSignedIn(me.username, me.id, true);
      reflectAdmin(me.isAdmin);
      await claimDraftOntoAccount();
    })();
  }
  // Ctrl/Cmd+S is what people reach for before they hunt for a button.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void doSave(saveTopBtn ?? saveBtn);
    }
  });
  // A popover pinned in viewport coordinates has to follow its anchor.
  window.addEventListener('resize', () => {
    if (!accountOffer.hidden) placeOffer(saveTopBtn ?? saveBtn);
  });

  // ================= publish (a separate intent, with its own metadata) =================
  const publishBtn = $('#publish-design') as unknown as HTMLButtonElement;
  publishBtn.addEventListener('click', async () => {
    if (!(await ensureSignedIn())) return;
    if (designId === null && !(await saveToAccount(false))) return;
    const { openPublishDialog } = await import('./publishDialog');
    const choice = await openPublishDialog({
      title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder'),
      currentlyPublic: publicChk.checked,
    });
    if (!choice) return;
    publishBtn.disabled = true;
    try {
      if (!(await saveToAccount(false))) return;
      if (!designId) return;
      // Apply the public name first, so the design is never briefly public
      // under a placeholder title that a crawler or a share preview could catch.
      if (choice.title && choice.title !== docTitle.value.trim()) {
        docTitle.value = choice.title;
        await setDesignTitle(designId, choice.title).catch(() => {});
        draftWriter.schedule(); // keep the local draft's title in step
      }
      await setPublic(designId, true);
      publicChk.checked = true;
      const { setDesignTags, setDesignTemplate, setPublishMeta } = await import('../net/api');
      if (choice.tags.length > 0) await setDesignTags(designId, choice.tags).catch(() => {});
      if (choice.isTemplate) await setDesignTemplate(designId, true).catch(() => {});
      if (choice.description !== null || !choice.allowRemix) {
        await setPublishMeta(designId, choice.description, choice.allowRemix).catch(() => {});
      }
      track('published');
      message.textContent = i18nT('publish.done');
      // The moment it is public is the moment it can be shared: offer it now,
      // with the links already tagged, rather than leaving Share as a separate
      // button to find later (sharing ran at three presses a month).
      openShareModal({ id: designId, title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder') });
    } catch (err) {
      message.textContent = `${i18nT('publish.failed')}: ${(err as Error).message}`;
    } finally {
      publishBtn.disabled = false;
    }
  });

  // The durable escape hatch, no longer buried inside a modal.
  ($('#download-tifo') as unknown as HTMLButtonElement).addEventListener('click', () => downloadLocal());

  /**
   * Open another design: from the gallery, or from a profile.
   *
   * It used to be loaded into the canvas in place, over whatever was there.
   * With projects that would overwrite the open project, so it opens as a
   * project of its own: your own design opens as itself, anybody else's as a
   * new project named after it (main.ts decides which, on `from`).
   */
  const doLoad = async (id: string): Promise<void> => {
    draftWriter.flush();
    location.assign(`/app?${new URLSearchParams({ new: '1', from: id }).toString()}`);
  };
  // Hidden input for opening .tifo files.
  const tifoInput = document.createElement('input');
  tifoInput.type = 'file';
  tifoInput.accept = '.tifo,application/json';
  tifoInput.hidden = true;
  document.body.appendChild(tifoInput);
  tifoInput.addEventListener('change', () => {
    const f = tifoInput.files?.[0];
    if (f) void importTifoFile(f);
    tifoInput.value = ''; // allow re-selecting the same file
  });
  $('#load').addEventListener('click', () => tifoInput.click());
  $('#gallery').addEventListener('click', () =>
    void openGallery(
      (id) => void doLoad(id),
      async () => {
        const name = await openAuthModal();
        if (name) {
          const me = await fetchMe();
          reflectSignedIn(name, me?.id, true);
          reflectAdmin(me?.isAdmin ?? false);
        }
        return isSignedIn();
      },
    ),
  );

  // Moderation button opens the queue (shown only to admins via reflectAdmin).
  document.getElementById('moderation')?.addEventListener('click', async () => {
    const { openModeration } = await import('./moderation');
    await openModeration();
  });

  /**
   * Deep link from the admin dashboard: /app?admin=reports|photos|stadiums.
   *
   * The three review queues live in two different places - reports and photos
   * in the Moderation panel, stadium submissions in the Stadium panel - which
   * is impossible to guess from a count on a dashboard. The dashboard now links
   * each count straight at the panel that handles it.
   *
   * Run only after the session is known, so a link forwarded to someone who is
   * not an admin opens nothing rather than flashing a panel they cannot use.
   * The endpoints behind both panels are admin-gated server-side regardless.
   */
  const openAdminQueue = async (what: string): Promise<void> => {
    if (what === 'reports' || what === 'photos') {
      const { openModeration } = await import('./moderation');
      await openModeration(what);
      return;
    }
    if (what === 'stadiums') {
      setPanelMode('stadium');
      setOptionsSheet(true);
      // The queue is at the bottom of a long panel; land on it, not above it.
      requestAnimationFrame(() =>
        document.getElementById('stadium-review')?.scrollIntoView({ block: 'center' }),
      );
    }
  };

  // Check admin status on load (once the session is known).
  void (async () => {
    const me = await fetchMe();
    const isAdmin = me?.isAdmin ?? false;
    reflectAdmin(isAdmin);
    const wanted = new URLSearchParams(location.search).get('admin');
    if (isAdmin && wanted) {
      // Drop the parameter first, not after: a refresh or a bookmark made from
      // here should not reopen the panel over whatever the user moved on to,
      // and doing it up front does not depend on when the panel settles.
      const url = new URL(location.href);
      url.searchParams.delete('admin');
      history.replaceState(null, '', url.toString());
      await openAdminQueue(wanted);
    }
  })();

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (bannerActive() && bannerHost.current?.escape()) return;
      if (editor.tool === 'import') cancelImport();
      else if (editor.tool === 'text') setTool('brush');
      else if (objects.selected && !bannerActive()) objects.select(null);
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // In the Banner view the keys belong to the banner.
    //
    // They did not: Ctrl+Z undid the SEAT design — invisible behind the
    // artboard, so a stroke disappeared from a surface nobody was looking at
    // and nothing on screen changed — and Delete removed the seat editor's
    // selection instead of the item picked on the banner.
    if (bannerActive()) {
      const b = bannerHost.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (b && mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) b.redo();
        else b.undo();
        refreshHistory();
        return;
      }
      if (b && mod && key === 'd') {
        e.preventDefault();
        b.duplicateSelected();
        refreshHistory();
        return;
      }
      if (b && (key === 'delete' || key === 'backspace')) {
        if (b.deleteSelected()) {
          e.preventDefault();
          refreshHistory();
        }
        return;
      }
      if (b && key.startsWith('arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
        if (b.nudge(dx, dy)) e.preventDefault();
        return;
      }
      // Mirror is a seat-editor idea; a banner has no stand axis to mirror on.
      if (key === 'm') return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      refreshHistory();
      return;
    }
    // The selected layer's keys — the ones Figma and Canva taught everyone.
    const layerSel = objects.selected;
    if (layerSel && !bannerActive()) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'd') {
        e.preventDefault();
        duplicateLayer(layerSel.id);
        return;
      }
      if (mod && (e.key === ']' || e.key === '[' || e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        const up = e.key === ']' || e.code === 'BracketRight';
        objects.reorder(layerSel.id, e.altKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward');
        return;
      }
      if (mod && e.shiftKey && key === 'h') {
        e.preventDefault();
        objects.update(layerSel.id, { hidden: !layerSel.hidden });
        return;
      }
      if (mod && e.shiftKey && key === 'l') {
        e.preventDefault();
        objects.update(layerSel.id, { locked: !layerSel.locked });
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        layersPanel?.startRename(layerSel.id);
        return;
      }
      if (editor.tool === 'select' && key.startsWith('arrow') && editor.selectedRegion.size === 0 && !layerSel.locked) {
        e.preventDefault();
        // One seat a press; ten with Shift.
        const step = e.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
        objects.update(layerSel.id, { cx: layerSel.cx + dx * EDITOR_UNITS.colPx, cy: layerSel.cy + dy * EDITOR_UNITS.rowPx });
        return;
      }
    }
    const k = e.key.toLowerCase();
    if (k === 'm') {
      mirrorChk.checked = !mirrorChk.checked;
      editor.mirror = mirrorChk.checked;
    }
    if (k === 'v') setTool('select');
    if ((k === 'delete' || k === 'backspace') && editor.tool === 'select') {
      if (editor.selectedRegion.size > 0) editor.deleteSelection();
      else objects.deleteSelected();
      return;
    }
    if (k === 't') setTool('text');
    if (k === 's') setTool('shape');
    if (k === 'b') setTool('brush');
    if (k === 'f') setTool('fill');
    if (k === 'e') setTool('eraser');
    if (k === 'i') setTool('eyedropper');
    if (k === ' ') setTool('pan');
  });
  window.addEventListener('keyup', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' && editor.tool === 'pan') setTool('brush');
  });

  // ---- Floodlight chrome ----

  // Panel collapse and zen mode.
  const panel = $('#panel');
  // Backdrop for the tablet slide-over: dims the canvas and taps to dismiss.
  const panelScrim = document.createElement('div');
  panelScrim.className = 'panel-scrim';
  document.querySelector('.workspace')?.appendChild(panelScrim);
  const closeSlideOver = (): void => {
    panel.classList.remove('open');
    panelScrim.classList.remove('show');
  };
  panelScrim.addEventListener('click', closeSlideOver);
  $('#panel-toggle').addEventListener('click', () => {
    // On tablet the panel is a slide-over (.open); on desktop it collapses (.collapsed).
    if (window.matchMedia('(max-width: 1099px)').matches) {
      closeSlideOver();
    } else {
      panel.classList.toggle('collapsed');
      requestAnimationFrame(() => {
        editor.app.resize();
        editor.fitToView();
      });
    }
  });

  // Tablet-only floating button to summon the slide-over panel.
  const fab = document.createElement('button');
  fab.className = 'panel-fab';
  fab.setAttribute('aria-label', 'Properties');
  fab.innerHTML = '<i class="ti ti-adjustments"></i>';
  fab.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    panelScrim.classList.toggle('show', open);
  });
  document.querySelector('.workspace')?.appendChild(fab);

  // ---- Mobile options sheet + AI front door (Mobile M4/M5) ----
  const mobileSheet = (): boolean => window.matchMedia('(max-width: 767px)').matches;
  openOptionsSheet = (): void => {
    if (!mobileSheet()) return;
    panel.classList.add('open');
    panelScrim.classList.add('show');
  };
  setOptionsSheet = (open: boolean): void => {
    if (!mobileSheet()) return;
    panel.classList.toggle('open', open);
    panelScrim.classList.toggle('show', open);
  };
  // On a phone, greet RETURNING users each fresh session with the AI "describe it"
  // front door. First-timers reach the AI via the guided tour instead, so skip it
  // for them (avoids opening the sheet behind the onboarding modal + tour).
  try {
    const onboardedBefore = localStorage.getItem('tifo_onboarded_v1') === '1';
    if (mobileSheet() && onboardedBefore && !sessionStorage.getItem('tifo_m5_intro')) {
      sessionStorage.setItem('tifo_m5_intro', '1');
      setPanelMode('ai');
      openOptionsSheet();
    }
  } catch {
    /* storage blocked — skip the one-time intro */
  }

  // Live cursor coordinates in stadium language (stand · section · row · seat).
  const coords = $('#coords');
  const STANDS = ['East', 'North', 'West', 'South'];
  // A ground in its real blocks says which block you are over, numbered along
  // its stand as the seat locator and the steward's sheets number it.
  const tplHere = templateById(map.templateRef.id);
  const blockInfo = tplHere && hasBlocks(tplHere) ? sectionInfo(map) : null;
  const BLOCK_STAND = { north: 'North', east: 'East', south: 'South', west: 'West' } as const;
  editor.onHoverSeat = (seat) => {
    if (seat < 0) {
      coords.textContent = '-';
      return;
    }
    const bi = blockInfo?.get(map.sectionOf[seat]);
    if (bi) {
      coords.textContent = `${BLOCK_STAND[bi.stand]}${bi.tier > 0 ? ' upper' : ''} · Block ${bi.number} · Row ${map.rowOf[seat] + 1} · Seat ${seat}`;
      return;
    }
    const u = map.uv[seat * 2];
    const stand = STANDS[Math.floor(((u + 0.125) % 1) * 4)];
    const sectionInStand = (map.sectionOf[seat] % 28) + 1;
    coords.textContent = `${stand} · Sec ${sectionInStand} · Row ${map.rowOf[seat] + 1} · Seat ${seat}`;
  };

  // Mini-map: live thumbnail + violet viewport rect, click/drag to navigate.
  const miniCanvas = $('#minimap-canvas') as unknown as HTMLCanvasElement;
  const miniViewport = $('#minimap-viewport');
  const miniCtx = miniCanvas.getContext('2d')!;
  const renderMiniMap = (): void => {
    const b64 = makeThumbnailB64(map, store);
    const img = new Image();
    img.onload = () => miniCtx.drawImage(img, 0, 0, miniCanvas.width, miniCanvas.height);
    img.src = `data:image/png;base64,${b64}`;
  };
  renderMiniMap();
  let miniMapDirty = false;
  store.onDirty(() => {
    if (miniMapDirty) return;
    miniMapDirty = true;
    requestAnimationFrame(() => {
      miniMapDirty = false;
      renderMiniMap();
    });
  });
  editor.onViewChange = (u0, v0, u1, v1, zoom) => {
    const cw = miniCanvas.clientWidth || miniCanvas.width;
    const ch = miniCanvas.clientHeight || miniCanvas.height;
    const cl = Math.max(0, Math.min(1, u0));
    const ct = Math.max(0, Math.min(1, v0));
    const cr = Math.max(0, Math.min(1, u1));
    const cb = Math.max(0, Math.min(1, v1));
    miniViewport.style.left = `${5 + cl * cw}px`;
    miniViewport.style.top = `${5 + ct * ch}px`;
    miniViewport.style.width = `${(cr - cl) * cw}px`;
    miniViewport.style.height = `${(cb - ct) * ch}px`;
    $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  };
  const miniNavigate = (e: PointerEvent): void => {
    const r = miniCanvas.getBoundingClientRect();
    editor.centerOn((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  miniCanvas.addEventListener('pointerdown', (e) => {
    miniCanvas.setPointerCapture(e.pointerId);
    miniNavigate(e);
  });
  miniCanvas.addEventListener('pointermove', (e) => {
    if (e.buttons) miniNavigate(e);
  });

  // Zoom pill buttons.
  $('#zoom-in').addEventListener('click', () => (bannerActive() ? bannerHost.current?.zoomBy(1.25) : editor.zoomBy(1.25)));
  $('#zoom-out').addEventListener('click', () => (bannerActive() ? bannerHost.current?.zoomBy(0.8) : editor.zoomBy(0.8)));

  // Legibility chip in the status bar mirrors message styling.
  const chip = $('#message');
  const baseLegibility = $('#legibility');
  baseLegibility.addEventListener('click', () => {
    requestAnimationFrame(() => {
      chip.className = chip.textContent && chip.textContent.includes('vanish') ? 'legible-chip warn' : 'legible-chip ok';
    });
  });

  editor.emitView();

  // ---- Layers: the selected layer's properties, the Layers list, the action bar ----
  const overlay = editor.objectOverlay!;
  const objEmpty = $('#obj-empty');
  const objControls = $('#obj-controls');
  const objKind = $('#obj-kind');
  const objX = $('#obj-x') as unknown as HTMLInputElement;
  const objY = $('#obj-y') as unknown as HTMLInputElement;
  const objHeight = $('#obj-height') as unknown as HTMLInputElement;
  const objHeightOut = $('#obj-height-out');
  const objTier = $('#obj-tier') as unknown as HTMLSelectElement;
  const objRot = $('#obj-rot') as unknown as HTMLInputElement;
  const objKeep = $('#obj-keep') as unknown as HTMLSelectElement;
  const objTouched = $('#obj-touched');
  const objTextRow = $('#obj-text-row');
  const objText = $('#obj-text') as unknown as HTMLInputElement;
  const objFont = $('#obj-font') as unknown as HTMLSelectElement;
  const objColorRow = $('#obj-color-row');
  const objColors = $('#obj-colors');
  const objPicRow = $('#obj-pic-row');
  const objCutout = $('#obj-cutout') as unknown as HTMLInputElement;
  const objDither = $('#obj-dither') as unknown as HTMLInputElement;
  for (const f of TIFO_FONTS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    objFont.appendChild(opt);
  }

  // Visibility of ctx-objects / ctx-brush is now driven by the contextual panel
  // controller (data-panel). This hook is retained only as a no-op anchor so the
  // existing call sites keep working; content refresh happens in refreshObjectPanel.
  const syncObjectPanelVisibility = (): void => {
    /* contextual panel controller manages section visibility */
  };
  objectPanelHook = syncObjectPanelVisibility;

  // ---- magic-wand region selection UI (select tool) ----
  const regionActions = document.getElementById('region-actions') as HTMLElement | null;
  const regionCount = document.getElementById('region-count');
  const objEmptyEl = document.getElementById('obj-empty') as HTMLElement | null;
  editor.onSelectionChange = (count: number): void => {
    if (regionActions) regionActions.hidden = count === 0;
    if (regionCount) regionCount.textContent = count.toLocaleString();
    // Hide the "no object" hint while a region is selected.
    if (objEmptyEl && count > 0) objEmptyEl.hidden = true;
    else if (objEmptyEl && !objects.selected) objEmptyEl.hidden = false;
  };
  document.getElementById('region-recolor')?.addEventListener('click', () => {
    editor.recolorSelection(editor.colorIndex);
  });
  document.getElementById('region-delete')?.addEventListener('click', () => {
    editor.deleteSelection();
  });
  document.getElementById('region-clear')?.addEventListener('click', () => {
    editor.clearSelection();
  });
  // Make movable: painted seats become a layer — the way out for a design
  // that was baked before layers existed, and for the AI's lettering.
  document.getElementById('region-lift')?.addEventListener('click', () => {
    if (!composer || editor.selectedRegion.size === 0) return;
    const lifted = composer.lift(editor.selectedRegion);
    if (!lifted) {
      message.textContent = i18nT('ly.msg.liftNone');
      return;
    }
    editor.clearSelection();
    setTool('select');
    objects.select(lifted.id);
    message.textContent = i18nT('ly.msg.lifted');
  });

  const keepValue = (o: { keep?: { stand: string; stands?: string[] } | null }): string =>
    !o.keep ? 'all' : o.keep.stands?.length ? 'custom' : o.keep.stand;

  const refreshObjectPanel = (): void => {
    const sel = objects.selected;
    objControls.hidden = !sel;
    objEmpty.hidden = !!sel;
    if (!sel) {
      objKind.textContent = '';
      return;
    }
    objKind.textContent = layerName(sel);
    // Height shown in seats: derive from current footprint.
    const heightSeats = Math.round(sel.height / EDITOR_UNITS.rowPx);
    objHeight.value = String(Math.max(4, Math.min(120, heightSeats)));
    objHeightOut.textContent = String(heightSeats);
    // Shown in seats and rows, the units the rest of the panel already uses.
    objX.value = String(Math.round(sel.cx / EDITOR_UNITS.colPx));
    objY.value = String(Math.round(sel.cy / EDITOR_UNITS.rowPx));
    objTier.value = sel.tier === null ? 'both' : String(sel.tier);
    if (document.activeElement !== objRot) objRot.value = String(Math.round(sel.rotation));
    const kv = keepValue(sel);
    const custom = objKeep.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (custom) custom.hidden = kv !== 'custom';
    objKeep.value = kv;
    objTouched.hidden = !sel.touch;
    objTextRow.hidden = sel.kind !== 'text';
    if (sel.kind === 'text') {
      if (document.activeElement !== objText) objText.value = sel.text;
      if (![...objFont.options].some((o) => o.value === sel.fontId)) {
        const opt = document.createElement('option');
        opt.value = sel.fontId;
        opt.textContent = sel.fontId;
        objFont.appendChild(opt);
      }
      objFont.value = sel.fontId;
    }
    objColorRow.hidden = sel.kind !== 'text' && sel.kind !== 'shape';
    if (!objColorRow.hidden) renderObjColors(sel.colorIndex);
    objPicRow.hidden = sel.kind !== 'image';
    if (sel.kind === 'image') {
      objCutout.checked = !!sel.cutout;
      objDither.checked = !!sel.dither;
    }
    for (const id of ['obj-x', 'obj-y', 'obj-height', 'obj-rot', 'obj-rot-reset', 'obj-tier', 'obj-keep', 'obj-back', 'obj-front', 'obj-merge', 'obj-text', 'obj-font', 'obj-cutout', 'obj-dither']) {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) el.disabled = !!sel.locked;
    }
  };

  /** The design's colours, for a text or shape layer to be recoloured with. */
  function renderObjColors(active: number): void {
    objColors.textContent = '';
    store.palette.forEach((hex, idx) => {
      if (idx === 0) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ly-swatch${idx === active ? ' on' : ''}`;
      b.style.background = hex;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(idx === active));
      b.setAttribute('aria-label', hex);
      b.addEventListener('click', () => {
        const sel = objects.selected;
        if (sel && !sel.locked) objects.update(sel.id, { colorIndex: idx });
      });
      objColors.appendChild(b);
    });
  }
  store.onPaletteChange(() => refreshObjectPanel());

  // Editing what a text layer says: it re-draws as you type, keeps its height,
  // and the whole edit is one undo step.
  let textEditing = false;
  objText.addEventListener('input', () => {
    const sel = objects.selected;
    if (!sel || sel.kind !== 'text' || sel.locked) return;
    const words = objText.value;
    if (!words.trim()) return;
    if (!textEditing) {
      textEditing = true;
      objects.beginGesture(false);
    }
    const r = renderTextCanvas(words, sel.fontCss, sel.arcDeg);
    if (!r) return;
    objects.mutate(sel.id, { text: words, width: sel.height * (r.canvas.width / r.canvas.height) } as Partial<typeof sel>);
  });
  objText.addEventListener('change', () => {
    if (!textEditing) return;
    textEditing = false;
    objects.endGesture();
  });
  objFont.addEventListener('change', async () => {
    const sel = objects.selected;
    if (!sel || sel.kind !== 'text') return;
    await loadTifoFonts();
    const fontCss = TIFO_FONTS.find((f) => f.id === objFont.value)?.css ?? sel.fontCss;
    const r = renderTextCanvas(sel.text, fontCss, sel.arcDeg);
    const patch: Record<string, unknown> = { fontId: objFont.value, fontCss };
    if (r) patch.width = sel.height * (r.canvas.width / r.canvas.height);
    objects.update(sel.id, patch as Partial<typeof sel>);
  });
  objCutout.addEventListener('change', () => {
    const sel = objects.selected;
    if (sel?.kind === 'image') objects.update(sel.id, { cutout: objCutout.checked } as Partial<typeof sel>);
  });
  objDither.addEventListener('change', () => {
    const sel = objects.selected;
    if (sel?.kind === 'image') objects.update(sel.id, { dither: objDither.checked } as Partial<typeof sel>);
  });

  objects.onChange(() => {
    refreshObjectPanel();
    refreshHistory();
  });
  overlay.sync();
  refreshObjectPanel();
  // Double-clicking a text layer goes straight to its words.
  editor.app.canvas.addEventListener('dblclick', () => {
    const sel = objects.selected;
    if (editor.tool !== 'select' || sel?.kind !== 'text' || sel.locked) return;
    objText.focus();
    objText.select();
  });

  // Resize via a handle pushes height back into the panel slider.
  editor.onObjectResize = (heightEditor) => {
    objHeightOut.textContent = String(Math.round(heightEditor / EDITOR_UNITS.rowPx));
  };

  // The height slider rescales the selected layer about its centre, keeping its
  // shape. One undo step per slide, not one per notch.
  let sliding = false;
  objHeight.addEventListener('input', () => {
    const sel = objects.selected;
    if (!sel || sel.locked) return;
    if (!sliding) {
      sliding = true;
      objects.beginGesture();
    }
    objHeightOut.textContent = objHeight.value;
    const newH = Number(objHeight.value) * EDITOR_UNITS.rowPx;
    const aspect = sel.width / sel.height;
    objects.mutateSelected({ height: newH, width: newH * aspect });
  });
  objHeight.addEventListener('change', () => {
    if (!sliding) return;
    sliding = false;
    objects.endGesture();
  });
  /** Move the selection to the typed position - the non-drag path required by 2.5.7. */
  const applyObjectPosition = (): void => {
    const sel = objects.selected;
    if (!sel) return;
    const x = Number(objX.value), y = Number(objY.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    objects.update(sel.id, { cx: x * EDITOR_UNITS.colPx, cy: y * EDITOR_UNITS.rowPx });
  };
  objX.addEventListener('change', applyObjectPosition);
  objY.addEventListener('change', applyObjectPosition);
  objRot.addEventListener('change', () => {
    const sel = objects.selected;
    const v = Number(objRot.value);
    if (!sel || !Number.isFinite(v)) return;
    objects.update(sel.id, { rotation: ((((v + 180) % 360) + 360) % 360) - 180 });
  });
  $('#obj-rot-reset').addEventListener('click', () => {
    const sel = objects.selected;
    if (sel) objects.update(sel.id, { rotation: 0 });
  });

  objTier.addEventListener('change', () => {
    const sel = objects.selected;
    if (sel) objects.update(sel.id, { tier: objTier.value === 'both' ? null : Number(objTier.value) });
  });
  objKeep.addEventListener('change', () => {
    const sel = objects.selected;
    if (!sel || objKeep.value === 'custom') return;
    objects.update(sel.id, {
      keep: objKeep.value === 'all' ? null : { stand: objKeep.value as 'north' | 'south' | 'east' | 'west', tier: 'all' },
    });
  });
  $('#obj-back').addEventListener('click', () => objects.reorderSelected('back'));
  $('#obj-front').addEventListener('click', () => objects.reorderSelected('front'));
  $('#obj-dup').addEventListener('click', () => {
    const sel = objects.selected;
    if (sel) duplicateLayer(sel.id);
  });
  $('#obj-delete').addEventListener('click', () => objects.deleteSelected());
  $('#obj-clear-touch').addEventListener('click', () => {
    const sel = objects.selected;
    if (sel) objects.update(sel.id, { touch: null });
  });

  const duplicateLayer = (id: string): void => {
    const o = objects.get(id);
    if (o?.kind === 'image' && objects.pictureCount() >= MAX_PICTURES) {
      message.textContent = tv('ly.msg.pictureLimit', { n: MAX_PICTURES });
      return;
    }
    objects.duplicate(id);
  };

  /** Merge a layer into the paint: the old Bake, now a choice rather than a toll. */
  const mergeLayer = (id: string): void => {
    if (!composer) return;
    const o = objects.get(id);
    if (!o) return;
    const name = layerName(o);
    const n = composer.merge(id);
    refreshHistory();
    message.textContent = tv('ly.msg.merged', { name, n: n.toLocaleString() });
  };
  $('#obj-merge').addEventListener('click', () => {
    const sel = objects.selected;
    if (sel) mergeLayer(sel.id);
  });

  // The Layers list.
  const layersPanel = composer
    ? mountLayersPanel({
      objects,
      composer,
      store,
      editor,
      list: $('#layers-list'),
      empty: $('#layers-empty'),
      tag: $('#layers-tag'),
      bannerCount: () => sceneIO?.bannerCount?.() ?? 0,
      onOpenBanners: () => document.getElementById('view-banner')?.click(),
      onPick: (id) => {
        if (bannerActive()) document.getElementById('view-2d')?.click();
        if (editor.tool !== 'select') setTool('select');
        objects.select(id);
        // A layer picked in the list is brought into view if it is off screen.
        const o = objects.get(id);
        if (o && !editor.isWorldVisible(o.cx, o.cy)) editor.centerOnWorld(o.cx, o.cy);
      },
      onMerge: mergeLayer,
    })
    : null;
  sceneIO?.onChange?.(() => layersPanel?.render());

  // ---- the floating action bar: the selected layer's common actions, above it ----
  const actionBar = document.createElement('div');
  actionBar.className = 'ly-actionbar';
  actionBar.setAttribute('role', 'toolbar');
  actionBar.setAttribute('aria-label', i18nT('ly.actionsA'));
  actionBar.hidden = true;
  const barBtn = (icon: string, key: string, run: () => void, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>`;
    b.dataset.key = key;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    actionBar.appendChild(b);
    return b;
  };
  const withSel = (fn: (id: string) => void) => (): void => {
    const sel = objects.selected;
    if (sel) fn(sel.id);
  };
  barBtn('ti-copy', 'ly.duplicateT', withSel(duplicateLayer));
  barBtn('ti-stack-front', 'ly.forwardT', withSel((id) => objects.reorder(id, 'forward')));
  barBtn('ti-stack-back', 'ly.backwardT', withSel((id) => objects.reorder(id, 'backward')));
  const lockBtn = barBtn('ti-lock-open', 'ly.lockT', withSel((id) => objects.update(id, { locked: !objects.get(id)?.locked })));
  barBtn('ti-arrow-merge', 'ly.mergeT', withSel(mergeLayer));
  barBtn('ti-trash', 'ed.obj.deleteT', withSel((id) => objects.remove(id)), 'danger');
  const labelActionBar = (): void => {
    for (const b of actionBar.querySelectorAll<HTMLButtonElement>('button')) {
      const text = i18nT(b.dataset.key!);
      b.title = text;
      b.setAttribute('aria-label', text);
    }
  };
  labelActionBar();
  document.querySelector('.canvas-wrap')?.appendChild(actionBar);
  let gestureActive = false;
  const placeActionBar = (): void => {
    const sel = objects.selected;
    const show = !!sel && !sel.hidden && editor.tool === 'select' && !gestureActive && !bannerActive() && !document.body.classList.contains('m-shell');
    if (!show || !sel) {
      actionBar.hidden = true;
      return;
    }
    const locked = !!sel.locked;
    lockBtn.innerHTML = `<i class="ti ${locked ? 'ti-lock' : 'ti-lock-open'}" aria-hidden="true"></i>`;
    lockBtn.dataset.key = locked ? 'ly.unlockT' : 'ly.lockT';
    lockBtn.classList.toggle('on', locked);
    labelActionBar();
    for (const b of actionBar.querySelectorAll<HTMLButtonElement>('button')) {
      if (b !== lockBtn && b.dataset.key !== 'ly.duplicateT') b.disabled = locked;
    }
    const bounds = overlay.boundsOf(sel.id);
    const wrap = actionBar.parentElement?.getBoundingClientRect();
    if (!bounds || !wrap) {
      actionBar.hidden = true;
      return;
    }
    const [lx, ty] = editor.worldToClient(bounds.minX, bounds.minY);
    const [rx] = editor.worldToClient(bounds.maxX, bounds.minY);
    actionBar.hidden = false;
    const bw = actionBar.offsetWidth;
    const bh = actionBar.offsetHeight;
    let x = (lx + rx) / 2 - wrap.left - bw / 2;
    let y = ty - wrap.top - bh - 12;
    const [, by] = editor.worldToClient(bounds.minX, bounds.maxY);
    if (y < 8) y = by - wrap.top + 12; // no room above: under it
    x = Math.max(8, Math.min(wrap.width - bw - 8, x));
    y = Math.max(8, Math.min(wrap.height - bh - 8, y));
    actionBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  overlay.onGesture = (active) => {
    gestureActive = active;
    placeActionBar();
  };
  objectPanelHook = placeActionBar; // a tool change shows or hides it
  objects.onChange(placeActionBar);
  editor.addViewListener(placeActionBar);
  document.addEventListener('tifo:view', placeActionBar);
  window.addEventListener('resize', placeActionBar);

  // ---- painting names what it paints on ----
  // "Tools edit what is on top": a stroke over a picture touches up the
  // picture. The label beside the cursor says so before the stroke lands.
  const paintTarget = document.createElement('div');
  paintTarget.className = 'ly-paint-target';
  paintTarget.hidden = true;
  paintTarget.setAttribute('aria-hidden', 'true');
  document.body.appendChild(paintTarget);
  editor.onHoverLayer = (obj, x, y) => {
    if (!obj || document.body.classList.contains('m-shell')) {
      paintTarget.hidden = true;
      return;
    }
    const key = obj.locked ? 'ly.target.locked' : editor.tool === 'eraser' ? 'ly.target.erase' : 'ly.target.touch';
    paintTarget.textContent = tv(key, { name: layerName(obj) });
    paintTarget.classList.toggle('locked', !!obj.locked);
    paintTarget.hidden = false;
    paintTarget.style.transform = `translate(${Math.round(x + 16)}px, ${Math.round(y + 18)}px)`;
  };
  editor.app.canvas.addEventListener('pointerup', () => {
    // A stroke that met a locked layer says why nothing happened.
    const hit = composer?.lockedHit;
    if (hit) {
      message.textContent = tv('ly.msg.lockedStroke', { name: layerName(hit) });
      composer!.lockedHit = null;
    }
  });

  syncObjectPanelVisibility();

  // ---- Section navigator: grouped clickable strip, zoom-to-section ----
  const sectionNav = $('#section-nav');
  {
    // Group seat indices by section, and each section by stand (from mean u).
    const bySection = new Map<number, number[]>();
    for (let i = 0; i < map.count; i++) {
      const s = map.sectionOf[i];
      let arr = bySection.get(s);
      if (!arr) { arr = []; bySection.set(s, arr); }
      arr.push(i);
    }
    const stands: Record<string, { id: number; seats: number[]; u: number }[]> = { North: [], East: [], South: [], West: [] };
    const standName = (u: number): string => ['East', 'North', 'West', 'South'][Math.floor(((u + 0.125) % 1) * 4)];
    for (const [id, seats] of bySection) {
      // A ground in its real blocks: the stand and number every other label
      // gives the block (lower tier first, then upper, left to right).
      const bi = blockInfo?.get(id);
      if (bi) {
        stands[BLOCK_STAND[bi.stand]].push({ id, seats, u: bi.tier * 1000 + bi.number });
        continue;
      }
      let uSum = 0;
      for (const i of seats) uSum += map.uv[i * 2];
      const u = uSum / seats.length;
      stands[standName(u)].push({ id, seats, u });
    }
    for (const stand of ['North', 'East', 'South', 'West']) {
      const group = stands[stand];
      if (group.length === 0) continue;
      group.sort((a, b) => a.u - b.u);
      const wrap = document.createElement('div');
      wrap.className = 'section-stand';
      const label = document.createElement('div');
      label.className = 'section-stand-label';
      label.textContent = tl(stand);
      const cells = document.createElement('div');
      cells.className = 'section-cells';
      group.forEach((sec, n) => {
        const c = document.createElement('button');
        c.className = 'section-cell';
        // A real block keeps its own number; an upper-tier one is marked U.
        const bi = blockInfo?.get(sec.id);
        const num = bi ? `${bi.tier > 0 ? 'U' : ''}${bi.number}` : String(n + 1);
        c.textContent = num;
        c.title = `${tl(stand)} ${i18nT('ed.section')} ${num} · ${sec.seats.length.toLocaleString()} ${i18nT('ed.seats')}`;
        c.addEventListener('click', () => {
          editor.zoomToSeats(sec.seats);
          message.textContent = `${tl(stand)} ${i18nT('ed.section')} ${num}: ${sec.seats.length.toLocaleString()} ${i18nT('ed.seats')}`;
        });
        cells.appendChild(c);
      });
      wrap.append(label, cells);
      sectionNav.appendChild(wrap);
    }
  }

  // ---- Animation: reveal player + GIF export ----
  const revealSel = $('#reveal-preset') as unknown as HTMLSelectElement;
  for (const r of REVEAL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = tl(r.id);
    revealSel.appendChild(opt);
  }
  // Default the reveal to right → left, the standard tifo sweep direction.
  revealSel.value = 'sweep-rl';
  const playBtn = $('#reveal-play') as unknown as HTMLButtonElement;
  const scrub = $('#reveal-scrub') as unknown as HTMLInputElement;
  const durSlider = $('#reveal-dur') as unknown as HTMLInputElement;
  const durOut = $('#reveal-dur-out');
  // The drum call's own row: what it is, its drum, and a count you can see.
  const drumRow = root.querySelector<HTMLElement>('#reveal-drum');
  const drumSound = root.querySelector<HTMLInputElement>('#reveal-drum-sound');
  const beatDots = Array.from(root.querySelectorAll<HTMLElement>('#reveal-beats i'));
  const drum = new DrumTrack();
  const drumOn = (): boolean => player.revealId === 'drum-call' && (drumSound?.checked ?? true);

  const showBeat = (): void => {
    const plan = player.drumPlan();
    const b = plan ? drumCallBeat(plan, player.seconds) : { count: 0, phase: null, pulse: 0 };
    beatDots.forEach((d, i) => {
      d.classList.toggle('on', i < b.count);
      d.classList.toggle('hit', i === b.count - 1 && b.pulse > 0.55);
      d.dataset.phase = b.phase ?? '';
    });
  };

  const setPlayLabel = (playing: boolean): void => {
    playBtn.innerHTML = playing
      ? `<i class="ti ti-player-pause"></i> <span>${i18nT('ed.reveal.pause')}</span>`
      : `<i class="ti ti-player-play"></i> <span>${i18nT('ed.reveal.play')}</span>`;
  };

  const player = new RevealPlayer(map, revealSel.value as RevealId, (clock, playing) => {
    // Clock 1 used to mean "done, just draw the design". The drum call ends
    // with every card back down, so its last frame is drawn like the rest.
    const vis = clock >= 1 && !revealEndsHidden(player.revealId) ? null : (seat: number) => player.visibilityAt(seat);
    editor.applyReveal(vis);
    // Drive the 3D stadium too, so the reveal plays in whichever view is open.
    getPreview?.()?.applyReveal(vis);
    scrub.value = String(Math.round(clock * 100));
    setPlayLabel(playing);
    showBeat();
  });

  /**
   * The length control means something different for the drum call. Its hits
   * land on a real beat, so it cannot be squeezed into two seconds; what the
   * length buys is how long the picture is held up between the two counts.
   */
  const syncRevealKind = (): void => {
    const isDrum = player.revealId === 'drum-call';
    if (drumRow) drumRow.hidden = !isDrum;
    const [min, max] = isDrum ? [DRUM_CALL_MIN_LENGTH, 16] : [2, 10];
    // Read before narrowing the range: the browser clamps the value to a new
    // min on the spot, so a 4 s wipe would come back as exactly the minimum.
    let v = Number(durSlider.value);
    durSlider.min = String(min);
    durSlider.max = String(max);
    if (isDrum && v < min) v = 9;
    v = Math.max(min, Math.min(max, v));
    durSlider.value = String(v);
    player.durationSec = v;
    durOut.textContent = `${v}s`;
    if (!isDrum) drum.stop();
    showBeat();
  };

  // A partial reveal is a transient preview — any edit snaps back to the full
  // design so painting/filling never fights the dim overlay.
  editor.onEditWhileRevealed = () => {
    drum.stop();
    player.reset();
    editor.applyReveal(null);
    getPreview?.()?.applyReveal(null);
    scrub.value = '0';
  };

  revealSel.addEventListener('change', () => {
    drum.stop();
    if (player.isPlaying) player.pause();
    player.setReveal(map, revealSel.value as RevealId);
    syncRevealKind();
    player.seek(Number(scrub.value) / 100);
  });
  playBtn.addEventListener('click', () => {
    if (player.isPlaying) {
      drum.stop();
      player.pause();
      return;
    }
    // Played from the end, the player starts over — so does the drum.
    const plan = player.drumPlan();
    const from = player.currentClock >= 1 ? 0 : player.seconds;
    if (plan && drumOn()) drum.play(plan.hits, from);
    player.play();
  });
  drumSound?.addEventListener('change', () => {
    if (!drumSound.checked) drum.stop();
    else if (player.isPlaying) {
      const plan = player.drumPlan();
      if (plan) drum.play(plan.hits, player.seconds);
    }
  });
  $('#reveal-reset').addEventListener('click', () => {
    drum.stop();
    player.reset();
    editor.applyReveal(null);
    getPreview?.()?.applyReveal(null);
  });
  scrub.addEventListener('input', () => {
    drum.stop();
    if (player.isPlaying) player.pause();
    player.seek(Number(scrub.value) / 100);
  });
  durSlider.addEventListener('input', () => {
    drum.stop();
    if (player.isPlaying) player.pause();
    player.durationSec = Number(durSlider.value);
    durOut.textContent = `${durSlider.value}s`;
    player.seek(Number(scrub.value) / 100);
  });
  syncRevealKind();

  const gifBtn = $('#reveal-gif') as unknown as HTMLButtonElement;
  gifBtn.addEventListener('click', async () => {
    gifBtn.disabled = true;
    gifBtn.textContent = 'Encoding…';
    try {
      const { exportRevealGifAsync } = await import('../workers/client');
      // The drum call is on a real beat, so its GIF plays in real time; the
      // others have always played at double speed, and still do.
      const isDrum = player.revealId === 'drum-call';
      const blob = await exportRevealGifAsync(map, store, {
        reveal: revealSel.value as RevealId,
        frames: Math.round(player.durationSec * (isDrum ? 12 : 9)),
        fps: isDrum ? 12 : 18,
        lengthSec: player.durationSec,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${docTitle.value.trim() || 'tifo'}-reveal.gif`;
      a.click();
      URL.revokeObjectURL(url);
      message.textContent = tv('ed.msg.gifExported', { kb: (blob.size / 1024).toFixed(0) });
    } catch (err) {
      message.textContent = tv('ed.msg.gifFailed', { err: (err as Error).message });
    } finally {
      gifBtn.disabled = false;
      gifBtn.innerHTML = '<i class="ti ti-gif"></i> Export GIF';
    }
  });

  // ---- Stadium animation export (3D video / GIF, with preview) ----
  const sxFormat = $('#sx-format') as unknown as HTMLSelectElement;
  const sxGifRow = root.querySelector<HTMLElement>('#sx-gif-size-row');
  const sxGifWidth = $('#sx-gif-width') as unknown as HTMLSelectElement;
  const sxNoshow = $('#sx-noshow') as unknown as HTMLInputElement;
  const sxPreviewBtn = $('#sx-preview') as unknown as HTMLButtonElement;
  const sxExportBtn = $('#sx-export') as unknown as HTMLButtonElement;
  const sxStatus = root.querySelector<HTMLElement>('#sx-status');
  const sxSay = (t: string): void => {
    if (sxStatus) sxStatus.textContent = t;
  };
  const syncFormatRows = (): void => {
    if (sxGifRow) sxGifRow.hidden = sxFormat.value !== 'gif';
  };
  sxFormat.addEventListener('change', syncFormatRows);
  syncFormatRows();

  const buildExportOpts = (forGif: boolean): StadiumExportOpts => ({
    reveal: revealSel.value as RevealId,
    durationSec: player.durationSec,
    fps: forGif ? 15 : 30,
    noShows: sxNoshow.checked,
    watermark: 'tifomaker.org',
    gifWidth: forGif ? Number(sxGifWidth.value) : undefined,
    drum: !forGif && drumOn() ? drum : null,
  });

  // The 3D bowl only renders inside a visible, sized host, so switch to the
  // Stadium view and wait for the lazily-created preview before capturing.
  const ensureStadiumPreview = async (): Promise<Preview3D | null> => {
    (root.querySelector('#view-3d') as HTMLButtonElement | null)?.click();
    let p = getPreview?.() ?? null;
    for (let i = 0; i < 60 && !p; i++) {
      await new Promise((r) => setTimeout(r, 50));
      p = getPreview?.() ?? null;
    }
    if (p) await new Promise((r) => setTimeout(r, 80)); // let it size + paint once
    return p;
  };

  const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runExport = async (preview: Preview3D, say: (t: string) => void): Promise<void> => {
    const forGif = sxFormat.value === 'gif';
    const name = `${docTitle.value.trim() || 'tifo'}-stadium`;
    if (forGif) {
      say('Encoding GIF…');
      const blob = await exportStadiumGif(preview, map, store, buildExportOpts(true));
      downloadBlob(blob, `${name}.gif`);
      say(`GIF exported (${(blob.size / 1024).toFixed(0)} KB)`);
    } else {
      if (!videoExportSupported()) {
        say('Video capture is not supported in this browser, switch Format to GIF.');
        return;
      }
      say('Recording video…');
      const { blob, extension, universal } = await exportStadiumVideo(preview, map, buildExportOpts(false));
      downloadBlob(blob, `${name}.${extension}`);
      say(`Video exported (${(blob.size / 1024).toFixed(0)} KB)`
        + (universal ? '' : ' — this browser could not record H.264, so it may not open everywhere.'));
    }
  };

  sxPreviewBtn.addEventListener('click', async () => {
    sxPreviewBtn.disabled = true;
    sxSay('Preparing the stadium…');
    try {
      const preview = await ensureStadiumPreview();
      if (!preview) {
        sxSay('Could not start the 3D stadium preview.');
        return;
      }
      const opts = buildExportOpts(sxFormat.value === 'gif');
      const backdrop = document.createElement('div');
      backdrop.className = 'sx-backdrop';
      backdrop.innerHTML = `
        <div class="sx-modal" role="dialog" aria-modal="true" aria-label="Stadium animation preview">
          <button class="sx-close" aria-label="Close">&times;</button>
          <h3>Animation preview</h3>
          <p class="sx-lead">Exactly what will be exported, watermark included.</p>
          <canvas class="sx-canvas"></canvas>
          <div class="sx-actions">
            <button id="sx-modal-download" class="primary"><i class="ti ti-download"></i> Download ${sxFormat.value === 'gif' ? 'GIF' : 'video'}</button>
            <button id="sx-modal-replay">Replay</button>
          </div>
          <p class="sx-msg" id="sx-modal-msg"></p>
        </div>`;
      document.body.appendChild(backdrop);
      const close = (): void => backdrop.remove();
      backdrop.querySelector('.sx-close')!.addEventListener('click', close);
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) close();
      });
      const cv = backdrop.querySelector('.sx-canvas') as HTMLCanvasElement;
      const ctx = cv.getContext('2d')!;
      const modalMsg = backdrop.querySelector('#sx-modal-msg') as HTMLElement;
      await previewStadium(preview, map, opts, ctx);
      backdrop.querySelector('#sx-modal-replay')!.addEventListener('click', () => {
        void previewStadium(preview, map, buildExportOpts(sxFormat.value === 'gif'), ctx);
      });
      const dlBtn = backdrop.querySelector('#sx-modal-download') as HTMLButtonElement;
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        try {
          await runExport(preview, (t) => {
            modalMsg.textContent = t;
          });
        } catch (err) {
          modalMsg.textContent = `Export failed: ${(err as Error).message}`;
        } finally {
          dlBtn.disabled = false;
        }
      });
      sxSay('');
    } catch (err) {
      sxSay(`Preview failed: ${(err as Error).message}`);
    } finally {
      sxPreviewBtn.disabled = false;
    }
  });

  sxExportBtn.addEventListener('click', async () => {
    sxExportBtn.disabled = true;
    try {
      const preview = await ensureStadiumPreview();
      if (!preview) {
        sxSay('Could not start the 3D stadium preview.');
        return;
      }
      await runExport(preview, sxSay);
    } catch (err) {
      sxSay(`Export failed: ${(err as Error).message}`);
    } finally {
      sxExportBtn.disabled = false;
    }
  });

  // ---- Production export: distribution PDF (server) + seat manifest CSV (client) ----
  const bagSize = $('#bag-size') as unknown as HTMLInputElement;
  const colorNamesFor = (): string[] => {
    // Use the live palette hex as fallback names; index 0 is the empty seat.
    return store.palette.map((hex, i) => (i === 0 ? 'Empty seat' : `Color ${i} (${hex})`));
  };

  const pdfBtn = $('#export-pdf') as unknown as HTMLButtonElement;
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true;
    const original = pdfBtn.innerHTML;
    pdfBtn.textContent = 'Generating…';
    try {
      const { exportDistributionPdf } = await import('../net/api');
      const blob = await exportDistributionPdf(store, map, {
        title: docTitle.value.trim() || 'Tifo',
        cardsPerBag: Math.max(10, Number(bagSize.value) || 100),
        colorNames: colorNamesFor(),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(docTitle.value.trim() || 'tifo').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-distribution.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      track('exported', { once: false }); // bottom of funnel; count every export
      message.textContent = isSignedIn()
        ? `distribution PDF exported (${(blob.size / 1024).toFixed(0)} KB)`
        : `distribution PDF exported: sign in for a clean, watermark-free version`;
    } catch (err) {
      message.textContent = tv('ed.msg.pdfFailed', { err: (err as Error).message });
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.innerHTML = original;
    }
  });

  const csvBtn = $('#export-csv') as unknown as HTMLButtonElement;
  csvBtn.addEventListener('click', async () => {
    const { seatManifestCsv } = await import('../core/production');
    const csv = seatManifestCsv(store.cells, store.palette, map, {
      colorNames: colorNamesFor(),
      includeEmpty: false,
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(docTitle.value.trim() || 'tifo').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-seats.csv`;
    a.click();
    URL.revokeObjectURL(url);
    const rows = csv.split('\n').length - 1;
    track('exported', { once: false });
    message.textContent = tv('ed.msg.manifestExported', { n: rows.toLocaleString() });
  });

  // Fan QR code: one stadium-wide code that points at /s/:id. Fans scan it,
  // pick their seat, and see exactly which card to hold. Needs a saved design.
  const qrBtn = $('#export-qr') as unknown as HTMLButtonElement;
  qrBtn.addEventListener('click', async () => {
    if (!designId) {
      message.textContent = i18nT('ed.msg.saveBeforeQr');
      return;
    }
    const url = `${location.origin}/s/${designId}`;
    try {
      const QR = (await import('qrcode')).default;
      const dataUrl = await QR.toDataURL(url, { width: 720, margin: 2, color: { dark: '#0E0A1A', light: '#FFFFFF' } });
      openQrDialog(dataUrl, url, docTitle.value.trim() || 'Tifo');
    } catch {
      message.textContent = i18nT('ed.msg.qrFailed');
    }
  });

  function openQrDialog(dataUrl: string, url: string, name: string): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'qr-backdrop';
    backdrop.innerHTML = `
      <div class="qr-modal" role="dialog" aria-modal="true">
        <button class="qr-close" aria-label="Close">&times;</button>
        <h3 class="qr-h3">Fan QR code</h3>
        <p class="qr-lead">Print this on the cards, banners, or the big screen. Fans scan it, pick their seat, and see exactly which colour to hold up.</p>
        <img class="qr-img" src="${dataUrl}" alt="QR code for ${escapeHtml(name)}" />
        <div class="qr-url">${escapeHtml(url)}</div>
        <div class="qr-actions">
          <button class="primary" id="qr-download"><i class="ti ti-download"></i> Download PNG</button>
          <button id="qr-copy"><i class="ti ti-link"></i> Copy link</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = (): void => backdrop.remove();
    backdrop.querySelector('.qr-close')!.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('#qr-download')!.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-qr.png`;
      a.click();
    });
    backdrop.querySelector('#qr-copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        (backdrop.querySelector('#qr-copy') as HTMLElement).textContent = 'Copied!';
      } catch {
        /* clipboard blocked */
      }
    });
  }


  // ================= the project, for main.ts =================
  const publishBtnEl = document.getElementById('publish-design') as HTMLButtonElement | null;
  const api: ToolbarApi = {
    async createProject({ title, origin }) {
      creationPending = false;
      docTitle.value = title;
      if (isSignedIn()) {
        try {
          const meta = await saveDesign(store, map, map.templateRef.id, map.templateRef.version, title, null, origin);
          if (sceneIO && !sceneUnread) {
            // Banners carried in (a copy onto another stadium, a template
            // with banners) go with it. Best-effort, like every scene write.
            await saveScene(meta.id, sceneIO.snapshot()).catch(() => {});
          }
          serverTitle = title;
          unsynced = false;
          bindProject({ kind: 'account', id: meta.id });
          refreshPhotoRow();
          draftWriter.flush();
          track('project_created');
          return ref;
        } catch {
          // The account could not be reached. The work is not lost for that:
          // it becomes a project in this browser, and the next Save moves it.
          message.textContent = i18nT('ed.proj.localOnly');
        }
      }
      const lp = createLocal({ title, templateId: map.templateRef.id, templateVersion: map.templateRef.version, origin });
      unsynced = false;
      bindProject({ kind: 'local', id: lp.id });
      draftWriter.flush();
      const thumb = makeStripDataUrl(map, store);
      if (thumb) writeRaw(thumbKey(lp.id), thumb);
      if (lastDraft && !lastDraft.ok) message.textContent = i18nT('pj.t.full');
      track('project_created');
      return ref;
    },

    async generate(prompt, autoName) {
      setPanelMode('ai');
      openOptionsSheet();
      message.textContent = i18nT('ed.proj.aiRunning');
      aiNaming = { autoName };
      // Naming and keeping happen in onApplied, above, so a design that
      // arrives later (after a choice card) is named and kept the same way.
      const ok = (await aiPanel.generate(prompt)) !== null;
      // Not drawn (yet): the AI panel's own card says why and what to do, so
      // the status line stops claiming it is designing.
      if (!ok && message.textContent === i18nT('ed.proj.aiRunning')) message.textContent = '';
      return ok;
    },

    publish() {
      publishBtnEl?.click();
    },

    async quickDesign(prompt) {
      return (await aiPanel.quickDesign(prompt)) !== null;
    },

    postTarget() {
      return {
        title: docTitle.value.trim() || i18nT('ed.docTitlePlaceholder'),
        publicId: publicChk.checked ? designId : null,
      };
    },

    bannersKey() {
      return ref ? keysFor(ref).banners : null;
    },
  };
  return api;
}
