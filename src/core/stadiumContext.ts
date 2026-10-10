/**
 * Stadium context — a compact, model-readable summary of a SeatMap's geometry.
 *
 * The Super AI "director" (Phase 2) plans a whole-bowl choreography, so it needs
 * to understand the venue it is designing for: how many seats each stand holds,
 * how many tiers and rows, how wide/tall each stand is, and the few geometric
 * facts that affect composition (the u=0 seam, which stands face each other).
 *
 * This module turns the engine's already-computed per-seat geometry (uv, tierOf,
 * rowOf) into that summary. It is pure and DOM-free — it runs in the browser, in
 * the server's planning endpoint, and in tests — and reads the SAME stand
 * bucketing the compiler uses (standIndexOfU), so "north" here is "north" there.
 *
 * Phase 1 deliverable: nothing consumes this yet; it is the foundation the
 * director prompt is built on. No model spend, no rendering, no UI change.
 */

import type { SeatMap } from './types';
import { STAND_ORDER, standIndexOfU, type Stand } from './tifoSpec';

export interface StandSummary {
  stand: Stand;
  /** Seats in this stand. */
  seats: number;
  /** Tier indices present in this stand, ascending. */
  tiers: number[];
  /** Distinct rows spanned by this stand. */
  rows: number;
  /** Widest row's seat count (≈ horizontal resolution available). */
  cols: number;
  /** cols / rows — >1 is wide (typical), <1 is tall. */
  aspect: number;
  /** Fraction of the whole bowl's seats (0..1). */
  share: number;
  /**
   * Rows in the MIDDLE of the stand, where centred art lands — the height a
   * word or crest really gets. Lower than `rows` when the stand's quarter
   * only catches its neighbours' corners in some rows.
   */
  artRows: number;
}

export interface StadiumContext {
  /** Total seats in the bowl. */
  total: number;
  /** Number of tiers. */
  tiers: number;
  /** One summary per stand, in perimeter order (east, north, west, south). */
  stands: StandSummary[];
  /** Geometric facts that affect composition, as short human-readable notes. */
  notes: string[];
}

/** Build a structured geometry summary from a seat map. Pure; O(seats). */
export function buildStadiumContext(map: SeatMap): StadiumContext {
  const acc = STAND_ORDER.map((stand) => ({
    stand,
    seats: 0,
    tiers: new Set<number>(),
    rowSet: new Set<number>(),
    coreRows: new Set<number>(),
    rowCounts: new Map<number, number>(),
  }));
  const CENTRE = [0, 0.25, 0.5, 0.75];

  let maxTier = 0;
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    const si = ((standIndexOfU(u) % 4) + 4) % 4; // defensive clamp to 0..3
    const s = acc[si];
    s.seats++;
    const t = map.tierOf[i];
    if (t > maxTier) maxTier = t;
    s.tiers.add(t);
    const r = map.rowOf[i];
    s.rowSet.add(r);
    let d = u - CENTRE[si];
    d -= Math.round(d);
    if (Math.abs(d) <= 0.08) s.coreRows.add(r);
    s.rowCounts.set(r, (s.rowCounts.get(r) ?? 0) + 1);
  }

  const total = map.count;
  const denom = total || 1;
  const stands: StandSummary[] = acc.map((s) => {
    const rows = s.rowSet.size || 1;
    let cols = 0;
    for (const c of s.rowCounts.values()) if (c > cols) cols = c;
    return {
      stand: s.stand,
      seats: s.seats,
      tiers: [...s.tiers].sort((a, b) => a - b),
      rows,
      cols,
      aspect: Math.round((cols / rows) * 100) / 100,
      share: Math.round((s.seats / denom) * 1000) / 1000,
      artRows: s.coreRows.size,
    };
  });

  const notes = [
    'Stands are disjoint quarters of the perimeter, in order East, North, West, South.',
    'The East stand straddles the u=0 seam, art that must read across the seam needs care.',
    'East and West are the long sides facing each other; North and South are the ends facing each other.',
  ];

  return { total, tiers: maxTier + 1, stands, notes };
}


/**
 * What one stand can hold, in the terms the art is judged in: rows of seats.
 * A word needs about 8 rows of glyph to read (Arabic 12), a crest about 12
 * (measured: scripts/ai-text-rows.mts); a stand is a missing one or a sliver
 * when it has next to no seats compared with the biggest.
 */
export function standCapacity(s: StandSummary, biggest: number): string {
  if (s.seats === 0) return 'NO SEATS: place nothing here';
  if (s.seats < Math.max(150, biggest * 0.15) || s.artRows < 5) return 'a SLIVER: colour only, no words or symbols';
  const r = s.artRows;
  if (r < 12) return `SHALLOW (${r} rows): ONE short Latin word at heightFrac 0.9, no row bands, no Arabic`;
  if (r < 21) return `SHALLOW (${r} rows): ONE element (a word OR a symbol) at heightFrac/scaleFrac 0.9, no row bands`;
  if (r < 34) return `${r} rows: a symbol over a word fits; keep each in its own row band`;
  return `${r} rows: room for a hero and a supporting line`;
}

/**
 * Render the context as a compact text block for the director's prompt. Kept
 * terse (few tokens) but complete enough to plan a coherent multi-stand scene.
 */
export function describeStadiumContext(ctx: StadiumContext): string {
  const lines: string[] = [];
  const real = ctx.stands.filter((s) => s.seats > 0).length;
  const biggest = Math.max(1, ...ctx.stands.map((s) => s.seats));
  lines.push(`Stadium: ${ctx.total.toLocaleString()} seats, ${ctx.tiers} tier(s), ${real} stand(s) with seats.`);
  for (const s of ctx.stands) {
    const pct = Math.round(s.share * 100);
    const shape = s.aspect >= 1.6 ? 'wide' : s.aspect <= 0.8 ? 'tall' : 'squarish';
    lines.push(
      `- ${s.stand}: ${s.seats.toLocaleString()} seats (${pct}%), ~${s.rows} rows x ~${s.cols} cols, ` +
        `aspect ${s.aspect} (${shape}), ${s.tiers.length === 1 ? 'tier' : 'tiers'} ${s.tiers.join(' and ') || 'none'}. Holds: ${standCapacity(s, biggest)}.`,
    );
  }
  lines.push('Rows are the limit: glyph rows = heightFrac x the stand\'s rows. A word must reach 8 rows (Arabic 12), a symbol 12.');
  lines.push('Write regions exactly as the names above: "north", or {"stand":"north","tier":0} (one tier number, or "all").');
  for (const note of ctx.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
}
