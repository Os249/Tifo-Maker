/**
 * The stadium export's Pro options, and the mark on every export that has
 * one. Mounted by proTools.ts, so only for an account /api/pro says Pro is on
 * for, and the editor's start carries none of its code or words.
 *
 *  - Size, beside Format: the screen's size (free, what it always was), Full
 *    HD 1920 × 1080, or vertical 9:16 1080 × 1920 for TikTok, Reels,
 *    Snapchat and WhatsApp Status. A Pro size is not the editor's model on
 *    its plate: it is Match Day's film of the tifo (ui/proFilm.ts), drawn
 *    off screen frame by frame and encoded to H.264, and the Preview plays
 *    that film. A device that cannot draw the size gets the screen's size,
 *    and the note under the picker says so.
 *  - "Match-day poster (4K)": the poster sheet (ui/proPoster.ts), a
 *    designed poster over Match Day's picture of the tifo, landscape
 *    3840 × 2160 or portrait 2160 × 3840, with a live preview.
 *  - The Post it sheet's own "Without the tifomaker.org mark" (PostPro in
 *    ui/postMoment.ts): the stadium video and GIF already have theirs.
 *
 * toolbar.ts reads the size and its Pro item through ctx.stadium when Preview
 * or Export is pressed, and asks about every Pro item an export carries in
 * one question (proGate.ts). Free to try: the Preview plays at the Pro size,
 * the Post it picture follows the tick. What leaves the site asks first, and
 * "Export without Pro items" is today's free export: the mark, the screen's
 * size, the design's Pro items lifted. Like the rest of Pro in the interface,
 * this shows and asks; it decides nothing that costs money.
 */
import './proExport.css';
import { escapeHtml } from '../core/escape';
import { fetchPro, type ProState } from '../net/api';
import { drawWatermark } from '../export/stadiumExport';
import { currentCredit, drawCreditLine, type Credit } from './creditLine';
import type { RevealId } from '../core/reveal';
import type { Preview3D } from '../render/preview3d';
import { getLang, onLangChange, t, tv } from './i18n';
import { CROWN_SVG, proChipHtml } from './pro';
import { designProItems, withoutDesignProItems } from './proGate';
import { cleanByDefault, rememberClean } from './proMark';
import { cameraCheck } from './proRead';
import { mountPhaseControl, phaseChoice } from './proPhases';
import type { ProToolsContext } from './proTools';
import { matchDayDeps } from './matchDayDeps';
import { SPLIT_TELLS, tifoSplit } from '../render/simulator/tifoSplit';
import { focusPicker, type FocusPicker } from './tifoFocus';

type Size = { width: number; height: number };

/** The Pro video sizes, by the picker's value. */
export const VIDEO_SIZES: Record<'hd' | 'vertical', Size> = {
  hd: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
};
/** The poster: 4K UHD, landscape (portrait with the vertical size). */
export const POSTER: Size = { width: 3840, height: 2160 };

const MARK = 'tifomaker.org';


/** Two frames, for the seats to follow lifted layers or a status line to paint (no more: a hidden tab has none). */
const settle = (): Promise<void> =>
  Promise.race([
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    new Promise<void>((r) => setTimeout(r, 250)),
  ]);

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function pngOf(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}

/**
 * A still of the stadium as the view shows it now: at `size` (drawn
 * off-screen at that size), or at the screen's size when `size` is null.
 * A device that cannot draw `size` gets the largest of its shape it can, and
 * failing that the screen's size: `asked` says which it was.
 */
export function stadiumStill(preview: Preview3D, size: Size | null, mark: boolean, credit?: Credit): { canvas: HTMLCanvasElement; asked: boolean; max: number } {
  const max = preview.maxDrawSize();
  let at = null as ReturnType<Preview3D['drawAt']>;
  let asked = false;
  if (size) {
    at = preview.drawAt(size.width, size.height);
    asked = !!at;
    if (!at) {
      const k = Math.min(1, max / Math.max(size.width, size.height));
      const w = Math.floor(size.width * k);
      const h = Math.floor(size.height * k);
      if (w >= 2 && h >= 2) at = preview.drawAt(w, h);
    }
  }
  try {
    preview.renderOnce();
    const src = preview.canvas;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const g = out.getContext('2d')!;
    g.drawImage(src, 0, 0);
    if (mark) drawWatermark(g, out.width, out.height, MARK);
    if (credit?.text) drawCreditLine(g, out.width, out.height, credit.text, { avoid: mark ? 'right' : null, accent: credit.accent });
    return { canvas: out, asked, max };
  } finally {
    at?.end();
  }
}

