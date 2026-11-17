/**
 * /pro: "Help us price Pro". Two columns, Free against Pro, with no price on
 * Pro: until it goes on sale, the Pro column asks every visitor what a month
 * of it is worth to them, in riyals or US dollars (server/src/proPrice.ts),
 * and Osamh reads the answers on /admin.
 *
 * Asking a price for something nobody can buy yet is new to most fans, and
 * looks like a checkout to someone skimming. So the page says three things
 * before anything else (pro.html, .ps-steps): Pro is not on sale; tell us
 * what a month is worth, nothing is charged; we set the price from the
 * answers and you hear first. Answering is one tap: a quick amount, or
 * "Not for me", with typing your own a box away (10 Nov 2026).
 *
 * Every allowance on the page is the server's (/api/pro → soon.limits, from
 * server/src/proPlan.ts), so an offer changes in one file. The page is the
 * same for everyone; an account in the Pro preview also sees its own pass,
 * or its gift waiting.
 *
 * The one blue button is "Send my price". "Tell me when Pro opens" (signed
 * in) stays beside it, quiet.
 *
 * On sale (payments v1, 12 Nov 2026): when the server says this visitor can
 * buy Pro (/api/pro offer.paymentsOpen, server/src/payments.ts, off by
 * default), the same page says so instead. The hero's words become "pay once,
 * it turns on, it ends by itself" (setSaleCopy), the Pro column shows the
 * price and "Get Pro", which goes to Moyasar's own payment page, and the
 * price question and "Tell me when Pro opens" step aside. Coming back from
 * Moyasar (/pro?order=...), the page asks the server until the order is paid
 * (watchOrder). No card is ever typed on this site.
 *
 * Payments v2 (16 Nov 2026), each part off until the server says otherwise:
 *
 * The payment form (offer.checkout === 'form'): "Get Pro" opens Moyasar's own
 * form here in the Pro column instead of leaving for its hosted page
 * (openForm). The form is Moyasar's script (the moyasar-payment-form package,
 * bundled, loaded only when the form opens); what is typed into it goes from
 * this browser straight to Moyasar and never to our server. After the bank's
 * 3-D Secure page the fan comes back to /pro?order=..., exactly as from the
 * hosted page, and the server reads the payment from Moyasar: this page
 * believes nothing in the address it came back with. Each way it can end has
 * its own words (FAIL_KEYS), and every one of them says nothing was charged.
 *
 * "Keep Pro on" (form.renew): an unticked box above the form, with the price
 * and the date of the first renewal. Ticking it is told to the server first,
 * and only then is the form opened again asking Moyasar to save the card.
 * Nothing is ever ticked for the fan.
 *
 * /pro?stop=<token>: the one-click link in the renewal emails. The page turns
 * auto-renew off with it and says so (stopByLink); no sign-in needed.
 */
