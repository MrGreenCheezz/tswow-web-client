// 05.11 (7.60): which game objects answer the pointer at all. Wow.exe's own rule, read from the code and then checked on
// the client one template at a time (F:\WowOracle\tools\go-hover.mjs, runs\go-hover-*.txt): an object that does not answer
// gets no name, no cursor and no click, and the pointer finds whatever stands behind it.
//
// The world frame's hover (0x004F8190) asks the object's virtual +0xA4, 0x0070F580. That asks the behaviour class of the
// object's type (factory 0x007143E2, slot +0xC), then, for a quest-bound object, whether the quest is in the log.
//
// * Most types: "interactable now", slot +0x18, 0x007112A0 (below). A chair and a barber chair add that the player is not
//   sitting in it (0x00711CE0, not modelled: its seats are the model's). A fishing bobber asks that it is the player's
//   channel object first (0x00712030).
// * A generic object and a capture point: their template's `highlight` word (0x0070FF80).
// * A spell focus, a duel flag, a fishing hole, an aura generator: always (0x008A1420).
// * The rest: never (0x00427A90), and so never a map object, a transport, a ship.
//
// This is what keeps lava traps, service objects and the like silent: Onyxia's 104 lava fissures are traps without a lock,
// flags 0 and all, and their model is as visible in Wow.exe as here.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { player } from "./Fields.js";
import {
  GO_FLAG_INTERACT_COND, GO_FLAG_NOT_SELECTABLE, GO_TYPE_CHAIR, GO_TYPE_FISHINGNODE, GO_TYPE_TRAP, lockIdOf,
  type GameObjectTemplate,
} from "./GameObjectProtocol.js";
import type { WorldObjectState } from "./WorldState.js";

/** Types whose behaviour class has 0x007112A0 (or the chair's and the bobber's forms of it) in slot +0x18. */
export const GO_TYPES_INTERACTABLE: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 6, 7, 9, 10, 12, 13, 17, 18, 19, 22, 23, 24, 26, 27, 32, 34,
]);
/** Slot +0xC is 0x008A1420, "mov al, 1". */
const GO_TYPES_ALWAYS = new Set([8, 16, 25, 30]);
/** Slot +0xC is 0x0070FF80: template field 0x12 (table 0x00A36F34), the `highlight` word of a generic object and a capture point. */
const HIGHLIGHT_WORD: Readonly<Record<number, number>> = { 5: 1, 29: 19 };
/** Template field 0x14, read by 0x0070F580: the quest a chest, a generic object, a spell focus or a goober is bound to. */
const QUEST_WORD: Readonly<Record<number, number>> = { 3: 8, 5: 5, 8: 4, 10: 1 };
/** Template field 0x5E, read by 0x00710410: a chair only its creator may sit in. */
const CHAIR_ONLY_CREATOR_WORD = 2;

const GO_FLAG_IN_USE = 0x01;
const GO_DYNFLAG_LO_ACTIVATE = 0x01;
const GO_DYNFLAG_LO_NO_INTERACT = 0x04;

export interface GameObjectPointerFacts {
  /** The player's character. */
  readonly self: WorldObjectState;
  readonly object: WorldObjectState;
  /** The object's type, byte 1 of GAMEOBJECT_BYTES_1. */
  readonly type: number;
  readonly template: GameObjectTemplate | undefined;
  /**
   * 0x0070EDD0 at hostile or below: the creator unit's view of the player, else GAMEOBJECT_FACTION's, else neutral. A trap
   * must be hostile to answer, anything else must not be: a door of a hostile faction is scenery.
   */
  readonly hostile: boolean;
  /** A trap a player set: whether that player can be fought, by PvP, free-for-all or a duel (0x007112D6). */
  creatorOpen(creator: WorldObjectState): boolean;
  /** The object that goes by this guid, for the setter of a trap. */
  objectOf(guid: bigint): WorldObjectState | undefined;
}

