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
            <span>${t('auth.username')}</span>
            <input type="text" name="username" autocomplete="username" autocapitalize="off"
                   spellcheck="false" placeholder="${t('auth.usernamePh')}" />
          </label>
          <label class="auth-field auth-email" hidden>
            <span>${t('auth.email')}</span>
            <input type="email" name="email" autocomplete="email" autocapitalize="off"
                   spellcheck="false" placeholder="${t('auth.emailPh')}" />
          </label>
          <label class="auth-field">
            <span>${t('auth.password')}</span>
            <input type="password" name="password" autocomplete="current-password"
                   placeholder="${t('auth.passwordPh')}" />
          </label>
          <label class="auth-field auth-accept" hidden>
            <input type="checkbox" name="accept" />
            <span>${t('auth.accept')} <a href="/legal#terms" target="_blank" rel="noopener">${t('auth.termsLink')}</a> ${t('auth.and')} <a href="/legal#privacy" target="_blank" rel="noopener">${t('auth.privacyLink')}</a>.</span>
          </label>
          <div class="auth-error" role="alert" hidden></div>
          <button type="submit" class="auth-submit primary">${t('auth.signin')}</button>
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
    const usernameInput = form.username as HTMLInputElement;
    const passwordInput = form.password as HTMLInputElement;
    const emailInput = form.email as HTMLInputElement;
    const emailRow = backdrop.querySelector('.auth-email') as HTMLElement;
    const acceptInput = form.accept as HTMLInputElement;
    const acceptRow = backdrop.querySelector('.auth-accept') as HTMLElement;
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
      emailRow.hidden = next !== 'signup';
      acceptRow.hidden = next !== 'signup';
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
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      const email = emailInput.value.trim();
      if (!USERNAME_RE.test(username)) {
        showError(t('auth.errUsername'));
        usernameInput.focus();
        return;
      }
      if (password.length < 8) {
        showError(t('auth.errPassword'));
        passwordInput.focus();
        return;
      }
      if (mode === 'signup' && !EMAIL_RE.test(email)) {
        showError(t('auth.errEmail'));
        emailInput.focus();
        return;
      }
      if (mode === 'signup' && !acceptInput.checked) {
        showError(t('auth.errAccept'));
        acceptInput.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = mode === 'signin' ? t('auth.signingIn') : t('auth.creating');
      try {
        const name = mode === 'signin' ? await login(username, password) : await register(username, password, email, POLICY_VERSION);
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
    setTimeout(() => usernameInput.focus(), 0);
    void modal;
  });
}
