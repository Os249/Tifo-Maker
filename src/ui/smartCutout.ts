/**
 * Smart cut-out (Pro): one button in the picture-import bar that swaps the
 * armed picture for the same picture with its background lifted away, and a
 * second press that puts the original back.
 *
 * The bar is the same element on a desktop and inside the phone's sheet
 * (mobileShell.ts borrows #import-bar), so one button serves both.
 *
 * What this module decides: nothing that matters. The server counts the
 * allowance, refuses an account Pro is not on for, checks the picture and
 * hands back a PNG it has checked. This only shows the button where
 * /api/pro says Pro is on, asks before spending the last one, and keeps the
 * two bitmaps from leaking.
 */
import { fetchPro, smartCutout, type CutoutError, type ProState } from '../net/api';
import { track } from '../net/analytics';
import { CROWN_SVG, limitBack, limitTitle } from './pro';
import { t, tv } from './i18n';
import { escapeHtml } from '../core/escape';

export interface CutoutHost {
  /** The import bar the button lives in. */
  bar: HTMLElement;
  /** The picture armed for placing, if any. */
  current: () => ImageBitmap | null;
  /** Put this bitmap in place of the armed one (the caller keeps the old one alive). */
  swap: (bitmap: ImageBitmap) => boolean;
  /** One line in the editor's message bar. */
  say: (msg: string) => void;
}

/** The picture is sent at most this big on its long edge (the server's limit is 2 MB). */
const SEND_EDGE = 1536;
const SEND_BYTES = 1_900_000;
const SEEN_KEY = 'tifo_cutout_seen_v1';

/** The armed picture as a JPEG data URL small enough to send, on white (a JPEG has no transparency). */
function encodeForSend(bmp: ImageBitmap): string | null {
  const k = Math.min(1, SEND_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.9, 0.8, 0.68]) {
    const url = c.toDataURL('image/jpeg', q);
    // base64 is 4/3 of the bytes.
    if (url.length * 0.75 < SEND_BYTES) return url;
  }
  return null;
}

async function decodePng(dataUrl: string): Promise<ImageBitmap> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return createImageBitmap(img);
}

const seen = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};
const markSeen = (): void => {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode: the sheet shows again next time, which is harmless */
  }
};

/**
 * Mount the button. Loaded on the first picture armed (ui/toolbar.ts), so it
 * is told about that one with armed(); every later one it hears itself.
 */
