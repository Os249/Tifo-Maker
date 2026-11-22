/**
 * What a fan made with Pro during the 7-day gift (22 Nov 2026).
 *
 * The card that says the gift ended shows what they actually used: the
 * vertical video, the picture without the mark, the 4K poster. So when an
 * export carrying Pro items leaves the site while the gift is the Pro they
 * hold, the items are remembered on the server (api.ts giftUsed), by the
 * interface's own key rather than by words, so the card reads right in either
 * language later.
 *
 * Loaded only when such an export happens or the card is shown (proGate.ts,
 * proSheets.ts), so its words are not in the editor's start.
 */
import { giftUsed } from '../net/api';
import { t } from './i18n';

/** The Pro items an export can carry, by key. An item with no key here is counted as 'other'. */
export const USE_KEYS = ['pexp.item.vertical', 'pexp.item.hd', 'pexp.item.poster', 'pro.mark.option', 'phase.item'] as const;
/** Everything else Pro puts in a design: a Pro font, a portrait style, the club kit, the credit line. */
export const USE_OTHER = 'gw.made.other';

/** An item's key from its name on the export sheet. */
function keyOf(label: string): string {
  return USE_KEYS.find((k) => t(k) === label) ?? USE_OTHER;
}

/** These Pro items just left the site in an export, during the gift. */
export function noteProUse(items: string[]): void {
  giftUsed([...new Set(items.filter(Boolean).map(keyOf))]);
}

/** What was made, as the end card lists it: each item's name, most used first. */
export function madeList(items: Record<string, number>): string[] {
  const known = new Set<string>([...USE_KEYS, USE_OTHER]);
  return Object.entries(items)
    .filter(([k, n]) => known.has(k) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => t(k));
}
