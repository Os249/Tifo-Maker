import { startTour, tourOpen, type TourStep } from './tour';

/**
 * The Banner view's own tour: the first time somebody opens it, and again from
 * "How banners work" in its panel.
 *
 * The editor's main tour is no longer pushed at anyone (see the note in
 * main.ts) and this one is, and the difference is the moment. That tour
 * landed on a first-time visitor in their first thirty seconds, on top of two
 * other things. This one arrives when somebody has just chosen to open a view
 * that works differently from the rest of the editor — a sheet with a size, a
 * fabric and a stand of its own — which is exactly when a short explanation is
 * wanted. It is skippable on every step, Escape ends it, and it is shown once.
 *
 * It follows the state of the tifo. With no banner yet it is three steps about
 * making one; with a banner, it walks the sheet, the tools, the list, the
 * placement and the reveal. Steps whose controls are not on the screen (the
 * panel is a closed slide-over on a narrow laptop) are left out, not pointed
 * at empty space.
 */

const FLAG = 'tifo_banner_tour_v1';

export function hasSeenBannerTour(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return true; // storage blocked → don't nag on every open
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    /* ignore */
  }
}

/** Where the sheet is drawn, told by the Banner view once it is up. */
let sheetBox: (() => { left: number; top: number; right: number; bottom: number } | null) | null = null;
export function setSheetBox(fn: typeof sheetBox): void {
  sheetBox = fn;
}
const sheet = (): { left: number; top: number; right: number; bottom: number } | null => sheetBox?.() ?? null;

const none = (): boolean => document.body.classList.contains('bn-none');
const some = (): boolean => !none();
const isSign = (): boolean => document.body.classList.contains('bn-sign');

const STEPS: TourStep[] = [
  { selector: '#view-banner', titleKey: 'btour.intro', bodyKey: 'btour.intro.b', place: 'bottom' },
  { selector: '#bn-empty', when: none, titleKey: 'btour.make', bodyKey: 'btour.make.b', place: 'right' },
  { selector: '#banner-bar', when: some, titleKey: 'btour.sheet', bodyKey: 'btour.sheet.b', place: 'bottom' },
  { selector: '#bn-msg-block', when: isSign, titleKey: 'btour.msg', bodyKey: 'btour.msg.b', place: 'left' },
  { selector: '.tool-rail', when: some, titleKey: 'btour.draw', bodyKey: 'btour.draw.b', place: 'right' },
  { selector: ['#ctx-banner > h4', '#bn-list', '.bn-add-row'], titleKey: 'btour.list', bodyKey: 'btour.list.b', place: 'left' },
  { selector: ['label[for="bn-stand"]', '#bn-stand', '#bn-size-out'], when: some, titleKey: 'btour.place', bodyKey: 'btour.place.b', place: 'left' },
  { selector: ['#bn-reveal', '#bn-matchday'], when: some, titleKey: 'btour.reveal', bodyKey: 'btour.reveal.b', place: 'left' },
  { selector: '#bn-tour', titleKey: 'btour.again', bodyKey: 'btour.again.b', place: 'left' },
];

/**
 * A phone has the artboard, the view pill and the ribbon on the screen, and
 * everything else in the Paint sheet — so the phone's tour is about where
 * things are, and is three steps.
 */
const MOBILE_STEPS: TourStep[] = [
  { selector: '.m-view-b[data-view="banner"]', titleKey: 'btour.m.view', bodyKey: 'btour.intro.b', place: 'bottom' },
  { selector: '#bn-empty', when: none, titleKey: 'btour.make', bodyKey: 'btour.make.b', place: 'top' },
  { selector: '#banner-host', box: sheet, when: some, titleKey: 'btour.m.draw', bodyKey: 'btour.m.draw.b', place: 'bottom' },
  { selector: '.m-tab[data-tab="paint"]', titleKey: 'btour.m.paint', bodyKey: 'btour.m.paint.b', place: 'top' },
];

/** Something else already has the screen: onboarding, a tour, Match Day. */
function screenBusy(): boolean {
  return tourOpen() || !!document.querySelector('.ob-backdrop, .mds-overlay');
}

/** Run it now, whether or not it has been seen: "How banners work". */
export function runBannerTour(): Promise<void> {
  // The replay link sits in the Paint sheet on a phone, and the sheet covers
  // the artboard the tour is about to point at.
  document.querySelector<HTMLButtonElement>('.m-sheet.open .m-sheet-x')?.click();
  document.dispatchEvent(new CustomEvent('tifo:news-close'));
  return startTour({ steps: STEPS, mobileSteps: MOBILE_STEPS, onDone: markSeen, labelKey: 'btour.aria' });
}

/**
 * The first time the Banner view opens. A moment after, so the view has laid
 * itself out — and only if it is still the Banner view by then, and nothing
 * else has the screen. Not shown is not the same as seen: the next open tries
 * again.
 */
export function offerBannerTour(stillHere: () => boolean): void {
  if (hasSeenBannerTour()) return;
  window.setTimeout(() => {
    if (hasSeenBannerTour() || !stillHere() || screenBusy()) return;
    void runBannerTour();
  }, 450);
}
