/**
 * The .tifo file format — the public, LLM-authorable interchange schema.
 *
 * v2 carries layers, floating objects (text/image), metadata, and explicit
 * versioning, serializing what the editor already models so import is lossless.
 * v1 (flat template+palette+cells) remains accepted and migrates forward.
 *
 * This module is framework-free and DOM-free: it runs identically in the
 * browser, in the server's /api/tifo/validate endpoint, and in tests — so a
 * generator's "validate before deliver" loop and the real import share one
 * source of truth. That shared truth is what lets an LLM hit 100% data
 * integrity: anything validate() accepts, import accepts.
 */

export const TIFO_SCHEMA_VERSION = 2 as const;

// ---- schema types ----

export interface TifoMeta {
  title?: string;
  author?: string;
  createdAt?: string;
  generator?: string; // e.g. "claude-opus-4.8" — provenance, optional
  description?: string;
}

/** Run-length pair: [paletteIndex, count]. */
export type Rle = [number, number];

export interface TifoLayer {
  id: string;
  name?: string;
  kind: 'cells';
  visible?: boolean;
  /** RLE over palette indices in generator seat order; sums to the seat count. */
  cellsRle: Rle[];
}

export interface TifoTextObject {
  id: string;
  kind: 'text';
  text: string;
  fontId: string;
  arcDeg?: number;
  colorIndex: number;
  tier?: number | null;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface TifoImageObject {
  id: string;
  kind: 'image';
  /** Asset reference inside a .tifo zip container, or a data URL. */
  assetRef: string;
  colorIndex?: number;
  tier?: number | null;
  cx: number;
  cy: number;
  width: number;
  height: number;
  dither?: boolean;
  realColors?: boolean;
}

export type TifoObject = TifoTextObject | TifoImageObject;

export interface TifoDocV2 {
  format: 'tifo';
  schemaVersion: 2;
  meta?: TifoMeta;
  stadium: { templateId: string; templateVersion: number };
  /** Index 0 is the empty seat. 2–8 entries. */
  palette: string[];
  layers: TifoLayer[];
  objects?: TifoObject[];
}

// ---- validation ----

export interface ValidationError {
  /** JSON path to the offending field, e.g. "layers[0].cellsRle". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Present when valid: the normalized v2 document (v1 inputs are migrated). */
  doc?: TifoDocV2;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_LAYERS = 16;
const MAX_OBJECTS = 64;
const MAX_TEXT_LEN = 200;
const MAX_RLE_RUNS = 200_000; // generous; a 76k bowl fully alternating is ~76k

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed .tifo document against a known stadium seat count.
 * Strict and all-or-nothing: returns every problem (so a generator can fix them
 * all at once) and, on success, a normalized v2 document. v1 inputs migrate.
 *
 * `seatCountFor(templateId, version)` returns the expected cell count for a
 * known template, or null if the template is unknown.
 */
export function validateTifo(
  input: unknown,
  seatCountFor: (templateId: string, version: number) => number | null,
): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  if (!isObj(input)) {
    return { valid: false, errors: [{ path: '', message: 'document must be a JSON object' }] };
  }

  // Migrate v1 → v2 shape first, then validate uniformly.
  const fmt = input.format;
  let doc: Record<string, unknown>;
  if (fmt === 'tifo-v1') {
    const migrated = migrateV1(input);
    if ('error' in migrated) {
      return { valid: false, errors: [{ path: '', message: migrated.error }] };
    }
    doc = migrated.doc as unknown as Record<string, unknown>;
  } else if (fmt === 'tifo') {
    doc = input;
  } else {
    return { valid: false, errors: [{ path: 'format', message: 'format must be "tifo" (or legacy "tifo-v1")' }] };
  }

  if (doc.schemaVersion !== TIFO_SCHEMA_VERSION) {
    err('schemaVersion', `schemaVersion must be ${TIFO_SCHEMA_VERSION}`);
  }

  // stadium
  let seatCount: number | null = null;
  if (!isObj(doc.stadium)) {
    err('stadium', 'stadium is required ({ templateId, templateVersion })');
  } else {
    const { templateId, templateVersion } = doc.stadium as Record<string, unknown>;
    if (typeof templateId !== 'string') err('stadium.templateId', 'templateId must be a string');
    else if (typeof templateVersion !== 'number') err('stadium.templateVersion', 'templateVersion must be a number');
    else {
      seatCount = seatCountFor(templateId, templateVersion);
      if (seatCount === null) err('stadium.templateId', `unknown stadium "${templateId}" v${templateVersion}`);
    }
  }

