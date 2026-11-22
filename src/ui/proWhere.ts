/**
 * Where a Pro offer was seen, and where "Get Pro" was pressed (22 Nov 2026).
 *
 * /admin's Pro funnel reads the path "saw a Pro offer, pressed Get Pro, paid"
 * by place: Post it, share, the export sheet, /pro itself, the card after the
 * gift, a limit card, the account page. The first two steps are funnel events
 * (net/analytics.ts: counted only for a visitor who allowed counting); the
 * last is the order, which carries the place its checkout named.
 *
 * So a Get Pro link made here goes to /pro with `?from=<place>` (and
 * `&plan=match` for the match pass), /pro reads it once and hands it to the
 * checkout, and only for a visitor who allowed counting: otherwise the order
 * says nothing about where it came from.
 *
 * No strings and no imports beyond analytics and the path helper, so any
 * chunk can use it.
 */
import { analyticsAllowed, track, type ProPlace } from '../net/analytics';
import { localPath } from './i18n';

export type { ProPlace };

const PLACES: readonly ProPlace[] = ['post', 'share', 'export', 'page', 'giftend', 'limit', 'account'];

/** A Pro offer was shown here. */
export function offerSeen(place: ProPlace): void {
  track(`pro_offer_${place}`);
}

/** "Get Pro" (or the match pass) was pressed here. */
export function getPressed(place: ProPlace): void {
  track(`pro_get_${place}`);
}

/** The /pro address a Get Pro link at `place` goes to. */
export function proLink(place: ProPlace, plan: 'monthly' | 'match' = 'monthly'): string {
  return `${localPath('/pro')}?from=${place}${plan === 'match' ? '&plan=match' : ''}`;
}

/** What /pro was opened with: the place (when it is one of ours) and the plan asked for. */
export function readArrival(search: string): { from: ProPlace | null; plan: 'monthly' | 'match' } {
  const q = new URLSearchParams(search);
  const from = q.get('from');
  return { from: PLACES.includes(from as ProPlace) ? (from as ProPlace) : null, plan: q.get('plan') === 'match' ? 'match' : 'monthly' };
}

/** The place to name on an order, or null when the visitor has not allowed counting. */
export function orderSrc(place: ProPlace | null): string | null {
  return analyticsAllowed() ? place ?? 'page' : null;
}
