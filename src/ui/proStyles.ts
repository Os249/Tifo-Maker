/**
 * Portrait styles (Pro): a face or a player photo as a stencil, a duotone in
 * the club's colour, a 2- or 3-colour poster or pop art, drawn for the stand
 * it is going on. Mounted by proTools.ts, which loads this module only for an
 * account /api/pro says Pro is on for, so the editor's start carries none of
 * its code or words.
 *
 * Two places to pick a style, each with the crown beside it:
 *  - the picture import bar. Picking a style there prepares the picture for
 *    the stand it is going to (ui/portraitPrep.ts: the subject lifted out, the
 *    face found, a head and shoulders cropped and sized to fill the stand's
 *    rows at its seats' real shape) and puts the prepared picture in the bar,
 *    face and all, for toolbar.ts to place. Under the bar, every style is
 *    shown on the fan's own stand, sampled at its real rows and seats over the
 *    design already there, before they pick; and a line says honestly what
 *    the stand can carry (a 14-row stand gets a silhouette, and is told so).
 *    "Cut out and style" does the smart cut-out (smartCutout.ts, counted by
 *    the server) and the style in one tap. On a banner, where a portrait is
 *    printed rather than held up, the style is drawn at full size;
 *  - a picture layer's properties: a change is one undo step; the face is
 *    looked for the first time a style is picked.
 *
 * The drawing itself is core/portraitStyles.ts, called from ensureGrid for
 * any picture that carries a style, Pro or not: a style is the design's
 * data, like its colours. What Pro decides is what leaves the site, so the
 * style is registered with proGate as a design-level Pro item, and an export
 * from an account without Pro running asks first (and can go without it).
 *
 * Like the rest of Pro in the interface, this shows and asks; it decides
 * nothing that costs money (the cut-out's count is the server's).
 */
import './proStyles.css';
import { fetchPro, type ProState } from '../net/api';
import { BANNER_STYLES, SEAT_STYLES, isPortraitStyle, type PortraitStyle } from '../core/portraitStyles';
import { ROWS_FACE, ROWS_SHOULDERS, cropKindFor, seatShapeAt, underAt, type FaceInfo, type SeatShape } from '../core/portraitPipeline';
import { ensureGrid, type ImageObject } from '../core/objects';
import { stampObject } from '../core/layers';
import { EDITOR_UNITS } from '../core/seatmap';
import { regionPredicate, regionRect } from '../core/specCompiler';
import { STAND_ORDER, standAtU, type Region } from '../core/tifoSpec';
import type { StandIndex } from '../core/banner';
import { bestFaceBanner, faceShareOf, printPortrait } from './faceBanner';
import { applyDom, onLangChange, t, tv } from './i18n';
import { CROWN_SVG, proChipHtml } from './pro';
import { designProItems, exportGate, registerProProbe, withoutDesignProItems } from './proGate';
import { bannerActive, bannerScene } from './bannerHost';
import type { ProToolsContext } from './proTools';
import type { Prepared } from './portraitPrep';

/** Each choice's name, Original first. */
const NAMES: Record<PortraitStyle | '', string> = {
  '': 'pstyle.original',
  stencil: 'pstyle.stencil',
  duotone: 'qi.duotone',
  poster2: 'pstyle.poster2',
  poster3: 'pstyle.poster3',
  pop: 'pstyle.pop',
  painted: 'qi.painted',
};

/**
 * Give the select the styles this surface offers: the seat styles on the
 * stand, Painted as well on a banner. A retired style (Poster 2) stays
 * listed only while it is the one picked, so a saved picture still shows it.
 */
