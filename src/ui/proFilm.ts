/**
 * Pro's Match Day film, from wherever it is asked for: the editor's export
 * panel (ui/proExport.ts) and Match Day's own Record (simulator/overlay.ts).
 *
 * The film itself is simulator/film.ts: a directed shot of the tifo in its
 * floodlit ground, drawn frame by frame at 1920 × 1080 or 1080 × 1920 and
 * encoded to H.264. This module is what the fan sees while it is made (a
 * card with the frames counting up, a progress bar and Cancel), and, from the
 * editor, the Match Day it is made in: built off screen from the editor's own
 * design (ui/matchDayDeps.ts), lit as Match Day opens, and freed after.
 *
 * Loaded only when a Pro film or poster is asked for; its words come with it.
 */
import './proFilm.css';
import type { FilmHost, FilmResult, FilmRevealSource } from '../render/simulator/film';
import type { MatchDaySimulator } from '../render/simulator/index';
import { FILM_TIMES } from '../render/simulator/filmPlan';
import { SPLIT_TELLS, tifoSplit } from '../render/simulator/tifoSplit';
import type { SeatMap } from '../core/types';
import type { DesignStore } from '../core/design';
import { containDialog } from './dialogFocus';
import { getLang, t, tv } from './i18n';
import { matchDayDeps } from './matchDayDeps';
import { CROWN_SVG, proChipHtml } from './pro';

export type FilmShape = 'landscape' | 'vertical';
export const FILM_SIZES: Record<FilmShape, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
};

export interface FilmJob {
  shape: FilmShape;
  reveal: FilmRevealSource;
  /** "tifomaker.org" in the corner. */
  mark: boolean;
  creditLine?: string;
  /** The file's name, without its extension. */
  name: string;
}

/** What became of a film: saved (with what it is), cancelled, or failed. */
export type FilmOutcome =
  | { kind: 'saved'; message: string; file: File; result: FilmResult }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string };

const nf = new Intl.NumberFormat('en');

// ---------------------------------------------------------------- the card ---

interface ProgressCard {
  signal: AbortSignal;
  /** `done` 0..1; with the frame numbers when the film counts its frames. */
  set(done: number, frame?: number, total?: number): void;
  /** The film is being made in real time: say what that means. */
  realtime(): void;
  /** This browser cannot encode the sound: say the film will be silent. */
  silent(): void;
  close(): void;
}

