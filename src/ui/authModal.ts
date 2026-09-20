import { availableProviders, login, register, requestPasswordReset, startProviderSignIn } from '../net/api';
import { PASSWORD_MIN } from '../core/password';
import { deriveUsername } from '../core/handle';
import { enhancePasswordField } from './passwordField';
import { t, tv, getLang } from './i18n';

/**
 * Sign in / sign up modal. Replaces the window.prompt() auth with a proper
 * tabbed dialog: client-side validation matching the server's rules, inline
 * errors, and a single resolve when the user is authenticated. Styled with the
 * Floodlight tokens injected by theme.ts.
 *
 * Resolves with the signed-in username, or null if the user dismisses.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Bump when Terms/Privacy change materially; recorded with each signup acceptance. */
export const POLICY_VERSION = '2026-06-27';

/** Google's G, inline. No script and no image request to anyone else. */
const GOOGLE_MARK =
  '<svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">' +
  '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/>' +
  '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/>' +
  '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/>' +
  '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/>' +
  '</svg>';

/**
 * Is this page inside an app's own browser?
 *
 * Google answers `403 disallowed_useragent` to OAuth started from an embedded
 * webview, which is not a bug we can work around — it is the policy. A large
 * share of this site's arrivals come from TikTok and X links, and both open
 * pages inside their own browser, so the button has to say so rather than lead
 * someone to a Google error page they cannot read.
 *
 * Deliberately a short list of the ones that actually send us traffic. A UA
 * sniff that tries to be exhaustive ends up hiding the button from people whose
 * browser was fine.
 */
function inAppBrowser(): boolean {
  const ua = navigator.userAgent;
  return /\b(FBAN|FBAV|FB_IAB|Instagram|TikTok|musical_ly|Line\/|Snapchat|Twitter|MicroMessenger)\b/i.test(ua);
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

/**
 * The sign-in dialog.
 *
 * `claimOnReturn` matters only for a provider: that path leaves the page, so the
 * promise this returns never resolves and the caller's "now claim the draft"
 * line never runs. The intent is recorded before the redirect and picked up
 * again on the way back in. See `takeClaimIntent` in net/api.
 */
export function openAuthModal(claimOnReturn = false): Promise<string | null> {
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
        <div class="auth-providers" hidden>
          <button type="button" class="auth-provider" data-provider="google">
            ${GOOGLE_MARK}<span>${t('auth.google')}</span>
          </button>
          <p class="auth-inapp" hidden>${t('auth.inApp')}</p>
          <div class="auth-or"><span>${t('auth.or')}</span></div>
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
                   placeholder="${tv('auth.passwordPh', { min: PASSWORD_MIN })}" />
          </label>
          <label class="auth-field auth-confirm" hidden>
            <span>${t('pw.confirm')}</span>
            <input type="password" name="confirm" autocomplete="new-password" />
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
    const opener = document.activeElement as HTMLElement | null;
    document.body.appendChild(backdrop);

    let mode: 'signin' | 'signup' = 'signin';
    const modal = backdrop.querySelector('.auth-modal')!;
    const form = backdrop.querySelector('.auth-form') as HTMLFormElement;
    const errorEl = backdrop.querySelector('.auth-error') as HTMLElement;
    const submit = backdrop.querySelector('.auth-submit') as HTMLButtonElement;
    const tabs = Array.from(backdrop.querySelectorAll('.auth-tab')) as HTMLButtonElement[];
    const identityInput = form.identity as HTMLInputElement;
    const passwordInput = form.password as HTMLInputElement;
    const confirmInput = form.confirm as HTMLInputElement;
    const confirmRow = backdrop.querySelector('.auth-confirm') as HTMLElement;
    const idLabel = backdrop.querySelector('.auth-id-label') as HTMLElement;
    const termsRow = backdrop.querySelector('.auth-terms') as HTMLElement;
    const tabsRow = backdrop.querySelector('.auth-tabs') as HTMLElement;
    const note = backdrop.querySelector('.auth-note') as HTMLElement;
    const providersRow = backdrop.querySelector('.auth-providers') as HTMLElement;
    const inAppNote = backdrop.querySelector('.auth-inapp') as HTMLElement;
    const forgotLink = backdrop.querySelector('.auth-forgot-link') as HTMLButtonElement;
    const forgotForm = backdrop.querySelector('.auth-forgot') as HTMLFormElement;
    const femailInput = forgotForm.femail as HTMLInputElement;
    const forgotMsg = backdrop.querySelector('.auth-forgot-msg') as HTMLElement;
    const forgotSubmit = forgotForm.querySelector('.auth-submit') as HTMLButtonElement;
    const backBtn = backdrop.querySelector('.auth-back') as HTMLButtonElement;

    // The provider row appears only once the server has confirmed it has
    // credentials for something. A button that cannot work is worse than no
    // button, and that is also why an in-app browser gets the note instead.
    void availableProviders().then((list) => {
      if (!list.includes('google') || !document.contains(backdrop)) return;
      providersRow.hidden = false;
      if (inAppBrowser()) {
        inAppNote.hidden = false;
        (providersRow.querySelector('.auth-provider') as HTMLButtonElement).disabled = true;
      }
    });
    providersRow.querySelector('.auth-provider')!.addEventListener('click', () => {
      // Whichever tab they are on, this is the same door — and if they are here
      // from the save flow, the draft has to follow them through it.
      startProviderSignIn('google', { claim: claimOnReturn, policy: POLICY_VERSION });
    });

    // The strength bar, the reveal button and the suggester. Off to begin with:
    // the modal opens on the sign-in tab, where an account older than this
    // policy is entitled to its old password.
    const passwordField = enhancePasswordField({
      input: passwordInput,
      confirm: confirmInput,
      suggest: true,
      // Read at check time, not now — on the sign-up tab the email above is
      // still being typed when the password field is first touched.
      context: () => (mode === 'signup' ? { email: identityInput.value.trim() } : {}),
    });
    passwordField.setActive(false);

    const close = (result: string | null): void => {
      backdrop.remove();
      // Return focus to whatever opened the dialog. Without this a keyboard user
      // who opens it, changes their mind and presses Escape is dropped at the top
      // of the document and has to tab through the whole header to get back.
      if (opener && document.contains(opener)) opener.focus();
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
      confirmRow.hidden = next !== 'signup';
      if (next !== 'signup') confirmInput.value = '';
      passwordField.setActive(next === 'signup');
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
      // On sign-up this is the whole policy — length, blocklist, the email
      // above, and the confirm field. On sign-in it only insists that something
      // was typed, because the rules below apply to passwords being CHOSEN, and
      // an account created before them still has to be able to get in.
      const complaint = passwordField.validate();
      if (complaint) {
        showError(complaint.message);
        complaint.field.focus();
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
