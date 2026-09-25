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
 *
 * ## The mixer
 *
 * Everything lands on one of four buses before the master, because "louder" is
 * four different requests. Someone recording a clip for a phone wants the crowd
 * up and the drum down; someone designing at 2am wants the whole thing at 10%;
 * someone showing a tifo on a projector wants the roar to land. One slider
 * cannot answer those.
 *
 *   crowd    the bed, its swell, roars, applause, the chant — the people
 *   sfx      whistle, air horn, pyro, confetti, the floodlight contactor
 *   amb      weather: rain on a roof, wind round an empty bowl
 *   drum     the terrace drum, on its own because it is the most intrusive
 *
 *   ...all -> master -> limiter -> speakers (and the recorder's audio track)
 *
 * The limiter is not decoration. A roar, a drum hit and an air horn can arrive
 * in the same 20 ms, and three sources that each peak below 1.0 sum well past
 * it; without it that moment is a click, which is the one artefact that makes
 * synthesised audio sound broken rather than cheap.
 */

import { tablHit } from '../drumTrack';

/** How loud the crowd bed sits under everything else, before the bus gain. */
const BED_GAIN = 0.34;

export type SoundBus = 'crowd' | 'sfx' | 'amb' | 'drum';

export interface SoundLevels {
  master: number;
  crowd: number;
  sfx: number;
  amb: number;
  drum: number;
}

/**
 * What everybody hears first. Chosen by ear by Osamah, September 2026: the
 * old defaults (70 / 90 / 80 / 60 / 55) were a stadium at full cry before
 * anything had happened, and the drum call's tabl and the crowd's "Oooh" have
 * to have somewhere to go.
 */
export const DEFAULT_LEVELS: SoundLevels = {
  master: 0.3,
  crowd: 0.35,
  sfx: 0.2,
  amb: 0.25,
  drum: 0.25,
};

export type WeatherSound = 'clear' | 'rain' | 'snow';

export interface Atmosphere {
  /** Start or stop the whole rig. Must be called from a user gesture the first time. */
  setEnabled(on: boolean): Promise<void>;
  isEnabled(): boolean;
  /**
   * Hold everything without tearing the graph down.
   *
   * For the tab going to the background: the render loop already stops there,
   * and a stadium that keeps roaring out of a tab nobody is looking at is the
   * kind of thing people close the tab over rather than report.
   */
  setSuspended(on: boolean): void;

  setLevel(bus: 'master' | SoundBus, v: number): void;
  getLevels(): SoundLevels;
  setMuted(m: boolean): void;
  isMuted(): boolean;

  /**
   * How full the ground is, 0..1.
   *
   * An empty stadium that roars like a sell-out is the sound equivalent of
   * painting a crowd onto empty seats. This scales the bed and every reaction
   * the crowd makes, and it is why `crowd` has a bus of its own.
   */
  setCrowdFill(f: number): void;

  // ---- the crowd ----
  /** A swell of noise — the tifo going up, a goal. `strength` 0..1. */
  roar(strength?: number): void;
  /** Hands, not voices: the polite end of the same crowd. */
  applause(strength?: number): void;
  /** One call-and-response cycle of a terrace chant, over the drum. */
  chant(): void;
  /** Start/stop the ultras' drum, about 96 BPM. */
  setDrum(on: boolean): void;
  /**
   * One hit of the tabl — the drum that calls a card display. Not the terrace
   * drum above: deeper, longer, and far louder, because a whole stand is
   * waiting on it. `accent` for the third of a count, the one people move on.
   *
   * `inSec` schedules it that far ahead on the audio clock. The show runs on
   * rendered frames, and a slow phone renders a few a second: a hit fired on
   * the frame that crossed it lands late, and three hits crossed by one long
   * frame land on top of each other — a count that is no longer a count. So
   * the simulator looks ahead and books each hit for the moment it is due.
   */
  drumHit(accent?: boolean, inSec?: number, from?: number): void;
  /**
   * The stand's "Oooh" — booked `inSec` ahead exactly like a tabl hit, because
   * it has to land ON the picture appearing, not a frame or a swell later.
   * `drop` is the one for the picture going: lower, longer, falling.
   */
  ooh(inSec?: number, drop?: boolean, from?: number): void;
  /**
   * The audio clock now. A show books all its sounds from ONE reading of it:
   * reading it afresh for each, on a busy main thread, lets the clock tick on
   * between calls and the sounds drift apart by milliseconds.
   */
  audioNow(): number;
  /** Silence everything booked (hits, oohs) that has not sounded yet — a show stopped mid-count. */
  cancelBooked(): void;
  isDrumming(): boolean;

  // ---- everything else that happens ----
  /** The referee's whistle. `long` is the one that starts the match. */
  whistle(long?: boolean): void;
  /** The horn every away end owns exactly one of. */
  airhorn(): void;
  /** Pyro: the whoosh going up, then the crackle coming down. */
  pyro(): void;
  /** Paper in the air. */
  confetti(): void;
  /** The contactor closing, and the tubes coming up to temperature. */
  floodlights(on: boolean): void;

  // ---- weather ----
  setWeatherBed(w: WeatherSound, intensity?: number): void;

  /**
   * An audio track carrying everything above, for MediaRecorder.
   *
   * Null when the rig has never been started — there is no context to tap, and
   * a recorder handed a stream with a dead track produces a file some players
   * refuse to open at all.
   */
  captureStream(): MediaStream | null;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Buffer synthesis. All of these are rendered once, on the first gesture, and
// then played as buffer sources — a clap field is ~900 impulses, and 900 live
// nodes to hear one round of applause is not a trade worth making.
// ---------------------------------------------------------------------------

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
  loopSeam(out);
  return buf;
}

/** White noise, for anything that wants the top end: rain, claps, crackle. */
function whiteNoise(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  for (let i = 0; i < len; i++) out[i] = (Math.random() * 2 - 1) * 0.5;
  loopSeam(out);
  return buf;
}

/**
 * Taper the tail into the head so the loop point is not a click.
 *
 * A click every four seconds is the one artefact nobody can un-hear, and it is
 * the reason a naive noise loop sounds like a machine rather than a room.
 */
function loopSeam(out: Float32Array): void {
  const fade = Math.min(2205, Math.floor(out.length / 8));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = out[i] * t + out[out.length - fade + i] * (1 - t);
  }
}

