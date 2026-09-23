/**
 * Generate the banner showcase: three designs on three grounds, each with
 * banners of a different kind, for the community page.
 *
 * Banners are new, and a feed of seat mosaics shows nobody what one looks
 * like in a stadium, or that a tifo can carry one. So the site's own account
 * publishes a few that do — a hanging banner flown from the roof, a four-block
 * stand banner unrolled over the North stand, and a pair on the kop: a
 * see-through mesh sheet and a tall one-block drop.
 *
 * They are published the way the starter library is: by @tifomaker, flagged as
 * templates, so they carry the Template badge, stay out of "Made by people"
 * and can never be Tifo of the day (see seedTemplates.ts on why the library is
 * not dressed up as community posts). They are the newest of the library, so
 * they lead the feed's default sort.
 *
 * The seats are three of the library's own designs, which have been through
 * its contrast and coverage gates; the banners are drawn in each one's
 * palette. Text is measured in the browser with the fonts the editor uses,
 * because a text item's box is the shape of its rendered glyphs and a guessed
 * box would stretch them.
 *
 *   npx tsx scripts/generate-showcase.mts
 *
 * Output: server/data/showcase.jsonl, seeded at boot after the library.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LIBRARY = join(ROOT, 'server/data/templates.jsonl');
const OUT = join(ROOT, 'server/data/showcase.jsonl');
const PORT = 5207;

interface LibraryEntry {
  id: string; titleEn: string; titleAr: string; stadiumId: string; templateVersion: number;
  palette: string[]; cellsGzB64: string; thumbnailPng: string | null; tags: string[];
}

/** A line of text on a banner, sized by its height; the width follows the glyphs. */
interface TextSpec { kind: 'text'; text: string; fontId: string; color: string; cx: number; cy: number; h: number; maxW?: number; outline?: number; outlineColor?: string }
interface ShapeSpec { kind: 'shape'; shape: string; color: string; cx: number; cy: number; w: number; h: number; outline?: number; outlineColor?: string }
type ItemSpec = TextSpec | ShapeSpec;
interface BannerSpec {
  name: string;
  kind: 'stand' | 'hanging';
  aspect: number;
  bg: string;
  material?: 'solid' | 'mesh';
  slot: { stand: 0 | 1 | 2 | 3; blockSpan: number };
  items: ItemSpec[];
}
interface ShowcaseSpec {
  id: string;
  from: string;
  titleEn: string;
  titleAr: string;
  banners: BannerSpec[];
}

