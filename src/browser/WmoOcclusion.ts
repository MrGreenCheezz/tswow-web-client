import type { WmoBounds, WmoPortals } from "./WmoModel.js";

export interface WmoOcclusionGroup {
  bounds: WmoBounds;
  /** False means the source bounds are retained for diagnostics but cannot authorize culling. */
  boundsValid?: boolean;
  indoor: boolean;
  exterior: boolean;
  portalStart: number;
  portalCount: number;
}

export interface WmoOcclusionPoint {
  x: number;
  y: number;
  z: number;
}

export interface WmoOcclusionSelection {
  /** The distance-selected groups left after portal traversal, in their original order. */
  groups: readonly number[];
  candidates: number;
  visible: number;
  culled: number;
  /** False means the answer is the unmodified distance fallback. */
  used: boolean;
}

interface Aperture {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const FULL_APERTURE: Aperture = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
const CLIP_W_EPSILON = 1e-4;
const CLIP_NEAR_EPSILON = 1e-4;
const APERTURE_EPSILON = 1e-6;
/** Decoded WMO graphs and their group tables are immutable for the model's lifetime. */
const GRAPH_VALIDATION = new WeakMap<WmoPortals, WeakMap<object, boolean>>();

/**
 * Conservative visibility through a WMO's authored portal graph.
 *
 * This is deliberately a refinement of the renderer's distance selection, never a replacement
 * for it. It only becomes authoritative while the camera is confidently inside a WMO group and
 * the whole graph is structurally usable. Once that is true, `viewer` conservatively adds the
 * character's room as a second seed: a third-person camera can stand in the doorway or even in a
 * wall while the character is in the adjacent room. Exterior shells and groups with no portal
 * references stay selected, because the source data cannot prove that an orphan is hidden.
 *
 * `modelToClip` is a column-major 4x4 matrix, matching `THREE.Matrix4.elements`. Keeping that tiny
 * contract here avoids a Three/WebGL dependency and makes every failure mode directly testable.
 */
export function selectWmoPortalGroups(
  groups: readonly WmoOcclusionGroup[],
  portals: WmoPortals | undefined,
  distanceGroups: readonly number[],
  camera: WmoOcclusionPoint,
  modelToClip: readonly number[],
  viewer?: WmoOcclusionPoint,
): WmoOcclusionSelection {
  const fallback = fallbackSelection(distanceGroups);
  if (!portals || groups.length === 0 || !finitePoint(camera) || !validMatrix(modelToClip)) return fallback;

  const seeds: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.boundsValid === false || !validBounds(group.bounds)) return fallback;
    // Exterior-lit faces inside an indoor MOGP group are still part of the city shell, and their
    // broad AABB commonly contains streets/courtyards. Only a wholly interior group is evidence
    // strong enough to seed culling.
    if (group.indoor && !group.exterior && contains(group.bounds, camera)) seeds.push(index);
  }
  if (seeds.length === 0) return fallback;
  // Keep the camera as the authority that enables portal culling, but never let its one containing
  // room erase the character's room. The second seed is a visibility superset and therefore fails
  // safely by drawing too much rather than making an interior disappear.
  if (viewer && finitePoint(viewer)) {
    for (const [index, group] of groups.entries()) {
      if (group.indoor && !group.exterior && contains(group.bounds, viewer) && !seeds.includes(index)) {
        seeds.push(index);
      }
    }
  }
  // Most WMO placements are observed from open air. Do not scan their vertex/reference arrays on
  // every one of those frames; only a confirmed indoor seed makes the graph relevant.
  if (!cachedValidGraph(groups, portals)) return fallback;

  const apertures = new Map<number, Aperture>();
  const queue: number[] = [];
  for (const seed of seeds) {
    apertures.set(seed, FULL_APERTURE);
    queue.push(seed);
  }
  // Apertures only grow. The cap is intentionally generous for real city graphs; reaching it is
  // evidence of unexpected data/numerics, and the safe answer is the unchanged distance set.
  const iterationLimit = Math.max(64, groups.length * 16 + portals.references.length * 4);
  let cursor = 0;
  let iterations = 0;
  while (cursor < queue.length) {
    if (++iterations > iterationLimit) return fallback;
    const sourceIndex = queue[cursor++]!;
    const source = groups[sourceIndex]!;
    const sourceAperture = apertures.get(sourceIndex)!;
    const end = source.portalStart + source.portalCount;
    for (let at = source.portalStart; at < end; at++) {
      const reference = portals.references[at]!;
      if (reference.group === sourceIndex) continue;
      const definition = portals.definitions[reference.portal]!;
      const portalAperture = projectPortal(portals.vertices, definition, modelToClip, sourceAperture);
      if (!portalAperture) continue;
      const previous = apertures.get(reference.group);
      if (!previous) {
        apertures.set(reference.group, portalAperture);
        queue.push(reference.group);
        continue;
      }
      const merged = union(previous, portalAperture);
      if (expanded(previous, merged)) {
        apertures.set(reference.group, merged);
        queue.push(reference.group);
      }
    }
  }

  const selected: number[] = [];
  for (const index of distanceGroups) {
    const group = groups[index];
    // Invalid candidates cannot come from `wmoGroupsInRange`, but preserving the whole fallback is
    // safer than silently dropping one if a different caller ever supplies a damaged index.
    if (!group) return fallback;
    if (apertures.has(index) || group.exterior || !group.indoor || group.portalCount === 0) selected.push(index);
  }
  return {
    groups: selected,
    candidates: distanceGroups.length,
    visible: selected.length,
    culled: Math.max(0, distanceGroups.length - selected.length),
    used: true,
  };
}

