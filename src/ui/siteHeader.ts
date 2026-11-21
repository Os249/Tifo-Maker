/**
 * The public pages' header (ui/siteHeader.css): the account button and its menu.
 *
 * The places are plain links in each page's HTML and need no script. This is
 * the part that depends on who is looking: "Sign up" until someone is signed
 * in, then their letter, which opens a menu with the account, their projects,
 * Pro, the theme and Sign out. Signed out on a phone the same menu is behind
 * the "more" button, with what the bar has no room for (Pro, For clubs, the
 * theme). A letter with the gold ring and the crown is an account whose Pro is
 * running (a paid month or the gift): what the server says, never a guess.
 *
 * A page that signs people in itself (community, projects, events, Pro) calls
 * initSiteHeader({ onSignIn }) and then setHeaderUser() whenever it learns who
 * is there. A page with no sign-in of its own (home, clubs, account) calls
 * initSiteHeader() alone: the header asks the server itself, and only when the
 * browser holds a session, so a first-time visitor's page loads nothing for it.
 */
import { escapeHtml } from '../core/escape';
import { CROWN_SVG } from './crown';
import { localPath, onLangChange, t, tv } from './i18n';

export interface HeaderUser { username: string }
export interface SiteHeaderOptions {
  /** The page's own way in. Without one, the shared dialog is opened and the page reloads on success. */
  onSignIn?: () => void | Promise<void>;
  /** After signing out: by default the page is loaded again. */
  onSignOut?: () => void;
}

const ICON = {
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20.5c1-4 4.2-6 8-6s7 2 8 6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20.5V4.5M5 5.5h12l-2.5 4 2.5 4H5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
  out: '<svg class="flip" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h9"/></svg>',
};
/** The key net/api.ts keeps the session under: read here only to decide whether there is anyone to ask about. */
const TOKEN_KEY = 'tifo_token_v1';

let header: HTMLElement | null = null;
let authBtn: HTMLButtonElement | null = null;
let moreBtn: HTMLButtonElement | null = null;
let menu: HTMLElement | null = null;
let opener: HTMLElement | null = null;
let user: HeaderUser | null = null;
let options: SiteHeaderOptions = {};
/** True while the menu presses the header's own theme toggle for the visitor. */
let proxying = false;
/** What /api/pro last said that the header shows: whether Pro is running, the countdown's words for it, and whether it is on sale. */
let pro: { active: boolean; label: () => string; onSale: boolean } = { active: false, label: () => '', onSale: false };

const here = (path: string): boolean => location.pathname.replace(/^\/ar(?=\/|$)/, '').replace(/\/$/, '') === path;

