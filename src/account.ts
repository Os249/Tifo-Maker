/**
 * Account settings.
 *
 * A real page rather than the three modals this replaces, because every fact it
 * shows has state that a modal cannot carry: is this address verified, is a code
 * still valid, how many guesses are left, what is my name right now. The old
 * flow told you none of it — you added an email, a dialog closed itself after
 * 2.4 seconds, and nothing ever mentioned the address again.
 *
 * Laid out as five areas (ui/accountAreas.ts) under a summary of who you are,
 * your email and your plan, each with its one next step. An address that is not
 * verified yet comes before all of it.
 *
 * Each block saves on its own and reports its own result, beside the field it
 * is about. One page-level Save would make a single failure look like five.
 * Every button says when it is working and what came of it.
 */
import { cleanAddressBar } from './core/utm';
import {
  fetchMe,
  isSignedIn,
  setAccountEmail,
  resendVerification,
  verifyEmailCode,
  changeUsername,
  changePassword,
  requestPasswordReset,
  exportMyData,
  deleteAccount,
  signOut,
  availableProviders,
  beginLinkProvider,
  unlinkProvider,
  adoptProviderSession,
  providerFailure,
  aiUnlockToken,
} from './net/api';
import type { Me } from './net/api';
import { applyDom, getLang, initLang, localPath, toggleLang, t, tErr, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { enhancePasswordField } from './ui/passwordField';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { POLICY_VERSION } from './ui/authModal';
import { mountProAccount, type ProSummary } from './ui/proAccount';
import { initAreas, type Area, type Areas } from './ui/accountAreas';
import { supporterBadgeHtml } from './ui/supporterBadge';
import { initSiteHeader, setHeaderUser } from './ui/siteHeader';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

// Every standalone page has to do this first: `current` starts at 'en' and only
// initLang() reads the saved choice. Without it the page renders in English
// with an Arabic document direction, which is worse than either alone. Before
// anything below draws words of its own (the password field does, at once).
initLang();

type Tone = 'ok' | 'bad' | 'info';
/** Where each message sits when it is not beside a field. */
const homes = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Say what an action answered. With `field`, the message moves beside that
 * field and the field is marked as the one to fix; without, it goes back to its
 * own place under the block.
 */
const say = (el: HTMLElement | null, text: string, tone: Tone = 'info', field?: HTMLInputElement | null): void => {
  if (!el) return;
  if (!homes.has(el) && el.parentElement) homes.set(el, el.parentElement);
  const block = el.closest('.ac-card, .ac-verify') ?? document;
  for (const i of Array.from(block.querySelectorAll<HTMLInputElement>(`[aria-describedby~="${el.id}"]`))) {
    i.removeAttribute('aria-invalid');
    const rest = (i.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== el.id);
    if (rest.length) i.setAttribute('aria-describedby', rest.join(' '));
    else i.removeAttribute('aria-describedby');
  }
  const host = field && tone === 'bad' && text ? field.closest<HTMLElement>('.ac-field') : null;
  if (host) {
    host.append(el);
    field!.setAttribute('aria-invalid', 'true');
    field!.setAttribute('aria-describedby', [field!.getAttribute('aria-describedby'), el.id].filter(Boolean).join(' '));
  } else {
    const home = homes.get(el);
    if (home && el.parentElement !== home) home.append(el);
  }
  el.textContent = text;
  el.dataset.tone = tone;
};

/** A button that is working: it says so, turns, and cannot be pressed twice. */
function busy(btn: HTMLButtonElement | null, on: boolean, label = ''): void {
  if (!btn) return;
  const words = btn.querySelector<HTMLElement>('span') ?? btn;
  if (on) {
    if (btn.dataset.busy === undefined) btn.dataset.idle = words.textContent ?? '';
    btn.dataset.busy = '';
    btn.disabled = true;
    if (label) words.textContent = label;
  } else if (btn.dataset.busy !== undefined) {
    delete btn.dataset.busy;
    btn.disabled = false;
    words.textContent = btn.dataset.idle ?? words.textContent;
    delete btn.dataset.idle;
  }
}

/** Show or hide a field whole: its box, its label and its input. */
function showField(input: HTMLInputElement | null, on: boolean): void {
  if (!input) return;
  input.hidden = !on;
  const field = input.closest<HTMLElement>('.ac-field');
  if (field) field.hidden = !on;
  const label = field?.querySelector('label');
  if (label) label.hidden = !on;
}

const EYE = '<svg class="ac-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg class="ac-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.2 7.7A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.3 3.6-.8"/></svg>';
const eyes: Array<() => void> = [];

/** Show and hide on a password box that is typed, not chosen (the chosen one is ui/passwordField.ts). */
function revealable(input: HTMLInputElement | null): void {
  if (!input) return;
  const box = document.createElement('span');
  box.className = 'ac-pwbox';
  input.before(box);
  box.append(input);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'ac-eye';
  const draw = (): void => {
    const shown = input.type === 'text';
    eye.innerHTML = shown ? EYE_OFF : EYE;
    eye.setAttribute('aria-pressed', String(shown));
    eye.setAttribute('aria-label', t(shown ? 'pw.hide' : 'pw.show'));
  };
  eye.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    draw();
    input.focus();
  });
  box.append(eye);
  draw();
  eyes.push(draw);
}

