import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { gameObjectType } from "../SimpleScene.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import {
  GO_FLAG_NOT_SELECTABLE, GO_TYPE_GUILD_BANK, GO_TYPE_MAILBOX, interactionDistance, interactiveGameObjectType,
  lockIdOf, usableByHand,
} from "../../world/GameObjectProtocol.js";
import { LOCK_KEY_ITEM, LOCK_KEY_SKILL } from "../../world/LockRules.js";
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
  { kind: "guild-bank" } | { kind: "mail" } | { kind: "use" } | { kind: "unlock"; spell: number } | undefined {
  const type = gameObjectType(object);
  if (!interactiveGameObjectType(type)) return undefined;
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((flags & GO_FLAG_NOT_SELECTABLE) !== 0) return undefined;
  const position = object.position;
  if (!position) return undefined;
  const distance = Math.hypot(position.x - player.x, position.y - player.y, position.z - player.z);
  if (distance > interactionDistance(type)) return undefined;

  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? world.gameObjectTemplate(entry, object.guid) : undefined;
  // The query owns the server's `Point` veto and confirms the type. Until it arrives there is no
  // authoritative basis for a click, so the first hover only starts the query and never guesses.
  if (!template || template.type !== type) return undefined;
  if (template?.iconName === "Point") return undefined;

  if (type === GO_TYPE_MAILBOX) return { kind: "mail" };
  if (type === GO_TYPE_GUILD_BANK) return { kind: "guild-bank" };

  // A lock decides which of the two paths this is, and a chest has nothing but a lock — it is not
  // in the server's use switch at all, so without a spell it cannot be opened by anyone.
  const lockId = template ? lockIdOf(template) : 0;
  if (lockId > 0) {
    const spell = game.locks?.spellFor(lockId, world.knownSpells.map((known) => known.id)) ?? 0;
    if (spell > 0) return { kind: "unlock", spell };
  }
  return usableByHand(type) ? { kind: "use" } : undefined;
}

/**
 * Why a lockable object the player is looking at cannot be opened — or nothing, when it can be,
 * when it is not a lock story at all, or when the template answer is still in flight.
 *
 * A vein, a herb and a chest without a known opening spell used to eat the click in silence:
 * `gameObjectAction` answers `undefined` and every caller treated that as "nothing here". The
 * server is still the authority that refuses the cast; this only names the missing piece from the
 * same `Lock.dbc` data the opener matching already reads, so the player learns the profession
 * instead of the silence.
 */
export function gameObjectLockHint(
  world: WorldClient, object: WorldObjectState, player: WorldPosition,
): string | undefined {
  if (object.typeId !== 5) return undefined;
  const type = gameObjectType(object);
  if (!interactiveGameObjectType(type)) return undefined;
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((flags & GO_FLAG_NOT_SELECTABLE) !== 0) return undefined;
  const position = object.position;
  if (!position) return undefined;
  const distance = Math.hypot(position.x - player.x, position.y - player.y, position.z - player.z);
  if (distance > interactionDistance(type)) return undefined;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (entry <= 0) return undefined;
  const template = world.gameObjectTemplate(entry, object.guid);
  if (!template || template.type !== type || template.iconName === "Point") return undefined;
  const lockId = lockIdOf(template);
  if (lockId <= 0) return undefined;
  const known = world.knownSpells.map((knownSpell) => knownSpell.id);
  if ((game.locks?.spellFor(lockId, known) ?? 0) > 0) return undefined;
  if (!game.locks || !game.locks.ready) return "Данные замков загружаются…";
  const cases = game.locks.casesOf(lockId);
  if (cases.some((entry) => entry.type === LOCK_KEY_ITEM)) return "Нужен ключ";
  const skill = cases.find((entry) => entry.type === LOCK_KEY_SKILL);
  // `LockType` the skill case names: 1 pick, 2 herb, 3 mine (`LockClient.ts` tracking reads the
  // same index). Anything else is a skill this client has no name for.
  if (skill) {
    if (skill.index === 2) return "Нужен навык: Травничество";
    if (skill.index === 3) return "Нужен навык: Горное дело";
    if (skill.index === 1) return "Нужен навык: Вскрытие замков";
    return "Нужен навык";
  }
  return cases.length > 0 ? "Нужен ключ или навык" : undefined;
}
