/**
 * Starter-library guard.
 *
 * The library is ~600 machine-composed designs that ship in the repo and seed
 * themselves on boot, which means nobody looks at them again. Three things can
 * rot silently:
 *
 *   size     the first generation run wrote a 3D render AND a flat strip into
 *            every template and came to 176 MB. A budget here is the only thing
 *            standing between a thumbnail change and an unpushable repo.
 *   quality  the gates live in the generator, so a regenerated library could
 *            ship designs that never passed them. They are re-checked from the
 *            stored data, not trusted.
 *   variety  a library that is 60 hoops in a row is worse than a small one.
 *            Both the mix and the ORDER are asserted: order is what a visitor
 *            actually sees, and seeding the library in file order put every
 *            hoop on page one.
 *
 * Then the live half: paging must not repeat or skip a card, and every
 * thumbnail must actually serve.
 *
 *   node e2e-templates.mjs            (server on :8787)
 */
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const B = process.env.BASE ?? 'http://127.0.0.1:8787';
const LIB = 'server/data/templates.jsonl';
const SEATS = { 'generic-bowl-60k': 60832, 'single-kop-40k': 39700, 'grand-oval-76k': 75984 };

/** Total repo cost of the library. Generous against today's ~1.8 MB, tight
 *  enough that re-introducing bitmap thumbnails fails here and not in review. */
