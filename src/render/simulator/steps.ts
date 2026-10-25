/**
 * A build in steps (performance plan P3.6).
 *
 * The Stadium view used to build a whole ground in one task: half a second
 * and more on a phone (Jewel: 1.3 s at a phone's speed), during which the page
 * could not answer a tap or draw a frame. The builders are generators now:
 * they do exactly what they did, in the same order, and say `yield` where a
 * piece of the building is finished. Match Day runs them straight through
 * (runSync: the same single task as before); the Stadium view runs them a
 * slice at a time (runSliced), giving the main thread back whenever a slice
 * has taken its budget.
 *
 * Same code, same order, so the same geometry and the same draws of
 * Math.random (three's object ids take four each): the pictures do not
 * change. A worker was the other way to keep the main thread free; it would
 * have needed every material, canvas texture and shader hook the builders
 * make carried across as data, and a worker's own Math.random.
 */

export type Steps<T> = Generator<void, T, void>;

/** Run every step now, in one task (what the builders did before). */
export function runSync<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Thrown out of runSliced when the caller no longer wants the result. */
export class BuildCancelled extends Error {
  constructor() {
    super('build cancelled');
  }
}

/**
 * Give the main thread back: input, rendering and other tasks run before the
 * build carries on. scheduler.yield() where there is one (the build goes on
 * ahead of other queued work), else a message to ourselves, which no browser
 * delays the way it delays a timer.
 */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof s?.yield === 'function') return s.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** How long a slice may run before it gives the main thread back, in ms. */
export const SLICE_MS = 8;

/**
 * Time spent working, not waiting: the slices' own time added up, for a
 * build's stats (a wall clock would count every other task in between).
 */
export class SliceClock {
  private busy = 0;
  private from = -1;
  /** Slices run so far, and the longest of them in ms (for the census and the suites). */
  slices = 0;
  longest = 0;
  begin(): void {
    if (this.from < 0) this.from = performance.now();
  }
  end(): void {
    if (this.from >= 0) {
      const d = performance.now() - this.from;
      this.busy += d;
      this.slices++;
      if (d > this.longest) this.longest = d;
    }
    this.from = -1;
  }
  now(): number {
    return this.busy + (this.from >= 0 ? performance.now() - this.from : 0);
  }
}

/**
 * Run the steps a slice at a time: as many as fit in `budgetMs`, then yield.
 * `cancelled` is asked between slices; when it says so, the steps are
 * abandoned (nothing they made has reached the GPU yet) and BuildCancelled
 * is thrown.
 */
export async function runSliced<T>(steps: Steps<T>, opts: { budgetMs?: number; cancelled?: () => boolean; clock?: SliceClock } = {}): Promise<T> {
  const budget = opts.budgetMs ?? SLICE_MS;
  const clock = opts.clock;
  clock?.begin();
  let t0 = performance.now();
  try {
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      if (performance.now() - t0 >= budget) {
        clock?.end();
        await yieldToMain();
        clock?.begin();
        if (opts.cancelled?.()) {
          steps.return(undefined as never);
          throw new BuildCancelled();
        }
        t0 = performance.now();
      }
    }
  } finally {
    clock?.end();
  }
}
