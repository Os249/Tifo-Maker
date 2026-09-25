import type { DrumHit } from '../core/drumCall';

/**
 * The tabl — the big drum that calls a Saudi card display — and a small player
 * that lines its hits up with a drum-call reveal.
 *
 * Synthesised, like everything else the site plays: nothing to license, no
 * bytes to download, and the hit can be scheduled to the sample on the audio
 * clock, which a recorded one-shot dropped in with a timer cannot.
 *
 * It is a different animal from the terrace drum in the Match Day mix. That
 * one keeps time under a chant and is meant to sit back; this one is a signal
 * — four thousand people are waiting for it — so it is deeper, longer and much
 * further forward: a body that starts near 100 Hz and sags to the fundamental,
 * a slap of skin on top, and a short tail of the room answering.
 */

const noiseFor = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseFor.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1), ctx.sampleRate);
    const d = b.getChannelData(0);
    // Deterministic, so two renders of the same show are the same file.
    let s = 0x2545f491;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    noiseFor.set(ctx, b);
  }
  return b;
}

/**
 * One tabl hit at audio time `at`, into `out`. Returns the sources it started,
 * so a caller that is cancelled (pause, scrub, close) can silence hits that
 * were scheduled but have not sounded yet.
 */
export function tablHit(ctx: BaseAudioContext, out: AudioNode, at: number, gain = 0.9): AudioScheduledSourceNode[] {
  const started: AudioScheduledSourceNode[] = [];
  const g = Math.max(0.0002, gain);

  // The body: a pitch-dropping sine. The drop is most of what makes a drum
  // sound like a skin being hit rather than a tone being played.
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(104, at);
  body.frequency.exponentialRampToValueAtTime(46, at + 0.28);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.0001, at);
  bg.gain.exponentialRampToValueAtTime(g, at + 0.005);
  bg.gain.exponentialRampToValueAtTime(g * 0.35, at + 0.18);
  bg.gain.exponentialRampToValueAtTime(0.0001, at + 0.95);
  body.connect(bg).connect(out);
  body.start(at);
  body.stop(at + 1);
  started.push(body);

  // An overtone a fifth-and-a-bit up, gone quickly: the "boom" has a front.
  const over = ctx.createOscillator();
  over.type = 'triangle';
  over.frequency.setValueAtTime(170, at);
  over.frequency.exponentialRampToValueAtTime(80, at + 0.12);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, at);
  og.gain.exponentialRampToValueAtTime(g * 0.35, at + 0.004);
  og.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
  over.connect(og).connect(out);
  over.start(at);
  over.stop(at + 0.25);
  started.push(over);

  const noise = noiseBuffer(ctx);

  // The skin: a very short band of noise where a hand or a beater lands.
  const slap = ctx.createBufferSource();
  slap.buffer = noise;
  const sf = ctx.createBiquadFilter();
  sf.type = 'bandpass';
  sf.frequency.value = 1100;
  sf.Q.value = 1.1;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(g * 0.55, at);
  sg.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
  slap.connect(sf).connect(sg).connect(out);
  slap.start(at, 0.1);
  slap.stop(at + 0.09);
  started.push(slap);

  // The room: low noise swelling a moment after the hit and dying away — a
  // stand of concrete and people giving the hit back.
  const room = ctx.createBufferSource();
  room.buffer = noise;
  const rf = ctx.createBiquadFilter();
  rf.type = 'lowpass';
  rf.frequency.value = 260;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, at);
  rg.gain.exponentialRampToValueAtTime(g * 0.22, at + 0.05);
  rg.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
  room.connect(rf).connect(rg).connect(out);
  room.start(at, 0.4);
  room.stop(at + 0.62);
  started.push(room);

  return started;
}

/**
 * Plays a drum call's hits in step with a reveal the page is animating.
 *
 * The page's clock is requestAnimationFrame and this one is the audio clock;
 * over the fifteen seconds a call lasts they do not drift apart audibly, so
 * the hits are scheduled all at once from wherever the animation is, and
 * cancelled wholesale if it is paused, scrubbed or stopped.
 */
export class DrumTrack {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private live: AudioScheduledSourceNode[] = [];
  private toSpeakers = true;

  /** Build the context. Call from a user gesture the first time, or the browser keeps it suspended. */
  ensure(): AudioContext | null {
    if (this.ctx) {
      void this.ctx.resume().catch(() => undefined);
      return this.ctx;
    }
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.85;
    if (this.toSpeakers) this.out.connect(this.ctx.destination);
    void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  /** Whether the hits reach the speakers (a recording still gets them either way). */
  setSpeakers(on: boolean): void {
    if (on === this.toSpeakers) return;
    this.toSpeakers = on;
    if (!this.ctx || !this.out) return;
    if (on) this.out.connect(this.ctx.destination);
    else {
      try {
        this.out.disconnect(this.ctx.destination);
      } catch {
        /* was not connected */
      }
    }
  }

  /**
   * Schedule every hit at or after `fromSec` seconds into the call, as if the
   * call were at `fromSec` right now. Anything already scheduled is cancelled
   * first, so calling this again after a scrub is always safe.
   */
  play(hits: readonly DrumHit[], fromSec: number): void {
    this.stop();
    const ctx = this.ensure();
    if (!ctx || !this.out) return;
    // Started early by the output latency, so the hit leaves the speaker on
    // the beat the picture moves on rather than a buffer (or a Bluetooth
    // link) later. Capped, like the Match Day mix.
    const lead = Math.min(0.25, Math.max(0, (ctx.outputLatency || 0) + (ctx.baseLatency || 0)));
    const now = ctx.currentTime + 0.005 - lead;
    for (const h of hits) {
      // A hit a few ms in the past is the one the user pressed Play on top of;
      // play it rather than swallowing the first beat of the count.
      if (h.t < fromSec - 0.04) continue;
      // The last of the three is hit hardest — it is the one people move on.
      const gain = h.count === 3 ? 0.95 : 0.8;
      this.live.push(...tablHit(ctx, this.out, Math.max(ctx.currentTime + 0.005, now + Math.max(0, h.t - fromSec)), gain));
    }
  }

  /** Silence everything scheduled that has not sounded yet (and cut what is ringing). */
  stop(): void {
    for (const n of this.live) {
      try {
        n.stop();
      } catch {
        /* never started, or already stopped */
      }
    }
    this.live = [];
  }

  /** An audio track carrying the hits, for a MediaRecorder. Null if there is no audio here. */
  captureStream(): MediaStream | null {
    const ctx = this.ensure();
    if (!ctx || !this.out) return null;
    if (!this.dest) {
      this.dest = ctx.createMediaStreamDestination();
      this.out.connect(this.dest);
    }
    return this.dest.stream;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.out = null;
    this.dest = null;
  }
}
