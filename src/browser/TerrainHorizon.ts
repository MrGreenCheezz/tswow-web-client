/**
 * 15.11 (7.54, 7.53): the terrain horizon of Wow.exe 12340, read from the client (`.runtime/re-2026-11-15/portal5/hz*.c`).
 *
 * - The buffer: 384 columns of screen heights at 0x00cd8938, reset every frame to -1e6 by `0x79a870` (with the
 *   occluder marks at 0x00cd87b8 cleared). Its space is the camera's position and heading with the pitch taken out
 *   (`0x795400` builds 0x00adf460 from a look-at along the horizontal forward, times the projection): a point's
 *   column is rint(x/z * 64 - 0.5) + 192, its height y/z (`0x4c21b0` drops w; z is the projection's z).
 * - The gate: bit 0x20 of 0x00cd774c (on by default, `0x780f50` sets 0x7104b73) and |forward.z| <= 0.9 (0x00a3f85c,
 *   0x00a02a34). Outside it nothing is filled and nothing is hidden.
 * - The order: everything with a box is sorted into 64 buckets by the depth of its nearest corner along the horizontal
 *   forward, 33.3 yards each (`0x792bd0`, 0.03 at 0x00a3f7ec). `0x79a790` takes the buckets front to back and in each
 *   first tests what lies in it (terrain chunks `0x799d40`, outdoor WMO groups `0x79a160` and `0x7b3a10`, liquids
 *   `0x7935a0`, doodads `0x793060`, `0x7987a0`, `0x799980`), then fills (`0x793760`). A test sees only nearer buckets.
 * - The fill (`0x7cfb10` -> `0x78f6a0`): a terrain chunk drawn this frame (its box in the view and not hidden) gives
 *   two polylines of nine outer vertices, its far row and its far column in the heading's direction. Each segment
 *   whose two ends are at least 1/36 deep raises the columns between them to the lower of the two heights. A chunk
 *   is filled in the bucket of its far corner (`0x799d40`). A chunk with holes instead resets the columns its
 *   polylines span to -1000001, unless an occluder marked them.
 * - The box test (`0x78fdc0`): the eight corners; any nearer than 50 (unless flag 8) and it is seen. Otherwise it is
 *   hidden when in every column from rint(minX*64-0.5)+192 to rint(maxX*64-0.5)+193 the buffer is at or above its top.
 *   The sphere test (`0x78fc40`) is the same with the centre and the radius scaled by the projection.
 *
 * Every approximation here errs low, because a horizon higher than the original's hides what the original draws:
 * a chunk this client cannot place is not filled, a reset is repeated in every bucket the chunk spans, heights come in
 * already lowered by their storage error (`TerrainHorizonChunks.ts`), and the map occluders (`0x7cc880`, which only
 * raise) are not read.
 */

export const HORIZON_COLUMNS = 384;
export const HORIZON_BUCKETS = 64;
const RESET = -1e6; // 0xc9742400
const HOLE_RESET = -1000001; // 0x00a3f858
const MIN_FILL_DEPTH = 1 / 36; // 0x00a3f854
const NEAR_SEEN = 50; // 0x009f22ec
const COLUMN_SCALE = 64; // 0x00a3f7e8
const BUCKET_SCALE = 0.03; // 0x00a3f7ec
const PITCH_LIMIT = 0.9;

