/**
 * The drum call — the Saudi way of showing a card tifo.
 *
 * Nobody sweeps anything. The stand sits still; the drum hits three times;
 * on the next beat every card in the stand goes up at once and the picture is
 * simply THERE. It holds. Three more hits, and on the next beat every card
 * comes down together and the picture is gone — the disappearance is half the
 * show. Then, often, it happens again.
 *
 *     DOOM · DOOM · DOOM · [up] ……… hold ……… DOOM · DOOM · DOOM · [down]
 *
 * This file is the whole of that as pure arithmetic: when the hits land, when
 * the cards move, and how far up any one seat's card is at any instant. The
 * editor preview, the flat GIF, the 3D export and Match Day all read it, so
 * the show is the same show wherever it is played, scrubbed or recorded.
 *
 * "At once" is a crowd, not a switch. A person hears the third hit, waits for
 * the beat, and lifts — most within a tenth of a second of each other, a few
 * late. So each seat has its own small, fixed reaction delay (skewed so most
 * are quick), and a card takes a moment to come up. The whole stand is still
 * up well inside half a second, which is what reads as "all at once" from the
 * other side of the ground — and the ragged edge is what stops it reading as a
 * light being switched on.
 */

export interface DrumCallOpts {
  /** Seconds between hits. A terrace count sits near 100 BPM. */
  beat?: number;
  /** Seconds the picture is held up, from the lift to the first hit of the drop. */
  hold?: number;
  /** How many up/down cycles. Crowds repeat it; one is the minimum show. */
  times?: number;
}

/** Everything else about the call, fixed — these are what make it read right. */
export const DRUM_CALL = {
  beat: 0.6,
  hold: 4,
  times: 1,
  /** Quiet before the first hit, so the first one is heard as a start. */
  lead: 0.4,
  /** Down time between cycles before the next count starts. */
  rest: 2.4,
  /** The slowest fan's reaction delay, seconds. */
  jitter: 0.35,
  /** How long a card takes to come up (or go down), seconds. */
  lift: 0.14,
  /** Held after the last drop, so a clip ends on the empty stand, not mid-flip. */
  tail: 0.6,
  /** Limits the controls offer. */
  minHold: 1,
  maxHold: 12,
  maxTimes: 3,
} as const;

export interface DrumHit {
  /** Seconds from the start of the call. */
  t: number;
  /** 1, 2 or 3 — which hit of its count this is. */
  count: 1 | 2 | 3;
  /** What the count leads to. */
  phase: 'up' | 'down';
  cycle: number;
}

