import type { Quat } from "../world/GameObjectRotation.js";

/**
 * 11.01 (15.11): the click box of a lift car its TransportRotation.dbc keys turn (0x0070dc10). Wow.exe draws the car with
 * that rotation and hit-tests the model it draws, so its box turns with it; the overlay's box (GameObjectPickBox.ts) was
 * placed with the spawn's rotation, and a car upside down on its way up kept a box the right way up.
 *
 * `keepPathRotation` keeps the rotation of this frame on the renderer's game object (`pathRotation`), reusing the one
 * object it holds, and when it changed makes the published box be derived again: the row key (RenderResultRows.ts
 * `PickRowKey`) watches the drawn position, scale and spawn rotation, and a car can turn on the spot.
 */
export function keepPathRotation(kept: Quat | undefined, rotation: Quat | undefined,
  pickKey: { x: number } | undefined): Quat | undefined {
  if (rotation === undefined) {
    if (kept !== undefined && pickKey !== undefined) pickKey.x = Number.NaN;
    return undefined;
  }
  if (kept !== undefined && kept.x === rotation.x && kept.y === rotation.y && kept.z === rotation.z && kept.w === rotation.w) return kept;
  const out = kept ?? { x: 0, y: 0, z: 0, w: 1 };
  copyQuat(rotation, out);
  // A key that no longer matches anything: the next fill derives the box again (NaN equals nothing).
  if (pickKey !== undefined) pickKey.x = Number.NaN;
  return out;
}

export function copyQuat(from: Quat, to: Quat): Quat {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.w = from.w;
  return to;
}
