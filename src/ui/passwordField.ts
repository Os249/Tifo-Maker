/**
 * The password field, everywhere a password is chosen.
 *
 * Three places ask someone to invent a password — the sign-up modal, the
 * change-password dialog and the /reset page — and before this they shared
 * nothing but a `length < 8` check copy-pasted three times. Raising the bar to
 * twelve characters without giving something back would just be a worse form,
 * so the bar and the help arrive together:
 *
 *   - a reveal button, because a twelve-character password typed blind on a
 *     phone is a typo waiting to become a support email (ASVS §6.2.6, and NIST's
 *     "SHOULD offer an option to display the password while it is entered");
 *   - a bar and one short line telling you the single thing that is wrong,
 *     live, instead of a wall of red rules that only appears after you submit;
 *   - a button that invents a good password for you, which is the only advice
 *     in this whole area that reliably works.
 *
 * It styles itself. The editor's modals get Floodlight's tokens from theme.ts,
 * but /reset is a standalone page with its own small palette and none of them —
 * so every colour here is `var(--token, fallback)`: it picks up the app's theme
 * inside the app, and looks right on the reset page without it.
 */
import { checkPassword, suggestPassphrase, PASSWORD_MAX, PASSWORD_MIN, type PasswordContext } from '../core/password';
import { t, tv } from './i18n';

export interface PasswordFieldOptions {
  /** The field where the new password is typed. */
  input: HTMLInputElement;
  /** A second field that has to match, if the form has one. */
  confirm?: HTMLInputElement;
  /** Offer to generate one. */
  suggest?: boolean;
  /**
   * The email and username this password must not be made of, read at the
   * moment of checking — on the sign-up form the email is still being typed
   * when the password field is first touched.
   */
  context?: () => PasswordContext;
}

/** What is wrong, and where the cursor should go to fix it. */
export interface PasswordComplaint {
  message: string;
  field: HTMLInputElement;
}

export interface PasswordFieldHandle {
  /** The complaint to show, or null when the password is good to send. */
  validate(): PasswordComplaint | null;
  /**
   * Turn the whole apparatus off.
   *
   * The sign-in tab of the auth modal reuses the same input, and an existing
   * account may well have an eight-character password from before this policy.
   * Grading it there would lock out the very people who already signed up.
   */
  setActive(on: boolean): void;
  /** Redraw after the value was changed in code. */
  refresh(): void;
}

const EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4"/><path d="M6.2 6.3A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.1-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

const STYLE_ID = 'pwf-style';

/**
 * Injected once, on first use. `style-src` allows `'unsafe-inline'` (the app
 * already injects its theme this way), so this is not a new hole in the CSP.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.pwf-box { position:relative; display:block; }
.pwf-box > input { width:100%; padding-inline-end:40px !important; }
.pwf-eye {
  position:absolute; inset-inline-end:2px; top:50%; transform:translateY(-50%);
  display:flex; align-items:center; justify-content:center;
  width:34px; height:34px; padding:0; margin:0; border:none; background:none; cursor:pointer;
  color:var(--text-3, #5b6473); border-radius:8px;
}
.pwf-eye:hover { color:var(--text-1, #0e1426); background:none; }
.pwf-eye:focus-visible { outline:2px solid var(--flare, #1c6fe0); outline-offset:1px; }
/* No margin of its own: it is a child of the form that owns it, and each of
   the four forms already has its own idea of vertical rhythm. */
