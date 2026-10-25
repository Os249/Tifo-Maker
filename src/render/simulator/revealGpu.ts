import * as THREE from 'three';
import { seatReaction, type DrumCallPlan } from '../../core/drumCall';

/**
 * The card reveal, drawn by the GPU (performance plan P3.2).
 *
 * A reveal used to recolour every seat on the CPU every frame and send the
 * whole ground's colours again: 8.4 ms of JavaScript and 1.7 MB a frame on a
 * big ground. Every reveal the product has is the same small function of two
 * things: a number that belongs to the seat and never changes while the
 * reveal plays (when it goes up: its delay, its place across the bowl, its
 * hash, its reaction to the drum), and a number that belongs to the instant
 * (the clock). So the seat's number is sent once, when the reveal style is
 * chosen, and each frame sends only the instant — a handful of uniforms — and
 * the vertex shader works out every card's visibility itself.
 *
 * The arithmetic is the CPU's, step for step, in the same order (core/reveal,
 * core/drumCall, simulator/choreo), so a frame at a given time is the frame
 * the CPU drew at that time. The only difference is float32 against float64:
 * a card exactly on a threshold (0.02 to show, 0.5 for a premium card, 1 for
 * full colour) can land on the other side of it, and a colour exactly on a
 * rounding edge can come out one level apart.
 *
 *   mode 0  off: every card as designed (the shader returns 1)
 *   mode 1  fade, the Stadium view's reveals: clamp((clock - key) / fade)
 *   mode 2  ramp, Match Day's wipes: max(0, min(1, 1 - (key - threshold) / edge))
 *   mode 3  the same ramp, inverted (centre out)
 *   mode 4  step, Match Day's sparkle: key < progress
 *   mode 5  the drum call: up on its count, down on the drop, each seat on its own reaction
 *   mode 6  one value for every seat (the design settling back after a drum call)
 *
 * The seat's numbers: key.x is the style's own (delay, u, 1 - v, ...), key.y
 * and key.z the seat's reactions to the drum, in seconds, up and down.
 */

export const REVEAL_OFF = 0;
export const REVEAL_FADE = 1;
export const REVEAL_RAMP = 2;
export const REVEAL_RAMP_INVERTED = 3;
export const REVEAL_STEP = 4;
export const REVEAL_DRUM = 5;
export const REVEAL_CONST = 6;

/** The cycles a drum call may have (DRUM_CALL.maxTimes); one uniform slot each. */
const DRUM_CYCLES = 3;
/** An unused cycle's slot: every seat is long before it. */
const NEVER = -1e30;

export interface RevealUniforms {
  tifoRevealMode: { value: number };
  /** Mode parameters: fade (clock, fade), ramp (threshold, edge), step (progress), drum (lift), const (value). */
  tifoRevealA: { value: THREE.Vector2 };
  /** Drum call: seconds since each cycle's lift (t - ups[k]). */
  tifoRevealUp: { value: THREE.Vector3 };
  /** Drum call: seconds since each cycle's drop (t - downs[k]). */
  tifoRevealDown: { value: THREE.Vector3 };
}

export function revealUniforms(): RevealUniforms {
  return {
    tifoRevealMode: { value: REVEAL_OFF },
    tifoRevealA: { value: new THREE.Vector2() },
    tifoRevealUp: { value: new THREE.Vector3(NEVER, NEVER, NEVER) },
    tifoRevealDown: { value: new THREE.Vector3(NEVER, NEVER, NEVER) },
  };
}

/** Copy one set's values into another (a cached mesh's own uniforms follow the view that holds it). */
export function copyRevealUniforms(from: RevealUniforms, to: RevealUniforms): void {
  to.tifoRevealMode.value = from.tifoRevealMode.value;
  to.tifoRevealA.value.copy(from.tifoRevealA.value);
  to.tifoRevealUp.value.copy(from.tifoRevealUp.value);
  to.tifoRevealDown.value.copy(from.tifoRevealDown.value);
}

/**
 * The declarations and the function, for a vertex shader. The branches are on
 * a uniform, so every vertex of a draw takes the same one.
 */
