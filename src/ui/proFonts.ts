/**
 * Pro fonts: extra Arabic and Latin display fonts for text and banners.
 * Mounted by proTools.ts, so only for an account Pro is on for.
 *
 * The voices themselves are core/proVoices (names, Node-importable, never fed
 * to the AI) and core/proFontFaces (the files, a chunk of their own). Fonts
 * are assets, not the gate: everything that turns a font id into CSS knows the
 * Pro ids for everybody, and a design that uses one loads its faces for
 * whoever opens it (toolbar.ts and render/bannerRender.ts ask, cheaply). What
 * this module adds, for an account Pro is on for:
 *
 *  - the Pro voices in the three font pickers (the Text tool, a text layer's
 *    font, a sign's letters), after the free ones, in a group of their own;
 *  - the crown beside a picker while a Pro voice is chosen (quiet while Pro is
 *    running for them), shown by CSS alone, so it follows every way a picker
 *    changes: a click, a selected layer, an undo, a banner made active;
 *  - the export question: a Pro voice on a text layer (a probe) and on a
 *    banner (a lifter), both named "Pro fonts" on the export sheet, both
 *    lifted to the default voice for "Export without Pro items" (proGate.ts).
 *
 * Free to try in the editor, the 3D view and Match Day; nothing here blocks
 * saving or publishing.
 */
import './proFonts.css';
import { fetchPro } from '../net/api';
import type { TextObject } from '../core/objects';
import { aspectOf, fitMessage, type BannerDoc, type BannerItem, type BannerStore, type TextItem } from '../core/banner';
import { PRO_VOICES, isProVoice, seatsVoice, type ProVoice } from '../core/proVoices';
import { fontCssOf, renderTextCanvas } from '../core/text';
import { drawSeatAlpha } from '../core/seatText';
import { loadProFonts } from '../core/tifoFonts';
import { bannerScene } from './bannerHost';
import { onLangChange, t, tv } from './i18n';
import { proChipHtml } from './pro';
import { designProItems, registerProLifter, registerProProbe, withoutDesignProItems } from './proGate';
import type { ProToolsContext } from './proTools';

/** The neutral default voice (core/tifoVoices): where a Pro font goes for a free export. */
const DEFAULT_VOICE = 'grotesk';

/** The three font pickers: the Text tool's, a text layer's, a sign's letters. */
const PICKERS = ['text-font', 'obj-font', 'bn-msg-font'];

