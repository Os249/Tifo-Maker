// The icon font is bundled, not pulled from a CDN at runtime.
//
// community.css used to @import it from jsdelivr, pinned at 2.47.0 while the
// installed package was 3.21.0 - two majors apart, across which icon names
// changed. It was also a render-blocking third-party request on the page whose
// whole job is browsing images, made before the consent bar is answered, and
// when it failed all thirteen icons on the page rendered as nothing: the like
// and comment counts became a bare "0  0".
import { escapeHtml } from './core/escape';
import './vendor/tabler-subset.css';
import './community.css';
import { initLang, applyDom, getLang, onLangChange, toggleLang, t, tv, tTag, tTitle } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { generateSeatMapAsync } from './workers/client';
import { TEMPLATES } from './core/template';
import { DesignStore } from './core/design';
import { Preview3D, CAMERA_PRESETS } from './render/preview3d';
import { openAuthModal } from './ui/authModal';
import { openShareModal } from './ui/shareModal';
import {
  isSignedIn,
  fetchMe,
  listGallery,
  listGalleryFacets,
  type GalleryFacets,
  listPopularTags,
  loadDesign,
  voteDesign,
  thumbnailUrl,
  remixDesign,
  reportDesign,
  followUser,
  unfollowUser,
  searchUsers,
  listComments,
  addComment,
  deleteComment,
  fetchGalleryItem,
  recordView,
  listNotifications,
  markNotificationsRead,
  fetchProfile,
  type GalleryItem,
  type GallerySort,
  type CommentItem,
  type NotificationItem,
  type ProfileData,
} from './net/api';

// ---------- bootstrap ----------
initLang();
// Light / dark. The scheme is already on the <html> element (the inline head
// script settles it before first paint); this wires the header toggle and the
// translated labels.
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });

applyDom(document);
installMobileNav();
installConsent();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
let me: { id: string; username: string; isAdmin: boolean } | null = null;

const toast = (msg: string): void => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
};

const initials = (name: string): string => name.replace(/^@/, '').slice(0, 2).toUpperCase();
const timeAgo = (iso: string): string => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// ---------- nav: auth + language ----------
const authBtn = $('#auth-btn') as HTMLButtonElement;
const langToggle = $('#lang-toggle');
langToggle?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  langToggle.textContent = t('common.language');
});

async function refreshAuthUI(): Promise<void> {
  me = await fetchMe().catch(() => null);
  const notifBtn = $('#notif-btn');
  if (me) {
    // Drop the i18n binding while it holds a username: applyDom() rewrites every
    // [data-i18n] node on a language switch, so leaving it attached turned
    // "@os99" back into "Sign in" the moment someone toggled to Arabic.
    authBtn.removeAttribute('data-i18n');
    authBtn.textContent = `@${me.username}`;
    authBtn.onclick = () => {
      window.location.href = '/app';
    };
    notifBtn.hidden = false;
    void refreshNotifications();
    startNotifPolling();
  } else {
    authBtn.setAttribute('data-i18n', 'ed.signup');
    authBtn.textContent = t('ed.signup');
    authBtn.onclick = async () => {
      const tok = await openAuthModal();
      if (tok) {
        await refreshAuthUI();
        void loadGallery();
      }
    };
    notifBtn.hidden = true;
  }
}

async function ensureAuth(): Promise<boolean> {
  if (isSignedIn()) return true;
  const tok = await openAuthModal();
  if (tok) {
    await refreshAuthUI();
    return true;
  }
  return false;
}

// ---------- gallery ----------
let currentSort: GallerySort | 'templates' | 'people' = 'recent';
let activeTags: string[] = [];
/** Colour families, OR'd. See core/facets for where they come from. */
let activeColours: string[] = [];
let activeClub = '';

/**
 * Paging.
 *
 * The starter-template library alone is ~600 designs, so the old "fetch every
 * public design and append 600 cards" load is no longer something a phone
 * should be asked to do. Pages are 60; scrolling near the bottom pulls the
 * next one, and the button below the sentinel is the keyboard/no-observer path.
 *
 * `token` guards against a slow page landing after the user has switched tab or
 * tag: a response whose token no longer matches is dropped instead of being
 * appended to a grid it does not belong to.
 */
const PAGE = 60;
let pageOffset = 0;
let pageToken = 0;
let exhausted = false;
/**
 * Which request is in flight, by token — not a bare boolean.
 *
 * It used to be a boolean, and loadPage refused outright while one was
 * running. But loadGallery CLEARS THE GRID before it calls loadPage, so a
 * refused call left the feed permanently empty: no cards, no loader, no retry,
 * until the next thing you clicked. Two quick tab clicks did it, and removing
 * a filter pill — which reloads the panel and the feed together — did it every
 * time.
 *
 * A newer token must always be allowed through; the older call discards its own
 * result at the token check below, which is what that check has always been
 * for. The same token twice is still refused, which is the infinite scroll not
 * fetching the same page twice.
 */
let loadingToken = -1;

async function loadGallery(): Promise<void> {
  pageOffset = 0;
  exhausted = false;
  pageToken++;
  const grid = $('#gallery-grid');
  const loading = $('#grid-loading');
  const empty = $('#grid-empty');
  // The server ships a plain list of links so crawlers (and anyone without JS)
  // can reach every published tifo. Once the real grid is about to render it
  // has done its job, and leaving it would show the same designs twice.
  document.getElementById('seo-feed')?.remove();
  grid.innerHTML = '';
  $('#grid-more').hidden = true;
  loading.hidden = false;
  empty.hidden = true;
  const ok = await loadPage(pageToken);
  loading.hidden = true;
  if (!ok) return;
  if (grid.childElementCount === 0) empty.hidden = false;
}

