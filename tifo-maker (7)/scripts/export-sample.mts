import { mkdirSync } from 'node:fs';
import { generateSeatMap } from '../src/core/seatmap';
import { DEFAULT_PALETTE, DEFAULT_TEMPLATE } from '../src/core/template';
import { renderDistributionPdf } from '../src/export/distributionPdf';
import type { DesignState } from '../src/core/types';

/**
 * Generates a sample design entirely from seat math (no canvas needed in Node):
 * royal-blue base, gold border bands, and "GLORY" in white across the north
 * stand using a 5x7 bitmap font mapped onto (u, row) cells — the same
 * cell-mapping idea the browser image importer uses.
 */

const FONT: Record<string, string[]> = {
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

const map = generateSeatMap(DEFAULT_TEMPLATE);
const cells = new Uint8Array(map.count).fill(1); // blue base

const totalRows = 48;
// Gold bands: bottom/top two rows of each tier.
for (let i = 0; i < map.count; i++) {
  const r = map.rowOf[i];
  if (r <= 1 || r === 24 || r === 25 || r === 26 || r === 27 || r >= totalRows - 2) cells[i] = 3;
}

// "GLORY" across the north stand (u centered on 0.25), both tiers.
const text = 'GLORY';
const colsTotal = text.length * 6 - 1; // 5 glyph cols + 1 spacing, no trailing space
const u0 = 0.25 - 0.11;
const u1 = 0.25 + 0.11;
const rowStart = 6;
const rowsPerCell = 5; // 7 font rows * 5 = 35 seat rows tall
for (let i = 0; i < map.count; i++) {
  const u = map.uv[i * 2];
  if (u < u0 || u >= u1) continue;
  const r = map.rowOf[i];
  const cellY = Math.floor((r - rowStart) / rowsPerCell);
  if (cellY < 0 || cellY > 6) continue;
  const fontRow = 6 - cellY; // row 0 is the lowest seat row; font row 0 is the top
  const cellX = Math.floor(((u - u0) / (u1 - u0)) * colsTotal);
  const letter = Math.floor(cellX / 6);
  const col = cellX % 6;
  if (col === 5) continue; // spacing column
  const glyph = FONT[text[letter]];
  if (glyph[fontRow][col] === '1') cells[i] = 2; // white
}

const design: DesignState = {
  seatMapRef: map.templateRef,
  palette: DEFAULT_PALETTE.slice(0, 4),
  cells,
};

mkdirSync('out', { recursive: true });
const outPath = 'out/glory-distribution-plan.pdf';
const t0 = performance.now();
const result = await renderDistributionPdf(
  design,
  map,
  {
    designTitle: 'GLORY - North Stand Tifo',
    stadiumName: 'Generic 60k bowl (template v1)',
    colorNames: ['Empty seat', 'Royal blue', 'White', 'Gold'],
  },
  outPath,
);
console.log(
  `wrote ${outPath}: ${result.pages} pages (${result.sections} sections) in ${(performance.now() - t0).toFixed(0)} ms`,
);
