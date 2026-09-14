/**
 * Shipped display faces — the "voices".
 *
 * Every voice is ONE CSS family built from two files: an Arabic face and a Latin
 * face, joined by `unicode-range`. The browser then picks per glyph, so a spec
 * asking for `poster` gets Cairo for Arabic text and Passion One for Latin
 * without the compiler ever inspecting the script.
 *
 * Why ship them at all: before this, fontId mapped to a system stack ("Impact,
 * Arial Black, sans-serif"), so the same design rendered differently on Windows,
 * macOS and Android — and on machines with none of them it silently fell back to
 * a plain grotesque. Bundling removes that variance and buys real display
 * letterforms, including an Arabic display face, which system stacks never had.
 *
 * All faces are SIL Open Font License 1.1 (see each package's LICENSE), which
 * permits commercial use, embedding and redistribution.
 *
 * Browser-only: it imports .woff2 through the bundler and registers FontFaces on
 * the document. The voice NAMES live in core/tifoVoices, which Node can import. Everything that renders
 * text to seats must await `loadTifoFonts()` first, because canvas measureText
 * silently falls back to a default face for a font that has not loaded yet.
 */

import { TIFO_VOICES } from './tifoVoices';

import cairoAr from '@fontsource/cairo/files/cairo-arabic-900-normal.woff2';
import passionLat from '@fontsource/passion-one/files/passion-one-latin-900-normal.woff2';
import kufamAr from '@fontsource/kufam/files/kufam-arabic-900-normal.woff2';
import kufamLat from '@fontsource/kufam/files/kufam-latin-900-normal.woff2';
import notoKufiAr from '@fontsource/noto-kufi-arabic/files/noto-kufi-arabic-arabic-900-normal.woff2';
import antonLat from '@fontsource/anton/files/anton-latin-400-normal.woff2';
import almaraiAr from '@fontsource/almarai/files/almarai-arabic-800-normal.woff2';
import alfaSlabLat from '@fontsource/alfa-slab-one/files/alfa-slab-one-latin-400-normal.woff2';
import changaAr from '@fontsource/changa/files/changa-arabic-800-normal.woff2';
import bungeeLat from '@fontsource/bungee/files/bungee-latin-400-normal.woff2';
import tajawalAr from '@fontsource/tajawal/files/tajawal-arabic-900-normal.woff2';
import archivoBlackLat from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2';

/** Codepoints routed to the Arabic half of a voice. */
const ARABIC_RANGE =
  'U+0600-06FF, U+0750-077F, U+0870-088E, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F';

/** Voice id → the two files that make up its family. */
const FILES: Record<string, { arabic: string; latin: string }> = {
  poster: { arabic: cairoAr, latin: passionLat },
  kufi: { arabic: kufamAr, latin: kufamLat },
  condensed: { arabic: notoKufiAr, latin: antonLat },
  slab: { arabic: almaraiAr, latin: alfaSlabLat },
  sign: { arabic: changaAr, latin: bungeeLat },
  grotesk: { arabic: tajawalAr, latin: archivoBlackLat },
};

let loading: Promise<void> | null = null;

/**
 * Register and load every voice. Idempotent and safe to await repeatedly — the
 * first call does the work and the rest share its promise. Never rejects: a face
 * that fails to load just falls back, which is worse-looking but not broken.
 */
export function loadTifoFonts(): Promise<void> {
  if (loading) return loading;
  if (typeof document === 'undefined' || !document.fonts) return (loading = Promise.resolve());

  loading = (async () => {
    const faces: FontFace[] = [];
    for (const v of TIFO_VOICES) {
      const f = FILES[v.id];
      if (!f) continue;
      faces.push(new FontFace(v.family, `url(${f.arabic}) format("woff2")`, { unicodeRange: ARABIC_RANGE, display: 'block' }));
      faces.push(new FontFace(v.family, `url(${f.latin}) format("woff2")`, { display: 'block' }));
    }
    await Promise.all(
      faces.map(async (f) => {
        try {
          document.fonts.add(await f.load());
        } catch {
          /* one missing face must not take the others down */
        }
      }),
    );
  })();
  return loading;
}
