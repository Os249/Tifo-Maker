import './community.css';
import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { installMobileNav } from './ui/mobileNav';
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
  listPopularTags,
  loadDesign,
  voteDesign,
  thumbnailUrl,
  remixDesign,
  followUser,
  unfollowUser,
  searchUsers,
  listComments,
  addComment,
  deleteComment,
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
applyDom(document);
installMobileNav();

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
    authBtn.textContent = `@${me.username}`;
    authBtn.onclick = () => {
      window.location.href = '/app';
    };
    notifBtn.hidden = false;
    void refreshNotifications();
  } else {
    authBtn.textContent = 'Sign in';
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
let currentSort: GallerySort | 'templates' = 'recent';
let activeTags: string[] = [];

async function loadGallery(): Promise<void> {
  const grid = $('#gallery-grid');
  const loading = $('#grid-loading');
  const empty = $('#grid-empty');
  loading.hidden = false;
  empty.hidden = true;
  try {
    const sort: GallerySort = currentSort === 'likes' ? 'likes' : 'recent';
    const items = await listGallery({
      sort,
      tags: activeTags,
      templatesOnly: currentSort === 'templates',
    });
    grid.innerHTML = '';
    loading.hidden = true;
    if (items.length === 0) {
      empty.hidden = false;
      return;
    }
    for (const item of items) grid.appendChild(renderCard(item));
  } catch {
    loading.textContent = 'Could not load the feed. Please try again.';
  }
}

function renderCard(item: GalleryItem, onClick?: () => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'tifo-card';
  const thumb = item.hasThumbnail
    ? `<div class="card-thumb"><img class="card-thumb-img" src="${thumbnailUrl(item.id)}" alt="" loading="lazy" />`
    : `<div class="card-thumb card-thumb-empty">`;
  const badges =
    (item.isTemplate ? `<span class="badge template">Template</span>` : '') +
    (item.hasPhoto ? `<span class="badge photo">Real photo</span>` : '');
  const remixed = item.remixedFromName
    ? `<div class="card-remixed">↻ remixed from <span class="at">@${escapeHtml(item.remixedFromName)}</span></div>`
    : '';
  const liked = item.myVote === 1;
  card.innerHTML = `
    ${thumb}${badges}</div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-by">by <span class="at">@${escapeHtml(item.ownerName)}</span></div>
      ${remixed}
      <div class="card-stats">
        <span class="card-stat like ${liked ? 'on' : ''}"><i class="ti ti-heart${liked ? '-filled' : ''}"></i> ${item.likeScore}</span>
        <span class="card-stat"><i class="ti ti-message-circle"></i> <span class="cmt-count" data-id="${item.id}">·</span></span>
        <button class="card-stat card-share" title="Share this tifo"><i class="ti ti-share"></i></button>
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

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
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
    if (modal) modal.querySelector('.profile-loading')!.textContent = 'Could not load this profile.';
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
          followBtn.textContent = 'Follow';
          followBtn.classList.remove('following');
        } else {
          await followUser(userId);
          following = true;
          followBtn.textContent = 'Following';
          followBtn.classList.add('following');
        }
      } catch {
        toast('Could not update follow');
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

async function openPreview(item: GalleryItem): Promise<void> {
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
          <h2 class="side-title">${escapeHtml(item.title)}</h2>
          <div class="side-author">
            <div class="side-avatar">${initials(item.ownerName)}</div>
            <div class="side-author-meta">
              <div class="side-author-name">@${escapeHtml(item.ownerName)}</div>
              <div class="side-author-handle" id="author-stats">creator</div>
            </div>
            <button class="follow-btn" id="follow-btn" ${!item.ownerId || (me && me.id === item.ownerId) ? 'hidden' : ''}>Follow</button>
          </div>
          ${
            item.description
              ? `<div class="explanation"><div class="explanation-label">Creator's explanation</div><div class="explanation-body">${escapeHtml(item.description)}</div></div>`
              : ''
          }
          <div class="side-actions">
            <button class="act-btn like ${item.myVote === 1 ? 'on' : ''}" id="like-btn"><i class="ti ti-heart${item.myVote === 1 ? '-filled' : ''}"></i> <span id="like-count">${item.likeScore}</span></button>
            ${item.allowRemix !== false ? `<button class="act-btn remix" id="remix-btn"><i class="ti ti-git-fork"></i> Remix</button>` : ''}
          </div>
        </div>
        <div class="comments" id="comments"><div class="comments-head">Comments</div><div id="comment-list"></div></div>
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
  void loadCommentThread(item);
  // author stats
  void fetchAuthorStats(item);
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
    if (host) host.innerHTML = '<div class="grid-loading" style="color:#9aa3b5;padding-top:80px;">Could not render this tifo.</div>';
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
      toast('Could not register your vote');
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
          followBtn.textContent = 'Follow';
          followBtn.classList.remove('following');
        } else {
          await followUser(item.ownerId!);
          following = true;
          followBtn.textContent = 'Following';
          followBtn.classList.add('following');
        }
      } catch {
        toast('Could not update follow');
      }
    });
  }

  // Remix
  const remixBtn = document.getElementById('remix-btn');
  remixBtn?.addEventListener('click', async () => {
    if (!(await ensureAuth())) return;
    try {
      const created = await remixDesign(item.id);
      toast('Remixed! Opening in the editor…');
      setTimeout(() => {
        window.location.href = `/app?design=${created.id}`;
      }, 700);
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
      followBtn.textContent = 'Following';
      followBtn.classList.add('following');
    }
  } catch {
    /* ignore */
  }
}