.pwf { display:flex; flex-direction:column; gap:6px; }
.pwf-bars { display:flex; gap:4px; }
.pwf-bars i {
  flex:1; height:3px; border-radius:2px; background:var(--line-2, #e6e8ee);
  transition:background .18s ease;
}
.pwf[data-score="1"] .pwf-bars i:nth-child(-n+1) { background:#e0564f; }
.pwf[data-score="2"] .pwf-bars i:nth-child(-n+2) { background:#e0964f; }
.pwf[data-score="3"] .pwf-bars i:nth-child(-n+3) { background:#3f9ad6; }
.pwf[data-score="4"] .pwf-bars i { background:#3fb37a; }
.pwf-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.pwf-hint { margin:0; font-size:11.5px; line-height:1.5; color:var(--text-3, #5b6473); }
.pwf[data-bad="1"] .pwf-hint { color:#d0695f; }
.pwf-suggest {
  /* width and margin are spelled out because /reset styles bare <button> as a
     full-width pill, and this one is a link sitting at the end of a line. */
  flex:none; width:auto; padding:0; margin:0; border:none; background:none; cursor:pointer;
  font:inherit; font-size:11.5px; color:var(--flare, #1c6fe0); text-decoration:underline;
  white-space:nowrap;
}
.pwf-suggest:hover { background:none; }
.pwf-hidden { display:none; }
`;
  document.head.appendChild(el);
}

/** The one line to show under the bar for a password as it stands. */
function hintFor(value: string, ctx?: PasswordContext): { text: string; score: number; bad: boolean } {
  // Nothing typed yet: the tip that actually changes what people do, rather
  // than a recital of the rules they are about to break.
  if (!value) return { text: tv('pw.tip', { min: PASSWORD_MIN }), score: 0, bad: false };
  const verdict = checkPassword(value, ctx);
  if (verdict.ok) return { text: t(`pw.level${verdict.score}`), score: verdict.score, bad: false };
  // While they are still typing, "3 more to go" is encouragement; the full
  // sentence about the minimum belongs to the moment they press the button.
  if (verdict.problem === 'short') {
    return { text: tv('pw.hint.short', { n: verdict.missing }), score: 0, bad: false };
  }
  return { text: messageFor(verdict.problem), score: 0, bad: true };
}

/** The sentence for a refusal, in the reader's language. */
function messageFor(problem: string | null): string {
  return tv(`pw.err.${problem ?? 'common'}`, { min: PASSWORD_MIN, max: PASSWORD_MAX });
}

export function enhancePasswordField(opts: PasswordFieldOptions): PasswordFieldHandle {
  ensureStyles();
  const { input, confirm } = opts;
  let active = true;

  // Wrap the input so the reveal button can sit on top of it without the
  // caller's stylesheet having to know anything about this.
  const box = document.createElement('div');
  box.className = 'pwf-box';
  input.parentNode?.insertBefore(box, input);
  box.appendChild(input);

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'pwf-eye';
  eye.innerHTML = EYE;
  eye.setAttribute('aria-label', t('pw.show'));
  eye.setAttribute('aria-pressed', 'false');
  box.appendChild(eye);

  const meter = document.createElement('div');
  meter.className = 'pwf';
  meter.innerHTML = `
    <div class="pwf-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="pwf-row">
      <p class="pwf-hint" role="status" aria-live="polite"></p>
      ${opts.suggest ? `<button type="button" class="pwf-suggest">${t('pw.suggest')}</button>` : ''}
    </div>`;
  // Under the whole field — label included — not squeezed between the label
  // text and the input.
  const host = input.closest('label') ?? box;
  host.parentNode?.insertBefore(meter, host.nextSibling);

  const hint = meter.querySelector('.pwf-hint') as HTMLElement;

  const draw = (): void => {
    const state = hintFor(input.value, opts.context?.());
    meter.dataset.score = String(state.score);
    meter.dataset.bad = state.bad ? '1' : '0';
    // Only when it changes: this is a live region, and rewriting it on every
    // keystroke would have a screen reader reading the same sentence twelve
    // times while someone types a passphrase.
    if (hint.textContent !== state.text) hint.textContent = state.text;
  };

  const reveal = (show: boolean): void => {
    input.type = show ? 'text' : 'password';
    if (confirm) confirm.type = input.type;
    eye.innerHTML = show ? EYE_OFF : EYE;
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', t(show ? 'pw.hide' : 'pw.show'));
  };

  eye.addEventListener('click', () => {
    reveal(input.type === 'password');
    input.focus();
  });

  meter.querySelector('.pwf-suggest')?.addEventListener('click', () => {
    const made = suggestPassphrase();
    input.value = made;
    if (confirm) confirm.value = made;
    // Shown, not hidden behind dots: a password you cannot read is a password
    // you cannot write down or check against your manager, and this one was
    // never a secret you chose in the first place.
    reveal(true);
    draw();
    input.focus();
    input.setSelectionRange(made.length, made.length);
  });

  input.addEventListener('input', draw);
  confirm?.addEventListener('input', draw);
  draw();

  return {
    validate(): PasswordComplaint | null {
      // Inactive means the sign-in tab: an account made before this policy is
      // allowed to have a shorter password, and refusing it here would lock out
      // the people who signed up first.
      if (!input.value) return { message: t('pw.err.blank'), field: input };
      if (!active) return null;
      const verdict = checkPassword(input.value, opts.context?.());
      if (!verdict.ok) return { message: messageFor(verdict.problem), field: input };
      if (confirm && confirm.value !== input.value) {
        return { message: t('pw.err.mismatch'), field: confirm };
      }
      return null;
    },
    setActive(on: boolean): void {
      active = on;
      meter.classList.toggle('pwf-hidden', !on);
      if (!on) reveal(false);
      else draw();
    },
    refresh: draw,
  };
}
