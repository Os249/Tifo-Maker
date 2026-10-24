import { Worker, type ResourceLimits, type Transferable } from 'node:worker_threads';

/**
 * Worker threads for the work that used to hold the server's one event loop
 * (performance plan P2.14): checking and stripping scenes, and rendering the
 * distribution PDF. While a crafted 21 KB scene was being parsed (0.6 s) or a
 * big ground's PDF laid out (0.3-3.2 s, and that route is open to anyone),
 * every other request to the site waited.
 *
 * Each kind of work has a pool of its own, so a queue of PDFs never delays a
 * scene save. The guardrails, all of them here:
 *  - a bounded queue: `size` tasks run, `maxQueue` wait, and anything beyond
 *    is refused at once (PoolBusyError), which the routes answer with 503;
 *  - a time limit per task: past it the worker is terminated and the task
 *    fails (PoolFailedError, 503). The route never falls back to doing the
 *    work itself, and a strip that fails sends no scene, never the owner's
 *    layers;
 *  - an error and an exit handler on every worker: one that crashes, runs out
 *    of memory or exits fails its task (503) and is replaced for the next;
 *  - resourceLimits, so a task cannot take the process's memory with it.
 *    A process-wide V8 heap flag (NODE_OPTIONS=--max-old-space-size) silently
 *    overrides them, so each worker reports the limit it really has, and an
 *    override is logged here and shown by preflight and the posture panel;
 *  - `env: {}`, as defence in depth only: `process.env` in a worker is empty,
 *    so a careless line there cannot read DATABASE_URL or AI_ADMIN_PASSWORD.
 *    A worker thread is NOT a sandbox: it is the same process, and code
 *    running in it can still read /proc/self/environ, the server's files and
 *    its memory mappings. So nothing secret is ever posted to a worker (only
 *    the scene or the seats being worked on), and the code that runs in one
 *    is our own, never something a request supplies;
 *  - only exact-size copies cross, handed over (transferred) rather than
 *    cloned: cloning a Buffer that is a view into a shared slab sends the
 *    whole slab, other requests' bytes included (stage 2 review);
 *  - room kept for what matters most: a task may be `urgent` (it waits ahead
 *    of the others: an owner's scene save) and may be limited to the first
 *    `room` places of the queue (anonymous views), so a flood of views can
 *    never leave a save refused;
 *  - a time limit on waiting too (`maxWaitMs`): a task not started in time is
 *    refused (503), so nothing waits for ever behind tasks that jump ahead;
 *  - workers start on first use and end after `idleMs` without work, and an
 *    idle worker never keeps the process alive (unref).
 *
 * The worker files are separate entry points: server/src/*Worker.ts under tsx
 * (development and the tests), server/build/*Worker.mjs beside the server
 * bundle in production (scripts/bundle-server.mjs, checked by test:deploy).
 */

/** The queue is full: answer 503 and let the caller try again. */
export class PoolBusyError extends Error {
  readonly code = 'POOL_BUSY';
}
/** The task timed out, the worker died, or the task itself failed. */
export class PoolFailedError extends Error {
  readonly code = 'POOL_FAILED';
}

export interface PoolOptions {
  name: string;
  /** The worker's entry point (see workerFile). */
  file: WorkerEntry;
  /** At most this many tasks run at once (one per worker). */
  size: number;
  /** At most this many wait; past that a task is refused. */
  maxQueue: number;
  timeoutMs: number;
  /**
   * A task still waiting in the queue after this long is refused
   * (PoolBusyError, which the routes answer 503 "try again"), so no request
   * waits for ever: a view behind a steady stream of saves, which wait ahead
   * of it, used to hang with no reply (stage 2 review). Every pool has one:
   * DEFAULT_MAX_WAIT_MS when it names none.
   */
  maxWaitMs?: number;
  /** A worker with nothing to do for this long is ended. */
  idleMs: number;
  resourceLimits: ResourceLimits;
  log?: (message: string) => void;
}

interface Job {
  msg: unknown;
  transfer: Transferable[];
  urgent: boolean;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Running while the task waits in the queue (maxWaitMs). */
  waiting?: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  idle: ReturnType<typeof setTimeout> | null;
  /** The worker has loaded its entry point and said so. */
  ready: boolean;
  starting: ReturnType<typeof setTimeout> | null;
}

/**
 * How long a new worker may take to load before it counts as failed. A task's
 * own time limit starts only once its worker is ready, so a slow start (tsx
 * compiling the entry in development) is never mistaken for a slow task.
 */
const START_LIMIT_MS = 60_000;

/** How long a task may wait in a queue before it is refused, when a pool names nothing else. */
export const DEFAULT_MAX_WAIT_MS = 5_000;

