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
 *
 * `screenApertures`, when given (four floats per group), receives the screen rectangle each group
 * can be seen through when the answer is `used`: minX, maxX, minY, maxY in NDC, the whole screen
 * for a seed or an orphan, and an empty one (min > max) for a group not selected. Untouched otherwise.
 */
export function selectWmoPortalGroups(
  groups: readonly WmoOcclusionGroup[],
  portals: WmoPortals | undefined,
  distanceGroups: readonly number[],
  camera: WmoOcclusionPoint,
  modelToClip: readonly number[],
  viewer?: WmoOcclusionPoint,
  screenApertures?: Float32Array,
  options?: WmoPortalSelectionOptions, // 05.10-A7b-2 (7.03 slice 2)
): WmoOcclusionSelection {
  // 05.10-A7b-2 (7.03 slice 2): from open air, with the caller's own scratch.
  if (options?.exteriorSeeds === true && options.scratch) {
    return selectFromOpenAir(groups, portals, distanceGroups, camera, modelToClip, viewer, screenApertures, options.scratch);
  }
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
  if (screenApertures && screenApertures.length >= groups.length * 4) {
    for (let index = 0; index < groups.length; index++) {
      screenApertures[index * 4] = 1;
      screenApertures[index * 4 + 1] = -1;
      screenApertures[index * 4 + 2] = 1;
      screenApertures[index * 4 + 3] = -1;
    }
    for (const index of selected) {
      const aperture = apertures.get(index) ?? FULL_APERTURE;
      screenApertures[index * 4] = aperture.minX;
      screenApertures[index * 4 + 1] = aperture.maxX;
      screenApertures[index * 4 + 2] = aperture.minY;
      screenApertures[index * 4 + 3] = aperture.maxY;
    }
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

/**
 * 05.10-A7b-2 (7.03 slice 2): the walk from open air. Without `exteriorSeeds` (every caller before
 * it) a camera in no room answers the distance fallback, as it always has.
 */
export interface WmoPortalSelectionOptions {
  /**
   * When the camera stands in no room, start from the building's outside instead: every outdoor
   * group (`!indoor`) and every group holding exterior runs (`exterior`), seen across the whole
   * screen, plus the room the viewer stands in. A room is then drawn when a chain of portals from
   * the outside reaches it on screen — through a door, a window, an arch — which is how the stock
   * client sees into buildings from the street. The rooms whose boxes hold the camera are seeds as
   * well (05.10 review A7b-2: added to the street's, never instead of them); a building of rooms
   * alone has no street, so there the walk is exactly the indoor one.
   */
  readonly exteriorSeeds?: boolean;
  /** Required with `exteriorSeeds`: the walk's reusable state, one per placement. */
  readonly scratch?: WmoPortalWalkScratch;
}

/**
 * Everything the open-air walk writes, kept between frames so a moving camera allocates nothing.
 * The returned selection (`result`, `selected`) is this object's own and is overwritten by the
 * next walk with the same scratch.
 */
export interface WmoPortalWalkScratch {
  groupCapacity: number;
  /** Four doubles per group: the rectangle it is reached through (min > max: not reached). */
  apertures: Float64Array;
  reached: Uint8Array;
  queued: Uint8Array;
  /** A ring of group indices; a group is queued at most once at a time. */
  queue: Int32Array;
  readonly portal: Float64Array;
  /** The answer's groups; P1-12c: replaced by a new array only when their number changes. */
  selected: number[];
  /** P1-12c: where a walk picks its groups before they are compared with `selected`; never shrinks. */
  readonly picks: number[];
  readonly result: { groups: readonly number[]; candidates: number; visible: number; culled: number; used: boolean };
}

export function createWmoPortalWalkScratch(): WmoPortalWalkScratch {
  return {
    groupCapacity: 0,
    apertures: new Float64Array(0),
    reached: new Uint8Array(0),
    queued: new Uint8Array(0),
    queue: new Int32Array(0),
    portal: new Float64Array(4),
    selected: [],
    picks: [],
    result: { groups: [], candidates: 0, visible: 0, culled: 0, used: false },
  };
}

function scratchFallback(scratch: WmoPortalWalkScratch, groups: readonly number[]): WmoOcclusionSelection {
  const result = scratch.result;
  result.groups = groups;
  result.candidates = groups.length;
  result.visible = groups.length;
  result.culled = 0;
  result.used = false;
  return result;
}

/** Seeds one group across the whole screen; the ring is empty before seeding, so it starts at 0. */
function seedGroup(scratch: WmoPortalWalkScratch, index: number, size: number): number {
  scratch.apertures[index * 4] = -1;
  scratch.apertures[index * 4 + 1] = 1;
  scratch.apertures[index * 4 + 2] = -1;
  scratch.apertures[index * 4 + 3] = 1;
  scratch.reached[index] = 1;
  if (scratch.queued[index] !== 0) return size;
  scratch.queued[index] = 1;
  scratch.queue[size] = index;
  return size + 1;
}

function selectFromOpenAir(
  groups: readonly WmoOcclusionGroup[],
  portals: WmoPortals | undefined,
  distanceGroups: readonly number[],
  camera: WmoOcclusionPoint,
  modelToClip: readonly number[],
  viewer: WmoOcclusionPoint | undefined,
  screenApertures: Float32Array | undefined,
  scratch: WmoPortalWalkScratch,
): WmoOcclusionSelection {
  const count = groups.length;
  if (!portals || count === 0 || !finitePoint(camera) || !validMatrix(modelToClip)) {
    return scratchFallback(scratch, distanceGroups);
  }
  if (scratch.groupCapacity < count) {
    scratch.groupCapacity = count;
    scratch.apertures = new Float64Array(count * 4);
    scratch.reached = new Uint8Array(count);
    scratch.queued = new Uint8Array(count);
    scratch.queue = new Int32Array(count);
  }
  const { apertures, reached, queued, queue, portal } = scratch;
  reached.fill(0, 0, count);
  queued.fill(0, 0, count);
  let head = 0;
  let size = 0;
  if (!cachedValidGroupBounds(groups)) return scratchFallback(scratch, distanceGroups);
  const viewerValid = viewer !== undefined && finitePoint(viewer);
  // 05.10 review A7b-2: the street and the rooms whose boxes hold the camera or the viewer, together.
  // A room box is no proof the camera is in that room — a city's are districts (Dalaran's up to
  // 145 x 145 yards) — so it adds a seed and never takes the street's away. A building of rooms
  // alone has no street seed, and its walk is then exactly the indoor one.
  for (let index = 0; index < count; index++) {
    const group = groups[index]!;
    const room = group.indoor && !group.exterior;
    if (!room || contains(group.bounds, camera) || (viewerValid && contains(group.bounds, viewer!))) {
      size = seedGroup(scratch, index, size);
    }
  }
  if (size === 0 || !cachedValidGraph(groups, portals)) return scratchFallback(scratch, distanceGroups);

  const iterationLimit = Math.max(64, count * 16 + portals.references.length * 4);
  let iterations = 0;
  while (size > 0) {
    if (++iterations > iterationLimit) return scratchFallback(scratch, distanceGroups);
    const sourceIndex = queue[head]!;
    head = (head + 1) % count;
    size--;
    queued[sourceIndex] = 0;
    const source = groups[sourceIndex]!;
    const end = source.portalStart + source.portalCount;
    for (let at = source.portalStart; at < end; at++) {
      const reference = portals.references[at]!;
      const target = reference.group;
      if (target === sourceIndex) continue;
      const definition = portals.definitions[reference.portal]!;
      // P1-12c: the parent rectangle by its offset — doubles passed to a call that is not inlined
      // were boxed, four heap numbers per portal per walk. A target's own rectangle is written
      // below only after this projection has read its source's, so reading in place is the same.
      if (!projectPortalInto(portals.vertices, definition, modelToClip, apertures, sourceIndex * 4, portal)) continue;
      const base = target * 4;
      if (reached[target] === 0) {
        reached[target] = 1;
        apertures[base] = portal[0]!;
        apertures[base + 1] = portal[1]!;
        apertures[base + 2] = portal[2]!;
        apertures[base + 3] = portal[3]!;
      } else {
        const minX = Math.min(apertures[base]!, portal[0]!);
        const maxX = Math.max(apertures[base + 1]!, portal[1]!);
        const minY = Math.min(apertures[base + 2]!, portal[2]!);
        const maxY = Math.max(apertures[base + 3]!, portal[3]!);
        if (!(minX < apertures[base]! - APERTURE_EPSILON || maxX > apertures[base + 1]! + APERTURE_EPSILON
          || minY < apertures[base + 2]! - APERTURE_EPSILON || maxY > apertures[base + 3]! + APERTURE_EPSILON)) continue;
        apertures[base] = minX;
        apertures[base + 1] = maxX;
        apertures[base + 2] = minY;
        apertures[base + 3] = maxY;
      }
      if (queued[target] === 0) {
        queued[target] = 1;
        queue[(head + size) % count] = target;
        size++;
      }
    }
  }

  // P1-12c: picked into a buffer that never shrinks — `length = 0` dropped the backing store of the
  // answer every walk and the pushes grew it again. The answer array is kept while its contents
  // are, overwritten in place at the same length, and replaced only when the length changes.
  const picks = scratch.picks;
  let picked = 0;
  for (let at = 0; at < distanceGroups.length; at++) {
    const index = distanceGroups[at]!;
    const group = groups[index];
    if (!group) return scratchFallback(scratch, distanceGroups);
    if (reached[index] === 1 || group.exterior || !group.indoor || group.portalCount === 0) {
      if (picked < picks.length) picks[picked] = index;
      else picks.push(index);
      picked++;
    }
  }
  let selected = scratch.selected;
  if (selected.length === picked) {
    for (let at = 0; at < picked; at++) selected[at] = picks[at]!;
  } else {
    selected = scratch.selected = picks.slice(0, picked);
  }
  if (screenApertures && screenApertures.length >= count * 4) {
    for (let index = 0; index < count; index++) {
      screenApertures[index * 4] = 1;
      screenApertures[index * 4 + 1] = -1;
      screenApertures[index * 4 + 2] = 1;
      screenApertures[index * 4 + 3] = -1;
    }
    // P1-12c: indexed, and no value that is a small integer on one branch and a double on the other —
    // the iterator and the merged value were both heap objects in code the browser had not optimised.
    for (let at = 0; at < picked; at++) {
      const base = selected[at]! * 4;
      if (reached[selected[at]!] !== 1) {
        screenApertures[base] = -1;
        screenApertures[base + 1] = 1;
        screenApertures[base + 2] = -1;
        screenApertures[base + 3] = 1;
      } else {
        screenApertures[base] = apertures[base]!;
        screenApertures[base + 1] = apertures[base + 1]!;
        screenApertures[base + 2] = apertures[base + 2]!;
        screenApertures[base + 3] = apertures[base + 3]!;
      }
    }
  }
  const result = scratch.result;
  result.groups = selected;
  result.candidates = distanceGroups.length;
  result.visible = selected.length;
  result.culled = Math.max(0, distanceGroups.length - selected.length);
  result.used = true;
  return result;
}

/**
 * P1-12c: whether every group's box can be trusted, once per group table (and its length) — the
 * table is as immutable as the graph `cachedValidGraph` keys on. The open-air walk asked it of
 * every group on every walk.
 */
const BOUNDS_VALIDATION = new WeakMap<object, { readonly count: number; readonly valid: boolean }>();

function cachedValidGroupBounds(groups: readonly WmoOcclusionGroup[]): boolean {
  const known = BOUNDS_VALIDATION.get(groups);
  if (known !== undefined && known.count === groups.length) return known.valid;
  let valid = true;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.boundsValid === false || !validBounds(group.bounds)) {
      valid = false;
      break;
    }
  }
  BOUNDS_VALIDATION.set(groups, { count: groups.length, valid });
  return valid;
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
  if (matrix.length !== 16) return false;
  // P1-12c: indexed — `every` handed each element to its callback as a heap number. A hole is
  // skipped, as `every` skips it.
  for (let index = 0; index < 16; index++) {
    if (!Number.isFinite(matrix[index]) && index in matrix) return false;
  }
  return true;
}

