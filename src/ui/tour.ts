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

interface TourStep {
  selector: string;
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

/** Run the tour. Resolves when finished or skipped. */
export function startTour(): Promise<void> {
  return new Promise((resolve) => {
    const isPhone = window.matchMedia('(max-width: 767px)').matches;
    const steps = (isPhone ? MOBILE_STEPS : STEPS).filter((s) => {
      const el = document.querySelector<HTMLElement>(s.selector);
      return !!el && el.getClientRects().length > 0; // exists AND actually visible
    });
    if (steps.length === 0) {
      markTourSeen();
      resolve();
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.innerHTML = `
      <div class="tour-spotlight" id="tour-spot"></div>
      <div class="tour-pop" id="tour-pop" role="dialog" aria-live="polite">
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

    const finish = (): void => {
      markTourSeen();
      window.removeEventListener('resize', render);
      overlay.remove();
      // On phones, hand off to the AI front door (unless it's already open).
      if (isPhone) {
        const p = document.getElementById('panel');
        if (p && !p.classList.contains('open')) (document.getElementById('rail-ai') as HTMLButtonElement | null)?.click();
      }
      resolve();
    };

    function render(): void {
      const step = steps[i];
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (!el) {
        // Target vanished — skip forward.
        if (i < steps.length - 1) {
          i++;
          render();
        } else finish();
        return;
      }
      const r = el.getBoundingClientRect();
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
        const place = step.place ?? 'bottom';
        let left = 0;
        let top = 0;
        const gap = 16;
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
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        left = Math.max(12, Math.min(left, vw - pr.width - 12));
        top = Math.max(12, Math.min(top, vh - pr.height - 12));
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
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
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        finish();
      }
    });

    render();
  });
}