import { cleanAddressBar } from './core/utm';
import { track } from './net/analytics';
import './vendor/tabler-subset.css';
import './community.css';
import './proPage.css';
import { initLang, applyDom, getLang, localPath, onLangChange, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { escapeHtml } from './core/escape';
import {
  adoptProviderSession, fetchMe, fetchOrder, fetchPriceAnswer, fetchPro, forgetPro, markPayAttempt, notifyPro, sendPriceAnswer, setKeepPro,
  startCheckout, stopRenewalByLink,
  type AllowanceKind, type CheckoutForm, type CheckoutRefusal, type PayFail, type PlanLimits, type PriceAnswer, type PriceCurrency, type ProState,
} from './net/api';
import { CROWN_SVG, endsText, mountProChip, whenDay } from './ui/pro';
import { QUICK_PICKS, defaultCurrency, priceText, readAmount, thanksText } from './ui/priceQuestion';
import { openGiftSheet } from './ui/proSheets';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const authBtn = $<HTMLButtonElement>('auth-btn');

let state: ProState | null = null;
/** Nothing is painted until /api/pro has answered once. */
let loaded = false;

/** The visitor's answer to the price question, once they have given one. */
let answer: PriceAnswer | null = null;
/** Showing the form again over an answer already given ("Change my answer"). */
let changing = false;
/** The currency the visitor chose; until they choose, the page's language decides. */
let pickedCurrency: PriceCurrency | null = null;
/** How many answers there are ("N fans have answered", from 5 up). */
let answered = 0;
/** Whether the last answer put a signed-in fan on the "hear first" list. */
let told = false;

/** Below this, a count reads as "hardly anyone": the line stays hidden. */
const SHOW_COUNT_FROM = 5;

// ---------------------------------------------------------------- on sale ---

/** This visitor can buy Pro (or, signed out, could once signed in): the server's word. */
const onSale = (): boolean => !!state?.offer?.paymentsOpen;

/** Within this long of a month's end, another can be added (server/src/payments RENEW_WITHIN_DAYS). */
const RENEW_MS = 7 * 24 * 3600_000;

/** What "Get Pro" last said, kept across repaints as a key and its values. */
let buyMsg: { key: string; vars?: Record<string, string> } | null = null;
/** The return from Moyasar's page, kept the same way. */
let paidMsg: { key: string; vars?: Record<string, string>; tone: 'wait' | 'ok' | 'bad' } | null = null;

/**
 * The words that change when Pro is on sale: each element with its
 * coming-soon key and its on-sale key. Found once, by the coming-soon key in
 * pro.html, before anything swaps them.
 */
const SALE_COPY: [HTMLElement, string, string][] = (
  [
    ['ps.eyebrow', 'pb.eyebrow'], ['ps.title', 'pb.title'], ['ps.lead', 'pb.lead'],
    ['ps.step1.t', 'pb.step1.t'], ['ps.step1.b', 'pb.step1.b'],
    ['ps.step2.t', 'pb.step2.t'], ['ps.step2.b', 'pb.step2.b'],
    ['ps.step3.t', 'pb.step3.t'], ['ps.step3.b', 'pb.step3.b'],
    ['pp.faq.a5', 'pb.faq.a5'], ['pp.faq.a2', 'pp.faq.a2'],
  ] as const
).flatMap(([soon, sale]) => {
  const el = document.querySelector<HTMLElement>(`[data-i18n="${soon}"]`);
  return el ? [[el, soon, sale] as [HTMLElement, string, string]] : [];
});
/** The words that differ when the form is the checkout, and when "Keep Pro on" is offered (payments v2). */
const FORM_COPY: Record<string, string> = { 'pb.step1.t': 'pf.step1.t', 'pb.step1.b': 'pf.step1.b', 'pb.faq.a5': 'pf.faq.a5' };
const RENEW_COPY: Record<string, string> = { 'pb.step3.t': 'pr.step3.t', 'pb.step3.b': 'pr.step3.b', 'pp.faq.a2': 'pr.faq.a2', 'pb.lead': 'pr.lead' };
/** Which wording is on the page now: '' (coming soon), or the sale wording with its variants. */
let saleCopy = '';

/** Moyasar's form is the checkout here, rather than its hosted page. */
const formCheckout = (): boolean => state?.offer?.checkout === 'form';
/** "Keep Pro on" is offered at checkout. */
const renewOffered = (): boolean => state?.offer?.autoRenew === true;

function setSaleCopy(on: boolean): void {
  const want = on ? `sale${formCheckout() ? '+form' : ''}${renewOffered() ? '+renew' : ''}` : '';
  if (want === saleCopy) return;
  saleCopy = want;
  for (const [el, soon, sale] of SALE_COPY) {
    const key = !on ? soon : (renewOffered() && RENEW_COPY[sale]) || (formCheckout() && FORM_COPY[sale]) || sale;
    el.setAttribute('data-i18n', key);
  }
  const refund = document.getElementById('pp-faq-refund');
  if (refund) refund.hidden = !on;
  applyDom(document);
}

/** The month this account holds, when it is a month (paid or given) rather than the gift. */
function monthHeld(): { endsAt: string } | null {
  const p = state?.live ? state.pass : null;
  return p && p.plan === 'monthly' && Date.parse(p.endsAt) > Date.now() ? { endsAt: p.endsAt } : null;
}

/** The Pro column's head when Pro is on sale: the price, and the one way to buy it. */
function buyHtml(): string {
  const o = state!.offer!;
  const price = String(o.monthly.price);
  const held = monthHeld();
  const renew = !!held && Date.parse(held.endsAt) - Date.now() <= RENEW_MS;
  let act = '';
  if (!state?.signedIn) act = `<button type="button" class="pp-btn" data-act="buy-signin">${escapeHtml(t('pb.signin'))}</button>`;
  else if (held && !renew) act = `<p class="pb-note">${escapeHtml(tv('pb.err.held', { date: whenDay(held.endsAt) }))}</p>`;
  else {
    act = `<button type="button" class="pp-btn" data-act="buy">${escapeHtml(tv(renew ? 'pb.renew' : 'pb.buy', { price }))}</button>` +
      (renew ? `<p class="pb-note">${escapeHtml(t('pb.renewNote'))}</p>` : '');
  }
  const msg = buyMsg ? escapeHtml(tv(buyMsg.key, buyMsg.vars ?? {})) : '';
  return (
    `<div class="pb-buy" id="pb-buy">` +
    `<p class="pb-price"><b>${escapeHtml(tv('pb.price', { price }))}</b> <span>${escapeHtml(tv('pb.per', { days: o.monthly.days }))}</span></p>` +
    `<p class="pb-once">${escapeHtml(t(renewOffered() ? 'pr.once' : 'pb.once'))}</p>` +
    act +
    // Moyasar's form opens here (openForm), in place of the button.
    `<div class="pb-form" id="pb-form" hidden></div>` +
    `<p class="pb-msg" id="pb-msg" role="status" aria-live="polite">${msg}</p>` +
    `<p class="ps-private">${escapeHtml(t(formCheckout() ? 'pf.methods' : 'pb.methods'))}</p>` +
    `</div>`
  );
}

const REFUSED: Record<CheckoutRefusal, string> = {
  off: 'pb.err.off', verify: 'pb.err.verify', held: 'pb.err.held', busy: 'pb.err.busy',
  unavailable: 'pb.err.unavailable', signin: 'pb.signin', offline: 'pb.err.offline',
};

function sayBuy(m: { key: string; vars?: Record<string, string> } | null): void {
  buyMsg = m;
  const msg = document.getElementById('pb-msg');
  if (msg) msg.textContent = m ? tv(m.key, m.vars ?? {}) : '';
}

function wireBuy(): void {
  const box = document.getElementById('pb-buy');
  if (!box) return;
  box.querySelector('[data-act="buy-signin"]')?.addEventListener('click', () => void signIn());
  const btn = box.querySelector<HTMLButtonElement>('[data-act="buy"]');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    const label = btn.textContent ?? '';
    btn.textContent = t(formCheckout() ? 'pf.opening' : 'pb.going');
    const r = await startCheckout(getLang());
    if (r.ok && 'url' in r) {
      track('pro_checkout');
      // Moyasar's own page: the card, Apple Pay or mada is handled there, never here.
      location.assign(r.url);
      return;
    }
    if (r.ok) {
      track('pro_checkout');
      btn.disabled = false;
      btn.textContent = label;
      sayBuy(null);
      await openForm(r.order, r.form, false);
      return;
    }
    if (r.reason === 'signin') {
      await signIn();
      return;
    }
    btn.disabled = false;
    btn.textContent = label;
    sayBuy({ key: REFUSED[r.reason], vars: r.endsAt ? { date: whenDay(r.endsAt) } : undefined });
  });
  // A repaint (a language switch) while the form is open: open it again, in the new language.
  if (openOrder && btn) void openForm(openOrder.id, openOrder.form, openOrder.keep);
}

