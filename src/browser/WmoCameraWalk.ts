/**
 * 02.11: which groups of a building the camera sees, by the rule recorded from Wow.exe 12340.
 *
 * Every draw call of the stock client was recorded on 145 cameras (137 over Stormwind, 8 over Silvermoon) and matched
 * to the WMOs' own batches; docs/implementation/wmo-camera-walk.ru.md has the numbers. What fits all of it:
 *
 * - The camera's group is the nearest surface straight below it, of any slope, however far down
 *   (`CollisionSource.staticWmoSurfaceState`). 127 of 128 frames with a verdict; "a room's box holds the camera", which
 *   is what the older walks ask, 105. A city's boxes are districts, stacked and overlapping.
 * - A room (no MOGP 0x8) seeds the walk alone, and nothing outdoors is drawn unless a portal leads to it. So from the
 *   Cathedral Square the real cathedral shows and `cathy_facade01`, its stand-in for far away, does not.
 * - Otherwise every outdoor group of the building seeds it. From the road the stand-in shows and the cathedral does not.
 * - Portals lead one way, from the side their reference says.
 * - MOGP 0x10000 is drawn wherever the camera is, as long as it is in the frame: Stormwind's `mountains` and
 *   `TreeFacades*`, Silvermoon's `skyline`. A group with no portals of its own has no such right: `cathy_facade01` and
 *   `bazaarfacade03` have none and are portal targets, and Silvermoon's walls have none and show only from outside.
 *
 * The frustum then judges what was chosen, as for everything else in the scene.
 *
 * 7.53: from a room the outside world is drawn exactly when the walk reaches an outdoor group on screen (70 of 71 room
 * frames, docs/implementation/wmo-camera-walk.ru.md): a door in view brings terrain back, the same room with its back to
 * the door draws none. Which of its chunks then is not settled; WebClient draws the world as usual in that case.
 */

import { WMO_GROUP_OUTDOOR, type WmoBounds, type WmoPortals } from "./WmoModel.js";
import {
  cachedValidGraph, cachedValidGroupBounds, clearWalk, createWmoPortalWalkScratch, finitePoint, publishWalk, scratchFallback,
  seedGroup, validMatrix, walkPortals,
  type WmoOcclusionGroup, type WmoOcclusionPoint, type WmoOcclusionSelection, type WmoPortalWalkScratch,
} from "./WmoOcclusion.js";

/** MOGP: drawn wherever the camera is, frustum permitting. */
export const WMO_GROUP_ALWAYS_DRAW = 0x10000;

export interface WmoCameraWalkGroup extends WmoOcclusionGroup {
  readonly flags: number;
  readonly triangleCount: number;
}

/** A room for this rule: the file says indoor (0x2000) and not open to the sky (0x8). */
export function wmoGroupIsRoom(group: Pick<WmoCameraWalkGroup, "indoor" | "flags">): boolean {
  return group.indoor && (group.flags & WMO_GROUP_OUTDOOR) === 0;
}

const OUTDOOR_GROUP = new WeakMap<object, boolean>();

/** Whether any group of the model can seed a walk from outside; a model with none keeps the older answers. */
export function wmoHasOutdoorGroup(groups: readonly Pick<WmoCameraWalkGroup, "indoor" | "flags" | "triangleCount">[]): boolean {
  let known = OUTDOOR_GROUP.get(groups);
  if (known === undefined) {
    known = groups.some((group) => group.triangleCount > 0 && !wmoGroupIsRoom(group));
    OUTDOOR_GROUP.set(groups, known);
  }
  return known;
}

const SAME_BOUNDS = 1e-3;

/**
 * The file's group a collision group stands for, or -1. The `.vmo` leaves groups out (Stormwind's 82 and 93), so its
 * index is not the file's (`WmoMinimapAlign.ts`); a kept group has the same flags and box in both.
 */
