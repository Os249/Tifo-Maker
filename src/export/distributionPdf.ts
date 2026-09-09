import { createWriteStream } from 'node:fs';
import PDFDocument from 'pdfkit';
import type { DesignState, SeatMap } from '../core/types';
import { productionSummary, colorFamily } from '../core/production';

/**
 * Phase 4 export: the per-section distribution plan.
 *
 * This is the document that bridges digital design to physical execution —
 * what section stewards actually print and carry on matchday. One cover page
 * with the bowl overview and the purchase list (total cards per color), then
 * one page per section with its bill of materials and a seat-by-seat chart.
 *
 * Charts are drawn from the seats' real editor coordinates, so arcs, ragged
 * row ends, and aisle gaps appear exactly as the steward will see them.
 * Node-only (runs in the export worker / CLI); shares core types with the
 * client, which is the whole reason the worker lives in this codebase.
 */

export interface DistributionMeta {
  designTitle: string;
  stadiumName: string;
  /** Display names for palette indices; index 0 is the empty seat. */
  colorNames?: string[];
  /** Cards packed per bag for the materials estimate. */
  cardsPerBag?: number;
  /** Free tier stamps a watermark; paid tier omits it. */
  watermark?: boolean;
}

const PAGE = { width: 841.89, height: 595.28 }; // A4 landscape
const MARGIN = 40;
const EMPTY_HEX = '#9aa0ad'; // print-friendly stand-gray for unassigned seats

type SectionInfo = {
  id: number;
  seats: number[];
  tier: number;
  stand: string;
  counts: Map<number, number>;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
};

function standName(meanU: number): string {
  if (meanU >= 0.875 || meanU < 0.125) return 'East';
  if (meanU < 0.375) return 'North';
  if (meanU < 0.625) return 'West';
  return 'South';
}

