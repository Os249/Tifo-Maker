import { listGallery, thumbnailUrl, voteDesign, isSignedIn, type GalleryItem, type GallerySort } from '../net/api';

/**
 * Community feed: a full-screen overlay of published tifos. The heart of the
 * sharing loop. Browse what others made, search by name, sort by recent or most
 * liked, like/dislike, and open any design as a working copy to remix.
 *
 * onPick(id) loads the chosen design into the editor (as a remixable copy).
 * onNeedAuth() is called when an action requires sign-in.
 */
export async function openGallery(
  onPick: (id: string) => void,
  onNeedAuth?: () => Promise<boolean>,
): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.className = 'feed-backdrop';
  backdrop.innerHTML = `
    <div class="feed-panel" role="dialog" aria-modal="true" aria-label="Community feed">
      <div class="feed-head">
        <div class="feed-title">Community feed</div>
        <div class="feed-sub">Open any tifo to remix it — your changes start a fresh copy.</div>
        <button class="feed-close" aria-label="Close">&times;</button>
        <div class="feed-controls">
          <input type="search" class="feed-search" id="feed-search" placeholder="Search by name…" />
          <div class="feed-sorts">
            <button class="feed-sort active" data-sort="recent">Recent</button>
            <button class="feed-sort" data-sort="likes">Most liked</button>
          </div>
        </div>
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
  const searchInput = backdrop.querySelector('#feed-search') as HTMLInputElement;
  const sortButtons = Array.from(backdrop.querySelectorAll('.feed-sort')) as HTMLButtonElement[];

  let sort: GallerySort = 'recent';
  let search = '';
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const render = (items: GalleryItem[]): void => {
    grid.innerHTML = '';
    if (items.length === 0) {
      grid.innerHTML = search
        ? `<div class="feed-empty">No tifos match “${escapeHtml(search)}”.</div>`
        : '<div class="feed-empty">No public tifos yet — be the first! Design something, then tick “List in public gallery” and Save.</div>';
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
          <div class="feed-votes">
            <button class="feed-vote like ${item.myVote === 1 ? 'on' : ''}" title="Like" aria-label="Like">
              <i class="ti ti-arrow-big-up"></i><span class="feed-score">${item.likeScore}</span>
            </button>
            <button class="feed-vote dislike ${item.myVote === -1 ? 'on' : ''}" title="Dislike" aria-label="Dislike">
              <i class="ti ti-arrow-big-down"></i>
            </button>
          </div>
        </div>
        <button class="feed-open primary">Open &amp; remix</button>
      `;
      const open = (): void => {
        close();
        onPick(item.id);
      };
      card.querySelector('.feed-open')!.addEventListener('click', open);
      card.querySelector('.feed-thumb')!.addEventListener('click', open);

      const likeBtn = card.querySelector('.feed-vote.like') as HTMLButtonElement;
      const dislikeBtn = card.querySelector('.feed-vote.dislike') as HTMLButtonElement;
      const scoreEl = card.querySelector('.feed-score') as HTMLElement;
      const doVote = async (intended: 1 | -1): Promise<void> => {
        if (!isSignedIn()) {
          const ok = onNeedAuth ? await onNeedAuth() : false;
          if (!ok) return;
        }
        // Toggle off if re-clicking the active vote.
        const value: 1 | -1 | 0 = item.myVote === intended ? 0 : intended;
        try {
          const res = await voteDesign(item.id, value);
          item.myVote = res.myVote;
          item.likeScore = res.likeScore;
          scoreEl.textContent = String(res.likeScore);
          likeBtn.classList.toggle('on', res.myVote === 1);
          dislikeBtn.classList.toggle('on', res.myVote === -1);
        } catch {
          /* ignore transient vote errors */
        }
      };
      likeBtn.addEventListener('click', () => void doVote(1));
      dislikeBtn.addEventListener('click', () => void doVote(-1));

      grid.appendChild(card);
    }
  };

  let loadToken = 0;
  const load = async (): Promise<void> => {
    const token = ++loadToken;
    try {
      const items = await listGallery({ sort, search });
      if (token !== loadToken) return; // a newer load() superseded this one
      render(items);
    } catch (err) {
      if (token !== loadToken) return;
      grid.innerHTML = `<div class="feed-empty">Couldn’t load the feed: ${escapeHtml((err as Error).message)}</div>`;
    }
  };

  sortButtons.forEach((b) =>
    b.addEventListener('click', () => {
      sort = b.dataset.sort as GallerySort;
      sortButtons.forEach((x) => x.classList.toggle('active', x === b));
      void load();
    }),
  );
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void load(), 250);
  });

  await load();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
