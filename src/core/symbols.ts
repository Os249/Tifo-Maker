/**
 * Vector symbol library for the AI Tifo Designer.
 *
 * Each drawer paints a bold, single-colour silhouette (white on transparent)
 * into a square canvas. The compiler then runs it through maskFromAlpha →
 * applyGridToSeats, the exact path the Text tool uses — so a symbol becomes
 * seats with no new rendering code. Shapes are intentionally chunky: anything
 * thinner than a few seats dies under the real-world ~10% no-show rate, so
 * fine detail (photographic faces, club crests) is deliberately out of scope —
 * this is mosaic iconography, not an image generator.
 *
 * Keep this list in lockstep with SYMBOL_NAMES in tifoSpec.ts.
 */

import type { SymbolName } from './tifoSpec';

/**
 * Shapes offered by the Shapes tool. A superset of a few geometric primitives
 * (rect/ellipse/line, drawn to fill the object's box) plus the bold symbols
 * above. Every entry is a valid `drawSymbol` name.
 */
export const SHAPE_NAMES = [
  'rect', 'ellipse', 'circle', 'triangle', 'diamond', 'line',
  'star', 'star6', 'heart', 'crown', 'shield', 'ring', 'cross', 'chevron', 'bolt', 'flame',
] as const;
export type ShapeName = (typeof SHAPE_NAMES)[number];

/** Default width:height ratio for a freshly placed shape (most are square). */
export const SHAPE_ASPECT: Record<string, number> = { line: 4, rect: 1.6 };

type Pt = [number, number];

/** Map unit coordinates in [-0.5,0.5]² to the padded box and fill a polygon. */
function fillUnit(ctx: CanvasRenderingContext2D, w: number, h: number, pts: Pt[], margin = 0.08): void {
  const s = Math.min(w, h) * (1 - 2 * margin);
  const cx = w / 2;
  const cy = h / 2;
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const X = cx + x * s;
    const Y = cy + y * s;
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
}

/** N-point star as unit polygon points. */
function starPoints(n: number, rOuter: number, rInner: number, rot = -Math.PI / 2): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / n;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

function circle(ctx: CanvasRenderingContext2D, w: number, h: number, r: number): void {
  const s = Math.min(w, h) * 0.84;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r * s, 0, Math.PI * 2);
  ctx.fill();
}

/** Filled outer disc minus an inner disc (a ring / annulus), via even-odd. */
function annulus(ctx: CanvasRenderingContext2D, w: number, h: number, rOut: number, rIn: number): void {
  const s = Math.min(w, h) * 0.84;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, rOut * s, 0, Math.PI * 2);
  ctx.arc(w / 2, h / 2, rIn * s, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
}

/**
 * Draw `name` filling a w×h canvas in the current fillStyle. Returns true if a
 * shape was drawn (always true for known names; unknown names fall back to a disc).
 */