export class WorkerPool<In, Out> {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private closed = false;
  readonly stats = { started: 0, done: 0, failed: 0, crashed: 0, timedOut: 0, refused: 0, expired: 0 };
  /** A worker reported a heap limit far above the one asked for (see above). */
  limitOverridden = false;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: PoolOptions) {
    this.log = opts.log ?? ((m) => console.error(m));
  }

  private get maxWaitMs(): number {
    return this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /** How many workers are alive right now (for tests). */
  get alive(): number {
    return this.slots.length;
  }

  /**
   * Run one task. `transfer` hands those buffers over (the caller must not
   * use them again). `room`: wait only while fewer than this many wait (at
   * most maxQueue). `urgent`: wait ahead of every task that is not.
   */
  run(msg: In, transfer: Transferable[] = [], opts: { room?: number; urgent?: boolean } = {}): Promise<Out> {
    return new Promise<Out>((resolve, reject) => {
      if (this.closed) return reject(new PoolBusyError(`${this.opts.name}: closed`));
      const job: Job = { msg, transfer, urgent: opts.urgent === true, resolve: resolve as (v: unknown) => void, reject };
      const free = this.slots.find((s) => !s.job);
      if (free) return this.assign(free, job);
      if (this.slots.length < this.opts.size) return this.assign(this.spawn(), job);
      const room = Math.min(this.opts.maxQueue, opts.room ?? this.opts.maxQueue);
      if (this.queue.length >= room) {
        this.stats.refused++;
        return reject(new PoolBusyError(`${this.opts.name}: ${this.queue.length} tasks already waiting`));
      }
      if (job.urgent) {
        const at = this.queue.findIndex((j) => !j.urgent);
        this.queue.splice(at === -1 ? this.queue.length : at, 0, job);
      } else {
        this.queue.push(job);
      }
      job.waiting = setTimeout(() => {
        const at = this.queue.indexOf(job);
        if (at === -1) return;
        this.queue.splice(at, 1);
        this.stats.expired++;
        reject(new PoolBusyError(`${this.opts.name}: not started within ${this.maxWaitMs} ms`));
      }, this.maxWaitMs);
    });
  }

  /** Off the queue and onto a worker: its wait is over. */
  private dequeue(): Job | undefined {
    const job = this.queue.shift();
    if (job?.waiting) clearTimeout(job.waiting);
    return job;
  }

  private spawn(): Slot {
    const worker = new Worker(this.opts.file.url, {
      env: {},
      resourceLimits: this.opts.resourceLimits,
      workerData: this.opts.file.workerData,
    });
    const slot: Slot = { worker, job: null, idle: null, ready: false, starting: null };
    slot.starting = setTimeout(() => {
      this.log(`[tifo] ${this.opts.name} worker did not start within ${START_LIMIT_MS} ms; stopping it`);
      void worker.terminate();
    }, START_LIMIT_MS);
    slot.starting.unref();
    worker.on('message', (m: { ready?: true; heapLimitMb?: number; ok: boolean; result?: unknown; error?: string }) => {
      if (m.ready) {
        this.checkLimit(m.heapLimitMb);
        return this.started(slot);
      }
      this.settle(slot, m);
    });
    worker.on('error', (err: unknown) => this.lost(slot, `failed: ${(err as Error)?.message ?? err}`));
    worker.on('exit', (code) => this.lost(slot, `exited (${code})`));
    worker.unref();
    this.slots.push(slot);
    this.stats.started++;
    return slot;
  }

  /**
   * V8 sizes a worker's heap from resourceLimits plus some room of its own
   * (16 MB asked for is about 67 MB reported); a limit many times larger
   * means a process-wide flag won. Said once per pool.
   */
  private checkLimit(heapLimitMb: number | undefined): void {
    const asked = this.opts.resourceLimits.maxOldGenerationSizeMb;
    if (typeof heapLimitMb !== 'number' || !asked || this.limitOverridden) return;
    if (heapLimitMb > asked * 2 + 256) {
      this.limitOverridden = true;
      this.log(`[tifo] ${this.opts.name} worker: memory limit not in force (${heapLimitMb} MB instead of about ${asked} MB). NODE_OPTIONS sets a V8 heap size, which overrides it; remove that setting.`);
    }
  }

  private started(slot: Slot): void {
    if (slot.starting) clearTimeout(slot.starting);
    slot.starting = null;
    slot.ready = true;
    if (slot.job) this.post(slot, slot.job);
  }

  private assign(slot: Slot, job: Job): void {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.job = job;
    // A worker with a task keeps the process alive until it answers.
    slot.worker.ref();
    if (slot.ready) this.post(slot, job);
  }

  /** Hand the task over, and start its clock. */
  private post(slot: Slot, job: Job): void {
    job.timer = setTimeout(() => {
      this.stats.timedOut++;
      this.drop(slot);
      job.reject(new PoolFailedError(`${this.opts.name}: no answer within ${this.opts.timeoutMs} ms`));
      this.log(`[tifo] ${this.opts.name} worker: a task ran past ${this.opts.timeoutMs} ms; the worker was stopped and replaced`);
      void slot.worker.terminate();
      this.refill();
    }, this.opts.timeoutMs);
    try {
      slot.worker.postMessage(job.msg, job.transfer);
    } catch (e) {
      clearTimeout(job.timer);
      slot.job = null;
      job.reject(new PoolFailedError(`${this.opts.name}: ${(e as Error).message}`));
      this.release(slot);
    }
  }

  private settle(slot: Slot, m: { ok: boolean; result?: unknown; error?: string }): void {
    const job = slot.job;
    if (!job) return;
    clearTimeout(job.timer);
    slot.job = null;
    if (m.ok) {
      this.stats.done++;
      job.resolve(m.result);
    } else {
      this.stats.failed++;
      job.reject(new PoolFailedError(`${this.opts.name}: ${m.error ?? 'failed'}`));
    }
    this.release(slot);
  }

  /** Next task for this worker, or rest (and end after idleMs). */
  private release(slot: Slot): void {
    const next = this.dequeue();
    if (next) return this.assign(slot, next);
    slot.worker.unref();
    slot.idle = setTimeout(() => {
      this.drop(slot);
      void slot.worker.terminate();
    }, this.opts.idleMs);
    slot.idle.unref();
  }

  /** Take a worker out of the pool (it is being terminated or has died). */
  private drop(slot: Slot): boolean {
    const i = this.slots.indexOf(slot);
    if (i < 0) return false;
    this.slots.splice(i, 1);
    if (slot.idle) clearTimeout(slot.idle);
    if (slot.starting) clearTimeout(slot.starting);
    slot.idle = null;
    slot.starting = null;
    return true;
  }

  /** A worker that crashed, ran out of memory or exited: its task fails, and it is replaced. */
  private lost(slot: Slot, why: string): void {
    if (!this.drop(slot)) return; // already taken out (timed out, idle, or closed)
    const job = slot.job;
    slot.job = null;
    if (job) {
      clearTimeout(job.timer);
      this.stats.crashed++;
      job.reject(new PoolFailedError(`${this.opts.name}: the worker ${why}`));
      this.log(`[tifo] ${this.opts.name} worker ${why} during a task; it will be replaced`);
    }
    this.refill();
  }

  /** Start a worker for whatever is waiting. */
  private refill(): void {
    if (this.closed) return;
    while (this.queue.length && this.slots.length < this.opts.size) this.assign(this.spawn(), this.dequeue()!);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      if (job.waiting) clearTimeout(job.waiting);
      job.reject(new PoolBusyError(`${this.opts.name}: closed`));
    }
    const all = this.slots.splice(0);
    for (const s of all) {
      if (s.idle) clearTimeout(s.idle);
      if (s.starting) clearTimeout(s.starting);
      if (s.job) {
        clearTimeout(s.job.timer);
        s.job.reject(new PoolBusyError(`${this.opts.name}: closed`));
      }
    }
    await Promise.all(all.map((s) => s.worker.terminate().catch(() => 0)));
  }
}

