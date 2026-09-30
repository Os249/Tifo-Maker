/**
 * "Post it": a picture of the tifo in the stadium, ready to post.
 *
 * WHY
 *   The 29 Sep 2026 review: 72% of people who open the editor paint something
 *   and 61% look at it in 3D, but only ~10% press Save, and sharing was three
 *   presses in a month. Share needed a public design, which needs an account,
 *   which a first-time visitor does not have, so the one moment someone is
 *   proudest of their tifo (seeing it in the bowl) led nowhere. And the site's
 *   traffic comes from X: a fan posting their tifo IS the growth loop.
 *
 * WHAT
 *   - renderPostCard(): 1080×1350 (the 4:5 portrait X and Instagram show
 *     uncropped in the feed). The stadium view on top, the title and
 *     "Designed on tifomaker.org" underneath, a small mark in the picture's
 *     corner for when someone crops the band off.
 *   - openPostSheet(): phones with the Web Share API for files get one button
 *     that opens the share sheet with the picture attached (X, WhatsApp,
 *     Instagram, TikTok, Snapchat). Everyone else gets Copy image, Download,
 *     Post on X and Copy link. No account needed for any of it.
 *   - maybeOfferPost(): once per browser, the first time someone has made
 *     something and is looking at it in the stadium.
 *   - offerFileShare(): the same share sheet for a Match Day video or snapshot.
 *
 * The link that goes with the post is the design's public page when it has
 * one, otherwise the home page, and it is tagged (core/utm.ts) so the visits
 * it brings back are counted under "Shared by visitors".
 */
import { getLang, t } from './i18n';
import { tagShareUrl, type ShareSource } from '../core/utm';
import { track } from '../net/analytics';
import { recordShare } from '../net/api';

export interface PostDeps {
  /** Show the Stadium view and hand back its canvas, freshly rendered. */
  capture(): Promise<HTMLCanvasElement | null>;
  title(): string;
  /** The design's id when it is public, so the link can be its own page. */
  publicDesignId(): string | null;
}

export const CARD_W = 1080;
export const CARD_H = 1350;
const PHOTO_H = 1080;
const NUDGE_KEY = 'tifo_post_nudge_v1';

// ---------------------------------------------------------------------------
// The picture

