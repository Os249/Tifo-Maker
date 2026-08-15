import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { installTheme } from './ui/theme';
import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { installConsent } from './ui/consent';
import { generateSeatMapAsync } from './workers/client';
import { DEFAULT_PALETTE, DEFAULT_TEMPLATE, PALETTE_PRESETS, TEMPLATES } from './core/template';
import { templateById, registerServerCommunity, type StadiumEntry } from './core/stadiumCatalog';
import { fetchCommunityStadiums } from './net/api';
import { requestStadiumSwitch } from './ui/stadiumSwitch';
import { registerCustom } from './core/customStadiums';
import { PATTERN_PRESETS } from './core/patterns';
import { DesignStore } from './core/design';
import { AssetStore } from './core/sceneAssets';
import { ObjectLayer } from './core/objects';
import { Editor } from './render/editor';
import type { Preview3D } from './render/preview3d';
import { mountToolbar } from './ui/toolbar';
import { mountBannerStudio } from './ui/bannerStudio';
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

/** Dismissible bottom note shown to phone create-lite users. */
function showCreateLiteBanner(): void {
  try {
    if (localStorage.getItem('tifo_mobile_note') === '1') return;
  } catch {
    /* storage blocked — show it anyway */
  }
  const bar = document.createElement('div');
  bar.id = 'mobile-create-note';
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;align-items:center;gap:10px;justify-content:center;' +
    'padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:#1C6FE0;color:#fff;' +
    "font:500 13px 'Inter',system-ui,sans-serif;box-shadow:0 -6px 20px rgba(0,0,0,.3);";
  const msg = document.createElement('span');
  msg.textContent = t('ed.mobileNote');
  const x = document.createElement('button');
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Dismiss');
  x.style.cssText =
    'background:rgba(255,255,255,.2);border:none;color:#fff;width:26px;height:26px;min-width:26px;border-radius:50%;cursor:pointer;flex:0 0 auto;font-size:13px;';
  x.addEventListener('click', () => {
    bar.remove();
    try {
      localStorage.setItem('tifo_mobile_note', '1');
    } catch {
      /* ignore */
    }
  });
  bar.append(msg, x);
  document.body.appendChild(bar);
}

