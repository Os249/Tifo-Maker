/**
 * The Pro film: Match Day footage of the tifo, drawn frame by frame off the
 * live loop and encoded to an H.264 MP4 in the browser.
 *
 * A screen recording films what the screen managed to draw: on a phone that
 * is a stutter, and at 1920 × 1080 most phones manage a few frames a second.
 * This draws every frame of the shot (filmPlan.ts) at the film's own size,
 * off screen, with the scene moved on by exactly 1/30 s each frame
 * (MatchDaySimulator.filmHost), and hands each one to WebCodecs' VideoEncoder.
 * However long a frame takes to draw, the file plays smoothly at 30 frames a
 * second, and every phone gets the same film as a desktop, only later.
 *
 * Where there is no VideoEncoder, or no H.264 in it, it films in real time
 * instead, through MediaRecorder as Match Day's own Record does, and says so
 * (`realtime` on the result): on a slow device that file can stutter.
 *
 * The muxer (mp4-muxer, MIT) loads with this module, which loads only when a
 * Pro film is made.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { buildReveal, type RevealId } from '../../core/reveal';
import { DRUM_CALL, seatReaction } from '../../core/drumCall';
import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { BowlBounds, SimShot, TifoFootprint } from './cameras';
import type { RevealMode } from './choreo';
import { FILM_TIMES, planFilm, type FilmPlan, type FilmPlanInput } from './filmPlan';
import { describeRecording, pickRecordingFormat } from './recordPlan';
import { drawCreditLine } from '../../ui/creditLine';
import { FILM_SOUND_RATE, encodeFilmSound, filmSoundCodec, renderFilmSound } from './filmSound';

/** What a film needs of the simulator (MatchDaySimulator.filmHost). */
export interface FilmHost {
  readonly canvas: HTMLCanvasElement;
  readonly template: StadiumTemplate;
  readonly map: SeatMap;
  /** False once the simulator is closed or its context is lost: the film stops. */
  alive(): boolean;
  /** Show or hide the ground's big screens (a poster leaves them out). */
  screens?(show: boolean): void;
  footprint(): TifoFootprint | null;
  bounds(): BowlBounds;
  outerReach(): number;
  /** Every camera, worked out for the picture's current shape (after `begin`, the film's). */
  shots(): SimShot[];
  /** Whether a seat holds a card of the tifo. */
  painted(seat: number): boolean;
  /** The ground's own structure (a roof, a stand) is under `at`: a camera there looks across a building. */
  overRoof(at: [number, number, number]): boolean;
  /** Nothing the ground built stands between `from` and the card at `to`. */
  sees(from: [number, number, number], to: [number, number, number]): boolean;
  /** Stop the live loop and draw at w × h, each frame moving the scene on by 1/fps. */
  begin(w: number, h: number, fps: number): Promise<void>;
  /** Put the camera on `shot`, move the scene on by one step and draw. */
  frame(shot: SimShot): void;
  /** Each seat's moment (seconds on the film's clock) for the fade reveal. */
  revealKeys(keys: Float32Array): void;
  /** The cards at `clock` seconds: a seat is up `fade` seconds after its key. */
  revealAt(clock: number, fade: number): void;
  /** How much of the floodlight beams' haze shows, 0..1. */
  haze(k: number): void;
  /** Back to the live picture: its size, its camera, its loop. */
  end(): void;
}

/** The reveal a film plays: the editor's (core/reveal) or Match Day's own (choreo). */
export type FilmRevealSource = { kind: 'order'; id: RevealId } | { kind: 'mode'; mode: RevealMode };

/** A seat that is not in the tifo: its key is long before the film starts, so it is always there. */
const ALWAYS = -1e6;

/**
 * Every seat's moment in the film: the design's own order (a sweep, rows,
 * sections, sparkle…), stretched over the tifo's own seats so the wave
 * crosses the tifo for the whole reveal rather than for the slice of the bowl
 * it happens to sit in, and starting at FILM_TIMES.revealAt. A drum call is
 * everyone on one beat, each fan a fraction late (core/drumCall). The seats
 * round the tifo keep their own colours throughout.
 */
