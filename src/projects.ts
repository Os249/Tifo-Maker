/**
 * /projects: everything someone has made, and the one way to start something new.
 *
 * Signed in, the list is their account's designs (the server holds them for
 * good). Signed out, it is the projects kept in this browser, and the page
 * says exactly that, with the offer of an account to keep them anywhere. The
 * moment there is an account, whatever this browser held is moved into it.
 *
 * Deliberately small: a grid of cards, a search box, one sort, pins, and a
 * Trash. Folders were considered and left out; at the numbers people have,
 * search and pins find anything faster than a tree would.
 */

import { cleanAddressBar } from './core/utm';
import './vendor/tabler-subset.css';
import './community.css';
import './projects.css';
import { initLang, applyDom, onLangChange, toggleLang, t, tv, tl, getLang } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { escapeHtml } from './core/escape';
import { templateById } from './core/stadiumCatalog';
import {
  TRASH_DAYS, docKey, accountDraftKey, duplicateLocal, listLocal, localThumb,
  migrateLegacyDraft, nextDefaultName, openUrl, purgeLocal, readEnvelope, restoreLocal,
  trashLocal, updateLocal, writeEnvelope, newProjectUrl, stashNewProject, type ProjectRef,
} from './core/projects';
import {
  adoptProviderSession, deleteProject, duplicateProject, fetchDesignCells, fetchMe, isSignedIn,
  listProjects, providerFailure, restoreProject, setDesignTitle, setProjectPinned, setPublic,
  fetchThumbnailObjectUrl, takeClaimIntent, type AccountProject,
} from './net/api';
import { claimAllLocal } from './net/claimProjects';

// ---------------------------------------------------------------- types ---

interface Item {
  kind: 'local' | 'account';
  id: string;
  title: string;
  templateId: string;
  isPublic: boolean;
  pinned: boolean;
  /** Epoch ms, or null when not in the Trash. */
  deletedAt: number | null;
  origin: string | null;
  createdAt: number;
  updatedAt: number;
  thumb: string | null;
}

type Sort = 'edited' | 'created' | 'name';

const SORT_KEY = 'tifo_projects_sort_v1';
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- state ---

let items: Item[] = [];
let trashDays = TRASH_DAYS;
let view: 'projects' | 'trash' = 'projects';
let query = '';
let sort: Sort = readSort();
let signedIn = false;
let loaded = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const grid = $('pj-grid');
const status = $('pj-status');
const empty = $('pj-empty');
const controls = $('pj-controls');
const where = $('pj-where');
const trashBtn = $<HTMLButtonElement>('pj-trash-btn');
const trashLabel = $('pj-trash-label');
const trashNote = $('pj-trash-note');
const heading = $('pj-h');
const searchInput = $<HTMLInputElement>('pj-search');
const sortSel = $<HTMLSelectElement>('pj-sort');
const authBtn = $<HTMLButtonElement>('auth-btn');

function readSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v === 'created' || v === 'name' ? v : 'edited';
  } catch {
    return 'edited';
  }
}

const refOf = (it: Item): ProjectRef => ({ kind: it.kind, id: it.id });

function fromAccount(p: AccountProject): Item {
  return {
    kind: 'account',
    id: p.id,
    title: p.title,
    templateId: p.templateId,
    isPublic: p.isPublic,
    pinned: p.pinned,
    deletedAt: p.deletedAt ? Date.parse(p.deletedAt) : null,
    origin: p.origin,
    createdAt: Date.parse(p.createdAt),
    updatedAt: Date.parse(p.updatedAt),
    thumb: p.hasThumbnail ? `acct:${p.id}:${p.updatedAt}` : null,
  };
}

function fromLocal(): Item[] {
  return listLocal().map((p) => ({
    kind: 'local' as const,
    id: p.id,
    title: p.title,
    templateId: p.templateId,
    isPublic: false,
    pinned: p.pinned,
    deletedAt: p.deletedAt,
    origin: p.origin,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    thumb: localThumb(p.id),
  }));
}

// ------------------------------------------------------------- feedback ---

function toast(msg: string, action?: { label: string; run: () => void }): void {
  document.querySelectorAll('.toast.pj-toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'toast pj-toast';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pj-toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.remove();
      action.run();
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), action ? 6000 : 3200);
}

