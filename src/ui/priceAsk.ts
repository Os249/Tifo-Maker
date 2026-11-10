/**
 * "You're one of TifoMaker's founding fans": the price question, asked once
 * in the editor (10 Nov 2026).
 *
 * The /pro page asks everyone what a month of Pro is worth, but fans spend
 * their time here, not there, and in its first days hardly anyone opened it.
 * So a signed-in fan who opens a project gets this card once: a few lines on
 * what Pro is and that it is not on sale, quick amounts that answer in one
 * tap, "Other amount", "Not for me", and a link to /pro for the details.
 * Signed in only: an account's answer is one answer, and answering puts the
 * fan on the "hear first when Pro opens" list, as the card says.
 *
 * Like the news cards (whatsNew.ts) it does not interrupt: a card in the
 * corner, not a dialog; the canvas keeps working; it waits behind the
 * onboarding dialog, the tour and Match Day. It does not come back once
 * answered (here or on /pro). "Not now", the X or Escape put it off for two
 * weeks, and after the second time it is not asked again in this browser.
 * No quick amount is chosen for anyone: the amounts are buttons that send.
 *
 * Lazily loaded (main.ts), so its strings live in its own chunk, not the
 * editor's start chunk.
 */
import './priceAsk.css';
import { track } from '../net/analytics';
import { fetchMeOnce, fetchPriceAnswer, isSignedIn, sendPriceAnswer, type PriceCurrency } from '../net/api';
import { escapeHtml } from '../core/escape';
import { getLang, localPath, t } from './i18n';
import { CROWN_SVG } from './crown';
import { QUICK_PICKS, defaultCurrency, priceText, readAmount, thanksText } from './priceQuestion';

const KEY = 'tifo_price_ask_v1';
/** "Not now" puts it off this long. */
const LATER_MS = 14 * 24 * 3600_000;
/** After this many "Not now"s it is not asked again in this browser. */
const LATER_MAX = 2;

interface Later {
  n: number;
  until: number;
}

function laterState(): Later | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Later> | null;
    return v && typeof v.n === 'number' && typeof v.until === 'number' ? { n: v.n, until: v.until } : null;
  } catch {
    return null;
  }
}

/** Put off, or (once answered) done for good. */
function putOff(done: boolean): void {
  const was = laterState();
  const n = done ? LATER_MAX : (was?.n ?? 0) + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify({ n, until: Date.now() + LATER_MS }));
  } catch {
    /* storage blocked: it may be asked again on a later visit */
  }
}

function due(): boolean {
  const l = laterState();
  return !l || (l.n < LATER_MAX && Date.now() > l.until);
}

/** Something else has the screen, and this can wait for it. */
function screenBusy(): boolean {
  return !!document.querySelector('.tour-overlay, .mds-overlay, .dlg-backdrop, .news-card, .modal-backdrop');
}

export interface PriceAskOptions {
  /** The guided first tifo is running: wait for it. */
  busy?: () => boolean;
}

/**
 * Ask, if this fan is due to be asked. Resolves true when the card is on its
 * way (so the caller shows no other card this visit), false otherwise.
 */
export async function offerPriceAsk(opts: PriceAskOptions = {}): Promise<boolean> {
  if (!isSignedIn() || !due()) return false;
  const me = await fetchMeOnce().catch(() => null);
  if (!me) return false;
  const mine = await fetchPriceAnswer();
  // Answered already, here or on /pro; or the server could not say: not now.
  if (!mine || mine.answer) {
    if (mine?.answer) putOff(true);
    return false;
  }
  let waited = 0;
  const wait = (): void => {
    if (screenBusy() || opts.busy?.()) {
      // Two minutes is longer than anyone spends on the onboarding dialog.
      waited += 700;
      if (waited < 120000) window.setTimeout(wait, 700);
      return;
    }
    show();
  };
  // A moment after the editor settles, so it is read rather than lost in the load.
  window.setTimeout(wait, 1500);
  return true;
}

