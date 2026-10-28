/**
 * Pro's sheets: the gift, what Pro adds, a confirm, and the export choice.
 *
 * Its own module, loaded the first time a sheet opens: the editor's start
 * carries the crown, the counts and the countdown (ui/pro.ts), not the words
 * of sheets most visits never open (e2e-pages-load counts the strings at start).
 *
 * Like the rest of Pro in the interface, a sheet SHOWS what /api/pro says and
 * asks the server to act; it decides nothing.
 */
import { escapeHtml } from '../core/escape';
import { acceptProGift, notifyPro, type ProOffer, type ProState } from '../net/api';
import { track } from '../net/analytics';
import { containDialog } from './dialogFocus';
import { localPath, t, tv } from './i18n';
import { CROWN_SVG, whenDate, whenDay } from './pro';

const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------- the sheet ---

interface Sheet {
  root: HTMLElement;
  body: HTMLElement;
  close: () => void;
  closed: Promise<void>;
}

/** One sheet at a time: a modal on a desktop, a bottom sheet on a phone. */
let open: Sheet | null = null;

function openSheet(html: string): Sheet {
  open?.close();
  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop';
  root.innerHTML =
    `<div class="pro-sheet" role="dialog" aria-modal="true">` +
    `<button type="button" class="pro-sheet-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>` +
    `<div class="pro-sheet-body">${html}</div></div>`;
  document.body.appendChild(root);
  let done: () => void = () => {};
  const closed = new Promise<void>((r) => { done = r; });
  let finished = false;
  const close = (): void => {
    if (finished) return;
    finished = true;
    release();
    if (open === sheet) open = null;
    // Closes quicker than it opened, and never waits on reduced motion.
    root.classList.add('closing');
    const gone = (): void => { root.remove(); done(); };
    const ms = parseFloat(getComputedStyle(root).animationDuration || '0') * 1000;
    if (ms > 0) setTimeout(gone, ms); else gone();
  };
  const release = containDialog(root, close);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  root.querySelector('.pro-sheet-close')!.addEventListener('click', close);
  const sheet: Sheet = { root, body: root.querySelector('.pro-sheet-body') as HTMLElement, close, closed };
  open = sheet;
  return sheet;
}

const mark = (): string => `<div class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</div>`;

function perksHtml(keys: string[]): string {
  return `<ul class="pro-perks">${keys.map((k) => `<li>${CROWN_SVG}<span>${escapeHtml(t(k))}</span></li>`).join('')}</ul>`;
}
const GIFT_PERKS = ['pro.perk.super', 'pro.perk.cutout', 'pro.perk.polish', 'pro.perk.mark', 'pro.perk.noLimits'];

/**
 * Accept the 7-day gift. Shows when it would end if started now, and starts
 * it only on the button. Resolves true when the gift is running.
 */