export function mountProExport(ctx: ProToolsContext): void {
  const format = document.getElementById('sx-format') as HTMLSelectElement | null;
  const formatRow = format?.closest('.group');
  const exportRow = document.getElementById('sx-export')?.closest('.group');
  if (!format || !formatRow || !exportRow || document.getElementById('sx-size')) return;

  // ---- the size, beside Format ----
  const row = document.createElement('div');
  row.className = 'group pexp-size-row';
  row.id = 'sx-size-row';
  row.innerHTML =
    `<label for="sx-size"></label>` +
    `<select id="sx-size" class="grow0">` +
    `<option value="screen"></option>` +
    `<optgroup><option value="hd"></option><option value="vertical"></option></optgroup>` +
    `</select><span class="pexp-crown"></span>`;
  const select = row.querySelector('select') as HTMLSelectElement;
  const crown = row.querySelector('.pexp-crown') as HTMLElement;
  const note = document.createElement('p');
  note.className = 'pexp-note';
  note.id = 'sx-size-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.hidden = true;
  formatRow.after(row, note);

  // ---- the 4K poster, under Preview and Export ----
  const poster = document.createElement('button');
  poster.type = 'button';
  poster.id = 'sx-poster';
  poster.className = 'pro-btn pexp-poster';
  poster.innerHTML = `${CROWN_SVG}<span></span>`;
  // ---- the Reel, under the poster ----
  const reelBtn = document.createElement('button');
  reelBtn.type = 'button';
  reelBtn.id = 'sx-reel';
  reelBtn.className = 'pro-btn pexp-poster pexp-reel';
  reelBtn.innerHTML = `${CROWN_SVG}<span></span>`;
  // ---- the designer pack, under the Reel ----
  const packBtn = document.createElement('button');
  packBtn.type = 'button';
  packBtn.id = 'sx-pack';
  packBtn.className = 'pro-btn pexp-poster pexp-pack';
  packBtn.innerHTML = `${CROWN_SVG}<span></span>`;
  exportRow.after(poster, reelBtn, packBtn);

  const status = (msg: string): void => {
    const el = document.getElementById('sx-status');
    if (el) el.textContent = msg;
  };

  let live = false;
  let running = false;
  /** Painted again whenever /api/pro's answer changes: the proposal sheet's button, further down. */
  let afterShow: () => void = () => {};
  /** The longest side this device could draw when a Pro size was refused, or 0. */
  let refused = 0;
  let told = false;

  const proSize = (): Size | null => VIDEO_SIZES[select.value as keyof typeof VIDEO_SIZES] ?? null;
  /** The poster's size: portrait when the vertical size is chosen for the video. */
  const posterSize = (): Size =>
    select.value === 'vertical' && format.value !== 'gif' ? { width: POSTER.height, height: POSTER.width } : { ...POSTER };
  const paintNote = (): void => {
    const size = proSize();
    let text = '';
    if (size && refused) text = tv('pexp.tooBig', { max: refused });
    else if (select.value === 'hd') text = t('pexp.hdNote');
    else if (select.value === 'vertical') text = t('pexp.verticalNote');
    // Before filming: part of the tifo is where its stand has no seats (simulator/tifoSplit.ts).
    const deps = size && !refused ? matchDayDeps() : null;
    if (deps && tifoSplit(deps.map.uv, deps.map.count, (i) => deps.store.cells[i] !== 0) >= SPLIT_TELLS) text = `${text} ${t('qv.split')}`.trim();
    note.textContent = text;
    note.hidden = !text || row.hidden;
    paintPart(!!size && !refused && !row.hidden);
  };
  // The part of the tifo a Pro film is on (ui/tifoFocus.ts), under the size while one is picked.
  // Made when first shown, and again when the design has changed since (the picker draws the tifo once).
  let part: FocusPicker | null = null;
  let partOf = '';
  const paintPart = (on: boolean): void => {
    const deps = on ? matchDayDeps() : null;
    if (!deps) {
      part?.root.classList.add('tf-off');
      return;
    }
    let h = 0;
    for (let i = 0; i < deps.store.cells.length; i++) if (deps.store.cells[i]) h = (Math.imul(h, 31) + i * 7 + deps.store.cells[i]) | 0;
    const key = `${deps.template.id}|${h}|${getLang()}`;
    if (!part || partOf !== key) {
      part?.destroy();
      part = focusPicker(deps, () => {});
      part.root.classList.add('pexp-part');
      partOf = key;
      note.after(part.root);
    }
    part.root.classList.remove('tf-off');
  };
  const paint = (): void => {
    (row.querySelector('label') as HTMLElement).textContent = t('pexp.size');
    select.title = t('pexp.sizeT');
    (select.querySelector('optgroup') as HTMLOptGroupElement).label = t('pexp.group');
    (select.querySelector('option[value="screen"]') as HTMLElement).textContent = t('pexp.screen');
    (select.querySelector('option[value="hd"]') as HTMLElement).textContent = t('pexp.hd');
    (select.querySelector('option[value="vertical"]') as HTMLElement).textContent = t('pexp.vertical');
    // The crown where the size is picked, while a Pro one is (quiet while Pro
    // runs). The crown alone, its name spoken: the row is narrow, and the
    // picker keeps the room for the size's name.
    crown.innerHTML = proSize() ? proChipHtml({ quiet: running, icon: true }) : '';
    const ps = posterSize();
    (poster.querySelector('span') as HTMLElement).textContent = t('pexp.poster');
    poster.title = tv('pexp.posterT', { w: ps.width, h: ps.height });
    poster.classList.toggle('quiet', running);
    (reelBtn.querySelector('span') as HTMLElement).textContent = t('pexp.reel');
    reelBtn.title = t('pexp.reelT');
    reelBtn.classList.toggle('quiet', running);
    (packBtn.querySelector('span') as HTMLElement).textContent = t('pexp.pack');
    packBtn.title = t('pexp.packT');
    packBtn.classList.toggle('quiet', running);
    paintNote();
  };
  /** Only while /api/pro says Pro is on for this account: a sign-out takes them away. */
  const show = (st: ProState | null): void => {
    live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    row.hidden = !live || format.value === 'gif';
    poster.hidden = !live;
    phases?.paint();
    reelBtn.hidden = !live;
    packBtn.hidden = !live;
    if (!live) {
      select.value = 'screen';
      refused = 0;
    }
    paint();
    afterShow();
  };
  select.addEventListener('change', () => {
    refused = 0;
    if (proSize() && !told) {
      told = true;
      ctx.say(t('pexp.try'));
    }
    paint();
  });
  // The size is the video's: a GIF keeps its own width.
  format.addEventListener('change', () => {
    row.hidden = !live || format.value === 'gif';
    paint();
  });
  const revealRow = document.getElementById('reveal-preset')?.closest('.group');
  const phases = revealRow ? mountPhaseControl(revealRow, () => ({ live, running }), () => paint()) : null;
  show(null);
  void fetchPro().then(show, () => show(null));
  const refresh = (): void => void fetchPro(true).then(show, () => show(null));
  window.addEventListener('tifo:auth', refresh);
  window.addEventListener('tifo:pro', refresh);
  onLangChange(paint);

  // ---- what toolbar.ts reads at Preview and Export ----
  /** The chosen Pro size, when this device can draw it (said in the note when it cannot). */
  const size = (): Size | null => {
    const want = live && format.value !== 'gif' ? proSize() : null;
    if (!want) return null;
    const p = ctx.getPreview();
    if (p && !p.canDraw(want.width, want.height)) {
      refused = p.maxDrawSize();
      paintNote();
      return null;
    }
    if (refused) {
      refused = 0;
      paintNote();
    }
    return { ...want };
  };
  ctx.stadium = {
    size,
    items: () => {
      const s = size();
      return s ? [t(s.height > s.width ? 'pexp.item.vertical' : 'pexp.item.hd'), ...(phaseChoice() ? [t('phase.item')] : [])] : [];
    },
    // A Pro size is Match Day's film of the tifo, not the editor's model on its plate.
    film: async (s, how) => {
      const { filmFromEditor } = await import('./proFilm');
      const outcome = await filmFromEditor({
        shape: s.height > s.width ? 'vertical' : 'landscape',
        reveal: { kind: 'order', id: how.reveal as RevealId },
        mark: !how.clean,
        creditLine: currentCredit().text || undefined,
        phases: phaseChoice() ?? undefined,
        name: `${ctx.title()}-matchday`,
      });
      return outcome.message;
    },
    // The export sheet's two pictures: the stadium view as it leaves today (the
    // screen's size, the mark, the design's Pro items lifted), and the same
    // tifo as chosen: the film's hold at a Pro size, or the view without the mark.
    bothWays: (clean) => ({
      free: async () => {
        const p = ctx.getPreview();
        if (!p) return null;
        return withoutDesignProItems(ctx.objects, async () => {
          await settle();
          return stadiumStill(p, null, true).canvas;
        });
      },
      pro: async (signal) => {
        const s = size();
        const credit = currentCredit();
        if (!s) {
          const p = ctx.getPreview();
          return p ? stadiumStill(p, null, !clean, credit).canvas : null;
        }
        const [{ offscreenMatchDay }, { filmStill }] = await Promise.all([import('./proFilm'), import('../render/simulator/film')]);
        if (signal.aborted) return null;
        return offscreenMatchDay(async (sim) => {
          if (signal.aborted) return null;
          // Half the film's size (the Preview's own): drawn larger than the sheet's frame, so the crowd is not grain.
          const c = await filmStill(sim.filmHost(), Math.round(s.width / 2), Math.round(s.height / 2));
          const g = c.getContext('2d')!;
          if (!clean) drawWatermark(g, c.width, c.height, MARK);
          if (credit.text) drawCreditLine(g, c.width, c.height, credit.text, { avoid: clean ? null : 'right', accent: credit.accent });
          return c;
        });
      },
    }),
    // Free to try: the Preview plays that film, drawn at half its size.
    previewFilm: async (s, canvas, how) => {
      const { previewFilm } = await import('./proFilm');
      await previewFilm(canvas, {
        shape: s.height > s.width ? 'vertical' : 'landscape',
        reveal: { kind: 'order', id: how.reveal as RevealId },
        mark: !how.clean,
        phases: phaseChoice() ?? undefined,
        name: '',
      });
    },
  };

  // ---- the poster: its own sheet, with a live preview (ui/proPoster.ts) ----
  /** Today's free picture: the stadium view at the screen's size, with the mark, the design's Pro items lifted. */
  const freePicture = async (): Promise<string> => {
    const preview = await ctx.ensurePreview();
    if (!preview) return t('pexp.posterFailed');
    await Promise.race([preview.ready, new Promise((r) => setTimeout(r, 8000))]);
    const shot = await withoutDesignProItems(ctx.objects, async () => {
      await settle();
      return stadiumStill(preview, null, true);
    });
    const blob = await pngOf(shot.canvas);
    if (!blob) return t('pexp.posterFailed');
    download(blob, `${ctx.title()}-stadium.png`);
    return tv('pexp.pictureSaved', { w: shot.canvas.width, h: shot.canvas.height });
  };
  poster.addEventListener('click', async () => {
    if (poster.disabled) return;
    poster.disabled = true;
    try {
      const { openPosterSheet, designTextOf } = await import('./proPoster');
      await openPosterSheet({
        title: () => ctx.title(),
        designText: () => designTextOf(ctx.objects.list()),
        designItems: () => {
          const credit = currentCredit();
          return [...(credit.text && credit.label ? [credit.label] : []), ...designProItems(ctx.objects)];
        },
        creditLine: currentCredit().text || undefined,
        shape: posterSize().height > posterSize().width ? 'portrait' : 'landscape',
        free: freePicture,
        freeStill: async () => {
          const p = ctx.getPreview();
          if (!p) return null;
          return withoutDesignProItems(ctx.objects, async () => {
            await settle();
            return stadiumStill(p, null, true).canvas;
          });
        },
        say: status,
      });
    } catch {
      status(t('pexp.posterFailed'));
    } finally {
      poster.disabled = false;
    }
  });

  // ---- the designer pack: every size, framed by hand (ui/proPack.ts) ----
  packBtn.addEventListener('click', async () => {
    if (packBtn.disabled) return;
    packBtn.disabled = true;
    try {
      const { openPackSheet } = await import('./proPack');
      await openPackSheet({
        title: () => ctx.title(),
        clean: () => cleanByDefault(running),
        creditLine: currentCredit().text || undefined,
        designItems: () => {
          const credit = currentCredit();
          return [...(credit.text && credit.label ? [credit.label] : []), ...designProItems(ctx.objects)];
        },
        free: freePicture,
        freeStill: async () => {
          const p = ctx.getPreview();
          if (!p) return null;
          return withoutDesignProItems(ctx.objects, async () => {
            await settle();
            return stadiumStill(p, null, true).canvas;
          });
        },
        say: status,
      });
    } catch {
      status(t('pack.failed'));
    } finally {
      packBtn.disabled = false;
    }
  });

  // ---- the Reel: its own sheet, with the Reel playing in it (ui/proReel.ts) ----
  reelBtn.addEventListener('click', async () => {
    if (reelBtn.disabled) return;
    reelBtn.disabled = true;
    try {
      const { openReelSheet } = await import('./proReel');
      await openReelSheet({
        title: () => ctx.title(),
        reveal: () => ({ kind: 'order', id: (ctx.revealId?.() ?? 'sweep') as RevealId }),
        clean: () => cleanByDefault(running),
        creditLine: currentCredit().text || undefined,
        phases: () => phaseChoice(),
        designItems: () => {
          const credit = currentCredit();
          return [...(phaseChoice() ? [t('phase.item')] : []), ...(credit.text && credit.label ? [credit.label] : []), ...designProItems(ctx.objects)];
        },
        free: async () => {
          await ctx.freeVideo?.();
        },
        freeStill: async () => {
          const p = ctx.getPreview();
          if (!p) return null;
          return withoutDesignProItems(ctx.objects, async () => {
            await settle();
            return stadiumStill(p, null, true).canvas;
          });
        },
        say: status,
      });
    } catch {
      status(t('qv.failed'));
    } finally {
      reelBtn.disabled = false;
    }
  });

  // ---- the proposal sheet, with the production files (ui/proProposal.ts) ----
  const csv = document.getElementById('export-csv');
  if (csv && !document.getElementById('export-proposal')) {
    const prop = document.createElement('button');
    prop.type = 'button';
    prop.id = 'export-proposal';
    prop.className = csv.className;
    prop.innerHTML = `<i class="ti ti-file-text" aria-hidden="true"></i><span><b></b><small></small></span>`;
    csv.after(prop);
    const paintProp = (): void => {
      (prop.querySelector('b') as HTMLElement).innerHTML = `${escapeHtml(t('prop.btn'))} ${proChipHtml({ quiet: running, icon: true })}`;
      (prop.querySelector('small') as HTMLElement).textContent = t('prop.btnHelp');
      prop.hidden = !live;
    };
    paintProp();
    afterShow = paintProp;
    onLangChange(paintProp);
    prop.addEventListener('click', async () => {
      if (prop.disabled) return;
      prop.disabled = true;
      try {
        const { openProposalSheet } = await import('./proProposal');
        await openProposalSheet({
          title: () => ctx.title(),
          clean: () => cleanByDefault(running),
          designItems: () => designProItems(ctx.objects),
          say: (msg) => ctx.say(msg),
        });
      } catch {
        ctx.say(t('pack.failed'));
      } finally {
        prop.disabled = false;
      }
    });
  }

  // ---- the Post it sheet's mark (ui/postMoment.ts) ----
  // Remembered for the visit, like the stadium's: whoever wants it off once
  // wants it off the next time too.
  // A member's picture goes without the mark unless they asked for it back
  // (ui/proMark.ts): null until they tick or untick it in this visit.
  let postChoice: boolean | null = null;
  const postCleanNow = (): boolean => postChoice ?? cleanByDefault(running);
  let postBox: HTMLInputElement | null = null;
  void import('./postMoment').then(({ setPostPro }) =>
    setPostPro({
      option: (changed) => {
        if (!live) return null;
        const label = document.createElement('label');
        label.className = 'pro-option pexp-post-mark';
        label.innerHTML = `<input type="checkbox" /> <span></span> ${proChipHtml({ quiet: running })}`;
        (label.querySelector('span') as HTMLElement).textContent = t('pro.mark.option');
        const box = label.querySelector('input') as HTMLInputElement;
        box.checked = postCleanNow();
        box.addEventListener('change', () => {
          postChoice = box.checked;
          rememberClean(running, box.checked);
          changed();
        });
        postBox = box;
        return label;
      },
      clean: () => live && postCleanNow(),
      untick: () => {
        postChoice = false;
        if (postBox) postBox.checked = false;
      },
      items: () => (live ? [...(postCleanNow() ? [t('pro.mark.option')] : []), ...designProItems(ctx.objects)] : []),
      withoutDesignItems: (make) => withoutDesignProItems(ctx.objects, make),
      // Read from straight across the tifo, not from wherever the view happens to be.
      read: (shot) => (live ? cameraCheck(() => ctx.getPreview()?.tifoStill(1024, 576) ?? shot, () => ctx.objects.list().filter((o) => o.kind === 'text' && !o.hidden).map((o) => (o as { text?: string }).text ?? ''), running) : null),
    }),
  ).catch(() => {});

  // The browser suite's way in (e2e-pro-export.mjs), only on a page opened
  // with ?e2e (main.ts sets window.__tifo for it at boot).
  if ((window as unknown as { __tifo?: unknown }).__tifo) {
    (window as unknown as { __tifoProExport?: unknown }).__tifoProExport = {
      size,
      items: () => ctx.stadium?.items() ?? [],
      preview: () => ctx.getPreview(),
    };
  }
}