/** A form behind its "Change" button: open, or put away again. */
function fold(button: HTMLButtonElement | null, form: HTMLElement | null, open: boolean, focus = true): void {
  if (!button || !form) return;
  form.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.dataset.i18n = open ? 'ac.close' : button.dataset.closed ?? 'ac.change';
  button.textContent = t(button.dataset.i18n);
  // One form at a time: opening one puts the other away, so the screen has one step.
  if (open) {
    for (const [b, f] of [['ac-email-edit', 'ac-email-form'], ['ac-pw-edit', 'ac-pw-form']] as const) {
      const other = $(f);
      if (other && other !== form && !other.hidden) fold($<HTMLButtonElement>(b), other, false);
    }
  }
  syncPrimary();
  if (open && focus) form.querySelector<HTMLInputElement>('input:not([hidden])')?.focus();
}

/**
 * One blue button on the screen: the code's Verify while an address waits for
 * its code; otherwise the submit of the form that is open, or Save once the
 * name was changed. Everything else stays quiet.
 */
function syncPrimary(): void {
  const verify = $('ac-verify');
  const verifying = !!verify && !verify.hidden && verify.offsetParent !== null;
  const mark = (id: string, on: boolean): void => {
    $(id)?.classList.toggle('primary', on && !verifying);
  };
  mark('ac-email-save', $('ac-email-form')?.hidden === false);
  mark('ac-pw-save', $('ac-pw-form')?.hidden === false);
  const nameSave = $<HTMLButtonElement>('ac-name-save');
  mark('ac-name-save', !!nameSave && (!nameSave.disabled || nameSave.dataset.busy !== undefined));
}
window.addEventListener('hashchange', () => window.setTimeout(syncPrimary));
window.addEventListener('resize', syncPrimary);

let me: Me | null = null;
let areas: Areas | null = null;
const goTo = (area: Area): void => { (areas as Areas | null)?.go(area); };
/** What ui/proAccount.ts last said of this account's plan; null until it has, and where Pro is off. */
let pro: ProSummary | null = null;

/** Wire a Save button to stay disabled until its field actually differs. */
function dirtyGate(input: HTMLInputElement | null, button: HTMLButtonElement | null, current: () => string): void {
  if (!input || !button) return;
  const sync = (): void => {
    if (button.dataset.busy !== undefined) return;
    const v = input.value.trim();
    button.disabled = v.length === 0 || v === current();
    syncPrimary();
  };
  if (!input.dataset.gated) {
    input.dataset.gated = '1';
    input.addEventListener('input', sync);
  }
  sync();
}

// ---- the summary and the list ------------------------------------------------

function emailState(): 'ok' | 'pending' | 'none' {
  return !me?.email ? 'none' : me.emailVerified ? 'ok' : 'pending';
}
const EMAIL_WORD = { ok: 'ac.email.verified', pending: 'ac.email.unverified', none: 'ac.email.missing' } as const;