export function mountProFonts(ctx: ProToolsContext): void {
  const groups: HTMLOptGroupElement[] = [];
  const chips: HTMLElement[] = [];
  let quiet = false;
  let told = false;

  for (const id of PICKERS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel || sel.querySelector(':scope > .pfont-group')) continue;
    // The voices that go on seats; then, where words can land on a banner
    // (the Text tool, a sign), the banners-only ones in a group of their own.
    // A text layer's picker is on seats, so it never offers those.
    const sets: Array<[readonly ProVoice[], string]> = [[PRO_VOICES.filter((v) => v.seats !== false), 'pfont-group']];
    if (id !== 'obj-font') sets.push([PRO_VOICES.filter((v) => v.seats === false), 'pfont-group pfont-banners']);
    // A layer selected before this mounted may have left a stand-in option
    // for its Pro voice (an id the picker did not know yet): the group's
    // option takes its place.
    const was = sel.value;
    for (const o of sel.querySelectorAll<HTMLOptionElement>(':scope > option')) if (isProVoice(o.value) && (id !== 'obj-font' || seatsVoice(o.value))) o.remove();
    for (const [voices, cls] of sets) {
      const group = document.createElement('optgroup');
      group.className = cls;
      for (const f of voices) {
        const o = document.createElement('option');
        o.value = f.id;
        o.textContent = f.name;
        group.appendChild(o);
      }
      // After the free voices. The sign's picker fills its free ones the first
      // time the Banner view draws, and puts them ahead of these groups then.
      sel.appendChild(group);
      groups.push(group);
    }
    if (isProVoice(was)) sel.value = was;

    const chip = document.createElement('span');
    chip.className = 'pfont-chip';
    // The sign's row is narrow (a label, the picker and a colour): the crown
    // alone there, its name spoken, so the picker keeps room for the name.
    if (id === 'bn-msg-font') chip.dataset.icon = '1';
    sel.after(chip);
    chips.push(chip);

    // The faces load when a picker is first opened, so the list can show them,
    // and every voice that is chosen is measured in its own face.
    const want = (): void => void loadProFonts();
    sel.addEventListener('pointerdown', want, { once: true });
    sel.addEventListener('focus', want, { once: true });
    sel.addEventListener('change', () => {
      if (!isProVoice(sel.value)) return;
      void loadProFonts([sel.value]);
      if (!told) {
        told = true;
        ctx.say(t('pfont.try'));
      }
    });
  }
  if (!groups.length) return;

  const paint = (): void => {
    for (const g of groups) g.label = t(g.classList.contains('pfont-banners') ? 'qf.group.banners' : 'pfont.group');
    for (const c of chips) c.innerHTML = proChipHtml({ quiet, icon: c.dataset.icon === '1' });
  };
  paint();
  onLangChange(paint);

  // A pass holder still sees what is Pro, quietly (the design bible, "Pro").
  const plan = (fresh = false): void => {
    void fetchPro(fresh)
      .then((st) => {
        const on = !!st.live && !!st.plan && st.plan !== 'free';
        if (on === quiet) return;
        quiet = on;
        paint();
      })
      .catch(() => {});
  };
  plan();
  window.addEventListener('tifo:pro', () => plan(true));

  // ---- the export question (proGate.ts) ----
  const label = (): string => t('pfont.label');
  const defaultCss = fontCssOf(DEFAULT_VOICE);
  registerProProbe('pro-font', {
    label,
    patch: (o) => (o.kind === 'text' && isProVoice(o.fontId) ? { fontId: DEFAULT_VOICE, fontCss: defaultCss } : null),
  });
  registerProLifter('pro-font-banners', {
    label,
    active: () => proBannerText().length > 0,
    lift: liftBanners,
  });

  keepBannerFontsOffSeats(ctx);
  // The words on the seats, under the Text tool and a text layer (its own chunk).
  void import('./seatPreview').then((m) => mountSeatPreviews(ctx, m)).catch((e) => console.warn('[tifo] the seat preview did not load', e));

  // The browser suite's way in (e2e-pro-fonts.mjs). Opt-in by URL only: main.ts
  // sets window.__tifo for ?e2e=1 at boot, before the address bar is tidied.
  if ((window as unknown as { __tifo?: unknown }).__tifo) {
    const layers = (): { fontId: string; width: number }[] =>
      ctx.objects.list().filter((o): o is TextObject => o.kind === 'text').map((o) => ({ fontId: o.fontId, width: o.width }));
    const banners = (): { fontId: string; w: number; h: number }[] =>
      (bannerScene.store?.list() ?? []).flatMap((b) => b.items.filter((i): i is TextItem => i.kind === 'text').map((i) => ({ fontId: i.fontId, w: i.w, h: i.h })));
    (window as unknown as { __tifoProFonts?: unknown }).__tifoProFonts = {
      items: (): string[] => designProItems(ctx.objects),
      /** What an export without Pro items would draw (everything comes back after). */
      duringFreeExport: () => withoutDesignProItems(ctx.objects, async () => ({ layers: layers(), banners: banners() })),
      layers,
      banners,
      /** A text layer's seats as drawn seat-aware (its raster) and as its face alone would draw them. */
      seatCounts: (id: string) => {
        const o = ctx.objects.get(id);
        if (!o || o.kind !== 'text' || !o.grid) return null;
        const plain = drawSeatAlpha(o.text, o.fontCss, o.arcDeg, o.grid.cols, o.grid.rows, 0);
        return { seatAware: o.grid.data.filter((v) => v >= 0).length, plain: plain ? plain.reduce((a, v) => a + v, 0) : 0, key: o.gridKey ?? '' };
      },
    };
  }
}

