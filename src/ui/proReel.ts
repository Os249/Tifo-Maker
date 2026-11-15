/**
 * The Reel sheet: the tifo's reveal, cut for TikTok, Reels and Shorts
 * (simulator/reel.ts), set up and watched before it is made.
 *
 * Beside the preview: a line of the fan's own for the start, 15 or 30
 * seconds, and the closing frame's title and line. The preview is the Reel
 * itself, drawn by the film maker at half its size in a Match Day built off
 * screen (ui/proFilm.ts offscreenMatchDay): it plays through once, then
 * typing a word shows the frame that word is on at once (the build-up for the
 * opening line, the closing frame for its title), with no wait for a replay.
 * What the apps cover with their own buttons can be shaded over it; that
 * shade is never in the file.
 *
 * Free to try. The download is a Pro item and asks once (proGate.ts), with
 * the tifo shown both ways; "Export without Pro items" is today's free
 * stadium video (`free`). The file is made after this sheet has closed, by
 * the same film card as the Full HD film (filmFromEditor).
 *
 * Loaded when the sheet first opens; its words come with it.
 */
import './proPoster.css';
import './proReel.css';
import { escapeHtml } from '../core/escape';
import { TIFO_FONTS, fontCssOf } from '../core/text';
import { loadTifoFonts } from '../core/tifoFonts';
import type { FilmHost, FilmRevealSource } from '../render/simulator/film';
import type { ReelCut } from '../render/simulator/reel';
import { SPLIT_TELLS, tifoSplit } from '../render/simulator/tifoSplit';
import { containDialog } from './dialogFocus';
import { getLang, t, tv } from './i18n';
import { matchDayDeps } from './matchDayDeps';
import { CROWN_SVG } from './pro';
import { exportGate } from './proGate';
import { FILM_SIZES, offscreenMatchDay } from './proFilm';

export interface ReelSheetDeps {
  /** The project's name: the file's, and the closing frame's title to start with. */
  title(): string;
  /** How the cards go up: the reveal picked in the Animation panel. */
  reveal(): FilmRevealSource;
  /** Without the tifomaker.org mark (a member's default, ui/proMark.ts). */
  clean(): boolean;
  creditLine?: string;
  /** Two phases (ui/proPhases.ts): the first phase's look, or null. */
  phases?(): import('../render/simulator/phases').PhaseLook | null;
  /** The Pro items the design carries besides the Reel (proGate.designProItems). */
  designItems(): string[];
  /** "Export without Pro items": today's free stadium video, after the sheet has closed. */
  free(): Promise<void>;
  /** Today's free stadium picture, for the export sheet's "both ways". */
  freeStill?(): Promise<HTMLCanvasElement | null>;
  /** Put a line in the export panel's status. */
  say(msg: string): void;
}

interface Fields {
  hook: string;
  seconds: 15 | 30;
  endTitle: string;
  endLine: string;
  guide: boolean;
}

/** Kept for the visit: whoever set a Reel up once wants it as they left it. */
let keptFields: Partial<Fields> = {};

const FPS = 30;
/** The frame the opening line is fully on, and (from the end) the closing frame's. */
const HOOK_AT = 1.6;

type Mode = 'play' | 'hook' | 'end';

