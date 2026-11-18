/**
 * Fix operations, undoable palettes and the text outline (the ground AI
 * Critique stands on): `npx tsx scripts/verify-fixops.mts`.
 *
 * Runs in Node, on a real bowl. Text is never drawn here (that needs a
 * browser), so text layers sit on a layer stack that keeps history but does
 * not rasterise; the seats themselves are checked with a real Composer.
 */
import { generateSeatMap, EDITOR_UNITS } from '../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../src/core/template';
import { DesignStore } from '../src/core/design';
import { ObjectLayer, gridKeyFor, objectFromJSON, objectToJSON, outlineStrokePx, hasOutline, type TextObject } from '../src/core/objects';
import { Composer } from '../src/core/composer';
import { TIFO_FONTS } from '../src/core/text';
import { regionPredicate, regionRect } from '../src/core/specCompiler';
import { applyFix, fixContextOf, parseFixOp, standAt, standsWithSeats, type FixDeps, type FixOp } from '../src/core/fixOps';

let fails = 0;
let checks = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  checks++;
  if (!cond) fails++;
  console.log(`fixops: ${name}`, cond ? 'ok' : `FAILED${extra ? ' — ' + extra : ''}`);
};

const map = generateSeatMap(DEFAULT_TEMPLATE);
const W = EDITOR_UNITS.width;
const PALETTE = ['#262a33', '#8cc8f5', '#7dbdee', '#ffffff', '#f2c230'];
const count = (cells: Uint8Array, v: number): number => { let n = 0; for (let i = 0; i < cells.length; i++) if (cells[i] === v) n++; return n; };

// ------------------------------------------------- the store: palettes ---
{
  const store = new DesignStore(map, PALETTE);
  store.fillAll(1);
  let told = 0;
  store.onPaletteChange(() => told++);
  const step0 = store.lastStep;

  store.changePalette([...PALETTE, '#0b2a6b']);
  ok('changePalette adds the colour', store.palette.length === 6 && store.palette[5] === '#0b2a6b');
  ok('and tells the views', told === 1);
  ok('and is one undo step', store.lastStep !== step0 && store.canUndo);
  ok('without moving a seat', count(store.cells, 1) === map.count);
  store.undo();
  ok('undo puts the old palette back', store.palette.length === 5 && store.palette.join() === PALETTE.join());
  ok('and leaves the seats', count(store.cells, 1) === map.count);
  store.redo();
  ok('redo brings the new one back', store.palette.length === 6);
  store.undo();

  const before = store.lastStep;
  store.changePalette([...PALETTE]);
  ok('the same palette is no step', store.lastStep === before);

  // What an AI design does: new colours and new seats, as one step.
  store.group(() => {
    store.changePalette(['#000000', '#ff0000', '#00ff00']);
    store.transform(() => 2);
  });
  ok('a design lands in its colours', store.palette[2] === '#00ff00' && count(store.cells, 2) === map.count);
  store.undo();
  ok('one undo puts back the seats AND the colours', store.palette.join() === PALETTE.join() && count(store.cells, 1) === map.count);

  // remapIndices
  store.transform((i) => (i % 2 === 0 ? 1 : 2));
  const twos = count(store.cells, 2);
  store.remapIndices([0, 1, 1, 3, 4]);
  ok('remapIndices merges one colour into another', count(store.cells, 2) === 0 && count(store.cells, 1) === map.count && twos > 0);
  ok('and keeps the palette', store.palette.join() === PALETTE.join());
  store.undo();
  ok('one undo splits them again', count(store.cells, 2) === twos);
  const mark = store.lastStep;
  store.remapIndices([0, 1, 2, 3, 4]);
  store.remapIndices([]);
  ok('a remap that changes nothing is no step', store.lastStep === mark);
  store.remapIndices([0, 99, 2]);
  ok('an index outside the palette is ignored', store.lastStep === mark && count(store.cells, 1) > 0);
}

