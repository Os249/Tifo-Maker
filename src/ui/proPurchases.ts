/**
 * The purchases list of "Pro and purchases" on the account page
 * (ui/proAccount.ts): each order with how it was paid, where it stands, its
 * receipt (to open here or send to the account's email again) and "Request a
 * refund" on one that still qualifies, plus the one-time word that a refund
 * ended Pro.
 *
 * A module of its own so that it, and its strings, are downloaded only by an
 * account that has an order or a refund to show: for everyone else the account
 * page starts with exactly what it had before.
 */
import { requestRefund, resendReceipt, seenRefundNotice, type ProState, type PurchaseView } from '../net/api';
import { escapeHtml } from '../core/escape';
import { money, whenDay } from './pro';
import { t, tv } from './i18n';

/** What a button on an order last said, kept across repaints as a key and a tone. */
export interface OrderNote { key: string; tone: 'ok' | 'bad' | '' }

/** What the list remembers while the page is open (owned by the account section, which repaints it). */
export interface PurchasesUi {
  /** Which order's "Request a refund" is open. */
  asking: string | null;
  /** Which receipts are open. */
  receipts: Set<string>;
  /** What each order's buttons last said. */
  notes: Map<string, OrderNote>;
  /** Orders this page asked a refund for: what happened to them is said on the order itself, not as news. */
  askedHere: Set<string>;
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

function purchaseHtml(o: PurchaseView, refundDays: number, asking: boolean, receiptOpen: boolean, note: OrderNote | undefined): string {
  // A founder's first purchase lists the days it bought and the days it was given.
  const item = o.product === 'year'
    ? tv('pu.itemYear', { days: o.days })
    : o.product === 'match'
    ? tv('pu.itemMatch', { hours: o.days * 24 })
    : o.bonusDays ? tv('pu.itemBonus', { days: o.days, bonus: o.bonusDays }) : tv(o.renewal ? 'pu.itemRenewal' : 'pu.item', { days: o.days });
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

/** The list itself, or nothing when the account has no order to show. */
export function purchasesHtml(orders: PurchaseView[], refundDays: number, ui: PurchasesUi): string {
  if (!orders.length) return '';
  return (
    `<div class="pu"><h3 class="pro-ac-h" id="pu-h">${escapeHtml(t('pu.title'))}</h3><ul class="pu-list" aria-labelledby="pu-h">` +
    orders.map((o) => purchaseHtml(o, refundDays, ui.asking === o.id, ui.receipts.has(o.id), ui.notes.get(o.id))).join('') +
    `</ul></div>`
  );
}

/** The one-time word that a refund ended Pro, as a strip at the top of the section. */
export function refundedHtml(n: NonNullable<ProState['refundNotice']>): string {
  return (
    `<div class="pro-strip pro-refunded" role="status"><span><b>${escapeHtml(t('rn.title'))}</b> ` +
    `${escapeHtml(tv('rn.body', { price: money(n.amount), date: whenDay(n.at) }))}${n.test ? ` ${escapeHtml(t('rn.test'))}` : ''}</span></div>`
  );
}

/**
 * The purchases' own buttons: a receipt sent again, and a refund asked for in
 * two steps. `paint` redraws the section from what `ui` holds; `reload` reads
 * the account's state again first.
 */
export function wirePurchases(sec: HTMLElement, ui: PurchasesUi, paint: () => void, reload: () => Promise<void>): void {
  for (const d of Array.from(sec.querySelectorAll<HTMLDetailsElement>('.pu-receipt'))) {
    d.addEventListener('toggle', () => {
      const id = d.dataset.receipt ?? '';
      if (d.open) ui.receipts.add(id);
      else ui.receipts.delete(id);
    });
  }
  for (const b of Array.from(sec.querySelectorAll<HTMLButtonElement>('[data-act="receipt"]'))) {
    b.addEventListener('click', async () => {
      const id = b.dataset.order ?? '';
      b.disabled = true;
      b.textContent = t('pu.sending');
      const r = await resendReceipt(id);
      ui.notes.set(id, r === 'sent' ? { key: 'pu.sent', tone: 'ok' } : r === 'wait' ? { key: 'pu.sendWait', tone: '' } : { key: r === 'no_email' ? 'pu.sendNoEmail' : 'pu.sendFailed', tone: 'bad' });
      paint();
    });
  }
  for (const b of Array.from(sec.querySelectorAll<HTMLButtonElement>('[data-act="refund-ask"]'))) {
    b.addEventListener('click', () => {
      ui.asking = b.dataset.order ?? null;
      if (ui.asking) ui.notes.delete(ui.asking);
      paint();
      sec.querySelector<HTMLTextAreaElement>('.pu-ask textarea')?.focus();
    });
  }
  sec.querySelector('[data-act="refund-cancel"]')?.addEventListener('click', () => {
    const id = ui.asking;
    ui.asking = null;
    paint();
    if (id) sec.querySelector<HTMLButtonElement>(`[data-act="refund-ask"][data-order="${id}"]`)?.focus();
  });
  const send = sec.querySelector<HTMLButtonElement>('[data-act="refund-send"]');
  send?.addEventListener('click', async () => {
    const id = send.dataset.order ?? '';
    const note = sec.querySelector<HTMLTextAreaElement>('.pu-ask textarea')?.value ?? '';
    send.disabled = true;
    send.textContent = t('pu.rf.sending');
    ui.askedHere.add(id);
    const r = await requestRefund(id, note);
    ui.asking = null;
    if (r.ok) {
      ui.notes.set(id, { key: r.state === 'refunded' ? 'pu.rf.doneRefunded' : 'pu.rf.doneAsked', tone: 'ok' });
      // The page already says what happened to this order: the one-time notice is not owed for it.
      if (r.state === 'refunded') await seenRefundNotice(id);
      await reload();
    } else {
      // Too late, already asked for, or refunded meanwhile: the list says which once it is read again.
      const gone = r.reason === 'late' || r.reason === 'already' || r.reason === 'refunded' || r.reason === 'not_paid' || r.reason === 'none';
      ui.notes.set(id, { key: gone ? 'pu.rf.gone' : 'pu.rf.failed', tone: 'bad' });
      if (gone) await reload();
      else paint();
    }
  });
}