async function main(): Promise<void> {
  installTheme();
  initLang();
  applyDom(document);
  installConsent();
  // Confirmation toast after returning from an email-verification link.
  const verifiedFlag = new URLSearchParams(location.search).get('verified');
  if (verifiedFlag === '1' || verifiedFlag === '0') {
    const toast = document.createElement('div');
    toast.textContent = verifiedFlag === '1' ? t('verify.ok') : t('verify.fail');
    toast.style.cssText =
      'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:1100;' +
      'padding:10px 16px;border-radius:10px;color:#fff;font:600 13px/1.3 "Inter",system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:90vw;text-align:center;' +
      (verifiedFlag === '1' ? 'background:#15924D;' : 'background:#C0392B;');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
    history.replaceState(null, '', location.pathname);
  }
  // Language toggle in the editor header.
  const langToggle = document.getElementById('lang-toggle');
  langToggle?.addEventListener('click', () => {
    toggleLang();
    applyDom(document);
    if (langToggle) langToggle.textContent = t('common.language');
  });
  const sharedId = sharedDesignId();
  registerCustom(); // make user-authored custom stadiums resolvable before we pick one
  // Best-effort: pull approved community stadiums into the catalog (non-blocking).
  void fetchCommunityStadiums()
    .then((list) =>
      registerServerCommunity(
        list.map((c): StadiumEntry => ({
          id: c.id,
          template: { ...c.template, id: c.id },
          meta: { name: c.name, source: 'community', country: c.country ?? undefined, type: c.template.tiers.length === 1 ? 'Single-tier' : 'Two-tier', tags: ['community-server'] },
        })),
      ),
    )
    .catch(() => {});

  // A shared design may live on any template, so resolve its template BEFORE
  // generating the seat map (the map must match the saved cell count).
  let template = DEFAULT_TEMPLATE;
  if (sharedId) {
    try {
      const { fetchDesignTemplate } = await import('./net/api');
      const ref = await fetchDesignTemplate(sharedId);
      template = templateById(ref.templateId) ?? DEFAULT_TEMPLATE;
    } catch {
      // Fall back to the default template; the load below will surface errors.
    }
  } else {
    const wanted = new URLSearchParams(location.search).get('template');
    template = templateById(wanted ?? '') ?? DEFAULT_TEMPLATE;
  }

  const t0 = performance.now();
  // Off-thread generation keeps the UI responsive even for the 76k oval.
  const map = await generateSeatMapAsync(template.id);
  const genMs = performance.now() - t0;

  // Phone + shared link → lightweight read-only viewer (great for opening a
  // shared tifo on a phone). Phone /app falls through to the editor (create-lite).
  if (isPhone() && sharedId) {
    const vstore = new DesignStore(map, DEFAULT_PALETTE.slice());
    let vtitle = 'Untitled tifo';
    try {
      const { loadDesign } = await import('./net/api');
      const r = await loadDesign(vstore, sharedId);
      vtitle = r.title;
    } catch {
      const vseed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
      for (let i = 0; i < map.count; i++) vstore.cells[i] = vseed(i);
    }
    await mountViewer({ map, store: vstore, templateName: template.name, title: vtitle, designId: sharedId });
    return;
  }
  // Phone create-lite: the real editor runs (paint + AI + simulate + share),
  // with a gentle, dismissible note that desktop/tablet unlock the full toolset.
  if (window.matchMedia(`(max-width: ${PHONE_MAX - 1}px)`).matches) showCreateLiteBanner();

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
    // Shared switch path (also used by the Stadium panel): stash → reload → remap.
    requestStadiumSwitch(stadiumSel.value, {
      fromId: template.id,
      palette: store.palette,
      cells: store.cells,
      title: docTitleValue(),
    });
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
      const fromTpl = templateById(data.fromTemplate);
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
    // Default to the whole-bowl "Full view" so the entire tifo reads at a glance.
    const fullIdx = CAMERA_PRESETS.findIndex((p) => p.name === 'Full view');
    if (fullIdx >= 0) {
      sel.value = String(fullIdx);
      preview!.applyPreset(CAMERA_PRESETS[fullIdx]);
    }
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

  // One-time coaching hint on the design pane: a brush drawing a stroke, nudging
  // newcomers to paint and watch the 3D stadium fill live. Appended INSIDE
  // #canvas-host so it overlays the design half correctly in both LTR and RTL.
  function showDrawHint(): void {
    try {
      if (localStorage.getItem('tifo_draw_hint_v1') === '1') return;
    } catch {
      return; // storage blocked → skip quietly
    }
    const drawHost = document.getElementById('canvas-host');
    if (!drawHost) return;
    const hint = document.createElement('div');
    hint.className = 'draw-hint';
    hint.innerHTML =
      '<div class="draw-hint-art">' +
      '<svg viewBox="0 0 200 90" aria-hidden="true"><path class="draw-hint-stroke" d="M12 62 q34 -50 62 -10 q24 32 50 -6 q22 -28 46 2"/></svg>' +
      '<i class="ti ti-brush draw-hint-brush" aria-hidden="true"></i>' +
      '</div><div class="draw-hint-label"></div>';
    const label = hint.querySelector('.draw-hint-label');
    if (label) label.textContent = t('ed.drawHint');
    drawHost.appendChild(hint);
    try {
      localStorage.setItem('tifo_draw_hint_v1', '1');
    } catch {
      /* ignore */
    }
    window.setTimeout(() => hint.remove(), 4200);
    // Beat 2: once the draw nudge fades, pulse the Match Day button so newcomers
    // know where the cinematic payoff lives.
    window.setTimeout(() => showMatchDayHint(), 4600);
  }

  // Second beat of the first-run hint: pulse the Match Day button and float a
  // tooltip beneath it.
  function showMatchDayHint(): void {
    const md = document.getElementById('match-day');
    if (!md) return;
    const r = md.getBoundingClientRect();
    if (!r.width) return; // not visible (e.g. not in split) → skip
    md.classList.add('nudge');
    window.setTimeout(() => md.classList.remove('nudge'), 3200);
    const tip = document.createElement('div');
    tip.className = 'md-hint';
    tip.innerHTML = '<div class="md-hint-inner"></div>';
    const inner = tip.querySelector('.md-hint-inner');
    if (inner) inner.textContent = t('ed.matchDayHint');
    document.body.appendChild(tip);
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.bottom + 10}px`;
    window.setTimeout(() => tip.remove(), 3800);
  }

  // First load: land in Split on desktop so newcomers instantly see how the 2D
  // design maps onto the 3D stadium. Phones/tablets keep the single-pane Design
  // view — split needs the width.
  if (window.matchMedia('(min-width: 1100px)').matches) {
    void setView('split').then(() => showDrawHint());
  }

  // Match Day Simulator: a separate, lazy-loaded high-fidelity renderer shown in
  // a fullscreen overlay. The editor preview is paused while it runs so only one
  // heavy WebGL context is live at a time, and resumes when the overlay closes.
  // Tifo assets (banners/flags/surfaces) live in a shared store so they persist
  // across opening/closing the simulator within a session.
  const assetStore = new AssetStore();
  mountBannerStudio({ trigger: document.getElementById('banner-studio-btn'), assetStore, store, map });
  // Persist them locally too, so they survive a page reload (client-only and
  // wrapped in try/catch — never touches the server save path; full per-design +
  // server persistence is a later, test-gated step).
  try {
    const raw = localStorage.getItem('tifo_scene_v2');
    if (raw) assetStore.loadJSON(JSON.parse(raw));
  } catch {
    /* ignore corrupt/unavailable storage */
  }
  let sceneSaveTimer = 0;
  assetStore.onChange(() => {
    window.clearTimeout(sceneSaveTimer);
    sceneSaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem('tifo_scene_v2', JSON.stringify(assetStore.toJSON()));
      } catch {
        /* quota exceeded (large images) or storage off — assets stay for this session */
      }
    }, 500);
  });
  const matchDayBtn = document.getElementById('match-day') as HTMLButtonElement | null;
  let simOpen = false;
  matchDayBtn?.addEventListener('click', async () => {
    if (simOpen) return;
    simOpen = true;
    const resumePreview = !previewHost.hidden;
    preview?.stop();
    try {
      const { openMatchDaySimulator } = await import('./render/simulator/overlay');
      openMatchDaySimulator(map, store, template, assetStore, {
        onClose: () => {
          simOpen = false;
          if (resumePreview) preview?.start();
        },
      });
    } catch {
      simOpen = false;
      if (resumePreview) preview?.start();
    }
  });

  // Shareable Match Day link: ?sim=1 opens the simulator straight onto the loaded design.
  if (new URLSearchParams(location.search).get('sim') === '1') {
    setTimeout(() => matchDayBtn?.click(), 400);
  }

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
