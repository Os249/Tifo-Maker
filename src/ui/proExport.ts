/**
 * The stadium export's Pro options, and the mark on every export that has
 * one. Mounted by proTools.ts, so only for an account /api/pro says Pro is on
 * for, and the editor's start carries none of its code or words.
 *
 *  - Size, beside Format: the screen's size (free, what it always was), Full
 *    HD 1920 × 1080, or vertical 9:16 1080 × 1920 for TikTok, Reels,
 *    Snapchat and WhatsApp Status. The video is drawn at that size whatever
 *    the window (Preview3D.drawAt); a device that cannot draw it gets the
 *    screen's size, and the note under the picker says so.
 *  - "Poster picture (4K)": a 3840 × 2160 PNG of the tifo in its stadium
 *    from where the camera is now (2160 × 3840 with the vertical size), with
 *    the mark unless "Without the tifomaker.org mark" is ticked.
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
import { fetchPro, type ProState } from '../net/api';
import { drawWatermark } from '../export/stadiumExport';
import type { Preview3D } from '../render/preview3d';
import { onLangChange, t, tv } from './i18n';
import { CROWN_SVG, proChipHtml } from './pro';
import { designProItems, exportGate, withoutDesignProItems } from './proGate';
import type { ProToolsContext } from './proTools';

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
export function stadiumStill(preview: Preview3D, size: Size | null, mark: boolean): { canvas: HTMLCanvasElement; asked: boolean; max: number } {
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
  exportRow.after(poster);

  const status = (msg: string): void => {
    const el = document.getElementById('sx-status');
    if (el) el.textContent = msg;
  };

  let live = false;
  let running = false;
  /** The longest side this device could draw when a Pro size was refused, or 0. */
  let refused = 0;
  let told = false;

  const proSize = (): Size | null => VIDEO_SIZES[select.value as keyof typeof VIDEO_SIZES] ?? null;
  /** The poster's size: portrait when the vertical size is chosen for the video. */
  const posterSize = (): Size =>
    select.value === 'vertical' && format.value !== 'gif' ? { width: POSTER.height, height: POSTER.width } : { ...POSTER };
  const noMark = (): boolean => {
    const box = document.getElementById('sx-nomark') as HTMLInputElement | null;
    return live && !!box?.checked && !box.closest('label')?.hidden;
  };

  const paintNote = (): void => {
    const size = proSize();
    let text = '';
    if (size && refused) text = tv('pexp.tooBig', { max: refused });
    else if (select.value === 'hd') text = t('pexp.hdNote');
    else if (select.value === 'vertical') text = t('pexp.verticalNote');
    note.textContent = text;
    note.hidden = !text || row.hidden;
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
    paintNote();
  };
  /** Only while /api/pro says Pro is on for this account: a sign-out takes them away. */
  const show = (st: ProState | null): void => {
    live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    row.hidden = !live || format.value === 'gif';
    poster.hidden = !live;
    if (!live) {
      select.value = 'screen';
      refused = 0;
    }
    paint();
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
      return s ? [t(s.height > s.width ? 'pexp.item.vertical' : 'pexp.item.hd')] : [];
    },
  };

  // ---- the poster ----
  poster.addEventListener('click', async () => {
    if (poster.disabled) return;
    poster.disabled = true;
    try {
      const preview = await ctx.ensurePreview();
      if (!preview) {
        status(t('pexp.posterFailed'));
        return;
      }
      // A poster of the stadium, not of cards on a pitch: the building first (briefly).
      await Promise.race([preview.ready, new Promise((r) => setTimeout(r, 8000))]);
      const clean = noMark();
      const items = [t('pexp.item.poster'), ...(clean ? [t('pro.mark.option')] : []), ...designProItems(ctx.objects)];
      const how = await exportGate(items);
      if (how === null) return;
      status(t('pexp.posterMaking'));
      await settle();
      // 'pro': 4K, without the mark if ticked. 'free': the screen's size, with
      // the mark, and the design's Pro items lifted while it draws.
      const shot = how === 'pro'
        ? stadiumStill(preview, posterSize(), !clean)
        : await withoutDesignProItems(ctx.objects, async () => {
          await settle();
          return stadiumStill(preview, null, true);
        });
      const blob = await pngOf(shot.canvas);
      if (!blob) throw new Error('no picture');
      const { width: w, height: h } = shot.canvas;
      download(blob, `${ctx.title()}-${how === 'pro' ? 'poster' : 'stadium'}.png`);
      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      if (how === 'pro' && !shot.asked) status(tv('pexp.posterSmaller', { max: shot.max, w, h }));
      else if (how === 'pro') status(tv('pexp.posterSaved', { w, h, mb }));
      else status(tv('pexp.pictureSaved', { w, h }));
    } catch {
      status(t('pexp.posterFailed'));
    } finally {
      poster.disabled = false;
    }
  });

  // ---- the Post it sheet's mark (ui/postMoment.ts) ----
  // Remembered for the visit, like the stadium's: whoever wants it off once
  // wants it off the next time too.
  let postClean = false;
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
        box.checked = postClean;
        box.addEventListener('change', () => {
          postClean = box.checked;
          changed();
        });
        postBox = box;
        return label;
      },
      clean: () => live && postClean,
      untick: () => {
        postClean = false;
        if (postBox) postBox.checked = false;
      },
      items: () => (live ? [...(postClean ? [t('pro.mark.option')] : []), ...designProItems(ctx.objects)] : []),
      withoutDesignItems: (make) => withoutDesignProItems(ctx.objects, make),
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