/** 05.10-A7b-2: `projectPortalInto`'s answer for the allocating walk; doubles, as it always had. */
const PROJECTED = new Float64Array(4);
/** P1-12c: the parent rectangle of the allocating walk, in the layout `projectPortalInto` reads. */
const PARENT = new Float64Array(4);

function projectPortal(
  vertices: Float32Array,
  definition: { startVertex: number; vertexCount: number },
  matrix: readonly number[],
  parent: Aperture,
): Aperture | undefined {
  PARENT[0] = parent.minX;
  PARENT[1] = parent.maxX;
  PARENT[2] = parent.minY;
  PARENT[3] = parent.maxY;
  if (!projectPortalInto(vertices, definition, matrix, PARENT, 0, PROJECTED)) {
    return undefined;
  }
  return { minX: PROJECTED[0]!, maxX: PROJECTED[1]!, minY: PROJECTED[2]!, maxY: PROJECTED[3]! };
}

/**
 * 05.10-A7b-2: the screen rectangle a portal is seen through from a parent rectangle, written into
 * `out` (minX, maxX, minY, maxY); false when it is not seen. Conservative widening — to the whole
 * parent — wherever the projection of its corners cannot be trusted. P1-12c: the parent is the four
 * doubles of `parents` at `parentAt` (same order), so no double crosses a call and none is boxed.
 */