export function mountSmartCutout(host: CutoutHost): { armed: () => void } {
  const field = document.createElement('span');
  field.className = 'tb-field cut-field';
  field.hidden = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pro-btn cut-btn';
  field.appendChild(btn);
  // Right after the file name: it is a thing done TO this picture, before
  // deciding where it goes.
  const name = host.bar.querySelector('#import-name');
  if (name?.nextSibling) host.bar.insertBefore(field, name.nextSibling);
  else host.bar.prepend(field);

  /** The bitmap that is NOT armed right now: the original after a cut, or nothing. */
  let original: ImageBitmap | null = null;
  let cut: ImageBitmap | null = null;
  let busy = false;
  let ctl: AbortController | null = null;

  const paint = (): void => {
    if (busy) {
      btn.disabled = true;
      btn.innerHTML = `<span class="cut-spin" aria-hidden="true"></span><span>${escapeHtml(t('cut.working'))}</span>`;
      return;
    }
    btn.disabled = false;
    if (cut && original) {
      btn.classList.add('undo');
      btn.innerHTML = `<i class="ti ti-arrow-back-up" aria-hidden="true"></i><span>${escapeHtml(t('cut.undo'))}</span>`;
      btn.title = '';
    } else {
      btn.classList.remove('undo');
      btn.innerHTML = `${CROWN_SVG}<span>${escapeHtml(t('cut.btn'))}</span>`;
      btn.title = t('cut.btnT');
    }
  };

  /**
   * Let go of the original after placing, cancelling or a new file. While a
   * cut-out is armed, the original is the one bitmap nobody else holds: the
   * cut-out itself belongs to the placed picture, or the toolbar has already
   * closed it with the import.
   */
  const release = (): void => {
    ctl?.abort();
    ctl = null;
    if (original) {
      try {
        original.close();
      } catch {
        /* older engines: GC will get it */
      }
    }
    original = null;
    cut = null;
    busy = false;
    paint();
  };

  const show = async (): Promise<void> => {
    const st = await fetchPro().catch(() => null);
    field.hidden = !st?.live || !st.allowances?.cutout;
    paint();
  };

  const armed = (): void => {
    release();
    void show();
  };
  document.addEventListener('tifo:import-armed', armed);
  document.addEventListener('tifo:import-done', () => {
    release();
    field.hidden = true;
  });

  const fail = (e: CutoutError, st: ProState | null): void => {
    if (e.reason === 'quota' && e.quota?.kind && e.quota.period && e.quota.resetAt) {
      const al = { kind: e.quota.kind, period: e.quota.period, resetAt: e.quota.resetAt, limit: e.quota.limit };
      if (st && (!e.quota.plan || e.quota.plan === 'free')) {
        track('pro_limit');
        void import('./proSheets').then((m) => m.openProSheet(st, { title: limitTitle(al), lead: `${limitBack(al)} ${t('pro.sheet.whatLead')}` }));
      } else {
        host.say(`${limitTitle(al)}. ${limitBack(al)}`);
      }
      return;
    }
    host.say(
      t(
        e.reason === 'refused' ? 'cut.refused'
          : e.reason === 'busy' ? 'cut.busy'
            : e.reason === 'unavailable' ? 'cut.unavailable'
              : e.reason === 'signin' ? 'cut.signIn'
                : e.reason === 'verify' ? 'gift.verify'
                  : e.status === 413 ? 'cut.tooBig'
                    : 'cut.failed',
      ),
    );
  };

  btn.addEventListener('click', async () => {
    if (busy) return;
    // Second press: the original back, the cut-out let go.
    if (cut && original) {
      if (host.current() === cut && host.swap(original)) {
        try {
          cut.close();
        } catch {
          /* fine */
        }
        cut = null;
        original = null;
        paint();
      }
      return;
    }
    const bmp = host.current();
    if (!bmp) return;
    const st = await fetchPro(true).catch(() => null);
    const al = st?.allowances?.cutout;
    if (!st?.live || !al) {
      field.hidden = true;
      return;
    }
    if (al.remaining <= 0) {
      fail(Object.assign(new Error('quota'), {
        status: 429, reason: 'quota' as const,
        quota: { used: al.used, limit: al.limit, remaining: 0, live: true, kind: al.kind, period: al.period, resetAt: al.resetAt, plan: st.plan },
      }), st);
      return;
    }
    // Asked first the first time (what happens to the picture), and whenever
    // this press would spend the last one.
    if (!seen() || al.remaining === 1) {
      const per = t(`pro.per.${al.period}`);
      const { openConfirmSheet } = await import('./proSheets');
      const ok = await openConfirmSheet({
        title: t('cut.btn'),
        lines: [t('cut.sheetLead'), al.remaining === 1 ? tv('cut.usesLast', { per }) : tv('cut.uses', { n: al.remaining, per })],
        go: t('cut.go'),
        note: t('cut.privacy'),
      });
      if (!ok) return;
      markSeen();
    }
    if (host.current() !== bmp) return; // the picture changed while the sheet was open
    const image = encodeForSend(bmp);
    if (!image) {
      host.say(t('cut.tooBig'));
      return;
    }
    busy = true;
    paint();
    host.say(t('cut.working'));
    ctl = new AbortController();
    const mine = ctl;
    try {
      const res = await smartCutout(image, mine.signal);
      const out = await decodePng(res.image);
      // Placed, cancelled or replaced while it ran: the result is not wanted.
      if (mine.signal.aborted || host.current() !== bmp) {
        out.close();
        return;
      }
      if (!host.swap(out)) {
        out.close();
        return;
      }
      original = bmp;
      cut = out;
      track('cutout_used');
      host.say(t('cut.done'));
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      fail(e as CutoutError, st);
    } finally {
      if (ctl === mine) ctl = null;
      busy = false;
      paint();
    }
  });
  return { armed };
}
