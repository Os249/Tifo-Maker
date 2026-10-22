/**
 * Uploading only the seats that changed (performance plan P1.4).
 *
 * The Stadium and Split views keep three per-seat arrays on the GPU: whether
 * a card is up, its colour, and the same "up" flag as a texture for the
 * chairs. Painting one dab used to re-send all three whole, 1.33 MB a frame
 * on the Bernabeu (2.7 MB in Split), for a few hundred seats. three.js can
 * send part of an array (`addUpdateRange`); this works out which parts.
 *
 * The one thing that must never happen is a partial upload of something the
 * GPU does not hold yet, or holds out of date as a whole: the first upload
 * of a texture would then fill only the ranges and leave the rest empty. So
 * a target starts "whole" and stays whole until three says it has uploaded
 * it (the attribute's onUpload, the texture's onUpdate), and anything that
 * recolours every seat makes it whole again.
 */

/** The part of a three.js BufferAttribute or Texture this needs. */
export interface RangedTarget {
  addUpdateRange(start: number, count: number): void;
  clearUpdateRanges(): void;
  readonly updateRanges: readonly unknown[];
}

/** Past this many ranges in one upload, the whole array is cheaper and simpler. */
const MAX_RANGES = 256;
/** Two runs this close together go up as one (fewer GL calls for a few wasted bytes). */
const RUN_GAP = 8;

/**
 * The changed seats as sorted, merged runs: [start0, end0, start1, end1, …],
 * end exclusive. Duplicates and any order are fine.
 */
export function seatRuns(indices: ArrayLike<number>, gap = RUN_GAP): number[] {
  if (indices.length === 0) return [];
  const sorted = Uint32Array.from(indices as ArrayLike<number>).sort();
  const out: number[] = [];
  let a = sorted[0];
  let b = a + 1;
  for (let k = 1; k < sorted.length; k++) {
    const v = sorted[k];
    if (v <= b + gap) {
      if (v + 1 > b) b = v + 1;
      continue;
    }
    out.push(a, b);
    a = v;
    b = v + 1;
  }
  out.push(a, b);
  return out;
}

export class SeatUploads {
  private whole = true;

  /**
   * @param perSeat array elements per seat (1 for a flag, 3 for a colour)
   * @param rowSeats for a texture: seats per row (each range stays inside one row)
   * @param rowUnit for a texture: what three.js counts a pixel as in a range
   *   (it assumes four components, whatever the format; see updateTexture in
   *   three's WebGLTextures)
   */
  constructor(
    private readonly target: RangedTarget,
    private readonly perSeat: number,
    private readonly rowSeats = 0,
    private readonly rowUnit = 4,
  ) {}

  /** Three has sent it: from here on, ranges add to what the GPU holds. */
  uploaded(): void {
    this.whole = false;
  }

  /** The next upload sends everything (every seat was recoloured). */
  all(): void {
    this.whole = true;
    this.target.clearUpdateRanges();
  }

  /** These seats changed (runs from seatRuns). */
  changed(runs: readonly number[]): void {
    if (this.whole) return; // a whole upload is pending anyway
    const t = this.target;
    if (this.rowSeats > 0) {
      // A texture range is a strip of one row: a run that wraps onto the next
      // row is sent as two.
      const W = this.rowSeats;
      for (let k = 0; k < runs.length; k += 2) {
        for (let a = runs[k], b = runs[k + 1]; a < b; ) {
          const e = Math.min(b, (Math.floor(a / W) + 1) * W);
          t.addUpdateRange(a * this.rowUnit, (e - a) * this.rowUnit);
          a = e;
        }
      }
    } else {
      for (let k = 0; k < runs.length; k += 2) {
        t.addUpdateRange(runs[k] * this.perSeat, (runs[k + 1] - runs[k]) * this.perSeat);
      }
    }
    if (t.updateRanges.length > MAX_RANGES) this.all();
  }
}
