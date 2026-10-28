/**
 * /pro: what Pro adds and what it costs, and the one next step that exists
 * right now.
 *
 * Every number on the page is the server's (/api/pro → offer.limits, prices
 * and dates from server/src/proPlan.ts), so an offer changes in one file. Until
 * the server says Pro is on for this visitor, the page shows only "not open
 * yet": in preview, nobody off the list learns the prices from it.
 *
 * Payments are not open (OFFER.paymentsOpen), so the one blue button is "Tell
 * me when Pro opens", or "Use my Pro gift" for an account with one waiting.
 */
import { cleanAddressBar } from './core/utm';
import { track } from './net/analytics';
import './vendor/tabler-subset.css';
import './community.css';
import './proPage.css';
import { initLang, applyDom, localPath, onLangChange, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { escapeHtml } from './core/escape';
import { adoptProviderSession, fetchMe, fetchPro, notifyPro, type AllowanceKind, type PlanLimits, type ProState } from './net/api';
import { CROWN_SVG, endsText, mountProChip, proChipHtml, whenDay } from './ui/pro';
import { openGiftSheet } from './ui/proSheets';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const authBtn = $<HTMLButtonElement>('auth-btn');

let state: ProState | null = null;
/** Nothing is painted until /api/pro has answered once. */
let loaded = false;

/** "3 a week"; "10 a day" over "150 a month", one window to a line. */
function limitHtml(l: PlanLimits[AllowanceKind] | undefined): string {
  if (!l?.length) return escapeHtml(t('pp.notIncluded'));
  return l.map((w) => `<span>${escapeHtml(tv(`pp.per.${w.period}`, { n: w.limit }))}</span>`).join('');
}

const ROWS: AllowanceKind[] = ['super', 'std', 'polish', 'cutout', 'photo'];

function planCard(o: { id: string; name: string; price: string; sub: string; best?: boolean; limits: PlanLimits | undefined; pro: boolean }): string {
  const rows = ROWS.map((k) => `<li><span>${escapeHtml(t(`pp.row.${k}`))}</span><b class="pp-lim">${limitHtml(o.limits?.[k])}</b></li>`);
  const yes = `<b class="pp-yes">${CROWN_SVG}<span>${escapeHtml(t('pp.included'))}</span></b>`;
  const no = `<b class="pp-no">${escapeHtml(t('pp.notIncluded'))}</b>`;
  rows.push(`<li><span>${escapeHtml(t('pp.row.mark'))}</span>${o.pro ? yes : no}</li>`);
  rows.push(`<li><span>${escapeHtml(t('pp.row.badge'))}</span>${o.pro ? yes : no}</li>`);
  rows.push(`<li><span>${escapeHtml(t('pp.row.free'))}</span><b>${escapeHtml(t('pp.unlimited'))}</b></li>`);
  return (
    `<article class="pp-plan${o.best ? ' best' : ''}${o.pro ? ' pro' : ''}" aria-labelledby="pp-plan-${o.id}">` +
    (o.best ? `<p class="pp-best">${escapeHtml(t('pp.season.best'))}</p>` : '') +
    `<h2 id="pp-plan-${o.id}">${escapeHtml(o.name)}${o.pro ? ` ${proChipHtml()}` : ''}</h2>` +
    `<p class="pp-price">${escapeHtml(o.price)}</p>` +
    `<p class="pp-sub">${escapeHtml(o.sub)}</p>` +
    `<ul class="pp-rows">${rows.join('')}</ul></article>`
  );
}

function paint(): void {
  if (!loaded) return;
  const st = state;
  const wait = $('pp-wait');
  const open = $('pp-open');
  const closed = $('pp-closed');
  wait.hidden = true;
  if (!st?.live || !st.offer) {
    open.hidden = true;
    closed.hidden = false;
    return;
  }
  closed.hidden = true;
  open.hidden = false;
  const o = st.offer;
  $('pp-crown').innerHTML = CROWN_SVG;
  const lim = o.limits;
  $('pp-plans').innerHTML =
    planCard({ id: 'free', name: t('pp.free.name'), price: tv('pp.price', { n: 0 }), sub: t('pp.free.sub'), limits: lim?.free, pro: false }) +
    planCard({ id: 'match', name: t('ac.pro.plan.match'), price: tv('pp.price', { n: o.match.price }), sub: tv('pp.match.sub', { hours: o.match.hours }), limits: lim?.match, pro: true }) +
    planCard({
      id: 'season', name: t('pp.season.name'), price: tv('pp.price', { n: o.season.price }),
      sub: tv('pp.season.sub', { date: whenDay(o.season.endsAt) }), best: true, limits: lim?.season, pro: true,
    });
  $('pp-group-body').textContent = tv('pp.group.body', { price: o.group.from });
  $('pp-small').textContent = `${tv('pp.credit', { days: o.matchCreditDays })} ${t('pp.noRenew')}`;

  // Who is looking: a pass running, a gift waiting, or neither.
  const you = $('pp-you');
  const plan = st.plan ?? 'free';
  const holder = !!st.pass && plan !== 'free';
  if (holder && st.pass) {
    you.hidden = false;
    you.innerHTML =
      `${CROWN_SVG}<span>${escapeHtml(tv('pp.youHave', { plan: t(`ac.pro.plan.${plan}`), date: endsText(st.pass.endsAt) }))}</span>` +
      `<a href="${escapeHtml(localPath('/account'))}#pro">${escapeHtml(t('ac.pro.title'))}</a>`;
  } else {
    you.hidden = true;
  }
  // A pass running: nothing to ask for, so no button at all.
  $('pp-act').hidden = holder;
  if (holder) return;
  const note = $('pp-act-note');
  const row = $('pp-act-row');
  const msg = $('pp-msg');
  msg.textContent = '';
  if (!st.signedIn) {
    note.textContent = t('pp.closed');
    row.innerHTML = `<button type="button" class="pp-btn" data-act="signin">${escapeHtml(t('pp.signInToNotify'))}</button>`;
    row.querySelector('[data-act="signin"]')!.addEventListener('click', () => void signIn());
    return;
  }
  if (st.gift?.state === 'offered') {
    note.textContent = tv('ac.pro.giftWaiting', { n: st.gift.days });
    row.innerHTML = `<button type="button" class="pp-btn" data-act="gift">${escapeHtml(t('pro.act.useGift'))}</button>`;
    row.querySelector('[data-act="gift"]')!.addEventListener('click', async () => {
      if (await openGiftSheet(st)) await load(true);
    });
    return;
  }
  note.textContent = t('pp.closed');
  row.innerHTML = `<button type="button" class="pp-btn" data-act="notify"${st.notified ? ' disabled' : ''}>${escapeHtml(t(st.notified ? 'pro.act.notified' : 'pro.act.notify'))}</button>`;
  const btn = row.querySelector('[data-act="notify"]') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (await notifyPro()) {
      track('pro_notify');
      btn.textContent = t('pro.act.notified');
      msg.textContent = t('pro.notify.done');
    } else {
      btn.disabled = false;
      msg.textContent = t('pro.notify.failed');
    }
  });
}