function offer(select: HTMLSelectElement, banner: boolean, value = select.value): void {
  const want = ['', ...(banner ? BANNER_STYLES : SEAT_STYLES)] as (PortraitStyle | '')[];
  const v = (isPortraitStyle(value) ? value : '') as PortraitStyle | '';
  if (!want.includes(v)) want.push(v);
  const have = [...select.options].map((o) => o.value);
  if (have.length !== want.length || have.some((h, i) => h !== want[i])) {
    select.replaceChildren(
      ...want.map((w) => {
        const opt = document.createElement('option');
        opt.value = w;
        opt.setAttribute('data-i18n', NAMES[w]);
        opt.textContent = t(NAMES[w]);
        return opt;
      }),
    );
  }
  select.value = v;
}

/** The palette card furthest in lightness from `bg`: words that read on the sheet. */
function contrasting(palette: readonly string[], bg: string | undefined): string {
  const lum = (h: string): number => {
    const v = parseInt(String(h).replace('#', '').slice(0, 6), 16);
    return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
  };
  const b = lum(bg ?? '#ffffff');
  let best = '#141414';
  let far = -1;
  for (const c of palette.slice(1)) {
    if (!/^#[0-9a-f]{6}$/i.test(c)) continue;
    const d = Math.abs(lum(c) - b);
    if (d > far) {
      far = d;
      best = c;
    }
  }
  return best;
}

/** A PNG data URL's width and height, from its header. */
function pngSize(url: string): [number, number] {
  try {
    const b = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 33));
    const at = (i: number): number => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;
    return [at(16), at(20)];
  } catch {
    return [0, 0];
  }
}

/**
 * Rows below which a face on the cards is a person rather than a likeness
 * (measured on the portrait sheets, 2 Nov 2026): the advice offers the
 * banner below it.
 */
const ROWS_LIKENESS = 45;

/** A banner is not a stand: a head and shoulders at the picture's own shape. */
const BANNER_SHAPE = { rows: 64, seats: 4096, pitch: EDITOR_UNITS.colPx, cell: 1 };

/** The import bar's stand presets (index.html #import-place): their names. */
const STAND_NAMES: Record<string, string> = { north: 'ed.import.north', east: 'ed.import.east', south: 'ed.import.south', west: 'ed.import.west' };

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
  offer(select, false);
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

/** The stand a picture in the import bar is going to, and its seats. */
interface Target {
  key: string;
  region: Region;
  accept: (i: number) => boolean;
  rect: { cx: number; cy: number; width: number; height: number };
  shape: SeatShape;
  /** Its name in a sentence ("North stand", "this stand"). */
  name: string;
}

