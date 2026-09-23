import type { DesignStore } from '../core/design';
import type { SeatMap, ToolId } from '../core/types';
import type { BannerDoc, BannerItem, BannerKind, BannerReveal, BannerSize, StandIndex } from '../core/banner';
import {
  BannerStore, aspectOf, applyKind, bannerFacts, newBanner, estimateSize,
  BANNER_PRESETS, KIND_REVEALS, presetOf, isPlaced,
  physicalRevealMs, revealSeconds,
} from '../core/banner';
import { spanFrameCache, type StandFrame } from '../render/simulator/standFrame';
import { resolveSlot, maxUsefulSpan, hangableTiers, type ResolvedSlot } from '../render/simulator/bannerSlot';

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
 * The shape of the sheet, as people describe banners.
 *
 * "2:1" rather than "0.50", because a tifo crew says "two to one" and because
 * a decimal that is the height divided by the width is the wrong way up for
 * anyone who has ever ordered fabric.
 */
function aspectLabel(a: number): string {
  if (a <= 1) return `${(1 / a).toFixed(a > 0.5 ? 1 : 0)}:1`;
  return `1:${a.toFixed(a < 2 ? 1 : 0)}`;
}

function secsText(s: number): string {
  return s >= 20 ? s.toFixed(0) : s.toFixed(1);
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
 * It owns the artboard, the bar above it and the panel beside it, and it
 * registers itself as the editor's `bannerHost` so the existing tool rail,
 * palette, undo buttons, keys and touch gestures all drive it without the
 * toolbar needing to know what a banner is.
 *
 * The split between the two sets of controls is deliberate. `#banner-bar`
 * above the canvas is the SHEET — type, size, fabric — because changing any of
 * those changes what you are drawing on. `#ctx-banner` in the side panel is
 * everything else: the tool in hand, the thing selected, and the STADIUM —
 * which stand, which blocks, how it is revealed.
 */

export interface BannerViewDeps {
  /** The element the artboard fills. */
  host: HTMLElement;
  /** The design's palette, shared with the seat editor: one set of swatches. */
  store: DesignStore;
  bannerStore: BannerStore;
  /**
   * The seat map, which is what a stand's blocks and tiers are measured from.
   *
   * The panel used to ASK Match Day for them — by an event only an open
   * simulator answered — and Match Day covers the whole screen, so in
   * practice nobody ever saw the block and tier pickers at all: the panel
   * opened with Stand, Across and an estimated size, and nothing else. The
   * frames are a pure function of the seat map, so the panel builds the same
   * ones Match Day does, from the same map, and never has to ask.
   */
  map: SeatMap;
  /** Open the Match Day simulator (the banner is already in its scene). */
  onOpenMatchDay: () => void;
  /** Put the stadium beside the artboard, or take it away. */
  onToggleBeside?: () => void;
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
  /** Reflect whether the stadium is showing beside the artboard. */
  setBeside(on: boolean): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** What a stand offers a banner, measured from the seat map. */
interface StandOffer {
  frame: StandFrame;
  blocks: number;
  tiers: number;
  /** The tiers this banner may use; a flown one cannot use a gap too thin to hang in. */
  tierOptions: number[];
  /** The widest run that still makes this banner bigger — see `maxUsefulSpan`. */
  maxSpan: number;
  fit: ResolvedSlot;
}

export function mountBannerView(deps: BannerViewDeps): BannerView {
  const { host, store, bannerStore } = deps;
  const frameFor = spanFrameCache(deps.map);

  // Always have something to draw on. A Banner view whose first frame is an
  // empty-state card is a worse introduction than a blank sheet of fabric.
  if (bannerStore.count === 0) {
    bannerStore.add(newBanner('stand', t('bn.defaultName')));
    bannerStore.clearHistory();
  }

  const canvas = BannerCanvas.create(host, bannerStore);
  let active = false;
  let syncing = false;
  const historyMoved = (): void => {
    document.dispatchEvent(new CustomEvent(BANNER_HISTORY_EVENT));
  };

  const bar = $<HTMLElement>('banner-bar');
  const panel = $<HTMLElement>('ctx-banner');
  const docSel = $<HTMLSelectElement>('bn-doc');
  const nameIn = $<HTMLInputElement>('bn-name');
  const renameBtn = $<HTMLButtonElement>('bn-rename');
  const newBtn = $<HTMLButtonElement>('bn-new');
  const delBtn = $<HTMLButtonElement>('bn-del');
  const kindSel = $<HTMLSelectElement>('bn-kind');
  const presetSel = $<HTMLSelectElement>('bn-preset');
  const aspIn = $<HTMLInputElement>('bn-aspect');
  const aspOut = $<HTMLElement>('bn-aspect-out');
  const matSel = $<HTMLSelectElement>('bn-material');
  const gsmSel = $<HTMLSelectElement>('bn-gsm');
  const seamsChk = $<HTMLInputElement>('bn-seams');
  const guidesChk = $<HTMLInputElement>('bn-guides');
  const snapChk = $<HTMLInputElement>('bn-snap');
  const bgIn = $<HTMLInputElement>('bn-bg');
  const bgNone = $<HTMLInputElement>('bn-bg-none');
  const factsEl = $<HTMLElement>('bn-facts');

  const brushBlock = $<HTMLElement>('bn-brush-block');
  const itemBlock = $<HTMLElement>('bn-item-block');
  const itemName = $<HTMLElement>('bn-item-name');
  const itemFront = $<HTMLButtonElement>('bn-item-front');
  const itemBack = $<HTMLButtonElement>('bn-item-back');
  const itemDup = $<HTMLButtonElement>('bn-item-dup');
  const itemDel = $<HTMLButtonElement>('bn-item-del');

  const standSel = $<HTMLSelectElement>('bn-stand');
  const acrossSel = $<HTMLSelectElement>('bn-across');
  const blockSel = $<HTMLSelectElement>('bn-block');
  const spanSel = $<HTMLSelectElement>('bn-span');
  const tierSel = $<HTMLSelectElement>('bn-tier');
  const blockRow = $<HTMLElement>('bn-block-row');
  const tierRow = $<HTMLElement>('bn-tier-row');
  const fitNoteEl = $<HTMLElement>('bn-fit-note');
  const sizeOutEl = $<HTMLElement>('bn-size-out');
  const besideBtn = $<HTMLButtonElement>('bn-beside');
  const hiddenNote = $<HTMLElement>('bn-hidden');
  const unhideBtn = $<HTMLButtonElement>('bn-unhide');
  const netChk = $<HTMLInputElement>('bn-net');
  const barChk = $<HTMLInputElement>('bn-bar');
  const revSel = $<HTMLSelectElement>('bn-reveal');
  const secsBlock = $<HTMLElement>('bn-secs-block');
  const secsIn = $<HTMLInputElement>('bn-secs');
  const secsOut = $<HTMLElement>('bn-secs-out');
  const secsReal = $<HTMLElement>('bn-secs-real');
  const secsRealText = $<HTMLElement>('bn-secs-real-text');
  const secsAuto = $<HTMLButtonElement>('bn-secs-auto');
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
  // What the stand offers, measured here
  // -------------------------------------------------------------------------

  /** The same frame Match Day and the editor's bowl build, from the same map. */
  const frameOf = (doc: BannerDoc): StandFrame => frameFor(doc.slot.stand, doc.slot.stands);

  const offerOf = (doc: BannerDoc): StandOffer | null => {
    const f = frameOf(doc);
    if (!f.ok) return null;
    return {
      frame: f,
      blocks: f.blocks.length,
      tiers: f.tiers.length,
      tierOptions: doc.kind === 'hanging' ? hangableTiers(f) : f.tiers.map((_, i) => i),
      maxSpan: maxUsefulSpan(doc, f),
      fit: resolveSlot(doc, f),
    };
  };

  /**
   * The size the blocks give this banner on this ground, remembered.
   *
   * The artboard asks on every frame it draws — the ruler, the seams, the
   * type band and the brush are all in real metres — and a brush stroke draws
   * sixty frames a second, so the answer is kept until something it depends
   * on changes.
   */
  let sizeKey = '';
  let sizeVal: BannerSize = { widthM: 1, heightM: 1 };
  const realSize = (doc: BannerDoc): BannerSize => {
    const s = doc.slot;
    const key = `${doc.id}|${doc.kind}|${doc.aspect}|${s.stand}|${s.stands}|${s.blockFrom}|${s.blockSpan}|${s.tier}`;
    if (key !== sizeKey) {
      const f = frameOf(doc);
      sizeVal = f.ok ? resolveSlot(doc, f).size : estimateSize(doc);
      sizeKey = key;
    }
    return sizeVal;
  };
  canvas.sizeOf = realSize;
  canvas.capLabel = (m) => tv('bn.capBand', { m });

  /** A stand's name in the current language. */
  const standName = (st: StandIndex): string => t(`dir.${['east', 'north', 'west', 'south'][st]}`);

  const opt = (sel: HTMLSelectElement, value: string, label: string): void => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };

  /** Fill the block, span and tier pickers from the stand the banner is on. */
  function syncSlots(doc: BannerDoc): void {
    const offer = offerOf(doc);
    if (acrossSel) {
      // Say WHICH two. "Two stands, round the corner" left you to find out
      // which corner by looking: the run goes on from this stand into the
      // next one round the bowl.
      const two = acrossSel.querySelector<HTMLOptionElement>('option[value="2"]');
      if (two) two.textContent = tv('bn.across.pair', { a: standName(doc.slot.stand), b: standName(((doc.slot.stand + 1) % 4) as StandIndex) });
      acrossSel.value = String(doc.slot.stands);
    }
    const nBlocks = offer?.blocks ?? 0;
    const nTiers = offer?.tiers ?? 0;

    if (blockRow) blockRow.style.display = nBlocks > 0 ? '' : 'none';
    if (tierRow) tierRow.style.display = nTiers > 1 ? '' : 'none';

    if (blockSel && offer && nBlocks > 0) {
      blockSel.replaceChildren();
      opt(blockSel, '-1', t('bn.block.centred'));
      for (let i = 0; i < nBlocks; i++) opt(blockSel, String(i), tv('bn.block.n', { n: i + 1 }));
      blockSel.value = doc.slot.blockFrom < 0 ? '-1' : String(offer.fit.blockFrom);
    }
    // Only the runs that actually make the banner bigger. Past a point the
    // stand runs out of rake before the artwork's proportions are satisfied
    // and every wider run draws the identical sheet, which reads as the
    // control being broken rather than as the stand being full.
    const nSpan = Math.max(1, Math.min(nBlocks, offer?.maxSpan ?? nBlocks));
    if (spanSel && nBlocks > 0) {
      spanSel.replaceChildren();
      for (let i = 1; i <= nSpan; i++) {
        opt(spanSel, String(i), i === 1 ? t('bn.span.one') : tv('bn.span.n', { n: i }));
      }
      spanSel.value = String(Math.max(1, Math.min(nSpan, doc.slot.blockSpan)));
    }
    if (tierSel && offer && nTiers > 0) {
      tierSel.replaceChildren();
      opt(tierSel, '-1', t('bn.tier.all'));
      for (const i of offer.tierOptions) opt(tierSel, String(i), tv('bn.tier.n', { n: i + 1 }));
      tierSel.value = offer.tierOptions.includes(doc.slot.tier) ? String(doc.slot.tier) : '-1';
    }

    // The size the blocks give it. Not a field to fill in — the whole point of
    // the slot model is that there is no size to get wrong — so this is a
    // readout, in metres, of what those blocks come to on this ground.
    if (sizeOutEl) {
      const f = offer?.fit;
      sizeOutEl.textContent = f
        ? tv('bn.size.is', { w: Math.round(f.size.widthM), h: round1(f.size.heightM) })
        : tv('bn.size.about', {
          w: Math.round(estimateSize(doc).widthM), h: Math.round(estimateSize(doc).heightM),
        });
    }
    // What overrules the blocks and the shape, and why.
    if (fitNoteEl) {
      const f = offer?.fit;
      let note = '';
      if (doc.slotAspect !== null) note = t('bn.fit.fascia');
      else if (f && f.heightLimited && nSpan < nBlocks) note = tv('bn.fit.capped', { n: nSpan });
      else if (f && f.heightLimited) {
        note = tv('bn.fit.short', { fw: Math.round(f.size.widthM), fh: Math.round(f.size.heightM) });
      }
      fitNoteEl.textContent = note;
      fitNoteEl.style.display = note ? '' : 'none';
    }
  }

  /** The reveals this type can perform, and nothing else. */
  function syncReveal(doc: BannerDoc): void {
    if (revSel) {
      const want = KIND_REVEALS[doc.kind];
      const have = [...revSel.options].map((o) => o.value);
      if (have.join() !== want.join()) {
        revSel.replaceChildren();
        for (const r of want) opt(revSel, r, t(`bn.rev.${r}`));
      } else {
        for (const o of revSel.options) o.textContent = t(`bn.rev.${o.value}`);
      }
      revSel.value = doc.reveal;
    }
    // "Already up" has no length. A seconds slider under it was a control for
    // a thing the panel had just said does not happen.
    const timed = doc.reveal !== 'cut';
    if (secsBlock) secsBlock.hidden = !timed;
    if (!timed) return;
    const size = realSize(doc);
    const shown = revealSeconds(doc, size);
    const real = physicalRevealMs(doc.reveal, size) / 1000;
    if (secsIn) secsIn.value = String(Math.round(secsToSlider(shown)));
    if (secsOut) secsOut.textContent = tv('bn.secs.v', { s: secsText(shown) });
    const off = !doc.revealAuto && Math.abs(shown - real) >= Math.max(0.3, real * 0.06);
    if (secsReal) secsReal.hidden = !off;
    if (secsRealText && off) secsRealText.textContent = tv('bn.secs.real', { s: secsText(real) });
  }

  /** What the selected item is, in words. */
  function itemLabel(it: BannerItem): string {
    if (it.kind === 'text') return tv('bn.item.text', { t: it.text.length > 18 ? `${it.text.slice(0, 17)}…` : it.text });
    if (it.kind === 'fill') return t('bn.item.patch');
    return t(`bn.item.${it.kind}`);
  }

  /** The panel's two contextual blocks: the tool in hand, and the thing selected. */
  function syncContext(): void {
    const tool = canvas.tool;
    if (brushBlock) brushBlock.hidden = !(tool === 'brush' || tool === 'eraser');
    const it = tool === 'select' ? bannerStore.selectedItem : null;
    if (itemBlock) itemBlock.hidden = !it;
    if (it && itemName) itemName.textContent = itemLabel(it);
    const doc = bannerStore.active;
    const i = it && doc ? doc.items.indexOf(it) : -1;
    if (itemFront) itemFront.disabled = !doc || i < 0 || i === doc.items.length - 1;
    if (itemBack) itemBack.disabled = !doc || i <= 0;
  }

  // -------------------------------------------------------------------------
  // Reading the store into the controls
  // -------------------------------------------------------------------------

  let framedId = '';
  let framedAspect = 0;
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
      syncContext();
      if (!doc) return;

      if (kindSel) kindSel.value = doc.kind;
      // The sheet changed shape under the artboard — a preset, the slider, or
      // a strip between two tiers growing with its blocks — so frame it again
      // rather than leave it hanging off the sides of the view.
      const shape = aspectOf(doc);
      if (doc.id === framedId && Math.abs(shape - framedAspect) > 1e-4) canvas.fitToView();
      framedId = doc.id;
      framedAspect = shape;
      // Between two tiers the gap sets the shape, so the controls that set it
      // are not the user's to move until the banner is somewhere else.
      const shapeLocked = doc.slotAspect !== null;
      if (presetSel) {
        if (!presetSel.options.length) {
          opt(presetSel, '', t('bn.preset.custom'));
          for (const b of BANNER_PRESETS) opt(presetSel, b.id, t(`bn.preset.${b.id}`));
        }
        presetSel.value = presetOf(doc) ?? '';
        presetSel.disabled = shapeLocked;
      }
      if (aspIn) {
        aspIn.value = String(Math.round(aspectOf(doc) * 100));
        aspIn.disabled = shapeLocked;
      }
      if (aspOut) aspOut.textContent = aspectLabel(aspectOf(doc));
      if (matSel) matSel.value = doc.material;
      if (gsmSel) gsmSel.value = String(doc.fabricGsm);
      if (bgNone) bgNone.checked = doc.bg === null;
      if (bgIn) {
        if (doc.bg) bgIn.value = doc.bg;
        bgIn.disabled = doc.bg === null;
      }
      if (standSel) {
        // A stand this ground does not have is not somewhere to put a banner.
        // Every ground in the catalogue has all four; an imported one may not,
        // and choosing a stand that is not there made the banner vanish.
        for (const o of standSel.options) {
          const f = frameFor(Number(o.value) as StandIndex, doc.slot.stands);
          o.disabled = !f.ok;
          const name = standName(Number(o.value) as StandIndex);
          o.textContent = f.ok ? name : tv('bn.stand.none', { name });
        }
        standSel.value = String(doc.slot.stand);
      }
      if (hiddenNote) hiddenNote.hidden = doc.visible !== false;
      syncSlots(doc);
      if (netChk) netChk.checked = doc.netBacked;
      if (barChk) barChk.checked = doc.weightBar;
      syncReveal(doc);
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
    // Measured on this ground: a seam count is a fact about a physical sheet,
    // so it has to come from the size the blocks actually give it.
    const f = bannerFacts(doc, realSize(doc));
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

  /**
   * A slider as ONE undo step per drag, not one per pixel of it.
   *
   * The gesture opens on the first movement and closes when the slider is let
   * go — or, for input that never sends a release (a keyboard, a script), a
   * moment after the last movement, so an open gesture can never swallow the
   * next edit into itself.
   */
  function sliderEdit(el: HTMLInputElement | null, apply: () => void): void {
    if (!el) return;
    let open = false;
    let timer = 0;
    const close = (): void => {
      window.clearTimeout(timer);
      if (!open) return;
      open = false;
      bannerStore.commit();
    };
    el.addEventListener('input', () => {
      if (syncing || !bannerStore.active) return;
      if (!open) {
        open = true;
        bannerStore.begin();
      }
      apply();
      window.clearTimeout(timer);
      timer = window.setTimeout(close, 500);
    });
    el.addEventListener('change', close);
  }

  docSel?.addEventListener('change', () => bannerStore.setActive(docSel.value || null));
  newBtn?.addEventListener('click', () => {
    const n = bannerStore.count + 1;
    const doc = newBanner('stand', tv('bn.nameN', { n }));
    // On a stand nobody has used yet. Every new banner used to land in the
    // same centred slot on the North stand, exactly on top of the last one,
    // so the second banner of a design was invisible under the first.
    const used = new Set(bannerStore.list().map((b) => b.slot.stand));
    const free = ([1, 3, 0, 2] as StandIndex[]).find((st) => !used.has(st) && frameFor(st, 1).ok);
    if (free !== undefined) doc.slot = { ...doc.slot, stand: free };
    bannerStore.add(doc);
    canvas.fitToView();
    say(t('bn.msg.added'));
  });
  delBtn?.addEventListener('click', () => {
    const doc = bannerStore.active;
    if (!doc || bannerStore.count <= 1) return;
    bannerStore.remove(doc.id);
    canvas.fitToView();
    say(t('bn.msg.deletedBanner'));
  });
  // Renaming happens in place: the menu turns into a field with the name in
  // it, Enter or leaving it keeps the new one, Escape keeps the old.
  const endRename = (keep: boolean): void => {
    if (!nameIn || nameIn.hidden) return;
    const name = nameIn.value.trim().slice(0, 40);
    nameIn.hidden = true;
    if (docSel) docSel.hidden = false;
    if (keep && name && bannerStore.active && name !== bannerStore.active.name) {
      edit(() => bannerStore.patch({ name }));
    }
    docSel?.focus();
  };
  renameBtn?.addEventListener('click', () => {
    const doc = bannerStore.active;
    if (!doc || !nameIn || !docSel) return;
    nameIn.value = doc.name;
    nameIn.style.width = `${Math.max(120, docSel.getBoundingClientRect().width)}px`;
    docSel.hidden = true;
    nameIn.hidden = false;
    nameIn.focus();
    nameIn.select();
  });
  nameIn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false); }
  });
  nameIn?.addEventListener('blur', () => endRename(true));
  unhideBtn?.addEventListener('click', () => edit(() => bannerStore.patch({ visible: true })));

  kindSel?.addEventListener('change', () => {
    const doc = bannerStore.active;
    if (!doc) return;
    edit(() => bannerStore.patch(applyKind(doc, kindSel.value as BannerKind)));
    canvas.fitToView();
    say(tv('bn.msg.kind', { name: kindSel.selectedOptions[0]?.textContent?.trim() ?? '' }));
  });

  // The shape of the artwork, and the only thing about a banner's geometry
  // the editor gets to say. Its SIZE comes from the blocks it covers, because
  // a size you can type in is a size that can be wrong for the ground you
  // are in — which is exactly what used to break in Match Day.
  // A preset sets the run and the shape together, because that is the pair a
  // person is actually choosing when they say "a two-block banner".
  presetSel?.addEventListener('change', () => {
    const b = BANNER_PRESETS.find((x) => x.id === presetSel.value);
    if (!b) return;
    edit(() => {
      bannerStore.patch({ aspect: b.aspect });
      bannerStore.patchSlot({ blockSpan: b.blockSpan });
    });
    canvas.fitToView();
    say(tv('bn.msg.preset', { name: presetSel.selectedOptions[0]?.textContent?.trim() ?? '' }));
  });
  sliderEdit(aspIn, () => {
    const a = clamp(Number(aspIn!.value) / 100, 0.05, 6);
    if (aspOut) aspOut.textContent = aspectLabel(a);
    bannerStore.patch({ aspect: a });
    canvas.fitToView();
  });

  matSel?.addEventListener('change', () => edit(() => bannerStore.patch({ material: matSel.value as 'solid' | 'mesh' })));
  gsmSel?.addEventListener('change', () => edit(() => bannerStore.patch({ fabricGsm: Number(gsmSel.value) })));

  seamsChk?.addEventListener('change', () => { canvas.showSeams = seamsChk.checked; canvas.requestDraw(); });
  guidesChk?.addEventListener('change', () => { canvas.showGuides = guidesChk.checked; canvas.requestDraw(); });
  snapChk?.addEventListener('change', () => {
    canvas.snap = snapChk.checked;
    canvas.requestDraw();
  });

  const bgChanged = (): void => {
    if (!bgIn || !bgNone) return;
    edit(() => bannerStore.patch({ bg: bgNone.checked ? null : bgIn.value }));
  };
  bgIn?.addEventListener('input', bgChanged);
  bgNone?.addEventListener('change', bgChanged);

  standSel?.addEventListener('change', () => edit(() => bannerStore.patchSlot({ stand: Number(standSel.value) as StandIndex })));
  // A banner that carries on round the corner into the next stand. The block
  // numbering changes with the window, so the run is re-centred rather than
  // left pinned to an index that now means somewhere else.
  acrossSel?.addEventListener('change', () => {
    edit(() => bannerStore.patchSlot({ stands: Math.max(1, Number(acrossSel.value) || 1), blockFrom: -1 }));
  });
  blockSel?.addEventListener('change', () => {
    edit(() => bannerStore.patchSlot({ blockFrom: Number(blockSel.value) }));
  });
  spanSel?.addEventListener('change', () => {
    edit(() => bannerStore.patchSlot({ blockSpan: Math.max(1, Number(spanSel.value)) }));
  });
  tierSel?.addEventListener('change', () => {
    edit(() => bannerStore.patchSlot({ tier: Number(tierSel.value) }));
    // The artboard changes shape when the banner moves into, or out of, the
    // gap between two tiers.
    canvas.fitToView();
  });
  besideBtn?.addEventListener('click', () => deps.onToggleBeside?.());

  netChk?.addEventListener('change', () => edit(() => bannerStore.patch({ netBacked: netChk.checked })));
  barChk?.addEventListener('change', () => edit(() => bannerStore.patch({ weightBar: barChk.checked })));
  revSel?.addEventListener('change', () => edit(() => bannerStore.patch({ reveal: revSel.value as BannerReveal })));
  // Moving the slider is choosing a length; until then the reveal takes as
  // long as the real one does, at whatever size the banner is now.
  sliderEdit(secsIn, () => {
    const ms = Math.round(sliderToSecs(Number(secsIn!.value)) * 1000);
    bannerStore.patch({ revealMs: ms, revealAuto: false });
  });
  secsAuto?.addEventListener('click', () => edit(() => bannerStore.patch({ revealAuto: true })));
  sliderEdit(windIn, () => {
    if (windOut) windOut.textContent = windIn!.value;
    bannerStore.patch({ wind: Number(windIn!.value) / 100 });
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
  // The selected item
  // -------------------------------------------------------------------------

  const deleteSelected = (): boolean => {
    const it = bannerStore.selectedItem;
    if (!it) return false;
    bannerStore.removeItem(it.id);
    say(t('bn.msg.deleted'));
    historyMoved();
    return true;
  };
  const duplicateSelected = (): boolean => {
    const it = bannerStore.selectedItem;
    if (!it) return false;
    bannerStore.duplicateItem(it.id);
    say(t('bn.msg.duplicated'));
    historyMoved();
    return true;
  };
  itemDel?.addEventListener('click', () => deleteSelected());
  itemDup?.addEventListener('click', () => duplicateSelected());
  itemFront?.addEventListener('click', () => {
    const it = bannerStore.selectedItem;
    if (it) bannerStore.reorderItem(it.id, 'front');
    historyMoved();
  });
  itemBack?.addEventListener('click', () => {
    const it = bannerStore.selectedItem;
    if (it) bannerStore.reorderItem(it.id, 'back');
    historyMoved();
  });

  /** Nudge the selected item, one undo step per burst of key presses. */
  let nudgeTimer = 0;
  let nudging = false;
  const nudge = (dxPx: number, dyPx: number): boolean => {
    const it = bannerStore.selectedItem;
    if (!it) return false;
    const dx = canvas.pxToUnits(dxPx);
    const dy = canvas.pxToUnits(dyPx);
    if (!nudging) {
      nudging = true;
      bannerStore.begin();
    }
    if (isPlaced(it)) {
      bannerStore.patchItem(it.id, { cx: it.cx + dx, cy: it.cy + dy } as Partial<BannerItem>);
    } else if (it.kind === 'stroke') {
      const pts = it.pts.slice();
      for (let i = 0; i < pts.length; i += 2) {
        pts[i] += dx;
        pts[i + 1] += dy;
      }
      bannerStore.patchItem(it.id, { pts } as Partial<BannerItem>);
    } else if (it.kind === 'patch') {
      bannerStore.patchItem(it.id, { x: it.x + dx, y: it.y + dy } as Partial<BannerItem>);
    }
    window.clearTimeout(nudgeTimer);
    nudgeTimer = window.setTimeout(() => {
      nudging = false;
      bannerStore.commit();
      historyMoved();
    }, 450);
    return true;
  };

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
  canvas.onSelect = () => syncContext();
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
    if (presetSel) presetSel.replaceChildren();
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
      syncContext();
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
      const capFrac = bannerFacts(doc, realSize(doc)).headlineCapFrac;
      const h = clamp((capFrac * r.canvas.height) / r.glyphHeight, 0.05 * aspect, 0.8 * aspect);
      // And never wider than the sheet: on a strip between two tiers the cap
      // band alone can ask for type a whole banner wide.
      const w0 = h * (r.canvas.width / r.canvas.height);
      const k = w0 > 0.94 ? 0.94 / w0 : 1;
      const c = spendPoint();
      canvas.placeText({
        text: o.text, fontId: o.fontId, arcDeg: o.arcDeg, color: o.color,
        cx: fitIn(c.x, w0 * k, 1), cy: fitIn(c.y, h * k, aspect),
        w: w0 * k, h: h * k, rot: 0,
      });
      return true;
    },
    placeShape(o) {
      const doc = bannerStore.active;
      if (!doc) return false;
      const aspect = aspectOf(doc);
      const sa = SHAPE_ASPECT[o.shape] ?? 1;
      const h = Math.min(0.3 * aspect, 0.6 / sa);
      const w = h * sa;
      const c = spendPoint();
      canvas.placeShape({
        shape: o.shape, color: o.color,
        cx: fitIn(c.x, w, 1), cy: fitIn(c.y, h, aspect),
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
      // Six tenths of the width, unless that would be taller than the sheet.
      const ratio = o.bitmap.height / Math.max(1, o.bitmap.width);
      const w = Math.min(0.6, (0.8 * aspect) / Math.max(1e-6, ratio));
      const h = w * ratio;
      const c = spendPoint();
      canvas.placeImage({
        src, name: o.name,
        cx: fitIn(c.x, w, 1), cy: fitIn(c.y, h, aspect),
        w, h, rot: 0, opacity: 1,
      });
      return true;
    },
    deleteSelected,
    duplicateSelected,
    nudge,
    escape() {
      if (!bannerStore.selectedItem) return false;
      bannerStore.selectItem(null);
      return true;
    },
  };

  sync();

  return {
    canvas,
    sync,
    setBeside(on: boolean) {
      if (!besideBtn) return;
      besideBtn.classList.toggle('active', on);
      besideBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
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
/**
 * Where to centre something `size` long so all of it lands on a sheet `span`
 * long, as near the click as that allows.
 *
 * The old rule kept the CENTRE six per cent in from the edge, which on a
 * two-to-one sheet is plenty and on a fascia strip is not: a headline clicked
 * onto the middle of a three-metre band hung a third of itself off the hem.
 */
function fitIn(v: number, size: number, span: number): number {
  const half = size / 2;
  if (half * 2 >= span) return span / 2;
  const pad = Math.min(span * 0.02, (span - size) / 2);
  return clamp(v, half + pad, span - half - pad);
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
