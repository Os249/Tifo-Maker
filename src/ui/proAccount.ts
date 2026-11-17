/**
 * "Your plan" on the account page: which plan, until when, what is left of
 * each allowance and when it comes back, and the gift when one is waiting.
 *
 * Shown only where /api/pro says Pro is on for this account; with Pro off the
 * page is exactly what it was. Every number here is the server's.
 */
import { cancelRenewal, fetchMeOnce, fetchPro, fetchRenewal, type Allowance, type AllowanceKind, type ProState, type RenewalView } from '../net/api';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG, backWhen, endsText, kindName, proChipHtml, whenDay } from './pro';
import { onLangChange, t, tv } from './i18n';
import { supporterBadgeHtml } from './supporterBadge';

const ORDER: AllowanceKind[] = ['std', 'polish', 'cutout', 'photo'];

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

/** "Visa ending 1111", "Apple Pay · Visa ending 1111", or just "your card". */
function cardText(s: RenewalView): string {
  const wallet = s.method === 'applepay' ? 'Apple Pay' : s.method === 'samsungpay' ? 'Samsung Pay' : '';
  const brand = s.brand ? s.brand.charAt(0).toUpperCase() + s.brand.slice(1) : '';
  const name = [wallet, brand].filter(Boolean).join(' · ');
  return s.lastFour ? tv('pr.ac.cardEnding', { brand: name || t('pr.ac.theCard'), last: s.lastFour }) : name || t('pr.ac.card');
}

/**
 * "Keep Pro on" (auto-renew, payments v2): when the next renewal is and from
 * which card, with the one button that turns it off. Shown only to an account
 * that has (or had) it; turning it off is one click and needs no reason.
 */
function renewHtml(r: { paused: boolean; sub: RenewalView | null } | null, note: string): string {
  const s = r?.sub;
  if (!s) return '';
  const renewing = s.status === 'active' || s.status === 'failing';
  // Stopped long ago and nothing to say now: only a renewal that is running, or was just turned off, is shown.
  if (!renewing && !note) return '';
  const line = !renewing
    ? ''
    : r.paused
      ? t('pr.ac.paused')
      : tv(s.status === 'failing' ? 'pr.ac.failing' : 'pr.ac.active', { date: s.nextAt ? whenDay(s.nextAt) : '', price: s.amount, card: cardText(s) });
  return (
    `<div class="pro-renew"><h3 class="pro-ac-h">${escapeHtml(t('pr.ac.title'))}</h3>` +
    (line ? `<p class="ac-note">${escapeHtml(line)}</p>` : '') +
    (renewing ? `<button type="button" class="ac-btn" data-act="renew-off">${escapeHtml(t('pr.ac.cancel'))}</button>` : '') +
    `<p class="ac-note" id="pro-renew-msg" role="status" aria-live="polite">${escapeHtml(note)}</p></div>`
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
  let renewal: Awaited<ReturnType<typeof fetchRenewal>> = null;
  /** What turning auto-renew off last said, kept across repaints as a key. */
  let renewNote = '';

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
    // A supporter sees their name as the community shows it, badge and all.
    const foot = st.supporter
      ? `<p class="ac-note pro-ac-foot">${escapeHtml(t('qk.badgeYou'))}</p>` +
        `<p class="pro-ac-name"><bdi dir="ltr">@${escapeHtml(username)}</bdi>${supporterBadgeHtml()}</p>`
      : !paid && g?.state !== 'offered'
        ? `<button type="button" class="ac-btn" data-act="what">${escapeHtml(t('pro.sheet.whatTitle'))}</button>`
        : '';
    sec.innerHTML = head + gift + renewHtml(renewal, renewNote ? t(renewNote) : '') + meters + foot;
    const off = sec.querySelector<HTMLButtonElement>('[data-act="renew-off"]');
    off?.addEventListener('click', async () => {
      off.disabled = true;
      off.textContent = t('pr.ac.cancelling');
      const r = await cancelRenewal();
      if (r) {
        renewal = { offered: renewal?.offered ?? false, paused: false, sub: r.sub };
        renewNote = 'pr.ac.cancelled';
      } else {
        renewNote = 'pr.ac.cancelFailed';
      }
      paint();
      sec.querySelector<HTMLElement>('#pro-renew-msg')?.focus?.();
    });
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

  let username = '';
  const load = async (fresh = false): Promise<void> => {
    const [st, me] = await Promise.all([fetchPro(fresh).catch(() => null), fetchMeOnce().catch(() => null)]);
    state = st;
    // Asked for only when the server says this account has auto-renew: nothing new is fetched otherwise.
    renewal = st?.live && st.renewal ? await fetchRenewal() : null;
    username = me?.username ?? '';
    paint();
    // Arrived from the header chip (/account#pro): bring the section into view.
    if (!sec.hidden && location.hash === '#pro') sec.scrollIntoView({ block: 'start' });
  };
  void load();
  window.addEventListener('tifo:pro', () => void load(true));
  onLangChange(paint);
}