export interface WorkerEntry {
  url: URL;
  workerData?: { entry: string };
}

/**
 * Where a worker's entry point is. In production, the bundled .mjs beside
 * server/build/server.mjs. Under tsx (development, the tests), the
 * TypeScript source beside this file, started through workerBoot.mjs,
 * because the tsx loader is not carried into worker threads. Decided at run
 * time from this module's own URL; nothing is defined at build time.
 */
export function workerFile(name: 'sceneWorker' | 'pdfWorker'): WorkerEntry {
  const here = import.meta.url;
  if (!here.endsWith('.ts')) return { url: new URL(`./${name}.mjs`, here) };
  return { url: new URL('./workerBoot.mjs', here), workerData: { entry: new URL(`./${name}.ts`, here).href } };
}

/**
 * Scenes: one worker, sixteen waiting, 5 s each. A real scene parses in about
 * 10 ms and the slowest shape the structure caps allow in about 100 ms, so 5 s
 * is only ever a broken or hostile one. 256 MB: a 16 MB scene, parsed and
 * written back, with room to spare.
 */
/**
 * How many of the scene queue's 16 places anonymous views (and copies) may
 * take: the other four are always free for an owner's save, which also waits
 * ahead of every view (stage 2 review).
 */
export const SCENE_VIEW_ROOM = 12;

export const SCENE_POOL: Omit<PoolOptions, 'file'> = {
  name: 'scene',
  size: 1,
  maxQueue: 16,
  timeoutMs: 5_000,
  // Sixteen ordinary tasks clear in well under a second; five seconds in the
  // queue means the worker is being flooded, and the caller is told to retry.
  maxWaitMs: 5_000,
  idleMs: 5 * 60_000,
  resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
};

/**
 * PDFs: one worker, four waiting, 30 s each (the biggest ground takes about
 * 3 s on a busy box). It holds the stadium catalogue and pdfkit, so it ends
 * after a minute without work and the memory goes back.
 */
export const PDF_POOL: Omit<PoolOptions, 'file'> = {
  name: 'pdf',
  size: 1,
  maxQueue: 4,
  timeoutMs: 30_000,
  // Four big grounds at about 3 s each, with room to spare.
  maxWaitMs: 15_000,
  idleMs: 60_000,
  resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
};
