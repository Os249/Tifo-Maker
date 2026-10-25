/**
 * The colours of a band painted in a club's colours (the home page's closing
 * band): the first of the club's colours that is neither near-white nor
 * near-black is the ground; the ink is another of the club's colours that
 * reads on it at 4.5:1 or better, else near-black or white, whichever reads
 * better. Al Ittihad: yellow with its black. Al Hilal: its blue with white.
 *
 * A mid-tone ground can miss 4.5:1 with both (Al Ettifaq's green, Arsenal's
 * red: white reads at 4.45). Then the ground is deepened, a step at a time,
 * just until white text reads on it: the same colour, a shade darker.
 *
 * Pure and DOM-free.
 */

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export const BAND_DARK = '#0B1220';
export const BAND_LIGHT = '#FFFFFF';

/** The band's ground and ink from a club's colours, strongest first; null without any. */
export function bandColours(palette: readonly string[]): { band: string; ink: string } | null {
  const hexes = palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  if (!hexes.length) return null;
  const band = hexes.find((c) => {
    const l = luminance(c);
    return l >= 0.03 && l <= 0.78;
  }) ?? hexes[0]!;
  const own = hexes.find((c) => c.toLowerCase() !== band.toLowerCase() && contrast(c, band) >= 4.5);
  if (own) return { band, ink: own };
  const ink = contrast(BAND_DARK, band) >= contrast(BAND_LIGHT, band) ? BAND_DARK : BAND_LIGHT;
  if (contrast(ink, band) >= 4.5) return { band, ink };
  let deeper = band;
  for (let k = 0.96; contrast(BAND_LIGHT, deeper) < 4.5 && k > 0.3; k -= 0.04) deeper = shade(band, k);
  return { band: deeper, ink: BAND_LIGHT };
}

/** A #rrggbb colour with each channel scaled by k (below 1 is darker). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = (v: number): string => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}
