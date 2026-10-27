import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SAUDI_REAL_BLOCKS } from './src/core/realBlocksSaudi';
import { REAL_BLOCK_IDS } from './src/core/realBlockIds';
import { i18nTables } from './scripts/vite/i18nTables';
import { EARLIER_LAYOUT_IDS, LABEL_KEYS } from './src/ui/i18n/maps';
import { HERO_GROUND_KEYS } from './src/heroGrounds';
import HERO_TIFOS from './src/data/heroTifos.json';
import { precompress } from './scripts/vite/precompress';
import { fontPreload } from './scripts/vite/fontPreload';
import { arabicPages } from './scripts/vite/arabicPages';

const INPUT = {
  landing: resolve(__dirname, 'landing.html'),
  app: resolve(__dirname, 'index.html'),
  spec: resolve(__dirname, 'tifo-spec.html'),
  community: resolve(__dirname, 'community.html'),
  seat: resolve(__dirname, 'seat.html'),
  clubs: resolve(__dirname, 'clubs.html'),
  share: resolve(__dirname, 'share.html'),
  legal: resolve(__dirname, 'legal.html'),
  reset: resolve(__dirname, 'reset.html'),
  account: resolve(__dirname, 'account.html'),
  projects: resolve(__dirname, 'projects.html'),
};

/**
 * The pages built a second time in Arabic, served under /ar/ (performance
 * plan P3.3; scripts/vite/arabicPages.ts). Every page whose words exist in
 * Arabic. Not the .tifo spec: it is written in English only, and an "Arabic"
 * page of English text would be read aloud in the wrong language.
 */
const ARABIC_TWINS = Object.keys(INPUT).filter((name) => name !== 'spec');

/**
 * theme-boot.js under a content-hashed name (performance plan P1.29).
 *
 * It is the one render-blocking script on the public pages, and as a plain
 * public/ file it was served max-age=0: every repeat view paid a revalidation
 * round trip (about 240 ms from Saudi Arabia) before the first paint. Under
 * /assets/ with a hash in its name it is cached for good like every other
 * built file, and a change to it is a new URL.
 *
 * It stays an external same-origin classic script: no inlining, so the CSP
 * keeps script-src 'self' with no 'unsafe-inline', hash or nonce. The source
 * stays in public/ so the dev server serves it as before; the build emits the
 * hashed copy, rewrites the tag in every page, and removes the unhashed copy
 * from dist/ so only one version exists.
 *
 * The build FAILS unless every page that references it was rewritten. The
 * server renders /, /community, /clubs, /s/:id and the rest from these
 * dist/*.html files, so a page left on the old name would quietly lose its
 * theme (and the /community no-flash class) after the next deploy.
 */
function hashThemeBoot(): Plugin {
  const SRC = resolve(__dirname, 'public/theme-boot.js');
  const TAG = '<script src="/theme-boot.js"></script>';
  return {
    name: 'tifo:hash-theme-boot',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const source = readFileSync(SRC, 'utf8');
      const hash = createHash('sha256').update(source).digest('base64url').slice(0, 10);
      const fileName = `assets/theme-boot-${hash}.js`;
      this.emitFile({ type: 'asset', fileName, source });

      const expected = Object.values(INPUT).filter((f) => readFileSync(f, 'utf8').includes(TAG)).length;
      let rewritten = 0;
      for (const out of Object.values(bundle)) {
        if (out.type !== 'asset' || !out.fileName.endsWith('.html')) continue;
        const html = String(out.source);
        if (!html.includes(TAG)) continue;
        out.source = html.split(TAG).join(`<script src="/${fileName}"></script>`);
        rewritten++;
      }
      const left = Object.values(bundle).filter(
        (o) => o.type === 'asset' && o.fileName.endsWith('.html') && /["']\/theme-boot\.js["']/.test(String(o.source)),
      );
      if (expected === 0 || rewritten !== expected || left.length) {
        this.error(
          `theme-boot.js: ${rewritten} of ${expected} page(s) rewritten to /${fileName}` +
            (left.length ? `; still on the old name: ${left.map((o) => o.fileName).join(', ')}` : ''),
        );
      }
      this.info?.(`theme-boot.js -> /${fileName} in ${rewritten} pages`);
    },
    writeBundle(options) {
      // public/ is copied into dist/ before the bundle is written. The hashed
      // copy is the only one any page names; the old path is left to 404.
      if (options.dir) rmSync(join(options.dir, 'theme-boot.js'), { force: true });
    },
  };
}