const SIZE_BUDGET_MB = 8;
const THUMB_BUDGET_KB = 16;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------- the files on disk ----------
console.log('\n— the library on disk —');
const lines = readFileSync(LIB, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
ok('library is present', lines.length >= 300, `${lines.length} templates`);

const bytes = statSync(LIB).size;
ok(`library fits in ${SIZE_BUDGET_MB} MB`, bytes <= SIZE_BUDGET_MB * 1048576,
  `${(bytes / 1048576).toFixed(2)} MB`);

const recs = [];
const bad = { parse: [], fields: [], cells: [], thumb: [], thumbBig: [], colors: [] };
for (const [i, line] of lines.entries()) {
  let j;
  try { j = JSON.parse(line); } catch { bad.parse.push(`line ${i + 1}`); continue; }
  const f = j.id;
  recs.push(j);
  for (const k of ['id', 'titleEn', 'titleAr', 'stadiumId', 'palette', 'cellsGzB64', 'thumbnailPng', 'archetype']) {
    if (j[k] == null || (Array.isArray(j[k]) && !j[k].length)) { bad.fields.push(`${f}:${k}`); break; }
  }
  // Cells must expand to exactly the stadium's seat count, or the design is
  // silently truncated in the editor.
  try {
    const n = gunzipSync(Buffer.from(j.cellsGzB64, 'base64')).length;
    if (n !== SEATS[j.stadiumId]) bad.cells.push(`${f}: ${n} != ${SEATS[j.stadiumId]}`);
  } catch { bad.cells.push(`${f}: cells unreadable`); }
  // Thumbnail: a real PNG, indexed, and small.
  const png = Buffer.from(j.thumbnailPng ?? '', 'base64');
  const isPng = png.length > 8 && png.readUInt32BE(0) === 0x89504e47;
  if (!isPng) bad.thumb.push(f);
  else {
    if (png.length > THUMB_BUDGET_KB * 1024) bad.thumbBig.push(`${f}: ${(png.length / 1024).toFixed(1)} KB`);
    if (png[25] !== 3) bad.colors.push(`${f}: colour type ${png[25]}`); // 3 = palette
  }
}
ok('every line parses', bad.parse.length === 0, bad.parse.slice(0, 3).join(', '));
ok('every template carries the required fields', bad.fields.length === 0, bad.fields.slice(0, 3).join(', '));
ok('cells match the stadium seat count', bad.cells.length === 0, bad.cells.slice(0, 3).join(', '));
ok('thumbnails are PNGs', bad.thumb.length === 0, bad.thumb.slice(0, 3).join(', '));
ok(`thumbnails stay under ${THUMB_BUDGET_KB} KB`, bad.thumbBig.length === 0, bad.thumbBig.slice(0, 3).join(', '));
ok('thumbnails are palette-indexed', bad.colors.length === 0, bad.colors.slice(0, 3).join(', '));

// ---------- the quality gates, re-checked from stored data ----------
console.log('\n— quality —');
const srgb = (hex) => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
};
const lum = (hex) => {
  const [r, g, b] = srgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const viol = { coverage: [], dominance: [], ink: [], contrast: [], twoColour: [] };
for (const j of recs) {
  const cells = gunzipSync(Buffer.from(j.cellsGzB64, 'base64'));
  const hist = new Array(j.palette.length).fill(0);
  for (const c of cells) hist[c] = (hist[c] ?? 0) + 1;
  const total = cells.length;
  const painted = total - (hist[0] ?? 0);
  if (painted / total < 0.55) viol.coverage.push(`${j.id} ${(painted / total * 100) | 0}%`);
  const used = hist.map((n, idx) => ({ n, idx })).filter((x) => x.idx > 0 && x.n / total > 0.02);
  if (used.length < 2) { viol.twoColour.push(j.id); continue; }
  const sorted = used.map((u) => u.n).sort((a, b) => b - a);
  if (sorted[0] / total > 0.92) viol.dominance.push(`${j.id} ${(sorted[0] / total * 100) | 0}%`);
  if (sorted[1] / total < 0.04) viol.ink.push(`${j.id} ${(sorted[1] / total * 100).toFixed(1)}%`);
  let worst = Infinity;
  for (let a = 0; a < used.length; a++) {
    for (let b = a + 1; b < used.length; b++) worst = Math.min(worst, ratio(j.palette[used[a].idx], j.palette[used[b].idx]));
  }
  if (worst < 1.6) viol.contrast.push(`${j.id} ${worst.toFixed(2)}`);
}
ok('every design covers at least 55% of the bowl', viol.coverage.length === 0, viol.coverage.slice(0, 3).join(', '));
ok('every design uses at least two real colours', viol.twoColour.length === 0, viol.twoColour.slice(0, 3).join(', '));
ok('no design is one flat colour (>92%)', viol.dominance.length === 0, viol.dominance.slice(0, 3).join(', '));
ok('the second colour is never a speck (<4%)', viol.ink.length === 0, viol.ink.slice(0, 3).join(', '));
ok('colours in a design are distinguishable (>=1.6)', viol.contrast.length === 0, viol.contrast.slice(0, 3).join(', '));

// ---------- variety ----------
console.log('\n— variety —');
const byArch = new Map();
for (const j of recs) byArch.set(j.archetype, (byArch.get(j.archetype) ?? 0) + 1);
const biggest = [...byArch.entries()].sort((a, b) => b[1] - a[1])[0];
ok('at least 12 distinct compositions', byArch.size >= 12, `${byArch.size}`);
ok('no composition is more than 20% of the library', biggest[1] / recs.length <= 0.2,
  `${biggest[0]} is ${(biggest[1] / recs.length * 100).toFixed(0)}%`);
const titles = new Set(recs.map((r) => r.titleEn));
ok('titles are unique', titles.size === recs.length, `${recs.length - titles.size} repeats`);
ok('every design has an Arabic title', recs.every((r) => /[؀-ۿ]/.test(r.titleAr)));
// Not the same thing as an Arabic title: these are designs whose WORD on the
// stand is Arabic. Most of the clubs here are Arab clubs, and a library where
// every banner reads in Latin is a library built for the wrong crowd.
const arabic = recs.filter((r) => r.tags.includes('arabic'));
ok('the library includes Arabic-word designs', arabic.length >= 20, `${arabic.length}`);
ok('their titles quote the word that is on the stand',
  arabic.every((r) => /[؀-ۿ]/.test(r.titleEn)),
  arabic.filter((r) => !/[؀-ۿ]/.test(r.titleEn)).slice(0, 3).map((r) => r.titleEn).join(', '));

// Seeding order is gallery order. Replays the seeder's hash shuffle and checks
// the first page is a mix, because sorted-by-filename put 60 hoops on page one.
const key = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const seedOrder = [...recs].sort((a, b) => key(a.id) - key(b.id) || a.id.localeCompare(b.id));
const firstPage = new Set(seedOrder.slice(0, 60).map((r) => r.archetype));
ok('the first page shows at least 10 compositions', firstPage.size >= 10, `${firstPage.size}`);

// Nothing readable may sit on the east stand: it straddles the seam where the
// bowl unrolls, so a word placed there comes out with one half at each end of
// the strip — "الد … ربي". The generator records which stands carry text or a
// symbol precisely so this is checkable after the fact.
const onSeam = recs.filter((r) => (r.inkStands ?? []).includes('east'));
ok('nothing readable sits on the seam stand', onSeam.length === 0,
  onSeam.slice(0, 3).map((r) => r.id).join(', '));
ok('every design records which stands carry its text', recs.every((r) => Array.isArray(r.inkStands)));

// ---------- live: paging and thumbnails ----------
console.log('\n— the gallery —');
const get = async (path) => {
  const r = await fetch(B + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r;
};
try {
  const p1 = await (await get('/api/gallery?templates=1&limit=60')).json();
  const p2 = await (await get('/api/gallery?templates=1&limit=60&offset=60')).json();
  ok('a page is 60 designs', p1.length === 60, `${p1.length}`);
  ok('the second page is a different 60', p2.length === 60 && !p1.some((a) => p2.some((b) => b.id === a.id)));
  const seen = new Set();
  let dup = 0, got = 0;
  // Walks past the library's own size on purpose: a seeder that re-adds on
  // restart shows up here as more designs than there are files.
  for (let off = 0; off < recs.length * 3 + 120; off += 60) {
    const page = await (await get(`/api/gallery?templates=1&limit=60&offset=${off}`)).json();
    for (const d of page) { if (seen.has(d.id)) dup++; seen.add(d.id); }
    got += page.length;
    if (page.length < 60) break;
  }
  ok('paging walks the whole library without repeats', dup === 0 && seen.size === recs.length,
    `${seen.size} unique of ${got} returned, ${dup} repeats, library is ${recs.length}`);
  ok('the default page is capped', (await (await get('/api/gallery?templates=1')).json()).length === 60);

  const archOf = new Map(recs.map((r) => [r.titleEn, r.archetype]));
  const firstLive = new Set(p1.map((d) => archOf.get(d.title)).filter(Boolean));
  ok('page one of the live gallery is a mix', firstLive.size >= 10, `${firstLive.size} compositions`);

  // Thumbnails actually serve, for a sample across the library.
  let served = 0, badType = 0;
  for (const d of p1.slice(0, 12)) {
    const r = await fetch(`${B}/api/designs/${d.id}/thumbnail.png`);
    if (r.ok) served++;
    if (!(r.headers.get('content-type') ?? '').includes('image/png')) badType++;
  }
  ok('thumbnails serve', served === 12, `${served}/12`);
  ok('thumbnails serve as image/png', badType === 0);

  // A template must open in the editor: cells decode and match the stadium.
  const one = await (await get(`/api/designs/${p1[0].id}`)).json();
  const cells = gunzipSync(Buffer.from(one.cellsGzB64, 'base64'));
  ok('a template opens with a full set of seats', cells.length === SEATS[one.templateId],
    `${cells.length} vs ${SEATS[one.templateId]}`);
  ok('a template is flagged as one', p1[0].isTemplate === true);
  ok('templates are published by the library account', p1.every((d) => d.ownerName === 'tifomaker'));
} catch (e) {
  fail++;
  console.log(`  FAIL  live gallery — ${e.message}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
