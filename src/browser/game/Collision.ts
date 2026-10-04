import { MAX_WALKABLE_SLOPE_DEGREES } from "./Physics.js";

/**
 * Standing on things, and not walking through them.
 *
 * The geometry is the server's own: the `.vmo` files its vmap extractor wrote, placed by the same
 * spawns its `ModelInstance` places them with. That is the point of taking it from there rather
 * than from the render meshes — the two then agree on where a wall is by construction, and there
 * is no such thing as the server thinking the player is inside one.
 *
 * The maths is here and nothing else is: triangles in, answers out, no fetching and no world.
 * `CollisionWorld` is a bag of transformed meshes with a grid over each; what fills it lives in
 * `CollisionSource`, and what asks it lives in `Physics`.
 */

const WALKABLE_NORMAL_Z = Math.cos(MAX_WALKABLE_SLOPE_DEGREES * Math.PI / 180);
/** How wide a cell of a mesh's own lookup grid is. The inn is forty yards across and 26,222 triangles. */
const CELL_YARDS = 4;
/** A grid is only worth building past this; a table is twelve triangles. */
const GRID_THRESHOLD = 64;

export interface CollisionPlacement {
  /** Where the vmap tile says the model stands, in world coordinates. */
  x: number;
  y: number;
  z: number;
  /** The tile's Euler angles, in degrees, exactly as `ModelSpawn` records them. */
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scale: number;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Model space to world space, the way `ModelInstance` does it and then back out of vmap's own
 * frame.
 *
 * `ModelInstance` builds its rotation as `Matrix3::fromEulerAnglesZYX(rot.y, rot.x, rot.z)` and
 * places a vertex at `iPos + iScale * (R * v)`, all in the internal frame vmap stores everything
 * in. That frame is the world mirrored about its own middle in x and y — `convertPositionToInternalRep`
 * is `mid - x, mid - y, z` — and `iPos` is the placement already converted. Substituting one into
 * the other, the mid cancels and what is left is this: rotate, scale, negate x and y, and offset
 * by where the tile says the model stands. Getting the sign wrong here puts every building's
 * collision through itself, mirrored, which is worse than having none.
 */
export function transformCollisionMesh(
  vertices: Float32Array,
  indices: Uint32Array,
  placement: CollisionPlacement,
): Float32Array {
  const yaw = placement.rotationY * Math.PI / 180;
  const pitch = placement.rotationX * Math.PI / 180;
  const roll = placement.rotationZ * Math.PI / 180;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);

  // Rz(yaw) * Ry(pitch) * Rx(roll), written out rather than composed, because this runs over every
  // vertex of every building in view.
  const m00 = cosYaw * cosPitch;
  const m01 = cosYaw * sinPitch * sinRoll - sinYaw * cosRoll;
  const m02 = cosYaw * sinPitch * cosRoll + sinYaw * sinRoll;
  const m10 = sinYaw * cosPitch;
  const m11 = sinYaw * sinPitch * sinRoll + cosYaw * cosRoll;
  const m12 = sinYaw * sinPitch * cosRoll - cosYaw * sinRoll;
  const m20 = -sinPitch;
  const m21 = cosPitch * sinRoll;
  const m22 = cosPitch * cosRoll;
  const scale = placement.scale || 1;

  const triangles = new Float32Array(indices.length * 3);
  for (let index = 0; index < indices.length; index++) {
    const vertex = indices[index]! * 3;
    const vx = vertices[vertex]!;
    const vy = vertices[vertex + 1]!;
    const vz = vertices[vertex + 2]!;
    const rx = m00 * vx + m01 * vy + m02 * vz;
    const ry = m10 * vx + m11 * vy + m12 * vz;
    const rz = m20 * vx + m21 * vy + m22 * vz;
    const out = index * 3;
    triangles[out] = placement.x - scale * rx;
    triangles[out + 1] = placement.y - scale * ry;
    triangles[out + 2] = placement.z + scale * rz;
  }
  return triangles;
}

/**
 * World space back into one vmap placement's model space.
 *
 * This is the exact inverse of `transformCollisionMesh`, including vmap's x/y reflection. It is
 * kept as a point operation for metadata that stays in model space, notably a WMO's `MLIQ` grid.
 */
export function inverseTransformCollisionPoint(point: Vector3, placement: CollisionPlacement): Vector3 {
  const yaw = placement.rotationY * Math.PI / 180;
  const pitch = placement.rotationX * Math.PI / 180;
  const roll = placement.rotationZ * Math.PI / 180;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);

  const m00 = cosYaw * cosPitch;
  const m01 = cosYaw * sinPitch * sinRoll - sinYaw * cosRoll;
  const m02 = cosYaw * sinPitch * cosRoll + sinYaw * sinRoll;
  const m10 = sinYaw * cosPitch;
  const m11 = sinYaw * sinPitch * sinRoll + cosYaw * cosRoll;
  const m12 = sinYaw * sinPitch * cosRoll - cosYaw * sinRoll;
  const m20 = -sinPitch;
  const m21 = cosPitch * sinRoll;
  const m22 = cosPitch * cosRoll;
  const scale = placement.scale || 1;

  // Undo the placement and reflection, then multiply by R transpose (R is orthonormal).
  const rx = (placement.x - point.x) / scale;
  const ry = (placement.y - point.y) / scale;
  const rz = (point.z - placement.z) / scale;
  return {
    x: m00 * rx + m10 * ry + m20 * rz,
    y: m01 * rx + m11 * ry + m21 * rz,
    z: m02 * rx + m12 * ry + m22 * rz,
  };
}

export interface CollisionBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * A model-space box in world space, by way of its own eight corners.
 *
 * Needed before the geometry is: a city's groups are chosen by which of their boxes the player is
 * standing in, and asking for the geometry first would defeat the whole point of choosing.
 */