// ------------------------------------------------- the outline on text ---
const font = TIFO_FONTS[0];
const textLayer = (over: Partial<TextObject> = {}): Omit<TextObject, 'id' | 'kind' | 'rotation'> => ({
  cx: W * 0.25, cy: (map.bounds.minY + map.bounds.maxY) / 2, width: 600, height: 80, colorIndex: 3, tier: null,
  text: 'kings of asia', fontCss: font.css, fontId: font.id, arcDeg: 0, heightSeats: 10, ...over,
});
{
  const plain = { ...textLayer(), id: 't1', kind: 'text', rotation: 0 } as TextObject;
  const lined = { ...plain, outline: { colorIndex: 4, seats: 2 } } as TextObject;
  ok('a layer without an outline keeps its old raster key', !gridKeyFor(plain).includes('|o'));
  ok('an outline is part of the raster key', gridKeyFor(lined) !== gridKeyFor(plain) && gridKeyFor(lined).endsWith('|o4:2'));
  ok('hasOutline', hasOutline(lined) && !hasOutline(plain));
  ok('the outline is drawn in proportion to the letters', outlineStrokePx(lined) === 24 && outlineStrokePx(plain) === 0, String(outlineStrokePx(lined)));
  ok('a thick outline on tiny letters is capped', outlineStrokePx({ heightSeats: 1, outline: { colorIndex: 1, seats: 8 } }) === 48);

  const json = objectToJSON(lined);
  ok('it is saved', JSON.stringify(json.outline) === JSON.stringify({ colorIndex: 4, seats: 2 }));
  ok('a plain layer saves none', !('outline' in objectToJSON(plain)));
  const back = objectFromJSON(JSON.parse(JSON.stringify(json)), TIFO_FONTS, PALETTE.length) as TextObject | null;
  ok('and read back', !!back && back.kind === 'text' && back.outline?.colorIndex === 4 && back.outline?.seats === 2);
  const bad = (outline: unknown): TextObject | null => objectFromJSON({ ...json, outline }, TIFO_FONTS, PALETTE.length) as TextObject | null;
  ok('a colour outside the palette is dropped', !!bad({ colorIndex: 9, seats: 2 }) && !bad({ colorIndex: 9, seats: 2 })!.outline);
  ok('a silly thickness is dropped', !bad({ colorIndex: 4, seats: 99 })!.outline && !bad({ colorIndex: 4, seats: 0 })!.outline && !bad('x')!.outline);

  const layer = new ObjectLayer();
  layer.load([lined]);
  const snap = layer.snapshot() as TextObject[];
  layer.remapColours([0, 1, 1, 3, 2]);
  ok('a palette remap follows the outline', (layer.get('t1') as TextObject).outline?.colorIndex === 2);
  ok('without writing into an undo snapshot', snap[0].outline?.colorIndex === 4);
}

