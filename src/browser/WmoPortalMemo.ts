/**
 * P1-12c: the indoor portal walk of one placement, skipped while its inputs are the same.
 *
 * `selectWmoPortalGroups` is a pure function of the building's groups and portal graph, the
 * candidate rooms, the camera and the viewer in model space, the model-to-clip matrix and the room
 * record its screen rectangles are written into. With the camera and the character still — a player
 * standing in a dungeon hall — it walked the same graph to the same answer every frame, building a
 * `Map`, a queue and a result each time. A placement keeps its last inputs here; when every one is
 * equal (the matrix and both points element for element, the candidates and the record by identity)
 * the last answer is the answer, and the record still holds the rectangles that walk wrote (only
 * this placement's walks write it). Any NaN compares unequal and walks again.
 */

import type { WmoOcclusionPoint, WmoOcclusionSelection } from "./WmoOcclusion.js";

export interface WmoPortalMemo {
  model: object | undefined;
  candidates: readonly number[] | undefined;
  apertures: Float32Array | undefined;
  readonly matrix: Float64Array;
  /** Camera x, y, z, then viewer x, y, z (NaN: no viewer). */
  readonly points: Float64Array;
  hasViewer: boolean;
  result: WmoOcclusionSelection | undefined;
  /** Walks skipped and walks run (tests and diagnostics). */
  reused: number;
  walked: number;
}

export function createWmoPortalMemo(): WmoPortalMemo {
  return {
    model: undefined,
    candidates: undefined,
    apertures: undefined,
    matrix: new Float64Array(16),
    points: new Float64Array(6),
    hasViewer: false,
    result: undefined,
    reused: 0,
    walked: 0,
  };
}

/** The last answer when every input equals the last walk's, else undefined (walk, then note). */
export function wmoPortalMemoAnswer(
  memo: WmoPortalMemo,
  model: object,
  candidates: readonly number[],
  camera: WmoOcclusionPoint,
  modelToClip: ArrayLike<number>,
  viewer: WmoOcclusionPoint | undefined,
  apertures: Float32Array | undefined,
): WmoOcclusionSelection | undefined {
  const result = memo.result;
  if (result === undefined || memo.model !== model || memo.candidates !== candidates
    || memo.apertures !== apertures || memo.hasViewer !== (viewer !== undefined)) return undefined;
  const points = memo.points;
  if (points[0] !== camera.x || points[1] !== camera.y || points[2] !== camera.z) return undefined;
  if (viewer !== undefined && (points[3] !== viewer.x || points[4] !== viewer.y || points[5] !== viewer.z)) return undefined;
  const matrix = memo.matrix;
  for (let index = 0; index < 16; index++) if (matrix[index] !== modelToClip[index]) return undefined;
  memo.reused++;
  return result;
}

export function wmoPortalMemoNote(
  memo: WmoPortalMemo,
  model: object,
  candidates: readonly number[],
  camera: WmoOcclusionPoint,
  modelToClip: ArrayLike<number>,
  viewer: WmoOcclusionPoint | undefined,
  apertures: Float32Array | undefined,
  result: WmoOcclusionSelection,
): void {
  memo.walked++;
  memo.model = model;
  memo.candidates = candidates;
  memo.apertures = apertures;
  memo.hasViewer = viewer !== undefined;
  const points = memo.points;
  points[0] = camera.x;
  points[1] = camera.y;
  points[2] = camera.z;
  points[3] = viewer?.x ?? Number.NaN;
  points[4] = viewer?.y ?? Number.NaN;
  points[5] = viewer?.z ?? Number.NaN;
  for (let index = 0; index < 16; index++) memo.matrix[index] = modelToClip[index]!;
  memo.result = result;
}