// ------------------------------------------------- Moyasar's payment form ---

/** The order the form is open for, and whether "Keep Pro on" is ticked for it (as the server has it). */
let openOrder: { id: string; form: CheckoutForm; keep: boolean; sent: boolean } | null = null;

interface MoyasarForm {
  init(config: Record<string, unknown>): void;
}
let moyasarLib: Promise<MoyasarForm> | null = null;
/** Moyasar's form: its script and its stylesheet, from our own /assets, fetched the first time a form opens. */
function loadMoyasar(): Promise<MoyasarForm> {
  moyasarLib ??= Promise.all([import('moyasar-payment-form'), import('moyasar-payment-form/dist/moyasar.css')]).then(([m]) => {
    const lib = ((m as { default?: unknown }).default ?? m) as MoyasarForm & { default?: MoyasarForm };
    return typeof lib.init === 'function' ? lib : (lib.default as MoyasarForm);
  });
  moyasarLib.catch(() => { moyasarLib = null; });
  return moyasarLib;
}

/** The methods "Keep Pro on" works with, as a fan reads them. */
function renewMethodsText(f: NonNullable<CheckoutForm['renew']>): string {
  const names: string[] = [];
  if (f.methods.includes('creditcard')) names.push(t(f.mada ? 'pr.m.cardsMada' : 'pr.m.cards'));
  if (f.methods.includes('applepay')) names.push('Apple Pay');
  if (f.methods.includes('samsungpay')) names.push('Samsung Pay');
  return names.join(t('pr.m.sep'));
}

function closeForm(): void {
  openOrder = null;
  const box = document.getElementById('pb-form');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  const btn = document.querySelector<HTMLButtonElement>('#pb-buy [data-act="buy"]');
  if (btn) btn.hidden = false;
}

/**
 * Open Moyasar's form for an order, in place of the "Get Pro" button. With
 * `keep`, the form asks Moyasar to save the card for renewals; the page only
 * ever passes true after the server has recorded the fan's tick.
 */
