/**
 * 15.11 (7.54): Wow.exe's hand-placed map occluders, and the shadow volumes it culls with.
 *
 * Read from the client (`.runtime/re-2026-11-15/portal8/`), not guessed:
 *
 * - Wow.exe 12340 carries a table of 62 occluder polygons in its data (0x00af0040, 40 bytes a record: map id, flags,
 *   a box `0x7ccd20` grows from zero over the points, the points and their count). Map 0 has one, a wall west of
 *   Stormwind's gate; Northrend has Dalaran's floor, roof and inner walls and a few more; 600, 603, 609, 631 and 575
 *   have some. The project ships none of it: the gateway reads the table from the user's own Wow.exe
 *   (`src/gateway/MapOccluderTable.ts`, `/dbc/occluders/<map>`) and `MapOccluderClient.ts` brings one map's records.
 *   Without them (no Wow.exe, another build, an older gateway) there are no volumes and the walk is as before.
 * - Each frame `0x79a790` calls `0x7cd850(eye, frustum, 0)`: every occluder of the current map whose box meets the
 *   frustum (`0x9839e0`, a corner on the inner side of each plane by more than -0.0194) becomes a volume
 *   (`0x7cd4e0`): one plane through the eye and each edge (`0x7912c0`: (b - a) x (c - a), normalised, through a), then
 *   the polygon's own plane through its first three points. When the eye is below the polygon's plane every plane
 *   of the volume is negated, so the eye is always outside and the volume is the shadow the polygon casts from it.
 *   (With the camera in a room the polygon is first clipped by a plane at the doors' depth, `0x7f9650`; that depth
 *   comes from `0x7905b0`, not read, so this client builds volumes only for a camera outside.)
 * - `0x7cce00`: a sphere wholly inside one volume (centre's distance plus radius not above zero for every plane) is
 *   hidden. `0x79a160` asks it for every outdoor WMO group (MOGP 0x8 or 0x10000) before the group may start a walk
 *   or be drawn; terrain chunks (`0x799d40`), liquids, doodads (`0x793060`, `0x7987a0`) ask it too.
 * - `0x7ccfa0`: a portal whose polygon (its first twelve vertices, in world space) lies wholly inside one volume is
 *   not seen (`0x7a85e0`, before the polygon is clipped and projected).
 */

/** One occluder polygon of a map: the points as x, y, z in WoW's world coordinates, and the record's flags. */
export interface MapOccluderRecord {
  readonly flags: number;
  readonly points: readonly number[];
}

/** `0x9839e0`: a box is out when its nearest corner is behind a frustum plane by more than this (0x00aa2e74). */
const FRUSTUM_SLACK = -0.019444443;

/** Shadow volumes of one frame: planes as nx, ny, nz, d (a point inside has every n.p + d <= 0). */
export interface MapOccluderVolumes {
  planes: Float64Array;
  planeCount: number;
  /** Per volume: its first plane and how many planes it has. */
  firsts: Int32Array;
  counts: Int32Array;
  volumeCount: number;
  /** Multiplies a sphere's radius into the planes' units (a placement's scale, for volumes in a model's space). */
  radiusScale: number;
}

export function createMapOccluderVolumes(): MapOccluderVolumes {
  return { planes: new Float64Array(64), planeCount: 0, firsts: new Int32Array(8), counts: new Int32Array(8), volumeCount: 0, radiusScale: 1 };
}

/** `0x7ccd20`: the record's box, grown from (0, 0, 0) over its points. Cached per record. */
const BOXES = new WeakMap<MapOccluderRecord, Float64Array>();
function occluderBox(record: MapOccluderRecord): Float64Array {
  let box = BOXES.get(record);
  if (box) return box;
  box = new Float64Array(6);
  const points = record.points;
  for (let at = 0; at < points.length; at += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = points[at + axis]!;
      if (value < box[axis]!) box[axis] = value;
      if (value > box[axis + 3]!) box[axis + 3] = value;
    }
  }
  BOXES.set(record, box);
  return box;
}

/**
 * `0x9839e0` with the six planes of `wowToClip` (column-major, WebGL clip space, WoW world coordinates in):
 * whether the box meets the frustum. The planes are normalised so the slack is in yards, as the original's are.
 */
export function mapOccluderBoxInFrustum(box: ArrayLike<number>, m: ArrayLike<number>): boolean {
  for (let plane = 0; plane < 6; plane++) {
    const row = plane >> 1;
    const sign = (plane & 1) === 0 ? 1 : -1;
    // Gribb-Hartmann: row 3 plus or minus row `row`.
    const a = m[3]! + sign * m[row]!;
    const b = m[7]! + sign * m[4 + row]!;
    const c = m[11]! + sign * m[8 + row]!;
    const d = m[15]! + sign * m[12 + row]!;
    const length = Math.hypot(a, b, c);
    if (!(length > 0)) continue;
    // The corner furthest along the plane's normal.
    const x = a >= 0 ? box[3]! : box[0]!;
    const y = b >= 0 ? box[4]! : box[1]!;
    const z = c >= 0 ? box[5]! : box[2]!;
    if ((a * x + b * y + c * z + d) / length < FRUSTUM_SLACK) return false;
  }
  return true;
}

