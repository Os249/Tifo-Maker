/**
 * Translation tables split by page, and by the code that needs them
 * (performance plan P2.6).
 *
 * Every page used to load one chunk holding both languages of every page's
 * strings (about 66 KB gz) for the few hundred keys it can show. Now no chunk
 * carries strings it cannot use: each built chunk carries the strings its own
 * modules name (and an entry chunk, those of its page's HTML), minus the ones a
 * chunk it imports statically already carries, in BOTH languages. So a page
 * downloads at start the strings of the code it runs at start, the strings of
 * a dialog or of Match Day arrive with that code when it is loaded, and the
 * language toggle never needs a download.
 *
 * A chunk hands its table to ui/i18n.ts through a same-origin queue,
 * `globalThis.__tifoStrings.push(table)`, as the first statement of the chunk,
 * so the strings are in place before any module in it runs (the chunks it
 * imports have run already, and theirs are in place too). No inline script,
 * no eval, nothing from another origin: the tables are part of the same
 * hashed /assets files as the code, under script-src 'self'.
 *
 * Which keys a module names (the same rules everywhere below):
 *  - any quoted string that is a key ('cm.remix', "cm.remix", `cm.remix`,
 *    data-i18n="cm.remix", { labelKey: 'mn.home' });
 *  - the keys inside data-i18n-attr="title:a.b,aria-label:c.d";
 *  - whole families for keys built at run time from a literal prefix:
 *    t(`bn.rev.${r}`), t('cm.colour.' + id), t(`pw.level${n}`);
 *  - tTag() brings the tag.* family;
 *  - an entry chunk also carries its page's HTML keys and the data-i18n keys
 *    the server writes into the pages it renders.
 *
 * The build FAILS when:
 *  - a string in ui/i18n/strings.ts lacks its English or its Arabic;
 *  - code calls t()/tv() with, or HTML carries, a key that does not exist;
 *  - a chunk's built modules (scanned again from the output) name a key that
 *    neither it nor a chunk it statically imports registers, or a registered
 *    table did not make it into the final code.
 * What no rule can see (a key that arrives whole from somewhere else) is the
 * runtime fallback's job: ui/i18n.ts then fetches the full table once.
 *
 * The two lookup maps (ui/i18n/maps.ts) are modules of their own,
 * `virtual:tifo-i18n/labels` (tl(), tlBoth(): every ground, palette and
 * pattern name) and `virtual:tifo-i18n/errors` (tErr(): the server's error
 * messages), each registering its map and the strings it points at. A module
 * that calls those functions directly gets a static import of the module at
 * build time, so Rollup loads it once, shared, before that code runs; code
 * that needs one only after an await asks ui/i18n.ts for it (loadLabels(),
 * tErrLater()), and no page carries it at start. The build fails if a chunk
 * calls one directly without the module loaded before it.
 */
import type { Plugin, Rollup } from 'vite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { STRINGS } from '../../src/ui/i18n/strings';
import { EARLIER_LAYOUT_IDS, ERROR_KEYS, LABEL_KEYS } from '../../src/ui/i18n/maps';