async function openForm(orderId: string, form: CheckoutForm, keep: boolean): Promise<void> {
  const box = document.getElementById('pb-form');
  const btn = document.querySelector<HTMLButtonElement>('#pb-buy [data-act="buy"]');
  if (!box) return;
  openOrder = { id: orderId, form, keep, sent: false };
  const rn = form.renew;
  const price = String(rn?.price ?? form.amount / 100);
  box.innerHTML =
    (rn
      ? `<label class="pb-keep"><input type="checkbox" id="pb-keep"${keep ? ' checked' : ''}>` +
        `<span><b>${escapeHtml(tv('pr.keep', { days: rn.days }))}</b>` +
        `<span class="pb-keep-terms">${escapeHtml(tv('pr.keep.terms', { price, date: whenDay(rn.nextAt), days: rn.days }))}</span>` +
        `<span class="pb-keep-terms">${escapeHtml(tv('pr.keep.methods', { methods: renewMethodsText(rn) }))}</span>` +
        (rn.mada ? '' : `<span class="pb-keep-terms">${escapeHtml(t('pr.keep.noMada'))}</span>`) +
        `</span></label>` +
        `<p class="pb-keep-state" id="pb-keep-state" role="status" aria-live="polite">${escapeHtml(t(keep ? 'pr.keep.on' : 'pr.keep.off'))}</p>`
      : '') +
    `<div class="pb-mysr" id="pb-mysr" aria-busy="true"></div>` +
    `<button type="button" class="pb-form-close" data-act="form-close">${escapeHtml(t('pf.close'))}</button>`;
  box.hidden = false;
  if (btn) btn.hidden = true;
  box.querySelector('[data-act="form-close"]')?.addEventListener('click', () => {
    // Unticked on the server too: a form opened again always starts unticked.
    if (openOrder?.keep) void setKeepPro(openOrder.id, false);
    closeForm();
    document.querySelector<HTMLButtonElement>('#pb-buy [data-act="buy"]')?.focus();
  });
  const keepBox = document.getElementById('pb-keep') as HTMLInputElement | null;
  keepBox?.addEventListener('change', async () => {
    const want = keepBox.checked;
    keepBox.disabled = true;
    // The server hears the choice first. Only once it has it is the form opened again to match.
    const ok = openOrder?.id === orderId && (await setKeepPro(orderId, want));
    if (openOrder?.id !== orderId) return;
    if (!ok) {
      keepBox.checked = !want;
      keepBox.disabled = false;
      const st = document.getElementById('pb-keep-state');
      if (st) st.textContent = t('pr.keep.failed');
      return;
    }
    await openForm(orderId, form, want);
    document.getElementById('pb-keep')?.focus();
  });

  let lib: MoyasarForm;
  try {
    lib = await loadMoyasar();
  } catch {
    closeForm();
    sayBuy({ key: 'pb.err.unavailable' });
    return;
  }
  // Closed, or opened for another order, while the script loaded.
  const mount = document.getElementById('pb-mysr');
  if (!mount || openOrder?.id !== orderId || openOrder.keep !== keep) return;
  mount.removeAttribute('aria-busy');
  try {
    lib.init({
      element: mount,
      language: getLang(),
      amount: form.amount,
      currency: form.currency,
      description: form.description,
      publishable_api_key: form.publishableKey,
      callback_url: form.callbackUrl,
      // The payment's id is the server's choice: it looks for exactly this payment afterwards.
      given_id: form.givenId,
      metadata: { order_id: orderId },
      methods: form.methods,
      supported_networks: form.networks,
      fixed_width: false,
      credit_card: { save_card: keep },
      ...(form.applePay
        ? { apple_pay: { country: form.applePay.country, label: form.applePay.label, validate_merchant_url: 'https://api.moyasar.com/v1/applepay/initiate', save_card: keep } }
        : {}),
      ...(form.samsungPay
        ? { samsung_pay: { service_id: form.samsungPay.serviceId, order_number: form.samsungPay.orderNumber, country: 'SA', label: 'TifoMaker', environment: 'PRODUCTION', save_card: keep } }
        : {}),
      // Moyasar has made a payment (it may still need the bank's 3-D Secure page): the
      // server is told the order was used, before the form sends the fan anywhere.
      on_completed: async () => {
        if (openOrder?.id === orderId) openOrder.sent = true;
        await markPayAttempt(orderId);
      },
      on_failure: async () => {
        // The form shows its own error. If a payment was already made for this order, the order
        // is spent (one payment per order): close the form, and the next press starts a new one.
        if (openOrder?.id === orderId && openOrder.sent) {
          closeForm();
          void watchOrder(orderId, true, true);
        }
      },
    });
  } catch {
    closeForm();
    sayBuy({ key: 'pb.err.unavailable' });
  }
}

/** Each way a payment can fail has its own words; all of them say nothing was charged. */
const FAIL_KEYS: Record<PayFail, string> = {
  auth: 'pf.fail.auth', cancelled: 'pf.fail.cancelled', unavailable: 'pf.fail.unavailable', rejected: 'pf.fail.rejected',
  error: 'pf.fail.error', funds: 'pf.fail.funds', expired_card: 'pf.fail.expired', declined: 'pf.fail.declined',
};

/** The one-click link from a renewal email (/pro?stop=...): turn auto-renew off and say so. */
async function stopByLink(token: string): Promise<void> {
  paidMsg = { key: 'pr.stop.working', tone: 'wait' };
  paintPaid();
  const r = await stopRenewalByLink(token);
  paidMsg = r
    ? { key: r.endsAt ? 'pr.stop.done' : 'pr.stop.doneNoDate', vars: r.endsAt ? { date: whenDay(r.endsAt) } : undefined, tone: 'ok' }
    : { key: 'pr.stop.failed', tone: 'bad' };
  paintPaid();
}

