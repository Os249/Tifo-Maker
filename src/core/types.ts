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
  /**
   * The things that make a real ground that ground rather than a bowl of its
   * size: the vehicle lanes through the stands, the premium seating, the box
   * band and the big screens. All optional — a template without it is
   * untouched — and only `lanes` moves seats (it removes them, exactly as a
   * real ramp does). See VenueDetails.
   */
  details?: VenueDetails;
  /**
   * A fully enclosed building: no sky, no weather inside, and the cameras stay
   * under the roof. Shell only — never moves a seat.
   */
  indoor?: boolean;
  /**
   * Roofs a real ground has, stand by stand, in place of the one generated
   * cantilever (set `roof: { coverage: 'none' }` alongside): a white fabric
   * vault over a U of stands, a steel truss round a ring, a sheet roof over a
   * main stand only. Shell only — never moves a seat.
   */
  roofs?: RoofRun[];
  /**
   * What the empty seats look like: the club's colour, a mosaic, a block of
   * another colour, letters picked out in the seats. Shell only — the seat
   * map is untouched; a tifo paints over it as it always has.
   */
  seatLook?: SeatLook;
  /**
   * The colour of the stands' concrete (the steps between the seats) and of
   * their walls, where a ground's is not the default grey: the pale finish of
   * the Saudi grounds reads very differently from weathered European concrete.
   */
  finish?: { concrete?: number; walls?: number };
  /**
   * What lies between the pitch and the stands: grass run to the front row,
   * a covered-over track, sand. A superellipse (default p = 8) of this colour
   * under the pitch. Omitted: the dark apron every ground has had.
   */
  runoff?: { color: number; a: number; b: number; exponent?: number };
  /**
   * How many tiers a fan would say the ground has, where that is not the
   * number of entries in `tiers`: a separate main stand or the back rows of a
   * horseshoe are their own entries here, but still one tier to the eye.
   */
  levels?: number;
}

/** A seat colour mix: plain hex colours, or weighted ones for a mosaic. */
export type SeatPaint = (string | { c: string; w: number })[];

/** A part of the bowl whose empty seats have their own colours (SeatLook.regions). */
export interface SeatRegion {
  /** Which tiers (0 = lower). Omitted: all. */
  tiers?: number[];
  /** A run along one side (x for north/south, z for the ends)… */
  side?: StandSide;
  from?: number;
  to?: number;
  /** …and/or a perimeter range in u. */
  centerU?: number;
  halfU?: number;
  /** Rows within the tier, [first, last] inclusive, 0 = front row. */
  rows?: [number, number];
  colors: SeatPaint;
  /** Colour whole sections (between aisles) in turn instead of mixing seat by seat. */
  alternate?: boolean;
  /** Mix in clumps this size instead of seat by seat (see SeatLook.grain). */
  grain?: SeatGrain;
}

/**
 * The size of the patches a mixed colour comes in: a mosaic laid in blocks of
 * a few seats and rows, as most are, rather than seat by seat.
 */
export interface SeatGrain {
  /** Metres along the row. */
  along: number;
  /** Rows. */
  rows: number;
}

/** Letters picked out in the seats, the way grounds write a club's name. */
export interface SeatText {
  text: string;
  color: string;
  /** Background colour of the block it sits in (omitted: the seats keep theirs). */
  ground?: string;
  tier: number;
  /** Perimeter centre and half-width in u. */
  centerU: number;
  halfU: number;
  /** Rows within the tier it fills, [first, last]. */
  rows: [number, number];
  /** CSS font (bold sans by default). */
  font?: string;
  /** Write it the other way round (for a stand you read from the far side). */
  mirror?: boolean;
  /** A shape instead of letters (`text` is then just its name). */
  shape?: 'heart';
}

export interface SeatLook {
  colors: SeatPaint;
  /** Mix `colors` in clumps instead of seat by seat. */
  grain?: SeatGrain;
  regions?: SeatRegion[];
  text?: SeatText[];
}

