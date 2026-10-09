/**
 * Dev-only: does the AI / Quick Designer output read on EVERY stadium?
 *   npx tsx scripts/ai-fit.mts [--fit] [--png DIR] [--only id,id] [--modes quick,super] [--max-bad N]
 *
 * Runs the real designers and the real compiler (in headless Chromium, because
 * text needs a canvas) through the client's own path — refine → compile →
 * critique → one repair — on every stadium in the catalogue, and reports, per
 * text/symbol layer, how many seat ROWS the glyphs span and what share of them
 * sits in strokes too thin to hold up. Text a few rows tall is not text.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] ?? '' : null; };
const FIT = process.argv.includes('--fit');
const PNG = arg('--png');
const ONLY = arg('--only')?.split(',').filter(Boolean) ?? null;
const MODES = (arg('--modes') ?? 'quick,super,shuffle1,shuffle2,ex0,ex2').split(',');
const JSON_OUT = arg('--json');

export const PROMPTS = [
  'CHAMPIONS in red and white',
  'الهلال الزعيم',
  'نادي القرن الأهلي',
  'eagle in green and white with FALCONS',
  'MESSI 10 farewell',
  'red and black stripes FORZA ULTRAS',
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241 }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5241/scripts/ai-fit-harness.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });

type T = { idx: number; kind: string; text: string; region: unknown; rows: number; seats: number; fragile: number; warn: number };
type R = { seats: number; critique: { score: number; issues: string[]; fragile: number }; texts: T[]; png: string | null; changes?: string[] };

const ids = (ONLY ?? STADIUM_CATALOG.map((e) => (e as { template?: { id: string } }).template?.id ?? (e as { id: string }).id));
if (PNG) mkdirSync(PNG, { recursive: true });
const all: Array<{ id: string; mode: string; prompt: string } & R> = [];
let bad = 0, total = 0;
for (const id of ids) {
  for (const mode of MODES) {
    const prompts = mode.startsWith('ex') ? [''] : PROMPTS;
    for (const prompt of prompts) {
      const r = (await page.evaluate(([a, b, c, f, p]) => (window as never as { __run: (...x: unknown[]) => Promise<R> }).__run(a, b, c, { fit: f, png: p }),
        [id, mode, prompt, FIT, !!PNG] as const)) as R;
      total++;
      // A headline needs ~7 seat rows to read (Latin capitals), more for Arabic.
      const weak = r.texts.filter((t) => t.kind === 'text' && (t.rows < 7 || t.fragile > 0.35 || t.seats === 0));
      const lostSym = r.texts.filter((t) => t.kind === 'symbol' && (t.seats === 0 || t.fragile > 0.5));
      const flag = weak.length > 0 || lostSym.length > 0 || r.critique.score < 60;
      if (flag) bad++;
      all.push({ id, mode, prompt, ...r, png: null });
      const desc = r.texts.map((t) => `${t.kind === 'text' ? '"' + t.text + '"' : t.text}:${t.rows}r/${Math.round(t.fragile * 100)}%${t.seats ? '' : '∅'}`).join(' ');
      if (process.env.CHANGES && r.changes?.length) console.log('       ' + r.changes.join('\n       '));
      if (flag || !ONLY) console.log(`${flag ? 'BAD ' : 'ok  '} ${id.padEnd(30)} ${mode.padEnd(8)} ${prompt.slice(0, 22).padEnd(22)} score=${String(r.critique.score).padStart(3)} ${desc}`);
      if (PNG && r.png) writeFileSync(`${PNG}/${id}--${mode}--${prompt.replace(/[^\w؀-ۿ]+/g, '_').slice(0, 30)}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
}
console.log(`\n${bad} of ${total} designs have unreadable text, a lost symbol or a low score${FIT ? ' (with fit)' : ''}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
const MAX_BAD = arg('--max-bad');
if (MAX_BAD !== null && bad > Number(MAX_BAD)) process.exitCode = 1;
await browser.close();
await vite.close();
