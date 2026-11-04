/**
 * Dev-only: the Pro film's frames and files, made by the REAL simulator and
 * the REAL film code (src/render/simulator/film.ts), for looking at.
 *
 *   npx tsx scripts/pro-film-shots.mts frames [out]   stills at the shot's four
 *       moments (establishing, push-in, reveal, hold) for 5 grounds × a small,
 *       a medium and a large tifo × landscape and vertical, and a contact
 *       sheet of each ground;
 *   npx tsx scripts/pro-film-shots.mts encode [out]   whole films, encoded, and
 *       what ffprobe says of each (duration, frame rate, frame count, size, and
 *       that every frame is a different picture);
 *   npx tsx scripts/pro-film-shots.mts time           how long a frame takes.
 *
 * Under swiftshader a Full HD frame takes seconds, so `encode` takes a while.
 * `out` defaults to /home/claude/evidence/video.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'frames';
const OUT = process.argv[3] ?? '/home/claude/evidence/video';
const only = (process.env.GROUNDS ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

/** The five grounds, by their site key, and the stand the tifo goes in (0 east, 1 north, 2 west, 3 south). */
const GROUNDS = [
  { key: 'kingdom', id: 'kingdom-arena-26k', stand: 1 },
  { key: 'jewel', id: 'jewel-jeddah-60k', stand: 0 },
  { key: 'abha', id: 'abha-stadium-20k', stand: 1 },
  { key: 'anfield', id: 'anfield-61k', stand: 2 },
  { key: 'bernabeu', id: 'bernabeu-83k', stand: 3 },
].filter((g) => !only.length || only.includes(g.key));
const SIZES = (['small', 'medium', 'large'] as const).filter((x) => !process.env.SIZES || process.env.SIZES.split(',').includes(x));
const SHAPES = [
  { name: 'landscape', w: 1920, h: 1080 },
  { name: 'vertical', w: 1080, h: 1920 },
].filter((x) => !process.env.SHAPES || process.env.SHAPES.split(',').includes(x.name));
/** The four moments, as frame numbers at 30 fps: establishing, push-in, reveal under way, hold. */
const MOMENTS: [string, number][] = [['1-start', 30], ['2-push', 130], ['3-reveal', 210], ['4-hold', 330]];
/** Vertical's hold is the pan's end (9.2 s), and its end the whole tifo (11.9 s). MOMENTS=2-push,4-hold picks some. */
const momentsFor = (shape: string): [string, number][] =>
  (shape === 'vertical' ? [...MOMENTS.slice(0, 3), ['4-hold', 276], ['5-end', 357]] as [string, number][] : MOMENTS)
    .filter(([name]) => !process.env.MOMENTS || process.env.MOMENTS.split(',').includes(name));

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5239, hmr: false }, logLevel: 'error' });
await vite.listen(5239);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5239/scripts/pro-film-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

type W = Window & {
  __boot: (id: string, stand: number, size: string, tier?: string) => Promise<Record<string, unknown>>;
  __frames: (w: number, h: number, only: number[]) => Promise<{ frames: { n: number; t: number; jpg: string }[]; ms: number }>;
  __encode: (w: number, h: number) => Promise<{ b64: string; frames: number; fps: number; realtime: boolean; ms: number; w: number; h: number }>;
};
const boot = (id: string, stand: number, size: string, tier = 'high') =>
  page.evaluate(([a, b, c, d]) => (window as unknown as W).__boot(a as string, b as number, c as string, d as string), [id, stand, size, tier] as const);
const jpg = (dataUrl: string): Buffer => Buffer.from(dataUrl.split(',')[1], 'base64');

