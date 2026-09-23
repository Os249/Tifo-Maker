import { t } from './i18n';

/**
 * "Banners are here": told once, to everyone who opens the editor.
 *
 * A new view in a row of four tabs is easy to miss — the people who most need
 * telling are the ones who already know the editor, and they are exactly the
 * ones who no longer read its header. So the news points AT the tab, from just
 * under it, and says what it is in one line, with the one button that goes
 * there.
 *
 * It does not interrupt. It is a card beside the work rather than a dialog in
 * front of it: the canvas keeps working, focus stays where it was, and it waits
 * its turn behind the onboarding dialog, the tour and Match Day rather than
 * stacking on top of them. It goes when it is answered — Try, Not now, the X
 * or Escape — or when the view changes, since then it has either done its job
 * or been passed over. A reload before any of those shows it again: seen is
 * when somebody has responded to it, not when it was painted.
 */

const FLAG = 'tifo_news_banners_v1';

function seen(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return true; // storage blocked → it would come back on every load
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    /* ignore */
  }
}

/** Something else has the screen, and this can wait for it. */
function screenBusy(): boolean {
  return !!document.querySelector('.tour-overlay, .ob-backdrop, .mds-overlay, .dlg-backdrop');
}

/** The Banner tab this points at: the header's, or the phone's view pill. */
function anchor(): HTMLElement | null {
  for (const sel of ['.m-view-b[data-view="banner"]', '#view-banner']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

export interface WhatsNewOptions {
  /** Go to the Banner view. */
  onTry: () => void;
  /** Already in it: then there is nothing to announce. */
  inBanner: () => boolean;
}

export function offerWhatsNew(opts: WhatsNewOptions): void {
  if (seen()) return;
  let waited = 0;
  const wait = (): void => {
    if (seen()) return;
    if (opts.inBanner()) {
      markSeen();
      return;
    }
    if (screenBusy()) {
      // Two minutes is longer than anyone spends on the onboarding dialog.
      // After that, give up for this visit rather than poll forever.
      waited += 700;
      if (waited < 120000) window.setTimeout(wait, 700);
      return;
    }
    show(opts);
  };
  // A moment after the editor settles, so it is noticed as news rather than
  // lost in the page load.
  window.setTimeout(wait, 1200);
}

function show(opts: WhatsNewOptions): void {
  if (document.getElementById('news-card')) return;
  const card = document.createElement('div');
  card.id = 'news-card';
  card.className = 'news-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'news-title');
  card.innerHTML =
    '<span class="news-arrow" aria-hidden="true"></span>' +
    '<button type="button" class="news-x" id="news-x"><i class="ti ti-x" aria-hidden="true"></i></button>' +
    '<div class="news-head"><span class="news-tag"></span><i class="ti ti-flag news-icon" aria-hidden="true"></i></div>' +
    '<h3 class="news-title" id="news-title"></h3>' +
    '<p class="news-body"></p>' +
    '<div class="news-actions">' +
    '<button type="button" class="news-later" id="news-later"></button>' +
    '<button type="button" class="news-try primary" id="news-try"><i class="ti ti-arrow-right news-go" aria-hidden="true"></i></button>' +
    '</div>';
  const q = <T extends HTMLElement>(s: string): T => card.querySelector(s) as T;
  q('.news-tag').textContent = t('news.tag');
  q('.news-title').textContent = t('news.title');
  q('.news-body').textContent = t('news.body');
  q('#news-later').textContent = t('news.later');
  q('#news-try').prepend(document.createTextNode(t('news.try') + ' '));
  q('#news-x').setAttribute('aria-label', t('news.close'));
  document.body.appendChild(card);

  const place = (): void => {
    const a = anchor();
    const vw = window.innerWidth;
    const cw = card.offsetWidth;
    const arrow = q<HTMLElement>('.news-arrow');
    if (!a) {
      // No tab to point at: under the header, centred.
      card.style.left = `${Math.max(12, (vw - cw) / 2)}px`;
      card.style.top = '72px';
      arrow.hidden = true;
      return;
    }
    const r = a.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    const left = Math.max(12, Math.min(mid - cw / 2, vw - cw - 12));
    card.style.left = `${left}px`;
    card.style.top = `${r.bottom + 12}px`;
    arrow.hidden = false;
    arrow.style.left = `${Math.max(18, Math.min(mid - left, cw - 18))}px`;
  };
  place();
  requestAnimationFrame(place);
  window.addEventListener('resize', place);

  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    markSeen();
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('tifo:view', onView);
    document.removeEventListener('tifo:news-close', close);
    card.classList.add('out');
    window.setTimeout(() => card.remove(), 160);
  };
  function onKey(e: KeyboardEvent): void {
    // Escape belongs to whatever is on top of this, when something is.
    if (e.key === 'Escape' && !screenBusy()) close();
  }
  // Any change of view ends it. Into the Banner view, it has done its job;
  // into the Stadium or Split view, it would sit on the camera bar, which is
  // right under the tabs — and somebody moving around the editor has seen it.
  function onView(): void {
    close();
  }
  q('#news-x').addEventListener('click', close);
  q('#news-later').addEventListener('click', close);
  q('#news-try').addEventListener('click', () => {
    close();
    opts.onTry();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('tifo:view', onView);
  document.addEventListener('tifo:news-close', close);
}
