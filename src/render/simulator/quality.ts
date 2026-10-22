/**
 * Match Day Simulator — quality tiers + capability probe.
 *
 * Pure and DOM-light (only a one-off WebGL probe), so it is trivially testable.
 * The simulator reads a QualitySettings to decide shadows, pixel ratio, AA, and
 * fog. LOW maps to "don't bother — use the editor renderer"; the simulator
 * itself runs MEDIUM and up. Everything here is advisory: the caller can always
 * override the tier, and the simulator degrades gracefully if a feature is off.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  /** Cast/receive real shadows (directional sun). */
  shadows: boolean;
  /** Hard ceiling on devicePixelRatio (perf lever). */
  maxPixelRatio: number;
  /** MSAA on the default framebuffer. */
  antialias: boolean;
  /** Distance fog for depth/atmosphere. */
  fog: boolean;
  /** Shadow map resolution when shadows are on. */
  shadowMapSize: number;
  /** Image-based lighting (night-sky env) for PBR ambient + reflections. */
  ibl: boolean;
  /** scene.environmentIntensity applied when ibl is on. */
  envIntensity: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: { tier: 'low', shadows: false, maxPixelRatio: 1, antialias: false, fog: false, shadowMapSize: 0, ibl: false, envIntensity: 0 },
  medium: { tier: 'medium', shadows: false, maxPixelRatio: 1.5, antialias: true, fog: true, shadowMapSize: 0, ibl: true, envIntensity: 0.22 },
  high: { tier: 'high', shadows: true, maxPixelRatio: 2, antialias: true, fog: true, shadowMapSize: 2048, ibl: true, envIntensity: 0.45 },
  ultra: { tier: 'ultra', shadows: true, maxPixelRatio: 2, antialias: true, fog: true, shadowMapSize: 4096, ibl: true, envIntensity: 0.55 },
};

export const ALL_TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export function settingsFor(tier: QualityTier): QualitySettings {
  return QUALITY_PRESETS[tier] ?? QUALITY_PRESETS.high;
}

/** The probe's answer, kept for the page's life: nothing it reads changes. */
let probed: QualityTier | null = null;

/**
 * Pick a sensible default tier for this device. Conservative on mobile / low
 * memory; HIGH (not ULTRA) on capable desktops so first paint stays smooth and
 * the user can opt up to ULTRA explicitly.
 *
 * Asked once a page. The WebGL check makes a context of its own, which it
 * gives straight back: it used to be made on every Match Day open and kept,
 * one more live context each time towards Chrome's limit (performance plan
 * P1.19).
 */
export function probeQuality(): QualityTier {
  if (probed) return probed;
  try {
    if (typeof document === 'undefined') return 'high';
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGLRenderingContext | null) ||
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return 'low';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (isMobile) return (probed = mem !== undefined && mem <= 3 ? 'low' : 'medium');
    if (mem !== undefined && mem <= 4) return (probed = 'medium');
    return (probed = 'high');
  } catch {
    return 'low';
  }
}