function paintPaid(): void {
  const box = document.getElementById('pp-paid');
  if (!box) return;
  box.hidden = !paidMsg;
  if (!paidMsg) return;
  box.dataset.tone = paidMsg.tone;
  box.textContent = tv(paidMsg.key, paidMsg.vars ?? {});
}

const pause = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Back from Moyasar's page with /pro?order=...: ask until the order is paid
 * (the server asks Moyasar each time), failed, or a minute has gone by. The
 * order's id leaves the address bar at once, so a reload or a shared link
 * does not ask again.
 */
async function watchOrder(id: string, back: boolean, declined = false): Promise<void> {
  paidMsg = { key: 'pb.checking', tone: 'wait' };
  paintPaid();
  const started = Date.now();
  // "Back" on Moyasar's page: one look is enough (it may have been paid in another tab).
  // The form said the payment failed: a few looks, for the server to hear why.
  const limit = declined ? 8000 : back ? 0 : 60_000;
  for (let i = 0; i === 0 || Date.now() - started < limit; i++) {
    const o = await fetchOrder(id);
    if (o?.status === 'paid') {
      track('pro_paid');
      forgetPro();
      closeForm();
      // "Keep Pro on" was ticked: say whether it took. A method that cannot renew leaves a one-time pass.
      paidMsg = { key: o.kept ? (o.renews ? 'pr.paid.renews' : 'pr.paid.once') : 'pb.paid', vars: { date: o.endsAt ? whenDay(o.endsAt) : '' }, tone: 'ok' };
      await load(true);
      paintPaid();
      return;
    }
    if (o && (o.status === 'failed' || o.status === 'expired')) {
      paidMsg = { key: (o.why && FAIL_KEYS[o.why]) || 'pb.failed', tone: 'bad' };
      paintPaid();
      return;
    }
    if (back && !declined) break;
    await pause(i < 6 ? 1500 : 4000);
  }
  paidMsg = declined ? { key: 'pb.failed', tone: 'bad' } : back ? { key: 'pb.left', tone: 'wait' } : { key: 'pb.slow', tone: 'wait' };
  paintPaid();
}

/** "3 a week"; "10 a day" over "150 a month", one window to a line. */
function limitHtml(l: PlanLimits[AllowanceKind] | undefined): string {
  if (!l?.length) return escapeHtml(t('pp.notIncluded'));
  return l.map((w) => `<span>${escapeHtml(tv(`pp.per.${w.period}`, { n: w.limit }))}</span>`).join('');
}

const ROWS: AllowanceKind[] = ['std', 'polish', 'cutout', 'photo'];

/** What only Pro has, in the order the Pro column lists it. */
const PERK_ROWS = ['pp.row.mark', 'pp.row.video', 'pp.row.poster', 'pp.row.styles', 'pp.row.fonts', 'pp.row.led', 'pp.row.kit', 'pp.row.badge'];

/**
 * The allowances worth a row: those where Pro gives more than Free. A kind
 * Pro gives no more of (Stadium from a photo, while it is off the Pro list:
 * server/src/proPlan PHOTO_ON_PRO) is not something Pro adds, so neither card
 * lists it.
 */
function rowsFor(lim: { free: PlanLimits; pro: PlanLimits } | undefined): AllowanceKind[] {
  return ROWS.filter((k) => JSON.stringify(lim?.pro[k] ?? null) !== JSON.stringify(lim?.free[k] ?? null));
}

function planCard(o: { id: string; name: string; head: string; limits: PlanLimits | undefined; pro: boolean; rows: AllowanceKind[] }): string {
  const rows = o.rows.map((k) => `<li><span>${escapeHtml(t(`pp.row.${k}`))}</span><b class="pp-lim">${limitHtml(o.limits?.[k])}</b></li>`);
  const yes = `<b class="pp-yes">${CROWN_SVG}<span>${escapeHtml(t('pp.included'))}</span></b>`;
  const no = `<b class="pp-no">${escapeHtml(t('pp.notIncluded'))}</b>`;
  for (const k of PERK_ROWS) rows.push(`<li><span>${escapeHtml(t(k))}</span>${o.pro ? yes : no}</li>`);
  rows.push(`<li><span>${escapeHtml(t('pp.row.free'))}</span><b>${escapeHtml(t('pp.unlimited'))}</b></li>`);
  return (
    `<article class="pp-plan${o.pro ? ' pro' : ''}" aria-labelledby="pp-plan-${o.id}">` +
    // The crown alone: the card's own name already says Pro.
    `<h2 id="pp-plan-${o.id}">${escapeHtml(o.name)}${o.pro ? ` <span class="pro-chip icon" aria-hidden="true">${CROWN_SVG}</span>` : ''}</h2>` +
    o.head +
    `<ul class="pp-rows">${rows.join('')}</ul></article>`
  );
}

