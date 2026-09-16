import type { LightingSpec, LightingStyle, StadiumTemplate } from '../../core/types';
import { ROOF_DEFAULTS } from './roof';

/**
 * Where a stadium's floodlights go, and how high.
 *
 * Previously every ground got the same four masts at the same hard-coded
 * coordinates, 55 m up, whether the bowl was 128 m across or 256. Real lighting
 * is not a style choice — it is set by two rules that both UEFA and FIFA state,
 * and both are about the ANGLE rather than the height:
 *
 *   - a luminaire must sit at least 25 degrees above the pitch centre. That one
 *     rule is why a corner mast set back behind a deep stand is 40 m tall while
 *     a roof-rim unit only 60 m from the middle needs 28 — the same constraint
 *     at different distances.
 *   - nothing within 15 degrees either side of the goal line, because it dazzles
 *     the goalkeeper. Which is exactly why real corner pylons stand on the
 *     diagonal rather than squared off behind the goal.
 *
 * So the bowl's own size decides everything here. Nothing is a constant except
 * the two angles, and those come from the rulebook.
 */

/** Corner towers: at least this far above the horizontal, seen from the pitch CENTRE. */
const MIN_ELEVATION_DEG = 25;
/** Corner towers: nothing this close to the goal line, either side. */
const GOAL_LINE_EXCLUSION_DEG = 15;
/**
 * Roof-rim arrays: at least this far above the horizontal, seen from the nearest
 * point of the PITCH PERIMETER. A different rule to a different reference point,
 * and getting the two confused is not a detail — applying the centre rule to a
 * rim array demands 57 m on a bowl whose roof is 30 m, so the lamps end up
 * hanging in the sky above the building in a neat dotted arc. Which is exactly
 * what this code did until the wording was checked.
 */
const RIM_MIN_ANGLE_DEG = 20;
/** Half the pitch: the goal line, and the touchline. */
const PITCH_HALF_LENGTH = 52.5;
const PITCH_HALF_WIDTH = 34;

export const LIGHTING_DEFAULTS = {
  style: 'corner-masts' as LightingStyle,
  /** 5700 K: mid-range for the LED installations both bodies now specify. */
  kelvin: 5700,
};

export interface Luminaire {
  /** Where the light sits. */
  pos: [number, number, number];
  /** How wide the bank of lamps is, in metres. */
  width: number;
  /** Is this a lamp on top of a tower that has to be drawn under it? */
  mast: boolean;
}

export interface LightingPlan {
  /** What the template asked for. */
  requested: LightingStyle;
  /** What it got. These differ when a bowl is too low to be lit from its roof. */
  style: LightingStyle;
  kelvin: number;
  luminaires: Luminaire[];
  /** Whether the angle below is measured to the pitch centre or its perimeter. */
  angleRef: 'centre' | 'perimeter';
  /** The shallowest angle any luminaire makes with that reference. */
  minAngleDeg: number;
  /** Set when the requested style could not be built, saying why. */
  note?: string;
}

/** Superellipse point |x/a|^p+|z/b|^p=1 at angle t. */
function se(a: number, b: number, p: number, t: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
}

/**
 * Kelvin to an approximate RGB.
 *
 * Tanner Helland's piecewise fit to the blackbody curve — close enough over
 * 4000-6500 K, which is the whole range stadium lighting lives in. The
 * difference between 4200 K and 5700 K is small on paper and is the difference
 * between a render that looks like 1995 and one that looks like now.
 */
export function kelvinToRgb(k: number): number {
  const t = Math.max(1800, Math.min(12000, k)) / 100;
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}

/** The height that satisfies the 25-degree rule at this distance from the middle. */
export function minMastHeight(distanceFromCentre: number): number {
  return distanceFromCentre * Math.tan((MIN_ELEVATION_DEG * Math.PI) / 180);
}

/** Radial offset of the back of the top tier, and its height. Mirrors stands.ts. */
export function bowlBack(template: StadiumTemplate): { radial: number; y: number } {
  let radial = 0;
  let y = 0;
  for (const tier of template.tiers) {
    const lastRow = Math.max(1, tier.rows - 1);
    const rakeTan = Math.tan((tier.rakeDeg * Math.PI) / 180);
    radial = tier.baseOffset + lastRow * tier.rowDepth + tier.rowDepth * 0.5;
    y = tier.baseElevation + lastRow * tier.rowDepth * rakeTan + tier.rowDepth * rakeTan * 0.5;
  }
  return { radial, y };
}

/** The top of the structure a rim light would ride on — the roof if there is one. */
export function structureTop(template: StadiumTemplate): number {
  const { y } = bowlBack(template);
  const roof = template.roof ?? {};
  if (roof.coverage === 'none') return y;
  return y + (roof.rise ?? ROOF_DEFAULTS.rise);
}

/** Elevation above the horizontal, seen from the pitch centre. */
function centreAngleDeg(pos: [number, number, number]): number {
  return (Math.atan2(pos[1], Math.hypot(pos[0], pos[2])) * 180) / Math.PI;
}

