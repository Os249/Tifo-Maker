/**
 * Change-password dialog for signed-in users. Reuses the Floodlight auth-modal
 * styles. Requires the current password; on success the session stays valid
 * (only password resets force re-login).
 */
import { changePassword } from '../net/api';
import { t, getLang } from './i18n';

export function openChangePasswordModal(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'auth-backdrop';
  backdrop.innerHTML = `
    <div class="auth-modal" role="dialog" aria-modal="true" aria-label="${t('ed.changePassword')}" dir="${getLang() === 'ar' ? 'rtl' : 'ltr'}">
      <button class="auth-close" aria-label="${t('auth.close')}">&times;</button>
      <div class="auth-brand">TIFO<b>MAKER</b></div>
      <form class="auth-form" novalidate>
        <label class="auth-field">
          <span>${t('cp.current')}</span>
          <input type="password" name="current" autocomplete="current-password" />
        </label>
        <label class="auth-field">
          <span>${t('cp.new')}</span>
          <input type="password" name="next" autocomplete="new-password" placeholder="${t('auth.passwordPh')}" />
        </label>
        <div class="auth-error" role="alert" hidden></div>
        <div class="auth-forgot-msg" role="status" hidden></div>
        <button type="submit" class="auth-submit primary">${t('cp.submit')}</button>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const form = backdrop.querySelector('.auth-form') as HTMLFormElement;
  const cur = form.current as HTMLInputElement;
  const next = form.next as HTMLInputElement;
  const err = backdrop.querySelector('.auth-error') as HTMLElement;
  const okMsg = backdrop.querySelector('.auth-forgot-msg') as HTMLElement;
  const submit = backdrop.querySelector('.auth-submit') as HTMLButtonElement;

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
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
    if (next.value.length < 8) {
      err.textContent = t('auth.errPassword');
      err.hidden = false;
      next.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = t('auth.sending');
    try {
      await changePassword(cur.value, next.value);
      form.hidden = true;
      okMsg.hidden = false;
      okMsg.textContent = t('cp.done');
      setTimeout(close, 1600);
    } catch (e2) {
      err.textContent = (e2 as Error).message || t('cp.err');
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = t('cp.submit');
    }
  });

  setTimeout(() => cur.focus(), 0);
}
