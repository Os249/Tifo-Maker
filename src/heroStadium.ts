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
 * The page is for every fan, not one club's: it opens on a different club on
 * each visit. The server picks one per page load (server/src/landingHero.ts)
 * and writes that club into the page: its still picture (public/hero/<club>.webp,
 * and a 640 px copy for smaller screens, rendered from this module by
 * scripts/hero-still.mts), its caption, its chip pressed and its "Make this
 * tifo" link, so it paints with the page. This module starts from whichever
 * club that is. A tap or a click on the picture, or on one of the club chips,
 * starts the live renderer: 165 KB gz of Three.js, the stadium catalogue and a
 * seat map built off the main thread.
 *
 * Desktops used to start the live one by themselves once the browser was idle,
 * which cost them 183 KB gz and about three seconds of blocked main thread
 * before anyone had asked for it; phones never did. Now neither does
 * (performance plan P1.14), and WebGL is not even probed until the tap.
 * ?hero3d still starts it at once, for the still-picture script and the tests,
 * and ?hero=<club> opens on that club.
 */
import HERO_TIFOS from './data/heroTifos.json';
import { localPath, t } from './ui/i18n';
import { HERO_GROUND_KEYS } from './heroGrounds';

const HOST_ID = 'hero-3d';
const PHONE_QUERY = '(max-width: 860px)';
/** A hero club's still picture, at 960 px or (small) 640 px wide. */
export const heroStill = (club: string, small = false): string => `/hero/${club}${small ? '-640' : ''}.webp`;

interface HeroTifo {
  club: string;
  templateId: string;
  count: number;
  palette: string[];
  cellsGzB64: string;
  title: string;
  /** See Preview3DOptions.heroScale: further back for a building bigger than its bowl. */
  heroScale?: number;
}
const TIFOS = HERO_TIFOS as HeroTifo[];

/**
 * Can this browser draw WebGL? Asked on the first tap, not at load, and only
 * once: every probe makes a throwaway context, which a phone's GPU driver pays
 * for and which counts against the browser's limit of live contexts.
 */
