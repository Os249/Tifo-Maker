import {
  Bounds,
  Buffer,
  BufferImageSource,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  type Renderer,
  type WebGLRenderer,
} from 'pixi.js';
import type { SeatMap } from '../core/types';
import { seatRuns } from './seatUploads';

/**
 * Every seat of the 2D editor in one mesh with a colour table, drawn in one
 * call (performance plan P3.1).
 *
 * The seats used to be 83,040 Pixi particles on the Bernabeu: one JavaScript
 * object per seat, and four vertices of position, texture, rotation and
 * colour each (128 bytes a seat on the GPU, and as much again in memory).
 * Every painted frame walked all of them to rebuild the colour buffer and
 * sent it whole, 1.33 MB, for the few hundred seats a dab changes. And the
 * particle code is generated with `new Function`, which is most of why the
 * Content Security Policy had to allow 'unsafe-eval'.
 *
 * Here a seat is four corners of position, worked out once and sent once,
 * and four bytes of state on each corner: its palette index, how far its
 * card is up in a reveal, and whether it is selected or flashing. The
 * colours themselves are a 256 × 2 texture: the palette, and the same
 * palette with the selection sheen on. So a stroke sends 16 bytes per
 * changed seat, and a palette edit sends the 2 KB table and nothing per seat.
 *
 * Plain quads, not one instanced quad: the same state could be one value a
 * seat with instancing, but a software GL (SwiftShader, what Chrome falls
 * back to without a usable GPU, and what the test machines run) pays a fixed
 * cost per instance, and measured 1.2–2 s a frame for 60,000 instances
 * against 0.1 s for the particles. Quads draw like the particles did.
 *
 * What the screen shows is what the particles showed: the same rectangles at
 * the same places (each seat 3.2 × 6.4 editor units, centred on its point,
 * the corner added to the point in float32 exactly as the particle shader
 * added them), the same colours (the table holds exactly the tints the
 * particles were given, the selection sheen included), and the same
 * transform (the stage's own projection and the world container's matrix).
 */

/** Seat size in editor units, as the particles had it (EDITOR_UNITS: 3.2 per seat, 8 per row). */
const SEAT_W = 3.2;
const SEAT_H = 6.4;

/** Flag bits in a seat's third byte. */
const SELECTED = 1;
const FLASH = 2;

/** Past this many runs in one upload, the whole state buffer is cheaper (and simpler) to send. */
const MAX_RUNS = 256;

/** The colour table: one row of palette colours, one of the same with the selection sheen. */
const TABLE_W = 256;
const TABLE_H = 2;

/** Corners of a seat, in the particles' order; the state is repeated on each. */
const CORNERS = 4;

// GLSL written the way Pixi writes its own (in/out, `finalColor`): Pixi
// compiles it as GLSL ES 1.00 on WebGL 1 and 2 alike, with its defines.
const VERTEX = /* glsl */ `
in vec2 aPosition;
in vec4 aSeat;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vLookup;
out float vShown;
out float vFlash;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // aSeat arrives as 0..255 per byte: index, shown, flags.
  float flags = aSeat.z;
  float selected = mod(flags, 2.0);
  vFlash = step(2.0, mod(flags, 4.0));
  vLookup = vec2((aSeat.x + 0.5) / ${TABLE_W.toFixed(1)}, (selected + 0.5) / ${TABLE_H.toFixed(1)});
  vShown = aSeat.y / 255.0;
}
`;

const FRAGMENT = /* glsl */ `
in vec2 vLookup;
in float vShown;
in float vFlash;

uniform sampler2D uPalette;
uniform vec3 uEmpty;
uniform vec3 uWarn;
uniform vec4 uColor;

out vec4 finalColor;

void main(void) {
  vec3 c = texture(uPalette, vLookup).rgb;
  // A reveal dims a seat toward the empty-seat colour, as far as its card is down.
  if (vShown < 0.999) c = mix(uEmpty, c, vShown);
  // The legibility check's warning colour replaces everything while it shows.
  if (vFlash > 0.5) c = uWarn;
  finalColor = vec4(c, 1.0) * uColor;
}
`;

/** '#rrggbb' as 0xRRGGBB the way the editor always read it (parseInt of the hex), or null. */
function rgbOf(hex: string | undefined): number | null {
  if (typeof hex !== 'string') return null;
  const v = parseInt(hex.slice(1), 16);
  return Number.isFinite(v) ? v & 0xffffff : null;
}

/** 45% toward white: the selection sheen, rounded exactly as the particle tints were. */
function sheen(rgb: number): number {
  const mix = (c: number): number => Math.round(c + (255 - c) * 0.45);
  return (mix((rgb >> 16) & 255) << 16) | (mix((rgb >> 8) & 255) << 8) | mix(rgb & 255);
}

/** The seats' view: a Mesh whose bounds are the seats', not its one quad's. */
class SeatsView extends Mesh<Geometry, Shader> {
  private readonly seatBounds: Bounds;

