/**
 * Portrait styles (Pro): stencil, halftone, pop art and 2–3-colour posterize
 * for a face or a player photo. Mounted by proTools.ts, which loads this
 * module only for an account /api/pro says Pro is on for, so the editor's
 * start carries none of its code or words.
 *
 * Two places to pick a style, each with the crown beside it:
 *  - the picture import bar: the choice is kept on the bar
 *    (`data-pro-style`) and toolbar.ts puts it on the picture it places;
 *  - a picture layer's properties: a change is one undo step.
 *
 * The drawing itself is core/portraitStyles.ts, called from ensureGrid for
 * any picture that carries a style, Pro or not: a style is the design's
 * data, like its colours. What Pro decides is what leaves the site, so the
 * style is registered with proGate as a design-level Pro item, and an export
 * from an account without Pro running asks first (and can go without it).
 *
 * Like the rest of Pro in the interface, this shows and asks; it decides
 * nothing that costs money.
 */
import './proStyles.css';
import { fetchPro, type ProState } from '../net/api';
import { PORTRAIT_STYLES, isPortraitStyle, type PortraitStyle } from '../core/portraitStyles';
import { applyDom, onLangChange, t, tv } from './i18n';
import { proChipHtml } from './pro';
import { designProItems, exportGate, registerProProbe, withoutDesignProItems } from './proGate';
import type { ProToolsContext } from './proTools';

/** Each choice's name, Original first. */
const NAMES: Record<PortraitStyle | '', string> = {
  '': 'pstyle.original',
  stencil: 'pstyle.stencil',
  halftone: 'pstyle.halftone',
  pop: 'pstyle.pop',
  poster2: 'pstyle.poster2',
  poster3: 'pstyle.poster3',
};

/** Register the design-level Pro item: a picture's portrait style, lifted back to the picture for an export without Pro. */
export function registerPortraitProbe(): void {
  registerProProbe('portrait-style', {
    label: () => t('pstyle.item'),
    patch: (o) => (o.kind === 'image' && o.style ? { style: undefined } : null),
  });
}

/** A labelled Style select (Original and the five styles) and the crown beside it. */
function picker(id: string, wrap: HTMLElement): { select: HTMLSelectElement; chip: HTMLElement } {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.setAttribute('data-i18n', 'pstyle.label');
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('data-i18n-attr', 'title:pstyle.labelT');
  for (const v of ['', ...PORTRAIT_STYLES] as const) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.setAttribute('data-i18n', NAMES[v]);
    select.appendChild(opt);
  }
  const chip = document.createElement('span');
  chip.className = 'pstyle-crown';
  wrap.append(label, select, chip);
  applyDom(wrap);
  return { select, chip };
}

/**
 * The import bar's other picture options that a style replaces: Real colours
 * (a style draws in the design's own colours, so the palette is not grown)
 * and Dither (a style draws its own tones). Switched off and greyed while a
 * style is picked, and given back as they were when it is Original again.
 */
function importExtras(): { set(styled: boolean): void } {
  const boxes = ['real-colors', 'dither']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
  const was = new Map<HTMLInputElement, boolean>();
  return {
    set(styled) {
      for (const box of boxes) {
        if (styled) {
          if (!was.has(box)) was.set(box, box.checked);
          box.checked = false;
          box.disabled = true;
          box.title = t('pstyle.ownColours');
        } else if (was.has(box)) {
          box.checked = was.get(box)!;
          was.delete(box);
          box.disabled = false;
          box.removeAttribute('title');
        }
      }
    },
  };
}