/** Append one page. Returns false if the request failed. */
async function loadPage(token: number): Promise<boolean> {
  if (exhausted || loadingToken === token) return true;
  loadingToken = token;
  const more = $('#grid-more');
  more.dataset.busy = '1';
  try {
    const sort: GallerySort = currentSort === 'likes' ? 'likes' : 'recent';
    const items = await listGallery({
      sort,
      tags: activeTags,
      templatesOnly: currentSort === 'templates',
      peopleOnly: currentSort === 'people',
      colors: activeColours,
      clubId: activeClub || undefined,
      limit: PAGE,
      offset: pageOffset,
    });
    if (token !== pageToken) return true; // a newer tab/tag won the race
    const grid = $('#gallery-grid');
    for (const item of items) grid.appendChild(renderCard(item));
    pageOffset += items.length;
    if (items.length < PAGE) exhausted = true;
    more.hidden = exhausted || grid.childElementCount === 0;
    $('#grid-more-count').textContent = exhausted ? '' : t('cm.shown').replace('{n}', String(pageOffset));
    void fillCommentCounts(items);
    return true;
  } catch {
    if (token === pageToken) $('#grid-loading').textContent = t('cm.errFeed');
    return false;
  } finally {
    // Only if we are still the current request. A stale call finishing late
    // must not unlock — or un-busy — the newer one that replaced it. An `if`
    // block and not an early return: a `return` inside a finally REPLACES
    // whatever the try or catch was returning, so this one would quietly hand
    // back undefined and loadGallery would read it as a failed page.
    if (loadingToken === token) {
      loadingToken = -1;
      more.dataset.busy = '';
    }
  }
}

/** Wire the sentinel and the button once, at mount. */
function initPaging(): void {
  $('#grid-more-btn').addEventListener('click', () => void loadPage(pageToken));
  const sentinel = document.getElementById('grid-sentinel');
  if (!sentinel || typeof IntersectionObserver === 'undefined') return;
  new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) void loadPage(pageToken); },
    { rootMargin: '600px 0px' }, // start fetching before the user reaches the end
  ).observe(sentinel);
}

function renderCard(item: GalleryItem, onClick?: () => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'tifo-card';
  const thumb = item.hasThumbnail
    ? `<div class="card-thumb"><img class="card-thumb-img" src="${thumbnailUrl(item.id)}" alt="" loading="lazy" />`
    : `<div class="card-thumb card-thumb-empty">`;
  // Badges sit in the body, not over the art. They used to float on the
  // thumbnail, which was free while the card wasted half its height on
  // letterbox; once the thumbnail was tightened to the tifo's real shape the
  // pill covered the left end of the design.
  const badges =
    item.isTemplate || item.hasPhoto
      ? `<div class="card-badges">` +
        (item.isTemplate ? `<span class="badge template">${escapeHtml(t('cm.badgeTemplate'))}</span>` : '') +
        (item.hasPhoto ? `<span class="badge photo">${escapeHtml(t('cm.badgePhoto'))}</span>` : '') +
        `</div>`
      : '';
  const remixed = item.remixedFromName
    ? `<div class="card-remixed">↻ remixed from <span class="at">@${escapeHtml(item.remixedFromName)}</span></div>`
    : '';
  const liked = item.myVote === 1;
  card.innerHTML = `
    ${thumb}</div>
    <div class="card-body">
      ${badges}
      <div class="card-title">${escapeHtml(tTitle(item))}</div>
      <div class="card-by">${escapeHtml(t('cm.by'))} <span class="at">@${escapeHtml(item.ownerName)}</span></div>
      ${remixed}
      <div class="card-stats">
        <span class="card-stat like ${liked ? 'on' : ''}"><i class="ti ti-heart${liked ? '-filled' : ''}"></i> ${item.likeScore}</span>
        <span class="card-stat"><i class="ti ti-message-circle"></i> <span class="cmt-count" data-id="${item.id}">·</span></span>
        <span class="card-stat views" title="${escapeHtml(t('cm.viewsTitle'))}"><i class="ti ti-eye"></i> <span class="view-count" data-id="${item.id}">${item.viewCount ?? 0}</span></span>
        <button class="card-stat card-share" title="${escapeHtml(t('cm.shareThis'))}"><i class="ti ti-share"></i></button>
      </div>
    </div>`;
  card.addEventListener('click', () => (onClick ? onClick() : openPreview(item)));
  // Share button — opens the share modal without triggering the card's open.
  const shareBtn = card.querySelector('.card-share') as HTMLElement | null;
  shareBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openShareModal({ id: item.id, title: item.title });
  });
  // The @username opens the creator profile instead of the tifo preview.
  if (item.ownerId) {
    const at = card.querySelector('.card-by .at') as HTMLElement | null;
    if (at) {
      at.style.cursor = 'pointer';
      at.addEventListener('click', (e) => {
        e.stopPropagation();
        void openProfile(item.ownerId!);
      });
    }
  }
  return card;
}


