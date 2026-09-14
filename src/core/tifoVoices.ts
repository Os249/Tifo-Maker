/**
 * The display "voices" — pure metadata, no assets.
 *
 * A voice is ONE family covering Arabic and Latin, so a spec asking for
 * `poster` gets Cairo for Arabic text and Passion One for Latin without the
 * compiler ever inspecting the script. This module holds only the names, so it
 * imports in Node (tests, scripts, the server) as well as in the browser; the
 * font files and the loader live in core/tifoFonts, which is browser-only
 * because it imports .woff2 assets through the bundler.
 *
 * All faces are SIL Open Font License 1.1 — commercial use, embedding and
 * redistribution are permitted. Each package ships its own LICENSE.
 */

export interface TifoVoice {
  /** Spec `fontId`. */
  id: string;
  /** CSS family name the two faces register under. */
  family: string;
  /** Shown in the font picker. */
  name: string;
  /** The Arabic face and the Latin face, for documentation. */
  pair: string;
  /** One line on when to reach for it. */
  note: string;
}

export const TIFO_VOICES: TifoVoice[] = [
  { id: 'poster', family: 'TifoPoster', name: 'Poster', pair: 'Cairo 900 · Passion One',
    note: 'Widest and loudest — a two-word phrase reaches the edges of a stand.' },
  { id: 'kufi', family: 'TifoKufi', name: 'Kufi', pair: 'Kufam 900 (both scripts)',
    note: 'Geometric kufi drawn for both scripts by one hand, so they never disagree.' },
  { id: 'condensed', family: 'TifoCondensed', name: 'Condensed', pair: 'Noto Kufi Arabic 900 · Anton',
    note: 'Narrow enough to fit a whole sentence across one stand.' },
  { id: 'slab', family: 'TifoSlab', name: 'Slab', pair: 'Almarai 800 · Alfa Slab One',
    note: 'Serifs thick enough to survive the seat grid. Anniversaries and years.' },
  { id: 'sign', family: 'TifoSign', name: 'Signage', pair: 'Changa 800 · Bungee',
    note: 'Heaviest in the set — two words maximum before the strokes close up.' },
  { id: 'grotesk', family: 'TifoGrotesk', name: 'Grotesk', pair: 'Tajawal 900 · Archivo Black',
    note: 'The neutral default. Carries a club name in either script without editorialising.' },
];
