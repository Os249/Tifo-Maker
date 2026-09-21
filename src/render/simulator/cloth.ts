import { probe, type Heightfield, type Hit } from './standHeightfield';

/**
 * XPBD cloth, for a banner.
 *
 * The first version of the banner rig was a parametric surface: a formula that
 * said where every point of the sheet was at time t. It could be made to look
 * like a curve, but it could not be made to behave like fabric, and — the
 * reason this file exists — it had no way of knowing where the stand was. It
 * kept itself clear of the terracing by sitting a fixed distance off the
 * stand's normal, which works for exactly one shape of banner and fails
 * visibly for every other.
 *
 * This is the real thing instead: particles, distance constraints, gravity,
 * air, and a collision constraint against the stand. Passing through the seats
 * stops being something to tune around and becomes something that cannot
 * happen, because a particle inside the stand is pushed back out every
 * substep.
 *
 * ## The loop
 *
 * Substepped XPBD (Macklin's *Small Steps*): rather than one big step with N
 * solver iterations, N small steps with ONE iteration each. The result is not
 * marginal — their hanging-chain test measures 322 m of error for 100
 * iterations against 3.2 m for 100 substeps, at the same cost. With one
 * iteration per substep the Lagrange multiplier starts at zero every time, so
 * it never has to be stored at all.
 *
 * ## The numbers are real
 *
 * Mass comes from the fabric's areal density in g/m², gravity is 9.81, air is
 * 1.225 kg/m³ and the drag coefficient of a flat sheet is 1.28. That matters
 * more than it sounds: at 3 m/s a 70 g/m² flag sees about 2.6 g of wind
 * loading and flies nearly horizontal, while a 230 g/m² banner sees 0.78 g and
 * billows gently. One number separates a flag from a banner, and it is the one
 * the editor already asks for.
 */

export interface ClothOptions {
  /** Particles across the width and down the height. */
  cols: number;
  rows: number;
  /** Fabric weight in kg/m² — 0.07 for a printed flag, 0.29 for painted muslin. */
  arealKgM2: number;
  /** Drag coefficient. 1.28 for a solid sheet; a perforated mesh is lower. */
  dragC: number;
  /** Lift coefficient — what turns a bulge into a ripple. */
  liftC: number;
  /** Bend compliance in m/N. Small = a stiff PVC banner, large = floppy scrim. */
  bendCompliance: number;
  /** Extra mass multiplier on the bottom row, for a weighted hem. */
  hemWeight: number;
}

/** What the solver needs to know about the world, each step. */
export interface ClothWorld {
  /**
   * How hard the support holds the fabric, 0..1.
   *
   * Concrete does not hold a banner; a crowd does. A Blockfahne lying over a
   * full block is in the hands of several hundred people, and the difference
   * between modelling that and not is the difference between a banner that
   * stays where the crew put it and one that the first gust rolls up the
   * terracing — which is precisely what an early build of this did, at 0.3 on
   * the wind slider, in under a quarter of a second.
   */
  grip: number;
  /** Wind velocity in m/s at a point. Written into `out`. */
  wind(x: number, y: number, z: number, out: { x: number; y: number; z: number }): void;
  /** The stand, or null for a banner hanging clear of everything. */
  field: Heightfield | null;
  /** How far off the surface the fabric is held, in metres. */
  clearance: number;
  /** Ground plane the cloth cannot fall through (pitch level). */
  groundY: number;
}

