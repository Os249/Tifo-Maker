import * as THREE from 'three';
import { loadTifoFonts } from '../../core/tifoFonts';
import { DEFAULT_STYLE, LedShow, PAGE_H, PAGE_W, drawAtlas, pageUv, pagesFor, type LedPage, type LedPicture, type LedStyle } from './ledBoards';

/**
 * Match Day Simulator — pitch-side realism (Phase 3).
 *
 * Mown pitch stripes, an LED advertising ring just outside the touchlines,
 * dugouts at the halfway line, and a players' tunnel mouth. Pitch is the standard
 * 105 x 68 m, so positions are fixed regardless of the bowl. All meshes are cheap
 * boxes/planes; the LED boards use an emissive material so they read at dusk.
 *
 * The boards can carry a fan's own words (Pro, Match Day): up to three
 * messages, in a style (render/simulator/ledBoards.ts), drawn once into one
 * atlas that the four boards show through textures of their own, so that
 * scrolling, sequencing and flashing them costs uniforms, not redraws. With
 * no messages there is nothing extra in the scene at all, so the plain ring
 * looks exactly as it always did.
 */

export interface PitchsideController {
  readonly object: THREE.Object3D;
  /** `gloss` is the wet roughness; lower is more mirror-like. Default 0.12. */
  setWet(on: boolean, gloss?: number): void;
  /**
   * Put messages on the touchline LED ring, in one board colour. No messages
   * (or only empty ones): the plain boards, with every texture freed. True
   * when the boards changed.
   */
  setBoardText(messages: readonly string[], colour: string): boolean;
  /** Show or hide the messages without dropping them (a free export, say). True when that changed. */
  setBoardTextShown(on: boolean): boolean;
  /** What the boards carry, or null for the plain ring. Read-only. */
  boardText(): { messages: string[]; colour: string; shown: boolean } | null;
  /** The boards' style (template, crest, score). True when the boards changed. */
  setBoardStyle(style: LedStyle): boolean;
  /**
   * Move the boards on by `dt` seconds, on a frame Match Day draws anyway:
   * `moving` (something else moves), `revealing` (a reveal plays). True only
   * while a change the boards started is under way and needs its next frame.
   */
  animate(dt: number, moving: boolean, revealing: boolean): boolean;
  /** What each face shows now (pages, scroll, brightness) and how many pages there are; null with no words. Read-only. */
  boardFrame(): { pages: number[]; scroll: number; glow: number; count: number; kinds: string[] } | null;
  /** The page on show, for the big screens (null: no words, or hidden); `seq` changes when it does. */
  boardPicture(): { page: LedPage; colour: string; crest: LedPicture | null; seq: number } | null;
  dispose(): void;
}

const HALF_X = 52.5;
const HALF_Z = 34;

/** The longest message a board takes, in characters. */
export const BOARD_TEXT_MAX = 40;
/** How many messages the ring runs. */
export const BOARD_MESSAGES = 3;

/**
 * A message as a board shows it: one line, no control or direction-override
 * characters, at most BOARD_TEXT_MAX characters. User input, so it is only
 * ever drawn with canvas fillText; nothing here goes near the DOM.
 */
export function cleanBoardText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    // Controls (newlines, tabs) and the explicit bidi embeddings, overrides
    // and isolates: the canvas works the direction out from the letters.
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, BOARD_TEXT_MAX).join('').trim();
}

/** A colour a board can be: #rrggbb, or null. */
export function boardColour(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  return null;
}

/** The fonts are in once; until then a strip is drawn again when they arrive. */
let boardFontsIn = false;

function stripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#1d7437' : '#236f3a';
    g.fillRect(0, i * 32, 16, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * `benches: false` leaves out the generic dugouts and tunnel, for a ground
 * whose own builder puts its real ones where they are (Kingdom Arena's are in
 * front of the main stand, on the other touchline); `dugouts: 'south'` puts
 * them on the -z touchline and `tunnel: false` leaves out only the tunnel
 * mouth (a template's `pitchside`). `redraw` is asked for a
 * frame when the boards change on their own (their font arriving).
 */
export function buildPitchside(shadows: boolean, opts: { benches?: boolean; dugouts?: 'north' | 'south'; tunnel?: boolean; shelters?: { color?: number; offset?: number }; redraw?: () => void } = {}): PitchsideController {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];

  // Mown stripes overlaid on the base pitch.
  const stex = stripeTexture();
  const stripeGeo = new THREE.PlaneGeometry(105, 68);
  const stripeMat = new THREE.MeshStandardMaterial({ map: stex, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.55 });
  const stripes = new THREE.Mesh(stripeGeo, stripeMat);
  stripes.rotation.x = -Math.PI / 2;
  stripes.position.y = 0.02;
  stripes.receiveShadow = shadows;
  group.add(stripes);
  trash.push(stripeGeo, stripeMat, stex);

  // LED advertising ring just outside the touchlines.
  const adMat = new THREE.MeshStandardMaterial({ color: 0x0e1118, emissive: 0x2b3a63, emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.1 });
  const boardH = 0.9;
  const m = 2.4;
  const board = (w: number, x: number, z: number, ry: number): void => {
    const g = new THREE.BoxGeometry(w, boardH, 0.2);
    const mesh = new THREE.Mesh(g, adMat);
    mesh.position.set(x, boardH / 2, z);
    mesh.rotation.y = ry;
    group.add(mesh);
    trash.push(g);
  };
  board(2 * HALF_X + 6, 0, HALF_Z + m, 0);
  board(2 * HALF_X + 6, 0, -(HALF_Z + m), 0);
  board(2 * HALF_Z + 6, HALF_X + m, 0, Math.PI / 2);
  board(2 * HALF_Z + 6, -(HALF_X + m), 0, Math.PI / 2);
  trash.push(adMat);

  // The fan's messages, on a face just in front of each board's pitch side
  // (where a real board shows its picture, for the cameras). Built only when
  // there are messages, after the static merge, and never merged itself.
  const led = new THREE.Group();
  led.name = 'led-boards';
  group.add(led);
  let ledText: { messages: string[]; colour: string } | null = null;
  let style: LedStyle = DEFAULT_STYLE;
  let pages: LedPage[] = [];
  let atlas: HTMLCanvasElement | null = null;
  const show = new LedShow();
  /** One texture (sharing the atlas) and one material a face, so each face shows its own page. */
  const faces: { tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial; page: number }[] = [];
  const ledGeos: THREE.BufferGeometry[] = [];
  let lastScroll = 0;
  let lastGlow = 1;
  const clearLed = (): void => {
    for (const child of [...led.children]) led.remove(child);
    for (const geo of ledGeos.splice(0)) geo.dispose();
    for (const f of faces.splice(0)) {
      f.mat.dispose();
      f.tex.dispose();
    }
    atlas = null;
  };
  /** Show page `p` on face `f` (a uniform: the texture's offset). */
  const showPage = (f: (typeof faces)[number], p: number): void => {
    if (f.page === p) return;
    f.page = p;
    const uv = pageUv(p, pages.length);
    f.tex.repeat.y = uv.repeat;
    f.tex.offset.y = uv.offset;
  };
  const buildLed = (): void => {
    clearLed();
    if (!ledText) return;
    pages = pagesFor(ledText.messages, style);
    if (!pages.length) return;
    show.setPages(pages);
    atlas = drawAtlas(pages, ledText.colour, style.crest);
    const faceH = boardH * 0.86;
    // One page in metres, at the face's height.
    const pageLen = (PAGE_W / PAGE_H) * faceH;
    const still = show.step(0, false, false);
    const face = (len: number, x: number, z: number, ry: number, k: number): void => {
      const w = len - 0.3;
      // Whole pages only, so no message is cut at a corner flag: the count
      // that stretches or squeezes the letters least.
      const r = w / pageLen;
      const lo = Math.max(1, Math.floor(r));
      const hi = Math.max(1, Math.ceil(r));
      const reps = Math.abs(Math.log(r / lo)) <= Math.abs(Math.log(r / hi)) ? lo : hi;
      const geo = new THREE.PlaneGeometry(w, faceH);
      ledGeos.push(geo);
      const tex = new THREE.CanvasTexture(atlas!);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = reps;
      // The boards are seen nearly edge-on from most seats.
      tex.anisotropy = 8;
      // Unlit and not tone-mapped: an LED panel is its own light, the same
      // colour at noon and at night.
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const f = { tex, mat, page: -1 };
      faces.push(f);
      showPage(f, still.pages[k]);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, boardH / 2, z);
      mesh.rotation.y = ry;
      mesh.userData.keep = true;
      led.add(mesh);
    };
    // Each face looks at the pitch: its words read left to right from there.
    const front = 0.1 + 0.012;
    face(2 * HALF_X + 6, 0, HALF_Z + m - front, Math.PI, 0);
    face(2 * HALF_X + 6, 0, -(HALF_Z + m - front), 0, 1);
    face(2 * HALF_Z + 6, HALF_X + m - front, 0, -Math.PI / 2, 2);
    face(2 * HALF_Z + 6, -(HALF_X + m - front), 0, Math.PI / 2, 3);
    lastScroll = 0;
    lastGlow = 1;
    if (!boardFontsIn) {
      const drawn = ledText;
      void loadTifoFonts().then(() => {
        boardFontsIn = true;
        // Drawn with a fallback face; again, now that the real one is here.
        if (!disposed && ledText === drawn) {
          buildLed();
          opts.redraw?.();
        }
      });
    }
  };
  let disposed = false;

  // Dugouts near halfway (+z touchline, or -z for a template that says so).
  const dz = opts.dugouts === 'south' ? -1 : 1;
  const dugMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.85 });
  const dugout = (x: number): void => {
    const g = new THREE.BoxGeometry(7, 1.6, 2);
    const d = new THREE.Mesh(g, dugMat);
    d.position.set(x, 0.8, dz * (HALF_Z + m + 2.4));
    d.castShadow = shadows;
    group.add(d);
    trash.push(g);
  };
  trash.push(dugMat);
  // Barrel-vault shelters instead (pitchside.shelters): a quarter-and-a-bit of
  // a cylinder lying along the touchline, its back to the stand, open to the pitch.
  const shelter = (x: number, len: number, mat: THREE.Material, rib: THREE.Material): void => {
    const r = 1.5;
    const zc = dz * (HALF_Z + m + (opts.shelters?.offset ?? 2.4));
    const N = 14;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.68; // from the ground behind, over the top
      const y = Math.sin(a) * r * 1.25;
      const z = zc + dz * Math.cos(a) * r;
      pos.push(x - len / 2, y, z, x + len / 2, y, z);
      if (i > 0) {
        const k = (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const s = new THREE.Mesh(g, mat);
    s.castShadow = shadows;
    group.add(s);
    trash.push(g);
    // The frame: a hoop at each end and every few metres between.
    const hoops = Math.max(2, Math.round(len / 2.5) + 1);
    for (let h = 0; h < hoops; h++) {
      const hx = x - len / 2 + (len * h) / (hoops - 1);
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 0.68;
        const a1 = ((i + 1) / N) * Math.PI * 0.68;
        const p0 = new THREE.Vector3(hx, Math.sin(a0) * r * 1.25, zc + dz * Math.cos(a0) * r);
        const p1 = new THREE.Vector3(hx, Math.sin(a1) * r * 1.25, zc + dz * Math.cos(a1) * r);
        const bg = new THREE.BoxGeometry(0.08, 0.08, p0.distanceTo(p1));
        const b = new THREE.Mesh(bg, rib);
        b.position.copy(p0).add(p1).multiplyScalar(0.5);
        b.lookAt(p1);
        group.add(b);
        trash.push(bg);
      }
    }
  };
  if (opts.benches !== false && opts.shelters) {
    const skin = new THREE.MeshStandardMaterial({ color: opts.shelters.color ?? 0x2a53b8, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.86, side: THREE.DoubleSide });
    const rib = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.5, metalness: 0.4 });
    trash.push(skin, rib);
    shelter(-15, 11, skin, rib);
    shelter(15, 11, skin, rib);
    shelter(0, 4.5, skin, rib);
  } else if (opts.benches !== false) {
    dugout(-9);
    dugout(9);
  }
  // Players' tunnel mouth behind the dugouts (`tunnel: false` for a ground
  // whose real tunnel is modelled where it is).
  if (opts.benches !== false && opts.tunnel !== false) {
    const tunMat = new THREE.MeshStandardMaterial({ color: 0x0a0d14, emissive: 0x1a1408, emissiveIntensity: 0.5, roughness: 1 });
    const tunGeo = new THREE.BoxGeometry(4, 3, 3);
    const tunnel = new THREE.Mesh(tunGeo, tunMat);
    tunnel.position.set(0, 1.5, dz * (HALF_Z + m + 5.5));
    group.add(tunnel);
    trash.push(tunGeo, tunMat);
  }

  return {
    object: group,
    setWet(on, gloss = 0.12) {
      // The visible turf surface is these stripes, so the wet sheen must live here.
      stripeMat.roughness = on ? gloss : 0.95;
      stripeMat.metalness = on ? 0.5 : 0;
      stripeMat.opacity = on ? 0.72 : 0.55;
      stripeMat.needsUpdate = true;
    },
    setBoardText(messages, colour) {
      const list = messages.map(cleanBoardText).filter(Boolean).slice(0, BOARD_MESSAGES);
      const col = boardColour(colour) ?? '#0b1d4d';
      const next = list.length ? { messages: list, colour: col } : null;
      const same = (ledText === null && next === null) ||
        (!!ledText && !!next && ledText.colour === next.colour && ledText.messages.join('\n') === next.messages.join('\n'));
      if (same) return false;
      ledText = next;
      buildLed();
      return true;
    },
    setBoardTextShown(on) {
      if (led.visible === on) return false;
      led.visible = on;
      return !!ledText;
    },
    boardText() {
      return ledText ? { messages: [...ledText.messages], colour: ledText.colour, shown: led.visible } : null;
    },
    setBoardStyle(next) {
      const same = next.template === style.template && next.crest === style.crest && next.home === style.home &&
        next.away === style.away && next.homeGoals === style.homeGoals && next.awayGoals === style.awayGoals;
      if (same) return false;
      style = { ...next };
      buildLed();
      return !!ledText;
    },
    animate(dt, moving, revealing) {
      if (!faces.length || !led.visible) return false;
      const fr = show.step(dt, moving, revealing);
      faces.forEach((f, k) => showPage(f, fr.pages[k]));
      if (fr.scroll !== lastScroll) {
        lastScroll = fr.scroll;
        for (const f of faces) f.tex.offset.x = fr.scroll;
      }
      if (fr.glow !== lastGlow) {
        lastGlow = fr.glow;
        for (const f of faces) f.mat.color.setScalar(fr.glow);
      }
      return fr.busy;
    },
    boardFrame() {
      if (!faces.length) return null;
      return { pages: faces.map((f) => f.page), scroll: lastScroll, glow: lastGlow, count: pages.length, kinds: pages.map((p) => p.kind) };
    },
    boardPicture() {
      if (!atlas || !ledText || !led.visible || !pages.length) return null;
      return { page: pages[show.current()] ?? pages[0], colour: ledText.colour, crest: style.crest, seq: show.seq };
    },
    dispose() {
      disposed = true;
      ledText = null;
      clearLed();
      for (const d of trash) d.dispose();
    },
  };
}
