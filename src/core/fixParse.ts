/**
 * Fix operations, the half with no editor in it: what a fix may be, and the
 * check that one a model wrote is something this design has. The server runs
 * it on the critic's answer (server/src/aiReview.ts) and the browser runs it
 * again before applying (core/fixOps.ts), so this file imports nothing that
 * draws, paints or keeps history.
 */
import { isProVoice } from './proVoices';
import { MAX_OUTLINE_SEATS, needsWholeStringShaping } from './text';
import type { Stand } from './tifoSpec';

/** The kinds of layer a design holds (core/objects.ts ObjectKind). */
export type FixLayerKind = 'text' | 'image' | 'shape' | 'cells';

/** A colour a fix names: one already in the palette, or a new one to add to it. */
export type ColorRef = number | string;

export type FixOp =
  /** The same words in capitals (Latin only). */
  | { type: 'text.setCase'; layer: string; text: string }
  /** Other words, asked for in chat. */
  | { type: 'text.setText'; layer: string; text: string }
  /** Letters `rows` seats tall. */
  | { type: 'text.resize'; layer: string; rows: number }
  /** An outline `seats` seats thick in `color`; 0 seats takes it off. */
  | { type: 'text.outline'; layer: string; color: ColorRef; seats: number }
  /** Another colour for a text or shape layer. */
  | { type: 'object.recolor'; layer: string; color: ColorRef }
  /** Into one stand: centred, shrunk if it must be, and kept inside it. */
  | { type: 'object.fitToStand'; layer: string; stand: Stand }
  /** Centred in the stand it is on. */
  | { type: 'object.center'; layer: string; axis: 'x' | 'y' | 'both' }
  /** Every painted seat of one colour, in a stand or the whole bowl, repainted. */
  | { type: 'paint.replaceColor'; stand: Stand | 'all'; from: number; to: ColorRef }
  /** Colours nobody can tell apart from across the ground, made one. */
  | { type: 'palette.merge'; merge: { from: number; to: number }[] };

export type FixOpType = FixOp['type'];
export const FIX_OP_TYPES: FixOpType[] = [
  'text.setCase', 'text.setText', 'text.resize', 'text.outline', 'object.recolor',
  'object.fitToStand', 'object.center', 'paint.replaceColor', 'palette.merge',
];

/** Limits a fix is held to, whatever the model wrote. */
export const FIX_LIMITS = {
  /** Words on a stand: longer than this is a paragraph. */
  textMax: 80,
  rowsMin: 4,
  rowsMax: 160,
  mergeMax: 12,
} as const;

