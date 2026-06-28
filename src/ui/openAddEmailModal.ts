/**
 * "Add your email" dialog for pre-launch accounts that have no email yet. The AI
 * Designer requires a verified email; this lets a signed-in user attach one and
 * triggers the verification email. Reuses the Floodlight auth-modal styles.
 *
 * Resolves true if an email was saved (and a verification link sent).
 */
import { setAccountEmail, resendVerification } from '../net/api';
import { t, getLang } from './i18n';
import { POLICY_VERSION } from './authModal';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function openAddEmailModal(): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'auth-backdrop';
    backdrop.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-label="${t('addemail.title')}" dir="${getLang() === 'ar' ? 'rtl' : 'ltr'}">
        <button class="auth-close" aria-label="${t('auth.close')}">&times;</button>
        <div class="auth-brand">TIFO<b>MAKER</b></div>
        <p class="auth-note" style="margin:0 0 12px;text-align:start;">${t('addemail.body')}</p>
        <form class="auth-form" novalidate>
          <label class="auth-field">
            <span>${t('auth.email')}</span>
            <input type="email" name="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="${t('auth.emailPh')}" />
          </label>
          <div class="auth-error" role="alert" hidden></div>
          <div class="auth-forgot-msg" role="status" hidden></div>
          <button type="submit" class="auth-submit primary">${t('addemail.submit')}</button>
        </form>
      </div>`;
    document.body.appendChild(backdrop);

    const form = backdrop.querySelector('.auth-form') as HTMLFormElement;
    const input = form.email as HTMLInputElement;
    const err = backdrop.querySelector('.auth-error') as HTMLElement;
    const okMsg = backdrop.querySelector('.auth-forgot-msg') as HTMLElement;
    const submit = backdrop.querySelector('.auth-submit') as HTMLButtonElement;
    let added = false;

    const close = (): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(added);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('.auth-close')!.addEventListener('click', close);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const email = input.value.trim();
      if (!EMAIL_RE.test(email)) {
        err.textContent = t('auth.errEmail');
        err.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = t('auth.sending');
      try {
        await setAccountEmail(email, POLICY_VERSION);
        await resendVerification().catch(() => {});
        added = true;
        form.hidden = true;
        okMsg.hidden = false;
        okMsg.textContent = t('addemail.sent');
        setTimeout(close, 2400);
      } catch (e2) {
        err.textContent = (e2 as Error).message || t('addemail.err');
        err.hidden = false;
        submit.disabled = false;
        submit.textContent = t('addemail.submit');
      }
    });

    setTimeout(() => input.focus(), 0);
  });
}
