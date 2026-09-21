import type { DesignStore } from '../core/design';
import type { ToolId } from '../core/types';
import type { BannerDoc, BannerKind, BannerReveal, StandIndex } from '../core/banner';
import {
  BannerStore, KIND_PROFILE, aspectOf, applyKind, bannerFacts, newBanner,
  physicalRevealMs, revealFloorSeconds,
} from '../core/banner';

/**
 * The reveal-length slider, which now has to span half a second and two
 * minutes on the same track.
 *
 * It did not have to before, because every reveal ran for 4.2 seconds. Now a
 * drop takes five and a rope lift takes forty, so a linear track would put
 * every useful value for a drop inside the first four pixels. A power curve
 * gives fine control where the short reveals live and still reaches a minute
 * and a half at the far end.
 */
const SECS_MIN = 0.4;
const SECS_MAX = 120;
const SECS_POW = 2.2;

function sliderToSecs(raw: number): number {
  const t = Math.max(0, Math.min(1, raw / 100));
  return SECS_MIN + Math.pow(t, SECS_POW) * (SECS_MAX - SECS_MIN);
}

function secsToSlider(secs: number): number {
  const t = (Math.max(SECS_MIN, Math.min(SECS_MAX, secs)) - SECS_MIN) / (SECS_MAX - SECS_MIN);
  return 100 * Math.pow(t, 1 / SECS_POW);
}

/**
 * The number under the slider, with a note when it is not what the rig does.
 *
 * Nobody watching a preview knows that a 36 x 18 m Aufziehfahne takes forty
 * seconds to haul. Showing what the real one takes, next to what they have
 * chosen, is how they find out — and it is the same figure the 3D uses, so
 * "real" is not a claim here, it is the default.
 */
function secsLabel(doc: BannerDoc): string {
  const secs = Math.max(revealFloorSeconds(doc), doc.revealMs / 1000);
  const real = physicalRevealMs(doc.kind, doc.widthM, doc.heightM) / 1000;
  const shown = secs >= 20 ? secs.toFixed(0) : secs.toFixed(1);
  if (Math.abs(secs - real) < Math.max(0.3, real * 0.06)) return `${shown}s`;
  return `${shown}s (real ${real >= 20 ? real.toFixed(0) : real.toFixed(1)}s)`;
}
import { BannerCanvas } from '../render/bannerCanvas';
import { invalidateBannerText } from '../render/bannerRender';
import { renderTextCanvas, TIFO_FONTS } from '../core/text';
import { SHAPE_ASPECT } from '../core/symbols';
import { BANNER_HISTORY_EVENT, bannerHost, type BannerHost } from './bannerHost';
import { t, tv, onLangChange } from './i18n';

/**
 * The Banner view — the fourth thing the view switcher can show.
 *
 * It owns the artboard, the bar above it and the placement panel beside it,
 * and it registers itself as the editor's `bannerHost` so the existing tool
 * rail, palette, undo buttons and touch gestures all drive it without the
 * toolbar needing to know what a banner is.
 *
 * The split between the two sets of controls is deliberate. `#banner-bar`
 * above the canvas is the SHEET — type, size, fabric — because changing any of
 * those changes what you are drawing on. `#ctx-banner` in the side panel is the
 * STADIUM — which stand, how high, how it is revealed — because that is judged
 * against the bowl, not against the art.
 */

export interface BannerViewDeps {
  /** The element the artboard fills. */
  host: HTMLElement;
  /** The design's palette, shared with the seat editor: one set of swatches. */
  store: DesignStore;
  bannerStore: BannerStore;
  /** Open the Match Day simulator (the banner is already in its scene). */
  onOpenMatchDay: () => void;
  /** Status line, shared with the rest of the editor. */
  message?: HTMLElement | null;
}