function isDark(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** The menu's rows, for whoever is looking now. */
function menuHtml(): string {
  const link = (path: string, icon: string, label: string, cls = ''): string =>
    `<a class="nav-mi ${cls}" role="menuitem" href="${escapeHtml(localPath(path))}"${here(path.split('#')[0]) && !path.includes('#') ? ' aria-current="page"' : ''}>${icon}<span>${escapeHtml(label)}</span></a>`;
  const proRow = pro.active
    ? link('/account#billing', CROWN_SVG, t('nav.managePro'), 'gold')
    : link('/pro', CROWN_SVG, t(pro.onSale ? 'nav.pro' : 'nav.proSoon'), 'gold');
  const theme = `<button type="button" class="nav-mi" role="menuitem" data-act="theme">${isDark() ? ICON.sun : ICON.moon}<span>${escapeHtml(t(isDark() ? 'theme.light' : 'theme.dark'))}</span></button>`;
  if (!user) return proRow + link('/clubs', ICON.flag, t('nav.clubs')) + `<div class="nav-menu-sep"></div>` + theme;
  return (
    `<div class="nav-menu-head"><b><bdi dir="ltr">@${escapeHtml(user.username)}</bdi></b>` +
    `<span>${escapeHtml((pro.active && pro.label()) || t('nav.planFree'))}</span></div>` +
    link('/account', ICON.user, t('nav.account')) +
    link('/projects', ICON.folder, t('nav.projects')) +
    proRow +
    link('/clubs', ICON.flag, t('nav.clubs'), 'only-narrow') +
    `<div class="nav-menu-sep"></div>` +
    theme +
    `<button type="button" class="nav-mi" role="menuitem" data-act="signout">${ICON.out}<span>${escapeHtml(t('nav.signOut'))}</span></button>`
  );
}

function closeMenu(focus = true): void {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  opener?.setAttribute('aria-expanded', 'false');
  if (focus) opener?.focus();
  opener = null;
}

function openMenu(from: HTMLElement): void {
  if (!menu) return;
  menu.innerHTML = menuHtml();
  menu.hidden = false;
  opener = from;
  from.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('.nav-mi')?.focus();
}

function toggleMenu(from: HTMLElement): void {
  if (menu && !menu.hidden && opener === from) closeMenu();
  else openMenu(from);
}

/** Paint the account button for whoever is signed in, or as the way in. */
function paintButton(): void {
  if (!authBtn || !header) return;
  if (user) {
    // Drop the i18n binding while it holds a name: applyDom() rewrites every
    // [data-i18n] node on a language switch, and would put "Sign up" back.
    authBtn.removeAttribute('data-i18n');
    authBtn.classList.add('is-user');
    authBtn.dataset.letter = user.username.charAt(0);
    authBtn.toggleAttribute('data-pro', pro.active);
    // The name is the button's text for a screen reader; the letter is drawn from data-letter.
    authBtn.innerHTML = `<span class="nav-sr">@${escapeHtml(user.username)}</span>` + (pro.active ? `<span class="nav-av-badge" aria-hidden="true">${CROWN_SVG}</span>` : '');
    authBtn.setAttribute('aria-label', pro.active ? tv('nav.youPro', { name: user.username }) : `@${user.username}`);
    authBtn.setAttribute('aria-haspopup', 'menu');
    authBtn.setAttribute('aria-expanded', String(!!menu && !menu.hidden && opener === authBtn));
    header.dataset.user = '1';
  } else {
    authBtn.classList.remove('is-user');
    authBtn.removeAttribute('data-pro');
    authBtn.removeAttribute('data-letter');
    authBtn.removeAttribute('aria-label');
    authBtn.removeAttribute('aria-haspopup');
    authBtn.removeAttribute('aria-expanded');
    authBtn.setAttribute('data-i18n', 'nav.join');
    authBtn.textContent = t('nav.join');
    delete header.dataset.user;
  }
}

/** Ask the server about Pro for this visitor: whether it is running (the ring and the crown) and whether it is on sale (the link's word). */
async function loadPro(fresh = false): Promise<void> {
  try {
    const { fetchPro } = await import('../net/api');
    const st = await fetchPro(fresh);
    const active = !!st.live && !!st.pass && !!st.plan && st.plan !== 'free' && Date.parse(st.pass.endsAt) > Date.now();
    // The same words the countdown has always used ("Pro · 5 days left", "Pro · until 20 December 2026"),
    // worked out when read so they follow the language. Loaded only for an account whose Pro is running.
    const chipText = active ? (await import('./pro')).chipText : null;
    pro = { active, label: () => (chipText ? chipText(st) ?? '' : ''), onSale: st.offer?.paymentsOpen === true };
  } catch {
    pro = { active: false, label: () => '', onSale: false };
  }
  // Pro is on sale: the header's link says "Pro", not "Pro · soon".
  if (pro.onSale) {
    document.querySelectorAll<HTMLElement>('[data-i18n="nav.proSoon"]').forEach((el) => {
      el.setAttribute('data-i18n', 'nav.pro');
      el.textContent = t('nav.pro');
    });
  }
  paintButton();
}

/** Tell the header who is signed in (or that nobody is). */
export function setHeaderUser(next: HeaderUser | null): void {
  const changed = (user?.username ?? null) !== (next?.username ?? null);
  user = next ? { username: next.username } : null;
  if (changed) closeMenu(false);
  if (!user) pro = { ...pro, active: false, label: () => '' };
  paintButton();
  if (user && changed) void loadPro();
}

async function defaultSignIn(): Promise<void> {
  const { openAuthModal } = await import('./authModal');
  if (await openAuthModal(false, 'signin')) location.reload();
}

/** Wire the header. Once per page, after the DOM is parsed. */
export function initSiteHeader(opts: SiteHeaderOptions = {}): void {
  header = document.querySelector<HTMLElement>('header.nav');
  authBtn = document.getElementById('auth-btn') as HTMLButtonElement | null;
  if (!header || !authBtn || menu) return;
  options = opts;
  moreBtn = header.querySelector<HTMLButtonElement>('.nav-more');
  menu = document.createElement('div');
  menu.className = 'nav-menu';
  menu.id = 'nav-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  header.append(menu);
  moreBtn?.setAttribute('aria-controls', 'nav-menu');

  authBtn.addEventListener('click', () => {
    if (user) toggleMenu(authBtn!);
    else void (options.onSignIn ?? defaultSignIn)();
  });
  moreBtn?.addEventListener('click', () => toggleMenu(moreBtn!));
  menu.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'theme') {
      // The header's own toggle does the work (ui/colorScheme.ts), wherever it is shown.
      const from = opener;
      // Its click is ours: it must not count as a click outside the menu.
      proxying = true;
      document.getElementById('theme-toggle')?.click();
      proxying = false;
      if (menu && from) { menu.innerHTML = menuHtml(); menu.querySelector<HTMLElement>('[data-act="theme"]')?.focus(); }
    } else if (act === 'signout') {
      const { signOut } = await import('../net/api');
      signOut();
      closeMenu(false);
      if (options.onSignOut) options.onSignOut();
      else location.reload();
    } else if ((e.target as HTMLElement).closest('a')) {
      closeMenu(false);
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu || menu.hidden) return;
    const target = e.target as Node;
    // A row that was just redrawn (the theme row) is no longer in the page: that click was inside the menu.
    if (proxying || !target.isConnected) return;
    if (!menu.contains(target) && !opener?.contains(target)) closeMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!menu || menu.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = Array.from(menu.querySelectorAll<HTMLElement>('.nav-mi')).filter((r) => r.offsetParent !== null);
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[to]?.focus();
  });
  menu.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && !menu!.contains(to) && !opener?.contains(to)) closeMenu(false);
  });
  onLangChange(() => {
    paintButton();
    if (menu && !menu.hidden) menu.innerHTML = menuHtml();
  });
  window.addEventListener('tifo:pro', () => void loadPro(true));

  // A page with no sign-in of its own: the header finds out who is there, and
  // only where the browser holds a session at all.
  let session = false;
  try { session = !!localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked: nobody is signed in */ }
  if (!opts.onSignIn && session) {
    void import('../net/api').then(async ({ fetchMeOnce }) => {
      const me = await fetchMeOnce().catch(() => null);
      if (me && !me.needsUsername) setHeaderUser(me);
    });
  }
  // Whether Pro is on sale decides the link's word for everyone; asked once the page is idle.
  const idle = (window as unknown as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1200));
  idle(() => { if (!user) void loadPro(); });
}