// ---------- creator profile view ----------
async function openProfile(userId: string): Promise<void> {
  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal profile-modal">
      <button class="modal-close" id="profile-close" aria-label="Close">&times;</button>
      <div class="profile-loading">Loading profile…</div>
    </div>`;
  const close = (): void => {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', escProfile);
  };
  $('#profile-close').addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', escProfile);

  let profile: ProfileData;
  try {
    profile = await fetchProfile(userId);
  } catch {
    const modal = root.querySelector('.profile-modal');
    if (modal) modal.querySelector('.profile-loading')!.textContent = t('cm.errProfile');
    return;
  }

  const isSelf = me && me.id === userId;
  const modal = root.querySelector('.profile-modal') as HTMLElement;
  modal.innerHTML = `
    <button class="modal-close" id="profile-close" aria-label="Close">&times;</button>
    <div class="profile-head">
      <div class="profile-avatar">${initials(profile.username)}</div>
      <div class="profile-id">
        <h2 class="profile-name">@${escapeHtml(profile.username)}</h2>
        <div class="profile-counts">
          <span><b>${profile.designCount ?? profile.created.length}</b> tifo${(profile.designCount ?? profile.created.length) === 1 ? '' : 's'}</span>
          <span><b>${profile.followerCount ?? 0}</b> follower${(profile.followerCount ?? 0) === 1 ? '' : 's'}</span>
          <span><b>${profile.followingCount ?? 0}</b> following</span>
        </div>
      </div>
      ${isSelf ? '' : `<button class="follow-btn ${profile.isFollowing ? 'following' : ''}" id="profile-follow">${profile.isFollowing ? 'Following' : 'Follow'}</button>`}
    </div>
    <div class="profile-grid-wrap">
      <div class="profile-section-title">Public tifos</div>
      <div class="profile-grid" id="profile-grid"></div>
    </div>`;
  modal.querySelector('#profile-close')!.addEventListener('click', close);

  // follow toggle
  const followBtn = modal.querySelector('#profile-follow') as HTMLButtonElement | null;
  if (followBtn) {
    let following = !!profile.isFollowing;
    followBtn.addEventListener('click', async () => {
      if (!(await ensureAuth())) return;
      try {
        if (following) {
          await unfollowUser(userId);
          following = false;
          followBtn.textContent = t('cm.follow');
          followBtn.classList.remove('following');
        } else {
          await followUser(userId);
          following = true;
          followBtn.textContent = t('cm.following');
          followBtn.classList.add('following');
        }
      } catch {
        toast(t('cm.errFollow'));
      }
    });
  }

  // their tifos
  const grid = modal.querySelector('#profile-grid') as HTMLElement;
  if (profile.created.length === 0) {
    grid.innerHTML = `<div class="profile-empty">No public tifos yet.</div>`;
  } else {
    for (const item of profile.created) {
      const card = renderCard(item, () => {
        close();
        void openPreview(item);
      });
      grid.appendChild(card);
    }
  }
}

function escProfile(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    const root = document.getElementById('modal-root');
    if (root && root.querySelector('.profile-modal')) {
      root.hidden = true;
      root.innerHTML = '';
      document.removeEventListener('keydown', escProfile);
    }
  }
}

// ---------- 3D preview modal ----------
let activePreview: Preview3D | null = null;

async function openPreview(item: GalleryItem, focusCommentId?: string | null): Promise<void> {
  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="modal-close" aria-label="Close">&times;</button>
      <div class="modal-3d">
        <div class="modal-3d-host" id="modal-3d-host">
          <div class="grid-loading" style="color:#9aa3b5;padding-top:80px;">Rendering stadium…</div>
        </div>
        <div class="modal-3d-bar" id="cam-bar"></div>
      </div>
      <div class="modal-side">
        <div class="side-head">
          <h2 class="side-title">${escapeHtml(tTitle(item))}</h2>
          <div class="side-author">
            <div class="side-avatar">${initials(item.ownerName)}</div>
            <div class="side-author-meta">
              <div class="side-author-name">@${escapeHtml(item.ownerName)}</div>
              <div class="side-author-handle" id="author-stats">creator</div>
            </div>
            <button class="follow-btn" id="follow-btn" ${!item.ownerId || (me && me.id === item.ownerId) ? 'hidden' : ''}>Follow</button>
          </div>
          <div class="side-stats">
            <span class="side-stat"><i class="ti ti-eye"></i> <span id="view-count">${item.viewCount ?? 0}</span> <span id="view-word">${escapeHtml(t('cm.viewsWord'))}</span></span>
          </div>
          ${
            item.description
              ? `<div class="explanation"><div class="explanation-label">${escapeHtml(t('cm.explanation'))}</div><div class="explanation-body">${escapeHtml(item.description)}</div></div>`
              : ''
          }
          <div class="side-actions">
            <button class="act-btn like ${item.myVote === 1 ? 'on' : ''}" id="like-btn"><i class="ti ti-heart${item.myVote === 1 ? '-filled' : ''}"></i> <span id="like-count">${item.likeScore}</span></button>
            ${item.allowRemix !== false ? `<button class="act-btn remix" id="remix-btn"><i class="ti ti-git-fork"></i> ${escapeHtml(t('cm.remix'))}</button>` : ''}
            <!-- Share sat only on the grid card, so the one screen where somebody
                 has just decided they like a tifo — open, in 3D, having read the
                 creator's note — was the one screen with no way to send it on. -->
            <button class="act-btn share" id="share-btn"><i class="ti ti-share"></i> ${escapeHtml(t('cm.share'))}</button>
            <button class="act-btn report" id="report-btn" title="${t('cm.report')}" aria-label="${t('cm.report')}"><i class="ti ti-flag"></i></button>
          </div>
        </div>
        <div class="comments" id="comments"><div class="comments-head">${escapeHtml(t('cm.comments'))}</div><div id="comment-list"></div></div>
        <div id="comment-foot"></div>
      </div>
    </div>`;

  // close handlers
  const close = (): void => closePreview();
  $('#modal-close').addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', escClose);

  // render the live 3D stadium
  void mountPreview3D(item);
  // follow / like / remix
  wirePreviewActions(item);
  // comments
  void loadCommentThread(item, focusCommentId);
  // author stats
  void fetchAuthorStats(item);
  // and this counts as a view
  void countView(item);
}

/**
 * Designs opened in this page session, so re-opening the same tifo does not
 * keep adding views.
 *
 * Until now the ONLY thing that counted a view was landing on a /t/:id share
 * link, so the number on a design was close to meaningless for anyone whose
 * tifo was found through the community. Opening it in 3D is a view.
 */
const viewed = new Set<string>();

async function countView(item: GalleryItem): Promise<void> {
  if (viewed.has(item.id)) return;
  viewed.add(item.id);
  try {
    const views = await recordView(item.id);
    item.viewCount = views;
    const inModal = document.getElementById('view-count');
    if (inModal) inModal.textContent = String(views);
    // The card behind the modal, so the number is right when it closes.
    const onCard = document.querySelector(`.view-count[data-id="${cssId(item.id)}"]`);
    if (onCard) onCard.textContent = String(views);
  } catch {
    /* a view that fails to record is not worth telling anyone about */
  }
}

/**
 * An id inside a QUOTED attribute selector: [data-id="<here>"].
 *
 * Not CSS.escape — that escapes identifiers, and a UUID beginning with a digit
 * comes back as `\34 1ab…`, which is correct for `#41ab…` and matches nothing
 * inside quotes. Roughly half of all UUIDs start with a digit, so the first
 * version of this silently failed to find the comment a notification pointed
 * at, or the card whose view count had just changed, about half the time.
 * Inside quotes only the quote and the backslash are special.
 */