/** What a fix may refer to: the design as it was described to the critic. */
export interface FixContext {
  layers: { id: string; kind: FixLayerKind; text?: string; fontId?: string; locked?: boolean }[];
  paletteLength: number;
  /** The stands that have seats on this ground. */
  stands: Stand[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Words as a layer may hold them: one line, no control characters, trimmed. */
function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= FIX_LIMITS.textMax ? t : null;
}

/**
 * A colour for something drawn: a palette index that exists and is not 0 (the
 * empty seat), or a new #rrggbb. `hex` wins when both are given.
 */
function colorRef(index: unknown, hex: unknown, ctx: FixContext): ColorRef | null {
  if (typeof hex === 'string' && HEX.test(hex)) return hex.toLowerCase();
  if (isInt(index) && index >= 1 && index < ctx.paletteLength) return index;
  return null;
}

/**
 * One operation as the model wrote it, checked against the design, or null.
 *
 * The model's form is flat: a `type` and the fields that type uses (`layer`,
 * `stand`, `text`, `rows`, `color` or `colorHex`, `fromColor`, `toColor` or
 * `toColorHex`, `outlineSeats`, `axis`, `merge`), with null for the rest.
 */
export function parseFixOp(raw: unknown, ctx: FixContext): FixOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !(FIX_OP_TYPES as string[]).includes(type)) return null;

  const layer = typeof r.layer === 'string' ? ctx.layers.find((l) => l.id === r.layer && !l.locked) ?? null : null;
  const stand = typeof r.stand === 'string' && (ctx.stands as string[]).includes(r.stand) ? (r.stand as Stand) : null;

  switch (type as FixOpType) {
    case 'text.setCase': {
      if (!layer || layer.kind !== 'text' || typeof layer.text !== 'string') return null;
      // "Capitals" with no words given means these words, in capitals: a model
      // often names the fix and leaves the text out, since the text does not change.
      const text = r.text === null || r.text === undefined || r.text === '' ? cleanText(layer.text.toUpperCase()) : cleanText(r.text);
      if (!text) return null;
      // The same letters and nothing else: this fix can change case, never words.
      if (text === layer.text.trim() || text.toLowerCase() !== layer.text.trim().toLowerCase()) return null;
      // Arabic has no capitals; a "case" change there is some other change.
      if (needsWholeStringShaping(text)) return null;
      return { type: 'text.setCase', layer: layer.id, text };
    }
    case 'text.setText': {
      const text = cleanText(r.text);
      if (!layer || layer.kind !== 'text' || !text || text === layer.text?.trim()) return null;
      return { type: 'text.setText', layer: layer.id, text };
    }
    case 'text.resize': {
      if (!layer || layer.kind !== 'text' || !isInt(r.rows)) return null;
      if (r.rows < FIX_LIMITS.rowsMin || r.rows > FIX_LIMITS.rowsMax) return null;
      return { type: 'text.resize', layer: layer.id, rows: r.rows };
    }
    case 'text.outline': {
      // A Pro voice is drawn seat by seat and takes no outline (core/objects hasOutline).
      if (!layer || layer.kind !== 'text' || isProVoice(layer.fontId ?? '')) return null;
      if (!isInt(r.outlineSeats) || r.outlineSeats < 0 || r.outlineSeats > MAX_OUTLINE_SEATS) return null;
      const color = colorRef(r.color, r.colorHex, ctx);
      if (color === null) return null;
      return { type: 'text.outline', layer: layer.id, color, seats: r.outlineSeats };
    }
    case 'object.recolor': {
      // A picture's colours are its tones and a moved area's are its seats: neither has one colour to change.
      if (!layer || (layer.kind !== 'text' && layer.kind !== 'shape')) return null;
      const color = colorRef(r.color, r.colorHex, ctx);
      return color === null ? null : { type: 'object.recolor', layer: layer.id, color };
    }
    case 'object.fitToStand':
      return layer && stand ? { type: 'object.fitToStand', layer: layer.id, stand } : null;
    case 'object.center': {
      const axis = r.axis;
      if (!layer || (axis !== 'x' && axis !== 'y' && axis !== 'both')) return null;
      return { type: 'object.center', layer: layer.id, axis };
    }
    case 'paint.replaceColor': {
      const where = r.stand === 'all' || r.stand === null || r.stand === undefined ? 'all' : stand;
      if (!where || !isInt(r.fromColor) || r.fromColor < 1 || r.fromColor >= ctx.paletteLength) return null;
      const to = colorRef(r.toColor, r.toColorHex, ctx);
      if (to === null || to === r.fromColor) return null;
      return { type: 'paint.replaceColor', stand: where, from: r.fromColor, to };
    }
    case 'palette.merge': {
      if (!Array.isArray(r.merge) || r.merge.length === 0 || r.merge.length > FIX_LIMITS.mergeMax) return null;
      const merge: { from: number; to: number }[] = [];
      for (const m of r.merge as unknown[]) {
        const p = m as { from?: unknown; to?: unknown } | null;
        if (!p || !isInt(p.from) || !isInt(p.to)) return null;
        // Never the empty seat, on either side: merging into it would erase.
        if (p.from < 1 || p.to < 1 || p.from >= ctx.paletteLength || p.to >= ctx.paletteLength || p.from === p.to) return null;
        if (merge.some((x) => x.from === p.from)) return null;
        merge.push({ from: p.from, to: p.to });
      }
      // No chains (a into b while b goes into c): each colour ends where it says.
      if (merge.some((m) => merge.some((x) => x.from === m.to))) return null;
      return { type: 'palette.merge', merge };
    }
  }
}