// ----------------------------------------------------- the price question ---

const currencyNow = (): PriceCurrency => pickedCurrency ?? answer?.currency ?? defaultCurrency();

/** The Pro card's head: the question, or the answer given and a way to change it. */
function askHtml(): string {
  if (answer && !changing) {
    // Told first: signed in, answering put them on the list. Signed out, the
    // "Sign in to be told" button below says how.
    const after = state?.signedIn && (told || state.notified) ? `<p class="ps-after">${escapeHtml(t('ps.told'))}</p>` : '';
    return (
      `<div class="ps-ask ps-done" id="ps-ask">` +
      `<p class="ps-thanks" role="status">${escapeHtml(thanksText(answer))}</p>${after}` +
      `<button type="button" class="ps-change" data-act="change">${escapeHtml(t('ps.change'))}</button>` +
      `</div>`
    );
  }
  const cur = currencyNow();
  const radio = (c: PriceCurrency) =>
    `<label><input type="radio" name="ps-cur" value="${c}"${c === cur ? ' checked' : ''}><span>${escapeHtml(t(`ps.cur.${c}`))}</span></label>`;
  const picks = QUICK_PICKS[cur]
    .map((n) => `<button type="button" class="ps-pick" data-pick="${n}" aria-pressed="false">${escapeHtml(priceText(n, cur))}</button>`)
    .join('');
  return (
    `<form class="ps-ask" id="ps-ask" novalidate>` +
    `<p class="ps-q" id="ps-q">${escapeHtml(t('ps.ask'))}</p>` +
    `<p class="ps-sub">${escapeHtml(t('ps.ask.sub'))}</p>` +
    `<fieldset class="ps-cur"><legend class="ps-label">${escapeHtml(t('ps.currency'))}</legend>${radio('SAR')}${radio('USD')}</fieldset>` +
    `<div class="ps-picks" role="group" aria-labelledby="ps-q">${picks}</div>` +
    `<label class="ps-field"><span class="ps-label">${escapeHtml(t('ps.amount.own'))}</span>` +
    `<input id="ps-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" maxlength="7" dir="ltr" aria-describedby="ps-msg"></label>` +
    `<label class="ps-field"><span class="ps-label">${escapeHtml(t('ps.comment'))}</span>` +
    `<textarea id="ps-comment" name="comment" rows="2" maxlength="200" placeholder="${escapeHtml(t('ps.comment.ph'))}"></textarea></label>` +
    `<div class="ps-sends">` +
    `<button type="submit" class="pp-btn" id="ps-send">${escapeHtml(t('ps.send'))}</button>` +
    `<button type="button" class="ps-wont" id="ps-wont">${escapeHtml(t('ps.wont'))}</button>` +
    `</div>` +
    `<p class="ps-msg" id="ps-msg" role="status" aria-live="polite"></p>` +
    `<p class="ps-private">${escapeHtml(t('ps.nocharge'))}</p>` +
    `</form>`
  );
}

/** The quick amount matching what is in the box is the one shown chosen. */
function markPick(box: HTMLElement, value: string): void {
  const n = readAmount(value);
  box.querySelectorAll<HTMLButtonElement>('.ps-pick').forEach((b) => b.setAttribute('aria-pressed', String(n !== null && Number(b.dataset.pick) === n)));
}

