import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { installTheme } from './ui/theme';
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

/** Parse a /d/:id share path. Returns the design id, or null. */
function sharedDesignId(): string | null {
  const m = location.pathname.match(/^\/d\/([A-Za-z0-9-]+)\/?$/);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  installTheme();
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
    location.search = `?template=${encodeURIComponent(stadiumSel.value)}`;
  });

  const store = new DesignStore(map, DEFAULT_PALETTE.slice());

  // Either load a shared design, or seed a starter so the canvas never opens
  // blank (the border preset is template-agnostic — derives tier edges from the map).
  let sharedTitle: string | null = null;
  let sharedLoaded = false;
  if (sharedId) {
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
          store.setPalette(result.doc.palette.slice(0, 8));
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
  const loadedTitle = sharedTitle ?? pendingTitle;
  if (sharedLoaded && loadedTitle) {
    const docTitle = document.getElementById('doc-title') as HTMLInputElement | null;
    if (docTitle) docTitle.value = loadedTitle;
    editor.rebuildPalette();
    editor.repaintAll();
  }

  // First-run onboarding: only for a fresh visitor on a normal boot (never via
  // a share link or a file import — those already have content/context).
  if (!sharedId && !sharedLoaded && !hasOnboarded()) {
    const { openOnboarding } = await import('./ui/onboarding');
    const choice = await openOnboarding(PATTERN_PRESETS);
    if (choice) {
      const palette = PALETTE_PRESETS[choice.paletteName];
      if (palette) store.setPalette(palette.slice());
      const pattern = PATTERN_PRESETS.find((p) => p.id === choice.patternId);
      if (pattern) store.transform(pattern.cellAt(map));
      editor.rebuildPalette();
      editor.repaintAll();
      // Reflect the chosen palette in the dropdown so the UI stays consistent.
      const presetSel = document.getElementById('preset') as HTMLSelectElement | null;
      if (presetSel) presetSel.value = choice.paletteName;
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
