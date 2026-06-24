import * as THREE from 'three';

/**
 * Image asset pipeline (Wave F3).
 *
 * Helpers to turn an uploaded/imported image (a data URL or object URL) into a
 * Three.js texture for banners and surface tifos, and to measure an image's
 * aspect ratio so an asset can size itself correctly. Kept tiny and dependency-
 * free; the editor's existing image-import produces the data URLs these consume.
 */

export interface LoadedImage {
  url: string;
  width: number;
  height: number;
  aspect: number;
}

/** Load an image URL/data URL and resolve its natural dimensions. */
export function loadImage(url: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () =>
      resolve({ url, width: img.naturalWidth, height: img.naturalHeight, aspect: img.naturalWidth / Math.max(1, img.naturalHeight) });
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

/** Texture from a URL / data URL (sRGB, mild anisotropy for angled banners). */
export function textureFromUrl(url: string): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Texture from an already-decoded image or canvas. */
export function textureFromImage(img: HTMLImageElement | HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** A simple two-colour striped banner texture (fallback when no image is set). */
export function stripeTexture(c1: string, c2: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = c1;
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = c2;
  g.fillRect(0, 13, 128, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A text banner texture (white text on a coloured field), for auto rail banners. */
export function textTexture(text: string, fg: string, bg: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = fg;
  g.font = 'bold 56px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText((text || '').slice(0, 28).toUpperCase(), 256, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
