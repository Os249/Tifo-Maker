/**
 * Pro's poster sheet: a match-day poster of the tifo, with a live preview.
 *
 * The picture is Match Day's, not the editor's model: the tifo in its
 * floodlit ground on the "Your tifo" camera (simulator/film.ts filmStill),
 * drawn off screen from the editor's design (ui/proFilm.ts
 * offscreenMatchDay) and reframed for each shape. Over it, the type
 * (ui/posterLayout.ts): three layouts, landscape 3840 × 2160 or portrait
 * 2160 × 3840, in the language the site is in, with the fan's club kit
 * (its name, colours, crest and lettering) when they have one, and the
 * design's own colours and lettering when not.
 *
 * Free to try: the preview is drawn for anyone Pro is on for. The download
 * is a Pro item and asks once (proGate.ts); "Export without Pro items" is
 * today's free picture, the screen's size with the mark (`free`).
 */
import './proPoster.css';
import { escapeHtml } from '../core/escape';
import { PRO_FONTS, PRO_VOICES } from '../core/proVoices';
import { TIFO_FONTS, fontCssOf } from '../core/text';
import { loadProFonts, loadTifoFonts } from '../core/tifoFonts';
import type { MatchDaySimulator } from '../render/simulator/index';
import { loadKits, type ClubKit } from './clubKitStore';
import { containDialog } from './dialogFocus';
import { getLang, t, tl, tv } from './i18n';
import { matchDayDeps } from './matchDayDeps';
import { SPLIT_TELLS, tifoSplit } from '../render/simulator/tifoSplit';
import { CROWN_SVG } from './pro';
import { exportGate } from './proGate';
import { offscreenMatchDay } from './proFilm';
import { POSTER_SIZES, drawPoster, type PosterLayout, type PosterShape, type PosterSpec } from './posterLayout';

export interface PosterSheetDeps {
  /** The project's name: the file's, and the club's when there is no kit. */
  title(): string;
  /** The shape to open on: portrait when the video's size is vertical. */
  shape: PosterShape;
  /** The design's text layers' fonts and words, for its own lettering and a chant. */
  designText(): { fontId: string; text: string }[];
  /** The Pro items the design carries besides the poster (proGate.designProItems). */
  designItems(): string[];
  /** "Export without Pro items": the free picture, after the sheet has closed. Resolves with the status line. */
  free(): Promise<string>;
  /** Put a line in the export panel's status. */
  say(msg: string): void;
  creditLine?: string;
}

interface Fields {
  layout: PosterLayout;
  shape: PosterShape;
  club: string;
  opponent: string;
  date: string;
  time: string;
  venue: string;
  headline: string;
}

const KEEP = 'tifo_poster_v1';
const LAYOUTS: PosterLayout[] = ['matchday', 'chant', 'minimal'];
const SHAPES: PosterShape[] = ['landscape', 'portrait'];
/** The preview's longest side: enough to judge the type, quick to draw. */
const PREVIEW_EDGE = 1280;

/** What the fan typed last time (this browser), so the next poster starts there. */
function kept(): Partial<Fields> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEEP) || 'null') as Partial<Fields> | null;
    if (!raw || typeof raw !== 'object') return {};
    const out: Partial<Fields> = {};
    if (LAYOUTS.includes(raw.layout as PosterLayout)) out.layout = raw.layout;
    for (const k of ['opponent', 'date', 'time', 'headline'] as const) if (typeof raw[k] === 'string') out[k] = raw[k]!.slice(0, 80);
    return out;
  } catch {
    return {};
  }
}
function keep(f: Fields): void {
  try {
    localStorage.setItem(KEEP, JSON.stringify({ layout: f.layout, opponent: f.opponent, date: f.date, time: f.time, headline: f.headline }));
  } catch { /* private mode: this visit keeps it */ }
}

