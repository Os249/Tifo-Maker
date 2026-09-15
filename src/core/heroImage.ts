/**
 * Super AI guarantees the bowl a PICTURE.
 *
 * The director is told to make one the hero, and usually does — but "usually"
 * is not a guarantee, and a Super design without a picture is a Quick Designer
 * result that cost a premium credit. A vector symbol is one flat colour and
 * cannot shade, so a bowl of symbols and fills can only ever be flat blocks;
 * the picture is the entire reason the mode exists.
 *
 * So this is structural rather than a prompt request. If the spec has no image
 * layer, one is put there — preferring to PROMOTE the design's own hero symbol
 * rather than invent a new element, because the director already decided where
 * the focal point belongs and an image in the same region is a straight upgrade
 * of the same composition.
 */
import type { TifoSpec, SpecLayer, Region, Stand, SymbolName } from './tifoSpec';
import { STANDS } from './tifoSpec';

/** What each drawable symbol becomes when a real picture is generated instead. */
const SUBJECT: Partial<Record<SymbolName, string>> = {
  eagle: 'a heraldic eagle with spread wings, head in profile',
  wings: 'a pair of outstretched heraldic wings',
  crown: 'a heavy royal crown, front on',
  shield: 'a bold heraldic shield crest',
  crescent: 'a crescent moon',
  fist: 'a clenched fist raised in defiance',
  flame: 'a rising flame',
  bolt: 'a forked lightning bolt',
  star: 'a single bold five-pointed star',
  star6: 'a bold six-pointed star',
  heart: 'a bold heart',
  anchor: 'a heavy ship anchor',
  ball: 'a football, hexagon panels picked out in shadow',
  cross: 'a bold upright cross',
  ring: 'a heavy ring',
  diamond: 'a cut diamond',
  chevron: 'a bold chevron',
};

/** Single-stand regions only: a picture needs one continuous surface. */
function singleStand(region: Region): Stand | null {
  if (region.stands && region.stands.length > 1) return null;
  if (region.stands && region.stands.length === 1) return region.stands[0];
  return region.stand === 'all' ? null : (region.stand as Stand);
}

export interface HeroOptions {
  /** The user's brief, so the subject is about THEIR club, not a generic bird. */
  brief: string;
  /** The club's crest symbol, when the brief named a club we know. */
  crest?: SymbolName;
}

export interface HeroResult {
  spec: TifoSpec;
  /** How the picture got there: already present, promoted from a symbol, or added. */
  via: 'present' | 'promoted' | 'added';
}

/** The picture's subject, in words an image model can draw. */
export function heroPrompt(symbol: SymbolName | undefined, opts: HeroOptions): string {
  const subject =
    (symbol && SUBJECT[symbol]) ||
    (opts.crest && SUBJECT[opts.crest]) ||
    'the club crest as a single bold emblem';
  // The brief carries the club, the occasion and the mood. Keep it short: the
  // style suffix that follows is long, and a diffusion model weights the front.
  const brief = opts.brief.replace(/\s+/g, ' ').trim().slice(0, 110);
  return brief ? `${subject}, for: ${brief}` : subject;
}

/**
 * Ensure the design has exactly one hero picture. Returns the spec untouched
 * when it already has an image layer.
 */
export function ensureHeroImage(spec: TifoSpec, opts: HeroOptions): HeroResult {
  if (spec.layers.some((l) => l.kind === 'image')) return { spec, via: 'present' };
  const layers = spec.layers.slice();

  // 1) Promote the biggest symbol that owns a stand. The composition survives:
  //    same region, same place in the paint order, same role in the design.
  let bestIdx = -1;
  let bestScale = -1;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.kind !== 'symbol') continue;
    if (!singleStand(l.region)) continue;
    if (l.scaleFrac > bestScale) { bestScale = l.scaleFrac; bestIdx = i; }
  }
  if (bestIdx >= 0) {
    const sym = layers[bestIdx] as Extract<SpecLayer, { kind: 'symbol' }>;
    layers[bestIdx] = {
      kind: 'image',
      id: sym.id,
      region: sym.region,
      prompt: heroPrompt(sym.symbol, opts),
      scaleFrac: Math.max(0.9, sym.scaleFrac),
      fit: 'cover',
      cutout: true,
      dither: false,
      halftone: false,
    };
    return { spec: { ...spec, layers }, via: 'promoted' };
  }

  // 2) No symbol to promote: put the picture on the emptiest stand, so it lands
  //    beside the lettering rather than on top of it.
  const load = new Map<Stand, number>();
  for (const st of STANDS) load.set(st, 0);
  for (const l of layers) {
    if (l.kind === 'fill' || l.kind === 'stripes' || l.kind === 'gradient' || l.kind === 'pattern') continue;
    const st = singleStand(l.region);
    if (st) load.set(st, (load.get(st) ?? 0) + 1);
  }
  // North and south face the camera head-on, so they win ties.
  const order: Stand[] = ['north', 'south', 'west', 'east'];
  let target: Stand = order[0];
  for (const st of order) if ((load.get(st) ?? 0) < (load.get(target) ?? 0)) target = st;

  layers.push({
    kind: 'image',
    id: 'hero-auto',
    region: { stand: target, tier: 'all' },
    prompt: heroPrompt(opts.crest, opts),
    scaleFrac: 0.95,
    fit: 'cover',
    cutout: true,
    dither: false,
    halftone: false,
  });
  return { spec: { ...spec, layers }, via: 'added' };
}
