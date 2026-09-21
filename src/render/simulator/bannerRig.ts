import * as THREE from 'three';
import type { BannerDoc, BannerStore } from '../../core/banner';
import { KIND_PROFILE, revealEase } from '../../core/banner';
import { bannerToCanvas, onBannerImageReady } from '../bannerRender';
import type { StandFrame } from './standFrame';

/**
 * Banners in the bowl — the fabric, the rig that holds it, and the reveal.
 *
 * The old asset layer hung a banner as a flat textured plane. A plane is
 * exactly wrong for this: what makes a banner read as a real object in a
 * stadium is not the picture on it, it is the ROPES going up to the roof, the
 * net behind it holding seventy grams per square metre of polyester flat over
 * forty metres, and the weighted bar in the bottom hem that makes it fall
 * straight. So all of that is geometry here, and the fabric is a surface that
 * sags between the points the rig actually holds.
 *
 * Every banner's shape is one parametric function of (u, v) — across the width
 * and down the height — evaluated afresh each frame. The reveal is a single
 * 0..1 progress fed into that same function, which is what lets a reveal be
 * scrubbed, previewed, put on the choreography timeline and screenshotted at
 * any moment rather than being an animation that can only be played.
 */

export interface BannerRigLayer {
  readonly object: THREE.Group;
  /** Rebuild meshes and textures after the banner data changes. */
  refresh(): void;
  /** Per-frame: cloth, wind, and any reveal in flight. */
  update(elapsed: number): void;
  /** Start a banner's own reveal. Omit the id to reveal every banner. */
  play(id?: string): void;
  /** Park a banner at a fixed point in its reveal (0 hidden, 1 shown). */
  setProgress(id: string, p: number): void;
  /** Ray-pick a banner. Returns its id, or null. */
  pick(raycaster: THREE.Raycaster): string | null;
  /** Outline one banner as the selected one. */
  select(id: string | null): void;
  /** What is actually in the scene, for a test that a screenshot cannot make. */
  census(): { banners: number; ropes: number; nets: number; bars: number; poles: number };
  dispose(): void;
}

/** How finely the fabric is subdivided — enough to sag, not enough to cost. */
function segmentsFor(doc: BannerDoc): { sx: number; sy: number } {
  return {
    sx: Math.max(10, Math.min(56, Math.round(doc.widthM / 1.2))),
    sy: Math.max(8, Math.min(40, Math.round(doc.heightM / 1.2))),
  };
}

/** Everything about a banner that changes what its texture looks like. */
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

interface Rig {
  doc: BannerDoc;
  group: THREE.Group;
  mesh: THREE.Mesh;
  geo: THREE.PlaneGeometry;
  mat: THREE.MeshBasicMaterial;
  texKey: string;
  sx: number;
  sy: number;
  ropes: THREE.LineSegments | null;
  net: THREE.LineSegments | null;
  bar: THREE.Mesh | null;
  poles: THREE.Mesh[] ;
  roll: THREE.Mesh | null;
  outline: THREE.LineSegments;
  /** Reveal progress 0..1, and when it started (seconds). */
  prog: number;
  playing: boolean;
  t0: number;
}

const ROPE_COLOR = 0xd8d2c4;
const NET_COLOR = 0x9aa2ad;

