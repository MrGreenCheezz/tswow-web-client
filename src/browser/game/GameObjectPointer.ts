// 05.11 (7.60): world/GameObjectHighlight.ts against the live world: which game object the pointer may find.

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_HOSTILE } from "../../world/FactionRules.js";
import { gameObjectCanHighlight, gameObjectHighlightWordOff } from "../../world/GameObjectHighlight.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { gameObjectType } from "../GameObjectClickable.js";
import { game } from "./Context.js";
import { canAttackUnit, unitReactionToPlayer } from "./Targeting.js";

/**
 * 0x0070EDD0: the creator unit's view of the player while the unit is around, else the view of GAMEOBJECT_FACTION (0x0071F770, the
 * rule of {@link unitReactionToPlayer} over that template), else neutral.
 */
export function gameObjectHostileToPlayer(object: WorldObjectState): boolean {
  const created = UPDATE_FIELDS.OBJECT_FIELD_CREATED_BY.offset;
  const guid = (BigInt((object.fields.get(created + 1) ?? 0) >>> 0) << 32n) | BigInt((object.fields.get(created) ?? 0) >>> 0);
  const creator = guid === 0n ? undefined : game.world?.state.objects.get(guid);
  if (creator !== undefined && (creator.typeId === 3 || creator.typeId === 4)) return unitReactionToPlayer(creator) === REACTION_HOSTILE;
  const faction = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FACTION.offset) ?? 0;
  if (faction === 0) return false;
  // The reaction rules read a unit's template word and nothing else of the object they are given.
  const view: WorldObjectState = { ...object, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, faction]]) };
  return unitReactionToPlayer(view) === REACTION_HOSTILE;
}

/**
 * Wow.exe's answer for the object under the pointer. An object whose template is still on its way does answer, so the hover
 * goes on to wait for the template and asks again (Controls.ts); the query starts here, as it would for the name.
 */
export function gameObjectAnswersPointer(object: WorldObjectState): boolean {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  if (!world || !self) return false;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? world.gameObjectTemplate(entry, object.guid) : undefined;
  if (template === undefined && entry > 0 && !world.gameObjectTemplates.has(entry)) return true;
  return gameObjectCanHighlight({
    self, object, type: gameObjectType(object), template,
    hostile: gameObjectHostileToPlayer(object),
    creatorOpen: canAttackUnit,
    objectOf: (guid) => world.state.objects.get(guid),
  });
}

/**
 * Asked per frame of each object in range: only a generic object or a capture point needs its template for this, and most generic
 * objects drop out on it. The first sight of one asks the server, as Wow.exe does for every object it creates.
 */
export function gameObjectBoxWanted(object: WorldObjectState): boolean {
  const type = gameObjectType(object);
  if (type !== 5 && type !== 29) return true;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? game.world?.gameObjectTemplate(entry, object.guid) : undefined;
  return !gameObjectHighlightWordOff(type, template);
}
