/**
 * Homepage community showcase — pulls real public designs from the existing
 * gallery API and renders a thumbnail grid as social proof. Cards link into the
 * /community hub (where the live 3D preview modal already lives), so this adds
 * zero new backend and reuses the existing thumbnail + gallery endpoints.
 *
 * Fails gracefully: if there's nothing to show (or the request fails), the whole
 * section hides itself rather than showing an empty box on a cold homepage.
 */

const GRID_ID = 'showcase-grid';
const SECTION_ID = 'showcase';

export async function mountShowcase(): Promise<void> {
  const grid = document.getElementById(GRID_ID);
  const section = document.getElementById(SECTION_ID);
  if (!grid || !section) return;

  try {
    const { listGallery, thumbnailUrl } = await import('./net/api');
    // Prefer the most-liked designs; they're the best social proof.
    let items = await listGallery({ sort: 'likes' });
    // Only show ones with a real thumbnail to avoid empty tiles.
    items = items.filter((d) => d.hasThumbnail).slice(0, 8);
    if (items.length === 0) {
      section.style.display = 'none';
      return;
    }
    grid.innerHTML = items
      .map(
        (item) => `
        <a class="showcase-card" href="/community" aria-label="${escapeAttr(item.title)} by ${escapeAttr(item.ownerName)}">
          <div class="showcase-thumb" style="background-image:url('${thumbnailUrl(item.id)}')"></div>
          <div class="showcase-meta">
            <span class="showcase-title">${escapeHtml(item.title)}</span>
            <span class="showcase-by">@${escapeHtml(item.ownerName)}</span>
          </div>
        </a>`,
      )
      .join('');
    grid.setAttribute('aria-busy', 'false');
  } catch {
    section.style.display = 'none';
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
