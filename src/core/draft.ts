/**
 * Local draft persistence — the safety net under everything else.
 *
 * WHY THIS EXISTS
 * Until now a design lived only in memory. Painting a tifo and closing the tab
 * destroyed it: nothing was ever written to disk unless an account save
 * succeeded, and creating an account was the only way to keep anything. That is
 * why almost everyone who painted something left with nothing.
 *
 * A draft is written here on every change, so the work survives a reload, a
 * crash, or a closed tab, and it survives WITHOUT an account. Signing up then
 * becomes an offer ("keep it anywhere") rather than a toll.
 *
 * HONESTY ABOUT WHERE IT LIVES
 * This is localStorage, not a backup. Excalidraw ships exactly this and its
 * users still lose work, because:
 *   - the ~5MB per-origin budget fails on write with no warning of its own,
 *   - Safari evicts site data after 7 days without a visit,
 *   - privacy-focused browsers clear it aggressively,
 *   - a second tab on the same design overwrites the first (last write wins).
 * So every failure below is REPORTED rather than swallowed, the UI says "saved
 * in this browser" rather than "saved", and the .tifo download stays as the
 * durable escape hatch. Promising more than this can deliver is how you turn a
 * safety net into a betrayal.
 *
 * WHAT IS AND IS NOT CAPTURED
 * The painted seats, the palette, the stadium, the title and any text objects.
 * Image and shape overlays are not: they hold a live ImageBitmap that has no
 * JSON form, which is why the existing .tifo export bakes images into cells
 * first. Baking is destructive, so an autosave must never do it silently. The
 * seats someone painted are the substance; an unbaked overlay is not worth
 * corrupting their design to preserve.
 */

import { buildTifoV2, type TifoDocV2 } from './tifoFormat';

const KEY = 'tifo_draft_v1';

/** Refuse to write beyond this; the browser ceiling is ~5MB for the whole origin. */
const MAX_BYTES = 3_500_000;

export interface DraftEnvelope {
  v: 1;
  savedAt: number;
  templateId: string;
  templateVersion: number;
  title: string;
  /**
   * The account design this draft belongs to, when there is one. Without it a
   * restored draft of an already-saved design would look brand new and the next
   * save would fork a duplicate instead of updating the original.
   */
  designId: string | null;
  /** The local project this belongs to, when it is one (see core/projects). */
  projectId?: string | null;
  /**
   * True when this copy holds changes the account has not got yet. Only
   * meaningful for an account project: a local project's copy is the only one.
   */
  dirty?: boolean;
  doc: TifoDocV2;
}

export type DraftWriteResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'too-big' | 'quota' | 'blocked' };