export interface BannerView {
  show(): void;
  hide(): void;
  destroy(): void;
  readonly canvas: BannerCanvas;
  /** Re-read the store into every control (after a load, or an undo). */
  sync(): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

export function mountBannerView(deps: BannerViewDeps): BannerView {
  const { host, store, bannerStore } = deps;

  // Always have something to draw on. A Banner view whose first frame is an
  // empty-state card is a worse introduction than a blank sheet of fabric.
  if (bannerStore.count === 0) bannerStore.add(newBanner('drop', t('bn.defaultName')));

  const canvas = BannerCanvas.create(host, bannerStore);
  let active = false;
  let syncing = false;
  const historyMoved = (): void => {
    document.dispatchEvent(new CustomEvent(BANNER_HISTORY_EVENT));
  };

  const bar = $<HTMLElement>('banner-bar');
  const panel = $<HTMLElement>('ctx-banner');
  const docSel = $<HTMLSelectElement>('bn-doc');
  const newBtn = $<HTMLButtonElement>('bn-new');
  const delBtn = $<HTMLButtonElement>('bn-del');
  const kindSel = $<HTMLSelectElement>('bn-kind');
  const wIn = $<HTMLInputElement>('bn-w');
  const hIn = $<HTMLInputElement>('bn-h');
  const matSel = $<HTMLSelectElement>('bn-material');
  const gsmSel = $<HTMLSelectElement>('bn-gsm');
  const seamsChk = $<HTMLInputElement>('bn-seams');
  const guidesChk = $<HTMLInputElement>('bn-guides');
  const snapChk = $<HTMLInputElement>('bn-snap');
  const bgIn = $<HTMLInputElement>('bn-bg');
  const bgNone = $<HTMLInputElement>('bn-bg-none');
  const factsEl = $<HTMLElement>('bn-facts');

  const standSel = $<HTMLSelectElement>('bn-stand');
  const alongIn = $<HTMLInputElement>('bn-along');
  const alongOut = $<HTMLElement>('bn-along-out');
  const upIn = $<HTMLInputElement>('bn-up');
  const upOut = $<HTMLElement>('bn-up-out');
  const outIn = $<HTMLInputElement>('bn-out');
  const outOut = $<HTMLElement>('bn-out-out');
  const tiltIn = $<HTMLInputElement>('bn-tilt');
  const tiltOut = $<HTMLElement>('bn-tilt-out');
  const centreBtn = $<HTMLButtonElement>('bn-centre');
  const fitStandBtn = $<HTMLButtonElement>('bn-fit-stand');
  const netChk = $<HTMLInputElement>('bn-net');
  const barChk = $<HTMLInputElement>('bn-bar');
  const revSel = $<HTMLSelectElement>('bn-reveal');
  const secsIn = $<HTMLInputElement>('bn-secs');
  const secsOut = $<HTMLElement>('bn-secs-out');
  const windIn = $<HTMLInputElement>('bn-wind');
  const windOut = $<HTMLElement>('bn-wind-out');
  const mdBtn = $<HTMLButtonElement>('bn-matchday');
  const notesEl = $<HTMLElement>('bn-notes');
  const brushIn = $<HTMLInputElement>('bn-brush');
  const brushOut = $<HTMLElement>('bn-brush-out');
  const clearArtBtn = $<HTMLButtonElement>('bn-clear-art');

  const say = (text: string): void => {
    if (deps.message) deps.message.textContent = text;
  };

  // -------------------------------------------------------------------------
  // Reading the store into the controls
  // -------------------------------------------------------------------------

  function sync(): void {
    const doc = bannerStore.active;
    syncing = true;
    try {
      if (docSel) {
        docSel.replaceChildren();
        for (const b of bannerStore.list()) {
          const o = document.createElement('option');
          o.value = b.id;
          o.textContent = b.name;
          docSel.appendChild(o);
        }
        docSel.value = doc?.id ?? '';
        docSel.disabled = bannerStore.count === 0;
      }
      if (delBtn) delBtn.disabled = bannerStore.count <= 1;
      if (!doc) return;

      if (kindSel) kindSel.value = doc.kind;
      if (wIn) wIn.value = String(round2(doc.widthM));
      if (hIn) hIn.value = String(round2(doc.heightM));
      if (matSel) matSel.value = doc.material;
      if (gsmSel) gsmSel.value = String(doc.fabricGsm);
      if (bgNone) bgNone.checked = doc.bg === null;
      if (bgIn) {
        bgIn.value = doc.bg ?? '#ffffff';
        bgIn.disabled = doc.bg === null;
      }
      if (standSel) standSel.value = String(doc.place.stand);
      if (alongIn) alongIn.value = String(Math.round(doc.place.alongU * 100));
      if (alongOut) alongOut.textContent = String(Math.round(doc.place.alongU * 100));
      if (upIn) upIn.value = String(Math.round(doc.place.heightV * 100));
      if (upOut) upOut.textContent = String(Math.round(doc.place.heightV * 100));
      if (outIn) outIn.value = String(Math.round(doc.place.outM * 10));
      if (outOut) outOut.textContent = `${round1(doc.place.outM)} m`;
      if (tiltIn) tiltIn.value = String(Math.round(doc.place.tiltDeg));
      if (tiltOut) tiltOut.textContent = `${Math.round(doc.place.tiltDeg)}°`;
      if (netChk) netChk.checked = doc.netBacked;
      if (barChk) barChk.checked = doc.weightBar;
      if (revSel) revSel.value = doc.reveal;
      if (secsIn) secsIn.value = String(Math.round(secsToSlider(doc.revealMs / 1000)));
      if (secsOut) secsOut.textContent = secsLabel(doc);
      if (windIn) windIn.value = String(Math.round(doc.wind * 100));
      if (windOut) windOut.textContent = String(Math.round(doc.wind * 100));
      if (brushIn) brushIn.value = String(Math.round(canvas.brushM * 100));
      if (brushOut) brushOut.textContent = tv('bn.cm', { n: Math.round(canvas.brushM * 100) });
      renderFacts(doc);
    } finally {
      syncing = false;
    }
  }

  /**
   * The line under the bar, and the notes in the panel.
   *
   * Everything here is derived — seams from the 3 m panel width, weight from
   * area times the fabric's g/m², the cap height from the viewing distance —
   * so none of it can be stale in the way a hard-coded hint can. It is the same
   * posture the stadium estimator takes: quote the rule, not an opinion.
   */
  function renderFacts(doc: BannerDoc): void {
    const f = bannerFacts(doc);
    if (factsEl) {
      factsEl.textContent = tv('bn.facts', {
        panels: f.panels,
        kg: f.weightKg < 10 ? f.weightKg.toFixed(1) : String(Math.round(f.weightKg)),
        cap: round1(f.headlineCapM),
      });
    }
    if (notesEl) {
      notesEl.replaceChildren();
      for (const n of f.notes) {
        const p = document.createElement('p');
        p.className = `bn-note ${n.level}`;
        p.textContent = n.vals ? tv(`bn.note.${n.key}`, n.vals) : t(`bn.note.${n.key}`);
        notesEl.appendChild(p);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Writing the controls into the store
  // -------------------------------------------------------------------------

  /** Wrap a control change as one undo entry. */
  const edit = (fn: () => void): void => {
    if (syncing) return;
    bannerStore.begin();
    fn();
    bannerStore.commit();
  };

  docSel?.addEventListener('change', () => bannerStore.setActive(docSel.value || null));
  newBtn?.addEventListener('click', () => {
    const n = bannerStore.count + 1;
    bannerStore.add(newBanner('drop', tv('bn.nameN', { n })));
    canvas.fitToView();
    say(t('bn.msg.added'));
  });
  delBtn?.addEventListener('click', () => {
    const doc = bannerStore.active;
    if (!doc || bannerStore.count <= 1) return;
    bannerStore.remove(doc.id);
    canvas.fitToView();
  });

  kindSel?.addEventListener('change', () => {
    const doc = bannerStore.active;
    if (!doc) return;
    edit(() => {
      const next = applyKind(doc, kindSel.value as BannerKind);
      bannerStore.patch(next);
    });
    canvas.fitToView();
    say(tv('bn.msg.kind', { name: kindSel.selectedOptions[0]?.textContent?.trim() ?? '' }));
  });

  const sizeChanged = (): void => {
    const doc = bannerStore.active;
    if (!doc || !wIn || !hIn) return;
    edit(() => bannerStore.patch({
      widthM: clamp(Number(wIn.value) || doc.widthM, 0.5, 400),
      heightM: clamp(Number(hIn.value) || doc.heightM, 0.3, 120),
    }));
    canvas.fitToView();
  };
  wIn?.addEventListener('change', sizeChanged);
  hIn?.addEventListener('change', sizeChanged);

  matSel?.addEventListener('change', () => edit(() => bannerStore.patch({ material: matSel.value as 'solid' | 'mesh' })));
  gsmSel?.addEventListener('change', () => edit(() => bannerStore.patch({ fabricGsm: Number(gsmSel.value) })));

  seamsChk?.addEventListener('change', () => { canvas.showSeams = seamsChk.checked; canvas.requestDraw(); });
  guidesChk?.addEventListener('change', () => { canvas.showGuides = guidesChk.checked; canvas.requestDraw(); });
  snapChk?.addEventListener('change', () => {
    canvas.snap = snapChk.checked;
    const doc = bannerStore.active;
    if (doc) edit(() => bannerStore.patchPlace({ snap: snapChk.checked }));
  });

  const bgChanged = (): void => {
    if (!bgIn || !bgNone) return;
    edit(() => bannerStore.patch({ bg: bgNone.checked ? null : bgIn.value }));
  };
  bgIn?.addEventListener('input', bgChanged);
  bgNone?.addEventListener('change', bgChanged);

  standSel?.addEventListener('change', () => edit(() => bannerStore.patchPlace({ stand: Number(standSel.value) as StandIndex })));
  alongIn?.addEventListener('input', () => {
    if (alongOut) alongOut.textContent = alongIn.value;
    edit(() => bannerStore.patchPlace({ alongU: Number(alongIn.value) / 100 }));
  });
  upIn?.addEventListener('input', () => {
    if (upOut) upOut.textContent = upIn.value;
    edit(() => bannerStore.patchPlace({ heightV: Number(upIn.value) / 100 }));
  });
  outIn?.addEventListener('input', () => {
    const m = Number(outIn.value) / 10;
    if (outOut) outOut.textContent = `${round1(m)} m`;
    edit(() => bannerStore.patchPlace({ outM: m }));
  });
  tiltIn?.addEventListener('input', () => {
    if (tiltOut) tiltOut.textContent = `${tiltIn.value}°`;
    edit(() => bannerStore.patchPlace({ tiltDeg: Number(tiltIn.value) }));
  });

  centreBtn?.addEventListener('click', () => {
    edit(() => bannerStore.patchPlace({ alongU: 0.5, yawDeg: 0 }));
    say(t('bn.msg.centred'));
  });

  /**
   * Size the banner to the stand it is on.
   *
   * The real width and height of a stand are only known to the simulator, so
   * this asks for the numbers the editor does have — the template's own plan —
   * through a custom event the simulator answers when it is open, and falls
   * back to the type's own default band when it is not. A banner sized to a
   * stand it has never seen would be a confident wrong answer.
   */
  fitStandBtn?.addEventListener('click', () => {
    const doc = bannerStore.active;
    if (!doc) return;
    const ev = new CustomEvent<{ stand: number; width?: number; height?: number }>('tifo:stand-extent', {
      detail: { stand: doc.place.stand },
    });
    document.dispatchEvent(ev);
    const w = ev.detail.width;
    const h = ev.detail.height;
    if (w && h) {
      edit(() => bannerStore.patch({ widthM: round1(w * 0.82), heightM: round1(h * 0.8) }));
      say(tv('bn.msg.fitStand', { w: round1(w * 0.82), h: round1(h * 0.8) }));
    } else {
      const p = KIND_PROFILE[doc.kind];
      edit(() => bannerStore.patch({ widthM: p.widthM, heightM: p.heightM }));
      say(t('bn.msg.fitStandGuess'));
    }
    canvas.fitToView();
  });

  netChk?.addEventListener('change', () => edit(() => bannerStore.patch({ netBacked: netChk.checked })));
  barChk?.addEventListener('change', () => edit(() => bannerStore.patch({ weightBar: barChk.checked })));
  revSel?.addEventListener('change', () => edit(() => bannerStore.patch({ reveal: revSel.value as BannerReveal })));
  secsIn?.addEventListener('input', () => {
    const ms = Math.round(sliderToSecs(Number(secsIn.value)) * 1000);
    const doc = bannerStore.active;
    if (secsOut && doc) secsOut.textContent = secsLabel({ ...doc, revealMs: ms });
    edit(() => bannerStore.patch({ revealMs: ms }));
  });
  windIn?.addEventListener('input', () => {
    if (windOut) windOut.textContent = windIn.value;
    edit(() => bannerStore.patch({ wind: Number(windIn.value) / 100 }));
  });
  mdBtn?.addEventListener('click', () => deps.onOpenMatchDay());

  brushIn?.addEventListener('input', () => {
    canvas.brushM = Number(brushIn.value) / 100;
    if (brushOut) brushOut.textContent = tv('bn.cm', { n: Number(brushIn.value) });
  });
  clearArtBtn?.addEventListener('click', () => {
    bannerStore.clearArt();
    say(t('bn.msg.cleared'));
  });

  // -------------------------------------------------------------------------
  // Canvas hooks
  // -------------------------------------------------------------------------

  /**
   * Where the next stamp lands.
   *
   * The artboard knows where you clicked; the toolbar knows what you are
   * placing (the typed string, the chosen shape, the decoded bitmap). Neither
   * can do it alone and neither should import the other, so the artboard
   * records the point and announces the click, the toolbar runs its own
   * placement routine, and that routine comes back through `placeText` and
   * friends to spend the point. It is the same arrangement `tifo:import-armed`
   * already uses between the toolbar and the phone shell.
   */
  let pendingPoint: { x: number; y: number } | null = null;
  const spendPoint = (): { x: number; y: number } => {
    const p = pendingPoint ?? canvas.viewCentre();
    pendingPoint = null;
    return p;
  };
  canvas.onPlaceStamp = (x, y) => {
    pendingPoint = { x, y };
    document.dispatchEvent(new CustomEvent('tifo:banner-place'));
  };

  canvas.onColorPick = (hex) => {
    // The banner shares the design's swatch set, so picking a colour off a
    // banner adds it to the same palette the seats paint from. One palette per
    // design, whichever surface you picked it on.
    const idx = store.addSwatch(hex);
    canvas.color = store.palette[idx] ?? hex;
    document.dispatchEvent(new CustomEvent('tifo:banner-pick', { detail: { index: idx, hex } }));
  };
  canvas.onDoubleTap = () => canvas.fitToView();
  canvas.onZoom = () => {
    const z = $<HTMLElement>('zoom-level');
    if (z && active) z.textContent = `${canvas.zoomPct}%`;
  };
  canvas.onHistory = historyMoved;
  canvas.onTwoFingerTap = () => {
    if (!bannerStore.canUndo) return;
    bannerStore.undo();
    historyMoved();
  };

  bannerStore.onChange(sync);
  bannerStore.onHistoryChange(historyMoved);
  // A banner's type is drawn with the display faces, so the glyph cache has to
  // be dropped when they land or a banner opened during the download keeps its
  // fallback-font text forever.
  onLangChange(() => {
    invalidateBannerText();
    sync();
    canvas.requestDraw();
  });

  // -------------------------------------------------------------------------
  // The host contract
  // -------------------------------------------------------------------------

  const impl: BannerHost = {
    get active() {
      return active;
    },
    setTool(tool: ToolId) {
      canvas.setTool(tool);
    },
    undo() {
      bannerStore.undo();
    },
    redo() {
      bannerStore.redo();
    },
    get canUndo() {
      return bannerStore.canUndo;
    },
    get canRedo() {
      return bannerStore.canRedo;
    },
    fit() {
      canvas.fitToView();
    },
    zoomBy(f: number) {
      canvas.zoomBy(f);
    },
    setColor(hex: string) {
      canvas.color = hex;
    },
    placeText(o) {
      const doc = bannerStore.active;
      if (!doc) return false;
      const css = TIFO_FONTS.find((f) => f.id === o.fontId)?.css ?? TIFO_FONTS[0].css;
      const r = renderTextCanvas(o.text, css, o.arcDeg);
      if (!r) return false;
      const aspect = aspectOf(doc);
      // A headline lands at the size that reads: the cap-height band the
      // artboard draws. Resize handles take it from there — which is how you
      // size type in a vector editor, and why the seat editor's seat-count
      // slider is not plumbed through to here.
      const capFrac = bannerFacts(doc).headlineCapFrac;
      const h = clamp((capFrac * r.canvas.height) / r.glyphHeight, 0.05 * aspect, 0.8 * aspect);
      const w = h * (r.canvas.width / r.canvas.height);
      const c = spendPoint();
      canvas.placeText({
        text: o.text, fontId: o.fontId, arcDeg: o.arcDeg, color: o.color,
        cx: inBanner(c.x, 0, 1), cy: inBanner(c.y, 0, aspect),
        w, h, rot: 0,
      });
      return true;
    },
    placeShape(o) {
      const doc = bannerStore.active;
      if (!doc) return false;
      const aspect = aspectOf(doc);
      const h = 0.3 * aspect;
      const w = h * (SHAPE_ASPECT[o.shape] ?? 1);
      const c = spendPoint();
      canvas.placeShape({
        shape: o.shape, color: o.color,
        cx: inBanner(c.x, 0, 1), cy: inBanner(c.y, 0, aspect),
        w, h, rot: 0,
      });
      return true;
    },
    placeImage(o) {
      const doc = bannerStore.active;
      if (!doc) return false;
      const src = bitmapToDataUrl(o.bitmap);
      if (!src) return false;
      const aspect = aspectOf(doc);
      const w = 0.6;
      const h = w * (o.bitmap.height / Math.max(1, o.bitmap.width));
      const c = spendPoint();
      canvas.placeImage({
        src, name: o.name,
        cx: inBanner(c.x, 0, 1), cy: inBanner(c.y, 0, aspect),
        w, h, rot: 0, opacity: 1,
      });
      return true;
    },
  };

  sync();

  return {
    canvas,
    sync,
    show() {
      active = true;
      bannerHost.current = impl;
      document.body.classList.add('banner-view');
      if (bar) bar.hidden = false;
      if (panel) panel.style.display = '';
      host.hidden = false;
      historyMoved();
      // The host was display:none until now, so the artboard has never had a
      // size to fit to. Wait one frame for layout, then frame the banner.
      requestAnimationFrame(() => {
        canvas.requestDraw();
        canvas.fitToView();
      });
      sync();
    },
    hide() {
      active = false;
      if (bannerHost.current === impl) bannerHost.current = null;
      document.body.classList.remove('banner-view');
      if (bar) bar.hidden = true;
      if (panel) panel.style.display = 'none';
      host.hidden = true;
      historyMoved();
    },
    destroy() {
      if (bannerHost.current === impl) bannerHost.current = null;
      document.body.classList.remove('banner-view');
      canvas.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Keep a stamp on the fabric even when the view is scrolled off it. */
function inBanner(v: number, lo: number, hi: number): number {
  return clamp(v, lo + (hi - lo) * 0.06, hi - (hi - lo) * 0.06);
}

/**
 * An imported bitmap as a data URL, capped.
 *
 * Banners travel inside the design's save payload, so an 8-megapixel photo
 * pasted onto one would be the difference between a design that saves and one
 * that is rejected. Large printed flags need only about 15 px per inch at final
 * size, so 1,600 px on the long edge is already generous for a sheet metres
 * across — and JPEG is used for anything fully opaque, which is most photos.
 */
export const BANNER_IMAGE_MAX_EDGE = 1600;

function bitmapToDataUrl(bmp: ImageBitmap): string | null {
  const scale = Math.min(1, BANNER_IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  // Opaque? Then JPEG, which is four to ten times smaller than PNG for a photo.
  let opaque = true;
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 250) {
        opaque = false;
        break;
      }
    }
  } catch {
    opaque = false; // tainted canvas — assume alpha and keep PNG
  }
  return opaque ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png');
}
