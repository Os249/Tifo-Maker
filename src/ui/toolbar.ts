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
import { isSignedIn, loadDesign, login, register, saveDesign, setPublic } from '../net/api';
import { openGallery } from './gallery';
import { DEFAULT_TEMPLATE } from '../core/template';
import { EDITOR_UNITS } from '../core/seatmap';

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
  let pendingImport: { bitmap: ImageBitmap; name: string } | null = null;
  let onEnterMode: (tool: ToolId) => void = () => {};
  let objectPanelHook: () => void = () => {};
  const setTool = (tool: ToolId): void => {
    editor.tool = tool;
    for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool);
    editor.app.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    textBar.hidden = tool !== 'text';
    importBar.hidden = tool !== 'import';
    if (tool !== 'text' && tool !== 'import') editor.hideStampPreview();
    if (tool === 'import' && !pendingImport) fileInput.click();
    onEnterMode(tool);
    objectPanelHook();
  };
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool as ToolId));
  setTool('brush');

  // Palette swatches
  const palEl = $('#palette');
  /** Per-color seat tallies — one pass over the cells buffer (ambient BOM). */
  const colorCounts = (): number[] => {
    const counts = new Array(store.palette.length).fill(0);
    for (let i = 0; i < store.cells.length; i++) counts[store.cells[i]]++;
    return counts;
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
      b.title = `Color ${idx}`;
      b.setAttribute('aria-label', `Color ${idx}, ${counts[idx].toLocaleString()} seats`);
      b.addEventListener('click', () => {
        editor.colorIndex = idx;
        if (editor.tool === 'eraser') setTool('brush');
        editor.refreshStampPreviewTint();
        renderPalette();
      });
      // Double-click (or the native color input) edits this slot's color.
      // Changing a slot recolors every seat using it instantly — seats store
      // indices, not colors — and re-tints any floating objects in that color.
      b.addEventListener('dblclick', () => openColorEditor(idx, b));
      const tally = document.createElement('span');
      tally.className = 'swatch-count';
      tally.textContent = counts[idx] >= 1000 ? `${(counts[idx] / 1000).toFixed(1)}k` : String(counts[idx]);
      cell.append(b, tally);
      palEl.appendChild(cell);
    });
  };
  renderPalette();
  store.onDirty(renderPalette);

  // A lightweight color editor: native color input + hex field in a popover,
  // anchored to the swatch. Applies live so the user sees the bowl recolor.
  let colorPopover: HTMLElement | null = null;
  const openColorEditor = (idx: number, anchor: HTMLElement): void => {
    colorPopover?.remove();
    const pop = document.createElement('div');
    pop.className = 'color-pop';
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
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
      const next = store.palette.slice();
      next[idx] = v.toLowerCase();
      store.setPalette(next);
      editor.rebuildPalette();
      editor.repaintAll();
      editor.objectOverlay?.sync();
      renderPalette();
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
    label.textContent = `Color ${idx}`;
    pop.append(label, picker, hex);
    document.body.appendChild(pop);
    colorPopover = pop;
    // Dismiss on outside click.
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

  // Palette preset picker
  const presetSel = $('#preset') as unknown as HTMLSelectElement;
  for (const name of Object.keys(PALETTE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSel.appendChild(opt);
  }
  presetSel.addEventListener('change', () => {
    store.setPalette(PALETTE_PRESETS[presetSel.value].slice());
    editor.rebuildPalette();
    editor.repaintAll();
    renderPalette();
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
  const rebuildTextPreview = (): void => {
    previewRendered = renderTextCanvas(textInput.value, currentFontCss(), Number(textArc.value));
    editor.setStampPreview(previewRendered?.canvas ?? null, true);
    updateTextPreviewSize();
  };
  textInput.addEventListener('input', rebuildTextPreview);
  textFont.addEventListener('change', rebuildTextPreview);
  textArc.addEventListener('input', () => {
    textArcOut.textContent = textArc.value;
    rebuildTextPreview();
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

  $('#fill-base').addEventListener('click', () => store.fillAll(1));
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
  importWidth.addEventListener('input', refreshImportUI);
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

  // One shared placement-click callback, dispatched by the active mode.
  editor.onPlaceStamp = (x, y) => {
    if (editor.tool === 'text') placeTextAt(x, y);
    else if (editor.tool === 'import' && importPlace.value === 'click') stampImageAt(x, y);
  };

  // Rebuild the right ghost when (re-)entering a stamp mode.
  onEnterMode = (tool) => {
    if (tool === 'text') rebuildTextPreview();
    else if (tool === 'import' && pendingImport) {
      editor.setStampPreview(pendingImport.bitmap, false);
      refreshImportUI();
    }
  };

  // Account + persistence (run `npm run server` alongside `npm run dev`).
  let designId: string | null = null;
  let username: string | null = null;
  const publicChk = $('#public') as unknown as HTMLInputElement;
  const signinBtn = $('#signin') as unknown as HTMLButtonElement;

  signinBtn.addEventListener('click', async () => {
    const name = window.prompt('Username (3-24 chars, letters/digits/_)');
    if (!name) return;
    const pass = window.prompt('Password (8+ chars)');
    if (!pass) return;
    try {
      username = await login(name.trim(), pass);
    } catch {
      if (!window.confirm('No account with those credentials. Create it?')) return;
      try {
        username = await register(name.trim(), pass);
      } catch (err) {
        message.textContent = `sign-in failed: ${(err as Error).message}`;
        return;
      }
    }
    signinBtn.textContent = username;
    const avatar = document.getElementById('avatar');
    if (avatar && username) avatar.textContent = username[0].toUpperCase();
    message.textContent = `signed in as ${username} (token is in-memory; refresh signs you out)`;
  });

  const saveBtn = $('#save') as unknown as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    if (!isSignedIn()) {
      message.textContent = 'sign in first - designs belong to accounts';
      return;
    }
    saveBtn.disabled = true;
    try {
      const title = designId ? '' : (docTitle.value.trim() || 'Untitled tifo');
      const meta = await saveDesign(store, map, DEFAULT_TEMPLATE.id, DEFAULT_TEMPLATE.version, title, designId);
      designId = meta.id ?? designId;
      if (designId && publicChk.checked !== meta.isPublic) {
        await setPublic(designId, publicChk.checked);
      }
      message.textContent = `saved - id ${designId}${publicChk.checked ? ' (public)' : ''}`;
    } catch (err) {
      message.textContent = `save failed: ${(err as Error).message} - is the API running? (npm run server)`;
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
      editor.rebuildPalette();
      editor.repaintAll();
      renderPalette();
      message.textContent = ownerIsMe ? `loaded "${title}"` : `loaded "${title}" (read-only copy - Save creates your own)`;
    } catch (err) {
      message.textContent = `load failed: ${(err as Error).message}`;
    }
  };
  $('#load').addEventListener('click', () => {
    const id = window.prompt('Design id to load');
    if (id) void doLoad(id.trim());
  });
  $('#gallery').addEventListener('click', () => void openGallery((id) => void doLoad(id)));

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
      objects.deleteSelected();
      return;
    }
    if (k === 't') setTool('text');
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
  $('#panel-toggle').addEventListener('click', () => {
    // On tablet the panel is a slide-over (.open); on desktop it collapses (.collapsed).
    if (window.matchMedia('(max-width: 1099px)').matches) {
      panel.classList.remove('open');
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
  fab.addEventListener('click', () => panel.classList.toggle('open'));
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
  const ctxObjects = $('#ctx-objects');
  const ctxBrush = $('#ctx-brush');
  const objEmpty = $('#obj-empty');
  const objControls = $('#obj-controls');
  const objKind = $('#obj-kind');
  const objHeight = $('#obj-height') as unknown as HTMLInputElement;
  const objHeightOut = $('#obj-height-out');
  const objTier = $('#obj-tier') as unknown as HTMLSelectElement;

  // The object panel replaces the brush context whenever the Select tool is active.
  const syncObjectPanelVisibility = (): void => {
    const selecting = editor.tool === 'select';
    ctxObjects.hidden = !selecting;
    ctxBrush.hidden = selecting;
  };
  objectPanelHook = syncObjectPanelVisibility;

  const refreshObjectPanel = (): void => {
    const sel = objects.selected;
    objControls.hidden = !sel;
    objEmpty.hidden = !!sel;
    if (!sel) {
      objKind.textContent = '';
      return;
    }
    objKind.textContent = sel.kind === 'text' ? `"${sel.text}"` : sel.name;
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
  const playBtn = $('#reveal-play') as unknown as HTMLButtonElement;
  const scrub = $('#reveal-scrub') as unknown as HTMLInputElement;
  const durSlider = $('#reveal-dur') as unknown as HTMLInputElement;
  const durOut = $('#reveal-dur-out');

  const player = new RevealPlayer(map, revealSel.value as RevealId, (clock, playing) => {
    editor.applyReveal(clock >= 1 ? null : (seat) => player.visibilityAt(seat));
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
}
