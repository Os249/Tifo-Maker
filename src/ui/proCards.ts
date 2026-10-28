/**
 * The gift, on My projects: one card at a time, and only when there is news.
 *
 *  - offered: the 7-day gift is waiting. It starts only from the sheet's
 *    button, so the card can say "keep it for a big match week". "Later"
 *    puts it away for three days.
 *  - running, two days or less left: a reminder (day 5, then the last day),
 *    each shown until it is dismissed.
 *  - ended (in the last fortnight): what happens now, once.
 *
 * All of it is read from /api/pro. Dismissing is remembered in this browser
 * only: it is a courtesy, and the worst a cleared browser does is show a card
 * again.
 */
import { fetchPro, isSignedIn, notifyPro, type ProState } from '../net/api';
import { track } from '../net/analytics';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG, whenDate, whenDay } from './pro';
import { onLangChange, t, tv } from './i18n';

const DAY = 24 * 60 * 60 * 1000;
const LATER_KEY = 'tifo_gift_later_v1';
const SEEN_KEY = 'tifo_gift_seen_v1';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the card may show again, which is harmless */
  }
};

type View =
  | { kind: 'offer'; days: number; claimBy: string }
  | { kind: 'remind'; stage: string; last: boolean; endsAt: string }
  | { kind: 'ended'; stage: string };

function viewOf(st: ProState | null, now = Date.now()): View | null {
  const g = st?.live ? st.gift : undefined;
  if (!g) return null;
  if (g.state === 'offered') {
    const later = Number(read(LATER_KEY) ?? 0);
    if (later && now - later < 3 * DAY) return null;
    return { kind: 'offer', days: g.days, claimBy: g.claimBy };
  }
  if (g.state === 'active') {
    const left = Date.parse(g.endsAt) - now;
    if (left <= 0 || left > 2 * DAY) return null;
    const last = left <= DAY;
    const stage = `${last ? 'last' : 'd2'}:${g.endsAt}`;
    return read(SEEN_KEY) === stage ? null : { kind: 'remind', stage, last, endsAt: g.endsAt };
  }
  if (g.state === 'used' && g.endedAt) {
    if (now - Date.parse(g.endedAt) > 14 * DAY) return null;
    const stage = `end:${g.endedAt}`;
    return read(SEEN_KEY) === stage ? null : { kind: 'ended', stage };
  }
  return null;
}

/** Keep the gift card in `host`, before `before`. Hidden unless there is news. */
export function mountGiftCard(host: HTMLElement, before: Element | null): void {
  const card = document.createElement('section');
  card.className = 'pro-card';
  card.hidden = true;
  card.setAttribute('aria-labelledby', 'pro-card-h');
  host.insertBefore(card, before);
  let state: ProState | null = null;

  const paint = (): void => {
    const v = viewOf(state);
    if (!v || !state) {
      card.hidden = true;
      card.innerHTML = '';
      return;
    }
    let title: string;
    let body: string;
    let main: string;
    let quiet: string;
    if (v.kind === 'offer') {
      title = tv('gift.cardTitle', { n: v.days });
      body = `${t('gift.cardBody')} ${tv('gift.claimBy', { date: whenDay(v.claimBy) })}`;
      main = t('gift.accept');
      quiet = t('gift.later');
    } else if (v.kind === 'remind') {
      title = t(v.last ? 'gift.remindLast' : 'gift.remind2');
      body = tv('gift.remindBody', { when: whenDate(v.endsAt) });
      main = t('pro.limit.seePro');
      quiet = t('gift.ok');
    } else {
      title = t('gift.endTitle');
      body = t('gift.endBody');
      main = t(state.notified ? 'pro.act.notified' : 'pro.act.notify');
      quiet = t('gift.ok');
    }
    card.innerHTML =
      `<div class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</div>` +
      `<div><h2 id="pro-card-h">${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>` +
      `<div class="pro-card-actions">` +
      `<button type="button" class="pro-btn" data-act="main"${v.kind === 'ended' && state.notified ? ' disabled' : ''}>${CROWN_SVG}<span>${escapeHtml(main)}</span></button>` +
      `<button type="button" class="pro-text-btn" data-act="quiet">${escapeHtml(quiet)}</button>` +
      `</div><p class="pro-note" role="status" aria-live="polite"></p></div>`;
    card.hidden = false;
    const note = card.querySelector('.pro-note') as HTMLElement;
    const mainBtn = card.querySelector('[data-act="main"]') as HTMLButtonElement;
    card.querySelector('[data-act="quiet"]')!.addEventListener('click', () => {
      if (v.kind === 'offer') write(LATER_KEY, String(Date.now()));
      else write(SEEN_KEY, v.stage);
      paint();
    });
    mainBtn.addEventListener('click', async () => {
      if (!state) return;
      if (v.kind === 'offer') {
        const { openGiftSheet } = await import('./proSheets');
        if (await openGiftSheet(state)) await load(true);
      } else if (v.kind === 'remind') {
        const st = state;
        void import('./proSheets').then((m) => m.openProSheet(st));
      } else {
        mainBtn.disabled = true;
        if (await notifyPro()) {
          track('pro_notify');
          note.textContent = t('pro.notify.done');
          mainBtn.querySelector('span')!.textContent = t('pro.act.notified');
        } else {
          mainBtn.disabled = false;
          note.textContent = t('pro.notify.failed');
        }
      }
    });
  };

  const load = async (fresh = false): Promise<void> => {
    state = isSignedIn() ? await fetchPro(fresh).catch(() => null) : null;
    paint();
  };
  void load();
  window.addEventListener('tifo:auth', () => void load(true));
  onLangChange(paint);
}
