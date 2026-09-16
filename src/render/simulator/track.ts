import * as THREE from 'three';
import type { StadiumTemplate, TrackSpec } from '../../core/types';

/**
 * A 400 m athletics track, to the World Athletics standard.
 *
 * Every number here is from the World Athletics "400 Metre Standard Track,
 * Marking Plan" rather than eyeballed, because a track is one of the few things
 * in a stadium that is specified to the millimetre and readers know what it
 * looks like. Getting the lane count or the bend radius wrong is the kind of
 * error that makes the whole render feel fake.
 *
 * The shape is a discorectangle: two straights joined by two semicircles, which
 * is why the maths below walks a perimeter rather than a superellipse like the
 * rest of the bowl. A stadium's seating curve and its track are genuinely
 * different shapes, and pretending otherwise puts the lanes through the stands.
 */

/** Construction (kerb) radius, including the raised kerb on the inside. */
const KERB_R = 36.5;
/** Centres of the two bend circles, either side of the middle. */
const BEND_CX = 42.195; // half of the 84.39 m straight
const STRAIGHT = 84.39;
/** Lane width, including the 0.05 m line on its outside. */
const LANE_W = 1.22;
/** Every marking on a track is this wide. */
const LINE_W = 0.05;

export const TRACK_DEFAULTS = {
  lanes: 8,
  /** Brick red. World Athletics specifies no surface colour; this is the common one. */
  surface: 0xb5472f,
  markings: true,
};

/** Half-extents of the outer edge of the marked oval, for a given lane count. */
export function trackExtent(lanes: number): { halfLength: number; halfWidth: number } {
  const outer = KERB_R + lanes * LANE_W;
  return { halfLength: BEND_CX + outer, halfWidth: outer };
}

/**
 * Will a track of this size fit inside the bowl, with the seating clear of it?
 *
 * The check is the interesting part: it means a template cannot claim a track it
 * has no room for. Amman's plan is 101 x 71 m and an 8-lane track needs
 * 88.5 x 46.3, so it fits; Al-Awwal's 64 x 50 cannot hold one at any lane count,
 * which is correct — it is a football ground.
 */
export function trackFits(template: StadiumTemplate, lanes: number): boolean {
  const { halfLength, halfWidth } = trackExtent(lanes);
  return template.plan.a >= halfLength + 1 && template.plan.b >= halfWidth + 1;
}

/**
 * A point on the discorectangle of "radius" r, at perimeter fraction u.
 *
 * Walked by ARC LENGTH so lane lines stay parallel: parameterising by angle
 * would bunch the samples on the straights and stretch them round the bends,
 * and the lines would visibly wander relative to each other.
 */
function pathPoint(r: number, u: number): [number, number] {
  const arc = Math.PI * r;
  const total = 2 * STRAIGHT + 2 * arc;
  let d = ((u % 1) + 1) % 1 * total;
  // Start at the middle of the "top" straight heading +x, so u=0 is the finish.
  if (d < STRAIGHT / 2) return [d, r];
  d -= STRAIGHT / 2;
  if (d < arc) {
    const a = Math.PI / 2 - (d / arc) * Math.PI;
    return [BEND_CX + Math.cos(a) * r, Math.sin(a) * r];
  }
  d -= arc;
  if (d < STRAIGHT) return [BEND_CX - d, -r];
  d -= STRAIGHT;
  if (d < arc) {
    const a = -Math.PI / 2 - (d / arc) * Math.PI;
    return [-BEND_CX + Math.cos(a) * r, Math.sin(a) * r];
  }
  d -= arc;
  return [-BEND_CX + d, r];
}

/** A closed ring of points at radius r, sampled evenly by arc length. */
function ring(r: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push(pathPoint(r, i / n));
  return out;
}