export function openGiftSheet(state?: ProState | null): Promise<boolean> {
  const days = state?.gift && 'days' in state.gift ? state.gift.days : 7;
  const endsIfNow = new Date(Date.now() + days * DAY).toISOString();
  const sheet = openSheet(
    mark() +
    `<h2>${escapeHtml(tv('gift.sheetTitle', { n: days }))}</h2>` +
    `<p>${escapeHtml(t('gift.sheetLead'))}</p>` +
    perksHtml(GIFT_PERKS) +
    `<p>${escapeHtml(t('gift.endsIfNow'))} <span class="pro-when">${escapeHtml(whenDate(endsIfNow))}</span>.</p>` +
    `<div class="pro-actions">` +
    `<button type="button" class="pro-primary" data-act="start">${escapeHtml(tv('gift.start', { n: days }))}</button>` +
    `<button type="button" class="pro-text-btn" data-act="later">${escapeHtml(t('pro.act.notNow'))}</button>` +
    `</div><p class="pro-note" role="status" aria-live="polite"></p>`,
  );
  return new Promise<boolean>((resolve) => {
    let started = false;
    void sheet.closed.then(() => resolve(started));
    const note = sheet.body.querySelector('.pro-note') as HTMLElement;
    sheet.body.querySelector('[data-act="later"]')!.addEventListener('click', sheet.close);
    const go = sheet.body.querySelector('[data-act="start"]') as HTMLButtonElement;
    go.addEventListener('click', async () => {
      go.disabled = true;
      note.textContent = t('gift.starting');
      const r = await acceptProGift();
      if (!r.ok) {
        go.disabled = false;
        note.textContent = t(r.reason === 'used' ? 'gift.used' : r.reason === 'expired' ? 'gift.expired' : r.status === 403 ? 'gift.verify' : 'gift.failed');
        return;
      }
      started = true;
      track('gift_accepted');
      sheet.body.innerHTML =
        mark() +
        `<h2>${escapeHtml(t('gift.startedTitle'))}</h2>` +
        `<p>${escapeHtml(t('gift.startedBody'))} <span class="pro-when">${escapeHtml(whenDate(r.endsAt))}</span>.</p>` +
        `<div class="pro-actions"><button type="button" class="pro-primary" data-act="done">${escapeHtml(t('gift.startedGo'))}</button></div>`;
      const done = sheet.body.querySelector('[data-act="done"]') as HTMLButtonElement;
      done.addEventListener('click', sheet.close);
      done.focus();
    });
  });
}

/** The two passes in one line, from the server's offer. */
export function passesLine(offer: ProOffer): string {
  return tv('pro.passesLine', {
    match: offer.match.price,
    hours: offer.match.hours,
    season: offer.season.price,
    until: whenDay(offer.season.endsAt),
  });
}

/**
 * What Pro adds, from a limit card or a crown: the perks, the prices, and the
 * one way forward that exists right now (until payments open, being told when
 * they do).
 */
export function openProSheet(state: ProState, opts: { title?: string; lead?: string } = {}): Promise<void> {
  const offer = state.offer;
  const notified = !!state.notified;
  const gift = state.gift?.state === 'offered';
  const sheet = openSheet(
    mark() +
    `<h2>${escapeHtml(opts.title ?? t('pro.sheet.whatTitle'))}</h2>` +
    `<p>${escapeHtml(opts.lead ?? t('pro.sheet.whatLead'))}</p>` +
    perksHtml([...GIFT_PERKS, 'pro.perk.badge']) +
    (offer ? `<p>${escapeHtml(passesLine(offer))}</p>` : '') +
    `<div class="pro-actions">` +
    (gift
      ? `<button type="button" class="pro-primary" data-act="gift">${escapeHtml(t('pro.act.useGift'))}</button>`
      : offer?.paymentsOpen
        ? `<a class="pro-primary" href="${escapeHtml(localPath('/pro'))}">${escapeHtml(tv('pro.act.getPro', { price: offer.match.price }))}</a>`
        : `<button type="button" class="pro-primary" data-act="notify" ${notified ? 'disabled' : ''}>${escapeHtml(t(notified ? 'pro.act.notified' : 'pro.act.notify'))}</button>`) +
    `<a class="pro-text-btn" href="${escapeHtml(localPath('/pro'))}">${escapeHtml(t('pro.act.seePage'))}</a>` +
    `</div><p class="pro-note" role="status" aria-live="polite"></p>`,
  );
  const note = sheet.body.querySelector('.pro-note') as HTMLElement;
  sheet.body.querySelector('[data-act="gift"]')?.addEventListener('click', () => {
    sheet.close();
    void openGiftSheet(state);
  });
  const notify = sheet.body.querySelector('[data-act="notify"]') as HTMLButtonElement | null;
  notify?.addEventListener('click', async () => {
    notify.disabled = true;
    if (await notifyPro()) {
      track('pro_notify');
      notify.textContent = t('pro.act.notified');
      note.textContent = t('pro.notify.done');
    } else {
      notify.disabled = false;
      note.textContent = t('pro.notify.failed');
    }
  });
  return sheet.closed;
}