/** The queue a chunk pushes its table onto (ui/i18n.ts drains it). */
export const QUEUE = '__tifoStrings';
const LABELS_ID = 'virtual:tifo-i18n/labels';
const ERRORS_ID = 'virtual:tifo-i18n/errors';
const RESOLVED_LABELS = '\0tifo-i18n/labels';
const RESOLVED_ERRORS = '\0tifo-i18n/errors';
/** An import of ui/i18n.ts, from wherever in src/ (static or dynamic). */
const IMPORTS_I18N = /(?:\bfrom|\bimport\s*\()\s*['"](?:\.{1,2}\/)+(?:ui\/)?i18n['"]/;

const KEYS = Object.keys(STRINGS);
const KEYSET = new Set(KEYS);

/** Quoted strings shaped like a key; the closing quote is looked at, not eaten. */
const QUOTED = /(['"`])([A-Za-z][\w.-]*)(?=\1)/g;
/** Template-literal heads: `bn.rev.${ ... */
const TEMPLATE_HEAD = /`([A-Za-z][\w.-]*)\$\{/g;
/** data-i18n-attr="attr:key,attr:key" (quotes possibly escaped inside a JS string). */
const ATTR_SPEC = /data-i18n-attr=\\?["']([^"'\\]*)/g;
/** Literal keys handed to t()/tv() (and the aliases the editor imports them as). */
const T_CALL = /\b(?:t|tv|tr|i18nT)\(\s*(['"`])([A-Za-z][\w.-]*\.[\w.-]+)\1\s*[,)]/g;
const DATA_I18N = /data-i18n=\\?["']([^"'\\]+)/g;

const LABEL_FAMILY = [...new Set(Object.values(LABEL_KEYS)), 'sp.earlierLayout'];
const ERROR_FAMILY = [...new Set(Object.values(ERROR_KEYS))];

/** What a piece of code or markup names. */
export interface Named {
  keys: Set<string>;
  /** Prefixes of families named in full (each holds at least one key). */
  families: Set<string>;
  labels: boolean;
  errors: boolean;
}
const named = (): Named => ({ keys: new Set(), families: new Set(), labels: false, errors: false });

function familyKeys(prefix: string): string[] {
  return KEYS.filter((k) => k.startsWith(prefix));
}

/** The keys and key families a piece of code or markup names. */
export function scan(text: string, into: Named = named()): Named {
  const prefix = (p: string): void => {
    if (!p.includes('.') || into.families.has(p)) return;
    const ks = familyKeys(p);
    if (!ks.length) return;
    into.families.add(p);
    for (const k of ks) into.keys.add(k);
  };
  for (const m of text.matchAll(QUOTED)) {
    const s = m[2]!;
    if (KEYSET.has(s)) into.keys.add(s);
    else if (/[._-]$/.test(s)) prefix(s);
  }
  for (const m of text.matchAll(TEMPLATE_HEAD)) prefix(m[1]!);
  for (const m of text.matchAll(ATTR_SPEC)) {
    for (const pair of m[1]!.split(',')) {
      const k = pair.split(':')[1]?.trim();
      if (k && KEYSET.has(k)) into.keys.add(k);
    }
  }
  return into;
}

/** What a module that imports ui/i18n.ts asks of it besides plain keys. */
function scanUse(code: string, into: Named): void {
  if (/\btl(?:Both)?\b/.test(code) && !/\bloadLabels\b/.test(code)) into.labels = true;
  if (/\btErr\b/.test(code)) into.errors = true;
  if (/\btTag\b/.test(code)) {
    into.families.add('tag.');
    for (const k of familyKeys('tag.')) into.keys.add(k);
  }
}

/** What a map module registers: the map and the strings it points at. */
function mapTable(which: 'labels' | 'errors'): ChunkTable {
  const keys = which === 'labels' ? LABEL_FAMILY : ERROR_FAMILY;
  const table: ChunkTable = { strings: Object.fromEntries(keys.map((k) => [k, [STRINGS[k]!.en, STRINGS[k]!.ar] as const])) };
  if (which === 'labels') {
    table.labels = LABEL_KEYS;
    table.earlier = EARLIER_LAYOUT_IDS;
  } else table.errors = { ...ERROR_KEYS };
  return table;
}

/** A map module's code. */
function mapModule(i18nImport: string, which: 'labels' | 'errors'): string {
  return `import { registerStrings } from ${JSON.stringify(i18nImport)};\nregisterStrings(${JSON.stringify(mapTable(which))});\n`;
}

/** Keys code or HTML names explicitly that are not strings anywhere (typos, deleted keys). */
export function unknownKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(T_CALL)) if (!KEYSET.has(m[2]!)) out.add(m[2]!);
  for (const m of text.matchAll(DATA_I18N)) if (!m[1]!.includes('${') && !KEYSET.has(m[1]!)) out.add(m[1]!);
  for (const m of text.matchAll(ATTR_SPEC)) {
    for (const pair of m[1]!.split(',')) {
      const k = pair.split(':')[1]?.trim();
      if (k && !k.includes('${') && !KEYSET.has(k)) out.add(k);
    }
  }
  return [...out];
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** What one chunk registers (the shape ui/i18n.ts's registerStrings takes). */
export interface ChunkTable {
  strings: Record<string, readonly [string, string]>;
  families?: string[];
  labels?: Record<string, string>;
  earlier?: readonly string[];
  errors?: Record<string, string>;
}

type ChunkLike = Pick<Rollup.RenderedChunk, 'fileName' | 'imports' | 'dynamicImports' | 'modules' | 'isEntry' | 'facadeModuleId'>;
type Ctx = Pick<Rollup.PluginContext, 'getModuleInfo'>;

/**
 * @param pages page name -> its HTML file (the same map as rollupOptions.input)
 */
export function i18nTables(pages: Record<string, string>): Plugin[] {
  let root = '';
  let serve = false;
  let i18nId = '';
  let stringsId = '';
  let mapsId = '';
  /** HTML file -> its source, for the pages with a script */
  const html = new Map<string, string>();
  let serverKeys = new Set<string>();
  /** preliminary chunk file name -> what was injected into it */
  const injected = new Map<string, ChunkTable>();
  /** preliminary chunk file name -> what its own modules name (render phase only) */
  const ownMemo = new Map<string, Named>();

  const skip = (id: string): boolean =>
    id.startsWith('\0') || id.includes('/node_modules/') || id === i18nId || id === stringsId || id === mapsId ||
    /\.(css|woff2?|png|webp|svg|json)(\?|$)/.test(id);

  /** What a chunk's own modules (and, for an entry, its page) name. */
  function ownOf(ctx: Ctx, chunk: ChunkLike): Named {
    const n = named();
    for (const [mid, rm] of Object.entries(chunk.modules)) {
      if (skip(mid) || !rm.code) continue;
      scan(rm.code, n);
      const info = ctx.getModuleInfo(mid);
      if (info && (info.importedIds.includes(i18nId) || info.dynamicallyImportedIds.includes(i18nId))) scanUse(info.code ?? rm.code, n);
    }
    const page = chunk.isEntry && chunk.facadeModuleId ? html.get(chunk.facadeModuleId) : undefined;
    if (page !== undefined) {
      scan(page, n);
      for (const k of serverKeys) n.keys.add(k);
    }
    return n;
  }

  /** The chunks that have run before this one's body does: its static imports, transitively, minus any it is in a cycle with. */
  function ancestors(name: string, all: Record<string, Pick<ChunkLike, 'imports'>>): string[] {
    const memo = new Map<string, Set<string>>();
    const reach = (from: string): Set<string> => {
      const hit = memo.get(from);
      if (hit) return hit;
      const seen = new Set<string>();
      const stack = [...(all[from]?.imports ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        stack.push(...(all[c]?.imports ?? []));
      }
      memo.set(from, seen);
      return seen;
    };
    return [...reach(name)].filter((a) => !reach(a).has(name));
  }

  /**
   * The dev server has no chunks to put tables in: it registers every string
   * up front, so every page, test harness and shot script there behaves as
   * before. (Before the TypeScript transform, so Vite then resolves these
   * imports like any other.)
   */
  const dev: Plugin = {
    name: 'tifo:i18n-tables-dev',
    apply: 'serve',
    enforce: 'pre',
    transform(code, rawId) {
      if (rawId.split('?')[0] !== resolve(root, 'src/ui/i18n.ts')) return null;
      return (
        code +
        `\nimport { STRINGS as __tifoAll } from './i18n/strings';` +
        `\nimport { EARLIER_LAYOUT_IDS as __tifoEarlier, ERROR_KEYS as __tifoErrors, LABEL_KEYS as __tifoLabels } from './i18n/maps';` +
        `\nregisterStrings({ strings: Object.fromEntries(Object.entries(__tifoAll).map(([k, v]) => [k, [v.en, v.ar] as const])), families: [''], labels: __tifoLabels, earlier: __tifoEarlier, errors: __tifoErrors });\n`
      );
    },
  };

  const main: Plugin = {
    name: 'tifo:i18n-tables',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      serve = config.command === 'serve';
      i18nId = resolve(root, 'src/ui/i18n.ts');
      stringsId = resolve(root, 'src/ui/i18n/strings.ts');
      mapsId = resolve(root, 'src/ui/i18n/maps.ts');
    },

    buildStart() {
      if (serve) return;
      injected.clear();
      ownMemo.clear();
      // Both languages, never empty, for every string.
      const gaps = Object.entries(STRINGS).filter(([, v]) => !v || !v.en?.trim() || !v.ar?.trim()).map(([k]) => k);
      if (gaps.length) this.error(`i18n: ${gaps.length} string(s) without both English and Arabic: ${gaps.slice(0, 20).join(', ')}`);
      for (const file of Object.values(pages)) {
        const src = readFileSync(file, 'utf8');
        const unknown = unknownKeys(src);
        if (unknown.length) this.error(`i18n: ${file} names key(s) that do not exist: ${unknown.join(', ')}`);
        if (/<script\s+type="module"/.test(src)) html.set(file, src);
      }
      // Labels the server writes into the HTML it renders (the landing's Tifo
      // of the Day card, for one): every page's entry gets them, a handful.
      serverKeys = new Set();
      for (const f of walkFiles(resolve(root, 'server/src'))) {
        for (const m of readFileSync(f, 'utf8').matchAll(DATA_I18N)) if (KEYSET.has(m[1]!)) serverKeys.add(m[1]!);
      }
    },

    resolveId(source) {
      if (source === LABELS_ID) return RESOLVED_LABELS;
      if (source === ERRORS_ID) return RESOLVED_ERRORS;
      return null;
    },

    load(id) {
      // Root-relative on the dev server, the file itself in the build.
      const from = serve ? '/src/ui/i18n.ts' : i18nId;
      if (id === RESOLVED_LABELS) return mapModule(from, 'labels');
      if (id === RESOLVED_ERRORS) return mapModule(from, 'errors');
      return null;
    },

    // After the TypeScript transform, so the code read here is what runs:
    // no types, no comments (a comment that mentions tl() is not a call).
    transform: {
      order: 'post',
      handler(code, rawId) {
        if (serve) return null;
        const id = rawId.split('?')[0]!;
        // A module that calls tl()/tlBoth() or tErr() directly gets the map
        // module as a static import: loaded, and registered, before it runs.
        if (!/\.(ts|js|mjs)$/.test(id) || skip(id) || !IMPORTS_I18N.test(code)) return null;
        const use = named();
        scanUse(code, use);
        const add = (use.labels ? `import ${JSON.stringify(LABELS_ID)};` : '') + (use.errors ? `import ${JSON.stringify(ERRORS_ID)};` : '');
        // On the first line, ahead of everything, so line numbers do not move.
        return add ? { code: add + code, map: null } : null;
      },
    },

    renderChunk(code, chunk, _options, meta) {
      const ownMemoized = (c: Rollup.RenderedChunk): Named => {
        let o = ownMemo.get(c.fileName);
        if (!o) ownMemo.set(c.fileName, (o = ownOf(this, c)));
        return o;
      };
      const own = ownMemoized(chunk);
      if (!own.keys.size) return null;
      const before = ancestors(chunk.fileName, meta.chunks).map((a) => meta.chunks[a]).filter((c): c is Rollup.RenderedChunk => !!c);
      const have = named();
      for (const a of before) {
        const o = ownMemoized(a);
        for (const k of o.keys) have.keys.add(k);
        for (const f of o.families) have.families.add(f);
      }
      const table: ChunkTable = { strings: {} };
      for (const k of [...own.keys].sort()) if (!have.keys.has(k)) table.strings[k] = [STRINGS[k]!.en, STRINGS[k]!.ar];
      const families = [...own.families].filter((f) => !have.families.has(f)).sort();
      if (families.length) table.families = families;
      if (!Object.keys(table.strings).length && !table.families) return null;
      injected.set(chunk.fileName, table);
      // First statement of the chunk: imports are hoisted, so this runs after
      // the chunks it imports and before any of its own modules.
      return { code: `(globalThis.${QUEUE}||(globalThis.${QUEUE}=[])).push(${JSON.stringify(table)});\n` + code, map: null };
    },

    generateBundle(_options, bundle) {
      if (serve) return;
      const problems: string[] = [];
      const chunks = Object.values(bundle).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');
      const byName = new Map(chunks.map((c) => [c.fileName, c] as const));
      const tableOf = (c: Rollup.OutputChunk): ChunkTable | undefined => injected.get(c.preliminaryFileName);
      for (const c of chunks) {
        // Keys that do not exist, named by code that uses ui/i18n.ts.
        for (const mid of Object.keys(c.modules)) {
          if (skip(mid)) continue;
          const info = this.getModuleInfo(mid);
          if (!info?.code || !(info.importedIds.includes(i18nId) || info.dynamicallyImportedIds.includes(i18nId))) continue;
          const unknown = unknownKeys(info.code);
          if (unknown.length) problems.push(`${mid.slice(root.length + 1)} names key(s) that do not exist: ${unknown.join(', ')}`);
        }
        const table = tableOf(c);
        if (table && !c.code.includes(`${QUEUE}`)) problems.push(`${c.fileName}: its string table is missing from the final code`);
        // Everything the chunk's modules name, scanned again from the output,
        // must be registered by the chunk or by one that has run before it.
        const need = ownOf(this, c);
        const avail = new Set<string>(Object.keys(table?.strings ?? {}));
        let labels = c.moduleIds.includes(RESOLVED_LABELS);
        let errors = c.moduleIds.includes(RESOLVED_ERRORS);
        const all = Object.fromEntries(chunks.map((x) => [x.fileName, x]));
        for (const a of ancestors(c.fileName, all)) {
          const ac = byName.get(a)!;
          const t = tableOf(ac);
          for (const k of Object.keys(t?.strings ?? {})) avail.add(k);
          labels ||= ac.moduleIds.includes(RESOLVED_LABELS);
          errors ||= ac.moduleIds.includes(RESOLVED_ERRORS);
        }
        const lacking = [...need.keys].filter((k) => !avail.has(k));
        if (lacking.length) problems.push(`${c.fileName}: names ${lacking.length} key(s) no table before it registers: ${lacking.slice(0, 15).join(', ')}`);
        if (need.labels && !labels) problems.push(`${c.fileName}: calls tl() but the label map is not loaded before it`);
        if (need.errors && !errors) problems.push(`${c.fileName}: calls tErr() but the error map is not loaded before it`);
        for (const [k, v] of Object.entries(table?.strings ?? {})) if (!v[0]?.trim() || !v[1]?.trim()) problems.push(`${c.fileName}: "${k}" lacks a language`);
      }
      // Every page with a script has its entry chunk, and so its HTML's keys.
      for (const file of html.keys()) {
        if (!chunks.some((c) => c.isEntry && c.facadeModuleId === file)) problems.push(`${file}: no entry chunk`);
      }
      if (problems.length) this.error(`i18n:\n  ${problems.join('\n  ')}`);

      // What each page holds at start (its entry and the chunks that entry
      // imports statically) and in all (everything it may load later).
      const kb = (t: ChunkTable[]): string => (gzipSync(JSON.stringify(t)).length / 1024).toFixed(1);
      for (const [page, file] of Object.entries(pages)) {
        const entry = chunks.find((c) => c.isEntry && c.facadeModuleId === file);
        if (!entry) continue;
        const startNames = new Set([entry.fileName, ...ancestors(entry.fileName, Object.fromEntries(chunks.map((x) => [x.fileName, x])))]);
        const reach = new Set<string>();
        const stack = [entry.fileName];
        while (stack.length) {
          const n = stack.pop()!;
          if (reach.has(n)) continue;
          reach.add(n);
          const c = byName.get(n);
          if (c) stack.push(...c.imports, ...c.dynamicImports);
        }
        const tables = (names: Set<string>): ChunkTable[] =>
          [...names].flatMap((n) => {
            const c = byName.get(n)!;
            return [
              tableOf(c),
              c.moduleIds.includes(RESOLVED_LABELS) ? mapTable('labels') : undefined,
              c.moduleIds.includes(RESOLVED_ERRORS) ? mapTable('errors') : undefined,
            ].filter((t): t is ChunkTable => !!t);
          });
        const count = (t: ChunkTable[]): number => new Set(t.flatMap((x) => Object.keys(x.strings))).size;
        const start = tables(startNames);
        const later = tables(reach);
        this.info?.(`i18n ${page}: ${count(start)} keys at start (${kb(start)} KB gz), ${count(later)} with everything it can load (${kb(later)} KB gz)`);
      }
    },
  };

  return [dev, main];
}
