/**
 * 22.10 ARC-2 S3a: everything the main thread reads back from the world renderer, as one record the renderer
 * fills — at the end of every `draw` (a throwing or early-returning one included), and wherever a published
 * value changes outside a frame (`setIndoors`, `setAtmosphereEffects`, `observeFrame`, the cadence resets,
 * `clearWorldResources`). The main thread reads it through the functions below instead of calling renderer
 * getters, so between two draws it answers exactly what the renderer's state answered then.
 *
 * Plain data only, so the record can cross from a DedicatedWorker by `postMessage` later: Maps of bigint keys
 * to typed arrays or plain records, primitives, plain objects; no functions, nothing of three.js. The record
 * and its rows are reused, so a frame allocates only rows for guids it has not published before.
 */

import type { AtmosphereAudioState, AtmosphereProfile } from "./AtmosphereEffects.js";
import type { PortraitOutput } from "./PortraitTargetData.js";
import {
  CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_EYE_BODY_SHARE, CAMERA_PIVOT_BODY_SHARE,
  cameraBodyHeight,
} from "./SceneCamera.js";

/** A unit row: the drawn height (`unit.height`), the camera's pivot and eye on that body, the fill's stamp. */
export const UNIT_RESULT_HEIGHT = 0;
export const UNIT_RESULT_PIVOT = 1;
export const UNIT_RESULT_EYE = 2;
export const UNIT_RESULT_STAMP = 3;
export const UNIT_RESULT_SIZE = 4;

/** A game object row: its model box's eight world corners (x, y, z each), then the fill's stamp. */
export const PICK_CORNER_VALUES = 24;
export const PICK_RESULT_STAMP = 24;
export const PICK_RESULT_SIZE = 25;

/** One seated vehicle passenger of the renderer's last seat pass (VehiclePassengerPose.ts `place`). */
export interface SeatResult {
  /** The world-space step from the unit's own place to where its model was drawn. */
  x: number;
  y: number;
  z: number;
  /** HIDE_PASSENGER: no model while it sits there. */
  hidden: boolean;
  /** The seat pass that wrote it (`seatFrame`). */
  stamp: number;
}

export interface RenderResults {
  /** Bumped by every fill of the rows below. */
  frame: number;
  /** Every unit the renderer holds (drawn this frame or kept in range), by guid. */
  readonly units: Map<bigint, Float64Array>;
  /**
   * 06.10-7.24: the drawn model box of every game object the overlay can ask about — clickable, a model with a
   * box drawn this frame, within the overlay's 100 yards of the view subject (SimpleScene.ts).
   */
  readonly gameObjectCorners: Map<bigint, Float64Array>;
  /** 11.02-tails: the seated passengers of the last seat pass and that pass's number. */
  readonly seats: Map<bigint, SeatResult>;
  seatFrame: number;
  /** 5.33: the world camera's width over height (CameraClip.ts). */
  cameraAspect: number;
  /** How far the storm sky has rolled in, 0 to 1. */
  weatherStorm: number;
  atmosphereProfile: Readonly<AtmosphereProfile>;
  /** The atmosphere controller's audio snapshot (a copy), undefined while there is no controller. */
  atmosphereAudio: AtmosphereAudioState | undefined;
  /** The observed RAF cadence. */
  fps: number;
  /** The last `setIndoors` answer. */
  indoors: boolean;
  /** The diagnostics status line, written by `endRenderFrame` on a frame whose inputs ask for it. */
  status: string;
  /**
   * 22.10 ARC-2 S3b: the portrait canvas operations — blanks and finished readbacks — oldest first, queued until
   * the page takes them (PortraitCanvasBridge.ts `drain`, which empties the list). Unlike the rest of the record
   * these are not overwritten per frame: each is applied exactly once.
   */
  readonly portraits: PortraitOutput[];
}

export function createRenderResults(atmosphereProfile: Readonly<AtmosphereProfile>): RenderResults {
  return {
    frame: 0, units: new Map(), gameObjectCorners: new Map(), seats: new Map(), seatFrame: 0,
    cameraAspect: 1, weatherStorm: 0, atmosphereProfile, atmosphereAudio: undefined, fps: 0, indoors: false, status: "",
    portraits: [],
  };
}

/** The row for this guid, made on first use; the caller writes every value and the stamp. */
export function resultRow(rows: Map<bigint, Float64Array>, guid: bigint, size: number): Float64Array {
  let row = rows.get(guid);
  if (row === undefined) {
    row = new Float64Array(size);
    rows.set(guid, row);
  }
  return row;
}

/** Drops the rows a fill did not stamp; called only when the map holds more rows than the fill wrote. */
export function dropStaleRows(rows: Map<bigint, Float64Array>, stampAt: number, stamp: number): void {
  for (const [guid, row] of rows) if (row[stampAt] !== stamp) rows.delete(guid);
}

// ---- the main thread's reader: what the old getters answered, from the record ----------------------------

/** Was `renderer.unitHeight(guid)`: the drawn body's height, undefined for a unit the renderer does not hold. */
export function resultUnitHeight(results: RenderResults | undefined, guid: bigint): number | undefined {
  return results?.units.get(guid)?.[UNIT_RESULT_HEIGHT];
}

/**
 * Was `renderer.unitPivotHeight(guid)`. A guid it does not hold gets what `#bodyHeight` gave it: the clamped
 * constant plus a saddle and a seat lift of 0.
 */
export function resultUnitPivotHeight(results: RenderResults | undefined, guid: bigint): number | undefined {
  if (results === undefined) return undefined;
  const row = results.units.get(guid);
  return row === undefined
    ? cameraBodyHeight(undefined, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT) + 0 + 0
    : row[UNIT_RESULT_PIVOT];
}

/** Was `renderer.unitEyeHeight(guid)`. */
export function resultUnitEyeHeight(results: RenderResults | undefined, guid: bigint): number | undefined {
  if (results === undefined) return undefined;
  const row = results.units.get(guid);
  return row === undefined
    ? cameraBodyHeight(undefined, undefined, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT) + 0 + 0
    : row[UNIT_RESULT_EYE];
}

/** Was `renderer.gameObjectPickCorners(object, out)`: false (and `out` untouched) without a drawn box. */
export function resultGameObjectCorners(results: RenderResults | undefined, guid: bigint, out: Float64Array): boolean {
  const row = results?.gameObjectCorners.get(guid);
  if (row === undefined) return false;
  for (let index = 0; index < PICK_CORNER_VALUES; index++) out[index] = row[index]!;
  return true;
}
