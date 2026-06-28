/**
 * Password-reset page (/reset?token=…). Standalone entry: reads the emailed
 * token, validates the new password client-side, and POSTs to /api/auth/reset.
 * On success the user's other sessions are invalidated server-side.
 */
import { resetPassword } from './net/api';

const token = new URLSearchParams(location.search).get('token') ?? '';
const form = document.getElementById('reset-form') as HTMLFormElement;
const pw = document.getElementById('pw') as HTMLInputElement;
const pw2 = document.getElementById('pw2') as HTMLInputElement;
const err = document.getElementById('err') as HTMLElement;
const submit = document.getElementById('submit') as HTMLButtonElement;
const done = document.getElementById('done') as HTMLElement;

function showErr(msg: string): void {
  err.textContent = msg;
  err.hidden = false;
}

if (!token) {
  showErr('This reset link is missing its token. Request a new one from the sign-in screen.');
  submit.disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  if (pw.value.length < 8) {
    showErr('Password must be at least 8 characters.');
    return;
  }
  if (pw.value !== pw2.value) {
    showErr('Passwords do not match.');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Updating…';
  try {
    await resetPassword(token, pw.value);
    form.hidden = true;
    done.hidden = false;
  } catch (e2) {
    showErr((e2 as Error).message || 'That reset link is invalid or has expired.');
    submit.disabled = false;
    submit.textContent = 'Update password';
  }
});
