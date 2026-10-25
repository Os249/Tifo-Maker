/**
 * Bilingual i18n (English + Saudi-dialect Arabic) with full RTL support.
 *
 * The Arabic is intentionally colloquial Saudi — the way fans on the curva
 * actually talk — not formal MSA. e.g. "ببلاش" (free) over "مجاناً",
 * "صمّم" / "سوّي" phrasing, "تشوفه" over "مشاهدته".
 *
 * One source of truth: every translatable string has a key, in
 * ui/i18n/strings.ts. The landing page marks elements with data-i18n; the
 * editor calls t(key). Switching language flips <html dir/lang>, persists the
 * choice, and re-applies the DOM.
 *
 * Strings travel with the code that shows them (performance plan P2.6). This
 * module holds no strings. Every page used to download one chunk with both
 * languages of every page's strings, about 66 KB gz, for the few hundred it can
 * show. Now each built chunk carries the strings its own modules (and, for a
 * page's entry, its HTML) name, in BOTH languages, and hands them over through
 * a same-origin queue (globalThis.__tifoStrings) before any of its code runs:
 * a page downloads at start only what the code it runs at start can show, a
 * dialog's strings arrive with the dialog, and the language toggle stays
 * instant (scripts/vite/i18nTables.ts). A build check fails on any key a
 * chunk's code names that neither it nor the chunks it imports register; should
 * one slip through anyway (a key that arrives whole from elsewhere), t() never
 * shows the raw key: it shows nothing for that moment, fetches the full table
 * once, then re-applies the page and tells every onLangChange listener.
 */

import { PASSWORD_MAX, PASSWORD_MIN } from '../core/passwordLimits';
import { inLang } from '../core/langPath';

export type Lang = 'en' | 'ar';

/** One string in both languages, as the page tables carry it. */
export type StringPair = readonly [en: string, ar: string];

/** What the build-generated page table registers. */
export interface PageStrings {
  /** key -> [English, Arabic] */
  strings: Record<string, StringPair>;
  /**
   * Key prefixes this table holds in full (`bn.rev.` for t(`bn.rev.${r}`)), so a
   * key under one that is not in the table is not a string anywhere.
   */
  families?: readonly string[];
  /** tl()'s value -> key map, when the page calls tl() or tlBoth(). */
  labels?: Record<string, string>;
  /** The ground ids tl() marks as the earlier layout. */
  earlier?: readonly string[];
  /** tErr()'s server message -> key map, when the page calls tErr(). */
  errors?: Record<string, string>;
}

// Null-prototype maps: a key such as 'constructor' must not find Object's.
const TABLE: Record<string, StringPair> = Object.create(null);
const LABEL_KEYS: Record<string, string> = Object.create(null);
const ERROR_KEYS: Record<string, string> = Object.create(null);
const EARLIER_LAYOUT = new Set<string>();
let families: string[] = [];
/** The full table, once a miss has fetched it (or the dev server registered it). */
let complete = false;

/**
 * Adds a table. Called by the build-generated module each page's entry imports
 * first (and, on the dev server, with every string), never by hand.
 */
export function registerStrings(page: PageStrings): void {
  Object.assign(TABLE, page.strings);
  if (page.labels) Object.assign(LABEL_KEYS, page.labels);
  if (page.errors) Object.assign(ERROR_KEYS, page.errors);
  for (const id of page.earlier ?? []) EARLIER_LAYOUT.add(id);
  if (page.families) families = [...families, ...page.families];
  if (page.families?.includes('')) complete = true;
}

/**
 * The queue the built chunks push their tables onto. A chunk that runs before
 * this module left its table in a plain array; from here on, a push registers.
 */
type Queue = { push(page: PageStrings): unknown };
declare global {
  // eslint-disable-next-line no-var
  var __tifoStrings: Queue | PageStrings[] | undefined;
}
{
  const early = globalThis.__tifoStrings;
  globalThis.__tifoStrings = { push: registerStrings };
  if (Array.isArray(early)) for (const page of early) registerStrings(page);
}

let fetching: Promise<void> | null = null;
const warned = new Set<string>();

/**
 * The runtime fallback for a key this page's table lacks: fetch the whole
 * table (same-origin, built from the repo like every other chunk) once, then
 * re-apply the page and tell the listeners, as a language switch does.
 */
function fetchRest(key: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] "${key}" is not in this page's string table; fetching the full table`);
  }
  if (fetching) return;
  fetching = import('./i18n/strings')
    .then(({ STRINGS }) => {
      for (const [k, v] of Object.entries(STRINGS)) if (!(k in TABLE)) TABLE[k] = [v.en, v.ar];
      complete = true;
      applyDom(document);
      for (const fn of listeners) fn(current);
    })
    .catch(() => {
      // Offline, or a deploy removed the chunk: let a later miss try again.
      fetching = null;
    });
}

