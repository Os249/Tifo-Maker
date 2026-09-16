/**
 * Account settings.
 *
 * A real page rather than the three modals this replaces, because every fact it
 * shows has state that a modal cannot carry: is this address verified, is a code
 * still valid, how many guesses are left, what is my name right now. The old
 * flow told you none of it — you added an email, a dialog closed itself after
 * 2.4 seconds, and nothing ever mentioned the address again.
 *
 * Each section saves on its own and reports its own result. One page-level Save
 * would make a single failure look like five.
 */
import {
  fetchMe,
  isSignedIn,
  setAccountEmail,
  resendVerification,
  verifyEmailCode,
  changeUsername,
  changePassword,
  exportMyData,
  deleteAccount,
  signOut,
} from './net/api';
import { applyDom, getLang, initLang, t, tv } from './ui/i18n';
import { POLICY_VERSION } from './ui/authModal';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

type Tone = 'ok' | 'bad' | 'info';
const say = (el: HTMLElement | null, text: string, tone: Tone = 'info'): void => {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
};

let me: { id: string; username: string; email: string | null; emailVerified: boolean } | null = null;

/** Wire a Save button to stay disabled until its field actually differs. */
function dirtyGate(input: HTMLInputElement | null, button: HTMLButtonElement | null, current: () => string): void {
  if (!input || !button) return;
  const sync = (): void => {
    const v = input.value.trim();
    button.disabled = v.length === 0 || v === current();
  };
  input.addEventListener('input', sync);
  sync();
}

/** Paint the email section from `me`: address, badge, and whether to ask for a code. */
function renderEmail(): void {
  const valueEl = $('ac-email-current');
  const badge = $('ac-email-badge');
  const verify = $('ac-verify');
  const note = $('ac-verify-note');
  if (valueEl) valueEl.textContent = me?.email || t('ac.email.none');
  if (badge) {
    const state = !me?.email ? 'none' : me.emailVerified ? 'ok' : 'pending';
    badge.dataset.state = state;
    badge.textContent = t(state === 'ok' ? 'ac.email.verified' : state === 'pending' ? 'ac.email.unverified' : 'ac.email.missing');
    badge.hidden = false;
  }
  // The code box appears only when there is something to verify — an unverified
  // address. With no address at all the next step is to add one, not type a code.
  const needsCode = !!me?.email && !me.emailVerified;
  if (verify) verify.hidden = !needsCode;
  if (note && needsCode) note.textContent = tv('ac.verify.sentTo', { email: me?.email ?? '' });
  const emailInput = $<HTMLInputElement>('ac-email');
  if (emailInput && !emailInput.value) emailInput.value = me?.email ?? '';
  dirtyGate(emailInput, $<HTMLButtonElement>('ac-email-save'), () => me?.email ?? '');
}

function renderName(): void {
  const input = $<HTMLInputElement>('ac-name');
  if (input && !input.value) input.value = me?.username ?? '';
  dirtyGate(input, $<HTMLButtonElement>('ac-name-save'), () => me?.username ?? '');
}

async function load(): Promise<void> {
  const sections = $('ac-sections');
  const gate = $('ac-gate');
  if (!isSignedIn()) {
    if (gate) gate.hidden = false;
    return;
  }
  me = await fetchMe().catch(() => null);
  if (!me) {
    // A token that no longer works reads as signed in locally. Say so plainly
    // rather than showing empty fields that fail on save.
    if (gate) { gate.hidden = false; gate.textContent = t('ac.sessionOver'); }
    return;
  }
  if (gate) gate.hidden = true;
  if (sections) sections.hidden = false;
  renderEmail();
  renderName();
}

// ---- email -----------------------------------------------------------------

$('ac-email-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ac-email');
  const msg = $('ac-email-msg');
  const email = (input?.value ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say(msg, t('ac.email.invalid'), 'bad');
  say(msg, t('ac.saving'), 'info');
  try {
    await setAccountEmail(email, POLICY_VERSION);
    me = await fetchMe().catch(() => me);
    renderEmail();
    say(msg, t('ac.email.saved'), 'ok');
  } catch (err) {
    say(msg, (err as Error).message || t('ac.email.taken'), 'bad');
  }
});

$('ac-code-submit')?.addEventListener('click', async () => {
  const input = $<HTMLInputElement>('ac-code');
  const msg = $('ac-email-msg');
  const code = (input?.value ?? '').replace(/\D/g, '');
  if (code.length !== 6) return say(msg, t('ac.verify.sixDigits'), 'bad');
  say(msg, t('ac.verify.checking'), 'info');
  const res = await verifyEmailCode(code);
  if (res.ok) {
    me = await fetchMe().catch(() => me);
    renderEmail();
    if (input) input.value = '';
    return say(msg, t('ac.verify.done'), 'ok');
  }
  // Counting down out loud beats a flat "wrong code" five times over.
  say(
    msg,
    res.triesLeft === undefined
      ? res.error ?? t('ac.verify.wrong')
      : res.triesLeft > 0
        ? tv('ac.verify.wrongLeft', { n: res.triesLeft })
        : t('ac.verify.exhausted'),
    'bad',
  );
});

