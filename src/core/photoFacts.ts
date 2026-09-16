import type { FacadeStyle, LightingStyle, RoofCoverage } from './types';

/**
 * What a photograph can tell the estimator that nothing else can.
 *
 * The bowl's shape comes off overhead imagery and its row count comes off the
 * stated capacity, and both carry a residual you can quote. What neither can
 * reach is the handful of CATEGORICAL facts that decide whether a render looks
 * like the ground or merely like a stadium: how many tiers, which stands are
 * roofed, whether there is a track, whether the lights are on pylons or along
 * the roof, and what the outside is made of. A person who has seen the place
 * knows all six at a glance. So does a vision model, looking at one photo.
 *
 * The risk is obvious: a model will answer confidently whether or not it can
 * see the answer, and a confident wrong answer that enters the template as
 * plain data is worse than the guess it replaced — the guess at least admitted
 * to being one. So this module never takes a single answer. It asks several
 * times and keeps the agreement rate, and the agreement rate is what decides
 * whether the answer is used at all. Disagreement is not noise here; it is the
 * model telling us it cannot see that from this picture.
 *
 * Pure and DOM-free: the prompt, the parsing and the vote all run in Node, so
 * the hard part is testable without a key, a network or a browser.
 */

export const TIER_VALUES = [1, 2, 3] as const;
export const ROOF_VALUES: RoofCoverage[] = ['none', 'ring', 'sides', 'ends', 'west'];
export const LIGHTING_VALUES: LightingStyle[] = ['none', 'corner-masts', 'side-banks', 'roof-rim'];
export const FACADE_VALUES: FacadeStyle[] = ['plain', 'berm', 'truss', 'concrete', 'brick', 'cladding', 'membrane', 'lattice'];

/** One reading of one photograph. Every field is optional: "I cannot see" is an answer. */
export interface PhotoFacts {
  tiers?: 1 | 2 | 3;
  roof?: RoofCoverage;
  track?: boolean;
  lighting?: LightingStyle;
  facade?: FacadeStyle;
  /** Open corners, as a box arena has. */
  openCorners?: boolean;
  /** Up to three seat colours, most common first, as #rrggbb. */
  seatColours?: string[];
}

/**
 * The system prompt.
 *
 * Two things in here are doing the real work. The first is that every question
 * offers an explicit "unsure" — without it a model answers anyway, and then the
 * vote below cannot tell a fact from a coin-flip because every sample agrees on
 * a fabrication. The second is that the questions are about what is VISIBLE
 * rather than about the stadium: "how many decks of seating can you count in
 * this picture" is answerable from a photo; "how many tiers does this stadium
 * have" invites the model to recall a ground it thinks it recognises, which is
 * how you get the right answer for the wrong stadium.
 */
export const PHOTO_FACTS_PROMPT = [
  'You are looking at one photograph of a football or athletics ground.',
  'Answer ONLY from what is visible in this image. Do not use anything you may know',
  'about a stadium you think you recognise: you are describing this picture, not that',
  'stadium. If the picture does not show something, say "unsure" — that is a correct',
  'and useful answer, and guessing is not.',
  '',
  'Reply with JSON only, this exact shape, every field present:',
  '{',
  '  "tiers": 1|2|3|"unsure",            // decks of seating stacked above each other',
  '  "roof": "none"|"ring"|"sides"|"ends"|"one"|"unsure",  // which stands are covered',
  '  "track": true|false|"unsure",        // a running track between the seats and the pitch',
  '  "lighting": "corner-masts"|"roof-rim"|"side-banks"|"none"|"unsure",',
  '  "facade": "berm"|"truss"|"concrete"|"brick"|"cladding"|"membrane"|"lattice"|"plain"|"unsure",',
  '  "openCorners": true|false|"unsure",  // four separate stands with gaps at the corners',
  '  "seatColours": ["#rrggbb", ...]      // up to 3, commonest first; [] if you cannot tell',
  '}',
  '',
  'lighting: "corner-masts" = tall lattice towers at the corners. "roof-rim" = a',
  'continuous line of small lamps along the roof edge. "side-banks" = lamps along the',
  'two long sides only. Answer "unsure" for a daylight photo with nothing visible.',
  '',
  'facade, meaning the OUTSIDE of the building: "berm" = a grassy or earth bank with no',
  'wall. "truss" = open steelwork you can see through. "concrete" = bare structural',
  'concrete. "brick" = brickwork. "cladding" = a continuous skin of metal panels.',
  '"membrane" = translucent fabric or plastic panels. "lattice" = a decorative openwork',
  'shell standing clear of the building. "plain" = a flat blank wall. If the photo is',
  'taken from inside, you cannot see the facade: answer "unsure".',
].join('\n');

