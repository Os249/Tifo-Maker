/**
 * "Your plan" on the account page: which plan, until when, what is left of
 * each allowance and when it comes back, and the gift when one is waiting.
 *
 * Shown only where /api/pro says Pro is on for this account; with Pro off the
 * page is exactly what it was. Every number here is the server's.
 */
import { fetchPro, type Allowance, type AllowanceKind, type ProState } from '../net/api';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG, backWhen, endsText, kindName, proChipHtml, whenDay } from './pro';
import { onLangChange, t, tv } from './i18n';

const ORDER: AllowanceKind[] = ['super', 'std', 'polish', 'cutout', 'photo'];

function meter(a: Allowance): string {
  const per = t(`pro.per.${a.period}`);
  const left = tv('pro.q.left', { n: a.remaining, limit: a.limit, what: kindName(a.kind), per });
  const back = a.remaining < a.limit ? ` · ${tv('ac.pro.back', { when: backWhen(a) })}` : '';
  return (
    `<li class="pro-meter" data-left="${a.remaining <= 0 ? 'none' : a.remaining === 1 && a.limit > 1 ? 'low' : ''}">` +
    `<span class="pro-meter-text">${escapeHtml(left + back)}</span>` +
    `<span class="pro-meter-bar" aria-hidden="true"><span data-frac="${a.limit ? a.remaining / a.limit : 0}"></span></span></li>`
  );
}

/** Put the section first among the account's sections, and keep it current. */
export function mountProAccount(sections: HTMLElement): void {
  const sec = document.createElement('section');
  sec.className = 'ac-card pro-ac';
  sec.id = 'pro';
  sec.hidden = true;
  sec.setAttribute('aria-labelledby', 'pro-ac-h');
  sections.prepend(sec);
  let state: ProState | null = null;

  const paint = (): void => {
    const st = state;
    if (!st?.live || !st.signedIn) {
      sec.hidden = true;
      return;
    }
    const plan = st.plan ?? 'free';
    const paid = plan !== 'free';
    const head =
      `<h2 id="pro-ac-h">${escapeHtml(t('ac.pro.title'))}</h2>` +
      `<div class="ac-row"><span class="ac-value">${escapeHtml(t(`ac.pro.plan.${plan}`))}</span>` +
      (paid ? proChipHtml() : '') +
      (st.pass ? `<span class="ac-badge" data-state="ok">${escapeHtml(tv('ac.pro.ends', { date: endsText(st.pass.endsAt) }))}</span>` : '') +
      `</div>`;
    const g = st.gift;
    const gift =
      g?.state === 'offered'
        ? `<div class="pro-strip">${CROWN_SVG}<span>${escapeHtml(tv('ac.pro.giftWaiting', { n: g.days }))}</span></div>` +
          `<button type="button" class="pro-btn pro-ac-btn" data-act="gift">${CROWN_SVG}<span>${escapeHtml(t('gift.accept'))}</span></button>`
        : g?.state === 'used' && g.endedAt && !paid
          ? `<p class="ac-note">${escapeHtml(tv('ac.pro.giftEnded', { date: whenDay(g.endedAt) }))}</p>`
          : '';
    const al = st.allowances;
    const meters = al
      ? `<h3 class="pro-ac-h">${escapeHtml(t('ac.pro.left'))}</h3><ul class="pro-meters">${ORDER.filter((k) => al[k]).map((k) => meter(al[k])).join('')}</ul>`
      : '';
    const foot = st.supporter
      ? `<p class="ac-note pro-ac-foot">${escapeHtml(t('ac.pro.supporter'))}</p>`
      : !paid && g?.state !== 'offered'
        ? `<button type="button" class="ac-btn" data-act="what">${escapeHtml(t('pro.sheet.whatTitle'))}</button>`
        : '';
    sec.innerHTML = head + gift + meters + foot;
    for (const bar of Array.from(sec.querySelectorAll<HTMLElement>('.pro-meter-bar > span'))) {
      bar.style.inlineSize = `${Math.round(Math.max(0, Math.min(1, Number(bar.dataset.frac))) * 100)}%`;
    }
    sec.querySelector('[data-act="gift"]')?.addEventListener('click', async () => {
      const { openGiftSheet } = await import('./proSheets');
      if (await openGiftSheet(st)) await load(true);
    });
    sec.querySelector('[data-act="what"]')?.addEventListener('click', () => void import('./proSheets').then((m) => m.openProSheet(st)));
    sec.hidden = false;
  };

  const load = async (fresh = false): Promise<void> => {
    state = await fetchPro(fresh).catch(() => null);
    paint();
    // Arrived from the header chip (/account#pro): bring the section into view.
    if (!sec.hidden && location.hash === '#pro') sec.scrollIntoView({ block: 'start' });
  };
  void load();
  window.addEventListener('tifo:pro', () => void load(true));
  onLangChange(paint);
}
