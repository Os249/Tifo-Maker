/**
 * Deterministic design critique + repair (Super AI Phase 4a).
 *
 * After a spec is compiled to seats, this inspects the ACTUAL rendered result
 * and reports concrete, actionable problems — fine detail that won't survive the
 * ~10% no-show rate (via findFragileSeats), and intended stands that came out
 * empty/sparse in a multi-stand composition. `repairSpec` then makes one bounded,
 * safe adjustment (enlarge fragile text/symbols) so the caller can recompile.
 *
 * This is the "critique legibility/balance + integrate the fragile-seat estimate"
 * half of Phase 4. It is pure and DOM-free (runs in the browser, server, tests).
 * A future Phase 4b adds a vision-model pass on a render of the bowl.
 */

import type { SeatMap } from './types';
import { findFragileSeats } from './analysis';
import { STAND_ORDER, standIndexOfU, type Stand, type TifoSpec } from './tifoSpec';

export interface DesignCritique {
  /** 0..100 overall legibility/balance score (100 = clean). */
  score: number;
  /** Concrete, human-readable problems, most important first. */
  issues: string[];
  /** Painted seats sitting in sub-threshold (likely-illegible) strokes. */
  fragileSeats: number;
  /** Total non-empty seats. */
  paintedSeats: number;
  /** Fill ratio (0..1) per stand. */
  perStandFill: Record<Stand, number>;
}

const FRAGILE_RATIO_WARN = 0.2; // >20% of paint in thin strokes → flag + repairable
const EMPTY_FILL = 0.03; // an intended stand under 3% filled reads as empty

/** Stands the spec means to cover (background ⇒ all; else union of layer regions). */
function intendedStands(spec: TifoSpec): Set<Stand> {
  const set = new Set<Stand>();
  const all = (): void => STAND_ORDER.forEach((s) => set.add(s));
  if (spec.background !== undefined && spec.background !== null) all();
  for (const layer of spec.layers) {
    const r = layer.region;
    if (r.stands && r.stands.length > 0) r.stands.forEach((s) => set.add(s));
    else if (r.stand === 'all') all();
    else set.add(r.stand);
  }
  return set;
}

/** Inspect compiled seats against the spec and report concrete problems. */
export function critiqueDesign(cells: Uint8Array, map: SeatMap, spec: TifoSpec): DesignCritique {
  const fragileSeats = findFragileSeats(cells, map).length;

  const totals = [0, 0, 0, 0];
  const painted = [0, 0, 0, 0];
  let paintedSeats = 0;
  for (let i = 0; i < map.count; i++) {
    const si = ((standIndexOfU(map.uv[i * 2]) % 4) + 4) % 4;
    totals[si]++;
    if (cells[i] !== 0) {
      painted[si]++;
      paintedSeats++;
    }
  }
  const perStandFill = {} as Record<Stand, number>;
  STAND_ORDER.forEach((s, i) => {
    perStandFill[s] = totals[i] ? painted[i] / totals[i] : 0;
  });

  const issues: string[] = [];
  const fragileRatio = paintedSeats ? fragileSeats / paintedSeats : 0;
  if (fragileRatio > FRAGILE_RATIO_WARN) {
    issues.push(
      `Fine detail may not read at stadium scale (${Math.round(fragileRatio * 100)}% of painted seats sit in thin strokes) — enlarge text/symbols.`,
    );
  }

  const intended = intendedStands(spec);
  const emptyStands = STAND_ORDER.filter((s) => intended.has(s) && perStandFill[s] < EMPTY_FILL);
  for (const s of emptyStands) {
    issues.push(`The ${s} stand is nearly empty — give it a focal element or colour field.`);
  }

  let score = 100;
  score -= Math.round(Math.min(1, fragileRatio) * 60);
  score -= emptyStands.length * 12;
  score = Math.max(0, Math.min(100, score));

  return { score, issues, fragileSeats, paintedSeats, perStandFill };
}

const TEXT_BUMP = 0.12;
const SYMBOL_BUMP = 0.12;

/**
 * One bounded, safe repair: when fine detail is fragile, enlarge every text and
 * symbol layer (thicker glyphs survive no-shows). Returns a NEW spec and whether
 * anything changed, so the caller recompiles only when it will help. Pure.
 */
export function repairSpec(spec: TifoSpec, critique: DesignCritique): { spec: TifoSpec; changed: boolean } {
  const fragile = critique.paintedSeats > 0 && critique.fragileSeats / critique.paintedSeats > FRAGILE_RATIO_WARN;
  if (!fragile) return { spec, changed: false };

  let changed = false;
  const layers = spec.layers.map((layer) => {
    if (layer.kind === 'text' && layer.heightFrac < 1) {
      changed = true;
      return { ...layer, heightFrac: Math.min(1, layer.heightFrac + TEXT_BUMP) };
    }
    if (layer.kind === 'symbol' && layer.scaleFrac < 1) {
      changed = true;
      return { ...layer, scaleFrac: Math.min(1, layer.scaleFrac + SYMBOL_BUMP) };
    }
    return layer;
  });

  return changed ? { spec: { ...spec, layers }, changed: true } : { spec, changed: false };
}
