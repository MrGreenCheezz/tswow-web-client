// 22.10 ARC-2 S3a: what the canvas overlay (SimpleScene.ts) asks of a game object before it wants its drawn
// model box — moved out of SimpleScene.ts so the renderer publishes boxes for exactly those objects
// (RenderResults.ts `gameObjectCorners`) without importing the overlay's page code.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { GO_FLAG_NOT_SELECTABLE, interactiveGameObjectType } from "../world/GameObjectProtocol.js";
import type { WorldObjectState, WorldPosition } from "../world/WorldState.js";

/** How far from the view subject the overlay boxes and plates anything, in yards. */
export const OVERLAY_OBJECT_RANGE = 100;

/**
 * The object's type, from byte 1 of its bytes field.
 *
 * Absent means zero, not unknown: a create block writes a field only when its value is non-zero,
 * so an open door — type 0, state 0 — arrives with the whole word missing. Treating that as "no
 * type" left every open door in the world unlabelled and unclassified.
 */
export function gameObjectType(object: WorldObjectState): number {
  return ((object.fields.get(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset) ?? 0) >>> 8) & 0xff;
}

/** 06.10-7.24-review: whether a click can land on this game object (the test `#drawGameObject` makes). */
export function clickableGameObject(object: WorldObjectState): boolean {
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  return interactiveGameObjectType(gameObjectType(object)) && (flags & GO_FLAG_NOT_SELECTABLE) === 0;
}

export function overlaySquaredDistance(left: WorldPosition, right: WorldPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}
