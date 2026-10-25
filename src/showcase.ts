/**
 * Homepage community showcase — pulls real public designs from the existing
 * gallery API and renders a thumbnail grid as social proof. Cards link into the
 * /community hub (where the live 3D preview modal already lives), so this adds
 * zero new backend and reuses the existing thumbnail + gallery endpoints.
 *
 * Curated (Direction C, 24 Oct 2026): the band used to show two "Untitled
 * tifo" cards, one supporter's design twice and the tifo of the day again
 * under itself. Now: named designs only, one per supporter, never the design
 * featured above, people's designs before the starter templates, and each card
 * can be taken as a template (the same /d/:id the share page's Remix uses).
 *
 * Fails gracefully: if there's nothing to show (or the request fails), the grid
 * hides itself rather than showing an empty box on a cold homepage — and the
 * whole section goes with it UNLESS the Tifo of the Day card is up, which lives
 * in the same section and is not this module's to take down.
 */
import { escapeHtml } from './core/escape';
import type { GalleryItem } from './net/api';
import { localPath } from './core/langPath';

const GRID_ID = 'showcase-grid';
const SECTION_ID = 'showcase';
/** How many cards the band shows: one row on a desktop, two on a phone. */
export const SHOWCASE_MAX = 4;

/** A name nobody chose: the defaults a design gets when it is saved unnamed. */
const UNNAMED = /^(untitled(\s+tifo)?|my\s+tifo(\s+\d+)?|tifo|تيفو)$/i;

/** The design the tifo-of-the-day card above the grid shows, if any. */
function featuredId(): string | null {
  const href = document.querySelector<HTMLAnchorElement>('#featured-tifo a.fd-card')?.getAttribute('href') ?? '';
  return href.match(/^\/t\/([A-Za-z0-9-]+)/)?.[1] ?? null;
}

/**
 * The cards, from the gallery sorted by likes: named designs with a picture,
 * not the featured one; people's first, at most one each; the starter
 * templates only fill what people have not.
 */
export function curateShowcase(all: GalleryItem[], skipId: string | null, max = SHOWCASE_MAX): GalleryItem[] {
  const named = all.filter((d) => d.hasThumbnail && d.id !== skipId && !!d.title?.trim() && !UNNAMED.test(d.title.trim()));
  const seen = new Set<string>();
  const people: GalleryItem[] = [];
  for (const d of named) {
    if (d.isTemplate) continue;
    const who = d.ownerId ?? `@${d.ownerName}`;
    if (seen.has(who)) continue;
    seen.add(who);
    people.push(d);
  }
  return [...people, ...named.filter((d) => d.isTemplate)].slice(0, max);
}

const FORK_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/></svg>';

/**
 * Take the grid down without taking the Tifo of the Day with it: that card sits
 * in this section too and is rendered by the server, so hiding the section on a
 * failed gallery fetch would hide a card that is perfectly fine.
 */
function hideGrid(section: HTMLElement): void {
  const featured = document.getElementById('featured-tifo');
  if (featured && featured.children.length > 0) {
    // The heading stays: it introduces the featured card just as well.
    section.querySelector<HTMLElement>('.showcase-grid')?.style.setProperty('display', 'none');
    section.querySelector<HTMLElement>('.showcase-cta')?.style.setProperty('display', 'none');
    return;
  }
  section.style.display = 'none';
}

export async function mountShowcase(): Promise<void> {
  const grid = document.getElementById(GRID_ID);
  const section = document.getElementById(SECTION_ID);
  if (!grid || !section) return;
  // Not until it is nearly on screen. The eight thumbnails were ~350 KB, and
  // they were downloaded on page load, below the fold, before a phone
  // visitor could tap "Start designing".
  await nearViewport(section);

  try {
    const { listGallery, thumbnailUrl } = await import('./net/api');
    const { t, tTitle } = await import('./ui/i18n');
    // Prefer the most-liked designs; they're the best social proof. The band
    // says "designed by supporters", so people's own designs come first and
    // the starter templates only fill the rows people have not yet.
    const items = curateShowcase(await listGallery({ sort: 'likes' }), featuredId());
    if (items.length === 0) {
      hideGrid(section);
      return;
    }
    grid.innerHTML = items
      .map((item) => {
        const title = tTitle(item);
        const use = item.allowRemix !== false
          ? `<a class="showcase-use" href="${localPath(`/d/${encodeURIComponent(item.id)}`)}" aria-label="${escapeHtml(`${t('showcase.use')}: ${title}`)}">${FORK_SVG}<span>${escapeHtml(t('showcase.use'))}</span></a>`
          : '';
        return `
        <article class="showcase-card">
          <a class="showcase-open" href="${localPath(`/community?t=${encodeURIComponent(item.id)}`)}" aria-label="${escapeHtml(t('cm.cardBy').replace('{title}', title).replace('{name}', item.ownerName))}">
            <div class="showcase-thumb is-bowl"><img data-bowl="${thumbnailUrl(item.id)}" alt="" /></div>
            <div class="showcase-meta">
              <span class="showcase-title">${escapeHtml(title)}</span>
              <span class="showcase-by">@${escapeHtml(item.ownerName)}</span>
            </div>
          </a>
          ${use}
        </article>`;
      })
      .join('');
    grid.setAttribute('aria-busy', 'false');
    // Each strip drawn as the tifo in the bowl (ui/bowlPicture.ts): the old
    // 16:10 tile cropped a 10:1 strip to a magnified sliver of it.
    const { hydrateBowls } = await import('./ui/bowlPicture');
    hydrateBowls(grid);
  } catch {
    hideGrid(section);
  }
}

/** Resolves when `el` comes within half a screen of the viewport (at once without IntersectionObserver). */
function nearViewport(el: Element): Promise<void> {
  if (typeof IntersectionObserver === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          resolve();
        }
      },
      // Half a screen ahead: early enough that the cards are there when the
      // section is, late enough that a visitor who never scrolls never pays.
      { rootMargin: '50% 0px' },
    );
    io.observe(el);
  });
}