/** What a roof run is made of, as you would tell it apart from the pitch. */
export type RoofRunStyle =
  | 'membrane' // white fabric stretched in vaulted bays between steel ribs
  | 'truss' // a deep steel space-truss, lamps on top
  | 'sheet' // profiled metal sheet on cantilever beams
  | 'slab'; // a plain flat cantilever

/**
 * One roof over one run of stands. The run is either one side (a straight
 * stand, between `from` and `to` along it) or the whole ring less its gaps.
 * Offsets are metres out from the plan curve, like everything else.
 */
export interface RoofRun {
  style: RoofRunStyle;
  /** A run over one side only. Omitted: the ring. */
  side?: StandSide;
  /** Over a straight stand (TierSpec.straight): offsets are out from the plan's side line, not its curve. */
  straight?: boolean;
  /** Along that side (x for north/south, z for the ends). */
  from?: number;
  to?: number;
  /** Stretches of the ring with no roof (a ring run only). */
  omit?: StandGap[];
  /** Offset of the back (where the columns are) and of the leading edge. */
  back: number;
  front: number;
  /** Height of the roof's underside at the back and at the leading edge. */
  backY: number;
  frontY: number;
  /** Metres between ribs (bays). */
  bay?: number;
  /** Structural depth at the back (a truss is deep, fabric is thin). */
  depth?: number;
  color?: number;
  underColor?: number;
  /** Columns at the back from the ground up to the roof, and their colour. */
  columns?: { every?: number; color?: number; shape?: 'post' | 'y' | 'raking'; offset?: number };
  /** Floodlights along the top of the leading edge (a truss ring carries them). */
  lights?: { every: number; y: number };
  /** A run that rises over the middle of one side (Al-Awwal's main stand): extra height peaking at along = 0, over `halfLength`. */
  arch?: { side: StandSide; rise: number; halfLength: number };
}

/**
 * Where a quarter of the bowl is, as the tifo vocabulary names it. Matches
 * STAND_GEOMETRY in tifoSpec: east is centred on u = 0 (the +x end), north on
 * 0.25, west on 0.5, south on 0.75. Corners sit between two of them.
 */
export type BowlCorner = 'north-east' | 'north-west' | 'south-west' | 'south-east';

/**
 * A vehicle tunnel for ambulances and service vehicles, coming out at pitch
 * level through the front of a tier. It is a real gap in the seating — the
 * seats inside it are not generated — which is why it shows in the design view
 * as well as the 3D one.
 */
export interface VehicleLane {
  /** Which corner of the bowl it comes in at. */
  corner: BowlCorner;
  /** Clear width of the ramp, in metres, measured along each row. */
  widthM: number;
  /** The tier it cuts through (0 = lower). Tiers above it run unbroken. */
  tier: number;
  /**
   * How many rows, from the front of the tier, the open cut takes. The rows
   * behind it run on over the tunnel's roof, the way a real one is built: an
   * ambulance needs about 4 m of headroom, not a slot through the whole stand.
   * Omitted means the cut runs the full depth of the tier.
   */
  rows?: number;
}

/**
 * A kind of premium seating, as Saudi ticketing names them: the gold platform
 * (المنصة الذهبية) at the centre of the main stand, the silver platform either
 * side of it, and a general VIP block.
 */
export type SeatZoneKind = 'gold' | 'silver' | 'vip';

/**
 * A block of premium seating. Never moves or removes a seat — it says which
 * seats are which, so the renderer can draw them as what they are and the
 * editor can show where they are.
 */
export interface SeatZone {
  kind: SeatZoneKind;
  /** Perimeter centre (0..1, same u as the seat map) and half-width in u. */
  centerU: number;
  halfU: number;
  /** Which tiers it covers (0 = lower). */
  tiers: number[];
  /**
   * Premium seats do not take part in a card display: they are sold to people
   * who are not going to hold up a card. When true the renderer draws the
   * zone's own seat colour whatever the design says.
   */
  noTifo?: boolean;
}

