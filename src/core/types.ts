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
  /**
   * Box-arena corner cut (0..1). 0 / undefined = full continuous bowl (default).
   * When > 0, seats whose normalised plan coords satisfy |x/a| > c AND |y/b| > c
   * are dropped, opening the four corners so the bowl reads as four straight
   * stands (Kingdom Arena style). ~0.6 = generous corners, ~0.75 = small notch.
   */
  cornerCut?: number;
  /**
   * Space seats evenly along each row's own (offset) curve instead of the base
   * plan curve. Fixes seats bunching on the straights and stretching round the
   * corners — the error grows with every row back.
   *
   * OPT-IN because it moves seat positions: a template's SeatMap must stay
   * byte-identical for a given version or saved designs would shift. Set it on
   * new templates; leave existing ones alone (or bump their version).
   */
  evenRows?: boolean;
  /**
   * The roof over the bowl. Omitted means the default cantilever ring, so every
   * existing template keeps a roof without being edited; `{ coverage: 'none' }`
   * is how a ground says it is genuinely open to the sky, and how the two
   * stadiums with hand-built roofs (see simulator/stadiumExtras, jewelCrown)
   * opt out of getting a second one.
   *
   * Roof geometry is shell only — it never touches seat positions, so changing
   * it cannot move a saved design.
   */
  roof?: RoofSpec;
  /**
   * A 400 m athletics track around the pitch. Present means the ground has one;
   * the renderer still checks it FITS, so a template cannot claim a track its
   * bowl has no room for.
   */
  track?: TrackSpec;
  /**
   * How this ground is lit. Omitted means the historic default — four corner
   * masts — so every existing template renders as it did.
   */
  lighting?: LightingSpec;
  /**
   * What the outside of the bowl is made of. Omitted means the plain concrete
   * skirt the renderer has always drawn, so every existing template is
   * untouched; a style here replaces that skirt.
   */
  facade?: FacadeSpec;
}

/**
 * Where a ground's floodlights are.
 *
 * Not a decoration: UEFA states that four corner towers "will not generally
 * meet" its requirements for a top-tier ground, because they light the grass
 * and leave players' faces dark. Corner masts are the 1955-1990 look; a
 * continuous array along the roof rim is what a modern broadcast venue has.
 * Which one a stadium has is the single biggest cue to its age.
 */
export type LightingStyle = 'none' | 'corner-masts' | 'side-banks' | 'roof-rim';

export interface LightingSpec {
  /** Default 'corner-masts', which is what the renderer drew before this existed. */
  style?: LightingStyle;
  /**
   * Colour temperature in kelvin. LED installations are specified at 5000-6200 K
   * (5700 typical); metal halide, which is what anything built before roughly
   * 2010 has, runs 4000-5600 K and reads visibly warmer. Default 5700.
   */
  kelvin?: number;
}

/**
 * What the outside of the bowl is made of.
 *
 * These are the seven things you can tell apart in a photograph taken from
 * outside a stadium, which is the only place this information can come from.
 * They differ in three ways that survive at 150 m: whether you can see through
 * the skin, what rhythm it has, and whether it glows after dark.
 */
export type FacadeStyle =
  | 'plain'     // a flat concrete skirt: the renderer's historic default
  | 'berm'      // no wall at all — the bowl is banked into an earth slope
  | 'truss'     // open steel: posts and rails, and you see the deck behind
  | 'concrete'  // structural frame with the piers standing proud
  | 'brick'     // brick infill between piers
  | 'cladding'  // a continuous panel skin with vertical fins
  | 'membrane'  // translucent fabric or ETFE, lit from within at night
  | 'lattice';  // an expressive diagrid standing clear of the bowl

export interface FacadeSpec {
  /** Default 'plain'. */
  style?: FacadeStyle;
  /** Main skin colour. Each style has a sensible default. */
  color?: number;
  /** Piers, fins, posts — whatever the style's secondary element is. */
  accent?: number;
  /** Metres between piers/fins/posts. Default depends on the style. */
  bayMeters?: number;
}

/** An athletics track. All optional — `{}` means "a standard eight-lane one". */
export interface TrackSpec {
  /** 4-9. Default 8, the World Athletics standard for a Category I facility. */
  lanes?: number;
  /** Surface colour. Default brick red; there is no official standard. */
  surface?: number;
  /** Lane lines and the finish line. Default true. */
  markings?: boolean;
}

/** Which stands a roof covers. Matches the tifo stand names; 'ring' is all four. */
export type RoofCoverage = 'none' | 'ring' | 'sides' | 'ends' | 'north' | 'south' | 'east' | 'west';

/**
 * A cantilever roof, described the way a stadium actually varies: how much of
 * the bowl it covers, how far in it reaches, how high it sits and how it tilts.
 *
 * Reach is a FRACTION of the top tier's depth rather than metres, because the
 * one number that must never be wrong is how much of the tifo the roof hides,
 * and that is a proportion of the stand, not an absolute distance. A fixed
 * metre reach silently swallows a shallow bowl.
 */
export interface RoofSpec {
  /** Default 'ring'. */
  coverage?: RoofCoverage;
  /** How far in over the top tier, as a fraction of its depth. 0..1. Default 0.5. */
  reach?: number;
  /** Metres the roof oversails behind the back of the bowl. Default 5. */
  overhang?: number;
  /** Metres from the back of the top tier up to the roof's OUTER edge. Default 6. */
  rise?: number;
  /** Metres the leading (pitch-side) edge sits below the outer edge. Default 2. */
  slope?: number;
  /** Structural depth in metres, which is what gives the roof a visible edge. Default 1.2. */
  thickness?: number;
  /** Deck colour (seen from outside/above). */
  color?: number;
  /** Underside colour (what the crowd and the camera actually see). */
  underColor?: number;
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
  /** Up to 256 hex colors (one byte per seat). Index 0 is always "empty seat". */
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

export type ToolId = 'brush' | 'fill' | 'eraser' | 'pan' | 'text' | 'import' | 'select' | 'shape' | 'eyedropper';
export type FillScope = 'section' | 'global';
