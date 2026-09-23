import { t } from './i18n';

/**
 * First-run guided tour. After onboarding, new users get a sequence of spotlight
 * coach-marks pointing at the major editor controls — what each does, and (the
 * common confusion) how to switch between the 2D Design view, the 3D Stadium
 * view, and the live Split view. Fully skippable; shown once (localStorage flag).
 *
 * It's resilient: any step whose target element is missing is silently skipped,
 * so the tour never blocks the UI even if the DOM changes.
 */

const TOUR_FLAG = 'tifo_tour_v2';

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_FLAG) === '1';
  } catch {
    return true; // storage blocked → don't nag
  }
}
export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_FLAG, '1');
  } catch {
    /* ignore */
  }
}

export interface TourStep {
  /**
   * What to light up. Several selectors light up the box around all of them
   * that are on the screen, for a step about a group of controls rather than
   * one.
   */
  selector: string | string[];
  /**
   * The box to light up, when it is not an element's: the banner sheet is
   * drawn on a canvas that fills the whole view, and lighting the canvas
   * lights the whole screen. The selector still has to be on the screen.
   */
  box?: () => { left: number; top: number; right: number; bottom: number } | null;
  /** Only when this says so. A step about a control the user cannot use yet is noise. */
  when?: () => boolean;
  /** i18n keys, not literals: the tour is the one place a new user reads prose. */
  titleKey: string;
  bodyKey: string;
  place?: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: TourStep[] = [
  {
    selector: '.tool-rail',
    titleKey: 'tour.tools',
    bodyKey: 'tour.tools.b',
    place: 'right',
  },
  {
    selector: '#fg-well',
    titleKey: 'tour.colors',
    bodyKey: 'tour.colors.b',
    place: 'left',
  },
  {
    selector: '#rail-ai',
    titleKey: 'tour.ai',
    bodyKey: 'tour.ai.b',
    place: 'right',
  },
  {
    selector: '#rail-stadium',
    titleKey: 'tour.stadium',
    bodyKey: 'tour.stadium.b',
    place: 'right',
  },
  {
    selector: '#view-2d',
    titleKey: 'tour.design',
    bodyKey: 'tour.design.b',
    place: 'bottom',
  },
  {
    selector: '#view-3d',
    titleKey: 'tour.stadiumView',
    bodyKey: 'tour.stadiumView.b',
    place: 'bottom',
  },
  {
    selector: '#view-split',
    titleKey: 'tour.split',
    bodyKey: 'tour.split.b',
    place: 'bottom',
  },
  {
    selector: '#save',
    titleKey: 'tour.save',
    bodyKey: 'tour.save.b',
    place: 'top',
  },
  {
    selector: '#gallery',
    titleKey: 'tour.inspire',
    bodyKey: 'tour.inspire.b',
    place: 'bottom',
  },
];

// Short, phone-native tour: fewer steps, targets the bottom ribbon + view tabs,
// and ends on AI so finishing drops the user into the AI front door.
const MOBILE_STEPS: TourStep[] = [
  { selector: '.tool-rail', titleKey: 'tour.mtools', bodyKey: 'tour.mtools.b', place: 'top' },
  { selector: '#view-3d', titleKey: 'tour.m3d', bodyKey: 'tour.m3d.b', place: 'bottom' },
  { selector: '#rail-ai', titleKey: 'tour.mai', bodyKey: 'tour.mai.b', place: 'top' },
];

/** Everything a step points at that is actually on the screen. */
function targetsOf(step: TourStep): HTMLElement[] {
  const sels = Array.isArray(step.selector) ? step.selector : [step.selector];
  const vw = window.innerWidth;
  const out: HTMLElement[] = [];
  for (const sel of sels) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || el.getClientRects().length === 0) continue; // missing, or display:none
    const r = el.getBoundingClientRect();
    // Off to one side is not on the screen: a closed slide-over panel still
    // has boxes, parked past the edge of the window.
    if (r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= vw) continue;
    out.push(el);
  }
  return out;
}

