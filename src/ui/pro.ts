/**
 * Pro in the interface: the crown, the counts and the words for "back on
 * Sunday", and the countdown chip. The sheets (the gift, the export choice,
 * what Pro adds) are ui/proSheets.ts, loaded when one first opens.
 *
 * Everything here SHOWS what /api/pro says; nothing here decides. A page that
 * edits this module can make a crown disappear or a sheet say "yes", and the
 * server still refuses anything Pro the account does not hold.
 */
import './pro.css';
import { escapeHtml } from '../core/escape';
import { fetchPro, isSignedIn, type Allowance, type ProPlan, type ProState } from '../net/api';
import { getLang, localPath, onLangChange, t, tv } from './i18n';

/** The crown: the one mark for everything Pro. */
export const CROWN_SVG =
  '<svg class="pro-crown" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M3.2 7.6l4.6 3.6 3.4-5.7a.95.95 0 0 1 1.6 0l3.4 5.7 4.6-3.6a.6.6 0 0 1 .96.58L19.9 17H4.1L2.24 8.18a.6.6 0 0 1 .96-.58z"/>' +
  '<path d="M4.4 18.6h15.2V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z"/></svg>';

/** "♛ Pro" / "♛ مميّز"; the crown alone (with a spoken name) on a small thumbnail. */
export function proChipHtml(opts: { icon?: boolean; quiet?: boolean } = {}): string {
  const cls = `pro-chip${opts.icon ? ' icon' : ''}${opts.quiet ? ' quiet' : ''}`;
  return opts.icon
    ? `<span class="${cls}" role="img" aria-label="${escapeHtml(t('pro.chip'))}">${CROWN_SVG}</span>`
    : `<span class="${cls}">${CROWN_SVG}<span>${escapeHtml(t('pro.chip'))}</span></span>`;
}

/** The Supporter crown beside a name (a paid pass), with its name spoken and on hover. */
export function supporterCrownHtml(): string {
  const name = escapeHtml(t('pro.supporter'));
  return `<span class="supporter-crown" role="img" aria-label="${name}" title="${name}">${CROWN_SVG}</span>`;
}

export function proChip(opts: { icon?: boolean; quiet?: boolean } = {}): HTMLElement {
  const box = document.createElement('span');
  box.innerHTML = proChipHtml(opts);
  return box.firstElementChild as HTMLElement;
}

// ------------------------------------------------------------- the words ---

const DAY = 24 * 60 * 60 * 1000;

/** A date and time in the reader's language, with Western digits and the Gregorian calendar. */
export function whenDate(iso: string, withTime = true): string {
  const loc = getLang() === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(loc, {
    weekday: 'long', day: 'numeric', month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(iso));
}

/** When a pass ends: the day and time while it is near, the day and year when it is months off. */
export function endsText(iso: string, now = Date.now()): string {
  return Date.parse(iso) - now > 14 * DAY ? whenDay(iso) : whenDate(iso);
}

/** A day far enough off to need its year: "31 May 2027" / "31 مايو 2027". */
export function whenDay(iso: string): string {
  const loc = getLang() === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** "in 2 days", "in 5 hours", "tomorrow", in the reader's language. */
export function inTime(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 60_000) return t('pro.when.now');
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return tv('pro.when.minutes', { n: mins });
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    if (hours <= 1) return t('pro.when.hour1');
    if (hours === 2) return t('pro.when.hours2');
    // Arabic counts 3 to 10 with a plural noun and 11 up with a singular one.
    return tv(hours > 10 ? 'pro.when.hoursMany' : 'pro.when.hours', { n: hours });
  }
  const days = Math.round(ms / DAY);
  if (days === 1) return t('pro.when.tomorrow');
  if (days === 2) return t('pro.when.days2');
  return tv(days > 10 ? 'pro.when.daysMany' : 'pro.when.days', { n: days });
}

/** When an allowance comes back: "on Sunday, in 2 days" for a week, "tomorrow" for a day. */
export function backWhen(a: Pick<Allowance, 'period' | 'resetAt'>, now = Date.now()): string {
  if (a.period === 'day') return inTime(a.resetAt, now);
  const loc = getLang() === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
  const day = new Intl.DateTimeFormat(loc, { weekday: 'long' }).format(new Date(a.resetAt));
  return tv('pro.when.onDay', { day, in: inTime(a.resetAt, now) });
}