export const REVEAL_GLSL = /* glsl */ `
uniform int tifoRevealMode;
uniform vec2 tifoRevealA;
uniform vec3 tifoRevealUp;
uniform vec3 tifoRevealDown;
float tifoDrumCycle( float sinceUp, float sinceDown, vec3 key ) {
  float r = ( sinceUp - key.y ) / tifoRevealA.x;
  if ( r <= 0.0 ) return 0.0;
  float f = ( sinceDown - key.z ) / tifoRevealA.x;
  float up = r >= 1.0 ? 1.0 : r;
  float down = f <= 0.0 ? 0.0 : ( f >= 1.0 ? 1.0 : f );
  return up * ( 1.0 - down );
}
float tifoRevealVis( vec3 key ) {
  if ( tifoRevealMode == 0 ) return 1.0;
  if ( tifoRevealMode == 1 ) {
    float t = ( tifoRevealA.x - key.x ) / tifoRevealA.y;
    return t <= 0.0 ? 0.0 : ( t >= 1.0 ? 1.0 : t );
  }
  if ( tifoRevealMode == 2 || tifoRevealMode == 3 ) {
    float t = ( key.x - tifoRevealA.x ) / tifoRevealA.y;
    float v = max( 0.0, min( 1.0, 1.0 - t ) );
    return tifoRevealMode == 2 ? v : 1.0 - v;
  }
  if ( tifoRevealMode == 4 ) return key.x < tifoRevealA.x ? 1.0 : 0.0;
  if ( tifoRevealMode == 5 ) {
    float v = tifoDrumCycle( tifoRevealUp.x, tifoRevealDown.x, key );
    v = max( v, tifoDrumCycle( tifoRevealUp.y, tifoRevealDown.y, key ) );
    return max( v, tifoDrumCycle( tifoRevealUp.z, tifoRevealDown.z, key ) );
  }
  return tifoRevealA.x;
}
`;

export function revealOff(u: RevealUniforms): void {
  u.tifoRevealMode.value = REVEAL_OFF;
}

/** core/reveal's sweeps: (clock - delay) / fade, clamped. */
export function revealFade(u: RevealUniforms, clock: number, fade: number): void {
  u.tifoRevealMode.value = REVEAL_FADE;
  u.tifoRevealA.value.set(clock, fade);
}

/** simulator/choreo's ramp(threshold, key), or 1 minus it. */
export function revealRamp(u: RevealUniforms, threshold: number, edge: number, inverted: boolean): void {
  u.tifoRevealMode.value = inverted ? REVEAL_RAMP_INVERTED : REVEAL_RAMP;
  u.tifoRevealA.value.set(threshold, edge);
}

export function revealStep(u: RevealUniforms, progress: number): void {
  u.tifoRevealMode.value = REVEAL_STEP;
  u.tifoRevealA.value.set(progress, 0);
}

export function revealConst(u: RevealUniforms, value: number): void {
  u.tifoRevealMode.value = REVEAL_CONST;
  u.tifoRevealA.value.set(value, 0);
}

/**
 * core/drumCall's drumCallVisibility at `t` seconds into `plan`. The seconds
 * since each cycle's lift and drop are taken here, in double precision, so the
 * shader is left with one subtraction a cycle, as the CPU was.
 */
export function revealDrum(u: RevealUniforms, plan: DrumCallPlan, t: number): void {
  u.tifoRevealMode.value = REVEAL_DRUM;
  u.tifoRevealA.value.set(plan.lift, 0);
  const up = [NEVER, NEVER, NEVER];
  const down = [NEVER, NEVER, NEVER];
  for (let k = 0; k < Math.min(DRUM_CYCLES, plan.ups.length); k++) {
    up[k] = t - plan.ups[k];
    down[k] = t - plan.downs[k];
  }
  u.tifoRevealUp.value.set(up[0], up[1], up[2]);
  u.tifoRevealDown.value.set(down[0], down[1], down[2]);
}

/**
 * Every seat's reaction to the drum, in seconds (seatReaction × jitter), up
 * and down: the same two numbers drumCallVisibility works out for a seat each
 * time it is asked. They depend on the seat's index alone.
 */
export function drumReactions(count: number, jitter: number): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = seatReaction(i, 'up') * jitter;
    out[i * 2 + 1] = seatReaction(i, 'down') * jitter;
  }
  return out;
}
