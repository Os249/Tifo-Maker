import * as THREE from 'three';
import type { BannerDoc, BannerStore, StandIndex } from '../../core/banner';
import { KIND_PROFILE, revealSeconds } from '../../core/banner';
import { bannerToCanvas, onBannerImageReady } from '../bannerRender';
import type { StandFrame } from './standFrame';
import { bakeStandHeightfield, probe, type Heightfield, type Hit } from './standHeightfield';
import { Cloth, type ClothWorld } from './cloth';

/**
 * Banners in the bowl — real cloth, on a real rig, colliding with a real stand.
 *
 * ## What this replaced, and why
 *
 * The first version was a parametric surface: a formula giving the position of
 * every point of the sheet at time t. It could be shaped into something that
 * looked like a curve, but it had two faults that no amount of tuning could
 * fix.
 *
 * It did not know where the stand was. It kept clear of the terracing by
 * sitting a fixed distance along the stand's normal — which works for a sheet
 * that follows the rake and fails for every other, so a hanging banner sank
 * into the seats and came out the other side.
 *
 * And it made every stand-mounted banner lie ON the rake. That is wrong for
 * most of them. A sheet hung from a top edge hangs VERTICALLY; a tier face is
 * raked at 28-35°, so the two diverge and the banner stands off in free air —
 * the "curtain in front of the stand" that every photograph of a rope lift
 * shows. Only the two types the crowd physically carries — the Überziehfahne
 * and a stand cover — follow the seating, and even those ride about two metres
 * up, on raised hands, not on the concrete.
 *
 * So the shape is no longer authored. The fabric is simulated (see `cloth.ts`)
 * and the only thing this module decides is WHERE THE RIG HOLDS IT: which
 * particles are pinned, and where those pins are at this moment of the reveal.
 * Everything else — the drape, the sag, the swing, the ripple, and the fact
 * that it cannot pass through the stand — falls out of the solver.
 *
 * ## The reveals are timed by physics, not by an easing curve
 *
 * A drop is gravity: the bundle falls, and the sheet pays out behind it. A
 * rope lift is people hauling at half a metre a second, which is why a
 * twenty-metre lift takes half a minute and every account of one uses the word
 * "slowly". A crowd pass travels back through the block at about a metre a
 * second, one row of raised hands at a time. Those three speeds are what set
 * the durations, and they differ by an order of magnitude — which the first
 * version, with 4.2 seconds for everything, did not.
 */

export interface BannerRigLayer {
  readonly object: THREE.Group;
  refresh(): void;
  /** Advance the simulation. `dt` is real seconds since the last frame. */
  update(elapsed: number, dt: number): void;
  play(id?: string): void;
  setProgress(id: string, p: number): void;
  /** Run the solver forward without rendering, so a still can be taken. */
  settle(seconds: number): void;
  pick(raycaster: THREE.Raycaster): string | null;
  select(id: string | null): void;
  census(): { banners: number; ropes: number; nets: number; bars: number; poles: number; particles: number };
  /** Deepest any banner is inside its stand, in metres. The gate reads this. */
  /**
   * How deep the fabric is inside the terracing, in metres — the structural
   * question, measured against the concrete rather than against whatever the
   * rig is holding the sheet off.
   */
  worstPenetration(): number;

  /**
   * How far the fabric has dipped below what is holding it up, in metres.
   *
   * Not a fault: a gust pressing a sheet a few centimetres into the crowd
   * carrying it is what fabric does. Worth watching, because a large figure
   * means the support is being ignored rather than yielded to.
   */
  worstSag(): number;

  /** World-space box the fabric actually occupies, for framing and for tests. */
  bounds(id: string): { min: [number, number, number]; max: [number, number, number] } | null;
  dispose(): void;
}

const ROPE_COLOR = 0xd8d2c4;
const NET_COLOR = 0x9aa2ad;
/** Particles per banner. Enough to drape; cheap enough to run four at once. */
/** Fabric thickness above the concrete: what "inside the stand" means. */
const SOLID_CLEARANCE = 0.03;

const PARTICLE_BUDGET = 1400;
const SUBSTEPS = 8;
/** The simulation runs on a fixed step; the frame only says how many to take. */
const FIXED_DT = 1 / 60;

type Layout = 'hang' | 'surface' | 'ground';

interface Rig {
  doc: BannerDoc;
  group: THREE.Group;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshBasicMaterial;
  pos: Float32Array;
  nrm: Float32Array;
  texKey: string;
  cloth: Cloth;
  world: ClothWorld;
  layout: Layout;
  /** Cached stand geometry — baking is not free, and the stand does not move. */
  frame: StandFrame;
  field: Heightfield | null;
  ropes: THREE.LineSegments | null;
  net: THREE.LineSegments | null;
  bar: THREE.Mesh | null;
  poles: THREE.Mesh[];
  roll: THREE.Mesh | null;
  outline: THREE.LineSegments;
  /** Reveal progress 0..1 and how long the whole reveal takes, in seconds. */
  prog: number;
  playing: boolean;
  t0: number;
  durationS: number;
  /**
   * The RIG FRAME: where the crew tied the banner.
   *
   * The shape the layout walk produced, kept so the perimeter can be lashed
   * back to it every frame. This is the rigging itself — a banner's edge is
   * fixed to the structure at the shape the banner is meant to hold, and
   * everything between the grommets is free to breathe.
   */
  rigX: Float64Array;
  rigY: Float64Array;
  rigZ: Float64Array;
  /** Signature of everything that would require a rebuild. */
  sig: string;
  accum: number;
}

/**
 * How much play a tied edge has, in metres.
 *
 * Small, and it has to be. Eyelets go in every 50 cm and the hem they are
 * punched through has a rope sewn into it, so the EDGE ITSELF cannot get
 * shorter — the only freedom is the centimetre or two of movement a zip tie
 * through a grommet allows.
 *
 * That is not a detail. Slack along the edge is slack the middle of the sheet
 * can spend on bellying out: for a 20 m banner, nine centimetres a side buys
 * a metre of bulge, which is exactly the metre of bulge this had when the
 * number was nine centimetres. Two centimetres buys 40 cm, and the real thing
 * — roped hem, inextensible — buys almost none. A properly rigged tifo reads
 * as a flat printed wall, and this is the line that makes it one.
 */
const LASH_SLACK_M = 0.02;

/**
 * Play on an edge a crowd is holding rather than one tied to steelwork.
 *
 * Hands move. A Blockfahne's sides, held by the people on the terracing, are
 * not zip-tied to anything, so they breathe far more than a hem laced to a
 * rail — but they are still held every arm's length, which is why the sheet
 * stays a sheet.
 */
const HAND_SLACK_M = 0.45;