/**
 * The built pages, not only their sources, carry no inline script and no
 * script from another origin. The CSP (script-src 'self', no 'unsafe-inline')
 * would refuse either at run time, silently; this refuses them at build time,
 * after every rewrite above has run.
 */
function checkBuiltScripts(): Plugin {
  return {
    name: 'tifo:check-built-scripts',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type !== 'asset' || !out.fileName.endsWith('.html')) continue;
        const html = String(out.source);
        if (/<script(?![^>]*\bsrc=)(?![^>]*\btype=[\"']?application\/ld\+json)[^>]*>\s*\S/i.test(html)) this.error(`${out.fileName}: an inline <script>`);
        for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)) {
          if (!m[1].startsWith('/') || m[1].startsWith('//')) this.error(`${out.fileName}: a script from outside this origin: ${m[1]}`);
        }
      }
    },
  };
}

/**
 * src/core/realBlockIds.ts is a hand-kept copy of which grounds were rebuilt in
 * their real blocks, so i18n can label them without importing the Saudi
 * geometry builders into every page (performance plan P1.15). A copy can drift,
 * so the build fails the moment it does.
 */
function checkRealBlockIds(): Plugin {
  return {
    name: 'tifo:check-real-block-ids',
    buildStart() {
      const want = Object.fromEntries(Object.entries(SAUDI_REAL_BLOCKS).map(([oldId, l]) => [oldId, l.id]));
      const a = JSON.stringify(Object.entries(want).sort());
      const b = JSON.stringify(Object.entries(REAL_BLOCK_IDS).sort());
      if (a !== b) this.error(`src/core/realBlockIds.ts is out of step with SAUDI_REAL_BLOCKS: expected ${a}, found ${b}`);
    },
  };
}

/**
 * src/heroGrounds.ts names the label key of each hero tifo's ground, so the
 * landing does not need the whole ground-name map to caption its hero
 * (performance plan P2.6). It is a hand-kept copy of what tl() would answer,
 * so the build fails the moment it differs for any tifo in heroTifos.json.
 */
function checkHeroGrounds(): Plugin {
  return {
    name: 'tifo:check-hero-grounds',
    buildStart() {
      for (const { templateId } of HERO_TIFOS as { templateId: string }[]) {
        const want = LABEL_KEYS[templateId];
        if (!want || EARLIER_LAYOUT_IDS.includes(templateId) || HERO_GROUND_KEYS[templateId] !== want) {
          this.error(`src/heroGrounds.ts: ${templateId} should map to ${want ?? '(a ground with a label)'}, found ${HERO_GROUND_KEYS[templateId] ?? 'nothing'}`);
        }
      }
    },
  };
}

// Two entry points: the marketing landing (served at /) and the editor app
// (served at /app and for /d/:id share links). Both build into dist/.
export default defineConfig({
  plugins: [checkRealBlockIds(), checkHeroGrounds(), i18nTables(INPUT), hashThemeBoot(), arabicPages(INPUT, ARABIC_TWINS), fontPreload(INPUT), checkBuiltScripts(), precompress()],
  build: {
    target: 'es2022',
    // Vite 8 bundles with Rolldown (performance plan P3.8). Its options are
    // rolldownOptions; rollupOptions and manualChunks are deprecated aliases.
    rolldownOptions: {
      input: INPUT,
      output: {
        codeSplitting: {
          groups: [
            /**
             * three.js in a chunk of its own (performance plan P2.19).
             *
             * It used to share a chunk with preview3d.ts and the code around it, so
             * any change to the 3D code (19 of the last 59 commits) gave the chunk a
             * new hash and every returning visitor downloaded three again: about
             * 139 KB gz for a library that had not changed. On its own, its file
             * name changes only when three itself (or the set of its exports the
             * app uses) does. It is still loaded exactly where it was: only by the
             * 3D code that imports it, never at page load where it was not before
             * (e2e-pages-load checks both).
             */
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]build[\\/]/ },
          ],
        },
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