/** Who I am, my email and my plan, each with its one next step, and the line under each area's name. */
function renderSummary(): void {
  if (!me) return;
  const name = $('ac-sum-name');
  if (name) name.textContent = `@${me.username}`;
  const avatar = $('ac-sum-avatar');
  if (avatar) avatar.textContent = me.username.charAt(0);
  const sup = $('ac-sum-badge');
  if (sup) sup.innerHTML = pro?.supporter ? supporterBadgeHtml() : '';

  const state = emailState();
  const email = $('ac-sum-email');
  if (email) email.textContent = me.email || t('ac.email.none');
  const badge = $('ac-sum-email-badge');
  if (badge) {
    badge.dataset.state = state;
    badge.textContent = t(EMAIL_WORD[state]);
    badge.hidden = false;
  }
  const step = $<HTMLButtonElement>('ac-sum-email-step');
  if (step) {
    step.hidden = state === 'ok';
    step.textContent = t(state === 'pending' ? 'ac.sum.code' : 'ac.sum.addEmail');
  }

  const planCell = $('ac-sum-plan');
  if (planCell) planCell.hidden = !pro;
  if (pro) {
    const planName = $('ac-sum-plan-name');
    if (planName) planName.textContent = t(`ac.pro.plan.${pro.plan}`);
    const days = $('ac-sum-plan-badge');
    if (days) {
      days.hidden = pro.daysLeft === null;
      if (pro.daysLeft !== null) {
        days.dataset.state = pro.daysLeft <= 7 && !pro.renewing && pro.plan !== 'gift' ? 'pending' : 'quiet';
        days.textContent = daysLeftText(pro.daysLeft);
      }
    }
    const sub = $('ac-sum-plan-sub');
    if (sub) {
      sub.hidden = !pro.endsOn;
      sub.textContent = pro.endsOn ? tv(pro.renewing ? 'ac.sum.renews' : 'ac.pro.ends', { date: pro.endsOn }) : '';
    }
    const planStep = $('ac-sum-plan-step');
    if (planStep) {
      planStep.textContent = t(pro.plan === 'free' ? 'ac.sum.what' : pro.daysLeft !== null && pro.daysLeft <= 7 && !pro.renewing ? 'ac.sum.ends' : 'ac.sum.manage');
      planStep.classList.toggle('tint', pro.plan === 'free');
    }
  }

  const navProfile = $('ac-nav-profile');
  if (navProfile) navProfile.textContent = `@${me.username}`;
  const navSec = $('ac-nav-security');
  if (navSec) navSec.textContent = t(state === 'ok' ? 'ac.nav.secOk' : EMAIL_WORD[state]);
  document.querySelector('.ac-link[data-to="security"]')?.toggleAttribute('data-warn', state !== 'ok');
  const billing = document.querySelector<HTMLElement>('.ac-link[data-to="billing"]');
  if (billing) {
    billing.hidden = !pro;
    billing.toggleAttribute('data-warn', !!pro && pro.daysLeft !== null && pro.daysLeft <= 7 && !pro.renewing);
  }
  const navBilling = $('ac-nav-billing');
  if (navBilling && pro) navBilling.textContent = [t(`ac.pro.plan.${pro.plan}`), pro.daysLeft === null ? '' : daysLeftText(pro.daysLeft)].filter(Boolean).join(' · ');
}

function daysLeftText(n: number): string {
  return n <= 0 ? t('ac.pro.lastDay') : n === 1 ? t('ac.pro.dayLeft') : tv('ac.pro.daysLeft', { n });
}

/** The next step for the email, from the summary: the code box, or the form that adds an address. */
$('ac-sum-email-step')?.addEventListener('click', () => {
  if (emailState() === 'pending') {
    $<HTMLInputElement>('ac-code')?.focus();
    return;
  }
  goTo('security');
  fold($<HTMLButtonElement>('ac-email-edit'), $('ac-email-form'), true);
});

// ---- email -------------------------------------------------------------------

/** Paint the email block from `me`: address, badge, and whether to ask for a code. */
function renderEmail(): void {
  const valueEl = $('ac-email-current');
  const badge = $('ac-email-badge');
  const verify = $('ac-verify');
  const note = $('ac-verify-note');
  const state = emailState();
  if (valueEl) valueEl.textContent = me?.email || t('ac.email.none');
  if (badge) {
    badge.dataset.state = state;
    badge.textContent = t(EMAIL_WORD[state]);
    badge.hidden = false;
  }
  // The code box appears only when there is something to verify — an unverified
  // address. With no address at all the next step is to add one, not type a code.
  const needsCode = state === 'pending';
  if (verify) verify.hidden = !needsCode;
  if (note && needsCode) note.textContent = tv('ac.verify.sentTo', { email: me?.email ?? '' });
  // Putting an address on the account, a first one included, needs the current
  // password (see the server's `reauthenticated`); an account without a
  // password has none to give.
  showField($<HTMLInputElement>('ac-email-pw'), me?.hasPassword !== false);
  const edit = $<HTMLButtonElement>('ac-email-edit');
  if (edit) {
    edit.dataset.closed = state === 'none' ? 'ac.sum.addEmail' : 'ac.change';
    if (edit.getAttribute('aria-expanded') !== 'true') {
      edit.dataset.i18n = edit.dataset.closed;
      edit.textContent = t(edit.dataset.closed);
    }
  }
  dirtyGate($<HTMLInputElement>('ac-email'), $<HTMLButtonElement>('ac-email-save'), () => me?.email ?? '');
  renderSummary();
  syncPrimary();
}