/** The string for a key in the current language, or undefined if there is none here. */
function lookup(key: string): string | undefined {
  const e = TABLE[key];
  return e ? e[current === 'ar' ? 1 : 0] : undefined;
}

/**
 * A key the table does not have. When the table is known to be complete for
 * it, the key is not a string anywhere, and it comes back as itself, as it
 * always has: layer names and the like test for that to fall back to the raw
 * value. Otherwise it may be a string this page's table missed, and the person
 * sees nothing (never "cm.remix") until the full table arrives.
 */
function missing(key: string): string {
  if (complete || families.some((p) => key.startsWith(p))) return key;
  fetchRest(key);
  return '';
}

const LS_KEY = 'tifo_lang_v1';
let current: Lang = 'en';
const listeners: ((lang: Lang) => void)[] = [];

/**
 * Arabic for a browser that asks for it first.
 *
 * Only the FIRST preferred language counts: a Saudi phone set to Arabic lists
 * ar-SA first, while an English browser that merely has Arabic further down the
 * list keeps English. Before this, everyone got English until they found the
 * toggle, and 63% of the visitors in the late-September spike had Arabic
 * browsers. A choice made with the toggle is saved and always wins.
 */
export function preferredLang(langs: readonly string[] | undefined): Lang {
  const first = (langs ?? [])[0] ?? '';
  return /^ar\b/i.test(first) ? 'ar' : 'en';
}

/**
 * The language this page's HTML was built in, when the page has a twin in the
 * other one (performance plan P3.3): <html data-lang-page="en|ar">, written
 * by the build and the server, never by this script's caller. Null on the dev
 * server, whose pages have no twins: there everything works as it always did.
 */
function pageLang(): Lang | null {
  const v = document.documentElement.getAttribute('data-lang-page');
  return v === 'en' || v === 'ar' ? v : null;
}

export function initLang(): Lang {
  let saved: Lang | null = null;
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'en' || v === 'ar') saved = v;
  } catch {
    /* ignore */
  }
  // An /ar/ page is Arabic, whatever was saved: its words are in its HTML,
  // and its address says Arabic (performance plan P3.3). Every other page
  // follows the saved choice, else the browser's first language, as before.
  if (pageLang() === 'ar') current = 'ar';
  else if (saved) current = saved;
  else {
    try {
      current = preferredLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
    } catch {
      /* keep English */
    }
  }
  applyDir();
  // An English address showing Arabic because Arabic was chosen with the
  // toggle: the address becomes its Arabic twin, in place, so a reload, a
  // bookmark and every link from here are the Arabic pages, which paint in
  // Arabic from their first frame. Only for a choice someone made: a browser
  // that merely prefers Arabic keeps the address it asked for. Never a
  // navigation, so nothing is fetched twice and nothing runs twice.
  if (pageLang() === 'en' && saved === 'ar') followLanguage('ar');
  return current;
}

/** The address follows the language on screen: the twin's, in place (performance plan P3.3). */
function followLanguage(lang: Lang): void {
  const here = location.pathname + location.search + location.hash;
  const there = inLang(here, lang);
  if (there && there !== here) {
    history.replaceState(history.state, '', there);
    document.documentElement.setAttribute('data-lang-page', lang);
  }
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LS_KEY, lang);
  } catch {
    /* ignore */
  }
  // The address goes to the twin (performance plan P3.3): the page in the
  // other language is its own URL, so a reload, a bookmark or a link copied
  // from here opens it in the language now on screen. In place, not a
  // navigation, so whatever is open stays open (the editor, a dialog, a
  // half-typed form); the page is translated right here as it always was.
  if (pageLang()) followLanguage(lang);
  applyDir();
  applyDom(document);
  for (const fn of listeners) fn(lang);
}

/**
 * A link to one of this site's pages, in the language on screen (performance
 * plan P3.3; core/langPath.ts). Re-exported here for the pages' convenience.
 */
export { localPath } from '../core/langPath';

export function toggleLang(): void {
  setLang(current === 'en' ? 'ar' : 'en');
}

export function onLangChange(fn: (lang: Lang) => void): void {
  listeners.push(fn);
}

/**
 * Translate a key. A key that is not a string at all comes back as itself; one
 * this page's table missed shows nothing until the full table arrives (see
 * missing()).
 */
export function t(key: string): string {
  return lookup(key) ?? missing(key);
}

/**
 * Translate with {placeholders} filled in.
 *
 * Arabic puts numbers and names in different places than English does, so the
 * sentence has to be translated whole and the values dropped into it — never
 * assembled from fragments in code, which is how "designed with" ends up
 * stranded in English inside an Arabic panel.
 */
