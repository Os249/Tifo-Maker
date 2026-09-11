import type { PatternPreset } from '../core/patterns';
import { PALETTE_PRESETS as PALETTES } from '../core/template';

/**
 * First-run onboarding. Shown once (gated by a localStorage flag) on a normal
 * boot — never when arriving via a share link, since those visitors already
 * have context. Instead of passive coach marks, this is an active quick-start:
 * pick a color scheme and a starting look, and it applies immediately, so the
 * first thing a new user sees is *their* tifo taking shape. They can also skip
 * straight to the blank-ish default.
 *
 * Resolves with a choice the caller applies to the store, or null if skipped.
 */

const SEEN_KEY = 'tifo_onboarded_v1';

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false; // private mode / storage blocked → just show it
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
}

export type StarterKind = 'blank' | 'patterns' | 'crest' | 'text';

export interface QuickStart {
  kind: StarterKind;
  paletteName: string;
  patternId: string | null;
  projectName: string;
  /** True when the user asked for the guided tour here, rather than it launching itself. */
  wantsTour: boolean;
}

// Intent-first starter templates — framed as outcomes, not features. Each maps
// to a concrete editor setup the caller applies. "patterns" carries a default
// pattern id the user lands on (changeable later in the Stadium panel).
const STARTERS: { kind: StarterKind; icon: string; title: string; blurb: string; pattern: string | null }[] = [
  { kind: 'blank', icon: '▢', title: 'Start blank', blurb: 'An empty bowl. Paint freely from scratch.', pattern: null },
  { kind: 'patterns', icon: '▤', title: 'Stripes & patterns', blurb: 'Begin with hoops, halves, or a sash.', pattern: 'hoops' },
  { kind: 'crest', icon: '◆', title: 'Club crest setup', blurb: 'A centered canvas, ready for your logo.', pattern: null },
  { kind: 'text', icon: 'A', title: 'Typography / text', blurb: 'Start with a banner of big text.', pattern: null },
];

// Default pattern offered inside the "Stripes & patterns" starter.
const STARTER_PATTERNS: { id: string; label: string }[] = [
  { id: 'hoops', label: 'Hoops' },
  { id: 'split', label: 'Split stands' },
  { id: 'sash', label: 'Diagonal sash' },
  { id: 'gradient', label: 'Gradient' },
];

/** Mini SVG swatch row previewing a palette's first three card colors. */
function paletteSwatchRow(colors: string[]): string {
  return colors
    .slice(1, 4)
    .map((c) => `<span class="ob-swatch" style="background:${c}"></span>`)
    .join('');
}