async function load(fresh = false): Promise<void> {
  state = await fetchPro(fresh).catch(() => null);
  loaded = true;
  paint();
  if (state?.live) track('pro_viewed');
}

async function refreshAuth(): Promise<void> {
  const me = await fetchMe().catch(() => null);
  const named = await ensureUsernameChosen(me);
  if (named) {
    authBtn.removeAttribute('data-i18n');
    authBtn.textContent = `@${named.username}`;
    authBtn.classList.add('is-user');
    authBtn.onclick = () => location.assign(localPath('/account'));
  } else {
    authBtn.setAttribute('data-i18n', 'ed.signup');
    authBtn.textContent = t('ed.signup');
    authBtn.classList.remove('is-user');
    authBtn.onclick = () => void signIn();
  }
}

async function signIn(): Promise<void> {
  const { openAuthModal } = await import('./ui/authModal');
  if (!(await openAuthModal(true, 'signin'))) return;
  await refreshAuth();
  await load(true);
}

// ------------------------------------------------------------------ boot ---

initLang();
cleanAddressBar();
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
applyDom(document);
installMobileNav();
installConsent();

const langToggle = $('lang-toggle');
langToggle.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  langToggle.textContent = t('common.language');
});
onLangChange(() => {
  setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });
  paint();
});
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});

void (async () => {
  await adoptProviderSession();
  await refreshAuth();
  if (authBtn.parentElement) mountProChip(authBtn.parentElement, authBtn);
  await load();
})();
