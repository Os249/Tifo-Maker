import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SAUDI_REAL_BLOCKS } from './src/core/realBlocksSaudi';
import { REAL_BLOCK_IDS } from './src/core/realBlockIds';

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
        if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) this.error(`${out.fileName}: an inline <script>`);
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

// Two entry points: the marketing landing (served at /) and the editor app
// (served at /app and for /d/:id share links). Both build into dist/.
export default defineConfig({
  plugins: [checkRealBlockIds(), hashThemeBoot(), checkBuiltScripts()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: INPUT,
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
