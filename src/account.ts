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
  availableProviders,
  beginLinkProvider,
  unlinkProvider,
  adoptProviderSession,
  providerFailure,
} from './net/api';
import type { Me } from './net/api';
import { applyDom, getLang, initLang, t, tErr, tv } from './ui/i18n';
import { enhancePasswordField } from './ui/passwordField';
import { POLICY_VERSION } from './ui/authModal';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

type Tone = 'ok' | 'bad' | 'info';
const say = (el: HTMLElement | null, text: string, tone: Tone = 'info'): void => {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
};

let me: Me | null = null;

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
  renderPasswordSection();
  void renderConnections();
}

// ---- password, or the lack of one ------------------------------------------

/**
 * An account created by signing in with Google has no password to confirm, so
 * the form asks for one rather than to change one. Hiding the current-password
 * field is not cosmetic: leaving it there would ask for something that does not
 * exist, and the only honest answer would be to leave it blank.
 */
function renderPasswordSection(): void {
  const first = me?.hasPassword === false;
  const current = $<HTMLInputElement>('ac-pw-current');
  const currentLabel = document.querySelector('label[for="ac-pw-current"]') as HTMLElement | null;
  const title = document.querySelector('#sec-password h2') as HTMLElement | null;
  const note = document.querySelector('#sec-password .ac-note') as HTMLElement | null;
  const save = $('ac-pw-save');
  if (current) current.hidden = first;
  if (currentLabel) currentLabel.hidden = first;
  if (title) title.textContent = t(first ? 'ac.pw.titleSet' : 'ac.pw.title');
  if (note) note.textContent = t(first ? 'ac.pw.noteSet' : 'ac.pw.note');
  if (save) save.textContent = t(first ? 'ac.pw.setSave' : 'ac.pw.save');
}

// ---- connected accounts ----------------------------------------------------

const PROVIDER_LABEL: Record<string, string> = { google: 'Google' };

async function renderConnections(): Promise<void> {
  const section = $('sec-connected');
  const list = $('ac-link-list');
  if (!section || !list) return;
  const offered = await availableProviders();
  if (!offered.length) return; // nothing configured: no section at all
  section.hidden = false;
  const linked = me?.providers ?? [];
  list.replaceChildren();
  for (const id of offered) {
    const row = document.createElement('div');
    row.className = 'ac-link-row';
    const name = document.createElement('span');
    name.textContent = PROVIDER_LABEL[id] ?? id;
    const button = document.createElement('button');
    button.className = 'ac-btn';
    button.type = 'button';
    const on = linked.includes(id);
    button.textContent = t(on ? 'ac.link.remove' : 'ac.link.add');
    button.addEventListener('click', async () => {
      const msg = $('ac-link-msg');
      button.disabled = true;
      try {
        if (on) {
          const left = await unlinkProvider(id);
          if (me) me.providers = left;
          say(msg, t('ac.link.removed'), 'ok');
          void renderConnections();
        } else {
          // Leaves the page for the consent screen and comes back to /account.
          await beginLinkProvider(id, '/account');
        }
      } catch (err) {
        say(msg, tErr((err as Error).message), 'bad');
        button.disabled = false;
      }
    });
    row.append(name, button);
    list.append(row);
  }
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
    if (res.ok && res.alreadyVerified) {
      // Verified from another tab or from the link in the meantime.
      me = await fetchMe().catch(() => me);
      renderEmail();
      return say(msg, t('ac.verify.done'), 'ok');
    }
    if (res.ok) return say(msg, tv('ac.verify.resent', { email: me?.email ?? '' }), 'ok');
    // The daily cap is not a cooldown: waiting a minute will not help, and the
    // "already on its way" wording would be wrong.
    if (res.status === 429 && res.error === 'too many verification emails today') {
      return say(msg, tErr(res.error), 'info');
    }
    // A cooldown is not a failure — the message they are waiting for is already
    // on its way, and pressing again would invalidate the code in it.
    if (res.status === 429 && res.retryInSeconds) {
      return say(msg, tv('ac.verify.cooldown', { n: res.retryInSeconds }), 'info');
    }
    // Only a 502 means the email provider refused. Every other failure used to
    // be reported as that too, including the 400 that was actually breaking
    // this button, which sent the diagnosis looking at the wrong system.
    say(
      msg,
      res.status === 502
        ? t('ac.verify.sendRefused')
        : res.status === 401
          ? t('ac.sessionOver')
          : t('ac.verify.resendFailed'),
      'bad',
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

// The same field as the sign-up modal and /reset: strength bar, reveal button,
// suggester, confirm. The fourth place a password gets chosen, and the last one
// that still had its own private idea of what a good one looks like.
const pwNew = $<HTMLInputElement>('ac-pw-new');
const pwAgain = $<HTMLInputElement>('ac-pw-again');
const pwField =
  pwNew && pwAgain
    ? enhancePasswordField({
        input: pwNew,
        confirm: pwAgain,
        suggest: true,
        context: () => ({ email: me?.email ?? undefined, username: me?.username }),
      })
    : null;

$('ac-pw-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $<HTMLInputElement>('ac-pw-current');
  const next = $<HTMLInputElement>('ac-pw-new');
  const msg = $('ac-pw-msg');
  const complaint = pwField?.validate();
  if (complaint) {
    complaint.field.focus();
    return say(msg, complaint.message, 'bad');
  }
  say(msg, t('ac.saving'), 'info');
  try {
    await changePassword(cur?.value ?? '', next?.value ?? '');
    if (cur) cur.value = '';
    if (next) next.value = '';
    if (pwAgain) pwAgain.value = '';
    pwField?.refresh();
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

/**
 * This page is also a landing spot for a provider round trip: a link started
 * here comes back here, and so does a sign-in whose `returnTo` was /account.
 * Both have to be settled before `load()` asks the server who we are.
 */
void (async () => {
  await adoptProviderSession();
  const failed = providerFailure();
  const params = new URLSearchParams(location.search);
  const linked = params.get('linked');
  if (linked) {
    params.delete('linked');
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  }
  await load();
  if (failed) say($('ac-link-msg'), t(`auth.err.${failed}`), 'bad');
  else if (linked) say($('ac-link-msg'), t('ac.link.added'), 'ok');
})();
