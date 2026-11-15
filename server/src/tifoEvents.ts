/**
 * Tifo events: the rules, with nothing stored and nothing sent
 * (eventRepo.ts stores, eventRoutes.ts answers).
 *
 * An event's stage comes from its four times and the clock. Nothing moves it
 * on: a page read at 20:00:01 simply sees voting where 20:00:00 saw entries.
 *
 *   draft      before it is announced: only the admin sees it
 *   announced  the theme, the dates and the prize are public
 *   open       published tifos made since the announcement can be entered
 *   voting     entries are frozen; votes are taken, and not shown
 *   closed     voting is over; the admin has not confirmed the result yet
 *   result     confirmed: the podium and the counts are public, for good
 *
 * A cancelled event is 'cancelled' whatever the clock says, and is public
 * nowhere.
 */
import { createHash } from 'node:crypto';
import type { EventEntry, EventFields, TifoEvent } from './eventRepo';

export type EventStage = 'draft' | 'announced' | 'open' | 'voting' | 'closed' | 'result' | 'cancelled';

/** The stages a visitor can see. */
export const PUBLIC_STAGES: readonly EventStage[] = ['announced', 'open', 'voting', 'closed', 'result'];

/** How long a confirmed result stays on the home and community pages. */
export const RESULT_BAND_DAYS = 7;
/** A winner gets the prize at most once in this long; the title, always. */
export const PRIZE_EVERY_DAYS = 90;
/** The most entries an event's page lists. */
export const MAX_ENTRIES_SHOWN = 300;

const DAY_MS = 24 * 3600_000;

export function stageOf(e: Pick<TifoEvent, 'announceAt' | 'openAt' | 'voteAt' | 'closeAt' | 'cancelledAt' | 'confirmedAt'>, now: Date): EventStage {
  if (e.cancelledAt) return 'cancelled';
  if (e.confirmedAt) return 'result';
  const t = now.getTime();
  if (t < Date.parse(e.announceAt)) return 'draft';
  if (t < Date.parse(e.openAt)) return 'announced';
  if (t < Date.parse(e.voteAt)) return 'open';
  if (t < Date.parse(e.closeAt)) return 'voting';
  return 'closed';
}

/** When the stage an event is in ends, or null when nothing more is timed. */
export function stageEnds(e: Pick<TifoEvent, 'openAt' | 'voteAt' | 'closeAt'>, stage: EventStage): string | null {
  return stage === 'announced' ? e.openAt : stage === 'open' ? e.voteAt : stage === 'voting' ? e.closeAt : null;
}

/**
 * The one event the home and community pages speak of, or null: the one
 * furthest along that is still going (voting before open before announced),
 * then one waiting for its result, then a result confirmed in the last week.
 */
export function currentEvent(all: TifoEvent[], now: Date): TifoEvent | null {
  const rank: Partial<Record<EventStage, number>> = { voting: 0, open: 1, announced: 2, closed: 3, result: 4 };
  let best: TifoEvent | null = null;
  let bestRank = 99;
  for (const e of all) {
    const s = stageOf(e, now);
    const r = rank[s];
    if (r === undefined) continue;
    if (s === 'result' && now.getTime() - Date.parse(e.confirmedAt as string) > RESULT_BAND_DAYS * DAY_MS) continue;
    // Between two in the same stage, the one that opened first.
    if (!best || r < bestRank || (r === bestRank && Date.parse(e.openAt) < Date.parse(best.openAt))) {
      best = e;
      bestRank = r;
    }
  }
  return best;
}

// ------------------------------------------------------- the admin's form ---

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Control characters and the marks that flip text direction have no place in a title. */
const UNPRINTABLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const tidy = (v: unknown): string => (typeof v === 'string' ? v.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim() : '');