function renderName(): void {
  const input = $<HTMLInputElement>('ac-name');
  if (input && !input.value) input.value = me?.username ?? '';
  dirtyGate(input, $<HTMLButtonElement>('ac-name-save'), () => me?.username ?? '');
}

/** The way in from the signed-out page: the same dialog as everywhere else. */
function wireGate(): void {
  const open = async (startOn: 'signin' | 'signup'): Promise<void> => {
    const { openAuthModal } = await import('./ui/authModal');
    if (await openAuthModal(false, startOn)) location.reload();
  };
  $('ac-gate-signin')?.addEventListener('click', () => void open('signin'));
  $('ac-gate-signup')?.addEventListener('click', () => void open('signup'));
}

async function load(): Promise<void> {
  const sections = $('ac-sections');
  const gate = $('ac-gate');
  if (!isSignedIn()) {
    if (gate) gate.hidden = false;
    return;
  }
  me = await fetchMe().catch(() => null);
  // Same wall as everywhere else: this page's own saves would be refused too.
  me = await ensureUsernameChosen(me);
  if (!me) {
    // A token that no longer works reads as signed in locally. Say so plainly
    // rather than showing empty fields that fail on save.
    if (gate) {
      gate.hidden = false;
      const msg = $('ac-gate-msg');
      if (msg) {
        // Its own sentence now, which a language switch must not put back.
        msg.dataset.i18n = 'ac.sessionOver';
        msg.textContent = t('ac.sessionOver');
      }
    }
    return;
  }
  if (gate) gate.hidden = true;
  if (sections) sections.hidden = false;
  setHeaderUser(me);
  const main = $('main');
  // Billing is an area only where Pro is on for this account (and nowhere else).
  if (main) areas = initAreas(main, (area) => area !== 'billing' || !!pro || !proKnown);
  const billing = $('ac-billing');
  if (billing) {
    mountProAccount(billing, (summary) => {
      pro = summary;
      proKnown = true;
      renderSummary();
      areas?.refresh();
    });
  }
  renderEmail();
  renderName();
  renderPasswordSection();
  void renderConnections();
}
/** Until Pro has answered, a link to billing is taken at its word: it is not sent back to the overview and then forward again. */
let proKnown = false;

// ---- password, or the lack of one ------------------------------------------

/**
 * An account created by signing in with Google has no password to confirm, so
 * the form asks for one rather than to change one. Hiding the current-password
 * field is not cosmetic: leaving it there would ask for something that does not
 * exist, and the only honest answer would be to leave it blank.
 */
function renderPasswordSection(): void {
  const first = me?.hasPassword === false;
  // No password but a proven address: the address decides, not this session.
  // The server refuses a first password set from here, and sends the link.
  const byLink = linkOnly();
  showField($<HTMLInputElement>('ac-pw-current'), !first);
  const title = $('ac-pw-title');
  const note = $('ac-pw-note');
  const save = $('ac-pw-save');
  if (title) title.textContent = t(first ? 'ac.pw.titleSet' : 'ac.pw.title');
  if (note) note.textContent = byLink ? tv('ac.pw.noteEmail', { email: me?.email ?? '' }) : t(first ? 'ac.pw.noteSet' : 'ac.pw.note');
  if (save && save.dataset.busy === undefined) save.textContent = t(byLink ? 'ac.pw.sendLink' : first ? 'ac.pw.setSave' : 'ac.pw.save');
  const box = $('ac-pw-newbox');
  if (box) box.hidden = byLink;
  const dots = $('ac-pw-state');
  if (dots) dots.hidden = first;
  const badge = $('ac-pw-badge');
  if (badge) badge.textContent = t(first ? 'ac.pw.none' : 'ac.pw.isSet');
  const edit = $<HTMLButtonElement>('ac-pw-edit');
  if (edit) {
    edit.dataset.closed = first ? 'ac.pw.titleSet' : 'ac.change';
    if (edit.getAttribute('aria-expanded') !== 'true') {
      edit.dataset.i18n = edit.dataset.closed;
      edit.textContent = t(edit.dataset.closed);
    }
  }
}