const hexRgb = (h: string): string => {
  const v = parseInt(String(h).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;
};

export function mountProStyles(ctx: ProToolsContext): void {
  registerPortraitProbe();
  const { objects, map, store } = ctx;
  const host = ctx.importPicture ?? null;
  const crowns: HTMLElement[] = [];
  let running = false;
  let live = false;
  let canCut = false;
  const paintCrowns = (): void => {
    // A holder still sees what is Pro, quietly (docs/DESIGN.md, Pro).
    for (const c of crowns) c.innerHTML = proChipHtml({ quiet: running });
  };

  // ---- the import bar ----
  const bar = document.getElementById('import-bar');
  let importField: HTMLElement | null = null;
  let importSelect: HTMLSelectElement | null = null;
  let panel: HTMLElement | null = null;
  let strip: HTMLElement | null = null;
  let note: HTMLElement | null = null;
  let cutBtn: HTMLButtonElement | null = null;
  let bannerBtn: HTMLButtonElement | null = null;
  const extras = importExtras();
  if (bar) {
    importField = document.createElement('span');
    importField.className = 'tb-field pstyle-field';
    const { select, chip } = picker('import-pstyle', importField);
    importSelect = select;
    crowns.push(chip);
    // One tap: the smart cut-out, then the style (Stencil if none is picked yet).
    cutBtn = document.createElement('button');
    cutBtn.type = 'button';
    cutBtn.className = 'pro-btn qi-cutstyle';
    cutBtn.hidden = true;
    importField.appendChild(cutBtn);
    // Beside Real colours and Dither: it is the same question, how to draw it.
    const after = document.getElementById('real-colors')?.closest('.tb-field');
    if (after?.parentElement === bar) after.after(importField);
    else bar.insertBefore(importField, document.getElementById('import-cancel'));
    // The previews and the advice: a row of their own under the bar's controls.
    panel = document.createElement('div');
    panel.className = 'qi-panel';
    panel.hidden = true;
    note = document.createElement('p');
    note.className = 'qi-note';
    note.setAttribute('aria-live', 'polite');
    strip = document.createElement('div');
    strip.className = 'qi-strip';
    strip.setAttribute('role', 'radiogroup');
    // Too few rows for a face: the face goes on a printed banner instead.
    bannerBtn = document.createElement('button');
    bannerBtn.type = 'button';
    bannerBtn.className = 'pro-btn qi-tobanner';
    bannerBtn.hidden = true;
    bannerBtn.innerHTML = `${CROWN_SVG}<span></span>`;
    bannerBtn.addEventListener('click', () => void toBanner());
    panel.append(note, bannerBtn, strip);
    bar.insertBefore(panel, document.getElementById('import-cancel')?.nextSibling ?? null);
    select.addEventListener('change', () => {
      const v = select.value;
      if (isPortraitStyle(v)) bar.dataset.proStyle = v;
      else delete bar.dataset.proStyle;
      extras.set(isPortraitStyle(v));
      void refresh();
    });
  }
  const paintCut = (): void => {
    if (!cutBtn) return;
    cutBtn.hidden = !canCut || !host;
    cutBtn.innerHTML = `${CROWN_SVG}<span></span>`;
    cutBtn.querySelector('span')!.textContent = t('qi.cutStyle');
    cutBtn.title = t('qi.cutStyleT');
  };

  // ---- preparing the armed picture for its stand ----
  /** The picture as the fan armed it (or as the smart cut-out gave it back): what is prepared from. */
  let source: ImageBitmap | null = null;
  let prepared: Prepared | null = null;
  /** What `prepared` was made for: the source and the stand (or the banner). */
  let preparedFor = '';
  /** The bitmap this module put in the bar for a banner (a style drawn at full size). */
  let printed: ImageBitmap | null = null;
  let generation = 0;
  const ids = new WeakMap<ImageBitmap, number>();
  let idSeq = 0;
  const idOf = (b: ImageBitmap): number => {
    if (!ids.has(b)) ids.set(b, ++idSeq);
    return ids.get(b)!;
  };

  const target = (): Target | null => {
    const place = (document.getElementById('import-place') as HTMLSelectElement | null)?.value ?? 'click';
    const tierV = (document.getElementById('import-tier') as HTMLSelectElement | null)?.value ?? 'both';
    let u: number;
    if (place === 'click') {
      const v = ctx.editor.getViewportRect();
      u = (((v.x + v.width / 2) / EDITOR_UNITS.width) % 1 + 1) % 1;
    } else u = Number(place);
    const stand = standAtU(u);
    const region: Region = { stand, tier: tierV === 'both' ? 'all' : Number(tierV) };
    const accept = regionPredicate(region, map);
    const rect = regionRect(region, map);
    const shape = seatShapeAt(map, rect, accept, EDITOR_UNITS.width);
    if (!shape) return null;
    return { key: `${stand}|${region.tier}`, region, accept, rect, shape, name: place === 'click' ? t('qi.thisStand') : t(STAND_NAMES[stand]) };
  };

  const say = (text: string): void => {
    if (note) note.textContent = text;
  };

  /** The advice for this stand: what it can carry, in rows. */
  const advice = (tg: Target, prep: Prepared): string => {
    if (!prep.face) return t('qi.noFace');
    const kind = cropKindFor(prep.rows);
    if (kind === 'shoulders') return tv(prep.rows >= ROWS_LIKENESS ? 'qi.full' : 'qi.person', { rows: prep.rows, seats: prep.seats, stand: tg.name });
    if (kind === 'face') return tv('qi.tight', { stand: tg.name, rows: tg.shape.rows, need: ROWS_SHOULDERS });
    return tv('qi.small', { stand: tg.name, rows: tg.shape.rows, need: ROWS_FACE });
  };

  /** A picture layer as it would be placed, without being placed. */
  const probe = (bmp: ImageBitmap, tg: Target, style: PortraitStyle | '', p: Prepared | null): ImageObject => {
    const base = { id: 'qi', kind: 'image' as const, cx: tg.rect.cx, cy: tg.rect.cy, rotation: 0, colorIndex: 0, tier: null, name: '', dither: false, alphaThreshold: 128 };
    if (style && p) {
      const o: ImageObject = { ...base, bitmap: p.bitmap, width: p.width, height: p.height, style, ...(p.face ? { face: p.face } : {}) };
      const box = { cx: o.cx, cy: o.cy, width: o.width, height: o.height };
      const sh = seatShapeAt(map, box, tg.accept, EDITOR_UNITS.width);
      // As the composer will measure it once placed: the shape of the seats, and the paint beneath.
      if (sh) o.seat = { pitch: Math.round(sh.pitch * 100) / 100, cell: Math.round(sh.cell * 100) / 100, under: underAt(map, store.base, box, tg.accept, EDITOR_UNITS.width) };
      return o;
    }
    // Original: the photo as the bar would place it, at the stand's height.
    const h = Math.min(tg.rect.height, tg.shape.rows * 8);
    return { ...base, bitmap: bmp, width: Math.min(tg.rect.width, (h * bmp.width) / bmp.height), height: h };
  };

  /** One style on the stand, seat by seat over the design already there, at the cards' real shape. */
  const drawTile = (o: ImageObject, tg: Target, canvas: HTMLCanvasElement): void => {
    ensureGrid(o, store.palette);
    const stamp = stampObject(map, o, o.grid ?? null, null, EDITOR_UNITS.width, tg.accept, null);
    const over = new Map<number, number>();
    for (let j = 0; j < stamp.seats.length; j++) over.set(stamp.seats[j], stamp.vals[j]);
    const margin = Math.max(o.width * 0.1, tg.shape.pitch * 4);
    const x0 = o.cx - o.width / 2 - margin;
    const x1 = o.cx + o.width / 2 + margin;
    const rowY = new Map<number, number>();
    const seats: number[] = [];
    for (let i = 0; i < map.count; i++) {
      if (!tg.accept(i)) continue;
      const x = map.xy[i * 2];
      if (x < x0 || x >= x1) continue;
      rowY.set(map.tierOf[i] * 4096 + map.rowOf[i], map.xy[i * 2 + 1]);
      seats.push(i);
    }
    const order = [...rowY.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    const rowAt = new Map(order.map((k, j) => [k, j]));
    const across = (x1 - x0) / tg.shape.pitch;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // About 128 CSS pixels across, the cards at their real shape, never taller than 96.
    let cw = (128 * dpr) / across;
    let ch = cw / tg.shape.cell;
    if (ch * order.length > 96 * dpr) {
      ch = (96 * dpr) / order.length;
      cw = ch * tg.shape.cell;
    }
    canvas.width = Math.max(8, Math.ceil(across * cw));
    canvas.height = Math.max(8, Math.ceil(order.length * ch));
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    const g = canvas.getContext('2d')!;
    g.fillStyle = hexRgb('#0b0d12');
    g.fillRect(0, 0, canvas.width, canvas.height);
    const fill = store.palette.map(hexRgb);
    const gap = cw >= 3 ? 0.5 : 0;
    for (const i of seats) {
      const r = rowAt.get(map.tierOf[i] * 4096 + map.rowOf[i])!;
      const v = over.get(i) ?? store.cells[i];
      g.fillStyle = fill[v] ?? fill[0];
      g.fillRect(((map.xy[i * 2] - x0) / tg.shape.pitch) * cw, r * ch, Math.max(1, cw - gap), Math.max(1, ch - gap));
    }
  };

  /** A style drawn for a banner: at full size, in the design's colours (a banner prints, so it can afford the detail). */
  const printStyled = async (p: Prepared, style: PortraitStyle, under = -1): Promise<ImageBitmap> =>
    createImageBitmap(printPortrait(p, style, store.palette, under));

  /** Can this stand take a banner? (Some grounds have a stand with no frame for one.) */
  let frames: ((stand: StandIndex, stands?: number) => { ok: boolean }) | null = null;
  void import('../render/simulator/standFrame')
    .then(({ spanFrameCache }) => {
      frames = spanFrameCache(map);
    })
    .catch(() => undefined);
  const standIndexOf = (tg: Target): StandIndex => Math.max(0, STAND_ORDER.indexOf(tg.region.stand as (typeof STAND_ORDER)[number])) as StandIndex;

  /** Offer the banner when the stand is short of the rows a face needs (the lead offer below a face's rows). */
  const paintBanner = (tg: Target | null, p: Prepared | null): void => {
    if (!bannerBtn) return;
    const rows = p ? p.rows : tg ? tg.shape.rows : ROWS_LIKENESS;
    const kind = cropKindFor(rows);
    const ok = !!tg && (!p || !!p.face) && rows < ROWS_LIKENESS && !!bannerScene.store && frames?.(standIndexOf(tg), 1).ok !== false;
    bannerBtn.hidden = !ok;
    bannerBtn.classList.toggle('qi-tobanner-lead', ok && kind === 'silhouette');
    bannerBtn.querySelector('span')!.textContent = t('qi.toBanner');
    bannerBtn.title = t('qi.toBannerT');
  };

  /**
   * One tap: the styled face at full size on a printed banner over the
   * middle of the stand, through the banner system (it saves, shows in Match
   * Day and is edited in Banners like any other), on a sheet of the stand's
   * own colour; the cards around it keep the club colours and the words.
   * The picture is not stamped on the seats.
   */
  const toBanner = async (): Promise<void> => {
    const bs = bannerScene.store;
    const tg = target();
    if (!bs || !tg || !source || !importSelect) return;
    const picked = importSelect.value;
    const style: PortraitStyle = isPortraitStyle(picked) ? picked : 'painted';
    const mine = ++generation;
    say(t('qi.finding'));
    try {
      const { preparePortrait } = await import('./portraitPrep');
      // Head and shoulders, and the face alone: the banner takes whichever
      // shows the face bigger from the TV gantry.
      const ps = await preparePortrait(source, BANNER_SHAPE);
      const pf = await preparePortrait(source, { ...BANNER_SHAPE, rows: ROWS_FACE + 4 });
      const under = underAt(map, store.cells, tg.rect, tg.accept, EDITOR_UNITS.width);
      const prints = {
        shoulders: { canvas: printPortrait(ps, style, store.palette, under), face: faceShareOf(ps.face) },
        face: { canvas: printPortrait(pf, style, store.palette, under), face: faceShareOf(pf.face) },
      };
      ps.bitmap.close();
      pf.bitmap.close();
      if (mine !== generation) return;
      const bg = under >= 0 ? store.palette[under] : undefined;
      // The design's own words, for a long cloth: its longest text layer.
      const words = objects
        .list()
        .flatMap((o) => (o.kind === 'text' && o.text.trim() ? [o.text.trim()] : []))
        .sort((a, b) => b.length - a.length)[0];
      const plan = await bestFaceBanner(prints, map, {
        name: tv('qi.bannerName', { stand: tg.name }),
        stand: standIndexOf(tg),
        tier: typeof tg.region.tier === 'number' ? tg.region.tier : -1,
        bg,
        words: words?.slice(0, 60),
        wordsColor: contrasting(store.palette, bg),
      });
      lastPlan = { kind: plan.layout.kind, words: plan.layout.words, crop: plan.crop, share: Math.round(plan.share * 1000) / 1000, widthM: Math.round(plan.widthM), heightM: Math.round(plan.heightM) };
      const doc = plan.doc;
      bs.add(doc);
      bannered = doc.id;
      const name = tg.name;
      // The picture is on the banner, not the seats: put the import away.
      document.getElementById('import-cancel')?.click();
      ctx.say(tv('qi.onBanner', { stand: name }));
    } catch (e) {
      console.warn('[tifo] face banner failed', e);
      if (mine === generation) say(t('qi.failed'));
    }
  };
  /** The last banner made here, and how it was chosen (for the browser suite). */
  let bannered = '';
  let lastPlan: Record<string, unknown> | null = null;

  const showTiles = (tg: Target, p: Prepared, chosen: PortraitStyle | ''): void => {
    if (!strip || !source) return;
    strip.replaceChildren();
    for (const v of ['', ...SEAT_STYLES] as const) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'qi-tile';
      tile.dataset.style = v;
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(v === chosen));
      tile.title = tv('qi.tileT', { style: t(NAMES[v]), stand: tg.name });
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const cap = document.createElement('span');
      cap.textContent = t(NAMES[v]);
      tile.append(canvas, cap);
      strip.appendChild(tile);
      drawTile(probe(source, tg, v, p), tg, canvas);
      tile.addEventListener('click', () => {
        if (!importSelect) return;
        importSelect.value = v;
        importSelect.dispatchEvent(new Event('change'));
      });
    }
    strip.setAttribute('aria-label', t('qi.strip'));
  };

  /** Size the bar's width to the prepared picture, so the ghost and the placed layer are the stand's. */
  const fitWidth = (p: Prepared): void => {
    const input = document.getElementById('import-width') as HTMLInputElement | null;
    if (!input) return;
    const seats = Math.round(p.width / EDITOR_UNITS.colPx / 2) * 2;
    input.value = String(Math.max(Number(input.min) || 8, Math.min(Number(input.max) || 1250, seats)));
    input.dispatchEvent(new Event('input'));
  };

  /**
   * Bring the bar up to date with the picked style: prepare the picture for
   * its stand when the picture or the stand changed, put it in the bar, and
   * draw the previews. Original gives the bar its picture back.
   */
  const refresh = async (): Promise<void> => {
    if (!host || !importSelect || !panel) return;
    const style = importSelect.value;
    const mine = ++generation;
    source ??= host.current();
    if (!source || !live) {
      panel.hidden = true;
      return;
    }
    if (!isPortraitStyle(style)) {
      // Original: the picture as it was armed (or cut out). On a stand too
      // small for a face, the banner is still offered, first.
      if (host.current() !== source) host.swap(source);
      printed = null;
      const tg = bannerActive() ? null : target();
      const small = !!tg && tg.shape.rows < ROWS_FACE;
      panel.hidden = !small;
      if (small && tg) {
        strip?.replaceChildren();
        say(tv('qi.small', { stand: tg.name, rows: tg.shape.rows, need: ROWS_FACE }));
      }
      paintBanner(small ? tg : null, null);
      return;
    }
    const banner = bannerActive();
    offer(importSelect, banner);
    const tg = banner ? null : target();
    panel.hidden = false;
    paintBanner(null, null);
    const key = `${idOf(source)}|${banner ? 'banner' : tg?.key ?? ''}`;
    if (preparedFor !== key || !prepared) {
      say(t('qi.finding'));
      strip?.replaceChildren();
      try {
        const { preparePortrait } = await import('./portraitPrep');
        // A banner is not a stand: a head and shoulders at the picture's own shape.
        const shape = tg?.shape ?? BANNER_SHAPE;
        const p = await preparePortrait(source, shape);
        if (mine !== generation) {
          p.bitmap.close();
          return;
        }
        prepared = p;
        preparedFor = key;
      } catch (e) {
        console.warn('[tifo] portrait preparation failed', e);
        if (mine === generation) say(t('qi.failed'));
        return;
      }
    }
    const p = prepared!;
    if (banner) {
      const b = await printStyled(p, style);
      if (mine !== generation) return;
      printed = b;
      host.swap(b);
      say(t('qi.banner'));
      strip?.replaceChildren();
      return;
    }
    if (!tg) return;
    if (host.current() !== p.bitmap) host.swap(p.bitmap, p.face ?? undefined);
    fitWidth(p);
    say(advice(tg, p));
    paintBanner(tg, p);
    showTiles(tg, p, style);
  };

  const forget = (): void => {
    generation++;
    source = null;
    prepared = null;
    preparedFor = '';
    printed = null;
    if (panel) panel.hidden = true;
    strip?.replaceChildren();
  };
  document.addEventListener('tifo:import-armed', () => {
    forget();
    if (host) source = host.current();
    void refresh();
  });
  // The smart cut-out gave the bar a new picture, or the original back: prepare from that.
  for (const ev of ['tifo:cutout-done', 'tifo:cutout-undone']) {
    document.addEventListener(ev, (e) => {
      const bmp = (e as CustomEvent<{ bitmap?: ImageBitmap }>).detail?.bitmap;
      if (!bmp) return;
      generation++;
      source = bmp;
      prepared = null;
      preparedFor = '';
      if (ev === 'tifo:cutout-done' && importSelect && !isPortraitStyle(importSelect.value)) fitCutout(bmp);
      void refresh();
    });
  }
  /**
   * A cut-out with no style: sized so the subject (it is cropped to it)
   * fills the stand's rows, never wider than the stand.
   */
  const fitCutout = (bmp: ImageBitmap): void => {
    const tg = bannerActive() ? null : target();
    const input = document.getElementById('import-width') as HTMLInputElement | null;
    if (!tg || !input) return;
    const across = Math.min(tg.rect.width, (tg.shape.rows * 8 * bmp.width) / bmp.height);
    const seats = Math.round(across / EDITOR_UNITS.colPx / 2) * 2;
    input.value = String(Math.max(Number(input.min) || 8, Math.min(Number(input.max) || 1250, seats)));
    input.dispatchEvent(new Event('input'));
    ctx.say(tv('qi.cutFit', { stand: tg.name, rows: tg.shape.rows }));
  };
  document.addEventListener('tifo:import-done', forget);
  // The smart cut-out is about to read the bar: it cuts the picture, not what a style made of it.
  document.addEventListener('tifo:cutout-before', () => {
    generation++;
    if (host && source && host.current() !== source) host.swap(source);
  });
  for (const id of ['import-place', 'import-tier']) document.getElementById(id)?.addEventListener('change', () => void refresh());

  cutBtn?.addEventListener('click', () => {
    if (!importSelect) return;
    if (!isPortraitStyle(importSelect.value)) {
      importSelect.value = 'stencil';
      importSelect.dispatchEvent(new Event('change'));
    }
    // smartCutout.ts runs it (asks first, the server counts it) and says when it is done.
    document.dispatchEvent(new CustomEvent('tifo:cutout-run'));
  });

  // ---- a picture layer's properties ----
  const picRow = document.getElementById('obj-pic-row');
  let layerRow: HTMLElement | null = null;
  let layerSelect: HTMLSelectElement | null = null;
  /** The face of each picture's source, once looked for (null: there is none). */
  const faces = new Map<string, FaceInfo | null>();
  if (picRow) {
    layerRow = document.createElement('div');
    layerRow.className = 'pstyle-row';
    const { select, chip } = picker('obj-pstyle', layerRow);
    layerSelect = select;
    crowns.push(chip);
    picRow.appendChild(layerRow);
    select.addEventListener('change', async () => {
      const sel = objects.selected;
      if (sel?.kind !== 'image' || sel.locked) return;
      const v = select.value;
      const style = isPortraitStyle(v) ? v : undefined;
      // The face is looked for once per picture, the first time a style is picked.
      let face = sel.face;
      const src = sel.src ?? '';
      if (style && !face && sel.bitmap) {
        if (!faces.has(src)) {
          const { findFace } = await import('./portraitVision');
          faces.set(src, await findFace(sel.bitmap).catch(() => null));
        }
        face = faces.get(src) ?? undefined;
      }
      // One undo step (ObjectLayer.update); Original takes the style off.
      const now = objects.get(sel.id);
      if (now?.kind !== 'image') return;
      objects.update(sel.id, { style, ...(face && !now.face ? { face } : {}) });
      ctx.say(tv('pstyle.set', { name: sel.label || sel.name, style: t(NAMES[style ?? '']) }));
    });
  }
  const dither = document.getElementById('obj-dither') as HTMLInputElement | null;
  /** Show the selected picture's style. Runs after the toolbar's own refresh (registered later). */
  const syncLayer = (): void => {
    const sel = objects.selected;
    if (!layerSelect || sel?.kind !== 'image') return;
    offer(layerSelect, false, isPortraitStyle(sel.style) ? sel.style : '');
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
    live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    canCut = live && !!st?.allowances?.cutout;
    if (importField) importField.hidden = !live;
    if (layerRow) layerRow.hidden = !live;
    if (!live && bar && importSelect) {
      importSelect.value = '';
      delete bar.dataset.proStyle;
      extras.set(false);
      forget();
    }
    paintCrowns();
    paintCut();
  };
  paintCrowns();
  paintCut();
  void fetchPro().then(show, () => show(null));
  window.addEventListener('tifo:auth', () => {
    void fetchPro(true).then(show, () => show(null));
  });
  onLangChange(() => {
    paintCrowns();
    paintCut();
    syncLayer();
    if (importSelect && bar && isPortraitStyle(importSelect.value)) {
      extras.set(true);
      void refresh();
    }
  });

  // A handle for the browser suite (e2e-pro-styles.mjs), only on a page opened
  // with ?e2e (the editor tidies its address, so its own e2e hook, __tifo, is
  // how a page opened with it still says so): the export sheet and the lift,
  // and what the bar prepared.
  if (new URLSearchParams(location.search).has('e2e') || '__tifo' in window) {
    (window as unknown as { __tifoProStyles: unknown }).__tifoProStyles = {
      items: (): string[] => designProItems(objects),
      /** The last face banner made from the import bar, as the banner store holds it. */
      banner: () => {
        const d = bannered ? bannerScene.store?.get(bannered) : undefined;
        const img = d?.items.find((i) => i.kind === 'image');
        return d ? { plan: lastPlan, kind: d.kind, stand: d.slot.stand, tier: d.slot.tier, bg: d.bg, aspect: d.aspect, image: img?.kind === 'image' ? { w: img.w, h: img.h, png: img.src.startsWith('data:image/png'), px: pngSize(img.src) } : null } : null;
      },
      gate: () => exportGate(designProItems(objects)),
      /** The seats while the design's Pro items are lifted, and after they are put back. */
      lifted: async (): Promise<{ during: string; after: string }> => {
        const st = (window as unknown as { __tifo?: { store?: { cells: Uint8Array } } }).__tifo?.store;
        const sum = (): string => {
          const c = st?.cells;
          if (!c) return '';
          let h = 2166136261;
          for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i], 16777619);
          return (h >>> 0).toString(16);
        };
        const during = await withoutDesignProItems(objects, async () => sum());
        return { during, after: sum() };
      },
      prepared: () => (prepared ? { kind: prepared.kind, face: !!prepared.face, rows: prepared.rows, seats: prepared.seats, subject: prepared.subject, w: prepared.bitmap.width, h: prepared.bitmap.height } : null),
      printed: () => (printed ? { w: printed.width, h: printed.height } : null),
    };
  }
}
