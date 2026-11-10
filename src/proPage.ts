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
  adoptProviderSession, fetchMe, fetchPriceAnswer, fetchPro, notifyPro, sendPriceAnswer,
  type AllowanceKind, type PlanLimits, type PriceAnswer, type PriceCurrency, type ProState,
} from './net/api';
import { CROWN_SVG, endsText, mountProChip } from './ui/pro';
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
  $('pp-plans').innerHTML =
    planCard({
      id: 'free', name: t('pp.free.name'), limits: lim?.free, pro: false, rows,
      head: `<p class="pp-price">${escapeHtml(t('ps.free.price'))}</p><p class="pp-sub">${escapeHtml(t('pp.free.sub'))}</p>`,
    }) +
    planCard({
      id: 'pro', name: t('pp.pro.name'), limits: lim?.pro, pro: true, rows,
      head: `<p class="pp-sub">${escapeHtml(tv('pp.pro.sub', { days }))}</p>${askHtml()}`,
    });
  wireAsk(kept);
}

function paint(): void {
  if (!loaded) return;
  const st = state;
  // What was typed survives a repaint, so switching language loses nothing.
  const amountNow = document.getElementById('ps-amount') as HTMLInputElement | null;
  const commentNow = document.getElementById('ps-comment') as HTMLTextAreaElement | null;
  paintPlans(amountNow && commentNow ? { amount: amountNow.value, comment: commentNow.value } : null);
  $('pp-crown').innerHTML = CROWN_SVG;
  const count = $('ps-count');
  count.hidden = answered < SHOW_COUNT_FROM;
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

void (async () => {
  await adoptProviderSession();
  await refreshAuth();
  if (authBtn.parentElement) mountProChip(authBtn.parentElement, authBtn);
  await load();
})();