/**
 * The Text tool's words go on seats outside the Banner view, where a
 * banners-only voice breaks up: its group is hidden there (CSS), and if one
 * is chosen when the Banner view closes, the Text tool takes the seat voice
 * nearest it in spirit and says so. A sign's picker is the Banner view's own.
 */
function keepBannerFontsOffSeats(ctx: ProToolsContext): void {
  const sel = document.getElementById('text-font') as HTMLSelectElement | null;
  if (!sel) return;
  const check = (): void => {
    if (document.body.classList.contains('banner-view') || seatsVoice(sel.value)) return;
    const was = PRO_VOICES.find((v) => v.id === sel.value);
    const other = PRO_VOICES.find((v) => v.id === was?.instead);
    if (!was || !other) return;
    sel.value = other.id;
    sel.dispatchEvent(new Event('change'));
    ctx.say(tv('qf.swapped', { font: was.name, other: other.name }));
  };
  new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sel.addEventListener('change', check);
}

type SeatPreview = typeof import('./seatPreview');

/** The seat preview under the Text tool's bar and under a text layer's words. */
function mountSeatPreviews(ctx: ProToolsContext, { seatPanel, seatNear, standMiddles }: SeatPreview): void {
  const input = document.getElementById('text-input') as HTMLInputElement | null;
  const font = document.getElementById('text-font') as HTMLSelectElement | null;
  const size = document.getElementById('text-size') as HTMLInputElement | null;
  const arc = document.getElementById('text-arc') as HTMLInputElement | null;
  const bar = document.getElementById('text-bar');
  const pick = (sel: HTMLSelectElement | null, id: string): void => {
    if (!sel) return;
    sel.value = id;
    sel.dispatchEvent(new Event('change'));
  };

  // Where the Text tool's words will land: where the pointer last rested on
  // the seats, else the middle of the view.
  let spot: { x: number; y: number } | null = null;
  const canvas = ctx.editor.app.canvas as HTMLCanvasElement;
  const toWorld = (cx: number, cy: number): { x: number; y: number } => {
    const [ox, oy] = ctx.editor.worldToClient(0, 0);
    const [ux, uy] = ctx.editor.worldToClient(1, 1);
    return { x: (cx - ox) / (ux - ox || 1), y: (cy - oy) / (uy - oy || 1) };
  };

  if (input && font && size && arc && bar) {
    const middles = standMiddles(ctx);
    /** With no pointer on the seats yet: the middle of the stand nearest the middle of the view. */
    const inView = (): { x: number; y: number } => {
      const r = ctx.editor.getViewportRect();
      const near = seatNear(ctx, r.x + r.width / 2, r.y + r.height / 2);
      return (near && middles.get(near.tier * 4 + near.side)) ?? { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    const panel = seatPanel(ctx, {
      words: () => {
        if (bar.hidden || !input.value.trim() || document.body.classList.contains('banner-view')) return null;
        const at = spot ?? inView();
        return { text: input.value, fontId: font.value, glyphRows: Number(size.value), arcDeg: Number(arc.value), colorIndex: ctx.editor.colorIndex, cx: at.x, cy: at.y, rotation: 0 };
      },
      setRows: (n) => {
        size.value = String(Math.max(Number(size.min) || 1, Math.min(Number(size.max) || 400, n)));
        size.dispatchEvent(new Event('input'));
      },
      useFont: (id) => pick(font, id),
    }, (root) => bar.appendChild(root));
    for (const el of [input, size, arc]) el.addEventListener('input', panel.refresh);
    font.addEventListener('change', panel.refresh);
    canvas.addEventListener('pointermove', (e) => {
      if (bar.hidden) return;
      spot = toWorld(e.clientX, e.clientY);
      panel.refresh();
    }, { passive: true });
    // The tool shown or hidden, a colour picked, the language: cheap to ask, drawn once per change.
    new MutationObserver(panel.refresh).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('click', panel.refresh, { capture: true, passive: true });
    panel.refresh();
  }

  const row = document.getElementById('obj-text-row');
  const objFont = document.getElementById('obj-font') as HTMLSelectElement | null;
  if (row && objFont) {
    const selected = (): TextObject | null => {
      const o = ctx.objects.selected;
      return o && o.kind === 'text' ? o : null;
    };
    /** A layer's letter height in rows: its frame's, less the pad round the letters. */
    const glyphRowsOf = (o: TextObject): number => {
      const r = renderTextCanvas(o.text, o.fontCss, o.arcDeg);
      return r ? (o.height / 8) * (r.glyphHeight / r.canvas.height) : o.heightSeats;
    };
    const panel = seatPanel(ctx, {
      words: () => {
        const o = selected();
        if (!o || !o.text.trim()) return null;
        return { text: o.text, fontId: o.fontId, glyphRows: glyphRowsOf(o), arcDeg: o.arcDeg, colorIndex: o.colorIndex, cx: o.cx, cy: o.cy, rotation: o.rotation };
      },
      setRows: (n) => {
        const o = selected();
        if (!o || o.locked) return;
        const k = n / glyphRowsOf(o);
        ctx.objects.update(o.id, { width: o.width * k, height: o.height * k, heightSeats: n } as Partial<TextObject>);
      },
      useFont: (id) => pick(objFont, id),
    }, (root) => row.after(root));
    ctx.objects.onChange(panel.refresh);
    panel.refresh();
  }
}

/** The text on the banners an export shows that is set in a Pro voice. */
function proBannerText(): { doc: BannerDoc; it: TextItem }[] {
  const out: { doc: BannerDoc; it: TextItem }[] = [];
  for (const doc of bannerScene.store?.list() ?? []) {
    if (doc.visible === false) continue;
    for (const it of doc.items) if (it.kind === 'text' && !it.hidden && isProVoice(it.fontId)) out.push({ doc, it });
  }
  return out;
}

type ItemPatch = { doc: string; id: string; patch: Partial<TextItem> };

/**
 * Put every banner's Pro-voiced text in the default voice, refitted the way
 * the Banner view fits words (a sign's message to its sheet; anything else at
 * its height and centre), and hand back what puts it all back. No undo step.
 */
function liftBanners(): () => void {
  const store = bannerScene.store;
  const hits = proBannerText();
  if (!store || !hits.length) return () => {};
  const css = fontCssOf(DEFAULT_VOICE);
  const before: ItemPatch[] = hits.map(({ doc, it }) => ({
    doc: doc.id, id: it.id, patch: { fontId: it.fontId, cx: it.cx, cy: it.cy, w: it.w, h: it.h },
  }));
  const after: ItemPatch[] = hits.map(({ doc, it }) => ({
    doc: doc.id, id: it.id, patch: { fontId: DEFAULT_VOICE, ...refit(doc, it, css) },
  }));
  patchItems(store, after);
  return () => patchItems(store, before);
}

/** Where words set in `css` sit, for the item they replace. */
function refit(doc: BannerDoc, it: TextItem, css: string): Partial<TextItem> {
  const message = it.role === 'message';
  const r = renderTextCanvas(it.text, css, message ? 0 : it.arcDeg);
  if (!r) return {};
  const ratio = r.canvas.width / Math.max(1, r.canvas.height);
  if (message) return fitMessage(aspectOf(doc), ratio);
  let w = it.h * ratio;
  let h = it.h;
  if (w > 0.94) {
    h *= 0.94 / w;
    w = 0.94;
  }
  return { w, h };
}

/**
 * Patch items on any banner without an undo step. The store patches the
 * active banner's items, so each banner is made active for its own, and the
 * banner and item that were picked are picked again after.
 */
function patchItems(store: BannerStore, patches: ItemPatch[]): void {
  const active = store.activeId_;
  const picked = store.selectedItemId_;
  for (const p of patches) {
    if (!store.get(p.doc)) continue;
    store.setActive(p.doc);
    store.patchItem(p.id, p.patch as Partial<BannerItem>);
  }
  store.setActive(active);
  store.selectItem(picked);
}
