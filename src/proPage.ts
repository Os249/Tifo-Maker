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
 *
 * The three plans (22 Nov 2026): when the server says so (offer.plans, its
 * PRO_THREE_PLANS), the page is one price list instead of Free against Pro:
 * the match pass, the month and the year, each with its own button
 * (proPlansView.ts, loaded only then). Who may buy, the sign-in, the form and
 * the return from Moyasar are the same code as before; only what is drawn
 * changes. With the switch off, nothing here is different.
 */
import { cleanAddressBar } from './core/utm';
import { track } from './net/analytics';
import './vendor/tabler-subset.css';
import './community.css';
import './proPage.css';
import { initLang, applyDom, getLang, localPath, onLangChange, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { initSiteHeader, setHeaderUser } from './ui/siteHeader';
import { installConsent } from './ui/consent';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { escapeHtml } from './core/escape';
import {
  adoptProviderSession, fetchMe, fetchOrder, fetchPriceAnswer, fetchPro, forgetPro, markPayAttempt, notifyPro, sendPriceAnswer, setKeepPro,
  asProProduct, startCheckout, stopProMail, stopRenewalByLink,
  type AllowanceKind, type CheckoutForm, type CheckoutRefusal, type PayFail, type PlanLimits, type PriceAnswer, type PriceCurrency, type ProProduct, type ProState,
} from './net/api';
import { CROWN_SVG, endsText, money, proNavOnSale, whenDay, whenRiyadh } from './ui/pro';
import { QUICK_PICKS, defaultCurrency, priceText, readAmount, thanksText } from './ui/priceQuestion';
import { openGiftSheet } from './ui/proSheets';
import { SALE_KEYS, keysOf, saleKey } from './ui/proSaleCopy';
import { getPressed, offerSeen, orderSrc, planPicked, plansSeen, readArrival } from './ui/proWhere';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Where this visit to /pro came from (a Get Pro link on Post it, the export
 * sheet, the card after the gift...) and which of the two things on sale the
 * link was about. Read once and taken out of the address bar; the place goes
 * with the checkout, for /admin's funnel, only for a visitor who allowed counting.
 */
const arrival = ((): ReturnType<typeof readArrival> => {
  try {
    const u = new URL(location.href);
    const a = readArrival(u.search);
    if (u.searchParams.has('from') || u.searchParams.has('plan')) {
      u.searchParams.delete('from');
      u.searchParams.delete('plan');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
    return a;
  } catch {
    return { from: null, plan: 'monthly' as const };
  }
})();

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
/** A year can be bought over Pro that ends within this long (server/src/proPlan YEAR_WITHIN_DAYS): a month still running. */
const YEAR_MS = 37 * 24 * 3600_000;

/** The three-plan page's drawing code (proPlansView.ts), once the server has said this page is that one. */
let plansView: typeof import('./proPlansView') | null = null;
/** The page is the price list: the server says so, Pro can be bought here, and the code for it has arrived. */
const plansMode = (): boolean => !!plansView && !!state?.offer?.plans && onSale();

/** What "Get Pro" last said, kept across repaints as a key and its values. */
let buyMsg: { key: string; vars?: Record<string, string> } | null = null;
/** The return from Moyasar's page, kept the same way. */
let paidMsg: { key: string; vars?: Record<string, string>; tone: 'wait' | 'ok' | 'bad' } | null = null;

/**
 * The words that change when Pro is on sale (ui/proSaleCopy.ts): each element
 * with its coming-soon key and its on-sale key. Found once, before anything
 * swaps them, by whichever of its keys the page arrived with: the server
 * sends the on-sale words itself once Pro is on sale to everyone.
 */
const SALE_COPY: [HTMLElement, string, string][] = SALE_KEYS.flatMap(([soon, sale]) => {
  const el = document.querySelector<HTMLElement>(keysOf(soon, sale).map((k) => `[data-i18n="${k}"]`).join(','));
  return el ? [[el, soon, sale] as [HTMLElement, string, string]] : [];
});
/** The server sent this page as on sale (routes.ts: Pro is on sale to everyone). */
const serverSale = document.getElementById('pp-open')?.classList.contains('on-sale') ?? false;
/**
 * /api/pro did not answer: fetchPro then gives a bare state with neither the
 * coming-soon plans nor an offer, and the server always sends the plans.
 */
const loadFailed = (): boolean => !state?.offer && !state?.soon;
/** Which wording is on the page now: '' (coming soon), or the sale wording with its variants; null until the first paint settles it. */
let saleCopy: string | null = null;

/** Moyasar's form is the checkout here, rather than its hosted page. */
const formCheckout = (): boolean => state?.offer?.checkout === 'form';
/** "Keep Pro on" is offered at checkout. */
const renewOffered = (): boolean => state?.offer?.autoRenew === true;

function setSaleCopy(on: boolean): void {
  const plans = on && plansMode();
  const want = on ? `sale${formCheckout() ? '+form' : ''}${renewOffered() ? '+renew' : ''}${plans ? '+plans' : ''}` : '';
  if (want === saleCopy) return;
  saleCopy = want;
  for (const [el, soon, sale] of SALE_COPY) {
    el.setAttribute('data-i18n', on ? saleKey(sale, { form: formCheckout(), renew: renewOffered(), plans }) : soon);
  }
  // The price list has its own layout (proPage.css #pp-open.plans3, then proPlans.css).
  document.getElementById('pp-open')?.classList.toggle('plans3', plans);
  // The price first, how it works after it (proPage.css), and the questions only a buyer asks.
  document.getElementById('pp-open')?.classList.toggle('on-sale', on);
  // One blue button: while Pro is to buy here, the header's "Sign up" goes quiet (proPage.css).
  document.body.classList.toggle('pp-selling', on);
  for (const id of ['pp-faq-refund', 'pp-faq-who']) {
    const q = document.getElementById(id);
    if (q) q.hidden = !on;
  }
  applyDom(document);
}

/** The month this account holds, when it is a month (paid or given) rather than the gift. */
function monthHeld(): { endsAt: string } | null {
  const p = state?.live ? state.pass : null;
  return p && p.plan === 'monthly' && Date.parse(p.endsAt) > Date.now() ? { endsAt: p.endsAt } : null;
}

/** The founders offer, while this account can still take it (server/src/proLaunch.ts). */
function founderOpen(): { until: string; bonusDays: number; total: number } | null {
  const f = state?.founder;
  return f && f.state === 'open' && Date.parse(f.until) > Date.now() ? f : null;
}

/** The Pro column's head when Pro is on sale: the price, and the one way to buy it. */
function buyHtml(): string {
  const o = state!.offer!;
  const price = money(o.monthly.price);
  const held = monthHeld();
  const renew = !!held && Date.parse(held.endsAt) - Date.now() <= RENEW_MS;
  const founder = state?.signedIn ? founderOpen() : null;
  let act = '';
  // Signed out: the same button with the price on it. It opens sign-up (most visitors from a link have no
  // account), and once signed in the page carries on to the payment by itself (wireBuy).
  if (!state?.signedIn) {
    act = `<button type="button" class="pp-btn" data-act="buy-signin">${escapeHtml(tv('pb.buy', { price }))}</button>` +
      `<p class="pb-note" id="pb-signin-note">${escapeHtml(t('pb.signin.note'))}</p>`;
  }
  // An email not verified yet: the server would refuse the press, so the page says it first, with the way to do it.
  else if (state.emailVerified === false) {
    act = `<p class="pb-note" id="pb-verify">${escapeHtml(t('pb.verify.note'))}</p>` +
      `<a class="pp-btn" data-act="verify" href="${escapeHtml(localPath('/account'))}">${escapeHtml(t('pb.verify.btn'))}</a>`;
  }
  // Holding Pro for longer than a week: come back in its last week. A founder's offer has a deadline, so they may buy now.
  else if (held && !renew && !founder) act = `<p class="pb-note">${escapeHtml(tv('pb.err.held', { date: whenDay(held.endsAt) }))}</p>`;
  else {
    act = `<button type="button" class="pp-btn" data-act="buy">${escapeHtml(tv(held ? 'pb.renew' : 'pb.buy', { price }))}</button>` +
      (held ? `<p class="pb-note">${escapeHtml(t('pb.renewNote'))}</p>` : '');
  }
  const msg = buyMsg ? escapeHtml(tv(buyMsg.key, buyMsg.vars ?? {})) : '';
  // The launch price: by default a price and the day it changes, in plain words. The regular price is shown
  // crossed out only when the server says so, which it does only with a discount licence number to print.
  const l = o.launch;
  const regular = l ? money(l.regular) : '';
  const strike = !!l && l.display === 'strike' && !!l.licence;
  const was = strike ? ` <s class="pb-was" aria-label="${escapeHtml(tv('pb.launch.was', { regular }))}">${escapeHtml(tv('pb.price', { price: regular }))}</s>` : '';
  const launch = l
    ? `<p class="pb-launch" id="pb-launch">${escapeHtml(strike
      ? tv('pb.launch.licence', { date: whenRiyadh(l.until, false), regular, licence: l.licence ?? '' })
      : tv('pb.launch', { date: whenRiyadh(l.until, false), regular }))}</p>`
    : '';
  const offer = founder
    ? `<p class="pb-founder" id="pb-founder">${CROWN_SVG}<span><b>${escapeHtml(tv('pb.founder', { date: whenRiyadh(founder.until) }))}</b>` +
      `${escapeHtml(tv('pb.founder.terms', { total: founder.total, days: o.monthly.days }))}</span></p>`
    : '';
  // The match pass, while it is sold: the same Pro for a match week, under the month and quieter than it.
  // Its whole price, its length, that it is one payment and never renews are all said before the button.
  const mp = o.match;
  let match = '';
  if (mp) {
    const mprice = money(mp.price);
    const mact = !state?.signedIn
      ? `<button type="button" class="pp-btn quiet" data-act="match-signin">${escapeHtml(tv('pm2.buy', { price: mprice }))}</button>`
      : state.emailVerified === false || (held && !renew)
        ? ''
        : `<button type="button" class="pp-btn quiet" data-act="buy-match">${escapeHtml(tv('pm2.buy', { price: mprice }))}</button>`;
    match =
      `<div class="pb-match" id="pb-match"${arrival.plan === 'match' ? ' data-asked="1"' : ''}>` +
      `<p class="pb-match-h"><b>${escapeHtml(t('pm2.title'))}</b> ${escapeHtml(tv('pm2.body', { hours: mp.hours, price: mprice }))}</p>` +
      mact + `</div>`;
  }
  return (
    `<div class="pb-buy" id="pb-buy">` +
    `<p class="pb-price"><b>${escapeHtml(tv('pb.price', { price }))}</b>${was} <span>${escapeHtml(tv('pb.per', { days: o.monthly.days }))}</span></p>` +
    launch +
    `<p class="pb-once">${escapeHtml(t(renewOffered() ? 'pr.once' : 'pb.once'))} ${escapeHtml(t('pb.vat'))}</p>` +
    offer +
    act +
    match +
    // Moyasar's form opens here (openForm), in place of the button.
    `<div class="pb-form" id="pb-form" hidden></div>` +
    `<p class="pb-msg" id="pb-msg" role="status" aria-live="polite">${msg}</p>` +
    `<p class="ps-private">${escapeHtml(t(formCheckout() ? 'pf.methods' : 'pb.methods'))}</p>` +
    // The refund promise, and the terms and a contact a tap away: both are sections of /legal, which holds both languages.
    `<div class="pb-trust"><b>${escapeHtml(t('pb.trust.refund'))}</b>` +
    `<ul class="pb-links" aria-label="${escapeHtml(t('pb.trust.links'))}">` +
    `<li><a href="${escapeHtml(localPath('/legal'))}#${getLang() === 'ar' ? 'terms-ar' : 'terms'}">${escapeHtml(t('pb.trust.terms'))}</a></li>` +
    `<li><a href="${escapeHtml(localPath('/legal'))}#${getLang() === 'ar' ? 'about-ar' : 'about'}">${escapeHtml(t('pb.trust.contact'))}</a></li>` +
    `</ul></div>` +
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

/** "Get Pro" pressed for a plan: an order from the server, then Moyasar's page or its form. The price is the server's. */
async function startBuy(btn: HTMLButtonElement, product: ProProduct): Promise<void> {
  btn.disabled = true;
  const label = btn.textContent ?? '';
  btn.textContent = t(formCheckout() ? 'pf.opening' : 'pb.going');
  getPressed('page');
  const r = await startCheckout(getLang(), { product, src: orderSrc(arrival.from) });
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
}

/** Whether this account may buy this plan now: the server's rule (payments.ts startFor), said before the press. */
function canBuyNow(p: ProProduct): boolean {
  if (!state?.signedIn || state.emailVerified === false) return false;
  const held = monthHeld();
  if (!held) return true;
  const left = Date.parse(held.endsAt) - Date.now();
  // A year may follow a month still running; a month or a match pass waits for the last week (a founder's offer has a deadline).
  if (p === 'year') return left <= YEAR_MS;
  return left <= RENEW_MS || (p === 'monthly' && !!founderOpen());
}

/** The price list's buttons (proPlansView.ts): each plan's own, signed in or out. */
function wirePlans(): void {
  const box = document.getElementById('pb-buy');
  if (!box) return;
  box.querySelectorAll<HTMLButtonElement>('[data-act="buy-signin"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const product = asProProduct(b.dataset.product);
      getPressed('page');
      planPicked('page', product);
      if (!(await signIn('signup'))) return;
      // Signed in. They pressed a plan with its price on it, so the page carries on to the payment when this
      // account can buy it now; otherwise the next step has the focus (the email to verify, or what they hold).
      const next = document.querySelector<HTMLElement>(`#pb-buy [data-act="buy"][data-product="${product}"], #pb-buy [data-act="verify"]`);
      next?.focus();
      if (next?.dataset.act === 'buy' && !monthHeld()) next.click();
    }));
  box.querySelectorAll<HTMLButtonElement>('[data-act="buy"]').forEach((b) =>
    b.addEventListener('click', () => {
      const product = asProProduct(b.dataset.product);
      planPicked('page', product);
      void startBuy(b, product);
    }));
  // A repaint (a language switch) while the form is open: open it again, in the new language.
  if (openOrder) void openForm(openOrder.id, openOrder.form, openOrder.keep);
}

function wireBuy(): void {
  const box = document.getElementById('pb-buy');
  if (!box) return;
  box.querySelector('[data-act="match-signin"]')?.addEventListener('click', async () => {
    getPressed('page');
    if (!(await signIn('signup'))) return;
    const next = document.querySelector<HTMLElement>('#pb-buy [data-act="buy-match"], #pb-buy [data-act="verify"]');
    next?.focus();
    if (next?.dataset.act === 'buy-match') next.click();
  });
  box.querySelector('[data-act="buy-signin"]')?.addEventListener('click', async () => {
    getPressed('page');
    if (!(await signIn('signup'))) return;
    // Signed in. They pressed "Get Pro for SAR ..." with the price on it, so the page carries on to the
    // payment without a second press, when this account can buy now. Otherwise the next step has the
    // focus: the email to verify, or the note saying they already hold Pro.
    const next = document.querySelector<HTMLElement>('#pb-buy [data-act="buy"], #pb-buy [data-act="verify"]');
    next?.focus();
    if (next?.dataset.act === 'buy' && !monthHeld()) next.click();
  });
  const btn = box.querySelector<HTMLButtonElement>('[data-act="buy"]');
  btn?.addEventListener('click', () => void startBuy(btn, 'monthly'));
  const matchBtn = box.querySelector<HTMLButtonElement>('[data-act="buy-match"]');
  matchBtn?.addEventListener('click', () => void startBuy(matchBtn, 'match'));
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
  document.querySelectorAll<HTMLElement>('#pb-buy [data-act="buy"], #pb-match').forEach((el) => { el.hidden = false; });
  // The price list: its buttons come back, and no plan is marked as the one being paid for.
  document.querySelector('.pt-list')?.classList.remove('paying');
  document.querySelectorAll('.pt-col[data-paying]').forEach((el) => el.removeAttribute('data-paying'));
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
  // What is charged now, and what each renewal will be: the two are not always the same price.
  const now = money(form.amount / 100);
  const price = money(rn?.price ?? form.amount / 100);
  const fo = form.founder ?? null;
  box.innerHTML =
    (rn
      ? `<label class="pb-keep"><input type="checkbox" id="pb-keep"${keep ? ' checked' : ''}>` +
        `<span><b>${escapeHtml(tv('pr.keep', { days: rn.days }))}</b>` +
        `<span class="pb-keep-terms" id="pb-keep-terms">${escapeHtml(tv(fo ? 'pr.keep.termsFounder' : 'pr.keep.terms', { now, price, date: whenDay(rn.nextAt), days: rn.days, total: fo?.total ?? rn.days }))}</span>` +
        `<span class="pb-keep-terms">${escapeHtml(tv('pr.keep.methods', { methods: renewMethodsText(rn) }))}</span>` +
        (rn.mada ? '' : `<span class="pb-keep-terms">${escapeHtml(t('pr.keep.noMada'))}</span>`) +
        `</span></label>` +
        `<p class="pb-keep-state" id="pb-keep-state" role="status" aria-live="polite">${escapeHtml(t(keep ? 'pr.keep.on' : 'pr.keep.off'))}</p>`
      : '') +
    `<div class="pb-mysr" id="pb-mysr" aria-busy="true"></div>` +
    `<button type="button" class="pb-form-close" data-act="form-close">${escapeHtml(t('pf.close'))}</button>`;
  box.hidden = false;
  const list = plansMode() ? document.querySelector('.pt-list') : null;
  if (list && plansView && state?.offer) {
    // The price list: every plan's button steps aside (proPlans.css .paying), the plan being paid for stays lit,
    // and the form says above itself what it is for.
    const product = asProProduct(form.product);
    const row = plansView.plansOf(state.offer).find((p) => p.product === product);
    list.classList.add('paying');
    document.querySelectorAll('.pt-col').forEach((el) => el.toggleAttribute('data-paying', (el as HTMLElement).dataset.plan === product));
    if (row) box.insertAdjacentHTML('afterbegin', `<p class="pt-paying" id="pt-paying">${escapeHtml(tv('pt.paying', { what: plansView.planLine(row) }))}</p>`);
  } else if (btn) btn.hidden = true;
  // One thing is being paid for: the other offer steps aside while the form is open.
  const other = document.getElementById('pb-match');
  if (other) other.hidden = true;
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
      track(o.product === 'match' ? 'match_bought' : o.product === 'year' ? 'year_bought' : 'monthly_bought');
      // Paid after the 7 days they were given: the gift did its work.
      if (state?.gift?.state === 'used' && state.gift.auto) track('bought_after_gift');
      forgetPro();
      closeForm();
      // "Keep Pro on" was ticked: say whether it took. A method that cannot renew leaves a one-time pass.
      // A founder's first purchase: the page says the extra month was given, as the receipt does.
      const total = o.bonusDays ? (o.days ?? 0) + o.bonusDays : 0;
      paidMsg = {
        key: o.product === 'match' ? 'pm2.paid' : o.product === 'year' ? 'py.paid' : o.kept ? (o.renews ? 'pr.paid.renews' : 'pr.paid.once') : total ? 'pb.paid.founder' : 'pb.paid',
        vars: { date: o.endsAt ? whenDay(o.endsAt) : '', total: String(total) }, tone: 'ok',
      };
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

const ROWS: AllowanceKind[] = ['std', 'critique', 'cutout', 'photo'];

/** What only Pro has, in the order the Pro column lists it. */
const PERK_ROWS = ['pp.row.mark', 'pp.row.video', 'pp.row.poster', 'pp.row.styles', 'pp.row.fonts', 'pp.row.led', 'pp.row.kit', 'pp.row.badge'];

/**
 * The allowances worth a row: those where Pro gives more than Free. A kind
 * Pro gives no more of (Stadium from a photo, while it is off the Pro list:
 * server/src/proPlan PHOTO_ON_PRO) is not something Pro adds, so neither card
 * lists it.
 */
function rowsFor(lim: { free: PlanLimits; pro: PlanLimits } | undefined, unlisted: AllowanceKind[] = []): AllowanceKind[] {
  // And not a kind the server says not to list (server/src/proPlan UNLISTED: the smart cut-out, 19 Nov 2026).
  return ROWS.filter((k) => !unlisted.includes(k) && JSON.stringify(lim?.pro[k] ?? null) !== JSON.stringify(lim?.free[k] ?? null));
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
  const rows = rowsFor(lim, st?.soon?.unlisted ?? st?.offer?.unlisted);
  // The cut-out's own question goes with its row.
  const cutFaq = document.getElementById('pp-faq-cutout');
  if (cutFaq) cutFaq.hidden = !rows.includes('cutout');
  // The server sent the page as on sale and /api/pro then did not answer: the price is not known, and
  // the page does not fall back to asking what Pro is worth. It says so, with a way to try again.
  if (loadFailed() && serverSale) {
    setSaleCopy(true);
    $('pp-plans').innerHTML =
      `<div class="pp-act" id="pp-load-failed"><p class="pp-act-note" role="alert">${escapeHtml(t('pb.err.load'))}</p>` +
      `<div class="pp-act-row"><button type="button" class="pp-btn" data-act="reload">${escapeHtml(t('common.retry'))}</button></div></div>`;
    $('pp-plans').querySelector('[data-act="reload"]')?.addEventListener('click', () => void load(true));
    return;
  }
  const sale = onSale();
  setSaleCopy(sale);
  if (sale && plansMode() && plansView && st) {
    const held = monthHeld();
    $('pp-plans').innerHTML = plansView.listHtml(st, {
      signedIn: !!st.signedIn, unverified: st.emailVerified === false, heldUntil: held?.endsAt ?? null, canBuy: canBuyNow,
      asked: arrival.plan !== 'monthly' ? arrival.plan : null, msg: buyMsg ? tv(buyMsg.key, buyMsg.vars ?? {}) : '',
      renew: renewOffered(), form: formCheckout(), adding: !!held && canBuyNow('monthly'),
    });
    wirePlans();
    plansView.paintRest(st);
    return;
  }
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
  // (Nor is it shown when the server sent the page as on sale and the price then failed to load.)
  const selling = onSale() || (loadFailed() && serverSale);
  count.hidden = answered < SHOW_COUNT_FROM || selling;
  count.textContent = count.hidden ? '' : tv('ps.count', { n: answered });

  // Someone in the preview: a pass running, a gift waiting, or neither.
  const you = $('pp-you');
  const plan = st?.live ? (st.plan ?? 'free') : 'free';
  const holder = !!st?.live && !!st.pass && plan !== 'free';
  // The price list says what a paid pass holds itself, above the plans; the hero's line is kept for the gift.
  if (holder && st?.pass && !(plansMode() && plan === 'monthly')) {
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
  if (selling) {
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
  // The price list's own code, the first time the server says this page is one. If it cannot be fetched, the page stays as it was.
  if (st?.offer?.plans && st.offer.paymentsOpen && !plansView) plansView = await import('./proPlansView').catch(() => null);
  proNavOnSale(st);
  // A fresh load (after signing in) shows the account's answer, or this browser's.
  answer = mine?.answer ?? null;
  answered = mine?.answered ?? 0;
  changing = false;
  loaded = true;
  $('pp-plans').removeAttribute('aria-busy');
  paint();
  // The question about the 7 days says how they work now: once they start by themselves, "it waits until you press Start" is not true.
  if (state?.offer?.autoGift) {
    for (const [from, to] of [['pp.faq.q6', 'pp.faq.q6auto'], ['pp.faq.a6', 'pp.faq.a6auto']] as const) {
      const el = document.querySelector<HTMLElement>(`[data-i18n="${from}"]`);
      if (el) {
        el.setAttribute('data-i18n', to);
        el.textContent = t(to);
      }
    }
  }
  if (first) track('pro_viewed');
  if (first && state?.offer?.paymentsOpen) offerSeen('page');
  if (first && plansMode()) {
    plansSeen('page');
    // A link that asked for a plan (/pro?plan=year): that plan is in view, with its button ready.
    if (arrival.plan !== 'monthly') {
      const col = document.querySelector<HTMLElement>(`.pt-col[data-plan="${arrival.plan}"]`);
      col?.scrollIntoView({ block: 'center' });
      col?.querySelector<HTMLElement>('.pp-btn')?.focus({ preventScroll: true });
    }
  }
}

async function refreshAuth(): Promise<void> {
  const me = await fetchMe().catch(() => null);
  const named = await ensureUsernameChosen(me);
  // The header draws the account: "Sign up", or a letter that opens the menu.
  setHeaderUser(named);
}

/** The sign-in dialog. True once signed in, with the page painted again for the account. */
async function signIn(startOn: 'signin' | 'signup' = 'signin'): Promise<boolean> {
  const { openAuthModal } = await import('./ui/authModal');
  if (!(await openAuthModal(true, startOn))) return false;
  await refreshAuth();
  await load(true);
  return true;
}

// ------------------------------------------------------------------ boot ---

initLang();
cleanAddressBar();
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
applyDom(document);
initSiteHeader({ onSignIn: () => void signIn() });
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

/** "Stop these emails" from the founders email (/pro?nomail=...), taken out of the address bar the same way. */
const noMailToken = ((): string | null => {
  try {
    const u = new URL(location.href);
    const tok = u.searchParams.get('nomail');
    if (!tok) return null;
    u.searchParams.delete('nomail');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    return /^[A-Za-z0-9_-]{24,64}$/.test(tok) ? tok : null;
  } catch {
    return null;
  }
})();

/** Stop emails about Pro's news and offers, and say so. No sign-in: the link can do nothing else. */
async function stopMailByLink(token: string): Promise<void> {
  paidMsg = { key: 'pb.nomail.working', tone: 'wait' };
  paintPaid();
  paidMsg = (await stopProMail(token)) ? { key: 'pb.nomail.done', tone: 'ok' } : { key: 'pb.nomail.failed', tone: 'bad' };
  paintPaid();
}

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
  await load();
  if (returned) void watchOrder(returned.id, returned.back);
  else if (stopToken) void stopByLink(stopToken);
  else if (noMailToken) void stopMailByLink(noMailToken);
})();