export interface DrumCallPlan {
  beat: number;
  hold: number;
  times: number;
  jitter: number;
  lift: number;
  hits: DrumHit[];
  /** The beat each cycle's cards go up on (before any seat's own delay). */
  ups: number[];
  /** The beat each cycle's cards come down on. */
  downs: number[];
  /** Seconds from the start to the last card down, plus the tail. */
  duration: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Build the call. Out-of-range options are clamped, never rejected. */
export function drumCallPlan(opts: DrumCallOpts = {}): DrumCallPlan {
  const beat = clamp(Number.isFinite(opts.beat) ? (opts.beat as number) : DRUM_CALL.beat, 0.3, 1.2);
  const hold = clamp(Number.isFinite(opts.hold) ? (opts.hold as number) : DRUM_CALL.hold, DRUM_CALL.minHold, DRUM_CALL.maxHold);
  const times = Math.round(clamp(Number.isFinite(opts.times) ? (opts.times as number) : DRUM_CALL.times, 1, DRUM_CALL.maxTimes));
  const hits: DrumHit[] = [];
  const ups: number[] = [];
  const downs: number[] = [];
  let t: number = DRUM_CALL.lead;
  for (let c = 0; c < times; c++) {
    for (let k = 0; k < 3; k++) hits.push({ t: t + k * beat, count: (k + 1) as 1 | 2 | 3, phase: 'up', cycle: c });
    // Three hits, then the cards move on the fourth beat — "one, two, three, UP".
    const up = t + 3 * beat;
    ups.push(up);
    const dropCount = up + hold;
    for (let k = 0; k < 3; k++) hits.push({ t: dropCount + k * beat, count: (k + 1) as 1 | 2 | 3, phase: 'down', cycle: c });
    const down = dropCount + 3 * beat;
    downs.push(down);
    t = down + DRUM_CALL.rest;
  }
  const last = downs[downs.length - 1];
  return {
    beat,
    hold,
    times,
    jitter: DRUM_CALL.jitter,
    lift: DRUM_CALL.lift,
    hits,
    ups,
    downs,
    duration: last + DRUM_CALL.jitter + DRUM_CALL.lift + DRUM_CALL.tail,
  };
}

/** The part of a one-cycle call that is not the hold. */
export function drumCallFixedSeconds(beat: number = DRUM_CALL.beat): number {
  return DRUM_CALL.lead + 6 * beat + DRUM_CALL.jitter + DRUM_CALL.lift + DRUM_CALL.tail;
}

/** The shortest one-cycle call, in whole seconds — what a length control should start at. */
export const DRUM_CALL_MIN_LENGTH = Math.ceil(drumCallFixedSeconds() + DRUM_CALL.minHold);

/**
 * A one-cycle call that fills `seconds` exactly, by giving the hold whatever
 * the count-ins and the tail leave over. For the editor, whose one control is
 * the length of the whole animation.
 */
export function drumCallPlanForLength(seconds: number): DrumCallPlan {
  return drumCallPlan({ hold: seconds - drumCallFixedSeconds() });
}

/** Deterministic hash → [0,1). Salted so a seat's lift and drop are independent. */
function hash01(n: number, salt: number): number {
  let x = (Math.imul(n, 374761393) + Math.imul(salt, 668265263)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/**
 * A seat's reaction delay as a fraction of the slowest, 0..1.
 *
 * Cubed, so it is skewed hard towards quick: about 70% of the stand moves in
 * the first third of the window and the last few percent straggle in. That
 * is what a real stand looks like on the replay.
 */
export function seatReaction(seat: number, which: 'up' | 'down'): number {
  const h = hash01(seat, which === 'up' ? 1 : 2);
  return h * h * h;
}

/**
 * How far up one seat's card is at `t` seconds into the call: 0 down, 1 up.
 *
 * Every cycle is "up, then down", so the card is up only between its own lift
 * and its own drop, and the cycles never overlap (`rest` keeps them apart).
 */
export function drumCallVisibility(plan: DrumCallPlan, seat: number, t: number): number {
  if (t < plan.ups[0]) return 0;
  const ju = seatReaction(seat, 'up') * plan.jitter;
  const jd = seatReaction(seat, 'down') * plan.jitter;
  let v = 0;
  for (let k = 0; k < plan.ups.length; k++) {
    const r = (t - plan.ups[k] - ju) / plan.lift;
    if (r <= 0) break;
    const f = (t - plan.downs[k] - jd) / plan.lift;
    const up = r >= 1 ? 1 : r;
    const down = f <= 0 ? 0 : f >= 1 ? 1 : f;
    const here = up * (1 - down);
    if (here > v) v = here;
  }
  return v;
}

/**
 * Where the count is at `t`, for a beat indicator: how many hits of the
 * current count have landed (0..3), which way it leads, and how fresh the
 * last hit is (1 on the hit, fading to 0 over a beat). `count` goes back to
 * 0 half a second after the cards move, so an indicator empties once the
 * thing it was counting towards has happened.
 */
export function drumCallBeat(plan: DrumCallPlan, t: number): { count: number; phase: 'up' | 'down' | null; pulse: number } {
  let last: DrumHit | null = null;
  for (const h of plan.hits) {
    if (h.t <= t) last = h;
    else break;
  }
  if (!last) return { count: 0, phase: null, pulse: 0 };
  const action = last.phase === 'up' ? plan.ups[last.cycle] : plan.downs[last.cycle];
  if (t > action + 0.5) return { count: 0, phase: null, pulse: 0 };
  const since = t - last.t;
  return { count: last.count, phase: last.phase, pulse: Math.max(0, 1 - since / plan.beat) };
}
