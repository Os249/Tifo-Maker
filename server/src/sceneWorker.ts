/**
 * The scene worker (performance plan P2.14): a thread of its own for the two
 * pieces of scene work that used to hold the server's one event loop. See
 * workerPool.ts for how it is started, bounded and replaced, and
 * sceneCheck.ts for the work itself.
 *
 * Its `process.env` is empty (the pool starts it with `env: {}`), which is
 * defence in depth, not isolation: a worker thread shares the process. It
 * touches no file, no network and no database: bytes in, a verdict or bytes
 * out, exact-size and handed over both ways.
 */
import { parentPort } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { checkScene, stripLayers } from './sceneCheck';

export type SceneTask = { kind: 'check'; gz: Uint8Array } | { kind: 'strip'; gz: Uint8Array };

parentPort?.on('message', (task: SceneTask) => {
  try {
    if (task.kind === 'check') {
      parentPort!.postMessage({ ok: true, result: checkScene(task.gz) });
      return;
    }
    const stripped = stripLayers(task.gz);
    // Handed back as an exact-size copy: stripLayers can return a view into
    // a larger buffer (the input itself, or zlib's output chunk), and the
    // server keeps what comes back, so it is charged for exactly what it holds.
    const out = stripped ? new Uint8Array(stripped) : null;
    parentPort!.postMessage({ ok: true, result: out }, out ? [out.buffer as ArrayBuffer] : []);
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
});

// Loaded: the pool starts a task's clock from here, and checks the memory
// limit it asked for is the one in force (workerPool.ts).
parentPort?.postMessage({ ready: true, heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1_048_576) });
