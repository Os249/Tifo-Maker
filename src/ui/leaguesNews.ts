import { t, tv } from './i18n';
import { LEAGUES, queryCatalog } from '../core/stadiumCatalog';

/**
 * "Your club's real stadium is here": told once, to everyone who opens the
 * editor, after the 2026-27 Roshn Saudi League, Premier League and LaLiga
 * grounds went in.
 *
 * The same manners as the Banners card (whatsNew.ts): a card beside the work,
 * not a dialog in front of it; it waits behind the onboarding dialog, the tour
 * and Match Day; it goes when it is answered or when the view changes. Each
 * league is a picture of one of its grounds and opens the stadium list on that
 * league, because the question a fan has is "is MY team's ground there?", and
 * the answer is one tap away rather than a scroll through sixty.
 *
 * One news card per visit: while this one is unanswered, the Banners card
 * waits for a later visit (main.ts).
 */

const FLAG = 'tifo_news_leagues_v1';

/** The picture for each league: one of its grounds, rendered in Match Day. */
const PICTURE: Record<string, string> = {
  'saudi-pro-league': '/news/leagues-saudi.webp',
  'premier-league': '/news/leagues-premier.webp',
  laliga: '/news/leagues-laliga.webp',
};

export function leaguesNewsSeen(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return true; // storage blocked → it would come back on every load
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    /* ignore */
  }
}

/** Something else has the screen, and this can wait for it. */
function screenBusy(): boolean {
  return !!document.querySelector('.tour-overlay, .ob-backdrop, .mds-overlay, .dlg-backdrop, #news-card');
}

export interface LeaguesNewsOptions {
  /** Open the stadium list, on one league (a tag from LEAGUES) or on all of them. */
  openStadiums: (league: string | null) => void;
}

export function offerLeaguesNews(opts: LeaguesNewsOptions): void {
  if (leaguesNewsSeen()) return;
  let waited = 0;
  const wait = (): void => {
    if (leaguesNewsSeen()) return;
    if (screenBusy()) {
      waited += 700;
      if (waited < 120000) window.setTimeout(wait, 700);
      return;
    }
    show(opts);
  };
  window.setTimeout(wait, 1200);
}

function show(opts: LeaguesNewsOptions): void {
  if (document.getElementById('news-card')) return;
  const card = document.createElement('div');
  card.id = 'news-card';
  card.className = 'news-card news-leagues';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'news-title');
  card.innerHTML =
    '<button type="button" class="news-x" id="news-x"><i class="ti ti-x" aria-hidden="true"></i></button>' +
    '<div class="news-head"><span class="news-tag"></span><i class="ti ti-building-stadium news-icon" aria-hidden="true"></i></div>' +
    '<h3 class="news-title" id="news-title"></h3>' +
    '<p class="news-body"></p>' +
    '<div class="news-leagues-row"></div>' +
    '<div class="news-actions">' +
    '<button type="button" class="news-later" id="news-later"></button>' +
    '<button type="button" class="news-try primary" id="news-try"><i class="ti ti-arrow-right news-go" aria-hidden="true"></i></button>' +
    '</div>';
  const q = <T extends HTMLElement>(s: string): T => card.querySelector(s) as T;
  q('.news-tag').textContent = t('news.tag');
  q('.news-title').textContent = t('newsl.title');
  q('.news-body').textContent = t('newsl.body');
  q('#news-later').textContent = t('news.later');
  q('#news-try').prepend(document.createTextNode(t('newsl.all') + ' '));
  q('#news-x').setAttribute('aria-label', t('news.close'));

  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    markSeen();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('tifo:view', close);
    document.removeEventListener('tifo:news-close', close);
    card.classList.add('out');
    window.setTimeout(() => card.remove(), 160);
  };
  const go = (league: string | null): void => {
    close();
    opts.openStadiums(league);
  };

  // One tile per league: its picture, its name, how many grounds.
  const row = q('.news-leagues-row');
  for (const l of LEAGUES) {
    const n = queryCatalog({ league: l.tag, source: 'builtin' }).length;
    if (!n) continue;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'news-league';
    tile.dataset.league = l.tag;
    const img = document.createElement('img');
    img.src = PICTURE[l.tag] ?? '';
    img.alt = '';
    img.width = 240;
    img.height = 150;
    img.decoding = 'async';
    const name = document.createElement('span');
    name.className = 'news-league-name';
    name.textContent = t(l.key);
    const count = document.createElement('span');
    count.className = 'news-league-count';
    count.textContent = tv('newsl.count', { n });
    tile.append(img, name, count);
    tile.addEventListener('click', () => go(l.tag));
    row.appendChild(tile);
  }
  document.body.appendChild(card);

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !document.querySelector('.tour-overlay, .ob-backdrop, .mds-overlay, .dlg-backdrop')) close();
  }
  q('#news-x').addEventListener('click', close);
  q('#news-later').addEventListener('click', close);
  q('#news-try').addEventListener('click', () => go(null));
  document.addEventListener('keydown', onKey);
  // A change of view means it was passed over; the editor's views all fire this.
  document.addEventListener('tifo:view', close);
  document.addEventListener('tifo:news-close', close);
}