/** Elevation above the horizontal, seen from the NEAREST point of the pitch edge. */
function perimeterAngleDeg(pos: [number, number, number]): number {
  const px = Math.max(-PITCH_HALF_LENGTH, Math.min(PITCH_HALF_LENGTH, pos[0]));
  const pz = Math.max(-PITCH_HALF_WIDTH, Math.min(PITCH_HALF_WIDTH, pos[2]));
  const d = Math.hypot(pos[0] - px, pos[2] - pz);
  return (Math.atan2(pos[1], d) * 180) / Math.PI;
}

/**
 * Lay out this ground's luminaires.
 *
 * Every position is derived from the bowl. A template supplies a style and a
 * colour temperature; it does not supply coordinates, because coordinates that
 * do not follow from the geometry are how the old four-masts-at-122-metres came
 * to hang in mid-air over a small ground and inside the stand of a large one.
 */
export function layOutLights(template: StadiumTemplate): LightingPlan {
  const spec: LightingSpec = template.lighting ?? {};
  const requested = spec.style ?? LIGHTING_DEFAULTS.style;
  const kelvin = spec.kelvin ?? LIGHTING_DEFAULTS.kelvin;
  const { a, b, exponent: p } = template.plan;
  const back = bowlBack(template);
  const top = structureTop(template);

  const masts = (note?: string): LightingPlan => {
    const out: Luminaire[] = [];
    // On the diagonal and clear of the building. The diagonal is also what puts
    // a mast well outside the 15-degree wedge behind each goal, which is the
    // whole reason real pylons stand there rather than squared off at the ends.
    const t = Math.PI / 4;
    const [cx, cz] = se(a, b, p, t);
    const L = Math.hypot(cx, cz) || 1;
    let x = Math.abs(cx + (cx / L) * (back.radial + 14));
    let z = Math.abs(cz + (cz / L) * (back.radial + 14));
    if ((Math.atan2(z, x) * 180) / Math.PI < GOAL_LINE_EXCLUSION_DEG) {
      // A bowl this elongated would put a corner mast inside the dazzle wedge.
      // Swing it round rather than build something no inspector would pass.
      const th = (GOAL_LINE_EXCLUSION_DEG * Math.PI) / 180;
      const r = Math.hypot(x, z);
      x = r * Math.cos(th);
      z = r * Math.sin(th);
    }
    const h = Math.max(top + 8, minMastHeight(Math.hypot(x, z)));
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      out.push({ pos: [sx * x, h, sz * z], width: 11, mast: true });
    }
    return {
      requested,
      style: 'corner-masts',
      kelvin,
      luminaires: out,
      angleRef: 'centre',
      minAngleDeg: Math.min(...out.map((l) => centreAngleDeg(l.pos))),
      ...(note ? { note } : {}),
    };
  };

  if (requested === 'none') {
    return { requested, style: 'none', kelvin, luminaires: [], angleRef: 'centre', minAngleDeg: 0 };
  }
  if (requested === 'corner-masts') return masts();

  // Roof-rim and side-bank arrays are BOLTED TO THE STRUCTURE. Their height is
  // therefore not a free variable — it is wherever the roof is, and the only
  // question is whether that is high enough. Which is the same shape of check
  // as trackFits(): a template may not claim a fitting its geometry cannot hold.
  const y = top + 2.5;
  const N = requested === 'roof-rim' ? 72 : 40;
  const off = back.radial + (template.roof?.overhang ?? ROOF_DEFAULTS.overhang) * 0.4;
  const out: Luminaire[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const [ex, ez] = se(a, b, p, t);
    const L = Math.hypot(ex, ez) || 1;
    const x = ex + (ex / L) * off;
    const z = ez + (ez / L) * off;
    // The two long sides only, which is what a ground with two covered sides
    // and open ends actually has.
    if (requested === 'side-banks' && Math.abs(Math.cos(t)) > 0.62) continue;
    // UEFA's rim guidance wants more than 20 degrees to the pitch edge and puts
    // the optimum at 25-30. Behind the goal the geometry is worst, which is why
    // the guide talks about a second run of luminaires there — a real ground
    // simply leaves that stretch out rather than aiming up at the underside of
    // its own roof.
    if (perimeterAngleDeg([x, y, z]) < RIM_MIN_ANGLE_DEG) continue;
    out.push({ pos: [x, y, z], width: 2.6, mast: false });
  }

  if (out.length < 8) {
    return masts(
      `roof at ${top.toFixed(0)} m is too low for a rim array (needs >${RIM_MIN_ANGLE_DEG} deg to the pitch edge); corner masts instead`,
    );
  }
  return {
    requested,
    style: requested,
    kelvin,
    luminaires: out,
    angleRef: 'perimeter',
    minAngleDeg: Math.min(...out.map((l) => perimeterAngleDeg(l.pos))),
  };
}