if (mode === 'time') {
  const g = GROUNDS[1] ?? GROUNDS[0];
  for (const [tier, w, h] of [['high', 640, 360], ['low', 1920, 1080], ['high', 1920, 1080]] as const) {
    await boot(g.id, g.stand, 'medium', tier);
    const r = await page.evaluate(([w, h]) => (window as unknown as W).__frames(w as number, h as number, [0, 1, 2, 200, 201, 202]), [w, h] as const);
    const at = r.frames.map((f) => (f as unknown as { at: number }).at);
    console.log(`  ${tier} ${w}×${h}: begin+first ${at[0]} ms, then ${at.slice(1).map((x, i) => x - at[i]).join(', ')} ms`);
  }
} else if (mode === 'frames') {
  for (const g of GROUNDS) {
    for (const size of SIZES) {
      const info = await boot(g.id, g.stand, size);
      for (const s of SHAPES) {
        const moments = momentsFor(s.name);
        const r = await page.evaluate(([w, h, o]) => (window as unknown as W).__frames(w as number, h as number, o as number[]), [s.w, s.h, moments.map((m) => m[1])] as const);
        for (const f of r.frames) {
          const name = moments.find((m) => m[1] === f.n)![0];
          writeFileSync(join(OUT, `${g.key}-${size}-${s.name}-${name}.jpg`), jpg(f.jpg));
        }
        console.log(`${g.key} ${size} ${s.name}: ${JSON.stringify(info)} ${r.ms} ms`);
      }
    }
  }
} else if (mode === 'bench') {
  // The encoder's cost of a frame on this machine's CPU, at both sizes.
  for (const s of SHAPES) {
    const r = await page.evaluate(([w, h]) => (window as unknown as { __encodeBench: (w: number, h: number, n: number) => Promise<{ msPerFrame: number; bytes: number }> }).__encodeBench(w as number, h as number, 120), [s.w, s.h] as const);
    console.log(`  encode ${s.w}×${s.h}: ${r.msPerFrame.toFixed(1)} ms a frame (2D draw + VideoFrame + H.264), ${(r.bytes / 1e6).toFixed(1)} MB for 4 s`);
  }
} else if (mode === 'sound') {
  // The soundtrack alone, and a whole film at a small size on the Low tier:
  // what the container makes of the sound, at the film's full length.
  const r = await page.evaluate(() => (window as unknown as { __sound: () => Promise<{ codec: string | null; b64?: string; seconds?: number }> }).__sound());
  if (!r.codec || !r.b64) console.log('no audio encoder here');
  else {
    const file = join(OUT, 'film-sound.mp4');
    writeFileSync(file, Buffer.from(r.b64, 'base64'));
    console.log(`${file}: ${r.codec}, rendered ${r.seconds} s in ${(r as { renderMs?: number }).renderMs} ms, encoded in ${(r as { encodeMs?: number }).encodeMs} ms`);
    console.log('  ffprobe', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-filter_complex', 'showwavespic=s=1600x300:split_channels=0:colors=0x2050c0', '-frames:v', '1', join(OUT, 'film-sound-wave.png')]);
  }
  if (!process.env.SOUND_ONLY) {
    const g = GROUNDS.find((x) => x.key === 'abha') ?? GROUNDS[0];
    await boot(g.id, g.stand, 'medium', 'low');
    const f = await page.evaluate(() => (window as unknown as W).__encode(360, 640));
    const file = join(OUT, 'film-av-check-360x640.mp4');
    writeFileSync(file, Buffer.from(f.b64, 'base64'));
    console.log(`${file}: ${f.frames} frames, ${(f.ms / 1000).toFixed(0)} s to make`);
    console.log('  ffprobe', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration,nb_frames,sample_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().replace(/\n/g, ' | '));
  }
} else if (mode === 'encode') {
  const list = (process.env.FILMS ?? 'jewel:medium,kingdom:large').split(',').map((x) => x.split(':'));
  for (const [key, size] of list) {
    const g = GROUNDS.find((x) => x.key === key) ?? GROUNDS[0];
    await boot(g.id, g.stand, size);
    for (const s of SHAPES) {
      const r = await page.evaluate(([w, h]) => (window as unknown as W).__encode(w as number, h as number), [s.w, s.h] as const);
      const file = join(OUT, `film-${g.key}-${size}-${s.name}.mp4`);
      writeFileSync(file, Buffer.from(r.b64, 'base64'));
      console.log(`${file}: ${r.frames} frames at ${r.fps} fps, ${r.w}×${r.h}, realtime ${r.realtime}, ${(r.ms / 1000).toFixed(0)} s to make`);
      try {
        const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration', '-of', 'json', file], { encoding: 'utf8' });
        console.log('  ffprobe', JSON.stringify(JSON.parse(probe).streams[0]));
        // Every frame its own picture (no frame repeated), and evenly spaced in time.
        const md5 = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.startsWith('#'));
        const hashes = md5.map((l) => l.split(',').pop()!.trim());
        let repeats = 0;
        for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) repeats++;
        const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split('\n').map(Number);
        const steps = pts.slice(1).map((p, i) => p - pts[i]);
        const uneven = steps.filter((d) => Math.abs(d - 1 / r.fps) > 0.002).length;
        console.log(`  decoded ${hashes.length} frames, ${repeats} repeated, ${uneven} unevenly spaced (${Math.min(...steps).toFixed(4)}..${Math.max(...steps).toFixed(4)} s)`);
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', 'fps=1,scale=480:-2,tile=5x3', '-frames:v', '1', join(OUT, `film-${g.key}-${size}-${s.name}-sheet.jpg`)]);
      } catch (e) {
        console.log('  ffprobe/ffmpeg failed:', String((e as Error).message).slice(0, 300));
      }
    }
  }
}

await page.evaluate(() => (window as unknown as { __teardown: () => void }).__teardown());
await browser.close();
await vite.close();
