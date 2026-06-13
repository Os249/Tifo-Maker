/**
 * Shared data contracts for Tifo Maker.
 *
 * These types are consumed by the 2D editor, the (Phase 2) 3D preview,
 * the backend, and the export worker. Treat them as a versioned API.
 */

/** Parametric definition of a stadium bowl. Designs reference a template id+version forever. */
export interface StadiumTemplate {
  id: string;
  name: string;
  version: number;
  /** Superellipse plan curve: |x/a|^p + |y/b|^p = 1. p≈2.5–3 gives a rounded-rectangle bowl. */
  plan: { a: number; b: number; exponent: number };
  tiers: TierSpec[];
  /** Radial aisles, expressed as perimeter fractions (u) with a physical width in metres. */
  aisles: { count: number; widthMeters: number };
  /** Sections per tier, bucketed by u. The organizational unit tifo planners think in. */
  sectionsPerTier: number;
}

export interface TierSpec {
  rows: number;
  /** Horizontal depth per row in metres (going outward/back). */
  rowDepth: number;
  /** Rake angle in degrees. Reference stadiums: lower ~24°, upper/kop ~33°. */
  rakeDeg: number;
  /** Elevation of the tier's first row, metres above pitch. */
  baseElevation: number;
  /** Radial offset of the tier's first row from the plan curve, metres. */
  baseOffset: number;
  /** Seat spacing along the row arc, metres. */
  seatPitch: number;
}

/**
 * Derived, immutable seat geometry. Generated deterministically from a template —
 * the same template version MUST always yield a byte-identical SeatMap, because
 * saved designs index into it by position.
 */
export interface SeatMap {
  templateRef: { id: string; version: number };
  count: number;
  /** count*2 — editor-space coordinates (unrolled bowl), in editor units. */
  xy: Float32Array;
  /** count*2 — normalized (u = perimeter fraction, v = row fraction). */
  uv: Float32Array;
  /** count*3 — world xyz in metres, for the Phase 2 3D preview. */
  pos3: Float32Array;
  /** Per-seat indices. */
  tierOf: Uint8Array;
  rowOf: Uint16Array;
  sectionOf: Uint16Array;
  /** count*4 — [left, right, down, up] seat indices; -1 = gap, aisle, tier edge. */
  neighbors: Int32Array;
  /**
   * Seat reflected across the halfway line (u → 0.5 − u), same row; -1 if none.
   * Side stands mirror about their own center; end stands map to each other.
   */
  mirrorOf: Int32Array;
  /** Editor-space bounds for camera fitting. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** A complete design: one byte per seat. 60k seats = 60 KB raw, ~2–8 KB gzipped. */
export interface DesignState {
  seatMapRef: { id: string; version: number };
  /** Up to 8 hex colors. Index 0 is always "empty seat". */
  palette: string[];
  cells: Uint8Array;
}

/**
 * The universal change format: undo stack entry, autosave payload,
 * revision-history row, and future realtime-collaboration message.
 */
export interface SparseDiff {
  indices: Uint32Array;
  before: Uint8Array;
  after: Uint8Array;
}

export type ToolId = 'brush' | 'fill' | 'eraser' | 'pan' | 'text' | 'import' | 'select';
export type FillScope = 'section' | 'global';