export function filmRevealKeys(map: SeatMap, painted: (i: number) => boolean, source: FilmRevealSource): { keys: Float32Array; fade: number } {
  const T = FILM_TIMES;
  const n = map.count;
  const keys = new Float32Array(n).fill(ALWAYS);
  const drum = source.kind === 'order' ? source.id === 'drum-call' : source.mode === 'drum-call';
  if (drum) {
    for (let i = 0; i < n; i++) if (painted(i)) keys[i] = T.revealAt + seatReaction(i, 'up') * DRUM_CALL.jitter;
    return { keys, fade: DRUM_CALL.lift * 2 };
  }
  const order = orderOf(map, source);
  // Round the bowl, a sweep's numbers wrap at one end of the ground: a tifo
  // across that seam would go up in two halves, seconds apart. Unwrap it at
  // the widest gap among its own seats.
  const wraps = source.kind === 'order' ? source.id === 'sweep-lr' || source.id === 'sweep-rl' : source.mode === 'wipe-lr';
  const vals: number[] = [];
  for (let i = 0; i < n; i++) if (painted(i)) vals.push(order[i]);
  if (!vals.length) return { keys, fade: T.revealFade };
  let shiftBelow = -Infinity;
  if (wraps) {
    const sorted = [...vals].sort((x, y) => x - y);
    let gap = 1 - sorted[sorted.length - 1] + sorted[0];
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k] - sorted[k - 1] > gap) {
        gap = sorted[k] - sorted[k - 1];
        shiftBelow = sorted[k];
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  const at = (v: number): number => (v < shiftBelow ? v + 1 : v);
  for (const v of vals) {
    lo = Math.min(lo, at(v));
    hi = Math.max(hi, at(v));
  }
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    if (!painted(i)) continue;
    keys[i] = T.revealAt + (span > 1e-6 ? (at(order[i]) - lo) / span : 0) * T.revealSpread;
  }
  return { keys, fade: T.revealFade };
}

/** Where the first cards go up: the middle of the earliest sixth of them, by their keys. */
function revealStart(map: SeatMap, keys: Float32Array): [number, number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < map.count; i++) {
    if (keys[i] <= ALWAYS / 2) continue;
    lo = Math.min(lo, keys[i]);
    hi = Math.max(hi, keys[i]);
  }
  if (lo === Infinity) return undefined;
  const cut = lo + (hi - lo) / 6;
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (let i = 0; i < map.count; i++) {
    if (keys[i] <= ALWAYS / 2 || keys[i] > cut) continue;
    x += map.pos3[i * 3];
    y += map.pos3[i * 3 + 1];
    z += map.pos3[i * 3 + 2];
    n++;
  }
  return n ? [x / n, y / n, z / n] : undefined;
}

/** The 0..1 order a reveal puts the seats in. */
function orderOf(map: SeatMap, source: FilmRevealSource): Float32Array {
  if (source.kind === 'order') return buildReveal(map, source.id);
  const out = new Float32Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    const v = map.uv[i * 2 + 1];
    switch (source.mode) {
      case 'wipe-up':
        out[i] = 1 - v;
        break;
      case 'center-out':
        out[i] = Math.abs(u - 0.5) * 2;
        break;
      case 'sparkle': {
        let x = (i * 374761393 + 668265263) >>> 0;
        x = (x ^ (x >>> 13)) >>> 0;
        x = (x * 1274126177) >>> 0;
        out[i] = ((x ^ (x >>> 16)) >>> 0) / 4294967296;
        break;
      }
      default:
        out[i] = u;
    }
  }
  return out;
}

