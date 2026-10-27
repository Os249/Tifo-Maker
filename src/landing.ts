import { cleanAddressBar } from './core/utm';
import { initLang, applyDom, localPath, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { localizeHero, mountHeroStadium } from './heroStadium';
import { mountShowcase } from './showcase';
import { localizeDailyTifo, mountDailyTifo } from './dailyTifo';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { escapeHtml } from './core/escape';

// Apply saved language on load, then translate the static page.
initLang();
// The visit was counted when the page was sent; see core/utm.ts.
cleanAddressBar();
// Light / dark. The scheme is already on the <html> element (the inline head
// script settles it before first paint); this wires the header toggle and the
// translated labels.
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });

applyDom(document);
installMobileNav();
installConsent();

// A real club's tifo in its real ground (lazy, after first paint).
void mountHeroStadium();
// Populate the community showcase with real designs (social proof).
void mountShowcase();
// Tifo of the day. Usually already in the HTML (the server renders it), in
// which case this only settles which language the design's title shows in.
void mountDailyTifo();

// ------------------------------------------------------------ leagues ---

/**
 * The leagues, each with a Match Day picture of one of its grounds. The names
 * and pictures are here so the strip paints with the page; how many grounds
 * each has comes from the catalogue, which is loaded only when the strip is
 * near the screen (it is the biggest module the site has).
 */
const LEAGUE_STRIP: { tag: string; key: string; pic: string }[] = [
  { tag: 'saudi-pro-league', key: 'sp.league.saudi', pic: '/news/leagues-saudi.webp' },
  { tag: 'premier-league', key: 'sp.league.premier', pic: '/news/leagues-premier.webp' },
  { tag: 'laliga', key: 'sp.league.laliga', pic: '/news/leagues-laliga.webp' },
  { tag: 'ligue-1', key: 'sp.league.ligue1', pic: '/news/leagues-ligue1.webp' },
  { tag: 'super-lig', key: 'sp.league.superLig', pic: '/news/leagues-superlig.webp' },
  { tag: 'botola', key: 'sp.league.botola', pic: '/news/leagues-botola.webp' },
  { tag: 'algeria-ligue-1', key: 'sp.league.algeria', pic: '/news/leagues-algeria.webp' },
  { tag: 'thai-league', key: 'sp.league.thai', pic: '/news/leagues-thai.webp' },
];

let leagueCounts: Map<string, number> | null = null;

function renderLeagues(): void {
  const strip = document.getElementById('league-strip');
  if (!strip) return;
  strip.innerHTML = LEAGUE_STRIP.map((l) => {
    const n = leagueCounts?.get(l.tag);
    return `<a class="league" href="${escapeHtml(localPath(`/projects?new=1&league=${encodeURIComponent(l.tag)}`))}">
      <img src="${l.pic}" alt="${escapeHtml(t(l.key))}" width="480" height="300" loading="lazy" decoding="async" />
      <span class="league-name" aria-hidden="true">${escapeHtml(t(l.key))}</span>
      ${n ? `<span class="league-count">${escapeHtml(tv('lgs.count', { n }))}</span>` : ''}
    </a>`;
  }).join('');
}
renderLeagues();

/**
 * The grounds, loaded once, when the strip or the search first needs them:
 * the index, names and tags without the geometry (performance plan P2.7).
 */
let catalog: Promise<typeof import('./core/stadiumIndex')> | null = null;
const loadCatalog = (): Promise<typeof import('./core/stadiumIndex')> => (catalog ??= import('./core/stadiumIndex'));

const strip = document.getElementById('league-strip');
if (strip && typeof IntersectionObserver !== 'undefined') {
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    void loadCatalog().then(({ STADIUM_INDEX }) => {
      leagueCounts = new Map();
      for (const e of STADIUM_INDEX) {
        if (e.meta.source !== 'builtin') continue;
        for (const tag of e.meta.tags ?? []) leagueCounts.set(tag, (leagueCounts.get(tag) ?? 0) + 1);
      }
      renderLeagues();
    });
  }, { rootMargin: '300px 0px' });
  io.observe(strip);
}

// ------------------------------------------------------------ the ground finder ---

