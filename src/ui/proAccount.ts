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
 * that still qualifies (and why not on one that does not), auto-renew with
 * its one button, and, once, the word that a refund ended Pro. A fan who
 * never bought anything sees nothing new but a "Get Pro" link where Pro is on
 * sale to them.
 */
import {
  cancelRenewal, fetchMeOnce, fetchPro, fetchPurchases, fetchRenewal, requestRefund, resendReceipt, seenRefundNotice,
  type Allowance, type AllowanceKind, type ProState, type PurchaseView, type RenewalView,
} from '../net/api';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG, backWhen, endsText, kindName, money, proChipHtml, proNavOnSale, whenDay, whenRiyadh } from './pro';
import { localPath, onLangChange, t, tv } from './i18n';
import { supporterBadgeHtml } from './supporterBadge';

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

/** How an order was paid: "Apple Pay", "mada", "Visa", or "Card" when Moyasar did not say which. */
function howPaid(o: PurchaseView): string {
  const brandKey = o.brand ? `pu.b.${o.brand}` : '';
  const brand = brandKey && t(brandKey) !== brandKey ? t(brandKey) : '';
  if (o.method === 'applepay' || o.method === 'stcpay' || o.method === 'samsungpay') {
    const wallet = t(`pu.m.${o.method}`);
    return brand && o.method !== 'stcpay' ? `${wallet} · ${brand}` : wallet;
  }
  return brand || (o.method ? t('pu.m.card') : '');
}

const BADGE: Record<string, string> = { paid: 'ok', refunded: 'quiet', failed: 'quiet', checking: 'pending' };

/** Where an order's refund stands, in a sentence: whether it still qualifies, and why if not. */
function refundLine(o: PurchaseView, refundDays: number): string {
  const r = o.refund;
  if (r.state === 'open') return tv(r.used ? 'pu.rf.openUsed' : 'pu.rf.open', { date: r.until ? whenDay(r.until) : '' });
  if (r.state === 'late') return tv('pu.rf.late', { days: refundDays, date: r.until ? whenDay(r.until) : '' });
  if (r.state === 'requested') return tv('pu.rf.requested', { date: r.askedAt ? whenDay(r.askedAt) : '' });
  if (r.state === 'declined') return tv('pu.rf.declined', { reason: r.reason ?? '' });
  if (r.state === 'refunded') return tv('pu.rf.refunded', { date: o.refundedAt ? whenDay(o.refundedAt) : '' });
  return o.status === 'failed' ? t('pu.failedNote') : o.status === 'checking' ? t('pu.checkingNote') : '';
}

/** What a button on an order last said, kept across repaints as a key and a tone. */
interface OrderNote { key: string; tone: 'ok' | 'bad' | '' }