/** The plan for this simulator's ground and tifo, at the shape the host now draws (after `begin`). */
export function filmPlanFor(host: FilmHost, aspect: number, hold?: FilmPlanInput['hold'], keys?: Float32Array): FilmPlan {
  const shots = host.shots();
  const fp = host.footprint();
  const stage = (fp && shots.find((s) => s.name === 'Your Tifo')) || shots.find((s) => s.name === 'TV Broadcast') || shots[0];
  const t = host.template;
  // A few hundred of the tifo's cards, where they stand (a card is 0.9 m over its seat).
  const points: [number, number, number][] = [];
  if (fp) {
    const m = host.map;
    const step = Math.max(1, Math.floor(fp.seats / 400));
    let k = 0;
    for (let i = 0; i < m.count; i++) {
      if (!host.painted(i) || k++ % step) continue;
      points.push([m.pos3[i * 3], m.pos3[i * 3 + 1] + 0.9, m.pos3[i * 3 + 2]]);
    }
  }
  return planFilm({
    hold,
    points,
    revealFrom: keys ? revealStart(host.map, keys) : undefined,
    sees: (a, b) => host.sees(a, b),
    overRoof: (a) => host.overRoof(a),
    aspect,
    footprint: fp,
    bounds: host.bounds(),
    plan: { a: t.plan.a, b: t.plan.b },
    reach: host.outerReach(),
    stage,
    indoor: !!t.indoor,
    inside: shots.find((s) => s.name === 'High Corner') ?? shots.find((s) => s.name === 'TV Broadcast'),
  });
}

export interface FilmOptions {
  width: number;
  height: number;
  fps?: number;
  reveal: FilmRevealSource;
  /** "tifomaker.org" in the corner (Pro leaves it off when asked). */
  mark: boolean;
  /** A small credit line (the fan's handle or group), drawn when given. */
  creditLine?: string;
  signal?: AbortSignal;
  /** 0..1 as the frames are drawn, with the frame just drawn and how many there are (none in real time). */
  onProgress?: (done: number, frame?: number, total?: number) => void;
  /** The first this many frames only: the browser suites, where a whole film takes most of an hour. */
  frameLimit?: number;
  /** Every frame as it is drawn, before it is encoded: for the suites and the shot scripts. */
  onFrame?: (n: number, t: number, picture: HTMLCanvasElement) => void | Promise<void>;
  /** Draw the frames without encoding them (the shot scripts). */
  encode?: boolean;
  /** Match Day's crowd and drum in the file (filmSound.ts), where the browser can encode it. Default on. */
  sound?: boolean;
  /** Only these frame numbers (the shot scripts' stills). The camera and the cards are exactly the film's; a flag's wave is not caught up in between. */
  only?: readonly number[];
}

export interface FilmResult {
  blob: Blob | null;
  mimeType: string;
  extension: 'mp4' | 'webm';
  /** H.264 in MP4: plays on every phone and in every app. */
  universal: boolean;
  /** Filmed in real time (no WebCodecs or no H.264): may stutter on a slow device. */
  realtime: boolean;
  /** The sound's codec, or null: the file is silent. */
  sound: 'aac' | 'opus' | null;
  frames: number;
  fps: number;
  width: number;
  height: number;
}

/** H.264 at High, Main, then Baseline, all at level 4 (1920 × 1080 and 1080 × 1920 at 30 fps). */
const AVC_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

/** The H.264 codec string this browser can encode the film in, or null (then it films in real time). */
export async function filmCodec(w: number, h: number, fps: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const codec of AVC_CODECS) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: filmBitrate(w, h), framerate: fps });
      if (s.supported) return codec;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/**
 * The film's bitrate: 7 Mbps at Full HD. A crowd of tens of thousands and a
 * stand of cards are fine detail that H.264 smears below about 5; a 13 s
 * film comes to about 11 MB.
 */
export function filmBitrate(w: number, h: number): number {
  return Math.round(7_000_000 * ((w * h) / (1920 * 1080)));
}

/** "tifomaker.org" in the bottom corner: the same mark, place and size as every Match Day export. */
function drawMark(g: CanvasRenderingContext2D, w: number, h: number): void {
  const fs = Math.max(14, Math.round(Math.min(w, h) * 0.026));
  const txt = 'tifomaker.org';
  g.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
  const tw = g.measureText(txt).width;
  const pad = Math.round(fs * 0.5);
  g.fillStyle = 'rgba(0,0,0,0.4)';
  g.fillRect(w - tw - pad * 3, h - fs - pad * 2, tw + pad * 2, fs + pad);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillText(txt, w - tw - pad * 2, h - Math.round(pad * 1.5));
}

/**
 * Make the film. Resolves with the file (null with `encode: false`), rejects
 * with an AbortError when `signal` aborts, and always gives the simulator
 * back its live picture.
 */