let webgl: boolean | null = null;
function webglAvailable(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    webgl = !!(window.WebGLRenderingContext && gl);
    // Give the probe's context back now rather than whenever it is collected.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
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
  const [{ clubById, clubColours }, { getLang, t, tv }] = await Promise.all([import('./core/clubGrounds'), import('./ui/i18n')]);
  const club = clubById(tifo.club);
  if (!club) return;
  const name = getLang() === 'ar' ? club.ar : club.en;
  // The ground's own key rather than tl(): see heroGrounds.ts.
  const groundKey = HERO_GROUND_KEYS[tifo.templateId];
  const ground = (groundKey ? t(groundKey) : tifo.templateId).replace(/\s*[(（][^)）]*[)）]\s*$/, '');
  const text = document.getElementById('hero-cap-text');
  if (text) text.textContent = tv('st.nameAt', { club: name, ground });
  const scarf = document.getElementById('hero-cap-scarf');
  const colours = clubColours(club);
  if (scarf && colours) {
    scarf.style.setProperty('--c1', colours[0]);
    scarf.style.setProperty('--c2', colours[1]);
  }
  const make = document.getElementById('hero-make') as HTMLAnchorElement | null;
  if (make) make.href = localPath(`/projects?new=1&club=${encodeURIComponent(club.id)}`);
  document.querySelectorAll<HTMLElement>('.hero-club').forEach((b) => {
    const on = b.dataset.club === tifo.club;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  revealChip();
}

/**
 * On a phone the club chips are one strip that scrolls sideways, and the club
 * the page opened on can be at its far end, out of sight: bring the pressed
 * chip into the strip (the strip only, never the page).
 */
function revealChip(): void {
  const strip = document.querySelector<HTMLElement>('.hero-clubs');
  const on = strip?.querySelector<HTMLElement>('.hero-club.on');
  if (!strip || !on || strip.scrollWidth <= strip.clientWidth + 1) return;
  const s = strip.getBoundingClientRect();
  const c = on.getBoundingClientRect();
  const pad = 18;
  if (c.left < s.left + pad) strip.scrollBy({ left: c.left - s.left - pad });
  else if (c.right > s.right - pad) strip.scrollBy({ left: c.right - s.right + pad });
}

/**
 * The pre-rendered stadium; a tap on it asks for the live one.
 *
 * The picture normally arrives in the page (landing.html); one is made here
 * only if it is missing. It goes away when the live stadium is in (see show),
 * and stays if that cannot happen, rather than leaving an empty frame.
 */
function mountStill(host: HTMLElement, club: string, live: () => Promise<boolean>): void {
  host.classList.add('still');
  let img = host.querySelector<HTMLImageElement>('img.hero-still');
  if (!img) {
    img = new Image();
    img.className = 'hero-still';
    img.alt = '';
    img.width = 960;
    img.height = 600;
    host.appendChild(img);
  }
  // The page normally arrives with this club's picture already in it; only
  // a page that names another (a ?hero= link, or `vite dev`, where no server
  // picks) is put right here.
  if (!img.getAttribute('src')?.endsWith(heroStill(club))) {
    img.srcset = `${heroStill(club, true)} 640w, ${heroStill(club)} 960w`;
    img.src = heroStill(club);
  }
  const still = img;
  const play = document.getElementById('hero-play') as HTMLButtonElement | null;
  // No picture (offline, blocked): the frame's own night ground stays. It may
  // have failed before this script ran, so look as well as listen.
  if (still.complete && still.naturalWidth === 0 && still.currentSrc) still.remove();
  still.addEventListener('error', () => still.remove());
  const tap = (): void => {
    if (play?.disabled) return;
    still.style.cursor = 'progress';
    if (play) {
      play.disabled = true;
      play.setAttribute('aria-busy', 'true');
      const label = play.querySelector<HTMLElement>('[data-i18n]');
      if (label) { label.dataset.i18n = 'hero.previewLoading'; label.textContent = t('hero.previewLoading'); }
    }
    void live().then((ok) => {
      if (play) { play.disabled = false; play.removeAttribute('aria-busy'); }
      if (ok) return;
      // No WebGL, or the stadium would not build: keep the picture, and let a
      // later tap try again.
      still.style.cursor = '';
      still.addEventListener('click', tap, { once: true });
      const label = play?.querySelector<HTMLElement>('[data-i18n]');
      if (label) { label.dataset.i18n = 'hero.previewRetry'; label.textContent = t('hero.previewRetry'); }
    });
  };
  still.addEventListener('click', tap, { once: true });
  play?.addEventListener('click', tap);
}

/**
 * Which hero tifo the page opened on: ?hero=<club>, else the club the server
 * wrote into the page (data-club on the frame, and its chip pressed), else the
 * first.
 */
function startIndex(host: HTMLElement): number {
  const want =
    new URLSearchParams(location.search).get('hero') ??
    host.dataset.club ??
    document.querySelector<HTMLElement>('.hero-club.on')?.dataset.club;
  const i = TIFOS.findIndex((x) => x.club === want);
  return i >= 0 ? i : 0;
}

export async function mountHeroStadium(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host || !TIFOS.length) return;
  const first = startIndex(host);
  revealChip();
  void caption(TIFOS[first]!);

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const phone = window.matchMedia?.(PHONE_QUERY).matches ?? false;
  const forced = new URLSearchParams(location.search).has('hero3d');

  type Preview = import('./render/preview3d').Preview3D;
  let preview: Preview | null = null;
  let showing = -1;
  let loading = 0;
  let io: IntersectionObserver | null = null;

  /** Build the stadium for tifo `i` and swap it in. True once it is showing. */
  const show = async (i: number): Promise<boolean> => {
    const tifo = TIFOS[i];
    if (!tifo) return false;
    if (i === showing) return true;
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
      if (!template) return false;
      const [map, cells] = await Promise.all([generateSeatMapAsync(template.id), gunzip(tifo.cellsGzB64)]);
      if (token !== loading) return false; // a newer pick won
      const store = new DesignStore(map, tifo.palette.slice());
      // The export was made on this same seat map; a ground that changed since
      // still opens, with whatever lines up.
      store.loadCells(cells.subarray(0, map.count));
      preview?.stop();
      preview?.dispose();
      host.querySelector('canvas')?.remove();
      preview = new Preview3D(host, map, store, { autoRotate: !reduceMotion, hero: true, heroScale: tifo.heroScale, transparent: true, template });
      showing = i;
      // The live one is in: the picture that stood in for it goes.
      host.querySelector('img.hero-still')?.remove();
      document.getElementById('hero-play')?.remove();
      host.classList.remove('still');
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
      return true;
    } catch {
      // Any failure leaves the frame as it was. Never break the page.
      return false;
    } finally {
      if (token === loading) host.classList.remove('switching');
    }
  };
  /** The live stadium, where this browser can draw one. */
  const goLive = async (i: number): Promise<boolean> => (webglAvailable() ? show(i) : false);

  // The club chips: on a desktop, or once the live stadium is up, each one
  // shows that club's tifo in 3D (the first press is the tap that starts it).
  // On a phone with only the picture, each one starts that club's tifo in the
  // editor instead.
  document.querySelectorAll<HTMLButtonElement>('.hero-club').forEach((b) => {
    b.addEventListener('click', () => {
      const i = TIFOS.findIndex((x) => x.club === b.dataset.club);
      if (i < 0) return;
      if ((preview || !phone || forced) && webglAvailable()) {
        delete host.dataset.stadium;
        void show(i);
        return;
      }
      location.assign(localPath(`/projects?new=1&club=${encodeURIComponent(TIFOS[i]!.club)}`));
    });
  });

  mountStill(host, TIFOS[first]!.club, () => goLive(first));
  if (forced) void goLive(first);
}

/** Re-say the caption in the page's language (the landing's language toggle). */
export function localizeHero(): void {
  const on = document.querySelector<HTMLElement>('.hero-club.on')?.dataset.club;
  const tifo = TIFOS.find((x) => x.club === on) ?? TIFOS[0];
  if (tifo) void caption(tifo);
}
