/**
 * Fix operations: the small, typed changes AI Critique may make to a design.
 *
 * The critic never sends a new design. It sends a list of fixes, each one
 * operation from the list below, and the person applies or dismisses them one
 * at a time. This file is the whole of what a fix can do:
 *
 *   parseFixOp  reads one operation as a model wrote it and returns it only
 *               if every part is something this design has (a layer id that
 *               was sent, a colour of its palette, a stand with seats). The
 *               server runs it on the model's answer and the browser runs it
 *               again before applying, so a fix that names anything else
 *               never reaches the seats.
 *   applyFix    carries one out as ONE undo step, and hands back a way to
 *               take that fix alone back later, when it is no longer the
 *               last thing that happened.
 *
 * No DOM here: the size of a piece of text is asked of `textSize`, which the
 * browser answers with core/objects `textObjectSize` and a test with numbers.
 */
import type { DesignStore } from './design';
import type { ObjectLayer, TextObject, TextOutline, TifoObject } from './objects';
import { EDITOR_UNITS } from './seatmap';
import { regionPredicate, regionRect } from './specCompiler';
import { STANDS, STAND_GEOMETRY, type Stand } from './tifoSpec';
import type { SeatMap } from './types';
import type { ColorRef, FixContext, FixOp } from './fixParse';

export { FIX_LIMITS, FIX_OP_TYPES, parseFixOp } from './fixParse';
export type { ColorRef, FixContext, FixLayerKind, FixOp, FixOpType } from './fixParse';

/** The context for the design in hand. */
export function fixContextOf(objects: ObjectLayer, store: DesignStore, map: SeatMap): FixContext {
  return {
    layers: objects.list().map((o) => ({
      id: o.id, kind: o.kind, ...(o.kind === 'text' ? { text: o.text, fontId: o.fontId } : {}), ...(o.locked ? { locked: true } : {}),
    })),
    paletteLength: store.palette.length,
    stands: standsWithSeats(map),
  };
}

export function standsWithSeats(map: SeatMap): Stand[] {
  return STANDS.filter((s) => {
    const inStand = regionPredicate({ stand: s, tier: 'all' }, map);
    for (let i = 0; i < map.count; i++) if (inStand(i)) return true;
    return false;
  });
}

// ------------------------------------------------------------------ apply ---

export interface FixDeps {
  store: DesignStore;
  objects: ObjectLayer;
  map: SeatMap;
  /** The footprint of a text layer, in editor units (core/objects textObjectSize in the browser). */
  textSize: (t: Pick<TextObject, 'text' | 'fontCss' | 'fontId' | 'arcDeg' | 'heightSeats' | 'outline'>) => { width: number; height: number } | null;
}

export interface AppliedFix {
  /**
   * Take this fix back. While it is still the last thing that happened, that
   * is the editor's own undo, exactly. Later it puts back what the fix changed
   * wherever that is still as the fix left it, as a new undo step, and leaves
   * alone anything changed since. False when there was nothing left to take back.
   */
  revert(): boolean;
}

const W = EDITOR_UNITS.width;

/** The stand an x on the unrolled bowl belongs to. */
export function standAt(x: number): Stand {
  const u = (((x / W) % 1) + 1) % 1;
  return (['east', 'north', 'west', 'south'] as const)[Math.floor(((u + 0.125) % 1) * 4) % 4];
}

/**
 * A stand's box. East sits on the seam of the unrolled bowl, so its centre is
 * both ends of it: the end nearer `x` is given, and a layer already there
 * does not cross the whole strip to be centred.
 */
function standBox(stand: Stand, map: SeatMap, x: number): { cx: number; cy: number; width: number; height: number } {
  const rect = regionRect({ stand, tier: 'all' }, map);
  const centre = STAND_GEOMETRY[stand].centerU * W;
  const lap = (((x % W) + W) % W) > W / 2 ? W : 0;
  return { ...rect, cx: centre === 0 ? lap : centre };
}