  // palette
  const palette = doc.palette;
  if (!Array.isArray(palette)) {
    err('palette', 'palette must be an array of hex colors');
  } else {
    if (palette.length < 2) err('palette', 'palette needs at least 2 colors (index 0 = empty seat)');
    if (palette.length > 256) err('palette', 'palette may have at most 256 colors');
    palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX.test(c)) err(`palette[${i}]`, `"${String(c)}" is not a #rrggbb hex color`);
    });
  }
  const paletteLen = Array.isArray(palette) ? palette.length : 0;

  // layers
  const layers = doc.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    err('layers', 'layers must be a non-empty array (at least one "cells" layer)');
  } else {
    if (layers.length > MAX_LAYERS) err('layers', `at most ${MAX_LAYERS} layers`);
    layers.forEach((layer, li) => {
      const p = `layers[${li}]`;
      if (!isObj(layer)) {
        err(p, 'layer must be an object');
        return;
      }
      if (layer.kind !== 'cells') err(`${p}.kind`, 'only "cells" layers are supported');
      if (typeof layer.id !== 'string') err(`${p}.id`, 'id must be a string');
      const rle = layer.cellsRle;
      if (!Array.isArray(rle)) {
        err(`${p}.cellsRle`, 'cellsRle must be an array of [index, count] pairs');
        return;
      }
      if (rle.length > MAX_RLE_RUNS) err(`${p}.cellsRle`, `too many runs (max ${MAX_RLE_RUNS})`);
      let total = 0;
      for (let r = 0; r < rle.length; r++) {
        const run = rle[r];
        if (!Array.isArray(run) || run.length !== 2 || typeof run[0] !== 'number' || typeof run[1] !== 'number') {
          err(`${p}.cellsRle[${r}]`, 'each run must be [index, count]');
          return;
        }
        const [idx, count] = run;
        if (!Number.isInteger(idx) || idx < 0 || (paletteLen && idx >= paletteLen)) {
          err(`${p}.cellsRle[${r}]`, `index ${idx} out of palette range 0..${paletteLen - 1}`);
          return;
        }
        if (!Number.isInteger(count) || count <= 0) {
          err(`${p}.cellsRle[${r}]`, `count must be a positive integer (got ${count})`);
          return;
        }
        total += count;
      }
      if (seatCount !== null && total !== seatCount) {
        err(`${p}.cellsRle`, `runs sum to ${total} seats but stadium has ${seatCount}`);
      }
    });
  }

  // objects (optional)
  const objects = doc.objects;
  if (objects !== undefined) {
    if (!Array.isArray(objects)) {
      err('objects', 'objects must be an array');
    } else {
      if (objects.length > MAX_OBJECTS) err('objects', `at most ${MAX_OBJECTS} objects`);
      objects.forEach((o, oi) => validateObject(o, `objects[${oi}]`, paletteLen, err));
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  // Normalize 3-digit hex to 6-digit so downstream always sees #rrggbb.
  const normDoc = doc as unknown as TifoDocV2;
  normDoc.palette = normDoc.palette.map(expandHex);
  return { valid: true, errors: [], doc: normDoc };
}

/** #abc → #aabbcc; passes #rrggbb through unchanged. */
function expandHex(hex: string): string {
  if (hex.length === 4) {
    return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex;
}

function validateObject(
  o: unknown,
  p: string,
  paletteLen: number,
  err: (path: string, message: string) => void,
): void {
  if (!isObj(o)) {
    err(p, 'object must be an object');
    return;
  }
  if (typeof o.id !== 'string') err(`${p}.id`, 'id must be a string');
  for (const f of ['cx', 'cy', 'width', 'height'] as const) {
    if (typeof o[f] !== 'number' || !Number.isFinite(o[f] as number)) err(`${p}.${f}`, `${f} must be a finite number`);
  }
  if (o.tier !== undefined && o.tier !== null && !Number.isInteger(o.tier)) {
    err(`${p}.tier`, 'tier must be an integer or null');
  }
  if (o.kind === 'text') {
    if (typeof o.text !== 'string' || o.text.length === 0) err(`${p}.text`, 'text is required');
    else if (o.text.length > MAX_TEXT_LEN) err(`${p}.text`, `text too long (max ${MAX_TEXT_LEN})`);
    if (typeof o.fontId !== 'string') err(`${p}.fontId`, 'fontId must be a string');
    if (typeof o.colorIndex !== 'number' || !Number.isInteger(o.colorIndex) || o.colorIndex < 0 || (paletteLen && o.colorIndex >= paletteLen)) {
      err(`${p}.colorIndex`, `colorIndex out of palette range 0..${paletteLen - 1}`);
    }
    if (o.arcDeg !== undefined && (typeof o.arcDeg !== 'number' || o.arcDeg < -170 || o.arcDeg > 170)) {
      err(`${p}.arcDeg`, 'arcDeg must be between -170 and 170');
    }
  } else if (o.kind === 'image') {
    if (typeof o.assetRef !== 'string' || o.assetRef.length === 0) err(`${p}.assetRef`, 'assetRef is required');
  } else {
    err(`${p}.kind`, 'kind must be "text" or "image"');
  }
}

// ---- RLE codec ----

/** Encode a cell buffer to run-length pairs. */
export function encodeCellsRle(cells: Uint8Array | number[]): Rle[] {
  const out: Rle[] = [];
  if (cells.length === 0) return out;
  let cur = cells[0];
  let run = 1;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] === cur) {
      run++;
    } else {
      out.push([cur, run]);
      cur = cells[i];
      run = 1;
    }
  }
  out.push([cur, run]);
  return out;
}