/** A run of glass-fronted hospitality boxes between two tiers. */
export interface BoxBand {
  centerU: number;
  halfU: number;
  /** Sits under the front of this tier (1 = between the lower and middle tier). */
  underTier: number;
  /** Number of boxes along the run. */
  count: number;
}

/** A big video screen. */
export interface ScreenSpec {
  /** Perimeter position of its centre, same u as the seat map. */
  centerU: number;
  widthM: number;
  heightM: number;
  /**
   * Hung from the roof instead of standing on the back of the top tier: the
   * centre of the screen is `offset` metres out from the plan curve and `y`
   * metres up (Kingdom Arena's end screens hang over the front rows), on
   * cables up to the ceiling at `ceiling` metres.
   */
  hang?: { offset: number; y: number; ceiling?: number };
  /**
   * Standing on its own frame instead (a screen in an open corner, or behind
   * a stand): centre `offset` metres out from the plan curve and `y` up, on
   * legs to the ground.
   */
  post?: { offset: number; y: number };
}

/** A four-sided screen hung over the centre spot — an arena's centre-hung board. */
export interface CentreScreen {
  /** Width of the two faces that look at the side stands. */
  widthM: number;
  /** Width of the two faces that look at the ends. */
  depthM: number;
  heightM: number;
  /** Height of its centre above the pitch. */
  y: number;
  /** Height of the ceiling its cables go up to. */
  ceiling?: number;
}

/** Portrait screens on columns at the four corners of the pitch, facing the centre spot. */
export interface CornerScreens {
  widthM: number;
  heightM: number;
  /** Height of the screen's centre. */
  y: number;
  /** Height the columns run up to (the roof trusses). */
  columnTop?: number;
}

/**
 * Floors of glass hospitality stacked behind a stand's last row, instead of a
 * tier above it (Kingdom Arena's main stand): boxes with seats out on a
 * terrace, and a lounge on top.
 */
export interface Hospitality {
  side: StandSide;
  /** Half its length along the stand, metres. */
  halfLength: number;
  /** Floors of boxes, and how many boxes on each. */
  boxFloors: number;
  boxesPerFloor: number;
  /** A glazed lounge across the top, with no terrace. */
  lounge: boolean;
}

export interface VenueDetails {
  lanes?: VehicleLane[];
  zones?: SeatZone[];
  boxes?: BoxBand[];
  screens?: ScreenSpec[];
  centreScreen?: CentreScreen;
  cornerScreens?: CornerScreens;
  hospitality?: Hospitality;
  /** Buildings behind the stands: a main stand's glazed VIP block, a media tower. */
  buildings?: StandBuilding[];
  /** Walls and skins round the bowl: a perforated metal skin, the panels behind the top row. */
  skins?: Skin[];
}

/** A wall round the outside of the bowl (or along one side), at a plan offset. */
export interface Skin {
  offset: number;
  y0: number;
  y1: number;
  color: number;
  /** `arcade`: a wall of tall pointed arches, one per `tile` width. */
  pattern?: 'perforated' | 'slats' | 'panels' | 'solid' | 'arcade';
  /** Metres along and up per repeat of the pattern (default 4 x 4; an arcade's bay). */
  tile?: [number, number];
  /** One side only, between `from` and `to` along it. Omitted: the ring. */
  side?: StandSide;
  from?: number;
  to?: number;
  /** Along the plan's side line rather than its curve. */
  straight?: boolean;
  /** Stretches of the ring without it. */
  omit?: StandGap[];
  /** Glows a little after dark (a lit skin). */
  glow?: number;
}

/**
 * A building behind (or over the back of) one stand: the glazed VIP and media
 * block a Saudi main stand has, the presidential suite on top of it.
 */
