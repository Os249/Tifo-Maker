/**
 * The Pro voices' font files (core/proVoices), registered as FontFaces.
 *
 * A chunk of its own: core/tifoFonts imports it dynamically (`loadProFonts`),
 * only when something needs a Pro face — the pickers show them (ui/proFonts),
 * or a text layer or a banner in the design uses one. The editor's start, and
 * every page whose design uses no Pro voice, never download a byte of it.
 *
 * One weight per face and only the Arabic and Latin subsets, joined into one
 * family per voice by `unicode-range`, exactly like the shipped voices. Each
 * voice loads on its own, so a design that uses one Pro voice fetches two
 * files, not ten. All faces are SIL Open Font License 1.1.
 */
import { ARABIC_RANGE } from './tifoFonts';
import { PRO_VOICES } from './proVoices';

import lalezarAr from '@fontsource/lalezar/files/lalezar-arabic-400-normal.woff2';
import bowlbyLat from '@fontsource/bowlby-one/files/bowlby-one-latin-400-normal.woff2';
import reemKufiAr from '@fontsource/reem-kufi/files/reem-kufi-arabic-700-normal.woff2';
import blackOpsLat from '@fontsource/black-ops-one/files/black-ops-one-latin-400-normal.woff2';
import lemonadaAr from '@fontsource/lemonada/files/lemonada-arabic-700-normal.woff2';
import lemonadaLat from '@fontsource/lemonada/files/lemonada-latin-700-normal.woff2';
import rakkasAr from '@fontsource/rakkas/files/rakkas-arabic-400-normal.woff2';
import rakkasLat from '@fontsource/rakkas/files/rakkas-latin-400-normal.woff2';
import marheyAr from '@fontsource/marhey/files/marhey-arabic-700-normal.woff2';
import marheyLat from '@fontsource/marhey/files/marhey-latin-700-normal.woff2';
import handjetAr from '@fontsource/handjet/files/handjet-arabic-900-normal.woff2';
import handjetLat from '@fontsource/handjet/files/handjet-latin-900-normal.woff2';
import blakaAr from '@fontsource/blaka/files/blaka-arabic-400-normal.woff2';
import blakaLat from '@fontsource/blaka/files/blaka-latin-400-normal.woff2';
import messiriAr from '@fontsource/el-messiri/files/el-messiri-arabic-700-normal.woff2';
import messiriLat from '@fontsource/el-messiri/files/el-messiri-latin-700-normal.woff2';
import ruqaaAr from '@fontsource/aref-ruqaa/files/aref-ruqaa-arabic-700-normal.woff2';
import ruqaaLat from '@fontsource/aref-ruqaa/files/aref-ruqaa-latin-700-normal.woff2';

/** Voice id → the two files that make up its family. */
const FILES: Record<string, { arabic: string; latin: string }> = {
  block: { arabic: lalezarAr, latin: bowlbyLat },
  stencil: { arabic: reemKufiAr, latin: blackOpsLat },
  rounded: { arabic: lemonadaAr, latin: lemonadaLat },
  classic: { arabic: rakkasAr, latin: rakkasLat },
  marker: { arabic: marheyAr, latin: marheyLat },
  pixel: { arabic: handjetAr, latin: handjetLat },
  gothic: { arabic: blakaAr, latin: blakaLat },
  heritage: { arabic: messiriAr, latin: messiriLat },
  ruqaa: { arabic: ruqaaAr, latin: ruqaaLat },
};

const loads = new Map<string, Promise<void>>();

function loadVoice(id: string): Promise<void> {
  const had = loads.get(id);
  if (had) return had;
  const v = PRO_VOICES.find((x) => x.id === id);
  const f = FILES[id];
  if (!v || !f || typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const p = (async () => {
    const faces = [
      new FontFace(v.family, `url(${f.arabic}) format("woff2")`, { unicodeRange: ARABIC_RANGE, display: 'block' }),
      new FontFace(v.family, `url(${f.latin}) format("woff2")`, { display: 'block' }),
    ];
    await Promise.all(
      faces.map(async (face) => {
        try {
          document.fonts.add(await face.load());
        } catch {
          /* one missing face must not take the others down */
        }
      }),
    );
  })();
  loads.set(id, p);
  return p;
}

/**
 * Register and load these Pro voices (all of them when none are named).
 * Idempotent per voice; never rejects: a face that fails falls back, which is
 * worse-looking but not broken.
 */
export function loadProFaces(ids?: readonly string[]): Promise<void> {
  const want = ids ?? PRO_VOICES.map((v) => v.id);
  return Promise.all(want.map(loadVoice)).then(() => undefined);
}
