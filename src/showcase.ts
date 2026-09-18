/**
 * Homepage community showcase — pulls real public designs from the existing
 * gallery API and renders a thumbnail grid as social proof. Cards link into the
 * /community hub (where the live 3D preview modal already lives), so this adds
 * zero new backend and reuses the existing thumbnail + gallery endpoints.
 *
 * Fails gracefully: if there's nothing to show (or the request fails), the grid
 * hides itself rather than showing an empty box on a cold homepage — and the
 * whole section goes with it UNLESS the Tifo of the Day card is up, which lives
 * in the same section and is not this module's to take down.
 */
import { escapeHtml } from './core/escape';

const GRID_ID = 'showcase-grid';
const SECTION_ID = 'showcase';

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

  try {
    const { listGallery, thumbnailUrl } = await import('./net/api');
    const { t, tTitle } = await import('./ui/i18n');
    // Prefer the most-liked designs; they're the best social proof.
    let items = await listGallery({ sort: 'likes' });
    // Only show ones with a real thumbnail to avoid empty tiles.
    items = items.filter((d) => d.hasThumbnail).slice(0, 8);
    if (items.length === 0) {
      hideGrid(section);
      return;
    }
    grid.innerHTML = items
      .map(
        (item) => `
        <a class="showcase-card" href="/community" aria-label="${escapeHtml(t('cm.cardBy').replace('{title}', tTitle(item)).replace('{name}', item.ownerName))}">
          <div class="showcase-thumb" style="background-image:url('${thumbnailUrl(item.id)}')"></div>
          <div class="showcase-meta">
            <span class="showcase-title">${escapeHtml(tTitle(item))}</span>
            <span class="showcase-by">@${escapeHtml(item.ownerName)}</span>
          </div>
        </a>`,
      )
      .join('');
    grid.setAttribute('aria-busy', 'false');
  } catch {
    hideGrid(section);
  }
}