/** "Super designs" / "تصاميم بالذكاء الخارق", by kind. */
export function kindName(kind: Allowance['kind']): string {
  return t(`pro.kind.${kind}`);
}

/** One of them: "Super design" / "تصميم بالذكاء الخارق". */
export function kindOne(kind: Allowance['kind']): string {
  return t(`pro.kind1.${kind}`);
}

/** "That's all 3 Super designs for this week" / "You've used this week's smart cut-out". */
export function limitTitle(a: Pick<Allowance, 'kind' | 'period' | 'limit'>): string {
  return a.limit === 1
    ? tv(`pro.limit1.${a.period}`, { what: kindOne(a.kind) })
    : tv(`pro.limit.${a.period}`, { limit: a.limit, what: kindName(a.kind) });
}

/** "They come back on Sunday (in 2 days)." */
export function limitBack(a: Pick<Allowance, 'period' | 'resetAt' | 'limit'>): string {
  return tv(a.limit === 1 ? 'pro.limit.backOne' : 'pro.limit.back', { when: backWhen(a) });
}

/** The quota line under the AI buttons: what is left and when it comes back. */
export function allowanceLine(a: Allowance, plan: ProPlan | undefined): string {
  if (a.remaining <= 0) return tv('pro.q.none', { what: kindName(a.kind), when: backWhen(a) });
  const per = t(`pro.per.${a.period}`);
  const base =
    a.remaining === 1 && a.limit > 1
      ? tv('pro.q.last', { what: kindOne(a.kind), per })
      : tv('pro.q.left', { n: a.remaining, limit: a.limit, what: kindName(a.kind), per });
  return plan && plan !== 'free' ? `${t('pro.chip')} · ${base}` : base;
}

// --------------------------------------------------------- the countdown ---

/** "Pro · 5 days left" for a pass that is running, or null. */
export function chipText(state: ProState, now = Date.now()): string | null {
  if (!state.live || !state.pass || !state.plan || state.plan === 'free') return null;
  const left = Date.parse(state.pass.endsAt) - now;
  if (left <= 0) return null;
  if (left < DAY) {
    const h = Math.max(1, Math.ceil(left / 3_600_000));
    return h <= 1 ? t('pro.chip.lastHour') : tv('pro.chip.hours', { n: h });
  }
  const days = Math.ceil(left / DAY);
  if (days > 14) return tv('pro.chip.until', { date: whenDay(state.pass.endsAt) });
  if (days === 1) return t('pro.chip.day1');
  if (days === 2) return t('pro.chip.days2');
  return tv(days > 10 ? 'pro.chip.daysMany' : 'pro.chip.days', { n: days });
}

/**
 * Keep a countdown chip in `host`, before `before` when given. Hidden unless
 * a pass is running. Follows sign-in, a gift accepted elsewhere on the page,
 * and the clock (once a minute).
 */
export function mountProChip(host: HTMLElement, before?: Element | null): void {
  const a = document.createElement('a');
  a.className = 'pro-head-chip';
  a.hidden = true;
  a.href = localPath('/account') + '#pro';
  host.insertBefore(a, before ?? null);
  let state: ProState | null = null;
  const paint = (): void => {
    const text = state ? chipText(state) : null;
    a.hidden = !text;
    if (text) a.innerHTML = `${CROWN_SVG}<span>${escapeHtml(text)}</span>`;
    a.title = text && state?.pass ? tv('pro.ends', { date: endsText(state.pass.endsAt) }) : '';
  };
  const load = async (fresh = false): Promise<void> => {
    // Signed out there is no pass to count down: no request at all.
    state = isSignedIn() ? await fetchPro(fresh).catch(() => null) : null;
    paint();
  };
  void load();
  window.addEventListener('tifo:pro', () => void load(true));
  window.addEventListener('tifo:auth', () => void load(true));
  onLangChange(paint);
  window.setInterval(paint, 60_000);
}