function wireAsk(kept: { amount: string; comment: string } | null): void {
  const box = $('ps-ask');
  if (!box) return;
  box.querySelector('[data-act="change"]')?.addEventListener('click', () => {
    changing = true;
    paintPlans(null);
    const amount = $<HTMLInputElement>('ps-amount');
    amount.value = answer && !answer.wontPay ? String(answer.amount) : '';
    $<HTMLTextAreaElement>('ps-comment').value = answer?.comment ?? '';
    markPick($('ps-ask'), amount.value);
    amount.focus();
  });
  if (!(box instanceof HTMLFormElement)) return;
  const amount = $<HTMLInputElement>('ps-amount');
  const comment = $<HTMLTextAreaElement>('ps-comment');
  const msg = $('ps-msg');
  const send = $<HTMLButtonElement>('ps-send');
  const wont = $<HTMLButtonElement>('ps-wont');
  if (kept) {
    amount.value = kept.amount;
    comment.value = kept.comment;
    markPick(box, amount.value);
  }
  box.querySelectorAll<HTMLInputElement>('input[name="ps-cur"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      pickedCurrency = r.value as PriceCurrency;
      // The quick amounts are the currency's own: paint them again, keeping what was typed.
      paintPlans({ amount: amount.value, comment: comment.value });
      (document.querySelector(`input[name="ps-cur"][value="${pickedCurrency}"]`) as HTMLInputElement | null)?.focus();
    }));
  box.querySelectorAll<HTMLButtonElement>('.ps-pick').forEach((b) =>
    b.addEventListener('click', () => {
      amount.value = b.dataset.pick ?? '';
      amount.removeAttribute('aria-invalid');
      msg.textContent = '';
      markPick(box, amount.value);
    }));
  amount.addEventListener('input', () => {
    amount.removeAttribute('aria-invalid');
    msg.textContent = '';
    markPick(box, amount.value);
  });

  const submit = async (wontPay: boolean): Promise<void> => {
    const n = wontPay ? 0 : readAmount(amount.value);
    if (n === null) {
      amount.setAttribute('aria-invalid', 'true');
      msg.textContent = t('ps.err.amount');
      amount.focus();
      return;
    }
    const busy = wontPay ? wont : send;
    const label = busy.textContent ?? '';
    send.disabled = wont.disabled = true;
    busy.textContent = t('ps.sending');
    msg.textContent = '';
    const r = await sendPriceAnswer({ amount: n, currency: currencyNow(), comment: comment.value.trim() || null, wontPay, lang: getLang(), source: 'page' });
    if (!r.ok) {
      send.disabled = wont.disabled = false;
      busy.textContent = label;
      msg.textContent = t(r.reason === 'pace' ? 'ps.err.pace' : r.reason === 'full' ? 'ps.err.full' : 'ps.err.failed');
      return;
    }
    track('pro_price');
    if (!answer) answered++;
    answer = r.answer;
    told = r.told;
    if (told && state) state.notified = true;
    changing = false;
    paint();
    // Focus follows the form it replaced, onto the change button beside the thanks.
    ($('ps-ask')?.querySelector('[data-act="change"]') as HTMLElement | null)?.focus();
  };
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit(false);
  });
  wont.addEventListener('click', () => void submit(true));
}

// --------------------------------------------------------------- painting ---

/** The two cards. `kept` carries what was typed across a repaint (a language switch). */
function paintPlans(kept: { amount: string; comment: string } | null): void {
  const st = state;
  const lim = st?.soon?.limits ?? st?.offer?.limits;
  const days = st?.soon?.monthly.days ?? st?.offer?.monthly.days ?? 30;
  const rows = rowsFor(lim);
  const sale = onSale();
  setSaleCopy(sale);
  $('pp-plans').innerHTML =
    planCard({
      id: 'free', name: t('pp.free.name'), limits: lim?.free, pro: false, rows,
      head: `<p class="pp-price">${escapeHtml(t('ps.free.price'))}</p><p class="pp-sub">${escapeHtml(t('pp.free.sub'))}</p>`,
    }) +
    planCard({
      id: 'pro', name: t('pp.pro.name'), limits: lim?.pro, pro: true, rows,
      // On sale, the price box says the days and that it ends by itself: the line above it would say it twice.
      head: sale ? buyHtml() : `<p class="pp-sub">${escapeHtml(tv('pp.pro.sub', { days }))}</p>${askHtml()}`,
    });
  if (sale) wireBuy();
  else wireAsk(kept);
}

function paint(): void {
  if (!loaded) return;
  const st = state;
  // What was typed survives a repaint, so switching language loses nothing.
  const amountNow = document.getElementById('ps-amount') as HTMLInputElement | null;
  const commentNow = document.getElementById('ps-comment') as HTMLTextAreaElement | null;
  paintPlans(amountNow && commentNow ? { amount: amountNow.value, comment: commentNow.value } : null);
  $('pp-crown').innerHTML = CROWN_SVG;
  paintPaid();
  const count = $('ps-count');
  // The count is about the price question, which steps aside once Pro is on sale.
  count.hidden = answered < SHOW_COUNT_FROM || onSale();
  count.textContent = count.hidden ? '' : tv('ps.count', { n: answered });

  // Someone in the preview: a pass running, a gift waiting, or neither.
  const you = $('pp-you');
  const plan = st?.live ? (st.plan ?? 'free') : 'free';
  const holder = !!st?.live && !!st.pass && plan !== 'free';
  if (holder && st?.pass) {
    you.hidden = false;
    you.innerHTML =
      `${CROWN_SVG}<span>${escapeHtml(tv('pp.youHave', { plan: t(`ac.pro.plan.${plan}`), date: endsText(st.pass.endsAt) }))}</span>` +
      `<a href="${escapeHtml(localPath('/account'))}#pro">${escapeHtml(t('ac.pro.title'))}</a>`;
  } else {
    you.hidden = true;
  }
  // A pass running: nothing to ask to be told about.
  const act = $('pp-act');
  act.hidden = holder;
  if (holder) return;
  const note = $('pp-act-note');
  const row = $('pp-act-row');
  const msg = $('pp-msg');
  msg.textContent = '';
  // On sale, buying is in the Pro column: this row only keeps a gift waiting to be started.
  if (onSale()) {
    act.hidden = !(st?.live && st.gift?.state === 'offered');
    if (act.hidden) return;
  }
  if (!st?.signedIn) {
    note.textContent = t('pp.closed');
    row.innerHTML = `<button type="button" class="pp-btn quiet" data-act="signin">${escapeHtml(t('pp.signInToNotify'))}</button>`;
    row.querySelector('[data-act="signin"]')!.addEventListener('click', () => void signIn());
    return;
  }
  if (st.live && st.gift?.state === 'offered') {
    note.textContent = tv('ac.pro.giftWaiting', { n: st.gift.days });
    row.innerHTML = `<button type="button" class="pp-btn quiet" data-act="gift">${escapeHtml(t('pro.act.useGift'))}</button>`;
    row.querySelector('[data-act="gift"]')!.addEventListener('click', async () => {
      if (await openGiftSheet(st)) await load(true);
    });
    return;
  }
  note.textContent = t('pp.closed');
  row.innerHTML = `<button type="button" class="pp-btn quiet" data-act="notify"${st.notified ? ' disabled' : ''}>${escapeHtml(t(st.notified ? 'pro.act.notified' : 'pro.act.notify'))}</button>`;
  const btn = row.querySelector('[data-act="notify"]') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (await notifyPro()) {
      track('pro_notify');
      if (state) state.notified = true;
      btn.textContent = t('pro.act.notified');
      msg.textContent = t('pro.notify.done');
    } else {
      btn.disabled = false;
      msg.textContent = t('pro.notify.failed');
    }
  });
}

