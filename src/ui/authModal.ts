import { login, register, requestPasswordReset } from '../net/api';
import { t, getLang } from './i18n';

/**
 * Sign in / sign up modal. Replaces the window.prompt() auth with a proper
 * tabbed dialog: client-side validation matching the server's rules, inline
 * errors, and a single resolve when the user is authenticated. Styled with the
 * Floodlight tokens injected by theme.ts.
 *
 * Resolves with the signed-in username, or null if the user dismisses.
 */

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Bump when Terms/Privacy change materially; recorded with each signup acceptance. */
export const POLICY_VERSION = '2026-06-27';

/** A username derived from the email local part, sanitised to the server's rules. */
function deriveUsername(email: string, attempt: number): string {
  const base = (email.split('@')[0] ?? '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 16)
    .replace(/^_+/, '');
  const stem = base.length >= 3 ? base : `${base}fan`;
  const name = attempt === 0 ? stem : `${stem}${Math.floor(1000 + Math.random() * 9000)}`;
  return USERNAME_RE.test(name) ? name : `tifo${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Register, retrying with a different handle when the derived one is taken. */
async function registerWithDerivedName(email: string, password: string): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await register(deriveUsername(email, attempt), password, email, POLICY_VERSION);
    } catch (err) {
      lastErr = err;
      const m = (err as Error).message;
      // Only a username collision is worth retrying. A taken EMAIL means this
      // person already has an account and needs to be told, not looped.
      if (/email/i.test(m)) throw err;
      if (!/taken|exists|409/i.test(m)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not create an account');
}

export function openAuthModal(): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'auth-backdrop';
    backdrop.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-label="${t('auth.signin')}" dir="${getLang() === 'ar' ? 'rtl' : 'ltr'}">
        <button class="auth-close" aria-label="${t('auth.close')}">&times;</button>
        <div class="auth-brand">TIFO<b>MAKER</b></div>
        <div class="auth-tabs">
          <button class="auth-tab active" data-mode="signin">${t('auth.signin')}</button>
          <button class="auth-tab" data-mode="signup">${t('auth.signup')}</button>
        </div>
        <form class="auth-form" novalidate>
          <label class="auth-field">
            <span class="auth-id-label">${t('auth.identity')}</span>
            <input type="text" name="identity" autocomplete="username" autocapitalize="off"
                   spellcheck="false" placeholder="${t('auth.identityPh')}" />
          </label>
          <label class="auth-field">
            <span>${t('auth.password')}</span>
            <input type="password" name="password" autocomplete="current-password"
                   placeholder="${t('auth.passwordPh')}" />
          </label>
          <div class="auth-error" role="alert" hidden></div>
          <button type="submit" class="auth-submit primary">${t('auth.signin')}</button>
          <p class="auth-terms" hidden>${t('auth.termsInline')}
            <a href="/legal#terms" target="_blank" rel="noopener">${t('auth.termsLink')}</a>
            ${t('auth.and')}
            <a href="/legal#privacy" target="_blank" rel="noopener">${t('auth.privacyLink')}</a>.</p>
        </form>
        <button type="button" class="auth-forgot-link">${t('auth.forgot')}</button>
        <form class="auth-forgot" hidden novalidate>
          <label class="auth-field">
            <span>${t('auth.email')}</span>
            <input type="email" name="femail" autocomplete="email" autocapitalize="off"
                   spellcheck="false" placeholder="${t('auth.emailPh')}" />
          </label>
          <div class="auth-forgot-msg" role="status" hidden></div>
          <button type="submit" class="auth-submit primary">${t('auth.sendReset')}</button>
          <button type="button" class="auth-back">${t('auth.backToSignin')}</button>
        </form>
        <p class="auth-note">${t('auth.note')}</p>
      </div>
    `;
    document.body.appendChild(backdrop);

    let mode: 'signin' | 'signup' = 'signin';
    const modal = backdrop.querySelector('.auth-modal')!;
    const form = backdrop.querySelector('.auth-form') as HTMLFormElement;
    const errorEl = backdrop.querySelector('.auth-error') as HTMLElement;
    const submit = backdrop.querySelector('.auth-submit') as HTMLButtonElement;
    const tabs = Array.from(backdrop.querySelectorAll('.auth-tab')) as HTMLButtonElement[];
    const identityInput = form.identity as HTMLInputElement;
    const passwordInput = form.password as HTMLInputElement;
    const idLabel = backdrop.querySelector('.auth-id-label') as HTMLElement;
    const termsRow = backdrop.querySelector('.auth-terms') as HTMLElement;
    const tabsRow = backdrop.querySelector('.auth-tabs') as HTMLElement;
    const note = backdrop.querySelector('.auth-note') as HTMLElement;
    const forgotLink = backdrop.querySelector('.auth-forgot-link') as HTMLButtonElement;
    const forgotForm = backdrop.querySelector('.auth-forgot') as HTMLFormElement;
    const femailInput = forgotForm.femail as HTMLInputElement;
    const forgotMsg = backdrop.querySelector('.auth-forgot-msg') as HTMLElement;
    const forgotSubmit = forgotForm.querySelector('.auth-submit') as HTMLButtonElement;
    const backBtn = backdrop.querySelector('.auth-back') as HTMLButtonElement;

    const close = (result: string | null): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.querySelector('.auth-close')!.addEventListener('click', () => close(null));

    const showError = (msg: string): void => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    };
    const clearError = (): void => {
      errorEl.hidden = true;
    };

    const setMode = (next: 'signin' | 'signup'): void => {
      mode = next;
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === next));
      submit.textContent = next === 'signin' ? t('auth.signin') : t('auth.signup');
      passwordInput.autocomplete = next === 'signin' ? 'current-password' : 'new-password';
      // Signing up asks only for an email. Signing in accepts either, because
      // accounts created here never had to choose a username.
      idLabel.textContent = next === 'signin' ? t('auth.identity') : t('auth.email');
      identityInput.placeholder = next === 'signin' ? t('auth.identityPh') : t('auth.emailPh');
      identityInput.type = next === 'signup' ? 'email' : 'text';
      identityInput.autocomplete = next === 'signup' ? 'email' : 'username';
      termsRow.hidden = next !== 'signup';
      forgotLink.hidden = next !== 'signin';
      clearError();
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode as 'signin' | 'signup')));

    // Forgot-password sub-view (sign-in only).
    const showForgot = (on: boolean): void => {
      forgotForm.hidden = !on;
      form.hidden = on;
      tabsRow.hidden = on;
      note.hidden = on;
      forgotLink.hidden = on || mode !== 'signin';
      if (on) setTimeout(() => femailInput.focus(), 0);
    };
    forgotLink.addEventListener('click', () => {
      clearError();
      forgotMsg.hidden = true;
      femailInput.disabled = false;
      femailInput.value = '';
      forgotSubmit.hidden = false;
      forgotSubmit.disabled = false;
      forgotSubmit.textContent = t('auth.sendReset');
      showForgot(true);
    });
    backBtn.addEventListener('click', () => showForgot(false));
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = femailInput.value.trim();
      if (!EMAIL_RE.test(email)) {
        forgotMsg.hidden = false;
        forgotMsg.textContent = t('auth.errEmail');
        return;
      }
      forgotSubmit.disabled = true;
      forgotSubmit.textContent = t('auth.sending');
      try {
        await requestPasswordReset(email);
      } catch {
        /* never reveal whether the email exists */
      }
      forgotMsg.hidden = false;
      forgotMsg.textContent = t('auth.forgotSent');
      femailInput.disabled = true;
      forgotSubmit.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError();
      const identity = identityInput.value.trim();
      const password = passwordInput.value;
      if (mode === 'signup' && !EMAIL_RE.test(identity)) {
        showError(t('auth.errEmail'));
        identityInput.focus();
        return;
      }
      if (mode === 'signin' && identity.length < 3) {
        showError(t('auth.errIdentity'));
        identityInput.focus();
        return;
      }
      if (password.length < 8) {
        showError(t('auth.errPassword'));
        passwordInput.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = mode === 'signin' ? t('auth.signingIn') : t('auth.creating');
      try {
        let name: string;
        if (mode === 'signin') {
          name = await login(identity, password);
        } else {
          // The API still needs a username; nobody should have to invent one to
          // keep a drawing. Derive it, and step aside if that handle is taken.
          name = await registerWithDerivedName(identity, password);
        }
        close(name);
      } catch (err) {
        const m = (err as Error).message;
        // Friendlier copy for the common cases.
        if (mode === 'signin' && /invalid/i.test(m)) {
          showError(t('auth.errInvalid'));
        } else if (mode === 'signup' && /taken/i.test(m)) {
          showError(t('auth.errTaken'));
        } else {
          showError(m);
        }
        submit.disabled = false;
        submit.textContent = mode === 'signin' ? t('auth.signin') : t('auth.signup');
      }
    });

    // Focus the first field once mounted.
    setTimeout(() => identityInput.focus(), 0);
    void modal;
  });
}