// ------------------------------------------------------------- parsing ---
{
  const ctx = {
    layers: [
      { id: 't1', kind: 'text' as const, text: 'kings of asia', fontId: font.id },
      { id: 't2', kind: 'text' as const, text: 'الزعيم', fontId: font.id },
      { id: 't3', kind: 'text' as const, text: 'LOCKED', fontId: font.id, locked: true },
      { id: 'i1', kind: 'image' as const },
      { id: 's1', kind: 'shape' as const },
    ],
    paletteLength: 5,
    stands: ['north', 'south'] as ('north' | 'south')[],
  };
  const flat = (o: Record<string, unknown>): Record<string, unknown> => ({
    layer: null, stand: null, text: null, rows: null, color: null, fromColor: null, toColor: null, outlineSeats: null, axis: null, merge: null, ...o,
  });
  const p = (o: Record<string, unknown>): FixOp | null => parseFixOp(flat(o), ctx);
  const yes = (name: string, o: Record<string, unknown>, want: FixOp): void => ok(`parse: ${name}`, JSON.stringify(p(o)) === JSON.stringify(want), JSON.stringify(p(o)));
  const no = (name: string, o: unknown): void => ok(`parse refuses: ${name}`, parseFixOp(o && typeof o === 'object' ? flat(o as Record<string, unknown>) : o, ctx) === null);

  yes('capitals', { type: 'text.setCase', layer: 't1', text: 'KINGS OF ASIA' }, { type: 'text.setCase', layer: 't1', text: 'KINGS OF ASIA' });
  no('other words dressed as a case change', { type: 'text.setCase', layer: 't1', text: 'KINGS OF EUROPE' });
  no('the same text', { type: 'text.setCase', layer: 't1', text: 'kings of asia' });
  no('a case change on Arabic', { type: 'text.setCase', layer: 't2', text: 'الزعيم ' });
  no('a layer that was not sent', { type: 'text.setCase', layer: 't9', text: 'KINGS OF ASIA' });
  no('a locked layer', { type: 'text.setText', layer: 't3', text: 'UNLOCKED' });
  no('text on a picture', { type: 'text.setText', layer: 'i1', text: 'HELLO' });
  yes('new words', { type: 'text.setText', layer: 't1', text: '  KINGS\nOF   ASIA‮ 2026 ' }, { type: 'text.setText', layer: 't1', text: 'KINGS OF ASIA 2026' });
  no('a paragraph', { type: 'text.setText', layer: 't1', text: 'x'.repeat(81) });
  no('empty words', { type: 'text.setText', layer: 't1', text: '   ' });
  yes('a size', { type: 'text.resize', layer: 't1', rows: 14 }, { type: 'text.resize', layer: 't1', rows: 14 });
  no('a size of 1.5 rows', { type: 'text.resize', layer: 't1', rows: 1.5 });
  no('a size of 900 rows', { type: 'text.resize', layer: 't1', rows: 900 });
  yes('an outline in a palette colour', { type: 'text.outline', layer: 't1', color: 4, outlineSeats: 2 }, { type: 'text.outline', layer: 't1', color: 4, seats: 2 });
  yes('an outline in a new colour', { type: 'text.outline', layer: 't1', colorHex: '#0B2A6B', outlineSeats: 3 }, { type: 'text.outline', layer: 't1', color: '#0b2a6b', seats: 3 });
  no('an outline in the empty-seat colour', { type: 'text.outline', layer: 't1', color: 0, outlineSeats: 2 });
  no('an outline in a colour that is not there', { type: 'text.outline', layer: 't1', color: 5, outlineSeats: 2 });
  no('an outline 40 seats thick', { type: 'text.outline', layer: 't1', color: 4, outlineSeats: 40 });
  no('a colour that is not a colour', { type: 'object.recolor', layer: 't1', colorHex: 'javascript:1' });
  yes('a recolour', { type: 'object.recolor', layer: 's1', color: 2 }, { type: 'object.recolor', layer: 's1', color: 2 });
  no('recolouring a picture', { type: 'object.recolor', layer: 'i1', color: 2 });
  yes('into a stand', { type: 'object.fitToStand', layer: 'i1', stand: 'north' }, { type: 'object.fitToStand', layer: 'i1', stand: 'north' });
  no('into a stand with no seats', { type: 'object.fitToStand', layer: 'i1', stand: 'east' });
  yes('centred', { type: 'object.center', layer: 'i1', axis: 'x' }, { type: 'object.center', layer: 'i1', axis: 'x' });
  no('centred on no axis', { type: 'object.center', layer: 'i1', axis: 'z' });
  yes('a repaint in a stand', { type: 'paint.replaceColor', stand: 'north', fromColor: 1, toColor: 3 }, { type: 'paint.replaceColor', stand: 'north', from: 1, to: 3 });
  yes('a repaint everywhere', { type: 'paint.replaceColor', fromColor: 1, toColorHex: '#0b2a6b' }, { type: 'paint.replaceColor', stand: 'all', from: 1, to: '#0b2a6b' });
  no('a repaint to the same colour', { type: 'paint.replaceColor', stand: 'north', fromColor: 1, toColor: 1 });
  no('a repaint that erases', { type: 'paint.replaceColor', stand: 'north', fromColor: 1, toColor: 0 });
  no('a repaint of the empty seats', { type: 'paint.replaceColor', stand: 'north', fromColor: 0, toColor: 1 });
  yes('a merge', { type: 'palette.merge', merge: [{ from: 2, to: 1 }] }, { type: 'palette.merge', merge: [{ from: 2, to: 1 }] });
  no('a merge into the empty seat', { type: 'palette.merge', merge: [{ from: 2, to: 0 }] });
  no('a chain of merges', { type: 'palette.merge', merge: [{ from: 2, to: 1 }, { from: 1, to: 3 }] });
  no('one colour merged twice', { type: 'palette.merge', merge: [{ from: 2, to: 1 }, { from: 2, to: 3 }] });
  no('an empty merge', { type: 'palette.merge', merge: [] });
  no('an operation that does not exist', { type: 'design.replace', layer: 't1' });
  no('not an object', 'text.setCase');
  no('null', null);
}