  constructor(geometry: Geometry, shader: Shader, bounds: Bounds) {
    super({ geometry, shader, label: 'seats' });
    this.seatBounds = bounds;
    // The editor routes every pointer itself (editor.ts bindPointer).
    this.eventMode = 'none';
  }

  override get bounds(): Bounds {
    if (this._boundsDirty) {
      this.updateBounds();
      this._boundsDirty = false;
    }
    return this._bounds;
  }

  protected override updateBounds(): void {
    this._bounds = this.seatBounds;
  }

  override containsPoint(): boolean {
    return false;
  }
}

export class SeatMesh {
  readonly view: Mesh<Geometry, Shader>;
  private readonly count: number;
  /** Four bytes a corner, the same on a seat's four: palette index, how far the card is up (0..255), flags, spare. */
  private readonly state: Uint8Array;
  private readonly stateBuffer: Buffer;
  /** The colour table's texels (RGBA), and the source Pixi uploads them from. */
  private readonly table = new Uint8Array(TABLE_W * TABLE_H * 4);
  private readonly tableSource: BufferImageSource;
  /** Seats whose state changed since the last upload; `whole` means send it all. */
  private changed: number[] = [];
  private whole = true;
  /** The seats flagged now, so a new selection or flash clears exactly the old one. */
  private selected: number[] = [];
  private flashing: number[] = [];