/** Draw `src` into the box, cropped to fill it (CSS object-fit: cover). */
function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number): void {
  const sw = src.width;
  const sh = src.height;
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const cw = w / scale;
  const ch = h / scale;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

/** Shorten `text` with an ellipsis until it fits `max` pixels. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

export function renderPostCardCanvas(src: HTMLCanvasElement, opts: { title: string; lang: 'en' | 'ar' }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CARD_W;
  c.height = CARD_H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  drawCover(ctx, src, 0, 0, CARD_W, PHOTO_H);

  // A soft fade into the band, so the picture does not end on a hard line.
  const fade = ctx.createLinearGradient(0, PHOTO_H - 140, 0, PHOTO_H);
  fade.addColorStop(0, 'rgba(10,12,17,0)');
  fade.addColorStop(1, 'rgba(10,12,17,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, PHOTO_H - 140, CARD_W, 140);

  // The corner mark: survives someone cropping the band off.
  ctx.font = '600 26px Inter, system-ui, -apple-system, sans-serif';
  const mark = 'tifomaker.org';
  const mw = ctx.measureText(mark).width;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(CARD_W - mw - 52, 28, mw + 28, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textBaseline = 'middle';
  ctx.fillText(mark, CARD_W - mw - 38, 50);

  // The band: the tifo's name, then where it was made.
  const rtl = opts.lang === 'ar';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  const x = rtl ? CARD_W - 64 : 64;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f2f1ec';
  ctx.font = '800 58px Inter, system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif';
  const title = (opts.title || '').trim() || (rtl ? 'تيفو' : 'My tifo');
  ctx.fillText(fitText(ctx, title, CARD_W - 128), x, PHOTO_H + 112);
  ctx.font = '500 36px Inter, system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif';
  ctx.fillStyle = '#9aa3b2';
  const lead = `${t('post.designedOn')} `;
  ctx.fillText(lead, x, PHOTO_H + 186);
  const lw = ctx.measureText(lead).width;
  ctx.fillStyle = '#5b9bf2';
  ctx.font = '700 36px Inter, system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif';
  ctx.fillText('tifomaker.org', rtl ? x - lw : x + lw, PHOTO_H + 186);
  return c;
}

function toBlob(c: HTMLCanvasElement, type = 'image/png'): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b), type, 0.92));
}

// ---------------------------------------------------------------------------
// Sharing

/** A data: URL as a Blob, without fetch() (the CSP's connect-src refuses data:). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body = ''] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function canShareFiles(file: File): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function canCopyImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
}

function linkFor(deps: PostDeps, source: ShareSource): string {
  const id = deps.publicDesignId();
  const plain = id ? `${location.origin}/t/${id}` : `${location.origin}/`;
  return tagShareUrl(plain, source, 'post');
}

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

function fileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'tifo'}-tifomaker.png`;
}

function counted(deps: PostDeps, platform: ShareSource): void {
  track('shared');
  const id = deps.publicDesignId();
  if (id) recordShare(id, platform);
}

// ---------------------------------------------------------------------------
// UI

const CSS = `
.pm-overlay{position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.7);backdrop-filter:blur(4px);padding:14px;}
.pm-card:focus{outline:none;}
.pm-card{width:min(420px,100%);max-height:94dvh;overflow:auto;background:#11141b;color:#f2f1ec;border:1px solid #232a36;
  border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.5);padding:16px;font-family:Inter,system-ui,Arial,sans-serif;}
.pm-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.pm-head h3{margin:0;font-size:17px;font-weight:800;}
.pm-x{all:unset;cursor:pointer;color:#9aa3b2;font-size:22px;line-height:1;padding:4px 8px;border-radius:8px;}
.pm-x:hover,.pm-x:focus-visible{background:#1b2230;color:#fff;}
.pm-pic{display:block;width:100%;aspect-ratio:1080/1350;max-height:52dvh;object-fit:contain;border-radius:10px;background:#0a0c11;border:1px solid #232a36;}
.pm-wait{display:flex;align-items:center;justify-content:center;aspect-ratio:1080/1350;max-height:52dvh;border-radius:10px;background:#0a0c11;border:1px solid #232a36;color:#9aa3b2;font-size:14px;}
.pm-main{all:unset;box-sizing:border-box;display:flex;gap:8px;align-items:center;justify-content:center;width:100%;margin-top:12px;
  background:#2563eb;color:#fff;font-weight:800;font-size:15px;padding:13px;border-radius:11px;cursor:pointer;}
.pm-main:hover{background:#1d4ed8;} .pm-main:focus-visible{outline:2px solid #9cc0ff;outline-offset:2px;}
.pm-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-top:8px;}
.pm-b{all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:6px;align-items:center;justify-content:center;padding:11px 8px;
  border-radius:10px;background:#171c26;border:1px solid #232a36;font-weight:700;font-size:13px;color:#f2f1ec;text-align:center;}
.pm-b:hover{background:#1f2734;border-color:#33405a;} .pm-b:focus-visible{outline:2px solid #9cc0ff;outline-offset:2px;}
.pm-b[disabled]{opacity:.5;cursor:default;}
.pm-note{margin:10px 2px 0;font-size:12px;line-height:1.5;color:#9aa3b2;}
.pm-msg{min-height:18px;margin:8px 2px 0;font-size:12.5px;color:#9cc0ff;}
.pm-nudge{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));z-index:60;
  width:min(380px,calc(100vw - 24px));background:#11141b;color:#f2f1ec;border:1px solid #2a3344;border-radius:14px;
  box-shadow:0 18px 48px rgba(0,0,0,.45);padding:14px 14px 12px;font-family:Inter,system-ui,Arial,sans-serif;animation:pm-in .22s ease-out;}
body.m-shell .pm-nudge{bottom:calc(132px + env(safe-area-inset-bottom));}
.pm-nudge b{display:block;font-size:15px;margin-bottom:3px;} .pm-nudge p{margin:0 0 11px;font-size:13px;color:#aab3c2;line-height:1.45;}
.pm-nudge .pm-acts{display:flex;gap:8px;} .pm-nudge .pm-main{margin:0;padding:10px;font-size:14px;flex:1;}
.pm-nudge .pm-b{flex:0 0 auto;padding:10px 12px;}
@keyframes pm-in{from{opacity:0;transform:translate(-50%,8px);}to{opacity:1;transform:translate(-50%,0);}}
@media (prefers-reduced-motion: reduce){.pm-nudge{animation:none;}}
`;

function ensureCss(): void {
  if (document.getElementById('post-moment-css')) return;
  const style = document.createElement('style');
  style.id = 'post-moment-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

let open = false;

/** Open the "Post your tifo" sheet: make the picture, then offer every way to post it. */
export async function openPostSheet(deps: PostDeps): Promise<void> {
  if (open) return;
  open = true;
  ensureCss();
  track('post_opened');
  const rtl = getLang() === 'ar';
  const overlay = document.createElement('div');
  overlay.className = 'pm-overlay';
  overlay.dataset.postSheet = '1';
  overlay.innerHTML = `
    <div class="pm-card" role="dialog" aria-modal="true" aria-labelledby="pm-title" dir="${rtl ? 'rtl' : 'ltr'}">
      <div class="pm-head"><h3 id="pm-title">${t('post.head')}</h3><button class="pm-x" type="button" aria-label="${t('post.close')}">&times;</button></div>
      <div class="pm-wait" role="status">${t('post.making')}</div>
      <div class="pm-actions"></div>
      <p class="pm-msg" role="status" aria-live="polite"></p>
      <p class="pm-note">${t('post.foot')}</p>
    </div>`;
  const opener = document.activeElement as HTMLElement | null;
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    open = false;
    if (opener && document.contains(opener)) opener.focus();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.pm-x')!.addEventListener('click', close);
  document.body.appendChild(overlay);
  (overlay.querySelector('.pm-x') as HTMLElement).focus();

  const msg = overlay.querySelector('.pm-msg') as HTMLElement;
  const say = (text: string): void => { msg.textContent = text; };

  let blob: Blob | null = null;
  let preview = '';
  try {
    const src = await deps.capture();
    if (src) {
      const card = renderPostCardCanvas(src, { title: deps.title(), lang: rtl ? 'ar' : 'en' });
      blob = await toBlob(card);
      // Shown from a data: URL, not the blob: one: the site's CSP allows
      // data: images and not blob: ones. JPEG, because it is only a preview.
      preview = card.toDataURL('image/jpeg', 0.86);
    }
  } catch {
    blob = null;
  }
  if (!overlay.isConnected) return; // closed while the picture was being made
  const wait = overlay.querySelector('.pm-wait') as HTMLElement;
  if (!blob) {
    wait.textContent = t('post.fail');
    return;
  }
  const title = deps.title() || 'tifo';
  const file = new File([blob], fileName(title), { type: 'image/png' });
  const img = document.createElement('img');
  img.className = 'pm-pic';
  img.src = preview;
  img.alt = title;
  wait.replaceWith(img);

  const acts = overlay.querySelector('.pm-actions') as HTMLElement;
  const button = (cls: string, icon: string, label: string, onClick: () => void | Promise<void>): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i> <span></span>`;
    (b.querySelector('span') as HTMLElement).textContent = label;
    b.addEventListener('click', () => void onClick());
    return b;
  };
  const text = t('post.text');

  // Phones: the share sheet, with the picture attached. The link goes in the
  // text rather than `url`, because several targets keep only one of the two
  // when both are given, and the picture is the point.
  if (canShareFiles(file)) {
    acts.appendChild(button('pm-main', 'ti-share', t('post.share'), async () => {
      try {
        await navigator.share({ files: [file], text: `${text} ${linkFor(deps, 'webshare')}` });
        counted(deps, 'webshare');
      } catch {
        /* cancelled */
      }
    }));
  }
  const row = document.createElement('div');
  row.className = 'pm-row';
  if (canCopyImage()) {
    row.appendChild(button('pm-b', 'ti-copy', t('post.copyImg'), async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob! })]);
        counted(deps, 'copy');
        say(t('post.copiedImg'));
      } catch {
        say(t('post.pressHold'));
      }
    }));
  }
  row.appendChild(button('pm-b', 'ti-download', t('post.download'), () => {
    download(blob!, file.name);
    counted(deps, 'link');
    say(t('post.saved'));
  }));
  row.appendChild(button('pm-b', 'ti-brand-x', t('post.x'), () => {
    const href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(linkFor(deps, 'x'))}`;
    window.open(href, '_blank', 'noopener,noreferrer');
    counted(deps, 'x');
    say(t('post.xHint'));
  }));
  row.appendChild(button('pm-b', 'ti-brand-whatsapp', 'WhatsApp', () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${linkFor(deps, 'whatsapp')}`)}`, '_blank', 'noopener,noreferrer');
    counted(deps, 'whatsapp');
  }));
  row.appendChild(button('pm-b', 'ti-link', t('post.copyLink'), async () => {
    await navigator.clipboard?.writeText(linkFor(deps, 'copy')).catch(() => {});
    counted(deps, 'copy');
    say(t('post.copiedLink'));
  }));
  acts.appendChild(row);
  // A phone that cannot share files (an in-app browser, most often) can still
  // save the picture from the image itself.
  if (!canShareFiles(file) && matchMedia('(pointer: coarse)').matches) say(t('post.pressHold'));
  // Focus the dialog itself, not the first button: a ring round "Copy image"
  // read as a choice already made. Tab still starts at the first action.
  const cardEl = overlay.querySelector('.pm-card') as HTMLElement;
  cardEl.tabIndex = -1;
  cardEl.focus();
}

