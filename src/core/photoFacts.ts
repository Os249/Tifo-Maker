import type { FacadeStyle, LightingStyle, RoofCoverage } from './types';

/**
 * What a photograph can tell the estimator that nothing else can.
 *
 * The bowl's size comes off the map and its row count comes off the stated
 * capacity. What neither can reach is what makes a render look like the ground
 * rather than merely like a stadium: how many tiers, which stands are roofed,
 * whether there is a track, whether the stands are a square box or a rounded
 * bowl, whether the corners are open, and what colour the seats are. A fan who
 * has been there knows all of it at a glance. So does a vision model, looking
 * at one good photo.
 *
 * The risk is obvious: a model will answer confidently whether or not it can
 * see the answer, and a confident wrong answer that enters the template as
 * plain data is worse than the guess it replaced. Three defences, measured on
 * real photos of 18 grounds the site models (scripts/photo-eval.mts):
 *
 *  - It says first what the photo shows. A dressing room, a pub, a satellite
 *    image or a crowd close-up is not a ground, and nothing read from it is
 *    used. Before this, a photo of the pub opposite Villa Park set the
 *    stadium's facade to brick.
 *  - It says how sure it is of each answer, and a "low" answer does not count.
 *  - It is asked several times, and an answer is used only when most readings
 *    give it. (The readings agree far more often than they are right, so this
 *    catches the coin-flips, not the systematic mistakes; the first two are
 *    what catch those.)
 *
 * Pure and DOM-free: the prompt, the parsing and the vote all run in Node, so
 * the hard part is testable without a key, a network or a browser.
 */

export const TIER_VALUES = [1, 2, 3] as const;
export const ROOF_VALUES: RoofCoverage[] = ['none', 'ring', 'sides', 'ends', 'west'];
export const LIGHTING_VALUES: LightingStyle[] = ['none', 'corner-masts', 'side-banks', 'roof-rim'];
export const FACADE_VALUES: FacadeStyle[] = ['plain', 'berm', 'truss', 'concrete', 'brick', 'cladding', 'membrane', 'lattice'];

/**
 * What the photo is of. "bowl": from inside, seats on at least two sides of
 * the pitch. "stand": from inside, one stand or a small part of the ground.
 * "aerial": from above. "outside": the building from outside. "none": no
 * football ground in it at all.
 */
export type PhotoView = 'bowl' | 'stand' | 'aerial' | 'outside' | 'none';
export const VIEW_VALUES: PhotoView[] = ['bowl', 'stand', 'aerial', 'outside', 'none'];

/** Straight stands squared up to the touchlines, or seating curving round the pitch. */
export type PhotoShape = 'square' | 'round';

/** One reading of one photograph. Every field is optional: "I cannot see" is an answer. */
export interface PhotoFacts {
  view?: PhotoView;
  tiers?: 1 | 2 | 3;
  roof?: RoofCoverage;
  track?: boolean;
  lighting?: LightingStyle;
  facade?: FacadeStyle;
  /** Open corners, as a ground of four separate stands has. */
  openCorners?: boolean;
  shape?: PhotoShape;
  /** Up to two seat colours, most common first, as #rrggbb. */
  seatColours?: string[];
}

/**
 * The system prompt.
 *
 * What does the work, each part found by reading the replies to real photos:
 *  - Every question offers "unsure", and asks how sure the answer is. Without
 *    an out a model answers anyway, and every reading agrees on the
 *    fabrication, so no vote can catch it.
 *  - The questions are about what is VISIBLE, not about the stadium: "how many
 *    decks can you see" is answerable from a photo; "how many tiers does this
 *    stadium have" invites the model to recall a ground it thinks it knows.
 *  - It names the photos that are not of a ground at all, because fans upload
 *    them (the match, the dressing room, the museum, the pub).
 *  - The seats are read off the seats, not the crowd: a full stand's colour
 *    is the fans' shirts. Told to give up wherever there were people, it gave
 *    up on five photos it had read right, so it looks between them instead.
 *  - The shape question is about the long sides, straight or bowed, because
 *    "square or round" was answered "round" for the Jewel, Al-Awwal, San
 *    Mamés and Wembley: boxes whose seating rounds the corners.
 *  - One fixed JSON shape, the same keys every time, so a reply either parses
 *    or plainly does not.
 */
