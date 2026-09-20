/**
 * "You're in — now pick your name."
 *
 * Signing in with Google hands us an email and no handle. A handle is the
 * public half of an account here: it goes under every design in the community
 * feed and it is what a profile link points at. Inventing one from the email
 * and quietly stamping it on someone gives them a name like `gfan1789865580969`
 * that they never chose and will probably never notice until a stranger sees
 * it.
 *
 * So a provider account is held here until its owner picks one. Deliberately
 * not dismissible: no close button, Escape does nothing, clicking the backdrop
 * does nothing. The server agrees — `requireUser` answers 428 to everything
 * except the few routes needed to get through this dialog — so closing it in
 * devtools buys nothing.
 *
 * The one way out that is not "choose a name" is to sign out, which is offered,
 * because a dialog with no exit at all is a trap rather than a step.
 */
import { changeUsername, signOut, type Me } from '../net/api';
import { USERNAME_RE } from '../core/handle';
import { t, getLang } from './i18n';

/** Resolves with the chosen name once it is saved. Never resolves otherwise. */
export function openChooseUsernameModal(): Promise<string> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'auth-backdrop';
    backdrop.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="un-title" dir="${getLang() === 'ar' ? 'rtl' : 'ltr'}">
        <div class="auth-brand">TIFO<b>MAKER</b></div>
        <h2 class="un-title" id="un-title">${t('un.title')}</h2>
        <p class="un-note">${t('un.note')}</p>
        <form class="auth-form" novalidate>
          <label class="auth-field">
            <span>${t('un.label')}</span>
            <input type="text" name="handle" autocomplete="username" autocapitalize="off"
                   spellcheck="false" maxlength="24" placeholder="${t('un.placeholder')}" />
          </label>
          <div class="auth-error" role="alert" hidden></div>
          <button type="submit" class="auth-submit primary">${t('un.save')}</button>
        </form>
        <button type="button" class="auth-forgot-link un-signout">${t('un.signout')}</button>
      </div>`;
    document.body.appendChild(backdrop);

    const form = backdrop.querySelector('.auth-form') as HTMLFormElement;
    const input = form.handle as HTMLInputElement;
    const errorEl = backdrop.querySelector('.auth-error') as HTMLElement;
    const submit = backdrop.querySelector('.auth-submit') as HTMLButtonElement;

    // The field is deliberately left empty. Pre-filling it would hand back the
    // invented name this dialog exists to replace — and the first thing most
    // people do with a filled field is press the button, which is the same
    // auto-assignment wearing a costume. The placeholder shows the shape of a
    // handle; they type the name.

    const fail = (msg: string): void => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    };

    // Say what is wrong while they type, not after they press the button.
    const grade = (): boolean => {
      const value = input.value.trim();
      const ok = USERNAME_RE.test(value);
      submit.disabled = !ok;
      if (ok || !value) errorEl.hidden = true;
      return ok;
    };
    input.addEventListener('input', grade);
    grade();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!grade()) return fail(t('un.invalid'));
      submit.disabled = true;
      submit.textContent = t('un.saving');
      try {
        const saved = await changeUsername(value);
        backdrop.remove();
        resolve(saved);
      } catch (err) {
        fail(/taken|409/i.test((err as Error).message) ? t('un.taken') : (err as Error).message);
        submit.disabled = false;
        submit.textContent = t('un.save');
        input.focus();
        input.select();
      }
    });

    backdrop.querySelector('.un-signout')!.addEventListener('click', () => {
      signOut();
      location.reload();
    });

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

/**
 * Hold here if this account has not named itself yet.
 *
 * Call it wherever the app first learns who it is talking to. It is a no-op for
 * everyone else, which is almost everyone.
 */
export async function ensureUsernameChosen(me: Me | null): Promise<Me | null> {
  if (!me?.needsUsername) return me;
  const chosen = await openChooseUsernameModal();
  return { ...me, username: chosen, needsUsername: false };
}
