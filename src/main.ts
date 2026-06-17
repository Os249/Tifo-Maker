import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { installTheme } from './ui/theme';
import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { generateSeatMapAsync } from './workers/client';
import { DEFAULT_PALETTE, DEFAULT_TEMPLATE, PALETTE_PRESETS, TEMPLATES } from './core/template';
import { PATTERN_PRESETS } from './core/patterns';
import { DesignStore } from './core/design';
import { ObjectLayer } from './core/objects';
import { Editor } from './render/editor';
import type { Preview3D } from './render/preview3d';
import { mountToolbar } from './ui/toolbar';
import { track } from './net/analytics';
import { mountViewer } from './ui/viewer';
import { hasOnboarded } from './ui/onboarding';

/** Phones get the viewer; tablet/desktop get the editor. ?editor=1 forces the editor. */
const PHONE_MAX = 768;
function isPhone(): boolean {
  const forced = new URLSearchParams(location.search).get('editor') === '1';
  return !forced && window.matchMedia(`(max-width: ${PHONE_MAX - 1}px)`).matches;
}

/** Parse a /d/:id share path OR a ?design=:id query param. Returns the id, or null. */
function sharedDesignId(): string | null {
  const m = location.pathname.match(/^\/d\/([A-Za-z0-9-]+)\/?$/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get('design');
  return q && /^[A-Za-z0-9-]+$/.test(q) ? q : null;
}

async function main(): Promise<void> {
  installTheme();
  initLang();
  applyDom(document);
  // Language toggle in the editor header.
  const langToggle = document.getElementById('lang-toggle');
  langToggle?.addEventListener('click', () => {
    toggleLang();
    applyDom(document);
    if (langToggle) langToggle.textContent = t('common.language');
  });
  const sharedId = sharedDesignId();

  // A shared design may live on any template, so resolve its template BEFORE
  // generating the seat map (the map must match the saved cell count).
  let template = DEFAULT_TEMPLATE;
  if (sharedId) {
    try {
      const { fetchDesignTemplate } = await import('./net/api');
      const ref = await fetchDesignTemplate(sharedId);
      template = TEMPLATES.find((t) => t.id === ref.templateId) ?? DEFAULT_TEMPLATE;
    } catch {
      // Fall back to the default template; the load below will surface errors.
    }
  } else {
    const wanted = new URLSearchParams(location.search).get('template');
    template = TEMPLATES.find((t) => t.id === wanted) ?? DEFAULT_TEMPLATE;
  }

  const t0 = performance.now();
  // Off-thread generation keeps the UI responsive even for the 76k oval.
  const map = await generateSeatMapAsync(template.id);
  const genMs = performance.now() - t0;

  // Phone branch: build the seeded store and hand off to the read-only viewer.
  if (isPhone()) {
    const vstore = new DesignStore(map, DEFAULT_PALETTE.slice());
    let vtitle = 'Untitled tifo';
    if (sharedId) {
      try {
        const { loadDesign } = await import('./net/api');
        const r = await loadDesign(vstore, sharedId);
        vtitle = r.title;
      } catch {
        const vseed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
        for (let i = 0; i < map.count; i++) vstore.cells[i] = vseed(i);
      }
    } else {
      const vseed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
      for (let i = 0; i < map.count; i++) vstore.cells[i] = vseed(i);
    }
    await mountViewer({ map, store: vstore, templateName: template.name, title: vtitle, designId: sharedId ?? undefined });
    return;
  }

  // Stadium selector: switching reloads with a fresh canvas for that bowl.
  const stadiumSel = document.getElementById('stadium') as HTMLSelectElement;
  for (const t of TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    stadiumSel.appendChild(opt);
  }
  stadiumSel.value = template.id;
  stadiumSel.addEventListener('change', () => {
    const fromId = template.id;
    const toId = stadiumSel.value;
    if (toId === fromId) return;
    // Carry the current design across the size change. We stash it (with the
    // source template) and reload on the target template; the load path remaps
    // by relative position so the look is preserved. Also remember where we came
    // from so the switch is reversible (switch back = remap back).
    try {
      sessionStorage.setItem(
        'tifo_stadium_remap',
        JSON.stringify({
          fromTemplate: fromId,
          palette: store.palette,
          cells: Array.from(store.cells),
          title: docTitleValue(),
          prevTemplate: fromId,
        }),
      );
    } catch {
      /* if stash fails we simply switch without carrying — acceptable fallback */
    }
    location.search = `?template=${encodeURIComponent(toId)}`;
  });

  // Read the current document title from the input without coupling to toolbar.
  function docTitleValue(): string {
    const el = document.getElementById('doc-title') as HTMLInputElement | null;
    return el?.value ?? '';
  }

  let sharedLoadedEarly = false;
  const store = new DesignStore(map, DEFAULT_PALETTE.slice());

  // Cross-stadium remap pickup: if we arrived from a stadium switch, regenerate
  // the SOURCE map, remap the saved cells onto THIS bowl by relative position,
  // and load the result — the design's look is preserved across the size change.
  let remapTitle: string | null = null;
  let remappedFrom: string | null = null;
  try {
    const raw = sessionStorage.getItem('tifo_stadium_remap');
    if (raw) {
      sessionStorage.removeItem('tifo_stadium_remap');
      const data = JSON.parse(raw) as { fromTemplate: string; palette: string[]; cells: number[]; title?: string; prevTemplate?: string };
      const fromTpl = TEMPLATES.find((t) => t.id === data.fromTemplate);
      if (fromTpl && Array.isArray(data.cells)) {
        const oldMap = await generateSeatMapAsync(fromTpl.id);
        if (data.cells.length === oldMap.count) {
          const { remapDesignAcrossStadiums } = await import('./core/remapStadium');
          const remapped = remapDesignAcrossStadiums(Uint8Array.from(data.cells), oldMap, map);
          store.setPalette((data.palette ?? DEFAULT_PALETTE).slice(0, 256));
          store.loadCells(remapped);
          remapTitle = data.title ?? null;
          remappedFrom = data.prevTemplate ?? data.fromTemplate;
          sharedLoadedEarly = true;
        }
      }
    }
  } catch {
    /* fall through to normal seed/load */
  }

  // Either load a shared design, or seed a starter so the canvas never opens
  // blank (the border preset is template-agnostic — derives tier edges from the map).
  let sharedTitle: string | null = null;
  let sharedLoaded = sharedLoadedEarly;
  if (sharedId && !sharedLoaded) {
    try {
      const { loadDesign } = await import('./net/api');
      const r = await loadDesign(store, sharedId);
      sharedTitle = r.title;
      sharedLoaded = true;
    } catch {
      sharedLoaded = false;
    }
  }

  // A .tifo file for a different stadium reloads with ?template= and stashes the
  // design here; pick it up now that this template's seat map matches its cells.
  let pendingTitle: string | null = null;
  if (!sharedLoaded) {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem('tifo_pending_import');
      if (pending) sessionStorage.removeItem('tifo_pending_import');
    } catch {
      pending = null;
    }
    if (pending) {
      try {
        const parsed = JSON.parse(pending);
        const { validateTifo, flattenLayers } = await import('./core/tifoFormat');
        const result = validateTifo(parsed, (id, v) =>
          id === template.id && v === template.version ? map.count : null,
        );
        if (result.valid && result.doc) {
          store.setPalette(result.doc.palette.slice(0, 256));
          store.loadCells(flattenLayers(result.doc));
          pendingTitle = result.doc.meta?.title ?? 'Imported tifo';
          sharedLoaded = true; // suppress the starter seed + onboarding
        }
      } catch {
        /* fall through to seed */
      }
    }
  }

  if (!sharedLoaded) {
    const seed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
    for (let i = 0; i < map.count; i++) store.cells[i] = seed(i);
  }

  const host = document.getElementById('canvas-host')!;
  const editor = await Editor.create(host, map, store);
  editor.aisleCount = template.aisles.count;
  editor.drawGrid(true);
  const objects = new ObjectLayer();
  editor.attachObjectLayer(objects);
  mountToolbar(document.body, editor, store, map, objects, () => preview);

  // --- Phase 2: lazy-initialized 3D preview sharing the same store ---
  const previewHost = document.getElementById('preview-host')!;
  const canvasWrap = host.parentElement as HTMLElement;
  const btn2d = document.getElementById('view-2d') as HTMLButtonElement;
  const btn3d = document.getElementById('view-3d') as HTMLButtonElement;
  const btnSplit = document.getElementById('view-split') as HTMLButtonElement;
  const camBar = document.getElementById('cam-bar')!;
  let preview: Preview3D | null = null;
  let loading = false;

  // Lazily create the 3D preview (Three.js loads only when first needed).
  const ensurePreview = async (): Promise<Preview3D | null> => {
    if (preview) return preview;
    if (loading) return null;
    loading = true;
    const { Preview3D, CAMERA_PRESETS } = await import('./render/preview3d');
    preview = new Preview3D(previewHost, map, store);
    const sel = document.getElementById('camera-preset') as HTMLSelectElement;
    CAMERA_PRESETS.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => preview!.applyPreset(CAMERA_PRESETS[Number(sel.value)]));
    const noshow = document.getElementById('noshow') as HTMLInputElement;
    noshow.addEventListener('change', () => preview!.setNoShows(noshow.checked));
    loading = false;
    return preview;
  };

  type ViewMode = '2d' | '3d' | 'split';

  const setView = async (next: ViewMode): Promise<void> => {
    const show2d = next === '2d' || next === 'split';
    const show3dView = next === '3d' || next === 'split';
    if (show3dView) track('view_3d');
    host.hidden = !show2d;
    previewHost.hidden = !show3dView;
    camBar.hidden = next === '2d';
    canvasWrap.classList.toggle('split', next === 'split');
    btn2d.classList.toggle('active', next === '2d');
    btn3d.classList.toggle('active', next === '3d');
    btnSplit.classList.toggle('active', next === 'split');

    if (show3dView) {
      const p = await ensurePreview();
      if (p) {
        p.recolorAll();
        p.start();
      }
    } else {
      preview?.stop();
    }
    // The 2D editor keeps rendering in 2d and split; pauses only in pure 3d.
    if (show2d) {
      editor.app.ticker.start();
      requestAnimationFrame(() => {
        editor.app.resize();
        if (next !== 'split') editor.fitToView();
        else editor.fitToView();
      });
    } else {
      editor.app.ticker.stop();
    }
    // In split, the 3D canvas shares the row — its ResizeObserver re-fits it
    // automatically when the layout changes to half width.
  };

  btn2d.addEventListener('click', () => void setView('2d'));
  btn3d.addEventListener('click', () => void setView('3d'));
  btnSplit.addEventListener('click', () => void setView('split'));

  const stat = document.getElementById('stat')!;
  stat.textContent = `${template.name} · ${map.count.toLocaleString()} seats · map generated in ${genMs.toFixed(0)} ms`;
  track('landed'); // editor is interactive — top of the funnel

  // If we loaded a shared design or an imported file, reflect title + repaint.
  const loadedTitle = sharedTitle ?? pendingTitle ?? remapTitle;
  if (sharedLoaded && loadedTitle) {
    const docTitle = document.getElementById('doc-title') as HTMLInputElement | null;
    if (docTitle) docTitle.value = loadedTitle;
    editor.rebuildPalette();
    editor.repaintAll();
  }

  // Reversible stadium switch: after a remap, offer a one-click switch back to
  // the previous stadium (which remaps the current design back).
  if (remappedFrom) {
    editor.rebuildPalette();
    editor.repaintAll();
    const msg = document.getElementById('message');
    const prevTpl = TEMPLATES.find((t) => t.id === remappedFrom);
    if (msg && prevTpl) {
      msg.innerHTML = `design fitted to ${template.name}. <button id="undo-stadium" style="all:unset;color:var(--flare);cursor:pointer;text-decoration:underline;">Switch back to ${prevTpl.name}</button>`;
      document.getElementById('undo-stadium')?.addEventListener('click', () => {
        stadiumSel.value = remappedFrom!;
        stadiumSel.dispatchEvent(new Event('change'));
      });
    }
  }

  // First-run onboarding: only for a fresh visitor on a normal boot (never via
  // a share link or a file import — those already have content/context).
  if (!sharedId && !sharedLoaded && !hasOnboarded()) {
    const { openOnboarding } = await import('./ui/onboarding');
    const choice = await openOnboarding(PATTERN_PRESETS);
    if (choice) {
      // Set the project name the user chose.
      const docTitleEl = document.getElementById('doc-title') as HTMLInputElement | null;
      if (docTitleEl && choice.projectName) docTitleEl.value = choice.projectName;
      const palette = PALETTE_PRESETS[choice.paletteName];
      if (palette) store.setPalette(palette.slice());
      // Apply the chosen starting point.
      if (choice.kind === 'patterns' && choice.patternId) {
        const pattern = PATTERN_PRESETS.find((p) => p.id === choice.patternId);
        if (pattern) store.transform(pattern.cellAt(map));
      } else if (choice.kind === 'crest') {
        // Fill the bowl with the base color so a centered logo reads against it,
        // then the user drops an image via the Image tool.
        store.fillAll(1);
      }
      editor.rebuildPalette();
      editor.repaintAll();
      // Reflect the chosen palette in the dropdown so the UI stays consistent.
      const presetSel = document.getElementById('preset') as HTMLSelectElement | null;
      if (presetSel) presetSel.value = choice.paletteName;
      // For text/crest starters, drop the user straight into the right tool.
      if (choice.kind === 'text') document.querySelector<HTMLButtonElement>('[data-tool="text"]')?.click();
      else if (choice.kind === 'crest') document.querySelector<HTMLButtonElement>('[data-tool="import"]')?.click();

      // First-timer guided tour of the major controls (skippable). Only runs if
      // the user completed onboarding (didn't skip) and hasn't seen the tour.
      const { hasSeenTour, startTour } = await import('./ui/tour');
      if (!hasSeenTour()) {
        // Let the layout settle (panels/tools rendered) before spotlighting.
        setTimeout(() => void startTour(), 400);
      }
    }
  }

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (e.key === 'Tab' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      document.body.classList.toggle('zen');
      requestAnimationFrame(() => {
        editor.app.resize();
        editor.fitToView();
      });
    }
  });

  window.addEventListener('resize', () => editor.fitToView());
}

void main();