export const PHOTO_FACTS_PROMPT = [
  'You are looking at one photograph that a football fan says shows their home ground.',
  'Describe ONLY what is visible in this image. Do not use anything you may know about a',
  'stadium you think you recognise: you are describing this picture, not that stadium.',
  'If the picture does not show something, say "unsure". That is a correct and useful',
  'answer; a guess is not.',
  '',
  'Reply with this JSON object and nothing else, every key present:',
  '{',
  '  "view": "bowl" | "stand" | "aerial" | "outside" | "none",',
  '  "tiers":    { "value": 1 | 2 | 3 | "unsure", "sure": "high" | "medium" | "low" },',
  '  "roof":     { "value": "ring" | "sides" | "ends" | "one" | "none" | "unsure", "sure": … },',
  '  "track":    { "value": true | false | "unsure", "sure": … },',
  '  "sides":    { "value": "straight" | "curved" | "unsure", "sure": … },',
  '  "corners":  { "value": "closed" | "open" | "unsure", "sure": … },',
  '  "lighting": { "value": "roof-rim" | "corner-masts" | "side-banks" | "none" | "unsure", "sure": … },',
  '  "facade":   { "value": "berm" | "truss" | "concrete" | "brick" | "cladding" | "membrane" | "lattice" | "plain" | "unsure", "sure": … },',
  '  "seats":    { "value": ["#rrggbb", …] | "unsure", "sure": … }',
  '}',
  '',
  'view: what the photo shows. "bowl" = from inside, with seating on at least two sides',
  'of the pitch. "stand" = from inside, but only one stand or a small part of the ground.',
  '"aerial" = the ground from above. "outside" = the building from outside. "none" = no',
  'football ground is shown: people close up, a dressing room, a street, a building, a',
  'map, a satellite or radar image, a model or a screen. For "none", answer "unsure" to',
  'everything else.',
  '',
  'sure: "high" = you can see it clearly; "medium" = you can see part of it; "low" = you',
  'are mostly guessing.',
  '',
  'tiers: the most decks of seating stacked one above another in any stand you can see.',
  'A deck is a band of seats with a wall, a row of boxes or a walkway between it and the',
  'next.',
  '',
  'roof: which stands have a roof over their seats. "ring" = every stand you can see,',
  'the ends too. "sides" = the two long stands along the touchlines only. "ends" = the',
  'two stands behind the goals only. "one" = a single stand. "none" = open to the sky.',
  '',
  'track: a running track between the seats and the pitch.',
  '',
  'sides: the two long stands along the touchlines. "straight" = they run straight and',
  'parallel to the touchline, even where the corners are rounded. "curved" = they bow',
  'outwards, so the seating makes an oval round the pitch.',
  '',
  'corners: "closed" = the seating continues round the corners. "open" = separate stands',
  'with gaps or empty space at the corners.',
  '',
  'lighting: "corner-masts" = tall towers at the corners. "roof-rim" = a line of lamps',
  'along the roof edge. "side-banks" = lamps along the two long sides only.',
  '',
  'facade, meaning the OUTSIDE of the building: "berm" = a grassy or earth bank.',
  '"truss" = open steelwork. "concrete" = bare structural concrete. "brick" = brickwork.',
  '"cladding" = a continuous skin of metal panels. "membrane" = translucent fabric or',
  'plastic panels. "lattice" = a decorative openwork shell. "plain" = a flat blank wall.',
  'From inside the ground you cannot see the facade: answer "unsure".',
  '',
  'seats: the colour of the seats themselves, as #rrggbb, the commonest first, at most',
  'two. Look at empty seats: whole empty blocks, and the seats that show between people.',
  'Ignore the fans and their shirts, the roof, the advertising and the shadows. If no',
  'seats can be seen at all, answer "unsure".',
].join('\n');

const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

/**
 * One answer as given: `{ value, sure }`, or a bare value (the shape the first
 * version of the prompt asked for, still accepted). A "low" answer is no
 * answer: the model has told us it is guessing.
 */
function answer(o: Record<string, unknown>, key: string, legacy?: string): unknown {
  const v = o[key] ?? (legacy ? o[legacy] : undefined);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const a = v as { value?: unknown; sure?: unknown };
    return a.sure === 'low' ? undefined : a.value;
  }
  return v;
}

/**
 * Turn one model reply into facts, dropping everything that is not exactly one
 * of the allowed answers.
 *
 * Deliberately unforgiving. A model that replies "two" instead of 2, or invents
 * "half-roof", has not answered the question, and silently coercing it to the
 * nearest legal value is how a fabrication becomes data. An unparseable field
 * simply does not vote.
 */
