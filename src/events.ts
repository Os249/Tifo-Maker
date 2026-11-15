/**
 * /events and /events/<address>: tifo events, the themed contests the admin
 * makes on /admin (server/src/eventRoutes.ts).
 *
 * The server decides everything: which stage the event is in, which tifos
 * may be entered, whether a vote is taken. This page shows what it says and
 * offers the one next step of that stage:
 *
 *   announced  "Start a tifo"
 *   open       "Enter one of my tifos" (signed out: "Sign in to enter")
 *   voting     a Vote button on every entry but your own
 *   closed     nothing to do: "Result soon"
 *   result     the podium, and the counts
 *
 * Votes are not on this page until the result is confirmed, because the
 * server does not send them. When a stage's time passes while the page is
 * open, it asks again.
 */
import { cleanAddressBar } from './core/utm';
import { track } from './net/analytics';
import './vendor/tabler-subset.css';
import './community.css';
import './events.css';
import { initLang, applyDom, getLang, localPath, onLangChange, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';
import { ensureUsernameChosen } from './ui/chooseUsernameModal';
import { hydrateBowls } from './ui/bowlPicture';
import { escapeHtml } from './core/escape';
import {
  adoptProviderSession, enterEvent, fetchEventMine, fetchEventPage, fetchMe, leaveEvent, listEvents, thumbnailUrl, voteEvent,
  type EventCard, type EventPage, type TifoEventInfo,
} from './net/api';
import { eventTitle, eventWhen, stageLine } from './ui/eventText';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const authBtn = $<HTMLButtonElement>('auth-btn');

/** The event's address from the page's own: /events/the-derby, /ar/events/the-derby. '' on /events. */
const slug = ((): string => {
  const parts = location.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('events');
  const s = at >= 0 ? parts[at + 1] ?? '' : '';
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(s) ? s : '';
})();

let page: EventPage | null = null;
let list: TifoEventInfo[] | null = null;
let missing = false;
let userId: string | null = null;
/** What the last action said, kept across repaints as a key. */
let msgKey = '';
let busy = false;
let reloadAt: ReturnType<typeof setTimeout> | null = null;

const show = (id: string, on: boolean): void => {
  $(id).hidden = !on;
};

// ------------------------------------------------------------- one event ---

function cardHtml(c: EventCard, foot: string, extraClass = ''): string {
  const thumb = c.hasThumbnail
    ? `<div class="card-thumb is-bowl"><img class="card-thumb-img" data-bowl="${thumbnailUrl(c.designId)}" alt="" /></div>`
    : '<div class="card-thumb card-thumb-empty"></div>';
  const title = getLang() === 'ar' && c.titleAr ? c.titleAr : c.title;
  const remixed = c.remixedFromName ? `<div class="card-remixed">↻ <span class="at"><bdi dir="ltr">@${escapeHtml(c.remixedFromName)}</bdi></span></div>` : '';
  return `<article class="tifo-card ${extraClass}" data-design="${escapeHtml(c.designId)}">
    ${thumb}
    <div class="card-body">
      <a class="card-title card-open" href="${localPath(`/t/${encodeURIComponent(c.designId)}`)}"><bdi>${escapeHtml(title)}</bdi></a>
      <div class="card-by">${escapeHtml(t('cm.by'))} <span class="at"><bdi dir="ltr">@${escapeHtml(c.ownerName)}</bdi></span></div>
      ${remixed}
      <div class="evp-card-foot">${foot}</div>
    </div>
  </article>`;
}

function footFor(c: EventCard, p: EventPage): string {
  const mine = c.designId === p.me.entry || (userId !== null && c.ownerId === userId);
  const tag = mine ? `<span class="evp-tag">${escapeHtml(t('ev.yours'))}</span>` : '';
  if (p.event.stage === 'result') return `${tag}<span class="evp-votes">${escapeHtml(tv('ev.votes', { n: c.votes ?? 0 }))}</span>`;
  if (p.event.stage !== 'voting' || mine) return tag;
  const on = p.me.votes.includes(c.designId);
  const title = getLang() === 'ar' && c.titleAr ? c.titleAr : c.title;
  return `<button class="evp-vote" type="button" aria-pressed="${on}" aria-label="${escapeHtml(tv('ev.voteFor', { title }))}" data-vote="${escapeHtml(c.designId)}">` +
    `<i class="ti ${on ? 'ti-heart' : 'ti-heart'}" aria-hidden="true"></i> ${escapeHtml(t(on ? 'ev.voted' : 'ev.vote'))}</button>`;
}

function paintActs(p: EventPage): void {
  const acts = $('ev-acts');
  const stage = p.event.stage;
  let html = '';
  if (stage === 'announced') {
    html = `<a class="evp-btn" href="${localPath('/projects?new=1')}">${escapeHtml(t('ev.cta.start'))}</a>`;
  } else if (stage === 'open') {
    if (!p.me.signedIn) html = `<button class="evp-btn" type="button" data-act="signin">${escapeHtml(t('ev.cta.signin'))}</button>`;
    else if (!p.me.entry) html = `<p class="evp-in">${escapeHtml(t('ev.mine.none'))}</p><button class="evp-btn" type="button" data-act="pick">${escapeHtml(t('ev.cta.enter'))}</button>`;
    else {
      const mine = p.entries.find((c) => c.designId === p.me.entry);
      const title = mine ? (getLang() === 'ar' && mine.titleAr ? mine.titleAr : mine.title) : '';
      html = `<p class="evp-in">${escapeHtml(tv('ev.mine.in', { title }))}</p>` +
        `<button class="evp-btn quiet" type="button" data-act="pick">${escapeHtml(t('ev.cta.change'))}</button>` +
        `<button class="evp-btn quiet" type="button" data-act="leave">${escapeHtml(t('ev.cta.leave'))}</button>`;
    }
  } else if (stage === 'voting' && !p.me.signedIn) {
    html = `<button class="evp-btn" type="button" data-act="signin">${escapeHtml(t('ev.cta.signinVote'))}</button>`;
  }
  acts.innerHTML = html;
}

function paintOne(p: EventPage): void {
  const e = p.event;
  const title = eventTitle(e);
  document.title = `${title} · TifoMaker`;
  $('ev-title').textContent = title;
  $('ev-line').textContent = getLang() === 'ar' ? e.lineAr || e.lineEn : e.lineEn || e.lineAr;
  $('ev-stage').textContent = t(`ev.stage.${e.stage}`);
  $('ev-when').textContent = stageLine(e);
  $('ev-prize').textContent = e.prizeDays > 0 ? tv('ev.prize', { days: e.prizeDays }) : t('ev.prizeTitle');
  $('ev-msg').textContent = msgKey ? t(msgKey) : '';
  paintActs(p);

  // The four dates, with the one the event is at marked.
  const at = { announced: 0, open: 1, voting: 2, closed: 3, result: 3 }[e.stage];
  const steps: [string, string][] = [['ev.step.announce', e.announceAt], ['ev.step.open', e.openAt], ['ev.step.vote', e.voteAt], ['ev.step.close', e.closeAt]];
  $('ev-steps').innerHTML = steps
    .map(([key, iso], i) => `<li class="${i === at ? 'now' : i < at ? 'done' : ''}"${i === at ? ' aria-current="step"' : ''}><b>${escapeHtml(t(key))}</b><span>${escapeHtml(eventWhen(iso))}</span></li>`)
    .join('');

  // The podium.
  const podium = $('ev-podium');
  if (e.stage === 'result') {
    const place = ['', 'ev.place1', 'ev.place2', 'ev.place3'];
    podium.innerHTML = p.podium.length
      ? `<h2>${escapeHtml(t('ev.stage.result'))}</h2><div class="evp-podium-grid">` +
        p.podium.map((c) => cardHtml(c, `<span class="evp-place">${escapeHtml(t(place[c.place ?? 0] || 'ev.place3'))}</span><span class="evp-votes">${escapeHtml(tv('ev.votes', { n: c.votes ?? 0 }))}</span>`, c.place === 1 ? 'first' : '')).join('') +
        '</div>'
      : `<p class="evp-note">${escapeHtml(t('ev.noWinner'))}</p>`;
    podium.hidden = false;
  } else podium.hidden = true;

  // The entries.
  const grid = $('ev-grid');
  const hint = $('ev-hint');
  const listed = e.stage === 'result' ? p.entries.filter((c) => !((c.place ?? 0) > 0)).length : p.entries.length;
  $('ev-count').textContent = e.stage === 'announced' ? '' : String(listed);
  hint.hidden = false;
  if (e.stage === 'announced') hint.textContent = t('ev.entries.soon');
  else if (!p.entries.length) hint.textContent = t(e.stage === 'open' ? 'ev.entries.none' : 'ev.entries.noneLate');
  else if (e.stage === 'voting') hint.textContent = t('ev.voteHint');
  else hint.hidden = true;
  show('ev-entries', !(e.stage === 'result' && p.entries.length > 0 && p.entries.every((c) => (c.place ?? 0) > 0)));
  // At the result the podium has its three already: the list is everyone else.
  grid.innerHTML = p.entries
    .filter((c) => !(e.stage === 'result' && (c.place ?? 0) > 0))
    .map((c) => cardHtml(c, footFor(c, p), c.designId === p.me.entry ? 'mine' : ''))
    .join('');
  hydrateBowls(grid);
  hydrateBowls(podium);

  // Taken out, with the reason.
  show('ev-out', p.out.length > 0);
  $('ev-out-list').innerHTML = p.out
    .map((c) => `<li><b><bdi>${escapeHtml(getLang() === 'ar' && c.titleAr ? c.titleAr : c.title)}</bdi></b> <bdi dir="ltr">@${escapeHtml(c.ownerName)}</bdi>. ${escapeHtml(tv('ev.out.reason', { reason: c.reason ?? '' }))}</li>`)
    .join('');
  ($('ev-back') as HTMLAnchorElement).href = localPath('/events');
}

function paintIndex(rows: TifoEventInfo[]): void {
  show('ev-index-none', rows.length === 0);
  $('ev-list').innerHTML = rows
    .map((e) => `<li><a href="${localPath(`/events/${encodeURIComponent(e.slug)}`)}"><b><bdi>${escapeHtml(eventTitle(e))}</bdi></b><span>${escapeHtml(t(`ev.stage.${e.stage}`))} · ${escapeHtml(stageLine(e))}</span></a></li>`)
    .join('');
}

function paint(): void {
  show('ev-loading', !page && !list && !missing);
  show('ev-one', !!page);
  show('ev-index', !page && (!!list || missing));
  if (page) paintOne(page);
  else if (list || missing) {
    paintIndex(list ?? []);
    // An address with no event behind it: say so above the list.
    const none = $('ev-index-none');
    if (missing) {
      none.hidden = false;
      none.textContent = t('ev.notFound');
    } else none.textContent = t('ev.index.none');
  }
}

/** Ask again when the stage's time passes while the page is open. */
function watchStage(): void {
  if (reloadAt) clearTimeout(reloadAt);
  reloadAt = null;
  const ends = page?.event.stageEnds;
  if (!ends) return;
  const ms = Date.parse(ends) - Date.now() + 1500;
  if (ms > 0 && ms < 24 * 3600_000) reloadAt = setTimeout(() => void load(), ms);
}

async function load(first = false): Promise<void> {
  try {
    if (slug) {
      page = await fetchEventPage(slug);
      missing = !page;
      if (!page) list = await listEvents();
    } else list = await listEvents();
  } catch {
    if (!page && !list) list = [];
    msgKey = 'ev.msg.fail';
  }
  paint();
  watchStage();
  if (first && page) track('event_view');
}

// ---------------------------------------------------------------- actions ---

async function signIn(): Promise<void> {
  const { openAuthModal } = await import('./ui/authModal');
  if (!(await openAuthModal(true, 'signin'))) return;
  await refreshAuth();
  await load();
}

function say(key: string): void {
  msgKey = key;
  $('ev-msg').textContent = key ? t(key) : '';
}

/** What a refusal's short reason reads as; a stage that has just moved on also reloads the page. */
async function refused(code: string): Promise<void> {
  if (code === 'signin') return void signIn();
  const known = ['verify_first', 'own', 'closed', 'too_old', 'not_public', 'not_yours', 'template', 'taken'];
  msgKey = known.includes(code) ? `ev.err.${code}` : 'ev.msg.fail';
  await load();
}

async function openPicker(): Promise<void> {
  if (!page) return;
  const dlg = $<HTMLDialogElement>('ev-pick');
  const listEl = $('ev-pick-list');
  const note = $('ev-pick-note');
  listEl.innerHTML = '';
  note.hidden = true;
  show('ev-pick-start', false);
  if (!dlg.open) dlg.showModal();
  let mine: { designs: { id: string; title: string }[]; older: number };
  try {
    mine = await fetchEventMine(page.event.slug);
  } catch {
    dlg.close();
    say('ev.msg.fail');
    return;
  }
  const current = page.me.entry;
  listEl.innerHTML = mine.designs
    .map((d) => `<button class="evp-pick-item" type="button" data-pick="${escapeHtml(d.id)}"${d.id === current ? ' aria-current="true"' : ''}><bdi>${escapeHtml(d.title)}</bdi>${d.id === current ? `<small>${escapeHtml(t('ev.pick.current'))}</small>` : ''}</button>`)
    .join('');
  if (!mine.designs.length) {
    note.hidden = false;
    note.textContent = tv('ev.pick.none', { when: eventWhen(page.event.announceAt) }) + (mine.older ? ` ${t('ev.pick.older')}` : '');
    show('ev-pick-start', true);
    ($('ev-pick-start') as HTMLAnchorElement).href = localPath('/projects?new=1');
  } else if (mine.older) {
    note.hidden = false;
    note.textContent = t('ev.pick.older');
  }
}

async function act(run: () => Promise<{ ok: true } | { ok: false; code: string }>, doneKey: string, event?: 'event_enter' | 'event_vote'): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const r = await run();
    if (!r.ok) return await refused(r.code);
    msgKey = doneKey;
    if (event) track(event);
    await load();
  } catch {
    say('ev.msg.fail');
  } finally {
    busy = false;
  }
}

$('ev-acts').addEventListener('click', (ev) => {
  const what = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!what || !page) return;
  if (what === 'signin') void signIn();
  else if (what === 'pick') void openPicker();
  else if (what === 'leave') void act(() => leaveEvent(page!.event.slug), 'ev.msg.left');
});

$('ev-pick-list').addEventListener('click', (ev) => {
  const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-pick]')?.dataset.pick;
  if (!id || !page) return;
  $<HTMLDialogElement>('ev-pick').close();
  void act(() => enterEvent(page!.event.slug, id), 'ev.msg.entered', 'event_enter');
});
$('ev-pick-close').addEventListener('click', () => $<HTMLDialogElement>('ev-pick').close());

$('ev-grid').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-vote]');
  if (!btn || !page) return;
  if (!page.me.signedIn) return void signIn();
  const id = btn.dataset.vote as string;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  void act(() => voteEvent(page!.event.slug, id, on), '', on ? 'event_vote' : undefined);
});

// ------------------------------------------------------------------ boot ---

async function refreshAuth(): Promise<void> {
  const me = await fetchMe().catch(() => null);
  const named = await ensureUsernameChosen(me);
  userId = named?.id ?? null;
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
  await load(true);
})();