function purchaseHtml(o: PurchaseView, refundDays: number, asking: boolean, receiptOpen: boolean, note: OrderNote | undefined): string {
  // A founder's first purchase lists the days it bought and the days it was given.
  const item = o.bonusDays ? tv('pu.itemBonus', { days: o.days, bonus: o.bonusDays }) : tv(o.renewal ? 'pu.itemRenewal' : 'pu.item', { days: o.days });
  const price = tv('pu.price', { price: money(o.amount) });
  const how = howPaid(o);
  const when = whenDay(o.paidAt ?? o.createdAt);
  const hasReceipt = o.status === 'paid' || o.status === 'refunded';
  const line = (k: string, v: string, ltr = false): string =>
    v ? `<dt>${escapeHtml(t(k))}</dt><dd>${ltr ? `<bdi dir="ltr">${escapeHtml(v)}</bdi>` : escapeHtml(v)}</dd>` : '';
  const receipt = hasReceipt
    ? `<details class="pu-receipt" data-receipt="${escapeHtml(o.id)}"${receiptOpen ? ' open' : ''}><summary>${escapeHtml(t('pu.receipt'))}</summary>` +
      `<dl class="pu-lines">` +
      line('pu.r.item', item) + line('pu.r.amount', price) + line('pu.r.paid', when) + line('pu.r.how', how) +
      line('pu.r.until', o.endsAt ? whenDay(o.endsAt) : '') +
      line('pu.r.refunded', o.status === 'refunded' && o.refundedAt ? `${whenDay(o.refundedAt)} · ${tv('pu.price', { price: money(o.refunded || o.amount) })}` : '') +
      line('pu.r.ref', o.reference, true) +
      `</dl><div class="pu-actions"><button type="button" class="ac-btn" data-act="receipt" data-order="${escapeHtml(o.id)}">${escapeHtml(t('pu.send'))}</button></div></details>`
    : '';
  const ask = o.refund.state !== 'open'
    ? ''
    : asking
      ? `<div class="pu-ask"><p>${escapeHtml(tv('pu.rf.confirm', { price: money(o.amount) }))}</p>` +
        `<label for="pu-note-${escapeHtml(o.id)}">${escapeHtml(t('pu.rf.note'))}</label>` +
        `<textarea id="pu-note-${escapeHtml(o.id)}" maxlength="500" rows="2"></textarea>` +
        `<div class="pu-actions"><button type="button" class="ac-btn" data-act="refund-send" data-order="${escapeHtml(o.id)}">${escapeHtml(t('pu.rf.send'))}</button>` +
        `<button type="button" class="ac-btn" data-act="refund-cancel">${escapeHtml(t('ac.cancel'))}</button></div></div>`
      : `<div class="pu-actions"><button type="button" class="ac-btn" data-act="refund-ask" data-order="${escapeHtml(o.id)}">${escapeHtml(t('pu.rf.ask'))}</button></div>`;
  const rl = refundLine(o, refundDays);
  return (
    `<li class="pu-order" data-order="${escapeHtml(o.id)}" data-status="${escapeHtml(o.status)}" data-refund="${escapeHtml(o.refund.state)}">` +
    `<div class="pu-head"><span class="pu-what">${escapeHtml(item)}</span>` +
    `<span class="ac-badge" data-state="${BADGE[o.status] ?? 'quiet'}">${escapeHtml(t(`pu.st.${o.status}`))}</span>` +
    `<span class="pu-amt">${escapeHtml(price)}</span></div>` +
    `<p class="pu-meta">${escapeHtml([when, how, o.test ? t('pu.test') : ''].filter(Boolean).join(' · '))}</p>` +
    (rl ? `<p class="ac-note pu-refund">${escapeHtml(rl)}</p>` : '') +
    receipt + ask +
    `<p class="pu-msg" role="status" aria-live="polite" data-tone="${note?.tone ?? ''}">${note ? escapeHtml(t(note.key)) : ''}</p></li>`
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
  /** Which order's "Request a refund" is open, which receipts are, and what each order's buttons last said. */
  let asking: string | null = null;
  const receipts = new Set<string>();
  const notes = new Map<string, OrderNote>();
  /** Orders this page asked a refund for: what happened to them is said on the order itself, not as news. */
  const askedHere = new Set<string>();

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
      (refunded
        ? `<div class="pro-strip pro-refunded" role="status"><span><b>${escapeHtml(t('rn.title'))}</b> ` +
          `${escapeHtml(tv('rn.body', { price: money(refunded.amount), date: whenDay(refunded.at) }))}${refunded.test ? ` ${escapeHtml(t('rn.test'))}` : ''}</span></div>`
        : '') +
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
    const list = orders.length
      ? `<div class="pu"><h3 class="pro-ac-h" id="pu-h">${escapeHtml(t('pu.title'))}</h3><ul class="pu-list" aria-labelledby="pu-h">` +
        orders.map((o) => purchaseHtml(o, bought?.refundDays ?? 7, asking === o.id, receipts.has(o.id), notes.get(o.id))).join('') +
        `</ul></div>`
      : '';
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
    wirePurchases();
    sec.hidden = false;
  };

  /** The purchases' own buttons: a receipt sent again, and a refund asked for in two steps. */
  const wirePurchases = (): void => {
    for (const d of Array.from(sec.querySelectorAll<HTMLDetailsElement>('.pu-receipt'))) {
      d.addEventListener('toggle', () => {
        const id = d.dataset.receipt ?? '';
        if (d.open) receipts.add(id);
        else receipts.delete(id);
      });
    }
    for (const b of Array.from(sec.querySelectorAll<HTMLButtonElement>('[data-act="receipt"]'))) {
      b.addEventListener('click', async () => {
        const id = b.dataset.order ?? '';
        b.disabled = true;
        b.textContent = t('pu.sending');
        const r = await resendReceipt(id);
        notes.set(id, r === 'sent' ? { key: 'pu.sent', tone: 'ok' } : r === 'wait' ? { key: 'pu.sendWait', tone: '' } : { key: r === 'no_email' ? 'pu.sendNoEmail' : 'pu.sendFailed', tone: 'bad' });
        paint();
      });
    }
    for (const b of Array.from(sec.querySelectorAll<HTMLButtonElement>('[data-act="refund-ask"]'))) {
      b.addEventListener('click', () => {
        asking = b.dataset.order ?? null;
        if (asking) notes.delete(asking);
        paint();
        sec.querySelector<HTMLTextAreaElement>('.pu-ask textarea')?.focus();
      });
    }
    sec.querySelector('[data-act="refund-cancel"]')?.addEventListener('click', () => {
      const id = asking;
      asking = null;
      paint();
      if (id) sec.querySelector<HTMLButtonElement>(`[data-act="refund-ask"][data-order="${id}"]`)?.focus();
    });
    const send = sec.querySelector<HTMLButtonElement>('[data-act="refund-send"]');
    send?.addEventListener('click', async () => {
      const id = send.dataset.order ?? '';
      const note = sec.querySelector<HTMLTextAreaElement>('.pu-ask textarea')?.value ?? '';
      send.disabled = true;
      send.textContent = t('pu.rf.sending');
      askedHere.add(id);
      const r = await requestRefund(id, note);
      asking = null;
      if (r.ok) {
        notes.set(id, { key: r.state === 'refunded' ? 'pu.rf.doneRefunded' : 'pu.rf.doneAsked', tone: 'ok' });
        // The page already says what happened to this order: the one-time notice is not owed for it.
        if (r.state === 'refunded') await seenRefundNotice(id);
        await load(true);
      } else {
        // Too late, already asked for, or refunded meanwhile: the list says which once it is read again.
        const gone = r.reason === 'late' || r.reason === 'already' || r.reason === 'refunded' || r.reason === 'not_paid' || r.reason === 'none';
        notes.set(id, { key: gone ? 'pu.rf.gone' : 'pu.rf.failed', tone: 'bad' });
        if (gone) await load(true);
        else paint();
      }
    });
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
      if (!askedHere.has(st.refundNotice.order)) refunded = st.refundNotice;
    }
    username = me?.username ?? '';
    paint();
    // Arrived from the header chip (/account#pro): bring the section into view.
    if (!sec.hidden && location.hash === '#pro') sec.scrollIntoView({ block: 'start' });
  };
  void load();
  window.addEventListener('tifo:pro', () => void load(true));
  onLangChange(paint);
}
