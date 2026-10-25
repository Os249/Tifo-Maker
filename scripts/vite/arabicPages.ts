/**
 * Pre-rendered Arabic pages under /ar/ (performance plan P3.3).
 *
 * Every page used to ship English HTML and turn Arabic only once its script
 * and strings had arrived and run: 1.4-5.3 s of English (laid out right to
 * left) on a phone, for most of this site's visitors. Now each page that has
 * its words in Arabic is built twice from the same source: dist/<page>.html in
 * English, as before, and dist/ar/<page>.html with the Arabic already in it,
 * <html lang="ar" dir="rtl">, so the first frame is Arabic. Both load the same
 * hashed scripts and stylesheets: one build, no second bundle.
 *
 * The Arabic page is the English page with exactly what ui/i18n.ts applyDom()
 * would do to it, done here instead, from the same table
 * (src/ui/i18n/strings.ts):
 *  - data-i18n="key": the element's content becomes the string, as text;
 *  - data-i18n-attr="attr:key,...": those attributes become the strings;
 *  - data-i18n-initial="attr:key,...": the same, for an attribute a script
 *    keeps up to date afterwards (the theme button's label says what pressing
 *    it does), or for the text itself ("text:key"); its {placeholders} come
 *    from data-i18n-vars="name:key,..." and the password limits, as tv() and
 *    tErr() fill them. The browser never reads these two;
 *  - data-lang-only="en|ar": a block written in one language (the legal
 *    texts) is shown or hidden, and data-href-ar is a link's Arabic target;
 *  - links to this site's pages point at their Arabic twins
 *    (src/core/langPath.ts), so moving around stays in Arabic;
 *  - <html data-lang-page>, on both versions, tells theme-boot.js and
 *    ui/i18n.ts which language the page was built in.
 * Every value is escaped with the site's one escaper (src/core/escape.ts).
 * Nothing is added that runs: no script, inline or not; the build's own
 * script check (vite.config.ts) reads the Arabic pages like the English ones.
 *
 * The server serves dist/ar/<page>.html at /ar/<path> with the same code path,
 * headers, caching and checks as the English page (server/src/routes.ts).
 *
 * The build FAILS when a page that should have a twin did not get one, when a
 * twin is not lang="ar" dir="rtl", when a key has no Arabic, or when an
 * element marked for translation was left in English.
 */
import type { Plugin } from 'vite';
import { pathKey } from './pathKey';
import { resolve } from 'node:path';
import { STRINGS } from '../../src/ui/i18n/strings';
import { escapeHtml } from '../../src/core/escape';
import { inLang, type PathLang } from '../../src/core/langPath';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../src/core/passwordLimits';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content the HTML parser reads as text, not markup. */
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const TAG = /<!--[\s\S]*?-->|<![^>]*>|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /\s+([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

interface Attr {
  name: string;
  /** As written in the source (entities and all), or null for a bare attribute. */
  raw: string | null;
}

const parseAttrs = (s: string): Attr[] =>
  [...s.matchAll(ATTR)].map((m) => {
    const v = m[2];
    const raw = v === undefined ? null : v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v;
    return { name: m[1]!, raw };
  });

/** The attribute's text, entities read. Only the few the source uses in these attributes. */
const textOf = (raw: string | null): string =>
  (raw ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const tagOf = (name: string, attrs: Attr[], selfClose: string): string =>
  `<${name}${attrs.map((a) => (a.raw === null ? ` ${a.name}` : ` ${a.name}="${a.raw.replace(/"/g, '&quot;')}"`)).join('')}${selfClose ? ' /' : ''}>`;

/** Where the element opened just before `from` ends: the start of its matching close tag. */
function closeOf(html: string, from: number, name: string): number {
  const lower = name.toLowerCase();
  if (RAW.has(lower)) {
    const at = html.toLowerCase().indexOf(`</${lower}`, from);
    if (at === -1) throw new Error(`<${name}> is never closed`);
    return at;
  }
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] && m[1].toLowerCase() === lower) {
      if (depth === 0) return m.index;
      depth--;
    } else if (m[2] && m[2].toLowerCase() === lower && !m[4] && !VOID.has(lower)) depth++;
    else if (m[2] && RAW.has(m[2].toLowerCase())) re.lastIndex = closeOf(html, re.lastIndex, m[2]);
  }
  throw new Error(`<${name}> is never closed`);
}

