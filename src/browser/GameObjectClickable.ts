// 22.10 ARC-2 S3a: what the canvas overlay (SimpleScene.ts) asks of a game object before it wants its drawn
// model box — moved out of SimpleScene.ts so the renderer publishes boxes for exactly those objects
// (RenderResults.ts `gameObjectCorners`) without importing the overlay's page code.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { gameObjectMayHighlight } from "../world/GameObjectHighlight.js";
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

/**
 * 06.10-7.24-review: whether the pointer could ever land on this game object (the test `#drawGameObject` makes). 05.11 (7.60):
 * by Wow.exe's rule as far as type and flags go; the template, the factions and the quest log are asked when it points.
 */
export function clickableGameObject(object: WorldObjectState): boolean {
  return gameObjectMayHighlight(gameObjectType(object), object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0);
}

export function overlaySquaredDistance(left: WorldPosition, right: WorldPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}