export function parsePhotoFacts(raw: unknown): PhotoFacts {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: PhotoFacts = {};
  if (typeof o.view === 'string' && (VIEW_VALUES as string[]).includes(o.view)) out.view = o.view as PhotoView;
  // A reading that says the photo shows no ground has nothing else to say,
  // whatever it filled the other keys with.
  if (out.view === 'none') return out;
  const tiers = answer(o, 'tiers');
  if (tiers === 1 || tiers === 2 || tiers === 3) out.tiers = tiers;
  // "one" is the prompt's word for a single roofed stand; 'west' is what the
  // template calls the main stand, and what the tifo compiler means by it.
  const r = answer(o, 'roof');
  const roof = r === 'one' ? 'west' : r;
  if (typeof roof === 'string' && (ROOF_VALUES as string[]).includes(roof)) out.roof = roof as RoofCoverage;
  const track = answer(o, 'track');
  if (typeof track === 'boolean') out.track = track;
  // "sides" is the question; "shape" the first prompt's word for it.
  const sides = answer(o, 'sides', 'shape');
  if (sides === 'straight' || sides === 'square') out.shape = 'square';
  else if (sides === 'curved' || sides === 'round') out.shape = 'round';
  const corners = answer(o, 'corners', 'openCorners');
  if (corners === 'open' || corners === 'closed') out.openCorners = corners === 'open';
  else if (typeof corners === 'boolean') out.openCorners = corners;
  const lighting = answer(o, 'lighting');
  if (typeof lighting === 'string' && (LIGHTING_VALUES as string[]).includes(lighting)) out.lighting = lighting as LightingStyle;
  // The outside cannot be seen from in the stands. A reading that says it is
  // inside and still names a facade is describing something else.
  const facade = answer(o, 'facade');
  const inside = out.view === 'bowl' || out.view === 'stand';
  if (!inside && typeof facade === 'string' && (FACADE_VALUES as string[]).includes(facade)) out.facade = facade as FacadeStyle;
  const seats = answer(o, 'seats', 'seatColours');
  if (Array.isArray(seats)) {
    const cols = seats.filter(isHex).map((c) => c.toLowerCase()).slice(0, 2);
    if (cols.length) out.seatColours = cols;
  }
  return out;
}

// ---- colour ------------------------------------------------------------------

function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference between two #rrggbb colours. */
export function deltaE(a: string, b: string): number {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Two readings of the same seats name them within this of each other: three
 * readings of Anfield gave #c8102e, #d6202a and #c8102e (8 apart), of the
 * Bernabéu #2f5fa8 and #2a5db0 (6). Red and claret, the nearest pair a fan
 * tells apart, are 27 apart.
 */
const SAME_SEATS = 20;

// ---- the vote --------------------------------------------------------------

/** What the samples settled on for one field, and how firmly. */
export interface FieldVote<T> {
  value: T;
  /** Fraction of samples that gave an answer AND gave this one. 0..1. */
  agreement: number;
  /** How many samples answered this field at all. */
  answered: number;
  /** How many samples were taken. */
  samples: number;
}

export interface FactsVote {
  view?: FieldVote<PhotoView>;
  tiers?: FieldVote<1 | 2 | 3>;
  roof?: FieldVote<RoofCoverage>;
  track?: FieldVote<boolean>;
  lighting?: FieldVote<LightingStyle>;
  facade?: FieldVote<FacadeStyle>;
  openCorners?: FieldVote<boolean>;
  shape?: FieldVote<PhotoShape>;
  seatColours?: FieldVote<string[]>;
  samples: number;
}

function tally<T>(values: T[], samples: number, key: (v: T) => string): FieldVote<T> | undefined {
  if (!values.length) return undefined;
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    const k = key(v);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { v, n: 1 });
  }
  let best = { v: values[0], n: 0 };
  for (const c of counts.values()) if (c.n > best.n) best = c;
  // Agreement is over the samples that ANSWERED, not over all samples. A field
  // eight of ten declined to answer is a field the two answerers may still be
  // right about; `answered` is reported alongside so the caller can weigh both.
  return { value: best.v, agreement: best.n / values.length, answered: values.length, samples };
}

/**
 * Seat colours agree when they are the same colour to the eye, not the same
 * hex: no two readings of red seats name the very same red. The answer is the
 * reading whose main colour sits closest to all the others (the medoid), and
 * agreement is the share of readings within SAME_SEATS of it.
 */
