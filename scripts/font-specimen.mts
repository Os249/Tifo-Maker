/**
 * Dev-only: judge display faces at REAL seat resolution.
 *   npx tsx scripts/font-specimen.mts
 * Every candidate is rasterised, downsampled to a 300x40 seat grid and hard
 * thresholded (a seat is on or off), then blown back up. What survives that is
 * what will read from across a pitch; smooth screen previews lie.
 * Fonts come from @fontsource — see FAMILIES for the install list.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/fonts');
const FS = resolve(ROOT, 'node_modules/@fontsource');

interface Face { id: string; family: string; file: string; script: 'ar' | 'lat' }

/** Heaviest available weight per family per script. */
function collect(): Face[] {
  const out: Face[] = [];
  for (const fam of readdirSync(FS).sort()) {
    let files: string[];
    try { files = readdirSync(resolve(FS, fam, 'files')); } catch { continue; }
    for (const script of ['ar', 'lat'] as const) {
      const tag = script === 'ar' ? '-arabic-' : '-latin-';
      const cands = files.filter((f) => f.endsWith('.woff2') && f.includes(tag) && !f.includes('italic') && !f.includes('ext'));
      if (!cands.length) continue;
      const weight = (f: string) => {
        const m = /-(\d{3}|wght)-/.exec(f);
        return !m ? 400 : m[1] === 'wght' ? 1000 : Number(m[1]);
      };
      const best = cands.sort((a, b) => weight(b) - weight(a))[0];
      out.push({ id: `${fam}-${script}`, family: `F_${fam.replace(/-/g, '_')}_${script}`, file: `/node_modules/@fontsource/${fam}/files/${best}`, script });
    }
  }
  return out;
}

const faces = collect();
const arFaces = faces.filter((f) => f.script === 'ar');
const latFaces = faces.filter((f) => f.script === 'lat');
console.log(`${faces.length} faces — ${arFaces.length} Arabic, ${latFaces.length} Latin`);

const css = faces.map((f) => `@font-face{font-family:"${f.family}";src:url("${f.file}") format("woff2");font-weight:100 900;font-display:block}`).join('\n');

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5207 }, logLevel: 'error' });
await vite.listen(5207);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5207/scripts/font-specimen.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

await page.addStyleTag({ content: css });
await page.evaluate(async (fams: string[]) => {
  await Promise.all(fams.map((f) => (document as unknown as { fonts: FontFaceSet }).fonts.load(`bold 128px "${f}"`)));
  await (document as unknown as { fonts: FontFaceSet }).fonts.ready;
}, faces.map((f) => f.family));

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const jobs: Array<[Face[], string, boolean, string]> = [
  [arFaces, 'زعيم آسيا', true, 'ar'],
  [latFaces, 'GRAZIE', false, 'lat'],
];
const index: Record<string, string[]> = {};
for (const [set, text, rtl, tag] of jobs) {
  const res = (await page.evaluate(
    ([f, t, r]) => (window as never as { __specimen: (a: unknown, b: unknown, c: unknown) => Promise<unknown> }).__specimen(f, t, r),
    [set, text, rtl] as [Face[], string, boolean],
  )) as Array<{ id: string; png: string }>;
  index[tag] = [];
  for (const r of res) {
    writeFileSync(`${OUT}/${r.id}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
    index[tag].push(r.id);
  }
  console.log(`${tag}: ${res.length} specimens`);
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2));
await browser.close();
await vite.close();
