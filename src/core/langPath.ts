/**
 * Which pages have an Arabic twin under /ar/, and the address of a page in
 * either language (performance plan P3.3).
 *
 * The Arabic pages are their own URLs, /ar/community beside /community, with
 * the Arabic already in the HTML, so an Arabic reader's first paint is Arabic
 * instead of English for the 1.4-5.3 s the strings took to arrive. The
 * language is in the path and nowhere else: never a cookie, never a header the
 * answer varies on, so one URL is always one page for every visitor and every
 * cache.
 *
 * One module for the three places that need the rule (the browser, ui/i18n.ts;
 * the server, server/src/pageLang.ts; the build, scripts/vite/arabicPages.ts),
 * so they can never disagree about which address is a page's twin.
 * public/theme-boot.js, a plain script that runs before anything paints, has
 * its own four-line copy of the prefix rule.
 */
export type PathLang = 'en' | 'ar';

/**
 * The English paths with an Arabic twin: the landing, the editor and every
 * page whose words exist in Arabic. Not /tifo-spec (the developer spec is
 * written in English only, and a page that says lang="ar" over English text
 * is read aloud wrongly), not /admin, nothing under /api, /og or /assets, and
 * no file.
 */
const TWINNED = /^\/(?:(?:app|community|clubs|legal|reset|account|projects)|(?:t|d|s)\/[^/?#\\]+)?$/;

/** The language a path is in: Arabic under /ar/, English everywhere else. */
export function langOfPath(pathname: string): PathLang {
  return pathname === '/ar' || pathname.startsWith('/ar/') ? 'ar' : 'en';
}

/** The English page behind a path in either language ('/ar/' is '/', '/ar/t/x' is '/t/x'). */
export function englishPath(pathname: string): string {
  if (langOfPath(pathname) === 'en') return pathname;
  const rest = pathname.slice(3);
  return rest === '' ? '/' : rest;
}

/** Whether the page at this English path (no query, no hash) has an Arabic twin. */
export function hasTwin(enPathname: string): boolean {
  return TWINNED.test(enPathname);
}

/** A page's path in a language: '/' and '/ar/', '/community' and '/ar/community'. */
export function pathIn(enPathname: string, lang: PathLang): string {
  if (lang === 'en') return enPathname;
  return enPathname === '/' ? '/ar/' : `/ar${enPathname}`;
}

/**
 * A link to one of this site's pages, written for a language: the same page,
 * the same query and fragment, in the other language's path. Null when it is
 * not a link to a page with a twin (another site, a file, the API, a fragment
 * on its own), which callers then leave exactly as it was.
 *
 * Only a path that starts with one slash is read: `//host` and `/\host` are
 * other origins to a browser, and nothing here may ever turn a link into one.
 */
export function inLang(href: string, lang: PathLang): string | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return null;
  const cut = href.search(/[?#]/);
  const pathname = cut === -1 ? href : href.slice(0, cut);
  const rest = cut === -1 ? '' : href.slice(cut);
  const en = englishPath(pathname);
  if (!hasTwin(en)) return null;
  const out = pathIn(en, lang) + rest;
  return out.startsWith('/') && !out.startsWith('//') && !out.startsWith('/\\') ? out : null;
}

/**
 * A link to one of this site's pages, for the language this page shows now
 * (<html lang>, which ui/i18n.ts keeps in step with the toggle): '/community'
 * on an Arabic page is '/ar/community', so moving around stays in Arabic
 * without a detour through the English page. Only on a built page that has a
 * twin (<html data-lang-page>); everything else, the dev server's pages and
 * anything that is not a link to such a page, comes back unchanged. In the
 * browser only; anywhere else it changes nothing.
 */
export function localPath(href: string): string {
  if (typeof document === 'undefined') return href;
  const root = document.documentElement;
  if (!root.hasAttribute('data-lang-page')) return href;
  return inLang(href, root.lang === 'ar' ? 'ar' : 'en') ?? href;
}
