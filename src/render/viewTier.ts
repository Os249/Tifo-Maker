/**
 * How much the Stadium view asks of this device.
 *
 * A first guess from what the browser will say about the hardware — a phone
 * or not, its memory, its cores, the GPU's own name — and the picture is
 * rendered only when something moves, so the guess mostly decides how sharp
 * and how detailed a moving picture is. `?quality=low|medium|high` in the
 * address overrides it (for testing, and for anyone whose device guesses
 * wrong).
 *
 *   - low:    cheap phones and software rendering. 1x pixels, no MSAA, Lambert
 *             materials, one-panel chairs.
 *   - medium: most phones and integrated laptop graphics. Up to 1.5x pixels.
 *   - high:   a desktop or laptop with a real GPU. Up to 2x pixels.
 */
export type ViewTier = 'low' | 'medium' | 'high';

export interface ViewTierSettings {
  tier: ViewTier;
  /** Ceiling on devicePixelRatio while the picture is still. */
  maxPixelRatio: number;
  /** Pixel ratio while the camera is moving (sharpness comes back when it stops). */
  movingPixelRatio: number;
  antialias: boolean;
  chairs: 'full' | 'low';
}

export const VIEW_TIERS: Record<ViewTier, ViewTierSettings> = {
  low: { tier: 'low', maxPixelRatio: 1, movingPixelRatio: 0.75, antialias: false, chairs: 'low' },
  medium: { tier: 'medium', maxPixelRatio: 1.5, movingPixelRatio: 1, antialias: true, chairs: 'full' },
  high: { tier: 'high', maxPixelRatio: 2, movingPixelRatio: 1.5, antialias: true, chairs: 'full' },
};

/** Old or entry-level mobile GPUs, by the name WebGL reports for them. */
const WEAK_GPU = /Mali-(4|T|G3|G5[0-2]|G7[0-2])|Adreno \(?TM\)? ?[1-5]\d\d|Adreno [1-5]\d\d|PowerVR|SGX|VideoCore|SwiftShader|llvmpipe|Software/i;
/** Integrated laptop graphics: fine for a still, slower to orbit. */
const IGPU = /Intel|UHD|Iris|HD Graphics|Radeon\(TM\) (Vega|Graphics)|Mali|Adreno|Apple GPU/i;

function gpuName(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

let cached: ViewTier | null = null;

export function detectViewTier(): ViewTier {
  if (cached) return cached;
  try {
    const forced = new URLSearchParams(location.search).get('quality');
    if (forced === 'low' || forced === 'medium' || forced === 'high') return (cached = forced);
  } catch {
    /* no location: a test */
  }
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return (cached = 'medium');
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory;
  const cores = nav.hardwareConcurrency || 4;
  const phone = /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent) || (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const gpu = gpuName();
  if (!gpu && !phone) return (cached = 'medium');
  if (WEAK_GPU.test(gpu)) return (cached = 'low');
  if (phone) return (cached = (mem !== undefined && mem <= 3) || cores <= 4 ? 'low' : 'medium');
  if (IGPU.test(gpu) || (mem !== undefined && mem <= 4) || cores <= 4) return (cached = 'medium');
  return (cached = 'high');
}

export function viewTierSettings(tier: ViewTier = detectViewTier()): ViewTierSettings {
  return VIEW_TIERS[tier];
}