function collectSections(map: SeatMap, cells: Uint8Array): SectionInfo[] {
  const byId = new Map<number, SectionInfo>();
  for (let i = 0; i < map.count; i++) {
    const id = map.sectionOf[i];
    let s = byId.get(id);
    if (!s) {
      s = {
        id,
        seats: [],
        tier: map.tierOf[i],
        stand: '',
        counts: new Map(),
        bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      };
      byId.set(id, s);
    }
    s.seats.push(i);
    s.counts.set(cells[i], (s.counts.get(cells[i]) ?? 0) + 1);
    const x = map.xy[i * 2];
    const y = map.xy[i * 2 + 1];
    if (x < s.bbox.minX) s.bbox.minX = x;
    if (x > s.bbox.maxX) s.bbox.maxX = x;
    if (y < s.bbox.minY) s.bbox.minY = y;
    if (y > s.bbox.maxY) s.bbox.maxY = y;
  }
  for (const s of byId.values()) {
    let uSum = 0;
    for (const i of s.seats) uSum += map.uv[i * 2];
    s.stand = standName(uSum / s.seats.length);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Draw seats batched by color: one fill operation per palette index. */
function drawSeatsBatched(
  doc: PDFKit.PDFDocument,
  map: SeatMap,
  cells: Uint8Array,
  palette: string[],
  seats: number[] | null,
  toPage: (x: number, y: number) => [number, number],
  rectW: number,
  rectH: number,
): void {
  const indices = seats ?? Array.from({ length: map.count }, (_, i) => i);
  for (let color = 0; color < palette.length; color++) {
    let any = false;
    for (const i of indices) {
      if (cells[i] !== color) continue;
      const [px, py] = toPage(map.xy[i * 2], map.xy[i * 2 + 1]);
      doc.rect(px - rectW / 2, py - rectH / 2, rectW, rectH);
      any = true;
    }
    if (any) doc.fill(color === 0 ? EMPTY_HEX : palette[color]);
  }
}

function bomLine(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  hex: string,
  label: string,
  count: number,
): void {
  doc.rect(x, y, 14, 14).fill(hex);
  doc.rect(x, y, 14, 14).stroke('#444444');
  doc
    .fillColor('#111111')
    .font('Helvetica')
    .fontSize(10)
    .text(`${label} - ${count.toLocaleString()} cards`, x + 20, y + 2);
}

export async function renderDistributionPdf(
  design: DesignState,
  map: SeatMap,
  meta: DistributionMeta,
  outPath: string,
): Promise<{ pages: number; sections: number }> {
  const { cells, palette } = design;
  const sections = collectSections(map, cells);
  const colorName = (idx: number): string =>
    meta.colorNames?.[idx] ?? (idx === 0 ? 'Empty seat' : `Color ${idx} (${palette[idx]})`);

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true });
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  // ---------- Cover: title, purchase list, bowl overview ----------
  doc.font('Helvetica-Bold').fontSize(26).fillColor('#111111').text(meta.designTitle, MARGIN, 48);
  doc
    .font('Helvetica')
    .fontSize(12)
    .fillColor('#444444')
    .text(
      `${meta.stadiumName}  ·  ${map.count.toLocaleString()} seats  ·  ${sections.length} sections  ·  distribution plan`,
      MARGIN,
      82,
    );

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Purchase list', MARGIN, 120);
  const totals = new Map<number, number>();
  for (let i = 0; i < map.count; i++) totals.set(cells[i], (totals.get(cells[i]) ?? 0) + 1);
  let ty = 142;
  for (let c = 1; c < palette.length; c++) {
    if (!totals.get(c)) continue;
    bomLine(doc, MARGIN, ty, palette[c], colorName(c), totals.get(c)!);
    ty += 22;
  }
  if (totals.get(0)) {
    bomLine(doc, MARGIN, ty, EMPTY_HEX, 'Unassigned seats', totals.get(0)!);
    ty += 22;
  }

  // Bowl overview: every seat, batched by color, fitted under the list.
  const ovTop = ty + 24;
  const ovH = PAGE.height - MARGIN - ovTop;
  const ovW = PAGE.width - 2 * MARGIN;
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const ovScale = Math.min(ovW / bw, ovH / bh);
  const ovX = MARGIN + (ovW - bw * ovScale) / 2;
  const ovY = ovTop + (ovH - bh * ovScale) / 2;
  doc.font('Helvetica').fontSize(9).fillColor('#777777').text(
    'Bowl overview (unrolled) - North stand at left-center, view from the pitch',
    MARGIN,
    ovY - 14,
  );
  drawSeatsBatched(
    doc,
    map,
    cells,
    palette,
    null,
    (x, y) => [ovX + (x - map.bounds.minX) * ovScale, ovY + (y - map.bounds.minY) * ovScale],
    Math.max(0.5, 3.2 * ovScale * 0.9),
    Math.max(0.9, 8 * ovScale * 0.85),
  );

  // ---------- Materials & color metrics page ----------
  const summary = productionSummary(cells, palette, {
    cardsPerBag: meta.cardsPerBag ?? 100,
    colorNames: meta.colorNames,
  });
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111').text('Materials & color metrics', MARGIN, 44);
  doc.font('Helvetica').fontSize(11).fillColor('#555555').text(
    `Total cards to print: ${summary.totalCards.toLocaleString()}  ·  ` +
      `Bags (@ ${meta.cardsPerBag ?? 100}/bag): ${summary.totalBags.toLocaleString()}  ·  ` +
      `Unused seats: ${summary.emptySeats.toLocaleString()}`,
    MARGIN,
    74,
  );

  // Table header.
  const cols = { swatch: MARGIN, name: MARGIN + 28, family: 300, cards: 470, share: 600, bags: 720 };
  let my = 110;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111');
  doc.text('Color', cols.name, my);
  doc.text('Family', cols.family, my);
  doc.text('Cards', cols.cards, my, { width: 90, align: 'right' });
  doc.text('Share', cols.share, my, { width: 90, align: 'right' });
  doc.text('Bags', cols.bags, my, { width: 80, align: 'right' });
  my += 6;
  doc.moveTo(MARGIN, my + 10).lineTo(PAGE.width - MARGIN, my + 10).strokeColor('#cccccc').lineWidth(0.5).stroke();
  my += 18;

  // One row per color, largest first.
  doc.font('Helvetica').fontSize(10);
  for (const c of summary.colors) {
    doc.rect(cols.swatch, my - 1, 16, 12).fill(c.hex).strokeColor('#999999').lineWidth(0.4).rect(cols.swatch, my - 1, 16, 12).stroke();
    doc.fillColor('#111111').text(`${c.name}`, cols.name, my, { width: 260 });
    doc.fillColor('#555555').text(`${colorFamily(c.hex)}  ·  ${c.hex}`, cols.family, my, { width: 160 });
    doc.fillColor('#111111').text(c.cards.toLocaleString(), cols.cards, my, { width: 90, align: 'right' });
    doc.text(`${(c.share * 100).toFixed(1)}%`, cols.share, my, { width: 90, align: 'right' });
    doc.text(c.bags.toLocaleString(), cols.bags, my, { width: 80, align: 'right' });
    my += 20;
  }
  // Totals row.
  my += 4;
  doc.moveTo(MARGIN, my).lineTo(PAGE.width - MARGIN, my).strokeColor('#cccccc').lineWidth(0.5).stroke();
  my += 10;
  doc.font('Helvetica-Bold').fillColor('#111111');
  doc.text('Total', cols.name, my);
  doc.text(summary.totalCards.toLocaleString(), cols.cards, my, { width: 90, align: 'right' });
  doc.text('100%', cols.share, my, { width: 90, align: 'right' });
  doc.text(summary.totalBags.toLocaleString(), cols.bags, my, { width: 80, align: 'right' });

  doc.font('Helvetica').fontSize(9).fillColor('#888888').text(
    'Color families and hex values are a procurement guide. Confirm physical card stock against a printed sample, screen color differs from print.',
    MARGIN,
    PAGE.height - MARGIN - 16,
    { width: PAGE.width - 2 * MARGIN },
  );

  // ---------- One page per section ----------
  const tierName = (t: number): string => (t === 0 ? 'Lower tier' : 'Upper tier');
  for (const s of sections) {
    doc.addPage();
    const within = s.id % 28;
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#111111')
      .text(`Section ${s.id + 1}`, MARGIN, 42);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#444444')
      .text(
        `${s.stand} stand  ·  ${tierName(s.tier)}  ·  block ${within + 1}  ·  ${s.seats.length.toLocaleString()} seats`,
        MARGIN,
        70,
      );

    // Section bill of materials, horizontal.
    let bx = MARGIN;
    const by = 96;
    const ordered = [...s.counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [c, n] of ordered) {
      bomLine(doc, bx, by, c === 0 ? EMPTY_HEX : palette[c], colorName(c), n);
      bx += 215;
    }

    // Seat chart from real coordinates.
    const chartTop = 134;
    const chartH = PAGE.height - MARGIN - 30 - chartTop;
    const chartW = PAGE.width - 2 * MARGIN - 30; // room for row labels
    const sw = s.bbox.maxX - s.bbox.minX || 1;
    const sh = s.bbox.maxY - s.bbox.minY || 1;
    const scale = Math.min(chartW / sw, chartH / sh);
    const cx = MARGIN + 30 + (chartW - sw * scale) / 2;
    const cy = chartTop + (chartH - sh * scale) / 2;
    const toPage = (x: number, y: number): [number, number] => [
      cx + (x - s.bbox.minX) * scale,
      cy + (y - s.bbox.minY) * scale,
    ];
    drawSeatsBatched(doc, map, cells, palette, s.seats, toPage, 3.2 * scale * 0.78, 8 * scale * 0.78);

    // Row labels every 5 rows at the left edge of the section.
    const rowMinX = new Map<number, { x: number; y: number }>();
    for (const i of s.seats) {
      const r = map.rowOf[i];
      const x = map.xy[i * 2];
      const cur = rowMinX.get(r);
      if (!cur || x < cur.x) rowMinX.set(r, { x, y: map.xy[i * 2 + 1] });
    }
    doc.font('Helvetica').fontSize(7).fillColor('#666666');
    const rowsSorted = [...rowMinX.keys()].sort((a, b) => a - b);
    const baseRow = rowsSorted[0];
    for (const r of rowsSorted) {
      const local = r - baseRow + 1;
      if (local !== 1 && local % 5 !== 0) continue;
      const p = rowMinX.get(r)!;
      const [, py] = toPage(p.x, p.y);
      doc.text(`R${local}`, MARGIN, py - 3, { width: 26, align: 'right' });
    }
    // NOTE: keep y + line height inside the bottom margin — pdfkit auto-adds a
    // page when flowed text crosses it, silently doubling every section.
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor('#777777')
      .text(
        'View from the pitch facing the section - row 1 at the bottom, seats left to right.',
        MARGIN,
        PAGE.height - MARGIN - 14,
        { lineBreak: false },
      );
  }

  // Free-tier watermark across every page (diagonal, low-opacity).
  if (meta.watermark) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.save();
      doc.rotate(-30, { origin: [PAGE.width / 2, PAGE.height / 2] });
      doc.font('Helvetica-Bold').fontSize(52).fillColor('#1c5fd9').opacity(0.10).text(
        'TIFOMAKER  ·  tifomaker.org',
        PAGE.width / 2 - 320,
        PAGE.height / 2 - 26,
        { width: 640, align: 'center', lineBreak: false },
      );
      doc.opacity(1).restore();
    }
  }

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  // Cover + materials page + one per section.
  return { pages: 2 + sections.length, sections: sections.length };
}
