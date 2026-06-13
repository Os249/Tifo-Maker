import { listGallery, thumbnailUrl, type GalleryItem } from '../net/api';

/**
 * Community feed: a full-screen overlay of published tifos. The heart of the
 * sharing loop — browse what others made, open any design as a working copy to
 * remix. Thumbnails are the ones we already render and store. Floodlight-themed.
 *
 * onPick(id) loads the chosen design into the editor (as a remixable copy).
 */
export async function openGallery(onPick: (id: string) => void): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.className = 'feed-backdrop';
  backdrop.innerHTML = `
    <div class="feed-panel" role="dialog" aria-modal="true" aria-label="Community feed">
      <div class="feed-head">
        <div class="feed-title">Community feed</div>
        <div class="feed-sub">Open any tifo to remix it — your changes start a fresh copy.</div>
        <button class="feed-close" aria-label="Close">&times;</button>
      </div>
      <div class="feed-grid" id="feed-grid">
        <div class="feed-loading">Loading published tifos…</div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.feed-close')!.addEventListener('click', close);

  const grid = backdrop.querySelector('#feed-grid') as HTMLElement;
  try {
    const items: GalleryItem[] = await listGallery();
    grid.innerHTML = '';
    if (items.length === 0) {
      grid.innerHTML =
        '<div class="feed-empty">No public tifos yet — be the first! Design something, then tick “List in public gallery” and Save.</div>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'feed-card';
      const thumb = item.hasThumbnail
        ? `<img class="feed-thumb" src="${thumbnailUrl(item.id)}" alt="${escapeHtml(item.title)}" loading="lazy" />`
        : '<div class="feed-thumb feed-thumb-empty"></div>';
      card.innerHTML = `
        ${thumb}
        <div class="feed-card-body">
          <div class="feed-card-title">${escapeHtml(item.title)}</div>
          <div class="feed-card-by">by ${escapeHtml(item.ownerName)}</div>
        </div>
        <button class="feed-open primary">Open &amp; remix</button>
      `;
      const open = (): void => {
        close();
        onPick(item.id);
      };
      card.querySelector('.feed-open')!.addEventListener('click', open);
      card.querySelector('.feed-thumb')!.addEventListener('click', open);
      grid.appendChild(card);
    }
  } catch (err) {
    grid.innerHTML = `<div class="feed-empty">Couldn’t load the feed: ${escapeHtml((err as Error).message)}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
