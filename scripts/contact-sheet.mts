/**
 * Lay a run out as one image so the designs can be judged together.
 *
 * Point it at a template directory to see the card strips exactly as the
 * gallery will show them, or at a `--shots` directory to see the 3D stadium
 * renders — which is the honest way to judge whether a composition reads, since
 * that is where a tifo is actually looked at.
 *
 *   npx tsx scripts/contact-sheet.mts server/data/templates /tmp/contact.png
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = process.argv[2] ?? 'server/data/templates';
const out = process.argv[3] ?? '/tmp/contact.png';
const limit = Number(process.argv[4] ?? 0) || 0;

const names = readdirSync(dir);
const shots = names.filter((f) => f.endsWith('.png'));
const items = shots.length
  ? shots.map((f) => ({
      png: readFileSync(join(dir, f)).toString('base64'),
      titleEn: f.replace(/\.png$/, ''), titleAr: '', archetype: '', coverage: '', contrast: '',
    }))
  : names.filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => { const t = JSON.parse(readFileSync(join(dir, f), 'utf8')); return { ...t, png: t.thumbnailPng }; });

const shown = limit ? items.slice(0, limit) : items;
const cards = shown.map((t) => `
  <figure>
    <img src="data:image/png;base64,${t.png}" alt="" />
    <figcaption><b>${t.titleEn}</b><span>${t.archetype} · ${t.coverage}% · ${t.contrast}:1</span>
    <span dir="rtl" lang="ar">${t.titleAr}</span></figcaption>
  </figure>`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#0B1120; color:#F1F4FB; font:12px/1.4 Inter,system-ui,sans-serif; padding:16px; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
  figure { margin:0; background:#0F172A; border:1px solid #243049; border-radius:10px; padding:8px; }
  img { width:100%; display:block; border-radius:4px; image-rendering:pixelated; background:#070B14; }
  figcaption { display:flex; flex-direction:column; gap:2px; margin-top:6px; }
  figcaption b { font-size:12px; }
  figcaption span { font-size:10.5px; color:#8690A7; }
</style><div class="grid">${cards}</div>`;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
await p.setContent(html, { waitUntil: 'networkidle' });
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log(`${items.length} templates -> ${out}`);
