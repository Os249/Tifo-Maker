/**
 * Tifo of the day on the home page — the client half.
 *
 * In production the card is already in the HTML: the server picks the day's
 * design and renders it (routes.ts, featuredCard), so it paints with the page
 * and a crawler sees a real link to the design. This module then only has to
 * put the title in the right language.
 *
 * Under `vite dev` there is no server injection, so it falls back to fetching
 * /api/featured/today and building the same card. Both paths produce the same
 * DOM, so the CSS has one shape to style and the language swap works on either.
 *
 * Nothing here is allowed to be loud about failing: an empty container is
 * hidden by CSS, which is exactly right on a site with no published designs yet.
 */
import { escapeHtml } from './core/escape';
// getLang, not <html lang>: the language module is the source of truth, and the
// landing bundle already carries it. The rest of i18n is pulled in lazily below,
// on the path that actually needs to build a card.
import { getLang } from './ui/i18n';

const ID = 'featured-tifo';

/** Put the featured title in the current language. Safe to call any time. */
export function localizeDailyTifo(): void {
  const el = document.querySelector<HTMLElement>(`#${ID} .fd-title`);
  if (!el) return;
  const en = el.dataset.titleEn ?? el.textContent ?? '';
  const ar = el.dataset.titleAr ?? '';
  el.textContent = getLang() === 'ar' && ar ? ar : en;
}

export async function mountDailyTifo(): Promise<void> {
  const box = document.getElementById(ID);
  if (!box) return;
  // Already rendered by the server: nothing to fetch, just pick the language.
  if (box.children.length > 0) {
    localizeDailyTifo();
    return;
  }
  try {
    const { fetchFeaturedTifo } = await import('./net/api');
    const { t } = await import('./ui/i18n');
    const featured = await fetchFeaturedTifo();
    const item = featured?.item;
    if (!item) return;
    const name = item.title?.trim() || 'Untitled tifo';
    const nameAr = item.titleAr?.trim() ?? '';
    const by = item.ownerName || 'a supporter';
    box.innerHTML = `
      <div class="fd-label"><span class="fd-star" aria-hidden="true">★</span><span data-i18n="daily.badge">${escapeHtml(t('daily.badge'))}</span></div>
      <a class="fd-card" href="/t/${encodeURIComponent(item.id)}">
        <span class="fd-shot-wrap">
          <img class="fd-shot" src="/api/designs/${encodeURIComponent(item.id)}/thumbnail.png"
               alt="${escapeHtml(name)}, a stadium tifo by @${escapeHtml(by)}" width="800" height="84" />
        </span>
        <span class="fd-body">
          <span class="fd-main">
            <span class="fd-title" data-title-en="${escapeHtml(name)}"${nameAr ? ` data-title-ar="${escapeHtml(nameAr)}"` : ''}>${escapeHtml(name)}</span>
            <span class="fd-by">@${escapeHtml(by)}</span>
          </span>
          <span class="fd-cta" data-i18n="daily.view">${escapeHtml(t('daily.view'))}</span>
        </span>
      </a>
      <p class="fd-note" data-i18n="daily.sub">${escapeHtml(t('daily.sub'))}</p>`;
    localizeDailyTifo();
  } catch {
    box.innerHTML = '';
  }
}
