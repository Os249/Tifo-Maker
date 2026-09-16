/**
 * Dev-only: does a recorded reveal actually fit the size budget?
 *   npx tsx scripts/record-size.mts
 *
 * The clip is sized to a byte budget rather than a fixed bitrate, and that is a
 * claim about what MediaRecorder produces — which can only be checked by running
 * MediaRecorder. So this boots the real simulator on a deliberately busy design
 * (a flat two-colour bowl compresses to nothing and would let any budget pass)
 * and records every length and frame rate the overlay offers.
 *
 * It ran before this existed at a flat 8 Mbps, which made a 9-second clip 9 MB
 * by arithmetic rather than by anything to do with the picture.
 *
 * READ THE NUMBERS AS A CEILING, NOT AS A SIZE. Headless Chromium renders this
 * scene in software, so the canvas repaints far too slowly to fill the capture
 * stream and VP9 compresses the near-static result to a fraction of what real
 * hardware produces — every case below comes out around 5% of budget, which is
 * not what anyone's machine will do. What this harness proves is that the wiring
 * holds and the cap is never exceeded. What a clip actually weighs is decided by
 * the arithmetic in src/render/simulator/recordPlan.ts, which npm run verify
 * checks directly and without a browser.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;

// Every combination the overlay's three selects can produce would be 36 runs of
// up to 15 seconds each. These are the corners that decide it: the longest clip
// (thinnest bits per second), the highest frame rate (thinnest bits per frame),
// and the default.
const CASES = [
  { seconds: 6, fps: 30, height: 720, label: 'shortest, default' },
  { seconds: 9, fps: 30, height: 720, label: 'default' },
  { seconds: 15, fps: 30, height: 720, label: 'longest' },
  { seconds: 9, fps: 60, height: 720, label: '60 fps' },
  { seconds: 15, fps: 60, height: 1080, label: 'worst case: longest, 60 fps, 1080p' },
  { seconds: 9, fps: 24, height: 1080, label: '1080p' },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5233 }, logLevel: 'error' });
await vite.listen(5233);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5233/scripts/record-size.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

const bootOnce = async (): Promise<{ budget: number; canvas: [number, number] }> =>
  (await page.evaluate(
    (id) => (window as never as { __boot: (a: string) => unknown }).__boot(id),
    'community-grand-national-80k',
  )) as { budget: number; canvas: [number, number] };

const boot = await bootOnce();
console.log(`budget ${(boot.budget / MB).toFixed(1)} MB · canvas ${boot.canvas[0]}x${boot.canvas[1]}\n`);
console.log('case'.padEnd(34) + 'secs'.padStart(5) + 'fps'.padStart(5) + 'res'.padStart(6) + 'size'.padStart(9) + '  of budget' + '  container' + '  codec');

let over = 0;
let measured = 0;
let crashed = 0;
/** Files whose extension does not match their own header bytes. */
let mislabelled = 0;
for (const [i, c] of CASES.entries()) {
  // A fresh simulator per case. Five stadiums' worth of geometry, five capture
  // streams and five recorders in one renderer process took the sixth case out
  // with "execution context was destroyed" — which is a harness running out of
  // memory, not a finding about the recorder.
  if (i > 0) {
    // If the previous case took the renderer down, the page itself is gone and
    // __teardown does not exist to call — reload rather than throwing out of the
    // loop and losing every result that did run.
    try {
      await page.evaluate(() => (window as never as { __teardown: () => void }).__teardown());
    } catch {
      await page.goto('http://127.0.0.1:5233/scripts/record-size.html', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });
    }
    await bootOnce();
  }
  let r: { bytes?: number; unsupported?: boolean; mime?: string; extension?: string; universal?: boolean; magic?: string; ftyp?: string; brands?: string };
  try {
    r = (await page.evaluate(
      (o) => (window as never as { __record: (a: unknown) => Promise<unknown> }).__record(o),
      { seconds: c.seconds, fps: c.fps, height: c.height },
    )) as typeof r;
  } catch (e) {
    // Report the case and carry on. A crashed browser is not a budget failure,
    // and losing the five results that did run to it would be the worse outcome.
    crashed++;
    console.log(c.label.slice(0, 37).padEnd(38) + `   browser gave up: ${(e as Error).message.split('\n')[0].slice(0, 60)}`);
    continue;
  }
  if (r.unsupported) { console.log(c.label.padEnd(38) + '   MediaRecorder unavailable'); continue; }
  const bytes = r.bytes ?? 0;
  measured++;
  const pct = (bytes / boot.budget) * 100;
  const flags: string[] = [];
  if (bytes > boot.budget) { over++; flags.push('OVER BUDGET'); }
  // The container is asserted from the file's own bytes: 'ftyp' for MP4, the
  // EBML magic 1a45dfa3 for WebM. An extension proves nothing.
  const isMp4 = r.ftyp === 'ftyp';
  const isWebm = r.magic === '1a45dfa3';
  const container = isMp4 ? 'mp4' : isWebm ? 'webm' : `?${r.magic ?? ''}`;
  if (r.extension === 'mp4' && !isMp4) { mislabelled++; flags.push('NOT-REALLY-MP4'); }
  if (r.extension === 'webm' && !isWebm) { mislabelled++; flags.push('NOT-REALLY-WEBM'); }
  const codec = (r.mime ?? '').split('codecs=')[1] ?? '(unnamed)';
  console.log(
    c.label.slice(0, 33).padEnd(34) + String(c.seconds).padStart(5) + String(c.fps).padStart(5) +
    `${c.height}p`.padStart(6) + `${(bytes / MB).toFixed(2)} MB`.padStart(9) +
    `${pct.toFixed(0)}%`.padStart(11) + container.padStart(11) + '  ' + codec +
    (r.universal ? '' : ' (not H.264)') + (flags.length ? '  <- ' + flags.join(' ') : ''),
  );
}

await browser.close();
await vite.close();
if (!measured) {
  console.log('\nNothing measured — MediaRecorder unavailable or the browser did not survive.');
  process.exitCode = 1;
} else {
  console.log(`\n${measured} of ${CASES.length} measured, ${over} over budget, ${mislabelled} mislabelled${crashed ? `, ${crashed} crashed` : ''}`);
  if (over || mislabelled) process.exitCode = 1;
}
