/**
 * Repack the template library: rebuild every card thumbnail and rewrite the
 * library in place.
 *
 * The first generation run wrote two bitmaps into every template — a 720x440 3D
 * stadium render and a 640px antialiased flat strip — plus the cells as
 * pretty-printed RLE, across 591 separate JSON files. That was 272 KB a
 * template and 176 MB in total, which is not a thing you commit. A template is
 * now one line of one file: the cells gzipped (the form the repo stores anyway)
 * and one indexed strip of about 2 KB.
 *
 * Re-runnable and idempotent, so a thumbnail change does not cost a fresh
 * eight-minute generation run. It also upgrades a library still in the old
 * directory-of-JSON layout.
 *
 *   npx tsx scripts/pack-templates.mts [--in server/data/templates.jsonl] [--dry]
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { stripPng, packCells, serialize, LIBRARY_FILE, type TemplateRecord } from './lib/strip.mjs';
import { generateSeatMap } from '../src/core/seatmap';
import { templateById } from '../src/core/stadiumCatalog';
import type { SeatMap } from '../src/core/types';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const inArg = opt('--in', LIBRARY_FILE);
const IN = inArg.startsWith('/') ? inArg : join(ROOT, inArg);
const DRY = args.includes('--dry');

/** Accepts the JSONL library, or the directory of JSON files it used to be. */
function load(path: string): { text: string; bytes: number; legacyDir: string | null } {
  if (existsSync(path) && statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => f.endsWith('.json') && f !== 'index.json');
    let bytes = 0;
    const lines = files.map((f) => {
      bytes += statSync(join(path, f)).size;
      return readFileSync(join(path, f), 'utf8');
    });
    return { text: lines.join('\n'), bytes, legacyDir: path };
  }
  return { text: readFileSync(path, 'utf8'), bytes: statSync(path).size, legacyDir: null };
}

const maps = new Map<string, SeatMap>();
const mapFor = (id: string): SeatMap => {
  let m = maps.get(id);
  if (!m) { m = generateSeatMap(templateById(id)!); maps.set(id, m); }
  return m;
};

function unrle(runs: [number, number][]): Uint8Array {
  let total = 0;
  for (const [, n] of runs) total += n;
  const out = new Uint8Array(total);
  let at = 0;
  for (const [v, n] of runs) { out.fill(v, at, at + n); at += n; }
  return out;
}

const { text, bytes: before, legacyDir } = load(IN);
const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
const out: string[] = [];
let n = 0, maxPng = 0;
for (const line of lines) {
  const j = JSON.parse(line) as Partial<TemplateRecord> & {
    cellsRle?: [number, number][]; flatPng?: string;
  };
  const map = mapFor(j.stadiumId!);
  const cells = j.cellsGzB64
    ? new Uint8Array(gunzipSync(Buffer.from(j.cellsGzB64, 'base64')))
    : unrle(j.cellsRle ?? []);
  if (cells.length !== map.count) throw new Error(`${j.id}: ${cells.length} cells, map wants ${map.count}`);

  const png = stripPng(map, cells, j.palette!);
  maxPng = Math.max(maxPng, png.length);
  const rec: TemplateRecord = {
    id: j.id!, titleEn: j.titleEn!, titleAr: j.titleAr!,
    stadiumId: j.stadiumId!, templateVersion: j.templateVersion ?? 1,
    palette: j.palette!, cellsGzB64: packCells(cells), tags: j.tags ?? [],
    archetype: j.archetype!, family: j.family!, club: j.club ?? null,
    thumbnailPng: png.toString('base64'),
    inkStands: j.inkStands ?? [],
    coverage: j.coverage ?? 0, contrast: j.contrast ?? 0,
  };
  out.push(serialize(rec));
  if (++n % 100 === 0) console.log(`  ${n}/${lines.length}`);
}
const text2 = out.join('\n') + '\n';
const target = legacyDir ? join(ROOT, LIBRARY_FILE) : IN;
if (!DRY) {
  writeFileSync(target, text2);
  if (legacyDir) rmSync(legacyDir, { recursive: true });
}
const mb = (b: number) => (b / 1048576).toFixed(2) + ' MB';
console.log(`${n} templates: ${mb(before)} -> ${mb(Buffer.byteLength(text2))}`);
console.log(`largest thumbnail: ${(maxPng / 1024).toFixed(1)} KB`);
if (legacyDir && !DRY) console.log(`migrated ${legacyDir} -> ${target}`);