export function transformCollisionBounds(bounds: CollisionBox, placement: CollisionPlacement): CollisionBox {
  const corners = new Float32Array(24);
  let cursor = 0;
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        corners[cursor++] = x;
        corners[cursor++] = y;
        corners[cursor++] = z;
      }
    }
  }
  const indices = Uint32Array.from({ length: 8 }, (_unused, index) => index);
  const world = transformCollisionMesh(corners, indices, placement);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < world.length; index += 3) {
    minX = Math.min(minX, world[index]!);
    minY = Math.min(minY, world[index + 1]!);
    minZ = Math.min(minZ, world[index + 2]!);
    maxX = Math.max(maxX, world[index]!);
    maxY = Math.max(maxY, world[index + 1]!);
    maxZ = Math.max(maxZ, world[index + 2]!);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * One placed model's triangles in world space, with a grid over them.
 *
 * The grid is over x and y only. Everything asked of this is asked at a point on the ground or
 * along a standing body, so the columns are what matter and a third axis would only cost memory.
 */
/**
 * Where one group's triangles start in a merged mesh, and the flags that group carried.
 *
 * A run table rather than a flag per triangle: a placement is a handful of groups and hundreds of
 * thousands of triangles, so this is tens of bytes instead of a megabyte.
 */
export interface CollisionRun {
  /** Index of this run's first triangle. Runs are in order and cover the mesh without gaps. */
  first: number;
  /** `MOGP`'s own flags for the group. `0x8` marks a group that is open to the sky. */
  flags: number;
  /** Index in the collision model's group array. Absent only on legacy/ad-hoc meshes. */
  groupIndex?: number;
  /** Authored WMO group id copied into the `.vmo`. Absent only on legacy/ad-hoc meshes. */
  groupId?: number;
}

/** The bit `Map::IsOutdoors` reads: set means the group is open air, clear means it is a room. */
export const COLLISION_GROUP_OUTDOOR = 0x8;

export class CollisionMesh {
  readonly triangles: Float32Array;
  readonly bounds: CollisionBox;
  /** Empty when nothing said which group a triangle belongs to, which reads as "no answer". */
  readonly runs: readonly CollisionRun[];
  readonly #cellsX: number;
  readonly #cellsY: number;
  /**
   * The grid as two flat arrays: cell `c` holds `#items[#offsets[c]]` up to `#offsets[c + 1]`,
   * in ascending triangle order — the same lists, in the same order, the grid used to keep as one
   * `Int32Array` per cell.
   *
   * Flat because of what the per-cell arrays cost to make. The Trade District's merged Stormwind
   * mesh was a grid of some 59,000 cells holding 757,000 references, and building it was that
   * many empty JS arrays, pushes into them and typed arrays copied out of them: measured, 32-36 ms
   * of a 36-58 ms rebuild and most of the twenty megabytes of garbage each one left. Two passes
   * over the triangles — count, then place — make the same grid out of two allocations.
   */
  readonly #offsets: Int32Array | undefined;
  readonly #items: Int32Array | undefined;
  /**
   * Single-cell answers handed out by `candidates`, made the first time a cell is asked about.
   * Views rather than copies, and kept so the query that asks about the cell under the feet every
   * frame allocates nothing after the first time.
   */
  readonly #views = new Map<number, Int32Array>();

  constructor(triangles: Float32Array, runs: readonly CollisionRun[] = []) {
    this.triangles = triangles;
    this.runs = runs;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < triangles.length; index += 3) {
      const x = triangles[index]!;
      const y = triangles[index + 1]!;
      const z = triangles[index + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    this.bounds = triangles.length === 0
      ? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
      : { minX, minY, minZ, maxX, maxY, maxZ };

    const count = triangles.length / 9;
    if (count < GRID_THRESHOLD) {
      this.#cellsX = 0;
      this.#cellsY = 0;
      this.#offsets = undefined;
      this.#items = undefined;
      return;
    }
    const cellsX = Math.max(1, Math.min(256, Math.ceil((maxX - minX) / CELL_YARDS)));
    const cellsY = Math.max(1, Math.min(256, Math.ceil((maxY - minY) / CELL_YARDS)));
    this.#cellsX = cellsX;
    this.#cellsY = cellsY;
    const cells = cellsX * cellsY;
    // Counted into each cell's own slot first; the running sum then turns every slot into where
    // its cell *ends*, and the second pass walks the triangles backwards, stepping each cell's
    // slot down as it places one. When it is done every slot holds where its cell starts, and each
    // cell lists its triangles in ascending order — the order the per-cell arrays had, which the
    // walks below and the tie-breaks of every query rely on.
    const offsets = new Int32Array(cells + 1);
    for (let triangle = 0; triangle < count; triangle++) {
      const base = triangle * 9;
      const fromX = gridCell(Math.min(triangles[base]!, triangles[base + 3]!, triangles[base + 6]!), minX, cellsX);
      const toX = gridCell(Math.max(triangles[base]!, triangles[base + 3]!, triangles[base + 6]!), minX, cellsX);
      const fromY = gridCell(Math.min(triangles[base + 1]!, triangles[base + 4]!, triangles[base + 7]!), minY, cellsY);
      const toY = gridCell(Math.max(triangles[base + 1]!, triangles[base + 4]!, triangles[base + 7]!), minY, cellsY);
      for (let cellY = fromY; cellY <= toY; cellY++) {
        for (let cellX = fromX; cellX <= toX; cellX++) offsets[cellY * cellsX + cellX]!++;
      }
    }
    let placed = 0;
    for (let cell = 0; cell < cells; cell++) {
      placed += offsets[cell]!;
      offsets[cell] = placed;
    }
    offsets[cells] = placed;
    const items = new Int32Array(placed);
    for (let triangle = count - 1; triangle >= 0; triangle--) {
      const base = triangle * 9;
      const fromX = gridCell(Math.min(triangles[base]!, triangles[base + 3]!, triangles[base + 6]!), minX, cellsX);
      const toX = gridCell(Math.max(triangles[base]!, triangles[base + 3]!, triangles[base + 6]!), minX, cellsX);
      const fromY = gridCell(Math.min(triangles[base + 1]!, triangles[base + 4]!, triangles[base + 7]!), minY, cellsY);
      const toY = gridCell(Math.max(triangles[base + 1]!, triangles[base + 4]!, triangles[base + 7]!), minY, cellsY);
      for (let cellY = fromY; cellY <= toY; cellY++) {
        for (let cellX = fromX; cellX <= toX; cellX++) items[--offsets[cellY * cellsX + cellX]!] = triangle;
      }
    }
    this.#offsets = offsets;
    this.#items = items;
  }

  #cellX(x: number): number {
    return gridCell(x, this.bounds.minX, this.#cellsX);
  }

  #cellY(y: number): number {
    return gridCell(y, this.bounds.minY, this.#cellsY);
  }

  /** Triangle indices whose boxes touch this square of ground, or every one when there is no grid. */
  candidates(minX: number, minY: number, maxX: number, maxY: number): Int32Array | undefined {
    const offsets = this.#offsets;
    const items = this.#items;
    if (!offsets || !items) return undefined;
    if (maxX < this.bounds.minX || minX > this.bounds.maxX || maxY < this.bounds.minY || minY > this.bounds.maxY) {
      return EMPTY;
    }
    const fromX = this.#cellX(minX);
    const toX = this.#cellX(maxX);
    const fromY = this.#cellY(minY);
    const toY = this.#cellY(maxY);
    if (fromX === toX && fromY === toY) {
      const cell = fromY * this.#cellsX + fromX;
      let view = this.#views.get(cell);
      if (!view) {
        view = items.subarray(offsets[cell]!, offsets[cell + 1]!);
        this.#views.set(cell, view);
      }
      return view;
    }
    const found = new Set<number>();
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const cell = cellY * this.#cellsX + cellX;
        const end = offsets[cell + 1]!;
        for (let entry = offsets[cell]!; entry < end; entry++) found.add(items[entry]!);
      }
    }
    return Int32Array.from(found);
  }

  /**
   * Bytes this mesh holds: its triangles and its grid. What a cache of built meshes is capped by;
   * the few single-cell views `candidates` has handed out are not counted.
   */
  get byteLength(): number {
    return this.triangles.byteLength + (this.#offsets?.byteLength ?? 0) + (this.#items?.byteLength ?? 0);
  }

  /**
   * Where a segment first meets this mesh, as a fraction of its own length, or nothing.
   *
   * Walked as a DDA over the same grid `candidates` buckets into, cell by cell along the line, and
   * the reason is that it builds no intermediate list and that its cost does not follow the size of
   * the mesh. Measured on a 7,224-triangle mesh — a 60-yard floor of one-yard squares with twelve
   * walls through it, 40,000 segments across it, node on this machine: **1.25 us** a query for the
   * walk, **18.4 us** for the same cells gathered into a `Set` first and then tested, and
   * **101.5 us** for `candidates` over the segment's whole bounding rectangle. The gap is two
   * things at once, and neither is arithmetic: the walk touches only the cells the line crosses,
   * and it stops at the first cell that answers instead of testing the corridor to the far end.
   *
   * A triangle spanning two cells is tested twice rather than remembered, which is the trade the
   * whole method is for: a `Set` to avoid it would cost more than the second test.
   *
   * `limit` is the best answer found so far, so the walk can stop as soon as no remaining cell can
   * beat it. Pass 1 to search the whole segment.
   */
  firstHit(from: Vector3, to: Vector3, limit = 1): { t: number; triangle: number } | undefined {
    const bounds = this.bounds;
    if (Math.min(from.x, to.x) > bounds.maxX || Math.max(from.x, to.x) < bounds.minX) return undefined;
    if (Math.min(from.y, to.y) > bounds.maxY || Math.max(from.y, to.y) < bounds.minY) return undefined;
    if (Math.min(from.z, to.z) > bounds.maxZ || Math.max(from.z, to.z) < bounds.minZ) return undefined;

    let best: number | undefined;
    let bestTriangle = -1;
    const consider = (triangle: number): void => {
      const t = segmentHit(this.triangles, triangle, from, to);
      if (t === undefined || t > limit) return;
      if (best !== undefined && t >= best) return;
      best = t;
      bestTriangle = triangle;
    };

    // Under the grid threshold there is no grid to walk, and a table is twelve triangles.
    const offsets = this.#offsets;
    const items = this.#items;
    if (!offsets || !items) {
      const count = this.triangleCount;
      for (let triangle = 0; triangle < count; triangle++) consider(triangle);
      return best === undefined ? undefined : { t: best, triangle: bestTriangle };
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    // A segment straight down a column crosses exactly one cell; the walk below divides by the
    // step and would spend its whole budget standing still.
    if (dx === 0 && dy === 0) {
      const cell = this.#cellY(from.y) * this.#cellsX + this.#cellX(from.x);
      const end = offsets[cell + 1]!;
      for (let entry = offsets[cell]!; entry < end; entry++) consider(items[entry]!);
      return best === undefined ? undefined : { t: best, triangle: bestTriangle };
    }

    let cellX = this.#cellX(from.x);
    let cellY = this.#cellY(from.y);
    const lastX = this.#cellX(to.x);
    const lastY = this.#cellY(to.y);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    // How much of the segment one whole cell of travel costs, per axis. Infinite for an axis the
    // line does not move along, which is what keeps that axis's boundary permanently in the future.
    const perCellX = dx === 0 ? Infinity : Math.abs(CELL_YARDS / dx);
    const perCellY = dy === 0 ? Infinity : Math.abs(CELL_YARDS / dy);
    // Where the next boundary of each axis falls, as a fraction of the segment. The clamping in
    // `#cellX` means a segment starting outside the mesh begins in the edge cell, so the first
    // boundary is measured from that cell rather than from where the line really is.
    let nextX = dx === 0 ? Infinity
      : (bounds.minX + (cellX + (stepX > 0 ? 1 : 0)) * CELL_YARDS - from.x) / dx;
    let nextY = dy === 0 ? Infinity
      : (bounds.minY + (cellY + (stepY > 0 ? 1 : 0)) * CELL_YARDS - from.y) / dy;
    if (nextX < 0) nextX = 0;
    if (nextY < 0) nextY = 0;

    for (;;) {
      const entered = Math.min(nextX, nextY);
      const cell = cellY * this.#cellsX + cellX;
      const end = offsets[cell + 1]!;
      for (let entry = offsets[cell]!; entry < end; entry++) consider(items[entry]!);
      // Nothing past this boundary can beat what is already in hand, because a triangle filed in a
      // later cell and not in this one cannot be crossed before the line leaves this one.
      if (best !== undefined && best <= entered) break;
      if (cellX === lastX && cellY === lastY) break;
      if (entered > limit) break;
      if (nextX <= nextY) {
        if (cellX === lastX) break;
        cellX += stepX;
        nextX += perCellX;
      } else {
        if (cellY === lastY) break;
        cellY += stepY;
        nextY += perCellY;
      }
    }
    return best === undefined ? undefined : { t: best, triangle: bestTriangle };
  }

  /** The group run a triangle came from, or undefined when the mesh carries no run table. */
  runAt(triangle: number): CollisionRun | undefined {
    const runs = this.runs;
    if (runs.length === 0) return undefined;
    // Walked backwards because the runs are few and the answer is usually the last one entered.
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      if (triangle >= run.first) return run;
    }
    return undefined;
  }

  /** The flags of the group a triangle came from, or undefined when the mesh carries no runs. */
  flagsAt(triangle: number): number | undefined {
    return this.runAt(triangle)?.flags;
  }

  get triangleCount(): number {
    return this.triangles.length / 9;
  }
}

const EMPTY = new Int32Array(0);

/** Which cell of a grid starting at `min` a coordinate falls in, clamped to the grid's edge. */
function gridCell(value: number, min: number, cells: number): number {
  return Math.max(0, Math.min(cells - 1, Math.floor((value - min) / CELL_YARDS)));
}

/**
 * Where a segment crosses a triangle, as a fraction of its own length, or nothing.
 *
 * Moller-Trumbore, and deliberately without a back-face cull: vmap winding is not consistent —
 * `uprightness` already takes the absolute value of the normal for the same reason — so culling by
 * the sign of the determinant would make half the walls in the world one-way glass.
 *
 * `verticalHit` is not this and cannot become it. It solves the barycentric coordinates of a point
 * in the triangle's *projection* onto xy and interpolates z, which is the right and much cheaper
 * answer for a plumb line and is no answer at all for a slanted one — it rejects every triangle
 * standing edge-on, which is to say every wall.
 */
export function segmentHit(triangles: Float32Array, triangle: number, from: Vector3, to: Vector3): number | undefined {
  const base = triangle * 9;
  const ax = triangles[base]!;
  const ay = triangles[base + 1]!;
  const az = triangles[base + 2]!;
  const e1x = triangles[base + 3]! - ax;
  const e1y = triangles[base + 4]! - ay;
  const e1z = triangles[base + 5]! - az;
  const e2x = triangles[base + 6]! - ax;
  const e2y = triangles[base + 7]! - ay;
  const e2z = triangles[base + 8]! - az;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;

  // d x e2
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const determinant = e1x * hx + e1y * hy + e1z * hz;
  // Parallel to the plane. The same 1e-9 `verticalHit` uses, and for the same reason: below it the
  // reciprocal is noise rather than a coordinate.
  if (Math.abs(determinant) < 1e-9) return undefined;
  const inverse = 1 / determinant;

  const sx = from.x - ax;
  const sy = from.y - ay;
  const sz = from.z - az;
  const u = inverse * (sx * hx + sy * hy + sz * hz);
  if (u < -1e-6 || u > 1 + 1e-6) return undefined;

  // s x e1
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = inverse * (dx * qx + dy * qy + dz * qz);
  if (v < -1e-6 || u + v > 1 + 1e-6) return undefined;

  const t = inverse * (e2x * qx + e2y * qy + e2z * qz);
  // A segment, not a ray: past the far end is a miss, not a distant hit.
  return t < 0 || t > 1 ? undefined : t;
}

/** Where a vertical line through (x, y) crosses a triangle, or undefined when it misses it. */
export function verticalHit(triangles: Float32Array, triangle: number, x: number, y: number): number | undefined {
  const base = triangle * 9;
  const ax = triangles[base]!;
  const ay = triangles[base + 1]!;
  const az = triangles[base + 2]!;
  const bx = triangles[base + 3]!;
  const by = triangles[base + 4]!;
  const bz = triangles[base + 5]!;
  const cx = triangles[base + 6]!;
  const cy = triangles[base + 7]!;
  const cz = triangles[base + 8]!;

  const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  // Edge-on to the vertical: a wall has no "height at this point" to report.
  if (Math.abs(determinant) < 1e-9) return undefined;
  const first = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant;
  if (first < -1e-6 || first > 1 + 1e-6) return undefined;
  const second = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant;
  if (second < -1e-6) return undefined;
  const third = 1 - first - second;
  if (third < -1e-6) return undefined;
  return first * az + second * bz + third * cz;
}

/** How upright a triangle is, as the size of its normal's vertical part. One is flat, zero is a wall. */
export function uprightness(triangles: Float32Array, triangle: number): number {
  const base = triangle * 9;
  const ux = triangles[base + 3]! - triangles[base]!;
  const uy = triangles[base + 4]! - triangles[base + 1]!;
  const uz = triangles[base + 5]! - triangles[base + 2]!;
  const vx = triangles[base + 6]! - triangles[base]!;
  const vy = triangles[base + 7]! - triangles[base + 1]!;
  const vz = triangles[base + 8]! - triangles[base + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  // Absolute, because vmap triangles are not wound consistently and a floor seen from below is
  // still a floor. Which side of it the character is on is decided by the height, not the winding.
  return length < 1e-12 ? 0 : Math.abs(nz) / length;
}

/** Whether a triangle is flat enough to stand on, by the same angle the terrain uses. */
export function isFloorTriangle(triangles: Float32Array, triangle: number): boolean {
  return uprightness(triangles, triangle) >= WALKABLE_NORMAL_Z;
}

/**
 * The point of a triangle nearest to a point, written out from the standard routine.
 *
 * Returned through a scratch object rather than a fresh one: this runs over every wall triangle
 * near the character several times a frame, and the garbage would be the expensive part.
 */
const closest: Vector3 = { x: 0, y: 0, z: 0 };
export function closestPointOnTriangle(triangles: Float32Array, triangle: number, px: number, py: number, pz: number): Vector3 {
  const base = triangle * 9;
  const ax = triangles[base]!;
  const ay = triangles[base + 1]!;
  const az = triangles[base + 2]!;
  const bx = triangles[base + 3]!;
  const by = triangles[base + 4]!;
  const bz = triangles[base + 5]!;
  const cx = triangles[base + 6]!;
  const cy = triangles[base + 7]!;
  const cz = triangles[base + 8]!;

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return assign(ax, ay, az);

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return assign(bx, by, bz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return assign(ax + abx * t, ay + aby * t, az + abz * t);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return assign(cx, cy, cz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return assign(ax + acx * t, ay + acy * t, az + acz * t);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return assign(bx + (cx - bx) * t, by + (cy - by) * t, bz + (cz - bz) * t);
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return assign(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

function assign(x: number, y: number, z: number): Vector3 {
  closest.x = x;
  closest.y = y;
  closest.z = z;
  return closest;
}

/** How many times the character is pushed out before the frame gives up: a corner needs two. */
const RESOLVE_PASSES = 4;
/** How far into a wall the character may be before it is worth moving them at all. */
const PENETRATION_EPSILON = 1e-4;
/** Floors closer than this are the same surface for selection; identity breaks the tie. */
export const COLLISION_FLOOR_TIE_EPSILON = 1e-4;

/** A floor together with the exact placement, triangle and authored group it came from. */
export interface CollisionFloorHit {
  z: number;
  flags: number | undefined;
  /** The stable instance supplied to `CollisionWorld.set` — its key, unless it was given one. */
  instanceId: number;
  /**
   * The triangle's index within the mesh that was hit. Since collision is held a group at a time
   * that is an index within the group, which is the only place it ever meant anything stable: a
   * merged placement's index moved every time a nearer group joined the mesh.
   */
  triangle: number;
  /** Present on meshes built from a grouped collision model. */
  groupIndex: number | undefined;
  /** Present on WMO meshes written by a current vmap extractor/gateway path. */
  groupId: number | undefined;
}

/**
 * Whether `candidate` wins a floor selection over `current`.
 *
 * Height is authoritative. Co-planar (or float-noise-close) overlaps are ordered by stable source
 * identity rather than `Map` insertion order, then by authored group and triangle. This makes the
 * same camera point answer identically while asynchronous tiles and model groups arrive in a
 * different order.
 */
export function collisionFloorHitPrecedes(
  candidate: CollisionFloorHit,
  current: CollisionFloorHit | undefined,
  epsilon = COLLISION_FLOOR_TIE_EPSILON,
): boolean {
  if (!current) return true;
  // Quantisation makes the comparison a total order. A pairwise `abs(a-b) <= epsilon` relation is
  // not transitive, so three nearly co-planar floors could otherwise still depend on visit order.
  const quantum = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : COLLISION_FLOOR_TIE_EPSILON;
  const candidateHeight = Math.round(candidate.z / quantum);
  const currentHeight = Math.round(current.z / quantum);
  if (candidateHeight !== currentHeight) return candidateHeight > currentHeight;
  // Unrolled lexicographic comparison over the same four keys the arrays below used to hold:
  // this runs per candidate triangle, where two array literals each were pure garbage.
  if (candidate.instanceId !== current.instanceId) return candidate.instanceId < current.instanceId;
  const candidateGroupId = candidate.groupId ?? Number.MAX_SAFE_INTEGER;
  const currentGroupId = current.groupId ?? Number.MAX_SAFE_INTEGER;
  if (candidateGroupId !== currentGroupId) return candidateGroupId < currentGroupId;
  const candidateGroupIndex = candidate.groupIndex ?? Number.MAX_SAFE_INTEGER;
  const currentGroupIndex = current.groupIndex ?? Number.MAX_SAFE_INTEGER;
  if (candidateGroupIndex !== currentGroupIndex) return candidateGroupIndex < currentGroupIndex;
  if (candidate.triangle !== current.triangle) return candidate.triangle < current.triangle;
  return false;
}

/**
 * The identity half of {@link collisionFloorHitPrecedes}, over fields rather than objects.
 *
 * Split out so the floor query can reject tied losers without materialising them: same four
 * keys, same order, same `MAX_SAFE_INTEGER` normalisation for absent groups.
 */
function floorHitTiePrecedes(
  candidateInstanceId: number,
  candidateGroupId: number | undefined,
  candidateGroupIndex: number | undefined,
  candidateTriangle: number,
  currentInstanceId: number,
  currentGroupId: number | undefined,
  currentGroupIndex: number | undefined,
  currentTriangle: number,
): boolean {
  if (candidateInstanceId !== currentInstanceId) return candidateInstanceId < currentInstanceId;
  const candidateId = candidateGroupId ?? Number.MAX_SAFE_INTEGER;
  const currentId = currentGroupId ?? Number.MAX_SAFE_INTEGER;
  if (candidateId !== currentId) return candidateId < currentId;
  const candidateIndex = candidateGroupIndex ?? Number.MAX_SAFE_INTEGER;
  const currentIndex = currentGroupIndex ?? Number.MAX_SAFE_INTEGER;
  if (candidateIndex !== currentIndex) return candidateIndex < currentIndex;
  if (candidateTriangle !== currentTriangle) return candidateTriangle < currentTriangle;
  return false;
}

/** One stored mesh, the instance its hits report, and that instance's height. */
interface WorldEntry {
  readonly mesh: CollisionMesh;
  readonly instanceId: number;
  readonly height: InstanceHeight;
}

/** The heights every mesh of one instance spans together, shared by all of their entries. */
interface InstanceHeight {
  minZ: number;
  maxZ: number;
  readonly meshes: CollisionMesh[];
}

/**
 * Everything solid near the player, and the two questions asked of it.
 *
 * Instances rather than one merged soup, because the set changes as the player walks and rebuilding
 * a city's worth of triangles every few yards would cost more than the queries do. Each one keeps
 * its own grid and its own box, and the box is the whole of the broad phase — a few hundred
 * buildings and doodads is a list short enough to walk.
 *
 * A mesh is stored under its own key and answers for an *instance*, which is the same number
 * unless `set` was told otherwise. The two come apart for a building held a group at a time: each
 * of Stormwind's rooms is its own mesh with its own key, and every one of them reports the city's
 * spawn id, so a floor hit still names the placement it stands in and the tie-break between two
 * co-planar floors is still placement, then authored group, then triangle.
 */
export class CollisionWorld {
  /** Each mesh with the instance its hits report, kept together so a query never looks one up. */
  readonly #meshes = new Map<number, WorldEntry>();
  readonly #heights = new Map<number, InstanceHeight>();

  get size(): number {
    return this.#meshes.size;
  }

  set(id: number, mesh: CollisionMesh, instanceId: number = id): void {
    const previous = this.#meshes.get(id);
    if (previous) this.#leave(previous);
    let height = this.#heights.get(instanceId);
    if (!height) {
      height = { minZ: Infinity, maxZ: -Infinity, meshes: [] };
      this.#heights.set(instanceId, height);
    }
    height.meshes.push(mesh);
    height.minZ = Math.min(height.minZ, mesh.bounds.minZ);
    height.maxZ = Math.max(height.maxZ, mesh.bounds.maxZ);
    this.#meshes.set(id, { mesh, instanceId, height });
  }

  delete(id: number): void {
    const entry = this.#meshes.get(id);
    if (!entry) return;
    this.#meshes.delete(id);
    this.#leave(entry);
  }

  #leave(entry: WorldEntry): void {
    const height = entry.height;
    const index = height.meshes.indexOf(entry.mesh);
    if (index >= 0) height.meshes.splice(index, 1);
    if (height.meshes.length === 0) {
      if (this.#heights.get(entry.instanceId) === height) this.#heights.delete(entry.instanceId);
      return;
    }
    height.minZ = Infinity;
    height.maxZ = -Infinity;
    for (const mesh of height.meshes) {
      height.minZ = Math.min(height.minZ, mesh.bounds.minZ);
      height.maxZ = Math.max(height.maxZ, mesh.bounds.maxZ);
    }
  }

  has(id: number): boolean {
    return this.#meshes.has(id);
  }

  get(id: number): CollisionMesh | undefined {
    return this.#meshes.get(id)?.mesh;
  }

  /** The instance a stored mesh's hits report, or undefined when nothing is stored under `id`. */
  instanceOf(id: number): number | undefined {
    return this.#meshes.get(id)?.instanceId;
  }

  clear(): void {
    this.#meshes.clear();
    this.#heights.clear();
  }

  ids(): Iterable<number> {
    return this.#meshes.keys();
  }

  /**
   * The first thing a straight line runs into, or nothing when it runs into nothing.
   *
   * The one question this class could not answer, and three things want it: whether a target can
   * be seen from the camera, how far the camera may orbit before a wall is between it and the
   * character, and later how deep the water is under a point on a canal.
   *
   * `t` is a fraction of the segment, so the world point is `from + (to - from) * t` and a caller
   * comparing two hits never has to take a square root. `flags` are the `MOGP` flags of whatever
   * was struck, and `undefined` there means the mesh carried no group table — not that nothing
   * was hit, which is what an absent return value means.
   *
   * **What this cannot see.** The ground. `CollisionWorld` holds placed models and nothing else;
   * the heightfield lives in `Terrain` and is asked separately. A line across an empty field
   * meets nothing here however far it sinks.
   */
  firstHit(from: Vector3, to: Vector3): { t: number; flags: number | undefined } | undefined {
    let best: number | undefined;
    let flags: number | undefined;
    for (const { mesh } of this.#meshes.values()) {
      // Every mesh is offered the best distance so far, so a building behind a nearer one stops
      // its walk at the first cell rather than searching itself out in full.
      const hit = mesh.firstHit(from, to, best ?? 1);
      if (!hit || (best !== undefined && hit.t >= best)) continue;
      best = hit.t;
      flags = mesh.flagsAt(hit.triangle);
    }
    return best === undefined ? undefined : { t: best, flags };
  }

  /**
   * The highest thing that can be stood on at this point, between two heights.
   *
   * This is what puts a player on the first floor of a tavern rather than on the grass underneath
   * it: the terrain says one height and the building says another, and the one nearer the
   * character's feet from above is the floor. Only triangles flat enough to stand on count, so a
   * wall passing through the column is not a step.
   */
  floorUnder(x: number, y: number, fromZ: number, minZ: number): number | undefined {
    return this.floorInfoUnder(x, y, fromZ, minZ)?.z;
  }

  /**
   * The full provenance of the highest walkable collision floor under a point.
   *
   * `accept` is evaluated before floors compete. A WMO locator can therefore exclude M2s or stale
   * placements and still find the next valid floor, instead of filtering the overall winner and
   * accidentally returning no answer.
   */
  floorHitUnder(
    x: number,
    y: number,
    fromZ: number,
    minZ: number,
    accept?: (hit: CollisionFloorHit) => boolean,
  ): CollisionFloorHit | undefined {
    // Best-hit fields as locals: the loop below used to allocate one hit object per passing
    // triangle (plus two tiebreak arrays in the comparison), and this runs per physics substep,
    // per camera query and per loop query — thousands of contenders a frame in a city. Only a
    // contender that can actually win is ever materialised; `accept` therefore sees winners and
    // tied contenders, never hopeless losers, so it must stay a pure predicate (all callers pass
    // one — the WMO locator reads fields and nothing else).
    let hasBest = false;
    let bestQuantum = 0;
    let bestInstanceId = 0;
    let bestGroupId: number | undefined;
    let bestGroupIndex: number | undefined;
    let bestTriangle = 0;
    let bestZ = 0;
    let bestFlags: number | undefined;
    for (const { mesh, instanceId } of this.#meshes.values()) {
      const bounds = mesh.bounds;
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      if (bounds.maxZ < minZ || bounds.minZ > fromZ) continue;
      const candidates = mesh.candidates(x, y, x, y);
      const count = candidates ? candidates.length : mesh.triangleCount;
      for (let entry = 0; entry < count; entry++) {
        const triangle = candidates ? candidates[entry]! : entry;
        const z = verticalHit(mesh.triangles, triangle, x, y);
        if (z === undefined || !Number.isFinite(z) || z > fromZ || z < minZ) continue;
        if (!isFloorTriangle(mesh.triangles, triangle)) continue;
        const candidateQuantum = Math.round(z / COLLISION_FLOOR_TIE_EPSILON);
        let run: CollisionRun | undefined;
        if (hasBest) {
          if (candidateQuantum < bestQuantum) continue;
          if (candidateQuantum === bestQuantum) {
            run = mesh.runAt(triangle);
            if (!floorHitTiePrecedes(
              instanceId, run?.groupId, run?.groupIndex, triangle,
              bestInstanceId, bestGroupId, bestGroupIndex, bestTriangle,
            )) continue;
          }
        }
        run ??= mesh.runAt(triangle);
        const hit: CollisionFloorHit = {
          z,
          flags: run?.flags,
          instanceId,
          triangle,
          groupIndex: run?.groupIndex,
          groupId: run?.groupId,
        };
        if (accept && !accept(hit)) continue;
        hasBest = true;
        bestQuantum = candidateQuantum;
        bestInstanceId = instanceId;
        bestGroupId = run?.groupId;
        bestGroupIndex = run?.groupIndex;
        bestTriangle = triangle;
        bestZ = z;
        bestFlags = run?.flags;
      }
    }
    if (!hasBest) return undefined;
    return {
      z: bestZ,
      flags: bestFlags,
      instanceId: bestInstanceId,
      triangle: bestTriangle,
      groupIndex: bestGroupIndex,
      groupId: bestGroupId,
    };
  }

  /**
   * 5.12: the lowest flat surface over a point between two heights — the ceiling a rising head
   * meets. The same triangles as `floorHitUnder` (a floor seen from below is the storey's ceiling)
   * and the same column walk, asked for the minimum above rather than the maximum below. Only the
   * height is needed, so nothing is materialised.
   */
  ceilingAbove(x: number, y: number, fromZ: number, toZ: number): number | undefined {
    let best = Infinity;
    for (const { mesh } of this.#meshes.values()) {
      const bounds = mesh.bounds;
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      if (bounds.maxZ < fromZ || bounds.minZ > toZ) continue;
      const candidates = mesh.candidates(x, y, x, y);
      const count = candidates ? candidates.length : mesh.triangleCount;
      for (let entry = 0; entry < count; entry++) {
        const triangle = candidates ? candidates[entry]! : entry;
        const z = verticalHit(mesh.triangles, triangle, x, y);
        if (z === undefined || !Number.isFinite(z) || z < fromZ || z > toZ || z >= best) continue;
        if (!isFloorTriangle(mesh.triangles, triangle)) continue;
        best = z;
      }
    }
    return best === Infinity ? undefined : best;
  }

  /**
   * The same query, and what the winning triangle belongs to.
   *
   * Kept together because they are one walk: the flags of the floor under the feet are how the
   * server decides whether a character is indoors (`Map::IsOutdoors` reads `MOGP` `0x8` off
   * exactly this triangle), and asking twice would walk the city twice.
   */
  floorInfoUnder(x: number, y: number, fromZ: number, minZ: number): { z: number; flags: number | undefined } | undefined {
    const hit = this.floorHitUnder(x, y, fromZ, minZ);
    return hit ? { z: hit.z, flags: hit.flags } : undefined;
  }

  /**
   * Whether the floor under this point is a room rather than open air.
   *
   * The rule the server uses, on the same triangle the character is standing on. The rule it
   * replaces asked whether the point was inside the axis-aligned box of any group marked indoor,
   * and in a city that is not a question about rooms: Stormwind is 276 indoor groups whose boxes
   * are whole districts up to 322 by 236 yards, so 59.4% of the city's own street surface answered
   * "indoors" and the weather was switched off over most of it.
   *
   * Nothing underneath, or a floor from a mesh that carried no flags, reads as open air — the same
   * side the old rule erred towards, and the safe one: rain in a room is a smaller wrong than a
   * city where it never rains.
   */
  indoorsAt(x: number, y: number, fromZ: number, minZ: number): boolean {
    const floor = this.floorInfoUnder(x, y, fromZ, minZ);
    if (!floor || floor.flags === undefined) return false;
    return (floor.flags & COLLISION_GROUP_OUTDOOR) === 0;
  }

  /**
   * Pushes the character out of anything it is standing inside, horizontally.
   *
   * The body is three spheres up its own axis rather than a true capsule sweep: at the speeds a
   * character moves — seven yards a second is under a eighth of a yard a frame, against a radius
   * of about four tenths — moving and then pushing out lands in the same place as sweeping, and it
   * is a great deal less to get wrong. The lowest sphere sits a step height up, so a kerb is
   * something to walk over rather than something to be stopped by.
   *
   * Only walls push. Floors are the vertical query's business, and a floor that shoved sideways
   * would slide the character off every roof it stood on.
   */
  pushOut(x: number, y: number, z: number, radius: number, bodyHeight: number, stepHeight: number): { x: number; y: number } {
    let atX = x;
    let atY = y;
    const heights = [
      Math.min(stepHeight, bodyHeight),
      bodyHeight * 0.55,
      bodyHeight * 0.95,
    ];

    for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
      let moved = false;
      for (const { mesh, height } of this.#meshes.values()) {
        const bounds = mesh.bounds;
        if (atX + radius < bounds.minX || atX - radius > bounds.maxX) continue;
        if (atY + radius < bounds.minY || atY - radius > bounds.maxY) continue;
        // By the height of the whole instance, not of this one mesh. The body's top sphere reaches
        // a little over its height, so this test is not exact, and it only ever was for a whole
        // placement: a merged building spanned every storey and was never culled here, while one
        // of its rooms on its own, starting just over the head, would be. Culled by the instance,
        // a building held a room at a time pushes exactly where it pushed when it was one mesh.
        if (height.maxZ < z || height.minZ > z + bodyHeight) continue;
        const candidates = mesh.candidates(atX - radius, atY - radius, atX + radius, atY + radius);
        const count = candidates ? candidates.length : mesh.triangleCount;
        for (let entry = 0; entry < count; entry++) {
          const triangle = candidates ? candidates[entry]! : entry;
          if (isFloorTriangle(mesh.triangles, triangle)) continue;
          // A wall whose whole height is within a step is a kerb, and a kerb is something to walk
          // up rather than something to be stopped by. Without this, the sphere in the middle of
          // the body clips the top edge of every doorstep in the world.
          const base = triangle * 9;
          const topZ = Math.max(mesh.triangles[base + 2]!, mesh.triangles[base + 5]!, mesh.triangles[base + 8]!);
          if (topZ <= z + stepHeight) continue;
          for (const height of heights) {
            const point = closestPointOnTriangle(mesh.triangles, triangle, atX, atY, z + height);
            const dx = atX - point.x;
            const dy = atY - point.y;
            const dz = z + height - point.z;
            const distance = Math.hypot(dx, dy, dz);
            if (distance >= radius) continue;
            const flat = Math.hypot(dx, dy);
            // Dead centre of a wall's plane: there is no direction to push, so the triangle's own
            // normal decides which side to come out on.
            if (flat < PENETRATION_EPSILON) {
              const away = wallNormal(mesh.triangles, triangle);
              atX += away.x * radius;
              atY += away.y * radius;
              moved = true;
              continue;
            }
            const push = radius - flat;
            if (push <= PENETRATION_EPSILON) continue;
            atX += (dx / flat) * push;
            atY += (dy / flat) * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return { x: atX, y: atY };
  }
}

const normal: Vector3 = { x: 0, y: 0, z: 0 };

/** The horizontal part of a triangle's normal, normalised. Used only to break a dead tie. */
function wallNormal(triangles: Float32Array, triangle: number): Vector3 {
  const base = triangle * 9;
  const ux = triangles[base + 3]! - triangles[base]!;
  const uy = triangles[base + 4]! - triangles[base + 1]!;
  const uz = triangles[base + 5]! - triangles[base + 2]!;
  const vx = triangles[base + 6]! - triangles[base]!;
  const vy = triangles[base + 7]! - triangles[base + 1]!;
  const vz = triangles[base + 8]! - triangles[base + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const length = Math.hypot(nx, ny);
  normal.x = length < 1e-9 ? 1 : nx / length;
  normal.y = length < 1e-9 ? 0 : ny / length;
  normal.z = 0;
  return normal;
}

/**
 * How far short of a wall the camera stops, in yards.
 *
 * It has to clear the near plane, which `buildWorldCamera` sets at 0.25: park the camera any
 * closer to the stone than that and the wall is clipped away and the room behind it is on screen —
 * the exact thing the clamp exists to prevent, arrived at from the other side.
 */
export const CAMERA_WALL_CLEARANCE = 0.45;

/**
 * How far *under* the heightfield the arm has to be hinged before the heightfield stops counting
 * as the ground, in yards. wowee's number: `pivot.z < *pivotH - 0.2f` (`camera_controller.cpp:193-197`).
 *
 * A depth of its own rather than the wall clearance, and that is the whole of it. Testing the
 * hinge with the same `ground + 0.45` the samples use fires the escape 0.65 yards early, and
 * `CAMERA_MIN_PIVOT_HEIGHT` is 0.4: a polymorphed player, a tiny display scale or a model with a
 * broken attachment table hangs the arm 0.4 above their own feet, which on open grass reads
 * "under the map" — and the terrain limit switches off on exactly the hillside it exists for.
 * Two tenths of a yard below the map is a cave, a basement or a hole; anything above it is not.
 *
 * The other half of that same shrunken player is here rather than in the escape: the ground
 * clearance the scan uses is capped by how high the hinge itself stands above the ground. Hinged
 * 0.4 above flat grass, every sample of a level boom sits below `ground + 0.45` — the hinge
 * included — so the scan cut the arm at its first sample and `advanceCameraView` floored it at
 * `CAMERA_MIN_WALL_DISTANCE`: measured, the whole 21.31-yard boom collapsed to 0.75 yards for
 * every pitch below 2.02 degrees, and snapped back to 21.31 above it. A pivot that is legitimately
 * low cannot be allowed to declare the flat ground it is standing on an obstruction; a pivot at
 * the ordinary 1.6 is nowhere near the cap and every number К1 measured is untouched.
 */
export const CAMERA_TERRAIN_ESCAPE_DEPTH = 0.2;

/** How far apart the ground is asked about along the boom, in yards. */
export const CAMERA_TERRAIN_SAMPLE_SPACING = 1.5;

/**
 * How many points along a boom of this length the ground is asked about.
 *
 * By spacing rather than by a fixed count, because the segment scanned is the boom itself and the
 * wheel makes that anything from 3.5 to 55 yards: six samples stood 4.552 yards apart at the boom
 * К1 inherited and would stand 9.17 at the wheel's maximum, so the longer the arm the more
 * hillside it marched through unasked. At a yard and a half the default 21.31-yard boom takes 15
 * samples 1.421 yards apart, near wowee's 1.25-yard march (`camera_controller.cpp:199-202`).
 */
export function boomTerrainSamples(length: number): number {
  return Math.max(1, Math.ceil(length / CAMERA_TERRAIN_SAMPLE_SPACING));
}

/** What each of the two things in the boom's way is granting, as a fraction of the whole boom. */
export interface BoomLimits {
  /** Buildings, bridges and doodads: the triangles the `CollisionWorld` holds. */
  wall: number;
  /** The heightfield the boom would sink into. */
  terrain: number;
}

/** Everything the two scans need to know beyond the segment itself. */
export interface BoomOptions {
  world?: CollisionWorld | undefined;
  heightAt?: ((x: number, y: number) => number | undefined) | undefined;
  clearance?: number;
  /** How many points along the boom the ground is asked about. `boomTerrainSamples` by default. */
  samples?: number;
}

/**
 * How much of the boom from where the arm is hinged out to where the camera wants to be is clear,
 * with the two answers kept apart.
 *
 * Fractions rather than distances, so the caller can shorten the arm it already has without
 * recomputing the direction — and so this can be tested without a camera at all.
 *
 * Two things are in the way and they are held in two different places. Buildings, bridges and
 * doodads are triangles in the `CollisionWorld`, and one segment query settles all of them at once.
 * The ground is not in there at all: the heightfield belongs to `Terrain` and the collision world
 * has never heard of it, which is why the camera could sink under an open hillside with nothing
 * anywhere to stop it. That half is sampled, because a heightfield answers about a point and not
 * about a line, and then bisected — a coarse scan alone makes the camera step in and out in
 * visible jumps as the player turns.
 *
 * They come back apart because since slice К2 they are *eased* apart, on two different time
 * constants: a wall is a plane and answers the same thing twice running, while a hillside marched
 * every yard and a half gives a new number every frame, and passing that straight through is a
 * shudder (wowee `camera_controller.cpp:1754-1773`). Which is also why the ground scan no longer
 * stops where the nearest wall is. An eased limit has to be measured on every frame, including the
 * ones where something nearer is deciding the arm: a ground limit that read «clear» for the
 * seconds the player stood behind a pillar would jump the moment they stepped out from behind it.
 * It costs the samples between the wall and the camera, which at the default boom is at most
 * fifteen heightfield lookups a frame.
 */
export function boomLimits(head: Vector3, wanted: Vector3, options: BoomOptions = {}): BoomLimits {
  const dx = wanted.x - head.x;
  const dy = wanted.y - head.y;
  const dz = wanted.z - head.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return { wall: 1, terrain: 1 };
  const clearance = options.clearance ?? CAMERA_WALL_CLEARANCE;
  const margin = clearance / length;

  let wall = 1;
  const world = options.world;
  if (world && world.size > 0) {
    const hit = world.firstHit(head, wanted);
    if (hit) wall = Math.min(wall, hit.t - margin);
  }

  let best = 1;
  const heightAt = options.heightAt;
  // How high the arm is hinged above the ground under it, which caps the clearance below. Read
  // once: the hinge does not move while the boom is scanned.
  const hinge = heightAt?.(head.x, head.y);
  // The same clearance as a wall, except where the hinge itself stands lower than that — see
  // `CAMERA_TERRAIN_ESCAPE_DEPTH`. Without the cap a 0.4-yard pivot reads its own flat ground as
  // an obstruction and the boom collapses to nothing.
  const groundClearance = hinge === undefined ? clearance : Math.min(clearance, Math.max(0, head.z - hinge));
  // Below the ground plus that clearance. Asked from the head outwards, so the first sample that
  // fails is the near edge of whatever the boom is about to enter.
  const sunk = (t: number): boolean => {
    const ground = heightAt?.(head.x + dx * t, head.y + dy * t);
    return ground !== undefined && head.z + dz * t < ground + groundClearance;
  };
  // Unless the arm is hinged under the heightfield itself, in which case the heightfield is not
  // the ground: a cave, a WMO's basement, the inside of a bridge, the hole a city is dug into.
  // Every sample along the boom then reads "sunk", the scan cuts the arm to nothing and the camera
  // is pinned against the character's back for as long as they stay indoors. wowee drops the
  // terrain limit outright in that case (camera_controller.cpp:193-197) and leaves the real
  // geometry — which a cave has, and which is in the collision world above — to do the work.
  //
  // Its own test rather than `sunk(0)`: see `CAMERA_TERRAIN_ESCAPE_DEPTH`. Being under the map is
  // a different question from being too close to it, and answering the first with the second is
  // how a shrunken player loses the terrain limit on flat ground. Both questions are asked of the
  // one `hinge` reading above rather than of two calls that could answer differently.
  const hingeUnderTerrain = hinge !== undefined && head.z < hinge - CAMERA_TERRAIN_ESCAPE_DEPTH;
  if (heightAt && !hingeUnderTerrain) {
    const samples = options.samples ?? boomTerrainSamples(length);
    let clear = 0;
    let blocked: number | undefined;
    for (let step = 1; step <= samples; step++) {
      const t = step / samples;
      if (sunk(t)) { blocked = t; break; }
      clear = t;
    }
    if (blocked !== undefined) {
      // Five halvings put the edge inside four centimetres of a 27-yard boom, which is under the
      // clearance and so cannot be seen; the scan alone puts it inside four and a half yards.
      let near = blocked;
      for (let step = 0; step < 5; step++) {
        const middle = (clear + near) / 2;
        if (sunk(middle)) near = middle;
        else clear = middle;
      }
      best = Math.min(best, clear);
    }
  }

  return { wall: Math.max(0, Math.min(1, wall)), terrain: Math.max(0, Math.min(1, best)) };
}

/**
 * The same scan as one number: what a boom may reach is the nearer of what the walls grant and
 * what the ground does.
 *
 * Nothing in `src/` calls it any more — the camera was the only caller and since К2 it eases the
 * two halves apart, so it takes them apart. It is kept because it is the surface the eleven tests
 * that predate the split are written against, and because the tests of each half check themselves
 * against it. Not dead code to be deleted, and not the loop's path to be added to.
 */
export function clearBoom(head: Vector3, wanted: Vector3, options: BoomOptions = {}): number {
  const limits = boomLimits(head, wanted, options);
  return Math.min(limits.wall, limits.terrain);
}
