/**
 * Password-reset page (/reset?token=…). Standalone entry: reads the emailed
 * token, validates the new password client-side, and POSTs to /api/auth/reset.
 * On success the user's other sessions are invalidated server-side.
 */
import { resetPassword } from './net/api';
import { PASSWORD_MIN } from './core/password';
import { enhancePasswordField } from './ui/passwordField';
import { initLang, applyDom, t, tv } from './ui/i18n';

initLang();
applyDom(document);

const token = new URLSearchParams(location.search).get('token') ?? '';
// The token is a one-time password-reset secret. Keep it in memory only: out of
// the address bar, the history, and anything that copies the current URL.
if (token) history.replaceState(null, '', location.pathname);
const form = document.getElementById('reset-form') as HTMLFormElement;
const pw = document.getElementById('pw') as HTMLInputElement;
const pw2 = document.getElementById('pw2') as HTMLInputElement;
const err = document.getElementById('err') as HTMLElement;
const submit = document.getElementById('submit') as HTMLButtonElement;
const done = document.getElementById('done') as HTMLElement;

// The placeholder carries the minimum, so it is filled from the constant rather
// than written out in two languages that would then have to be kept in step.
pw.placeholder = tv('pw.ph', { min: PASSWORD_MIN });
const passwordField = enhancePasswordField({ input: pw, confirm: pw2, suggest: true });

function showErr(msg: string): void {
  err.textContent = msg;
  err.hidden = false;
}

if (!token) {
  showErr(t('rs.noToken'));
  submit.disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const complaint = passwordField.validate();
  if (complaint) {
    showErr(complaint.message);
    complaint.field.focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = t('rs.updating');
  try {
    await resetPassword(token, pw.value);
    form.hidden = true;
    done.hidden = false;
  } catch (e2) {
    showErr((e2 as Error).message || t('rs.badLink'));
    submit.disabled = false;
    submit.textContent = t('rs.submit');
  }
});
