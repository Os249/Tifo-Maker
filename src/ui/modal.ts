/**
 * Themed modal dialogs that replace native window.confirm()/alert(). These match
 * the app's visual language (dark surfaces, pill buttons, the brand accent) and
 * return Promises so they drop into existing `if (await confirmModal(...))` flows.
 *
 * Two entry points:
 *   confirmModal({...})  → Promise<boolean>           — yes/no (with custom labels)
 *   choiceModal({...})   → Promise<string | null>     — N labelled choices, or null
 *
 * Both close on Escape and on backdrop click (treated as cancel/null).
 */

interface ConfirmOptions {
  title: string;
  message?: string;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

interface Choice {
  /** Returned value when this option is picked. */
  value: string;
  label: string;
  /** Optional one-line explanation under the label. */
  hint?: string;
  /** Primary (brand) or destructive styling. */
  variant?: 'primary' | 'danger' | 'default';
}

interface ChoiceOptions {
  title: string;
  message?: string;
  choices: Choice[];
  /** Label for the dismiss button (default "Cancel"); null → no cancel button. */
  cancelLabel?: string | null;
}

let liveBackdrop: HTMLElement | null = null;

function mount(html: string): { backdrop: HTMLElement; close: (then?: () => void) => void } {
  // Only one dialog at a time.
  liveBackdrop?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'dlg-backdrop';
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);
  liveBackdrop = backdrop;

  const close = (then?: () => void): void => {
    backdrop.remove();
    if (liveBackdrop === backdrop) liveBackdrop = null;
    document.removeEventListener('keydown', onKey);
    then?.();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') backdrop.dispatchEvent(new CustomEvent('dlg-cancel'));
  }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) backdrop.dispatchEvent(new CustomEvent('dlg-cancel'));
  });
  return { backdrop, close };
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** Themed yes/no confirmation. Resolves true if confirmed, false otherwise. */
export function confirmModal(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { backdrop, close } = mount(`
      <div class="dlg" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${esc(opts.title)}</h3>
        ${opts.message ? `<p class="dlg-msg">${esc(opts.message)}</p>` : ''}
        <div class="dlg-actions">
          <button class="dlg-btn dlg-cancel">${esc(opts.cancelLabel ?? 'Cancel')}</button>
          <button class="dlg-btn ${opts.danger ? 'danger' : 'primary'} dlg-confirm">${esc(opts.confirmLabel ?? 'Confirm')}</button>
        </div>
      </div>`);
    const done = (v: boolean): void => close(() => resolve(v));
    backdrop.querySelector('.dlg-confirm')!.addEventListener('click', () => done(true));
    backdrop.querySelector('.dlg-cancel')!.addEventListener('click', () => done(false));
    backdrop.addEventListener('dlg-cancel', () => done(false));
    (backdrop.querySelector('.dlg-confirm') as HTMLButtonElement).focus();
  });
}

/** Themed text-input prompt. Resolves the entered string, or null if dismissed. */
export function promptModal(opts: {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** Max characters (default 200). */
  maxLength?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const field = opts.multiline
      ? `<textarea class="dlg-input" rows="3" maxlength="${opts.maxLength ?? 200}" placeholder="${esc(opts.placeholder ?? '')}">${esc(opts.defaultValue ?? '')}</textarea>`
      : `<input type="text" class="dlg-input" maxlength="${opts.maxLength ?? 200}" placeholder="${esc(opts.placeholder ?? '')}" value="${esc(opts.defaultValue ?? '')}" />`;
    const { backdrop, close } = mount(`
      <div class="dlg" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${esc(opts.title)}</h3>
        ${opts.message ? `<p class="dlg-msg">${esc(opts.message)}</p>` : ''}
        <div class="dlg-field">${field}</div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-cancel">${esc(opts.cancelLabel ?? 'Cancel')}</button>
          <button class="dlg-btn primary dlg-confirm">${esc(opts.confirmLabel ?? 'OK')}</button>
        </div>
      </div>`);
    const input = backdrop.querySelector('.dlg-input') as HTMLInputElement | HTMLTextAreaElement;
    const submit = (): void => {
      const v = input.value.trim();
      close(() => resolve(v.length ? v : null));
    };
    backdrop.querySelector('.dlg-confirm')!.addEventListener('click', submit);
    backdrop.querySelector('.dlg-cancel')!.addEventListener('click', () => close(() => resolve(null)));
    backdrop.addEventListener('dlg-cancel', () => close(() => resolve(null)));
    if (!opts.multiline) {
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') submit();
      });
    }
    input.focus();
    if (input instanceof HTMLInputElement) input.select();
  });
}

/** Themed multi-choice dialog. Resolves the picked value, or null if dismissed. */
export function choiceModal(opts: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const buttons = opts.choices
      .map(
        (c) => `
        <button class="dlg-choice ${c.variant ?? 'default'}" data-value="${esc(c.value)}">
          <span class="dlg-choice-label">${esc(c.label)}</span>
          ${c.hint ? `<span class="dlg-choice-hint">${esc(c.hint)}</span>` : ''}
        </button>`,
      )
      .join('');
    const cancel = opts.cancelLabel === null ? '' : `<button class="dlg-btn dlg-cancel">${esc(opts.cancelLabel ?? 'Cancel')}</button>`;
    const { backdrop, close } = mount(`
      <div class="dlg" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${esc(opts.title)}</h3>
        ${opts.message ? `<p class="dlg-msg">${esc(opts.message)}</p>` : ''}
        <div class="dlg-choices">${buttons}</div>
        ${cancel ? `<div class="dlg-actions">${cancel}</div>` : ''}
      </div>`);
    const done = (v: string | null): void => close(() => resolve(v));
    backdrop.querySelectorAll('.dlg-choice').forEach((b) => {
      (b as HTMLElement).addEventListener('click', () => done((b as HTMLElement).dataset.value ?? null));
    });
    backdrop.querySelector('.dlg-cancel')?.addEventListener('click', () => done(null));
    backdrop.addEventListener('dlg-cancel', () => done(null));
  });
}
