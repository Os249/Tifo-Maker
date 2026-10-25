/**
 * The start flow: the one door into the editor.
 *
 * It used to open on a name field and a grid of 87 stadiums, and then the
 * editor asked a second set of questions (a colour scheme, a starter, a
 * pattern) in a first-run dialog of its own. Two dialogs, and neither asked the
 * question a fan actually starts from: who do you support?
 *
 * So it asks that, and everything else follows from the answer:
 *
 *   1. CLUB. A grid of clubs, each with its scarf colours and its ground.
 *      Picking one puts you in its home ground, in its colours, and names the
 *      project "Al Hilal at Kingdom Arena". No club, or a club that is not
 *      listed? Type it, or go straight to a ground.
 *   2. GROUND. Only when there is no club, or the fan wants another ground.
 *      The ground decides the seats (how many, in what shape), so it is fixed
 *      for the life of the project, and this step says so.
 *   3. START. How the stand looks when the editor opens: the club's tifo drawn
 *      across the bowl by the free offline designer, stripes in the club's
 *      colours, an empty stand, or a prompt for the AI. A club the app has no
 *      colours for gets a row of twelve swatches instead of a guess.
 *
 * A returning fan sees their club first, and the AI entry point (Generate a
 * tifo) lands on step 3 with the AI already chosen.
 *
 * What it hands the editor is a NewProjectIntent (core/projects.ts); the
 * editor applies `start` before the project is first saved, so the saved
 * starting point is the one they chose.
 */

// The index, not the catalogue: names, tags and counts, no geometry (performance plan P2.7).
import { LEAGUES, STADIUM_INDEX, type StadiumIndexEntry as StadiumEntry } from '../core/stadiumIndex';
import { DEFAULT_TEMPLATE } from '../core/template';
import {
  CLUB_STARTS, COLOUR_CHOICES, clubBrief, clubById, clubColours, clubPalette, clubsAt, paletteFrom, type ClubStart,
} from '../core/clubGrounds';
import { newProjectUrl, nextDefaultName, stashNewProject, type NewProjectIntent } from '../core/projects';
import { loadFavorites } from './stadiumFavorites';
import { escapeHtml } from '../core/escape';
import { fetchAiQuota, fetchMe, isSignedIn, type AiError } from '../net/api';
import { getLang, localPath, t, tl, tv } from './i18n';

const LAST_STADIUM_KEY = 'tifo_last_stadium_v1';
const LAST_CLUB_KEY = 'tifo_last_club_v1';
const CLUB_COLOURS_KEY = 'tifo_club_colours_v1';

export interface CreateProjectOptions {
  /** Start on the AI side (the "Generate a tifo" entry point). */
  ai?: boolean;
  /** The name to offer when there is no club: the next free "My tifo n". */
  defaultName: string;
  /** Names already in use, so "Al Hilal at Kingdom Arena" becomes "… 2". */
  takenNames?: string[];
  /** Open on this club (a CLUB_STARTS id), e.g. from a link on the landing page. */
  club?: string | null;
  /** Open on this ground (a catalogue id) with no club. */
  ground?: string | null;
  /** Open on this league's clubs (or, for a league with none listed, its grounds). */
  league?: string | null;
  /** Called when the panel needs someone to sign in or sign up. Resolves true when they did. */
  signIn: (startOn?: 'signin' | 'signup') => Promise<boolean>;
  /** Where the browser goes. Swappable so tests and the page can observe it. */
  navigate?: (url: string) => void;
}

type Step = 'club' | 'ground' | 'start';
type StartKind = 'club' | 'pattern' | 'blank' | 'ai';

/** The club being made for: one from the list, one typed in, or none. */
type Pick =
  | { kind: 'known'; club: ClubStart }
  | { kind: 'custom'; name: string };

const PATTERNS = ['hoops', 'split', 'sash', 'columns', 'gradient'] as const;

type AiGate =
  | { kind: 'ok'; left: number | null; unlimited: boolean }
  | { kind: 'signin' }
  | { kind: 'verify' }
  | { kind: 'empty'; resetInSec: number };

// ------------------------------------------------------------ storage ---

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* next time simply starts without it */
  }
}

/**
 * The last club picked: a CLUB_STARTS id, or "custom:<name>|<ground id>" for
 * one typed in, which has no home ground on file but did have a ground.
 */
function lastPick(): { pick: Pick; ground: string | null } | null {
  const v = read(LAST_CLUB_KEY);
  if (!v) return null;
  if (v.startsWith('custom:')) {
    const [name, ground] = v.slice(7).split('|');
    return name?.trim() ? { pick: { kind: 'custom', name: name.trim() }, ground: ground || null } : null;
  }
  const club = clubById(v);
  return club ? { pick: { kind: 'known', club }, ground: club.ground } : null;
}

