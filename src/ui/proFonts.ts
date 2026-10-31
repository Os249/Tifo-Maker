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
import { PRO_FONTS, isProVoice } from '../core/proVoices';
import { fontCssOf, renderTextCanvas } from '../core/text';
import { loadProFonts } from '../core/tifoFonts';
import { bannerScene } from './bannerHost';
import { onLangChange, t } from './i18n';
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
    const group = document.createElement('optgroup');
    group.className = 'pfont-group';
    for (const f of PRO_FONTS) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      group.appendChild(o);
    }
    // A layer selected before this mounted may have left a stand-in option
    // for its Pro voice (an id the picker did not know yet): the group's
    // option takes its place.
    const was = sel.value;
    for (const o of sel.querySelectorAll<HTMLOptionElement>(':scope > option')) if (isProVoice(o.value)) o.remove();
    // After the free voices. The sign's picker fills its free ones the first
    // time the Banner view draws, and puts them ahead of this group then.
    sel.appendChild(group);
    if (isProVoice(was)) sel.value = was;
    groups.push(group);

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
    for (const g of groups) g.label = t('pfont.group');
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
    };
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
