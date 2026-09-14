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
    // Arabic + an outline pair + a wide crest. Half the audience writes Arabic
    // briefs and the old gallery had none, so the model had nothing to copy.
    brief: 'الهلال بطل آسيا — تيفو يملأ الملعب كله',
    spec: {
      title: 'زعيم آسيا',
      summary: 'Blue sweep wrapping the bowl, a gold-edged headline filling one end, a wide crescent opposite.',
      palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37', '#001d5c', '#2f7bee'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [5, 1, 4, 1], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        { kind: 'text', region: 'south', text: 'زعيم آسيا', colorIndex: 3, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: 5 },
        { kind: 'text', region: 'south', text: 'زعيم آسيا', colorIndex: 1, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center' },
        { kind: 'fill', region: 'north', colorIndex: 4 },
        { kind: 'symbol', region: 'north', symbol: 'crescent', colorIndex: 3, scaleFrac: 0.95, align: 'center', wide: 1.5 },
        { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'horizontal', bands: 13 },
      ],
    },
  },
  {
    // Portrait on an END, not a side — the camera sees the ends head-on. Plus
    // the index-0 frame, row bands either side of the tier gap, and a shadow.
    brief: "Farewell to our captain's last game — his portrait, his years, black and gold.",
    spec: {
      title: 'Grazie Capitano',
      summary: 'Portrait filling one end; the farewell framed in bare seats on the other.',
      palette: ['#262a33', '#0d0d0f', '#f5c518', '#ffffff', '#3a2f08'],
      layers: [
        { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'image', region: 'north', prompt: 'graphic poster portrait of a veteran football captain, flat poster tones', scaleFrac: 0.95, dither: true, halftone: true },
        { kind: 'fill', region: 'south', colorIndex: 0 },
        { kind: 'fill', region: { stand: 'south', tier: 'all', rows: [0.07, 0.93] }, colorIndex: 2 },
        { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.1, 0.62] }, text: 'CAPITANO', colorIndex: 4, fontId: 'condensed', arcDeg: 0, heightFrac: 0.92, align: 'center', outline: 5, dx: 1, dy: 7 },
        { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.1, 0.62] }, text: 'CAPITANO', colorIndex: 1, fontId: 'condensed', arcDeg: 0, heightFrac: 0.92, align: 'center' },
        { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.7, 0.9] }, text: 'GRAZIE · 2009 — 2026', colorIndex: 1, fontId: 'condensed', arcDeg: 0, heightFrac: 0.66, align: 'center' },
      ],
    },
  },
  {
    // The worked answer to "two glyphs cannot fill a stand": stretch a number.
    brief: 'Club centenary: festive green and gold mosaic, giant 100, founding years.',
    spec: {
      title: 'One Hundred Years',
      summary: 'Checker mosaic across the bowl, a stretched 100 on one end above the founding years, a wide shield opposite.',
      palette: ['#262a33', '#00843d', '#ffffff', '#ffd200', '#013d1d'],
      layers: [
        { kind: 'pattern', region: 'all', pattern: 'checker', colors: [1, 4], scale: 28 },
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'text', region: { stand: 'north', tier: 'all', rows: [0.06, 0.6] }, text: '100', colorIndex: 2, fontId: 'slab', arcDeg: 0, heightFrac: 0.95, align: 'center', stretch: 3, outline: 2 },
        { kind: 'text', region: { stand: 'north', tier: 'all', rows: [0.06, 0.6] }, text: '100', colorIndex: 3, fontId: 'slab', arcDeg: 0, heightFrac: 0.95, align: 'center', stretch: 3 },
        { kind: 'text', region: { stand: 'north', tier: 'all', rows: [0.7, 0.92] }, text: '1925 — 2025', colorIndex: 2, fontId: 'slab', arcDeg: 0, heightFrac: 0.95, align: 'center', stretch: 1.4 },
        { kind: 'fill', region: 'south', colorIndex: 3 },
        { kind: 'symbol', region: 'south', symbol: 'shield', colorIndex: 1, scaleFrac: 0.95, align: 'center', wide: 1.5 },
      ],
    },
  },
  {
    // Two words + the heaviest voice + stretch. One idea, three values.
    brief: 'Derby against our rivals — make the whole ground feel like a threat, red and white.',
    spec: {
      title: 'This Is Our City',
      summary: 'Crimson bowl, a white claim filling one end, a raised fist opposite, diagonal bands down the sides.',
      palette: ['#262a33', '#c8102e', '#ffffff', '#5c0713', '#111318'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [3, 1, 4, 1], direction: 'horizontal' },
        { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'diagonal', bands: 9 },
        { kind: 'fill', region: 'south', colorIndex: 1 },
        { kind: 'text', region: 'south', text: 'OUR CITY', colorIndex: 4, fontId: 'sign', arcDeg: 0, heightFrac: 0.8, align: 'center', stretch: 1.6, outline: 4 },
        { kind: 'text', region: 'south', text: 'OUR CITY', colorIndex: 2, fontId: 'sign', arcDeg: 0, heightFrac: 0.8, align: 'center', stretch: 1.6 },
        { kind: 'fill', region: 'north', colorIndex: 4 },
        { kind: 'symbol', region: 'north', symbol: 'fist', colorIndex: 2, scaleFrac: 0.95, align: 'center', wide: 1.5 },
      ],
    },
  },
];


/**
 * Render the gallery as a compact few-shot block for the director's prompt:
 * each example is "brief → minified JSON". Minified to keep token cost down.
 */
export function fewShotBlock(): string {
  const parts = [
    'Study these example full-stadium designs (brief, then the JSON), then design in the same spirit.',
    'They are examples of STRUCTURE and craft, not of content: never reuse their words, palettes or titles.',
  ];
  SUPER_AI_EXEMPLARS.forEach((ex, i) => {
    parts.push(`\nExample ${i + 1}: ${ex.brief}\n${JSON.stringify(ex.spec)}`);
  });
  return parts.join('\n');
}
