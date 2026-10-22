/**
 * Reusable share modal for public tifos.
 *
 * One self-contained component used by the editor, the community feed, and the
 * public /t/:id page. It offers the native Web Share sheet on mobile, direct
 * share intents for the major platforms, a QR code, and copy-link — and logs
 * every share to the analytics endpoint via recordShare(). Platforms without a
 * web share-intent (Instagram, TikTok, Discord) fall back to copy-link with a
 * hint, since they can't accept a prefilled link from the browser.
 *
 * Self-contained styling (injected once) so it looks identical wherever it is
 * mounted, regardless of the host page's stylesheet.
 */

import { shareUrl, ogImageUrl, recordShare } from '../net/api';
import { tagShareUrl, type ShareSource } from '../core/utm';
import { track } from '../net/analytics';

import { t, tv } from './i18n';
import { escapeHtml } from '../core/escape';
import { containDialog } from './dialogFocus';
import { copyText } from './clipboard';
export interface ShareTarget {
  id: string;
  title: string;
  /** Override the link (defaults to the canonical /t/:id). */
  url?: string;
}

const CSS = `
.sm-overlay{position:fixed;inset:0;z-index:var(--z-overlay,100);display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.66);backdrop-filter:blur(4px);padding:16px;}
.sm-card{width:min(480px,100%);max-height:calc(100dvh - 32px - var(--consent-h,0px));overflow:auto;background:var(--card,var(--ink-1,#131d30));color:var(--ink,var(--text-1,#f1f4fb));
  border:1px solid var(--line,var(--line-1,#2a3650));border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.3);padding:24px;
  font-family:var(--font-ui,Inter,system-ui,sans-serif);}
.sm-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sm-head h3{margin:0;font-size:18px;font-weight:800;}
.sm-x{all:unset;cursor:pointer;color:#9aa3b2;font-size:22px;line-height:1;padding:2px 6px;border-radius:8px;}
.sm-x:hover{background:#1b2230;color:#fff;}
.sm-preview{width:100%;aspect-ratio:1200/630;object-fit:cover;border-radius:10px;background:#0a0c11;margin-bottom:14px;border:1px solid #232a36;}
.sm-native{all:unset;box-sizing:border-box;display:flex;gap:8px;align-items:center;justify-content:center;width:100%;
  background:#2563eb;color:#fff;font-weight:700;padding:12px;border-radius:10px;cursor:pointer;margin-bottom:14px;}
.sm-native:hover{background:#1d4ed8;}
.sm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px;}
.sm-btn{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:12px 4px;border-radius:10px;background:#171c26;border:1px solid #232a36;text-align:center;}
.sm-btn:hover{background:#1f2734;border-color:#33405a;}
.sm-btn i{font-size:22px;}
.sm-btn span{font-size:11px;color:#c6ccd6;}
.sm-row{display:flex;gap:8px;margin-bottom:12px;}
.sm-link{flex:1;min-width:0;background:#0c0f15;border:1px solid #232a36;border-radius:10px;color:#c6ccd6;
  padding:10px 12px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;}
.sm-copy{all:unset;cursor:pointer;background:#171c26;border:1px solid #232a36;border-radius:10px;padding:0 14px;
  display:flex;align-items:center;gap:6px;font-weight:700;font-size:13px;color:#f2f1ec;}
.sm-copy:hover{background:#1f2734;}
.sm-foot{display:flex;gap:8px;align-items:center;justify-content:space-between;}
.sm-open{all:unset;cursor:pointer;color:#5b8cff;font-weight:700;font-size:13px;}
.sm-qrbtn{all:unset;cursor:pointer;color:#9aa3b2;font-size:13px;display:flex;align-items:center;gap:6px;}
.sm-qr{margin-top:12px;display:flex;justify-content:center;}
.sm-qr img{width:180px;height:180px;border-radius:10px;background:#fff;padding:8px;}
.sm-qr[hidden]{display:none;}
.sm-x{display:grid;place-items:center;box-sizing:border-box;width:44px;height:44px;color:inherit;}
.sm-btn,.sm-copy{background:var(--raise,var(--ink-2,#1a263b));border-color:var(--line,var(--line-1,#2a3650));color:inherit;}
.sm-btn span{color:inherit;font-size:12px;}
.sm-btn:hover,.sm-copy:hover,.sm-x:hover{background:var(--raise-2,var(--ink-3,#25334c));color:inherit;}
.sm-link{background:var(--paper,var(--ink-0,#0b1120));border-color:var(--line,var(--line-1,#2a3650));color:inherit;min-height:44px;}
.sm-foot{flex-wrap:wrap;gap:12px;}
.sm-open,.sm-qrbtn{color:var(--blue,#7fb0ff);min-height:44px;display:inline-flex;align-items:center;}
.sm-card :is(button,a,input):focus-visible{outline:3px solid var(--blue,#7fb0ff);outline-offset:3px;}
.sm-status{font-size:13px;line-height:1.5;color:var(--muted,var(--text-2,#a6b0c8));margin:0 0 12px;}
.sm-status:empty{display:none;}
.sm-preview{height:140px;aspect-ratio:auto;object-fit:contain;background:#0b1120;margin-bottom:8px;}
.sm-target{margin:0 0 16px;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
@media(max-width:480px){.sm-overlay{align-items:flex-end;padding:12px 12px calc(12px + var(--consent-h,0px));}.sm-card{padding:18px;}.sm-grid{grid-template-columns:repeat(3,minmax(0,1fr));}}
.sm-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#1f2734;color:#fff;
  padding:10px 16px;border-radius:10px;font-size:13px;z-index:10000;box-shadow:0 8px 24px rgba(0,0,0,.4);}
`;

