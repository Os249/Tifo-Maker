/**
 * Light / dark for the public pages.
 *
 * (Not to be confused with ./theme.ts, which installs Floodlight — the
 * editor's design system. This is only the public site's colour scheme.)
 *
 * Two rules, both from what people actually expect:
 *
 *  - with no choice made, follow the device. Somebody whose phone is in dark
 *    mode should never be handed a white page, and if they flip the phone
 *    while the tab is open the page follows.
 *  - once they press the toggle, that is the answer until they change it. An
 *    explicit choice outranks the system, on every page and every visit.
 *
 * The attribute itself is set by /theme-boot.js (public/theme-boot.js), a tiny
 * classic script at the top of each page's head, because a module loads too
 * late: the page would paint white and then snap to dark, which is worse than
 * not having the feature at all. This module handles only what happens after
 * that first paint.
 */
export type Scheme = 'light' | 'dark';

const KEY = 'tifo_theme_v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// public/theme-boot.js repeats stored() and systemScheme() below in plain ES5,
// kept in step by hand: it is four lines, and it cannot import anything. It is a
// file rather than an inline <script> because the Content-Security-Policy allows
// scripts from this origin only, and it blocked the inline copy on every load.

const stored = (): Scheme | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // private mode or blocked storage; the device preference still works
  }
};

const systemScheme = (): Scheme =>
  window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';

export const getScheme = (): Scheme =>
  (document.documentElement.getAttribute('data-theme') as Scheme | null) ?? stored() ?? systemScheme();

const listeners = new Set<(s: Scheme) => void>();

function paint(scheme: Scheme): void {
  document.documentElement.setAttribute('data-theme', scheme);
  // The browser chrome around the page — address bar, notch — matches too.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', scheme === 'dark' ? '#0E0C16' : '#FBFAFF');
  for (const fn of listeners) fn(scheme);
}

export function setScheme(scheme: Scheme): void {
  try {
    localStorage.setItem(KEY, scheme);
  } catch { /* the choice just won't outlive the tab */ }
  paint(scheme);
}

export function toggleScheme(): Scheme {
  const next: Scheme = getScheme() === 'dark' ? 'light' : 'dark';
  setScheme(next);
  return next;
}

/** Set once i18n is up; English until then, which is what the markup says. */
let labels = { dark: 'Dark mode', light: 'Light mode' };

/** The button says what pressing it will DO, not what is currently on. */
function label(btn: HTMLElement): void {
  const text = getScheme() === 'dark' ? labels.light : labels.dark;
  btn.setAttribute('aria-label', text);
  btn.setAttribute('title', text);
}

const relabelAll = (): void => {
  for (const b of document.querySelectorAll<HTMLElement>('.theme-toggle')) label(b);
};

export function setSchemeLabels(next: { dark: string; light: string }): void {
  labels = next;
  relabelAll();
}

/**
 * Wire the header toggle, and keep following the device until a choice is
 * made. Safe to call on a page that has no toggle.
 */
export function initScheme(): void {
  paint(getScheme());
  listeners.add(relabelAll);

  window.matchMedia?.(DARK_QUERY).addEventListener('change', (e) => {
    if (!stored()) paint(e.matches ? 'dark' : 'light');
  });

  for (const btn of document.querySelectorAll<HTMLElement>('.theme-toggle')) {
    btn.addEventListener('click', () => toggleScheme());
    label(btn);
  }
}
