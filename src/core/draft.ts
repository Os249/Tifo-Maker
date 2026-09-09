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
    doc,
  };
}

/** Write the draft. Never throws; the caller decides what to tell the user. */
export function writeDraft(env: DraftEnvelope): DraftWriteResult {
  let json: string;
  try {
    json = JSON.stringify(env);
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

/**
 * Debounce a draft write. Editing fires continuously (every brush stroke), and
 * serialising 60,000 seats on each one would stutter the canvas, so writes are
 * coalesced. flush() exists for pagehide, where there is no time to wait.
 */
export function createDraftWriter(
  build: () => DraftEnvelope | null,
  onResult: (r: DraftWriteResult) => void,
  delayMs = 1200,
): { schedule: () => void; flush: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const run = (force: boolean): void => {
    timer = null;
    if (!pending && !force) return;
    pending = false;
    const env = build();
    if (!env) return;
    onResult(writeDraft(env));
  };

  return {
    schedule(): void {
      pending = true;
      if (timer) return;
      timer = setTimeout(() => run(false), delayMs);
    },
    /**
     * Write now, whether or not a change is pending. Pressing Save must produce
     * a real write and a real result: reporting "saved" off the back of a no-op
     * would be the exact lie this module exists to prevent.
     */
    flush(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run(true);
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}