// ------------------------------------------- applying: layers (no raster) ---
/** A store and a layer stack that share history, without drawing anything. */
function stack(): { store: DesignStore; objects: ObjectLayer; deps: FixDeps } {
  const store = new DesignStore(map, PALETTE);
  const objects = new ObjectLayer();
  objects.recorder = (change) => store.pushObjects(change);
  store.attachLayers({
    route: () => -1, top: () => -1, touch: () => -1,
    strokeBegin: () => {}, strokeEnd: () => null, strokeCancel: () => {},
    restore: (snapshot) => objects.restore(snapshot),
    recompose: (indices) => {
      if (indices === 'all') store.cells.set(store.base);
      else for (let k = 0; k < indices.length; k++) store.cells[indices[k]] = store.base[indices[k]];
    },
    remap: (remap) => objects.remapColours(remap),
  });
  // A stand-in for the browser's measurement: 60 units a letter, 8 a row, the outline's room added.
  const textSize: FixDeps['textSize'] = (t) => {
    if (!t.text.trim()) return null;
    const room = (t.outline?.seats ?? 0) * 2 * EDITOR_UNITS.rowPx;
    return { width: t.text.length * t.heightSeats * 6 + room, height: t.heightSeats * EDITOR_UNITS.rowPx + room };
  };
  return { store, objects, deps: { store, objects, map, textSize } };
}
{
  const { store, objects, deps } = stack();
  const t = objects.addText(textLayer());
  const fresh = (): TextObject => objects.get(t.id) as TextObject;
  const step = store.lastStep;

  const a = applyFix({ type: 'text.setCase', layer: t.id, text: 'KINGS OF ASIA' }, deps);
  ok('capitals are applied', !!a && fresh().text === 'KINGS OF ASIA');
  ok('as one undo step', store.lastStep !== step);
  store.undo();
  ok('Ctrl+Z takes them back', fresh().text === 'kings of asia' && store.lastStep === step);
  store.redo();
  ok('the card takes them back too, exactly', a!.revert() && fresh().text === 'kings of asia' && store.lastStep === step);
  ok('but only once', a!.revert() === false);

  const r = applyFix({ type: 'text.resize', layer: t.id, rows: 20 }, deps);
  ok('a resize sets the rows and the footprint with them', fresh().heightSeats === 20 && fresh().width === 'kings of asia'.length * 20 * 6 && fresh().height === 20 * EDITOR_UNITS.rowPx, `${fresh().width} x ${fresh().height}`);
  ok('the same size again is no fix', applyFix({ type: 'text.resize', layer: t.id, rows: 20 }, deps) === null);

  // A new colour for the outline: the palette grows in the same step.
  const before = store.lastStep;
  const o = applyFix({ type: 'text.outline', layer: t.id, color: '#0b2a6b', seats: 2 }, deps);
  ok('an outline in a new colour adds the colour', store.palette.length === 6 && fresh().outline?.colorIndex === 5 && fresh().outline?.seats === 2);
  ok('and makes room for itself', fresh().height === 20 * EDITOR_UNITS.rowPx + 4 * EDITOR_UNITS.rowPx);
  store.undo();
  ok('one undo takes the outline AND the colour away', store.palette.length === 5 && !fresh().outline && store.lastStep === before);
  store.redo();

  // Something else happens after the fix: its own Undo must not touch that.
  applyFix({ type: 'object.recolor', layer: t.id, color: 4 }, deps);
  ok('a later fix lands', fresh().colorIndex === 4);
  ok('an earlier fix is taken back by itself', o!.revert() && !fresh().outline && fresh().colorIndex === 4 && fresh().heightSeats === 20);
  ok('as a new step', store.canUndo);
  store.undo();
  ok('which undo undoes', fresh().outline?.seats === 2);
  store.undo(); // the recolour
  ok('and the resize is still there to revert', r!.revert() && fresh().heightSeats === 10);

  // A field the person changed since is theirs.
  const c = applyFix({ type: 'object.recolor', layer: t.id, color: 4 }, deps);
  objects.update(t.id, { colorIndex: 1 });
  ok('a fix does not undo what the person did after it', c!.revert() === false && fresh().colorIndex === 1);

  // Gone or locked layers.
  objects.update(t.id, { locked: true });
  ok('a locked layer is left alone', applyFix({ type: 'object.recolor', layer: t.id, color: 3 }, deps) === null && fresh().colorIndex === 1);
  ok('a layer that is gone is no fix', applyFix({ type: 'object.recolor', layer: 't99', color: 3 }, deps) === null);
  objects.update(t.id, { locked: false });

  // Outline off.
  applyFix({ type: 'text.outline', layer: t.id, color: 4, seats: 3 }, deps);
  applyFix({ type: 'text.outline', layer: t.id, color: 4, seats: 0 }, deps);
  ok('0 seats takes an outline off', !fresh().outline);
}