export function openOnboarding(patterns: PatternPreset[]): Promise<QuickStart | null> {
  return new Promise((resolve) => {
    const paletteNames = Object.keys(PALETTES);
    let chosenKind: StarterKind = 'blank';
    let chosenPalette = paletteNames[0];
    let chosenPattern: string | null = null;

    const backdrop = document.createElement('div');
    backdrop.className = 'ob-backdrop';
    backdrop.innerHTML = `
      <div class="ob-modal" role="dialog" aria-modal="true" aria-label="Welcome to Tifo Maker">
        <div class="ob-hero">
          <div class="ob-brand">TIFO<b>MAKER</b></div>
          <h2 class="ob-h2">Start your tifo</h2>
          <p class="ob-lead">A blank 60,000-seat bowl is a lot. Name your project and pick a starting point, you can change everything later.</p>
        </div>
        <div class="ob-section">
          <label class="ob-label" for="ob-name">Project name</label>
          <input type="text" id="ob-name" class="ob-name-input" maxlength="80" placeholder="e.g. Derby Day Wall" value="My first tifo" />
        </div>
        <div class="ob-section">
          <div class="ob-label">Choose a starting point</div>
          <div class="ob-starters" id="ob-starters">
            ${STARTERS.map(
              (s, i) => `
              <button class="ob-starter ${i === 0 ? 'active' : ''}" data-kind="${s.kind}">
                <span class="ob-starter-icon">${s.icon}</span>
                <span class="ob-starter-title">${s.title}</span>
                <span class="ob-starter-blurb">${s.blurb}</span>
              </button>`,
            ).join('')}
          </div>
        </div>
        <div class="ob-section" id="ob-pattern-section" hidden>
          <div class="ob-label">Which pattern?</div>
          <div class="ob-patterns" id="ob-patterns">
            ${STARTER_PATTERNS.map(
              (p, i) => `<button class="ob-pattern ${i === 0 ? 'active' : ''}" data-pattern="${p.id}">${p.label}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="ob-section">
          <div class="ob-label">Pick your colors</div>
          <div class="ob-palettes" id="ob-palettes">
            ${paletteNames
              .map(
                (name, i) => `
              <button class="ob-palette ${i === 0 ? 'active' : ''}" data-palette="${name}">
                <span class="ob-swatches">${paletteSwatchRow(PALETTES[name])}</span>
                <span class="ob-palette-name">${name}</span>
              </button>`,
              )
              .join('')}
          </div>
        </div>
        <div class="ob-actions">
          <button class="ob-start primary">Start designing</button>
          <!-- The tour used to launch itself on top of everything else. Offered
               here it is a choice made by someone who wants it, at the one
               moment they are already deciding how to begin. -->
          <button class="ob-tour">Start with a tour</button>
          <button class="ob-skip">Skip</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    /*
     * Make the app behind the dialog inert, and put focus inside it.
     *
     * Without both, a keyboard user arriving for the first time tabbed straight
     * past the dialog into the project title, the view switcher and Save - all
     * of them underneath a full-screen backdrop, none of them visible or
     * clickable - while the fifteen controls that actually start their tifo
     * were unreachable. Every one of those focused controls was entirely
     * covered by author content, which is what WCAG 2.4.11 forbids.
     *
     * `inert` also removes the background from the screen reader's virtual
     * cursor, which a focus trap alone would not do.
     */
    const shell = document.getElementById('app') ?? document.body.firstElementChild;
    const inertTargets = Array.from(document.body.children).filter(
      (el) => el !== backdrop && el instanceof HTMLElement,
    ) as HTMLElement[];
    for (const el of inertTargets) el.inert = true;
    void shell;

    // The name field is the first thing the copy asks for, so start there.
    const firstField = backdrop.querySelector('#ob-name') as HTMLElement | null;
    const dialog = backdrop.querySelector('.ob-modal') as HTMLElement | null;
    requestAnimationFrame(() => (firstField ?? dialog)?.focus());
    if (dialog && !dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;

    // Whatever had focus when the editor booted gets it back on close.
    const opener = document.activeElement as HTMLElement | null;

    const finish = (result: QuickStart | null): void => {
      markOnboarded();
      for (const el of inertTargets) el.inert = false;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', trapTab, true);
      if (opener && document.contains(opener)) opener.focus();
      resolve(result);
    };

    /**
     * Keep Tab inside the dialog, wrapping at both ends, per the ARIA dialog
     * pattern. `inert` stops the background being reachable, but the browser
     * would still walk focus out to its own chrome and back in at the top.
     */
    const trapTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        backdrop.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapTab, true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);

    const patternSection = backdrop.querySelector('#ob-pattern-section') as HTMLElement;

    // Starter cards drive the intent; the pattern picker only appears for "patterns".
    const startersEl = backdrop.querySelector('#ob-starters')!;
    startersEl.querySelectorAll('.ob-starter').forEach((btn) => {
      btn.addEventListener('click', () => {
        startersEl.querySelectorAll('.ob-starter').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chosenKind = (btn as HTMLElement).dataset.kind as StarterKind;
        if (chosenKind === 'patterns') {
          patternSection.hidden = false;
          chosenPattern = chosenPattern ?? STARTER_PATTERNS[0].id;
        } else {
          patternSection.hidden = true;
          chosenPattern = null;
        }
      });
    });

    const patternsEl = backdrop.querySelector('#ob-patterns')!;
    patternsEl.querySelectorAll('.ob-pattern').forEach((btn) => {
      btn.addEventListener('click', () => {
        patternsEl.querySelectorAll('.ob-pattern').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chosenPattern = (btn as HTMLElement).dataset.pattern!;
      });
    });

    const palettesEl = backdrop.querySelector('#ob-palettes')!;
    palettesEl.querySelectorAll('.ob-palette').forEach((btn) => {
      btn.addEventListener('click', () => {
        palettesEl.querySelectorAll('.ob-palette').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chosenPalette = (btn as HTMLElement).dataset.palette!;
      });
    });

    const start = (wantsTour: boolean): void => {
      const nameInput = backdrop.querySelector('#ob-name') as HTMLInputElement | null;
      const projectName = (nameInput?.value.trim() || 'My first tifo').slice(0, 80);
      finish({ kind: chosenKind, paletteName: chosenPalette, patternId: chosenPattern, projectName, wantsTour });
    };
    backdrop.querySelector('.ob-start')!.addEventListener('click', () => start(false));
    backdrop.querySelector('.ob-tour')!.addEventListener('click', () => start(true));
    backdrop.querySelector('.ob-skip')!.addEventListener('click', () => finish(null));

    void patterns;
  });
}