function ensureCss(): void {
  if (document.getElementById('share-modal-css')) return;
  const style = document.createElement('style');
  style.id = 'share-modal-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Open the share modal for a public tifo. */
export function openShareModal(target: ShareTarget): void {
  ensureCss();
  const base = target.url ?? shareUrl(target.id);
  // Each platform gets its own tagged copy of the link, so an opened link is
  // counted by where it was shared, WhatsApp and Discord included.
  const url = (source: ShareSource): string => tagShareUrl(base, source);
  const text = tv('sm.shareText', { title: target.title });
  const enc = encodeURIComponent;

  // Platforms with a real web share-intent.
  const intents: { id: ShareSource; label: string; icon: string; href: string }[] = [
    { id: 'whatsapp', label: 'WhatsApp', icon: 'ti-brand-whatsapp', href: `https://wa.me/?text=${enc(`${text} ${url('whatsapp')}`)}` },
    { id: 'x', label: 'X', icon: 'ti-brand-x', href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url('x'))}` },
    { id: 'telegram', label: 'Telegram', icon: 'ti-brand-telegram', href: `https://t.me/share/url?url=${enc(url('telegram'))}&text=${enc(text)}` },
    { id: 'facebook', label: 'Facebook', icon: 'ti-brand-facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url('facebook'))}` },
    { id: 'reddit', label: 'Reddit', icon: 'ti-brand-reddit', href: `https://www.reddit.com/submit?url=${enc(url('reddit'))}&title=${enc(target.title)}` },
    { id: 'email', label: 'Email', icon: 'ti-mail', href: `mailto:?subject=${enc(target.title)}&body=${enc(`${text}\n\n${url('email')}`)}` },
  ];
  // Platforms that can't take a prefilled web link → copy + hint.
  const copyOnly: { id: ShareSource; label: string; icon: string }[] = [
    { id: 'instagram', label: 'Instagram', icon: 'ti-brand-instagram' },
    { id: 'tiktok', label: 'TikTok', icon: 'ti-brand-tiktok' },
    { id: 'discord', label: 'Discord', icon: 'ti-brand-discord' },
  ];

  const overlay = document.createElement('div');
  overlay.className = 'sm-overlay';
  overlay.innerHTML = `
    <div class="sm-card" role="dialog" aria-modal="true" aria-label="${t('sm.title')}">
      <div class="sm-head"><h3>${t('sm.head')}</h3><button class="sm-x" aria-label="${t('common.close')}">&times;</button></div>
      <img class="sm-preview" src="${ogImageUrl(target.id)}" alt="" />
      <p class="sm-target">${escapeHtml(target.title)}</p>
      ${'share' in navigator ? `<button class="sm-native"><i class="ti ti-share" aria-hidden="true"></i> ${t('cm.share')}</button>` : ''}
      <div class="sm-row">
        <input class="sm-link" readonly aria-label="${t('sm.link')}" dir="ltr" value="${escapeHtml(url('copy'))}" />
        <button class="sm-copy"><i class="ti ti-copy" aria-hidden="true"></i> ${t('sm.copy')}</button>
      </div>
      <p class="sm-status" role="status" aria-live="polite"></p>
      <div class="sm-grid"></div>
      <div class="sm-foot">
        <a class="sm-open" href="${escapeHtml(base)}" target="_blank" rel="noopener">${t('sm.openPublic')} ↗</a>
        <button class="sm-qrbtn" aria-expanded="false"><i class="ti ti-qrcode" aria-hidden="true"></i> ${t('sm.qr')}</button>
      </div>
      <div class="sm-qr" hidden></div>
    </div>`;

  const close = (): void => {
    release();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  document.body.appendChild(overlay);
  const release = containDialog(overlay, close);
  overlay.querySelector<HTMLImageElement>('.sm-preview')?.addEventListener('error', (e) => { (e.target as HTMLImageElement).hidden = true; });
  const picture = overlay.querySelector<HTMLImageElement>('.sm-preview')!;
  const fitPicture = (): void => {
    // Older designs return the panoramic seat strip as their OG fallback.
    // Wrap that strip using the same bowl renderer as the community cards.
    if (!picture.naturalHeight || picture.naturalWidth / picture.naturalHeight <= 4) return;
    void import('./bowlPicture').then(({ drawBowl }) => {
      if (picture.isConnected) picture.src = drawBowl(picture).toDataURL('image/webp');
    }).catch(() => { /* contain keeps the complete strip visible */ });
  };
  if (picture.complete) fitPicture();
  else picture.addEventListener('load', fitPicture, { once: true });
  const copy = async (source: ShareSource, message: string): Promise<void> => {
    const field = overlay.querySelector<HTMLInputElement>('.sm-link')!;
    field.value = url(source);
    const ok = await copyText(field.value);
    overlay.querySelector('.sm-status')!.textContent = ok ? message : t('sm.copyFailed');
    if (!ok) { field.focus(); field.select(); return; }
    recordShare(target.id, source);
    track('shared');
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.sm-x')!.addEventListener('click', close);

  // Native share sheet (mobile).
  overlay.querySelector('.sm-native')?.addEventListener('click', async () => {
    try {
      await navigator.share({ title: target.title, text, url: url('webshare') });
      recordShare(target.id, 'webshare');
      track('shared');
    } catch {
      /* user cancelled */
    }
  });

  // Platform buttons.
  const grid = overlay.querySelector('.sm-grid')!;
  for (const p of intents) {
    const b = document.createElement('button');
    b.className = 'sm-btn';
    b.innerHTML = `<i class="ti ${p.icon}"></i><span>${p.label}</span>`;
    b.addEventListener('click', () => {
      window.open(p.href, '_blank', 'noopener,noreferrer');
      recordShare(target.id, p.id);
      track('shared');
    });
    grid.appendChild(b);
  }
  for (const p of copyOnly) {
    const b = document.createElement('button');
    b.className = 'sm-btn';
    b.innerHTML = `<i class="ti ${p.icon}"></i><span>${p.label}</span>`;
    b.addEventListener('click', async () => {
      await copy(p.id, `${t('sm.copiedFor')} ${p.label}`);
    });
    grid.appendChild(b);
  }

  // Copy link.
  overlay.querySelector('.sm-copy')!.addEventListener('click', async () => {
    await copy('copy', t('sm.copied'));
  });

  // QR code (lazy: only build the qrcode lib + image when requested).
  const qrWrap = overlay.querySelector('.sm-qr') as HTMLElement;
  overlay.querySelector('.sm-qrbtn')!.addEventListener('click', async () => {
    if (!qrWrap.hidden) {
      qrWrap.hidden = true;
      overlay.querySelector('.sm-qrbtn')!.setAttribute('aria-expanded', 'false');
      return;
    }
    qrWrap.hidden = false;
    overlay.querySelector('.sm-qrbtn')!.setAttribute('aria-expanded', 'true');
    if (!qrWrap.querySelector('img')) {
      try {
        const QRCode = (await import('qrcode')).default;
        const dataUrl = await QRCode.toDataURL(url('qr'), { width: 360, margin: 1 });
        recordShare(target.id, 'qr');
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = t('sm.qrAlt');
        qrWrap.appendChild(img);
      } catch {
        qrWrap.textContent = t('sm.qrFail');
      }
    }
  });

}
