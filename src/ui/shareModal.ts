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

export interface ShareTarget {
  id: string;
  title: string;
  /** Override the link (defaults to the canonical /t/:id). */
  url?: string;
}

const CSS = `
.sm-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.66);backdrop-filter:blur(4px);padding:16px;}
.sm-card{width:min(440px,100%);max-height:92vh;overflow:auto;background:#11141b;color:#f2f1ec;
  border:1px solid #232a36;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.5);padding:20px;
  font-family:Inter,system-ui,Arial,sans-serif;}
.sm-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sm-head h3{margin:0;font-size:18px;font-weight:800;}
.sm-x{all:unset;cursor:pointer;color:#9aa3b2;font-size:22px;line-height:1;padding:2px 6px;border-radius:8px;}
.sm-x:hover{background:#1b2230;color:#fff;}
.sm-preview{width:100%;aspect-ratio:1200/630;object-fit:cover;border-radius:10px;background:#0a0c11;margin-bottom:14px;border:1px solid #232a36;}
.sm-native{all:unset;box-sizing:border-box;display:flex;gap:8px;align-items:center;justify-content:center;width:100%;
  background:#2563eb;color:#fff;font-weight:700;padding:12px;border-radius:10px;cursor:pointer;margin-bottom:14px;}
.sm-native:hover{background:#1d4ed8;}
.sm-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;}
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

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'sm-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

/** Open the share modal for a public tifo. */
export function openShareModal(target: ShareTarget): void {
  ensureCss();
  const url = target.url ?? shareUrl(target.id);
  const text = `${target.title}: made with TifoMaker`;
  const enc = encodeURIComponent;

  // Platforms with a real web share-intent.
  const intents: { id: string; label: string; icon: string; href: string }[] = [
    { id: 'whatsapp', label: 'WhatsApp', icon: 'ti-brand-whatsapp', href: `https://wa.me/?text=${enc(`${text} ${url}`)}` },
    { id: 'x', label: 'X', icon: 'ti-brand-x', href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
    { id: 'telegram', label: 'Telegram', icon: 'ti-brand-telegram', href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
    { id: 'facebook', label: 'Facebook', icon: 'ti-brand-facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
    { id: 'reddit', label: 'Reddit', icon: 'ti-brand-reddit', href: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(target.title)}` },
    { id: 'email', label: 'Email', icon: 'ti-mail', href: `mailto:?subject=${enc(target.title)}&body=${enc(`${text}\n\n${url}`)}` },
  ];
  // Platforms that can't take a prefilled web link → copy + hint.
  const copyOnly: { id: string; label: string; icon: string }[] = [
    { id: 'instagram', label: 'Instagram', icon: 'ti-brand-instagram' },
    { id: 'tiktok', label: 'TikTok', icon: 'ti-brand-tiktok' },
    { id: 'discord', label: 'Discord', icon: 'ti-brand-discord' },
  ];

  const overlay = document.createElement('div');
  overlay.className = 'sm-overlay';
  overlay.innerHTML = `
    <div class="sm-card" role="dialog" aria-modal="true" aria-label="Share tifo">
      <div class="sm-head"><h3>Share this tifo</h3><button class="sm-x" aria-label="Close">&times;</button></div>
      <img class="sm-preview" src="${ogImageUrl(target.id)}" alt="" />
      ${'share' in navigator ? `<button class="sm-native"><i class="ti ti-share"></i> Share…</button>` : ''}
      <div class="sm-grid"></div>
      <div class="sm-row">
        <input class="sm-link" readonly value="${url}" />
        <button class="sm-copy"><i class="ti ti-copy"></i> Copy</button>
      </div>
      <div class="sm-foot">
        <a class="sm-open" href="${url}" target="_blank" rel="noopener">Open public page ↗</a>
        <button class="sm-qrbtn"><i class="ti ti-qrcode"></i> QR code</button>
      </div>
      <div class="sm-qr" hidden></div>
    </div>`;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
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
      await navigator.share({ title: target.title, text, url });
      recordShare(target.id, 'webshare');
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
    });
    grid.appendChild(b);
  }
  for (const p of copyOnly) {
    const b = document.createElement('button');
    b.className = 'sm-btn';
    b.innerHTML = `<i class="ti ${p.icon}"></i><span>${p.label}</span>`;
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(url).catch(() => {});
      recordShare(target.id, p.id);
      toast(`Link copied: paste it into ${p.label}`);
    });
    grid.appendChild(b);
  }

  // Copy link.
  overlay.querySelector('.sm-copy')!.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    recordShare(target.id, 'copy');
    toast('Link copied to clipboard');
  });

  // QR code (lazy: only build the qrcode lib + image when requested).
  const qrWrap = overlay.querySelector('.sm-qr') as HTMLElement;
  overlay.querySelector('.sm-qrbtn')!.addEventListener('click', async () => {
    if (!qrWrap.hidden) {
      qrWrap.hidden = true;
      return;
    }
    qrWrap.hidden = false;
    if (!qrWrap.querySelector('img')) {
      try {
        const QRCode = (await import('qrcode')).default;
        const dataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1 });
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'QR code to open this tifo';
        qrWrap.appendChild(img);
      } catch {
        qrWrap.textContent = 'Could not generate QR code.';
      }
    }
  });

  document.body.appendChild(overlay);
}