// ---------- comments ----------
async function loadCommentThread(item: GalleryItem): Promise<void> {
  const list = document.getElementById('comment-list');
  const foot = document.getElementById('comment-foot');
  if (!list || !foot) return;
  const comments = await listComments(item.id);
  renderComments(list, comments, item);
  // comment composer (or sign-in prompt)
  if (isSignedIn()) {
    foot.innerHTML = `
      <div class="comment-form">
        <textarea id="comment-input" placeholder="Add a comment…" rows="1"></textarea>
        <button class="comment-send" id="comment-send" disabled>Post</button>
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
        toast('Could not post comment');
        send.disabled = false;
      }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
  } else {
    foot.innerHTML = `<div class="comments-signin"><a id="cmt-signin">Sign in</a> to join the conversation.</div>`;
    document.getElementById('cmt-signin')?.addEventListener('click', async () => {
      if (await ensureAuth()) loadCommentThread(item);
    });
  }
}

function renderComments(list: HTMLElement, comments: CommentItem[], item: GalleryItem): void {
  const head = list.previousElementSibling; // .comments-head not present; we keep list only
  void head;
  const top = comments.filter((c) => !c.parentId);
  const repliesByParent = new Map<string, CommentItem[]>();
  for (const c of comments) {
    if (c.parentId) {
      const arr = repliesByParent.get(c.parentId) ?? [];
      arr.push(c);
      repliesByParent.set(c.parentId, arr);
    }
  }
  list.innerHTML = '';
  const headEl = document.querySelector('.comments-head');
  if (headEl) headEl.textContent = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
  if (comments.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:14px;">No comments yet — be the first.</div>`;
    return;
  }
  for (const c of top) {
    list.appendChild(commentNode(c, item, false));
    for (const r of repliesByParent.get(c.id) ?? []) list.appendChild(commentNode(r, item, true));
  }
}

function commentNode(c: CommentItem, item: GalleryItem, isReply: boolean): HTMLElement {
  const node = document.createElement('div');
  node.className = `comment${isReply ? ' reply' : ''}`;
  const canDelete = me && (me.id === c.authorId || me.id === item.ownerId);
  node.innerHTML = `
    <div class="c-avatar">${initials(c.authorName)}</div>
    <div class="c-body">
      <div class="c-meta"><span class="c-name">@${escapeHtml(c.authorName)}</span><span class="c-time">${timeAgo(c.createdAt)}</span></div>
      <div class="c-text">${escapeHtml(c.body)}</div>
      <div class="c-actions">
        ${!isReply ? `<button class="c-reply">Reply</button>` : ''}
        ${canDelete ? `<button class="c-del">Delete</button>` : ''}
      </div>
    </div>`;
  node.querySelector('.c-reply')?.addEventListener('click', () => openReplyBox(node, c, item));
  node.querySelector('.c-del')?.addEventListener('click', async () => {
    try {
      await deleteComment(c.id);
      await loadCommentThread(item);
    } catch {
      toast('Could not delete');
    }
  });
  return node;
}

