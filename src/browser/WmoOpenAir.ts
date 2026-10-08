/**
 * 05.10-A7b-2 (7.03 slice 3): a building with a street, seen from the street.
 *
 * Its rooms used to stop at sixty yards (`wmoGroupsInRange`'s room leash): past it a doorway or a
 * window showed an empty hole into the sky. From open air the renderer now walks the building's
 * portals from its outside (`selectWmoPortalGroups` with `exteriorSeeds`) over the rooms within
 * {@link WMO_OPEN_AIR_ROOM_RANGE}: a room is drawn when a door or a window on screen leads to it, and
 * — with WME4 in a `visual-wmo-v25` artifact — its furniture follows it.
 *
 * Per placement this keeps the walk's scratch and the inputs of its last answer, so a frame whose
 * camera and player have not moved re-uses that answer, and a moving one walks with no allocation.
 */

import {
  createWmoPortalWalkScratch, type WmoPortalSelectionOptions, type WmoPortalWalkScratch,
} from "./WmoOcclusion.js";

/**
 * The room leash from open air. The spec names 250 (the shell's own leash) with a measurement
 * gate — +0.3 ms CPU on P-cores in Stormwind, else 150. That measurement needs the bench, which this
 * slice could not run; the conservative 150 stands until 14.24 (Stormwind from 70–150 yards).
 */
export const WMO_OPEN_AIR_ROOM_RANGE = 150;

export interface WmoOpenAirState {
  readonly scratch: WmoPortalWalkScratch;
  /** The options every walk of this placement passes, made once. */
  readonly walk: WmoPortalSelectionOptions;
  /** The rooms within the open-air leash, for the player position below. */
  candidates: readonly number[] | undefined;
  candidatesAt: { x: number; y: number; z: number };
  /** The inputs the scratch's answer was walked with. */
  readonly walkedMatrix: Float64Array;
  walkedCandidates: readonly number[] | undefined;
  walkedRooms: object | undefined;
}

export function createWmoOpenAirState(): WmoOpenAirState {
  const scratch = createWmoPortalWalkScratch();
  return {
    scratch,
    walk: { exteriorSeeds: true, scratch },
    candidates: undefined,
    candidatesAt: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
    walkedMatrix: new Float64Array(16),
    walkedCandidates: undefined,
    walkedRooms: undefined,
  };
}

/** Whether the candidate rooms must be chosen again for this player position. */
export function wmoOpenAirCandidatesStale(state: WmoOpenAirState, x: number, y: number, z: number): boolean {
  const at = state.candidatesAt;
  return state.candidates === undefined || at.x !== x || at.y !== y || at.z !== z;
}

export function wmoOpenAirNoteCandidates(
  state: WmoOpenAirState,
  candidates: readonly number[],
  x: number,
  y: number,
  z: number,
): void {
  state.candidates = candidates;
  // P1-12c: the candidates may come back as the very array of the last walk (a rest radius), but
  // the walk also seeds from the viewer, who moved — so a new position always walks again.
  state.walkedCandidates = undefined;
  state.candidatesAt.x = x;
  state.candidatesAt.y = y;
  state.candidatesAt.z = z;
}

/**
 * Whether the last walk no longer answers: other candidates, another room record to write the
 * screen rectangles into, or a model-to-clip matrix that moved (camera, placement or projection).
 */
export function wmoOpenAirWalkStale(
  state: WmoOpenAirState,
  modelToClip: ArrayLike<number>,
  rooms: object | undefined,
): boolean {
  if (state.walkedCandidates === undefined || state.walkedCandidates !== state.candidates
    || state.walkedRooms !== rooms) return true;
  const walked = state.walkedMatrix;
  for (let index = 0; index < 16; index++) if (walked[index] !== modelToClip[index]) return true;
  return false;
}

export function wmoOpenAirNoteWalk(state: WmoOpenAirState, modelToClip: ArrayLike<number>, rooms: object | undefined): void {
  state.walkedCandidates = state.candidates;
  state.walkedRooms = rooms;
  for (let index = 0; index < 16; index++) state.walkedMatrix[index] = modelToClip[index]!;
}

/**
 * 05.10 review A7b-2: the doodads of one placement in an environment snapshot — interior objects
 * whose id is -(placement · 1e6 + ordinal + 1), in snapshot order. Since slice 3 every admitted
 * building with a street and WME4 binds its doodads, once per snapshot (each tile landing); walking
 * the whole snapshot for each of them cost 1.3–3.6 ms on P-cores for 10–30 buildings over 20,000
 * objects (`.runtime/re-2026-10-05/A7b-2-review/rebind-bench.mjs`). The snapshot is grouped once.
 */
const DOODADS_BY_PLACEMENT = new WeakMap<readonly object[], Map<number, readonly object[]>>();
const NO_DOODADS: readonly never[] = Object.freeze([]);

export function wmoDoodadsOfPlacement<T extends { readonly id: number; readonly interior?: boolean | undefined }>(
  objects: readonly T[],
  placement: number,
): readonly T[] {
  let groups = DOODADS_BY_PLACEMENT.get(objects);
  if (!groups) {
    const built = new Map<number, T[]>();
    for (const object of objects) {
      if (object.interior !== true || object.id >= 0) continue;
      const parent = Math.floor((-object.id - 1) / 1_000_000);
      const list = built.get(parent);
      if (list) list.push(object);
      else built.set(parent, [object]);
    }
    groups = built;
    DOODADS_BY_PLACEMENT.set(objects, groups);
  }
  return (groups.get(placement) as readonly T[] | undefined) ?? NO_DOODADS;
}