function textureKey(doc: BannerDoc): string {
  const art = JSON.stringify(doc.items);
  return `${doc.id}|${doc.material}|${doc.bg ?? '-'}|${art.length}|${hash(art)}`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Everything that changes the mesh or the rig rather than just the picture. */
function rigSignature(doc: BannerDoc): string {
  return [
    doc.kind, doc.widthM, doc.heightM, doc.material, doc.fabricGsm,
    doc.netBacked, doc.weightBar, doc.place.stand,
  ].join('|');
}

/** Which of the three ways this banner sits in the stadium. */
export function layoutFor(kind: BannerDoc['kind']): Layout {
  if (kind === 'pitch') return 'ground';
  // The two the crowd carries follow the seating; everything else hangs.
  if (kind === 'overhead-pass' || kind === 'stand-cover') return 'surface';
  return 'hang';
}

/**
 * How far off the surface the fabric is held.
 *
 * An Überziehfahne rides on raised hands — call it two metres above the
 * treads, which is where the research puts it and which is why the crowd
 * disappears under it rather than being flattened by it. A stand cover is
 * cable-tied down onto the seats. Everything else only touches the stand if
 * it swings into it, and then a few centimetres of cloth thickness is enough.
 */
/**
 * Which edge of the sheet the rigging holds.
 *
 * Almost everything is held along its top edge and hangs. Two are held from
 * below and built upward, and both of them live at the front rail: an
 * Aufziehfahne, made off along its bottom edge and hauled up on ropes, and a
 * pole banner, stood up and leaned out over the moat on two poles.
 *
 * For those, `heightV` means the rail the crowd is leaning on rather than a
 * point somewhere up the back of the stand. Getting it backwards is what made
 * a rope lift need an anchor implausibly high up the terracing before its
 * bottom edge landed anywhere near the front.
 */
function anchorEdgeOf(mode: BannerDoc['reveal']): 'top' | 'bottom' {
  return mode === 'lift' || mode === 'unfold' ? 'bottom' : 'top';
}

/**
 * How high the crowd holds a sheet off the concrete, in metres.
 *
 * The thing an empty-stadium cloth simulation gets wrong. A banner released
 * down the face of a full kop does not land on the terracing — it lands on
 * fifteen hundred people, and stays about head height above the treads for as
 * long as they hold it. That is why a real Blockfahne reads as a taut plane
 * over the block and a simulated one reads as a dust sheet over furniture.
 *
 * It needs a crowd to work. One person cannot hold up a sheet spanning twenty
 * rows; a packed block can, because the support is continuous. So it comes in
 * over the fill fraction rather than switching on: nothing below about 15%,
 * full head height by about 60%, which is roughly where a terrace stops
 * having holes in it.
 */
function crowdSupportM(fill: number): number {
  const t = (fill - 0.15) / 0.45;
  const sm = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  return 1.72 * sm;
}

/**
 * How far off the stand the fabric is held.
 *
 * An Überziehfahne rides on raised hands — arms up, so a little above head
 * height, which is why the crowd disappears under it rather than being
 * flattened by it. A stand cover is the one type meant for an EMPTY stand, so
 * it is cable-tied down onto the seats and the crowd does not come into it.
 * Everything else that touches the stand comes to rest on whoever is standing
 * there, and on the concrete when nobody is.
 */
/**
 * How firmly whatever the banner is resting on holds on to it, 0..1.
 *
 * A crowd grips; concrete and grass do not. The two types that are explicitly
 * NOT over people — a cover on an empty stand, a centre-circle banner on the
 * grass — get nothing from the crowd however full the ground is, because the
 * thing holding them is cable ties and stewards' weights.
 */
function gripFor(kind: BannerDoc['kind'], fill: number): number {
  if (kind === 'stand-cover' || kind === 'pitch') return 0.15;
  const t = (fill - 0.15) / 0.45;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

function clearanceFor(kind: BannerDoc['kind'], crowdTop: number): number {
  if (kind === 'overhead-pass') return Math.max(2.05, crowdTop + 0.4);
  if (kind === 'stand-cover') return 0.35;
  if (kind === 'pitch') return 0.06;
  return Math.max(0.06, crowdTop);
}

export function buildBannerRigs(
  bannerStore: BannerStore,
  frameFor: (stand: StandIndex) => StandFrame,
  /** Crowd fill 0..1, live: a banner over a full block rests on people. */
  crowdFill: () => number = () => 0,
): BannerRigLayer {
  const root = new THREE.Group();
  root.name = 'banners';
  const rigs = new Map<string, Rig>();
  const texCache = new Map<string, THREE.Texture>();
  const fieldCache = new Map<number, Heightfield>();
  let elapsed = 0;
  let selectedId: string | null = null;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();

  function fieldFor(stand: StandIndex): Heightfield | null {
    let f = fieldCache.get(stand);
    if (!f) {
      const frame = frameFor(stand);
      if (!frame.ok) return null;
      f = bakeStandHeightfield(frame);
      fieldCache.set(stand, f);
    }
    return f;
  }

  function texture(doc: BannerDoc): THREE.Texture {
    const key = textureKey(doc);
    const hit = texCache.get(key);
    if (hit) return hit;
    const canvas = bannerToCanvas(doc, { maxEdge: 1024, perforate: true });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    texCache.set(key, tex);
    if (texCache.size > 12) {
      for (const [k, t] of texCache) {
        if (k === key) continue;
        t.dispose();
        texCache.delete(k);
        if (texCache.size <= 12) break;
      }
    }
    return tex;
  }

  // -------------------------------------------------------------------------
  // Wind
  // -------------------------------------------------------------------------

  /**
   * Stadium air.
   *
   * The dominant gust timescale is set by the size of the eddies — roughly the
   * mean speed divided by their length — which in a stadium bowl comes out at
   * a ten to thirty second period. Animating gusts at one Hertz, which is the
   * obvious thing to do, reads as vibration rather than as weather.
   *
   * There is a spatial term as well, travelling across the banner at the wind
   * speed, because a forty-metre sheet in uniform wind moves like one rigid
   * sail instead of like fabric.
   */
  function makeWind(doc: BannerDoc, dirX: number, dirZ: number, frame: StandFrame): ClothWorld['wind'] {
    // 0..1 in the panel maps to a still bowl through to the speed at which a
    // real group would start thinking about not doing the display at all.
    const base = 0.4 + doc.wind * 7.5;
    const phase = hash(doc.id) % 1000;
    // A bowl is a wind shadow.
    //
    // Everyone who has played in one knows it: the flags on the roof are
    // streaming and the corner flag is barely moving. The stands block the
    // flow and what reaches pitch level is a fraction of what crosses the
    // rim. Without this, a banner pegged on the grass gets the same wind as
    // one flown from the roof steel, and behaves like a kite — measured, a
    // centre-circle banner was moving a quarter of a metre per frame.
    const yLow = frame.railY;
    const yHigh = Math.max(yLow + 6, frame.roofY);
    const profile = (y: number): number => {
      const t = (y - yLow) / (yHigh - yLow);
      const u = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      return 0.22 + 0.78 * u;
    };
    return (x, y, z, out) => {
      const t = elapsed;
      const g = fbm(t * 0.06 + phase, 4);
      const along = x * dirX + z * dirZ;
      const sp = noise1((along - base * t) / 18);
      const speed = base * profile(y) * (1 + 0.5 * (0.7 * g + 0.3 * sp));
      const yaw = 0.3 * fbm(t * 0.05 + phase + 137, 3);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      out.x = (dirX * c - dirZ * s) * speed;
      out.z = (dirX * s + dirZ * c) * speed;
      // A little vertical, because a crowd of thirty thousand is a heater.
      out.y = 0.18 * speed * fbm(t * 0.09 + phase + 913, 2) + Math.max(0, 1.2 - y * 0.02) * 0.15;
      void yLow;
    };
  }

  function noise1(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const a = hashF(i);
    const b = hashF(i + 1);
    return (a + (b - a) * u) * 2 - 1;
  }
  function hashF(n: number): number {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }
  function fbm(x: number, octaves: number): number {
    let a = 1;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let k = 0; k < octaves; k++) {
      sum += a * noise1(x * f);
      norm += a;
      a *= 0.5;
      f *= 2.3;
    }
    return sum / norm;
  }

  // -------------------------------------------------------------------------
  // Building a rig
  // -------------------------------------------------------------------------

  function makeRig(doc: BannerDoc): Rig {
    const frame = frameFor(doc.place.stand);
    const layout = layoutFor(doc.kind);
    const W = doc.widthM;
    const H = doc.heightM;

    // Grid resolution from area, so a fence flag is not simulated at the same
    // cost as a sheet covering a whole kop.
    const spacing = Math.max(0.5, Math.sqrt((W * H) / PARTICLE_BUDGET));
    const cols = Math.max(6, Math.min(72, Math.round(W / spacing) + 1));
    const rows = Math.max(5, Math.min(48, Math.round(H / spacing) + 1));

    const gsm = doc.fabricGsm / 1000;
    // A perforated banner passes air: the wind-tunnel work on perforated signs
    // puts a 30-40% open mesh at roughly two thirds of a solid sheet's drag,
    // and it suppresses flutter harder than it suppresses bulge.
    const kappa = doc.material === 'mesh' ? 0.65 : 1;
    const cloth = new Cloth(
      {
        cols,
        rows,
        arealKgM2: gsm,
        dragC: 1.28 * kappa,
        liftC: 0.35 * kappa * kappa,
        // Stiffer for heavy PVC, floppier for light scrim. Kept independent of
        // the stretch constraint: one global "stiffness" slider is what makes
        // an inextensible banner also board-stiff.
        bendCompliance: gsm > 0.15 ? 4e-5 : 3e-4,
        hemWeight: doc.weightBar ? 3 : 1,
      },
      W,
      H,
    );

    const field = layout === 'ground' ? null : fieldFor(doc.place.stand);
    const world: ClothWorld = {
      wind: makeWind(doc, 0, 1, frame),
      field,
      clearance: clearanceFor(doc.kind, crowdSupportM(crowdFill())),
      grip: gripFor(doc.kind, crowdFill()),
      groundY: 0,
    };

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cloth.count * 3);
    const nrm = new Float32Array(cloth.count * 3);
    const uv = new Float32Array(cloth.count * 2);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        uv[k * 2] = i / (cols - 1);
        uv[k * 2 + 1] = 1 - j / (rows - 1);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // Same alternating diagonal the solver's edges use, so the shading and
        // the simulation fold along the same lines.
        if ((i + j) % 2 === 0) {
          idx.push(a, c, d, a, d, b);
        } else {
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.StreamDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.StreamDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // Bounds are set once and generously; recomputing them every frame for a
    // mesh whose vertices all move is pure cost.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    const mat = new THREE.MeshBasicMaterial({
      map: texture(doc),
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: doc.material === 'mesh' ? 0.4 : 0.02,
      depthWrite: doc.material !== 'mesh',
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.userData.bannerId = doc.id;
    mesh.renderOrder = 4;

    const group = new THREE.Group();
    group.name = `banner:${doc.id}`;
    group.add(mesh);

    const profile = KIND_PROFILE[doc.kind];
    const ropes = profile.roped ? lineSet(ROPE_COLOR, 8, 1) : null;
    if (ropes) group.add(ropes);
    const net = doc.netBacked ? lineSet(NET_COLOR, (NET_U + NET_V) * 14, 0.5) : null;
    // The net is structure, not decoration. Drawing it and not enforcing it
    // is what let a net-backed banner belly out by metres while its ropes sat
    // obediently on the surface of the bulge.
    cloth.netted = doc.netBacked;
    if (net) group.add(net);

    let bar: THREE.Mesh | null = null;
    if (doc.weightBar) {
      const g = new THREE.CylinderGeometry(0.14, 0.14, 1, 7);
      g.rotateZ(Math.PI / 2);
      bar = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.7, metalness: 0.3 }));
      bar.frustumCulled = false;
      group.add(bar);
    }

    const poles: THREE.Mesh[] = [];
    if (doc.kind === 'pole-out') {
      for (let i = 0; i < 2; i++) {
        const g = new THREE.CylinderGeometry(0.08, 0.08, 1, 6);
        g.rotateZ(Math.PI / 2);
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.42, metalness: 0.55 }));
        m.frustumCulled = false;
        poles.push(m);
        group.add(m);
      }
    }

    let roll: THREE.Mesh | null = null;
    if (doc.reveal === 'drop' || doc.reveal === 'lift') {
      const g = new THREE.CylinderGeometry(1, 1, 1, 12);
      g.rotateZ(Math.PI / 2);
      roll = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xded9cf, roughness: 0.95 }));
      roll.frustumCulled = false;
      roll.visible = false;
      group.add(roll);
    }

    const outline = lineSet(0xff5db1, 4, 1);
    outline.visible = false;
    outline.renderOrder = 6;
    (outline.material as THREE.LineBasicMaterial).depthTest = false;
    group.add(outline);

    root.add(group);

    const rig: Rig = {
      doc, group, mesh, geo, mat, pos, nrm,
      texKey: textureKey(doc),
      cloth, world, layout, frame, field,
      ropes, net, bar, poles, roll, outline,
      rigX: new Float64Array(cloth.count),
      rigY: new Float64Array(cloth.count),
      rigZ: new Float64Array(cloth.count),
      prog: 1, playing: false, t0: 0,
      durationS: revealSeconds(doc),
      sig: rigSignature(doc),
      accum: 0,
    };
    layoutCloth(rig);
    return rig;
  }

  const NET_U = 8;
  const NET_V = 5;

  function lineSet(color: number, segments: number, opacity: number): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 6), 3).setUsage(THREE.StreamDrawUsage));
    const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const ls = new THREE.LineSegments(g, m);
    ls.frustumCulled = false;
    ls.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);
    return ls;
  }

  // -------------------------------------------------------------------------
  // Where the sheet starts
  // -------------------------------------------------------------------------

  /** The banner's frame of reference on its stand: origin, along, out. */
  /**
   * Move an authored point out of the stand before pinning it there.
   *
   * Pinned particles have infinite mass, so the collision constraint skips
   * them: whatever position the rig hands them is where they stay, inside the
   * terracing or not. That is fine when the rig and the collider agree about
   * where the surface is, and they don't quite — the heightfield takes the
   * HIGHEST sample in each cell, deliberately, so it sits a step-riser above
   * the true surface at every nosing. A pin placed on the true surface is
   * therefore inside the collider by up to the height of one step.
   *
   * Measured, that was 0.27 m on a stand cover: not fabric in the concrete,
   * but a rig and a collider describing the same stand differently, which is
   * the kind of disagreement that becomes fabric in the concrete the moment
   * either one changes. One probe per pin settles it.
   */
  function pinClear(rig: Rig, v: THREE.Vector3): THREE.Vector3 {
    const f = rig.field;
    if (!f) return v;
    // Three passes, because one is not enough. The probe converts a VERTICAL
    // gap into a distance along the normal, which is exact for a plane and a
    // little short on a curved rake; and moving along the normal changes x and
    // z, which lands on a different part of the surface. Iterating converges
    // in two or three: measured, one pass left 58 mm on a rope lift, three
    // leave nothing worth printing.
    for (let pass = 0; pass < 3; pass++) {
      probe(f, v.x, v.y, v.z, rig.world.clearance, hitScratch);
      if (hitScratch.depth <= 1e-4) break;
      v.x += hitScratch.nx * hitScratch.depth;
      v.y += hitScratch.ny * hitScratch.depth;
      v.z += hitScratch.nz * hitScratch.depth;
    }
    return v;
  }

  const hitScratch: Hit = { depth: 0, nx: 0, ny: 1, nz: 0 };

  function anchorOf(doc: BannerDoc, frame: StandFrame): {
    ox: number; oy: number; oz: number;
    rx: number; rz: number; nx: number; nz: number;
  } {
    // A roof-hung banner is the one type that does not touch the stand at all.
    //
    // It is flown from the roof steel IN FRONT of the terracing, in the air
    // over the first rows, which is the only place there is room for it: a
    // sheet hung from the roof above the middle of a 30 degree rake is inside
    // the seating within a couple of metres, and what came out of that was a
    // banner draped over the seats being called roof-hung. So its horizontal
    // place is the front rail pushed out, and `heightV` runs its top edge
    // from the rail up to the roof rather than up the terracing.
    const inAir = doc.kind === 'roof-hung';
    const a = inAir
      ? frame.pointAt(doc.place.alongU, 0)
      : frame.pointAt(doc.place.alongU, Math.min(1, doc.place.heightV));
    const yaw = (doc.place.yawDeg * Math.PI) / 180;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rx = a.rx * c - a.rz * s;
    const rz = a.rx * s + a.rz * c;
    const nx = a.ox * c - a.oz * s;
    const nz = a.ox * s + a.oz * c;
    const headroom = frame.roofY - frame.railY;
    return {
      ox: a.x + nx * doc.place.outM,
      oy: inAir
        ? frame.railY + Math.max(0.1, Math.min(1, doc.place.heightV)) * Math.max(4, headroom)
        : a.y,
      oz: a.z + nz * doc.place.outM,
      rx, rz, nx, nz,
    };
  }

  /**
   * The anchor, already lifted clear of whatever is under it.
   *
   * Both the layout and the rig have to measure from the SAME point or the
   * banner ends up with slack it should not have. A rope lift is anchored at
   * the front rail, and the rail is where the crowd is standing, so clearing
   * lifts it about 1.7 m; the batten 18 m above it is in open air and gets
   * lifted by nothing. Clear one and not the other and the two pins end up
   * 16.3 m apart holding 18 m of cloth — a metre and a half of slack, which
   * the wind then has something to do with. That was the whole of the rope
   * lift's remaining flap.
   */
  function clearedAnchor(rig: Rig): ReturnType<typeof anchorOf> {
    const a = anchorOf(rig.doc, rig.frame);
    pinClear(rig, tmpC.set(a.ox, a.oy, a.oz));
    a.ox = tmpC.x;
    a.oy = tmpC.y;
    a.oz = tmpC.z;
    return a;
  }

  function layoutCloth(rig: Rig): void {
    const { doc, frame, cloth, layout } = rig;
    const W = doc.widthM;
    const H = doc.heightM;

    if (layout === 'ground') {
      const a = frame.pointAt(doc.place.alongU, 0);
      const cx = a.x + a.ox * (13 + doc.place.outM);
      const cz = a.z + a.oz * (13 + doc.place.outM);
      cloth.reset((i, j, out) => {
        const u = i / (cloth.cols - 1) - 0.5;
        const v = j / (cloth.rows - 1) - 0.5;
        out.x = cx + a.rx * (u * W) + a.ox * (v * H);
        out.y = 0.05;
        out.z = cz + a.rz * (u * W) + a.oz * (v * H);
      });
      captureRigFrame(rig);
      return;
    }

    if (layout === 'surface') {
      // Lying on the stand, and therefore measured UP THE SLOPE. A sheet meant
      // to cover twenty metres of height on a 30-degree rake needs forty
      // metres of cloth; getting that wrong is the commonest reason a
      // simulated tifo reads as a sticker rather than as fabric.
      const spanU = Math.min(1.4, W / Math.max(1, frame.widthM));
      const spanV = Math.min(1.4, H / Math.max(1, frame.slopeM));
      const topV = doc.place.heightV;
      cloth.reset((i, j, out) => {
        const u = i / (cloth.cols - 1);
        const v = j / (cloth.rows - 1);
        const p = frame.pointAt(doc.place.alongU + (u - 0.5) * spanU, topV - v * spanV);
        const n = frame.normalAt(doc.place.alongU + (u - 0.5) * spanU, topV - v * spanV);
        const off = rig.world.clearance + 0.05;
        out.x = p.x + n.nx * off;
        out.y = p.y + n.ny * off;
        out.z = p.z + n.nz * off;
      });
      captureRigFrame(rig);
      return;
    }

    // Hanging: straight down from the anchor, which is what a sheet held along
    // its top edge does. It will meet the terracing below on its own, and the
    // collision constraint is what decides where.
    const a = clearedAnchor(rig);
    const tilt = (doc.place.tiltDeg * Math.PI) / 180;
    const dy = -Math.cos(tilt);
    const dOut = Math.sin(tilt);
    const bottomAnchored = anchorEdgeOf(doc.reveal) === 'bottom';
    const rows = cloth.rows;
    const cols = cloth.cols;
    const dv = H / (rows - 1);

    // A DRAPE, not a plane.
    //
    // The version this replaces laid the sheet out as a flat rectangle hanging
    // straight down from its anchor, and left the solver to sort out the
    // collision. On a stand that does not work: a sheet hung from the back of
    // a 30-degree rake is inside the terracing from its second row down, so
    // the solver spent its first frames shoving twelve metres of fabric out of
    // the concrete, and what came out the other side was a metre-wide crumple
    // against the seats. Correct by the penetration measurement, useless as a
    // banner — which is the exact failure mode this whole rewrite exists to
    // stop me repeating.
    //
    // So the layout walks the sheet down row by row instead. Each row steps a
    // row-spacing in the hanging direction from the row above, and if that
    // lands inside the stand it is pushed back out and the step re-scaled to
    // keep the spacing right. Where there is air the walk falls straight and
    // the banner hangs; where there is terracing it slides down the rake and
    // the banner lies on it. Both come out of the same three lines, because
    // they are the same thing happening to different surfaces.
    const walkX = new Float64Array(rows * cols);
    const walkY = new Float64Array(rows * cols);
    const walkZ = new Float64Array(rows * cols);
    // Row indices in the order the fabric leaves the anchor.
    const order: number[] = [];
    if (bottomAnchored) for (let j = rows - 1; j >= 0; j--) order.push(j);
    else for (let j = 0; j < rows; j++) order.push(j);
    // Bottom-anchored sheets are built upward, so the walk direction flips.
    const sy = bottomAnchored ? -dy : dy;
    const sOut = bottomAnchored ? -dOut : dOut;

    for (let n = 0; n < order.length; n++) {
      const j = order[n];
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const u = i / (cols - 1) - 0.5;
        if (n === 0) {
          walkX[k] = a.ox + a.rx * (u * W);
          walkY[k] = a.oy;
          walkZ[k] = a.oz + a.rz * (u * W);
        } else {
          const pk = order[n - 1] * cols + i;
          const px = walkX[pk];
          const py = walkY[pk];
          const pz = walkZ[pk];
          tmpA.set(px + a.nx * (sOut * dv), py + sy * dv, pz + a.nz * (sOut * dv));
          pinClear(rig, tmpA);
          // Re-scale back to one row spacing from the row above, so pushing
          // the sheet out of the stand never shortens it.
          const ddx = tmpA.x - px;
          const ddy = tmpA.y - py;
          const ddz = tmpA.z - pz;
          const len = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1;
          tmpA.set(px + (ddx / len) * dv, py + (ddy / len) * dv, pz + (ddz / len) * dv);
          pinClear(rig, tmpA);
          walkX[k] = tmpA.x;
          walkY[k] = tmpA.y;
          walkZ[k] = tmpA.z;
        }
      }
    }
    cloth.reset((i, j, out) => {
      const k = j * cols + i;
      out.x = walkX[k];
      out.y = walkY[k];
      out.z = walkZ[k];
    });
    captureRigFrame(rig);
  }

  /**
   * Remember the shape the crew tied the banner into.
   *
   * Taken straight off the laid-out cloth, so the rigging and the layout are
   * the same description by construction — the perimeter is lashed back to
   * exactly where it was put, which is what a grommet on a rail does.
   */
  function captureRigFrame(rig: Rig): void {
    const c = rig.cloth;
    for (let k = 0; k < c.count; k++) {
      rig.rigX[k] = c.px[k];
      rig.rigY[k] = c.py[k];
      rig.rigZ[k] = c.pz[k];
    }
  }

  /**
   * Run a side rope down each edge, between whatever the rig is holding.
   *
   * The two ends of a side rope are the two pinned corners of that column, so
   * the rope follows the rigging rather than a remembered shape — which is
   * what a rope tied to a batten does when the batten moves. `deployed` is
   * how much of the sheet is off the pile: the rest is not on the ropes yet.
   */
  function lashBetweenPinnedEnds(rig: Rig, slack: number, deployed: number): void {
    const c = rig.cloth;
    const cols = c.cols;
    const rows = c.rows;
    const first = Math.max(0, Math.floor((1 - Math.max(0, Math.min(1, deployed))) * (rows - 1)));
    for (const i of [0, cols - 1]) {
      const kT = c.index(i, 0);
      const kB = c.index(i, rows - 1);
      for (let j = first + 1; j < rows - 1; j++) {
        const k = c.index(i, j);
        if (c.w[k] === 0) continue;
        const f = j / (rows - 1);
        c.lash(
          k,
          c.px[kT] + (c.px[kB] - c.px[kT]) * f,
          c.py[kT] + (c.py[kB] - c.py[kT]) * f,
          c.pz[kT] + (c.pz[kB] - c.pz[kT]) * f,
          slack,
        );
      }
    }
  }

  /**
   * Lace the banner's edges to the rig frame.
   *
   * `fromRow`/`toRow` bound the part of the sheet that is actually deployed:
   * during a reveal the rest is still on the roll and has no business being
   * tied to anything. `dy` shifts the whole frame, for the rigs that lower a
   * finished banner rather than unrolling it.
   */
  function lashEdges(
    rig: Rig,
    fromRow: number,
    toRow: number,
    slack: number,
    dy = 0,
    lashFarEdge = true,
  ): void {
    const c = rig.cloth;
    const cols = c.cols;
    const lo = Math.max(0, Math.min(fromRow, toRow));
    const hi = Math.min(c.rows - 1, Math.max(fromRow, toRow));
    for (let j = lo; j <= hi; j++) {
      for (const i of [0, cols - 1]) {
        const k = c.index(i, j);
        if (c.w[k] === 0) continue;
        c.lash(k, rig.rigX[k], rig.rigY[k] + dy, rig.rigZ[k], slack);
      }
    }
    if (!lashFarEdge) return;
    for (let i = 1; i < cols - 1; i++) {
      const k = c.index(i, hi);
      if (c.w[k] === 0) continue;
      c.lash(k, rig.rigX[k], rig.rigY[k] + dy, rig.rigZ[k], slack);
    }
  }

  // -------------------------------------------------------------------------
  // What the rig holds, at this moment of the reveal
  // -------------------------------------------------------------------------

  /**
   * Pin the particles the rigging is holding, and put them where they are now.
   *
   * This is the only part of the banner's shape that is authored. Everything
   * else is the solver's answer to "given that these points are here, and
   * there is gravity and air and a stand, where does the fabric go".
   */
  function applyRig(rig: Rig, dt: number): void {
    const { doc, frame, cloth } = rig;
    const p = rig.prog;
    const H = doc.heightM;
    const cols = cloth.cols;
    const rows = cloth.rows;
    const dv = H / (rows - 1);
    cloth.unpinAll();

    const a = clearedAnchor(rig);
    const mode = doc.reveal;

    if (rig.layout === 'ground') {
      // Pegged at the corners, the rest lying on the grass.
      for (const [i, j] of [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]] as [number, number][]) {
        const k = cloth.index(i, j);
        pinClear(rig, tmpA.set(cloth.px[k], Math.max(0.05, cloth.py[k]), cloth.pz[k]));
        cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
      }
      // Weighted all the way round, not just at the corners. A centre-circle
      // banner pegged only at four points is a kite, and measured as one: it
      // was moving 0.67 m per frame before this line existed.
      lashEdges(rig, 0, cloth.rows - 1, LASH_SLACK_M);
      cloth.buildTethers();
      return;
    }

    if (rig.layout === 'surface') {
      const spanU = Math.min(1.4, doc.widthM / Math.max(1, frame.widthM));
      const spanV = Math.min(1.4, H / Math.max(1, frame.slopeM));
      const topV = doc.place.heightV;
      const off = rig.world.clearance;
      // A crowd pass travels backwards, one row of raised hands at a time. The
      // rows the fold has reached are being carried; the rest are still a
      // bundle at the front rail.
      const front = mode === 'pass' ? p : 1;
      const held = mode === 'pass' ? 1 - front : 0;
      for (let j = 0; j < rows; j++) {
        const v = j / (rows - 1);
        // Every second row is a hand. Between them the fabric dips a few
        // centimetres, which is the whole difference between a sheet and a
        // decal at this distance.
        const carried = j % 2 === 0 && v >= held;
        if (!carried) continue;
        for (let i = 0; i < cols; i++) {
          const su = doc.place.alongU + (i / (cols - 1) - 0.5) * spanU;
          const sv = topV - v * spanV;
          const q = frame.pointAt(su, sv);
          const n = frame.normalAt(su, sv);
          const k = cloth.index(i, j);
          pinClear(rig, tmpA.set(q.x + n.nx * off, q.y + n.ny * off, q.z + n.nz * off));
          cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
        }
      }
      if (mode === 'pass' && held > 0) {
        // The undeployed remainder, gathered at the front rail.
        const rail = frame.pointAt(doc.place.alongU, Math.max(0, topV - spanV));
        const rn = frame.normalAt(doc.place.alongU, Math.max(0, topV - spanV));
        for (let j = 0; j < rows; j++) {
          if (j / (rows - 1) >= held) continue;
          for (let i = 0; i < cols; i++) {
            const su = doc.place.alongU + (i / (cols - 1) - 0.5) * spanU;
            const q = frame.pointAt(su, Math.max(0, topV - spanV));
            const k = cloth.index(i, j);
            pinClear(rig, tmpA.set(
              q.x + rn.nx * (off + 0.4),
              q.y + rn.ny * (off + 0.4) + 0.3,
              q.z + rn.nz * (off + 0.4),
            ));
            cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
          }
        }
        void rail;
      }
      // The edges of a sheet over a block are in hands, not on hooks.
      lashEdges(rig, Math.floor(held * (rows - 1)), rows - 1, HAND_SLACK_M);
      cloth.buildTethers();
      return;
    }

    // ---- hanging rigs ------------------------------------------------------
    const tilt = (doc.place.tiltDeg * Math.PI) / 180;
    const tdy = -Math.cos(tilt);
    const tdOut = Math.sin(tilt);

    /**
     * World position of a point on the banner's nominal (undeformed) plane,
     * pushed clear of the terracing if the rig asked for a point inside it.
     */
    const plane = (u: number, dist: number, yOff: number, outOff: number, o: THREE.Vector3): THREE.Vector3 => {
      const s = (u - 0.5) * doc.widthM;
      o.set(
        a.ox + a.rx * s + a.nx * (tdOut * dist + outOff),
        a.oy + tdy * dist + yOff,
        a.oz + a.rz * s + a.nz * (tdOut * dist + outOff),
      );
      return pinClear(rig, o);
    };

    if (mode === 'drop') {
      // The top edge is made off to the rail before anything is dropped. The
      // remainder is a bundle that falls, paying fabric out behind it — the
      // deployed length follows gravity, which is why a drop is over in a few
      // seconds however big the banner is.
      const fallT = Math.sqrt((2 * H) / 9.81);
      const tau = p * rig.durationS;
      const deployed = Math.min(H, 0.5 * 9.81 * tau * tau);
      for (let i = 0; i < cols; i++) {
        const k = cloth.index(i, 0);
        plane(i / (cols - 1), 0, 0, 0, tmpA);
        cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
      }
      if (deployed < H - 1e-6) {
        for (let j = 0; j < rows; j++) {
          if (j * dv <= deployed) continue;
          for (let i = 0; i < cols; i++) {
            const k = cloth.index(i, j);
            plane(i / (cols - 1), deployed, 0, 0.25, tmpA);
            cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
          }
        }
      }
      void fallT;
      // The sides, as far down as the sheet has actually come. A Blockfahne's
      // edges are held all the way down the block — on the barriers where
      // there are barriers and in people's hands where there are not.
      lashEdges(rig, 0, Math.min(rows - 1, Math.floor(deployed / dv)), HAND_SLACK_M);
      cloth.buildTethers();
      return;
    }

    if (mode === 'lift') {
      // An Aufziehfahne. The sheet is folded along the front rail with its
      // BOTTOM edge made off there; ropes run from a batten in the head hem
      // up over the back of the stand. Hauling raises the batten and the
      // fabric unrolls off the pile from the top down, which is why the crowd
      // behind it still has their hands free for the cards — the whole point
      // of rigging it this way rather than dropping it.
      //
      // So the deployed length is measured DOWN from the batten, the pile
      // shrinks from the bottom, and nothing about it resembles a drop.
      const deployed = Math.min(H, p * H);
      // Bottom edge: on the rail, the whole time.
      for (let i = 0; i < cols; i++) {
        const k = cloth.index(i, rows - 1);
        plane(i / (cols - 1), 0, 0, 0, tmpA);
        cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
      }
      // The batten, as high above the rail as has been hauled. It leans out
      // as it rises: the ropes run backwards over the stand, so the head of
      // the sheet is pulled away from the terracing, not into it.
      for (let i = 0; i < cols; i++) {
        const k = cloth.index(i, 0);
        plane(i / (cols - 1), -deployed, 0, 0.35 * (deployed / H), tmpA);
        cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
      }
      // Everything still on the pile. Rows are indexed from the head, so a row
      // is off the pile once the batten has risen past it.
      for (let j = 1; j < rows - 1; j++) {
        if (j * dv <= deployed) continue;
        for (let i = 0; i < cols; i++) {
          const k = cloth.index(i, j);
          // Heaped, not flat: a few tens of centimetres of bulk on the rail.
          const heap = 0.35 + 0.25 * Math.sin((i / Math.max(1, cols - 1)) * 7.3);
          plane(i / (cols - 1), 0, heap * 0.5, heap, tmpA);
          cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
        }
      }
      // Side ropes, run from the rail to the batten — which is what holds an
      // Aufziehfahne flat enough to read while it is still going up.
      //
      // Taken from where the rigging IS right now, not from the shape the
      // banner was laid out in. The batten leans out as it rises, so lashing
      // the sides to the static layout puts the ropes and the batten in
      // disagreement, and the sheet buzzes between the two. Measured, that
      // disagreement was half a metre of movement per frame.
      lashBetweenPinnedEnds(rig, LASH_SLACK_M, deployed / H);
      cloth.buildTethers();
      return;
    }

    if (mode === 'hoist') {
      // Lowered from the roof on lines: controlled descent, not a drop. The
      // whole banner comes down together and settles on its ropes.
      const restY = a.oy;
      // From the roof steel down to where it flies. Never up: if the rest
      // height is already at the roof there is nothing to lower.
      const y = Math.max(restY, frame.roofY) + (restY - Math.max(restY, frame.roofY)) * p;
      for (let i = 0; i < cols; i++) {
        const k = cloth.index(i, 0);
        plane(i / (cols - 1), 0, y - restY, 0, tmpA);
        cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
      }
      // This is the case the research describes most exactly: grommets all
      // round, zip-tied to a net. The whole perimeter is tied, and the whole
      // perimeter comes down together.
      lashEdges(rig, 0, rows - 1, LASH_SLACK_M, y - restY);
      cloth.buildTethers();
      return;
    }

    if (mode === 'unfold') {
      // A pole banner, stood up at the front rail and leaned out.
      //
      // It cannot be propped out from the FACE of the stand, and that is
      // geometry rather than preference: over the 8 m this sheet drops, a 30
      // degree rake falls away 14 m horizontally, so holding its bottom edge
      // clear of the seats would need poles half as long again as the banner.
      // Nobody has those. What people actually do is stand it up at the front
      // of the block and lean it out over the moat, where there is air.
      //
      // The first version of this ran it out from half way up the terracing
      // and buried 1.74 m of it in the seating mid-swing; the second stopped
      // the penetration by letting the sheet lie flat on the rake, which is
      // worse — a clean measurement of the wrong thing.
      const outNow = doc.place.outM * (0.1 + 0.9 * p);
      const tiltNow = tilt * p;
      const up = H * Math.cos(tiltNow);
      const reach = H * Math.sin(tiltNow) + outNow;
      for (let i = 0; i < cols; i++) {
        const s = (i / (cols - 1) - 0.5) * doc.widthM;
        // Foot of the sheet: made off along the rail, and it stays there.
        const kBot = cloth.index(i, rows - 1);
        pinClear(rig, tmpB.set(a.ox + a.rx * s, a.oy, a.oz + a.rz * s));
        cloth.pin(kBot, tmpB.x, tmpB.y, tmpB.z, dt);
        // Head of the sheet: on the pole tips, up and out over the moat.
        const kTop = cloth.index(i, 0);
        pinClear(rig, tmpB.set(
          a.ox + a.rx * s + a.nx * reach,
          a.oy + up,
          a.oz + a.rz * s + a.nz * reach,
        ));
        cloth.pin(kTop, tmpB.x, tmpB.y, tmpB.z, dt);
      }
      // The poles are the side edges: the fabric is sleeved or tied along
      // them, so the sides are straight lines between rail and pole tip and
      // the only thing free to move is the middle.
      for (const i of [0, cols - 1]) {
        const kB = cloth.index(i, rows - 1);
        const kT = cloth.index(i, 0);
        for (let j = 1; j < rows - 1; j++) {
          const f = j / (rows - 1);
          const k = cloth.index(i, j);
          cloth.lash(
            k,
            cloth.px[kT] + (cloth.px[kB] - cloth.px[kT]) * f,
            cloth.py[kT] + (cloth.py[kB] - cloth.py[kT]) * f,
            cloth.pz[kT] + (cloth.pz[kB] - cloth.pz[kT]) * f,
            LASH_SLACK_M,
          );
        }
      }
      cloth.buildTethers();
      return;
    }

    // Fade, and anything that is simply already there when the gates open.
    //
    // These are the ones that are rigged rather than deployed, and rigged
    // means the WHOLE perimeter: the DFB's glossary defines a fence flag as
    // one fixed to the railings, and it is fixed along its length, not held
    // up by one edge. Tying only the top is what left a fence banner moving a
    // metry and a half per frame in a stiff wind.
    for (let i = 0; i < cols; i++) {
      const k = cloth.index(i, 0);
      plane(i / (cols - 1), 0, 0, 0, tmpA);
      cloth.pin(k, tmpA.x, tmpA.y, tmpA.z, dt);
    }
    lashEdges(rig, 0, rows - 1, LASH_SLACK_M);
    cloth.buildTethers();
  }

  // -------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------

  function stepRig(rig: Rig, dt: number): void {
    // Emptying the stand lowers the sheet onto the seats; filling it lifts the
    // sheet onto the crowd. Both should happen while the user watches, so the
    // clearance is read every frame rather than baked in at build time.
    rig.world.clearance = clearanceFor(rig.doc.kind, crowdSupportM(crowdFill()));
    rig.world.grip = gripFor(rig.doc.kind, crowdFill());
    if (rig.playing) {
      const raw = (elapsed - rig.t0) / Math.max(0.2, rig.durationS);
      rig.prog = raw >= 1 ? 1 : raw;
      if (raw >= 1) rig.playing = false;
    }
    if (rig.doc.reveal === 'fade') rig.mat.opacity = rig.prog;
    else rig.mat.opacity = 1;

    // Fixed-step accumulator, clamped: a tab that was in the background for a
    // minute must not try to catch up sixty seconds of cloth in one frame.
    rig.accum = Math.min(rig.accum + dt, FIXED_DT * 3);
    while (rig.accum >= FIXED_DT) {
      rig.accum -= FIXED_DT;
      applyRig(rig, FIXED_DT);
      rig.cloth.step(FIXED_DT, rig.world, SUBSTEPS);
      if (!rig.cloth.healthy) {
        // Something went non-finite. Put the sheet back rather than leaving a
        // NaN to spread through the buffer and blank the whole scene.
        layoutCloth(rig);
        break;
      }
    }
    uploadCloth(rig);
    updateHardware(rig);
  }

  function uploadCloth(rig: Rig): void {
    const c = rig.cloth;
    const pos = rig.pos;
    const nrm = rig.nrm;
    for (let k = 0; k < c.count; k++) {
      const o = k * 3;
      pos[o] = c.px[k];
      pos[o + 1] = c.py[k];
      pos[o + 2] = c.pz[k];
      nrm[o] = c.nx[k];
      nrm[o + 1] = c.ny[k];
      nrm[o + 2] = c.nz[k];
    }
    rig.geo.attributes.position.needsUpdate = true;
    rig.geo.attributes.normal.needsUpdate = true;
  }

  /** Ropes, net, weight bar, poles and the roll, all read off the fabric. */
  function updateHardware(rig: Rig): void {
    const { doc, cloth, frame } = rig;
    const cols = cloth.cols;
    const rows = cloth.rows;
    const at = (i: number, j: number, v: THREE.Vector3): THREE.Vector3 => {
      const k = cloth.index(i, j);
      return v.set(cloth.px[k], cloth.py[k], cloth.pz[k]);
    };

    if (rig.ropes) {
      const arr = rig.ropes.geometry.attributes.position.array as Float32Array;
      const spanU = Math.min(0.5, doc.widthM / Math.max(1, frame.widthM) / 2);
      const anchorAt = (du: number, v: THREE.Vector3): THREE.Vector3 => {
        const q = frame.pointAt(doc.place.alongU + du, 1);
        return v.set(q.x, doc.kind === 'roof-hung' ? frame.roofY : q.y + 1.6, q.z);
      };
      setSeg(arr, 0, anchorAt(-spanU, tmpA), at(0, 0, tmpB));
      setSeg(arr, 1, anchorAt(spanU, tmpA), at(cols - 1, 0, tmpB));
      setSeg(arr, 2, anchorAt(-spanU * 0.34, tmpA), at(Math.round((cols - 1) * 0.33), 0, tmpB));
      setSeg(arr, 3, anchorAt(spanU * 0.34, tmpA), at(Math.round((cols - 1) * 0.67), 0, tmpB));
      rig.ropes.geometry.attributes.position.needsUpdate = true;
    }

    if (rig.net) {
      const arr = rig.net.geometry.attributes.position.array as Float32Array;
      const cap = arr.length / 6;
      let seg = 0;
      for (let n = 0; n < NET_U && seg < cap; n++) {
        const i = Math.round((n / (NET_U - 1)) * (cols - 1));
        for (let s = 0; s + 1 < 7 && seg < cap; s++) {
          const j0 = Math.round((s / 6) * (rows - 1));
          const j1 = Math.round(((s + 1) / 6) * (rows - 1));
          setSeg(arr, seg++, at(i, j0, tmpA), at(i, j1, tmpB));
        }
      }
      for (let n = 0; n < NET_V && seg < cap; n++) {
        const j = Math.round((n / (NET_V - 1)) * (rows - 1));
        for (let s = 0; s + 1 < 7 && seg < cap; s++) {
          const i0 = Math.round((s / 6) * (cols - 1));
          const i1 = Math.round(((s + 1) / 6) * (cols - 1));
          setSeg(arr, seg++, at(i0, j, tmpA), at(i1, j, tmpB));
        }
      }
      for (let k = seg; k < cap; k++) setSeg(arr, k, at(0, 0, tmpA), at(0, 0, tmpB));
      rig.net.geometry.attributes.position.needsUpdate = true;
    }

    if (rig.bar) aimBetween(rig.bar, at(0, rows - 1, tmpA), at(cols - 1, rows - 1, tmpB), 1);

    if (rig.poles.length === 2) {
      // Based on the rail, reaching to the pole tips — which are the banner's
      // TOP corners now that it is stood up rather than hung.
      const f0 = frame.pointAt(doc.place.alongU - doc.widthM / Math.max(1, frame.widthM) / 2, doc.place.heightV);
      const f1 = frame.pointAt(doc.place.alongU + doc.widthM / Math.max(1, frame.widthM) / 2, doc.place.heightV);
      aimBetween(rig.poles[0], tmpA.set(f0.x, f0.y, f0.z), at(0, 0, tmpB), 1);
      aimBetween(rig.poles[1], tmpA.set(f1.x, f1.y, f1.z), at(cols - 1, 0, tmpB), 1);
    }

    if (rig.roll) {
      const left = 1 - rig.prog;
      rig.roll.visible = left > 0.02;
      if (rig.roll.visible) {
        // Both rigs keep their bulk at the bottom edge: a drop's bundle is
        // the leading edge on its way down, a lift's pile is on the rail.
        const j = rows - 1;
        // The roll thins as the fabric comes off it. That is the cue nobody
        // fakes and everybody notices.
        const rad = Math.max(0.1, Math.sqrt(left) * Math.min(1.0, doc.heightM * 0.045));
        aimBetween(rig.roll, at(0, j, tmpA), at(cols - 1, j, tmpB), 1);
        rig.roll.scale.y = rad;
        rig.roll.scale.z = rad;
      }
    }

    const o = rig.outline.geometry.attributes.position.array as Float32Array;
    setSeg(o, 0, at(0, 0, tmpA), at(cols - 1, 0, tmpB));
    setSeg(o, 1, at(cols - 1, 0, tmpA), at(cols - 1, rows - 1, tmpB));
    setSeg(o, 2, at(cols - 1, rows - 1, tmpA), at(0, rows - 1, tmpB));
    setSeg(o, 3, at(0, rows - 1, tmpA), at(0, 0, tmpB));
    rig.outline.geometry.attributes.position.needsUpdate = true;
  }

  function setSeg(arr: Float32Array, i: number, a: THREE.Vector3, b: THREE.Vector3): void {
    const o = i * 6;
    if (o + 5 >= arr.length) return;
    arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
    arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
  }

  function aimBetween(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, thickness: number): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mesh.scale.set(len, thickness, thickness);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(dx / len, dy / len, dz / len),
    );
  }

  function disposeRig(r: Rig): void {
    root.remove(r.group);
    r.geo.dispose();
    r.mat.dispose();
    for (const child of [r.ropes, r.net, r.outline]) {
      if (!child) continue;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    for (const m of [r.bar, r.roll, ...r.poles]) {
      if (!m) continue;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }

  function refresh(): void {
    const live = new Set(bannerStore.list().map((b) => b.id));
    for (const [id, r] of [...rigs]) {
      if (!live.has(id)) {
        disposeRig(r);
        rigs.delete(id);
      }
    }
    for (const doc of bannerStore.list()) {
      const existing = rigs.get(doc.id);
      if (!existing) {
        rigs.set(doc.id, makeRig(doc));
        continue;
      }
      const sig = rigSignature(doc);
      if (sig !== existing.sig) {
        const prog = existing.prog;
        disposeRig(existing);
        const next = makeRig(doc);
        next.prog = prog;
        rigs.set(doc.id, next);
        continue;
      }
      // Placement changed but the rig did not: keep the fabric, move the pins.
      // Re-laying it out on every slider drag would make the banner jump.
      existing.doc = doc;
      existing.durationS = revealSeconds(doc);
      existing.world.wind = makeWind(doc, 0, 1, existing.frame);
      const key = textureKey(doc);
      if (key !== existing.texKey) {
        existing.mat.map = texture(doc);
        existing.mat.needsUpdate = true;
        existing.texKey = key;
      }
    }
    applySelection();
  }

  function applySelection(): void {
    for (const [id, r] of rigs) r.outline.visible = id === selectedId;
  }

  const unsub = bannerStore.onChange(refresh);
  const unsubImg = onBannerImageReady(() => {
    for (const [, t] of texCache) t.dispose();
    texCache.clear();
    for (const r of rigs.values()) {
      r.mat.map = texture(r.doc);
      r.mat.needsUpdate = true;
      r.texKey = textureKey(r.doc);
    }
  });
  refresh();

  return {
    object: root,
    refresh,
    update(now, dt) {
      elapsed = now;
      for (const r of rigs.values()) {
        r.group.visible = r.doc.visible !== false;
        if (!r.group.visible) continue;
        stepRig(r, Math.min(0.05, Math.max(0, dt)));
      }
    },
    play(id) {
      for (const [bid, r] of rigs) {
        if (id && bid !== id) continue;
        r.prog = 0;
        r.playing = true;
        r.t0 = elapsed;
        // Put the fabric back where the rig starts, or the first frame of the
        // reveal is the sheet teleporting home from wherever it was.
        layoutCloth(r);
        applyRig(r, 0);
      }
    },
    setProgress(id, p) {
      const r = rigs.get(id);
      if (!r) return;
      r.playing = false;
      r.prog = Math.max(0, Math.min(1, p));
      applyRig(r, 0);
    },
    settle(seconds) {
      const steps = Math.max(1, Math.round(seconds / FIXED_DT));
      for (const r of rigs.values()) {
        if (r.doc.visible === false) continue;
        for (let s = 0; s < steps; s++) {
          elapsed += FIXED_DT;
          applyRig(r, FIXED_DT);
          r.cloth.step(FIXED_DT, r.world, SUBSTEPS);
          if (!r.cloth.healthy) {
            layoutCloth(r);
            break;
          }
        }
        uploadCloth(r);
        updateHardware(r);
      }
    },
    pick(raycaster) {
      const hits = raycaster.intersectObjects([...rigs.values()].map((r) => r.mesh), false);
      for (const h of hits) {
        const id = (h.object as THREE.Mesh).userData.bannerId as string | undefined;
        if (id) return id;
      }
      return null;
    },
    select(id) {
      selectedId = id;
      applySelection();
    },
    census() {
      let ropes = 0;
      let nets = 0;
      let bars = 0;
      let poles = 0;
      let particles = 0;
      for (const r of rigs.values()) {
        if (r.ropes) ropes++;
        if (r.net) nets++;
        if (r.bar) bars++;
        poles += r.poles.length;
        particles += r.cloth.count;
      }
      return { banners: rigs.size, ropes, nets, bars, poles, particles };
    },
    worstPenetration() {
      let worst = 0;
      for (const r of rigs.values()) {
        if (r.doc.visible === false) continue;
        // Against the structure, three centimetres proud of it — the thickness
        // of the fabric itself. Deliberately NOT against the rig's own
        // clearance: a sheet resting on a crowd is held nearly two metres off
        // the treads, and measuring it against that would report every gust as
        // a banner in the concrete.
        const d = r.cloth.measurePenetration(r.world, SOLID_CLEARANCE);
        if (d > worst) worst = d;
      }
      return worst;
    },
    bounds(id) {
      const r = rigs.get(id);
      if (!r) return null;
      const c = r.cloth;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < c.count; k++) {
        if (c.px[k] < x0) x0 = c.px[k];
        if (c.px[k] > x1) x1 = c.px[k];
        if (c.py[k] < y0) y0 = c.py[k];
        if (c.py[k] > y1) y1 = c.py[k];
        if (c.pz[k] < z0) z0 = c.pz[k];
        if (c.pz[k] > z1) z1 = c.pz[k];
      }
      return isFinite(x0) ? { min: [x0, y0, z0] as [number, number, number], max: [x1, y1, z1] as [number, number, number] } : null;
    },
    worstSag() {
      let worst = 0;
      for (const r of rigs.values()) {
        if (r.doc.visible === false) continue;
        const d = r.cloth.measurePenetration(r.world);
        if (d > worst) worst = d;
      }
      return worst;
    },
    dispose() {
      unsub();
      unsubImg();
      for (const r of rigs.values()) disposeRig(r);
      rigs.clear();
      for (const [, t] of texCache) t.dispose();
      texCache.clear();
      fieldCache.clear();
    },
  };
}
