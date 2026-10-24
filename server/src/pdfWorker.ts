/**
 * The PDF worker (performance plan P2.14): the distribution PDF, rendered on
 * a thread of its own. pdfkit lays out every seat synchronously: 0.3 to 3 s
 * for a big ground, and the route is open to anyone, so while one rendered
 * every other visitor of the site waited. See workerPool.ts for how it is
 * started, bounded and replaced.
 *
 * Its `process.env` is empty (the pool starts it with `env: {}`): defence in
 * depth, not a sandbox, since a worker thread shares the process. The one thing it
 * touches outside its memory is the temporary file pdfkit writes, named by the
 * route (a random name in the server's temporary directory) and removed both
 * here (finally) and by the route, which also covers a worker stopped before
 * its finally could run.
 */
import { parentPort } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { generateSeatMap } from '../../src/core/seatmap';
import { shippedTemplates } from '../../src/core/stadiumCatalog';
import { renderDistributionPdf, type DistributionMeta } from '../../src/export/distributionPdf';

export interface PdfTask {
  /** Where pdfkit writes, chosen by the route: `<tmpdir>/tifo-<24 hex>.pdf`. */
  outPath: string;
  templateId: string;
  templateVersion: number;
  /** One byte per seat, already checked against the seat count and with the royal boxes cleared. */
  cells: Uint8Array;
  palette: string[];
  meta: DistributionMeta;
}

// Seat maps, built once per ground in this thread (a 91k-seat map is 100-170
// ms). Bounded by the shipped grounds: the route accepts nothing else.
const maps = new Map<string, ReturnType<typeof generateSeatMap>>();

async function render(task: PdfTask): Promise<Uint8Array> {
  const tpl = shippedTemplates().find((t) => t.id === task.templateId && t.version === task.templateVersion);
  if (!tpl) throw new Error('unknown ground');
  const key = `${tpl.id}@${tpl.version}`;
  let map = maps.get(key);
  if (!map) {
    map = generateSeatMap(tpl);
    maps.set(key, map);
  }
  if (task.cells.length !== map.count) throw new Error('cells do not match the ground');
  // Only ever the kind of name the route makes.
  const outPath = task.outPath;
  if (typeof outPath !== 'string' || !/^tifo-[0-9a-f]{24}\.pdf$/.test(basename(outPath))) throw new Error('bad output path');
  try {
    await renderDistributionPdf(
      { cells: task.cells, palette: task.palette, seatMapRef: { id: tpl.id, version: tpl.version } },
      map,
      task.meta,
      outPath,
    );
    return new Uint8Array(await readFile(outPath));
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

parentPort?.on('message', (task: PdfTask) => {
  render(task).then(
    // Handed over, not copied: the bytes are this thread's own (readFile, then a fresh Uint8Array).
    (pdf) => parentPort!.postMessage({ ok: true, result: pdf }, [pdf.buffer as ArrayBuffer]),
    (e: unknown) => parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }),
  );
});

// Loaded: the pool starts a task's clock from here, and checks the memory
// limit it asked for is the one in force (workerPool.ts).
parentPort?.postMessage({ ready: true, heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1_048_576) });