function tallyColours(values: string[][], samples: number): FieldVote<string[]> | undefined {
  if (!values.length) return undefined;
  let best = values[0], bestCost = Infinity;
  for (const v of values) {
    const cost = values.reduce((s, w) => s + deltaE(v[0], w[0]), 0);
    if (cost < bestCost) { best = v; bestCost = cost; }
  }
  const near = values.filter((w) => deltaE(best[0], w[0]) <= SAME_SEATS).length;
  return { value: best, agreement: near / values.length, answered: values.length, samples };
}

/**
 * Fold several readings of the same photo into one answer per field.
 *
 * The output is not "the model said X". It is "n of m readings said X", which is
 * a different and much more honest claim, and the only one that earns its way
 * into a template that advertises where every number came from.
 */
export function aggregateFacts(samples: PhotoFacts[]): FactsVote {
  const n = samples.length;
  const pick = <K extends keyof PhotoFacts>(k: K): NonNullable<PhotoFacts[K]>[] =>
    samples.map((s) => s[k]).filter((v) => v !== undefined) as NonNullable<PhotoFacts[K]>[];
  return {
    view: tally(pick('view'), n, String),
    tiers: tally(pick('tiers'), n, String),
    roof: tally(pick('roof'), n, String),
    track: tally(pick('track'), n, String),
    lighting: tally(pick('lighting'), n, String),
    facade: tally(pick('facade'), n, String),
    openCorners: tally(pick('openCorners'), n, String),
    shape: tally(pick('shape'), n, String),
    seatColours: tallyColours(pick('seatColours'), n),
    samples: n,
  };
}

/** The share of readings that must agree before a field is used. */
export const DEFAULT_MIN_AGREEMENT = 0.6;

/**
 * Where a box arena's corners open, as a fraction of the half-axes: the figure
 * the Kingdom Arena template was drawn with.
 */
export const OPEN_CORNER_CUT = 0.8;

export interface PhotoKnown {
  tiers?: number;
  roof?: RoofCoverage;
  hasTrack?: boolean;
  lighting?: LightingStyle;
  facade?: FacadeStyle;
  cornerCut?: number;
  shape?: PhotoShape;
  /** The empty seats' colour, main first. */
  seatColours?: string[];
}

export interface KnownFromPhoto {
  known: PhotoKnown;
  used: string[];
  dropped: Array<{ field: string; agreement: number; answered: number }>;
  /** Most readings said the photo shows no ground: nothing was used, and the panel says why. */
  noGround: boolean;
}

/**
 * Which of the vote's answers are firm enough to hand the estimator, and why
 * each of the others was dropped.
 *
 * A field also needs more than one reading behind it: one lone answer out of
 * five scores 100% agreement with itself, which is exactly the false confidence
 * this whole arrangement exists to avoid.
 */
export function factsToKnown(vote: FactsVote, minAgreement = DEFAULT_MIN_AGREEMENT): KnownFromPhoto {
  const known: PhotoKnown = {};
  const used: string[] = [];
  const dropped: Array<{ field: string; agreement: number; answered: number }> = [];
  const firm = (field: string, v?: FieldVote<unknown>): boolean => {
    if (!v) return false;
    const enough = v.agreement >= minAgreement && (v.answered >= 2 || v.samples === 1);
    if (enough) used.push(field);
    else dropped.push({ field, agreement: v.agreement, answered: v.answered });
    return enough;
  };
  // A photo most readings call "no ground" gives nothing at all, even where a
  // reading that disagreed answered something: that answer is about a pub, a
  // crowd or a dressing room, not about the stands.
  const v = vote.view;
  if (v && v.value === 'none' && v.agreement >= minAgreement && (v.answered >= 2 || v.samples === 1)) {
    return { known, used, dropped, noGround: true };
  }
  if (firm('tiers', vote.tiers)) known.tiers = vote.tiers!.value;
  if (firm('roof', vote.roof)) known.roof = vote.roof!.value;
  if (firm('track', vote.track)) known.hasTrack = vote.track!.value;
  if (firm('lighting', vote.lighting)) known.lighting = vote.lighting!.value;
  if (firm('facade', vote.facade)) known.facade = vote.facade!.value;
  if (firm('openCorners', vote.openCorners) && vote.openCorners!.value) known.cornerCut = OPEN_CORNER_CUT;
  if (firm('shape', vote.shape)) known.shape = vote.shape!.value;
  if (firm('seatColours', vote.seatColours)) known.seatColours = vote.seatColours!.value;
  return { known, used, dropped, noGround: false };
}
