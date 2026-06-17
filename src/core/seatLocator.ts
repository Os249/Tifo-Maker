/**
 * Seat locator for the match-day QR flow.
 *
 * A fan scans one stadium-wide QR, lands on a mobile page, and picks their
 * physical location: Section → Row → Seat. This module turns the parametric
 * SeatMap into the option lists for those pickers and resolves a selection back
 * to the single cell index, so the page can read cells[index] → card colour.
 *
 * It's pure/DOM-free (built from the deterministic SeatMap), so the QR page can
 * regenerate the map client-side from the template id and do every lookup
 * locally — no per-seat data is ever stored server-side.
 *
 * Human-facing labels:
 *   Section  = "<Stand> <n>"  (e.g. "North 3"), derived from sectionOf + the bowl
 *              perimeter position (u). 28 sections → 4 stands × 7 each.
 *   Row      = tier + row index, labelled "Lower 12" / "Upper 4".
 *   Seat     = 1-based position within that (section,row), left→right.
 */

import type { SeatMap } from './types';

export interface SeatChoice {
  section: number; // sectionOf value
  tier: number;
  row: number; // rowOf value (global row index within tier-space)
  seatInRow: number; // 1-based
}

const STANDS = ['North', 'East', 'South', 'West'];

/** Human label for a section id, given how many sections the bowl has. */
export function sectionLabel(section: number, sectionCount: number): string {
  const perStand = Math.max(1, Math.round(sectionCount / STANDS.length));
  const stand = STANDS[Math.min(STANDS.length - 1, Math.floor(section / perStand))];
  const within = (section % perStand) + 1;
  return `${stand} ${within}`;
}

/** All section ids present in the map, ascending. */
export function listSections(map: SeatMap): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < map.count; i++) seen.add(map.sectionOf[i]);
  return [...seen].sort((a, b) => a - b);
}

/** Rows available in a section, as {tier,row,label}, ordered front→back. */
export function listRows(map: SeatMap, section: number): { tier: number; row: number; label: string }[] {
  const seen = new Map<string, { tier: number; row: number }>();
  for (let i = 0; i < map.count; i++) {
    if (map.sectionOf[i] !== section) continue;
    const key = `${map.tierOf[i]}:${map.rowOf[i]}`;
    if (!seen.has(key)) seen.set(key, { tier: map.tierOf[i], row: map.rowOf[i] });
  }
  const rows = [...seen.values()].sort((a, b) => a.tier - b.tier || a.row - b.row);
  // Number rows within each tier starting at 1 for a friendly label.
  const tierFirstRow = new Map<number, number>();
  for (const r of rows) if (!tierFirstRow.has(r.tier)) tierFirstRow.set(r.tier, r.row);
  return rows.map((r) => ({
    ...r,
    label: `${r.tier === 0 ? 'Lower' : 'Upper'} ${r.row - (tierFirstRow.get(r.tier) ?? 0) + 1}`,
  }));
}

/** Cell indices in a (section,tier,row), ordered left→right by perimeter u. */
function seatsInRow(map: SeatMap, section: number, tier: number, row: number): number[] {
  const seats: number[] = [];
  for (let i = 0; i < map.count; i++) {
    if (map.sectionOf[i] === section && map.tierOf[i] === tier && map.rowOf[i] === row) seats.push(i);
  }
  seats.sort((a, b) => map.uv[a * 2] - map.uv[b * 2]);
  return seats;
}

/** How many seats are in a (section,tier,row) — for the seat-number picker max. */
export function seatCountInRow(map: SeatMap, section: number, tier: number, row: number): number {
  return seatsInRow(map, section, tier, row).length;
}

/** Resolve a fan's full choice to the single cell index, or -1 if out of range. */
export function resolveSeat(map: SeatMap, choice: SeatChoice): number {
  const seats = seatsInRow(map, choice.section, choice.tier, choice.row);
  const idx = choice.seatInRow - 1;
  return idx >= 0 && idx < seats.length ? seats[idx] : -1;
}
