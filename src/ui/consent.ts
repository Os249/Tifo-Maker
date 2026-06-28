/**
 * Cookie / analytics consent banner. Strictly-necessary storage (sign-in,
 * language, this choice) is always on and needs no consent; non-essential
 * analytics only run when the user picks "Accept all". The choice is remembered;
 * the banner reappears only if it's never been answered. Bilingual via i18n.
 *
 * analytics.ts reads the same localStorage key directly (no import) to decide
 * whether to send, so tracking is off until the user explicitly accepts all.
 */
import { t } from './i18n';

const KEY = 'tifo_consent_v1';
export type Consent = 'all' | 'essential';

export function getConsent(): Consent | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'all' || v === 'essential' ? v : null;
  } catch {
    return null;
  }
}
export function hasAnalyticsConsent(): boolean {
  return getConsent() === 'all';
}

const CSS = `
.consent-bar {
  position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 1000;
  margin-bottom: env(safe-area-inset-bottom);
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px;
  background: #0F172A; color: #F1F4FB; border: 1px solid #243049; border-radius: 14px;
  padding: 14px 16px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
  font: 14px/1.5 'Inter', system-ui, -apple-system, sans-serif;
}
.consent-msg { flex: 1 1 260px; }
.consent-msg a { color: #6fa8f0; }
.consent-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.consent-bar button {
  font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px;
  padding: 9px 16px; border: 1px solid #33415c; background: transparent; color: #f1f4fb; min-height: 40px;
}
.consent-bar .consent-all { background: #1c6fe0; border-color: #1c6fe0; color: #fff; }
@media (max-width: 560px) { .consent-actions { width: 100%; } .consent-actions button { flex: 1; } }
`;

/** Show the consent banner once, if no choice has been made yet. */
export function installConsent(onChange?: (c: Consent) => void): void {
  if (getConsent() || document.getElementById('consent-bar')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'consent-bar';
  bar.className = 'consent-bar';
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', 'Cookie choices');

  const msg = document.createElement('span');
  msg.className = 'consent-msg';
  msg.innerHTML = t('consent.msg') + ' <a href="/legal#cookies">' + t('consent.learn') + '</a>';

  const actions = document.createElement('span');
  actions.className = 'consent-actions';
  const ess = document.createElement('button');
  ess.type = 'button';
  ess.textContent = t('consent.essential');
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'consent-all';
  all.textContent = t('consent.all');
  actions.append(ess, all);

  bar.append(msg, actions);

  const choose = (c: Consent): void => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* storage blocked — choice is session-only */
    }
    bar.remove();
    onChange?.(c);
  };
  ess.addEventListener('click', () => choose('essential'));
  all.addEventListener('click', () => choose('all'));
  document.body.appendChild(bar);
}
