/**
 * Hero stadium — the real WebGL renderer, auto-rotating, in the landing hero.
 *
 * Loads lazily AFTER first paint so the homepage stays fast: the heavy Three.js
 * renderer and seat-map generator are dynamic-imported, and we only spin it up
 * once the hero is on screen. Falls back silently to the existing CSS mock if
 * WebGL is unavailable or the user prefers reduced motion.
 *
 * It paints a striking showpiece design (a vibrant multi-band tifo) so a cold
 * visitor immediately sees what the product makes — a stadium lit up in 3D.
 */

const HOST_ID = 'hero-3d';
const MOCK_SELECTOR = '.stadium-mock';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

/** Build a bold showpiece design on the given seat map (no network needed). */
async function paintShowpiece(map: import('./core/types').SeatMap): Promise<import('./core/design').DesignStore> {
  const { DesignStore } = await import('./core/design');
  const { PATTERN_PRESETS } = await import('./core/patterns');
  // Vibrant brand-leaning palette: index 0 is "empty", then the card colors.
  const palette = ['#0B1120', '#1C6FE0', '#F2F1EC', '#D9F000', '#5B2A86'];
  const store = new DesignStore(map, palette);
  // A diagonal sash over a split base reads dramatically as the bowl rotates.
  const split = PATTERN_PRESETS.find((p) => p.id === 'split');
  const sash = PATTERN_PRESETS.find((p) => p.id === 'sash');
  if (split) store.transform(split.cellAt(map));
  if (sash) {
    // Overlay the sash in the neon accent for contrast.
    const sashAt = sash.cellAt(map);
    const cells = store.cells;
    for (let i = 0; i < map.count; i++) {
      const v = sashAt(i);
      if (v > 0) cells[i] = 3; // neon
    }
  }
  return store;
}

export async function mountHeroStadium(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!webglAvailable()) return; // keep the CSS mock fallback

  // Defer the heavy work until the browser is idle / hero is visible.
  const start = async (): Promise<void> => {
    try {
      const [{ Preview3D }, { generateSeatMap }, { DEFAULT_TEMPLATE }] = await Promise.all([
        import('./render/preview3d'),
        import('./core/seatmap'),
        import('./core/template'),
      ]);
      const map = generateSeatMap(DEFAULT_TEMPLATE);
      const store = await paintShowpiece(map);
      const preview = new Preview3D(host, map, store, { autoRotate: !reduceMotion, transparent: true });
      // Hide the CSS mock now that the real thing is up.
      const mock = document.querySelector(MOCK_SELECTOR);
      if (mock) (mock as HTMLElement).style.display = 'none';
      host.classList.add('ready');
      document.getElementById('hero-3d-wrap')?.classList.add('ready');
      preview.start();
      // Pause the spin when the hero scrolls out of view (saves battery/GPU).
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) preview.start();
            else preview.stop();
          }
        },
        { threshold: 0.05 },
      );
      io.observe(host);
    } catch {
      // Any failure → leave the CSS mock in place. Never break the page.
    }
  };

  const idle = (cb: () => void): void => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (ric) ric(cb);
    else setTimeout(cb, 200);
  };
  idle(() => void start());
}
