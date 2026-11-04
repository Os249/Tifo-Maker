/**
 * Dev-only: the Pro poster for 5 grounds × its 3 layouts × English and
 * Arabic × landscape and portrait, drawn by the REAL simulator's film still
 * and the REAL poster code (src/ui/posterLayout.ts) at full size.
 *
 *   npx tsx scripts/pro-poster-shots.mts [out]
 *
 * Saves a copy at a third of the size of each (JPEG) and a contact sheet per
 * ground, and prints the full-size PNG's dimensions and weight. `out`
 * defaults to /home/claude/evidence/video/posters. GROUNDS=kingdom,jewel
 * narrows it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? '/home/claude/evidence/video/posters';
const only = (process.env.GROUNDS ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

interface Club { colours: string[]; initials: string; font: string; en: { club: string; opp: string; venue: string }; ar: { club: string; opp: string; venue: string } }
const GROUNDS: { key: string; id: string; stand: number; palette: string[]; club: Club }[] = [
  {
    key: 'kingdom', id: 'kingdom-arena-26k', stand: 1, palette: ['#1a1d24', '#0b4ea2', '#f2f1ec', '#7fb3ea', '#06265a'],
    club: { colours: ['#0b4ea2', '#ffffff'], initials: 'H', font: 'block', en: { club: 'Al Hilal', opp: 'Al Nassr', venue: 'Kingdom Arena, Riyadh' }, ar: { club: 'الهلال', opp: 'النصر', venue: 'المملكة أرينا، الرياض' } },
  },
  {
    key: 'jewel', id: 'jewel-jeddah-60k', stand: 0, palette: ['#1a1d24', '#111111', '#f9d71c', '#f2f1ec', '#d4a20a'],
    club: { colours: ['#f9d71c', '#111111'], initials: 'I', font: 'stencil', en: { club: 'Al Ittihad', opp: 'Al Ahli', venue: 'King Abdullah Sports City' }, ar: { club: 'الاتحاد', opp: 'الأهلي', venue: 'مدينة الملك عبدالله الرياضية' } },
  },
  {
    key: 'abha', id: 'abha-stadium-20k', stand: 1, palette: ['#1a1d24', '#1f7a3a', '#f2f1ec', '#f2c40f', '#0f3f20'],
    club: { colours: ['#1f7a3a', '#f2c40f'], initials: 'A', font: 'classic', en: { club: 'Abha', opp: 'Al Fateh', venue: 'Prince Sultan bin Abdulaziz Stadium' }, ar: { club: 'أبها', opp: 'الفتح', venue: 'ملعب الأمير سلطان بن عبدالعزيز' } },
  },
  {
    key: 'anfield', id: 'anfield-61k', stand: 2, palette: ['#1a1d24', '#c8102e', '#f2f1ec', '#00b2a9', '#6b0716'],
    club: { colours: ['#c8102e', '#f6eb61', '#00b2a9'], initials: 'L', font: 'block', en: { club: 'Liverpool', opp: 'Everton', venue: 'Anfield' }, ar: { club: 'ليفربول', opp: 'إيفرتون', venue: 'أنفيلد' } },
  },
  {
    key: 'bernabeu', id: 'bernabeu-83k', stand: 3, palette: ['#1a1d24', '#f2f1ec', '#3d195b', '#febe10', '#1c2c5b'],
    club: { colours: ['#ffffff', '#3d195b', '#febe10'], initials: 'RM', font: 'rounded', en: { club: 'Real Madrid', opp: 'Barcelona', venue: 'Santiago Bernabéu' }, ar: { club: 'ريال مدريد', opp: 'برشلونة', venue: 'سانتياغو برنابيو' } },
  },
].filter((g) => !only.length || only.includes(g.key));
const LAYOUTS = ['matchday', 'chant', 'minimal'] as const;
const SHAPES = ['landscape', 'portrait'] as const;
const WORDS = {
  en: { labels: { matchday: 'Matchday', vs: 'vs' }, date: 'SAT 8 NOV', time: '20:30', headline: 'One heart. One voice.', rtl: false },
  ar: { labels: { matchday: 'يوم المباراة', vs: 'ضد' }, date: 'السبت 8 نوفمبر', time: '8:30 م', headline: 'قلب واحد، صوت واحد', rtl: true },
};

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241, hmr: false }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
await page.goto('http://127.0.0.1:5241/scripts/pro-poster-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

type W = Window & {
  __boot: (id: string, stand: number, palette: string[]) => Promise<{ name: string }>;
  __still: (shape: string, rtl: boolean) => Promise<{ ms: number; w: number; h: number }>;
  __poster: (shape: string, spec: unknown, club: unknown) => Promise<{ jpg: string; pngBytes: number; w: number; h: number }>;
};

for (const g of GROUNDS) {
  await page.evaluate(([id, stand, pal]) => (window as unknown as W).__boot(id as string, stand as number, pal as string[]), [g.id, g.stand, g.palette] as const);
  for (const shape of SHAPES) {
    for (const lang of ['en', 'ar'] as const) {
      // Landscape puts the tifo on the side the type does not start from: a still each way.
      if (lang === 'en' || shape === 'landscape') {
        const st = await page.evaluate(([s, r]) => (window as unknown as W).__still(s as string, r as boolean), [shape, WORDS[lang].rtl] as const);
        console.log(`${g.key} ${shape} ${lang} still: ${st.w}×${st.h} in ${(st.ms / 1000).toFixed(0)} s`);
      }
      for (const layout of LAYOUTS) {
        const w = WORDS[lang];
        const names = g.club[lang];
        const spec = { layout, club: names.club, opponent: names.opp, venue: names.venue, date: w.date, time: w.time, headline: w.headline, labels: w.labels, rtl: w.rtl };
        const r = await page.evaluate(([s, sp, c]) => (window as unknown as W).__poster(s as string, sp, c), [shape, spec, g.club] as const);
        const file = join(OUT, `${g.key}-${layout}-${lang}-${shape}.jpg`);
        writeFileSync(file, Buffer.from(r.jpg.split(',')[1], 'base64'));
        console.log(`  ${layout} ${lang}: full size ${r.w}×${r.h} PNG, ${(r.pngBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    }
  }
  try {
    for (const shape of SHAPES) {
      const files = LAYOUTS.flatMap((l) => (['en', 'ar'] as const).map((lang) => join(OUT, `${g.key}-${l}-${lang}-${shape}.jpg`)));
      const scale = shape === 'landscape' ? '640:-2' : '360:-2';
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}:v]scale=${scale}[v${i}]`).join(';')};${files.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${files.length}:layout=${shape === 'landscape' ? '0_0|w0_0|0_h0|w0_h0|0_h0+h1|w0_h0+h1' : '0_0|w0_0|w0+w1_0|w0+w1+w2_0|w0+w1+w2+w3_0|w0+w1+w2+w3+w4_0'}`, '-frames:v', '1', join(OUT, `sheet-${g.key}-${shape}.jpg`)]);
    }
  } catch (e) {
    console.log('  contact sheet failed:', String((e as Error).message).slice(0, 200));
  }
}

await page.evaluate(() => (window as unknown as { __teardown: () => void }).__teardown());
await browser.close();
await vite.close();