/**
 * Scroll the panel a control sits in, and only that, until it is in view.
 *
 * Not scrollIntoView: that scrolls every ancestor that can move, the page
 * included — and the page is overflow:hidden, not unscrollable, so a control
 * a little way off either edge dragged the whole editor sideways with it.
 */
function reveal(el: HTMLElement): void {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy !== 'auto' && oy !== 'scroll') || p.scrollHeight <= p.clientHeight) continue;
    const box = p.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top + 8) p.scrollTop -= box.top + 8 - r.top;
    else if (r.bottom > box.bottom - 8) p.scrollTop += Math.min(r.bottom - (box.bottom - 8), r.top - (box.top + 8));
    return;
  }
}

/** Is a tour on the screen right now? */
export function tourOpen(): boolean {
  return !!document.querySelector('.tour-overlay');
}

export interface TourOptions {
  steps: TourStep[];
  /** The phone's steps, when they differ. */
  mobileSteps?: TourStep[];
  /** Called when it ends, finished or skipped: the place to remember it. */
  onDone?: () => void;
  /** Label for the dialog, for a screen reader. */
  labelKey?: string;
}

/** Run the tour. Resolves when finished or skipped. */
export function startTour(opts?: TourOptions): Promise<void> {
  return new Promise((resolve) => {
    const isPhone = window.matchMedia('(max-width: 767px)').matches;
    const main = !opts;
    const all = opts ? (isPhone && opts.mobileSteps ? opts.mobileSteps : opts.steps) : isPhone ? MOBILE_STEPS : STEPS;
    const markDone = opts?.onDone ?? markTourSeen;
    // One tour at a time. A second one would stack a second spotlight on the
    // first, with two sets of buttons fighting over the same keys.
    if (tourOpen()) {
      resolve();
      return;
    }
    const steps = all.filter((s) => (!s.when || s.when()) && targetsOf(s).length > 0);
    if (steps.length === 0) {
      markDone();
      resolve();
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.innerHTML = `
      <div class="tour-spotlight" id="tour-spot"></div>
      <div class="tour-pop" id="tour-pop" role="dialog" aria-live="polite"${opts?.labelKey ? ` aria-label="${t(opts.labelKey)}"` : ''}>
        <div class="tour-pop-step" id="tour-step"></div>
        <h4 class="tour-pop-title" id="tour-title"></h4>
        <p class="tour-pop-body" id="tour-body"></p>
        <div class="tour-pop-actions">
          <button class="tour-skip" id="tour-skip">${t('tour.skip')}</button>
          <div class="tour-nav">
            <button class="tour-back" id="tour-back">${t('tour.back')}</button>
            <button class="tour-next primary" id="tour-next">${t('tour.next')}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let i = 0;
    const spot = overlay.querySelector('#tour-spot') as HTMLElement;
    const pop = overlay.querySelector('#tour-pop') as HTMLElement;

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      markDone();
      window.removeEventListener('resize', render);
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      // On phones, hand off to the AI front door (unless it's already open).
      if (main && isPhone) {
        const p = document.getElementById('panel');
        if (p && !p.classList.contains('open')) (document.getElementById('rail-ai') as HTMLButtonElement | null)?.click();
      }
      resolve();
    };

    function render(): void {
      const step = steps[i];
      let els = targetsOf(step);
      if (els.length === 0) {
        // Target vanished — skip forward.
        if (i < steps.length - 1) {
          i++;
          render();
        } else finish();
        return;
      }
      // A control down a scrolled panel is brought into view before it is
      // pointed at: a spotlight on a box below the fold points at nothing.
      reveal(els[0]);
      if (els.length > 1) reveal(els[els.length - 1]);
      els = targetsOf(step);
      if (els.length === 0) return;
      const own = step.box?.();
      const boxes = own ? [own] : els.map((e) => e.getBoundingClientRect());
      const left0 = Math.min(...boxes.map((b) => b.left));
      const top0 = Math.min(...boxes.map((b) => b.top));
      const right0 = Math.max(...boxes.map((b) => b.right));
      const bottom0 = Math.max(...boxes.map((b) => b.bottom));
      const r = { left: left0, top: top0, right: right0, bottom: bottom0, width: right0 - left0, height: bottom0 - top0 };
      const pad = 8;
      // Position the spotlight over the target.
      spot.style.left = `${r.left - pad}px`;
      spot.style.top = `${r.top - pad}px`;
      spot.style.width = `${r.width + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;

      // Fill content.
      (overlay.querySelector('#tour-step') as HTMLElement).textContent = t('tour.step').replace('{n}', String(i + 1)).replace('{total}', String(steps.length));
      (overlay.querySelector('#tour-title') as HTMLElement).textContent = t(step.titleKey);
      (overlay.querySelector('#tour-body') as HTMLElement).textContent = t(step.bodyKey);
      (overlay.querySelector('#tour-back') as HTMLButtonElement).style.visibility = i === 0 ? 'hidden' : 'visible';
      (overlay.querySelector('#tour-next') as HTMLButtonElement).textContent = i === steps.length - 1 ? t('tour.done') : t('tour.next');

      // Place the popover near the target, clamped to the viewport.
      pop.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        const pr = pop.getBoundingClientRect();
        const gap = 16;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const at = (place: 'right' | 'left' | 'top' | 'bottom'): { left: number; top: number } => {
          let left = 0;
          let top = 0;
          if (place === 'right') {
            left = r.right + gap;
            top = r.top;
          } else if (place === 'left') {
            left = r.left - pr.width - gap;
            top = r.top;
          } else if (place === 'top') {
            left = r.left + r.width / 2 - pr.width / 2;
            top = r.top - pr.height - gap;
          } else {
            left = r.left + r.width / 2 - pr.width / 2;
            top = r.bottom + gap;
          }
          // Clamp.
          left = Math.max(12, Math.min(left, vw - pr.width - 12));
          top = Math.max(12, Math.min(top, vh - pr.height - 12));
          return { left, top };
        };
        const covers = (p: { left: number; top: number }): boolean =>
          p.left < r.right && p.left + pr.width > r.left && p.top < r.bottom && p.top + pr.height > r.top;
        // The side asked for, unless clamping it into the window puts the card
        // over the very thing it is describing — then the next side that does
        // not, and failing all of them, the one asked for.
        // Sides are the reading direction's: in Arabic the panel is on the
        // left, so "beside the panel, towards the canvas" is its right.
        const asked = step.place ?? 'bottom';
        const rtl = document.documentElement.dir === 'rtl';
        const want = rtl && asked === 'left' ? 'right' : rtl && asked === 'right' ? 'left' : asked;
        const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;
        const order: ('right' | 'left' | 'top' | 'bottom')[] = [want, opposite[want], ...(['bottom', 'top', 'right', 'left'] as const).filter((x) => x !== want && x !== opposite[want])];
        const pos = order.map(at).find((p) => !covers(p)) ?? at(want);
        pop.style.left = `${pos.left}px`;
        pop.style.top = `${pos.top}px`;
        pop.style.visibility = 'visible';
      });
    }

    overlay.querySelector('#tour-next')!.addEventListener('click', () => {
      if (i < steps.length - 1) {
        i++;
        render();
      } else finish();
    });
    overlay.querySelector('#tour-back')!.addEventListener('click', () => {
      if (i > 0) {
        i--;
        render();
      }
    });
    overlay.querySelector('#tour-skip')!.addEventListener('click', finish);
    window.addEventListener('resize', render);
    // Removed by finish(), whichever way the tour ends. It used to remove
    // itself only on Escape, so every tour that ended on a button left a
    // listener behind that would end the NEXT tour on the first Escape.
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') finish();
    }
    document.addEventListener('keydown', onKey);

    render();
  });
}
