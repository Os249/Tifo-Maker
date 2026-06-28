import type { Editor } from '../render/editor';
import type { DesignStore } from '../core/design';
import type { SeatMap, ToolId } from '../core/types';
import { PALETTE_PRESETS } from '../core/template';
import { PATTERN_PRESETS } from '../core/patterns';
import { makeThumbnailB64 } from '../net/api';
import { renderTextCanvas, TIFO_FONTS, type RenderedText } from '../core/text';
import type { ObjectLayer } from '../core/objects';
import { MIN_LEGIBLE_RUN, findFragileSeats } from '../core/analysis';
import { RevealPlayer, REVEAL_PRESETS, type RevealId } from '../core/reveal';
import { fetchMe, isSignedIn, loadDesign, saveDesign, setPublic, exportMyData, deleteAccount } from '../net/api';
import { t as i18nT } from './i18n';
import { track, setAnalyticsSignedIn } from '../net/analytics';
import { buildTifoV2 } from '../core/tifoFormat';
import { extractPalette, rasterize } from '../core/importImage';
import { openAuthModal } from './authModal';
import { openGallery } from './gallery';
import { mountAiPanel } from './aiPanel';
import { mountStadiumPanel } from './stadiumPanel';
import { openShareModal } from './shareModal';
import { EDITOR_UNITS } from '../core/seatmap';
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
export function mountToolbar(
  root: HTMLElement,
  editor: Editor,
  store: DesignStore,
  map: SeatMap,
  objects: ObjectLayer,
  getPreview?: () => Preview3D | null,
): void {
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
  railSaveBtn?.addEventListener('click', () => setPanelMode(panelMode === 'save' ? 'design' : 'save'));
  animOpenBtn?.addEventListener('click', () => setPanelMode(panelMode === 'animation' ? 'design' : 'animation'));
  aiOpenBtn?.addEventListener('click', () => setPanelMode(panelMode === 'ai' ? 'design' : 'ai'));
  stadiumOpenBtn?.addEventListener('click', () => setPanelMode(panelMode === 'stadium' ? 'design' : 'stadium'));

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
    applyContextPanel(tool);
    onEnterMode(tool);
    objectPanelHook();
  };
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool as ToolId));
  setTool('brush');

  // ---- Swatches panel (Photoshop-style colour model) ----
  // Seats store a palette INDEX; the palette is the design's living swatch set.
  // You can pick ANY colour (auto-added as a swatch), edit a swatch in place
  // (an intentional recolour of those seats), or load a preset/uploaded palette
  // with a choice to ADD its colours or REMAP the design onto them.
  const palEl = $('#palette');
  const fgWell = $('#fg-well') as unknown as HTMLButtonElement;
  const fgHex = $('#fg-hex');
  const colorCounts = (): number[] => {
    const counts = new Array(store.palette.length).fill(0);
    for (let i = 0; i < store.cells.length; i++) counts[store.cells[i]]++;
    return counts;
  };
  const reflectFg = (): void => {
    const hex = store.palette[editor.colorIndex] ?? '#000000';
    fgWell.style.background = hex;
    fgHex.textContent = hex.toLowerCase();
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
      b.title = `${hex} · ${counts[idx].toLocaleString()} seats · double-click to edit`;
      b.setAttribute('aria-label', `Swatch ${hex}, ${counts[idx].toLocaleString()} seats`);
      b.addEventListener('click', () => {
        editor.colorIndex = idx;
        if (editor.tool === 'eraser') setTool('brush');
        editor.refreshStampPreviewTint();
        renderPalette();
        reflectFg();
      });
      b.addEventListener('dblclick', () => openColorEditor(idx, b));
      // Right-click removes a swatch (unless it's in use or the last one).
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (counts[idx] > 0) {
          message.textContent = `that colour is used by ${counts[idx].toLocaleString()} seats — recolour them before removing`;
          return;
        }
        if (store.palette.length <= 2) return;
        const next = store.palette.filter((_, i) => i !== idx);
        store.setPalette(next);
        if (editor.colorIndex >= next.length) editor.colorIndex = next.length - 1;
        editor.rebuildPalette();
        editor.repaintAll();
        renderPalette();
        reflectFg();
      });
      const tally = document.createElement('span');
      tally.className = 'swatch-count';
      tally.textContent = counts[idx] >= 1000 ? `${(counts[idx] / 1000).toFixed(1)}k` : String(counts[idx]);
      cell.append(b, tally);
      palEl.appendChild(cell);
    });
  };
  renderPalette();
  reflectFg();
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

  mountAiPanel({ root, store, editor, map, objects, getPreview, refresh: panelRefresh });

  // ---- Stadium panel (rail "stadium" button → panelMode 'stadium') ----
  mountStadiumPanel({ root, map, store, refresh: panelRefresh });

  // Pick ANY colour and start painting with it. Auto-adds it as a swatch so it's
  // reusable (the confirmed behaviour). Uses a hidden native colour input.
  const pickAnyColor = (initial: string, onChoose: (hex: string) => void): void => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = /^#[0-9a-fA-F]{6}$/.test(initial) ? initial : '#1c6fe0';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.addEventListener('input', () => onChoose(input.value.toLowerCase()), { once: false });
    input.addEventListener('change', () => {
      onChoose(input.value.toLowerCase());
      input.remove();
    });
    input.click();
  };

  const addAndSelect = (hex: string): void => {
    const idx = store.addSwatch(hex);
    editor.colorIndex = idx;
    if (editor.tool === 'eraser') setTool('brush');
    editor.rebuildPalette();
    editor.refreshStampPreviewTint();
    renderPalette();
    reflectFg();
  };

  // "+ Color" and the foreground well both open the any-colour picker.
  $('#add-swatch').addEventListener('click', () => {
    pickAnyColor(store.palette[editor.colorIndex] ?? '#1c6fe0', (hex) => addAndSelect(hex));
  });
  fgWell.addEventListener('click', () => {
    pickAnyColor(store.palette[editor.colorIndex] ?? '#1c6fe0', (hex) => addAndSelect(hex));
  });

  // Edit one swatch in place — recolours the seats using it (intentional).
  let colorPopover: HTMLElement | null = null;
  const openColorEditor = (idx: number, anchor: HTMLElement): void => {
    colorPopover?.remove();
    const pop = document.createElement('div');
    pop.className = 'color-pop';
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    pop.style.top = `${r.bottom + 6}px`;
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
    const label = document.createElement('span');
    label.textContent = 'Edit swatch';
    pop.append(label, picker, hex);
    document.body.appendChild(pop);
    colorPopover = pop;
    setTimeout(() => {
      const close = (e: MouseEvent): void => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          colorPopover = null;
          document.removeEventListener('mousedown', close);
        }
      };
      document.addEventListener('mousedown', close);
    }, 0);
  };

  // Applying a palette (preset or uploaded) offers the add-or-remap choice via a
  // themed dialog (replaces the old native confirm). It's genuinely three-way, so
  // a labelled choice modal reads far clearer than an OK/Cancel boolean.
  const applyPalette = async (incoming: string[], label: string): Promise<void> => {
    if (incoming.length === 0) return;
    const { choiceModal } = await import('./modal');
    const choice = await choiceModal({
      title: `Apply “${label}”`,
      message: 'How should these colours be applied to your design?',
      choices: [
        { value: 'remap', label: 'Remap my design', hint: 'Recolour every seat to the nearest new colour.', variant: 'primary' },
        { value: 'add', label: 'Just add the colours', hint: 'Add them to your swatches; the design stays as-is.' },
      ],
      cancelLabel: 'Cancel',
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
  presetPlaceholder.textContent = 'Choose a preset…';
  presetSel.appendChild(presetPlaceholder);
  for (const name of Object.keys(PALETTE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
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
    ph.textContent = saved.length ? 'Your saved palettes…' : 'No saved palettes yet';
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
        else message.textContent = 'couldn’t pull colours from that image';
      } else {
        const text = await file.text();
        const { parsePaletteText } = await import('./paletteIo');
        const colors = parsePaletteText(text, file.name.toLowerCase());
        if (colors.length) void applyPalette(colors, file.name);
        else message.textContent = 'no colours found in that file (.gpl/.hex/.json supported)';
      }
    } catch (err) {
      message.textContent = `palette import failed: ${(err as Error).message}`;
    }
  });

  // Save the current swatches as a reusable palette + offer a .hex download.
  $('#palette-save').addEventListener('click', async () => {
    const colors = store.palette.slice(1).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
    if (colors.length === 0) {
      message.textContent = 'add some colours first';
      return;
    }
    const { promptModal } = await import('./modal');
    const name = (await promptModal({
      title: 'Name this palette',
      placeholder: 'e.g. Derby black & gold',
      defaultValue: 'My palette',
      confirmLabel: 'Save palette',
      maxLength: 60,
    })) ?? '';
    if (name === '') return;
    const { saveUserPalette, serializePaletteHex } = await import('./paletteIo');
    saveUserPalette(name, colors);
    await refreshMyPalettes();
    message.textContent = `saved "${name}" — find it under your saved palettes`;
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
    opt.textContent = p.name;
    patternSel.appendChild(opt);
  }
  patternSel.addEventListener('change', () => {
    const preset = PATTERN_PRESETS.find((p) => p.id === patternSel.value);
    patternSel.value = '';
    if (!preset) return;
    store.transform(preset.cellAt(map));
    message.textContent = `pattern "${preset.name}" applied (palette slots 1-3)`;
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

  const placeTextAt = (x: number, y: number): void => {
    const rendered = renderTextCanvas(textInput.value, currentFontCss(), Number(textArc.value));
    if (!rendered) {
      message.textContent = 'type some text first';
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
    message.textContent = `"${textInput.value.trim()}" added — drag to position, resize from the corner, then Bake`;
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
      message.textContent = `font "${name}" loaded`;
    } catch (err) {
      message.textContent = `font load failed: ${(err as Error).message}`;
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
      message.textContent = `legibility ok — every stroke is ${MIN_LEGIBLE_RUN}+ seats thick`;
    } else {
      editor.flashSeats(fragile);
      message.textContent = `${fragile.length.toLocaleString()} seats sit in strokes thinner than ${MIN_LEGIBLE_RUN} — they may vanish with no-shows`;
    }
  });

  // Undo / redo / fill-all / fit
  const undoBtn = $('#undo') as unknown as HTMLButtonElement;
  const redoBtn = $('#redo') as unknown as HTMLButtonElement;
  const refreshHistory = (): void => {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  };
  undoBtn.addEventListener('click', () => {
    store.undo();
    refreshHistory();
  });
  redoBtn.addEventListener('click', () => {
    store.redo();
    refreshHistory();
  });
  store.onDirty(refreshHistory);
  refreshHistory();

  // Fill the whole bowl with the ACTIVE painting colour (not a fixed slot).
  $('#fill-base').addEventListener('click', () => store.fillAll(editor.colorIndex));
  $('#fit').addEventListener('click', () => editor.fitToView());

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
    importSizeOut.textContent = `${importWidth.value} × ${rows} seats`;
    importApply.disabled = importPlace.value === 'click' || !pendingImport;
    editor.setStampPreviewSize(w, h);
  };

  const stampImageAt = (cx: number, cy: number): void => {
    if (!pendingImport) return;
    const { w, h } = importRect();
    // "Real colours": add the picture's own dominant colours to the palette so
    // the imported art keeps its true look instead of only mapping to club cards.
    if (realColorsChk.checked) {
      const sampleCols = Math.min(200, Math.max(32, Math.round(w / 3)));
      const sampleRows = Math.max(2, Math.round((sampleCols * pendingImport.bitmap.height) / pendingImport.bitmap.width));
      const px = rasterize(pendingImport.bitmap, sampleCols, sampleRows);
      const extracted = extractPalette(px, sampleCols, sampleRows, 6, Number(importAlpha.value));
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
    objects.addImage({
      cx,
      cy,
      width: w,
      height: h,
      colorIndex: 0,
      tier: importTier.value === 'both' ? null : Number(importTier.value),
      bitmap: pendingImport.bitmap,
      name: pendingImport.name,
      dither: ditherChk.checked,
      alphaThreshold: Number(importAlpha.value),
    });
    editor.objectOverlay?.sync();
    // Keep the bitmap alive (the object now owns a reference); just exit import mode.
    pendingImport = null;
    editor.setStampPreview(null);
    setTool('select');
    message.textContent = `"${objects.selected && objects.selected.kind === 'image' ? objects.selected.name : 'image'}" added — drag to position, resize from the corner, then Bake`;
  };

  const cancelImport = (): void => {
    pendingImport?.bitmap.close();
    pendingImport = null;
    editor.setStampPreview(null);
    if (editor.tool === 'import') setTool('brush');
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      pendingImport?.bitmap.close();
      pendingImport = { bitmap: await createImageBitmap(file), name: file.name };
      importName.textContent = file.name;
      setTool('import');
      editor.setStampPreview(pendingImport.bitmap, false);
      refreshImportUI();
      message.textContent = 'configure the import, then click a stand (or pick a preset and Place)';
    } catch (err) {
      message.textContent = `image load failed: ${(err as Error).message}`;
    }
  });
  importWidth.addEventListener('input', rafThrottle(refreshImportUI));
  importTier.addEventListener('change', refreshImportUI);
  importPlace.addEventListener('change', refreshImportUI);
  importAlpha.addEventListener('input', () => {
    importAlphaOut.textContent = importAlpha.value;
  });
  importApply.addEventListener('click', () => {
    if (importPlace.value === 'click' || !pendingImport) return;
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
    message.textContent = `${kind} added — click to drop more, then “Bake all”. Switch to Select to move/resize.`;
  };

  // One shared placement-click callback, dispatched by the active mode.
  editor.onPlaceStamp = (x, y) => {
    if (editor.tool === 'text') placeTextAt(x, y);
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
  let designId: string | null = null;
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
      title: 'Add a caption',
      message: 'Optional — describe the match or moment.',
      placeholder: 'e.g. Liverpool vs Madrid, May 2026',
      confirmLabel: 'Continue',
      maxLength: 140,
    })) ?? '';
    addPhotoBtn && (addPhotoBtn.disabled = true);
    const original = addPhotoBtn?.innerHTML ?? '';
    if (addPhotoBtn) addPhotoBtn.textContent = 'Uploading…';
    try {
      const { uploadPhoto } = await import('../net/api');
      await uploadPhoto(designId, file, caption.trim());
      message.textContent = 'match-day photo added — it shows as Before/After in the feed';
    } catch (err) {
      message.textContent = `photo upload failed: ${(err as Error).message}`;
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
    message.textContent = `signed in as ${name}`;
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
    toggleAvatarMenu();
  });
  // Close the menu on any outside click.
  document.addEventListener('click', (e) => {
    if (avatarMenu && !avatarMenu.hidden) {
      const wrap = (e.target as HTMLElement).closest('.avatar-wrap');
      if (!wrap) toggleAvatarMenu(false);
    }
  });
  // Accessibility: make the avatar a real, keyboard-operable menu button.
  if (avatarEl) {
    avatarEl.setAttribute('role', 'button');
    avatarEl.setAttribute('tabindex', '0');
    avatarEl.setAttribute('aria-haspopup', 'menu');
    avatarEl.setAttribute('aria-expanded', 'false');
    avatarEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        avatarEl.click();
      }
    });
  }
  avatarMenu?.setAttribute('role', 'menu');
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
    message.textContent = 'signed out';
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
      message.textContent = 'save your design (and tick “List in public gallery”) first, then share';
      return;
    }
    openShareModal({ id: designId, title: docTitle.value.trim() || 'Untitled tifo' });
  });

  // Download the current design as a portable .tifo file (JSON: template + palette + cells).
  const downloadLocal = (): void => {
    const title = docTitle.value.trim() || 'Untitled tifo';
    // Bake image objects into cells (they're pixels); text objects serialize as
    // first-class v2 objects so they reopen editable.
    const imageObjs = objects.list().filter((o) => o.kind === 'image');
    if (imageObjs.length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
    const textObjs = objects.list().filter((o) => o.kind === 'text');
    const v2 = buildTifoV2({
      title,
      generator: 'tifomaker-editor',
      templateId: map.templateRef.id,
      templateVersion: map.templateRef.version,
      palette: store.palette,
      cells: store.cells,
      objects: textObjs.map((o) => ({
        id: o.id,
        kind: 'text' as const,
        text: (o as { text: string }).text,
        fontId: (o as { fontId: string }).fontId,
        arcDeg: (o as { arcDeg: number }).arcDeg,
        colorIndex: o.colorIndex,
        tier: o.tier,
        cx: o.cx,
        cy: o.cy,
        width: o.width,
        height: o.height,
      })),
    });
    const blob = new Blob([JSON.stringify(v2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.tifo`;
    a.click();
    URL.revokeObjectURL(url);
    message.textContent = `downloaded "${title}.tifo"`;
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
        message.textContent = 'that file isn\u2019t valid JSON';
        return;
      }
      const { validateTifo } = await import('../core/tifoFormat');
      // Different stadium → reload with the right template first (validate there).
      const stadiumId =
        (parsed as { stadium?: { templateId?: string } })?.stadium?.templateId ??
        (parsed as { templateId?: string })?.templateId;
      if (typeof stadiumId === 'string' && stadiumId !== map.templateRef.id) {
        try {
          sessionStorage.setItem('tifo_pending_import', text);
        } catch {
          /* ignore quota */
        }
        message.textContent = 'opening in the matching stadium\u2026';
        location.search = `?template=${encodeURIComponent(stadiumId)}`;
        return;
      }
      const result = validateTifo(parsed, (id, v) =>
        id === map.templateRef.id && v === map.templateRef.version ? map.count : null,
      );
      if (!result.valid || !result.doc) {
        const first = result.errors[0];
        message.textContent = first ? `can\u2019t open: ${first.path ? first.path + ' — ' : ''}${first.message}` : 'invalid .tifo file';
        return;
      }
      const { flattenLayers } = await import('../core/tifoFormat');
      store.setPalette(result.doc.palette.slice(0, 256));
      store.loadCells(flattenLayers(result.doc));
      const title = result.doc.meta?.title;
      if (title) docTitle.value = title;
      designId = null; // an imported file is a fresh working copy
      publicChk.checked = false;
      editor.rebuildPalette();
      editor.repaintAll();
      renderPalette();
      message.textContent = `opened "${title ?? file.name}"`;
    } catch (err) {
      message.textContent = `couldn\u2019t open file: ${(err as Error).message}`;
    }
  };

  saveBtn.addEventListener('click', async () => {
    track('save_clicked');
    const { openSaveDialog } = await import('./saveDialog');
    const choice = await openSaveDialog({
      isExisting: designId !== null,
      isSignedIn: isSignedIn(),
      currentlyPublic: publicChk.checked,
    });
    if (!choice) return;

    if (choice.kind === 'download') {
      downloadLocal();
      return;
    }

    // Account save (private or public) — ensure signed in first.
    if (!isSignedIn()) {
      const name = await openAuthModal();
      if (!name) return;
      const me = await fetchMe();
      reflectSignedIn(name, me?.id, true);
      reflectAdmin(me?.isAdmin ?? false);
    }
    saveBtn.disabled = true;
    try {
      const saveAsNew = choice.asNew || designId === null;
      const targetId = saveAsNew ? null : designId;
      const title = saveAsNew ? docTitle.value.trim() || 'Untitled tifo' : '';
      const meta = await saveDesign(store, map, map.templateRef.id, map.templateRef.version, title, targetId);
      designId = meta.id ?? designId;
      if (designId) {
        await setPublic(designId, choice.makePublic);
        publicChk.checked = choice.makePublic;
        refreshPhotoRow();
        // Apply tags + template flag (only meaningful once it's saved to the account).
        if (choice.tags.length > 0 || choice.isTemplate) {
          const { setDesignTags, setDesignTemplate } = await import('../net/api');
          if (choice.tags.length > 0) await setDesignTags(designId, choice.tags).catch(() => {});
          if (choice.isTemplate) await setDesignTemplate(designId, true).catch(() => {});
        }
        // Creator's explanation + remix permission (shown in the community 3D preview).
        if (choice.description !== null || choice.allowRemix === false) {
          const { setPublishMeta } = await import('../net/api');
          await setPublishMeta(designId, choice.description, choice.allowRemix).catch(() => {});
        }
      }
      if (choice.makePublic) track('published');
      message.textContent = choice.makePublic
        ? `published "${meta.title || docTitle.value}" — it's now in the community feed`
        : `saved privately${choice.asNew ? ' as a new copy' : ''}`;
    } catch (err) {
      message.textContent = `save failed: ${(err as Error).message}`;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const doLoad = async (id: string): Promise<void> => {
    try {
      const { title, isPublic, ownerIsMe } = await loadDesign(store, id);
      docTitle.value = title;
      designId = ownerIsMe ? id : null; // loading someone else's design = working copy
      publicChk.checked = isPublic && ownerIsMe;
      refreshPhotoRow();
      editor.rebuildPalette();
      editor.repaintAll();
      renderPalette();
      message.textContent = ownerIsMe ? `loaded "${title}"` : `loaded "${title}" (read-only copy - Save creates your own)`;
    } catch (err) {
      message.textContent = `load failed: ${(err as Error).message}`;
    }
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
  // Check admin status on load (once the session is known).
  void (async () => {
    const me = await fetchMe();
    reflectAdmin(me?.isAdmin ?? false);
  })();

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editor.tool === 'import') cancelImport();
      else if (editor.tool === 'text') setTool('brush');
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      refreshHistory();
      return;
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

  // Live cursor coordinates in stadium language (stand · section · row · seat).
  const coords = $('#coords');
  const STANDS = ['East', 'North', 'West', 'South'];
  editor.onHoverSeat = (seat) => {
    if (seat < 0) {
      coords.textContent = '—';
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
  $('#zoom-in').addEventListener('click', () => editor.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => editor.zoomBy(0.8));

  // Legibility chip in the status bar mirrors message styling.
  const chip = $('#message');
  const baseLegibility = $('#legibility');
  baseLegibility.addEventListener('click', () => {
    requestAnimationFrame(() => {
      chip.className = chip.textContent && chip.textContent.includes('vanish') ? 'legible-chip warn' : 'legible-chip ok';
    });
  });

  editor.emitView();

  // ---- Object layer (floating text/image until baked) ----
  const overlay = editor.objectOverlay!;
  const objEmpty = $('#obj-empty');
  const objControls = $('#obj-controls');
  const objKind = $('#obj-kind');
  const objHeight = $('#obj-height') as unknown as HTMLInputElement;
  const objHeightOut = $('#obj-height-out');
  const objTier = $('#obj-tier') as unknown as HTMLSelectElement;

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

  const refreshObjectPanel = (): void => {
    const sel = objects.selected;
    objControls.hidden = !sel;
    objEmpty.hidden = !!sel;
    if (!sel) {
      objKind.textContent = '';
      return;
    }
    objKind.textContent = sel.kind === 'text' ? `"${sel.text}"` : sel.kind === 'shape' ? sel.shape : sel.name;
    // Height shown in seats: derive from current footprint.
    const heightSeats = Math.round(sel.height / EDITOR_UNITS.rowPx);
    objHeight.value = String(Math.max(6, Math.min(60, heightSeats)));
    objHeightOut.textContent = objHeight.value;
    objTier.value = sel.tier === null ? 'both' : String(sel.tier);
  };

  objects.onChange(() => {
    refreshObjectPanel();
    refreshHistory();
  });
  overlay.sync();
  refreshObjectPanel();

  // Resize via the corner handle pushes height back into the panel slider.
  editor.onObjectResize = (heightEditor) => {
    objHeightOut.textContent = String(Math.round(heightEditor / EDITOR_UNITS.rowPx));
  };

  // Height slider rescales the selected object about its center, preserving aspect.
  objHeight.addEventListener('input', () => {
    const sel = objects.selected;
    if (!sel) return;
    objHeightOut.textContent = objHeight.value;
    const newH = Number(objHeight.value) * EDITOR_UNITS.rowPx;
    const aspect = sel.width / sel.height;
    objects.mutateSelected({ height: newH, width: newH * aspect });
  });
  objTier.addEventListener('change', () => {
    objects.mutateSelected({ tier: objTier.value === 'both' ? null : Number(objTier.value) });
  });
  $('#obj-back').addEventListener('click', () => objects.reorderSelected('back'));
  $('#obj-front').addEventListener('click', () => objects.reorderSelected('front'));
  $('#obj-delete').addEventListener('click', () => objects.deleteSelected());

  const bakeSelected = (): void => {
    const sel = objects.selected;
    if (!sel) return;
    const dirty = objects.bake(sel, store, map, EDITOR_UNITS.width);
    store.flush(dirty);
    objects.deleteSelected();
    refreshHistory();
    message.textContent = `baked onto ${dirty.length.toLocaleString()} seats`;
  };
  $('#obj-bake').addEventListener('click', bakeSelected);
  $('#obj-bake-all').addEventListener('click', () => {
    const n = objects.bakeAll(store, map, EDITOR_UNITS.width);
    overlay.sync();
    refreshHistory();
    message.textContent = `baked all objects onto ${n.toLocaleString()} seats`;
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
      label.textContent = stand;
      const cells = document.createElement('div');
      cells.className = 'section-cells';
      group.forEach((sec, n) => {
        const c = document.createElement('button');
        c.className = 'section-cell';
        c.textContent = String(n + 1);
        c.title = `${stand} section ${n + 1} · ${sec.seats.length.toLocaleString()} seats`;
        c.addEventListener('click', () => {
          editor.zoomToSeats(sec.seats);
          message.textContent = `${stand} section ${n + 1} — ${sec.seats.length.toLocaleString()} seats`;
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
    opt.textContent = r.name;
    revealSel.appendChild(opt);
  }
  // Default the reveal to right → left, the standard tifo sweep direction.
  revealSel.value = 'sweep-rl';
  const playBtn = $('#reveal-play') as unknown as HTMLButtonElement;
  const scrub = $('#reveal-scrub') as unknown as HTMLInputElement;
  const durSlider = $('#reveal-dur') as unknown as HTMLInputElement;
  const durOut = $('#reveal-dur-out');

  const player = new RevealPlayer(map, revealSel.value as RevealId, (clock, playing) => {
    const vis = clock >= 1 ? null : (seat: number) => player.visibilityAt(seat);
    editor.applyReveal(vis);
    // Drive the 3D stadium too, so the reveal plays in whichever view is open.
    getPreview?.()?.applyReveal(vis);
    scrub.value = String(Math.round(clock * 100));
    playBtn.innerHTML = playing
      ? '<i class="ti ti-player-pause"></i> Pause'
      : '<i class="ti ti-player-play"></i> Play';
  });

  // A partial reveal is a transient preview — any edit snaps back to the full
  // design so painting/filling never fights the dim overlay.
  editor.onEditWhileRevealed = () => {
    player.reset();
    editor.applyReveal(null);
    getPreview?.()?.applyReveal(null);
    scrub.value = '0';
  };

  revealSel.addEventListener('change', () => {
    player.setReveal(map, revealSel.value as RevealId);
    player.seek(Number(scrub.value) / 100);
  });
  playBtn.addEventListener('click', () => {
    if (player.isPlaying) player.pause();
    else player.play();
  });
  $('#reveal-reset').addEventListener('click', () => {
    player.reset();
    editor.applyReveal(null);
    getPreview?.()?.applyReveal(null);
  });
  scrub.addEventListener('input', () => {
    if (player.isPlaying) player.pause();
    player.seek(Number(scrub.value) / 100);
  });
  durSlider.addEventListener('input', () => {
    player.durationSec = Number(durSlider.value);
    durOut.textContent = `${durSlider.value}s`;
  });

  const gifBtn = $('#reveal-gif') as unknown as HTMLButtonElement;
  gifBtn.addEventListener('click', async () => {
    gifBtn.disabled = true;
    gifBtn.textContent = 'Encoding…';
    try {
      // Bake any floating objects first so they appear in the export.
      if (objects.list().length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
      const { exportRevealGifAsync } = await import('../workers/client');
      const blob = await exportRevealGifAsync(map, store, {
        reveal: revealSel.value as RevealId,
        frames: Math.round(player.durationSec * 9),
        fps: 18,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${docTitle.value.trim() || 'tifo'}-reveal.gif`;
      a.click();
      URL.revokeObjectURL(url);
      message.textContent = `GIF exported (${(blob.size / 1024).toFixed(0)} KB)`;
    } catch (err) {
      message.textContent = `GIF export failed: ${(err as Error).message}`;
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
        say('Video capture is not supported in this browser — switch Format to GIF.');
        return;
      }
      say('Recording video…');
      const { blob } = await exportStadiumVideo(preview, map, buildExportOpts(false));
      downloadBlob(blob, `${name}.webm`);
      say(`Video exported (${(blob.size / 1024).toFixed(0)} KB)`);
    }
  };

  sxPreviewBtn.addEventListener('click', async () => {
    sxPreviewBtn.disabled = true;
    sxSay('Preparing the stadium…');
    try {
      if (objects.list().length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
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
          <p class="sx-lead">Exactly what will be exported — watermark included.</p>
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
      if (objects.list().length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
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
      // Bake any floating objects so they appear in the export.
      if (objects.list().length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
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
        : `distribution PDF exported — sign in for a clean, watermark-free version`;
    } catch (err) {
      message.textContent = `PDF export failed: ${(err as Error).message}`;
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.innerHTML = original;
    }
  });

  const csvBtn = $('#export-csv') as unknown as HTMLButtonElement;
  csvBtn.addEventListener('click', async () => {
    if (objects.list().length > 0) objects.bakeAll(store, map, EDITOR_UNITS.width);
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
    message.textContent = `seat manifest exported (${rows.toLocaleString()} seats)`;
  });

  // Fan QR code: one stadium-wide code that points at /s/:id. Fans scan it,
  // pick their seat, and see exactly which card to hold. Needs a saved design.
  const qrBtn = $('#export-qr') as unknown as HTMLButtonElement;
  qrBtn.addEventListener('click', async () => {
    if (!designId) {
      message.textContent = 'save or publish your tifo first — the QR points fans to it';
      return;
    }
    const url = `${location.origin}/s/${designId}`;
    try {
      const QR = (await import('qrcode')).default;
      const dataUrl = await QR.toDataURL(url, { width: 720, margin: 2, color: { dark: '#0E0A1A', light: '#FFFFFF' } });
      openQrDialog(dataUrl, url, docTitle.value.trim() || 'Tifo');
    } catch {
      message.textContent = 'could not generate the QR code';
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
        <img class="qr-img" src="${dataUrl}" alt="QR code for ${escapeHtmlLocal(name)}" />
        <div class="qr-url">${escapeHtmlLocal(url)}</div>
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

  function escapeHtmlLocal(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