/** An account without a password whose address is proven: it gets its password by email. */
function linkOnly(): boolean {
  return me?.hasPassword === false && !!me.email && !!me.emailVerified;
}

// ---- connected accounts ----------------------------------------------------

const PROVIDER_LABEL: Record<string, string> = { google: 'Google' };

async function renderConnections(): Promise<void> {
  const section = $('sec-connected');
  const list = $('ac-link-list');
  if (!section || !list) return;
  const offered = await availableProviders();
  if (!offered.length) return; // nothing configured: no block at all
  section.hidden = false;
  const linked = me?.providers ?? [];
  // Connecting another sign-in asks for the current password when there is one.
  const pwForm = $('ac-link-pw-form');
  const canAdd = offered.some((id) => !linked.includes(id));
  if (pwForm) pwForm.hidden = !(canAdd && me?.hasPassword !== false);
  list.replaceChildren();
  for (const id of offered) {
    const row = document.createElement('div');
    row.className = 'ac-link-row';
    const on = linked.includes(id);
    const name = document.createElement('span');
    name.className = 'ac-link-name';
    const label = document.createElement('span');
    label.textContent = PROVIDER_LABEL[id] ?? id;
    const state = document.createElement('span');
    state.className = 'ac-badge';
    state.dataset.state = on ? 'ok' : 'quiet';
    state.textContent = t(on ? 'ac.link.on' : 'ac.link.off');
    name.append(label, state);
    const button = document.createElement('button');
    button.className = 'ac-btn sm';
    button.type = 'button';
    button.textContent = t(on ? 'ac.link.remove' : 'ac.link.add');
    button.addEventListener('click', async () => {
      const msg = $('ac-link-msg');
      say(msg, '');
      try {
        if (on) {
          busy(button, true);
          const left = await unlinkProvider(id);
          if (me) me.providers = left;
          say(msg, t('ac.link.removed'), 'ok');
          void renderConnections();
        } else {
          // Leaves the page for the consent screen and comes back to /account.
          const pwInput = $<HTMLInputElement>('ac-link-pw');
          const password = me?.hasPassword !== false ? (pwInput?.value ?? '') : '';
          if (me?.hasPassword !== false && !password) {
            say(msg, t('ac.link.needPw'), 'bad', pwInput);
            pwInput?.focus();
            return;
          }
          busy(button, true);
          await beginLinkProvider(id, '/account', password || undefined);
        }
      } catch (err) {
        busy(button, false);
        const wrongPw = (err as { status?: number }).status === 401;
        say(msg, tErr((err as Error).message), 'bad', wrongPw ? $<HTMLInputElement>('ac-link-pw') : null);
      }
    });
    row.append(name, button);
    list.append(row);
  }
}

// ---- email: change it --------------------------------------------------------

$('ac-email-edit')?.addEventListener('click', (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  if (open) say($('ac-email-msg'), '');
  fold(button, $('ac-email-form'), open);
});
$('ac-email-cancel')?.addEventListener('click', () => {
  say($('ac-email-msg'), '');
  fold($<HTMLButtonElement>('ac-email-edit'), $('ac-email-form'), false);
  $('ac-email-edit')?.focus();
});

