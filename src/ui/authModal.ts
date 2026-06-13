import { login, register } from '../net/api';

/**
 * Sign in / sign up modal. Replaces the window.prompt() auth with a proper
 * tabbed dialog: client-side validation matching the server's rules, inline
 * errors, and a single resolve when the user is authenticated. Styled with the
 * Floodlight tokens injected by theme.ts.
 *
 * Resolves with the signed-in username, or null if the user dismisses.
 */

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

export function openAuthModal(): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'auth-backdrop';
    backdrop.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-label="Sign in">
        <button class="auth-close" aria-label="Close">&times;</button>
        <div class="auth-brand">TIFO<b>MAKER</b></div>
        <div class="auth-tabs">
          <button class="auth-tab active" data-mode="signin">Sign in</button>
          <button class="auth-tab" data-mode="signup">Create account</button>
        </div>
        <form class="auth-form" novalidate>
          <label class="auth-field">
            <span>Username</span>
            <input type="text" name="username" autocomplete="username" autocapitalize="off"
                   spellcheck="false" placeholder="3–24 letters, digits, _" />
          </label>
          <label class="auth-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="current-password"
                   placeholder="at least 8 characters" />
          </label>
          <div class="auth-error" role="alert" hidden></div>
          <button type="submit" class="auth-submit primary">Sign in</button>
        </form>
        <p class="auth-note">Designs are tied to your account. Your session lasts until you sign out or refresh.</p>
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
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === next));
      submit.textContent = next === 'signin' ? 'Sign in' : 'Create account';
      passwordInput.autocomplete = next === 'signin' ? 'current-password' : 'new-password';
      clearError();
    };
    tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode as 'signin' | 'signup')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError();
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!USERNAME_RE.test(username)) {
        showError('Username must be 3–24 characters: letters, digits, or underscore.');
        usernameInput.focus();
        return;
      }
      if (password.length < 8) {
        showError('Password must be at least 8 characters.');
        passwordInput.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = mode === 'signin' ? 'Signing in…' : 'Creating…';
      try {
        const name = mode === 'signin' ? await login(username, password) : await register(username, password);
        close(name);
      } catch (err) {
        const m = (err as Error).message;
        // Friendlier copy for the common cases.
        if (mode === 'signin' && /invalid/i.test(m)) {
          showError('Wrong username or password. New here? Create an account.');
        } else if (mode === 'signup' && /taken/i.test(m)) {
          showError('That username is taken — try another, or sign in.');
        } else {
          showError(m);
        }
        submit.disabled = false;
        submit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      }
    });

    // Focus the first field once mounted.
    setTimeout(() => usernameInput.focus(), 0);
    void modal;
  });
}
