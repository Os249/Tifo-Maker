/**
 * Super AI few-shot gallery — curated, hand-authored multi-stand exemplars.
 *
 * These are NOT shown to users; they are fed to the Super AI "director" as
 * few-shot examples so it learns the house style and, crucially, how to compose
 * across the WHOLE bowl using the multi-stand region shorthands (sides/ends and
 * { stands: [...] }). Each spec is the exact JSON the model should emit (no
 * version/ids — the validator fills those), so they double as a living contract.
 *
 * Curated content only (our own designs, described in words) → zero IP/legal
 * exposure, unlike scraping real tifo photographs. Keep this list tight: every
 * exemplar costs prompt tokens on every Super AI generation.
 *
 * Pure + DOM-free so the server can import it. The verify-superai test asserts
 * every spec here passes validateSpec, so a broken exemplar fails CI, not users.
 */

/** A model-emittable spec (no version/id — validateSpec fills defaults). */
export interface ExemplarSpec {
  title: string;
  summary: string;
  palette: string[];
  background?: number;
  layers: Array<Record<string, unknown>>;
}

export interface Exemplar {
  /** Plain-language brief that would produce this design. */
  brief: string;
  spec: ExemplarSpec;
}

export const SUPER_AI_EXEMPLARS: Exemplar[] = [
  {
    brief: 'Derby night, whole stadium, club red and white, defiant mood.',
    spec: {
      title: 'Pride of the City',
      summary: 'Red hero stand with the crest, white headline opposite, banded sides wrapping the bowl.',
      palette: ['#262a33', '#c8102e', '#ffffff', '#111111'],
      layers: [
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'symbol', region: 'north', symbol: 'shield', colorIndex: 2, scaleFrac: 0.7, align: 'center' },
        { kind: 'fill', region: 'south', colorIndex: 3 },
        { kind: 'text', region: 'south', text: 'PRIDE OF THE CITY', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.5, align: 'center' },
        { kind: 'stripes', region: 'sides', colors: [1, 2], orientation: 'horizontal', bands: 8 },
      ],
    },
  },
  {
    brief: 'Farewell to a legendary captain: portrait hero, his name opposite, solemn blue and gold.',
    spec: {
      title: 'Grazie Capitano',
      summary: 'Portrait fills the west stand; gold name on the east; deep gradient on the ends frames the bowl.',
      palette: ['#262a33', '#0b3d91', '#ffffff', '#d4af37', '#15171c', '#8a8f98'],
      background: 4,
      layers: [
        { kind: 'image', region: 'west', prompt: 'graphic poster portrait of a legendary football captain lifting a trophy, bold flat tones', scaleFrac: 0.95, dither: true },
        { kind: 'text', region: 'east', text: 'GRAZIE CAPITANO', colorIndex: 3, fontId: 'georgia', arcDeg: 0, heightFrac: 0.45, align: 'center' },
        { kind: 'gradient', region: 'ends', colors: [1, 4], direction: 'vertical' },
      ],
    },
  },
  {
    brief: 'Club centenary anniversary: festive green and gold mosaic, giant 100, founding years.',
    spec: {
      title: 'One Hundred Years',
      summary: 'Checker mosaic across the whole bowl, a giant 100 on the north, founding years on the south, stars on the sides.',
      palette: ['#262a33', '#00843d', '#ffffff', '#ffd200'],
      layers: [
        { kind: 'pattern', region: 'all', pattern: 'checker', colors: [1, 2], scale: 28 },
        { kind: 'text', region: 'north', text: '100', colorIndex: 3, fontId: 'black', arcDeg: 0, heightFrac: 0.8, align: 'center' },
        { kind: 'text', region: 'south', text: '1925 – 2025', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.4, align: 'center' },
        { kind: 'symbol', region: 'sides', symbol: 'star', colorIndex: 3, scaleFrac: 0.5, align: 'center' },
      ],
    },
  },
];

/**
 * Render the gallery as a compact few-shot block for the director's prompt:
 * each example is "brief → minified JSON". Minified to keep token cost down.
 */
export function fewShotBlock(): string {
  const parts = ['Study these example full-stadium designs (brief, then the JSON), then design in the same spirit:'];
  SUPER_AI_EXEMPLARS.forEach((ex, i) => {
    parts.push(`\nExample ${i + 1}: ${ex.brief}\n${JSON.stringify(ex.spec)}`);
  });
  return parts.join('\n');
}