$('ac-email-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ac-email');
  const msg = $('ac-email-msg');
  const save = $<HTMLButtonElement>('ac-email-save');
  const email = (input?.value ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    input?.focus();
    return say(msg, t('ac.email.invalid'), 'bad', input);
  }
  if (linkOnly() && me?.email && me.email.toLowerCase() !== email.toLowerCase()) {
    return say(msg, t('ac.email.setPwFirst'), 'bad');
  }
  const pwInput = $<HTMLInputElement>('ac-email-pw');
  const password = pwInput && !pwInput.hidden ? pwInput.value : '';
  if (pwInput && !pwInput.hidden && !password) {
    pwInput.focus();
    return say(msg, t('ac.email.needPw'), 'bad', pwInput);
  }
  say(msg, '');
  busy(save, true, t('ac.saving'));
  try {
    await setAccountEmail(email, POLICY_VERSION, password || undefined);
    if (pwInput) pwInput.value = '';
    if (input) input.value = '';
    me = await fetchMe().catch(() => me);
    busy(save, false);
    fold($<HTMLButtonElement>('ac-email-edit'), $('ac-email-form'), false);
    // A new address starts with a new code: nothing said about the old one still holds.
    say($('ac-verify-msg'), '');
    const verified = $('ac-verified');
    if (verified) verified.hidden = true;
    renderEmail();
    say(msg, t('ac.email.saved'), 'ok');
  } catch (err) {
    busy(save, false);
    dirtyGate(input, save, () => me?.email ?? '');
    const wrongPw = (err as { status?: number }).status === 401;
    say(msg, (err as Error).message || t('ac.email.taken'), 'bad', wrongPw ? pwInput : input);
    (wrongPw ? pwInput : input)?.focus();
  }
});

// ---- email: verify it --------------------------------------------------------

$('ac-code-submit')?.addEventListener('click', async () => {
  const input = $<HTMLInputElement>('ac-code');
  const msg = $('ac-verify-msg');
  const button = $<HTMLButtonElement>('ac-code-submit');
  if (button?.dataset.busy !== undefined) return;
  const code = (input?.value ?? '').replace(/\D/g, '');
  if (code.length !== 6) {
    input?.focus();
    return say(msg, t('ac.verify.sixDigits'), 'bad', input);
  }
  say(msg, '');
  busy(button, true, t('ac.verify.checking'));
  const res = await verifyEmailCode(code).catch(() => ({ ok: false, triesLeft: undefined, error: t('err.retry') }));
  busy(button, false);
  if (res.ok) {
    me = await fetchMe().catch(() => me);
    if (input) input.value = '';
    say(msg, t('ac.verify.done'), 'ok');
    // The box goes; the word that it worked stays where the box was.
    const done = $('ac-verified');
    if (done) {
      done.textContent = t('ac.verify.done');
      done.hidden = false;
    }
    renderEmail();
    renderPasswordSection();
    return;
  }
  if (input) input.value = '';
  // Counting down out loud beats a flat "wrong code" five times over.
  say(
    msg,
    res.triesLeft === undefined
      ? res.error ?? t('ac.verify.wrong')
      : res.triesLeft > 0
        ? tv('ac.verify.wrongLeft', { n: res.triesLeft })
        : t('ac.verify.exhausted'),
    'bad',
    input,
  );
  input?.focus();
});

/** While the server's wait runs, the button counts it down and cannot be pressed: pressing would only be refused again. */
let resendAt = 0;
let resendTimer = 0;
function tickResend(): void {
  const button = $<HTMLButtonElement>('ac-resend');
  if (!button || button.dataset.busy !== undefined) return;
  const left = Math.ceil((resendAt - Date.now()) / 1000);
  if (left > 0) {
    button.disabled = true;
    button.textContent = tv('ac.verify.resendIn', { n: left });
    return;
  }
  window.clearInterval(resendTimer);
  resendTimer = 0;
  button.disabled = false;
  button.textContent = t('ac.verify.resend');
}