/** A slug from a title: "The Derby!" is "the-derby". Empty when the title has no Latin letters or digits. */
export function slugFrom(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export type FieldsResult = { ok: true; fields: EventFields } | { ok: false; error: string };

/** The admin's form, checked: every text within its length, the four times in order, the prize within 0 to 90 days. */
export function readEventFields(body: unknown): FieldsResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const titleEn = tidy(b.titleEn);
  const titleAr = tidy(b.titleAr);
  const lineEn = tidy(b.lineEn);
  const lineAr = tidy(b.lineAr);
  if (!titleEn || titleEn.length > 60) return { ok: false, error: 'the English title is required, 60 characters at most' };
  if (!titleAr || titleAr.length > 60) return { ok: false, error: 'the Arabic title is required, 60 characters at most' };
  if (lineEn.length > 200 || lineAr.length > 200) return { ok: false, error: 'each line is 200 characters at most' };
  const slug = tidy(b.slug) || slugFrom(titleEn);
  if (!SLUG.test(slug)) return { ok: false, error: 'the address is 2 to 41 small letters, digits or dashes, starting with a letter or digit' };
  const times: string[] = [];
  for (const k of ['announceAt', 'openAt', 'voteAt', 'closeAt'] as const) {
    const ms = typeof b[k] === 'string' ? Date.parse(b[k] as string) : NaN;
    if (!Number.isFinite(ms) || ms < Date.UTC(2026, 0, 1) || ms > Date.UTC(2100, 0, 1)) return { ok: false, error: `${k} is not a date and time` };
    times.push(new Date(ms).toISOString());
  }
  const [announceAt, openAt, voteAt, closeAt] = times;
  if (!(Date.parse(announceAt) <= Date.parse(openAt))) return { ok: false, error: 'entries cannot open before the event is announced' };
  if (!(Date.parse(openAt) < Date.parse(voteAt))) return { ok: false, error: 'voting must start after entries open' };
  if (!(Date.parse(voteAt) < Date.parse(closeAt))) return { ok: false, error: 'voting must end after it starts' };
  let prizeDays = 30;
  if (!(b.prizeDays === undefined || b.prizeDays === null || b.prizeDays === '')) {
    prizeDays = Number(b.prizeDays);
    if (!Number.isInteger(prizeDays) || prizeDays < 0 || prizeDays > 90) return { ok: false, error: 'the prize is a whole number of days from 0 to 90' };
  }
  return { ok: true, fields: { slug, titleEn, titleAr, lineEn, lineAr, announceAt, openAt, voteAt, closeAt, prizeDays } };
}

/** A reason for taking an entry out, as the page will show it; '' when there is none to show. */
export function readReason(v: unknown): string {
  return tidy(v).slice(0, 120);
}

// ------------------------------------------------------------ the result ---

export interface Ranked {
  designId: string;
  userId: string;
  votes: number;
  enteredAt: string;
}

/**
 * The entries in the order of the result: most counted votes first, and
 * between equals the one entered first. Entries taken out by the admin, and
 * ones whose tifo is no longer public, are not in it.
 */
export function rankEntries(entries: EventEntry[], tally: Map<string, { counted: number }>, stillPublic: (designId: string) => boolean): Ranked[] {
  return entries
    .filter((x) => !x.disqualifiedReason && stillPublic(x.designId))
    .map((x) => ({ designId: x.designId, userId: x.userId, votes: tally.get(x.designId)?.counted ?? 0, enteredAt: x.enteredAt }))
    .sort((a, b) => b.votes - a.votes || a.enteredAt.localeCompare(b.enteredAt) || a.designId.localeCompare(b.designId));
}

/** Whether this account's last event prize is recent enough that the next win brings the title alone. */
export function prizeTooSoon(all: TifoEvent[], userId: string, now: Date): boolean {
  return all.some((e) => e.winnerUser === userId && e.prizePass !== null && e.confirmedAt !== null && now.getTime() - Date.parse(e.confirmedAt) < PRIZE_EVERY_DAYS * DAY_MS);
}

/**
 * The entries in an order of the visitor's own while votes are being taken:
 * the same for one visitor every time, different between visitors, so nobody
 * collects votes for being listed first.
 */
export function shuffledFor<T extends { designId: string }>(items: T[], seed: string): T[] {
  const key = (id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');
  return items.map((x) => ({ x, k: key(x.designId) })).sort((a, b) => a.k.localeCompare(b.k)).map((p) => p.x);
}

/** Whether a vote goes in the result: an email verified before voting opened. */
export function voteCounts(emailVerifiedAt: string | null, voteAt: string): boolean {
  return !!emailVerifiedAt && Date.parse(emailVerifiedAt) < Date.parse(voteAt);
}