function openReplyBox(anchor: HTMLElement, parent: CommentItem, item: GalleryItem): void {
  if (anchor.querySelector('.reply-box')) return;
  const box = document.createElement('div');
  box.className = 'reply-box';
  box.style.marginTop = '8px';
  box.innerHTML = `
    <div class="comment-form" style="padding:0;border:none;background:none;">
      <textarea rows="1" placeholder="Reply to @${escapeHtml(parent.authorName)}…"></textarea>
      <button class="comment-send">Reply</button>
    </div>`;
  anchor.querySelector('.c-body')!.appendChild(box);
  const ta = box.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  box.querySelector('.comment-send')!.addEventListener('click', async () => {
    if (!(await ensureAuth())) return;
    const body = ta.value.trim();
    if (!body) return;
    try {
      await addComment(item.id, body, parent.id);
      await loadCommentThread(item);
      bumpCommentCount(item.id);
    } catch {
      toast('Could not reply');
    }
  });
}

function bumpCommentCount(designId: string): void {
  const el = document.querySelector(`.cmt-count[data-id="${designId}"]`);
  if (el) {
    const n = parseInt(el.textContent ?? '0', 10);
    el.textContent = String((isNaN(n) ? 0 : n) + 1);
  }
}

// lazily fill comment counts on cards after the grid renders
async function fillCommentCounts(items: GalleryItem[]): Promise<void> {
  for (const item of items) {
    const el = document.querySelector(`.cmt-count[data-id="${item.id}"]`);
    if (!el) continue;
    const comments = await listComments(item.id).catch(() => []);
    el.textContent = String(comments.length);
  }
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
async function refreshNotifications(): Promise<void> {
  if (!isSignedIn()) return;
  const { unread } = await listNotifications();
  const dot = $('#notif-dot');
  dot.hidden = unread === 0;
}

$('#notif-btn').addEventListener('click', async () => {
  const panel = $('#notif-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  const { items } = await listNotifications();
  panel.innerHTML = `
    <div class="notif-head"><h3>Notifications</h3><button id="notif-read-all">Mark all read</button></div>
    <div class="notif-list" id="notif-list"></div>`;
  const list = $('#notif-list');
  if (items.length === 0) {
    list.innerHTML = `<div class="notif-empty">No notifications yet.</div>`;
  } else {
    list.innerHTML = items.map(notifRow).join('');
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

function notifRow(n: NotificationItem): string {
  const icon = { follow_post: 'ti-photo', new_follower: 'ti-user-plus', comment: 'ti-message-circle', remix: 'ti-git-fork' }[n.kind] ?? 'ti-bell';
  const actor = n.actorName ? `<span class="at">@${escapeHtml(n.actorName)}</span>` : 'Someone';
  const text =
    {
      follow_post: `${actor} published <b>${escapeHtml(n.designTitle ?? 'a new tifo')}</b>`,
      new_follower: `${actor} started following you`,
      comment: `${actor} commented on your tifo`,
      remix: `${actor} remixed your tifo`,
    }[n.kind] ?? `${actor} did something`;
  return `
    <div class="notif-item ${n.readAt ? '' : 'unread'}">
      <div class="notif-icon ${n.kind}"><i class="ti ${icon}"></i></div>
      <div class="notif-text">${text}<div class="notif-time">${timeAgo(n.createdAt)}</div></div>
    </div>`;
}
document.addEventListener('click', (e) => {
  const panel = $('#notif-panel');
  const btn = $('#notif-btn');
  if (!panel.hidden && !panel.contains(e.target as Node) && !btn.contains(e.target as Node)) panel.hidden = true;
});

// ---------- sort tabs + tags ----------
$('#sort-tabs').querySelectorAll<HTMLButtonElement>('.sort-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $('#sort-tabs').querySelectorAll('.sort-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentSort = tab.dataset.sort as typeof currentSort;
    void loadGallery();
  });
});

async function loadTags(): Promise<void> {
  const tags = await listPopularTags().catch(() => []);
  const row = $('#tag-row');
  row.innerHTML = '';
  for (const tg of tags.slice(0, 12)) {
    const chip = document.createElement('button');
    chip.className = 'tag-chip';
    chip.textContent = `#${tg.slug}`;
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (activeTags.includes(tg.slug)) activeTags = activeTags.filter((x) => x !== tg.slug);
      else activeTags.push(tg.slug);
      void loadGallery();
    });
    row.appendChild(chip);
  }
}

// ---------- go ----------
async function main(): Promise<void> {
  langToggle.textContent = t('common.language');
  await refreshAuthUI();
  await Promise.all([loadGallery(), loadTags()]);
  // fill comment counts after the grid is up
  const items = await listGallery({
    sort: currentSort === 'likes' ? 'likes' : 'recent',
    tags: activeTags,
    templatesOnly: currentSort === 'templates',
  }).catch(() => []);
  void fillCommentCounts(items);
}
void main();