function createdBy(object: WorldObjectState): { low: number; high: number; guid: bigint } {
  const low = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_CREATED_BY.offset) ?? 0;
  const high = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_CREATED_BY.offset + 1) ?? 0;
  return { low, high, guid: (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0) };
}

/** 0x007112D6: a trap needs a lock and a hostile side, and the setter of a player's trap has to be there and open to a fight. */
function trapAnswers(facts: GameObjectPointerFacts): boolean {
  if (facts.template === undefined || lockIdOf(facts.template) <= 0 || !facts.hostile) return false;
  const { low, high, guid } = createdBy(facts.object);
  const playerGuid = (high & 0xf0000000) === 0 && (low !== 0 || (high & 0xf07fffff) !== 0);
  if (!playerGuid) return true;
  const creator = facts.objectOf(guid);
  return creator !== undefined && facts.creatorOpen(creator);
}

/**
 * 0x007112A0: the object can be dealt with now. For the types that have it this is also what gives a cursor (0x0070CE10),
 * so a click, a cursor and a name always agree.
 */
export function gameObjectInteractable(facts: GameObjectPointerFacts): boolean {
  const { self, object, type, template } = facts;
  if (!GO_TYPES_INTERACTABLE.has(type)) return false;
  // 0x00712030: a fishing bobber answers only while it is the player's channel object.
  if (type === GO_TYPE_FISHINGNODE) {
    const channel = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
    const low = self.fields.get(channel) ?? 0;
    const high = self.fields.get(channel + 1) ?? 0;
    if (((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)) !== object.guid) return false;
  }
  if (type === GO_TYPE_TRAP ? !trapAnswers(facts) : facts.hostile) return false;
  const dynamic = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset) ?? 0;
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((dynamic & GO_DYNFLAG_LO_NO_INTERACT) !== 0 || (flags & (GO_FLAG_IN_USE | GO_FLAG_NOT_SELECTABLE)) !== 0) return false;
  if ((flags & GO_FLAG_INTERACT_COND) !== 0 && (dynamic & GO_DYNFLAG_LO_ACTIVATE) === 0) return false;
  if (type === GO_TYPE_CHAIR && (template?.data[CHAIR_ONLY_CREATOR_WORD] ?? 0) !== 0 && createdBy(object).guid !== self.guid) return false;
  return true;
}

/** Whether the quest is in the player's log, in whatever state: 0x0070F5F0 walks the 25 slots and compares the id alone. */
function questInLog(self: WorldObjectState, questId: number): boolean {
  return player.quests(self).some((entry) => entry.questId === questId);
}

/** 0x0070F580: whether the pointer finds this object. */
export function gameObjectCanHighlight(facts: GameObjectPointerFacts): boolean {
  const { type, template } = facts;
  const word = HIGHLIGHT_WORD[type];
  const open = GO_TYPES_ALWAYS.has(type) || (word !== undefined ? (template?.data[word] ?? 0) !== 0 : gameObjectInteractable(facts));
  if (!open) return false;
  const questWord = QUEST_WORD[type];
  const quest = questWord === undefined ? 0 : template?.data[questWord] ?? 0;
  return quest <= 0 || questInLog(facts.self, quest);
}

/**
 * What can be said of a type with no template or player to hand, for the renderer's published boxes: a type that can never
 * answer needs no box, and neither does an object of the interactable types that is flagged out of it.
 */
export function gameObjectMayHighlight(type: number, flags: number): boolean {
  if (GO_TYPES_INTERACTABLE.has(type)) return (flags & GO_FLAG_NOT_SELECTABLE) === 0;
  return GO_TYPES_ALWAYS.has(type) || HIGHLIGHT_WORD[type] !== undefined;
}

/** A generic object or a capture point whose template says it stays silent: most of a city's collision hulls. */
export function gameObjectHighlightWordOff(type: number, template: GameObjectTemplate | undefined): boolean {
  const word = HIGHLIGHT_WORD[type];
  return word !== undefined && template !== undefined && (template.data[word] ?? 0) === 0;
}
