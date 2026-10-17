/**
 * The landing hero: a real club's tifo, in its real ground, in 3D.
 *
 * It used to paint a made-up showpiece (a sash meant to sit over a split,
 * which painted every seat neon and wiped the split out) on a generic bowl,
 * and the bowl was cropped flat on two sides by its frame. Now it shows what
 * the start flow actually makes: the "club tifo" for a club (the free offline
 * designer's design, exported from the editor into data/heroTifos.json) on
 * that club's own ground, framed whole, turning slowly. The chips under it
 * switch club, and "Make this tifo" starts the same thing in the editor.
 *
 * Loads lazily AFTER first paint so the home page stays fast: Three.js and the
 * seat map are dynamic imports, started once the browser is idle.
 *
 * Phones get a picture of the first one instead of the live renderer: the
 * renderer is 154 KB of Three.js plus a seat map built off the main thread,
 * spent before a phone visitor can tap "Start designing", and most visitors
 * are on phones. The still (public/hero-stadium.webp) is rendered from this
 * module by scripts/hero-still.mts, and a tap on it starts the live one.
 */
import HERO_TIFOS from './data/heroTifos.json';

const HOST_ID = 'hero-3d';
const PHONE_QUERY = '(max-width: 860px)';
export const HERO_STILL = '/hero-stadium.webp';

interface HeroTifo {
  club: string;
  templateId: string;
  count: number;
  palette: string[];
  cellsGzB64: string;
  title: string;
}
const TIFOS = HERO_TIFOS as HeroTifo[];

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

async function gunzip(b64: string): Promise<Uint8Array> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The caption and the "Make this tifo" link, for whichever club is showing. */
async function caption(tifo: HeroTifo): Promise<void> {
  const [{ clubById, clubColours }, { getLang, tv, tl }] = await Promise.all([import('./core/clubGrounds'), import('./ui/i18n')]);
  const club = clubById(tifo.club);
  if (!club) return;
  const name = getLang() === 'ar' ? club.ar : club.en;
  const ground = tl(tifo.templateId).replace(/\s*[(（][^)）]*[)）]\s*$/, '');
  const text = document.getElementById('hero-cap-text');
  if (text) text.textContent = tv('st.nameAt', { club: name, ground });
  const scarf = document.getElementById('hero-cap-scarf');
  const colours = clubColours(club);
  if (scarf && colours) {
    scarf.style.setProperty('--c1', colours[0]);
    scarf.style.setProperty('--c2', colours[1]);
  }
  const make = document.getElementById('hero-make') as HTMLAnchorElement | null;
  if (make) make.href = `/projects?new=1&club=${encodeURIComponent(club.id)}`;
  document.querySelectorAll<HTMLElement>('.hero-club').forEach((b) => {
    const on = b.dataset.club === tifo.club;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** Show the pre-rendered stadium; a tap on it swaps in the live one. */
function mountStill(host: HTMLElement, live: () => Promise<void>): void {
  host.classList.add('still');
  const img = new Image();
  img.className = 'hero-still';
  img.alt = '';
  img.decoding = 'async';
  img.width = 960;
  img.height = 600;
  img.addEventListener('load', () => host.classList.add('ready'));
  // No picture (offline, blocked): the frame's own night ground stays.
  img.addEventListener('error', () => img.remove());
  img.addEventListener('click', () => {
    img.style.cursor = 'progress';
    void live().then(() => {
      img.remove();
      host.classList.remove('still');
    });
  }, { once: true });
  img.src = HERO_STILL;
  host.appendChild(img);
}

export async function mountHeroStadium(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host || !TIFOS.length) return;
  void caption(TIFOS[0]!);

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const phone = window.matchMedia?.(PHONE_QUERY).matches ?? false;
  const forced = new URLSearchParams(location.search).has('hero3d');

  type Preview = import('./render/preview3d').Preview3D;
  let preview: Preview | null = null;
  let showing = -1;
  let loading = 0;
  let io: IntersectionObserver | null = null;

  /** Build the stadium for tifo `i` and swap it in. */
  const show = async (i: number): Promise<void> => {
    const tifo = TIFOS[i];
    if (!tifo || i === showing) return;
    const token = ++loading;
    host.classList.add('switching');
    void caption(tifo);
    try {
      const [{ Preview3D }, { generateSeatMapAsync }, { templateById }, { DesignStore }] = await Promise.all([
        import('./render/preview3d'),
        import('./workers/client'),
        import('./core/stadiumCatalog'),
        import('./core/design'),
      ]);
      const template = templateById(tifo.templateId);
      if (!template) return;
      const [map, cells] = await Promise.all([generateSeatMapAsync(template.id), gunzip(tifo.cellsGzB64)]);
      if (token !== loading) return; // a newer pick won
      const store = new DesignStore(map, tifo.palette.slice());
      // The export was made on this same seat map; a ground that changed since
      // still opens, with whatever lines up.
      store.loadCells(cells.subarray(0, map.count));
      preview?.stop();
      preview?.dispose();
      host.querySelector('canvas')?.remove();
      preview = new Preview3D(host, map, store, { autoRotate: !reduceMotion, hero: true, transparent: true, template });
      showing = i;
      host.classList.add('ready');
      preview.start();
      // Said once the building is in: what the still-picture script waits for.
      void preview.ready.then(() => {
        if (token === loading) host.dataset.stadium = 'ready';
      });
      io ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) preview?.start();
            else preview?.stop();
          }
        },
        { threshold: 0.05 },
      );
      io.observe(host);
    } catch {
      // Any failure leaves the frame as it was. Never break the page.
    } finally {
      if (token === loading) host.classList.remove('switching');
    }
  };

  // The club chips: live on a desktop; on a phone, where there is no live
  // stadium to switch, each one starts that club's tifo in the editor.
  document.querySelectorAll<HTMLButtonElement>('.hero-club').forEach((b) => {
    b.addEventListener('click', () => {
      const i = TIFOS.findIndex((x) => x.club === b.dataset.club);
      if (i < 0) return;
      if (preview || (!phone || forced)) {
        if (webglAvailable()) {
          delete host.dataset.stadium;
          void show(i);
          return;
        }
      }
      location.assign(`/projects?new=1&club=${encodeURIComponent(TIFOS[i]!.club)}`);
    });
  });

  if (!webglAvailable()) {
    mountStill(host, async () => {});
    return;
  }
  if (phone && !forced) {
    mountStill(host, () => show(0));
    return;
  }
  const idle = (cb: () => void): void => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (ric) ric(cb);
    else setTimeout(cb, 200);
  };
  idle(() => void show(0));
}

/** Re-say the caption in the page's language (the landing's language toggle). */
export function localizeHero(): void {
  const on = document.querySelector<HTMLElement>('.hero-club.on')?.dataset.club;
  const tifo = TIFOS.find((x) => x.club === on) ?? TIFOS[0];
  if (tifo) void caption(tifo);
}
