import type { SeatMap } from './types';

/**
 * Production logistics computations — the paid-tier "execution" layer.
 *
 * All pure functions over the design buffer + seat map, so they run identically
 * in the browser (live preview) and in any server-side export job, and are unit-
 * testable without a DOM. These turn a finished design into the real-world
 * quantities a match-day operation needs: how many cards of each color, how many
 * bags to pack them in, the procurement color spec, and a machine-readable
 * seat-by-seat manifest.
 */

export interface ProductionOptions {
  /** Cards packed per bag for distribution (procurement/logistics knob). */
  cardsPerBag: number;
  /** Display names per palette index (index 0 = empty seat). */
  colorNames?: string[];
}

export const DEFAULT_PRODUCTION: ProductionOptions = { cardsPerBag: 100 };

export interface ColorMetric {
  index: number;
  hex: string;
  name: string;
  /** Number of seats (cards) of this color. */
  cards: number;
  /** Share of all NON-EMPTY cards, 0..1. */
  share: number;
  /** Bags needed at the configured cards-per-bag (ceil). */
  bags: number;
}

export interface ProductionSummary {
  /** Per-color metrics for indices 1..N (empty seat excluded). */
  colors: ColorMetric[];
  /** Total cards to print (all non-empty seats). */
  totalCards: number;
  /** Total empty/unused seats in the geometry. */
  emptySeats: number;
  /** Total bags across all colors. */
  totalBags: number;
  /** Total addressable seats in the stadium. */
  seatCount: number;
}

function colorName(idx: number, hex: string, names?: string[]): string {
  return names?.[idx] ?? (idx === 0 ? 'Empty seat' : `Color ${idx} (${hex})`);
}

/** Count cards per palette index across the whole design. */
export function countByColor(cells: Uint8Array, paletteLength: number): number[] {
  const counts = new Array(paletteLength).fill(0);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c < paletteLength) counts[c]++;
  }
  return counts;
}

/** Full production summary: material counts, shares, and bag estimates. */
export function productionSummary(
  cells: Uint8Array,
  palette: string[],
  opts: ProductionOptions = DEFAULT_PRODUCTION,
): ProductionSummary {
  const perBag = Math.max(1, Math.floor(opts.cardsPerBag));
  const counts = countByColor(cells, palette.length);
  const emptySeats = counts[0] ?? 0;
  let totalCards = 0;
  for (let c = 1; c < palette.length; c++) totalCards += counts[c];

  const colors: ColorMetric[] = [];
  let totalBags = 0;
  for (let c = 1; c < palette.length; c++) {
    const cards = counts[c];
    if (cards === 0) continue; // skip unused palette slots
    const bags = Math.ceil(cards / perBag);
    totalBags += bags;
    colors.push({
      index: c,
      hex: palette[c],
      name: colorName(c, palette[c], opts.colorNames),
      cards,
      share: totalCards > 0 ? cards / totalCards : 0,
      bags,
    });
  }
  // Largest material requirement first — matches how procurement reads it.
  colors.sort((a, b) => b.cards - a.cards);

  return { colors, totalCards, emptySeats, totalBags, seatCount: cells.length };
}

/** Nearest human color family for a hex, for the procurement spec sheet. */
export function colorFamily(hex: string): string {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2 / 255;
  if (max - min < 24) {
    if (light > 0.85) return 'White';
    if (light < 0.15) return 'Black';
    return light > 0.5 ? 'Light grey' : 'Dark grey';
  }
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  const family =
    h < 20 || h >= 340 ? 'Red' :
    h < 45 ? 'Orange' :
    h < 70 ? 'Yellow' :
    h < 160 ? 'Green' :
    h < 200 ? 'Cyan' :
    h < 255 ? 'Blue' :
    h < 290 ? 'Purple' : 'Pink';
  return light < 0.28 ? `Dark ${family.toLowerCase()}` : light > 0.72 ? `Light ${family.toLowerCase()}` : family;
}

/**
 * Seat-by-seat CSV manifest: one row per addressable seat with its stand,
 * section, row, seat number, palette index, hex, and color name. The machine-
 * readable handoff to printers, spreadsheets, or a stadium ops system.
 */
export function seatManifestCsv(
  cells: Uint8Array,
  palette: string[],
  map: SeatMap,
  opts: { colorNames?: string[]; includeEmpty?: boolean; standName?: (meanU: number) => string } = {},
): string {
  const includeEmpty = opts.includeEmpty ?? false;
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const standOf = opts.standName ?? (() => '');
  const rows: string[] = ['stand,section,tier,row,seat,color_index,hex,color_name'];
  for (let i = 0; i < map.count; i++) {
    const idx = cells[i];
    if (idx === 0 && !includeEmpty) continue;
    const hex = idx === 0 ? '' : palette[idx] ?? '';
    const name = colorName(idx, hex, opts.colorNames);
    const stand = standOf(map.uv ? map.uv[i * 2] : 0);
    const section = map.sectionOf[i];
    const tier = map.tierOf[i];
    const row = map.rowOf[i];
    rows.push(
      [esc(stand), section, tier, row, i, idx, hex, esc(name)].join(','),
    );
  }
  return rows.join('\n');
}
