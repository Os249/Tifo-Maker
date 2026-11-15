/**
 * The band the home and community pages show while a tifo event is on:
 * announced, open, in voting, waiting for its result, or won in the last
 * week. With no event the server says "none" and nothing is added to the
 * page: in a quiet month the nav's "Events" link is all there is.
 *
 * Asked once the page is idle: it is never in the way of the first paint.
 */
import './eventBand.css';
import { escapeHtml } from '../core/escape';
import { fetchCurrentEvent, type EventCard, type TifoEventInfo } from '../net/api';
import { localPath, onLangChange, t, tv } from './i18n';
import { eventTitle, stageLine } from './eventText';

function bandHtml(e: TifoEventInfo & { winner: EventCard | null }): string {
  const line = e.stage === 'result' && e.winner
    ? tv('ev.band.winner', { title: e.winner.title, name: e.winner.ownerName })
    : stageLine(e);
  return `<span class="ev-band-label">${escapeHtml(t('ev.band.label'))}</span>` +
    `<span class="ev-band-title"><bdi>${escapeHtml(eventTitle(e))}</bdi></span>` +
    `<span class="ev-band-when"><bdi>${escapeHtml(line)}</bdi></span>` +
    `<a href="${localPath(`/events/${encodeURIComponent(e.slug)}`)}">${escapeHtml(t('ev.band.see'))}</a>`;
}

/** Put the band at the top of `host` (the page's <main>) if an event is on. */
export function mountEventBand(host: HTMLElement): void {
  const go = async (): Promise<void> => {
    const e = await fetchCurrentEvent();
    if (!e) return;
    const band = document.createElement('aside');
    band.className = 'ev-band';
    band.id = 'ev-band';
    band.setAttribute('aria-label', t('ev.band.label'));
    band.innerHTML = bandHtml(e);
    host.prepend(band);
    onLangChange(() => {
      band.setAttribute('aria-label', t('ev.band.label'));
      band.innerHTML = bandHtml(e);
    });
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void go(), { timeout: 3000 });
  else setTimeout(() => void go(), 800);
}
