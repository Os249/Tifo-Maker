/**
 * The supporter badge (Pro): beside the name of somebody whose Pro month is
 * running, the gold crown and "Pro supporter" / "داعم مميّز", on their
 * published tifo cards, their public tifo page and their profile header. Where
 * a name sits in a tight row (a comment, a card's byline on a phone), the
 * crown alone, with the badge's words spoken and on hover.
 *
 * It shows what the server says (`ownerSupporter`, `supporter`, server/src
 * routes.ts supportersFor): a fact about the account (a paid pass, now),
 * never which plan or until when, and nothing while Pro is off or, in
 * preview, to anyone outside it. One mark, the crown, in gold
 * (docs/DESIGN.md, Pro); never blue.
 */
import './supporterBadge.css';
import { escapeHtml } from '../core/escape';
import { CROWN_SVG } from './crown';
import { t } from './i18n';

/** The badge: the crown and its words, or (`compact`) the crown alone with its words spoken. */
export function supporterBadgeHtml(opts: { compact?: boolean } = {}): string {
  const words = escapeHtml(t('qk.badge'));
  const what = escapeHtml(t('qk.badgeT'));
  return opts.compact
    ? `<span class="supporter-badge compact" role="img" aria-label="${words}" title="${words}: ${what}">${CROWN_SVG}</span>`
    : `<span class="supporter-badge" title="${what}">${CROWN_SVG}<span>${words}</span></span>`;
}