export function wmoGroupOfCollision(
  groups: readonly Pick<WmoCameraWalkGroup, "flags" | "bounds">[],
  flags: number,
  bounds: Readonly<WmoBounds>,
): number {
  for (let index = 0; index < groups.length; index++) {
    if (sameGroup(groups[index]!, flags, bounds)) return index;
  }
  return -1;
}

function sameGroup(group: Pick<WmoCameraWalkGroup, "flags" | "bounds">, flags: number, bounds: Readonly<WmoBounds>): boolean {
  if (group.flags !== flags) return false;
  const box = group.bounds;
  return Math.abs(box.minX - bounds.minX) <= SAME_BOUNDS && Math.abs(box.minY - bounds.minY) <= SAME_BOUNDS
    && Math.abs(box.minZ - bounds.minZ) <= SAME_BOUNDS && Math.abs(box.maxX - bounds.maxX) <= SAME_BOUNDS
    && Math.abs(box.maxY - bounds.maxY) <= SAME_BOUNDS && Math.abs(box.maxZ - bounds.maxZ) <= SAME_BOUNDS;
}

/** Whether another group has the flags and box of this one: `wmoGroupOfCollision` cannot tell them apart. */
export function wmoGroupHasTwin(groups: readonly Pick<WmoCameraWalkGroup, "flags" | "bounds">[], index: number): boolean {
  const group = groups[index];
  if (!group) return false;
  for (let other = 0; other < groups.length; other++) {
    if (other !== index && sameGroup(groups[other]!, group.flags, group.bounds)) return true;
  }
  return false;
}

const PLANES = new WeakMap<WmoPortals, Float32Array>();

/**
 * Each portal's plane, four floats: normal and offset. MOPT's own plane is not on the wire, and needs not be: Newell's
 * normal over MOPV's vertices has its sign on all 7,547 portals of the 716 roots that have any.
 */
export function wmoPortalPlanes(portals: WmoPortals): Float32Array {
  let planes = PLANES.get(portals);
  if (planes) return planes;
  planes = new Float32Array(portals.definitions.length * 4);
  const vertices = portals.vertices;
  for (let portal = 0; portal < portals.definitions.length; portal++) {
    const { startVertex, vertexCount } = portals.definitions[portal]!;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let corner = 0; corner < vertexCount; corner++) {
      const a = (startVertex + corner) * 3;
      const b = (startVertex + (corner + 1) % vertexCount) * 3;
      nx += (vertices[a + 1]! - vertices[b + 1]!) * (vertices[a + 2]! + vertices[b + 2]!);
      ny += (vertices[a + 2]! - vertices[b + 2]!) * (vertices[a]! + vertices[b]!);
      nz += (vertices[a]! - vertices[b]!) * (vertices[a + 1]! + vertices[b + 1]!);
    }
    const length = Math.hypot(nx, ny, nz);
    // A degenerate polygon has no sides: an all-zero plane never turns a walk back.
    if (!(length > 1e-6)) continue;
    const first = startVertex * 3;
    planes[portal * 4] = nx / length;
    planes[portal * 4 + 1] = ny / length;
    planes[portal * 4 + 2] = nz / length;
    planes[portal * 4 + 3] = -(nx * vertices[first]! + ny * vertices[first + 1]! + nz * vertices[first + 2]!) / length;
  }
  PLANES.set(portals, planes);
  return planes;
}

const NO_GROUPS: readonly number[] = Object.freeze([]);

/**
 * The groups this camera sees. `room` is the file's group of the room below it, or -1 for a camera outside this
 * building. `used` false: the graph or the inputs cannot answer, and the caller keeps what it had.
 */
