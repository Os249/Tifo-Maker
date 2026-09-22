import './vendor/tabler-subset.css';
import { loadTifoFonts } from './core/tifoFonts';
import { installTheme } from './ui/theme';
import { initLang, applyDom, toggleLang, t, tl } from './ui/i18n';
import { installConsent } from './ui/consent';
import { generateSeatMapAsync } from './workers/client';
import { DEFAULT_PALETTE, DEFAULT_TEMPLATE, PALETTE_PRESETS, TEMPLATES } from './core/template';
import { templateById, registerServerCommunity, type StadiumEntry } from './core/stadiumCatalog';
import { adoptProviderSession, fetchCommunityStadiums, providerFailure } from './net/api';
import { requestStadiumSwitch } from './ui/stadiumSwitch';
import { registerCustom } from './core/customStadiums';
import { PATTERN_PRESETS } from './core/patterns';
import { DesignStore } from './core/design';
import { AssetStore, type SceneModel } from './core/sceneAssets';
import { BannerStore, type BannerSceneModel } from './core/banner';
import { ObjectLayer } from './core/objects';
import type { BannerView } from './ui/bannerView';
import type { Preview3D } from './render/preview3d';
import { track } from './net/analytics';
import { hasOnboarded } from './ui/onboarding';
// Narrow viewports (under EDITOR_MIN_WIDTH) get the read-only viewer for a
// shared link and the desktop-only gate for /app; ?editor=1 opts out of both,
// so a draft started on a phone is never permanently stranded.
import { isNarrowForEditor } from './ui/desktopOnly';

