/**
 * Preload the main font (performance plan P2.8).
 *
 * A font is only asked for once the CSS that names it has arrived and been
 * parsed, one round trip after the HTML (about 250 ms from Saudi Arabia), and
 * the text waits in a fallback face until it lands. Every page draws Inter
 * Latin at first paint, in English and in Arabic (digits, the wordmark,
 * handles), so each page gets
 *
 *   <link rel="preload" href="/assets/inter-latin-wght-normal-<hash>.woff2"
 *         as="font" type="font/woff2" crossorigin>
 *
 * in its head, naming the same hashed file the CSS uses (crossorigin because
 * fonts are always fetched in CORS mode; without it the preload would not be
 * reused and the font would download twice). It is a plain link written into
 * the HTML at build time, the way theme-boot.js is renamed: no inline script,
 * same origin, nothing for the CSP to allow.
 *
 * The build FAILS unless every page has exactly that one preload, naming an
 * asset that exists and that the page's own CSS references; and unless the
 * language toggle's tiny font (src/vendor/almarai-toggle.css) still covers
 * every letter of the toggle's label.
 */
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STRINGS } from '../../src/ui/i18n/strings';

/** The file every page draws its text with first. */
const MAIN_FONT = /^assets\/inter-latin-wght-normal-[\w-]+\.woff2$/;

export function fontPreload(pages: Record<string, string>): Plugin {
  let root = '';
  return {
    name: 'tifo:font-preload',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      // The toggle font must still draw the whole label (scripts/build-lang-font.mjs).
      const css = readFileSync(resolve(root, 'src/vendor/almarai-toggle.css'), 'utf8');
      const label = STRINGS['common.language']?.en ?? '';
      const ranges = [...css.matchAll(/unicode-range:\s*([^;]+);/g)].map((m) =>
        m[1]!.split(',').map((r) => {
          const [a, b] = r.trim().replace(/^U\+/i, '').split('-');
          return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as const;
        }),
      );
      const covered = (cp: number): boolean => ranges.length > 0 && ranges.every((rs) => rs.some(([a, b]) => cp >= a && cp <= b));
      const missing = [...label].filter((c) => !covered(c.codePointAt(0)!));
      if (!label || missing.length) {
        this.error(`src/vendor/almarai-toggle.css does not cover the toggle label "${label}" (missing ${missing.join(' ')}); run node scripts/build-lang-font.mjs`);
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx): HtmlTagDescriptor[] {
        const font = Object.values(ctx.bundle ?? {}).find((o) => o.type === 'asset' && MAIN_FONT.test(o.fileName));
        if (!font) throw new Error('font preload: the Inter Latin variable font is not in the bundle');
        return [
          {
            tag: 'link',
            attrs: { rel: 'preload', href: `/${font.fileName}`, as: 'font', type: 'font/woff2', crossorigin: true },
            injectTo: 'head',
          },
        ];
      },
    },
    generateBundle(_options, bundle) {
      const problems: string[] = [];
      for (const file of Object.values(pages)) {
        const name = Object.keys(bundle).find((n) => n.endsWith('.html') && resolve(root, n) === file);
        const out = name ? bundle[name] : undefined;
        if (!out || out.type !== 'asset') {
          problems.push(`${file}: not in the bundle`);
          continue;
        }
        const html = String(out.source);
        const preloads = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)].map((m) => m[0]);
        const fonts = preloads.filter((l) => /\bas="font"/.test(l));
        if (fonts.length !== 1) {
          problems.push(`${name}: ${fonts.length} font preloads, expected 1`);
          continue;
        }
        const href = /\bhref="\/([^"]+)"/.exec(fonts[0]!)?.[1] ?? '';
        if (!MAIN_FONT.test(href) || !bundle[href]) problems.push(`${name}: preloads ${href || 'nothing'}, which is not the built Inter Latin file`);
        if (!/\bcrossorigin\b/.test(fonts[0]!) || !/\btype="font\/woff2"/.test(fonts[0]!)) problems.push(`${name}: the font preload lacks crossorigin or its type`);
        // And the page's own CSS uses that very file, so the preload is the request the CSS would make.
        const sheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/([^"]+)"/g)].map((m) => m[1]!);
        const usedByCss = sheets.some((s) => {
          const css = bundle[s];
          return css && css.type === 'asset' && String(css.source).includes(href.replace(/^assets\//, ''));
        });
        if (!usedByCss) problems.push(`${name}: its CSS (${sheets.join(', ') || 'none'}) does not reference the preloaded ${href}`);
      }
      if (problems.length) this.error(`font preload:\n  ${problems.join('\n  ')}`);
    },
  };
}