export interface StandBuilding {
  side: StandSide;
  /** Behind a straight stand: `front` is out from the plan's side line, not its curve. */
  straight?: boolean;
  /** Centre along the side (x for north/south, z for the ends) and half its length. */
  center?: number;
  halfLength: number;
  /** Plan offset of its pitch-side face, and its depth back from that. */
  front: number;
  depth: number;
  /** Height of its ground floor and of its top. */
  y0: number;
  y1: number;
  /** Floors of glass on the pitch side (each 3.6 m), counted down from the top; the rest is solid. */
  glassFloors?: number;
  color?: number;
  /** A strip of colour along the top (a fascia), hex. */
  fascia?: number;
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
  /**
   * Where a hand-built roof carries its rim array: metres out from the plan
   * curve, and height above the pitch. Only for grounds whose roof is not the
   * generated one (the Jewel's lamps ride the inner edge of its crown, over
   * the seats, not the back of the top tier). The angle rules still apply.
   */
  mount?: { offset: number; y: number };
  /**
   * Corner masts as built: where they stand (plan x, z — mirrored into all four
   * corners unless all four are given), how tall, and what they look like.
   * Drawn as structure whether or not the lamps are on.
   */
  masts?: { at: [number, number][]; height: number; style?: 'lattice' | 'pole'; head?: 'rect' | 'tilted' };
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
  /**
   * Where this tier exists, for a ground whose four stands are not the same
   * (Kingdom Arena: a low main stand under three floors of hospitality, a
   * two-tier stand opposite, deep single-tier ends). Omitted: the full ring, as
   * every bowl has always been.
   *
   * Each entry is one stand: the side it is on, how far it runs either side of
   * the centre line in metres, and how many of the tier's rows it has. A seat
   * is in a stand when it is on that side of the bowl and within the length.
   */
  stands?: StandSpan[];
  /**
   * The tier's stands are straight blocks on lines square to the pitch —
   * north and south at z = ±(b + offset), the ends at x = ±(a + offset), each
   * as long as its halfLength — instead of runs of the offset plan curve. For
   * a ground of four separate rectangular stands whose sides run on past the
   * ends (the Al-Shabab ground), which no single curve can describe. Needs
   * `stands`; each stand may then sit at its own `offset` and `elevation`.
   */
  straight?: boolean;
  /**
   * Stretches of a RING tier with no seats: the open side of a horseshoe, or
   * the gap a separate main stand stands in (Buraidah, Abha, the Ettifaq
   * ground). Each is a run along one side, `from` to `to` metres along it (x
   * for the north and south sides, z for the ends), within that side's sector
   * of the bowl. Omitted: the ring is unbroken, as every bowl has always been.
   */
  omit?: StandGap[];
}

/** A stretch of one side of a ring tier with no seats (TierSpec.omit). */
export interface StandGap {
  side: StandSide;
  /** Along the side: x for north and south, z for east and west. from < to. */
  from: number;
  to: number;
  /**
   * Only the rows from this one back (0 = the front row): the front of the
   * stand runs on and the back of it opens, for a box band or a set-back
   * upper section over the middle of a main stand. Straight sides only.
   */
  fromRow?: number;
}

/**
 * The four sides of the bowl, in the tifo vocabulary (STAND_GEOMETRY in
 * tifoSpec): north is +z (u = 0.25), south -z (u = 0.75, the main stand),
 * east +x (u = 0, an end), west -x (u = 0.5, the other end).
 */
export type StandSide = 'north' | 'south' | 'east' | 'west';

export interface StandSpan {
  side: StandSide;
  /**
   * Half its length in metres, along the axis the stand runs: x for the north
   * and south stands, z for the ends.
   */
  halfLength: number;
  /** How many of the tier's rows this stand has. Default: all of them. */
  rows?: number;
  /** A straight tier only: metres further out than the tier's baseOffset, and higher than its baseElevation. */
  offset?: number;
  elevation?: number;
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