export function mountProStyles(ctx: ProToolsContext): void {
  registerPortraitProbe();
  const { objects } = ctx;
  const crowns: HTMLElement[] = [];
  let running = false;
  const paintCrowns = (): void => {
    // A holder still sees what is Pro, quietly (docs/DESIGN.md, Pro).
    for (const c of crowns) c.innerHTML = proChipHtml({ quiet: running });
  };

  // ---- the import bar ----
  const bar = document.getElementById('import-bar');
  let importField: HTMLElement | null = null;
  let importSelect: HTMLSelectElement | null = null;
  const extras = importExtras();
  if (bar) {
    importField = document.createElement('span');
    importField.className = 'tb-field seat-only pstyle-field';
    const { select, chip } = picker('import-pstyle', importField);
    importSelect = select;
    crowns.push(chip);
    // Beside Real colours and Dither: it is the same question, how to draw it.
    const after = document.getElementById('real-colors')?.closest('.tb-field');
    if (after?.parentElement === bar) after.after(importField);
    else bar.insertBefore(importField, document.getElementById('import-cancel'));
    select.addEventListener('change', () => {
      const v = select.value;
      if (isPortraitStyle(v)) bar.dataset.proStyle = v;
      else delete bar.dataset.proStyle;
      extras.set(isPortraitStyle(v));
    });
  }

  // ---- a picture layer's properties ----
  const picRow = document.getElementById('obj-pic-row');
  let layerRow: HTMLElement | null = null;
  let layerSelect: HTMLSelectElement | null = null;
  if (picRow) {
    layerRow = document.createElement('div');
    layerRow.className = 'pstyle-row';
    const { select, chip } = picker('obj-pstyle', layerRow);
    layerSelect = select;
    crowns.push(chip);
    picRow.appendChild(layerRow);
    select.addEventListener('change', () => {
      const sel = objects.selected;
      if (sel?.kind !== 'image' || sel.locked) return;
      const v = select.value;
      // One undo step (ObjectLayer.update); Original takes the style off.
      objects.update(sel.id, { style: isPortraitStyle(v) ? v : undefined });
      ctx.say(tv('pstyle.set', { name: sel.label || sel.name, style: t(NAMES[isPortraitStyle(v) ? v : '']) }));
    });
  }
  const dither = document.getElementById('obj-dither') as HTMLInputElement | null;
  /** Show the selected picture's style. Runs after the toolbar's own refresh (registered later). */
  const syncLayer = (): void => {
    const sel = objects.selected;
    if (!layerSelect || sel?.kind !== 'image') return;
    layerSelect.value = isPortraitStyle(sel.style) ? sel.style : '';
    layerSelect.disabled = !!sel.locked;
    // Dither means nothing to a styled picture: it draws its own tones.
    if (dither) {
      dither.disabled = !!sel.locked || isPortraitStyle(sel.style);
      if (isPortraitStyle(sel.style)) dither.title = t('pstyle.ownColours');
      else dither.removeAttribute('title');
    }
  };
  objects.onChange(syncLayer);
  syncLayer();

  // ---- Pro on, Pro running ----
  /** Only while /api/pro says Pro is on for this account: a sign-out takes the picker away. */
  const show = (st: ProState | null): void => {
    const live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    if (importField) importField.hidden = !live;
    if (layerRow) layerRow.hidden = !live;
    if (!live && bar && importSelect) {
      importSelect.value = '';
      delete bar.dataset.proStyle;
      extras.set(false);
    }
    paintCrowns();
  };
  paintCrowns();
  void fetchPro().then(show, () => show(null));
  window.addEventListener('tifo:auth', () => {
    void fetchPro(true).then(show, () => show(null));
  });
  onLangChange(() => {
    paintCrowns();
    syncLayer();
    if (importSelect && bar && isPortraitStyle(importSelect.value)) extras.set(true);
  });

  // A handle for the browser suite (e2e-pro-styles.mjs), only on a page opened
  // with ?e2e (the editor tidies its address, so its own e2e hook, __tifo, is
  // how a page opened with it still says so): the export sheet and the lift.
  if (new URLSearchParams(location.search).has('e2e') || '__tifo' in window) {
    (window as unknown as { __tifoProStyles: unknown }).__tifoProStyles = {
      items: (): string[] => designProItems(objects),
      gate: () => exportGate(designProItems(objects)),
      /** The seats while the design's Pro items are lifted, and after they are put back. */
      lifted: async (): Promise<{ during: string; after: string }> => {
        const store = (window as unknown as { __tifo?: { store?: { cells: Uint8Array } } }).__tifo?.store;
        const sum = (): string => {
          const c = store?.cells;
          if (!c) return '';
          let h = 2166136261;
          for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i], 16777619);
          return (h >>> 0).toString(16);
        };
        const during = await withoutDesignProItems(objects, async () => sum());
        return { during, after: sum() };
      },
    };
  }
}
