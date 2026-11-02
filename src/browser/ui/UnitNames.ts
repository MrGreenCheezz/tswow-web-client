import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";

export const typeNames = ["object", "item", "container", "unit", "player", "gameobject", "dynamicobject", "corpse"];

/**
 * What to call a unit.
 *
 * A player is whatever the name query came back with; a creature carries its name in the metadata
 * the gateway serves, which `displayName` knows nothing about — asked for a boar it answers with a
 * guid. Anything else falls back to its type and entry, which is at least a thing to look up.
 *
 * The creature table is asked only about a creature. `OBJECT_FIELD_ENTRY` on a game object is a
 * `gameobject_template` entry and the two tables number their rows independently, so a mailbox
 * whose entry collided with a creature's used to be called by that creature's name.
 */
export function unitDisplayName(object: WorldObjectState): string {
  const world = game.world;
  if (object.typeId === 4 && world) return world.displayName(object.guid);
  // 5.24: a player's pet by the name it was given (CMSG_PET_NAME_QUERY), not its kind.
  const petName = world?.petNameOf?.(object);
  if (petName) return petName;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const name = object.typeId === 3 ? game.creatureMetadata?.get(entry)?.name : undefined;
  return name ?? `${typeNames[object.typeId ?? -1] ?? "object"} · entry ${entry}`;
}