function progressCard(shape: FilmShape): ProgressCard {
  const size = FILM_SIZES[shape];
  const abort = new AbortController();
  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop qv-backdrop';
  root.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
  root.innerHTML =
    `<div class="pro-sheet qv-card" role="dialog" aria-modal="true" aria-labelledby="qv-title">` +
    `<div class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</div>` +
    `<h2 id="qv-title"></h2><p class="qv-sub"></p>` +
    `<progress class="qv-bar" max="1000" value="0"></progress>` +
    `<p class="qv-count" role="status" aria-live="polite"></p>` +
    `<p class="qv-note"></p><p class="qv-note qv-silent" hidden></p>` +
    `<div class="pro-actions"><button type="button" class="pro-alt qv-cancel"></button></div></div>`;
  const $ = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  $('#qv-title').textContent = t('qv.making');
  $('.qv-sub').textContent = tv(shape === 'vertical' ? 'qv.sub.vertical' : 'qv.sub.landscape', { w: size.width, h: size.height, s: FILM_TIMES.seconds });
  const bar = $<HTMLProgressElement>('.qv-bar');
  bar.setAttribute('aria-label', t('qv.making'));
  const count = $('.qv-count');
  count.textContent = t('qv.preparing');
  const note = $('.qv-note');
  note.textContent = t('qv.steady');
  const cancel = $<HTMLButtonElement>('.qv-cancel');
  cancel.textContent = t('qv.cancel');
  cancel.addEventListener('click', () => abort.abort());
  document.body.appendChild(root);
  // Escape cancels like the button; a click outside does nothing (a film is not dismissed by accident).
  const release = containDialog(root, () => abort.abort());
  cancel.focus();
  let lastFrame = -1;
  let leftShown = false;
  /** How long a frame takes here, smoothed: what the time left is worked out from. */
  let perFrame = 0;
  let lastAt = 0;
  return {
    signal: abort.signal,
    set(done, frame, total) {
      bar.value = Math.round(Math.max(0, Math.min(1, done)) * 1000);
      if (frame === undefined || total === undefined) {
        count.textContent = `${Math.round(done * 100)}%`;
        return;
      }
      const now = performance.now();
      if (lastAt) perFrame = perFrame ? perFrame * 0.85 + (now - lastAt) * 0.15 : now - lastAt;
      lastAt = now;
      // The words once a second's worth of frames, not every frame (a screen
      // reader reads each change), and as soon as there is a rate to go on.
      if (frame === total || frame - lastFrame >= 30 || lastFrame < 0 || (frame >= 4 && !leftShown)) {
        lastFrame = frame;
        const words = tv('qv.frame', { n: nf.format(frame), total: nf.format(total) });
        const left = frame >= 4 && frame < total ? timeLeft((total - frame) * perFrame) : '';
        if (left) leftShown = true;
        count.textContent = left ? `${words} · ${left}` : words;
      }
    },
    realtime() {
      note.textContent = t('qv.realtime');
    },
    silent() {
      const p = $('.qv-silent');
      p.textContent = t('qv.silent');
      p.hidden = false;
    },
    close() {
      if (!root.isConnected) return;
      release();
      root.remove();
    },
  };
}

/** How much of the design falls in a gap in its stand (tifoSplit.ts): a few passes over the seats, cheap enough per change. */
export function splitOf(map: SeatMap, store: DesignStore): number {
  return tifoSplit(map.uv, map.count, (i) => store.cells[i] !== 0);
}

/**
 * "About 25 seconds left", "About 3 minutes left": rounded to what a person
 * waiting cares about. Empty until there is a rate to go on.
 */
function timeLeft(ms: number): string {
  if (!(ms > 0) || !Number.isFinite(ms)) return '';
  const s = ms / 1000;
  if (s < 60) return tv('qv.left.s', { n: Math.max(5, Math.ceil(s / 5) * 5) });
  const m = Math.round(s / 60);
  return m <= 1 ? t('qv.left.m1') : tv('qv.left.m', { n: m });
}

/** Download a finished file. */
function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Make the film on `host`, with the card up, then download it and, on a
 * phone, offer the share sheet. Never throws: the outcome says what happened.
 */
async function film(host: () => Promise<FilmHost>, job: FilmJob, card: ProgressCard): Promise<FilmOutcome> {
  try {
    const [{ makeFilm, filmCodec }, { filmSoundCodec }, h] = await Promise.all([import('../render/simulator/film'), import('../render/simulator/filmSound'), host()]);
    const size = FILM_SIZES[job.shape];
    const encoded = !!(await filmCodec(size.width, size.height, 30));
    if (!encoded) card.realtime();
    if (!encoded || !(await filmSoundCodec())) card.silent();
    const result = await makeFilm(h, {
      width: size.width,
      height: size.height,
      reveal: job.reveal,
      mark: job.mark,
      creditLine: job.creditLine,
      signal: card.signal,
      frameLimit: testFrameLimit(),
      onProgress: (done, frame, total) => card.set(done, frame, total),
    });
    if (!result.blob) throw new Error('no file');
    const file = new File([result.blob], `${job.name}.${result.extension}`, { type: result.mimeType });
    download(file);
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const saved = result.realtime
      ? tv('qv.savedRealtime', { w: result.width, h: result.height, mb })
      : tv('qv.saved', { w: result.width, h: result.height, s: nf.format(Math.round((result.frames / result.fps) * 10) / 10), mb });
    const message = result.sound ? saved : `${saved} ${t('qv.silent')}`;
    void import('./postMoment').then(({ offerFileShare }) => offerFileShare(file, t('post.shareVideo'))).catch(() => {});
    return { kind: 'saved', message, file, result };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return { kind: 'cancelled', message: t('qv.cancelled') };
    console.warn('[tifo] the Pro film failed', e);
    return { kind: 'failed', message: t('qv.failed') };
  } finally {
    card.close();
  }
}