function rememberPick(pick: Pick | null, groundId: string): void {
  if (!pick) return;
  write(LAST_CLUB_KEY, pick.kind === 'known' ? pick.club.id : `custom:${pick.name.replace(/\|/g, ' ').slice(0, 60)}|${groundId}`);
}

/** Colours a fan picked for a club we have none for, kept per club. */
function savedColours(key: string): string[] | null {
  try {
    const all = JSON.parse(read(CLUB_COLOURS_KEY) ?? '{}') as Record<string, string[]>;
    const v = all[key];
    return Array.isArray(v) && v.length === 2 && v.every((w) => COLOUR_CHOICES.some((c) => c.word === w)) ? v : null;
  } catch {
    return null;
  }
}

function saveColours(key: string, words: string[]): void {
  try {
    const all = JSON.parse(read(CLUB_COLOURS_KEY) ?? '{}') as Record<string, string[]>;
    all[key] = words;
    write(CLUB_COLOURS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ helpers ---

const fmt = (n: number): string => n.toLocaleString('en-US');

/** "Kingdom Arena (Riyadh)" → "Kingdom Arena": the city is for the list, not the name. */
function groundShort(id: string): string {
  return tl(id).replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim() || tl(id);
}

const pickName = (p: Pick): string =>
  p.kind === 'known' ? (getLang() === 'ar' ? p.club.ar : p.club.en) : p.name;

const pickKey = (p: Pick): string => (p.kind === 'known' ? p.club.id : `custom:${p.name.toLowerCase()}`);

/** The club's own colours, or null when the fan has to pick them. */
const ownColours = (p: Pick | null): [string, string] | null =>
  p?.kind === 'known' ? clubColours(p.club) : null;

const hexOf = (word: string): string => COLOUR_CHOICES.find((c) => c.word === word)?.hex ?? '#1c5fd9';

/** Can this person generate right now, and if not, what is the one fix? */
async function readAiGate(): Promise<AiGate> {
  if (!isSignedIn()) return { kind: 'signin' };
  const me = await fetchMe().catch(() => null);
  if (!me) return { kind: 'signin' };
  if (!me.emailVerified) return { kind: 'verify' };
  try {
    const q = await fetchAiQuota();
    if (q.unlimited) return { kind: 'ok', left: null, unlimited: true };
    if (q.remaining <= 0) return { kind: 'empty', resetInSec: q.resetInSec ?? 3600 };
    return { kind: 'ok', left: q.remaining, unlimited: false };
  } catch (e) {
    const err = e as AiError;
    if (err.reason === 'verify') return { kind: 'verify' };
    if (err.reason === 'signin' || err.status === 401) return { kind: 'signin' };
    // Anything else (the quota endpoint being down) is not a reason to refuse:
    // the editor reports the real outcome of the generation itself.
    return { kind: 'ok', left: null, unlimited: false };
  }
}

function waitLabel(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? tv('np.inH', { n: fmt(Math.round(m / 60)) }) : tv('np.inMin', { n: fmt(m) });
}

/** A scarf: two colours in stripes, as a CSS custom-property pair. */
function scarfStyle(colours: [string, string] | null): string {
  return colours ? ` style="--c1:${colours[0]};--c2:${colours[1]}"` : '';
}

/**
 * The little stand on each start card, in the colours the tifo will have, so
 * the choice is a picture rather than a word.
 */
function startArt(kind: StartKind, c1: string, c2: string, pattern: string): string {
  const style = `--c1:${c1};--c2:${c2}`;
  if (kind === 'pattern') return `<span class="st-art st-art-${pattern}" style="${style}" aria-hidden="true"></span>`;
  return `<span class="st-art st-art-${kind}" style="${style}" aria-hidden="true">${kind === 'ai' ? '<i>✦</i>' : ''}</span>`;
}

// ------------------------------------------------------------ the flow ---

export function openCreateProject(opts: CreateProjectOptions): void {
  const go = opts.navigate ?? ((url: string) => location.assign(url));
  const taken = opts.takenNames ?? [];
  const favs = loadFavorites();
  const grounds = STADIUM_INDEX.filter((e) => e.meta.source === 'builtin');
  const groundById = (id: string | null | undefined): StadiumEntry | undefined =>
    id ? grounds.find((e) => e.id === id) : undefined;

  const last = lastPick();
  const remembered = last?.pick ?? null;
  const linkedClub = clubById(opts.club);
  const linkedGround = groundById(opts.ground);

  let pick: Pick | null = linkedClub ? { kind: 'known', club: linkedClub } : null;
  let ground: StadiumEntry =
    linkedGround ??
    (pick?.kind === 'known' ? groundById(pick.club.ground) : undefined) ??
    groundById(read(LAST_STADIUM_KEY)) ??
    groundById(DEFAULT_TEMPLATE.id) ??
    grounds[0]!;
  let step: Step = linkedClub || linkedGround ? 'start' : 'club';
  /** The steps behind this one, for Back. */
  const trail: Step[] = [];
  let start: StartKind = opts.ai ? 'ai' : 'club';
  let pattern: string = PATTERNS[0];
  let colourWords: string[] = ['blue', 'white'];
  let nameEdited = false;
  let gate: AiGate | null = null;
  let gateAsked = false;

  // A league picked on the home page: its clubs, or its grounds when none of
  // its clubs are listed.
  const league = !linkedClub && !linkedGround && !opts.ai && opts.league && LEAGUES.some((l) => l.tag === opts.league) ? opts.league : null;
  if (league && !CLUB_STARTS.some((c) => c.league === league)) {
    step = 'ground';
    start = 'pattern';
  }

  // The AI entry point opens on the last step, for the club they had last time.
  if (opts.ai && !linkedClub && !linkedGround) {
    step = 'start';
    pick = remembered;
    ground = groundById(last?.ground) ?? ground;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'np-backdrop';
  backdrop.innerHTML = `
    <div class="np-modal st-modal" role="dialog" aria-modal="true" aria-labelledby="np-h">
      <div class="st-head">
        <button type="button" class="np-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        <ol class="st-steps" aria-label="${escapeHtml(t('hero.workflow'))}"><li data-s="club">${escapeHtml(t('st.yours'))}</li><li data-s="ground">${escapeHtml(t('st.grounds'))}</li><li data-s="start">${escapeHtml(t('st.h.start'))}</li></ol>
        <h2 class="np-h" id="np-h" tabindex="-1"></h2>
        <p class="st-lead" id="st-lead"></p>
      </div>
      <div class="st-body" id="st-body"></div>
      <div class="np-foot st-foot">
        <p class="np-gate" id="np-gate" hidden></p>
        <div class="np-actions" id="np-actions"></div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string): T => backdrop.querySelector(sel) as T;
  const modal = $<HTMLElement>('.np-modal');
  const heading = $<HTMLElement>('#np-h');
  const lead = $<HTMLElement>('#st-lead');
  const body = $<HTMLElement>('#st-body');
  const gateEl = $<HTMLElement>('#np-gate');
  const actions = $<HTMLElement>('#np-actions');

  // Everything behind the dialog is inert while it is up, cookie banner
  // excepted: it must stay answerable.
  const inertTargets = Array.from(document.body.children).filter(
    (el) => el !== backdrop && el instanceof HTMLElement && !el.hasAttribute('data-stays-live'),
  ) as HTMLElement[];
  for (const el of inertTargets) el.inert = true;
  const opener = document.activeElement as HTMLElement | null;

  const close = (): void => {
    for (const el of inertTargets) el.inert = false;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // The auth dialog, opened from here, handles its own Escape.
      if (document.querySelector('.auth-backdrop, .auth-modal')) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // The cookie banner's buttons are part of the loop while it is up, after
    // the dialog's own: a keyboard user has to be able to answer it too.
    const sel = 'button:not([disabled]),input,textarea,a[href],[tabindex="0"]';
    const live = Array.from(document.querySelectorAll<HTMLElement>('[data-stays-live]'));
    const focusable = [backdrop, ...live]
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>(sel)))
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    // Moved by hand, every time: the cookie banner sits before this dialog in
    // the page, so the browser's own order would walk out of both.
    e.preventDefault();
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = at < 0
      ? (e.shiftKey ? focusable[focusable.length - 1] : focusable[0])
      : focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
    next?.focus();
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  $<HTMLButtonElement>('.np-close').addEventListener('click', close);

  // ---------------------------------------------------------- naming ---
  const autoName = (): string => {
    if (!pick) return opts.defaultName;
    const base = tv('st.nameAt', { club: pickName(pick), ground: groundShort(ground.id) }).slice(0, 80);
    return nextDefaultName(base, taken);
  };

  // ---------------------------------------------------------- step 1 ---
  const clubCard = (c: ClubStart, yours = false): string => {
    const name = getLang() === 'ar' ? c.ar : c.en;
    const colours = clubColours(c);
    return `<button type="button" class="st-club${yours ? ' yours' : ''}" data-club="${escapeHtml(c.id)}">
      <span class="st-scarf${colours ? '' : ' none'}"${scarfStyle(colours)}></span>
      <span class="st-club-name">${escapeHtml(name)}</span>
      <span class="st-club-ground">${escapeHtml(groundShort(c.ground))}</span>
    </button>`;
  };

  const renderClubStep = (): void => {
    heading.textContent = t('st.h.club');
    lead.textContent = t('st.lead.club');
    body.innerHTML = `
      <input type="search" class="np-input st-search" id="st-search" placeholder="${escapeHtml(t('st.search'))}" aria-label="${escapeHtml(t('st.search'))}" autocomplete="off" spellcheck="false" />
      <div id="st-results" class="st-results"></div>`;
    const search = $<HTMLInputElement>('#st-search');
    const results = $<HTMLElement>('#st-results');

    const draw = (): void => {
      const q = search.value.trim().toLowerCase();
      if (!q) {
        const parts: string[] = [];
        if (remembered) {
          parts.push(`<h3 class="st-group">${escapeHtml(t('st.yours'))}</h3><div class="st-clubs">${
            remembered.kind === 'known'
              ? clubCard(remembered.club, true)
              : `<button type="button" class="st-club yours" data-custom="${escapeHtml(remembered.name)}">
                   <span class="st-scarf"${scarfStyle(((w) => (w ? [hexOf(w[0]!), hexOf(w[1]!)] as [string, string] : null))(savedColours(pickKey(remembered))))}></span>
                   <span class="st-club-name">${escapeHtml(remembered.name)}</span>
                 </button>`
          }</div>`);
        }
        for (const lg of LEAGUES) {
          const clubs = CLUB_STARTS.filter((c) => c.league === lg.tag);
          if (!clubs.length) continue;
          parts.push(`<h3 class="st-group" data-league="${lg.tag}">${escapeHtml(t(lg.key))}</h3><div class="st-clubs">${clubs.map((c) => clubCard(c)).join('')}</div>`);
        }
        results.innerHTML = parts.join('');
        return;
      }
      const clubs = CLUB_STARTS.filter((c) => `${c.en} ${c.ar} ${tl(c.ground)}`.toLowerCase().includes(q));
      const gs = grounds.filter((e) =>
        `${tl(e.id)} ${e.meta.name} ${(e.meta.tags ?? []).join(' ')} ${e.meta.country ?? ''}`.toLowerCase().includes(q),
      );
      const typed = search.value.trim().slice(0, 40);
      const exact = CLUB_STARTS.some((c) => c.en.toLowerCase() === q || c.ar === typed);
      results.innerHTML = `
        ${clubs.length ? `<div class="st-clubs">${clubs.map((c) => clubCard(c)).join('')}</div>` : ''}
        ${exact ? '' : `<button type="button" class="st-custom" id="st-custom" data-custom="${escapeHtml(typed)}">
            <span class="st-scarf none"></span><span>${escapeHtml(tv('st.other', { name: typed }))}</span><i aria-hidden="true">→</i>
          </button>`}
        ${gs.length ? `<h3 class="st-group">${escapeHtml(t('st.grounds'))}</h3><div class="st-grounds">${gs.slice(0, 12).map(groundRow).join('')}</div>` : ''}`;
    };
    draw();
    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter takes the first thing listed: a club, or "make a tifo for …".
      (results.querySelector('.st-club, .st-custom, .st-ground') as HTMLElement | null)?.click();
    });
    results.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.st-club, .st-custom, .st-ground');
      if (!el) return;
      if (el.dataset.club) {
        const club = clubById(el.dataset.club)!;
        pick = { kind: 'known', club };
        ground = groundById(club.ground) ?? ground;
        if (start !== 'ai') start = 'club';
        goTo('start', 'club');
      } else if (el.dataset.custom !== undefined) {
        const name = el.dataset.custom.trim();
        if (!name) return;
        pick = { kind: 'custom', name };
        if (start !== 'ai') start = 'club';
        // A club we do not know has no home ground on file: ask for it, unless
        // this is the one they made last time, whose ground is remembered.
        const known = el.classList.contains('yours') ? groundById(last?.ground) : undefined;
        if (known) {
          ground = known;
          goTo('start', 'club');
        } else goTo('ground', 'club');
      } else if (el.dataset.id) {
        // A ground straight from search: no club.
        pick = null;
        ground = groundById(el.dataset.id) ?? ground;
        if (start === 'club') start = 'pattern';
        goTo('start', 'club');
      }
    });
  };

  // ---------------------------------------------------------- step 2 ---
  function groundRow(e: StadiumEntry): string {
    const on = e.id === ground.id;
    const home = clubsAt(e.id).map((c) => (getLang() === 'ar' ? c.ar : c.en));
    const homeLine = home.length ? tv('st.homeOf', { clubs: home.join(getLang() === 'ar' ? ' و' : ' & ') }) : '';
    return `<button type="button" class="st-ground${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-id="${escapeHtml(e.id)}">
      <span class="st-ground-name">${favs.has(e.id) ? `<span class="np-fav" aria-label="${escapeHtml(t('np.fav'))}">★</span>` : ''}${escapeHtml(tl(e.id))}</span>
      <span class="st-ground-meta">${escapeHtml(tv('np.seats', { seats: fmt(e.meta.capacity ?? 0) }))}${homeLine ? ` · ${escapeHtml(homeLine)}` : ''}</span>
    </button>`;
  }

  const renderGroundStep = (): void => {
    heading.textContent = t('st.h.ground');
    // Only a club we do not know is asked where it plays; a listed club is
    // here because the fan wants a ground other than its home.
    lead.textContent = pick?.kind === 'custom' ? tv('st.lead.groundFor', { club: pickName(pick) }) : t('np.fixed');
    body.innerHTML = `
      <input type="search" class="np-input st-search" id="st-search" placeholder="${escapeHtml(t('np.stadiumSearch'))}" aria-label="${escapeHtml(t('np.stadiumSearch'))}" autocomplete="off" spellcheck="false" />
      <div id="st-results" class="st-results" role="radiogroup" aria-label="${escapeHtml(t('np.stadium'))}"></div>`;
    const search = $<HTMLInputElement>('#st-search');
    const results = $<HTMLElement>('#st-results');
    const draw = (): void => {
      const q = search.value.trim().toLowerCase();
      const match = (e: StadiumEntry): boolean =>
        !q || `${tl(e.id)} ${e.meta.name} ${(e.meta.tags ?? []).join(' ')} ${e.meta.country ?? ''} ${clubsAt(e.id).map((c) => `${c.en} ${c.ar}`).join(' ')}`.toLowerCase().includes(q);
      const parts: string[] = [];
      const favList = grounds.filter((e) => favs.has(e.id) && match(e));
      if (favList.length && !q) parts.push(`<h3 class="st-group">${escapeHtml(t('st.favs'))}</h3><div class="st-grounds">${favList.map(groundRow).join('')}</div>`);
      const seen = new Set<string>();
      for (const lg of LEAGUES) {
        const list = grounds.filter((e) => (e.meta.tags ?? []).includes(lg.tag) && match(e));
        list.forEach((e) => seen.add(e.id));
        if (list.length) parts.push(`<h3 class="st-group" data-league="${lg.tag}">${escapeHtml(t(lg.key))}</h3><div class="st-grounds">${list.map(groundRow).join('')}</div>`);
      }
      const rest = grounds.filter((e) => !seen.has(e.id) && match(e));
      if (rest.length) parts.push(`<h3 class="st-group">${escapeHtml(t('st.moreGrounds'))}</h3><div class="st-grounds">${rest.map(groundRow).join('')}</div>`);
      results.innerHTML = parts.length ? parts.join('') : `<p class="np-none">${escapeHtml(t('np.noStadium'))}</p>`;
    };
    draw();
    search.addEventListener('input', draw);
    results.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.st-ground');
      if (!el?.dataset.id) return;
      ground = groundById(el.dataset.id) ?? ground;
      if (!pick && start === 'club') start = 'pattern';
      goTo('start', 'ground');
    });
    // The current ground in view, so "Change ground" does not open at the top
    // of a list of 87 with the selection out of sight.
    requestAnimationFrame(() => results.querySelector('.st-ground.on')?.scrollIntoView({ block: 'center' }));
  };

  // ---------------------------------------------------------- step 3 ---
  /** The tifo's two lead colours: the club's own, or the ones picked here. */
  const leadColours = (): [string, string] =>
    ownColours(pick) ?? [hexOf(colourWords[0]!), hexOf(colourWords[1] ?? colourWords[0]!)];

  const palette = (): string[] => {
    if (pick?.kind === 'known') {
      const own = clubPalette(pick.club);
      if (own) return own;
    }
    return paletteFrom(colourWords.map(hexOf));
  };

  const needsColours = (): boolean => !ownColours(pick);

  const renderStartStep = (): void => {
    heading.textContent = t('st.h.start');
    lead.textContent = '';
    if (pick && needsColours()) colourWords = savedColours(pickKey(pick)) ?? colourWords;
    const [c1, c2] = leadColours();
    const capacity = tv('np.seats', { seats: fmt(ground.meta.capacity ?? 0) });
    const tiers = ground.tiers;
    const facts = tiers === 1
      ? tv('np.facts1', { seats: fmt(ground.meta.capacity ?? 0), sections: fmt(ground.sections) })
      : tv('np.facts', { seats: fmt(ground.meta.capacity ?? 0), tiers: fmt(tiers), sections: fmt(ground.sections) });
    const options: StartKind[] = pick ? ['club', 'pattern', 'blank', 'ai'] : ['pattern', 'blank', 'ai'];
    if (!options.includes(start)) start = 'pattern';
    const labels: Record<StartKind, [string, string]> = {
      club: ['st.o.club', 'st.o.club.b'],
      pattern: ['st.o.pattern', 'st.o.pattern.b'],
      blank: ['st.o.blank', 'st.o.blank.b'],
      ai: ['st.o.ai', 'st.o.ai.b'],
    };
    const examples = pick
      ? ['st.aiEx1', 'st.aiEx2', 'st.aiEx3'].map((k) => tv(k, { club: pickName(pick!) }))
      : ['np.aiEx1', 'np.aiEx2', 'np.aiEx3'].map((k) => t(k));

    body.innerHTML = `
      <div class="st-summary">
        <span class="st-scarf${pick ? '' : ' none'}"${pick ? scarfStyle([c1, c2]) : ''}></span>
        <div class="st-summary-text">
          <b>${escapeHtml(pick ? pickName(pick) : t('st.noClubShort'))}</b>
          <span title="${escapeHtml(facts)}">${escapeHtml(groundShort(ground.id))} · ${escapeHtml(capacity)}</span>
        </div>
        <div class="st-summary-acts">
          <button type="button" class="st-link" id="st-change-club">${escapeHtml(t(pick ? 'st.changeClub' : 'st.pickClub'))}</button>
          <button type="button" class="st-link" id="st-change-ground">${escapeHtml(t('st.changeGround'))}</button>
        </div>
      </div>
      ${needsColours() ? `
      <section class="np-sec">
        <span class="np-label" id="st-colours-l">${escapeHtml(t('st.colours'))} <span class="st-sub">${escapeHtml(t('st.coloursHint'))}</span></span>
        <div class="st-colours" role="group" aria-labelledby="st-colours-l">
          ${COLOUR_CHOICES.map((c) => {
            const n = colourWords.indexOf(c.word);
            return `<button type="button" class="st-colour${n >= 0 ? ' on' : ''}" data-colour="${escapeHtml(c.word)}" style="--sw:${c.hex}" aria-pressed="${n >= 0}" aria-label="${escapeHtml(t(`st.c.${c.word.replace(' ', '')}`))}">${n >= 0 ? `<b>${n + 1}</b>` : ''}</button>`;
          }).join('')}
        </div>
      </section>` : ''}
      <div class="st-options" role="radiogroup" aria-label="${escapeHtml(t('st.h.start'))}">
        ${options.map((k) => `
          <button type="button" class="st-opt${k === start ? ' on' : ''}" role="radio" aria-checked="${k === start}" tabindex="${k === start ? 0 : -1}" data-start="${k}">
            ${startArt(k, c1, c2, pattern)}
            <span class="st-opt-t">${escapeHtml(t(labels[k][0]))}</span>
            <span class="st-opt-b">${escapeHtml(t(labels[k][1]))}</span>
          </button>`).join('')}
      </div>
      <section class="np-sec" id="st-pattern-sec"${start === 'pattern' ? '' : ' hidden'}>
        <div class="st-patterns" role="radiogroup" aria-label="${escapeHtml(t('st.o.pattern'))}">
          ${PATTERNS.map((p) => `<button type="button" class="st-pat${p === pattern ? ' on' : ''}" role="radio" aria-checked="${p === pattern}" data-pattern="${p}">${escapeHtml(t(`st.p.${p}`))}</button>`).join('')}
        </div>
      </section>
      <section class="np-sec" id="np-ai-sec"${start === 'ai' ? '' : ' hidden'}>
        <label class="np-label" for="np-prompt">${escapeHtml(t('np.aiAsk'))}</label>
        <textarea id="np-prompt" class="np-input np-prompt" rows="3" maxlength="400" placeholder="${escapeHtml(examples[0]!)}"></textarea>
        <div class="np-examples">
          ${examples.map((x) => `<button type="button" class="np-example">${escapeHtml(x)}</button>`).join('')}
        </div>
        <p class="np-err" id="np-prompt-err" role="alert" hidden></p>
      </section>
      <section class="np-sec">
        <label class="np-label" for="np-name">${escapeHtml(t('np.name'))}</label>
        <input id="np-name" class="np-input" type="text" maxlength="80" autocomplete="off" spellcheck="false" />
        <p class="np-err" id="np-name-err" role="alert" hidden></p>
        <p class="np-hint" id="st-name-hint"${start === 'ai' && !nameEdited && !pick ? '' : ' hidden'}>${escapeHtml(t('np.aiNamed'))}</p>
      </section>`;

    const nameInput = $<HTMLInputElement>('#np-name');
    nameInput.value = nameEdited ? nameValue : autoName();
    nameInput.addEventListener('input', () => {
      nameEdited = true;
      nameValue = nameInput.value;
      $<HTMLElement>('#np-name-err').hidden = true;
      $<HTMLElement>('#st-name-hint').hidden = true;
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const prompt = $<HTMLTextAreaElement>('#np-prompt');
    prompt.value = promptValue;
    prompt.addEventListener('input', () => {
      promptValue = prompt.value;
      $<HTMLElement>('#np-prompt-err').hidden = true;
    });
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
    body.querySelectorAll<HTMLButtonElement>('.np-example').forEach((b) =>
      b.addEventListener('click', () => {
        prompt.value = promptValue = b.textContent ?? '';
        $<HTMLElement>('#np-prompt-err').hidden = true;
        prompt.focus();
      }),
    );

    $<HTMLButtonElement>('#st-change-club').addEventListener('click', () => goTo('club', 'start'));
    $<HTMLButtonElement>('#st-change-ground').addEventListener('click', () => goTo('ground', 'start'));

    // Colours: the first click replaces colour 1, the next colour 2, and so on,
    // so picking two is two clicks whatever was picked before.
    body.querySelectorAll<HTMLButtonElement>('.st-colour').forEach((b) =>
      b.addEventListener('click', () => {
        const w = b.dataset.colour!;
        if (colourWords.includes(w)) return;
        colourWords = colourTurn === 0 ? [w, colourWords[1] ?? w] : [colourWords[0]!, w];
        colourTurn = colourTurn === 0 ? 1 : 0;
        if (pick) saveColours(pickKey(pick), colourWords);
        rerenderKeepingFocus(`.st-colour[data-colour="${CSS.escape(w)}"]`);
      }),
    );

    const options$ = Array.from(body.querySelectorAll<HTMLButtonElement>('.st-opt'));
    /** `keep`: focus stays on the option (keyboard, or a click on anything but Describe it). */
    const choose = (k: StartKind, keep: boolean): void => {
      start = k;
      rerenderKeepingFocus(keep ? `.st-opt[data-start="${k}"]` : null);
      if (k === 'ai') {
        // Describe it goes straight to the box to describe it in.
        if (!keep) $<HTMLTextAreaElement>('#np-prompt').focus();
        void askGate();
      }
    };
    options$.forEach((b) => b.addEventListener('click', () => choose(b.dataset.start as StartKind, b.dataset.start !== 'ai')));
    // Arrow keys move the choice, as in any radio group.
    body.querySelector('.st-options')!.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
      if (!keys.includes(ke.key)) return;
      ke.preventDefault();
      const i = options.indexOf(start);
      const rtl = document.documentElement.dir === 'rtl';
      const fwd = ke.key === 'ArrowDown' || ke.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
      choose(options[(i + (fwd ? 1 : -1) + options.length) % options.length]!, true);
    });
    body.querySelectorAll<HTMLButtonElement>('.st-pat').forEach((b) =>
      b.addEventListener('click', () => {
        pattern = b.dataset.pattern!;
        rerenderKeepingFocus(`.st-pat[data-pattern="${pattern}"]`);
      }),
    );
  };

  let nameValue = '';
  let promptValue = '';
  let colourTurn = 0;

  /** Redraw step 3 in place (a choice changed), keeping the scroll and focus. */
  const rerenderKeepingFocus = (focusSel: string | null): void => {
    const scroll = body.scrollTop;
    renderStartStep();
    renderFoot();
    body.scrollTop = scroll;
    if (focusSel) (body.querySelector(focusSel) as HTMLElement | null)?.focus();
  };

  // ---------------------------------------------------------- footer ---
  const renderGate = (): void => {
    if (step !== 'start' || start !== 'ai' || !gate) {
      gateEl.hidden = true;
      return;
    }
    gateEl.hidden = false;
    gateEl.className = 'np-gate';
    if (gate.kind === 'ok') {
      gateEl.textContent = gate.unlimited ? t('np.aiUnlimited') : gate.left !== null ? tv('np.aiCost', { left: fmt(gate.left) }) : '';
      gateEl.hidden = !gateEl.textContent;
      return;
    }
    gateEl.classList.add('locked');
    if (gate.kind === 'empty') gateEl.textContent = tv('np.aiNone', { when: waitLabel(gate.resetInSec) });
    else gateEl.textContent = t(gate.kind === 'signin' ? 'st.aiNeedsAccount' : 'np.aiLockedVerify');
  };

  const renderFoot = (): void => {
    renderGate();
    const back = trail.length ? `<button type="button" class="np-btn" id="st-back">${escapeHtml(t('np.back'))}</button>` : '';
    if (step === 'club') {
      actions.innerHTML = `${back}<button type="button" class="np-btn st-quiet" id="st-no-club">${escapeHtml(t('st.noClub'))}</button>`;
      actions.querySelector('#st-no-club')!.addEventListener('click', () => {
        pick = null;
        if (start === 'club') start = 'pattern';
        goTo('ground', 'club');
      });
    } else if (step === 'ground') {
      actions.innerHTML = back;
    } else {
      let label = t(start === 'club' ? 'st.go.club' : start === 'ai' ? 'np.aiGo' : 'st.go.paint');
      let disabled = false;
      let href: string | null = null;
      if (start === 'ai') {
        if (!gate) disabled = true;
        else if (gate.kind === 'signin') label = t('st.aiSignup');
        else if (gate.kind === 'verify') { label = t('np.verify'); href = localPath('/account'); }
        else if (gate.kind === 'empty') disabled = true;
      }
      const spark = start === 'ai' && (gate?.kind === 'ok' || !gate) ? '<span class="np-spark" aria-hidden="true">✦</span>' : '';
      actions.innerHTML = `${back}${
        href
          ? `<a class="np-btn primary" id="st-go" href="${href}">${escapeHtml(label)}</a>`
          : `<button type="button" class="np-btn primary" id="st-go"${disabled ? ' disabled' : ''}>${spark}${escapeHtml(label)}</button>`
      }`;
      actions.querySelector('button#st-go')?.addEventListener('click', submit);
    }
    actions.querySelector('#st-back')?.addEventListener('click', () => {
      const prev = trail.pop();
      if (prev) goTo(prev, null);
    });
  };

  const askGate = async (): Promise<void> => {
    if (gateAsked && gate) return;
    gateAsked = true;
    renderFoot();
    gate = await readAiGate();
    if (backdrop.isConnected && step === 'start') renderFoot();
  };

  // ---------------------------------------------------------- moving ---
  /** Move to a step; `from` goes on the Back trail (null when going back). */
  function goTo(next: Step, from: Step | null): void {
    if (from && next !== from) {
      // Going to a step already on the trail cuts the loop out of it (start →
      // ground → start is not three steps back), and the step being left is
      // always the one Back returns to.
      const at = trail.indexOf(next);
      if (at >= 0) trail.length = at;
      trail.push(from);
    }
    step = next;
    modal.dataset.step = step;
    backdrop.querySelectorAll<HTMLElement>('.st-steps li').forEach((li) => {
      const order: Step[] = ['club', 'ground', 'start'];
      li.classList.toggle('on', order.indexOf(li.dataset.s as Step) <= order.indexOf(step));
      if (li.dataset.s === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    gateEl.hidden = true;
    if (step === 'club') renderClubStep();
    else if (step === 'ground') renderGroundStep();
    else renderStartStep();
    body.scrollTop = 0;
    renderFoot();
    if (step === 'start' && start === 'ai') void askGate();
    // Focus the heading rather than a field: on a phone a focused search box
    // pops the keyboard over the very list it is there to search.
    heading.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------- submit ---
  function submit(): void {
    const nameInput = $<HTMLInputElement>('#np-name');
    const typed = nameInput.value.trim().slice(0, 80);
    if (start === 'ai') {
      // Signed out, the button says "Create a free account": that comes first,
      // whatever is in the box (which waits for them).
      if (gate?.kind === 'signin') {
        void opts.signIn('signup').then(async (ok) => {
          if (!ok || !backdrop.isConnected) return;
          gate = await readAiGate();
          renderFoot();
        });
        return;
      }
      const prompt = $<HTMLTextAreaElement>('#np-prompt');
      const brief = prompt.value.trim();
      if (!brief) {
        const err = $<HTMLElement>('#np-prompt-err');
        err.textContent = t('np.aiNeedPrompt');
        err.hidden = false;
        prompt.focus();
        return;
      }
      if (gate?.kind !== 'ok') return;
      write(LAST_STADIUM_KEY, ground.id);
      rememberPick(pick, ground.id);
      // The AI is told whose tifo it is when the brief does not already say.
      const name = pick ? pickName(pick) : '';
      // The brief is cut to fit, never the club's name off its end.
      const suffix = pick && !brief.toLowerCase().includes(name.toLowerCase()) ? ` (${name})` : '';
      const withClub = `${brief.slice(0, 400 - suffix.length)}${suffix}`;
      stashNewProject({
        title: nameEdited && typed ? typed : autoName(),
        templateId: ground.id,
        prompt: withClub.slice(0, 400),
        autoName: !(nameEdited && typed) && !pick,
      });
      go(newProjectUrl(ground.id, { ai: '1' }));
      return;
    }
    if (!typed) {
      const err = $<HTMLElement>('#np-name-err');
      err.textContent = t('np.nameNeeded');
      err.hidden = false;
      nameInput.focus();
      return;
    }
    write(LAST_STADIUM_KEY, ground.id);
    rememberPick(pick, ground.id);
    let intentStart: NonNullable<NewProjectIntent['start']>;
    if (start === 'club' && pick) {
      const ar = getLang() === 'ar';
      const word = pick.kind === 'known' ? (ar ? pick.club.ar : pick.club.word ?? pick.club.en.toUpperCase()) : (ar ? pick.name : pick.name.toUpperCase());
      const nameForDesigner = pick.kind === 'known' ? pick.club.en : pick.name;
      intentStart = {
        kind: 'club',
        brief: clubBrief(nameForDesigner, word, needsColours() ? colourWords : []),
        palette: palette(),
      };
    } else if (start === 'pattern') {
      intentStart = { kind: 'pattern', patternId: pattern, palette: palette() };
    } else {
      intentStart = { kind: 'blank', palette: palette() };
    }
    stashNewProject({ title: typed, templateId: ground.id, start: intentStart });
    go(newProjectUrl(ground.id));
  }

  goTo(step, null);
  if (league) {
    // Skip a league the fan already has a ground for: the group, not the top.
    requestAnimationFrame(() => {
      const head = body.querySelector<HTMLElement>(`.st-group[data-league="${CSS.escape(league)}"]`);
      if (head) body.scrollTop = head.offsetTop - body.offsetTop - 64;
    });
  }
}