// ----------------------------------------------- applying: where it sits ---
{
  const { objects, deps } = stack();
  const north = regionRect({ stand: 'north', tier: 'all' }, map);
  const south = regionRect({ stand: 'south', tier: 'all' }, map);
  ok('standAt reads the bowl', standAt(north.cx) === 'north' && standAt(south.cx) === 'south' && standAt(5) === 'east' && standAt(W - 5) === 'east' && standAt(W + north.cx) === 'north');

  // A picture half off the end of the north stand.
  const pic = objects.addCells({ cx: north.cx + north.width * 0.48, cy: north.cy + 30, width: 300, height: 90, colorIndex: 0, tier: null, grid: { cols: 2, rows: 2, data: new Int16Array(4).fill(4) }, gridKey: 'c' });
  applyFix({ type: 'object.center', layer: pic.id, axis: 'x' }, deps);
  ok('centre across moves it to the middle of its stand', objects.get(pic.id)!.cx === north.cx && objects.get(pic.id)!.cy === north.cy + 30);
  applyFix({ type: 'object.center', layer: pic.id, axis: 'both' }, deps);
  ok('centre both ways', objects.get(pic.id)!.cy === north.cy);

  // Far too big for the stand: fitted, shrunk in proportion, and kept inside.
  objects.update(pic.id, { width: north.width * 2, height: north.height * 0.5, cx: 100 });
  applyFix({ type: 'object.fitToStand', layer: pic.id, stand: 'south' }, deps);
  const f = objects.get(pic.id)!;
  ok('fit to stand moves it there', f.cx === south.cx && f.cy === south.cy && f.keep?.stand === 'south', `${f.cx} ${south.cx}`);
  ok('and shrinks it to fit, in proportion', Math.abs(f.width - south.width * 0.94) < 0.01 && Math.abs(f.width / f.height - 4 * (north.width / north.height)) < 0.01, `${f.width} x ${f.height}`);

  // Text shrinks its rows with it.
  const t = objects.addText(textLayer({ width: south.width * 2, height: 80, heightSeats: 20 }));
  applyFix({ type: 'object.fitToStand', layer: t.id, stand: 'south' }, deps);
  ok('text fitted to a stand keeps its rows in step', (objects.get(t.id) as TextObject).heightSeats < 20 && (objects.get(t.id) as TextObject).heightSeats >= 9);

  // East sits on the seam: the nearest lap, not a trip across the bowl.
  const e = objects.addCells({ cx: W - 40, cy: north.cy, width: 50, height: 40, colorIndex: 0, tier: null, grid: { cols: 2, rows: 2, data: new Int16Array(4).fill(4) }, gridKey: 'c' });
  applyFix({ type: 'object.center', layer: e.id, axis: 'x' }, deps);
  ok('centring on the east stand stays at the seam', objects.get(e.id)!.cx === W);
  objects.update(e.id, { cx: 30 });
  applyFix({ type: 'object.center', layer: e.id, axis: 'x' }, deps);
  ok('at whichever end it was nearer', objects.get(e.id)!.cx === 0);
}

