/**
 * The sound of a full stadium, synthesised.
 *
 * Not a recording. A crowd loop good enough not to be obviously a loop is
 * several megabytes, someone has to license it, and it cannot react to anything
 * — it is the same eight seconds whether the tifo has just gone up or the
 * players are still in the tunnel. Everything else in this renderer is generated
 * (the seats, the bowl, the facade, the track), and a crowd is one of the few
 * sounds that is genuinely easy to generate convincingly, because a crowd IS
 * filtered noise. Fifteen thousand voices average out into a band of energy
 * roughly 300 Hz to 2 kHz that swells and falls; the individual voices are gone
 * long before they reach you.
 *
 * So: one looping noise buffer, a bandpass, and a slow random walk on the gain.
 * The things you can actually pick out of a crowd — a roar, a whistle, the
 * ultras' drum — are separate one-shots layered on top, and those are what make
 * it read as a place rather than as rain.
 */

/** How loud the crowd sits under everything else at volume 1. */
const BED_GAIN = 0.34;

export interface Atmosphere {
  /** Start or stop the crowd bed. Must be called from a user gesture the first time. */
  setEnabled(on: boolean): Promise<void>;
  isEnabled(): boolean;
  /** 0..1. Applies immediately and is remembered by the caller. */
  setVolume(v: number): void;
  getVolume(): number;
  /** A swell of noise — the tifo going up, a goal. `strength` 0..1. */
  roar(strength?: number): void;
  /** The referee's whistle. */
  whistle(): void;
  /** Start/stop the ultras' drum, about 96 BPM. */
  setDrum(on: boolean): void;
  isDrumming(): boolean;
  dispose(): void;
}

/**
 * A few seconds of pink-ish noise, generated once and looped.
 *
 * Pink rather than white because white noise is hissy and reads as static or
 * rain; a crowd has far more energy low down. This is the cheap Voss-style
 * approximation — a handful of octave-spaced random walks summed — which is
 * indistinguishable from the real thing once it has been through a bandpass and
 * is sitting under a stadium.
 */
function pinkNoise(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  // Taper the last 50 ms into the first so the loop point is not a click. A
  // click every four seconds is the one artefact nobody can un-hear.
  const fade = Math.min(2205, Math.floor(len / 8));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = out[i] * t + out[len - fade + i] * (1 - t);
  }
  return buf;
}