const failed = (e: unknown): void => toast(tv('pj.t.failed', { err: (e as Error)?.message ?? '' }));

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const n = (v: number): string => Math.round(v).toLocaleString('en-US');
  if (s < 60) return t('pj.ago.now');
  if (s < 3600) return tv('pj.ago.m', { n: n(s / 60) });
  if (s < 86400) return tv('pj.ago.h', { n: n(s / 3600) });
  if (s < 2 * 86400) return t('pj.ago.y');
  return tv('pj.ago.d', { n: n(s / 86400) });
}

// --------------------------------------------------------------- render ---

function visible(): Item[] {
  const q = query.trim().toLowerCase();
  const inView = items.filter((it) => (view === 'trash' ? it.deletedAt !== null : it.deletedAt === null));
  const matched = q ? inView.filter((it) => it.title.toLowerCase().includes(q)) : inView;
  const cmp = (a: Item, b: Item): number => {
    if (view === 'projects' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (view === 'trash') return (b.deletedAt ?? 0) - (a.deletedAt ?? 0);
    if (sort === 'name') return a.title.localeCompare(b.title, getLang(), { sensitivity: 'base' });
    if (sort === 'created') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  };
  return matched.sort(cmp);
}

function cardHtml(it: Item): string {
  const inTrash = it.deletedAt !== null;
  const href = inTrash ? null : openUrl(refOf(it));
  const name = escapeHtml(it.title);
  // Account pictures are fetched with the session (see hydrateThumbs); local
  // ones are data URLs already.
  const cached = it.thumb?.startsWith('acct:') ? thumbCache.get(it.thumb) : it.thumb;
  const img = it.thumb
    ? `<img ${cached ? `src="${escapeHtml(cached)}"` : `data-thumb="${escapeHtml(it.thumb)}"`} alt="" decoding="async" />`
    : '';
  const thumb = img
    ? `<span class="pj-half">${img}</span><span class="pj-half">${img}</span>`
    : `<span class="pj-thumb-empty">${escapeHtml(t('pj.noThumb'))}</span>`;
  const left = inTrash ? Math.ceil((it.deletedAt! + trashDays * DAY - Date.now()) / DAY) : 0;
  const meta = inTrash
    ? left <= 1 ? t('pj.deletesSoon') : tv('pj.deletesIn', { n: left })
    : tv('pj.edited', { when: ago(it.updatedAt) });
  const badges = [
    it.isPublic
      ? `<span class="pj-badge pub">${escapeHtml(t('pj.badge.pub'))}</span>`
      : `<span class="pj-badge">${escapeHtml(t('pj.badge.private'))}</span>`,
    it.origin === 'ai' ? `<span class="pj-badge ai"><span aria-hidden="true">✦</span> ${escapeHtml(t('pj.badge.ai'))}</span>` : '',
  ].join('');
  const pin = inTrash
    ? ''
    : `<button type="button" class="pj-pin${it.pinned ? ' on' : ''}" data-act="pin" aria-pressed="${it.pinned}"
         title="${escapeHtml(t(it.pinned ? 'pj.unpin' : 'pj.pin'))}" aria-label="${escapeHtml(t(it.pinned ? 'pj.unpin' : 'pj.pin'))}">
         <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>
       </button>`;
  const open = (inner: string, cls: string): string =>
    href ? `<a class="${cls}" href="${escapeHtml(href)}">${inner}</a>` : `<span class="${cls}">${inner}</span>`;
  return `<article class="pj-card${inTrash ? ' trashed' : ''}${it.pinned && !inTrash ? ' pinned' : ''}" data-key="${it.kind}:${escapeHtml(it.id)}">
    <span class="pj-thumb" dir="ltr">${thumb}</span>
    <div class="pj-body">
      <div class="pj-row">
        ${open(name, 'pj-name')}
        ${pin}
        <button type="button" class="pj-more" data-act="menu" aria-haspopup="menu" aria-expanded="false"
          aria-label="${escapeHtml(tv('pj.more', { name: it.title }))}">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        </button>
      </div>
      <div class="pj-meta"><span>${escapeHtml(tl(it.templateId))}</span><span aria-hidden="true">·</span><span>${escapeHtml(meta)}</span></div>
      ${inTrash ? '' : `<div class="pj-badges">${badges}</div>`}
    </div>
  </article>`;
}

function render(): void {
  if (!loaded) return;
  const live = items.filter((it) => it.deletedAt === null);
  const trashed = items.filter((it) => it.deletedAt !== null);
  const list = visible();

  heading.textContent = t(view === 'trash' ? 'pj.trash' : 'pj.title');
  const nothingAtAll = live.length === 0 && view === 'projects';
  empty.hidden = !nothingAtAll;
  // The empty state has its own, bigger New project button: one is enough.
  $('pj-new').hidden = nothingAtAll;
  controls.hidden = nothingAtAll && trashed.length === 0;

  where.hidden = view === 'trash';
  if (signedIn) {
    where.textContent = t('pj.whereAccount');
  } else {
    where.innerHTML = `<span>${escapeHtml(t('pj.whereLocal'))}</span> <button type="button" class="pj-link" id="pj-keep">${escapeHtml(t('pj.keep'))}</button>`;
    where.querySelector('#pj-keep')?.addEventListener('click', () => void signIn());
  }

  trashBtn.hidden = view === 'projects' && trashed.length === 0;
  trashLabel.textContent = view === 'trash' ? t('pj.trashBack') : tv('pj.trashCount', { n: trashed.length });
  trashBtn.classList.toggle('back', view === 'trash');
  trashNote.hidden = view !== 'trash';
  trashNote.textContent = tv('pj.trashNote', { n: trashDays });

  if (nothingAtAll) {
    grid.innerHTML = '';
    status.textContent = '';
    return;
  }
  grid.innerHTML = list.map(cardHtml).join('');
  void hydrateThumbs();
  status.textContent = list.length
    ? ''
    : view === 'trash' && !query ? t('pj.emptyTrash') : tv('pj.noMatch', { q: query.trim() });
}

/** acct:<id>:<updatedAt> → object URL. A new edit time is a new picture. */
const thumbCache = new Map<string, string>();
const thumbLoading = new Set<string>();

async function hydrateThumbs(): Promise<void> {
  const imgs = Array.from(grid.querySelectorAll<HTMLImageElement>('img[data-thumb]'));
  // A few at a time: a long list should not open fifty requests at once.
  const queue = imgs.map((img) => img.dataset.thumb!).filter((k) => !thumbLoading.has(k));
  const work = async (): Promise<void> => {
    for (let k = queue.shift(); k; k = queue.shift()) {
      thumbLoading.add(k);
      const id = k.split(':')[1]!;
      const url = await fetchThumbnailObjectUrl(id).catch(() => null);
      thumbLoading.delete(k);
      if (!url) continue;
      thumbCache.set(k, url);
      grid.querySelectorAll<HTMLImageElement>(`img[data-thumb="${CSS.escape(k)}"]`).forEach((img) => {
        img.src = url;
        img.removeAttribute('data-thumb');
      });
    }
  };
  await Promise.all([work(), work(), work(), work()]);
}

// ----------------------------------------------------------------- data ---

async function load(): Promise<void> {
  status.textContent = t('pj.loading');
  migrateLegacyDraft();
  signedIn = isSignedIn();
  let account: AccountProject[] = [];
  if (signedIn) {
    // Whatever this browser held goes into the account first, so the list
    // below already has it.
    if (listLocal().length) {
      status.textContent = t('pj.moving');
      const r = await claimAllLocal();
      if (r.moved) toast(t('pj.t.moved'));
      else if (r.failed) toast(t('pj.t.moveFailed'));
    }
    try {
      const res = await listProjects();
      account = res.projects;
      trashDays = res.trashDays || TRASH_DAYS;
    } catch (e) {
      loaded = false;
      grid.innerHTML = '';
      status.innerHTML = `${escapeHtml(tv('pj.loadFail', { err: (e as Error).message }))} <button type="button" class="pj-link" id="pj-retry">${escapeHtml(t('pj.retry'))}</button>`;
      status.querySelector('#pj-retry')?.addEventListener('click', () => void load());
      return;
    }
  }
  // Signed in, anything still local is a project that failed to move: it is
  // shown rather than hidden, so nobody thinks it is gone.
  items = [...account.map(fromAccount), ...fromLocal()];
  loaded = true;
  render();
}

function find(key: string): Item | undefined {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  return items.find((it) => it.kind === kind && it.id === id);
}

function patchItem(it: Item, patch: Partial<Item>): void {
  Object.assign(it, patch);
  render();
}

// -------------------------------------------------------------- actions ---

async function signIn(): Promise<boolean> {
  const { openAuthModal } = await import('./ui/authModal');
  const name = await openAuthModal(true);
  if (!name) return false;
  await refreshAuth();
  await load();
  return true;
}

async function togglePin(it: Item): Promise<void> {
  const next = !it.pinned;
  patchItem(it, { pinned: next });
  try {
    if (it.kind === 'account') await setProjectPinned(it.id, next);
    else updateLocal(it.id, { pinned: next });
  } catch (e) {
    patchItem(it, { pinned: !next });
    failed(e);
  }
}

async function rename(it: Item): Promise<void> {
  const { promptModal } = await import('./ui/modal');
  const name = await promptModal({
    title: t('pj.renameTitle'),
    defaultValue: it.title,
    confirmLabel: t('common.ok'),
    maxLength: 80,
  });
  if (!name || name === it.title) return;
  const old = it.title;
  patchItem(it, { title: name });
  try {
    if (it.kind === 'account') {
      await setDesignTitle(it.id, name);
      retitleCopy(accountDraftKey(it.id), name);
    } else {
      updateLocal(it.id, { title: name });
      retitleCopy(docKey(it.id), name);
    }
    toast(t('pj.t.renamed'));
  } catch (e) {
    patchItem(it, { title: old });
    failed(e);
  }
}

/** Keep the browser's copy in step, or the editor would reopen the old name. */
function retitleCopy(key: string, title: string): void {
  const env = readEnvelope(key);
  if (env) writeEnvelope(key, { ...env, title, doc: { ...env.doc, meta: { ...env.doc.meta, title } } });
}

async function duplicate(it: Item): Promise<void> {
  const title = tv('pj.copyName', { name: it.title }).slice(0, 80);
  try {
    if (it.kind === 'account') {
      const m = await duplicateProject(it.id, title);
      const now = Date.now();
      items.push({
        ...it, id: m.id, title: m.title, isPublic: false, pinned: false, createdAt: now, updatedAt: now,
        thumb: it.thumb ? `acct:${m.id}:${m.updatedAt}` : null,
      });
    } else {
      const c = duplicateLocal(it.id, title);
      if (!c) {
        toast(t('pj.t.full'));
        return;
      }
      items.push({ ...it, id: c.id, title: c.title, pinned: false, createdAt: c.createdAt, updatedAt: c.updatedAt, thumb: localThumb(c.id) });
    }
    render();
    toast(t('pj.t.copied'));
  } catch (e) {
    failed(e);
  }
}

async function download(it: Item): Promise<void> {
  try {
    const { buildTifoV2 } = await import('./core/tifoFormat');
    let doc: unknown;
    if (it.kind === 'account') {
      const d = await fetchDesignCells(it.id);
      doc = buildTifoV2({
        title: it.title, generator: 'tifomaker-projects', templateId: d.templateId,
        templateVersion: d.templateVersion, palette: d.palette, cells: d.cells,
      });
    } else {
      const env = readEnvelope(docKey(it.id));
      if (!env) throw new Error('nothing saved yet');
      doc = { ...env.doc, meta: { ...env.doc.meta, title: it.title } };
    }
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(it.title || 'tifo').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'tifo'}.tifo`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    failed(e);
  }
}

async function unpublish(it: Item): Promise<void> {
  const { confirmModal } = await import('./ui/modal');
  const ok = await confirmModal({
    title: tv('pj.unpubQ', { name: it.title }),
    message: t('pj.unpubMsg'),
    confirmLabel: t('pj.m.unpublish'),
  });
  if (!ok) return;
  try {
    await setPublic(it.id, false);
    patchItem(it, { isPublic: false });
    toast(t('pj.t.private'));
  } catch (e) {
    failed(e);
  }
}

async function trash(it: Item): Promise<void> {
  // Something only its owner can see goes straight to the Trash, with an
  // Undo: the Trash is itself the safety net. Something published asks
  // first, because trashing it takes it out of the community too.
  if (it.isPublic) {
    const { confirmModal } = await import('./ui/modal');
    const ok = await confirmModal({
      title: tv('pj.trashQ', { name: it.title }),
      message: tv('pj.trashMsgPub', { n: trashDays }),
      confirmLabel: t('pj.m.trash'),
      danger: true,
    });
    if (!ok) return;
  }
  const wasPublic = it.isPublic;
  try {
    if (it.kind === 'account') await deleteProject(it.id);
    else trashLocal(it.id);
    patchItem(it, { deletedAt: Date.now(), isPublic: false });
    toast(t('pj.t.trashed'), { label: t('pj.t.undo'), run: () => void restore(it, wasPublic, true) });
  } catch (e) {
    failed(e);
  }
}

async function restore(it: Item, wasPublic = it.isPublic, quiet = false): Promise<void> {
  try {
    if (it.kind === 'account') await restoreProject(it.id);
    else restoreLocal(it.id);
    patchItem(it, { deletedAt: null, isPublic: wasPublic });
    if (!quiet) toast(t('pj.t.restored'));
  } catch (e) {
    failed(e);
  }
}

async function purge(it: Item): Promise<void> {
  const { confirmModal } = await import('./ui/modal');
  const ok = await confirmModal({
    title: tv('pj.purgeQ', { name: it.title }),
    message: t('pj.purgeMsg'),
    confirmLabel: t('pj.m.purge'),
    danger: true,
  });
  if (!ok) return;
  try {
    if (it.kind === 'account') await deleteProject(it.id, true);
    else purgeLocal(it.id);
    items = items.filter((x) => x !== it);
    render();
    toast(t('pj.t.deleted'));
  } catch (e) {
    failed(e);
  }
}

// ----------------------------------------------------------------- menu ---

let menuEl: HTMLElement | null = null;
let menuAnchor: HTMLElement | null = null;

function closeMenu(focusAnchor = false): void {
  menuEl?.remove();
  menuEl = null;
  if (menuAnchor) {
    menuAnchor.setAttribute('aria-expanded', 'false');
    if (focusAnchor) menuAnchor.focus();
  }
  menuAnchor = null;
}

function openMenu(it: Item, anchor: HTMLElement): void {
  closeMenu();
  const inTrash = it.deletedAt !== null;
  const entries: { label: string; run: () => void; danger?: boolean }[] = inTrash
    ? [
        { label: t('pj.m.restore'), run: () => void restore(it) },
        { label: t('pj.m.purge'), run: () => void purge(it), danger: true },
      ]
    : [
        { label: t('pj.m.open'), run: () => location.assign(openUrl(refOf(it))) },
        { label: t('pj.m.rename'), run: () => void rename(it) },
        { label: t('pj.m.duplicate'), run: () => void duplicate(it) },
        { label: t('pj.m.download'), run: () => void download(it) },
        it.isPublic
          ? { label: t('pj.m.unpublish'), run: () => void unpublish(it) }
          : { label: t('pj.m.publish'), run: () => location.assign(openUrl(refOf(it), { publish: '1' })) },
        { label: t('pj.m.trash'), run: () => void trash(it), danger: true },
      ];
  const m = document.createElement('div');
  m.className = 'pj-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = entries
    .map((e, i) => `<button type="button" role="menuitem" class="pj-menu-item${e.danger ? ' danger' : ''}" data-i="${i}" tabindex="-1">${escapeHtml(e.label)}</button>`)
    .join('');
  document.body.appendChild(m);
  menuEl = m;
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');

  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const rtl = document.documentElement.dir === 'rtl';
  let left = rtl ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = `${Math.round(left + window.scrollX)}px`;
  m.style.top = `${Math.round(top + window.scrollY)}px`;

  const buttons = Array.from(m.querySelectorAll<HTMLButtonElement>('.pj-menu-item'));
  buttons[0]?.focus();
  m.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.pj-menu-item');
    if (!b) return;
    const entry = entries[Number(b.dataset.i)];
    closeMenu();
    entry?.run();
  });
  m.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = buttons.length;
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu(true);
    }
  });
}

document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node) && !(menuAnchor?.contains(e.target as Node))) closeMenu();
});
window.addEventListener('resize', () => closeMenu());

grid.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!btn) return;
  const card = btn.closest<HTMLElement>('.pj-card');
  const it = card?.dataset.key ? find(card.dataset.key) : undefined;
  if (!it) return;
  e.preventDefault();
  if (btn.dataset.act === 'pin') void togglePin(it);
  else if (btn.dataset.act === 'menu') {
    if (menuAnchor === btn) closeMenu();
    else openMenu(it, btn);
  }
});

// ------------------------------------------------------------ creating ---

function takenNames(): string[] {
  return items.filter((it) => it.deletedAt === null).map((it) => it.title);
}

async function openCreate(ai = false): Promise<void> {
  const { openCreateProject } = await import('./ui/createProject');
  openCreateProject({
    ai,
    defaultName: nextDefaultName(t('np.nameDefault'), takenNames()),
    signIn,
  });
}

$('pj-new').addEventListener('click', () => void openCreate());
$('pj-empty-new').addEventListener('click', () => void openCreate());
$('pj-empty-ai').addEventListener('click', () => void openCreate(true));

// Importing a file makes a new project on the file's own stadium. The editor
// validates it against that stadium's seat map, which this page does not load.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.tifo,application/json';
fileInput.hidden = true;
document.body.appendChild(fileInput);
$('pj-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const parsed = JSON.parse(text) as { stadium?: { templateId?: string }; templateId?: string; meta?: { title?: string } };
    const stadiumId = parsed?.stadium?.templateId ?? parsed?.templateId;
    if (typeof stadiumId !== 'string' || !templateById(stadiumId)) throw new Error('unknown stadium');
    sessionStorage.setItem('tifo_pending_import', text);
    stashNewProject({
      title: (parsed.meta?.title || f.name.replace(/\.tifo$/i, '')).slice(0, 80) || t('np.nameDefault'),
      templateId: stadiumId,
    });
    location.assign(newProjectUrl(stadiumId, { import: '1' }));
  } catch {
    toast(t('pj.t.importBad'));
  }
});

// ------------------------------------------------------------- controls ---

searchInput.addEventListener('input', () => {
  query = searchInput.value;
  render();
});
sortSel.value = sort;
sortSel.addEventListener('change', () => {
  sort = sortSel.value as Sort;
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    /* the choice lasts for this visit */
  }
  render();
});
trashBtn.addEventListener('click', () => {
  view = view === 'trash' ? 'projects' : 'trash';
  render();
  trashBtn.focus();
});

// ------------------------------------------------------------------ auth ---

async function refreshAuth(): Promise<void> {
  const me = await fetchMe().catch(() => null);
  const named = await ensureUsernameChosen(me);
  signedIn = !!named && isSignedIn();
  if (named) {
    authBtn.removeAttribute('data-i18n');
    authBtn.textContent = `@${named.username}`;
    authBtn.onclick = () => location.assign('/account');
  } else {
    authBtn.setAttribute('data-i18n', 'ed.signup');
    authBtn.textContent = t('ed.signup');
    authBtn.onclick = () => void signIn();
  }
}

// ------------------------------------------------------------------ boot ---

initLang();
// The visit was counted when the page was sent; see core/utm.ts.
cleanAddressBar();
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
applyDom(document);
installMobileNav();
installConsent();

const langToggle = $('lang-toggle');
langToggle.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  langToggle.textContent = t('common.language');
});
onLangChange(() => {
  setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
  closeMenu();
  render();
});
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});

void (async () => {
  await adoptProviderSession();
  // Back from a provider with a claim asked for: this page claims everything
  // in load(), so the intent is used up here rather than left for the editor
  // to act on later, against whatever project it happens to open next.
  takeClaimIntent();
  const why = providerFailure();
  if (why) toast(t(`auth.err.${why}`));
  const params = new URLSearchParams(location.search);
  const flag = (k: string): string | null => {
    const v = params.get(k);
    params.delete(k);
    return v;
  };
  const verified = flag('verified');
  const missing = flag('missing');
  const importBad = flag('importfail');
  const wantsNew = flag('new');
  const wantsAi = flag('ai');
  const start = flag('start');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);

  await refreshAuth();
  await load();

  if (verified === '1') toast(t('verify.ok'));
  else if (verified === '0') toast(t('verify.fail'));
  if (missing) toast(t('pj.t.missing'));
  if (importBad) toast(t('pj.t.importBad'));

  const live = items.filter((it) => it.deletedAt === null).length;
  // The landing page's "Start designing" and a first visit to the editor both
  // arrive here wanting to begin: give them the panel, not an empty page.
  if (wantsNew === '1' || wantsAi === '1' || (start === '1' && live === 0)) void openCreate(wantsAi === '1');
})();