export function drawSymbol(ctx: CanvasRenderingContext2D, name: SymbolName | string, w: number, h: number): boolean {
  switch (name) {
    case 'star':
      fillUnit(ctx, w, h, starPoints(5, 0.5, 0.21));
      return true;
    case 'star6':
      // hexagram: two overlapping triangles.
      fillUnit(ctx, w, h, [[0, -0.5], [0.43, 0.25], [-0.43, 0.25]]);
      fillUnit(ctx, w, h, [[0, 0.5], [0.43, -0.25], [-0.43, -0.25]]);
      return true;
    case 'circle':
    case 'disc':
      circle(ctx, w, h, 0.5);
      return true;
    case 'ring':
      annulus(ctx, w, h, 0.5, 0.31);
      return true;
    case 'diamond':
      fillUnit(ctx, w, h, [[0, -0.5], [0.4, 0], [0, 0.5], [-0.4, 0]]);
      return true;
    case 'triangle':
      fillUnit(ctx, w, h, [[0, -0.46], [0.5, 0.42], [-0.5, 0.42]]);
      return true;
    case 'square':
      fillUnit(ctx, w, h, [[-0.42, -0.42], [0.42, -0.42], [0.42, 0.42], [-0.42, 0.42]]);
      return true;
    case 'chevron':
      // bold downward chevron (V).
      fillUnit(ctx, w, h, [
        [-0.5, -0.34], [0, 0.16], [0.5, -0.34], [0.5, -0.02], [0, 0.5], [-0.5, -0.02],
      ]);
      return true;
    case 'cross':
      // Latin cross (tall).
      fillUnit(ctx, w, h, [
        [-0.13, -0.5], [0.13, -0.5], [0.13, -0.16], [0.42, -0.16], [0.42, 0.1],
        [0.13, 0.1], [0.13, 0.5], [-0.13, 0.5], [-0.13, 0.1], [-0.42, 0.1], [-0.42, -0.16], [-0.13, -0.16],
      ]);
      return true;
    case 'plus':
      // Greek/medical equal cross.
      fillUnit(ctx, w, h, [
        [-0.17, -0.5], [0.17, -0.5], [0.17, -0.17], [0.5, -0.17], [0.5, 0.17], [0.17, 0.17],
        [0.17, 0.5], [-0.17, 0.5], [-0.17, 0.17], [-0.5, 0.17], [-0.5, -0.17], [-0.17, -0.17],
      ]);
      return true;
    case 'heart': {
      const s = Math.min(w, h) * 0.84;
      const cx = w / 2;
      const cy = h / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 0.4 * s);
      ctx.bezierCurveTo(cx - 0.62 * s, cy - 0.05 * s, cx - 0.32 * s, cy - 0.52 * s, cx, cy - 0.18 * s);
      ctx.bezierCurveTo(cx + 0.32 * s, cy - 0.52 * s, cx + 0.62 * s, cy - 0.05 * s, cx, cy + 0.4 * s);
      ctx.closePath();
      ctx.fill();
      return true;
    }
    case 'crown':
      // five-point crown sitting on a band.
      fillUnit(ctx, w, h, [
        [-0.5, -0.18], [-0.28, 0.06], [-0.16, -0.34], [0, 0.04], [0.16, -0.34], [0.28, 0.06], [0.5, -0.18],
        [0.5, 0.34], [-0.5, 0.34],
      ]);
      return true;
    case 'shield': {
      const s = Math.min(w, h) * 0.84;
      const cx = w / 2;
      const cy = h / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 0.42 * s, cy - 0.44 * s);
      ctx.lineTo(cx + 0.42 * s, cy - 0.44 * s);
      ctx.lineTo(cx + 0.42 * s, cy + 0.04 * s);
      ctx.bezierCurveTo(cx + 0.42 * s, cy + 0.4 * s, cx + 0.2 * s, cy + 0.5 * s, cx, cy + 0.52 * s);
      ctx.bezierCurveTo(cx - 0.2 * s, cy + 0.5 * s, cx - 0.42 * s, cy + 0.4 * s, cx - 0.42 * s, cy + 0.04 * s);
      ctx.closePath();
      ctx.fill();
      return true;
    }
    case 'bolt':
      fillUnit(ctx, w, h, [
        [0.12, -0.5], [-0.28, 0.08], [-0.02, 0.08], [-0.14, 0.5], [0.3, -0.12], [0.03, -0.12],
      ]);
      return true;
    case 'flame': {
      const s = Math.min(w, h) * 0.84;
      const cx = w / 2;
      const cy = h / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 0.5 * s);
      ctx.bezierCurveTo(cx + 0.42 * s, cy - 0.1 * s, cx + 0.34 * s, cy + 0.5 * s, cx, cy + 0.5 * s);
      ctx.bezierCurveTo(cx - 0.34 * s, cy + 0.5 * s, cx - 0.42 * s, cy - 0.02 * s, cx - 0.04 * s, cy - 0.18 * s);
      ctx.bezierCurveTo(cx - 0.16 * s, cy + 0.02 * s, cx + 0.06 * s, cy - 0.18 * s, cx, cy - 0.5 * s);
      ctx.closePath();
      ctx.fill();
      return true;
    }
    case 'anchor': {
      const s = Math.min(w, h) * 0.84;
      const cx = w / 2;
      const cy = h / 2;
      const lw = 0.12 * s;
      // ring
      ctx.beginPath();
      ctx.arc(cx, cy - 0.4 * s, 0.12 * s, 0, Math.PI * 2);
      ctx.arc(cx, cy - 0.4 * s, 0.05 * s, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      // shaft
      ctx.fillRect(cx - lw / 2, cy - 0.3 * s, lw, 0.78 * s);
      // crossbar
      ctx.fillRect(cx - 0.26 * s, cy - 0.14 * s, 0.52 * s, lw);
      // bottom arc (flukes)
      ctx.beginPath();
      ctx.arc(cx, cy + 0.18 * s, 0.36 * s, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.lineWidth = lw;
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.stroke();
      return true;
    }
    case 'ball':
      // disc with a central pentagon "cut" to read as a football.
      circle(ctx, w, h, 0.5);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      fillUnit(ctx, w, h, starPoints(5, 0.16, 0.16), 0.08); // small pentagon-ish hole
      ctx.restore();
      return true;
    case 'crescent': {
      const s = Math.min(w, h) * 0.84;
      const cx = w / 2;
      const cy = h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.48 * s, 0, Math.PI * 2);
      ctx.arc(cx + 0.2 * s, cy - 0.06 * s, 0.4 * s, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      return true;
    }
    case 'wings':
      // a pair of spread wings meeting at the centre.
      fillUnit(ctx, w, h, [
        [0, -0.12], [-0.12, -0.06], [-0.26, -0.16], [-0.22, -0.04], [-0.4, -0.12], [-0.34, 0.02],
        [-0.5, -0.02], [-0.4, 0.12], [-0.12, 0.12], [0, 0.18],
        [0.12, 0.12], [0.4, 0.12], [0.5, -0.02], [0.34, 0.02], [0.4, -0.12], [0.22, -0.04],
        [0.26, -0.16], [0.12, -0.06],
      ]);
      return true;
    case 'eagle':
      // heraldic eagle: head + spread wings + tail, symmetric silhouette.
      fillUnit(ctx, w, h, [
        [0, -0.5], [0.07, -0.42], [0.05, -0.3], // head/beak
        [0.16, -0.34], [0.34, -0.42], [0.3, -0.26], [0.5, -0.28], [0.4, -0.1], // right wing top
        [0.22, -0.12], [0.34, 0.04], [0.16, -0.02], [0.2, 0.16], [0.08, 0.06], // right wing lower
        [0.12, 0.3], [0.04, 0.22], [0.06, 0.46], [0, 0.36], // tail right
        [-0.06, 0.46], [-0.04, 0.22], [-0.12, 0.3], // tail left
        [-0.08, 0.06], [-0.2, 0.16], [-0.16, -0.02], [-0.34, 0.04], [-0.22, -0.12], // left wing lower
        [-0.4, -0.1], [-0.5, -0.28], [-0.3, -0.26], [-0.34, -0.42], [-0.16, -0.34], // left wing top
        [-0.05, -0.3], [-0.07, -0.42],
      ]);
      return true;
    case 'fist':
      // blocky raised fist.
      fillUnit(ctx, w, h, [
        [-0.26, -0.5], [-0.16, -0.5], [-0.14, -0.34], [-0.04, -0.34], [-0.02, -0.5], [0.08, -0.5],
        [0.1, -0.34], [0.2, -0.34], [0.22, -0.46], [0.32, -0.42], [0.3, -0.18],
        [0.34, 0.0], [0.3, 0.42], [-0.3, 0.42], [-0.34, 0.0],
      ]);
      return true;
    case 'rect':
      // Fill the whole box so resizing the object gives any rectangle.
      ctx.fillRect(0, 0, w, h);
      return true;
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      return true;
    }
    case 'line':
      // A centred horizontal bar; resize/rotate the object for any straight line.
      ctx.fillRect(0, h * 0.39, w, h * 0.22);
      return true;
    default:
      circle(ctx, w, h, 0.5);
      return true;
  }
}
