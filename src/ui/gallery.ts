import {
  listGallery, listPopularTags, reportDesign, thumbnailUrl, voteDesign, isSignedIn,
  type GalleryItem, type GallerySort,
} from '../net/api';

/**
 * Community feed: a full-screen overlay of published tifos. The heart of the
 * sharing loop. Browse what others made, search by name, sort by recent or most
 * liked, filter to templates or by tag, like/dislike, report, and open any
 * design as a working copy to remix.
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
            <button class="feed-sort feed-templates" id="feed-templates">Templates</button>
          </div>
        </div>
        <div class="feed-tags" id="feed-tags"></div>
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
  const sortButtons = Array.from(backdrop.querySelectorAll('.feed-sort[data-sort]')) as HTMLButtonElement[];
  const templatesBtn = backdrop.querySelector('#feed-templates') as HTMLButtonElement;
  const tagsBar = backdrop.querySelector('#feed-tags') as HTMLElement;

  let sort: GallerySort = 'recent';
  let search = '';
  let templatesOnly = false;
  const activeTags = new Set<string>();
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const render = (items: GalleryItem[]): void => {
    grid.innerHTML = '';
    if (items.length === 0) {
      const filtering = search || templatesOnly || activeTags.size > 0;
      grid.innerHTML = filtering
        ? '<div class="feed-empty">No tifos match those filters.</div>'
        : '<div class="feed-empty">No public tifos yet — be the first! Design something, then tick “List in public gallery” and Save.</div>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'feed-card';
      const thumb = item.hasThumbnail
        ? `<img class="feed-thumb" src="${thumbnailUrl(item.id)}" alt="${escapeHtml(item.title)}" loading="lazy" />`
        : '<div class="feed-thumb feed-thumb-empty"></div>';
      const tagline =
        item.tags.length > 0
          ? `<div class="feed-card-tags">${item.tags.slice(0, 4).map((t) => `<span class="feed-card-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}</div>`
          : '';
      const tmplBadge = item.isTemplate ? '<span class="feed-tmpl-badge">Template</span>' : '';
      const photoBadge = item.hasPhoto ? '<span class="feed-photo-badge">Before / After</span>' : '';
      card.innerHTML = `
        <div class="feed-thumb-wrap">
          ${thumb}
          ${item.hasPhoto ? '<button class="feed-ba-btn" title="See it built in real life"><i class="ti ti-arrows-left-right"></i> Before / After</button>' : ''}
        </div>
        <div class="feed-card-body">
          <div class="feed-card-title">${escapeHtml(item.title)} ${tmplBadge} ${photoBadge}</div>
          <div class="feed-card-by">by ${escapeHtml(item.ownerName)}</div>
          ${tagline}
          <div class="feed-votes">
            <button class="feed-vote like ${item.myVote === 1 ? 'on' : ''}" title="Like" aria-label="Like">
              <i class="ti ti-arrow-big-up"></i><span class="feed-score">${item.likeScore}</span>
            </button>
            <button class="feed-vote dislike ${item.myVote === -1 ? 'on' : ''}" title="Dislike" aria-label="Dislike">
              <i class="ti ti-arrow-big-down"></i>
            </button>
            <button class="feed-report" title="Report this tifo" aria-label="Report"><i class="ti ti-flag"></i></button>
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

      // Before/After button opens the split-slider without leaving the feed.
      const baBtn = card.querySelector('.feed-ba-btn');
      if (baBtn) {
        baBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { openBeforeAfter } = await import('./beforeAfter');
          await openBeforeAfter(item);
        });
      }

      // Clicking a card tag adds it to the active filter.
      card.querySelectorAll('.feed-card-tag').forEach((el) =>
        el.addEventListener('click', () => {
          const t = (el as HTMLElement).dataset.tag!;
          activeTags.add(t);
          syncTagChips();
          void load();
        }),
      );

      const likeBtn = card.querySelector('.feed-vote.like') as HTMLButtonElement;
      const dislikeBtn = card.querySelector('.feed-vote.dislike') as HTMLButtonElement;
      const scoreEl = card.querySelector('.feed-score') as HTMLElement;
      const doVote = async (intended: 1 | -1): Promise<void> => {
        if (!isSignedIn()) {
          const ok = onNeedAuth ? await onNeedAuth() : false;
          if (!ok) return;
        }
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

      const reportBtn = card.querySelector('.feed-report') as HTMLButtonElement;
      reportBtn.addEventListener('click', async () => {
        const { promptModal } = await import('./modal');
        const reason = await promptModal({
          title: 'Report this tifo',
          message: 'What’s the problem? This goes to the moderators.',
          placeholder: 'e.g. hateful content, spam, stolen design',
          confirmLabel: 'Submit report',
          multiline: true,
          maxLength: 300,
        });
        if (!reason || !reason.trim()) return;
        try {
          await reportDesign(item.id, reason.trim());
          reportBtn.classList.add('reported');
          reportBtn.title = 'Reported — thank you';
        } catch {
          /* ignore */
        }
      });

      grid.appendChild(card);
    }
  };

  let loadToken = 0;
  const load = async (): Promise<void> => {
    const token = ++loadToken;
    try {
      const items = await listGallery({
        sort,
        search,
        templatesOnly,
        tags: activeTags.size ? [...activeTags] : undefined,
      });
      if (token !== loadToken) return; // a newer load() superseded this one
      render(items);
    } catch (err) {
      if (token !== loadToken) return;
      grid.innerHTML = `<div class="feed-empty">Couldn’t load the feed: ${escapeHtml((err as Error).message)}</div>`;
    }
  };

  // Active-tag chips (removable) above the grid.
  const syncTagChips = (): void => {
    tagsBar.innerHTML = '';
    if (activeTags.size === 0) {
      tagsBar.classList.remove('has-tags');
      return;
    }
    tagsBar.classList.add('has-tags');
    for (const t of activeTags) {
      const chip = document.createElement('button');
      chip.className = 'feed-tag-chip active';
      chip.innerHTML = `${escapeHtml(t)} <span class="x">&times;</span>`;
      chip.addEventListener('click', () => {
        activeTags.delete(t);
        syncTagChips();
        void load();
      });
      tagsBar.appendChild(chip);
    }
  };

  sortButtons.forEach((b) =>
    b.addEventListener('click', () => {
      sort = b.dataset.sort as GallerySort;
      sortButtons.forEach((x) => x.classList.toggle('active', x === b));
      void load();
    }),
  );
  templatesBtn.addEventListener('click', () => {
    templatesOnly = !templatesOnly;
    templatesBtn.classList.toggle('active', templatesOnly);
    void load();
  });
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void load(), 250);
  });

  // Suggested tag chips from the most-used tags (click to filter).
  try {
    const popular = await listPopularTags();
    if (popular.length > 0) {
      const suggest = document.createElement('div');
      suggest.className = 'feed-tag-suggest';
      suggest.innerHTML =
        '<span class="feed-tag-label">Popular:</span>' +
        popular.slice(0, 12).map((t) => `<button class="feed-tag-chip" data-tag="${escapeHtml(t.slug)}">${escapeHtml(t.slug)}</button>`).join('');
      tagsBar.parentElement!.insertBefore(suggest, tagsBar);
      suggest.querySelectorAll('.feed-tag-chip').forEach((el) =>
        el.addEventListener('click', () => {
          activeTags.add((el as HTMLElement).dataset.tag!);
          syncTagChips();
          void load();
        }),
      );
    }
  } catch {
    /* tags are optional sugar; ignore failures */
  }

  await load();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