/**
 * Once per browser: the first time someone who has made something is looking
 * at it in the stadium. Not a dialog: a card they can ignore, gone on its own.
 */
export function maybeOfferPost(deps: PostDeps): void {
  try {
    if (localStorage.getItem(NUDGE_KEY)) return;
  } catch {
    return; // no storage: no way to show it only once, so not at all
  }
  // Never on top of another first-run layer.
  if (document.querySelector('.ob-backdrop, .tour-overlay, .news-card, .mds-overlay, [data-post-sheet], .pm-nudge')) return;
  try { localStorage.setItem(NUDGE_KEY, String(Date.now())); } catch { /* shown once per page at worst */ }
  ensureCss();
  const card = document.createElement('div');
  card.className = 'pm-nudge';
  card.setAttribute('role', 'status');
  card.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
  card.innerHTML = `<b></b><p></p><div class="pm-acts"><button type="button" class="pm-main"><i class="ti ti-share" aria-hidden="true"></i> <span></span></button><button type="button" class="pm-b"></button></div>`;
  (card.querySelector('b') as HTMLElement).textContent = t('post.nudgeTitle');
  (card.querySelector('p') as HTMLElement).textContent = t('post.nudgeBody');
  (card.querySelector('.pm-main span') as HTMLElement).textContent = t('post.btn');
  (card.querySelector('.pm-b') as HTMLElement).textContent = t('post.later');
  const done = (): void => { card.remove(); clearTimeout(timer); };
  const timer = window.setTimeout(done, 14000);
  card.querySelector('.pm-main')!.addEventListener('click', () => { done(); void openPostSheet(deps); });
  card.querySelector('.pm-b')!.addEventListener('click', done);
  document.body.appendChild(card);
}