/** Decode run-length pairs back to a flat Uint8Array. */
export function decodeCellsRle(rle: Rle[]): Uint8Array {
  let total = 0;
  for (const [, count] of rle) total += count;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const [idx, count] of rle) {
    out.fill(idx, pos, pos + count);
    pos += count;
  }
  return out;
}

// ---- v1 → v2 migration ----

/** Wrap a legacy v1 doc (flat cells) as a single-layer v2 doc. */
export function migrateV1(v1: Record<string, unknown>): { doc: TifoDocV2 } | { error: string } {
  if (!Array.isArray(v1.cells) || !Array.isArray(v1.palette) || typeof v1.templateId !== 'string') {
    return { error: 'legacy tifo-v1 file is missing cells, palette, or templateId' };
  }
  return {
    doc: {
      format: 'tifo',
      schemaVersion: 2,
      meta: typeof v1.title === 'string' ? { title: v1.title } : undefined,
      stadium: {
        templateId: v1.templateId,
        templateVersion: typeof v1.templateVersion === 'number' ? v1.templateVersion : 1,
      },
      palette: v1.palette as string[],
      layers: [{ id: 'base', kind: 'cells', cellsRle: encodeCellsRle(v1.cells as number[]) }],
    },
  };
}

/** Compose a v2 document from editor state (for export). */
export function buildTifoV2(args: {
  title?: string;
  generator?: string;
  templateId: string;
  templateVersion: number;
  palette: string[];
  cells: Uint8Array;
  objects?: TifoObject[];
}): TifoDocV2 {
  return {
    format: 'tifo',
    schemaVersion: 2,
    meta: {
      title: args.title,
      generator: args.generator,
      createdAt: new Date().toISOString(),
    },
    stadium: { templateId: args.templateId, templateVersion: args.templateVersion },
    palette: args.palette,
    layers: [{ id: 'base', kind: 'cells', cellsRle: encodeCellsRle(args.cells) }],
    objects: args.objects && args.objects.length > 0 ? args.objects : undefined,
  };
}

/** Flatten a validated v2 doc's layers into a single cell buffer (for the editor). */
export function flattenLayers(doc: TifoDocV2): Uint8Array {
  // Single base layer is the common case; if multiple, later visible layers
  // paint over earlier ones where their index is non-zero (0 = transparent/empty).
  const base = decodeCellsRle(doc.layers[0].cellsRle);
  for (let li = 1; li < doc.layers.length; li++) {
    const layer = doc.layers[li];
    if (layer.visible === false) continue;
    const cells = decodeCellsRle(layer.cellsRle);
    for (let i = 0; i < base.length && i < cells.length; i++) {
      if (cells[i] !== 0) base[i] = cells[i];
    }
  }
  return base;
}
