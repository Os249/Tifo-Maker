import { setSheetBox } from './bannerTour';
import type { DesignStore } from '../core/design';
import type { SeatMap, ToolId } from '../core/types';
import type { BannerDoc, BannerItem, BannerKind, BannerReveal, BannerSize, StandIndex, TextItem } from '../core/banner';
import {
  BannerStore, aspectOf, applyKind, bannerFacts, newBanner, estimateSize,
  BANNER_PRESETS, KIND_REVEALS, presetOf, isPlaced,
  physicalRevealMs, revealSeconds,
  SIGN_LENGTHS_M, SIGN_HEIGHTS_M, signPlaceOf, signHeightM, messageItem, messageOf, fitMessage,
} from '../core/banner';
import { spanFrameCache, type StandFrame } from '../render/simulator/standFrame';
import {
  resolveSlot, maxUsefulSpan, hangableTiers, signPlaces, signUsableRows, signTier, signFenceOk, type ResolvedSlot,
} from '../render/simulator/bannerSlot';

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
  /** Go to the Stadium view, looking at this banner. */
  onShowInStadium?: (id: string) => void;
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

  // No banner is made here. This used to put one in the tifo the first time
  // the view opened, on the theory that a blank sheet is a better welcome
  // than an empty state — and it was saved with the tifo like any other, so
  // anyone who only LOOKED at this view found a banner on their North stand
  // from then on. Not everyone wants a banner. A tifo starts with none, and
  // the empty state below makes one in a click.
  const canvas = BannerCanvas.create(host, bannerStore);
  // The tour's "draw on it" step lights the sheet, not the whole canvas.
  setSheetBox(() => canvas.sheetRect());

  /** What the artboard shows while there is nothing to draw on. */
  const emptyCard = document.createElement('div');
  emptyCard.id = 'bn-empty';
  emptyCard.className = 'bn-empty';
  emptyCard.hidden = true;
  emptyCard.innerHTML =
    '<i class="ti ti-flag bn-empty-icon" aria-hidden="true"></i>' +
    '<h3 data-i18n="bn.none.title"></h3>' +
    '<p data-i18n="bn.none.body"></p>' +
    '<div class="bn-empty-actions">' +
    '<button type="button" class="primary" data-kind="stand"><i class="ti ti-plus" aria-hidden="true"></i> <span data-i18n="bn.kind.stand"></span></button>' +
    '<button type="button" data-kind="hanging"><i class="ti ti-plus" aria-hidden="true"></i> <span data-i18n="bn.kind.hanging"></span></button>' +
    '<button type="button" data-kind="sign"><i class="ti ti-plus" aria-hidden="true"></i> <span data-i18n="bn.kind.sign"></span></button>' +
    '</div>';
  const paintEmpty = (): void => {
    for (const el of emptyCard.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  };
  paintEmpty();
  host.appendChild(emptyCard);
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
  const listEl = $<HTMLElement>('bn-list');
  const addStandBtn = $<HTMLButtonElement>('bn-add-stand');
  const addHangBtn = $<HTMLButtonElement>('bn-add-hanging');
  const detailEl = $<HTMLElement>('bn-detail');
  const addSignBtn = $<HTMLButtonElement>('bn-add-sign');
  const lengthSel = $<HTMLSelectElement>('bn-length');
  const heightSel = $<HTMLSelectElement>('bn-height');
  const rowSel = $<HTMLSelectElement>('bn-row');
  const atSel = $<HTMLSelectElement>('bn-at');
  const msgIn = $<HTMLInputElement>('bn-msg');
  const msgFont = $<HTMLSelectElement>('bn-msg-font');
  const msgColor = $<HTMLInputElement>('bn-msg-color');

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
    const key = `${doc.id}|${doc.kind}|${doc.aspect}|${s.stand}|${s.stands}|${s.blockFrom}|${s.blockSpan}|${s.tier}|${s.row}|${s.at}|${s.lengthM}`;
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

  /** A length or height in metres, as the pickers write it. */
  const metres = (m: number): string => tv('bn.sign.m', { m: Number.isInteger(m) ? m : round1(m) });

  /**
   * A sign's pickers: its tier, the row it is held at, where along the stand,
   * and its size in metres.
   *
   * The rows are counted from the front, which is how people in a stand count
   * them, and the first entry is the fence along the tier's front, where a
   * sign is tied rather than held.
   */
  function syncSign(doc: BannerDoc): void {
    const f = frameOf(doc);
    const place = signPlaceOf(doc.slot);
    const tier = f.ok ? signTier(f, doc.slot.tier) : 0;
    if (tierRow) tierRow.style.display = f.ok && f.tiers.length > 1 ? '' : 'none';
    if (tierSel && f.ok) {
      tierSel.replaceChildren();
      for (let i = 0; i < f.tiers.length; i++) opt(tierSel, String(i), tv('bn.tier.n', { n: i + 1 }));
      tierSel.value = String(tier);
    }
    if (rowSel) {
      // Only the rows a sheet this tall can be held up in: not under an overhang.
      const n = f.ok ? signUsableRows(f, tier, signHeightM(doc)) : 20;
      rowSel.replaceChildren();
      const fence = !f.ok || signFenceOk(f, tier);
      if (fence) opt(rowSel, '-1', t(tier >= 1 ? 'bn.sign.balcony' : 'bn.sign.fence'));
      for (let r = 0; r < n; r++) {
        opt(rowSel, String(r), r === 0 ? t('bn.sign.rowFront') : r === n - 1 ? tv('bn.sign.rowBack', { n: r + 1 }) : tv('bn.sign.rowN', { n: r + 1 }));
      }
      rowSel.value = String(place.row < 0 ? (fence ? -1 : 0) : Math.min(n - 1, place.row));
    }
    if (atSel) {
      const n = f.ok ? signPlaces(f) : 1;
      atSel.replaceChildren();
      opt(atSel, '-1', t('bn.sign.atMiddle'));
      for (let k = 0; k < n; k++) {
        const b = (k >> 1) + 1;
        opt(atSel, String(k), k % 2 === 0 ? tv('bn.sign.atBlock', { n: b }) : tv('bn.sign.atAisle', { a: b, b: b + 1 }));
      }
      atSel.value = String(place.at < 0 ? -1 : Math.min(n - 1, place.at));
    }
    // The sizes a sheet comes in, and whatever this one is if it is not one.
    const h = signHeightM(doc);
    if (lengthSel) {
      lengthSel.replaceChildren();
      const lengths: number[] = [...SIGN_LENGTHS_M];
      if (!lengths.some((m) => Math.abs(m - place.lengthM) < 0.05)) lengths.push(place.lengthM);
      lengths.sort((a, b) => a - b);
      for (const m of lengths) opt(lengthSel, String(m), metres(m));
      lengthSel.value = String(lengths.find((m) => Math.abs(m - place.lengthM) < 0.05) ?? place.lengthM);
    }
    if (heightSel) {
      heightSel.replaceChildren();
      const heights: number[] = [...SIGN_HEIGHTS_M];
      const hr = round1(h);
      if (!heights.some((m) => Math.abs(m - hr) < 0.05)) heights.push(hr);
      heights.sort((a, b) => a - b);
      for (const m of heights) opt(heightSel, String(m), metres(m));
      heightSel.value = String(heights.find((m) => Math.abs(m - hr) < 0.05) ?? hr);
    }
    const r = f.ok ? resolveSlot(doc, f) : null;
    if (sizeOutEl) {
      sizeOutEl.textContent = r
        ? tv('bn.size.is', { w: round1(r.size.widthM), h: round1(r.size.heightM) })
        : tv('bn.size.about', { w: Math.round(place.lengthM), h: round1(h) });
    }
    if (fitNoteEl) {
      const note = r && r.heightLimited ? tv('bn.sign.long', { w: Math.round(r.size.widthM) }) : '';
      fitNoteEl.textContent = note;
      fitNoteEl.style.display = note ? '' : 'none';
    }
    // The message, its letters and their colour.
    const m = messageOf(doc);
    if (msgIn && document.activeElement !== msgIn) msgIn.value = m?.text ?? '';
    if (msgFont) {
      if (!msgFont.options.length) for (const ft of TIFO_FONTS) opt(msgFont, ft.id, ft.name);
      msgFont.value = m?.fontId ?? 'condensed';
    }
    if (msgColor && m) msgColor.value = m.color;
  }

  /** Fill the block, span and tier pickers from the stand the banner is on. */
  function syncSlots(doc: BannerDoc): void {
    if (doc.kind === 'sign') {
      syncSign(doc);
      return;
    }
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
  // The list: every banner in this tifo, and the way to go and look at it
  // -------------------------------------------------------------------------

  /**
   * One row per banner — its fabric, its name, its type and stand — and a
   * "Show in stadium" that goes straight to the Stadium view looking at it.
   *
   * Rebuilt only when something it shows changes: `sync` runs on every store
   * change, which is every point of a brush stroke, and a list that re-made
   * its buttons sixty times a second would lose the pointer under a click.
   */
  let listKey = '';
  function syncList(): void {
    if (!listEl) return;
    const activeId = bannerStore.activeId_;
    const banners = bannerStore.list();
    const key = `${activeId}#` + banners.map((b) => `${b.id}|${b.name}|${b.kind}|${b.slot.stand}|${b.slot.stands}|${b.bg}|${b.visible}`).join(';');
    if (key === listKey) return;
    listKey = key;
    listEl.replaceChildren();
    if (!banners.length) {
      const none = document.createElement('p');
      none.className = 'bn-list-none';
      none.textContent = t('bn.none.short');
      listEl.appendChild(none);
      return;
    }
    for (const b of banners) {
      const row = document.createElement('div');
      row.className = b.id === activeId ? 'bn-li active' : 'bn-li';
      row.dataset.id = b.id;

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'bn-li-pick';
      pick.setAttribute('aria-pressed', b.id === activeId ? 'true' : 'false');
      const sw = document.createElement('span');
      sw.className = b.bg ? 'bn-li-sw' : 'bn-li-sw clear';
      if (b.bg) sw.style.background = b.bg;
      const txt = document.createElement('span');
      txt.className = 'bn-li-txt';
      const name = document.createElement('span');
      name.className = 'bn-li-name';
      name.textContent = b.name;
      const meta = document.createElement('span');
      meta.className = 'bn-li-meta';
      const where = b.slot.stands > 1
        ? tv('bn.across.pair', { a: standName(b.slot.stand), b: standName(((b.slot.stand + 1) % 4) as StandIndex) })
        : standName(b.slot.stand);
      meta.textContent = tv('bn.li.meta', { kind: t(`bn.kind.${b.kind}`), stand: where })
        + (b.visible === false ? ` · ${t('bn.li.hidden')}` : '');
      txt.append(name, meta);
      pick.append(sw, txt);
      pick.addEventListener('click', () => {
        bannerStore.setActive(b.id);
        canvas.fitToView();
      });

      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'bn-li-show';
      show.title = t('bn.showT');
      show.innerHTML = '<i class="ti ti-building-stadium" aria-hidden="true"></i> ';
      const label = document.createElement('span');
      label.textContent = t('bn.show');
      show.appendChild(label);
      show.addEventListener('click', () => deps.onShowInStadium?.(b.id));

      row.append(pick, show);
      listEl.appendChild(row);
    }
  }

  /** With no banner there is nothing to edit: the empty state, and the list's buttons. */
  function syncEmpty(): void {
    const none = bannerStore.count === 0;
    document.body.classList.toggle('bn-none', none);
    emptyCard.hidden = !none;
    if (detailEl) detailEl.hidden = none;
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
      // The last one can go too: a tifo does not need a banner.
      if (delBtn) delBtn.disabled = bannerStore.count === 0;
      syncList();
      syncEmpty();
      syncContext();
      document.body.classList.toggle('bn-sign', doc?.kind === 'sign');
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
    if (factsEl && doc.kind === 'sign') {
      factsEl.textContent = tv('bn.facts.sign', {
        hold: signPlaceOf(doc.slot).row < 0 ? t('bn.sign.tied') : tv('bn.sign.heldBy', { n: f.carriers }),
        kg: f.weightKg < 10 ? f.weightKg.toFixed(1) : String(Math.round(f.weightKg)),
        cap: round1(f.headlineCapM),
      });
    } else if (factsEl) {
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

  // -------------------------------------------------------------------------
  // A sign's message
  // -------------------------------------------------------------------------

  /** Where a line of words sits on a sheet of this shape: as big as it fits. */
  const boxFor = (text: string, fontId: string, aspect: number): { cx: number; cy: number; w: number; h: number } | null => {
    const css = TIFO_FONTS.find((f) => f.id === fontId)?.css ?? TIFO_FONTS[0].css;
    const r = renderTextCanvas(text, css, 0);
    if (!r) return null;
    return fitMessage(aspect, r.canvas.width / Math.max(1, r.canvas.height));
  };
  /** Fit a message item to its sheet, in place (for one not yet in the store). */
  function fitItem(it: TextItem, aspect: number): void {
    const box = boxFor(it.text, it.fontId, aspect);
    if (box) Object.assign(it, box);
  }
  /** Fit the active sign's message to the sheet it is on now. */
  function refitMessage(): void {
    const doc = bannerStore.active;
    if (!doc || doc.kind !== 'sign') return;
    const m = messageOf(doc);
    if (!m) return;
    const box = boxFor(m.text, m.fontId, aspectOf(doc));
    if (box) bannerStore.patchItem(m.id, box as Partial<BannerItem>);
  }

  // Typing is one undo step per burst, like a slider drag: the gesture opens
  // on the first key and closes a moment after the last one, or on leaving.
  let msgOpen = false;
  let msgTimer = 0;
  const msgClose = (): void => {
    window.clearTimeout(msgTimer);
    if (!msgOpen) return;
    msgOpen = false;
    bannerStore.commit();
  };
  msgIn?.addEventListener('input', () => {
    const doc = bannerStore.active;
    if (syncing || !doc || doc.kind !== 'sign') return;
    if (!msgOpen) {
      msgOpen = true;
      bannerStore.begin();
    }
    const text = msgIn.value.slice(0, 80);
    const m = messageOf(doc);
    if (!m) {
      const it = messageItem(text, msgColor?.value ?? '#141414', msgFont?.value ?? 'condensed');
      fitItem(it, aspectOf(doc));
      bannerStore.addItem(it);
    } else {
      const box = boxFor(text, m.fontId, aspectOf(doc));
      bannerStore.patchItem(m.id, { text, ...(box ?? {}) } as Partial<BannerItem>);
    }
    window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(msgClose, 700);
  });
  msgIn?.addEventListener('blur', msgClose);
  msgIn?.addEventListener('keydown', (e) => {
    // Enter is "done", not a new line: a sign is one line of words.
    if (e.key === 'Enter') {
      e.preventDefault();
      msgClose();
      msgIn.blur();
    }
  });
  msgFont?.addEventListener('change', () => {
    const doc = bannerStore.active;
    const m = doc ? messageOf(doc) : null;
    if (!m) return;
    edit(() => {
      bannerStore.patchItem(m.id, { fontId: msgFont.value } as Partial<BannerItem>);
      refitMessage();
    });
  });
  sliderEdit(msgColor, () => {
    const doc = bannerStore.active;
    const m = doc ? messageOf(doc) : null;
    if (m && msgColor) bannerStore.patchItem(m.id, { color: msgColor.value } as Partial<BannerItem>);
  });

  // Its size: the length it keeps its height through, and the height it
  // keeps its length through. The words refit either way.
  lengthSel?.addEventListener('change', () => {
    const doc = bannerStore.active;
    if (!doc || doc.kind !== 'sign') return;
    const h = signHeightM(doc);
    const L = Math.max(1, Number(lengthSel.value) || 12);
    edit(() => {
      bannerStore.patchSlot({ lengthM: L });
      bannerStore.patch({ aspect: h / L });
      refitMessage();
    });
    canvas.fitToView();
  });
  heightSel?.addEventListener('change', () => {
    const doc = bannerStore.active;
    if (!doc || doc.kind !== 'sign') return;
    const H = Math.max(0.3, Number(heightSel.value) || 1.2);
    edit(() => {
      bannerStore.patch({ aspect: H / signPlaceOf(doc.slot).lengthM });
      refitMessage();
    });
    canvas.fitToView();
  });
  rowSel?.addEventListener('change', () => edit(() => bannerStore.patchSlot({ row: Number(rowSel.value) })));
  atSel?.addEventListener('change', () => edit(() => bannerStore.patchSlot({ at: Number(atSel.value) })));

  docSel?.addEventListener('change', () => bannerStore.setActive(docSel.value || null));
  /** The lowest "Banner n" nobody is called, so deleting one does not make two of another. */
  const nextName = (key = 'bn.nameN'): string => {
    const taken = new Set(bannerStore.list().map((b) => b.name));
    let n = 1;
    while (taken.has(tv(key, { n }))) n++;
    return tv(key, { n });
  };
  const createBanner = (kind: BannerKind): void => {
    const doc = newBanner(kind, nextName(kind === 'sign' ? 'bn.signN' : 'bn.nameN'));
    // On a stand nobody has used yet. Every new banner used to land in the
    // same centred slot on the North stand, exactly on top of the last one,
    // so the second banner of a design was invisible under the first.
    const used = new Set(bannerStore.list().map((b) => b.slot.stand));
    const free = ([1, 3, 0, 2] as StandIndex[]).find((st) => !used.has(st) && frameFor(st, 1).ok);
    if (free !== undefined) doc.slot = { ...doc.slot, stand: free };
    // A sign is made to say something, so it starts with a line to replace —
    // and the Message field ready to type over it.
    if (kind === 'sign') {
      const m = messageItem(t('bn.sign.default'), '#141414', 'condensed');
      fitItem(m, aspectOf(doc));
      doc.items = [m];
    }
    bannerStore.add(doc);
    requestAnimationFrame(() => canvas.fitToView());
    if (kind === 'sign') {
      say(t('bn.msg.signAdded'));
      requestAnimationFrame(() => {
        if (!msgIn || msgIn.getClientRects().length === 0) return;
        msgIn.focus();
        msgIn.select();
      });
    } else {
      say(t('bn.msg.added'));
    }
  };
  newBtn?.addEventListener('click', () => createBanner('stand'));
  addStandBtn?.addEventListener('click', () => createBanner('stand'));
  addHangBtn?.addEventListener('click', () => createBanner('hanging'));
  addSignBtn?.addEventListener('click', () => createBanner('sign'));
  for (const b of emptyCard.querySelectorAll<HTMLButtonElement>('button[data-kind]')) {
    b.addEventListener('click', () => createBanner(b.dataset.kind as BannerKind));
  }
  delBtn?.addEventListener('click', () => {
    const doc = bannerStore.active;
    if (!doc) return;
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
    edit(() => {
      bannerStore.patch(applyKind(doc, kindSel.value as BannerKind));
      refitMessage();
    });
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
    paintEmpty();
    listKey = '';
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