function fallbackSelection(groups: readonly number[]): WmoOcclusionSelection {
  return { groups, candidates: groups.length, visible: groups.length, culled: 0, used: false };
}

function cachedValidGraph(groups: readonly WmoOcclusionGroup[], portals: WmoPortals): boolean {
  let byGroups = GRAPH_VALIDATION.get(portals);
  if (!byGroups) {
    byGroups = new WeakMap<object, boolean>();
    GRAPH_VALIDATION.set(portals, byGroups);
  }
  const key: object = groups;
  if (byGroups.has(key)) return byGroups.get(key)!;
  const valid = validGraph(groups, portals);
  byGroups.set(key, valid);
  return valid;
}

function validGraph(
  groups: readonly WmoOcclusionGroup[],
  portals: WmoPortals,
): boolean {
  if (groups.length === 0 || portals.vertices.length === 0
    || portals.vertices.length % 3 !== 0 || portals.definitions.length === 0
    || portals.references.length === 0) return false;
  const vertexCount = portals.vertices.length / 3;
  for (const value of portals.vertices) if (!Number.isFinite(value)) return false;
  for (const definition of portals.definitions) {
    if (!Number.isInteger(definition.startVertex) || !Number.isInteger(definition.vertexCount)
      || definition.startVertex < 0 || definition.vertexCount < 3
      || definition.startVertex + definition.vertexCount > vertexCount) return false;
  }
  const owners = new Uint8Array(portals.references.length);
  for (const group of groups) {
    if (!Number.isInteger(group.portalStart) || !Number.isInteger(group.portalCount)
      || group.portalStart < 0 || group.portalCount < 0
      || group.portalStart + group.portalCount > portals.references.length) return false;
    for (let at = group.portalStart; at < group.portalStart + group.portalCount; at++) {
      if (owners[at] !== 0) return false;
      owners[at] = 1;
    }
  }
  if (owners.some((owner) => owner === 0)) return false;
  return portals.references.every((reference) => Number.isInteger(reference.portal)
    && Number.isInteger(reference.group) && reference.portal >= 0
    && reference.portal < portals.definitions.length && reference.group >= 0
    && reference.group < groups.length);
}

function validBounds(bounds: WmoBounds): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.minZ)
    && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY) && Number.isFinite(bounds.maxZ)
    && bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY && bounds.minZ <= bounds.maxZ;
}

function contains(bounds: WmoBounds, point: WmoOcclusionPoint): boolean {
  return point.x > bounds.minX && point.x < bounds.maxX
    && point.y > bounds.minY && point.y < bounds.maxY
    && point.z > bounds.minZ && point.z < bounds.maxZ;
}

function finitePoint(point: WmoOcclusionPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function validMatrix(matrix: readonly number[]): boolean {
  return matrix.length === 16 && matrix.every((value) => Number.isFinite(value));
}

function projectPortal(
  vertices: Float32Array,
  definition: { startVertex: number; vertexCount: number },
  matrix: readonly number[],
  parent: Aperture,
): Aperture | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let front = 0;
  let behind = 0;
  let uncertain = 0;
  let nearUncertain = false;
  for (let vertex = definition.startVertex; vertex < definition.startVertex + definition.vertexCount; vertex++) {
    const at = vertex * 3;
    const x = vertices[at]!;
    const y = vertices[at + 1]!;
    const z = vertices[at + 2]!;
    const clipX = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
    const clipY = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
    const clipZ = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
    const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
    if (!Number.isFinite(clipX) || !Number.isFinite(clipY)
      || !Number.isFinite(clipZ) || !Number.isFinite(w)) return { ...parent };
    if (w > CLIP_W_EPSILON) {
      front++;
      // In WebGL clip space the near plane is z = -w. A polygon between the eye and that plane,
      // or crossing it, can cover more of the viewport after clipping than its projected vertices
      // say, so it inherits the entire incoming aperture.
      if (clipZ <= -w + CLIP_NEAR_EPSILON) nearUncertain = true;
      const ndcX = clipX / w;
      const ndcY = clipY / w;
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return { ...parent };
      minX = Math.min(minX, ndcX);
      maxX = Math.max(maxX, ndcX);
      minY = Math.min(minY, ndcY);
      maxY = Math.max(maxY, ndcY);
    } else if (w < -CLIP_W_EPSILON) {
      behind++;
    } else {
      uncertain++;
    }
  }
  if (front === 0) return uncertain > 0 ? { ...parent } : undefined;
  // Clipping an edge that crosses the eye/near plane can cover more of the screen than either
  // projected endpoint. Widening to the incoming aperture is the conservative answer.
  if (behind > 0 || uncertain > 0 || nearUncertain) return { ...parent };
  const clipped: Aperture = {
    minX: Math.max(parent.minX, minX),
    maxX: Math.min(parent.maxX, maxX),
    minY: Math.max(parent.minY, minY),
    maxY: Math.min(parent.maxY, maxY),
  };
  return clipped.minX <= clipped.maxX && clipped.minY <= clipped.maxY ? clipped : undefined;
}

function union(left: Aperture, right: Aperture): Aperture {
  return {
    minX: Math.min(left.minX, right.minX),
    maxX: Math.max(left.maxX, right.maxX),
    minY: Math.min(left.minY, right.minY),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

function expanded(previous: Aperture, next: Aperture): boolean {
  return next.minX < previous.minX - APERTURE_EPSILON || next.maxX > previous.maxX + APERTURE_EPSILON
    || next.minY < previous.minY - APERTURE_EPSILON || next.maxY > previous.maxY + APERTURE_EPSILON;
}