export function tv(key: string, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/**
 * Translate a value that doubles as an identifier and a display label — palette
 * names, pattern ids, stadium ids, camera presets. These live in data tables
 * keyed by their English name, so they cannot simply be replaced; the map
 * (ui/i18n/maps.ts, in the page's table when the page calls this) takes the
 * value to a key, and the value itself comes back when there is no entry.
 */
export function tl(value: string): string {
  const key = LABEL_KEYS[value];
  if (!key) return value;
  return EARLIER_LAYOUT.has(value) ? `${t(key)} (${t('sp.earlierLayout')})` : t(key);
}

/**
 * A label in BOTH languages at once, whatever the page is in — for things that
 * show both side by side, like a stadium's big screen. Falls back to the value
 * itself in both slots when it has no translation.
 */
export function tlBoth(value: string, fallback = value): { en: string; ar: string } {
  const key = LABEL_KEYS[value];
  const e = key ? TABLE[key] : undefined;
  const earlier = TABLE['sp.earlierLayout'];
  if (e && earlier && EARLIER_LAYOUT.has(value)) return { en: `${e[0]} (${earlier[0]})`, ar: `${e[1]} (${earlier[1]})` };
  return e ? { en: e[0], ar: e[1] } : { en: fallback, ar: fallback };
}

/**
 * A gallery tag as a label. Library tags have a translation; a tag a person
 * typed is their own word and comes back untouched.
 */
export function tTag(slug: string): string {
  // A direct lookup, not t(): a person's own tag is not a missing string, and
  // must not send the page off to fetch the full table.
  return lookup(`tag.${slug}`) ?? slug;
}

/**
 * The title to show for a design. Only the starter library carries a second
 * title — everything else is whatever its author typed, in whatever language
 * they typed it, and translating that would be putting words in their mouth.
 */
export function tTitle(item: { title: string; titleAr?: string | null }): string {
  return getLang() === 'ar' && item.titleAr ? item.titleAr : item.title;
}

/**
 * Translate a server error message.
 *
 * The API answers in English because it has no idea which language the person
 * picked — the choice lives in their browser. Rather than plumbing a locale
 * through every endpoint, the client maps the known messages (which are stable
 * strings, not prose; ui/i18n/maps.ts) to keys, and falls back to the server's
 * own text for anything unrecognised, which is exactly what shipped before.
 */
export function tErr(message: string): string {
  const key = ERROR_KEYS[message.trim()];
  if (!key) return message;
  // The password-length messages are the only server errors carrying a number,
  // and it is a constant both sides import; `tv` is a no-op on the rest.
  return tv(key, { min: PASSWORD_MIN, max: PASSWORD_MAX });
}

/*
 * The two maps (ui/i18n/maps.ts) and the strings they point at are modules of
 * their own (performance plan P2.6), so a page carries them only when its code
 * needs them. Code that calls tl()/tlBoth() or tErr() directly gets them as a
 * static import at build time; code that only needs them after an await loads
 * them here, on first use.
 */
let labelsLoading: Promise<void> | null = null;
let errorsLoading: Promise<void> | null = null;

/** The ground, palette and pattern names behind tl(), for code that calls it only after this resolves. */
export function loadLabels(): Promise<void> {
  return (labelsLoading ??= import('virtual:tifo-i18n/labels').then(
    () => undefined,
    (e: unknown) => {
      labelsLoading = null;
      throw e;
    },
  ));
}

/**
 * tErr() for code that can wait (every API call that failed): the server-error
 * strings are fetched the first time one is needed, so no page downloads them
 * at start. If that fetch fails, the server's own text comes back, which is
 * what tErr() does for any message it does not know.
 */
export async function tErrLater(message: string): Promise<string> {
  try {
    await (errorsLoading ??= import('virtual:tifo-i18n/errors').then(() => undefined));
  } catch {
    errorsLoading = null;
    return message;
  }
  return tErr(message);
}

function applyDir(): void {
  const html = document.documentElement;
  html.lang = current;
  html.dir = current === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Apply translations to every [data-i18n] element in a root. Supports:
 *   data-i18n="key"            → sets textContent
 *   data-i18n-attr="placeholder:key,title:key"  → sets attributes
 */
export function applyDom(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
  // And the links to this site's pages follow the language (localPath()), so
  // a page translated in place sends its reader to pages in the same language.
  if (pageLang()) {
    root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((a) => {
      const href = a.getAttribute('href')!;
      const to = inLang(href, current);
      if (to && to !== href) a.setAttribute('href', to);
    });
  }
}