const pairs = (spec: string): [string, string][] =>
  spec.split(',').map((p) => p.split(':').map((s) => s.trim()) as [string, string]).filter(([a, k]) => a && k);

/** A string in a language, or a build error naming the key. */
function str(key: string, lang: PathLang): string {
  const v = STRINGS[key]?.[lang];
  if (!v || !v.trim()) throw new Error(`no ${lang === 'ar' ? 'Arabic' : 'English'} for "${key}"`);
  return v;
}

/** The values tErr() always fills, the same constants the pages import. */
const BUILT_IN: Record<string, string> = { min: String(PASSWORD_MIN), max: String(PASSWORD_MAX) };

/** A string with its {placeholders} filled from data-i18n-vars (each a key) and BUILT_IN; a build error for one left over. */
function filled(key: string, lang: PathLang, varsRaw: string | null | undefined): string {
  const vars: Record<string, string> = { ...BUILT_IN };
  for (const [name, k] of varsRaw ? pairs(varsRaw) : []) vars[name] = str(k, lang);
  return str(key, lang).replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (vars[name] === undefined) throw new Error(`"${key}" needs {${name}}, which data-i18n-vars does not give`);
    return vars[name]!;
  });
}

/**
 * One page in one language. English changes only <html> (the marker);
 * Arabic gets every translation above. Pure: the same source, the same output.
 */
export function renderPage(html: string, lang: PathLang): string {
  let out = '';
  let at = 0;
  const re = new RegExp(TAG.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out += html.slice(at, m.index);
    at = re.lastIndex;
    const name = m[2];
    if (!name) {
      out += m[0];
      continue;
    }
    const lower = name.toLowerCase();
    const attrs = parseAttrs(m[3] ?? '');
    const get = (n: string): Attr | undefined => attrs.find((a) => a.name.toLowerCase() === n);
    const set = (n: string, text: string): void => {
      const a = get(n);
      if (a) a.raw = escapeHtml(text);
      else attrs.push({ name: n, raw: escapeHtml(text) });
    };
    const drop = (n: string): void => {
      const i = attrs.findIndex((a) => a.name.toLowerCase() === n);
      if (i !== -1) attrs.splice(i, 1);
    };
    let changed = false;
    if (lower === 'html') {
      set('lang', lang);
      if (lang === 'ar') set('dir', 'rtl');
      set('data-lang-page', lang);
      changed = true;
    }
    let content: string | null = null;
    if (lang === 'ar') {
      const key = get('data-i18n')?.raw;
      if (key && !VOID.has(lower)) content = escapeHtml(str(key, 'ar'));
      const attrSpec = get('data-i18n-attr')?.raw;
      for (const [attr, k] of attrSpec ? pairs(attrSpec) : []) {
        set(attr, str(k, 'ar'));
        changed = true;
      }
      const initial = get('data-i18n-initial')?.raw;
      for (const [attr, k] of initial ? pairs(initial) : []) {
        const text = filled(k, 'ar', get('data-i18n-vars')?.raw);
        if (attr === 'text') {
          if (VOID.has(lower)) throw new Error(`<${name}> has no text for data-i18n-initial`);
          content = escapeHtml(text);
        } else set(attr, text);
        changed = true;
      }
      const only = get('data-lang-only')?.raw;
      if (only === 'ar') {
        drop('hidden');
        changed = true;
      } else if (only === 'en') {
        if (!get('hidden')) attrs.push({ name: 'hidden', raw: null });
        changed = true;
      }
      if (lower === 'a') {
        const hrefAr = get('data-href-ar')?.raw;
        const href = get('href');
        if (hrefAr && href) {
          href.raw = hrefAr;
          changed = true;
        } else if (href?.raw) {
          const to = inLang(textOf(href.raw), 'ar');
          if (to) {
            href.raw = escapeHtml(to);
            changed = true;
          }
        }
      }
    }
    out += changed ? tagOf(name, attrs, m[4] ?? '') : m[0];
    if (content !== null) {
      const end = closeOf(html, at, name);
      out += content;
      at = end;
      re.lastIndex = end;
    } else if (RAW.has(lower) && !m[4]) {
      const end = closeOf(html, at, name);
      out += html.slice(at, end);
      at = end;
      re.lastIndex = end;
    }
  }
  return out + html.slice(at);
}

