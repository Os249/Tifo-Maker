/**
 * Everything /community needs to open a card in 3D, behind one dynamic import
 * (performance plan P1.10): three.js and the preview, the stadium catalogue,
 * the seat-map worker client and the design store.
 *
 * One module rather than five import() calls so the build treats them as one
 * lazy group. Imported separately, the small ones (core/template) became
 * chunks of their own, and every other page that uses them paid an extra
 * request for the split.
 */
export { generateSeatMapAsync } from './workers/client';
export { TEMPLATES } from './core/template';
export { templateById } from './core/stadiumCatalog';
export { DesignStore } from './core/design';
export { Preview3D, CAMERA_PRESETS } from './render/preview3d';