$('ac-resend')?.addEventListener('click', async () => {
  const msg = $('ac-verify-msg');
  const button = $<HTMLButtonElement>('ac-resend');
  say(msg, '');
  busy(button, true, t('ac.verify.sending'));
  try {
    const res = await resendVerification();
    busy(button, false);
    if (res.ok && res.alreadyVerified) {
      // Verified from another tab or from the link in the meantime.
      me = await fetchMe().catch(() => me);
      renderEmail();
      const done = $('ac-verified');
      if (done) {
        done.textContent = t('ac.verify.done');
        done.hidden = false;
      }
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
      resendAt = Date.now() + res.retryInSeconds * 1000;
      if (!resendTimer) resendTimer = window.setInterval(tickResend, 1000);
      tickResend();
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
    busy(button, false);
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
$<HTMLInputElement>('ac-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('ac-code-submit')?.click();
});

// ---- name ------------------------------------------------------------------

$('ac-name-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ac-name');
  const msg = $('ac-name-msg');
  const save = $<HTMLButtonElement>('ac-name-save');
  const name = (input?.value ?? '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) {
    input?.focus();
    return say(msg, t('ac.name.rules'), 'bad', input);
  }
  // Claiming a name reserved for an admin takes the admin password. The field
  // appears only in a browser that has unlocked the admin tools, and only after
  // the name was refused, so nobody else is ever asked for a password they
  // could not have.
  const adminPw = $<HTMLInputElement>('ac-name-adminpw');
  const adminPwForm = $('ac-name-admin-form');
  const claimPw = adminPw && !adminPw.hidden ? adminPw.value : '';
  say(msg, t('ac.saving'), 'info');
  busy(save, true, t('ac.saving'));
  try {
    const saved = await changeUsername(name, claimPw || undefined);
    if (me) me.username = saved;
    if (adminPw) { adminPw.value = ''; adminPw.hidden = true; }
    if (adminPwForm) adminPwForm.hidden = true;
    busy(save, false);
    renderName();
    renderSummary();
    say(msg, tv('ac.name.saved', { name: saved }), 'ok');
  } catch (err) {
    busy(save, false);
    if ((err as { taken?: boolean }).taken && aiUnlockToken() && adminPw) {
      adminPw.hidden = false;
      if (adminPwForm) adminPwForm.hidden = false;
      adminPw.value = '';
      adminPw.focus();
      say(msg, t(claimPw ? 'ac.name.adminWrong' : 'ac.name.adminAsk'), 'bad');
      return;
    }
    say(msg, (err as Error).message || t('ac.name.taken'), 'bad', input);
    input?.focus();
  }
});

// Enter in the admin password field saves the name, as in the name field.
$('ac-name-admin-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  $<HTMLButtonElement>('ac-name-save')?.click();
});

// ---- password --------------------------------------------------------------

// The same field as the sign-up modal and /reset: strength bar, reveal button,
// suggester, confirm. The fourth place a password gets chosen, and the last one
// that still had its own private idea of what a good one looks like. Its first
// line is the rules, shown before anything is typed.
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
for (const id of ['ac-pw-current', 'ac-email-pw', 'ac-link-pw', 'ac-delete-pw']) revealable($<HTMLInputElement>(id));

$('ac-pw-edit')?.addEventListener('click', (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  if (open) say($('ac-pw-msg'), '');
  fold(button, $('ac-pw-form'), open);
});
$('ac-pw-cancel')?.addEventListener('click', () => {
  say($('ac-pw-msg'), '');
  fold($<HTMLButtonElement>('ac-pw-edit'), $('ac-pw-form'), false);
  $('ac-pw-edit')?.focus();
});

$('ac-pw-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $<HTMLInputElement>('ac-pw-current');
  const next = $<HTMLInputElement>('ac-pw-new');
  const msg = $('ac-pw-msg');
  const save = $<HTMLButtonElement>('ac-pw-save');
  if (linkOnly() && me?.email) {
    say(msg, '');
    busy(save, true, t('ac.saving'));
    try {
      await requestPasswordReset(me.email);
      busy(save, false);
      say(msg, tv('ac.pw.linkSent', { email: me.email }), 'ok');
    } catch (err) {
      busy(save, false);
      say(msg, (err as Error).message || t('err.retry'), 'bad');
    }
    return;
  }
  if (cur && !cur.hidden && !cur.value) {
    cur.focus();
    return say(msg, t('ac.pw.needCurrent'), 'bad', cur);
  }
  const complaint = pwField?.validate();
  if (complaint) {
    complaint.field.focus();
    return say(msg, complaint.message, 'bad', complaint.field);
  }
  say(msg, '');
  busy(save, true, t('ac.saving'));
  try {
    await changePassword(cur?.value ?? '', next?.value ?? '');
    if (cur) cur.value = '';
    if (next) next.value = '';
    if (pwAgain) pwAgain.value = '';
    pwField?.refresh();
    busy(save, false);
    if (me) me.hasPassword = true;
    fold($<HTMLButtonElement>('ac-pw-edit'), $('ac-pw-form'), false);
    renderPasswordSection();
    // The server ended every other session. Saying so is the whole point of
    // changing a password after losing a device.
    say(msg, t('ac.pw.done'), 'ok');
  } catch (err) {
    busy(save, false);
    // A refused current password is about that field; anything else is about the new one.
    const wrongCur = (err as { status?: number }).status === 401 && !!cur && !cur.hidden;
    say(msg, (err as Error).message || t('ac.pw.wrong'), 'bad', wrongCur ? cur : next);
    (wrongCur ? cur : next)?.focus();
  }
});