function cssId(id: string): string {
  return id.replace(/["\\]/g, '\\$&');
}

function escClose(e: KeyboardEvent): void {
  if (e.key === 'Escape') closePreview();
}

function closePreview(): void {
  activePreview?.dispose();
  activePreview = null;
  document.removeEventListener('keydown', escClose);
  const root = $('#modal-root');
  root.hidden = true;
  root.innerHTML = '';
}

async function mountPreview3D(item: GalleryItem): Promise<void> {
  try {
    // Resolve the design's template, generate its seat map, load cells.
    const tpl = await resolveTemplate(item.id);
    const map = await generateSeatMapAsync(tpl);
    const store = new DesignStore(map, ['#262a33', '#1c5fd9']);
    await loadDesign(store, item.id);
    const host = document.getElementById('modal-3d-host');
    if (!host) return;
    host.innerHTML = '';
    const preview = new Preview3D(host, map, store);
    activePreview = preview;
    preview.start();
    // camera preset buttons
    const bar = document.getElementById('cam-bar');
    if (bar) {
      CAMERA_PRESETS.forEach((preset, i) => {
        const b = document.createElement('button');
        b.className = 'cam-btn';
        b.textContent = preset.name;
        b.addEventListener('click', () => preview.applyPreset(CAMERA_PRESETS[i]));
        bar.appendChild(b);
      });
    }
  } catch {
    const host = document.getElementById('modal-3d-host');
    if (host) host.innerHTML = `<div class="grid-loading" style="color:#9aa3b5;padding-top:80px;">${t('cm.errRender')}</div>`;
  }
}

/** Find the template object for a design (by querying its template id/version). */
async function resolveTemplate(designId: string): Promise<string> {
  const { fetchDesignTemplate } = await import('./net/api');
  const info = await fetchDesignTemplate(designId);
  const tpl = TEMPLATES.find((x) => x.id === info.templateId) ?? TEMPLATES[0];
  return tpl.id;
}

function wirePreviewActions(item: GalleryItem): void {
  // Like
  const likeBtn = document.getElementById('like-btn');
  likeBtn?.addEventListener('click', async () => {
    if (!(await ensureAuth())) return;
    const next = item.myVote === 1 ? 0 : 1;
    try {
      const r = await voteDesign(item.id, next as 1 | 0);
      item.myVote = r.myVote;
      item.likeScore = r.likeScore;
      const countEl = document.getElementById('like-count');
      if (countEl) countEl.textContent = String(r.likeScore);
      likeBtn.classList.toggle('on', r.myVote === 1);
      likeBtn.querySelector('i')!.className = `ti ti-heart${r.myVote === 1 ? '-filled' : ''}`;
    } catch {
      toast(t('cm.errVote'));
    }
  });

  // Follow
  const followBtn = document.getElementById('follow-btn') as HTMLButtonElement | null;
  if (followBtn && item.ownerId) {
    let following = false;
    followBtn.addEventListener('click', async () => {
      if (!(await ensureAuth())) return;
      try {
        if (following) {
          await unfollowUser(item.ownerId!);
          following = false;
          followBtn.textContent = t('cm.follow');
          followBtn.classList.remove('following');
        } else {
          await followUser(item.ownerId!);
          following = true;
          followBtn.textContent = t('cm.following');
          followBtn.classList.add('following');
        }
      } catch {
        toast(t('cm.errFollow'));
      }
    });
  }

  // Remix
  const remixBtn = document.getElementById('remix-btn');
  remixBtn?.addEventListener('click', async () => {
    if (!(await ensureAuth())) return;
    try {
      const created = await remixDesign(item.id);
      toast(t('cm.remixed'));
      setTimeout(() => {
        window.location.href = `/app?design=${created.id}`;
      }, 700);
    } catch (e) {
      toast((e as Error).message);
    }
  });

  // Share — the same modal the grid cards open: WhatsApp, X, Telegram, Facebook,
  // Reddit, the OS share sheet where there is one, and copy link.
  document.getElementById('share-btn')?.addEventListener('click', () => {
    openShareModal({ id: item.id, title: item.title });
  });

  // Report (sends to the moderation queue; you act on it from /admin or the DB).
  const reportBtn = document.getElementById('report-btn');
  reportBtn?.addEventListener('click', async () => {
    const reason = window.prompt(t('cm.reportWhy'));
    if (reason == null) return;
    const text = reason.trim();
    if (!text) return;
    try {
      await reportDesign(item.id, text.slice(0, 300));
      toast(t('cm.reportThanks'));
    } catch (e) {
      toast((e as Error).message);
    }
  });
}

async function fetchAuthorStats(item: GalleryItem): Promise<void> {
  if (!item.ownerId) return;
  try {
    const res = await fetch(`/api/users/${item.ownerId}/profile`, {
      headers: isSignedIn() ? { authorization: `Bearer ${localStorage.getItem('tifo_token_v1') ?? ''}` } : {},
    });
    if (!res.ok) return;
    const p = (await res.json()) as { handle: string | null; followerCount: number; designCount: number; isFollowing: boolean };
    const stats = document.getElementById('author-stats');
    if (stats) stats.textContent = `${p.followerCount} follower${p.followerCount === 1 ? '' : 's'} · ${p.designCount} tifo${p.designCount === 1 ? '' : 's'}`;
    const followBtn = document.getElementById('follow-btn') as HTMLButtonElement | null;
    if (followBtn && p.isFollowing) {
      followBtn.textContent = t('cm.following');
      followBtn.classList.add('following');
    }
  } catch {
    /* ignore */
  }
}

// ---------- comments ----------
/**
 * The comment thread.
 *
 * Replies go to any depth — replying to a reply is the ordinary way a
 * conversation continues, and the client used to be the only thing stopping it:
 * the server has always accepted a parent at any level, but Reply was hidden on
 * anything that was already a reply and the renderer only walked two levels, so
 * a third-level reply would have been stored and never shown.
 *
 * The INDENT is capped (see INDENT_CAP). Unbounded nesting is unreadable on a
 * phone at about the fourth step; past the cap a reply sits at the same offset
 * and says who it is answering instead.
 */
const INDENT_CAP = 2;

async function loadCommentThread(item: GalleryItem, focusCommentId?: string | null): Promise<void> {
  const list = document.getElementById('comment-list');
  const foot = document.getElementById('comment-foot');
  if (!list || !foot) return;
  const comments = await listComments(item.id);
  renderComments(list, comments, item);
  if (focusCommentId) focusComment(focusCommentId);
  // comment composer (or sign-in prompt)
  if (isSignedIn()) {
    foot.innerHTML = `
      <div class="comment-form">
        <textarea id="comment-input" placeholder="${escapeHtml(t('cm.addComment'))}" rows="1"></textarea>
        <button class="comment-send" id="comment-send" disabled>${escapeHtml(t('cm.post'))}</button>
      </div>`;
    const input = document.getElementById('comment-input') as HTMLTextAreaElement;
    const send = document.getElementById('comment-send') as HTMLButtonElement;
    input.addEventListener('input', () => {
      send.disabled = input.value.trim().length === 0;
      input.style.height = 'auto';
      input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    });
    const submit = async (): Promise<void> => {
      const body = input.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await addComment(item.id, body, null);
        input.value = '';
        send.disabled = true;
        await loadCommentThread(item);
        bumpCommentCount(item.id);
      } catch {
        toast(t('cm.errComment'));
        send.disabled = false;
      }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
  } else {
    foot.innerHTML = `<div class="comments-signin"><a id="cmt-signin">${escapeHtml(t('cm.signIn'))}</a> ${escapeHtml(t('cm.joinConvo'))}</div>`;
    document.getElementById('cmt-signin')?.addEventListener('click', async () => {
      if (await ensureAuth()) loadCommentThread(item);
    });
  }
}

function renderComments(list: HTMLElement, comments: CommentItem[], item: GalleryItem): void {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const childrenOf = new Map<string, CommentItem[]>();
  const roots: CommentItem[] = [];
  for (const c of comments) {
    // A reply whose parent is not in this thread (deleted since) is promoted to
    // the top rather than disappearing with it — the words are still somebody's.
    if (c.parentId && byId.has(c.parentId)) {
      const arr = childrenOf.get(c.parentId) ?? [];
      arr.push(c);
      childrenOf.set(c.parentId, arr);
    } else {
      roots.push(c);
    }
  }
  list.innerHTML = '';
  const headEl = document.querySelector('.comments-head');
  if (headEl) headEl.textContent = tv('cm.commentsN', { n: comments.length });
  if (comments.length === 0) {
    list.innerHTML = `<div class="comments-empty">${escapeHtml(t('cm.noComments'))}</div>`;
    return;
  }
  const walk = (c: CommentItem, depth: number): void => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    // Only worth saying once the indent has stopped tracking the nesting.
    const replyingTo = depth > INDENT_CAP ? (parent?.authorName ?? null) : null;
    list.appendChild(commentNode(c, item, depth, replyingTo));
    for (const child of childrenOf.get(c.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}

function commentNode(c: CommentItem, item: GalleryItem, depth: number, replyingTo: string | null): HTMLElement {
  const node = document.createElement('div');
  node.className = `comment${depth > 0 ? ' reply' : ''}`;
  node.dataset.id = c.id;
  // The indent stops growing at the cap so a long back-and-forth does not walk
  // off the side of a phone; the "replying to" line carries the thread instead.
  node.style.setProperty('--depth', String(Math.min(depth, INDENT_CAP)));
  const canDelete = me && (me.id === c.authorId || me.id === item.ownerId);
  const answering = replyingTo
    ? `<div class="c-answering">${escapeHtml(tv('cm.replyingTo', { name: replyingTo }))}</div>`
    : '';
  node.innerHTML = `
    <div class="c-avatar">${initials(c.authorName)}</div>
    <div class="c-body">
      <div class="c-meta"><span class="c-name">@${escapeHtml(c.authorName)}</span><span class="c-time">${timeAgo(c.createdAt)}</span></div>
      ${answering}
      <div class="c-text">${escapeHtml(c.body)}</div>
      <div class="c-actions">
        <button class="c-reply">${escapeHtml(t('cm.reply'))}</button>
        ${canDelete ? `<button class="c-del">${escapeHtml(t('cm.delete'))}</button>` : ''}
      </div>
    </div>`;
  node.querySelector('.c-reply')?.addEventListener('click', () => openReplyBox(node, c, item));
  node.querySelector('.c-del')?.addEventListener('click', async () => {
    try {
      await deleteComment(c.id);
      await loadCommentThread(item);
    } catch {
      toast(t('cm.errDelete'));
    }
  });
  return node;
}

function openReplyBox(anchor: HTMLElement, parent: CommentItem, item: GalleryItem): void {
  if (anchor.querySelector('.reply-box')) return;
  const box = document.createElement('div');
  box.className = 'reply-box';
  box.innerHTML = `
    <div class="comment-form">
      <textarea rows="1" placeholder="${escapeHtml(tv('cm.replyTo', { name: parent.authorName }))}"></textarea>
      <button class="comment-send">${escapeHtml(t('cm.reply'))}</button>
    </div>`;
  anchor.querySelector('.c-body')!.appendChild(box);
  const ta = box.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  const send = box.querySelector('.comment-send') as HTMLButtonElement;
  const submit = async (): Promise<void> => {
    if (!(await ensureAuth())) return;
    const body = ta.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      await addComment(item.id, body, parent.id);
      await loadCommentThread(item);
      bumpCommentCount(item.id);
    } catch {
      toast(t('cm.errReply'));
      send.disabled = false;
    }
  };
  send.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  });
}

/** Scroll a comment into view and mark it, for arriving from a notification. */
function focusComment(commentId: string): void {
  const el = document.querySelector<HTMLElement>(`.comment[data-id="${cssId(commentId)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('c-focus');
  // Long enough to catch the eye after the scroll, short enough not to become
  // a permanent highlight on a comment the reader has already found.
  window.setTimeout(() => el.classList.remove('c-focus'), 2600);
}

function bumpCommentCount(designId: string): void {
  const el = document.querySelector(`.cmt-count[data-id="${cssId(designId)}"]`);
  if (el) {
    const n = parseInt(el.textContent ?? '0', 10);
    el.textContent = String((isNaN(n) ? 0 : n) + 1);
  }
}

/**
 * Fill in comment counts once a page of cards is on screen.
 *
 * One request per card, so it runs a few at a time rather than one after
 * another: a 60-card page used to be 60 serial round-trips, which on a phone
 * meant the last card's count landed long after the reader had scrolled past.
 */
async function fillCommentCounts(items: GalleryItem[]): Promise<void> {
  const queue = items.filter((i) => document.querySelector(`.cmt-count[data-id="${cssId(i.id)}"]`));
  let at = 0;
  const worker = async (): Promise<void> => {
    while (at < queue.length) {
      const item = queue[at++];
      const el = document.querySelector(`.cmt-count[data-id="${cssId(item.id)}"]`);
      if (!el) continue;
      const comments = await listComments(item.id).catch(() => []);
      el.textContent = String(comments.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
}

// ---------- search ----------
const searchInput = $('#user-search') as HTMLInputElement;
const searchResults = $('#search-results');
let searchTimer: number | undefined;
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 1) {
    searchResults.hidden = true;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const users = await searchUsers(q);
    if (users.length === 0) {
      searchResults.innerHTML = `<div class="search-result"><div class="sr-meta"><div class="sr-sub">No creators found</div></div></div>`;
      searchResults.hidden = false;
      return;
    }
    searchResults.innerHTML = users
      .map(
        (u) => `
      <div class="search-result" data-id="${u.id}">
        <div class="sr-avatar">${initials(u.username)}</div>
        <div class="sr-meta">
          <div class="sr-name">@${escapeHtml(u.username)}</div>
          <div class="sr-sub">${u.followerCount} follower${u.followerCount === 1 ? '' : 's'} · ${u.designCount} tifo${u.designCount === 1 ? '' : 's'}</div>
        </div>
      </div>`,
      )
      .join('');
    searchResults.hidden = false;
    searchResults.querySelectorAll<HTMLElement>('.search-result[data-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const uid = el.dataset.id!;
        searchResults.hidden = true;
        searchInput.value = '';
        void openProfile(uid);
      });
    });
  }, 220);
});
document.addEventListener('click', (e) => {
  if (!searchInput.contains(e.target as Node) && !searchResults.contains(e.target as Node)) searchResults.hidden = true;
});

// ---------- notifications ----------
/**
 * The bell.
 *
 * Two things were missing and both made the feature look broken rather than
 * quiet. The rows did nothing when clicked — the CSS said `cursor: pointer`, so
 * they announced themselves as clickable and were not — and the unread dot was
 * read once at page load and never again, so anything arriving while the tab
 * sat open was invisible until a reload.
 */

/** How often the unread count is re-checked while the tab is in front. */
const NOTIF_POLL_MS = 60_000;
let notifTimer: number | undefined;

async function refreshNotifications(): Promise<void> {
  if (!isSignedIn()) return;
  try {
    const { unread } = await listNotifications();
    $('#notif-dot').hidden = unread === 0;
  } catch {
    /* a failed poll is not worth a toast; the next one will do */
  }
}

/**
 * Poll while the tab is in front, and stop while it is not — a background tab
 * polling forever is a battery cost nobody asked for. Checking on the way back
 * also means the dot is right the moment somebody returns to the page.
 */
function startNotifPolling(): void {
  if (notifTimer !== undefined) return;
  notifTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshNotifications();
  }, NOTIF_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshNotifications();
  });
}

$('#notif-btn').addEventListener('click', async () => {
  const panel = $('#notif-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  const { items } = await listNotifications();
  panel.innerHTML = `
    <div class="notif-head"><h3>${escapeHtml(t('nt.title'))}</h3><button id="notif-read-all">${escapeHtml(t('nt.markAll'))}</button></div>
    <div class="notif-list" id="notif-list"></div>`;
  const list = $('#notif-list');
  if (items.length === 0) {
    list.innerHTML = `<div class="notif-empty">${escapeHtml(t('nt.empty'))}</div>`;
  } else {
    list.innerHTML = items.map(notifRow).join('');
    for (const el of list.querySelectorAll<HTMLElement>('.notif-item')) {
      el.addEventListener('click', () => void openNotification(el, items));
    }
  }
  panel.hidden = false;
  $('#notif-read-all').addEventListener('click', async () => {
    await markNotificationsRead();
    await refreshNotifications();
    panel.querySelectorAll('.notif-item').forEach((el) => el.classList.remove('unread'));
  });
  // mark read on open
  await markNotificationsRead();
  await refreshNotifications();
});

/**
 * Open what a notification is about.
 *
 * Everything except a new follower is about a design, so the design's preview
 * opens — and for the two comment kinds the thread is scrolled to the comment
 * itself, because "somebody replied to you" is not much use if you then have to
 * find the reply. A new follower opens their profile.
 */
async function openNotification(el: HTMLElement, items: NotificationItem[]): Promise<void> {
  const n = items.find((x) => x.id === el.dataset.notif);
  if (!n) return;
  $('#notif-panel').hidden = true;
  el.classList.remove('unread');
  void markNotificationsRead(n.id).then(() => refreshNotifications());

  if (n.kind === 'new_follower') {
    if (n.actorId) void openProfile(n.actorId);
    return;
  }
  if (!n.designId) return;
  const item = await fetchGalleryItem(n.designId).catch(() => null);
  // Taken down, made private, or deleted since. Say so rather than opening an
  // empty modal — the notification is real, the tifo is what is gone.
  if (!item) {
    toast(t('nt.gone'));
    return;
  }
  void openPreview(item, n.commentId);
}

function notifRow(n: NotificationItem): string {
  const icon = {
    follow_post: 'ti-photo',
    new_follower: 'ti-user-plus',
    comment: 'ti-message-circle',
    reply: 'ti-message',
    remix: 'ti-git-fork',
    featured: 'ti-sparkles',
  }[n.kind] ?? 'ti-bell';
  const actor = n.actorName ? `<span class="at">@${escapeHtml(n.actorName)}</span>` : escapeHtml(t('nt.someone'));
  const title = `<b>${escapeHtml(n.designTitle ?? t('nt.aTifo'))}</b>`;
  const text =
    {
      follow_post: tv('nt.followPost', { actor, title }),
      new_follower: tv('nt.newFollower', { actor }),
      comment: tv('nt.comment', { actor, title }),
      reply: tv('nt.reply', { actor }),
      remix: tv('nt.remix', { actor, title }),
      // The site featured it, so there is no actor to name — and this one is
      // worth spelling out, because it is the only notification that put the
      // person's work in front of everybody who lands on the home page.
      featured: tv('nt.featured', { title }),
    }[n.kind] ?? tv('nt.generic', { actor });
  return `
    <div class="notif-item ${n.readAt ? '' : 'unread'}" data-notif="${escapeHtml(n.id)}" role="button" tabindex="0">
      <div class="notif-icon ${escapeHtml(n.kind)}"><i class="ti ${icon}"></i></div>
      <div class="notif-text">${text}<div class="notif-time">${timeAgo(n.createdAt)}</div></div>
    </div>`;
}
document.addEventListener('click', (e) => {
  const panel = $('#notif-panel');
  const btn = $('#notif-btn');
  if (!panel.hidden && !panel.contains(e.target as Node) && !btn.contains(e.target as Node)) panel.hidden = true;
});
// Enter/Space on a focused row, since the rows are buttons in all but element.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = (e.target as HTMLElement)?.closest?.('.notif-item') as HTMLElement | null;
  if (!row) return;
  e.preventDefault();
  row.click();
});

// ---------- sort tabs + tags ----------
$('#sort-tabs').querySelectorAll<HTMLButtonElement>('.sort-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $('#sort-tabs').querySelectorAll('.sort-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentSort = tab.dataset.sort as typeof currentSort;
    // The facets differ per tab — the library covers a dozen clubs, the people
    // tab may cover none — so a panel left over from the other tab would offer
    // filters that return nothing.
    void loadFilters();
    void loadGallery();
  });
});

/** A representative swatch per colour family, for the chip's dot. */
const COLOUR_SWATCH: Record<string, string> = {
  red: '#d53434', orange: '#e8862a', yellow: '#f2c40f', green: '#22a559', cyan: '#28b8c4',
  blue: '#2f6fe0', purple: '#8b5cf6', pink: '#e05a9a', white: '#f4f4f0', black: '#1b1e25', grey: '#8b9099',
};

/**
 * The filter panel.
 *
 * Two sets of state, and the distinction is the whole design: `draft` is what
 * you have clicked inside the panel, `active` is what the grid is actually
 * showing. Nothing crosses from one to the other until you press Apply. A live
 * filter re-fetches and reflows the feed under your hand on every click, which
 * is fine for one control and unusable for three.
 */
interface Selection { colors: string[]; clubs: string[]; tags: string[] }
const emptySelection = (): Selection => ({ colors: [], clubs: [], tags: [] });
let draft: Selection = emptySelection();
let facetCache: GalleryFacets | null = null;
let tagCache: { slug: string; count: number }[] = [];
let countTimer: number | undefined;

const selectionCount = (sel: Selection): number => sel.colors.length + sel.clubs.length + sel.tags.length;
const sameSelection = (a: Selection, b: Selection): boolean =>
  (['colors', 'clubs', 'tags'] as const).every((k) => a[k].length === b[k].length && a[k].every((v) => b[k].includes(v)));

const clubLabel = (id: string): string => {
  const c = facetCache?.clubs.find((x) => x.id === id);
  if (!c) return id;
  return (getLang() === 'ar' ? c.nameAr : c.name) || c.name;
};

function chip(label: string, on: boolean, dot: string | null, count: number | null, onToggle: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'f-chip';
  b.type = 'button';
  b.setAttribute('aria-pressed', String(on));
  if (dot) {
    const d = document.createElement('span');
    d.className = 'colour-dot';
    d.style.background = dot;
    b.appendChild(d);
  }
  const t2 = document.createElement('span');
  t2.textContent = label;
  b.appendChild(t2);
  if (count != null) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = String(count);
    b.appendChild(c);
  }
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(next));
    onToggle();
  });
  return b;
}

const toggle = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/**
 * Fill the panel from what the current tab ACTUALLY contains.
 *
 * Not from the full list of either. Thirty-nine clubs of which the library
 * covers a dozen is a wall of chips that return nothing, and a chip that
 * returns nothing is worse than no chip: it reads as a broken filter rather
 * than an empty category.
 */
async function loadFilters(): Promise<void> {
  const scope = { peopleOnly: currentSort === 'people', templatesOnly: currentSort === 'templates' };
  const [facets, tags] = await Promise.all([
    listGalleryFacets(scope).catch(() => null),
    listPopularTags().catch(() => []),
  ]);
  facetCache = facets;
  tagCache = tags.slice(0, 14);

  const colourBox = $('#colour-chips');
  const clubBox = $('#club-chips');
  const tagBox = $('#tag-chips');
  colourBox.innerHTML = '';
  clubBox.innerHTML = '';
  tagBox.innerHTML = '';

  for (const c of facets?.colors ?? []) {
    colourBox.appendChild(chip(t(`cm.colour.${c.id}`), draft.colors.includes(c.id), COLOUR_SWATCH[c.id] ?? '#888', c.count, () => {
      draft.colors = toggle(draft.colors, c.id);
      void refreshCount();
    }));
  }
  $('#colour-none').hidden = (facets?.colors.length ?? 0) > 0;

  for (const club of facets?.clubs ?? []) {
    clubBox.appendChild(chip(clubLabel(club.id), draft.clubs.includes(club.id), null, club.count, () => {
      draft.clubs = toggle(draft.clubs, club.id);
      void refreshCount();
    }));
  }
  $('#club-none').hidden = (facets?.clubs.length ?? 0) > 0;

  for (const tg of tagCache) {
    tagBox.appendChild(chip(`#${tTag(tg.slug)}`, draft.tags.includes(tg.slug), null, null, () => {
      draft.tags = toggle(draft.tags, tg.slug);
      void refreshCount();
    }));
  }
  void refreshCount();
}