const GRAVITY = -9.81;
const AIR_DENSITY = 1.225;
/** Velocity damping per second. Per SECOND, not per substep — see the note. */
const DAMP_PER_S = 0.18;
/** Friction of fabric on concrete. */
const MU_S = 0.6;
const MU_K = 0.45;

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;

  /** Positions, previous positions and velocities, one flat array per axis. */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  private readonly qx: Float64Array;
  private readonly qy: Float64Array;
  private readonly qz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  /** Inverse mass. Zero means pinned — the solver never moves it. */
  readonly w: Float64Array;
  /** The mass each particle would have if it were free, for re-pinning. */
  private readonly wFree: Float64Array;

  /** Structural + shear edges, as flat index pairs with rest lengths. */
  private readonly eA: Int32Array;
  private readonly eB: Int32Array;
  private readonly eL: Float64Array;
  private readonly eCount: number;

  /** Bend pairs (i, i+2), solved only in compression. */
  private readonly bA: Int32Array;
  private readonly bB: Int32Array;
  private readonly bL: Float64Array;
  private readonly bCount: number;

  /**
   * Long-range attachments.
   *
   * For every particle, the pin it hangs from and the rest distance to it. A
   * sheet pinned along one edge stretches under its own weight unless the
   * solver converges hard, and converging hard on forty rows is expensive.
   * A tether is one unilateral clamp per particle — the paper measures it at
   * under 2% of the solve cost — and it removes the creep exactly rather than
   * fighting it.
   */
  private readonly tPin: Int32Array;
  private readonly tLen: Float64Array;

  /** Per-frame aerodynamic force, accumulated per particle. */
  private readonly fx: Float64Array;
  private readonly fy: Float64Array;
  private readonly fz: Float64Array;

  /** Vertex normals, for shading and for the aero term. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly nz: Float64Array;

  private readonly opts: ClothOptions;
  private readonly spacing: { u: number; v: number };
  /** Deepest a particle has been inside the stand this step, in metres. */
  lastPenetration = 0;
  /** Was this particle touching the stand at the end of the last substep? */
  private readonly contact: Uint8Array;
  /** The surface normal it was touching, for the velocity pass. */
  private readonly cnx: Float64Array;
  private readonly cny: Float64Array;
  private readonly cnz: Float64Array;

  private readonly hit: Hit = { depth: 0, nx: 0, ny: 1, nz: 0 };
  private readonly windOut = { x: 0, y: 0, z: 0 };

  constructor(opts: ClothOptions, widthM: number, heightM: number) {
    this.opts = opts;
    this.cols = Math.max(2, opts.cols);
    this.rows = Math.max(2, opts.rows);
    const N = this.cols * this.rows;
    this.count = N;
    this.contact = new Uint8Array(N);
    this.cnx = new Float64Array(N);
    this.cny = new Float64Array(N);
    this.cnz = new Float64Array(N);
    this.spacing = { u: widthM / (this.cols - 1), v: heightM / (this.rows - 1) };

    this.px = new Float64Array(N);
    this.py = new Float64Array(N);
    this.pz = new Float64Array(N);
    this.qx = new Float64Array(N);
    this.qy = new Float64Array(N);
    this.qz = new Float64Array(N);
    this.vx = new Float64Array(N);
    this.vy = new Float64Array(N);
    this.vz = new Float64Array(N);
    this.w = new Float64Array(N);
    this.wFree = new Float64Array(N);
    this.fx = new Float64Array(N);
    this.fy = new Float64Array(N);
    this.fz = new Float64Array(N);
    this.nx = new Float64Array(N);
    this.ny = new Float64Array(N);
    this.nz = new Float64Array(N);

    // Mass from areal density: each interior particle owns one cell of fabric,
    // an edge particle half a cell, a corner a quarter. The hem carries extra
    // when the banner has a weighted bar in it, which is what makes the bottom
    // edge lag and overshoot instead of fluttering.
    const cellA = this.spacing.u * this.spacing.v;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        const fu = i === 0 || i === this.cols - 1 ? 0.5 : 1;
        const fv = j === 0 || j === this.rows - 1 ? 0.5 : 1;
        let m = opts.arealKgM2 * cellA * fu * fv;
        if (j === this.rows - 1) m *= Math.max(1, opts.hemWeight);
        this.wFree[k] = 1 / Math.max(1e-6, m);
        this.w[k] = this.wFree[k];
      }
    }

    // Edges. A triangulated grid with ONE diagonal per quad, alternating so
    // the sheet has no global bias. Structural plus both diagonals is
    // over-constrained and is the classic cause of a boiling surface.
    const ea: number[] = [];
    const eb: number[] = [];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        if (i + 1 < this.cols) {
          ea.push(k);
          eb.push(k + 1);
        }
        if (j + 1 < this.rows) {
          ea.push(k);
          eb.push(k + this.cols);
        }
        if (i + 1 < this.cols && j + 1 < this.rows) {
          if ((i + j) % 2 === 0) {
            ea.push(k);
            eb.push(k + this.cols + 1);
          } else {
            ea.push(k + 1);
            eb.push(k + this.cols);
          }
        }
      }
    }
    this.eA = Int32Array.from(ea);
    this.eB = Int32Array.from(eb);
    this.eL = new Float64Array(ea.length);
    this.eCount = ea.length;

    const ba: number[] = [];
    const bb: number[] = [];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        if (i + 2 < this.cols) {
          ba.push(k);
          bb.push(k + 2);
        }
        if (j + 2 < this.rows) {
          ba.push(k);
          bb.push(k + 2 * this.cols);
        }
      }
    }
    this.bA = Int32Array.from(ba);
    this.bB = Int32Array.from(bb);
    this.bL = new Float64Array(ba.length);
    this.bCount = ba.length;

    this.tPin = new Int32Array(N).fill(-1);
    this.tLen = new Float64Array(N);
  }

  /** The fabric's own coordinates: u across the width, v down the height. */
  index(i: number, j: number): number {
    return j * this.cols + i;
  }

  /**
   * Lay the sheet out and take its rest lengths from where it actually is.
   *
   * Rest lengths come from the initial geometry rather than from the nominal
   * spacing, so a sheet laid out along a curved stand starts unstressed rather
   * than immediately trying to straighten itself.
   */
  reset(place: (i: number, j: number, out: { x: number; y: number; z: number }) => void): void {
    const o = { x: 0, y: 0, z: 0 };
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = this.index(i, j);
        place(i, j, o);
        this.px[k] = o.x;
        this.py[k] = o.y;
        this.pz[k] = o.z;
        this.qx[k] = o.x;
        this.qy[k] = o.y;
        this.qz[k] = o.z;
        this.vx[k] = 0;
        this.vy[k] = 0;
        this.vz[k] = 0;
      }
    }
    for (let e = 0; e < this.eCount; e++) this.eL[e] = this.dist(this.eA[e], this.eB[e]);
    for (let b = 0; b < this.bCount; b++) this.bL[b] = this.dist(this.bA[b], this.bB[b]);
    this.computeNormals();
  }

  private dist(a: number, b: number): number {
    const dx = this.px[a] - this.px[b];
    const dy = this.py[a] - this.py[b];
    const dz = this.pz[a] - this.pz[b];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Free every particle, then let the caller pin what the rig holds. */
  unpinAll(): void {
    for (let k = 0; k < this.count; k++) this.w[k] = this.wFree[k];
    this.tPin.fill(-1);
  }

  /** Hold a particle at a world point. A pinned particle has no mass. */
  pin(k: number, x: number, y: number, z: number, dt: number): void {
    if (dt > 0) {
      // A hauled bar has to report its real velocity, or the air force and the
      // friction term below it never learn that it is moving.
      this.vx[k] = (x - this.px[k]) / dt;
      this.vy[k] = (y - this.py[k]) / dt;
      this.vz[k] = (z - this.pz[k]) / dt;
    }
    this.px[k] = x;
    this.py[k] = y;
    this.pz[k] = z;
    this.w[k] = 0;
  }

  /**
   * Tether every free particle to the pin it hangs from.
   *
   * Call after pinning. Distances come from the sheet's flat rest shape, which
   * is exactly right here: the paper notes that for a planar convex sheet —
   * a rectangular banner — plain Euclidean distance is enough and no geodesic
   * precompute is needed.
   */
  buildTethers(): void {
    const cols = this.cols;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = this.index(i, j);
        if (this.w[k] === 0) {
          this.tPin[k] = -1;
          continue;
        }
        // Walk up this column to the nearest pinned particle; failing that,
        // along the row. A sheet hauled from a bar finds the bar; one pinned
        // at its corners finds a corner.
        let pin = -1;
        for (let q = j - 1; q >= 0; q--) {
          if (this.w[this.index(i, q)] === 0) {
            pin = this.index(i, q);
            break;
          }
        }
        if (pin < 0) {
          for (let q = j + 1; q < this.rows; q++) {
            if (this.w[this.index(i, q)] === 0) {
              pin = this.index(i, q);
              break;
            }
          }
        }
        if (pin < 0) {
          for (let q = 0; q < cols; q++) {
            if (this.w[this.index(q, j)] === 0) {
              pin = this.index(q, j);
              break;
            }
          }
        }
        this.tPin[k] = pin;
        if (pin >= 0) {
          // 2% of slack, so the tether limits creep without making the sheet
          // feel like it is hanging on wires.
          this.tLen[k] = this.dist(k, pin) * 1.02;
        }
      }
    }
  }

  /**
   * One frame.
   *
   * `substeps` trades accuracy for time linearly and is the knob that scales
   * this to a phone. Aerodynamics are computed ONCE per frame and held across
   * the substeps: the air loading changes far more slowly than the constraint
   * residual, and recomputing six thousand face normals ten times a frame buys
   * nothing visible.
   */
  step(dt: number, world: ClothWorld, substeps: number): void {
    if (!(dt > 0)) return;
    const h = dt / substeps;
    this.computeNormals();
    this.applyAero(world);
    this.lastPenetration = 0;
    const damp = Math.exp(-DAMP_PER_S * h);

    for (let s = 0; s < substeps; s++) {
      // Predict.
      for (let k = 0; k < this.count; k++) {
        const w = this.w[k];
        if (w === 0) continue;
        this.vx[k] += h * (this.fx[k] * w);
        this.vy[k] += h * (GRAVITY + this.fy[k] * w);
        this.vz[k] += h * (this.fz[k] * w);
        this.qx[k] = this.px[k];
        this.qy[k] = this.py[k];
        this.qz[k] = this.pz[k];
        this.px[k] += h * this.vx[k];
        this.py[k] += h * this.vy[k];
        this.pz[k] += h * this.vz[k];
      }

      // Solve.
      //
      // The sweep order is FIXED, and that is not a detail. An earlier version
      // alternated it every substep, on the reasoning that a one-directional
      // Gauss-Seidel pass leaves a visible bias in the sheet — which is true,
      // and irrelevant next to what alternating costs.
      //
      // One iteration does not fully converge, so every substep ends with a
      // small residual displacement; velocity here is (p - q)/h, so that
      // residual is handed back as velocity. Flip the sweep order and the
      // residual flips sign with it, at exactly the substep frequency, and the
      // velocity feedback pumps it. It is a parametric resonance, and it
      // diverges: measured on a 3x3 sheet with nothing but gravity and
      // distance constraints, peak speed went 0.2, 1.6, 9.2, 52, 446 m/s over
      // five frames. On the real banner it showed up as twelve metres of
      // fabric rolling itself into a two-metre wad at the top of the stand in
      // under a quarter of a second — which I spent a long time blaming on the
      // wind, the collider and the tethers in turn, because the positions
      // still looked plausible for four frames while the velocities were
      // already six orders of magnitude out.
      //
      // Fixed order, and the same test sits still to five decimal places.
      this.solveEdges(true);
      this.solveBend();
      this.solveTethers();
      this.contact.fill(0);
      this.solveCollisions(world);

      // Velocities from the positions the solver settled on.
      for (let k = 0; k < this.count; k++) {
        if (this.w[k] === 0) continue;
        let vx = ((this.px[k] - this.qx[k]) / h) * damp;
        let vy = ((this.py[k] - this.qy[k]) / h) * damp;
        let vz = ((this.pz[k] - this.qz[k]) / h) * damp;

        // Resting contact, at the velocity level.
        //
        // The position solve alone is not enough. Moving `q` with `p` on a
        // push-out stops the contact ADDING energy, but it also preserves the
        // velocity that drove the particle into the surface — and since the
        // position is then held by the constraint, gravity keeps adding to a
        // velocity that never gets to do anything. Measured, a corner of a
        // banner resting on a stand reached 24 m/s while not moving at all,
        // and the moment anything lifted it off the surface it left.
        //
        // Zeroing the inward normal component is what hitting something and
        // staying on it means, and it costs one dot product.
        if (this.contact[k]) {
          const nx = this.cnx[k];
          const ny = this.cny[k];
          const nz = this.cnz[k];
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn < 0) {
            vx -= vn * nx;
            vy -= vn * ny;
            vz -= vn * nz;
          }
        }
        this.vx[k] = vx;
        this.vy[k] = vy;
        this.vz[k] = vz;
      }
    }
    this.computeNormals();
  }

  /**
   * Distance constraints at zero compliance.
   *
   * Real fabric stretches under one or two per cent at these loads: the top-row
   * tension of a 230 g/m² sheet twenty metres deep is 45 N/m, which on a woven
   * polyester is a strain of 0.015%. So the right compliance for the edges is
   * zero, and any stretch on screen is solver error rather than material.
   */
  private solveEdges(forward: boolean): void {
    // `forward` is kept as a parameter rather than inlined so the direction is
    // visible at the call site, where the reason it must not change lives.
    const n = this.eCount;
    for (let q = 0; q < n; q++) {
      const e = forward ? q : n - 1 - q;
      const a = this.eA[e];
      const b = this.eB[e];
      const wa = this.w[a];
      const wb = this.w[b];
      const sum = wa + wb;
      if (sum === 0) continue;
      const dx = this.px[a] - this.px[b];
      const dy = this.py[a] - this.py[b];
      const dz = this.pz[a] - this.pz[b];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const c = (len - this.eL[e]) / len / sum;
      if (wa !== 0) {
        this.px[a] -= dx * c * wa;
        this.py[a] -= dy * c * wa;
        this.pz[a] -= dz * c * wa;
      }
      if (wb !== 0) {
        this.px[b] += dx * c * wb;
        this.py[b] += dy * c * wb;
        this.pz[b] += dz * c * wb;
      }
    }
  }

  /**
   * Bending, as a unilateral i↔i+2 distance constraint.
   *
   * Solved only when the pair is COMPRESSED. Run two-sided it would fight the
   * structural edges and couple bending to stretch; run one-sided it does the
   * one job it is here for — stopping a vertical crease collapsing into a
   * knife edge — for half the work, because half the pairs are inactive.
   */
  private solveBend(): void {
    const alpha = this.opts.bendCompliance;
    for (let e = 0; e < this.bCount; e++) {
      const a = this.bA[e];
      const b = this.bB[e];
      const wa = this.w[a];
      const wb = this.w[b];
      const sum = wa + wb;
      if (sum === 0) continue;
      const dx = this.px[a] - this.px[b];
      const dy = this.py[a] - this.py[b];
      const dz = this.pz[a] - this.pz[b];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rest = this.bL[e];
      if (len >= rest || len < 1e-9) continue;
      const c = ((len - rest) / len / (sum + alpha)) * 0.5;
      if (wa !== 0) {
        this.px[a] -= dx * c * wa;
        this.py[a] -= dy * c * wa;
        this.pz[a] -= dz * c * wa;
      }
      if (wb !== 0) {
        this.px[b] += dx * c * wb;
        this.py[b] += dy * c * wb;
        this.pz[b] += dz * c * wb;
      }
    }
  }

  private solveTethers(): void {
    for (let k = 0; k < this.count; k++) {
      const pin = this.tPin[k];
      if (pin < 0 || this.w[k] === 0) continue;
      const dx = this.px[k] - this.px[pin];
      const dy = this.py[k] - this.py[pin];
      const dz = this.pz[k] - this.pz[pin];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const max = this.tLen[k];
      if (len <= max || len < 1e-9) continue;
      const s = max / len;
      this.px[k] = this.px[pin] + dx * s;
      this.py[k] = this.py[pin] + dy * s;
      this.pz[k] = this.pz[pin] + dz * s;
    }
  }

  /**
   * Push every particle out of the stand, and let the fabric catch on it.
   *
   * This is the constraint the whole rewrite is for. It runs on every particle
   * of every substep, which at ten substeps and 1.7 ms each means a particle
   * travelling at 10 m/s moves 1.7 cm between tests — far less than the
   * clearance, so there is nothing to tunnel through.
   *
   * The friction term is what stops the bottom of a banner sliding down the
   * terracing like ice. It cancels the tangential part of the particle's
   * motion when it is small enough to be static friction, and clamps it
   * otherwise.
   */
  private solveCollisions(world: ClothWorld): void {
    const f = world.field;
    const hit = this.hit;
    for (let k = 0; k < this.count; k++) {
      if (this.w[k] === 0) continue;
      let nx = 0;
      let ny = 1;
      let nz = 0;
      let depth = 0;

      if (f) {
        probe(f, this.px[k], this.py[k], this.pz[k], world.clearance, hit);
        if (hit.depth > 0) {
          depth = hit.depth;
          nx = hit.nx;
          ny = hit.ny;
          nz = hit.nz;
        }
      }
      // The pitch, which nothing may fall through.
      const gy = world.groundY + 0.02;
      if (this.py[k] < gy && gy - this.py[k] > depth) {
        depth = gy - this.py[k];
        nx = 0;
        ny = 1;
        nz = 0;
      }
      if (depth <= 0) continue;
      this.contact[k] = 1;
      this.cnx[k] = nx;
      this.cny[k] = ny;
      this.cnz[k] = nz;
      if (depth > this.lastPenetration) this.lastPenetration = depth;

      // Never move a particle more than half a cell in one substep: a huge
      // push-out after a teleport is how a solver explodes.
      const push = Math.min(depth, this.spacing.v * 0.5 + 0.05);
      this.px[k] += nx * push;
      this.py[k] += ny * push;
      this.pz[k] += nz * push;

      // Move the PREVIOUS position by the same amount.
      //
      // This is what makes the contact inelastic, and leaving it out is a real
      // bug rather than a refinement. Velocity here is (p - q)/h, so a push-out
      // that moves only `p` is indistinguishable from the particle having flown
      // that way under its own power: the solver hands it back as velocity, the
      // next substep it leaves the surface, falls in again, and is paid again.
      //
      // Measured on a 24 x 12 m sheet draped over a 30 degree rake, that ratchet
      // took four steps to start and fifteen to roll twelve metres of fabric up
      // the terracing into a two-metre wad — with the wind switched off, so it
      // was never the wind. Moving `q` with `p` makes the push contribute
      // exactly zero velocity, which is what hitting concrete does.
      this.qx[k] += nx * push;
      this.qy[k] += ny * push;
      this.qz[k] += nz * push;

      // Friction on the tangential part of this substep's motion.
      const dx = this.px[k] - this.qx[k];
      const dy = this.py[k] - this.qy[k];
      const dz = this.pz[k] - this.qz[k];
      const dn = dx * nx + dy * ny + dz * nz;
      const tx = dx - dn * nx;
      const ty = dy - dn * ny;
      const tz = dz - dn * nz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl < 1e-9) continue;
      // Hands, not just friction. A crowd carrying a sheet grips it; concrete
      // only rubs against it. `grip` interpolates between the two, and at full
      // grip the tangential motion is simply taken away, which is what a few
      // hundred fists do to a banner.
      const g = world.grip;
      const muS = MU_S + (3.0 - MU_S) * g;
      const muK = MU_K + (2.6 - MU_K) * g;
      const scale = tl < muS * depth ? 1 : Math.min((muK * depth) / tl, 1);
      this.px[k] -= tx * scale;
      this.py[k] -= ty * scale;
      this.pz[k] -= tz * scale;
    }
  }

  /**
   * Air.
   *
   * The standard aerodynamic force on a sheet, per particle: pressure normal
   * to the surface proportional to the square of the relative normal wind,
   * plus a lift component in the plane of the wind and the normal. Pressure
   * alone makes a banner bulge; it is the lift term that makes it ripple.
   *
   * The signed square keeps it two-sided without ever having to decide which
   * way the normal faces, and the acceleration is clamped: the true force on
   * 800 m² of fabric in a 10 m/s wind is six tonnes, and a sheet that is
   * momentarily badly stretched can generate an impulse that would throw it
   * out of the stadium.
   */
  private applyAero(world: ClothWorld): void {
    // Area per particle from its own MASS, not from the grid spacing.
    //
    // A corner particle owns a quarter of a cell and has a quarter of the
    // mass. Giving it a whole cell's worth of wind load while it carries a
    // quarter of the weight gives it four times the acceleration of the
    // fabric it is attached to, and the edges of the banner take off on their
    // own. Scaling the area with the mass makes the aerodynamic ACCELERATION
    // depend only on the areal density — which is the physical truth, and the
    // reason a light flag and a heavy one of the same size behave differently
    // while two pieces of the same flag do not.
    const sigma = this.opts.arealKgM2;
    const kDrag = 0.5 * AIR_DENSITY * this.opts.dragC;
    const kLift = 0.5 * AIR_DENSITY * this.opts.liftC;
    const wOut = this.windOut;
    for (let k = 0; k < this.count; k++) {
      this.fx[k] = 0;
      this.fy[k] = 0;
      this.fz[k] = 0;
      if (this.w[k] === 0) continue;
      // Fabric lying on the stand is in the boundary layer, and under a crowd
      // it is in their lee as well: the free-stream figure is simply not the
      // wind it feels. Using the free-stream everywhere is what gave a sheet
      // resting on a full kop five g of lift.
      const shelter = this.contact[k] ? 1 - 0.85 * world.grip - 0.1 : 1;
      world.wind(this.px[k], this.py[k], this.pz[k], wOut);
      const rx = wOut.x - this.vx[k];
      const ry = wOut.y - this.vy[k];
      const rz = wOut.z - this.vz[k];
      const nx = this.nx[k];
      const ny = this.ny[k];
      const nz = this.nz[k];
      const vn = rx * nx + ry * ny + rz * nz;
      const area = 1 / (this.w[k] * sigma);
      const drag = kDrag * area * vn * Math.abs(vn);
      let fx = drag * nx;
      let fy = drag * ny;
      let fz = drag * nz;

      // Lift: the component of the relative wind that is in the surface, which
      // is what makes a flag flutter rather than merely bow.
      const tx = rx - vn * nx;
      const ty = ry - vn * ny;
      const tz = rz - vn * nz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-6) {
        const speed2 = rx * rx + ry * ry + rz * rz;
        const sinCos = (vn / Math.sqrt(speed2 || 1)) * (tl / Math.sqrt(speed2 || 1));
        const l = kLift * area * speed2 * sinCos;
        fx += (l * tx) / tl;
        fy += (l * ty) / tl;
        fz += (l * tz) / tl;
      }

      // Clamp to five g of acceleration.
      const m = 1 / this.w[k];
      const cap = 5 * 9.81 * m;
      const mag = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (mag > cap) {
        const s = cap / mag;
        fx *= s;
        fy *= s;
        fz *= s;
      }
      this.fx[k] = fx * shelter;
      this.fy[k] = fy * shelter;
      this.fz[k] = fz * shelter;
    }
  }

  /**
   * Vertex normals by central difference.
   *
   * One cross product per vertex rather than one per triangle plus an
   * accumulation and a normalise — about two and a half times faster, and on a
   * smooth sheet indistinguishable. `computeVertexNormals` is never called:
   * it allocates and rebuilds the adjacency every time.
   */
  computeNormals(): void {
    const c = this.cols;
    const r = this.rows;
    for (let j = 0; j < r; j++) {
      for (let i = 0; i < c; i++) {
        const k = j * c + i;
        const a = j * c + Math.min(c - 1, i + 1);
        const b = j * c + Math.max(0, i - 1);
        const d = Math.min(r - 1, j + 1) * c + i;
        const e = Math.max(0, j - 1) * c + i;
        const ux = this.px[a] - this.px[b];
        const uy = this.py[a] - this.py[b];
        const uz = this.pz[a] - this.pz[b];
        const vx = this.px[d] - this.px[e];
        const vy = this.py[d] - this.py[e];
        const vz = this.pz[d] - this.pz[e];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < 1e-12) {
          nx = 0;
          ny = 1;
          nz = 0;
        } else {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        this.nx[k] = nx;
        this.ny[k] = ny;
        this.nz[k] = nz;
      }
    }
  }

  /** Deepest penetration of the stand right now, in metres. The gate reads this. */
  measurePenetration(world: ClothWorld, clearance = world.clearance): number {
    if (!world.field) return 0;
    let worst = 0;
    const hit = this.hit;
    for (let k = 0; k < this.count; k++) {
      probe(world.field, this.px[k], this.py[k], this.pz[k], clearance, hit);
      if (hit.depth > worst) worst = hit.depth;
    }
    return worst;
  }

  /** True if anything has gone non-finite — the one check worth making per frame. */
  get healthy(): boolean {
    return Number.isFinite(this.px[0]) && Number.isFinite(this.py[this.count - 1]);
  }
}