// Stands: 0 East, 1 North, 2 West, 3 South.
const SHOWCASE: ShowcaseSpec[] = [
  {
    id: 'showcase-hanging-green',
    from: 'crest-and-word-green-white-black-355',
    titleEn: 'Crest and "دائماً", with a hanging banner',
    titleAr: 'شعار و«دائماً»، مع لافتة معلّقة',
    banners: [{
      name: 'دائماً معك',
      kind: 'hanging',
      aspect: 0.6,
      bg: '#0f7a3d',
      slot: { stand: 2, blockSpan: 2 },
      items: [
        { kind: 'shape', shape: 'rect', color: '#f2f1ec', cx: 0.5, cy: 0.03, w: 1, h: 0.03 },
        { kind: 'shape', shape: 'rect', color: '#f2f1ec', cx: 0.5, cy: 0.57, w: 1, h: 0.03 },
        { kind: 'shape', shape: 'shield', color: '#16161a', cx: 0.19, cy: 0.3, w: 0.3, h: 0.34, outline: 0.012, outlineColor: '#f2f1ec' },
        { kind: 'shape', shape: 'star', color: '#f2f1ec', cx: 0.19, cy: 0.28, w: 0.13, h: 0.13 },
        { kind: 'text', text: 'دائماً', fontId: 'kufi', color: '#f2f1ec', cx: 0.64, cy: 0.23, h: 0.2, maxW: 0.6, outline: 0.008, outlineColor: '#16161a' },
        { kind: 'text', text: 'معك', fontId: 'kufi', color: '#16161a', cx: 0.64, cy: 0.41, h: 0.14, maxW: 0.5 },
      ],
    }],
  },
  {
    id: 'showcase-stand-north',
    from: 'chevron-sky-navy-575',
    titleEn: 'Sky & navy chevrons, with a four-block stand banner',
    titleAr: 'أسهم سماوي وكحلي، مع لافتة مدرج بعرض أربع قطاعات',
    banners: [{
      name: 'The North',
      kind: 'stand',
      aspect: 0.4,
      bg: '#10233f',
      slot: { stand: 1, blockSpan: 4 },
      items: [
        { kind: 'text', text: 'WE ARE', fontId: 'poster', color: '#5bc0eb', cx: 0.5, cy: 0.1, h: 0.085 },
        { kind: 'text', text: 'THE NORTH', fontId: 'poster', color: '#f2f1ec', cx: 0.5, cy: 0.235, h: 0.15, maxW: 0.74, outline: 0.006, outlineColor: '#5bc0eb' },
        { kind: 'shape', shape: 'star', color: '#5bc0eb', cx: 0.07, cy: 0.2, w: 0.09, h: 0.09 },
        { kind: 'shape', shape: 'star', color: '#5bc0eb', cx: 0.93, cy: 0.2, w: 0.09, h: 0.09 },
        { kind: 'shape', shape: 'chevron', color: '#5bc0eb', cx: 0.5, cy: 0.355, w: 0.16, h: 0.05 },
      ],
    }],
  },
  {
    id: 'showcase-kop-pair',
    from: 'checker-black-gold-467',
    titleEn: 'Black & gold kop, with two banners',
    titleAr: 'مدرج أسود وذهبي، مع لافتتين',
    banners: [
      {
        name: 'One club',
        kind: 'stand',
        aspect: 0.5,
        bg: '#16161a',
        material: 'mesh',
        slot: { stand: 3, blockSpan: 2 },
        items: [
          { kind: 'shape', shape: 'crown', color: '#e8b73a', cx: 0.5, cy: 0.1, w: 0.14, h: 0.12 },
          { kind: 'text', text: 'ONE CLUB', fontId: 'slab', color: '#e8b73a', cx: 0.5, cy: 0.25, h: 0.12, maxW: 0.8 },
          { kind: 'text', text: 'ONE CITY', fontId: 'slab', color: '#f2f1ec', cx: 0.5, cy: 0.39, h: 0.12, maxW: 0.8 },
        ],
      },
      {
        name: '12',
        kind: 'hanging',
        aspect: 1.6,
        bg: '#e8b73a',
        slot: { stand: 1, blockSpan: 1 },
        items: [
          { kind: 'shape', shape: 'star', color: '#16161a', cx: 0.5, cy: 0.26, w: 0.42, h: 0.42 },
          { kind: 'text', text: '12', fontId: 'condensed', color: '#16161a', cx: 0.5, cy: 0.98, h: 0.78, maxW: 0.82 },
          { kind: 'shape', shape: 'rect', color: '#16161a', cx: 0.5, cy: 1.5, w: 0.8, h: 0.03 },
        ],
      },
    ],
  },
];