/**
 * Applause: a field of individual claps, thinning out.
 *
 * A clap is a 12 ms burst of bright noise with almost no tail, and applause is
 * simply a lot of them arriving at random. Two details do all the work: the
 * density has to decay (people stop at different times, not together), and the
 * individual claps have to be loud relative to the bed, because applause you
 * can pick single hands out of is applause, and applause you cannot is rain.
 */
function applauseBuffer(ctx: BaseAudioContext, seconds = 3.2): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const clapLen = Math.floor(sr * 0.014);
  const claps = 1100;
  for (let c = 0; c < claps; c++) {
    // Biased to the front: the room comes in together and leaves raggedly.
    const u = Math.random() ** 1.7;
    const at = Math.floor(u * (len - clapLen));
    const amp = 0.05 + Math.random() * 0.16;
    for (let i = 0; i < clapLen; i++) {
      const env = Math.exp(-i / (clapLen * 0.28));
      out[at + i] += (Math.random() * 2 - 1) * amp * env;
    }
  }
  // A whisper of the room underneath, so the gaps between claps are not silence.
  for (let i = 0; i < len; i++) out[i] += (Math.random() * 2 - 1) * 0.012;
  return buf;
}

/** Sparse sharp impulses — the tail of a firework, gravel on a roof. */
function crackleBuffer(ctx: BaseAudioContext, seconds = 1.8): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const pops = 260;
  for (let c = 0; c < pops; c++) {
    const u = Math.random() ** 1.4;
    const at = Math.floor(u * (len - 400));
    const n = 60 + Math.floor(Math.random() * 180);
    const amp = 0.1 + Math.random() * 0.4;
    for (let i = 0; i < n; i++) out[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (n * 0.2));
  }
  return buf;
}

/**
 * The "Oooh" a stand gives the moment its own tifo appears.
 *
 * A crowd's vowel, not a roar: the roar is a noise swell that takes a third of
 * a second to arrive and reads as "something happened". This is thousands of
 * voices on one long "oo" — eight saws scattered over a man's speaking range,
 * through the two formants of /u/ (about 330 and 850 Hz), with breath under
 * them — and it is IN within 40 ms, because people do not decide to go "Oooh",
 * it comes out of them. The pitch lifts and then falls away, which is the
 * shape of the sound more than anything else is. The drop gets a lower,
 * longer, falling one.
 */
