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
 * Not the Arabic pages (performance plan P3.3; scripts/vite/arabicPages.ts).
 * Their text is nearly all Arabic, which Inter has no letters for, and on a
 * slow link a font preload competes with the render-blocking stylesheet
 * while font-display: swap paints the text anyway. Measured on a phone-class
 * CPU at 1.6 Mbit/s and 250 ms a request, Arabic text first appeared at
 * landing 1405 ms with Inter and Almarai Arabic 400 preloaded, 1125 ms with
 * Inter alone and 1021 ms with neither (community 1197 / 963 / 909, clubs
 * 1353 / 1097 / 988, /t 1102 / 897 / 769). So they preload no font.
 *
 * The build FAILS unless every English page has exactly that one preload,
 * naming an asset that exists and that the page's own CSS references, and
 * every Arabic page none; and unless the language toggle's tiny
 * font (src/vendor/almarai-toggle.css) still covers every letter of the
 * toggle's label.
 */
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { pathKey } from './pathKey';
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
      // The Arabic pages (made just before this, by arabicPages) were copied
      // from the English ones with its Inter preload; they keep none.
      const twins = Object.values(bundle).filter((o) => o.type === 'asset' && /^ar\/[\w-]+\.html$/.test(o.fileName));
      for (const out of twins) {
        if (out.type !== 'asset') continue;
        out.source = String(out.source).replace(/\n?\s*<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/g, '');
      }
      const check = (name: string, html: string, want: RegExp[]): void => {
        const preloads = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)].map((m) => m[0]);
        const fonts = preloads.filter((l) => /\bas="font"/.test(l));
        if (fonts.length !== want.length) {
          problems.push(`${name}: ${fonts.length} font preloads, expected ${want.length}`);
          return;
        }
        const sheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/([^"]+)"/g)].map((m) => m[1]!);
        fonts.forEach((tag, i) => {
          const href = /\bhref="\/([^"]+)"/.exec(tag)?.[1] ?? '';
          if (!want[i]!.test(href) || !bundle[href]) problems.push(`${name}: preloads ${href || 'nothing'}, which is not the built ${want[i]!.source}`);
          if (!/\bcrossorigin\b/.test(tag) || !/\btype="font\/woff2"/.test(tag)) problems.push(`${name}: the font preload lacks crossorigin or its type`);
          // And the page's own CSS uses that very file, so the preload is the request the CSS would make.
          const usedByCss = sheets.some((s) => {
            const css = bundle[s];
            return css && css.type === 'asset' && String(css.source).includes(href.replace(/^assets\//, ''));
          });
          if (!usedByCss) problems.push(`${name}: its CSS (${sheets.join(', ') || 'none'}) does not reference the preloaded ${href}`);
        });
      };
      for (const file of Object.values(pages)) {
        const name = Object.keys(bundle).find((n) => n.endsWith('.html') && pathKey(resolve(root, n)) === pathKey(file));
        const out = name ? bundle[name] : undefined;
        if (!out || out.type !== 'asset') {
          problems.push(`${file}: not in the bundle`);
          continue;
        }
        check(name!, String(out.source), [MAIN_FONT]);
      }
      for (const out of twins) if (out.type === 'asset') check(out.fileName, String(out.source), []);
      if (problems.length) this.error(`font preload:\n  ${problems.join('\n  ')}`);
    },
  };
}