/** x87 `fistp` in the default mode: round half to even. */
export function rint(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The camera in Wow's world axes (x north, y west, z up) and the projection's own numbers. */
export interface HorizonCamera {
  x: number;
  y: number;
  z: number;
  /** Unit forward. */
  fx: number;
  fy: number;
  fz: number;
  /** Projection: x and y scale, and the near and far planes. */
  xScale: number;
  yScale: number;
  near: number;
  far: number;
}

export class TerrainHorizon {
  /** Whether this frame's camera passes the gate; when false every test answers "seen". */
  active = false;
  /** One row of 384 per bucket: the buffer after that bucket's fill. Row b-1 is what a test in bucket b sees. */
  readonly snapshots = new Float32Array(HORIZON_BUCKETS * HORIZON_COLUMNS);
  readonly buffer = new Float32Array(HORIZON_COLUMNS);
  /** Fills and resets queued per bucket while the frame is built. */
  #queue: { bucket: number; reset: boolean; points: Float64Array }[][] = [];
  #rx = 0;
  #ry = 0;
  #hx = 0;
  #hy = 0;
  #hd = 0;
  #cx = 0;
  #cy = 0;
  #cz = 0;
  #xs = 1;
  #ys = 1;
  #q = 1;
  #zn = 0;
  #nearMinX = true;
  #nearMinY = true;
  #nearMinZ = true;

  /** Starts a frame; false when the gate keeps the horizon out of it. */
  begin(camera: HorizonCamera, enabled = true): boolean {
    this.buffer.fill(RESET);
    this.#queue = [];
    for (let bucket = 0; bucket < HORIZON_BUCKETS; bucket++) this.#queue.push([]);
    const horizontal = Math.hypot(camera.fx, camera.fy);
    this.active = enabled && camera.fz >= -PITCH_LIMIT && camera.fz <= PITCH_LIMIT && horizontal > 1e-4
      && camera.xScale > 0 && camera.yScale > 0 && camera.far > camera.near;
    if (!this.active) return false;
    this.#hx = camera.fx / horizontal;
    this.#hy = camera.fy / horizontal;
    this.#hd = -(this.#hx * camera.x + this.#hy * camera.y);
    // `0x6bfe60`: right = forward x up, with up = +z.
    this.#rx = this.#hy;
    this.#ry = -this.#hx;
    this.#cx = camera.x;
    this.#cy = camera.y;
    this.#cz = camera.z;
    this.#xs = camera.xScale;
    this.#ys = camera.yScale;
    this.#q = camera.far / (camera.far - camera.near);
    this.#zn = camera.near;
    // `0x792bd0`: the nearest corner is the low end on an axis the forward points up along.
    this.#nearMinX = camera.fx >= 0;
    this.#nearMinY = camera.fy >= 0;
    this.#nearMinZ = camera.fz >= 0;
    return true;
  }

  /** `0x792bd0`: the bucket of a box, by its nearest corner; -1 past the last bucket. */
  bucketOf(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    void minZ;
    void maxZ;
    const x = this.#nearMinX ? minX : maxX;
    const y = this.#nearMinY ? minY : maxY;
    return this.#bucketOfDepth(this.#hx * x + this.#hy * y + this.#hd);
  }

  /** The bucket of a box by its farthest corner, where `0x799d40` files a chunk for the fill. */
  farBucketOf(minX: number, minY: number, maxX: number, maxY: number): number {
    const x = this.#nearMinX ? maxX : minX;
    const y = this.#nearMinY ? maxY : minY;
    return this.#bucketOfDepth(this.#hx * x + this.#hy * y + this.#hd);
  }

  #bucketOfDepth(depth: number): number {
    if (!(depth > 0)) return 0;
    const bucket = rint(depth * BUCKET_SCALE - 0.5);
    return bucket < HORIZON_BUCKETS ? bucket : -1;
  }

  /** Whether the chunk's far edges run along its first (true) or last row and column: the heading decides (`0x7cfb10`). */
  get headingNegativeX(): boolean {
    return this.#hx < 0;
  }

  get headingNegativeY(): boolean {
    return this.#hy < 0;
  }

  /** Queues a chunk's two far polylines (`points`: x, y, z per point, nine per polyline) for the fill of `bucket`. */
  queueFill(bucket: number, points: Float64Array): void {
    if (bucket >= 0 && bucket < HORIZON_BUCKETS) this.#queue[bucket]!.push({ bucket, reset: false, points });
  }

  /** Queues a holed chunk's reset in every bucket from `from` to `to` (this client errs low: see the header). */
  queueReset(from: number, to: number, points: Float64Array): void {
    const last = to < 0 ? HORIZON_BUCKETS - 1 : Math.min(to, HORIZON_BUCKETS - 1);
    for (let bucket = Math.max(0, from); bucket <= last; bucket++) this.#queue[bucket]!.push({ bucket, reset: true, points });
  }

  /**
   * Runs the buckets front to back. `visit(bucket)` is called before each bucket's fill with the buffer as the nearer
   * buckets left it, so it can test what lies in that bucket and queue more fills (for this bucket or farther ones).
   */
  run(visit?: (bucket: number) => void): void {
    for (let bucket = 0; bucket < HORIZON_BUCKETS; bucket++) {
      if (visit) visit(bucket);
      const queued = this.#queue[bucket]!;
      // `0x793760`: the raises, then the chunks with holes.
      for (const item of queued) if (!item.reset) this.#raise(item.points);
      for (const item of queued) if (item.reset) this.#reset(item.points);
      this.snapshots.set(this.buffer, bucket * HORIZON_COLUMNS);
    }
  }

  #project(points: Float64Array, at: number, out: Float64Array): void {
    const dx = points[at]! - this.#cx;
    const dy = points[at + 1]! - this.#cy;
    const dz = points[at + 2]! - this.#cz;
    const right = this.#rx * dx + this.#ry * dy;
    const forward = this.#hx * dx + this.#hy * dy;
    out[0] = right * this.#xs;
    out[1] = dz * this.#ys;
    out[2] = this.#q * (forward - this.#zn);
  }

  readonly #a = new Float64Array(3);
  readonly #b = new Float64Array(3);

  /** `0x78f6a0` with no holes: every polyline of nine raises the columns between its neighbours. */
  #raise(points: Float64Array): void {
    const buffer = this.buffer;
    const a = this.#a;
    const b = this.#b;
    for (let line = 0; line + 9 * 3 <= points.length; line += 9 * 3) {
      this.#project(points, line, a);
      for (let index = 1; index < 9; index++) {
        this.#project(points, line + index * 3, b);
        if (a[2]! >= MIN_FILL_DEPTH && b[2]! >= MIN_FILL_DEPTH) {
          const ya = a[1]! / a[2]!;
          const yb = b[1]! / b[2]!;
          const height = yb <= ya ? yb : ya;
          let from = rint(a[0]! / a[2]! * COLUMN_SCALE - 0.5) + 192;
          let to = rint(b[0]! / b[2]! * COLUMN_SCALE - 0.5) + 192;
          if (to < from) {
            const swap = from;
            from = to;
            to = swap;
          }
          if (from < 0) from = 0;
          if (to > HORIZON_COLUMNS - 1) to = HORIZON_COLUMNS - 1;
          for (let column = from; column <= to; column++) if (buffer[column]! < height) buffer[column] = height;
        }
        a[0] = b[0]!;
        a[1] = b[1]!;
        a[2] = b[2]!;
      }
    }
  }

  /** `0x78f6a0` with holes: the columns the polylines span go back to nothing. A point at or behind the eye: all of them. */
  #reset(points: Float64Array): void {
    const buffer = this.buffer;
    const a = this.#a;
    const b = this.#b;
    for (let line = 0; line + 9 * 3 <= points.length; line += 9 * 3) {
      this.#project(points, line, a);
      for (let index = 1; index < 9; index++) {
        this.#project(points, line + index * 3, b);
        if (!(a[2]! > 1e-6 && b[2]! > 1e-6)) {
          buffer.fill(HOLE_RESET);
          return;
        }
        let from = rint(a[0]! / a[2]! * COLUMN_SCALE - 0.5) + 192;
        let to = rint(b[0]! / b[2]! * COLUMN_SCALE - 0.5) + 192;
        if (to < from) {
          const swap = from;
          from = to;
          to = swap;
        }
        if (from < 0) from = 0;
        if (to > HORIZON_COLUMNS - 1) to = HORIZON_COLUMNS - 1;
        for (let column = from; column <= to; column++) buffer[column] = HOLE_RESET;
        a[0] = b[0]!;
        a[1] = b[1]!;
        a[2] = b[2]!;
      }
    }
  }

  /**
   * `0x78fdc0`: whether a world box in `bucket` is hidden behind the nearer buckets' horizon. `seenNear` is
   * `(flags & 8) === 0`: a corner nearer than 50 makes it seen. Outside the gate, or in bucket 0, nothing is hidden.
   */
  boxHidden(
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, bucket: number, seenNear = true,
  ): boolean {
    if (!this.active || bucket <= 0) return false;
    let low = Infinity;
    let high = -Infinity;
    let top = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const dx = ((corner & 1) !== 0 ? maxX : minX) - this.#cx;
      const dy = ((corner & 2) !== 0 ? maxY : minY) - this.#cy;
      const dz = ((corner & 4) !== 0 ? maxZ : minZ) - this.#cz;
      const depth = this.#q * (this.#hx * dx + this.#hy * dy - this.#zn);
      if (seenNear && depth < NEAR_SEEN) return false;
      const inverse = 1 / depth;
      const x = (this.#rx * dx + this.#ry * dy) * this.#xs * inverse;
      const y = dz * this.#ys * inverse;
      if (x < low) low = x;
      if (x > high) high = x;
      if (y > top) top = y;
    }
    return this.#hiddenBetween(low, high, top, bucket, 192, 193);
  }

  /** `0x78fc40`: the same for a sphere; `seenNear` as for a box (flags 0 and 0x10 both keep it). */
  sphereHidden(x: number, y: number, z: number, radius: number, bucket: number, seenNear = true): boolean {
    if (!this.active || bucket <= 0 || !(Math.abs(radius) >= 2.384185791015625e-7)) return false;
    const dx = x - this.#cx;
    const dy = y - this.#cy;
    const dz = z - this.#cz;
    const depth = this.#q * (this.#hx * dx + this.#hy * dy - this.#zn);
    if (seenNear && depth < NEAR_SEEN) return false;
    const inverse = 1 / depth;
    const cx = (this.#rx * dx + this.#ry * dy) * this.#xs * inverse;
    const cy = dz * this.#ys * inverse;
    // As read: the width takes the projection's y scale and the top its x scale.
    const across = radius * this.#ys * inverse;
    const up = radius * this.#xs * inverse;
    return this.#hiddenBetween(cx - across, cx + across, cy + up, bucket, 192, 193);
  }

  #hiddenBetween(low: number, high: number, top: number, bucket: number, lowBase: number, highBase: number): boolean {
    let from = rint(low * COLUMN_SCALE - 0.5) + lowBase;
    let to = rint(high * COLUMN_SCALE - 0.5) + highBase;
    if (!(from < HORIZON_COLUMNS && to >= 0)) return false;
    if (from < 0) from = 0;
    if (to > HORIZON_COLUMNS - 1) to = HORIZON_COLUMNS - 1;
    const row = (bucket - 1) * HORIZON_COLUMNS;
    for (let column = from; column <= to; column++) if (this.snapshots[row + column]! < top) return false;
    return true;
  }
}