/**
 * The browser suites make a film of its first few frames only (a whole one
 * takes most of an hour in software GL). Only on a page opened with ?e2e,
 * where main.ts sets window.__tifo.
 */
function testFrameLimit(): number | undefined {
  const w = window as unknown as { __tifo?: unknown; __tifoFilmFrames?: number };
  return w.__tifo && typeof w.__tifoFilmFrames === 'number' ? w.__tifoFilmFrames : undefined;
}

// ------------------------------------------------------------ from Match Day ---

/** The film, from Match Day's own Record: the live simulator, as the fan has set it up. */
export function filmFromMatchDay(sim: MatchDaySimulator, job: FilmJob): Promise<FilmOutcome> {
  return film(async () => sim.filmHost(), job, progressCard(job.shape));
}

// -------------------------------------------------------------- from the editor ---

/**
 * A Match Day built off screen from the editor's design, lit as Match Day
 * opens (dusk, floodlights on, a full house, a wet pitch), for `run`, and
 * freed after. The editor's own 3D view is paused meanwhile: two scenes
 * drawing at once on a phone is one too many.
 */
/** Off-screen Match Days now drawing: the editor's view starts again only when the last is done. */
let offscreen = 0;

export async function offscreenMatchDay<T>(run: (sim: MatchDaySimulator) => Promise<T>): Promise<T> {
  const deps = matchDayDeps();
  if (!deps) throw new Error('no editor');
  const [{ MatchDaySimulator }, { probeQuality }] = await Promise.all([import('../render/simulator/index'), import('../render/simulator/quality')]);
  const hostEl = document.createElement('div');
  hostEl.className = 'qv-offscreen';
  hostEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(hostEl);
  if (offscreen++ === 0) deps.pausePreview();
  let sim: MatchDaySimulator | null = null;
  try {
    // A film is drawn once, not live: the device's own tier, but never below
    // Medium (Low has no fog and no image lighting, and looks it).
    const probed = probeQuality();
    sim = new MatchDaySimulator(hostEl, deps.map, deps.store, deps.template, deps.assetStore, {
      quality: probed === 'low' ? 'medium' : probed,
      bannerStore: deps.bannerStore,
    });
    sim.setCrowdPreset('sellout');
    sim.setFloodlightLevel(1);
    sim.setFloodlights(true);
    sim.setTimeOfDay('dusk');
    sim.setWeather('clear');
    sim.setWetPitch(true);
    sim.setGlow(false);
    return await run(sim);
  } finally {
    sim?.dispose();
    hostEl.remove();
    if (--offscreen === 0) deps.resumePreview();
  }
}

/** The film, from the editor's export panel. */
export async function filmFromEditor(job: FilmJob): Promise<FilmOutcome> {
  const card = progressCard(job.shape);
  try {
    return await offscreenMatchDay((sim) => film(async () => sim.filmHost(), job, card));
  } catch (e) {
    // Match Day could not be built here (no WebGL, or the context was refused).
    console.warn('[tifo] no Match Day for the Pro film', e);
    card.close();
    return { kind: 'failed', message: t('qv.failed') };
  }
}

/**
 * The film, played into `canvas` as it is drawn (the editor's Preview of a
 * Pro size): at half its size, which is quick to draw and all a preview
 * shows, kept to the film's own pace where the device draws faster than
 * that. It stops, and frees its Match Day, once the canvas leaves the page.
 */