/** The date as the poster sets it, in the site's language with Western digits: "SAT 8 NOV", "السبت 8 نوفمبر". */
export function posterDate(iso: string, lang: 'en' | 'ar'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  if (lang === 'ar') return new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`.toUpperCase();
}
/** The kick-off as the poster sets it: "20:30", "8:30 م". */
export function posterTime(hhmm: string, lang: 'en' | 'ar'): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return '';
  const d = new Date(Date.UTC(2026, 0, 1, +m[1], +m[2]));
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
}

/** A font id's CSS family, whether it is a shipped voice or a Pro one. */
const familyOf = (id: string): string => fontCssOf(id, [...TIFO_FONTS, ...PRO_FONTS]);
const knownFont = (id: string): boolean => [...TIFO_FONTS, ...PRO_FONTS].some((f) => f.id === id);

/**
 * Open the poster sheet. Resolves when it closes. Builds Match Day off screen
 * while it is open, and frees it after.
 */
export async function openPosterSheet(deps: PosterSheetDeps): Promise<void> {
  const md = matchDayDeps();
  if (!md) return;
  const lang: 'en' | 'ar' = getLang() === 'ar' ? 'ar' : 'en';
  const kits = (await loadKits(knownFont).catch(() => ({ kits: [] as ClubKit[] }))).kits;
  const design = deps.designText();
  const firstText = design.find((d) => d.text.trim());
  const f: Fields = {
    layout: 'matchday',
    shape: deps.shape,
    club: kits[0]?.name || deps.title(),
    opponent: '',
    date: '',
    time: '',
    venue: tl(md.template.id),
    headline: firstText?.text.trim().slice(0, 60) ?? '',
    ...kept(),
  };
  let kit: ClubKit | null = kits[0] ?? null;
  const fonts: { id: string; label: string }[] = [
    ...(kit?.font ? [{ id: 'kit', label: t('qv.p.kitFont') }] : []),
    ...(design[0]?.fontId && knownFont(design[0].fontId) ? [{ id: 'design', label: t('qv.p.designFont') }] : []),
    ...PRO_VOICES.map((v) => ({ id: v.id, label: v.name })),
  ];
  let fontChoice = fonts[0].id;
  const fontId = (): string => (fontChoice === 'kit' ? kit?.font || 'block' : fontChoice === 'design' ? design[0]?.fontId || 'block' : fontChoice);

  // ---- the sheet ----
  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop qv-poster-backdrop';
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const radios = (name: string, items: [string, string][], value: string): string =>
    `<div class="qv-seg" role="radiogroup" aria-label="${escapeHtml(t(`qv.p.${name}`))}">` +
    items.map(([v, label]) => `<label class="qv-seg-item"><input type="radio" name="qv-${name}" value="${v}"${v === value ? ' checked' : ''} /><span>${escapeHtml(label)}</span></label>`).join('') +
    `</div>`;
  const input = (key: keyof Fields, type = 'text', ph = ''): string =>
    `<label class="qv-field" data-f="${key}"><span>${escapeHtml(t(`qv.p.${key}`))}</span>` +
    `<input type="${type}" name="qv-${key}" maxlength="60" dir="auto" value="${escapeHtml(String(f[key]))}"${ph ? ` placeholder="${escapeHtml(ph)}"` : ''} /></label>`;
  root.innerHTML =
    `<div class="pro-sheet qv-poster" role="dialog" aria-modal="true" aria-labelledby="qv-p-title">` +
    `<button type="button" class="pro-sheet-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>` +
    `<div class="qv-poster-head"><span class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</span>` +
    `<div><h2 id="qv-p-title">${escapeHtml(t('qv.p.title'))}</h2><p class="qv-lead"></p></div></div>` +
    `<div class="qv-poster-body">` +
    `<div class="qv-preview"><canvas role="img" aria-label="${escapeHtml(t('qv.p.preview'))}"></canvas><p class="qv-wait" role="status" aria-live="polite"></p></div>` +
    // Part of the tifo is where its stand has no seats (simulator/tifoSplit.ts): said, not hidden.
    (tifoSplit(md.map.uv, md.map.count, (i) => md.store.cells[i] !== 0) >= SPLIT_TELLS ? `<p class="qv-p-split">${escapeHtml(t('qv.p.split'))}</p>` : '') +
    `<div class="qv-form">` +
    `<div class="qv-row"><span class="qv-label">${escapeHtml(t('qv.p.layout'))}</span>${radios('layout', LAYOUTS.map((l) => [l, t(`qv.p.l.${l}`)]), f.layout)}</div>` +
    `<div class="qv-row"><span class="qv-label">${escapeHtml(t('qv.p.shape'))}</span>${radios('shape', SHAPES.map((s) => [s, t(`qv.p.s.${s}`)]), f.shape)}</div>` +
    `<div class="qv-grid">${input('club')}${input('opponent')}${input('date', 'date')}${input('time', 'time')}${input('venue')}${input('headline', 'text', t('qv.p.headlinePh'))}</div>` +
    `<div class="qv-grid">` +
    (kits.length
      ? `<label class="qv-field"><span>${escapeHtml(t('qv.p.colours'))}</span><select name="qv-kit">` +
        kits.map((k, i) => `<option value="${i}">${escapeHtml(tv('qv.p.kit', { name: k.name || String(i + 1) }))}</option>`).join('') +
        `<option value="-1">${escapeHtml(t('qv.p.designColours'))}</option></select></label>`
      : '') +
    `<label class="qv-field"><span>${escapeHtml(t('qv.p.font'))}</span><select name="qv-font">` +
    fonts.map((o) => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join('') +
    `</select></label></div>` +
    `<div class="pro-actions"><button type="button" class="pro-btn qv-download">${CROWN_SVG}<span>${escapeHtml(t('qv.p.download'))}</span></button></div>` +
    `<p class="qv-status" role="status" aria-live="polite"></p>` +
    `</div></div></div>`;
  const $ = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  const canvas = $<HTMLCanvasElement>('.qv-preview canvas');
  const wait = $('.qv-wait');
  const status = $('.qv-status');
  const lead = $('.qv-lead');
  const download = $<HTMLButtonElement>('.qv-download');
  document.body.appendChild(root);

  let closed = false;
  let close: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    close = (): void => {
      if (closed) return;
      closed = true;
      release();
      root.remove();
      resolve();
    };
  });
  const release = containDialog(root, () => close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('.pro-sheet-close').addEventListener('click', () => close());

  /** Which fields the layout uses: the rest are hidden, not cleared. */
  const showFields = (): void => {
    const used: Record<PosterLayout, (keyof Fields)[]> = {
      matchday: ['club', 'opponent', 'date', 'time', 'venue'],
      chant: ['club', 'date', 'headline'],
      minimal: ['club'],
    };
    for (const el of root.querySelectorAll<HTMLElement>('.qv-field[data-f]')) el.hidden = !used[f.layout].includes(el.dataset.f as keyof Fields);
    const { width, height } = POSTER_SIZES[f.shape];
    lead.textContent = tv('qv.p.lead', { w: width, h: height });
  };
  showFields();

  const spec = (): PosterSpec => {
    const colours = kit ? kit.colors : md.store.palette.slice(1);
    return {
      layout: f.layout,
      club: f.club,
      opponent: f.opponent,
      date: posterDate(f.date, lang),
      time: posterTime(f.time, lang),
      venue: f.venue,
      headline: f.headline,
      labels: { matchday: t('qv.p.matchday'), vs: t('qv.p.vs') },
      rtl: lang === 'ar',
      colours,
      logo: kit?.logos[0]?.bitmap ?? null,
      display: familyOf(fontId()),
      text: familyOf('condensed'),
      creditLine: deps.creditLine,
    };
  };

  // ---- the picture: Match Day, off screen, for as long as the sheet is open ----
  const stills = new Map<string, HTMLCanvasElement>();
  let sim: MatchDaySimulator | null = null;
  let drawing: Promise<void> = Promise.resolve();
  /** The poster's size, or the preview's (the same shape, its longest side PREVIEW_EDGE). */
  const sizeOf = (shape: PosterShape, full: boolean): { width: number; height: number } => {
    const { width, height } = POSTER_SIZES[shape];
    const k = full ? 1 : PREVIEW_EDGE / Math.max(width, height);
    return { width: Math.round(width * k), height: Math.round(height * k) };
  };
  // The tifo stands beside the type in landscape, on the side it does not start from: a still each way.
  const still = async (shape: PosterShape, full: boolean, rtl: boolean): Promise<HTMLCanvasElement | null> => {
    const key = `${shape}:${full ? 'full' : 'preview'}:${shape === 'landscape' && rtl ? 'rtl' : 'ltr'}`;
    const had = stills.get(key);
    if (had) return had;
    if (!sim) return null;
    const { filmStill, posterHold } = await import('../render/simulator/film');
    const size = sizeOf(shape, full);
    const c = await filmStill(sim.filmHost(), size.width, size.height, posterHold(shape, rtl));
    stills.set(key, c);
    return c;
  };
  const redraw = (): void => {
    drawing = drawing.then(async () => {
      if (closed) return;
      const want = f.shape;
      const rtl = spec().rtl;
      if (!stills.has(`${want}:preview:${want === 'landscape' && rtl ? 'rtl' : 'ltr'}`)) wait.textContent = t('qv.p.drawingPreview');
      const bg = await still(want, false, rtl);
      if (closed || !bg || want !== f.shape || rtl !== spec().rtl) return;
      wait.textContent = '';
      const { width, height } = sizeOf(want, false);
      canvas.width = width;
      canvas.height = height;
      canvas.dataset.shape = want;
      drawPoster(canvas.getContext('2d')!, width, height, bg, spec());
      canvas.dataset.ready = '1';
    }).catch(() => {
      wait.textContent = t('pexp.posterFailed');
    });
  };

  // Every change redraws the preview; the typing is let settle first.
  let typing = 0;
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const name = el.name?.replace(/^qv-/, '');
    if (name === 'kit') {
      const i = Number(el.value);
      kit = i >= 0 ? kits[i] ?? null : null;
    } else if (name === 'font') fontChoice = el.value;
    else if (name && name in f) (f as unknown as Record<string, string>)[name] = el.value;
    if (name === 'layout' || name === 'shape') showFields();
    keep(f);
    window.clearTimeout(typing);
    if (name === 'kit' || name === 'font') void loadProFonts([fontId()]).then(redraw);
    else typing = window.setTimeout(redraw, el instanceof HTMLInputElement && el.type === 'text' ? 180 : 0);
  });

  // ---- the download ----
  download.addEventListener('click', async () => {
    if (download.disabled) return;
    download.disabled = true;
    status.textContent = '';
    try {
      const how = await exportGate([t('pexp.item.poster'), ...deps.designItems()]);
      if (how === null) return;
      if (how === 'free') {
        close();
        deps.say(await deps.free());
        return;
      }
      const { width, height } = POSTER_SIZES[f.shape];
      status.textContent = tv('qv.p.making', { w: width, h: height });
      const bg = await still(f.shape, true, spec().rtl);
      if (!bg) throw new Error('no picture');
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      drawPoster(out.getContext('2d')!, width, height, bg, spec());
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
      if (!blob) throw new Error('no picture');
      const file = new File([blob], `${deps.title()}-poster.png`, { type: 'image/png' });
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const msg = tv('pexp.posterSaved', { w: width, h: height, mb: (blob.size / (1024 * 1024)).toFixed(1) });
      status.textContent = msg;
      deps.say(msg);
      void import('./postMoment').then(({ offerFileShare }) => offerFileShare(file, t('post.sharePic'))).catch(() => {});
    } catch {
      status.textContent = t('pexp.posterFailed');
    } finally {
      download.disabled = false;
    }
  });

  // The fonts first (a canvas measures a font that has not loaded as the
  // default face), then Match Day, then the first preview.
  wait.textContent = t('qv.p.drawingPreview');
  await Promise.all([loadTifoFonts(), loadProFonts([fontId(), ...PRO_VOICES.map((v) => v.id)])]);
  if (closed) return;
  try {
    await offscreenMatchDay(async (s) => {
      sim = s;
      redraw();
      await done;
      await drawing;
      sim = null;
    });
  } catch {
    wait.textContent = t('pexp.posterFailed');
    await done;
  }
}

/** The design's text, for the sheet: each text layer's font and words. */
export function designTextOf(list: readonly { kind: string; fontId?: string; text?: string; hidden?: boolean }[]): { fontId: string; text: string }[] {
  return list.filter((o) => o.kind === 'text' && !o.hidden).map((o) => ({ fontId: o.fontId ?? '', text: o.text ?? '' }));
}
