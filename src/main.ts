import { cleanAddressBar } from './core/utm';
import './vendor/tabler-subset.css';
import { loadTifoFonts } from './core/tifoFonts';
import { installTheme } from './ui/theme';
import { initLang, applyDom, toggleLang, t, tl, tv, onLangChange } from './ui/i18n';
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
import { ObjectLayer, decodePictures } from './core/objects';
import { Composer } from './core/composer';
import { readLayers } from './core/layerStore';
import { TIFO_FONTS } from './core/text';
import { EDITOR_UNITS } from './core/seatmap';
import type { BannerView } from './ui/bannerView';
import type { Preview3D } from './render/preview3d';
import { track } from './net/analytics';
import { hasOnboarded } from './ui/onboarding';
import {
  accountBannersKey, accountDraftKey, bannersKey, docKey, getLocal, migrateLegacyDraft, openUrl,
  readEnvelope, readRaw, takeNewProject, writeRaw, type ProjectRef,
} from './core/projects';
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

/**
 * The design the URL names: a /d/:id share path, ?design=:id, or ?project=:id
 * (an account project, from the Projects page). Returns the id, or null.
 */
function sharedDesignId(): string | null {
  const m = location.pathname.match(/^\/d\/([A-Za-z0-9-]+)\/?$/);
  if (m) return m[1];
  const params = new URLSearchParams(location.search);
  const q = params.get('project') ?? params.get('design');
  return q && /^[A-Za-z0-9-]+$/.test(q) ? q : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  installTheme();
  initLang();
  // The visit was counted when the page was sent; see core/utm.ts.
  cleanAddressBar();
  applyDom(document);
  installConsent();

  // Read before anything strips it: a provider sign-in comes back to /app
  // with ?signedin=, and the server can only send it to a bare path.
  const bootParams = new URLSearchParams(location.search);
  const returningFromProvider = bootParams.has('signedin');

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

  // ---- which project ----
  //
  // The editor always has a project open, and the Projects page is the way
  // in. So the editor is reached as one of:
  //   ?project=<id> / ?design=<id> / /d/<id>   a design (yours opens as your project)
  //   ?local=<id>                              a project kept in this browser
  //   ?new=1[&from=<id>|&import=1|&ai=1]       a project being created right now
  // and a bare /app goes to the Projects page. ?admin= deep links from the
  // dashboard still open the editor as they did.
  migrateLegacyDraft();
  const localId = bootParams.get('local');
  const isNew = bootParams.get('new') === '1';
  const fromRaw = isNew ? bootParams.get('from') : null;
  const fromId = fromRaw && UUID_RE.test(fromRaw) ? fromRaw : null;
  if (!sharedId && !localId && !isNew && !bootParams.get('admin')) {
    // Back from a provider's sign-in: return to the project that was open in
    // this tab, where the half of the save flow the redirect interrupted waits.
    let back: string | null = null;
    if (returningFromProvider) {
      try {
        back = (JSON.parse(sessionStorage.getItem('tifo_open_project') ?? 'null') as { url?: string } | null)?.url ?? null;
      } catch {
        back = null;
      }
    }
    if (back && back.startsWith('/app?')) {
      location.replace(back);
      return;
    }
    const q = new URLSearchParams(location.search);
    q.set('start', '1');
    location.replace(`/projects?${q.toString()}`);
    return;
  }
  const intent = isNew ? takeNewProject() : null;
  const localProject = localId ? getLocal(localId) : null;
  if (localId && (!localProject || localProject.deletedAt)) {
    location.replace('/projects?missing=1');
    return;
  }
  const localEnv = localProject ? readEnvelope(docKey(localProject.id)) : null;

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
  const sourceId = sharedId ?? fromId;
  if (sourceId) {
    try {
      const { fetchDesignTemplate } = await import('./net/api');
      const ref = await fetchDesignTemplate(sourceId);
      template = templateById(ref.templateId) ?? DEFAULT_TEMPLATE;
    } catch {
      // A project link that does not open (deleted, or someone else's private
      // design) goes back to the list with a reason, rather than opening an
      // empty canvas that looks like the project lost its seats. A share link
      // falls back to the default template; the load below surfaces the error.
      if (bootParams.has('project') || fromId) {
        location.replace('/projects?missing=1');
        return;
      }
    }
  } else if (localProject) {
    template = templateById(localEnv?.templateId ?? localProject.templateId) ?? DEFAULT_TEMPLATE;
  } else {
    const wanted = bootParams.get('template') ?? intent?.templateId;
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
    // Shared switch path (also used by the Stadium panel): a copy of this
    // project on the other stadium, after asking. Declined, the select goes back.
    void requestStadiumSwitch(stadiumSel.value, {
      fromId: template.id,
      palette: store.palette,
      cells: store.cells,
      title: docTitleValue(),
    }).then((went) => {
      if (!went) stadiumSel.value = template.id;
    });
  });

  // Read the current document title from the input without coupling to toolbar.
  function docTitleValue(): string {
    const el = document.getElementById('doc-title') as HTMLInputElement | null;
    return el?.value ?? '';
  }

  let sharedLoadedEarly = false;
  const store = new DesignStore(map, DEFAULT_PALETTE.slice());

  // A copy onto another stadium (see stadiumSwitch.ts): regenerate the SOURCE
  // map, remap the saved cells onto THIS bowl by relative position, and load
  // the result. Only ever into a new project; the original is left alone.
  let remapTitle: string | null = null;
  let remappedFrom: string | null = null;
  let remapBanners: string | null = null;
  try {
    const raw = isNew ? sessionStorage.getItem('tifo_stadium_remap') : null;
    if (raw) {
      sessionStorage.removeItem('tifo_stadium_remap');
      const data = JSON.parse(raw) as { fromTemplate: string; palette: string[]; cells: number[]; title?: string; prevTemplate?: string; banners?: string | null };
      const fromTpl = templateById(data.fromTemplate);
      if (fromTpl && Array.isArray(data.cells)) {
        const oldMap = await generateSeatMapAsync(fromTpl.id);
        if (data.cells.length === oldMap.count) {
          const { remapDesignAcrossStadiums } = await import('./core/remapStadium');
          const remapped = remapDesignAcrossStadiums(Uint8Array.from(data.cells), oldMap, map);
          store.setPalette((data.palette ?? DEFAULT_PALETTE).slice(0, 256));
          store.loadCells(remapped);
          remapTitle = tv('ed.proj.copyOn', { name: data.title || t('np.nameDefault'), stadium: tl(template.id) }).slice(0, 80);
          remappedFrom = data.prevTemplate ?? data.fromTemplate;
          remapBanners = typeof data.banners === 'string' ? data.banners : null;
          sharedLoadedEarly = true;
        }
      }
    }
  } catch {
    /* fall through to normal seed/load */
  }

  // A design named by the URL: an account project, a share link, or the source
  // of a new project (?from=).
  let sharedTitle: string | null = null;
  let sharedLoaded = sharedLoadedEarly;
  /** The design is the viewer's own: it opens as their project. */
  let ownedProject = false;
  /** This browser held edits to it that the account never got. */
  let restoredUnsaved = false;
  /** A shared design's banners, restored once the stores exist further down. */
  let sharedScene: unknown = null;
  if (sourceId && !sharedLoaded) {
    try {
      const { loadDesign } = await import('./net/api');
      const r = await loadDesign(store, sourceId);
      sharedTitle = r.title;
      sharedLoaded = true;
      if (r.ownerIsMe && fromId) {
        // "Open" on one of your own designs from the gallery or your profile
        // opens it as itself, not as a copy of itself.
        location.replace(openUrl({ kind: 'account', id: fromId }));
        return;
      }
      ownedProject = r.ownerIsMe && !!sharedId;
    } catch {
      sharedLoaded = false;
      if (fromId) {
        location.replace('/projects?missing=1');
        return;
      }
    }
  }
  if (sourceId && sharedLoaded) {
    // Separate request, and a failure here costs the banners rather than the
    // tifo: an old design simply has no scene, and that is not an error.
    try {
      const { fetchScene } = await import('./net/api');
      sharedScene = await fetchScene(sourceId);
    } catch {
      sharedScene = null;
    }
  }

  // Edits this browser kept for an account project and never saved to it come
  // back, rather than being quietly replaced by the older copy on the server.
  let draftAge: string | null = null;
  const { describeAge } = await import('./core/draft');
  if (ownedProject && sharedId) {
    const env = readEnvelope(accountDraftKey(sharedId));
    if (env?.dirty && env.templateId === template.id && env.templateVersion === template.version) {
      try {
        const { validateTifo, flattenLayers } = await import('./core/tifoFormat');
        const result = validateTifo(env.doc, (id, v) => (id === template.id && v === template.version ? map.count : null));
        if (result.valid && result.doc) {
          store.setPalette(result.doc.palette.slice(0, 256));
          store.loadCells(flattenLayers(result.doc));
          sharedTitle = env.title || sharedTitle;
          restoredUnsaved = true;
          draftAge = describeAge(env.savedAt);
        }
      } catch {
        /* the server copy stands */
      }
    }
  }

  // A .tifo file opened as a new project (from the Projects page or the
  // editor's Open file), validated against this stadium's seat map.
  let pendingTitle: string | null = null;
  let imported = false;
  /** The layers a .tifo file carried, put back once the stack exists. */
  let importedLayers: unknown = null;
  if (isNew && bootParams.get('import') === '1' && !sharedLoaded) {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem('tifo_pending_import');
      if (pending) sessionStorage.removeItem('tifo_pending_import');
    } catch {
      pending = null;
    }
    try {
      const parsed = pending ? JSON.parse(pending) : null;
      const { validateTifo, flattenLayers } = await import('./core/tifoFormat');
      const result = validateTifo(parsed, (id, v) =>
        id === template.id && v === template.version ? map.count : null,
      );
      if (!result.valid || !result.doc) throw new Error('invalid');
      store.setPalette(result.doc.palette.slice(0, 256));
      store.loadCells(flattenLayers(result.doc));
      importedLayers = result.doc.editor?.layers ?? null;
      pendingTitle = result.doc.meta?.title ?? null;
      sharedLoaded = true;
      imported = true;
    } catch {
      // Never a new project with nothing in it where a file was promised.
      location.replace('/projects?importfail=1');
      return;
    }
  }

  // A project kept in this browser.
  if (localProject && !sharedLoaded) {
    pendingTitle = localProject.title;
    if (localEnv) {
      try {
        const { validateTifo, flattenLayers } = await import('./core/tifoFormat');
        const result = validateTifo(localEnv.doc, (id, v) =>
          id === template.id && v === template.version ? map.count : null,
        );
        if (result.valid && result.doc) {
          store.setPalette(result.doc.palette.slice(0, 256));
          store.loadCells(flattenLayers(result.doc));
          sharedLoaded = true;
        }
      } catch {
        /* a corrupt copy must never block the editor from opening */
      }
    }
  }

  if (!sharedLoaded) {
    const seed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
    const seeded = new Uint8Array(map.count);
    for (let i = 0; i < map.count; i++) seeded[i] = seed(i);
    store.loadCells(seeded);
  }

  const host = document.getElementById('canvas-host')!;
  const [{ Editor }, { mountToolbar }] = await editorChunks!;
  const editor = await Editor.create(host, map, store);
  editor.aisleCount = template.aisles.count;
  editor.drawGrid(true);
  // A real ground's premium zones and vehicle lanes, marked on the flat view.
  if (template.details) {
    const { venueMarks, noTifoMask } = await import('./core/venueDetails');
    // The royal box never takes the tifo — locked in the design itself.
    store.setLockedSeats(noTifoMask(map, template));
    const marks = venueMarks(map, template);
    const paint = (): void =>
      editor.setVenueMarks(marks, { gold: t('venue.gold'), silver: t('venue.silver'), vip: t('venue.vip'), lane: t('venue.lane') });
    paint();
    onLangChange(paint);
  }
  const objects = new ObjectLayer();
  // The layer stack: text, pictures and shapes stay movable layers above the
  // Paint layer, flattened into the seats. A "keep inside" region (the AI's
  // portraits keep to their stand) needs the spec compiler's region test.
  const { regionPredicate } = await import('./core/specCompiler');
  const composer = new Composer(map, store, objects, {
    wrapWidth: EDITOR_UNITS.width,
    clipFor: (region) => regionPredicate(region, map),
  });
  editor.composer = composer;
  // The browser suites (e2e-layers.mjs) read the stack directly. Opt-in by URL only.
  if (bootParams.has('e2e')) (window as unknown as { __tifo: unknown }).__tifo = { store, objects, composer, editor, map };
  // Banners and the older overlay assets. Both are created here, before the
  // toolbar, because saving a design has to be able to reach them: a banner
  // that only exists in this browser is not a banner anyone can be shown.
  const bannerStore = new BannerStore();
  // What the stands allow a banner — which tiers a flown one can use, and the
  // shape a gap between two tiers imposes — needs the stand geometry, which
  // the seat editor never loads. It arrives on the side, after the first
  // paint, and from then on every edit is settled against it, in any panel.
  void import('./render/bannerShape')
    .then(({ installSlotRules }) => installSlotRules(bannerStore, map))
    .catch((err) => console.error('[tifo] banner slot rules failed to load', err));
  const assetStore = new AssetStore();
  editor.attachObjectLayer(objects, EDITOR_UNITS.width);

  /** What travels with the design, and how it comes back. */
  const sceneIO = {
    snapshot: (): unknown => {
      // The layers travel with the design, so an account project opens with
      // its pictures still movable. Only the owner is ever sent them back.
      const layers = composer.toDoc();
      return { v: 1, banners: bannerStore.toJSON(), assets: assetStore.toJSON(), ...(layers ? { layers } : {}) };
    },
    /**
     * This design's scene — and a design without one has no banners.
     *
     * It used to return early on an empty scene, which kept whatever banners
     * were already in the editor: open a template from the gallery, or a
     * design saved before banners existed, and the last tifo's banners came
     * along onto it — and into its next save.
     */
    restore: (raw: unknown): void => {
      const scene = raw && typeof raw === 'object' ? (raw as { banners?: BannerSceneModel; assets?: SceneModel }) : null;
      bannerStore.loadJSON(scene?.banners ?? null);
      if (scene?.assets) assetStore.loadJSON(scene.assets);
    },
    onChange: (fn: () => void): void => {
      bannerStore.onChange(fn);
    },
    bannerCount: (): number => bannerStore.count,
  };

  // The account's banners, unless this browser has newer ones for it (below).
  if (sharedScene && !restoredUnsaved) sceneIO.restore(sharedScene);

  // The project's layers: the saved stack goes back on top of its seats, but
  // only onto the seats it was saved with (see Composer.loadDoc). An account
  // project's come from the account, or from this browser when it holds
  // edits the account has not got; a local project's from this browser; an
  // opened .tifo file's from the file. Anyone else's design opens flat.
  {
    const candidates: unknown[] = [];
    if (ownedProject && sharedId) {
      const fromScene = (sharedScene as { layers?: unknown } | null)?.layers ?? null;
      const fromBrowser = await readLayers(accountDraftKey(sharedId));
      if (restoredUnsaved) candidates.push(fromBrowser, fromScene);
      else candidates.push(fromScene, fromBrowser);
    } else if (localProject) {
      candidates.push(await readLayers(docKey(localProject.id)));
    } else if (imported) {
      candidates.push(importedLayers);
    }
    for (const doc of candidates) {
      if (doc && composer.loadDoc(doc, TIFO_FONTS)) {
        // Grids were saved, so nothing needs decoding to show the design; the
        // pictures are decoded in the background for when one is resized.
        void decodePictures(objects.list());
        break;
      }
    }
  }

  const projectRef: ProjectRef | null =
    ownedProject && sharedId ? { kind: 'account', id: sharedId }
      : localProject ? { kind: 'local', id: localProject.id }
        : null;
  const tb = mountToolbar(document.body, editor, store, map, objects, () => preview, null, sceneIO, {
    ref: projectRef,
    pending: isNew,
    unsynced: restoredUnsaved,
  }, composer);

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
  /** A banner Match Day should open looking at, when it was asked from the Banner view. */
  let focusOnOpen: string | null = null;
  const ensureBannerView = (): Promise<BannerView | null> => {
    if (bannerView) return Promise.resolve(bannerView);
    if (bannerLoading) return bannerLoading;
    bannerLoading = import('./ui/bannerView')
      .then(({ mountBannerView }) => {
        bannerView = mountBannerView({
          host: bannerHostEl,
          store,
          bannerStore,
          map,
          message: document.getElementById('message'),
          // Straight onto the banner, not onto the default camera.
          onOpenMatchDay: () => {
            focusOnOpen = bannerStore.activeId_;
            document.getElementById('match-day')?.click();
          },
          onToggleBeside: () => void setView(currentView === 'split' ? 'banner' : 'split'),
          onShowInStadium: (id) => void showInStadium(id),
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

  // "How banners work", in the Banner view's panel: its tour, again.
  document.getElementById('bn-tour')?.addEventListener('click', () => {
    void import('./ui/bannerTour').then(({ runBannerTour }) => runBannerTour());
  });

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
    // And one camera that is not a fixed place: wherever the banner is.
    // Only while there is a banner to be wherever: a tifo has none until
    // somebody makes one, and a camera that goes nowhere reads as broken.
    const bannerCam = document.createElement('option');
    bannerCam.value = 'banner';
    bannerCam.textContent = t('ed.camera.banner');
    sel.appendChild(bannerCam);
    const offerBannerCam = (): void => {
      bannerCam.disabled = !bannerStore.list().some((b) => b.visible !== false);
      // The last banner went while the camera was on it: back to the bowl,
      // rather than a menu showing a camera that is no longer offered.
      if (bannerCam.disabled && sel.value === 'banner') {
        const full = CAMERA_PRESETS.findIndex((p) => p.name === 'Full view');
        sel.value = String(Math.max(0, full));
        preview?.applyPreset(CAMERA_PRESETS[Math.max(0, full)]);
      }
    };
    offerBannerCam();
    bannerStore.onChange(offerBannerCam);
    sel.addEventListener('change', () => {
      if (sel.value === 'banner') preview!.focusBanner();
      else preview!.applyPreset(CAMERA_PRESETS[Number(sel.value)]);
    });
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
  /**
   * The drawing surface Split puts beside the stadium: the one you were last
   * drawing on.
   *
   * Split used to mean seats-and-stadium only, and a banner's placement was
   * blind: its panel sits in the Banner view, the bowl sits in the Stadium
   * view, and every "does it look right on the North stand" was a round trip
   * between the two. Now Split from a banner is the banner beside the bowl,
   * and the bowl turns to look at it whenever it moves.
   */
  let surface: '2d' | 'banner' = '2d';
  let currentView: ViewMode = '2d';
  const railFlag = document.getElementById('banner-studio-btn');

  // ---------- Post it: a picture of the tifo in the stadium (ui/postMoment.ts) ----------
  // The Stadium view, rendered fresh, is the picture. Asked for from 2D, the
  // view switches first: the post is of the bowl, and the person sees that it
  // is, rather than a picture of something they were not looking at.
  const capturePreview = async (): Promise<HTMLCanvasElement | null> => {
    if (currentView !== '3d' && currentView !== 'split') await setView('3d');
    let p = preview;
    for (let i = 0; !p && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      p = preview;
    }
    if (!p) return null;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return p.captureStill(1080);
  };
  const postDeps = {
    capture: capturePreview,
    title: () => tb.postTarget().title,
    publicDesignId: () => tb.postTarget().publicId,
  };
  /**
   * The one-time "Post it?" card. Someone who opened an existing project has
   * something to post; on a new one, only after they have made something (the
   * seeded border pattern is ours, not theirs). A short wait, so it arrives
   * after the bowl has, and not at all if they have already moved on.
   */
  let madeSomething = !isNew;
  store.onDirty(() => { madeSomething = true; });
  const offerPostSoon = (): void => {
    if (!madeSomething) return;
    window.setTimeout(() => {
      if (currentView !== '3d' && currentView !== 'split') return;
      void import('./ui/postMoment').then(({ maybeOfferPost }) => maybeOfferPost(postDeps));
    }, 1800);
  };

  const setView = async (next: ViewMode): Promise<void> => {
    if (next === '2d' || next === 'banner') surface = next;
    const bannerSplit = next === 'split' && surface === 'banner';
    const show2d = next === '2d' || (next === 'split' && !bannerSplit);
    const showBanner = next === 'banner' || bannerSplit;
    const show3dView = next === '3d' || next === 'split';
    currentView = next;
    // The phone shell draws its own view pill, and a view can change from
    // inside a panel ("Show in stadium") as well as from the pill.
    document.dispatchEvent(new CustomEvent('tifo:view', { detail: { view: next } }));
    if (show3dView) track('view_3d');
    if (next === 'banner') track('view_banner');
    host.hidden = !show2d;
    previewHost.hidden = !show3dView;
    camBar.hidden = !show3dView;
    canvasWrap.classList.toggle('split', next === 'split');
    canvasWrap.classList.toggle('banner-split', bannerSplit);
    btn2d.classList.toggle('active', next === '2d');
    btnBanner?.classList.toggle('active', next === 'banner');
    btn3d.classList.toggle('active', next === '3d');
    btnSplit.classList.toggle('active', next === 'split');
    railFlag?.classList.toggle('active', showBanner);

    // The Banner view owns the tool rail while it is up: the rail's buttons,
    // the palette, undo and the touch gestures all reach it through
    // `bannerHost` rather than through the seat editor.
    if (showBanner) {
      const bv = await ensureBannerView();
      bv?.show();
      bv?.setBeside(bannerSplit);
      // Its own short tour, the first time. It explains a view that works
      // differently from the rest of the editor at the moment somebody chose
      // to open it — see bannerTour.ts for why this one is offered and the
      // main tour is not.
      if (next === 'banner' && bv) {
        void import('./ui/bannerTour').then(({ offerBannerTour }) => offerBannerTour(() => currentView === 'banner'));
      }
    } else {
      bannerView?.hide();
    }

    if (show3dView) {
      const p = await ensurePreview();
      if (p) {
        p.recolorAll();
        p.start();
        if (bannerSplit && p.focusBanner()) {
          const sel = document.getElementById('camera-preset') as HTMLSelectElement | null;
          if (sel) sel.value = 'banner';
        }
      }
      offerPostSoon();
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

  /**
   * "Show in stadium", from a banner's row in the list: the Stadium view,
   * looking straight at it.
   *
   * A banner Match Day had hidden is shown again first — asking to see a
   * banner and being shown an empty stand is exactly the bug this exists to
   * end — and that is said, so nobody wonders why it came back.
   */
  const showInStadium = async (id: string): Promise<void> => {
    const doc = bannerStore.get(id);
    if (!doc) return;
    const msg = document.getElementById('message');
    bannerStore.setActive(id);
    const wasHidden = doc.visible === false;
    if (wasHidden) {
      bannerStore.begin();
      bannerStore.patch({ visible: true });
      bannerStore.commit();
    }
    await setView('3d');
    const p = preview;
    if (!p) return;
    const sel = document.getElementById('camera-preset') as HTMLSelectElement | null;
    if (p.focusBanner(id)) {
      if (sel) sel.value = 'banner';
      if (msg) msg.textContent = tv(wasHidden ? 'bn.msg.shownAgain' : 'bn.msg.shown', { name: doc.name });
    } else if (msg) {
      msg.textContent = tv('bn.msg.noPlace', { name: doc.name });
    }
  };

  btn2d.addEventListener('click', () => void setView('2d'));
  btnBanner?.addEventListener('click', () => void setView('banner'));
  btn3d.addEventListener('click', () => void setView('3d'));
  btnSplit.addEventListener('click', () => void setView('split'));
  // The tool rail's flag button is the other door into the same room. It used
  // to open a modal with a brush and a stand picker; that studio is gone and
  // this is where its work continued.
  railFlag?.addEventListener('click', () => {
    if (surface !== 'banner' || currentView === '3d') void setView('banner');
  });
  // Beside the bowl, the bowl follows the banner: move it to another stand
  // and the camera goes with it, rather than leaving you to find it.
  let lastPlace = '';
  bannerStore.onChange(() => {
    const a = bannerStore.active;
    const s = a?.slot;
    const key = a && s ? `${a.id}|${a.kind}|${s.stand}|${s.stands}|${s.blockFrom}|${s.blockSpan}|${s.tier}` : '';
    if (key === lastPlace) return;
    lastPlace = key;
    const sel = document.getElementById('camera-preset') as HTMLSelectElement | null;
    if (preview && !previewHost.hidden && (canvasWrap.classList.contains('banner-split') || sel?.value === 'banner')) {
      preview.focusBanner();
    }
  });

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
  // Banners live in their own key, and they belong to the tifo they were made
  // in — so they come back only when that tifo does: the draft this browser
  // was working on, or the same design carried onto another stadium. A new
  // tifo starts with none. It used to load them whatever the canvas held, so
  // a first visit, a link to another stadium, an imported file or a shared
  // design without banners all opened with the last tifo's banners on them.
  // Each project keeps its own, so they come back with that project and no
  // other: a local project's, an account project's unsaved ones, or the ones a
  // copy onto another stadium carried with it.
  try {
    const rawB = localProject
      ? readRaw(bannersKey(localProject.id))
      : restoredUnsaved && sharedId
        ? readRaw(accountBannersKey(sharedId))
        : remapBanners;
    if (rawB && bannerStore.count === 0) bannerStore.loadJSON(JSON.parse(rawB));
  } catch {
    /* ignore */
  }
  const writeBanners = (): void => {
    const key = tb.bannersKey();
    // Quota exceeded (a pasted photo): the banner still lives for this session.
    if (key) writeRaw(key, JSON.stringify(bannerStore.toJSON()));
  };
  // And the key is written with every draft, so the two always describe the
  // same tifo. A new tifo that never touches its banners would otherwise
  // leave the last one's in the key, to be restored with the new one's draft.
  document.addEventListener('tifo:draft-written', writeBanners);
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
    bannerSaveTimer = window.setTimeout(writeBanners, 600);
  });
  document.getElementById('post-tifo')?.addEventListener('click', () => {
    void import('./ui/postMoment').then(({ openPostSheet }) => openPostSheet(postDeps));
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
      const focusBanner = focusOnOpen;
      focusOnOpen = null;
      openMatchDaySimulator(map, store, template, assetStore, {
        bannerStore,
        focusBanner,
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
    if (msg) msg.textContent = tv('ed.proj.unsaved', { age: draftAge });
  }
  if (imported) {
    const msg = document.getElementById('message');
    if (msg) msg.textContent = t('ed.proj.imported');
  }

  // If we loaded a shared design or an imported file, reflect title + repaint.
  const loadedTitle = remapTitle ?? sharedTitle ?? pendingTitle;
  if (sharedLoaded && loadedTitle) {
    const docTitle = document.getElementById('doc-title') as HTMLInputElement | null;
    if (docTitle) docTitle.value = loadedTitle;
    editor.rebuildPalette();
    editor.repaintAll();
  }

  // A copy onto another stadium: say what happened. The original project is
  // untouched and still on the Projects page, so there is nothing to undo.
  if (remappedFrom) {
    editor.rebuildPalette();
    editor.repaintAll();
    const msg = document.getElementById('message');
    if (msg) msg.textContent = `design fitted to ${tl(template.id)}.`;
  }

  let clubStart = false;
  let clubPrompt = '';
  // The first-run guide: someone's very first project, started blank. Never
  // for a project that already has content (a file, a copy, a design from the
  // gallery) or one the AI is about to draw, and never again after the first.
  if (isNew && !sharedLoaded && !intent?.prompt && !hasOnboarded()) {
    const { openOnboarding } = await import('./ui/onboarding');
    const choice = await openOnboarding(PATTERN_PRESETS);
    if (choice?.kind === 'club' && choice.prompt) {
      // Start from your club: the free offline designer draws the whole bowl
      // now, before the project is created, so the saved starting point is
      // this design. The Stadium view follows once the project exists.
      const msg = document.getElementById('message');
      if (msg) msg.textContent = t('ob.clubMaking');
      clubPrompt = choice.prompt;
      clubStart = await tb.quickDesign(choice.prompt);
      // A whole design lands as one grouped change, which does not come
      // through onDirty the way a brush stroke does; say so directly.
      if (clubStart) madeSomething = true;
      if (msg && msg.textContent === t('ob.clubMaking')) msg.textContent = '';
    } else if (choice) {
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

  // A project being created: it exists from here on, in the account when
  // there is one and in this browser when there is not. Created AFTER the
  // guide, so the saved copy is the starting point they chose.
  if (isNew) {
    // A project started from a club is named after it, unless it already has a
    // name of its own (the default one does not count).
    const given = intent?.title?.trim();
    const clubTitle = clubStart && clubPrompt && (!given || given === t('np.nameDefault')) ? clubPrompt : '';
    const title = (
      clubTitle ||
      intent?.title?.trim() ||
      remapTitle ||
      sharedTitle ||
      pendingTitle ||
      t('np.nameDefault')
    ).slice(0, 80);
    await tb.createProject({ title, origin: intent?.prompt ? 'ai' : null });
    if (fromId) {
      const msg = document.getElementById('message');
      if (msg && !msg.textContent) msg.textContent = t('ed.proj.fromPick');
    }
    if (intent?.prompt) await tb.generate(intent.prompt, intent.autoName !== false);
    // Their club's tifo, in their stadium: the moment to show it off (and
    // where the one-time "Post it?" card comes in).
    if (clubStart) void setView('3d');
  }
  // "Publish to the community" on the Projects page opens the project here,
  // where the publish dialog and its name, tags and remix choices live.
  if (bootParams.get('publish') === '1') {
    const u = new URL(location.href);
    u.searchParams.delete('publish');
    history.replaceState(null, '', u.pathname + u.search);
    tb.publish();
  }

  // News, once each, to everyone who opens the editor — after the onboarding
  // dialog and any tour, never on top of them, and one card per visit: the
  // league stadiums first (leaguesNews.ts), "Banners are here" on a later
  // visit for whoever has not seen it (whatsNew.ts).
  void import('./ui/leaguesNews').then(({ leaguesNewsSeen, offerLeaguesNews }) => {
    if (!leaguesNewsSeen()) {
      offerLeaguesNews({
        openStadiums: (league) => {
          // The stadium list lives with the seat view's panel.
          if (currentView === 'banner') void setView('2d');
          if (document.body.classList.contains('m-shell')) {
            document.dispatchEvent(new CustomEvent('tifo:open-stadium'));
          } else {
            const rail = document.getElementById('rail-stadium');
            if (rail && !rail.classList.contains('menu-active')) rail.click();
          }
          requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('tifo:stadium-league', { detail: league ?? '' })));
        },
      });
      return;
    }
    void import('./ui/whatsNew').then(({ offerWhatsNew }) => offerWhatsNew({
      onTry: () => void setView('banner'),
      inBanner: () => currentView === 'banner',
    }));
  });

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
