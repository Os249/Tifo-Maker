/**
 * Pro at export: which Pro items an export carries, and the one question that
 * is asked about them.
 *
 * Pro tools are free to try in the editor, the 3D view and Match Day (the
 * design bible, "Pro"). What Pro decides is what LEAVES the site: a video, a
 * picture, a GIF. So every export that can carry a Pro item asks here first:
 *
 *   exportGate(items)  'pro'  Pro is running (or nothing here is Pro): go on;
 *                      'free' they chose "Export without Pro items";
 *                      null   they closed the sheet: export nothing.
 *
 * Two kinds of Pro item:
 *  - the export's own (no mark, Full HD, the 4K poster, LED board text): the
 *    export code knows them and passes their names;
 *  - the design's (a portrait style on a picture, a Pro font on a text): they
 *    live on layers, so the perk that adds them registers a probe here, and
 *    designProItems() / withoutDesignProItems() read and lift them for an
 *    export without moving anything in the editor's history.
 *
 * Holds no strings of its own (a probe brings its own label), so importing it
 * adds nothing to the editor's start. The sheet is ui/proSheets.ts, loaded
 * when it first opens. Like the rest of Pro in the interface, this SHOWS and
 * ASKS; the server is what guards anything that costs money.
 */
import { fetchPro } from '../net/api';
import type { ObjectLayer, TifoObject } from '../core/objects';

/**
 * A design-level Pro item. `patch` says how one layer would look without it
 * (null: this layer does not use it); `label` is its name on the export sheet.
 */
export interface ProProbe {
  label(): string;
  patch(o: TifoObject): Partial<TifoObject> | null;
}

const probes = new Map<string, ProProbe>();

/**
 * A Pro item in the design that is not on a layer (a banner's Pro font, say):
 * whether the design uses it now, and how to lift it for one export. `lift`
 * changes what it must and hands back the function that puts it back.
 */
export interface ProLifter {
  label(): string;
  active(): boolean;
  lift(): () => void;
}

const lifters = new Map<string, ProLifter>();

/** Register (or replace) a design-level Pro item. Called by the perk that adds it. */
export function registerProProbe(id: string, probe: ProProbe): void {
  probes.set(id, probe);
}

/** Register (or replace) a design-level Pro item that lives outside the layers. */
export function registerProLifter(id: string, lifter: ProLifter): void {
  lifters.set(id, lifter);
}

/** The names of the Pro items the design uses (its visible layers, and the rest), once each. */
export function designProItems(layer: Pick<ObjectLayer, 'list'> | null | undefined): string[] {
  const out: string[] = [];
  if (layer) {
    for (const p of probes.values()) {
      if (layer.list().some((o) => !o.hidden && p.patch(o) !== null)) out.push(p.label());
    }
  }
  for (const l of lifters.values()) {
    try {
      if (l.active()) out.push(l.label());
    } catch {
      /* a lifter that cannot tell is treated as not in use */
    }
  }
  return [...new Set(out)];
}

/**
 * Run an export with the design's Pro items lifted (a portrait style back to
 * the picture, a Pro font back to the default voice), then put them back. No
 * undo step either way: the editor's history never sees it. The seats, the 3D
 * view and Match Day all follow the layers, so whatever the export captures
 * is the free version.
 */
export async function withoutDesignProItems<T>(layer: ObjectLayer | null | undefined, run: () => Promise<T>): Promise<T> {
  const putBack: (() => void)[] = [];
  for (const l of lifters.values()) {
    try {
      if (l.active()) putBack.push(l.lift());
    } catch {
      /* nothing to put back */
    }
  }
  const undo: { id: string; patch: Partial<TifoObject> }[] = [];
  for (const o of layer?.list() ?? []) {
    if (o.hidden) continue;
    let merged: Partial<TifoObject> | null = null;
    for (const p of probes.values()) {
      const one = p.patch(o);
      if (one) merged = { ...(merged ?? {}), ...one };
    }
    if (!merged) continue;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(merged)) before[k] = (o as unknown as Record<string, unknown>)[k];
    undo.push({ id: o.id, patch: before as Partial<TifoObject> });
    layer!.mutate(o.id, merged);
  }
  try {
    return await run();
  } finally {
    for (const u of undo.reverse()) layer!.mutate(u.id, u.patch);
    for (const back of putBack.reverse()) {
      try {
        back();
      } catch {
        /* keep putting the rest back */
      }
    }
  }
}

export type GateAnswer = 'pro' | 'free' | null;

/**
 * Ask about the Pro items in an export, once. With none, or with Pro running
 * (a paid month or the gift), or with Pro not on for this visitor at all,
 * the answer is 'pro' and nothing is shown. Otherwise the export sheet opens:
 * the gift or Pro, or "Export without Pro items".
 */
export async function exportGate(items: string[]): Promise<GateAnswer> {
  const list = [...new Set(items.filter(Boolean))];
  if (!list.length) return 'pro';
  const st = await fetchPro(true).catch(() => null);
  if (!st?.live) return 'pro';
  if (st.plan && st.plan !== 'free') return 'pro';
  const { openExportSheet } = await import('./proSheets');
  const choice = await openExportSheet(list, st);
  return choice === 'free' ? 'free' : null;
}

/** Whether Pro is on for this visitor, and whether it is running for them. */
export async function proStatus(): Promise<{ live: boolean; running: boolean }> {
  const st = await fetchPro().catch(() => null);
  return { live: !!st?.live, running: !!st?.live && !!st.plan && st.plan !== 'free' };
}