$('ac-resend')?.addEventListener('click', async () => {
  const msg = $('ac-email-msg');
  say(msg, t('ac.saving'), 'info');
  try {
    const res = await resendVerification();
    if (res.ok) return say(msg, tv('ac.verify.resent', { email: me?.email ?? '' }), 'ok');
    // A cooldown is not a failure — the message they are waiting for is already
    // on its way, and pressing again would invalidate the code in it.
    say(
      msg,
      res.retryInSeconds
        ? tv('ac.verify.cooldown', { n: res.retryInSeconds })
        : t('ac.verify.sendRefused'),
      res.retryInSeconds ? 'info' : 'bad',
    );
  } catch {
    say(msg, t('ac.verify.resendFailed'), 'bad');
  }
});

// Digits only, and submit itself once six are in — the code is pasted far more
// often than it is typed.
$<HTMLInputElement>('ac-code')?.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const clean = el.value.replace(/\D/g, '').slice(0, 6);
  if (clean !== el.value) el.value = clean;
  if (clean.length === 6) $<HTMLButtonElement>('ac-code-submit')?.click();
});

// ---- name ------------------------------------------------------------------

$('ac-name-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ac-name');
  const msg = $('ac-name-msg');
  const name = (input?.value ?? '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) return say(msg, t('ac.name.rules'), 'bad');
  say(msg, t('ac.saving'), 'info');
  try {
    const saved = await changeUsername(name);
    if (me) me.username = saved;
    renderName();
    say(msg, tv('ac.name.saved', { name: saved }), 'ok');
  } catch (err) {
    say(msg, (err as Error).message || t('ac.name.taken'), 'bad');
  }
});

// ---- password --------------------------------------------------------------

$('ac-pw-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $<HTMLInputElement>('ac-pw-current');
  const next = $<HTMLInputElement>('ac-pw-new');
  const msg = $('ac-pw-msg');
  if ((next?.value ?? '').length < 8) return say(msg, t('ac.pw.short'), 'bad');
  say(msg, t('ac.saving'), 'info');
  try {
    await changePassword(cur?.value ?? '', next?.value ?? '');
    if (cur) cur.value = '';
    if (next) next.value = '';
    // The server ended every other session. Saying so is the whole point of
    // changing a password after losing a device.
    say(msg, t('ac.pw.done'), 'ok');
  } catch (err) {
    say(msg, (err as Error).message || t('ac.pw.wrong'), 'bad');
  }
});

// ---- data ------------------------------------------------------------------

$('ac-export')?.addEventListener('click', async () => {
  const msg = $('ac-export-msg');
  say(msg, t('ac.saving'), 'info');
  try {
    const data = await exportMyData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tifomaker-data.json';
    a.click();
    URL.revokeObjectURL(url);
    say(msg, t('ac.data.done'), 'ok');
  } catch {
    say(msg, t('ac.data.failed'), 'bad');
  }
});

// ---- danger zone -----------------------------------------------------------

$('ac-delete')?.addEventListener('click', () => {
  const box = $('ac-delete-confirm');
  const ask = $('ac-delete-ask');
  if (ask) ask.textContent = tv('ac.danger.typeName', { name: me?.username ?? '' });
  if (box) box.hidden = false;
  $('ac-delete')?.setAttribute('hidden', '');
  $<HTMLInputElement>('ac-delete-name')?.focus();
});
$('ac-delete-cancel')?.addEventListener('click', () => {
  const box = $('ac-delete-confirm');
  if (box) box.hidden = true;
  $('ac-delete')?.removeAttribute('hidden');
  say($('ac-delete-msg'), '', 'info');
});
$('ac-delete-go')?.addEventListener('click', async () => {
  const typed = ($<HTMLInputElement>('ac-delete-name')?.value ?? '').trim();
  const msg = $('ac-delete-msg');
  // Typing the name is the second step. A window.confirm is one reflex click.
  if (typed !== me?.username) return say(msg, t('ac.danger.mismatch'), 'bad');
  say(msg, t('ac.saving'), 'info');
  try {
    await deleteAccount();
    window.location.href = '/';
  } catch {
    say(msg, t('ac.danger.failed'), 'bad');
  }
});

$('ac-signout')?.addEventListener('click', () => {
  signOut();
  window.location.href = '/app';
});

// Every standalone page has to do this: `current` starts at 'en' and only
// initLang() reads the saved choice. Without it the page renders in English
// with an Arabic document direction, which is worse than either alone.
initLang();
document.documentElement.lang = getLang();
applyDom(document);
void load();
