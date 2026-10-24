/**
 * Brotli and gzip copies of every text file in dist/, made once at build time
 * (performance plan P2.3).
 *
 * Railway's edge compresses with gzip on the fly; brotli at quality 11 is about
 * 17% smaller on this site's JavaScript and CSS, but far too slow to run per
 * request (and dynamic compression on a 2-core box is a CPU lever for anyone
 * who can send requests). So the build writes `<file>.br` (quality 11) and
 * `<file>.gz` (level 9) next to each compressible file, and the server hands
 * them out with @fastify/static's `preCompressed: true`, compressing nothing
 * itself.
 *
 * Why this is safe (BREACH): these are public, static, secret-free files that
 * are the same for every visitor. No response that carries a secret, reflects
 * request input and rides on an ambient credential is touched; sessions are
 * bearer tokens, not cookies, and dynamic responses are never compressed here.
 * Images and fonts are already compressed and are left alone.
 *
 * Contract with the server agent: a pair exists only when it is smaller than
 * the original, and every pair decompresses to the original byte for byte; the
 * build FAILS otherwise, so a corrupt or truncated `.br` can never ship and be
 * served to a browser that would then run garbage or nothing.
 */
import type { Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompressSync, constants as Z, gzip, gunzipSync } from 'node:zlib';

/** The text types the server serves from dist/ (contract: js, mjs, css, html, svg, json, txt, xml, wasm). */
export const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);

const br = promisify(brotliCompress);
const gz = promisify(gzip);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export interface PrecompressResult {
  files: number;
  br: number;
  gz: number;
  rawBytes: number;
  brBytes: number;
  gzBytes: number;
}

/** Writes and verifies the pairs for every compressible file under `dir`. Throws on any mismatch. */
export async function precompressDir(dir: string): Promise<PrecompressResult> {
  const files = walk(dir).filter((f) => COMPRESSIBLE.has(extname(f)));
  const res: PrecompressResult = { files: files.length, br: 0, gz: 0, rawBytes: 0, brBytes: 0, gzBytes: 0 };
  // A handful at a time: zlib's async calls run on the libuv pool (4 threads),
  // and brotli 11 on the largest chunks takes a second or two each.
  const queue = [...files];
  const work = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const raw = readFileSync(f);
      res.rawBytes += raw.length;
      const [b, g] = await Promise.all([
        br(raw, {
          params: {
            [Z.BROTLI_PARAM_QUALITY]: 11,
            [Z.BROTLI_PARAM_MODE]: extname(f) === '.wasm' ? Z.BROTLI_MODE_GENERIC : Z.BROTLI_MODE_TEXT,
            [Z.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        }),
        gz(raw, { level: 9 }),
      ]);
      // Byte-for-byte round trip before anything is written: the build stops
      // here rather than ship a pair the server would hand to browsers.
      if (b.length < raw.length) {
        if (!brotliDecompressSync(b).equals(raw)) throw new Error(`precompress: ${relative(dir, f)}.br does not decompress to the original`);
        writeFileSync(f + '.br', b);
        res.br++;
        res.brBytes += b.length;
      } else res.brBytes += raw.length;
      if (g.length < raw.length) {
        if (!gunzipSync(g).equals(raw)) throw new Error(`precompress: ${relative(dir, f)}.gz does not decompress to the original`);
        writeFileSync(f + '.gz', g);
        res.gz++;
        res.gzBytes += g.length;
      } else res.gzBytes += raw.length;
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  return res;
}

/**
 * Checks what is on disk, independently of the writer above: every `.br` and
 * `.gz` sits next to a compressible original, is smaller than it, and
 * decompresses to it exactly. Returns the problems found (empty when sound).
 */
export function verifyPrecompressed(dir: string): string[] {
  const problems: string[] = [];
  for (const f of walk(dir)) {
    const ext = extname(f);
    if (ext !== '.br' && ext !== '.gz') continue;
    const orig = f.slice(0, -ext.length);
    const name = relative(dir, f);
    let raw: Buffer;
    try {
      raw = readFileSync(orig);
    } catch {
      problems.push(`${name}: no original next to it`);
      continue;
    }
    if (!COMPRESSIBLE.has(extname(orig))) problems.push(`${name}: not a text type`);
    const packed = readFileSync(f);
    if (packed.length >= raw.length) problems.push(`${name}: not smaller than the original`);
    let back: Buffer | null = null;
    try {
      back = ext === '.br' ? brotliDecompressSync(packed) : gunzipSync(packed);
    } catch (e) {
      problems.push(`${name}: does not decompress (${(e as Error).message})`);
      continue;
    }
    if (!back.equals(raw)) problems.push(`${name}: decompresses to something other than the original`);
  }
  return problems;
}

/**
 * The plugin: runs once the whole of dist/ is on disk (public/ copied, every
 * page written, theme-boot.js's unhashed copy removed), and only after a
 * successful write.
 */
export function precompress(): Plugin {
  let outDir = '';
  let written = false;
  return {
    name: 'tifo:precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    writeBundle() {
      written = true;
    },
    async closeBundle() {
      if (!written) return;
      const t0 = Date.now();
      const r = await precompressDir(outDir);
      const problems = verifyPrecompressed(outDir);
      if (problems.length) throw new Error(`precompress: ${problems.length} bad pair(s): ${problems.slice(0, 5).join('; ')}`);
      const kb = (n: number): string => (n / 1024).toFixed(0);
      this.info?.(
        `precompressed ${r.files} text files in ${Date.now() - t0} ms: ${r.br} .br, ${r.gz} .gz ` +
          `(${kb(r.rawBytes)} KB raw -> ${kb(r.gzBytes)} KB gzip-9 -> ${kb(r.brBytes)} KB brotli-11), every pair verified`,
      );
    },
  };
}