/**
 * What Apply would give you, before you press it.
 *
 * Without this the confirm button is a leap: pick three things, press it, land
 * on an empty grid, and have no idea which one was the mistake. Debounced,
 * because it is one request per click otherwise.
 */
async function refreshCount(): Promise<void> {
  const apply = $('#fp-apply') as HTMLButtonElement;
  const clear = $('#fp-clear') as HTMLButtonElement;
  clear.disabled = selectionCount(draft) === 0;
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(async () => {
    // The club filter takes ONE club server-side, so a multi-club draft cannot
    // be counted in a single request. Counting only the first would be a lie, so
    // the button falls back to a plain label rather than a wrong number.
    if (draft.clubs.length > 1) {
      apply.disabled = false;
      apply.textContent = t('cm.apply');
      return;
    }
    const facets = await listGalleryFacets({
      peopleOnly: currentSort === 'people',
      templatesOnly: currentSort === 'templates',
      colors: draft.colors,
      tags: draft.tags,
      clubId: draft.clubs[0],
    }).catch(() => null);
    if (!facets) { apply.disabled = false; apply.textContent = t('cm.apply'); return; }
    apply.disabled = facets.matching === 0;
    apply.textContent = facets.matching === 0
      ? t('cm.noMatches')
      : tv('cm.showN', { n: facets.matching });
  }, 220);
}