export async function makeFilm(host: FilmHost, opts: FilmOptions): Promise<FilmResult> {
  const fps = opts.fps ?? 30;
  const { width: w, height: h } = opts;
  const encode = opts.encode !== false;
  const codec = encode ? await filmCodec(w, h, fps) : null;
  if (encode && !codec) return filmRealtime(host, opts, fps);

  const comp = document.createElement('canvas');
  comp.width = w;
  comp.height = h;
  const g = comp.getContext('2d', { alpha: false })!;
  let encoder: VideoEncoder | null = null;
  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let failed: unknown = null;
  // The sound first: it is a second or two of work, and the muxer has to know it has a track.
  const total = Math.min(Math.round(FILM_TIMES.seconds * fps), opts.frameLimit ?? Infinity);
  const soundCodec = codec && opts.sound !== false ? await filmSoundCodec() : null;
  const sound = soundCodec ? await renderFilmSound(total / fps).catch(() => null) : null;
  if (codec) {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      ...(sound && soundCodec ? { audio: { codec: soundCodec.codec, sampleRate: FILM_SOUND_RATE, numberOfChannels: 2 } } : {}),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    const mx = muxer;
    encoder = new VideoEncoder({
      output: (chunk, meta) => mx.addVideoChunk(chunk, meta),
      error: (e) => {
        failed = e;
      },
    });
    encoder.configure({ codec, width: w, height: h, bitrate: filmBitrate(w, h), framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } });
  }

  // Ended only if begun: a second film asked for meanwhile must not end the first.
  let begun = false;
  try {
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    await host.begin(w, h, fps);
    begun = true;
    const { keys, fade } = filmRevealKeys(host.map, (i) => host.painted(i), opts.reveal);
    const plan = filmPlanFor(host, w / h, undefined, keys);
    host.revealKeys(keys);
    if (sound && soundCodec && muxer) {
      const mx = muxer;
      await encodeFilmSound(sound, soundCodec, (chunk, meta) => mx.addAudioChunk(chunk, meta));
    }
    const list = opts.only ? [...opts.only].filter((n) => n >= 0 && n < total) : null;
    const count = list ? list.length : total;
    for (let k = 0; k < count; k++) {
      if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (!host.alive()) throw new Error('Match Day closed');
      if (failed) throw failed;
      const n = list ? list[k] : k;
      const t = n / fps;
      host.revealAt(t, fade);
      host.haze(plan.hazeAt(t));
      host.frame(plan.shotAt(t));
      g.drawImage(host.canvas, 0, 0, w, h);
      const dark = plan.fadeAt(t);
      if (dark > 0) {
        g.fillStyle = `rgba(0,0,0,${dark.toFixed(4)})`;
        g.fillRect(0, 0, w, h);
      }
      if (opts.creditLine) drawCreditLine(g, w, h, opts.creditLine, { avoid: opts.mark ? 'right' : null });
      if (opts.mark) drawMark(g, w, h);
      await opts.onFrame?.(n, t, comp);
      if (encoder) {
        const frame = new VideoFrame(comp, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
        frame.close();
        // A slow encoder is waited for rather than handed the whole film at once.
        while (encoder.encodeQueueSize > 3 && !failed) await new Promise((r) => setTimeout(r, 4));
      }
      opts.onProgress?.((k + 1) / count, k + 1, count);
      // Let the page paint the progress bar and answer Cancel between frames.
      await new Promise((r) => setTimeout(r, 0));
    }
    let blob: Blob | null = null;
    if (encoder && muxer) {
      await encoder.flush();
      if (failed) throw failed;
      muxer.finalize();
      blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    }
    return { blob, mimeType: 'video/mp4', extension: 'mp4', universal: true, realtime: false, sound: blob && sound && soundCodec ? soundCodec.codec : null, frames: count, fps, width: w, height: h };
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    if (begun) host.end();
  }
}

/**
 * The same shot, filmed in real time through MediaRecorder: what a browser
 * without WebCodecs' H.264 gets. The camera and the cards follow the wall
 * clock, so a device that draws slowly drops frames rather than slowing the
 * film down.
 */