/** The palette index of a colour a fix names, adding a new colour to the palette (an undo step of the group). */
function indexOf(color: ColorRef, store: DesignStore): number | null {
  if (typeof color === 'number') return color >= 0 && color < store.palette.length ? color : null;
  const at = store.palette.findIndex((c) => c.toLowerCase() === color.toLowerCase());
  if (at >= 0) return at;
  if (store.palette.length >= 256) return null;
  store.changePalette([...store.palette, color]);
  return store.palette.length - 1;
}

/** Text fields changed, with the footprint that goes with them. */
function textPatch(o: TextObject, change: Partial<Pick<TextObject, 'text' | 'heightSeats' | 'outline'>>, deps: FixDeps): Partial<TextObject> {
  const next = { text: o.text, fontCss: o.fontCss, fontId: o.fontId, arcDeg: o.arcDeg, heightSeats: o.heightSeats, outline: o.outline, ...change };
  const size = deps.textSize(next);
  return { ...change, ...(size ? { width: size.width, height: size.height } : {}) };
}

type Patch = Record<string, unknown>;

/** The fields of `o` a patch is about to change, as they are now. */
function before(o: TifoObject, patch: Patch): Patch {
  const out: Patch = {};
  for (const k of Object.keys(patch)) out[k] = (o as unknown as Patch)[k];
  return out;
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Carry one fix out, as one undo step. Null when it no longer applies (its
 * layer is gone or locked, nothing would change): the design is untouched.
 */
export function applyFix(op: FixOp, deps: FixDeps): AppliedFix | null {
  const { store, objects, map } = deps;
  // What was changed, for taking this fix alone back later.
  const layerUndo: { id: string; was: Patch; now: Patch }[] = [];
  const seatUndo: { index: number; was: number; now: number }[] = [];
  const startStep = store.lastStep;

  const patchLayer = (o: TifoObject, patch: Partial<TifoObject>): void => {
    const p = patch as Patch;
    const was = before(o, p);
    if (Object.keys(p).every((k) => same(was[k], p[k]))) return;
    layerUndo.push({ id: o.id, was, now: p });
    objects.update(o.id, patch);
  };
  /** Repaint the Paint layer's seats that `pick` gives a new value for. */
  const repaint = (pick: (i: number, value: number) => number): void => {
    const dirty: number[] = [];
    store.paintBaseOnly(() => {
      store.beginStroke();
      for (let i = 0; i < map.count; i++) {
        const was = store.base[i];
        const now = pick(i, was);
        if (now === was || store.isLocked(i)) continue;
        if (store.paint(i, now)) dirty.push(i);
        if (store.base[i] === now) seatUndo.push({ index: i, was, now });
      }
      store.commitStroke();
    });
    store.flush(dirty.length ? 'all' : []);
  };

  const layer = 'layer' in op ? objects.get(op.layer) : null;
  if ('layer' in op && (!layer || layer.locked)) return null;

  store.group(() => {
    switch (op.type) {
      case 'text.setCase':
      case 'text.setText': {
        if (layer?.kind !== 'text') return;
        patchLayer(layer, textPatch(layer, { text: op.text }, deps));
        return;
      }
      case 'text.resize': {
        if (layer?.kind !== 'text') return;
        patchLayer(layer, textPatch(layer, { heightSeats: op.rows }, deps));
        return;
      }
      case 'text.outline': {
        if (layer?.kind !== 'text') return;
        let outline: TextOutline | undefined;
        if (op.seats > 0) {
          const colorIndex = indexOf(op.color, store);
          if (colorIndex === null) return;
          outline = { colorIndex, seats: op.seats };
        }
        patchLayer(layer, textPatch(layer, { outline }, deps));
        return;
      }
      case 'object.recolor': {
        if (!layer) return;
        const colorIndex = indexOf(op.color, store);
        if (colorIndex !== null) patchLayer(layer, { colorIndex });
        return;
      }
      case 'object.fitToStand': {
        if (!layer) return;
        const box = standBox(op.stand, map, layer.cx);
        // A little air at the edges: a layer flush with the stand's ends loses its outer seats to the aisles.
        const k = Math.min(1, (box.width * 0.94) / layer.width, (box.height * 0.94) / layer.height);
        const patch: Partial<TifoObject> = { cx: box.cx, cy: box.cy, keep: { stand: op.stand, tier: 'all' } };
        if (k < 1) {
          patch.width = layer.width * k;
          patch.height = layer.height * k;
          if (layer.kind === 'text') (patch as Partial<TextObject>).heightSeats = Math.max(1, Math.round(layer.heightSeats * k));
        }
        patchLayer(layer, patch);
        return;
      }
      case 'object.center': {
        if (!layer) return;
        const stand = layer.keep && layer.keep.stand !== 'all' ? layer.keep.stand : standAt(layer.cx);
        const box = standBox(stand, map, layer.cx);
        patchLayer(layer, { ...(op.axis !== 'y' ? { cx: box.cx } : {}), ...(op.axis !== 'x' ? { cy: box.cy } : {}) });
        return;
      }
      case 'paint.replaceColor': {
        const to = indexOf(op.to, store);
        if (to === null || to === op.from) return;
        const inStand = op.stand === 'all' ? null : regionPredicate({ stand: op.stand, tier: 'all' }, map);
        repaint((i, value) => (value === op.from && (!inStand || inStand(i)) ? to : value));
        return;
      }
      case 'palette.merge': {
        const remap = store.palette.map((_, i) => op.merge.find((m) => m.from === i)?.to ?? i);
        for (let i = 0; i < map.count; i++) {
          const was = store.base[i];
          if (remap[was] !== was && !store.isLocked(i)) seatUndo.push({ index: i, was, now: remap[was] });
        }
        for (const o of objects.list()) {
          const p: Patch = {};
          if (remap[o.colorIndex] !== o.colorIndex) p.colorIndex = remap[o.colorIndex];
          if (o.kind === 'text' && o.outline && remap[o.outline.colorIndex] !== o.outline.colorIndex) p.outline = { ...o.outline, colorIndex: remap[o.outline.colorIndex] };
          if (Object.keys(p).length) layerUndo.push({ id: o.id, was: before(o, p), now: p });
        }
        // A picture's tones or a touch-up may hold the colour too.
        const inRaster = objects.list().some((o) => [o.grid, o.touch].some((g) => !!g && g.data.some((v) => v >= 0 && remap[v] !== v)));
        // Nothing shows these colours: no step, and no fix.
        if (!seatUndo.length && !layerUndo.length && !inRaster) return;
        store.remapIndices(remap);
        return;
      }
    }
  });

  const step = store.lastStep;
  if (step === startStep) return null; // nothing changed
  let reverted = false;

  return {
    revert(): boolean {
      if (reverted) return false;
      reverted = true;
      if (store.lastStep === step) {
        store.undo();
        return true;
      }
      const mark = store.lastStep;
      store.group(() => {
        for (const u of layerUndo) {
          const o = objects.get(u.id);
          if (!o || o.locked) continue;
          // Only what is still as the fix left it: a field edited since is the person's.
          const back: Patch = {};
          for (const k of Object.keys(u.was)) if (same((o as unknown as Patch)[k], u.now[k])) back[k] = u.was[k];
          if (Object.keys(back).length) objects.update(o.id, back as Partial<TifoObject>);
        }
        if (seatUndo.length) {
          const dirty: number[] = [];
          store.paintBaseOnly(() => {
            store.beginStroke();
            for (const s of seatUndo) if (store.base[s.index] === s.now && store.paint(s.index, s.was)) dirty.push(s.index);
            store.commitStroke();
          });
          store.flush(dirty.length ? 'all' : []);
        }
      });
      return store.lastStep !== mark;
    },
  };
}