function crowdOoh(ctx: BaseAudioContext, out: AudioNode, breath: AudioBuffer, at: number, drop: boolean): AudioScheduledSourceNode[] {
  const started: AudioScheduledSourceNode[] = [];
  const len = drop ? 3.0 : 2.6;
  const f1 = ctx.createBiquadFilter();
  f1.type = 'bandpass';
  // setValueAtTime rather than .value, so a test can find the moment it lands.
  f1.frequency.setValueAtTime(330, at);
  f1.Q.value = 2.4;
  const f2 = ctx.createBiquadFilter();
  f2.type = 'bandpass';
  f2.frequency.value = 850;
  f2.Q.value = 4;
  const f2g = ctx.createGain();
  f2g.gain.value = 0.45;
  const body = ctx.createGain();
  body.gain.setValueAtTime(0.0001, at);
  const peak = drop ? 1.0 : 1.25;
  body.gain.exponentialRampToValueAtTime(peak * 0.7, at + 0.04);
  body.gain.exponentialRampToValueAtTime(peak, at + 0.3);
  body.gain.setValueAtTime(peak, at + 0.7);
  body.gain.exponentialRampToValueAtTime(0.0001, at + len);
  f1.connect(body);
  f2.connect(f2g).connect(body);
  body.connect(out);

  for (let v = 0; v < 8; v++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 105 + Math.random() * 80;
    const lift = drop ? 1.0 : 1.07;
    const fall = drop ? 0.82 : 0.9;
    o.frequency.setValueAtTime(f * (drop ? 1.02 : 0.95), at);
    o.frequency.exponentialRampToValueAtTime(f * lift, at + 0.35);
    o.frequency.exponentialRampToValueAtTime(f * fall, at + len);
    const g = ctx.createGain();
    g.gain.value = 0.13;
    o.connect(g);
    g.connect(f1);
    g.connect(f2);
    o.start(at);
    o.stop(at + len + 0.05);
    started.push(o);
  }

  // Breath: the part of four thousand people that is not pitch at all.
  const air = ctx.createBufferSource();
  air.buffer = breath;
  air.loop = true;
  const af = ctx.createBiquadFilter();
  af.type = 'bandpass';
  af.frequency.value = 420;
  af.Q.value = 0.9;
  const ag = ctx.createGain();
  ag.gain.value = 0.55;
  air.connect(af).connect(ag).connect(body);
  air.start(at, Math.random() * 2);
  air.stop(at + len + 0.05);
  started.push(air);
  return started;
}