export async function openReelSheet(deps: ReelSheetDeps): Promise<void> {
  const md = matchDayDeps();
  if (!md) return;
  const lang: 'en' | 'ar' = getLang() === 'ar' ? 'ar' : 'en';
  const today = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const f: Fields = { hook: '', seconds: 15, endTitle: deps.title(), endLine: today, guide: true, ...keptFields };
  const font = fontCssOf('condensed', TIFO_FONTS);
  const size = FILM_SIZES.vertical;

  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop qv-poster-backdrop';
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const field = (key: 'hook' | 'endTitle' | 'endLine', max: number, ph = ''): string =>
    `<label class="qv-field qv-reel-wide"><span>${escapeHtml(t(`reel.${key}`))}</span>` +
    `<input type="text" name="reel-${key}" maxlength="${max}" dir="auto" value="${escapeHtml(f[key])}"${ph ? ` placeholder="${escapeHtml(ph)}"` : ''} /></label>`;
  root.innerHTML =
    `<div class="pro-sheet qv-poster qv-reel" role="dialog" aria-modal="true" aria-labelledby="qv-r-title">` +
    `<button type="button" class="pro-sheet-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>` +
    `<div class="qv-poster-head"><span class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</span>` +
    `<div><h2 id="qv-r-title">${escapeHtml(t('reel.title'))}</h2><p class="qv-lead"></p></div></div>` +
    `<div class="qv-poster-body">` +
    `<div class="qv-reel-stage">` +
    `<div class="qv-preview"><canvas role="img" data-shape="portrait" aria-label="${escapeHtml(t('reel.preview'))}"></canvas><p class="qv-wait" role="status" aria-live="polite"></p></div>` +
    `<div class="qv-reel-bar"><button type="button" class="pro-alt qv-reel-play"><i class="ti ti-player-play" aria-hidden="true"></i> <span></span></button>` +
    `<label class="qv-reel-guide"><input type="checkbox" name="reel-guide"${f.guide ? ' checked' : ''} /> <span>${escapeHtml(t('reel.guide'))}</span></label></div>` +
    `</div>` +
    `<div class="qv-form">` +
    (tifoSplit(md.map.uv, md.map.count, (i) => md.store.cells[i] !== 0) >= SPLIT_TELLS ? `<p class="qv-p-split">${escapeHtml(t('qv.p.split'))}</p>` : '') +
    field('hook', 70, t('reel.hookPh')) +
    `<div class="qv-row"><span class="qv-label">${escapeHtml(t('reel.length'))}</span>` +
    `<div class="qv-seg" role="radiogroup" aria-label="${escapeHtml(t('reel.length'))}">` +
    ([15, 30] as const).map((s) => `<label class="qv-seg-item"><input type="radio" name="reel-seconds" value="${s}"${s === f.seconds ? ' checked' : ''} /><span>${escapeHtml(t(`reel.s${s}`))}</span></label>`).join('') +
    `</div><p class="qv-reel-note" data-note="length"></p></div>` +
    field('endTitle', 40) +
    field('endLine', 50) +
    `<p class="qv-reel-note" data-note="guide">${escapeHtml(t('reel.guideNote'))}</p>` +
    `<div class="pro-actions"><button type="button" class="pro-btn qv-download">${CROWN_SVG}<span>${escapeHtml(t('reel.download'))}</span></button></div>` +
    `<p class="qv-status" role="status" aria-live="polite"></p>` +
    `</div></div></div>`;
  const $ = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  const canvas = $<HTMLCanvasElement>('.qv-preview canvas');
  const wait = $('.qv-wait');
  const status = $('.qv-status');
  const lead = $('.qv-lead');
  const play = $<HTMLButtonElement>('.qv-reel-play');
  const download = $<HTMLButtonElement>('.qv-download');
  const lengthNote = $('[data-note="length"]');
  const guideNote = $('[data-note="guide"]');
  document.body.appendChild(root);

  // The preview: half the Reel's size, which is quick to draw and all the sheet shows.
  const pw = size.width / 2;
  const ph = size.height / 2;
  canvas.width = pw;
  canvas.height = ph;
  const g = canvas.getContext('2d')!;

  let closed = false;
  let close: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    close = (): void => {
      if (closed) return;
      closed = true;
      stop?.abort();
      release();
      root.remove();
      resolve();
    };
  });
  const release = containDialog(root, () => close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('.pro-sheet-close').addEventListener('click', () => close());

  const reel = (): ReelCut => ({
    seconds: f.seconds,
    hook: f.hook.trim() || undefined,
    end: f.endTitle.trim() || f.endLine.trim() ? { title: f.endTitle.trim(), line: f.endLine.trim() || undefined } : undefined,
    font,
  });
  const paintWords = (): void => {
    lead.textContent = tv('reel.lead', { w: size.width, h: size.height, s: f.seconds });
    lengthNote.textContent = f.seconds === 30 ? t('reel.cuts30') : '';
    lengthNote.hidden = f.seconds !== 30;
    guideNote.hidden = !f.guide;
    (play.querySelector('span') as HTMLElement).textContent = t(mode === 'play' && playing ? 'reel.playing' : played ? 'reel.again' : 'reel.play');
    play.disabled = mode === 'play' && playing;
  };

  // ---- the preview's engine: one thing drawn at a time, the newest asked for wins ----
  let host: FilmHost | null = null;
  let stop: AbortController | null = null;
  let chain: Promise<void> = Promise.resolve();
  let mode: Mode = 'play';
  let playing = false;
  let played = false;
  /** The frame as the film maker drew it, kept so the guide can be shown or hidden without drawing again. */
  const last = document.createElement('canvas');
  last.width = pw;
  last.height = ph;
  const present = async (): Promise<void> => {
    g.drawImage(last, 0, 0);
    if (f.guide) {
      const { drawReelGuide } = await import('../render/simulator/reel');
      drawReelGuide(g, pw, ph);
    }
    canvas.dataset.ready = '1';
    wait.textContent = '';
  };
  const show = (next: Mode): void => {
    mode = next;
    stop?.abort();
    const ac = new AbortController();
    stop = ac;
    chain = chain.then(async () => {
      if (closed || ac.signal.aborted || !host) return;
      const { makeFilm } = await import('../render/simulator/film');
      const cut = reel();
      const total = Math.round(cut.seconds * FPS);
      const still = next === 'hook' ? [Math.round(HOOK_AT * FPS)] : next === 'end' ? [total - 1] : undefined;
      let t0 = -1;
      if (next === 'play') {
        playing = true;
        paintWords();
      }
      try {
        await makeFilm(host, {
          width: pw,
          height: ph,
          fps: FPS,
          reveal: deps.reveal(),
          mark: !deps.clean(),
          creditLine: deps.creditLine,
          reel: cut,
          phases: deps.phases?.() ?? undefined,
          encode: false,
          sound: false,
          signal: ac.signal,
          only: still,
          frameLimit: testFrames(),
          onFrame: async (_n, at, picture) => {
            if (ac.signal.aborted) return;
            if (!still) {
              // Kept to the Reel's own pace where the device draws faster than that.
              if (t0 < 0) t0 = performance.now() - at * 1000;
              const early = t0 + at * 1000 - performance.now();
              if (early > 0) await new Promise((r) => setTimeout(r, early));
              if (ac.signal.aborted) return;
            }
            last.getContext('2d')!.drawImage(picture, 0, 0, pw, ph);
            await present();
          },
        });
        if (next === 'play' && !ac.signal.aborted) played = true;
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') {
          console.warn('[tifo] the Reel preview failed', e);
          wait.textContent = t('qv.failed');
        }
      } finally {
        if (next === 'play') {
          playing = false;
          paintWords();
        }
      }
    });
  };

  // ---- the fields ----
  let typing = 0;
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const name = el.name?.replace(/^reel-/, '');
    if (name === 'guide') {
      f.guide = el.checked;
      keptFields = { ...f };
      paintWords();
      void present();
      return;
    }
    if (name === 'seconds') {
      f.seconds = el.value === '30' ? 30 : 15;
      keptFields = { ...f };
      paintWords();
      // A new length is a new cut: watch it.
      show('play');
      return;
    }
    if (name !== 'hook' && name !== 'endTitle' && name !== 'endLine') return;
    f[name] = el.value;
    keptFields = { ...f };
    window.clearTimeout(typing);
    // The frame those words are on, at once.
    typing = window.setTimeout(() => show(name === 'hook' ? 'hook' : 'end'), 140);
  });
  play.addEventListener('click', () => show('play'));

  // ---- the download ----
  download.addEventListener('click', async () => {
    if (download.disabled) return;
    download.disabled = true;
    status.textContent = '';
    try {
      const picture = document.createElement('canvas');
      picture.width = pw;
      picture.height = ph;
      picture.getContext('2d')!.drawImage(last, 0, 0);
      const how = await exportGate([t('reel.item'), ...deps.designItems()], {
        free: async () => (deps.freeStill ? deps.freeStill() : null),
        pro: async () => (canvas.dataset.ready ? picture : null),
      });
      if (how === null) return;
      const cut = reel();
      close();
      // The preview's Match Day is given back before the file's is built: one at a time.
      await ended;
      if (how === 'free') {
        await deps.free();
        return;
      }
      const { filmFromEditor } = await import('./proFilm');
      const outcome = await filmFromEditor({
        shape: 'vertical',
        reveal: deps.reveal(),
        mark: !deps.clean(),
        creditLine: deps.creditLine,
        name: `${deps.title()}-reel`,
        reel: cut,
        phases: deps.phases?.() ?? undefined,
      });
      deps.say(outcome.message);
    } catch {
      status.textContent = t('qv.failed');
    } finally {
      download.disabled = false;
    }
  });

  paintWords();
  wait.textContent = t('qv.p.drawingPreview');
  await loadTifoFonts();
  let endedNow: () => void = () => {};
  const ended = new Promise<void>((r) => { endedNow = r; });
  if (closed) {
    endedNow();
    return;
  }
  try {
    await offscreenMatchDay(async (sim) => {
      host = sim.filmHost();
      show('play');
      await done;
      // Whatever is being drawn stops at its next frame, then Match Day is freed.
      await chain.catch(() => {});
      host = null;
    });
  } catch {
    wait.textContent = t('qv.failed');
    await done;
  } finally {
    endedNow();
  }
}

/** The browser suites play a Reel's first frames only (software GL); only on a page opened with ?e2e. */
function testFrames(): number | undefined {
  const w = window as unknown as { __tifo?: unknown; __tifoFilmFrames?: number };
  return w.__tifo && typeof w.__tifoFilmFrames === 'number' ? w.__tifoFilmFrames : undefined;
}