/**
 * A finished Match Day video or snapshot, offered to the phone's share sheet.
 *
 * `navigator.share` needs a fresh tap: by the time a recording has finished
 * encoding, the tap that started it is long gone, so this is a button, not an
 * automatic sheet. Only where files can actually be shared; elsewhere the file
 * has already been downloaded and that is the whole story.
 */
export function offerFileShare(file: File, label: string): void {
  if (!canShareFiles(file)) return;
  ensureCss();
  document.querySelector('.pm-nudge.pm-file')?.remove();
  const card = document.createElement('div');
  card.className = 'pm-nudge pm-file';
  card.style.zIndex = '10050'; // above the Match Day overlay
  card.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
  card.innerHTML = `<div class="pm-acts"><button type="button" class="pm-main"><i class="ti ti-share" aria-hidden="true"></i> <span></span></button><button type="button" class="pm-b" aria-label="${t('post.close')}">&times;</button></div>`;
  (card.querySelector('.pm-main span') as HTMLElement).textContent = label;
  const done = (): void => { card.remove(); clearTimeout(timer); };
  const timer = window.setTimeout(done, 20000);
  card.querySelector('.pm-main')!.addEventListener('click', async () => {
    try {
      await navigator.share({ files: [file], text: `${t('post.text')} ${tagShareUrl(`${location.origin}/`, 'webshare', 'matchday')}` });
      track('shared');
    } catch {
      /* cancelled */
    }
    done();
  });
  card.querySelector('.pm-b')!.addEventListener('click', done);
  document.body.appendChild(card);
}
