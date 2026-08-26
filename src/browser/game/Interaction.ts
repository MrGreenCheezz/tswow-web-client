import { WorldClient } from "../../world/WorldClient.js";
import { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { gameObjectType } from "../SimpleScene.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import {
  GO_FLAG_NOT_SELECTABLE, interactionDistance, lockIdOf, usableByHand,
} from "../../world/GameObjectProtocol.js";
import { game } from "./Context.js";
/**
 * Whether the interact button should offer to use this object.
 *
 * The rules are the server's, and none of them are the unit flags the button used to read — those
 * are a creature's field and are zero on every game object, so the button was simply always off.
 *
 * An object whose icon is `Point` is refused before anything else is checked. One marked
 * unselectable is not meant to be clicked. Range is per type and is not five yards for everything:
 * a chair wants three, a fishing bobber a hundred. And the type has to be one the server's own use
 * handler accepts — a chest is not, because a chest is opened by casting at it, which needs
 * `Lock.dbc`.
 *
 * What clicking a game object in the world does — nothing, use it by hand, or cast a spell at its
 * lock. It is pure world state and no DOM, so both the target frame and the click handler can ask
 * without either one owning it.
 */
export function gameObjectAction(world: WorldClient, object: WorldObjectState, player: WorldPosition):
  { kind: "use" } | { kind: "unlock"; spell: number } | undefined {
  const type = gameObjectType(object);
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((flags & GO_FLAG_NOT_SELECTABLE) !== 0) return undefined;
  const position = object.position;
  if (!position) return undefined;
  const distance = Math.hypot(position.x - player.x, position.y - player.y, position.z - player.z);
  if (distance > interactionDistance(type)) return undefined;

  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? world.gameObjectTemplate(entry, object.guid) : undefined;
  if (template?.iconName === "Point") return undefined;

  // A lock decides which of the two paths this is, and a chest has nothing but a lock — it is not
  // in the server's use switch at all, so without a spell it cannot be opened by anyone.
  const lockId = template ? lockIdOf(template) : 0;
  if (lockId > 0) {
    const spell = game.locks?.spellFor(lockId, world.knownSpells.map((known) => known.id)) ?? 0;
    if (spell > 0) return { kind: "unlock", spell };
  }
  return usableByHand(type) ? { kind: "use" } : undefined;
}
