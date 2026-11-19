/**
 * "Your plan" on the account page: which plan, until when, what is left of
 * each allowance and when it comes back, and the gift when one is waiting.
 *
 * Shown only where /api/pro says Pro is on for this account; with Pro off the
 * page is exactly what it was. Every number here is the server's.
 *
 * "Pro and purchases" (19 Nov 2026): once Pro can be bought, or this account
 * bought something, the same section is where it is all seen and managed:
 * each order with how it was paid, where it stands and its receipt (to open
 * here or send to the account's email again), "Request a refund" on an order
 * that still qualifies (and why not on one that does not; the list is
 * ui/proPurchases.ts, loaded only when there is one), auto-renew with
 * its one button, and, once, the word that a refund ended Pro. A fan who
 * never bought anything sees nothing new but a "Get Pro" link where Pro is on
 * sale to them.
 */
import {
  cancelRenewal, fetchMeOnce, fetchPro, fetchPurchases, fetchRenewal, seenRefundNotice,
  type Allowance, type AllowanceKind, type ProState, type RenewalView,
} from '../net/api';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG, backWhen, endsText, kindName, money, proChipHtml, proNavOnSale, whenDay, whenRiyadh } from './pro';
import { localPath, onLangChange, t, tv } from './i18n';
import { supporterBadgeHtml } from './supporterBadge';
import type { PurchasesUi } from './proPurchases';