/** The pills under the bar: what is applied, each removable on its own. */
function renderApplied(): void {
  const row = $('#applied-row');
  row.innerHTML = '';
  const items: { label: string; drop: () => void }[] = [
    ...activeColours.map((id) => ({ label: t(`cm.colour.${id}`), drop: () => { activeColours = activeColours.filter((x) => x !== id); } })),
    ...(activeClub ? [{ label: clubLabel(activeClub), drop: (): void => { activeClub = ''; } }] : []),
    ...activeTags.map((slug) => ({ label: `#${tTag(slug)}`, drop: () => { activeTags = activeTags.filter((x) => x !== slug); } })),
  ];
  const count = $('#filter-count');
  count.textContent = String(items.length);
  count.hidden = items.length === 0;
  row.hidden = items.length === 0;
  if (!items.length) return;

  for (const it of items) {
    const pill = document.createElement('span');
    pill.className = 'applied-pill';
    const label = document.createElement('span');
    label.textContent = it.label;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '\u00d7';
    x.setAttribute('aria-label', `${t('cm.remove')} ${it.label}`);
    x.addEventListener('click', () => {
      it.drop();
      draft = { colors: [...activeColours], clubs: activeClub ? [activeClub] : [], tags: [...activeTags] };
      renderApplied();
      void loadFilters();
      void loadGallery();
    });
    pill.append(label, x);
    row.appendChild(pill);
  }
  const clearAll = document.createElement('button');
  clearAll.className = 'applied-clear';
  clearAll.type = 'button';
  clearAll.textContent = t('cm.clearAll');
  clearAll.addEventListener('click', () => {
    activeColours = [];
    activeClub = '';
    activeTags = [];
    draft = emptySelection();
    renderApplied();
    void loadFilters();
    void loadGallery();
  });
  row.appendChild(clearAll);
}