export function buildAtmosphere(): Atmosphere {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let streamDest: MediaStreamAudioDestinationNode | null = null;
  const bus: Partial<Record<SoundBus, GainNode>> = {};

  let bed: AudioBufferSourceNode | null = null;
  let bedGain: GainNode | null = null;
  let weatherSrc: AudioBufferSourceNode | null = null;
  let weatherGain: GainNode | null = null;
  let swellTimer: number | undefined;
  let drumTimer: number | undefined;
  /** Tabl hits and oohs booked ahead on the audio clock, so a stopped show can take them back. */
  const booked: { start: number; end: number; nodes: AudioScheduledSourceNode[] }[] = [];
  /**
   * Where on the audio clock something due `inSec` from now must be started.
   *
   * Sound leaves the speaker later than it is started — the output buffer, and
   * on Bluetooth a good fifth of a second more — so it is started that much
   * EARLY, which is the only way for the "Oooh" to arrive with the picture
   * rather than after it. Capped: a figure a driver reports wildly is not
   * worth moving a count by.
   */
  const bookAt = (inSec: number, from?: number): number => {
    const c = ctx as AudioContext;
    const lead = Math.min(0.25, Math.max(0, (c.outputLatency || 0) + (c.baseLatency || 0)));
    // Tidy as we go: forget anything long finished.
    for (let i = booked.length - 1; i >= 0; i--) if (booked[i].end < c.currentTime) booked.splice(i, 1);
    const origin = from ?? c.currentTime;
    return Math.max(c.currentTime + 0.005, origin + 0.005 + inSec - lead);
  };
  /** Terrace-drum hits already scheduled, so switching the drum off takes back the one still to come. */
  let loopHits: { at: number; nodes: AudioScheduledSourceNode[] }[] = [];

  let noise: AudioBuffer | null = null;
  let white: AudioBuffer | null = null;
  let claps: AudioBuffer | null = null;
  let crackle: AudioBuffer | null = null;

  const levels: SoundLevels = { ...DEFAULT_LEVELS };
  let muted = false;
  let enabled = false;
  let suspended = false;
  let drumming = false;
  let fill = 1;
  let weather: WeatherSound = 'clear';
  let weatherStrength = 1;

  const AudioCtor = typeof window !== 'undefined'
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;

  /** Master, after mute. Kept in one place so mute and level cannot disagree. */
  const masterTarget = (): number => (muted ? 0 : levels.master);
  /** The crowd is only as loud as the ground is full — never quite silent. */
  const crowdTarget = (): number => levels.crowd * (0.18 + 0.82 * fill);

  const ramp = (p: AudioParam, v: number, tau = 0.05): void => {
    if (!ctx) return;
    p.setTargetAtTime(v, ctx.currentTime, tau);
  };

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
      limiter = ctx.createDynamicsCompressor();
      // A limiter, not a compressor: a high ratio above a ceiling that only the
      // sum of several sources reaches, so nothing is squashed until something
      // would otherwise clip.
      limiter.threshold.value = -6;
      limiter.knee.value = 4;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.22;
      limiter.connect(ctx.destination);

      master = ctx.createGain();
      master.gain.value = masterTarget();
      master.connect(limiter);

      for (const name of ['crowd', 'sfx', 'amb', 'drum'] as SoundBus[]) {
        const g = ctx.createGain();
        g.gain.value = name === 'crowd' ? crowdTarget() : levels[name];
        g.connect(master);
        bus[name] = g;
      }

      noise = pinkNoise(ctx);
      white = whiteNoise(ctx);
      claps = applauseBuffer(ctx);
      crackle = crackleBuffer(ctx);
    }
    // resume() only settles once the browser lets the context run. Without a
    // user gesture yet (sound is on by default now, so this can run on open)
    // it can sit pending indefinitely — so it is given a moment, not forever,
    // and the caller retries on the first gesture.
    if (ctx.state === 'suspended' && !suspended) {
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    }
    return ctx.state === 'running';
  };

  /** Every one-shot goes through here, so "is it allowed to make a noise" is asked once. */
  const live = (b: SoundBus): GainNode | null => {
    if (!ctx || !enabled || suspended) return null;
    return bus[b] ?? null;
  };

  // ---- the crowd bed ------------------------------------------------------

  const startBed = (): void => {
    if (!ctx || !noise || bed) return;
    const out = bus.crowd;
    if (!out) return;
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
    bed.connect(band).connect(tilt).connect(bedGain).connect(out);
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

  // ---- weather ------------------------------------------------------------

  const stopWeather = (): void => {
    try { weatherSrc?.stop(); } catch { /* already stopped */ }
    weatherSrc?.disconnect();
    weatherSrc = null;
    weatherGain = null;
  };

  /**
   * Rain is bright and constant; wind is dark and slow.
   *
   * Both are the same white-noise loop with a different filter on it, which is
   * most of what separates them in the real world too. Snow gets the wind and
   * nothing else — snow falling is silent, and a stadium in snow sounds like a
   * stadium in wind.
   */
  const startWeather = (): void => {
    if (!ctx || !white) return;
    const out = bus.amb;
    if (!out) return;
    stopWeather();
    if (weather === 'clear' || weatherStrength <= 0) return;

    weatherSrc = ctx.createBufferSource();
    weatherSrc.buffer = white;
    weatherSrc.loop = true;
    weatherGain = ctx.createGain();

    if (weather === 'rain') {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      weatherGain.gain.value = 0.16 * weatherStrength;
      weatherSrc.connect(hp).connect(lp).connect(weatherGain).connect(out);
    } else {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      // The gust. Wind that does not move is a fan.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 190;
      lfo.connect(lfoGain).connect(lp.frequency);
      lfo.start();
      weatherGain.gain.value = 0.2 * weatherStrength;
      weatherSrc.connect(lp).connect(weatherGain).connect(out);
    }
    weatherSrc.start(0, Math.random() * 2);
  };

  // ---- the drum -----------------------------------------------------------

  /** One drum hit: a pitch-dropping sine with a noise transient for the skin. */
  const hit = (at: number, gain: number): void => {
    if (!ctx || !noise) return;
    const out = bus.drum;
    if (!out) return;
    const nodes: AudioScheduledSourceNode[] = [];
    loopHits = loopHits.filter((h) => h.at > ctx!.currentTime - 1);
    loopHits.push({ at, nodes });
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, at);
    osc.frequency.exponentialRampToValueAtTime(48, at + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.5);
    nodes.push(osc);

    const click = ctx.createBufferSource();
    click.buffer = noise;
    click.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 1800;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(gain * 0.5, at);
    cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    click.connect(cf).connect(cg).connect(out);
    click.start(at, Math.random() * 2);
    click.stop(at + 0.08);
    nodes.push(click);
  };

  /** 60/96 s — where a terrace drum sits, slow enough to clap over. */
  const BEAT = 60 / 96;

  return {
    isEnabled: () => enabled,
    isDrumming: () => drumming,
    isMuted: () => muted,
    getLevels: () => ({ ...levels }),

    async setEnabled(on: boolean): Promise<void> {
      if (on) {
        if (!(await ensure())) return;
        enabled = true;
        suspended = false;
        startBed();
        startWeather();
        if (drumming) this.setDrum(true);
      } else {
        enabled = false;
        stopBed();
        stopWeather();
        window.clearInterval(drumTimer);
        drumTimer = undefined;
        void ctx?.suspend().catch(() => undefined);
      }
    },

    setSuspended(on: boolean): void {
      suspended = on;
      if (!ctx || !enabled) return;
      if (on) void ctx.suspend().catch(() => undefined);
      else void ctx.resume().catch(() => undefined);
    },

    setLevel(b: 'master' | SoundBus, v: number): void {
      const val = Math.max(0, Math.min(1, v));
      levels[b] = val;
      if (!ctx) return;
      if (b === 'master') ramp(master!.gain, masterTarget());
      else if (b === 'crowd') ramp(bus.crowd!.gain, crowdTarget());
      else ramp(bus[b]!.gain, val);
    },

    setMuted(m: boolean): void {
      muted = m;
      if (ctx && master) ramp(master.gain, masterTarget(), 0.03);
    },

    setCrowdFill(f: number): void {
      fill = Math.max(0, Math.min(1, f));
      if (ctx && bus.crowd) ramp(bus.crowd.gain, crowdTarget(), 0.3);
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
      const out = live('crowd');
      if (!out || !ctx || !noise) return;
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
      src.connect(band).connect(g).connect(out);
      src.start(now, Math.random() * 2);
      src.stop(now + 4.7);
    },

    applause(strength = 1): void {
      const out = live('crowd');
      if (!out || !ctx || !claps) return;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = claps;
      // A touch of lift so it sits above the bed without being brighter than it.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 420;
      const g = ctx.createGain();
      const peak = 0.9 * Math.max(0.15, Math.min(1, strength));
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.18);
      g.gain.setValueAtTime(peak, now + 1.4);
      g.gain.exponentialRampToValueAtTime(0.0001, now + claps.duration);
      src.connect(hp).connect(g).connect(out);
      src.start(now);
      src.stop(now + claps.duration + 0.05);
    },

    /**
     * A chant.
     *
     * Not words — a crowd chanting is four thousand people roughly in unison and
     * badly in tune, which at any distance is a vowel with a wide spread and no
     * consonants at all. Three detuned saws through two formant bandpasses (an
     * "ah" at 700 and 1150 Hz) gated in the drum's own rhythm gets you the whole
     * effect, and trying for actual words gets you a robot.
     */
    chant(): void {
      const out = live('crowd');
      if (!out || !ctx) return;
      const now = ctx.currentTime + 0.05;
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 700;
      f1.Q.value = 4;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1150;
      f2.Q.value = 6;
      const body = ctx.createGain();
      body.gain.value = 0.0001;
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      f1.connect(mix);
      f2.connect(mix);
      mix.connect(body).connect(out);

      const oscs: OscillatorNode[] = [];
      // A hundred people singing the same note are not singing the same note.
      for (const cents of [-9, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 146.83 * Math.pow(2, cents / 1200); // D3
        o.connect(f1);
        o.connect(f2);
        oscs.push(o);
      }
      // "Oh — oh — oh-oh-oh": two long, three short, which is every terrace on
      // earth and is why it needs no words to be recognised.
      const pattern: [number, number][] = [
        [0, BEAT * 0.9], [BEAT, BEAT * 0.9],
        [BEAT * 2, BEAT * 0.4], [BEAT * 2.5, BEAT * 0.4], [BEAT * 3, BEAT * 0.9],
      ];
      for (const [at, dur] of pattern) {
        const t = now + at;
        body.gain.setValueAtTime(0.0001, t);
        body.gain.exponentialRampToValueAtTime(0.5, t + 0.07);
        body.gain.setValueAtTime(0.5, t + dur * 0.7);
        body.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      }
      const end = now + BEAT * 4;
      for (const o of oscs) { o.start(now); o.stop(end + 0.1); }
    },

    whistle(long = false): void {
      const out = live('sfx');
      if (!out || !ctx) return;
      const now = ctx.currentTime;
      const hold = long ? 1.5 : 0.5;
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
      g.gain.setValueAtTime(0.16, now + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, now + hold + 0.12);
      osc.connect(g).connect(out);
      osc.start(now);
      lfo.start(now);
      osc.stop(now + hold + 0.2);
      lfo.stop(now + hold + 0.2);
    },

    /**
     * The air horn.
     *
     * A stack of saws a fifth apart through a lowpass, which is what a reed horn
     * is: one note, badly, very loudly. The pitch sags as the can empties —
     * without that it is a synth chord, with it everyone knows exactly what it is.
     */
    airhorn(): void {
      const out = live('sfx');
      if (!out || !ctx) return;
      const now = ctx.currentTime;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.28, now + 0.03);
      g.gain.setValueAtTime(0.28, now + 0.95);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
      lp.connect(g).connect(out);
      for (const f of [311.1, 466.2, 622.3]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, now);
        o.frequency.setValueAtTime(f, now + 0.8);
        o.frequency.linearRampToValueAtTime(f * 0.94, now + 1.25);
        o.connect(lp);
        o.start(now);
        o.stop(now + 1.3);
      }
    },

    /** Pyro: the whoosh going up, the thump, then the crackle coming down. */
    pyro(): void {
      const out = live('sfx');
      if (!out || !ctx || !white || !crackle) return;
      const now = ctx.currentTime;

      const air = ctx.createBufferSource();
      air.buffer = white;
      const sweep = ctx.createBiquadFilter();
      sweep.type = 'bandpass';
      sweep.Q.value = 1.1;
      sweep.frequency.setValueAtTime(220, now);
      sweep.frequency.exponentialRampToValueAtTime(4200, now + 0.38);
      const ag = ctx.createGain();
      ag.gain.setValueAtTime(0.0001, now);
      ag.gain.exponentialRampToValueAtTime(0.4, now + 0.1);
      ag.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      air.connect(sweep).connect(ag).connect(out);
      air.start(now, Math.random() * 2);
      air.stop(now + 0.6);

      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(90, now + 0.34);
      thump.frequency.exponentialRampToValueAtTime(38, now + 0.62);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, now + 0.34);
      tg.gain.exponentialRampToValueAtTime(0.5, now + 0.36);
      tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      thump.connect(tg).connect(out);
      thump.start(now + 0.34);
      thump.stop(now + 0.85);

      const cr = ctx.createBufferSource();
      cr.buffer = crackle;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.28, now + 0.42);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.42 + crackle.duration);
      cr.connect(cg).connect(out);
      cr.start(now + 0.42);
      cr.stop(now + 0.45 + crackle.duration);
    },

    /** Paper in the air: bright, weightless, and gone. */
    confetti(): void {
      const out = live('sfx');
      if (!out || !ctx || !white) return;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = white;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.1, now + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
      // The flutter. Paper is not a hiss; it is a hiss being interrupted.
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = 11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.045;
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start(now);
      lfo.stop(now + 2.5);
      src.connect(hp).connect(g).connect(out);
      src.start(now, Math.random() * 2);
      src.stop(now + 2.5);
    },

    /**
     * Floodlights.
     *
     * The contactor closing is the sound everyone actually associates with
     * stadium lights coming on — a hard mechanical clunk — and the hum that
     * follows is the tubes striking. Turning them off is the clunk without it.
     */
    floodlights(on: boolean): void {
      const out = live('sfx');
      if (!out || !ctx || !white) return;
      const now = ctx.currentTime;
      const clunk = ctx.createOscillator();
      clunk.type = 'sine';
      clunk.frequency.setValueAtTime(140, now);
      clunk.frequency.exponentialRampToValueAtTime(52, now + 0.09);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.exponentialRampToValueAtTime(0.34, now + 0.005);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      clunk.connect(cg).connect(out);
      clunk.start(now);
      clunk.stop(now + 0.2);

      const tick = ctx.createBufferSource();
      tick.buffer = white;
      const tf = ctx.createBiquadFilter();
      tf.type = 'bandpass';
      tf.frequency.value = 2600;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.14, now);
      tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      tick.connect(tf).connect(tg).connect(out);
      tick.start(now, Math.random() * 2);
      tick.stop(now + 0.06);

      if (!on) return;
      // 100 Hz, not 50: a choke hums at twice the mains frequency.
      const hum = ctx.createOscillator();
      hum.type = 'sawtooth';
      hum.frequency.value = 100;
      const hf = ctx.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 500;
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.0001, now + 0.1);
      hg.gain.exponentialRampToValueAtTime(0.045, now + 1.1);
      hg.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
      hum.connect(hf).connect(hg).connect(out);
      hum.start(now + 0.1);
      hum.stop(now + 3.5);
    },

    setDrum(on: boolean): void {
      drumming = on;
      window.clearInterval(drumTimer);
      drumTimer = undefined;
      // The loop books its off-beat a third of a second ahead; switched off
      // (say, for a drum call's count) that beat must not still land.
      const t = ctx?.currentTime ?? 0;
      for (const h of loopHits) {
        if (h.at <= t) continue;
        for (const n of h.nodes) {
          try { n.stop(); } catch { /* already stopped */ }
        }
      }
      loopHits = loopHits.filter((h) => h.at <= t);
      if (!on || !enabled || suspended || !ctx) return;
      // Scheduled a beat ahead on the audio clock rather than played from the
      // timer, because setInterval drifts and a drum that drifts is worse than
      // no drum.
      const tick = (): void => {
        if (!ctx) return;
        const at = ctx.currentTime + 0.05;
        hit(at, 0.4);
        hit(at + BEAT * 0.5, 0.16);
      };
      tick();
      drumTimer = window.setInterval(tick, BEAT * 1000);
    },

    audioNow: () => ctx?.currentTime ?? 0,

    drumHit(accent = false, inSec = 0, from?: number): void {
      if (!ctx || !enabled || suspended || !bus.drum) return;
      const at = bookAt(inSec, from);
      booked.push({ start: at, end: at + 1.1, nodes: tablHit(ctx, bus.drum, at, accent ? 1.1 : 0.9) });
    },

    ooh(inSec = 0, drop = false, from?: number): void {
      const out = live('crowd');
      if (!ctx || !out || !noise) return;
      const at = bookAt(inSec, from);
      booked.push({ start: at, end: at + 3.4, nodes: crowdOoh(ctx, out, noise, at, drop) });
    },

    cancelBooked(): void {
      const now = ctx?.currentTime ?? 0;
      for (const b of booked) {
        // Only what has not started: a hit already ringing is left to ring.
        if (b.start <= now) continue;
        for (const n of b.nodes) {
          try {
            n.stop();
          } catch {
            /* already stopped */
          }
        }
      }
      booked.length = 0;
    },

    setWeatherBed(w: WeatherSound, intensity = 1): void {
      weather = w;
      weatherStrength = Math.max(0, Math.min(1, intensity));
      if (!ctx || !enabled) return;
      startWeather();
    },

    captureStream(): MediaStream | null {
      if (!ctx || !limiter) return null;
      if (!streamDest) {
        streamDest = ctx.createMediaStreamDestination();
        limiter.connect(streamDest);
      }
      return streamDest.stream;
    },

    dispose(): void {
      stopBed();
      stopWeather();
      window.clearInterval(drumTimer);
      void ctx?.close().catch(() => undefined);
      ctx = null;
      master = null;
      limiter = null;
      streamDest = null;
      noise = null;
      white = null;
      claps = null;
      crackle = null;
      enabled = false;
      suspended = false;
    },
  };
}