async function filmRealtime(host: FilmHost, opts: FilmOptions, fps: number): Promise<FilmResult> {
  const { width: w, height: h } = opts;
  const asked = typeof MediaRecorder === 'undefined' ? null : pickRecordingFormat();
  const comp = document.createElement('canvas');
  comp.width = w;
  comp.height = h;
  const g = comp.getContext('2d', { alpha: false })!;
  if (!asked || typeof comp.captureStream !== 'function') throw new Error('no video encoder in this browser');
  const stream = comp.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: asked.mimeType, videoBitsPerSecond: filmBitrate(w, h) });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e): void => {
    if (e.data.size) chunks.push(e.data);
  };
  let format = asked;
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = (): void => {
      format = describeRecording(recorder.mimeType, asked);
      resolve(new Blob(chunks, { type: format.mimeType }));
    };
  });
  let frames = 0;
  let begun = false;
  try {
    await host.begin(w, h, fps);
    begun = true;
    const { keys, fade } = filmRevealKeys(host.map, (i) => host.painted(i), opts.reveal);
    const plan = filmPlanFor(host, w / h, undefined, keys);
    host.revealKeys(keys);
    const seconds = Math.min(plan.seconds, (opts.frameLimit ?? Infinity) / fps);
    recorder.start();
    const t0 = performance.now();
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (!host.alive()) throw new Error('Match Day closed');
      const t = (performance.now() - t0) / 1000;
      if (t > seconds) break;
      host.revealAt(t, fade);
      host.haze(plan.hazeAt(t));
      host.frame(plan.shotAt(t));
      g.drawImage(host.canvas, 0, 0, w, h);
      const dark = plan.fadeAt(t);
      if (dark > 0) {
        g.fillStyle = `rgba(0,0,0,${dark.toFixed(4)})`;
        g.fillRect(0, 0, w, h);
      }
      if (opts.creditLine) drawCreditLine(g, w, h, opts.creditLine, { avoid: opts.mark ? 'right' : null });
      if (opts.mark) drawMark(g, w, h);
      frames++;
      opts.onProgress?.(Math.min(1, t / seconds));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
    // The stream takes the canvas's last picture on its next frame: let it,
    // or a device that drew one slow frame hands over an empty file.
    await new Promise((r) => setTimeout(r, 1000 / fps + 250));
    recorder.stop();
    const blob = await done;
    if (!blob.size) throw new Error('the recording came out empty');
    return { blob, ...format, realtime: true, sound: null, frames, fps, width: w, height: h };
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    if (begun) host.end();
  }
}

/**
 * Where a poster's picture puts the tifo: in the upper part of a landscape
 * poster and a little over the middle of a portrait one, so the type has the
 * pitch below it to sit on.
 */
/**
 * Where a poster puts the tifo, its hero. Landscape: up to 62% of the width
 * and 90% of the height, on the side the type does not start from (the type
 * has a column on the reading side, posterLayout.ts TYPE_COLUMN). Portrait:
 * up to 92% of the width and 46% of the height, between the header and the
 * names. A wide tifo is held by the width, a tall one by the height.
 */
export function posterHold(shape: 'landscape' | 'portrait', rtl: boolean): NonNullable<FilmPlanInput['hold']> {
  return shape === 'landscape'
    ? { fillW: 0.62, fillH: 0.9, centreY: 0, centreX: rtl ? -0.33 : 0.33 }
    : { fillW: 0.92, fillH: 0.46, centreY: 0.18 };
}

/**
 * The film's hold, as one picture at w × h: the poster's background. Drawn
 * by the same camera and light as the film's hold, the tifo all the way up,
 * framed by `hold` (posterHold for a poster). The ground's big screens are
 * left out: a board hung over the stand sits on the tifo in a still.
 */
export async function filmStill(host: FilmHost, w: number, h: number, hold?: FilmPlanInput['hold']): Promise<HTMLCanvasElement> {
  await host.begin(w, h, 30);
  // (A begin that throws has begun nothing: it refuses before it changes anything.)
  try {
    host.screens?.(false);
    const plan = filmPlanFor(host, w / h, hold);
    const keys = new Float32Array(host.map.count).fill(ALWAYS);
    host.revealKeys(keys);
    host.revealAt(FILM_TIMES.seconds, 1);
    host.haze(plan.hazeAt(FILM_TIMES.seconds));
    host.frame(plan.hold);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(host.canvas, 0, 0, w, h);
    return out;
  } finally {
    host.screens?.(true);
    host.end();
  }
}
