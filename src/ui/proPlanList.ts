/**
 * The other plans, named wherever Pro is sold outside /pro (22 Nov 2026,
 * server: PRO_THREE_PLANS): the Post it sheet, the export sheet, the limit
 * sheets, the sheet after the gift and the account page.
 *
 * Each of those keeps its one button for the month. Under it, quietly, the
 * match pass and the year are named with their whole price and length, each a
 * link to /pro with that plan asked for; a line above them says they are the
 * same Pro. Nothing here is blue, and nothing is listed that the server does
 * not sell. With the switch off this returns nothing, and every sheet is as
 * it was.
 */
import { escapeHtml } from '../core/escape';
import type { ProOffer } from '../net/api';
import { tv, t } from './i18n';
import { money } from './pro';
import { getPressed, planPicked, plansSeen, proLink, type PlanName, type ProPlace } from './proWhere';

/** The sheets name every plan on sale: the server's switch, where Pro can be bought, with at least one plan beside the month. */
export function plansListed(offer: ProOffer | undefined): boolean {
  return !!offer?.paymentsOpen && !!offer.plans && (!!offer.match || !!offer.year);
}

/** The match pass and the year under the month's button; nothing when the plans are not listed. */
export function otherPlansHtml(offer: ProOffer | undefined, place: ProPlace): string {
  if (!offer || !plansListed(offer)) return '';
  const link = (plan: PlanName, text: string): string =>
    `<a class="pro-text-btn" data-act="plan" data-plan="${plan}" href="${escapeHtml(proLink(place, plan))}">${escapeHtml(text)}</a>`;
  return (
    `<div class="pro-plans" data-plans="${place}"><p>${escapeHtml(t('pl.same'))}</p>` +
    (offer.match ? link('match', tv('pl.match', { hours: offer.match.hours, price: money(offer.match.price) })) : '') +
    (offer.year ? link('year', tv('pl.year', { days: offer.year.days, price: money(offer.year.price), perMonth: money(offer.year.perMonth) })) : '') +
    `</div>`
  );
}

/**
 * Count what happens to the plans named in `root`: they were shown at this
 * place, and which one was pressed. The month's own button ([data-act="get"])
 * is the month picked; its "pressed Get Pro" is counted by the sheet itself.
 */
export function wirePlanList(root: ParentNode, offer: ProOffer | undefined, place: ProPlace): void {
  if (!plansListed(offer) || !root.querySelector('[data-plans]')) return;
  plansSeen(place);
  root.querySelectorAll<HTMLElement>('[data-act="plan"]').forEach((a) =>
    a.addEventListener('click', () => {
      getPressed(place);
      planPicked(place, a.dataset.plan === 'year' ? 'year' : 'match');
    }));
  root.querySelectorAll('[data-act="get"]').forEach((a) => a.addEventListener('click', () => planPicked(place, 'monthly')));
}
