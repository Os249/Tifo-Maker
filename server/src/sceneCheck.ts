import { gunzipSync, gzipSync } from 'node:zlib';
import { MAX_SCENE_GUNZIP_BYTES } from './codec';

/**
 * The CPU-heavy work on a design's scene: checking one that is being saved,
 * and taking the owner's layers out of one that someone else is viewing.
 *
 * Pure and synchronous, and run only inside the scene worker
 * (sceneWorker.ts, performance plan P2.14), never on the server's event loop:
 * a crafted save is decompressed to 16 MB and parsed here, and a big
 * published scene is parsed, stripped and recompressed here.
 */

/**
 * How much structure a saved scene may have before it is parsed.
 *
 * A scene may inflate to 16 MB, and what it costs to parse depends on what is
 * in it: 16 MB of `{},` took 3.4 s on the one event loop, 16 MB of `0,` 0.4 s,
 * while a real scene (banners with pictures, layer grids) is a few long base64
 * strings and a few thousand objects and parses in about 10 ms (audit round
 * six). A cap on the inflate ratio would refuse real saves (a solid layer
 * compresses hundreds to one); a cap on the structure does not. Counted on the
 * bytes before parsing, stopping as soon as a cap is passed. Characters inside
 * strings are counted too, which only ever overcounts.
 */
// Real scenes stay far below these: their bulk is base64 strings, and the one
// big source of commas, stroke points at full precision, fits about 100,000
// numbers in the largest body the server takes. Under the caps the slowest
// shapes found (duplicate keys, short floats) parse in about 100 ms.
export const SCENE_MAX_CONTAINERS = 100_000; // '{' and '['
export const SCENE_MAX_COMMAS = 400_000;
export const SCENE_MAX_COLONS = 200_000; // object keys

/** How many times `byte` occurs, counting no further than just past `cap`. */
function countUpTo(buf: Buffer, byte: number, cap: number): number {
  let n = 0;
  // indexOf is native: a long base64 string is skipped in a few milliseconds,
  // where a JavaScript loop over 16 MB took about 65.
  for (let i = buf.indexOf(byte); i !== -1 && n <= cap; i = buf.indexOf(byte, i + 1)) n++;
  return n;
}

export function sceneTooComplex(json: Buffer): boolean {
  const objects = countUpTo(json, 0x7b, SCENE_MAX_CONTAINERS); // {
  if (objects > SCENE_MAX_CONTAINERS) return true;
  if (objects + countUpTo(json, 0x5b, SCENE_MAX_CONTAINERS - objects) > SCENE_MAX_CONTAINERS) return true; // [
  if (countUpTo(json, 0x3a, SCENE_MAX_COLONS) > SCENE_MAX_COLONS) return true; // :
  return countUpTo(json, 0x2c, SCENE_MAX_COMMAS) > SCENE_MAX_COMMAS; // ,
}

/** What a scene being saved is: fit to store, or why not. */
export type SceneVerdict = 'ok' | 'gzip' | 'complex' | 'json';

/**
 * Inflated (at most 16 MB), bounded before it is parsed (sceneTooComplex),
 * and parsed: a scene that cannot be read back is worse than no scene,
 * because it fails on LOAD, in front of whoever opened the share link, rather
 * than at the save, in front of the person who can fix it.
 */
export function checkScene(gz: Uint8Array): SceneVerdict {
  let inflated: Buffer;
  try {
    inflated = gunzipSync(gz, { maxOutputLength: MAX_SCENE_GUNZIP_BYTES });
  } catch {
    return 'gzip';
  }
  if (sceneTooComplex(inflated)) return 'complex';
  try {
    const parsed = JSON.parse(inflated.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return 'json';
  } catch {
    return 'json';
  }
  return 'ok';
}

/**
 * A scene without its layer stack (for anyone but the design's owner), or
 * null when it cannot be read.
 *
 * It used to hand back the stored bytes untouched whenever they failed to
 * decompress or parse: the one case where it could not check for the owner's
 * layers was the case where it sent them, to everyone, and cached that
 * (audit round six). A save cannot store such a scene today, because PUT
 * parses it first, but a strip that is only safe while every writer behaves
 * is not a strip. It fails closed: no scene rather than the owner's.
 */
export function stripLayers(gz: Uint8Array): Uint8Array | null {
  try {
    const scene = JSON.parse(gunzipSync(gz, { maxOutputLength: MAX_SCENE_GUNZIP_BYTES }).toString('utf8')) as unknown;
    if (!scene || typeof scene !== 'object') return null;
    if (Array.isArray(scene) || !('layers' in scene)) return gz; // nothing of the owner's in it
    delete (scene as Record<string, unknown>).layers;
    return gzipSync(Buffer.from(JSON.stringify(scene), 'utf8'));
  } catch {
    return null;
  }
}