/** What is wrong with a built Arabic page (empty when nothing). */
export function checkArabicPage(html: string): string[] {
  const problems: string[] = [];
  const root = /<html\b([^>]*)>/i.exec(html)?.[1] ?? '';
  if (!/\blang="ar"/.test(root) || !/\bdir="rtl"/.test(root) || !/\bdata-lang-page="ar"/.test(root)) {
    problems.push('its <html> is not lang="ar" dir="rtl" data-lang-page="ar"');
  }
  // Every element marked for translation carries its Arabic.
  const re = new RegExp(TAG.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = m[2];
    if (!name) continue;
    const attrs = parseAttrs(m[3] ?? '');
    const val = (n: string): string | null | undefined => attrs.find((a) => a.name === n)?.raw;
    const inner = (): string => html.slice(re.lastIndex, closeOf(html, re.lastIndex, name));
    const key = val('data-i18n');
    if (key && !VOID.has(name.toLowerCase()) && inner() !== escapeHtml(STRINGS[key]?.ar ?? '\0')) problems.push(`[data-i18n=${key}] is not its Arabic`);
    const attrSpec = val('data-i18n-attr');
    for (const [attr, k] of attrSpec ? pairs(attrSpec) : []) {
      if ((val(attr) ?? '') !== escapeHtml(STRINGS[k]?.ar ?? '\0')) problems.push(`@${attr} of [data-i18n-attr] is not the Arabic of ${k}`);
    }
    const initial = val('data-i18n-initial');
    for (const [attr, k] of initial ? pairs(initial) : []) {
      const want = escapeHtml(filled(k, 'ar', val('data-i18n-vars')));
      if ((attr === 'text' ? inner() : val(attr) ?? '') !== want) problems.push(`${attr === 'text' ? 'the text' : '@' + attr} of [data-i18n-initial] is not the Arabic of ${k}`);
    }
  }
  return problems;
}

/**
 * @param pages page name -> its HTML file (rolldownOptions.input)
 * @param twinned the page names that get an Arabic twin
 */
export function arabicPages(pages: Record<string, string>, twinned: readonly string[]): Plugin {
  let root = '';
  return {
    name: 'tifo:arabic-pages',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const problems: string[] = [];
      const made: string[] = [];
      for (const name of twinned) {
        const file = pages[name];
        const fileName = Object.keys(bundle).find((n) => n.endsWith('.html') && file && pathKey(resolve(root, n)) === pathKey(file));
        const out = fileName ? bundle[fileName] : undefined;
        if (!fileName || !out || out.type !== 'asset') {
          problems.push(`${name}: its page is not in the bundle`);
          continue;
        }
        const english = String(out.source);
        let arabic: string;
        try {
          out.source = renderPage(english, 'en');
          arabic = renderPage(english, 'ar');
        } catch (e) {
          problems.push(`${fileName}: ${(e as Error).message}`);
          continue;
        }
        for (const p of checkArabicPage(arabic)) problems.push(`ar/${fileName}: ${p}`);
        this.emitFile({ type: 'asset', fileName: `ar/${fileName}`, source: arabic });
        made.push(`ar/${fileName}`);
      }
      if (problems.length) this.error(`Arabic pages:\n  ${problems.join('\n  ')}`);
      this.info?.(`Arabic pages: ${made.length} (${made.join(', ')})`);
    },
  };
}
