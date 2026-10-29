/**
 * Dev-only: render any TifoSpec (or an offline designer's output) on a ground
 * the way the editor would — refine → fit → compile → critique — and take the
 * stills a reviewer needs: the TV gantry, behind the goal, the full bowl, the
 * unrolled seat strips at 3 px a seat, plus the rows and fragile share of every
 * word and symbol.
 *
 *   npx tsx scripts/spec-shots.mts <manifest.json> <outDir>
 *
 * manifest: { "stadium": "<id>", "items": [ { "key": "a", "spec": {...} },
 *                                            { "key": "b", "mode": "super", "prompt": "..." },
 *                                            { "key": "c", "mode": "ex0" } ] }
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [manifestPath, outDir] = process.argv.slice(2);
if (!manifestPath || !outDir) throw new Error('usage: spec-shots.mts <manifest.json> <outDir>');
const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as { stadium: string; items: Array<Record<string, unknown> & { key: string }> };
mkdirSync(resolve(outDir), { recursive: true });

const CAMS = ['TV gantry', 'Behind goal', 'Full view'];
const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5251 }, logLevel: 'error' });
await vite.listen(5251);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5251/scripts/spec-shots.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });

type R = { stands?: Record<string, string | null>; histogram?: Record<string, Record<string, number>>; layers?: Array<{ idx: number; kind: string; what: string; by: Record<string, number>; v: number[] }>; ok: boolean; shots: Record<string, string | null>; flat: string; strips: string; spec: unknown; changes: string[]; warnings: string[];
  critique: { score: number; issues: string[]; fragile: number; painted: number; perStandFill: Record<string, number> };
  texts: Array<{ kind: string; text: string; region: unknown; rows: number; seats: number; fragile: number }>; seats: number };
const save = (file: string, dataUrl: string | null): void => { if (dataUrl) writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64')); };

for (const item of manifest.items) {
  const { key, ...input } = item;
  // "spec": "@file.json" reads the spec from a file beside the manifest.
  if (typeof input.spec === 'string' && input.spec.startsWith('@')) {
    input.spec = JSON.parse(readFileSync(resolve(dirname(resolve(manifestPath)), input.spec.slice(1)), 'utf8'));
  }
  try {
    const r = (await page.evaluate(([id, inp, cams]) => (window as never as { __run: (...x: unknown[]) => Promise<R> }).__run(id, inp, cams), [manifest.stadium, input, CAMS] as const)) as R;
    const base = resolve(outDir, key);
    save(`${base}-tv.png`, r.shots['TV gantry']);
    save(`${base}-goal.png`, r.shots['Behind goal']);
    save(`${base}-full.png`, r.shots['Full view']);
    save(`${base}-strips.png`, r.strips);
    save(`${base}-flat.png`, r.flat);
    for (const [st, png] of Object.entries(r.stands ?? {})) save(`${base}-stand-${st}.png`, png);
    for (const [k, h] of Object.entries(r.histogram ?? {})) console.log(`      cells ${k}: ${Object.entries(h).map(([c, n]) => `#${c}=${n}`).join(' ')}`);
    writeFileSync(`${base}-report.json`, JSON.stringify({ spec: r.spec, changes: r.changes, warnings: r.warnings, critique: r.critique, texts: r.texts }, null, 1));
    const fill = Object.entries(r.critique.perStandFill).map(([s, f]) => `${s} ${Math.round(f * 100)}%`).join(' ');
    console.log(`OK  ${key.padEnd(18)} score=${r.critique.score} painted=${r.critique.painted}/${r.seats} fragile=${r.critique.fragile} | ${fill}`);
    for (const t of r.texts) console.log(`      ${t.kind === 'text' ? '"' + t.text + '"' : t.text}: ${t.rows} rows, ${t.seats} seats, ${Math.round(t.fragile * 100)}% fragile`);
    for (const l of r.layers ?? []) console.log(`      L${l.idx} ${l.kind} ${l.what}: ${Object.entries(l.by).map(([k, n]) => `${k}=${n}`).join(' ') || 'nothing'} v=[${l.v.map((x) => x.toFixed(2)).join(',')}]`);
    for (const c of r.changes) console.log(`      fit: ${c}`);
    for (const w of r.warnings) console.log(`      warn: ${w}`);
  } catch (e) {
    console.error(`FAIL ${key}: ${(e as Error).message.slice(0, 300)}`);
  }
}
await browser.close();
await vite.close();