const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

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
  if (o.tiers === 1 || o.tiers === 2 || o.tiers === 3) out.tiers = o.tiers;
  // "one" is the prompt's word for a single roofed stand; 'west' is what the
  // template calls the main stand, and what the tifo compiler means by it.
  const roof = o.roof === 'one' ? 'west' : o.roof;
  if (typeof roof === 'string' && (ROOF_VALUES as string[]).includes(roof)) out.roof = roof as RoofCoverage;
  if (typeof o.track === 'boolean') out.track = o.track;
  if (typeof o.lighting === 'string' && (LIGHTING_VALUES as string[]).includes(o.lighting)) out.lighting = o.lighting as LightingStyle;
  if (typeof o.facade === 'string' && (FACADE_VALUES as string[]).includes(o.facade)) out.facade = o.facade as FacadeStyle;
  if (typeof o.openCorners === 'boolean') out.openCorners = o.openCorners;
  if (Array.isArray(o.seatColours)) {
    const cols = o.seatColours.filter(isHex).map((c) => c.toLowerCase()).slice(0, 3);
    if (cols.length) out.seatColours = cols;
  }
  return out;
}

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
  tiers?: FieldVote<1 | 2 | 3>;
  roof?: FieldVote<RoofCoverage>;
  track?: FieldVote<boolean>;
  lighting?: FieldVote<LightingStyle>;
  facade?: FieldVote<FacadeStyle>;
  openCorners?: FieldVote<boolean>;
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
    tiers: tally(pick('tiers'), n, String),
    roof: tally(pick('roof'), n, String),
    track: tally(pick('track'), n, String),
    lighting: tally(pick('lighting'), n, String),
    facade: tally(pick('facade'), n, String),
    openCorners: tally(pick('openCorners'), n, String),
    // Colours agree by their FIRST entry: two readings that both lead with the
    // same blue agree about the seats even if they disagree about the trim.
    seatColours: tally(pick('seatColours'), n, (c) => c[0] ?? ''),
    samples: n,
  };
}

/** The share of readings that must agree before a field is used. */
export const DEFAULT_MIN_AGREEMENT = 0.6;

export interface PhotoKnown {
  tiers?: number;
  roof?: RoofCoverage;
  hasTrack?: boolean;
  lighting?: LightingStyle;
  facade?: FacadeStyle;
  cornerCut?: number;
}

/**
 * Which of the vote's answers are firm enough to hand the estimator, and why
 * each of the others was dropped.
 *
 * A field also needs more than one reading behind it: one lone answer out of
 * five scores 100% agreement with itself, which is exactly the false confidence
 * this whole arrangement exists to avoid.
 */
export function factsToKnown(
  vote: FactsVote,
  minAgreement = DEFAULT_MIN_AGREEMENT,
): { known: PhotoKnown; used: string[]; dropped: Array<{ field: string; agreement: number; answered: number }> } {
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
  if (firm('tiers', vote.tiers)) known.tiers = vote.tiers!.value;
  if (firm('roof', vote.roof)) known.roof = vote.roof!.value;
  if (firm('track', vote.track)) known.hasTrack = vote.track!.value;
  if (firm('lighting', vote.lighting)) known.lighting = vote.lighting!.value;
  if (firm('facade', vote.facade)) known.facade = vote.facade!.value;
  // A box arena's corners open at about 0.8 of the half-axes — the figure the
  // Kingdom Arena template uses, and the only one this has ever been measured on.
  if (firm('openCorners', vote.openCorners) && vote.openCorners!.value) known.cornerCut = 0.8;
  return { known, used, dropped };
}
