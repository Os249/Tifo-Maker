import { Texture } from 'pixi.js';

/**
 * A texture this caller owns OUTRIGHT, safe to destroy with its source.
 *
 * `Texture.from(resource)` is a cache keyed on the resource object's identity —
 * pixi.js/lib/rendering/renderers/shared/texture/utils/textureFrom.js ends with
 * `Cache.set(resource, texture)` — so two callers that hand it the same
 * ImageBitmap are handed back the SAME Texture instance.
 *
 * The image-import flow did exactly that. The ghost that follows the cursor and
 * the object the user drops both wrap one ImageBitmap, so they shared a texture;
 * dropping the object destroys the ghost, and
 * `destroy({ texture: true, textureSource: true })` then tore the GPU source out
 * from under the object that had just been created. The picture vanished the
 * instant it was placed and the renderer threw
 * "Cannot read properties of null (reading 'alphaMode')".
 *
 * Two things made it hard to see. Baking kept working, because bake rasterises
 * the bitmap on a 2D canvas and never touches the texture — so the data was
 * plainly fine and only the preview was blank. And text and shapes were never
 * affected, because `renderObjectCanvas` builds them a FRESH canvas every call,
 * which is a fresh cache key by accident; a bitmap is stable by design, so only
 * photos were hit.
 *
 * `skipCache` is therefore not an optimisation here, it is the correctness
 * condition: every owner gets its own Texture and its own TextureSource, and
 * destroying one cannot reach another's.
 */
export function ownTexture(source: HTMLCanvasElement | ImageBitmap): Texture {
  return Texture.from(source, true);
}
