import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

/** The site's own colours (src/ui/tokens.css). */
export const C = {
  night950: '#070B14',
  night900: '#0B1120',
  night800: '#131B2D',
  night500: '#33415C',
  snow: '#F1F4FB',
  mist: '#A6B0C8',
  blue600: '#1C6FE0',
  maker: '#4A92F2',
  gold: '#F5B43C',
  goldTint: 'rgba(245, 180, 60, 0.12)',
  goldLine: 'rgba(245, 180, 60, 0.55)',
  green: '#3FC77F',
};

export const SCARF =
  'repeating-linear-gradient(90deg, #1C6FE0 0 22px, #F1F4FB 22px 30px, #0B1120 30px 52px, #F1F4FB 52px 60px)';

/** The crown: the one mark for everything Pro (src/ui/crown.ts). */
export const CROWN_PATHS = [
  'M3.2 7.6l4.6 3.6 3.4-5.7a.95.95 0 0 1 1.6 0l3.4 5.7 4.6-3.6a.6.6 0 0 1 .96.58L19.9 17H4.1L2.24 8.18a.6.6 0 0 1 .96-.58z',
  'M4.4 18.6h15.2V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z',
];

export const DISPLAY = 'Changa, Inter, sans-serif';
export const UI = 'Inter, Almarai, sans-serif';

/** The site's faces: Changa for headings, Almarai for Arabic, Inter for Latin. */
export const fontsReady = Promise.all(
  (
    [
      ['Changa', 'changa-arabic-700-normal.woff2', '700'],
      ['Changa', 'changa-arabic-800-normal.woff2', '800'],
      ['Almarai', 'almarai-arabic-700-normal.woff2', '700'],
      ['Almarai', 'almarai-arabic-800-normal.woff2', '800'],
      ['Inter', 'inter-latin-700-normal.woff2', '700'],
      ['Inter', 'inter-latin-800-normal.woff2', '800'],
    ] as const
  ).map(([family, file, weight]) => loadFont({ family, url: staticFile(`fonts/${file}`), weight })),
);