  constructor(map: SeatMap, cells: Uint8Array, palette: readonly string[], emptyRgb: number) {
    this.count = map.count;
    const n = map.count;
    this.state = new Uint8Array(Math.max(1, n) * CORNERS * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0, o = i * 16; c < CORNERS; c++, o += 4) {
        this.state[o] = cells[i];
        this.state[o + 1] = 255;
      }
    }
    // The four corners as the particle code worked them out for a 1×1
    // texture scaled to the seat and anchored at its centre, added to the
    // seat's point here. Both are float32 and their exact sum is rounded to
    // float32 once, which is what the particle shader's addition gave.
    const dx = [-0.5 * SEAT_W, 0.5 * SEAT_W, 0.5 * SEAT_W, -0.5 * SEAT_W].map(Math.fround);
    const dy = [-0.5 * SEAT_H, -0.5 * SEAT_H, 0.5 * SEAT_H, 0.5 * SEAT_H].map(Math.fround);
    const pos = new Float32Array(Math.max(1, n) * CORNERS * 2);
    const xy = map.xy;
    for (let i = 0, o = 0; i < n; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      for (let c = 0; c < CORNERS; c++, o += 2) {
        pos[o] = x + dx[c];
        pos[o + 1] = y + dy[c];
      }
    }
    // Two triangles a seat, in the particles' order. 16-bit indices while they reach.
    const index = n * CORNERS <= 65536 ? new Uint16Array(Math.max(1, n) * 6) : new Uint32Array(n * 6);
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      const v = i * CORNERS;
      index[o] = v;
      index[o + 1] = v + 1;
      index[o + 2] = v + 2;
      index[o + 3] = v;
      index[o + 4] = v + 2;
      index[o + 5] = v + 3;
    }
    this.stateBuffer = new Buffer({ data: this.state, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, label: 'seat-state' });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: new Buffer({ data: pos, usage: BufferUsage.VERTEX | BufferUsage.STATIC, label: 'seat-position' }), format: 'float32x2', stride: 8, offset: 0 },
        aSeat: { buffer: this.stateBuffer, format: 'uint8x4', stride: 4, offset: 0 },
      },
      indexBuffer: index,
    });

    this.tableSource = new BufferImageSource({
      resource: this.table,
      width: TABLE_W,
      height: TABLE_H,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'nearest',
      autoGenerateMipmaps: false,
      label: 'seat-colours',
    });
    const glProgram = GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'tifo-seats' });
    const shader = new Shader({
      glProgram,
      resources: {
        uPalette: this.tableSource,
        seatUniforms: {
          uEmpty: { value: new Float32Array([((emptyRgb >> 16) & 255) / 255, ((emptyRgb >> 8) & 255) / 255, (emptyRgb & 255) / 255]), type: 'vec3<f32>' },
          uWarn: { value: new Float32Array([0xff / 255, 0x2d / 255, 0x78 / 255]), type: 'vec3<f32>' },
        },
      },
    });

    const { minX, minY, maxX, maxY } = map.bounds;
    const bounds = n
      ? new Bounds(minX - SEAT_W / 2, minY - SEAT_H / 2, maxX + SEAT_W / 2, maxY + SEAT_H / 2)
      : new Bounds(0, 0, 0, 0);
    this.view = new SeatsView(geometry, shader, bounds);
    this.setPalette(palette, emptyRgb);
  }

  /**
   * The colours: index 0 and any index past the palette's end are the empty
   * seat, as the particles' tintFor had them. Sends the table only if it changed.
   */
  setPalette(palette: readonly string[], emptyRgb: number): void {
    let differs = false;
    for (let k = 0; k < TABLE_W; k++) {
      const rgb = k === 0 ? emptyRgb : rgbOf(palette[k]) ?? emptyRgb;
      differs = this.texel(k, 0, rgb) || differs;
      differs = this.texel(k, 1, sheen(rgb)) || differs;
    }
    // A table nobody has sent yet goes up with the first frame anyway.
    if (differs) this.tableSource.update();
  }

  private texel(k: number, row: number, rgb: number): boolean {
    const o = (row * TABLE_W + k) * 4;
    const t = this.table;
    const r = (rgb >> 16) & 255;
    const g = (rgb >> 8) & 255;
    const b = rgb & 255;
    if (t[o] === r && t[o + 1] === g && t[o + 2] === b && t[o + 3] === 255) return false;
    t[o] = r;
    t[o + 1] = g;
    t[o + 2] = b;
    t[o + 3] = 255;
    return true;
  }

  private set(i: number, byte: number, v: number): void {
    const o = i * 16 + byte;
    const s = this.state;
    if (s[o] === v) return;
    s[o] = v;
    s[o + 4] = v;
    s[o + 8] = v;
    s[o + 12] = v;
    if (!this.whole) this.changed.push(i);
  }

  /** These seats' palette indices changed (or every seat's). */
  cellsChanged(cells: Uint8Array, indices: ArrayLike<number> | 'all'): void {
    if (indices === 'all') {
      const n = Math.min(this.count, cells.length);
      for (let i = 0; i < n; i++) this.set(i, 0, cells[i]);
    } else {
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        if (i >= 0 && i < this.count) this.set(i, 0, cells[i]);
      }
    }
    this.compact();
  }

  /** The selection sheen on exactly these seats. */
  setSelected(seats: Iterable<number>): void {
    for (const i of this.selected) this.set(i, 2, this.state[i * 16 + 2] & ~SELECTED);
    const next: number[] = [];
    for (const i of seats) {
      if (i < 0 || i >= this.count) continue;
      next.push(i);
      this.set(i, 2, this.state[i * 16 + 2] | SELECTED);
    }
    this.selected = next;
    this.compact();
  }

  /** The warning colour on exactly these seats (none: an empty list). */
  setFlashing(seats: readonly number[]): void {
    for (const i of this.flashing) this.set(i, 2, this.state[i * 16 + 2] & ~FLASH);
    const next: number[] = [];
    for (const i of seats) {
      if (i < 0 || i >= this.count) continue;
      next.push(i);
      this.set(i, 2, this.state[i * 16 + 2] | FLASH);
    }
    this.flashing = next;
    this.compact();
  }

  /** How far each seat's card is up (0..1), or null for all the way. */
  setShown(visibility: ((seat: number) => number) | null): void {
    for (let i = 0; i < this.count; i++) {
      let v = 255;
      if (visibility) {
        const a = visibility(i);
        v = a >= 1 ? 255 : a > 0 ? Math.round(a * 255) : 0;
      }
      this.set(i, 1, v);
    }
    this.compact();
  }

  /** A change list longer than the seats is a whole upload anyway. */
  private compact(): void {
    if (!this.whole && this.changed.length > this.count) this.sendWhole();
  }

  private sendWhole(): void {
    this.whole = true;
    this.changed.length = 0;
  }

  /** A lost context came back: everything goes up again (Pixi re-creates the buffer from `state`). */
  contextRestored(): void {
    this.sendWhole();
  }

  /**
   * Send what changed, just before a frame is drawn. A whole upload is left
   * to Pixi (it sends the buffer when it next binds it); a partial one goes
   * straight into the buffer Pixi already holds on the GPU, run by run.
   *
   * A part is only ever written into a buffer that is on the GPU at its full
   * size. One that is not there yet, or not any more (the first frame, a
   * restored context, Pixi's clean-up of a buffer unused for a while), is
   * sent whole by Pixi from `state`, which always holds every seat.
   */
  upload(renderer: Renderer): void {
    if (this.whole) {
      this.whole = false;
      this.changed.length = 0;
      this.stateBuffer.update();
      return;
    }
    if (this.changed.length === 0) return;
    const runs = seatRuns(this.changed);
    this.changed.length = 0;
    if (runs.length / 2 > MAX_RUNS) {
      this.stateBuffer.update();
      return;
    }
    const r = renderer as WebGLRenderer;
    const gl = r.gl;
    if (!gl || typeof r.buffer?.getGlBuffer !== 'function' || gl.isContextLost()) {
      this.stateBuffer.update();
      return;
    }
    const glBuffer = r.buffer.getGlBuffer(this.stateBuffer);
    if (!glBuffer.buffer || glBuffer.byteLength < this.state.byteLength) {
      // Not on the GPU yet at its size: Pixi sends it whole when it binds it.
      this.stateBuffer.update();
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer.buffer);
    for (let k = 0; k < runs.length; k += 2) {
      const a = runs[k] * 16;
      const b = Math.min(runs[k + 1], this.count) * 16;
      if (b > a) gl.bufferSubData(gl.ARRAY_BUFFER, a, this.state.subarray(a, b));
    }
  }

  destroy(): void {
    this.view.destroy();
    this.tableSource.destroy();
  }
}
