import type { AisleRun, SeatOpening, StadiumTemplate, StandSide, TierSpec } from './types';
import { arcAtIndex, cornerStation, rhythm, stationIndex } from './blocks';
import { buildOffsetCurve, samplePlanCurve } from './planCurve';

/**
 * Grounds rebuilt in their real blocks (TierSpec.blocks), and the bookkeeping
 * that comes with it, in one place.
 *
 * A real layout moves seats, and a saved design is one byte per seat indexed
 * by position, so a ground that gains its real blocks is a new template id and
 * the old one stays, byte-identical, for the designs saved on it. Until this
 * file that meant writing out the old template a second time in the legacy
 * list, and hunting down every place that recognised the ground by its id.
 *
 * Now a rebuild is one entry: the old id, the new id, and how the new template
 * is made from the old one. The catalogue (stadiumCatalog.realLayouts) puts the
 * new entry where the old one was and moves the old one, unchanged, to the
 * legacy list with `supersededBy`, so the stadium panel offers to move a design
 * across. Anything that draws a ground specially (the Jewel's lattice, Kingdom
 * Arena's hall) asks `baseGroundId`, so the new layout is drawn exactly as the
 * old one was.
 */
export interface RealBlocksLayout {
  /** The new template id. */
  id: string;
  /** The new template, built from the old one (which must not be changed). */
  build: (old: StadiumTemplate) => StadiumTemplate;
  /** The published capacity, if the rebuild settles a different figure. */
  capacity?: number;
}

const REGISTRY = new Map<string, RealBlocksLayout>();
/** New id → the id of the ground it is a layout of. */
const BASE = new Map<string, string>();

/** Register rebuilt grounds, by the id each replaces. */
export function registerRealBlocks(layouts: Record<string, RealBlocksLayout>): void {
  for (const [oldId, l] of Object.entries(layouts)) {
    REGISTRY.set(oldId, l);
    BASE.set(l.id, BASE.get(oldId) ?? oldId);
  }
}

/** The rebuild of a ground, by the id it replaces. */
export function realBlocksFor(oldId: string): RealBlocksLayout | undefined {
  return REGISTRY.get(oldId);
}

/**
 * The id a ground was first shipped under: the same for every layout of it.
 * For drawing a ground specially — a later layout is the same building.
 */
export function baseGroundId(id: string): string {
  return BASE.get(id) ?? id;
}

/**
 * The new template for a rebuild: the old one with a new id and the given
 * tiers. A helper so a layout reads as what it changes.
 */
export function rebuilt(old: StadiumTemplate, id: string, change: (t: StadiumTemplate) => Partial<StadiumTemplate>): StadiumTemplate {
  const copy: StadiumTemplate = JSON.parse(JSON.stringify(old));
  return { ...copy, ...change(copy), id, version: 1 };
}

/**
 * A tier's stairways laid out on a regular rhythm, as a modern bowl is: every
 * `step` metres from each side's centre line (a block on the centre line, or a
 * stairway on it — `centred`), the long sides and the ends each with their own
 * step and phase if they differ, out to the corner.
 *
 * Towards a corner the bowl turns, so a block that is 22 seats across its front
 * row opens out behind; a real corner has more stairways than the straight to
 * keep every row of a block within the rule-book's 28 seats between two
 * stairs. So any block whose back row comes out wider than `maxBack` metres
 * (default 15: 28 seats at half a metre, and a stair) is split by stairs
 * spaced evenly along its front row.
 */
export function ringStairs(
  t: StadiumTemplate,
  tier: TierSpec,
  o: { step: number; centred: boolean; endStep?: number; endCentred?: boolean; maxBack?: number; rows?: [number, number]; sides?: StandSide[] },
): AisleRun[] {
  const sides = o.sides ?? ['north', 'south', 'east', 'west'];
  const endStep = o.endStep ?? o.step;
  const endCentred = o.endCentred ?? o.centred;
  const maxBack = o.maxBack ?? 15;
  const longCorner = cornerStation(t, tier, 'north');
  const endCorner = cornerStation(t, tier, 'east');
  const Q = longCorner + endCorner;
  const longAt = rhythm(o.step, o.centred, longCorner - 0.5);
  const endAt = rhythm(endStep, endCentred, endCorner - 0.5);
  const curve = samplePlanCurve(t.plan.a, t.plan.b, t.plan.exponent);
  const front = buildOffsetCurve(curve, tier.baseOffset);
  const lastRow = o.rows ? o.rows[1] : tier.rows - 1;
  const back = buildOffsetCurve(curve, tier.baseOffset + lastRow * tier.rowDepth);
  // One quadrant, from the long side's centre line round to the end's, in
  // stations of the long side carried on round the corner.
  const backWidth = (p: number, q: number): number => {
    const d = Math.abs(arcAtIndex(back, stationIndex(front, 'north', q)) - arcAtIndex(back, stationIndex(front, 'north', p)));
    // The end's centre line is the seam of the curve (u = 0): measure the short way round.
    return Math.min(d, back.total - d);
  };
  const pos = [...longAt, ...endAt.map((e) => Q - e)].sort((a, b) => a - b);
  // The blocks either side of the centre lines are halves of a symmetric pair.
  const ends = [o.centred ? -longAt[0] : 0, ...pos, endCentred ? Q + endAt[0] : Q];
  const add: number[] = [];
  for (let k = 0; k + 1 < ends.length; k++) {
    const p = ends[k];
    const q = ends[k + 1];
    const w = backWidth(Math.max(0, p), Math.min(Q, q)) + (p < 0 ? backWidth(0, -p) : 0) + (q > Q ? backWidth(Q - (q - Q), Q) : 0);
    const n = Math.ceil(w / maxBack) - 1;
    for (let j = 1; j <= n; j++) {
      const x = p + ((q - p) * j) / (n + 1);
      if (x > 0 && x < Q) add.push(Math.round(x * 100) / 100);
    }
  }
  const longAll = [...longAt, ...add.filter((x) => x <= longCorner)].sort((a, b) => a - b);
  const endAll = [...endAt, ...add.filter((x) => x > longCorner).map((x) => Math.round((Q - x) * 100) / 100)].sort((a, b) => a - b);
  const runs: AisleRun[] = [];
  for (const side of sides) {
    const long = side === 'north' || side === 'south';
    runs.push({ side, at: long ? longAll : endAll, mirror: true, ...(o.rows ? { rows: o.rows } : {}) });
  }
  return runs;
}

/**
 * Where a tier's front row turns the corner, as a station on an end
 * (east or west): measured from the long side's corner the short way round,
 * so a run along an end that stops here meets a run along the long side
 * (which stops at its own corner station) at exactly the same point — not a
 * hair before or after it, where a seat would fall in both or neither.
 */
export function endCornerStation(t: StadiumTemplate, tier: TierSpec): number {
  const front = buildOffsetCurve(samplePlanCurve(t.plan.a, t.plan.b, t.plan.exponent), tier.baseOffset);
  return front.total / 4 - cornerStation(t, tier, 'north');
}

/** Openings at every stairway of a set of runs (a vomitory at the foot of each stair, say). */
export function atStairs(runs: AisleRun[], o: Omit<SeatOpening, 'side' | 'at' | 'mirror'>, skip: (side: StandSide, at: number) => boolean = () => false): SeatOpening[] {
  return runs.map((r) => ({ side: r.side, at: r.at.filter((a) => !skip(r.side, a)), mirror: r.mirror, ...o })).filter((x) => x.at.length > 0);
}
