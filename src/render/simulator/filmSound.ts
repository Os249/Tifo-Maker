/**
 * The Pro film's soundtrack: Match Day's own crowd and drum, rendered
 * offline to the film's clock, so the sound lands on the picture to the
 * sample however long the frames took to draw.
 *
 * The same synthesised graph that plays live (atmosphere.ts), built into an
 * OfflineAudioContext instead of the speakers:
 *
 *   from 0 s     the crowd's bed, and a chant over the establishing shot;
 *   the count    three hits of the tabl on the beat before the cards, the
 *                third the loud one, and the stand's "Oooh" as they go up;
 *   the reveal   the chant while the cards are up;
 *   the end of the reveal   the roar, then applause and the chant again;
 *   the end      faded out with the picture.
 *
 * Encoded by WebCodecs' AudioEncoder: AAC where the browser has it (what
 * every phone plays), Opus where it does not (Chromium without the
 * proprietary codecs). With neither, the film is silent and the card says so.
 */
import { DRUM_CALL } from '../../core/drumCall';
import { buildAtmosphere } from './atmosphere';
import { FILM_TIMES } from './filmPlan';

export const FILM_SOUND_RATE = 48000;

export type FilmSoundCodec = { codec: 'aac' | 'opus'; config: AudioEncoderConfig };

/** The codec this browser can encode the film's sound in: AAC first, then Opus; null for none. */
export async function filmSoundCodec(): Promise<FilmSoundCodec | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || typeof OfflineAudioContext === 'undefined') return null;
  const tries: FilmSoundCodec[] = [
    { codec: 'aac', config: { codec: 'mp4a.40.2', sampleRate: FILM_SOUND_RATE, numberOfChannels: 2, bitrate: 160_000 } },
    { codec: 'opus', config: { codec: 'opus', sampleRate: FILM_SOUND_RATE, numberOfChannels: 2, bitrate: 128_000 } },
  ];
  for (const t of tries) {
    try {
      if ((await AudioEncoder.isConfigSupported(t.config)).supported) return t;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/** `seconds` of the film's sound, stereo at 48 kHz. Null where there is no OfflineAudioContext. */
export async function renderFilmSound(seconds: number): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === 'undefined' || seconds <= 0) return null;
  const T = FILM_TIMES;
  const ctx = new OfflineAudioContext(2, Math.ceil(FILM_SOUND_RATE * seconds), FILM_SOUND_RATE);
  const atmo = buildAtmosphere({ offline: ctx });
  try {
    await atmo.setEnabled(true);
    // The film's own mix, not the fan's speaker levels (set low for a room):
    // the crowd forward, the tabl over it, and the whole raised to the file's
    // level after (shape).
    atmo.setLevel('master', 1);
    atmo.setLevel('crowd', 0.6);
    atmo.setLevel('drum', 0.32);
    atmo.setCrowdFill(0.97);
    // Booked on the film's clock (`from` 0): the count, and the "Oooh" as the cards go up.
    for (let k = 3; k >= 1; k--) if (T.revealAt - k * DRUM_CALL.beat < seconds) atmo.drumHit(k === 1, T.revealAt - k * DRUM_CALL.beat, 0);
    if (T.revealAt < seconds) atmo.ooh(T.revealAt, false, 0);
    // The rest start "now": the render is paused at their moment to start them.
    const done = T.revealAt + T.revealSpread;
    const cues: [number, () => void][] = [
      [0.4, () => atmo.chant()],
      // The stand sings while the cards are up (silence there sounds like a fault).
      [T.revealAt + 0.9, () => atmo.chant()],
      [done + 0.2, () => atmo.roar(1)],
      [done + 1, () => atmo.applause(0.9)],
      [done + 1.7, () => atmo.chant()],
    ];
    for (const [at, cue] of cues) {
      if (at >= seconds) continue;
      void ctx.suspend(at).then(() => {
        cue();
        return ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    shape(buf);
    return buf;
  } finally {
    atmo.dispose();
  }
}

/**
 * Up to the file's level (its loudest moment at -1 dBFS, raised by no more
 * than 12 dB), in over a quarter of a second (no click), and out with the
 * picture's fade to black.
 */
function shape(buf: AudioBuffer): void {
  const T = FILM_TIMES;
  const rate = buf.sampleRate;
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
  const inEnd = Math.floor(0.25 * rate);
  const outFrom = Math.floor(T.fadeFrom * rate);
  const outLen = Math.max(1, Math.floor(T.seconds * rate) - outFrom);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
    for (let i = 0; i < Math.min(inEnd, d.length); i++) d[i] *= i / inEnd;
    for (let i = outFrom; i < d.length; i++) {
      const k = Math.min(1, (i - outFrom) / outLen);
      d[i] *= 1 - k * k * (3 - 2 * k);
    }
  }
}

/**
 * Encode `buf` and hand each chunk to `add` (the muxer). Resolves once the
 * encoder has flushed; rejects if it fails.
 */
export async function encodeFilmSound(buf: AudioBuffer, codec: FilmSoundCodec, add: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void): Promise<void> {
  let failed: unknown = null;
  const enc = new AudioEncoder({ output: add, error: (e) => { failed = e; } });
  enc.configure(codec.config);
  const rate = buf.sampleRate;
  const step = Math.floor(rate / 10);
  const left = buf.getChannelData(0);
  const right = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  try {
    for (let at = 0; at < buf.length; at += step) {
      const n = Math.min(step, buf.length - at);
      const planes = new Float32Array(n * 2);
      planes.set(left.subarray(at, at + n), 0);
      planes.set(right.subarray(at, at + n), n);
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at * 1e6) / rate), data: planes });
      enc.encode(data);
      data.close();
      if (failed) throw failed;
    }
    await enc.flush();
    if (failed) throw failed;
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
}