async function load(fresh = false): Promise<void> {
  const first = !loaded;
  const [st, mine] = await Promise.all([fetchPro(fresh).catch(() => null), fetchPriceAnswer()]);
  state = st;
  // A fresh load (after signing in) shows the account's answer, or this browser's.
  answer = mine?.answer ?? null;
  answered = mine?.answered ?? 0;
  changing = false;
  loaded = true;
  $('pp-plans').removeAttribute('aria-busy');
  paint();
  if (first) track('pro_viewed');
}

async function refreshAuth(): Promise<void> {
  const me = await fetchMe().catch(() => null);
  const named = await ensureUsernameChosen(me);
  if (named) {
    authBtn.removeAttribute('data-i18n');
    authBtn.textContent = `@${named.username}`;
    authBtn.classList.add('is-user');
    authBtn.onclick = () => location.assign(localPath('/account'));
  } else {
    authBtn.setAttribute('data-i18n', 'ed.signup');
    authBtn.textContent = t('ed.signup');
    authBtn.classList.remove('is-user');
    authBtn.onclick = () => void signIn();
  }
}

async function signIn(): Promise<void> {
  const { openAuthModal } = await import('./ui/authModal');
  if (!(await openAuthModal(true, 'signin'))) return;
  await refreshAuth();
  await load(true);
}

// ------------------------------------------------------------------ boot ---

initLang();
cleanAddressBar();
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
applyDom(document);
installMobileNav();
installConsent();

const langToggle = $('lang-toggle');
langToggle.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  langToggle.textContent = t('common.language');
});
onLangChange(() => {
  setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
  paint();
});
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});

/**
 * Back from Moyasar's page or form (paid, failed, or "Back" pressed there): the
 * order to ask after, taken out of the address bar straight away. Moyasar adds
 * the payment's id, status and message to the address; they leave the bar with
 * the rest and are never read: the server asks Moyasar what happened.
 */
const returned = ((): { id: string; back: boolean } | null => {
  try {
    const u = new URL(location.href);
    const id = u.searchParams.get('order');
    if (!id) return null;
    const back = u.searchParams.get('back') === '1';
    for (const k of ['order', 'back', 'id', 'status', 'message']) u.searchParams.delete(k);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    return /^[0-9a-f-]{36}$/i.test(id) ? { id, back } : null;
  } catch {
    return null;
  }
})();

/** The one-click cancel link from a renewal email, taken out of the address bar the same way. */
const stopToken = ((): string | null => {
  try {
    const u = new URL(location.href);
    const tok = u.searchParams.get('stop');
    if (!tok) return null;
    u.searchParams.delete('stop');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    return /^[A-Za-z0-9_-]{24,64}$/.test(tok) ? tok : null;
  } catch {
    return null;
  }
})();

// Back to this page from the bank's page with the browser's Back button: the form
// that was open belongs to an order already used. Start clean.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && openOrder) {
    closeForm();
    void load(true);
  }
});

void (async () => {
  await adoptProviderSession();
  await refreshAuth();
  if (authBtn.parentElement) mountProChip(authBtn.parentElement, authBtn);
  await load();
  if (returned) void watchOrder(returned.id, returned.back);
  else if (stopToken) void stopByLink(stopToken);
})();
