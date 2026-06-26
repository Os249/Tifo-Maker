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
  title: string;
  body: string;
  place?: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: TourStep[] = [
  {
    selector: '.tool-rail',
    title: 'Your tools',
    body: 'Brush, Fill and Eraser paint the seats; Text and Image add words or a logo. Shapes drops crests, stars and more — add as many as you like, then “Bake all”. Select now lets you drag a box around any area to recolour or clear it. Hover any tool for its shortcut.',
    place: 'right',
  },
  {
    selector: '#fg-well',
    title: 'Your colors',
    body: 'This is your active paint color. Click it to change it, hit “+ Color” to add any color to your palette, then click a swatch to paint with it.',
    place: 'left',
  },
  {
    selector: '#rail-ai',
    title: 'AI Designer',
    body: 'Describe a display in plain words and the AI paints a fully editable tifo on the seats. “Super AI” designs the whole bowl at once; “Shuffle” gives instant free variations — no tokens needed.',
    place: 'right',
  },
  {
    selector: '#rail-stadium',
    title: 'Choose your stadium',
    body: 'Pick the stadium your tifo is for and set the active area. Switching stadiums remaps your design onto the new bowl, so a display can be reused anywhere.',
    place: 'right',
  },
  {
    selector: '#view-2d',
    title: 'Design view',
    body: 'This flat view is where you paint the choreography across all 60,000 seats. It’s where you’ll spend most of your time.',
    place: 'bottom',
  },
  {
    selector: '#view-3d',
    title: 'Stadium view',
    body: 'See your design wrap around the real 3D bowl — and open the Match Day Simulator for a packed, cinematic night-match view with crowds, flags, smoke and choreography.',
    place: 'bottom',
  },
  {
    selector: '#view-split',
    title: 'Split view — both at once',
    body: 'Paint on the left and watch the 3D stadium update live on the right. The best of both while you fine-tune.',
    place: 'bottom',
  },
  {
    selector: '#save',
    title: 'Save, share & produce',
    body: 'Save to your account, publish to the community, or export match-day logistics — a distribution PDF, seat manifest and a fan QR code — from here.',
    place: 'top',
  },
  {
    selector: '#gallery',
    title: 'Get inspired',
    body: 'Browse tifos from supporters worldwide — like, comment, and remix any of them into your own starting point.',
    place: 'bottom',
  },
];

/** Run the tour. Resolves when finished or skipped. */
export function startTour(): Promise<void> {
  return new Promise((resolve) => {
    const steps = STEPS.filter((s) => document.querySelector(s.selector));
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
          <button class="tour-skip" id="tour-skip">Skip tour</button>
          <div class="tour-nav">
            <button class="tour-back" id="tour-back">Back</button>
            <button class="tour-next primary" id="tour-next">Next</button>
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
      (overlay.querySelector('#tour-step') as HTMLElement).textContent = `Step ${i + 1} of ${steps.length}`;
      (overlay.querySelector('#tour-title') as HTMLElement).textContent = step.title;
      (overlay.querySelector('#tour-body') as HTMLElement).textContent = step.body;
      (overlay.querySelector('#tour-back') as HTMLButtonElement).style.visibility = i === 0 ? 'hidden' : 'visible';
      (overlay.querySelector('#tour-next') as HTMLButtonElement).textContent = i === steps.length - 1 ? 'Got it' : 'Next';

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