export interface DraftTextObject {
  id: string;
  kind: 'text';
  text: string;
  fontId: string;
  arcDeg: number;
  colorIndex: number;
  tier: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Serialise the current design into a draft envelope. Pure: it reads the store
 * but never mutates it, so it is safe to call on every keystroke.
 */
export function buildDraft(args: {
  title: string;
  templateId: string;
  templateVersion: number;
  palette: string[];
  cells: Uint8Array;
  textObjects: DraftTextObject[];
  designId: string | null;
  projectId?: string | null;
  dirty?: boolean;
}): DraftEnvelope {
  const doc = buildTifoV2({
    title: args.title,
    generator: 'tifomaker-draft',
    templateId: args.templateId,
    templateVersion: args.templateVersion,
    palette: args.palette,
    cells: args.cells,
    objects: args.textObjects,
  });
  return {
    v: 1,
    savedAt: Date.now(),
    templateId: args.templateId,
    templateVersion: args.templateVersion,
    title: args.title,
    designId: args.designId,
    projectId: args.projectId ?? null,
    dirty: args.dirty ?? false,
    doc,
  };
}

/** Write the draft. Never throws; the caller decides what to tell the user. */
export function writeDraft(env: DraftEnvelope, serialised?: string): DraftWriteResult {
  let json: string;
  try {
    json = serialised ?? JSON.stringify(env);
  } catch {
    return { ok: false, reason: 'blocked' };
  }
  // A rough byte count: localStorage is UTF-16, so budget two bytes per unit.
  const bytes = json.length * 2;
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too-big' };
  try {
    localStorage.setItem(KEY, json);
    return { ok: true, bytes };
  } catch (e) {
    // QuotaExceededError, or storage disabled entirely (private mode, blocked cookies).
    const name = (e as { name?: string })?.name ?? '';
    return { ok: false, reason: /quota|exceed/i.test(name) ? 'quota' : 'blocked' };
  }
}

/** Read the stored draft, or null when there is none / it is unreadable. */
export function readDraft(): DraftEnvelope | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null; // storage blocked
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftEnvelope;
    if (!parsed || parsed.v !== 1 || !parsed.doc) return null;
    return parsed;
  } catch {
    return null; // corrupt; treat as absent rather than crashing the editor
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Cheap existence check for boot, without parsing the whole document. */
export function hasDraft(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** "just now", "4 minutes ago", "yesterday" — for the restore notice. */
export function describeAge(savedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export interface DraftWriterOptions {
  /**
   * The longest a change waits while edits keep coming, from the first change
   * not yet written. Without it a steady run of strokes with short pauses
   * between them would never be quiet long enough for the trailing wait.
   */
  maxWaitMs?: number;
  /**
   * True while a gesture is under way: a brush stroke, a layer being dragged,
   * a banner being moved. Nothing is written until it ends (release()).
   */
  held?: () => boolean;
  /**
   * The write for leaving the page (flushNow): synchronous, so it is done
   * before a closing tab is gone. `write` may compress and store
   * asynchronously (performance plan P3.7), which a closing tab may never
   * finish. Defaults to `write` when that is synchronous.
   */
  writeNow?: (env: DraftEnvelope, json: string) => DraftWriteResult;
}

export interface DraftWriter {
  /** A change was made: write it after the waits. */
  schedule(): void;
  /** A gesture ended: a write it held back goes now. */
  release(): void;
  /**
   * Write now, whether or not a change is pending, gesture or not. Resolves
   * with that write's own result once it is really written (null when there
   * was nothing to build). Pressing Save must produce a real write and a
   * real result: reporting "saved" off the back of a no-op would be the
   * exact lie this module exists to prevent.
   */
  flush(): Promise<DraftWriteResult | null>;
  /**
   * Leaving the page (pagehide, a hidden tab): write now with `writeNow`,
   * synchronously, unless nothing is waiting and the design as it is now is
   * exactly what is already stored for sure. Null when there was nothing to
   * write.
   */
  flushNow(): DraftWriteResult | null;
  stop(): void;
  /**
   * The draft this browser holds for the open project, as it was read when
   * the project opened. Leaving the page with the design still exactly that
   * writes nothing (flushNow compares with it until a write of its own).
   */
  known(env: DraftEnvelope | null): void;
  /** A change is waiting to be written. */
  readonly pending: boolean;
  /** A write has started and not finished. */
  readonly writing: boolean;
}

/**
 * What a draft holds, for telling two apart: its JSON without the times it
 * was built (buildDraft writes savedAt second, and buildTifoV2 stamps the
 * document's meta.createdAt, which comes before the seats, so the search
 * stops a few hundred characters in). A key inside a string is escaped (\")
 * and so never taken for one. One built some other way keeps its times and
 * never matches, which only means it is written again.
 */
export const contentOf = (json: string): string =>
  json.replace(/^\{"v":1,"savedAt":\d+,/, '{"v":1,').replace(/"createdAt":"[^"\\]*"/, '"createdAt":""');

/**
 * How long a gesture may hold a due write back. A gesture is seconds long; a
 * hold longer than this means one that never said it ended, and the work is
 * written anyway rather than waiting for the tab to close.
 */
const HOLD_CAP_MS = 30_000;
/** How often a held write looks again, should a gesture's end go unreported. */
const HOLD_POLL_MS = 500;

/**
 * Coalesce draft writes. Editing fires continuously (every brush stroke), and
 * serialising 60,000 seats on each one would stutter the canvas.
 *
 * A write goes `delayMs` after the last change (a trailing wait), and no later
 * than `maxWaitMs` after the first change it carries, so a long session still
 * saves; never in the middle of a gesture (performance plan P2.11). It used to
 * go 1.2 s after the first change whatever came after it: continuous painting
 * wrote every 1.2 s, each time with the whole layer stack behind it, half of
 * them mid-stroke.
 *
 * `write` may be asynchronous: the draft is compressed and stored in
 * IndexedDB (performance plan P3.7). Writes go one at a time, in order; a
 * write asked for while one is on its way follows it, built from the design
 * as it is then, so an older draft can never land after a newer one. Its
 * result reaches `onResult` only once it is really written.
 *
 * flush() is for Save and the moments the editor moves on, which must not
 * wait for the timer; flushNow() for pagehide and a hidden tab, where there
 * is no time for anything asynchronous. flushNow writes when a change is
 * waiting (a banner or a title too: what rides on the draft's onResult is
 * written with it), when a write is on its way that a closing tab may never
 * finish, and when the design differs from what is stored for sure even with
 * nothing scheduled: a palette edit, for one, schedules nothing, and leaving
 * the page has always been what wrote it.
 *
 * The envelope is serialised here, once per write, and handed on (`json`).
 */
export function createDraftWriter(
  build: () => DraftEnvelope | null,
  onResult: (r: DraftWriteResult) => void,
  delayMs = 1200,
  /** Where it goes. Projects pass their own key (see core/projects). */
  write: (env: DraftEnvelope, json: string) => DraftWriteResult | Promise<DraftWriteResult> = writeDraft,
  opts: DraftWriterOptions = {},
): DraftWriter {
  const maxWait = opts.maxWaitMs ?? Infinity;
  const held = opts.held ?? (() => false);
  const writeNow = opts.writeNow ?? ((env: DraftEnvelope, json: string): DraftWriteResult => {
    const r = write(env, json);
    return r instanceof Promise ? { ok: false, reason: 'blocked' } : r;
  });
  const now = (): number => performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  /** When the oldest change not yet written was made, and the latest. */
  let firstAt = 0;
  let lastAt = 0;
  /** A write fell due during a gesture, and when it first did. */
  let heldSince = 0;
  /** A write is on its way; another was asked for meanwhile. */
  let writing = false;
  let again = false;
  /** flush() callers waiting for the next write to finish. */
  let waiters: ((r: DraftWriteResult | null) => void)[] = [];
  /** What the last write that certainly finished held (contentOf), by either path. */
  let stored: string | null = null;
  /** That was flushNow's own synchronous write (so a write since on its way carries nothing new). */
  let storedNow = false;
  /** What was read at opening, until a write replaces it (serialised only if needed). */
  let opened: DraftEnvelope | null = null;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    const due = Math.min(lastAt + delayMs, firstAt + maxWait);
    timer = setTimeout(tick, Math.max(0, due - now()));
  };
  const start = (): void => {
    pending = false;
    heldSince = 0;
    again = false;
    const mine = waiters;
    waiters = [];
    const env = build();
    if (!env) {
      for (const w of mine) w(null);
      return;
    }
    writing = true;
    let out: DraftWriteResult | Promise<DraftWriteResult>;
    let content: string | null = null;
    try {
      const json = JSON.stringify(env);
      content = contentOf(json);
      out = write(env, json);
    } catch {
      out = { ok: false, reason: 'blocked' };
    }
    const done = (r: DraftWriteResult): void => {
      writing = false;
      if (r.ok) {
        stored = content;
        storedNow = false;
        opened = null;
      }
      onResult(r);
      for (const w of mine) w(r);
      if (again || waiters.length) start();
    };
    if (out instanceof Promise) {
      out.then(done, () => done({ ok: false, reason: 'blocked' }));
    } else {
      done(out);
    }
  };
  const run = (force: boolean): Promise<DraftWriteResult | null> => {
    clear();
    if (!pending && !force) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiters.push(resolve);
      if (writing) {
        again = true;
        return;
      }
      start();
    });
  };
  function tick(): void {
    timer = null;
    if (!pending) return;
    if (held()) {
      const t = now();
      if (!heldSince) heldSince = t;
      if (t - heldSince < HOLD_CAP_MS) {
        timer = setTimeout(tick, HOLD_POLL_MS);
        return;
      }
    }
    void run(false);
  }

  return {
    schedule(): void {
      const t = now();
      if (!pending) {
        pending = true;
        firstAt = t;
      }
      lastAt = t;
      // While a held write is waiting the poll is already running; the end
      // of the gesture (release) is what moves it.
      if (heldSince) return;
      arm();
    },
    release(): void {
      if (pending && heldSince && !held()) {
        clear();
        timer = setTimeout(tick, 0);
      }
    },
    flush(): Promise<DraftWriteResult | null> {
      return run(true);
    },
    flushNow(): DraftWriteResult | null {
      const env = build();
      if (!env) return null;
      let json: string;
      try {
        json = JSON.stringify(env);
      } catch {
        return null;
      }
      const content = contentOf(json);
      if (stored === null && opened) {
        try {
          stored = contentOf(JSON.stringify(opened));
        } catch {
          stored = null;
        }
        opened = null;
      }
      // Nothing waiting, and exactly what is stored for sure already. A
      // write still on its way counts only when it was started after this
      // very content was written here: otherwise it may carry a change (a
      // banner rides on its result) that a closing tab never finishes.
      if (!pending && content === stored && (!writing || storedNow)) return null;
      clear();
      pending = false;
      heldSince = 0;
      let r: DraftWriteResult;
      try {
        r = writeNow(env, json);
      } catch {
        r = { ok: false, reason: 'blocked' };
      }
      if (r.ok) {
        stored = content;
        storedNow = true;
        opened = null;
      }
      onResult(r);
      return r;
    },
    known(env: DraftEnvelope | null): void {
      if (stored === null) opened = env;
    },
    stop(): void {
      clear();
      pending = false;
      heldSince = 0;
    },
    get pending(): boolean {
      return pending;
    },
    get writing(): boolean {
      return writing;
    },
  };
}