// ------------------------------------------ applying: seats (real stack) ---
{
  const store = new DesignStore(map, PALETTE);
  const objects = new ObjectLayer();
  const composer = new Composer(map, store, objects, { wrapWidth: W });
  void composer;
  const deps: FixDeps = { store, objects, map, textSize: () => null };
  const inNorth = regionPredicate({ stand: 'north', tier: 'all' }, map);
  let northSeats = 0;
  for (let i = 0; i < map.count; i++) if (inNorth(i)) northSeats++;
  ok('the test bowl has four stands', standsWithSeats(map).length === 4 && northSeats > 1000);
  ok('fixContextOf lists the design', fixContextOf(objects, store, map).paletteLength === 5 && fixContextOf(objects, store, map).stands.length === 4);

  // Light blue everywhere, with bands of a nearly identical blue.
  store.transform((i) => (map.xy[i * 2 + 1] % 40 < 20 ? 1 : 2));
  const ones = count(store.cells, 1);
  const twos = count(store.cells, 2);
  let northOnes = 0;
  for (let i = 0; i < map.count; i++) if (inNorth(i) && store.cells[i] === 1) northOnes++;
  // A layer of colour 2 on top, away from the north stand.
  const south = regionRect({ stand: 'south', tier: 'all' }, map);
  const patch = objects.addCells({ cx: south.cx, cy: south.cy, width: 120, height: 60, colorIndex: 2, tier: null, grid: { cols: 4, rows: 4, data: new Int16Array(16).fill(4) }, gridKey: 'c' });
  const covered = count(store.cells, 4);
  ok('setup: a layer on painted seats', covered > 10 && ones > 0 && twos > 0 && northOnes > 0);

  const step = store.lastStep;
  const navy = applyFix({ type: 'paint.replaceColor', stand: 'north', from: 1, to: '#0b2a6b' }, deps);
  ok('a repaint adds its colour and paints only that stand', !!navy && store.palette[5] === '#0b2a6b' && count(store.cells, 5) === northOnes && count(store.base, 1) === ones - northOnes);
  ok('the layer on top is untouched', count(store.cells, 4) === covered);
  store.undo();
  ok('one undo: the seats and the palette', count(store.cells, 5) === 0 && store.palette.length === 5 && store.lastStep === step);
  store.redo();

  // Paint over a few of the navy seats, then take the fix back by its card.
  const navySeats: number[] = [];
  for (let i = 0; i < map.count && navySeats.length < 50; i++) if (store.base[i] === 5) navySeats.push(i);
  store.beginStroke();
  for (const i of navySeats) store.paint(i, 3);
  store.commitStroke();
  store.flush(navySeats);
  ok('a later brush stroke', count(store.cells, 3) === 50);
  ok('the card takes the repaint back', navy!.revert() === true && count(store.cells, 5) === 0);
  ok('and leaves the brush stroke', count(store.cells, 3) === 50 && count(store.base, 1) === ones - 50);

  // Merge 2 into 1: the paint and the layer's own colour follow.
  const before = store.lastStep;
  const merged = applyFix({ type: 'palette.merge', merge: [{ from: 2, to: 1 }] }, deps);
  ok('a merge repaints the seats', !!merged && count(store.base, 2) === 0 && count(store.base, 1) === ones - 50 + twos);
  ok('and the layers that used the colour', objects.get(patch.id)!.colorIndex === 1);
  ok('and keeps the swatches', store.palette.length === 6);
  ok('as one step', store.lastStep !== before);
  store.undo();
  ok('undone in one', count(store.base, 2) === twos && objects.get(patch.id)!.colorIndex === 2 && store.lastStep === before);
  store.redo();
  store.beginStroke();
  store.paint(navySeats[0], 4);
  store.commitStroke();
  ok('the merge is taken back by its card after other work', merged!.revert() === true && count(store.base, 2) === twos && objects.get(patch.id)!.colorIndex === 2 && store.base[navySeats[0]] === 4);

  ok('a repaint with nothing to repaint is no fix', applyFix({ type: 'paint.replaceColor', stand: 'all', from: 5, to: 1 }, deps) === null);
  ok('a merge with nothing to merge is no fix', applyFix({ type: 'palette.merge', merge: [{ from: 5, to: 1 }] }, deps) === null);
  // The layer's raster is all colour 4: a merge of 4 reaches it though no seat of the paint has it.
  const gridBefore = objects.get(patch.id)!.grid;
  const rasterOnly = applyFix({ type: 'palette.merge', merge: [{ from: 4, to: 3 }] }, deps);
  ok('a merge reaches a colour only a layer shows', !!rasterOnly && count(store.cells, 4) === 0 && objects.get(patch.id)!.grid!.data[0] === 3 && gridBefore!.data[0] === 4);
  store.undo();
  ok('and undo gives the layer its colour back', objects.get(patch.id)!.grid!.data[0] === 4);

  // Locked seats are never painted by a fix.
  const mask = new Uint8Array(map.count);
  let locked = 0;
  for (let i = 0; i < map.count && locked < 200; i++) if (store.base[i] === 1) { mask[i] = 1; locked++; }
  store.setLockedSeats(mask);
  applyFix({ type: 'paint.replaceColor', stand: 'all', from: 1, to: 3 }, deps);
  let leaked = 0;
  for (let i = 0; i < map.count; i++) if (mask[i] && store.cells[i] !== 0) leaked++;
  ok('a fix never paints a locked seat', leaked === 0);
}

console.log(`\nfixops: ${checks - fails} of ${checks} checks passed`);
if (fails) process.exit(1);
