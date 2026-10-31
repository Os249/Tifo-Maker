import * as THREE from 'three';
import { loadTifoFonts } from '../../core/tifoFonts';

/**
 * Match Day Simulator — pitch-side realism (Phase 3).
 *
 * Mown pitch stripes, an LED advertising ring just outside the touchlines,
 * dugouts at the halfway line, and a players' tunnel mouth. Pitch is the standard
 * 105 x 68 m, so positions are fixed regardless of the bowl. All meshes are cheap
 * boxes/planes; the LED boards use an emissive material so they read at dusk.
 *
 * The boards can carry a fan's own words (Pro, Match Day): up to three
 * messages, drawn once into one small canvas strip that all four boards tile.
 * With no messages there is nothing extra in the scene at all, so the plain
 * ring looks exactly as it always did.
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

/** Right to left when the first strong letter is (what dir="auto" does). */
function rtlFirst(s: string): boolean {
  for (const ch of s) {
    if (/[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(ch)) return true;
    if (/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(ch)) return false;
  }
  return false;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/**
 * Anton and Noto Kufi Arabic (the "Condensed" voice): narrow, heavy, and
 * made for both scripts, which is what a perimeter board is. Canvas shapes
 * the Arabic; the fallbacks cover a moment before the faces have loaded.
 */
const BOARD_FONT = '"TifoCondensed", "Noto Kufi Arabic", Impact, "Arial Black", sans-serif';
/** The strip's height in pixels: one board face, top to bottom. */
const STRIP_H = 128;
/** Widest strip uploaded (every WebGL device takes 4096). */
const STRIP_MAX_W = 4096;

/**
 * The messages side by side, each on its own panel of the board colour with
 * a seam between, as wide as its words need. The four boards tile this one
 * strip, so the whole ring costs one texture of at most 4096 x 128.
 */
function drawStrip(messages: readonly string[], colour: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const px = Math.round(STRIP_H * 0.6);
  const font = `${px}px ${BOARD_FONT}`;
  const pad = STRIP_H * 0.9;
  const minW = STRIP_H * 4;
  let widths: number[] = [];
  if (g) {
    g.font = font;
    widths = messages.map((m) => Math.max(minW, Math.ceil(g.measureText(m).width + pad * 2)));
  } else {
    widths = messages.map(() => minW);
  }
  const total = widths.reduce((a, b) => a + b, 0);
  // Long messages are drawn a little smaller rather than cut.
  const k = Math.min(1, STRIP_MAX_W / total);
  c.width = Math.max(1, Math.round(total * k));
  c.height = Math.max(1, Math.round(STRIP_H * k));
  if (!g) return c;
  g.scale(k, k);
  const ink = luminance(colour) > 0.4 ? '#0b0f18' : '#ffffff';
  let x = 0;
  messages.forEach((m, i) => {
    const w = widths[i];
    g.fillStyle = colour;
    g.fillRect(x, 0, w, STRIP_H);
    // A soft top-to-bottom shade, the way a panel catches the floodlights.
    const shade = g.createLinearGradient(0, 0, 0, STRIP_H);
    shade.addColorStop(0, 'rgba(255,255,255,0.10)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.16)');
    g.fillStyle = shade;
    g.fillRect(x, 0, w, STRIP_H);
    g.font = font;
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = rtlFirst(m) ? 'rtl' : 'ltr';
    g.fillText(m, x + w / 2, STRIP_H * 0.54, w - pad);
    // The seam between two panels.
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x + w - 3, 0, 3, STRIP_H);
    x += w;
  });
  return c;
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
 * front of the main stand, on the other touchline). `redraw` is asked for a
 * frame when the boards change on their own (their font arriving).
 */
export function buildPitchside(shadows: boolean, opts: { benches?: boolean; redraw?: () => void } = {}): PitchsideController {
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
  let ledTex: THREE.CanvasTexture | null = null;
  let ledMat: THREE.MeshBasicMaterial | null = null;
  const ledGeos: THREE.BufferGeometry[] = [];
  const clearLed = (): void => {
    for (const child of [...led.children]) led.remove(child);
    for (const geo of ledGeos.splice(0)) geo.dispose();
    ledMat?.dispose();
    ledMat = null;
    ledTex?.dispose();
    ledTex = null;
  };
  const buildLed = (): void => {
    clearLed();
    if (!ledText) return;
    const strip = drawStrip(ledText.messages, ledText.colour);
    const tex = new THREE.CanvasTexture(strip);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    // The boards are seen nearly edge-on from most seats.
    tex.anisotropy = 8;
    ledTex = tex;
    // Unlit and not tone-mapped: an LED panel is its own light, the same
    // colour at noon and at night.
    ledMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const faceH = boardH * 0.86;
    // One strip in metres, at the face's height.
    const stripLen = (strip.width / strip.height) * faceH;
    const face = (len: number, x: number, z: number, ry: number): void => {
      const w = len - 0.3;
      // Whole strips only, so no message is cut at a corner flag: the count
      // that stretches or squeezes the letters least.
      const r = w / stripLen;
      const lo = Math.max(1, Math.floor(r));
      const hi = Math.max(1, Math.ceil(r));
      const reps = Math.abs(Math.log(r / lo)) <= Math.abs(Math.log(r / hi)) ? lo : hi;
      const geo = new THREE.PlaneGeometry(w, faceH);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * reps);
      uv.needsUpdate = true;
      ledGeos.push(geo);
      const mesh = new THREE.Mesh(geo, ledMat!);
      mesh.position.set(x, boardH / 2, z);
      mesh.rotation.y = ry;
      mesh.userData.keep = true;
      led.add(mesh);
    };
    // Each face looks at the pitch: its words read left to right from there.
    const front = 0.1 + 0.012;
    face(2 * HALF_X + 6, 0, HALF_Z + m - front, Math.PI);
    face(2 * HALF_X + 6, 0, -(HALF_Z + m - front), 0);
    face(2 * HALF_Z + 6, HALF_X + m - front, 0, -Math.PI / 2);
    face(2 * HALF_Z + 6, -(HALF_X + m - front), 0, Math.PI / 2);
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

  // Dugouts near halfway (+z touchline).
  const dugMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.85 });
  const dugout = (x: number): void => {
    const g = new THREE.BoxGeometry(7, 1.6, 2);
    const d = new THREE.Mesh(g, dugMat);
    d.position.set(x, 0.8, HALF_Z + m + 2.4);
    d.castShadow = shadows;
    group.add(d);
    trash.push(g);
  };
  trash.push(dugMat);
  if (opts.benches !== false) {
    dugout(-9);
    dugout(9);

    // Players' tunnel mouth behind the dugouts.
    const tunMat = new THREE.MeshStandardMaterial({ color: 0x0a0d14, emissive: 0x1a1408, emissiveIntensity: 0.5, roughness: 1 });
    const tunGeo = new THREE.BoxGeometry(4, 3, 3);
    const tunnel = new THREE.Mesh(tunGeo, tunMat);
    tunnel.position.set(0, 1.5, HALF_Z + m + 5.5);
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
    dispose() {
      disposed = true;
      ledText = null;
      clearLed();
      for (const d of trash) d.dispose();
    },
  };
}