/** Fill between two rings as a flat strip at height y. */
function strip(inner: Array<[number, number]>, outer: Array<[number, number]>, y: number): THREE.BufferGeometry {
  const n = inner.length;
  const pos = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = inner[i][0]; pos[i * 3 + 1] = y; pos[i * 3 + 2] = inner[i][1];
    pos[(n + i) * 3] = outer[i][0]; pos[(n + i) * 3 + 1] = y; pos[(n + i) * 3 + 2] = outer[i][1];
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, n + i, n + j, i, n + j, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface TrackBuild {
  readonly object: THREE.Group;
  readonly lanes: number;
  /** Outer half-extents, so anything else placed nearby can clear it. */
  readonly extent: { halfLength: number; halfWidth: number };
  dispose(): void;
}

/**
 * Build the track, or return an empty group when the template does not have one
 * or has no room for it.
 */
export function buildTrack(template: StadiumTemplate, shadows: boolean, opts: { unlit?: boolean } = {}): TrackBuild {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  const spec: TrackSpec = template.track ?? {};
  const lanes = Math.max(4, Math.min(9, Math.round(spec.lanes ?? TRACK_DEFAULTS.lanes)));
  const extent = trackExtent(lanes);
  const empty: TrackBuild = { object: group, lanes: 0, extent, dispose(): void {} };
  if (!template.track || !trackFits(template, lanes)) return empty;

  const SAMPLES = 480; // enough that the bends read as curves, not polygons
  const surfaceY = 0.02; // just above the pitch plane, to avoid z-fighting
  const lineY = 0.03;

  // Lit by default, for the simulator. The editor's quick preview has no lights
  // at all — every material in it is unlit — so a MeshStandardMaterial there
  // renders pure black, which is how the track first appeared as a void where
  // the surface should be.
  const surfaceMat = opts.unlit
    ? new THREE.MeshBasicMaterial({ color: spec.surface ?? TRACK_DEFAULTS.surface })
    : new THREE.MeshStandardMaterial({
      color: spec.surface ?? TRACK_DEFAULTS.surface,
      // Rubber granulate: matte, no specular to speak of.
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.7,
    });
  trash.push(surfaceMat);

  const surface = strip(ring(KERB_R, SAMPLES), ring(KERB_R + lanes * LANE_W, SAMPLES), surfaceY);
  const sMesh = new THREE.Mesh(surface, surfaceMat);
  sMesh.receiveShadow = shadows;
  group.add(sMesh);
  trash.push(surface);

  if (spec.markings ?? TRACK_DEFAULTS.markings) {
    // White for a red track; World Athletics notes that a BLUE track uses red
    // markings instead, so follow the surface rather than assuming white.
    const blueish = ((spec.surface ?? TRACK_DEFAULTS.surface) & 0xff) > (((spec.surface ?? TRACK_DEFAULTS.surface) >> 16) & 0xff);
    const lineMat = new THREE.MeshBasicMaterial({ color: blueish ? 0xc4372c : 0xf2f2ee });
    trash.push(lineMat);

    // The kerb and the lane boundaries. These are 90% of what makes a track
    // read as a track from any distance — get their count and spacing right and
    // the rest is detail.
    for (let i = 0; i <= lanes; i++) {
      const r = KERB_R + i * LANE_W;
      const g = strip(ring(r - LINE_W / 2, SAMPLES), ring(r + LINE_W / 2, SAMPLES), lineY);
      group.add(new THREE.Mesh(g, lineMat));
      trash.push(g);
    }

    // The finish line: the only marking that crosses all eight lanes at once,
    // and the one that tells you which way the track runs.
    const fin = new THREE.PlaneGeometry(LINE_W * 3, lanes * LANE_W);
    const fMesh = new THREE.Mesh(fin, lineMat);
    fMesh.rotation.x = -Math.PI / 2;
    fMesh.position.set(0, lineY + 0.001, KERB_R + (lanes * LANE_W) / 2);
    group.add(fMesh);
    trash.push(fin);
  }

  return {
    object: group,
    lanes,
    extent,
    dispose(): void {
      for (const t of trash) t.dispose();
    },
  };
}