function projectPortalInto(
  vertices: Float32Array,
  definition: { startVertex: number; vertexCount: number },
  matrix: readonly number[],
  parents: Float64Array,
  parentAt: number,
  out: Float64Array,
): boolean {
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
    // P1-12c: `v - v === 0` is `Number.isFinite(v)` for a number, and the comparisons below are
    // `Math.min`/`Math.max` with their signed zeros; neither is a call that boxes its doubles in code
    // the browser runs unoptimised (the portal walk sat in its middle tier).
    if (!(clipX - clipX === 0) || !(clipY - clipY === 0)
      || !(clipZ - clipZ === 0) || !(w - w === 0)) return copyAperture(out, parents, parentAt);
    if (w > CLIP_W_EPSILON) {
      front++;
      // In WebGL clip space the near plane is z = -w. A polygon between the eye and that plane,
      // or crossing it, can cover more of the viewport after clipping than its projected vertices
      // say, so it inherits the entire incoming aperture.
      if (clipZ <= -w + CLIP_NEAR_EPSILON) nearUncertain = true;
      const ndcX = clipX / w;
      const ndcY = clipY / w;
      if (!(ndcX - ndcX === 0) || !(ndcY - ndcY === 0)) return copyAperture(out, parents, parentAt);
      // Both finite here and the bounds never NaN; a zero meeting a zero keeps Math.min's -0 / max's +0.
      if (ndcX < minX || (ndcX === 0 && minX === 0 && 1 / ndcX < 0)) minX = ndcX;
      if (ndcX > maxX || (ndcX === 0 && maxX === 0 && 1 / ndcX > 0)) maxX = ndcX;
      if (ndcY < minY || (ndcY === 0 && minY === 0 && 1 / ndcY < 0)) minY = ndcY;
      if (ndcY > maxY || (ndcY === 0 && maxY === 0 && 1 / ndcY > 0)) maxY = ndcY;
    } else if (w < -CLIP_W_EPSILON) {
      behind++;
    } else {
      uncertain++;
    }
  }
  if (front === 0) return uncertain > 0 ? copyAperture(out, parents, parentAt) : false;
  // Clipping an edge that crosses the eye/near plane can cover more of the screen than either
  // projected endpoint. Widening to the incoming aperture is the conservative answer.
  if (behind > 0 || uncertain > 0 || nearUncertain) return copyAperture(out, parents, parentAt);
  const clippedMinX = Math.max(parents[parentAt]!, minX);
  const clippedMaxX = Math.min(parents[parentAt + 1]!, maxX);
  const clippedMinY = Math.max(parents[parentAt + 2]!, minY);
  const clippedMaxY = Math.min(parents[parentAt + 3]!, maxY);
  if (!(clippedMinX <= clippedMaxX && clippedMinY <= clippedMaxY)) return false;
  out[0] = clippedMinX;
  out[1] = clippedMaxX;
  out[2] = clippedMinY;
  out[3] = clippedMaxY;
  return true;
}

/** P1-12c: widening to the whole parent — four doubles copied between typed arrays. */
function copyAperture(out: Float64Array, parents: Float64Array, parentAt: number): true {
  out[0] = parents[parentAt]!;
  out[1] = parents[parentAt + 1]!;
  out[2] = parents[parentAt + 2]!;
  out[3] = parents[parentAt + 3]!;
  return true;
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