function show(): void {
  if (document.getElementById('pa-card')) return;
  let currency: PriceCurrency = defaultCurrency();
  const card = document.createElement('div');
  card.id = 'pa-card';
  card.className = 'pa-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'pa-title');
  document.body.appendChild(card);
  track('pro_ask_seen');

  let open = true;
  const close = (answered: boolean): void => {
    if (!open) return;
    open = false;
    putOff(answered);
    document.removeEventListener('keydown', onKey);
    card.classList.add('out');
    window.setTimeout(() => card.remove(), 160);
  };
  function onKey(e: KeyboardEvent): void {
    // Escape belongs to whatever is on top of this, when something is.
    if (e.key === 'Escape' && !screenBusy()) close(false);
  }
  document.addEventListener('keydown', onKey);

  const proHref = escapeHtml(localPath('/pro'));
  const paint = (): void => {
    const picks = QUICK_PICKS[currency]
      .map((n) => `<button type="button" class="pa-pick" data-pick="${n}">${escapeHtml(priceText(n, currency))}</button>`)
      .join('');
    const cur = (c: PriceCurrency) =>
      `<button type="button" class="pa-cur-b" data-cur="${c}" aria-pressed="${c === currency}">${escapeHtml(t(`ps.cur.${c}`))}</button>`;
    card.innerHTML =
      `<button type="button" class="pa-x" aria-label="${escapeHtml(t('pa.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>` +
      `<div class="pa-head"><span class="pa-crown" aria-hidden="true">${CROWN_SVG}</span><span class="pa-tag">${escapeHtml(t('pa.tag'))}</span></div>` +
      `<h3 class="pa-title" id="pa-title">${escapeHtml(t('pa.title'))}</h3>` +
      `<p class="pa-body">${escapeHtml(t('pa.body'))}</p>` +
      `<div class="pa-cur" role="group" aria-label="${escapeHtml(t('ps.currency'))}">${cur('SAR')}${cur('USD')}</div>` +
      `<div class="pa-picks" role="group" aria-labelledby="pa-title">${picks}` +
      `<button type="button" class="pa-pick pa-other" aria-expanded="false" aria-controls="pa-own">${escapeHtml(t('pa.other'))}</button></div>` +
      `<form class="pa-own" id="pa-own" hidden novalidate>` +
      `<input id="pa-amount" type="text" inputmode="decimal" autocomplete="off" maxlength="7" dir="ltr" aria-label="${escapeHtml(t('ps.amount.own'))}" aria-describedby="pa-msg">` +
      `<button type="submit" class="pa-send">${escapeHtml(t('pa.send'))}</button></form>` +
      `<p class="pa-msg" id="pa-msg" role="status" aria-live="polite"></p>` +
      `<div class="pa-foot"><button type="button" class="pa-wont">${escapeHtml(t('ps.wont'))}</button>` +
      `<a class="pa-more" href="${proHref}" target="_blank" rel="noopener">${escapeHtml(t('pa.more'))}</a>` +
      `<button type="button" class="pa-later">${escapeHtml(t('pa.later'))}</button></div>` +
      `<p class="pa-note">${escapeHtml(t('pa.nocharge'))}</p>`;
    wire();
  };

  const q = <T extends HTMLElement>(s: string): T => card.querySelector(s) as T;
  const send = async (amount: number, wontPay: boolean): Promise<void> => {
    const msg = q('#pa-msg');
    card.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { if (!b.classList.contains('pa-x')) b.disabled = true; });
    msg.textContent = t('ps.sending');
    const r = await sendPriceAnswer({ amount, currency, comment: null, wontPay, lang: getLang(), source: 'editor' });
    if (!r.ok) {
      card.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = false; });
      msg.textContent = t(r.reason === 'pace' ? 'ps.err.pace' : r.reason === 'full' ? 'ps.err.full' : 'ps.err.failed');
      return;
    }
    track('pro_price');
    putOff(true);
    card.innerHTML =
      `<button type="button" class="pa-x" aria-label="${escapeHtml(t('pa.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>` +
      `<div class="pa-head"><span class="pa-crown" aria-hidden="true">${CROWN_SVG}</span><span class="pa-tag">${escapeHtml(t('pa.tag'))}</span></div>` +
      `<p class="pa-thanks" role="status">${escapeHtml(thanksText(r.answer))}</p>` +
      (r.told ? `<p class="pa-body">${escapeHtml(t('ps.told'))}</p>` : '') +
      `<div class="pa-foot"><a class="pa-more" href="${proHref}" target="_blank" rel="noopener">${escapeHtml(t('pa.more'))}</a></div>`;
    q('.pa-x').addEventListener('click', () => close(true));
    q<HTMLElement>('.pa-x').focus();
    // The thanks has been said; it goes by itself after a while.
    window.setTimeout(() => close(true), 9000);
  };

  function wire(): void {
    q('.pa-x').addEventListener('click', () => close(false));
    q('.pa-later').addEventListener('click', () => close(false));
    q('.pa-wont').addEventListener('click', () => void send(0, true));
    card.querySelectorAll<HTMLButtonElement>('.pa-cur-b').forEach((b) =>
      b.addEventListener('click', () => {
        currency = b.dataset.cur as PriceCurrency;
        paint();
        (card.querySelector(`.pa-cur-b[data-cur="${currency}"]`) as HTMLElement | null)?.focus();
      }));
    card.querySelectorAll<HTMLButtonElement>('.pa-pick:not(.pa-other)').forEach((b) =>
      b.addEventListener('click', () => void send(Number(b.dataset.pick), false)));
    const other = q<HTMLButtonElement>('.pa-other');
    const own = q<HTMLFormElement>('#pa-own');
    const amount = q<HTMLInputElement>('#pa-amount');
    other.addEventListener('click', () => {
      own.hidden = false;
      other.setAttribute('aria-expanded', 'true');
      amount.focus();
    });
    amount.addEventListener('input', () => {
      amount.removeAttribute('aria-invalid');
      q('#pa-msg').textContent = '';
    });
    own.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = readAmount(amount.value);
      if (n === null) {
        amount.setAttribute('aria-invalid', 'true');
        q('#pa-msg').textContent = t('ps.err.amount');
        amount.focus();
        return;
      }
      void send(n, false);
    });
  }

  paint();
}
