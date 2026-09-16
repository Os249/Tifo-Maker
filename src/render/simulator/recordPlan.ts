/**
 * How big a recorded clip is allowed to be, and what that implies.
 *
 * Pure arithmetic, deliberately in its own file. MediaRecorder's
 * `videoBitsPerSecond` is the one setting that actually decides a clip's size —
 * duration times bitrate is the file, near enough — so it is worth being able to
 * test it without a browser, a GPU or a real recording. (The end-to-end harness
 * `scripts/record-size.mts` does record for real, but under software rendering
 * the canvas barely repaints, so its absolute numbers are far below what real
 * hardware produces. It can prove the cap is never exceeded; it cannot tell you
 * what a clip weighs on a real machine. This can.)
 *
 * The recorder used to ask for a flat 8 Mbps. That is not a quality setting, it
 * is a multiplication: nine seconds at 8 Mbps is nine megabytes every time,
 * whatever the clip contained.
 */

/**
 * The size a shared clip has to fit in.
 *
 * Not a round number chosen for tidiness: it is under the point where the
 * messaging apps people actually post these to stop attaching the file as-is and
 * re-encode it themselves, which costs far more picture than encoding it
 * properly on our side would.
 */
export const RECORD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `videoBitsPerSecond` is a target AVERAGE for a variable-rate encoder, and a
 * variable-rate encoder spends over the average on the busy frames — here, the
 * confetti burst. This margin is what stops "about 5 MB" arriving as 5.4, and it
 * also covers the WebM container's own overhead.
 */
const VBR_MARGIN = 0.88;

/** Below this, VP9 starts smearing a crowd of 60,000 into blocks. */
const FLOOR_BPS = 1_200_000;

/**
 * Never above what the recorder used to ask for. A bigger budget should not make
 * a short clip heavier than it was before the budget existed.
 */
const CEILING_BPS = 8_000_000;

/**
 * Below this many bits per second, 30 fps is spreading the budget too thin and
 * the frame rate should give way first. See `fps` in the return value.
 */
const THIN_BPS = 2_600_000;

export interface RecordPlan {
  bitsPerSecond: number;
  /**
   * The frame rate to actually record at.
   *
   * When the per-frame budget gets thin this steps down and the RESOLUTION never
   * does. The same total bits over 24 frames instead of 30 is 25% more bits in
   * each one, and a slow camera move at 24 fps is hard to tell from 30 — whereas
   * a soft, blocky crowd is obvious in a single still.
   */
  fps: number;
  /** What the clip should weigh, if the encoder hits its target exactly. */
  estimatedBytes: number;
  /** True when the floor stopped us hitting the budget, so it may overshoot. */
  overBudget: boolean;
}

export function recordingPlan(opts: { seconds: number; fps?: number; maxBytes?: number }): RecordPlan {
  const seconds = Math.max(1, Math.round(opts.seconds));
  const budget = Math.max(512 * 1024, opts.maxBytes ?? RECORD_MAX_BYTES);
  const wanted = Math.floor((budget * 8 * VBR_MARGIN) / seconds);
  const fps = wanted < THIN_BPS && (opts.fps ?? 30) > 24 ? 24 : (opts.fps ?? 30);
  const bitsPerSecond = Math.max(FLOOR_BPS, Math.min(CEILING_BPS, wanted));
  return {
    bitsPerSecond,
    fps,
    estimatedBytes: Math.round((bitsPerSecond * seconds) / 8),
    overBudget: bitsPerSecond > wanted,
  };
}