const library = new Map<string, LibraryEntry>();
for (const line of readFileSync(LIBRARY, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as LibraryEntry;
  library.set(e.id, e);
}

const vite = await createServer({ root: ROOT, server: { port: PORT }, logLevel: 'error' });
await vite.listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
// tsx names the functions it compiles with a helper that only exists in
// Node; the ones handed to page.evaluate need it in the page too.
await page.addInitScript({ content: 'window.__name = (f) => f;' });
// The editor, because it is what loads the banner fonts — measuring against a
// fallback face would size every line for a font nobody sees.
await page.goto(`http://127.0.0.1:${PORT}/app`, { waitUntil: 'networkidle', timeout: 180000 });

const lines: string[] = [];
for (const spec of SHOWCASE) {
  const src = library.get(spec.from);
  if (!src) throw new Error(`no library design ${spec.from}`);
  const banners = await page.evaluate(async ({ bs, ground }: { bs: BannerSpec[]; ground: string }) => {
    // The dev server's own modules, by URL: the same code the editor runs.
    const textUrl = '/src/core/text.ts';
    const bannerUrl = '/src/core/banner.ts';
    const { TIFO_FONTS, renderTextCanvas } = await import(textUrl);
    const { newBanner, normalise, BannerStore } = await import(bannerUrl);
    const seatmapUrl = '/src/core/seatmap.ts';
    const catalogUrl = '/src/core/stadiumCatalog.ts';
    const shapeUrl = '/src/render/bannerShape.ts';
    const { generateSeatMap } = await import(seatmapUrl);
    const { templateById } = await import(catalogUrl);
    const { installSlotRules } = await import(shapeUrl);
    const css = (id: string): string => TIFO_FONTS.find((f: { id: string }) => f.id === id)?.css ?? 'sans-serif';
    let n = 0;
    const store = new BannerStore();
    // Settled against the real stands, as the editor settles every banner:
    // a flown banner's tier, a span the stand has room for, the shape a gap
    // imposes. Without it a showcase would store a slot the editor then
    // quietly changes the first time anyone opens it.
    installSlotRules(store, generateSeatMap(templateById(ground)));
    for (const b of bs) {
      const items = [];
      for (const it of b.items) {
        n++;
        if (it.kind === 'shape') {
          items.push({ id: `it_show${n}`, kind: 'shape', shape: it.shape, color: it.color, cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: 0,
            ...(it.outline ? { outline: it.outline, outlineColor: it.outlineColor } : {}) });
          continue;
        }
        await document.fonts.load(`bold 128px ${css(it.fontId)}`, it.text);
        const r = renderTextCanvas(it.text, css(it.fontId), 0, 0);
        if (!r) throw new Error(`could not render ${it.text}`);
        const ratio = r.canvas.width / r.canvas.height;
        let h = it.h;
        let w = h * ratio;
        if (it.maxW && w > it.maxW) { w = it.maxW; h = w / ratio; }
        items.push({ id: `it_show${n}`, kind: 'text', text: it.text, fontId: it.fontId, arcDeg: 0, color: it.color, cx: it.cx, cy: it.cy, w, h, rot: 0,
          ...(it.outline ? { outline: it.outline, outlineColor: it.outlineColor } : {}) });
      }
      const base = newBanner(b.kind, b.name);
      store.add(normalise({
        ...base,
        aspect: b.aspect,
        bg: b.bg,
        material: b.material ?? 'solid',
        items,
        slot: { ...base.slot, stand: b.slot.stand, blockSpan: b.slot.blockSpan },
      }));
    }
    return store.toJSON();
  }, { bs: spec.banners, ground: src.stadiumId });
  const scene = { v: 1, banners, assets: { version: 1, assets: [] } };
  const sceneGzB64 = gzipSync(Buffer.from(JSON.stringify(scene))).toString('base64');
  lines.push(JSON.stringify({
    id: spec.id,
    titleEn: spec.titleEn,
    titleAr: spec.titleAr,
    stadiumId: src.stadiumId,
    templateVersion: src.templateVersion,
    palette: src.palette,
    cellsGzB64: src.cellsGzB64,
    thumbnailPng: src.thumbnailPng,
    tags: [...new Set(['banners', ...src.tags])].slice(0, 8),
    sceneGzB64,
  }));
  console.log(`${spec.id}: ${banners.banners.length} banner(s) on ${src.stadiumId}, scene ${sceneGzB64.length} B`);
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}`);
await browser.close();
await vite.close();
