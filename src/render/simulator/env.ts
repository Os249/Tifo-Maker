import * as THREE from 'three';

/**
 * Night-sky image-based lighting. Attaches a dim, PMREM-prefiltered environment
 * to the scene so every PBR surface gets real ambient + reflections (wet pitch,
 * seat plastic, cloth banners) instead of flat shading — the single biggest
 * realism lever for the Match Day look. The environment is a dark vertical
 * gradient (deep-navy zenith → floodlit horizon haze) with four soft light
 * glows around the horizon so glossy surfaces catch highlights. Kept low
 * intensity so it only lifts the image, never washes it out. Returns the env
 * texture so the caller can dispose it on teardown.
 */
export function applyNightIBL(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  intensity = 0.32,
): THREE.Texture {
  const w = 512;
  const h = 256;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, '#05070d');
  g.addColorStop(0.55, '#0d1526');
  g.addColorStop(0.72, '#243349');
  g.addColorStop(0.86, '#3a4a63');
  g.addColorStop(1.0, '#0a0e16');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const cx of [0.14, 0.4, 0.6, 0.86]) {
    const rg = ctx.createRadialGradient(cx * w, h * 0.66, 0, cx * w, h * 0.66, w * 0.11);
    rg.addColorStop(0, 'rgba(230,235,255,0.55)');
    rg.addColorStop(1, 'rgba(230,235,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  const equi = new THREE.CanvasTexture(cv);
  equi.mapping = THREE.EquirectangularReflectionMapping;
  equi.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(equi).texture;
  pmrem.dispose();
  equi.dispose();
  scene.environment = env;
  scene.environmentIntensity = intensity;
  return env;
}