// The display faces are ~270 KB and nothing on first paint needs them, so warm
// them when the browser is idle. The text tool and the AI panel await the same
// promise, so an early click just waits for this fetch instead of racing it.
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadTifoFonts(), { timeout: 4000 });
else setTimeout(() => void loadTifoFonts(), 2000);
// Editor (Pixi), the toolbar and the banner studio are imported dynamically
// inside main(), below the desktop-only gate. They are the bulk of the bundle,
// and a phone that is about to be told "come back on a laptop" should not pay
// to download them. Vite splits them into their own chunks.

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
  installConsent();

  // Back from a provider's consent screen. This trades the one-time cookie the
  // callback left for the session token, and strips the marker out of the URL.
  //
  // It happens before everything else because everything else asks whether we
  // are signed in — including the desktop-only gate a few lines down, which
  // returns early and would otherwise strand a session that had just been
  // granted.
  await adoptProviderSession();
  const signinFailed = providerFailure();

  // An account that signed up with a provider has a handle we invented for it,
  // and the server refuses almost everything until its owner picks one. Ask
  // here — before the desktop gate, before the editor, and before the draft
  // claim, which is itself one of the calls the server would refuse.
  {
    const { fetchMe } = await import('./net/api');
    const me = await fetchMe().catch(() => null);
    if (me?.needsUsername) {
      const { ensureUsernameChosen } = await import('./ui/chooseUsernameModal');
      await ensureUsernameChosen(me);
    }
  }

  const sharedId = sharedDesignId();
  // The editor is desktop-only for now. Two phone bug reports were both people
  // hitting walls inside an editor that had let them in; this stops them at the
  // door instead, and stops here so the seat map, Pixi, Three and the toolbar
  // are never loaded. A shared link falls through to the read-only viewer.
  if (isNarrowForEditor() && !sharedId) {
    const { mountDesktopOnly } = await import('./ui/desktopOnly');
    mountDesktopOnly();
    return;
  }

  // Start pulling the editor chunks NOW, before the seat map, the template
  // lookup and the design fetch. Measured on a 4x-throttled phone they did not
  // begin downloading until 3.1s because every await above them had to settle
  // first; from here they stream in parallel with all of it. Not awaited — the
  // call site below awaits this promise.
  //
  // The one path that does not want them is a shared link on a screen too
  // narrow for any editor, which falls through to the read-only viewer.
  const wantsEditor = !(isNarrowForEditor() && sharedId);
  const editorChunks = wantsEditor
    ? Promise.all([import('./render/editor'), import('./ui/toolbar')])
    : null;
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

  // Narrow + shared link → lightweight read-only viewer (great for opening a
  // shared tifo on a phone). Narrow /app never reaches here: it was gated above.
  if (isNarrowForEditor() && sharedId) {
    const vstore = new DesignStore(map, DEFAULT_PALETTE.slice());
    let vtitle = t('ed.docTitlePlaceholder');
    try {
      const { loadDesign } = await import('./net/api');
      const r = await loadDesign(vstore, sharedId);
      vtitle = r.title;
    } catch {
      const vseed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
      for (let i = 0; i < map.count; i++) vstore.cells[i] = vseed(i);
    }
    const { mountViewer } = await import('./ui/viewer');
    await mountViewer({ map, store: vstore, templateName: template.name, title: vtitle, designId: sharedId });
    return;
  }

  // Stadium selector: switching reloads with a fresh canvas for that bowl.
  const stadiumSel = document.getElementById('stadium') as HTMLSelectElement;
  for (const t of TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = tl(t.id);
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
  /** A shared design's banners, restored once the stores exist further down. */
  let sharedScene: unknown = null;
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
  if (sharedId && sharedLoaded) {
    // Separate request, and a failure here costs the banners rather than the
    // tifo: an old design simply has no scene, and that is not an error.
    try {
      const { fetchScene } = await import('./net/api');
      sharedScene = await fetchScene(sharedId);
    } catch {
      sharedScene = null;
    }
  }

  // A .tifo file for a different stadium reloads with ?template= and stashes the
  // design here; pick it up now that this template's seat map matches its cells.
  let pendingTitle: string | null = null;
  let draftAge: string | null = null; // set when a local draft was restored
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

  // Nothing else claimed the canvas, so restore whatever this browser was last
  // working on. This is the whole point of the draft: someone who painted a tifo
  // and closed the tab gets it back instead of starting from nothing.
  let restoredDesignId: string | null = null;
  if (!sharedLoaded) {
    const { readDraft, describeAge } = await import('./core/draft');
    const draft = readDraft();
    // Only restore into the stadium it was drawn for; seat counts differ per
    // template and cells are positional.
    if (draft && draft.templateId === template.id && draft.templateVersion === template.version) {
      try {
        const { validateTifo, flattenLayers } = await import('./core/tifoFormat');
        const result = validateTifo(draft.doc, (id, v) =>
          id === template.id && v === template.version ? map.count : null,
        );
        if (result.valid && result.doc) {
          store.setPalette(result.doc.palette.slice(0, 256));
          store.loadCells(flattenLayers(result.doc));
          pendingTitle = draft.title || result.doc.meta?.title || t('ed.docTitlePlaceholder');
          restoredDesignId = draft.designId;
          sharedLoaded = true; // suppress the starter seed + onboarding
          draftAge = describeAge(draft.savedAt);
        }
      } catch {
        /* a corrupt draft must never block the editor from opening */
      }
    }
  }

  if (!sharedLoaded) {
    const seed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
    for (let i = 0; i < map.count; i++) store.cells[i] = seed(i);
  }

  const host = document.getElementById('canvas-host')!;
  const [{ Editor }, { mountToolbar }] = await editorChunks!;
  const editor = await Editor.create(host, map, store);
  editor.aisleCount = template.aisles.count;
  editor.drawGrid(true);
  const objects = new ObjectLayer();
  // Banners and the older overlay assets. Both are created here, before the
  // toolbar, because saving a design has to be able to reach them: a banner
  // that only exists in this browser is not a banner anyone can be shown.
  const bannerStore = new BannerStore();
  const assetStore = new AssetStore();
  editor.attachObjectLayer(objects);

  /** What travels with the design, and how it comes back. */
  const sceneIO = {
    snapshot: (): unknown => ({ v: 1, banners: bannerStore.toJSON(), assets: assetStore.toJSON() }),
    restore: (raw: unknown): void => {
      const scene = raw as { banners?: BannerSceneModel; assets?: SceneModel } | null;
      if (!scene || typeof scene !== 'object') return;
      if (scene.banners) bannerStore.loadJSON(scene.banners);
      if (scene.assets) assetStore.loadJSON(scene.assets);
    },
  };

  if (sharedScene) sceneIO.restore(sharedScene);

  mountToolbar(document.body, editor, store, map, objects, () => preview, restoredDesignId, sceneIO);

  // A sign-in that did not finish says why, in the same place every other
  // outcome is reported. Reasons are a fixed set from the callback; nothing the
  // provider said is echoed into the page.
  if (signinFailed) {
    const msg = document.getElementById('message');
    if (msg) msg.textContent = t(`auth.err.${signinFailed}`);
  }

  // --- Phase 2: lazy-initialized 3D preview sharing the same store ---
  const previewHost = document.getElementById('preview-host')!;
  const bannerHostEl = document.getElementById('banner-host')!;
  const canvasWrap = host.parentElement as HTMLElement;
  const btn2d = document.getElementById('view-2d') as HTMLButtonElement;
  const btnBanner = document.getElementById('view-banner') as HTMLButtonElement;
  const btn3d = document.getElementById('view-3d') as HTMLButtonElement;
  const btnSplit = document.getElementById('view-split') as HTMLButtonElement;
  const camBar = document.getElementById('cam-bar')!;
  let preview: Preview3D | null = null;
  let loading = false;

  // Banners. The store is pure data and is created up front because the
  // simulator, the save path and the mobile shell all read it; the VIEW —
  // artboard, bar, panel — is a chunk of its own that only arrives when
  // somebody actually presses Banner, the same bargain the 3D preview makes.
  let bannerView: BannerView | null = null;
  let bannerLoading: Promise<BannerView | null> | null = null;
  const ensureBannerView = (): Promise<BannerView | null> => {
    if (bannerView) return Promise.resolve(bannerView);
    if (bannerLoading) return bannerLoading;
    bannerLoading = import('./ui/bannerView')
      .then(({ mountBannerView }) => {
        bannerView = mountBannerView({
          host: bannerHostEl,
          store,
          bannerStore,
          message: document.getElementById('message'),
          onOpenMatchDay: () => document.getElementById('match-day')?.click(),
        });
        return bannerView;
      })
      .catch((err) => {
        // Say something. A swallowed mount failure leaves the Banner view a
        // blank rectangle with no clue anywhere as to why, which cost a whole
        // debugging session to work out once already.
        console.error('[tifo] the Banner view failed to mount', err);
        const m = document.getElementById('message');
        if (m) m.textContent = 'The Banner view could not start — please reload.';
        return null;
      });
    return bannerLoading;
  };

  // Lazily create the 3D preview (Three.js loads only when first needed).
  const ensurePreview = async (): Promise<Preview3D | null> => {
    if (preview) return preview;
    if (loading) return null;
    loading = true;
    const { Preview3D, CAMERA_PRESETS } = await import('./render/preview3d');
    preview = new Preview3D(previewHost, map, store);
    // Banners belong in the editor's own bowl, not only in Match Day. A sheet
    // you can only see by opening another view is a sheet you design blind.
    preview.attachBanners(bannerStore, template);
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

  type ViewMode = '2d' | 'banner' | '3d' | 'split';

  const setView = async (next: ViewMode): Promise<void> => {
    const show2d = next === '2d' || next === 'split';
    const show3dView = next === '3d' || next === 'split';
    if (show3dView) track('view_3d');
    if (next === 'banner') track('view_banner');
    host.hidden = !show2d;
    previewHost.hidden = !show3dView;
    camBar.hidden = next === '2d' || next === 'banner';
    canvasWrap.classList.toggle('split', next === 'split');
    btn2d.classList.toggle('active', next === '2d');
    btnBanner?.classList.toggle('active', next === 'banner');
    btn3d.classList.toggle('active', next === '3d');
    btnSplit.classList.toggle('active', next === 'split');

    // The Banner view owns the tool rail while it is up: the rail's buttons,
    // the palette, undo and the touch gestures all reach it through
    // `bannerHost` rather than through the seat editor.
    if (next === 'banner') {
      const bv = await ensureBannerView();
      bv?.show();
    } else {
      bannerView?.hide();
    }

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
  btnBanner?.addEventListener('click', () => void setView('banner'));
  btn3d.addEventListener('click', () => void setView('3d'));
  btnSplit.addEventListener('click', () => void setView('split'));
  // The tool rail's flag button is the other door into the same room. It used
  // to open a modal with a brush and a stand picker; that studio is gone and
  // this is where its work continued.
  document.getElementById('banner-studio-btn')?.addEventListener('click', () => void setView('banner'));

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

  // First load: land in Design, fitted.
  //
  // This used to open in Split on desktop, to show newcomers how the 2D design
  // maps onto the 3D stadium. The intent is right but the timing was wrong:
  // someone who has just asked for an empty bowl arrives at a half-width canvas
  // at 11% zoom showing a strip of seats about a centimetre tall, with nothing
  // yet painted for the 3D half to mirror. The mapping is the product's best
  // trick and it lands far harder once there is something on the seats, so
  // Split stays one tap away and the hint below points at it after the first
  // stroke rather than the view being chosen for them.
  void setView('2d').then(() => {
    editor.fitToView();
    showDrawHint();
  });

  // Match Day Simulator: a separate, lazy-loaded high-fidelity renderer shown in
  // a fullscreen overlay. The editor preview is paused while it runs so only one
  // heavy WebGL context is live at a time, and resumes when the overlay closes.
  // Tifo assets (banners/flags/surfaces) live in a shared store so they persist
  // across opening/closing the simulator within a session.
  // Phones get a different front end over the same editor: a five-tab ribbon
  // and bottom sheets instead of a 752px tool rail that ran off the screen.
  const { mountMobileShell, PHONE_MAX } = await import('./ui/mobileShell');
  let shell = mountMobileShell();
  // The shell collapses the header from two rows to one, so the canvas has ~53px
  // more to fill than it measured at creation. Re-fit before anyone sees it.
  if (shell) requestAnimationFrame(() => { editor.app.resize(); editor.fitToView(); });
  // Rotating or resizing across the breakpoint swaps front ends rather than
  // leaving a desktop rail on a phone (or a phone ribbon on a laptop).
  window.matchMedia(`(max-width: ${PHONE_MAX}px)`).addEventListener('change', (e) => {
    if (e.matches && !shell) shell = mountMobileShell();
    else if (!e.matches && shell) { shell.destroy(); shell = null; }
    requestAnimationFrame(() => { editor.app.resize(); editor.fitToView(); });
  });

  // Restore the scene.
  //
  // The retired Banner Studio's work is NOT brought forward. Its banners were
  // placed by a free position and a size in metres, and neither of those
  // exists any more — a banner is a run of blocks on a stand now. Inventing a
  // slot for an old banner would put it somewhere nobody chose, which is
  // worse than leaving it out; the artwork itself is untouched in storage.
  try {
    const raw = sharedScene ? null : localStorage.getItem('tifo_scene_v2');
    if (raw) assetStore.loadJSON(JSON.parse(raw));
  } catch {
    /* ignore corrupt/unavailable storage */
  }
  // Banners live in their own key.
  try {
    const rawB = sharedScene ? null : localStorage.getItem('tifo_banners_v1');
    if (rawB && bannerStore.count === 0) bannerStore.loadJSON(JSON.parse(rawB));
  } catch {
    /* ignore */
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
  let bannerSaveTimer = 0;
  bannerStore.onChange(() => {
    window.clearTimeout(bannerSaveTimer);
    bannerSaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem('tifo_banners_v1', JSON.stringify(bannerStore.toJSON()));
      } catch {
        /* quota exceeded (a pasted photo) — the banner still lives for this session */
      }
    }, 600);
  });
  const matchDayBtn = document.getElementById('match-day') as HTMLButtonElement | null;
  let simOpen = false;
  matchDayBtn?.addEventListener('click', async () => {
    if (simOpen) return;
    simOpen = true;
    // The simulator is ~690KB of Three.js and scene code that deliberately is
    // not in the first load. On a desktop that arrives before anyone looks up;
    // on 4G it is several seconds of a button that appears to have done
    // nothing. The phone shell listens for these and says "Loading…" on the
    // control the user actually tapped — it owns those, this module does not.
    document.dispatchEvent(new CustomEvent('tifo:sim-loading'));
    const resumePreview = !previewHost.hidden;
    preview?.stop();
    try {
      const { openMatchDaySimulator } = await import('./render/simulator/overlay');
      openMatchDaySimulator(map, store, template, assetStore, {
        bannerStore,
        onClose: () => {
          simOpen = false;
          if (resumePreview) preview?.start();
        },
      });
      document.dispatchEvent(new CustomEvent('tifo:sim-open'));
    } catch {
      simOpen = false;
      if (resumePreview) preview?.start();
      document.dispatchEvent(new CustomEvent('tifo:sim-failed'));
    }
  });

  // Shareable Match Day link: ?sim=1 opens the simulator straight onto the loaded design.
  if (new URLSearchParams(location.search).get('sim') === '1') {
    setTimeout(() => matchDayBtn?.click(), 400);
  }

  const stat = document.getElementById('stat')!;
  stat.textContent = `${tl(template.id)} · ${map.count.toLocaleString()} ${t('ed.seats')} · ${t('ed.stat.made')} ${genMs.toFixed(0)} ms`;
  track('landed'); // editor is interactive — top of the funnel
  if (draftAge) {
    track('draft_restored');
    const msg = document.getElementById('message');
    if (msg) msg.textContent = `restored your tifo from ${draftAge}`;
  }

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
      // Built from nodes: a custom stadium's name is whatever its author typed.
      msg.textContent = `design fitted to ${template.name}. `;
      const undo = document.createElement('button');
      undo.id = 'undo-stadium';
      undo.style.cssText = 'all:unset;color:var(--flare);cursor:pointer;text-decoration:underline;';
      undo.textContent = `Switch back to ${prevTpl.name}`;
      msg.appendChild(undo);
      undo.addEventListener('click', () => {
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

      // The guided tour is no longer started for them.
      //
      // It used to launch itself here, which put a nine-step spotlight on top of
      // a first-time user at the same moment the account offer and the consent
      // bar were also on screen — three things competing for attention in the
      // first thirty seconds. Tutorials pushed at people interrupt, do not
      // reliably improve task performance, and are forgotten quickly; the same
      // content works far better pulled at the moment it is needed, which the
      // tool tooltips and the "B brush · F fill · T text" hint strip already do.
      //
      // It is still one click away: the onboarding dialog offers it up front,
      // and "Replay tutorial" in the avatar menu starts it any time.
      /*
       * Re-fit once the dialog is gone.
       *
       * The initial fit happens while the onboarding dialog is still up, so it
       * measures a layout that is about to change; applying a starter then
       * repaints without re-fitting, and the design ended up rendered outside
       * the visible canvas - a black pane on the screen a first-time user sees
       * immediately after saying what they wanted to make.
       */
      requestAnimationFrame(() => {
        editor.app.resize();
        editor.fitToView();
      });

      if (choice.wantsTour) {
        const { startTour } = await import('./ui/tour');
        setTimeout(() => void startTour(), 400);
      }
    }
  }

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    /*
     * Zen mode is on Z, not Tab.
     *
     * It used to be Tab, with preventDefault(), for every keypress that did not
     * originate in a form field - which meant a keyboard user could not move
     * focus anywhere in the editor at all. Tab is how you navigate; a page that
     * swallows it is a keyboard trap (WCAG 2.1.2) across the entire product,
     * and it also made every other keyboard fix here untestable. Z matches the
     * single-letter shortcuts the tools already use (B, F, T, I).
     */
    if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey
        && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
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
