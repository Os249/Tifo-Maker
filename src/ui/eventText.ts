/**
 * A tifo event's words that both its page (src/events.ts) and its band
 * (ui/eventBand.ts) say: its title in the reader's language, a time in the
 * reader's own time zone, and the one line about the stage it is in.
 */
import { getLang, t, tv } from './i18n';
import type { TifoEventInfo } from '../net/api';

export function eventTitle(e: Pick<TifoEventInfo, 'titleEn' | 'titleAr'>): string {
  return getLang() === 'ar' ? e.titleAr || e.titleEn : e.titleEn || e.titleAr;
}

/** "Sat 21 Nov, 20:00" in the reader's time zone, with Western digits in Arabic too. */
export function eventWhen(iso: string): string {
  const loc = getLang() === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** "Entries close Sat 21 Nov, 20:00", or what is happening when nothing more is timed. */
export function stageLine(e: Pick<TifoEventInfo, 'stage' | 'stageEnds'>): string {
  return e.stageEnds ? tv(`ev.ends.${e.stage}`, { when: eventWhen(e.stageEnds) }) : t(`ev.ends.${e.stage}`);
}
