import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { gameObjectWithinUseReach } from "../../world/GameObjectUseReach.js";
import { fieldFloat, type WorldObjectState } from "../../world/WorldState.js";
import { PICK_CORNER_VALUES, resultGameObjectCorners } from "../RenderResults.js";
import { game } from "./Context.js";

/**
 * 4.15 (15.11): the live inputs of Wow.exe's use reach (world/GameObjectUseReach.ts) — the drawn box's corners from the
 * renderer's last record, the object's scale and facing — for the click, the cursor and the interact checks.
 */
const CORNERS = new Float64Array(PICK_CORNER_VALUES);

/** The eight world corners of the object's drawn box, or undefined while the renderer has none for it. */
export function drawnGameObjectCorners(object: WorldObjectState): Float64Array | undefined {
  return resultGameObjectCorners(game.renderer?.results, object.guid, CORNERS) ? CORNERS : undefined;
}

/**
 * Whether the player at `player` is within `object`'s use reach as Wow.exe measures it (0x00711470 → 0x0070FA70; the
 * chairs' seats, 0x00711DB0). `data` is the template's data words when known; `spellRange` a lock-opening spell's range.
 */
export function gameObjectInUseReach(
  object: WorldObjectState, type: number, player: Readonly<{ x: number; y: number; z: number }>,
  data?: readonly number[], spellRange?: number,
): boolean {
  const position = object.position;
  if (!position) return false;
  const scale = fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
  return gameObjectWithinUseReach({
    type, player, position, corners: drawnGameObjectCorners(object), spellRange,
    orientation: position.orientation, scale: scale !== undefined && scale > 0 ? scale : 1, data,
  });
}
