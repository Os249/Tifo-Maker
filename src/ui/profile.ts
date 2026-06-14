import { fetchProfile, thumbnailUrl, type GalleryItem } from '../net/api';

/**
 * Profile overlay. Shows a user's name, the tifos they've published (created),
 * and the public tifos they've liked. Clicking any opens it via onPick (load to
 * remix). Used both for the signed-in user (from the header button) and, later,
 * for viewing other creators.
 */
export async function openProfile(userId: string, onPick: (id: string) => void): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.className = 'feed-backdrop';
  backdrop.innerHTML = `
    <div class="feed-panel" role="dialog" aria-modal="true" aria-label="Profile">
      <div class="feed-head">
        <div class="feed-title" id="pf-name">Profile</div>
        <div class="feed-sub" id="pf-sub">Loading…</div>
        <button class="feed-close" aria-label="Close">&times;</button>
        <div class="feed-controls">
          <div class="feed-sorts">
            <button class="feed-sort active" data-tab="created">Created</button>
            <button class="feed-sort" data-tab="liked">Liked</button>
          </div>
        </div>
      </div>
      <div class="feed-grid" id="pf-grid"><div class="feed-loading">Loading…</div></div>
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

  const grid = backdrop.querySelector('#pf-grid') as HTMLElement;
  const tabs = Array.from(backdrop.querySelectorAll('.feed-sort')) as HTMLButtonElement[];

  const renderGrid = (items: GalleryItem[], emptyMsg: string): void => {
    grid.innerHTML = '';
    if (items.length === 0) {
      grid.innerHTML = `<div class="feed-empty">${emptyMsg}</div>`;
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
          <div class="feed-card-by">${item.likeScore} ${item.likeScore === 1 ? 'like' : 'likes'}</div>
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
  };

  try {
    const profile = await fetchProfile(userId);
    (backdrop.querySelector('#pf-name') as HTMLElement).textContent = profile.username;
    (backdrop.querySelector('#pf-sub') as HTMLElement).textContent =
      `${profile.created.length} created · ${profile.liked.length} liked`;
    let tab: 'created' | 'liked' = 'created';
    const show = (): void => {
      if (tab === 'created') renderGrid(profile.created, 'No public tifos yet. Publish one to show it here!');
      else renderGrid(profile.liked, 'No liked tifos yet. Like designs in the feed to collect them here.');
    };
    tabs.forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab as 'created' | 'liked';
        tabs.forEach((x) => x.classList.toggle('active', x === b));
        show();
      }),
    );
    show();
  } catch (err) {
    grid.innerHTML = `<div class="feed-empty">Couldn’t load profile: ${escapeHtml((err as Error).message)}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