export async function previewFilm(canvas: HTMLCanvasElement, job: Omit<FilmJob, 'creditLine'>): Promise<void> {
  const size = FILM_SIZES[job.shape];
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d')!;
  const abort = new AbortController();
  // Closed while Match Day is still being built: stop at the first chance, not at the first frame.
  const watch = window.setInterval(() => {
    if (!canvas.isConnected) abort.abort();
  }, 250);
  await offscreenMatchDay(async (sim) => {
    const { makeFilm } = await import('../render/simulator/film');
    let t0 = -1;
    await makeFilm(sim.filmHost(), {
      width: size.width / 2,
      height: size.height / 2,
      reveal: job.reveal,
      mark: job.mark,
      encode: false,
      signal: abort.signal,
      frameLimit: testFrameLimit(),
      onFrame: async (_n, t, picture) => {
        if (!canvas.isConnected) {
          abort.abort();
          return;
        }
        if (t0 < 0) t0 = performance.now() - t * 1000;
        const early = t0 + t * 1000 - performance.now();
        if (early > 0) await new Promise((r) => setTimeout(r, early));
        g.drawImage(picture, 0, 0, size.width, size.height);
      },
    }).catch((e: Error) => {
      if (e?.name !== 'AbortError') throw e;
    });
  }).finally(() => window.clearInterval(watch));
}

// ------------------------------------------------- Match Day's Record choice ---

export interface MatchDayFilmChoice {
  /** The film Record makes, or null for the recording of the view it always made. */
  shape(): FilmShape | null;
  /** The film's name on the export sheet. */
  item(): string;
  /** Pro off for this account (a sign-out): the choice goes, and Record is what it always was. */
  setLive(live: boolean, running: boolean): void;
}

/**
 * What Record makes, at the top of Match Day's Recording section, for an
 * account Pro is on for: Match Day's film (landscape or vertical), or the
 * recording of the view as the fields below set it. While a film is picked
 * those fields are hidden: the film has its own length, rate and camera.
 */
export function mountMatchDayFilmChoice(section: HTMLElement, recordingFields: HTMLElement[], design?: { map: SeatMap; store: DesignStore }): MatchDayFilmChoice {
  const field = document.createElement('div');
  field.className = 'mds-field mds-pro qv-md-field';
  const label = document.createElement('div');
  label.className = 'mds-flabel qv-md-label';
  label.textContent = t('qv.md.video');
  const chip = document.createElement('span');
  label.append(' ', chip);
  const sel = document.createElement('select');
  sel.className = 'mds-sel';
  sel.dataset.k = 'rec-film';
  for (const [v, k] of [['landscape', 'qv.md.landscape'], ['vertical', 'qv.md.vertical'], ['screen', 'qv.md.screen']] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t(k);
    sel.append(o);
  }
  const note = document.createElement('p');
  note.className = 'qv-md-note';
  note.textContent = t('qv.md.note');
  // Said before filming: part of the tifo is where the stand has no seats.
  const split = document.createElement('p');
  split.className = 'qv-md-note qv-md-split';
  split.textContent = t('qv.split');
  field.append(label, sel, note, split);
  section.prepend(field);
  const sync = (): void => {
    const film = !field.hidden && sel.value !== 'screen';
    for (const f of recordingFields) f.hidden = film;
    note.hidden = !film;
    split.hidden = !film || !design || splitOf(design.map, design.store) < SPLIT_TELLS;
  };
  sel.addEventListener('change', sync);
  return {
    shape: () => (!field.hidden && sel.value !== 'screen' ? (sel.value as FilmShape) : null),
    item: () => t(sel.value === 'vertical' ? 'pexp.item.vertical' : 'pexp.item.hd'),
    setLive(live, running) {
      field.hidden = !live;
      // The crown where the film is picked, quiet while Pro runs.
      chip.innerHTML = proChipHtml({ quiet: running, icon: true });
      sync();
    },
  };
}