function pushPlane(out: MapOccluderVolumes, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number): void {
  // `0x7912c0`: (b - a) x (c - a), normalised, through a.
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const inverse = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx *= inverse;
  ny *= inverse;
  nz *= inverse;
  if (out.planes.length < (out.planeCount + 1) * 4) {
    const grown = new Float64Array(out.planes.length * 2);
    grown.set(out.planes);
    out.planes = grown;
  }
  const at = out.planeCount++ * 4;
  out.planes[at] = nx;
  out.planes[at + 1] = ny;
  out.planes[at + 2] = nz;
  out.planes[at + 3] = -(nx * ax + ny * ay + nz * az);
}

/**
 * `0x7cd850(eye, frustum, 0)` and `0x7cd4e0` for a camera outside: the volumes of every occluder of the camera's map
 * (`records`) whose box meets the frustum. `eye` and `wowToClip` are in WoW world coordinates. Returns the count.
 */
export function buildMapOccluderVolumes(
  out: MapOccluderVolumes,
  records: readonly MapOccluderRecord[] | undefined,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  wowToClip: ArrayLike<number>,
): number {
  out.planeCount = 0;
  out.volumeCount = 0;
  out.radiusScale = 1;
  if (records === undefined) return 0;
  for (const record of records) {
    const points = record.points;
    const count = points.length / 3;
    if (count < 3 || !mapOccluderBoxInFrustum(occluderBox(record), wowToClip)) continue;
    const first = out.planeCount;
    for (let corner = 0; corner < count; corner++) {
      const a = corner * 3;
      const b = ((corner + 1) % count) * 3;
      pushPlane(out, points[a]!, points[a + 1]!, points[a + 2]!, points[b]!, points[b + 1]!, points[b + 2]!, eyeX, eyeY, eyeZ);
    }
    pushPlane(out, points[0]!, points[1]!, points[2]!, points[3]!, points[4]!, points[5]!, points[6]!, points[7]!, points[8]!);
    const own = (out.planeCount - 1) * 4;
    const planes = out.planes;
    if (planes[own]! * eyeX + planes[own + 1]! * eyeY + planes[own + 2]! * eyeZ + planes[own + 3]! < 0) {
      for (let at = first * 4; at < out.planeCount * 4; at++) planes[at] = -planes[at]!;
    }
    if (out.firsts.length <= out.volumeCount) {
      const firsts = new Int32Array(out.firsts.length * 2);
      firsts.set(out.firsts);
      out.firsts = firsts;
      const counts = new Int32Array(out.counts.length * 2);
      counts.set(out.counts);
      out.counts = counts;
    }
    out.firsts[out.volumeCount] = first;
    out.counts[out.volumeCount] = out.planeCount - first;
    out.volumeCount++;
  }
  return out.volumeCount;
}

/**
 * The same volumes in a model's own space: `modelToThree` (column-major) places the model in this client's world,
 * whose axes are WoW's x, z, -y. A plane's distance to a model point is then its world distance in yards, so
 * `radiusScale` is the placement's scale.
 */
export function mapOccluderVolumesInModel(source: MapOccluderVolumes, modelToThree: ArrayLike<number>, out: MapOccluderVolumes): MapOccluderVolumes {
  if (out.planes.length < source.planeCount * 4) out.planes = new Float64Array(source.planes.length);
  if (out.firsts.length < source.volumeCount) {
    out.firsts = new Int32Array(source.firsts.length);
    out.counts = new Int32Array(source.counts.length);
  }
  const m = modelToThree;
  for (let plane = 0; plane < source.planeCount; plane++) {
    const at = plane * 4;
    // WoW (x, y, z) = this client's (x, -z, y): the plane in this client's world first.
    const wx = source.planes[at]!;
    const wy = source.planes[at + 1]!;
    const wz = source.planes[at + 2]!;
    const d = source.planes[at + 3]!;
    const tx = wx;
    const ty = wz;
    const tz = -wy;
    out.planes[at] = tx * m[0]! + ty * m[1]! + tz * m[2]!;
    out.planes[at + 1] = tx * m[4]! + ty * m[5]! + tz * m[6]!;
    out.planes[at + 2] = tx * m[8]! + ty * m[9]! + tz * m[10]!;
    out.planes[at + 3] = tx * m[12]! + ty * m[13]! + tz * m[14]! + d;
  }
  out.planeCount = source.planeCount;
  for (let volume = 0; volume < source.volumeCount; volume++) {
    out.firsts[volume] = source.firsts[volume]!;
    out.counts[volume] = source.counts[volume]!;
  }
  out.volumeCount = source.volumeCount;
  out.radiusScale = source.radiusScale * Math.hypot(m[0]!, m[1]!, m[2]!);
  return out;
}