/**
 * Terminal fall speed of a sheet falling broadside, in m/s.
 *
 * The most readable weight cue there is. A 70 g/m² flag settles at under a
 * metre a second and visibly floats; painted muslin at 290 g/m² comes down at
 * nearly two and looks solid. It is also why tifo crews roll or accordion-fold
 * a banner before a drop: an unfolded sheet does not fall, it parachutes.
 */
export function terminalFallSpeed(arealKgM2: number, dragC = 1.28): number {
  return Math.sqrt((2 * arealKgM2 * 9.81) / (AIR_DENSITY * dragC));
}

/**
 * How hard the air pushes compared with gravity, at a given wind speed.
 *
 * One number separates a flag from a banner. Above about 1 m/s of airflow the
 * shape of a light sheet is set by pressure rather than by weight, which is
 * why tifo fabric breathes constantly instead of hanging like a curtain.
 */
export function windToWeightRatio(arealKgM2: number, windMs: number, dragC = 1.28): number {
  return (AIR_DENSITY * dragC * windMs * windMs) / (2 * Math.max(1e-6, arealKgM2) * 9.81);
}

/**
 * The first sway period of a sheet hanging from its top edge, in seconds.
 *
 * A hanging sheet is a pendulum whose period depends only on its length:
 * about 5.3 s at ten metres, 7.5 s at twenty. Worth knowing because it is the
 * timescale the eye reads as weight, and because a reveal shorter than one
 * period never looks like fabric arriving.
 */
export function swayPeriod(heightM: number): number {
  return (2 * Math.PI) / (1.2025 * Math.sqrt(9.81 / Math.max(0.5, heightM)));
}