export function buildBannerRigs(
  bannerStore: BannerStore,
  frameFor: (stand: 0 | 1 | 2 | 3) => StandFrame,
): BannerRigLayer {
  const root = new THREE.Group();
  root.name = 'banners';
  const rigs = new Map<string, Rig>();
  const texCache = new Map<string, THREE.Texture>();
  let elapsed = 0;
  let selectedId: string | null = null;

  // ---- scratch vectors, so a frame allocates nothing -----------------------
  const right = new THREE.Vector3();
  const out = new THREE.Vector3();
  const down = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const origin = new THREE.Vector3();

  function texture(doc: BannerDoc): THREE.Texture {
    const key = textureKey(doc);
    const hit = texCache.get(key);
    if (hit) return hit;
    const canvas = bannerToCanvas(doc, { maxEdge: 1024, perforate: true });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    texCache.set(key, tex);
    // The cache is keyed on content, so an edit orphans the previous texture.
    // Keeping more than a handful of 1024² canvases per banner is how a long
    // session runs a phone out of GPU memory.
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
  // The fabric's shape
  // -------------------------------------------------------------------------

  /**
   * Set up the banner's frame of reference for this instant, and return a
   * function giving the world position of any point on the fabric.
   *
   * There are three ways a banner can sit in a stadium, and which one it uses
   * is decided by its type rather than by a setting.
   *
   * **On the terracing.** Most of them. A block flag, a rope lift, a stand
   * cover, a 3D tifo — all of these live against the seating, and the seating
   * is RAKED. The first version of this hung them straight down in world
   * space from their anchor, which buried the bottom two thirds of every one
   * of them inside the seats within a couple of metres: correct arithmetic,
   * wrong physics. They now follow the stand's own surface and stand off it
   * along its normal, which is also what makes a banner on a curved end stand
   * curve with the stand instead of cutting a chord through it.
   *
   * **Free in the air.** A roof-hung banner and a fence flag hang from a
   * fixed edge and are genuinely vertical, so they get a plane.
   *
   * **Flat on the grass.** A pitch banner, laid out on the turf.
   */
  function surfaceFor(doc: BannerDoc, prog: number, t: number): (u: number, v: number, target: THREE.Vector3) => THREE.Vector3 {
    const frame = frameFor(doc.place.stand);
    const W = doc.widthM;
    const H = doc.heightM;
    const mode = doc.reveal;

    // Wind: a mesh banner passes air, so it moves noticeably less. This is the
    // visible half of the argument the fabric warning makes in words.
    const windAmp = doc.wind * Math.min(2.2, W * 0.035) * (doc.material === 'mesh' ? 0.45 : 1);
    // Sag between the rigging points. A net carries the load in both axes, so a
    // net-backed banner is nearly flat; one hanging from its own hem is not.
    const sagAmp = Math.min(2.6, W * (doc.netBacked ? 0.006 : 0.022));
    const flutter = doc.weightBar ? 0.15 : 1;

    /** How much of the sheet has left its roll, its bundle or the front row. */
    const unrolled = (v: number): number => {
      if (mode === 'drop') return Math.min(v, prog);
      if (mode === 'lift' || mode === 'pass') return Math.max(v, 1 - prog);
      return v;
    };

    // ---- flat on the pitch -------------------------------------------------
    if (doc.kind === 'pitch') {
      const a = frame.pointAt(doc.place.alongU, 0);
      // Laid out on the grass in front of the stand it belongs to, pushed in
      // from the touchline by `outM`.
      const cx = a.x + a.ox * (12 + doc.place.outM);
      const cz = a.z + a.oz * (12 + doc.place.outM);
      return (u, v, target) => {
        const vv = unrolled(v);
        return target.set(
          cx + a.rx * ((u - 0.5) * W) + a.ox * ((vv - 0.5) * H),
          0.06 + Math.sin(u * 5 + t * 1.2) * windAmp * 0.05,
          cz + a.rz * ((u - 0.5) * W) + a.oz * ((vv - 0.5) * H),
        );
      };
    }

    // ---- free in the air: roof-hung, fence, and the 3D pole-out ------------
    // A 3D tifo is here rather than on the terracing precisely because its
    // whole point is NOT lying on the stand: it is held out on poles at an
    // angle of its own. Measuring that angle from the rake instead of from
    // vertical laid it almost flat, since the rake is already thirty degrees.
    if (doc.kind === 'roof-hung' || doc.kind === 'fence' || doc.kind === 'pole-out') {
      const a = frame.pointAt(doc.place.alongU, doc.kind === 'fence' ? 0 : doc.place.heightV);
      const yaw = (doc.place.yawDeg * Math.PI) / 180;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      right.set(a.rx * cy - a.rz * sy, 0, a.rx * sy + a.rz * cy).normalize();
      out.set(a.ox * cy - a.oz * sy, 0, a.ox * sy + a.oz * cy).normalize();
      // Unfolding swings the sheet out from flat against the stand to its
      // working angle, and pushes it off the face as the poles extend.
      const tiltDeg = mode === 'unfold' ? doc.place.tiltDeg * prog : doc.place.tiltDeg;
      const outM = mode === 'unfold' ? doc.place.outM * (0.12 + 0.88 * prog) : doc.place.outM;
      const ct = Math.cos((tiltDeg * Math.PI) / 180);
      const st = Math.sin((tiltDeg * Math.PI) / 180);
      down.set(out.x * st, -ct, out.z * st).normalize();
      nrm.copy(right).cross(down).normalize();
      // A hoisted banner arrives from the roof, overshoots and settles — which
      // is what a mass on a rope does, and is why `revealEase('hoist')` is
      // allowed to pass 1 on the way.
      const topY = doc.kind === 'roof-hung' ? a.y : a.y - 0.2;
      const dropIn = mode === 'hoist' ? (frame.roofY - topY) * (1 - prog) : 0;
      origin.set(a.x + out.x * outM, topY + dropIn, a.z + out.z * outM);
      return (u, v, target) => {
        const vv = unrolled(v);
        const sag = sagAmp * 4 * u * (1 - u);
        const bil = Math.sin(u * 6.3 + t * 2.1) * Math.sin(vv * 3.1 + t * 0.8) * windAmp * vv;
        const edge = Math.sin(u * 4.7 - t * 1.6) * windAmp * 0.5 * flutter * vv * vv;
        return target.set(
          origin.x + right.x * ((u - 0.5) * W) + down.x * (vv * H + sag) + nrm.x * (bil + edge),
          origin.y + right.y * ((u - 0.5) * W) + down.y * (vv * H + sag) + nrm.y * (bil + edge),
          origin.z + right.z * ((u - 0.5) * W) + down.z * (vv * H + sag) + nrm.z * (bil + edge),
        );
      };
    }

    // ---- against the terracing --------------------------------------------
    const spanU = Math.min(1.4, W / Math.max(1, frame.widthM));
    const spanV = Math.min(1.4, H / Math.max(1, frame.slopeM));
    const topV = doc.place.heightV;
    const baseOut = doc.place.outM;

    return (u, v, target) => {
      const vv = unrolled(v);
      const su = doc.place.alongU + (u - 0.5) * spanU;
      const sv = topV - vv * spanV;
      const p = frame.pointAt(su, sv);
      const nAt = frame.normalAt(su, sv);
      const sag = sagAmp * 4 * u * (1 - u) * (doc.kind === 'stand-cover' ? 0.2 : 1);
      const bil = Math.sin(u * 6.3 + t * 2.1) * Math.sin(vv * 3.1 + t * 0.8) * windAmp * (0.3 + 0.7 * vv);
      const edge = Math.sin(u * 4.7 - t * 1.6) * windAmp * 0.4 * flutter * vv * vv;
      const off = baseOut + bil + edge;
      return target.set(
        p.x + nAt.nx * off,
        p.y + nAt.ny * off - sag * 0.4,
        p.z + nAt.nz * off,
      );
    };
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  function makeRig(doc: BannerDoc): Rig {
    const { sx, sy } = segmentsFor(doc);
    const geo = new THREE.PlaneGeometry(1, 1, sx, sy);
    const tex = texture(doc);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.DoubleSide,
      transparent: true,
      // A perforated banner has real holes; without the alpha test they would
      // render as a uniform haze, which is the one thing mesh is not.
      alphaTest: doc.material === 'mesh' ? 0.4 : 0.02,
      depthWrite: doc.material !== 'mesh',
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // vertices are rewritten every frame
    mesh.userData.bannerId = doc.id;
    mesh.renderOrder = 4;

    const group = new THREE.Group();
    group.name = `banner:${doc.id}`;
    group.add(mesh);

    const profile = KIND_PROFILE[doc.kind];
    const ropes = profile.roped ? lineSet(ROPE_COLOR, 4 * 2, 1) : null;
    if (ropes) group.add(ropes);
    const net = doc.netBacked ? lineSet(NET_COLOR, (NET_U + NET_V) * 2 * 24, 0.55) : null;
    if (net) group.add(net);

    let bar: THREE.Mesh | null = null;
    if (doc.weightBar) {
      const g = new THREE.CylinderGeometry(0.16, 0.16, 1, 7);
      g.rotateZ(Math.PI / 2); // lie along local X, so it can be aimed with lookAt
      bar = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.7, metalness: 0.3 }));
      bar.frustumCulled = false;
      group.add(bar);
    }

    const poles: THREE.Mesh[] = [];
    if (doc.kind === 'pole-out') {
      for (let i = 0; i < 2; i++) {
        const g = new THREE.CylinderGeometry(0.09, 0.09, 1, 6);
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.42, metalness: 0.55 }));
        m.frustumCulled = false;
        poles.push(m);
        group.add(m);
      }
    }

    let roll: THREE.Mesh | null = null;
    if (doc.reveal === 'drop' || doc.reveal === 'lift') {
      const g = new THREE.CylinderGeometry(1, 1, 1, 10);
      g.rotateZ(Math.PI / 2);
      roll = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.9 }));
      roll.frustumCulled = false;
      roll.visible = false;
      group.add(roll);
    }

    const outline = lineSet(0xff5db1, 4 * 2, 1);
    outline.visible = false;
    outline.renderOrder = 6;
    (outline.material as THREE.LineBasicMaterial).depthTest = false;
    group.add(outline);

    root.add(group);
    return {
      doc, group, mesh, geo, mat, texKey: textureKey(doc), sx, sy,
      ropes, net, bar, poles, roll, outline,
      prog: doc.reveal === 'fade' ? 1 : 1, playing: false, t0: 0,
    };
  }

  const NET_U = 9;
  const NET_V = 6;

  function lineSet(color: number, segments: number, opacity: number): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 3), 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const ls = new THREE.LineSegments(g, m);
    ls.frustumCulled = false;
    return ls;
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
    if (r.bar) {
      r.bar.geometry.dispose();
      (r.bar.material as THREE.Material).dispose();
    }
    for (const p of r.poles) {
      p.geometry.dispose();
      (p.material as THREE.Material).dispose();
    }
    if (r.roll) {
      r.roll.geometry.dispose();
      (r.roll.material as THREE.Material).dispose();
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
      existing.doc = doc;
      // Anything that changes the MESH — the subdivision, the rig hardware, the
      // alpha test — is a rebuild; anything that only changes the picture is a
      // texture swap. Rebuilding on every slider drag would stutter.
      const { sx, sy } = segmentsFor(doc);
      const rigChanged =
        sx !== existing.sx || sy !== existing.sy ||
        (!!existing.net) !== doc.netBacked ||
        (!!existing.bar) !== doc.weightBar ||
        (existing.poles.length > 0) !== (doc.kind === 'pole-out') ||
        (!!existing.ropes) !== KIND_PROFILE[doc.kind].roped ||
        (existing.mat.alphaTest > 0.2) !== (doc.material === 'mesh');
      if (rigChanged) {
        const prog = existing.prog;
        disposeRig(existing);
        const next = makeRig(doc);
        next.prog = prog;
        rigs.set(doc.id, next);
        continue;
      }
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

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  function update(now: number): void {
    elapsed = now;
    const pt = new THREE.Vector3();
    for (const r of rigs.values()) {
      const doc = r.doc;
      r.group.visible = doc.visible !== false;
      if (!r.group.visible) continue;

      if (r.playing) {
        const dur = Math.max(0.2, doc.revealMs / 1000);
        const raw = (now - r.t0) / dur;
        r.prog = raw >= 1 ? 1 : raw;
        if (raw >= 1) r.playing = false;
      }
      const eased = r.playing || r.prog < 1 ? revealEase(doc.reveal, r.prog) : 1;

      if (doc.reveal === 'fade') r.mat.opacity = eased;
      else r.mat.opacity = 1;

      const at = surfaceFor(doc, eased, now);
      const pos = r.geo.attributes.position;
      const arr = pos.array as Float32Array;
      const nx = r.sx + 1;
      const ny = r.sy + 1;
      for (let j = 0; j < ny; j++) {
        const v = j / (ny - 1);
        for (let i = 0; i < nx; i++) {
          const u = i / (nx - 1);
          at(u, v, pt);
          const o = (j * nx + i) * 3;
          arr[o] = pt.x;
          arr[o + 1] = pt.y;
          arr[o + 2] = pt.z;
        }
      }
      pos.needsUpdate = true;
      r.geo.computeVertexNormals();
      r.geo.computeBoundingSphere();

      updateHardware(r, at, eased, pt);
    }
  }

  /** Ropes, net, weight bar, poles, roll, outline — all driven by the fabric. */
  function updateHardware(
    r: Rig,
    at: (u: number, v: number, t: THREE.Vector3) => THREE.Vector3,
    prog: number,
    scratch: THREE.Vector3,
  ): void {
    const doc = r.doc;
    const frame = frameFor(doc.place.stand);

    // Corners of the sheet as it is right now.
    const tl = at(0, 0, new THREE.Vector3());
    const tr = at(1, 0, new THREE.Vector3());
    const bl = at(0, 1, new THREE.Vector3());
    const br = at(1, 1, new THREE.Vector3());

    if (r.ropes) {
      const a = r.ropes.geometry.attributes.position.array as Float32Array;
      // Where the lines are made off depends on the type: the roof for a
      // roof-hung banner, the back of the stand for a haul line, the stand's
      // own face for the poles of a 3D tifo.
      const spanU = Math.min(0.5, doc.widthM / Math.max(1, frame.widthM) / 2);
      const anchorAt = (du: number): THREE.Vector3 => {
        const p = frame.pointAt(doc.place.alongU + du, doc.kind === 'roof-hung' ? 1 : 1);
        const y = doc.kind === 'roof-hung' ? frame.roofY : p.y + 1.5;
        return new THREE.Vector3(p.x, y, p.z);
      };
      const a0 = anchorAt(-spanU);
      const a1 = anchorAt(spanU);
      setSeg(a, 0, a0, tl);
      setSeg(a, 1, a1, tr);
      // Two more, pulled toward the middle, so the rig reads as a rig and not
      // as two stray threads.
      const m0 = anchorAt(-spanU * 0.35);
      const m1 = anchorAt(spanU * 0.35);
      at(0.33, 0, scratch);
      setSeg(a, 2, m0, scratch);
      at(0.67, 0, scratch);
      setSeg(a, 3, m1, scratch);
      r.ropes.geometry.attributes.position.needsUpdate = true;
    }

    if (r.net) {
      // The net follows the fabric exactly — it is what the fabric is laced to
      // — so it is walked with the same surface function rather than being a
      // flat grid hung behind. Each line is drawn in short segments so it
      // curves with the sheet instead of cutting through it.
      const a = r.net.geometry.attributes.position.array as Float32Array;
      const cap = a.length / 6;
      const A = new THREE.Vector3();
      const B = new THREE.Vector3();
      let seg = 0;
      for (let i = 0; i < NET_U && seg < cap; i++) {
        const u = i / (NET_U - 1);
        for (let k = 0; k < 12 && seg < cap; k++) {
          setSeg(a, seg++, at(u, k / 12, A), at(u, (k + 1) / 12, B));
        }
      }
      for (let j = 0; j < NET_V && seg < cap; j++) {
        const v = j / (NET_V - 1);
        for (let k = 0; k < 12 && seg < cap; k++) {
          setSeg(a, seg++, at(k / 12, v, A), at((k + 1) / 12, v, B));
        }
      }
      for (let k = seg; k < cap; k++) setSeg(a, k, tl, tl); // collapse the rest
      r.net.geometry.attributes.position.needsUpdate = true;
    }

    if (r.bar) {
      aimBetween(r.bar, bl, br, 1);
    }

    if (r.poles.length === 2) {
      const f0 = frame.pointAt(doc.place.alongU - doc.widthM / Math.max(1, frame.widthM) / 2, doc.place.heightV);
      const f1 = frame.pointAt(doc.place.alongU + doc.widthM / Math.max(1, frame.widthM) / 2, doc.place.heightV);
      aimBetween(r.poles[0], new THREE.Vector3(f0.x, f0.y, f0.z), tl, 1);
      aimBetween(r.poles[1], new THREE.Vector3(f1.x, f1.y, f1.z), tr, 1);
    }

    if (r.roll) {
      const rolled = 1 - prog;
      r.roll.visible = rolled > 0.02;
      if (r.roll.visible) {
        const e0 = doc.reveal === 'drop' ? at(0, 1, new THREE.Vector3()) : at(0, 0, new THREE.Vector3());
        const e1 = doc.reveal === 'drop' ? at(1, 1, new THREE.Vector3()) : at(1, 0, new THREE.Vector3());
        // The roll is fat at the start and thin at the end: it is the fabric
        // that has not come off it yet.
        const rad = Math.max(0.12, Math.sqrt(rolled) * Math.min(1.1, doc.heightM * 0.05));
        aimBetween(r.roll, e0, e1, 1);
        r.roll.scale.y = rad;
        r.roll.scale.z = rad;
      }
    }

    const o = r.outline.geometry.attributes.position.array as Float32Array;
    setSeg(o, 0, tl, tr);
    setSeg(o, 1, tr, br);
    setSeg(o, 2, br, bl);
    setSeg(o, 3, bl, tl);
    r.outline.geometry.attributes.position.needsUpdate = true;
  }

  function setSeg(arr: Float32Array, i: number, a: THREE.Vector3, b: THREE.Vector3): void {
    const o = i * 6;
    if (o + 5 >= arr.length) return;
    arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
    arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
  }

  /** Stretch a unit-long mesh (lying along local X) between two points. */
  function aimBetween(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, thickness: number): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mesh.scale.set(len, thickness, thickness);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(dx / len, dy / len, dz / len),
    );
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const unsub = bannerStore.onChange(refresh);
  /**
   * A photograph on a banner decodes asynchronously.
   *
   * The texture is drawn synchronously — it has to be, a frame cannot await —
   * so a bitmap that has not finished decoding is simply skipped. Without
   * this, a banner carrying an imported photo would hang in the bowl with a
   * hole where the photo is, permanently, because nothing would ever ask for
   * the texture again.
   */
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
    update,
    play(id) {
      for (const [bid, r] of rigs) {
        if (id && bid !== id) continue;
        r.prog = 0;
        r.playing = true;
        r.t0 = elapsed;
      }
    },
    setProgress(id, p) {
      const r = rigs.get(id);
      if (!r) return;
      r.playing = false;
      r.prog = Math.max(0, Math.min(1, p));
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
      for (const r of rigs.values()) {
        if (r.ropes) ropes++;
        if (r.net) nets++;
        if (r.bar) bars++;
        poles += r.poles.length;
      }
      return { banners: rigs.size, ropes, nets, bars, poles };
    },
    dispose() {
      unsub();
      unsubImg();
      for (const r of rigs.values()) disposeRig(r);
      rigs.clear();
      for (const [, t] of texCache) t.dispose();
      texCache.clear();
    },
  };
}