const ORDER: AllowanceKind[] = ['std', 'polish', 'cutout', 'photo'];
const DAY = 24 * 60 * 60 * 1000;

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
      : tv(s.status === 'failing' ? 'pr.ac.failing' : 'pr.ac.active', { date: s.nextAt ? whenDay(s.nextAt) : '', price: money(s.amount), card: cardText(s) });
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
  let bought: Awaited<ReturnType<typeof fetchPurchases>> = null;
  /** What turning auto-renew off last said, kept across repaints as a key. */
  let renewNote = '';
  /** The refund this visit was told about: kept while the page is open, though the server says it only once. */
  let refunded: NonNullable<ProState['refundNotice']> | null = null;
  /** The purchases list (ui/proPurchases.ts), loaded once there is one to show, and what it remembers. */
  let pu: typeof import('./proPurchases') | null = null;
  const ui: PurchasesUi = { asking: null, receipts: new Set(), notes: new Map(), askedHere: new Set() };

  const paint = (): void => {
    const st = state;
    const orders = bought?.orders ?? [];
    // Pro is on for this account, or it bought something (which it can always see, whatever the switches say now).
    if (!st?.signedIn || (!st.live && !orders.length && !refunded)) {
      sec.hidden = true;
      return;
    }
    const plan = st.live ? st.plan ?? 'free' : 'free';
    const paid = plan !== 'free';
    const canBuy = st.live && st.offer?.paymentsOpen === true;
    const left = st.pass && plan === 'gift' ? Math.ceil((Date.parse(st.pass.endsAt) - Date.now()) / DAY) : 0;
    const head =
      `<h2 id="pro-ac-h">${escapeHtml(t(canBuy || orders.length || refunded ? 'ac.pro.titleBuy' : 'ac.pro.title'))}</h2>` +
      (refunded && pu ? pu.refundedHtml(refunded) : '') +
      `<div class="ac-row"><span class="ac-value">${escapeHtml(t(`ac.pro.plan.${plan}`))}</span>` +
      (paid ? proChipHtml() : '') +
      (st.live && st.pass ? `<span class="ac-badge" data-state="ok">${escapeHtml(tv('ac.pro.ends', { date: endsText(st.pass.endsAt) }))}</span>` : '') +
      // A gift is counted in days: how many are left, beside the day it ends.
      (left > 0 ? `<span class="ac-badge" data-state="quiet" data-gift-left="${left}">${escapeHtml(left === 1 ? t('ac.pro.dayLeft') : tv('ac.pro.daysLeft', { n: left }))}</span>` : '') +
      `</div>`;
    // The founders offer (server/src/proLaunch.ts): open to this account with its deadline, or taken with its first purchase.
    const fo = st.live ? st.founder : undefined;
    const founder = !fo
      ? ''
      : fo.state === 'used'
        ? `<div class="pro-strip pro-founder" data-founder="used">${CROWN_SVG}<span>${escapeHtml(tv('ac.pro.founderUsed', { bonus: fo.bonusDays, total: fo.total }))}</span></div>`
        : canBuy && Date.parse(fo.until) > Date.now()
          ? `<div class="pro-strip pro-founder" data-founder="open">${CROWN_SVG}<span>${escapeHtml(tv('ac.pro.founderOpen', { date: whenRiyadh(fo.until), total: fo.total, days: fo.total - fo.bonusDays }))} ` +
            `<a href="${escapeHtml(localPath('/pro'))}">${escapeHtml(tv('pb.buy', { price: money(st.offer?.monthly.price ?? 0) }))}</a></span></div>`
          : '';
    const g = st.live ? st.gift : undefined;
    const gift =
      g?.state === 'offered'
        ? `<div class="pro-strip">${CROWN_SVG}<span>${escapeHtml(tv('ac.pro.giftWaiting', { n: g.days }))}</span></div>` +
          `<button type="button" class="pro-btn pro-ac-btn" data-act="gift">${CROWN_SVG}<span>${escapeHtml(t('gift.accept'))}</span></button>`
        : g?.state === 'used' && g.endedAt && !paid
          ? `<p class="ac-note">${escapeHtml(tv('ac.pro.giftEnded', { date: whenDay(g.endedAt) }))}</p>`
          : '';
    const al = st.live ? st.allowances : undefined;
    const meters = al
      ? `<h3 class="pro-ac-h">${escapeHtml(t('ac.pro.left'))}</h3><ul class="pro-meters">${ORDER.filter((k) => al[k]).map((k) => meter(al[k])).join('')}</ul>`
      : '';
    // A supporter sees their name as the community shows it, badge and all.
    const foot = st.live && st.supporter
      ? `<p class="ac-note pro-ac-foot">${escapeHtml(t('qk.badgeYou'))}</p>` +
        `<p class="pro-ac-name"><bdi dir="ltr">@${escapeHtml(username)}</bdi>${supporterBadgeHtml()}</p>`
      : !st.live || g?.state === 'offered'
        ? ''
        : canBuy && st.offer
          // Pro is on sale to this account (on Free, or on a gift that will end): the short way to it.
          ? `<a class="ac-btn pro-ac-get" data-act="get" href="${escapeHtml(localPath('/pro'))}">${escapeHtml(tv('pb.buy', { price: money(st.offer.monthly.price) }))}</a>`
          : paid
            ? ''
            : `<button type="button" class="ac-btn" data-act="what">${escapeHtml(t('pro.sheet.whatTitle'))}</button>`;
    const list = pu ? pu.purchasesHtml(orders, bought?.refundDays ?? 7, ui) : '';
    sec.innerHTML = head + founder + gift + renewHtml(st.live ? renewal : null, renewNote ? t(renewNote) : '') + meters + foot + list;
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
    pu?.wirePurchases(sec, ui, paint, () => load(true));
    sec.hidden = false;
  };

  let username = '';
  const load = async (fresh = false): Promise<void> => {
    const [st, me] = await Promise.all([fetchPro(fresh).catch(() => null), fetchMeOnce().catch(() => null)]);
    state = st;
    proNavOnSale(st);
    // Asked for only when the server says this account has auto-renew: nothing new is fetched otherwise.
    renewal = st?.live && st.renewal ? await fetchRenewal() : null;
    // And the purchases only when it says there are some.
    bought = st?.purchases ? await fetchPurchases() : null;
    if (st?.refundNotice && refunded?.order !== st.refundNotice.order) {
      // Said here, now: the server does not offer it again, here or on My projects.
      void seenRefundNotice(st.refundNotice.order);
      if (!ui.askedHere.has(st.refundNotice.order)) refunded = st.refundNotice;
    }
    // The list and its strings are downloaded only by an account that has an order or a refund to show.
    if (!pu && (bought?.orders.length || refunded)) pu = await import('./proPurchases').catch(() => null);
    username = me?.username ?? '';
    paint();
    // Arrived from the header chip (/account#pro): bring the section into view.
    if (!sec.hidden && location.hash === '#pro') sec.scrollIntoView({ block: 'start' });
  };
  void load();
  window.addEventListener('tifo:pro', () => void load(true));
  onLangChange(paint);
}