/**
 * A short sheet: the crown, a title, a few lines and one blue step, with "Not
 * now" beside it. Resolves true when the step was pressed.
 */
export function openConfirmSheet(o: { title: string; lines: string[]; go: string; note?: string }): Promise<boolean> {
  const sheet = openSheet(
    mark() +
    `<h2>${escapeHtml(o.title)}</h2>` +
    o.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
    `<div class="pro-actions">` +
    `<button type="button" class="pro-primary" data-act="go">${escapeHtml(o.go)}</button>` +
    `<button type="button" class="pro-text-btn" data-act="later">${escapeHtml(t('pro.act.notNow'))}</button>` +
    `</div>` +
    (o.note ? `<p class="pro-note">${escapeHtml(o.note)}</p>` : ''),
  );
  return new Promise<boolean>((resolve) => {
    let ok = false;
    void sheet.closed.then(() => resolve(ok));
    const go = sheet.body.querySelector('[data-act="go"]') as HTMLButtonElement;
    go.addEventListener('click', () => { ok = true; sheet.close(); });
    sheet.body.querySelector('[data-act="later"]')!.addEventListener('click', sheet.close);
    go.focus();
  });
}

/**
 * A Pro item stands between someone and an export. Three ways on, never a
 * dead end: the gift (when there is one), Pro, or the free version.
 */
export function openExportSheet(items: string[], state: ProState): Promise<'free' | null> {
  const gift = state.gift?.state === 'offered';
  const offer = state.offer;
  const notified = !!state.notified;
  const sheet = openSheet(
    mark() +
    `<h2>${escapeHtml(items.length === 1 ? t('pro.export.title1') : tv('pro.export.titleN', { n: items.length }))}</h2>` +
    `<ul class="pro-items">${items.map((i) => `<li>${CROWN_SVG}<span>${escapeHtml(i)}</span></li>`).join('')}</ul>` +
    `<p>${escapeHtml(t('pro.export.lead'))}</p>` +
    `<div class="pro-actions">` +
    (gift
      ? `<button type="button" class="pro-primary" data-act="gift">${escapeHtml(t('pro.act.useGift'))}</button>`
      : offer?.paymentsOpen
        ? `<a class="pro-primary" href="${escapeHtml(localPath('/pro'))}">${escapeHtml(tv('pro.act.getPro', { price: offer.match.price }))}</a>`
        : `<button type="button" class="pro-primary" data-act="notify" ${notified ? 'disabled' : ''}>${escapeHtml(t(notified ? 'pro.act.notified' : 'pro.act.notify'))}</button>`) +
    `<button type="button" class="pro-alt" data-act="free">${escapeHtml(t('pro.export.free'))}</button>` +
    `</div><p class="pro-note" role="status" aria-live="polite">${escapeHtml(t('pro.export.never'))}</p>`,
  );
  track('export_sheet');
  return new Promise((resolve) => {
    let choice: 'free' | null = null;
    void sheet.closed.then(() => resolve(choice));
    const note = sheet.body.querySelector('.pro-note') as HTMLElement;
    sheet.body.querySelector('[data-act="free"]')!.addEventListener('click', () => {
      choice = 'free';
      track('export_free');
      sheet.close();
    });
    sheet.body.querySelector('[data-act="gift"]')?.addEventListener('click', () => {
      sheet.close();
      void openGiftSheet(state);
    });
    const notify = sheet.body.querySelector('[data-act="notify"]') as HTMLButtonElement | null;
    notify?.addEventListener('click', async () => {
      notify.disabled = true;
      if (await notifyPro()) {
        track('pro_notify');
        notify.textContent = t('pro.act.notified');
        note.textContent = t('pro.notify.done');
      } else {
        notify.disabled = false;
        note.textContent = t('pro.notify.failed');
      }
    });
  });
}