/**
 * Whether the occluders apply this frame: only with the camera over no WMO at all. Wow.exe's `0x795d40` probes 1760
 * yards down from the camera (0x00a3e6e8) for a WMO surface, rooms and streets alike. Found, it walks from that group
 * (`0x7b3b20`) and builds the volumes clipped at the doors' views' depth (`0x7cd4e0` with 0x00adf59c > 0), which this
 * client does not read; not found, it builds them whole (`0x79a790` with 0x00adf59c = 0), which is what this file
 * does. So over Dalaran's streets, as in its shops, this client builds none. `surface` is the renderer's camera
 * surface: null when known to be over no WMO, an object over one; `known` false says nothing is known this frame.
 */
export function wmoOccludersApply(known: boolean, surface: object | null | undefined): boolean {
  return known && surface === null;
}

/** What the renderer keeps for `mapOccludersForModel`: the volumes in world and in the model's space, and a matrix. */
export interface MapOccluderFrame {
  readonly world: MapOccluderVolumes;
  readonly model: MapOccluderVolumes;
  readonly wowToClip: Float64Array;
  /** What `world` was built for: the clip matrix and the eye (NaN never matches), and the records. */
  readonly builtFor: Float64Array;
  builtRecords: readonly MapOccluderRecord[] | undefined;
}

export function createMapOccluderFrame(): MapOccluderFrame {
  return {
    world: createMapOccluderVolumes(), model: createMapOccluderVolumes(), wowToClip: new Float64Array(16),
    builtFor: new Float64Array(19).fill(Number.NaN), builtRecords: undefined,
  };
}

/**
 * The volumes of `records` (the camera's map, from `MapOccluderClient`) for a camera outside, in the space of a model placed by `modelToThree`; undefined when the
 * map has none in view. The eye, `projection` and `view` (column-major) are this client's world (x, z, -y of WoW's).
 * The answer is `frame.model`, overwritten by the next call: use it before asking for another model.
 */
export function mapOccludersForModel(
  frame: MapOccluderFrame,
  records: readonly MapOccluderRecord[] | undefined,
  eye: { readonly x: number; readonly y: number; readonly z: number },
  projection: ArrayLike<number>,
  view: ArrayLike<number>,
  modelToThree: ArrayLike<number>,
): MapOccluderVolumes | undefined {
  if (records === undefined || records.length === 0) return undefined;
  const m = frame.wowToClip;
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + row]! * view[column * 4 + k]!;
      m[column * 4 + row] = sum;
    }
  }
  // WoW's y is this client's -z and WoW's z its y: the clip matrix of WoW coordinates swaps the two columns.
  for (let row = 0; row < 4; row++) {
    const y = m[4 + row]!;
    m[4 + row] = -m[8 + row]!;
    m[8 + row] = y;
  }
  // Built once for a camera: every building it walks from shares the world's volumes, each in its own space.
  const built = frame.builtFor;
  let same = built[16] === eye.x && built[17] === eye.y && built[18] === eye.z && frame.builtRecords === records;
  for (let at = 0; at < 16 && same; at++) same = built[at] === m[at];
  if (!same) {
    built.set(m);
    built[16] = eye.x;
    built[17] = eye.y;
    built[18] = eye.z;
    frame.builtRecords = records;
    buildMapOccluderVolumes(frame.world, records, eye.x, -eye.z, eye.y, m);
  }
  if (frame.world.volumeCount === 0) return undefined;
  return mapOccluderVolumesInModel(frame.world, modelToThree, frame.model);
}

/** `0x7cce00`: whether a sphere lies wholly inside one volume. */
export function mapOccludersHideSphere(volumes: MapOccluderVolumes, x: number, y: number, z: number, radius: number): boolean {
  const planes = volumes.planes;
  const r = radius * volumes.radiusScale;
  for (let volume = 0; volume < volumes.volumeCount; volume++) {
    const first = volumes.firsts[volume]!;
    const end = first + volumes.counts[volume]!;
    let plane = first;
    for (; plane < end; plane++) {
      const at = plane * 4;
      if (planes[at]! * x + planes[at + 1]! * y + planes[at + 2]! * z + planes[at + 3]! + r > 0) break;
    }
    if (plane === end) return true;
  }
  return false;
}

/** `0x7ccfa0`: whether every point (x, y, z from `start`, `count` of them) lies inside one volume. */
export function mapOccludersHidePoints(volumes: MapOccluderVolumes, points: ArrayLike<number>, start: number, count: number): boolean {
  const planes = volumes.planes;
  for (let volume = 0; volume < volumes.volumeCount; volume++) {
    const first = volumes.firsts[volume]!;
    const end = first + volumes.counts[volume]!;
    let inside = true;
    for (let point = 0; point < count && inside; point++) {
      const p = (start + point) * 3;
      const x = points[p]!;
      const y = points[p + 1]!;
      const z = points[p + 2]!;
      for (let plane = first; plane < end; plane++) {
        const at = plane * 4;
        if (planes[at]! * x + planes[at + 1]! * y + planes[at + 2]! * z + planes[at + 3]! > 0) {
          inside = false;
          break;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}