/**
 * "Is your club's ground here?" Clubs first (a club is what a fan types), then
 * grounds, each straight into the start flow on that club or ground. Nothing
 * found says so, and offers the start flow anyway.
 */
function mountGroundFinder(): void {
  const form = document.getElementById('ground-find') as HTMLFormElement | null;
  const input = document.getElementById('ground-q') as HTMLInputElement | null;
  const list = document.getElementById('ground-list');
  if (!form || !input || !list) return;
  let hits: import('./groundFinder').GroundHit[] = [];
  let active = -1;
  let finder: typeof import('./groundFinder') | null = null;

  // The search and the stadium index it reads, with the ground-name strings they
  // bring, on first use (performance plan P2.6).
  const load = async (): Promise<void> => {
    if (finder) return;
    finder = (await Promise.all([import('./groundFinder'), loadCatalog()]))[0];
  };
  const close = (): void => {
    // Nothing left to pick from: Enter on an emptied box goes to the start
    // flow, not to whatever was listed before.
    hits = [];
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const paint = (): void => {
    list.innerHTML = hits.length
      ? hits.map((h, i) => `<li role="option" id="gf-${i}" class="gf-hit${i === active ? ' on' : ''}" aria-selected="${i === active}">
          <a href="${escapeHtml(localPath(h.href))}">
            <span class="gf-scarf${h.colours ? '' : ' none'}"${h.colours ? ` style="--c1:${h.colours[0]};--c2:${h.colours[1]}"` : ''}></span>
            <span class="gf-text"><b>${escapeHtml(h.name)}</b><span>${escapeHtml(h.sub)}</span></span>
            <span class="gf-kind">${escapeHtml(t(h.kind === 'club' ? 'hero.searchClub' : 'hero.searchGround'))}</span>
          </a></li>`).join('')
      : `<li class="gf-none" role="option" aria-disabled="true"><a href="${localPath('/projects?new=1')}">${escapeHtml(t('hero.searchNone'))}</a></li>`;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `gf-${active}`);
  };
  const search = async (): Promise<void> => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      close();
      return;
    }
    await load();
    // The first search waits for the catalogue; the box may have changed since.
    if (input.value.trim().toLowerCase() !== q) return;
    hits = finder!.findGrounds(q);
    active = hits.length ? 0 : -1;
    paint();
  };
  input.addEventListener('input', () => void search());
  input.addEventListener('focus', () => void load());
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      paint();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  // Start: the highlighted club or ground, or the start flow when nothing is
  // typed (or nothing matched). A search typed faster than the catalogue
  // arrived is finished first, so Start never ignores what is in the box.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim() && !hits.length) await search();
    const hit = hits[active >= 0 ? active : 0];
    location.assign(localPath(hit ? hit.href : '/projects?new=1'));
  });
  document.addEventListener('click', (e) => {
    if (!form.contains(e.target as Node)) close();
  });
}
mountGroundFinder();

// ------------------------------------------------------------ the closing band ---

/**
 * The last band is the same for everyone: TifoMaker's own blue and a plain
 * Start. It used to repaint itself in the colours of the last club a visitor
 * had started a tifo for ("Start the Al Ittihad tifo"), which made the whole
 * page read as one club's site. A visitor with projects on this device gets
 * one neutral extra: a way back to them.
 */
function hasLocalProjects(): boolean {
  try {
    const list: unknown = JSON.parse(localStorage.getItem('tifo_projects_v1') ?? '[]');
    return Array.isArray(list) && list.some((p) => p && typeof p === 'object' && !(p as { deletedAt?: number }).deletedAt);
  } catch {
    return false;
  }
}
{
  const mine = document.getElementById('final-other');
  if (mine && hasLocalProjects()) mine.hidden = false;
}

// Keep the document <title> and toggle button label in sync.
const toggle = document.getElementById('lang-toggle');
toggle?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  // A design's own title is data, not a string table entry, so applyDom cannot
  // reach it — it ships in both languages on the element and swaps here.
  localizeDailyTifo();
  localizeHero();
  renderLeagues();
  if (toggle) toggle.textContent = t('common.language');
});

// The footer feedback entry. Lazy: the modal is only fetched once someone
// actually asks for it, so a visitor who never clicks pays nothing for it.
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});