export function walkWmoFromCamera(
  groups: readonly WmoCameraWalkGroup[],
  portals: WmoPortals,
  room: number,
  camera: WmoOcclusionPoint,
  modelToClip: readonly number[],
  screenApertures: Float32Array | undefined,
  scratch: WmoPortalWalkScratch,
): WmoOcclusionSelection {
  const count = groups.length;
  if (count === 0 || !finitePoint(camera) || !validMatrix(modelToClip)
    || !cachedValidGroupBounds(groups) || !cachedValidGraph(groups, portals)) return scratchFallback(scratch, NO_GROUPS);
  clearWalk(scratch, count);
  let size = 0;
  if (room >= 0) {
    if (room >= count) return scratchFallback(scratch, NO_GROUPS);
    size = seedGroup(scratch, room, size);
  } else {
    for (let index = 0; index < count; index++) {
      if (!wmoGroupIsRoom(groups[index]!)) size = seedGroup(scratch, index, size);
    }
  }
  if (size === 0) return scratchFallback(scratch, NO_GROUPS);
  if (!walkPortals(groups, portals, modelToClip, scratch, size, { planes: wmoPortalPlanes(portals), camera })) {
    return scratchFallback(scratch, NO_GROUPS);
  }
  const picks = scratch.picks;
  const reached = scratch.reached;
  let picked = 0;
  for (let index = 0; index < count; index++) {
    const group = groups[index]!;
    if (group.triangleCount === 0 || (reached[index] !== 1 && (group.flags & WMO_GROUP_ALWAYS_DRAW) === 0)) continue;
    if (picked < picks.length) picks[picked] = index;
    else picks.push(index);
    picked++;
  }
  return publishWalk(scratch, picked, count, count, screenApertures);
}

/** Whether the walk that just ran in `scratch` came out of the building on screen. MOGP 0x10000 alone does not count. */
export function wmoWalkReachedOutside(
  groups: readonly Pick<WmoCameraWalkGroup, "indoor" | "flags">[],
  scratch: Pick<WmoPortalWalkScratch, "reached">,
): boolean {
  for (let index = 0; index < groups.length; index++) {
    if (scratch.reached[index] === 1 && !wmoGroupIsRoom(groups[index]!)) return true;
  }
  return false;
}

/**
 * Whether an environment placement belongs to a building: the building itself, or one of its doodads, whose ids are
 * -(placement * 1e6 + ordinal + 1) (`wmoDoodadsOfPlacement`). Everything else is the world outside it.
 */
export function wmoPlacementOwns(placement: number, object: { readonly id: number; readonly interior?: boolean | undefined }): boolean {
  if (object.id === placement) return true;
  return object.interior === true && object.id < 0 && Math.floor((-object.id - 1) / 1_000_000) === placement;
}

/** One placement's walk: its scratch and the inputs of the answer in it, so a still camera walks once. */
export interface WmoCameraWalkState {
  readonly scratch: WmoPortalWalkScratch;
  /** The walk's answer within the account's view distance; the renderer fills it, as the answer the frame uses. */
  readonly kept: number[];
  readonly walkedMatrix: Float64Array;
  walkedRoom: number;
  walkedRooms: object | undefined;
  walked: boolean;
  /** Whether the walk came out of the building on screen (`wmoWalkReachedOutside`). */
  reachedOutside: boolean;
}

export function createWmoCameraWalkState(): WmoCameraWalkState {
  return {
    scratch: createWmoPortalWalkScratch(),
    kept: [],
    walkedMatrix: new Float64Array(16),
    walkedRoom: -2,
    walkedRooms: undefined,
    walked: false,
    reachedOutside: false,
  };
}

/** Whether the last walk no longer answers. The matrix holds the camera, the placement and the projection. */
export function wmoCameraWalkStale(
  state: WmoCameraWalkState,
  modelToClip: ArrayLike<number>,
  room: number,
  rooms: object | undefined,
): boolean {
  if (!state.walked || state.walkedRoom !== room || state.walkedRooms !== rooms) return true;
  const walked = state.walkedMatrix;
  for (let index = 0; index < 16; index++) if (walked[index] !== modelToClip[index]) return true;
  return false;
}

export function wmoCameraWalkNote(
  state: WmoCameraWalkState,
  modelToClip: ArrayLike<number>,
  room: number,
  rooms: object | undefined,
): void {
  state.walked = true;
  state.walkedRoom = room;
  state.walkedRooms = rooms;
  for (let index = 0; index < 16; index++) state.walkedMatrix[index] = modelToClip[index]!;
}
