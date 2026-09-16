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

/**
 * What container and codec to record in.
 *
 * WebM was the old answer because it was the only one `MediaRecorder` had for
 * years. It is a bad answer for a clip people post: it will not open in
 * QuickTime, most phone galleries refuse it, and several apps reject the upload
 * outright. MP4 is what "a video" means outside a browser.
 *
 * The order below asks for **H.264 by name first**, and that is the whole point
 * rather than a nicety. `isTypeSupported('video/mp4')` answers true in browsers
 * that will then hand back VP9 *inside* an MP4 — a real MP4 container that
 * QuickTime and iOS still will not play, which is the same problem wearing a
 * different extension. Naming the codec gets a straight answer.
 *
 * H.264 is also less efficient than VP9, so the same byte budget buys a slightly
 * softer picture. That is the right trade for a file whose purpose is to be sent
 * to someone.
 */
export interface RecordingFormat {
  /** Pass to the MediaRecorder constructor. */
  mimeType: string;
  /** File extension, without the dot. */
  extension: 'mp4' | 'webm';
  /** True when the result will play anywhere, i.e. H.264 in MP4. */
  universal: boolean;
}

const CANDIDATES: Array<{ mimeType: string; extension: 'mp4' | 'webm'; universal: boolean }> = [
  // H.264 baseline: the profile that plays on everything, including a decade of phones.
  { mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', universal: true },
  { mimeType: 'video/mp4;codecs=avc1.4D401F', extension: 'mp4', universal: true },
  { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4', universal: true },
  { mimeType: 'video/mp4;codecs=h264', extension: 'mp4', universal: true },
  // An MP4 whose codec the browser chooses. Better than WebM for anything that
  // sniffs the container, and worse than H.264 for anything Apple made.
  { mimeType: 'video/mp4', extension: 'mp4', universal: false },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm', universal: false },
  { mimeType: 'video/webm', extension: 'webm', universal: false },
];

/**
 * @param isSupported injected so this is testable in Node, where MediaRecorder
 *   does not exist. Defaults to the real thing in a browser.
 */
export function pickRecordingFormat(isSupported?: (mime: string) => boolean): RecordingFormat | null {
  const can = isSupported
    ?? ((m: string): boolean => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
  for (const c of CANDIDATES) if (can(c.mimeType)) return c;
  return null;
}

/**
 * What the recorder ACTUALLY negotiated, read back off the instance.
 *
 * `MediaRecorder.mimeType` after construction is the only honest source: ask for
 * `video/mp4` in a Chromium built without proprietary codecs and it reports back
 * `video/mp4;codecs=vp9`. Believing the request instead of the reply is how you
 * hand somebody a .mp4 that their phone will not open.
 */
export function describeRecording(negotiated: string, asked: RecordingFormat): RecordingFormat {
  const mime = negotiated || asked.mimeType;
  const extension: 'mp4' | 'webm' = mime.includes('mp4') ? 'mp4' : 'webm';
  const universal = extension === 'mp4' && /avc1|avc3|h264|hev1|hvc1/i.test(mime);
  return { mimeType: mime, extension, universal };
}