// ---- opening, closing, applying ----
const panel = $('#filter-panel');
const filterBtn = $('#filter-btn');

function openPanel(): void {
  // Start from what is applied, so opening the panel shows you where you are
  // rather than a blank slate you have to rebuild.
  draft = { colors: [...activeColours], clubs: activeClub ? [activeClub] : [], tags: [...activeTags] };
  panel.hidden = false;
  filterBtn.setAttribute('aria-expanded', 'true');
  void loadFilters();
  (panel.querySelector('.f-chip') as HTMLElement | null)?.focus();
}
function closePanel(focusBtn = true): void {
  panel.hidden = true;
  filterBtn.setAttribute('aria-expanded', 'false');
  if (focusBtn) filterBtn.focus();
}

// The panel's labels are built in JS, so a language switch has to rebuild them:
// applyDom only reaches the markup, and the chips, the pills and the Apply
// button's live count are all made here.
onLangChange(() => {
  renderApplied();
  if (!panel.hidden) void loadFilters();
  else void refreshCount();
});

filterBtn.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
$('#fp-close').addEventListener('click', () => closePanel());
$('#fp-clear').addEventListener('click', () => {
  draft = emptySelection();
  void loadFilters();
});
$('#fp-apply').addEventListener('click', () => {
  const applied: Selection = { colors: [...activeColours], clubs: activeClub ? [activeClub] : [], tags: [...activeTags] };
  activeColours = [...draft.colors];
  // One club at a time: the server filter is a single club id, and pretending
  // otherwise in the UI would quietly drop every club after the first.
  activeClub = draft.clubs[0] ?? '';
  activeTags = [...draft.tags];
  renderApplied();
  closePanel();
  // Nothing changed, so do not throw the grid away and rebuild it identically.
  if (!sameSelection(applied, draft)) void loadGallery();
});
document.addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Escape' && !panel.hidden) closePanel();
});
document.addEventListener('click', (e) => {
  const target = e.target as Node;
  if (panel.hidden || panel.contains(target) || filterBtn.contains(target)) return;
  closePanel(false);
});

// ---------- go ----------
/**
 * /community?t=<id> opens straight into that tifo.
 *
 * Which is what a notification needs when it is not opened from this page —
 * and what anyone linking a design into a chat gets for free. An id that is
 * private or gone just leaves the feed showing, which is the honest result.
 */
async function openDeepLink(): Promise<void> {
  const id = new URLSearchParams(window.location.search).get('t');
  if (!id) return;
  const item = await fetchGalleryItem(id).catch(() => null);
  if (item) void openPreview(item);
}

async function main(): Promise<void> {
  langToggle.textContent = t('common.language');
  await refreshAuthUI();
  initPaging();
  await Promise.all([loadGallery(), loadFilters()]);
  renderApplied();
  void openDeepLink();
}
void main();

// The footer feedback entry. Lazy: the modal is only fetched once someone
// actually asks for it, so a visitor who never clicks pays nothing for it.
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});