export function buildAtmosphere(): Atmosphere {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let bedGain: GainNode | null = null;
  let bed: AudioBufferSourceNode | null = null;
  let swellTimer: number | undefined;
  let drumTimer: number | undefined;
  let noise: AudioBuffer | null = null;
  let volume = 0.6;
  let enabled = false;
  let drumming = false;

  const AudioCtor = typeof window !== 'undefined'
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;

  /**
   * Build the graph on first use, not at construction.
   *
   * A browser will not let an AudioContext start outside a user gesture, and one
   * created early sits in 'suspended' and silently does nothing — which reads as
   * "the sound is broken" rather than "the browser said no". Creating it inside
   * the toggle means the toggle IS the gesture.
   */
  const ensure = async (): Promise<boolean> => {
    if (!AudioCtor) return false;
    if (!ctx) {
      ctx = new AudioCtor();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      noise = pinkNoise(ctx);
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    return ctx.state === 'running';
  };

  const startBed = (): void => {
    if (!ctx || !master || !noise || bed) return;
    bed = ctx.createBufferSource();
    bed.buffer = noise;
    bed.loop = true;

    // The crowd's own voice: everything below 200 Hz is rumble and everything
    // above ~2.5 kHz is hiss, and a crowd is neither.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.55;
    const tilt = ctx.createBiquadFilter();
    tilt.type = 'highshelf';
    tilt.frequency.value = 3200;
    tilt.gain.value = -14;

    bedGain = ctx.createGain();
    bedGain.gain.value = BED_GAIN * 0.75;
    bed.connect(band).connect(tilt).connect(bedGain).connect(master);
    bed.start();

    // The swell. A crowd is never at a constant level — it breathes, over five
    // or ten seconds, and a flat bed is the single thing that gives away a
    // synthesised one. Random walk rather than an LFO, because an LFO is
    // periodic and a crowd is not.
    const breathe = (): void => {
      if (!ctx || !bedGain) return;
      const target = BED_GAIN * (0.6 + Math.random() * 0.6);
      const secs = 3 + Math.random() * 5;
      bedGain.gain.cancelScheduledValues(ctx.currentTime);
      bedGain.gain.setTargetAtTime(target, ctx.currentTime, secs / 3);
      band.frequency.setTargetAtTime(560 + Math.random() * 420, ctx.currentTime, secs / 3);
      swellTimer = window.setTimeout(breathe, secs * 1000);
    };
    breathe();
  };

  const stopBed = (): void => {
    window.clearTimeout(swellTimer);
    swellTimer = undefined;
    try { bed?.stop(); } catch { /* already stopped */ }
    bed?.disconnect();
    bed = null;
    bedGain = null;
  };

  /** One drum hit: a pitch-dropping sine with a noise transient for the skin. */
  const hit = (at: number, gain: number): void => {
    if (!ctx || !master || !noise) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, at);
    osc.frequency.exponentialRampToValueAtTime(48, at + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + 0.5);

    const click = ctx.createBufferSource();
    click.buffer = noise;
    click.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 1800;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(gain * 0.5, at);
    cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    click.connect(cf).connect(cg).connect(master);
    click.start(at, Math.random() * 2);
    click.stop(at + 0.08);
  };

  return {
    isEnabled: () => enabled,
    getVolume: () => volume,
    isDrumming: () => drumming,

    async setEnabled(on: boolean): Promise<void> {
      if (on) {
        if (!(await ensure())) return;
        enabled = true;
        startBed();
        if (drumming) this.setDrum(true);
      } else {
        enabled = false;
        stopBed();
        window.clearInterval(drumTimer);
        drumTimer = undefined;
        void ctx?.suspend().catch(() => undefined);
      }
    },

    setVolume(v: number): void {
      volume = Math.max(0, Math.min(1, v));
      if (ctx && master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    },

    /**
     * A roar.
     *
     * The same noise bed, but opened up: a crowd on its feet is louder AND
     * brighter, because people are shouting rather than talking. Raising the
     * gain alone sounds like someone turned a dial; moving the filter with it
     * sounds like the stand stood up.
     */
    roar(strength = 1): void {
      if (!ctx || !master || !noise || !enabled) return;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.setValueAtTime(700, now);
      band.frequency.linearRampToValueAtTime(1500, now + 0.5);
      band.frequency.setTargetAtTime(700, now + 0.9, 1.6);
      band.Q.value = 0.5;
      const g = ctx.createGain();
      const peak = 0.55 * Math.max(0.1, Math.min(1, strength));
      g.gain.setValueAtTime(0.0001, now);
      // Fast in, slow out: a crowd reacts together and dies away one by one.
      g.gain.exponentialRampToValueAtTime(peak, now + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 4.5);
      src.connect(band).connect(g).connect(master);
      src.start(now, Math.random() * 2);
      src.stop(now + 4.7);
    },

    whistle(): void {
      if (!ctx || !master || !enabled) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(3150, now);
      // The warble is the pea in the whistle. Without it this is a test tone.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 26;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 130;
      lfo.connect(lfoGain).connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
      g.gain.setValueAtTime(0.16, now + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
      osc.connect(g).connect(master);
      osc.start(now);
      lfo.start(now);
      osc.stop(now + 0.7);
      lfo.stop(now + 0.7);
    },

    setDrum(on: boolean): void {
      drumming = on;
      window.clearInterval(drumTimer);
      drumTimer = undefined;
      if (!on || !enabled || !ctx) return;
      // 96 BPM, which is about where a terrace drum sits — slow enough to clap
      // over. Scheduled a beat ahead on the audio clock rather than played from
      // the timer, because setInterval drifts and a drum that drifts is worse
      // than no drum.
      const beat = 60 / 96;
      const tick = (): void => {
        if (!ctx) return;
        const at = ctx.currentTime + 0.05;
        hit(at, 0.4);
        hit(at + beat * 0.5, 0.16);
      };
      tick();
      drumTimer = window.setInterval(tick, beat * 1000);
    },

    dispose(): void {
      stopBed();
      window.clearInterval(drumTimer);
      void ctx?.close().catch(() => undefined);
      ctx = null;
      master = null;
      noise = null;
      enabled = false;
    },
  };
}