// ---- data ------------------------------------------------------------------

$('ac-export')?.addEventListener('click', async () => {
  const msg = $('ac-export-msg');
  const button = $<HTMLButtonElement>('ac-export');
  say(msg, '');
  busy(button, true, t('ac.data.working'));
  try {
    const data = await exportMyData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tifomaker-data.json';
    a.click();
    URL.revokeObjectURL(url);
    busy(button, false);
    say(msg, t('ac.data.done'), 'ok');
  } catch {
    busy(button, false);
    say(msg, t('ac.data.failed'), 'bad');
  }
});

// ---- danger zone -----------------------------------------------------------

$('ac-delete')?.addEventListener('click', () => {
  const box = $('ac-delete-confirm');
  const ask = $('ac-delete-ask');
  if (ask) ask.textContent = tv('ac.danger.typeName', { name: me?.username ?? '' });
  showField($<HTMLInputElement>('ac-delete-pw'), me?.hasPassword !== false);
  if (box) box.hidden = false;
  const start = $('ac-delete');
  start?.setAttribute('hidden', '');
  start?.setAttribute('aria-expanded', 'true');
  $<HTMLInputElement>('ac-delete-name')?.focus();
});
$('ac-delete-cancel')?.addEventListener('click', () => {
  const box = $('ac-delete-confirm');
  if (box) box.hidden = true;
  const start = $('ac-delete');
  start?.removeAttribute('hidden');
  start?.setAttribute('aria-expanded', 'false');
  say($('ac-delete-msg'), '', 'info');
  start?.focus();
});
$('ac-delete-confirm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = $<HTMLInputElement>('ac-delete-name');
  const typed = (nameInput?.value ?? '').trim();
  const msg = $('ac-delete-msg');
  const go = $<HTMLButtonElement>('ac-delete-go');
  // Typing the name is the second step. A window.confirm is one reflex click.
  if (typed !== me?.username) {
    nameInput?.focus();
    return say(msg, t('ac.danger.mismatch'), 'bad', nameInput);
  }
  const pwInput = $<HTMLInputElement>('ac-delete-pw');
  const password = pwInput && !pwInput.hidden ? pwInput.value : '';
  if (pwInput && !pwInput.hidden && !password) {
    pwInput.focus();
    return say(msg, t('ac.danger.needPw'), 'bad', pwInput);
  }
  say(msg, '');
  busy(go, true, t('ac.danger.deleting'));
  try {
    await deleteAccount(password || undefined);
    window.location.href = localPath('/');
  } catch (err) {
    busy(go, false);
    const status = (err as { status?: number }).status;
    say(msg, status === 401 ? (err as Error).message : t('ac.danger.failed'), 'bad', status === 401 ? pwInput : null);
  }
});

$('ac-signout')?.addEventListener('click', () => {
  signOut();
  window.location.href = localPath('/projects');
});

// The visit was counted when the page was sent; see core/utm.ts.
cleanAddressBar();
document.documentElement.lang = getLang();
applyDom(document);
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
// The site's header: the account button opens the same menu as on every page.
initSiteHeader({ onSignIn: () => $('ac-gate-signin')?.click() });
$('lang-toggle')?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
  // Words this script wrote itself are not in the page's data-i18n: say them again.
  for (const draw of eyes) draw();
  pwField?.refresh();
  const suggest = document.querySelector('.pwf-suggest');
  if (suggest) suggest.textContent = t('pw.suggest');
  if (resendTimer) tickResend();
  if (me) {
    renderEmail();
    renderPasswordSection();
    void renderConnections();
    const ask = $('ac-delete-ask');
    if (ask) ask.textContent = tv('ac.danger.typeName', { name: me.username });
  }
});

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
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }
  wireGate();
  await load();
  if (failed || linked) {
    // What came of connecting is said where connecting is done.
    goTo('security');
    if (failed) say($('ac-link-msg'), t(`auth.err.${failed}`), 'bad');
    else say($('ac-link-msg'), t('ac.link.added'), 'ok');
  }
})();
