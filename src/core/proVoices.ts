/**
 * The Pro display voices: names only, no assets, no strings.
 *
 * Five more voices, built exactly like the shipped ones (core/tifoVoices): ONE
 * family each, an Arabic face and a Latin face joined by `unicode-range`, so a
 * layer in `block` gets Lalezar for Arabic and Bowlby One for Latin without
 * anything inspecting the script.
 *
 * They are kept OUT of TIFO_VOICES on purpose. The server reads that list to
 * tell the AI designer which voices it may use, and the AI must never start
 * choosing a Pro font for somebody; the spec's font ids (core/tifoSpec) stay
 * the free ones for the same reason.
 *
 * Fonts are assets, not the gate. A design that uses a Pro voice renders in it
 * for anyone who opens it, Pro or not, so everything that turns a font id into
 * CSS (core/text `fontCssOf`) knows these ids too; only the font pickers show
 * them, and only to an account Pro is on for (ui/proFonts.ts). What Pro decides
 * is an export (ui/proGate.ts).
 *
 * The faces load in a chunk of their own (core/proFontFaces), only when
 * something needs them: the pickers show them, or a text layer or a banner in
 * the design uses one (`loadProFonts` in core/tifoFonts). This module is what
 * Node can import (tests, scripts), and what the editor's start can afford.
 *
 * Every face is SIL Open Font License 1.1, from its @fontsource package (each
 * ships its LICENSE); docs/DESIGN.md "Sources and licences" credits them.
 * Picked for the seat grid: heavy strokes and open counters that still read at
 * 20 to 40 rows of seats.
 */
import type { TifoFont } from './text';
import type { TifoVoice } from './tifoVoices';

export const PRO_VOICES: readonly TifoVoice[] = [
  { id: 'block', family: 'TifoProBlock', name: 'Block', pair: 'Lalezar · Bowlby One',
    note: 'The fattest strokes there are: a club name that reads from the far stand.' },
  { id: 'stencil', family: 'TifoProStencil', name: 'Stencil', pair: 'Reem Kufi 700 · Black Ops One',
    note: 'Square Kufi and sprayed stencil letters: terrace attitude.' },
  { id: 'rounded', family: 'TifoProRounded', name: 'Rounded', pair: 'Lemonada 700 (both scripts)',
    note: 'Soft, round and wide, drawn by one hand for both scripts.' },
  { id: 'classic', family: 'TifoProClassic', name: 'Classic', pair: 'Rakkas (both scripts)',
    note: 'Heavy, high-contrast display letters by one hand for both scripts: the old match-programme look. Best from 24 rows up.' },
  { id: 'marker', family: 'TifoProMarker', name: 'Marker', pair: 'Marhey 700 (both scripts)',
    note: 'Hand-cut and playful, like a banner painted the night before.' },
];

/** The Pro voices as fonts: what a picker lists and what a layer's CSS is. */
export const PRO_FONTS: readonly TifoFont[] = PRO_VOICES.map((v) => ({
  id: v.id,
  name: v.name,
  css: `"${v.family}", "Arial Black", sans-serif`,
}));

const IDS: ReadonlySet<string> = new Set(PRO_VOICES.map((v) => v.id));

/** Is this font id one of the Pro voices? */
export function isProVoice(id: string | null | undefined): boolean {
  return typeof id === 'string' && IDS.has(id);
}

/**
 * The Pro voices a design's text uses, once each: layers (`kind: 'text'`) and
 * banner items alike. Cheap enough to run on every change; it is what decides
 * whether the Pro faces are fetched for a design at all.
 */
export function proVoicesIn(items: Iterable<{ kind: string; fontId?: string }>): string[] {
  const out = new Set<string>();
  for (const o of items) if (o.kind === 'text' && isProVoice(o.fontId)) out.add(o.fontId as string);
  return [...out];
}
