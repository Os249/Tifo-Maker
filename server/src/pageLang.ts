/**
 * The pages in two languages (performance plan P3.3): what the server needs to
 * render a page in English or in Arabic, and to tell search engines that the
 * two are one page.
 *
 * Each page has an English address and, under /ar/, an Arabic one
 * (src/core/langPath.ts has the rule). Both are registered by the same code in
 * routes.ts with the language as an argument, so the Arabic page runs exactly
 * the English page's checks (who may see a design, takedowns, privacy), sends
 * exactly its headers and is cached, or not, exactly as it is. The language is
 * decided by the path alone: never a cookie, never Accept-Language, never a
 * header the answer could vary on, so one URL is one page for everyone.
 *
 * The words come from the site's one string table (src/ui/i18n/strings.ts),
 * the same one the pages and the build read; every value written into a page
 * goes through the one escaper on the way out (routes.ts esc()).
 */
import { STRINGS } from '../../src/ui/i18n/strings';
import { LABEL_KEYS } from '../../src/ui/i18n/maps';
import { pathIn, type PathLang } from '../../src/core/langPath';

export type PageLang = PathLang;
export const PAGE_LANGS: readonly PageLang[] = ['en', 'ar'];

/** A route's pattern in a language: '/t/:id' and '/ar/t/:id', '/' and '/ar/'. */
export const routeIn = (route: string, lang: PageLang): string => pathIn(route, lang);

/** Where a built page's file is, under the static directory: ar/ holds the Arabic ones. */
export const pageFile = (file: string, lang: PageLang): string => (lang === 'ar' ? `ar/${file}` : file);

/**
 * A string in a language, with {name} filled in. Throws for a key the table
 * does not have: every key named here is checked at boot (checkPageText), so
 * a typo stops the server starting rather than a page rendering a raw key.
 */
export function pageText(key: string, lang: PageLang, vars: Record<string, string | number> = {}): string {
  const e = STRINGS[key];
  if (!e) throw new Error(`pageLang: no string "${key}"`);
  return e[lang].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** The keys routes.ts uses, checked once when the routes are built. */
export const PAGE_TEXT_KEYS = [
  'meta.site', 'meta.card.alt', 'meta.landing.title', 'meta.landing.desc', 'meta.app.title', 'meta.app.desc',
  'meta.community.title', 'meta.community.desc', 'meta.clubs.title', 'meta.clubs.desc',
  'meta.legal.title', 'meta.legal.desc', 'meta.tifo.title', 'meta.tifo.none.title', 'meta.tifo.none.desc',
  'meta.tifo.alt', 'meta.tifo.altBy', 'meta.design.site', 'meta.design.title', 'meta.design.none.desc',
  'meta.describe.named', 'meta.describe.unnamed', 'meta.describe.on', 'meta.describe.somewhere',
  'meta.describe.seats', 'meta.describe.by', 'meta.describe.remixed', 'meta.describe.open',
  'meta.someone', 'meta.daily.alt', 'meta.feed.label', 'ed.docTitlePlaceholder', 'cm.by',
  'daily.badge', 'daily.view', 'daily.sub',
] as const;

export function checkPageText(): void {
  for (const k of PAGE_TEXT_KEYS) {
    const e = STRINGS[k];
    if (!e?.en?.trim() || !e.ar?.trim()) throw new Error(`pageLang: "${k}" needs both English and Arabic`);
  }
}

/** A ground's name in a language: its Arabic label when it has one, else the name it was given. */
export function groundName(templateId: string, name: string, lang: PageLang): string {
  if (lang === 'en') return name;
  const key = LABEL_KEYS[templateId];
  return (key && STRINGS[key]?.ar) || name;
}

/** A count written the way the language writes numbers (60,000 and ٦٠٬٠٠٠). */
export const formatCount = (n: number, lang: PageLang): string => n.toLocaleString(lang === 'ar' ? 'ar-SA' : 'en-US');

/** og:locale for a language. */
export const ogLocale = (lang: PageLang): string => (lang === 'ar' ? 'ar_AR' : 'en_US');

/**
 * The links that tie a page's two versions together, for search engines:
 * hreflang en, ar and x-default (the English one), each an absolute URL on
 * this site's own address. `enPath` is the English page's path; the values are
 * escaped by the caller's escaper.
 */
export function alternateLinks(base: string, enPath: string, esc: (s: string) => string): string[] {
  const en = `${base}${pathIn(enPath, 'en')}`;
  const ar = `${base}${pathIn(enPath, 'ar')}`;
  return [
    `<link rel="alternate" hreflang="en" href="${esc(en)}" />`,
    `<link rel="alternate" hreflang="ar" href="${esc(ar)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${esc(en)}" />`,
  ];
}
