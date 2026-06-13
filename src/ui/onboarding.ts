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

export interface QuickStart {
  paletteName: string;
  patternId: string;
}

// The starter looks offered — each maps to a real PATTERN_PRESET id.
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
    let chosenPalette = paletteNames[0];
    let chosenPattern = STARTER_PATTERNS[0].id;

    const backdrop = document.createElement('div');
    backdrop.className = 'ob-backdrop';
    backdrop.innerHTML = `
      <div class="ob-modal" role="dialog" aria-modal="true" aria-label="Welcome to Tifo Maker">
        <div class="ob-hero">
          <div class="ob-brand">TIFO<b>MAKER</b></div>
          <h2 class="ob-h2">Design a stadium tifo</h2>
          <p class="ob-lead">Paint a choreography across 60,000 seats, watch it light up the stands in 3D, then share it. Let’s start with a look — you can change everything later.</p>
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
        <div class="ob-section">
          <div class="ob-label">Pick a starting look</div>
          <div class="ob-patterns" id="ob-patterns">
            ${STARTER_PATTERNS.map(
              (p, i) => `<button class="ob-pattern ${i === 0 ? 'active' : ''}" data-pattern="${p.id}">${p.label}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="ob-actions">
          <button class="ob-start primary">Start designing</button>
          <button class="ob-skip">Start from blank</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const finish = (result: QuickStart | null): void => {
      markOnboarded();
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);

    const palettesEl = backdrop.querySelector('#ob-palettes')!;
    palettesEl.querySelectorAll('.ob-palette').forEach((btn) => {
      btn.addEventListener('click', () => {
        palettesEl.querySelectorAll('.ob-palette').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chosenPalette = (btn as HTMLElement).dataset.palette!;
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

    backdrop.querySelector('.ob-start')!.addEventListener('click', () =>
      finish({ paletteName: chosenPalette, patternId: chosenPattern }),
    );
    backdrop.querySelector('.ob-skip')!.addEventListener('click', () => finish(null));

    void patterns;
  });
}
