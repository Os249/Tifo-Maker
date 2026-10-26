import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSeatMap } from '../../src/core/seatmap';
import { shippedTemplates } from '../../src/core/stadiumCatalog';
import { noTifoMask } from '../../src/core/venueDetails';
import type { StadiumTemplate } from '../../src/core/types';

/**
 * Every shipped ground's seat count and locked seats, as a table generated
 * from the seat-map generator instead of by running it at every boot
 * (performance plan P1.28, P1.31).
 *
 * The server needs two facts per ground: how many seats it has (a design's
 * cells must be exactly that long, or the save is refused) and which seats
 * never take a card (a royal box: SeatZone.noTifo, cleared on every save).
 * Both came from generating the full seat map, all 104 of them at boot just to
 * count, 21-31 s against Railway's 30 s healthcheck, and again on the first
 * save on each ground (up to 1.3 s) to find its royal box.
 *
 * The table cannot drift from the generator:
 *  - the Docker build writes it fresh, from the same code, before the image is
 *    made (`npm run build:server`);
 *  - test:deploy regenerates every ground and compares, so a stale copy in the
 *    repository fails CI;
 *  - each row carries a fingerprint of the ground's definition, checked when
 *    the row is used: a ground that changed, a missing row or a table that
 *    cannot be read is generated on the spot, as before, and said so.
 * Counts are never taken from anywhere else: no request, no client, no env.
 */

export interface SeatTableEntry {
  /** `${id}@${version}` */
  key: string;
  id: string;
  version: number;
  name: string;
  seats: number;
  /** Seats that never take a card, as [start, end) runs of seat indices, ascending. */
  locked: [number, number][];
  /** A hash of the ground's definition the row was generated from. */
  fp: string;
}

export const SEAT_TABLE_FORMAT = 1;
/** Next to the server's other data: server/data, from server/src under tsx and from server/build when bundled. */
export const SEAT_TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../data/seat-table.json');

/**
 * A hash of a ground's definition, with every fractional number cut to 10
 * significant figures first. A definition holds stations worked out with
 * Math.cos, Math.pow and the like, and those are not exact to the last digit:
 * Node 22, Node 24 and Chrome disagree in the 15th or 16th figure (Camp Nou's
 * 106.83979883624355 is 106.83979883624353 on Node 24). Hashed raw, the table
 * written on one Node read as stale on another, so CI (Node 24) failed on a
 * table written on Node 22. Ten figures is a tenth of a micrometre on a
 * hundred-metre stand: any real change to a ground still changes the hash.
 */
export function templateFingerprint(t: StadiumTemplate): string {
  const steady = JSON.stringify(t, (_k, v: unknown) => (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toPrecision(10)) : v));
  return createHash('sha256').update(steady).digest('base64url').slice(0, 22);
}

/** The runs of 1s in a mask, as [start, end). */
export function maskRuns(mask: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i] !== 0;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

/** One ground's row, generated: the slow way, and the only source of the numbers. */
export function generateSeatEntry(t: StadiumTemplate): SeatTableEntry {
  const map = generateSeatMap(t);
  const mask = noTifoMask(map, t);
  return { key: `${t.id}@${t.version}`, id: t.id, version: t.version, name: t.name, seats: map.count, locked: mask ? maskRuns(mask) : [], fp: templateFingerprint(t) };
}

/** Every shipped ground, generated. What the build writes and the deploy test compares against. */
export function generateSeatTable(templates: StadiumTemplate[] = shippedTemplates()): SeatTableEntry[] {
  return templates.map(generateSeatEntry);
}

/** The file: one ground per line, so a change reads as a change to that ground. */
export function formatSeatTable(entries: SeatTableEntry[]): string {
  return `{"format":${SEAT_TABLE_FORMAT},"grounds":[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
}

/** A row as it must be, or null. Anything else in the file is ignored, never trusted. */
function validEntry(v: unknown): SeatTableEntry | null {
  const e = v as Partial<SeatTableEntry> | null;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !Number.isInteger(e.version) || e.key !== `${e.id}@${e.version}`) return null;
  if (typeof e.name !== 'string' || typeof e.fp !== 'string' || !e.fp) return null;
  if (!Number.isInteger(e.seats) || (e.seats as number) <= 0 || (e.seats as number) > 1_000_000) return null;
  if (!Array.isArray(e.locked)) return null;
  let last = 0;
  for (const r of e.locked) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) return null;
    if (r[0] < last || r[1] <= r[0] || r[1] > (e.seats as number)) return null;
    last = r[1];
  }
  return e as SeatTableEntry;
}

/** The table on disk, by key, or null when it is missing or not a table. */
export function readSeatTable(path: string): Map<string, SeatTableEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const p = parsed as { format?: unknown; grounds?: unknown } | null;
  if (!p || p.format !== SEAT_TABLE_FORMAT || !Array.isArray(p.grounds)) return null;
  const out = new Map<string, SeatTableEntry>();
  for (const g of p.grounds) {
    const e = validEntry(g);
    if (e) out.set(e.key, e);
  }
  return out;
}

/**
 * Rows for grounds, from the table when its row was generated from the same
 * definition, generated otherwise. Read once, lazily; each answer remembered.
 */
export class SeatTable {
  private file: Map<string, SeatTableEntry> | null | undefined;
  private rows = new Map<string, SeatTableEntry>();
  private generated: string[] = [];

  constructor(
    private readonly path: string = SEAT_TABLE_PATH,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** The row for one ground. */
  entry(t: StadiumTemplate): SeatTableEntry {
    const key = `${t.id}@${t.version}`;
    const known = this.rows.get(key);
    if (known) return known;
    if (this.file === undefined) this.file = readSeatTable(this.path);
    const hit = this.file?.get(key);
    let row: SeatTableEntry;
    if (hit && hit.fp === templateFingerprint(t) && hit.name === t.name) {
      row = hit;
    } else {
      row = generateSeatEntry(t);
      this.generated.push(t.id);
    }
    this.rows.set(key, row);
    return row;
  }

  /** Every shipped ground's row, saying which ones had to be generated. */
  shipped(): SeatTableEntry[] {
    const out = shippedTemplates().map((t) => this.entry(t));
    if (this.generated.length) {
      this.log(`[tifo] seat table: ${this.generated.length} ground(s) generated at boot (not in ${this.path}, or changed since it was written): ${this.generated.join(', ')}. Run \`npm run seats:table\`.`);
    }
    return out;
  }

  /** Locked seat runs for a shipped ground, or null for a ground that is not shipped. */
  lockedRuns(templateId: string, version: number): readonly [number, number][] | null {
    const t = shippedTemplates().find((x) => x.id === templateId && x.version === version);
    return t ? this.entry(t).locked : null;
  }

  /** Which grounds were generated rather than read (tests, the boot line). */
  generatedIds(): readonly string[] {
    return this.generated;
  }
}

/** The process's table, at the path the build writes it to. */
export const seatTable = new SeatTable();
