/**
 * The account page's areas (20 Nov 2026): Profile, Sign-in and security, Pro
 * and billing, Data and privacy, Danger zone. One is on screen at a time, and
 * which one is the address: /account#billing opens billing, and so on.
 *
 * A phone opens on the overview (the summary and the list of areas) and each
 * area is its own screen with a way back. From 900px the list stays beside the
 * open area, so with no hash the first area is open instead of an empty pane.
 *
 * The addresses the page had before keep working: #pro (the header chip, every
 * receipt and refund email) is billing, and the old section ids (#sec-danger
 * and the rest) open the area they moved into and bring that card into view.
 *
 * The stylesheet shows and hides by <main data-area>; this module sets it,
 * hides the panes that are not open, and marks the list.
 */
export type Area = 'overview' | 'profile' | 'security' | 'billing' | 'data' | 'danger';

const AREAS: readonly Area[] = ['profile', 'security', 'billing', 'data', 'danger'];
/** Earlier addresses into the page, and the area each now lives in. */
const MOVED: Record<string, Area> = {
  pro: 'billing',
  'sec-name': 'profile',
  'sec-email': 'security',
  'sec-password': 'security',
  'sec-connected': 'security',
  'sec-data': 'data',
  'sec-danger': 'danger',
};
const WIDE = '(min-width: 900px)';

export interface Areas {
  /** Draw again: something that decides what is shown changed (Pro came on, the screen turned). */
  refresh(): void;
  /** The area on screen: on a wide screen with no hash, the first one. */
  open(): Area;
  /** Go to an area, as a link to it would. */
  go(area: Area): void;
}

/** `available` says whether an area exists for this account right now (billing does only where Pro is on). */
export function initAreas(main: HTMLElement, available: (area: Area) => boolean): Areas {
  const wide = window.matchMedia(WIDE);
  const panes = Array.from(main.querySelectorAll<HTMLElement>('.ac-area'));
  const links = Array.from(main.querySelectorAll<HTMLAnchorElement>('.ac-link'));

  /** The hash as an area, and the card inside it the hash named, if it named one. */
  const asked = (): { area: Area; card: string | null } => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''));
    const area = (AREAS as readonly string[]).includes(id) ? (id as Area) : MOVED[id] ?? 'overview';
    return { area: available(area) ? area : 'overview', card: MOVED[id] ? id : null };
  };
  const open = (): Area => {
    const { area } = asked();
    return area === 'overview' && wide.matches ? 'profile' : area;
  };

  const draw = (): void => {
    const { area } = asked();
    const shown = open();
    main.dataset.area = area;
    for (const p of panes) p.hidden = p.dataset.area !== shown;
    for (const a of links) {
      if (a.dataset.to === shown) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };

  // A step from one area to another starts at its top, with the keyboard and a
  // screen reader put on its heading: on a phone it is a new screen.
  const arrive = (): void => {
    draw();
    const { area, card } = asked();
    const target = card ? document.getElementById(card) : null;
    if (target && !target.hidden) {
      target.scrollIntoView({ block: 'start' });
      return;
    }
    window.scrollTo(0, 0);
    if (area === 'overview') main.focus({ preventScroll: true });
    else document.getElementById(area)?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };

  window.addEventListener('hashchange', arrive);
  wide.addEventListener('change', draw);
  draw();
  return {
    refresh: draw,
    open,
    go(area) {
      if (asked().area === area) return;
      location.hash = area;
    },
  };
}
