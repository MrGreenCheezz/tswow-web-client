import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_NEUTRAL } from "../../world/FactionRules.js";
import { isLootable, unit } from "../../world/Fields.js";
import {
  GO_TYPE_BARBER_CHAIR, GO_TYPE_CHAIR, GO_TYPE_FISHINGNODE, GO_TYPE_GUILD_BANK, GO_TYPE_MAILBOX, GO_TYPE_QUESTGIVER,
  interactionDistance, lockIdOf, type GameObjectTemplate,
} from "../../world/GameObjectProtocol.js";
import type { CreatureTemplate } from "../../world/QueryCacheProtocol.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";

/**
 * The client's own cursors (5.17), chosen the way Wow.exe chooses them, drawn from its own pictures.
 *
 * **The set.** Wow.exe keeps 26 cursor names in a table at 0x00AD280C (id 1 Point … id 26
 * vehichleCursor, the file's own spelling), loads `Interface\Cursor\<name>.blp` for each at start-up
 * (0x006163B0) and a greyed `Unable<name>` twin for every one of them (ids 27–52 = id + 26, names
 * from 0x00AD2874). `SetCursor` (0x005104A0) knows them as POINT_CURSOR … VEHICLE_ERROR_CURSOR in the
 * same order; any other name is a file path of its own (id 53, 0x00616830). There is no
 * `EngineerSkin` in the table: an engineering body shows `Mine` (0x004F7A50, below).
 *
 * **The hotspot** is the picture's top-left pixel for every cursor: the apply routine (0x006162C0)
 * hands the cursor bitmap over with (0, 0); a 64-pixel picture is boxed down to 32 (0x006160B0).
 *
 * **The choice** is per object type, from the world frame's mouse-over (0x004F8190):
 *
 * * A unit (0x004F7A50). A creature the player may deal with — alive or interactable while dead,
 *   not uninteractible, not charmed, neutral or better both ways (0x00729620/0x00729530) — with NPC
 *   flags: its quest-giver status first (0x00744640: 2–5, 7, 8 Quest; 6 QuestRepeatable; 9, 10
 *   QuestTurnIn), else the template's IconName (a table name, or a file of its own), else the flags
 *   in this order (repair RepairNPC, innkeeper, flight master Taxi, trainer, spirit healer/guide
 *   Speak, banker/guild banker Buy, petitioner/tabard designer/battlemaster Speak, auctioneer Buy,
 *   stable master Speak, vendor Pickup, gossip Speak, spell click Interact); a creature that answers
 *   none of them keeps the default. Every one of these is the `Unable` twin past combat reach + 4
 *   yards (0x009E8D2C). Then a lootable body (0x00717B60): Pickup, or LootAll when auto-loot is on
 *   (0x00513700: the default flipped by the AUTOLOOTTOGGLE key), `Unable` out of loot range unless
 *   it is the body being looted (0x006D5A60). Then a skinnable body whose gathering spell the
 *   character knows (0x0053BCE0): Skin, GatherHerbs, or Mine for mining and engineering
 *   (0x00715E50), `Unable` past the spell's range (0x00802C30). Then a unit the player may attack,
 *   unpacified: Attack, `Unable` past melee range (0x004F5F40: max(5, both reaches + 4/3)).
 * * A game object (0x0070CE10): a type that has a cursor and is interactable now (0x007112A0) shows
 *   the template's IconName, else its type's own: lock-based for most (0x0070F9B0: the lock's first
 *   LockType's CursorName, else Interact), quest status then lock for a quest giver (0x0070FDE0),
 *   Inspect for a text (0x0070B540), Mail for a mailbox (0x0070B680), Buy for a guild bank
 *   (0x0070B910); each `Unable` while the object cannot be used (0x00711470). The other types keep
 *   the default.
 *
 * DOM-free apart from the picture loader at the bottom, which only runs where `document` exists.
 */

/** Wow.exe's cursor table, 0x00AD2808: index = cursor id, 1 … 26. */
export const CURSOR_FILES: readonly string[] = Object.freeze([
  "", "Point", "Cast", "Buy", "Attack", "Interact", "Speak", "Inspect", "Pickup", "Taxi", "Trainer", "Mine", "Skin",
  "GatherHerbs", "PickLock", "Mail", "LootAll", "Repair", "RepairNPC", "Item", "SkinHorde", "SkinAlliance",
  "Innkeeper", "Quest", "QuestRepeatable", "QuestTurnIn", "vehichleCursor",
]);
/** An `Unable` twin's id is its cursor's + 26 (0x00AD2874 onwards; `(-far & 0x1a) + id` in 0x004F7A50). */
export const CURSOR_UNABLE_OFFSET = 26;

/** `SetCursor`'s names (0x005104A0), in cursor-id order. */
const STOCK_CURSOR_KEYS = [
  "POINT", "CAST", "BUY", "ATTACK", "INTERACT", "SPEAK", "INSPECT", "PICKUP", "TAXI", "TRAINER", "MINE", "SKIN",
  "GATHER", "LOCK", "MAIL", "LOOT_ALL", "REPAIR", "REPAIRNPC", "ITEM", "SKIN_HORDE", "SKIN_ALLIANCE", "INNKEEPER",
  "QUEST", "QUEST_REPEATABLE", "QUEST_TURNIN", "VEHICLE",
] as const;

/** The file a cursor id draws: `Point` … `vehichleCursor`, `UnablePoint` … `UnablevehichleCursor`. */
export function cursorFile(id: number): string | undefined {
  if (id >= 1 && id <= CURSOR_UNABLE_OFFSET) return CURSOR_FILES[id];
  if (id > CURSOR_UNABLE_OFFSET && id <= 2 * CURSOR_UNABLE_OFFSET) return UNABLE_FILES[id - CURSOR_UNABLE_OFFSET];
  return undefined;
}
const UNABLE_FILES: readonly string[] = CURSOR_FILES.map((file) => (file ? `Unable${file}` : ""));

/** `SetCursor("ATTACK_CURSOR")` and the rest: the stock name's file, or undefined for a path. */
export function stockCursorFile(name: string): string | undefined {
  const upper = name.toUpperCase();
  for (let index = 0; index < STOCK_CURSOR_KEYS.length; index++) {
    const key = STOCK_CURSOR_KEYS[index]!;
    if (upper === `${key}_CURSOR`) return CURSOR_FILES[index + 1];
    if (upper === `${key}_ERROR_CURSOR`) return UNABLE_FILES[index + 1];
  }
  return undefined;
}

/** Lower-cased file name → its table spelling, for the IconName lookup (0x00616280 compares case-blind). */
const FILE_BY_LOWER = new Map<string, string>();
for (const file of [...CURSOR_FILES, ...UNABLE_FILES]) if (file) FILE_BY_LOWER.set(file.toLowerCase(), file);
/** Names outside the table, with their `Unable` twins, interned so a hover allocates nothing twice. */
const CUSTOM_NAMES = new Map<string, { readonly name: string; readonly unable: string }>();

/**
 * An IconName as Wow.exe reads it (0x00715EA0, 0x0070CE10): the table's file when the name (or its
 * `Unable` form) is one, else the name itself as a file of its own (id 53).
 */
export function iconCursor(iconName: string, unable: boolean): string {
  const known = FILE_BY_LOWER.get(iconName.toLowerCase());
  if (known !== undefined) {
    if (!unable) return known;
    const twin = FILE_BY_LOWER.get(`unable${known.toLowerCase()}`);
    return twin ?? known;
  }
  let custom = CUSTOM_NAMES.get(iconName);
  if (!custom) {
    custom = { name: iconName, unable: `Unable${iconName}` };
    CUSTOM_NAMES.set(iconName, custom);
  }
  return unable ? custom.unable : custom.name;
}

function pick(id: number, unable: boolean): string {
  return (unable ? UNABLE_FILES : CURSOR_FILES)[id]!;
}

const C = {
  CAST: 2, BUY: 3, ATTACK: 4, INTERACT: 5, SPEAK: 6, INSPECT: 7, PICKUP: 8, TAXI: 9, TRAINER: 10, MINE: 11,
  SKIN: 12, GATHER_HERBS: 13, MAIL: 15, LOOT_ALL: 16, REPAIR: 17, REPAIR_NPC: 18, INNKEEPER: 22, QUEST: 23,
  QUEST_REPEATABLE: 24, QUEST_TURNIN: 25,
} as const;
/** The cursor names this client sets itself, for callers outside the selection. */
export const CURSOR = Object.freeze({
  point: "Point", cast: "Cast", unableCast: "UnableCast", repair: "Repair",
});

// ---- the selection --------------------------------------------------------------------------------

/** `UnitNPCFlags` (TrinityCore UnitDefines.h), in 0x004F7A50's order. */
const NPC_GOSSIP = 0x1;
const NPC_TRAINER = 0x10;
const NPC_VENDOR = 0x80;
const NPC_REPAIR = 0x1000;
const NPC_FLIGHTMASTER = 0x2000;
const NPC_SPIRITHEALER = 0x4000;
const NPC_SPIRITGUIDE = 0x8000;
const NPC_INNKEEPER = 0x10000;
const NPC_BANKER = 0x20000;
const NPC_PETITIONER = 0x40000;
const NPC_TABARDDESIGNER = 0x80000;
const NPC_BATTLEMASTER = 0x100000;
const NPC_AUCTIONEER = 0x200000;
const NPC_STABLEMASTER = 0x400000;
const NPC_GUILD_BANKER = 0x800000;
const NPC_SPELLCLICK = 0x1000000;
/** UnitDefines.h: what 0x00729620 and the attack branch read. */
const UNIT_FLAG_PACIFIED = 0x20000;
const UNIT_FLAG_STUNNED = 0x40000;
const UNIT_FLAG_ON_TAXI = 0x100000;
const UNIT_FLAG_UNINTERACTIBLE = 0x2000000;
const UNIT_FLAG_SKINNABLE = 0x4000000;
/** SharedDefines.h:2732, CREATURE_TYPE_FLAG_INTERACT_WHILE_DEAD. */
const CREATURE_TYPE_FLAG_INTERACT_WHILE_DEAD = 0x80;
/** SharedDefines.h: creature type flags that pick the gathering skill (0x00715E50's order). */
const TYPE_FLAG_HERB = 0x100;
const TYPE_FLAG_MINING = 0x200;
const TYPE_FLAG_ENGINEERING = 0x8000;
/** SharedDefines.h:1631-1649: GameObjectFlags and the GAMEOBJECT_DYNAMIC low half. */
const GO_FLAG_IN_USE = 0x1;
const GO_FLAG_INTERACT_COND = 0x4;
const GO_FLAG_NOT_SELECTABLE = 0x10;
const GO_DYNFLAG_LO_ACTIVATE = 0x01;
const GO_DYNFLAG_LO_NO_INTERACT = 0x04;
/** 0x009E8D2C: an NPC's cursor greys past its combat reach plus this many yards. */
const NPC_CURSOR_REACH = 4;
/** 0x004F5F40: melee range = max(0x009EBF34, both combat reaches + 0x009F987C). */
const MELEE_RANGE_MIN = 5;
const MELEE_RANGE_BONUS = 4 / 3;
/** 0x00AD2810 … types whose vtable answers "has a cursor" with 0x007112A0 (the rest say no, 0x00427A90). */
const GO_TYPES_WITH_CURSOR = new Set([0, 1, 2, 3, 4, 6, 7, 9, 10, 12, 13, 17, 18, 19, 22, 23, 24, 26, 27, 32, 34]);
/**
 * LockType.dbc CursorName for the stock lock types (1 Lockpicking PickLock, 2 Herbalism GatherHerbs,
 * 3 Mining Mine, 19 Fishing FishingCursor; the rest are empty). A dataset's own lock types need the
 * gateway's lock table to carry the column (`LockCursorData.lockTypeCursors`).
 */
const STOCK_LOCK_TYPE_CURSORS: Readonly<Record<number, string>> = Object.freeze({
  1: "PickLock", 2: "GatherHerbs", 3: "Mine", 19: "FishingCursor",
});
/** LockType 1, lockpicking: 0x0070F9B0 never greys it. */
const LOCK_TYPE_PICKLOCK = 1;

/** What the selection reads of the world; the live `WorldClient` has all of it. */
export interface CursorWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: { get(guid: bigint): WorldObjectState | undefined } };
  creatureTemplate(entry: number, guid?: bigint): CreatureTemplate | undefined;
  gameObjectTemplate(entry: number, guid: bigint): GameObjectTemplate | undefined;
  readonly questGiverStatus?: { get(guid: bigint): number | undefined } | undefined;
  readonly loot?: { readonly guid: bigint } | undefined;
}

/** The answers that live outside the world object: factions, the spellbook, settings, locks. */
export interface CursorRules {
  /** The player's reaction to the unit, `REACTION_*`. */
  reaction(object: WorldObjectState): number;
  /** The unit's reaction to the player (0x00729530 asks both ways). */
  reactionBack?(object: WorldObjectState): number;
  canAttack(object: WorldObjectState): boolean;
  /** Auto-loot as the next click would have it: the default, flipped while its key is held. */
  autoLoot(): boolean;
  /** The gathering spell this character knows for this body's skill, if any. */
  gatherSpell(object: WorldObjectState): number | undefined;
  /** A spell's maximum range in yards. */
  spellRange(spellId: number): number | undefined;
  /** A lock's first case, as `LockClient.casesOf(lockId)[0]`. */
  lockCase(lockId: number): { readonly type: number; readonly index: number } | undefined;
  /** CursorName of a dataset LockType, when the gateway carried the column. */
  lockTypeCursor?(lockType: number): string | undefined;
}

function distanceSq(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function reach(object: WorldObjectState): number {
  const value = unit.combatReach(object);
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 0x004F5F40: the melee range between two units. */
export function meleeRange(a: WorldObjectState, b: WorldObjectState): number {
  return Math.max(MELEE_RANGE_MIN, reach(a) + reach(b) + MELEE_RANGE_BONUS);
}

function alive(object: WorldObjectState): boolean {
  return !isWorldObjectDead(object);
}

/** 0x00729620 + 0x00729530: whether the player may deal with this creature's services now. */
function npcInteractable(self: WorldObjectState, object: WorldObjectState, template: CreatureTemplate | undefined,
  rules: CursorRules): boolean {
  const selfFlags = unit.flags(self) ?? 0;
  if ((selfFlags & UNIT_FLAG_ON_TAXI) !== 0 || !alive(self)) return false;
  if ((self.fields.get(UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset) ?? 0) !== 0
    || (self.fields.get(UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset + 1) ?? 0) !== 0) return false;
  if (!alive(object) && ((template?.flags ?? 0) & CREATURE_TYPE_FLAG_INTERACT_WHILE_DEAD) === 0) return false;
  if (((unit.flags(object) ?? 0) & UNIT_FLAG_UNINTERACTIBLE) !== 0) return false;
  // 0x007251c0 both ways above 2: neutral or better.
  if (rules.reaction(object) < REACTION_NEUTRAL) return false;
  return rules.reactionBack === undefined || rules.reactionBack(object) >= REACTION_NEUTRAL;
}

/** 0x00744640: the quest-giver status cursor, or undefined for a status without one. */
function questCursor(status: number | undefined, unable: boolean): string | undefined {
  switch (status) {
    case 2: case 3: case 4: case 5: case 7: case 8: return pick(C.QUEST, unable);
    case 6: return pick(C.QUEST_REPEATABLE, unable);
    case 9: case 10: return pick(C.QUEST_TURNIN, unable);
    default: return undefined;
  }
}

/** 0x004F7A50's NPC-flag chain, after the quest status and the IconName. */
function npcFlagCursor(flags: number, unable: boolean): string {
  if ((flags & NPC_REPAIR) !== 0) return pick(C.REPAIR_NPC, unable);
  if ((flags & NPC_INNKEEPER) !== 0) return pick(C.INNKEEPER, unable);
  if ((flags & NPC_FLIGHTMASTER) !== 0) return pick(C.TAXI, unable);
  if ((flags & NPC_TRAINER) !== 0) return pick(C.TRAINER, unable);
  if ((flags & (NPC_SPIRITHEALER | NPC_SPIRITGUIDE)) !== 0) return pick(C.SPEAK, unable);
  if ((flags & (NPC_BANKER | NPC_GUILD_BANKER)) !== 0) return pick(C.BUY, unable);
  if ((flags & (NPC_PETITIONER | NPC_TABARDDESIGNER | NPC_BATTLEMASTER)) !== 0) return pick(C.SPEAK, unable);
  if ((flags & NPC_AUCTIONEER) !== 0) return pick(C.BUY, unable);
  if ((flags & NPC_STABLEMASTER) !== 0) return pick(C.SPEAK, unable);
  if ((flags & NPC_VENDOR) !== 0) return pick(C.PICKUP, unable);
  if ((flags & NPC_GOSSIP) !== 0) return pick(C.SPEAK, unable);
  if ((flags & NPC_SPELLCLICK) !== 0) return pick(C.INTERACT, unable);
  return "";
}

/** 0x00715E50 → 0x004F7A50: the gathering cursor id by the body's type flags. */
function gatherCursorId(typeFlags: number): number {
  if ((typeFlags & TYPE_FLAG_HERB) !== 0) return C.GATHER_HERBS;
  if ((typeFlags & (TYPE_FLAG_MINING | TYPE_FLAG_ENGINEERING)) !== 0) return C.MINE;
  return C.SKIN;
}

/** The cursor over a unit (0x004F7A50); "" is the default (Point). */
function unitCursor(world: CursorWorld, self: WorldObjectState, object: WorldObjectState, rules: CursorRules): string {
  const selfAt = self.position;
  const at = object.position;
  if (!selfAt || !at) return "";
  const distSq = distanceSq(selfAt, at);
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = object.typeId === 3 && entry > 0 ? world.creatureTemplate(entry, object.guid) : undefined;
  const npcFlags = unit.npcFlags(object) ?? 0;
  if (object.typeId === 3 && npcFlags !== 0 && npcInteractable(self, object, template, rules)) {
    const limit = reach(object) + NPC_CURSOR_REACH;
    const far = limit * limit < distSq;
    const quest = questCursor(world.questGiverStatus?.get(object.guid), far);
    if (quest !== undefined) return quest;
    const icon = template?.found ? template.cursorName : "";
    if (icon) return iconCursor(icon, far);
    return npcFlagCursor(npcFlags, far);
  }
  // 0x00717B60: a body with loot on it (dead and lootable).
  if (!alive(object) && isLootable(object)) {
    const range = meleeRange(self, object);
    const looting = world.loot?.guid === object.guid;
    const far = !looting && range * range < distSq;
    return pick(rules.autoLoot() ? C.LOOT_ALL : C.PICKUP, far);
  }
  // 0x0053BCE0: a skinnable body whose gathering spell the character knows.
  if (((unit.flags(object) ?? 0) & UNIT_FLAG_SKINNABLE) !== 0 && object.typeId === 3) {
    const spellId = rules.gatherSpell(object);
    if (spellId !== undefined) {
      const range = rules.spellRange(spellId) ?? 0;
      return pick(gatherCursorId(template?.flags ?? 0), range * range < distSq);
    }
  }
  // 0x00729A70 and the pacify check: a unit to swing at.
  if (rules.canAttack(object) && ((unit.flags(self) ?? 0) & UNIT_FLAG_PACIFIED) === 0) {
    const range = meleeRange(self, object);
    return pick(C.ATTACK, range * range < distSq);
  }
  return "";
}

/** 0x00711470, the part that reads this client's state: alive, not stunned, inside the use range. */
function gameObjectUsable(self: WorldObjectState, object: WorldObjectState, type: number): boolean {
  if (!alive(self) || ((unit.flags(self) ?? 0) & UNIT_FLAG_STUNNED) !== 0) return false;
  const selfAt = self.position;
  const at = object.position;
  if (!selfAt || !at) return false;
  const range = interactionDistance(type);
  return distanceSq(selfAt, at) <= range * range;
}

/** 0x007112A0: whether an object of a type with a cursor is interactable now. */
function gameObjectHasCursor(self: WorldObjectState, object: WorldObjectState, type: number): boolean {
  if (!GO_TYPES_WITH_CURSOR.has(type)) return false;
  const dynamic = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset) ?? 0;
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((dynamic & GO_DYNFLAG_LO_NO_INTERACT) !== 0 || (flags & (GO_FLAG_IN_USE | GO_FLAG_NOT_SELECTABLE)) !== 0) return false;
  if ((flags & GO_FLAG_INTERACT_COND) !== 0 && (dynamic & GO_DYNFLAG_LO_ACTIVATE) === 0) return false;
  // 0x00712030: a fishing bobber has a cursor only while it is the player's channel object.
  if (type === GO_TYPE_FISHINGNODE) {
    const channel = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
    const low = self.fields.get(channel) ?? 0;
    const high = self.fields.get(channel + 1) ?? 0;
    return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)) === object.guid;
  }
  return true;
}

/** 0x0070F9B0: the lock's first LockType's CursorName, else Interact. */
function lockCursor(template: GameObjectTemplate, usable: boolean, rules: CursorRules): string {
  const lockId = Array.isArray(template.data) ? lockIdOf(template) : 0;
  const first = lockId > 0 ? rules.lockCase(lockId) : undefined;
  if (first) {
    const name = rules.lockTypeCursor?.(first.index) ?? STOCK_LOCK_TYPE_CURSORS[first.index];
    if (name) return iconCursor(name, first.index !== LOCK_TYPE_PICKLOCK && !usable);
  }
  return pick(C.INTERACT, !usable);
}

/** The cursor over a game object (0x0070CE10); "" is the default (Point). */
function gameObjectCursor(world: CursorWorld, self: WorldObjectState, object: WorldObjectState, type: number,
  rules: CursorRules): string {
  if (!gameObjectHasCursor(self, object, type)) return "";
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? world.gameObjectTemplate(entry, object.guid) : undefined;
  if (!template) return "";
  const usable = gameObjectUsable(self, object, type);
  if (template.iconName) return iconCursor(template.iconName, !usable);
  switch (type) {
    case GO_TYPE_QUESTGIVER:
      return questCursor(world.questGiverStatus?.get(object.guid), !usable) ?? lockCursor(template, usable, rules);
    case 9: return pick(C.INSPECT, !usable);
    case GO_TYPE_MAILBOX: return pick(C.MAIL, !usable);
    case GO_TYPE_GUILD_BANK: return pick(C.BUY, !usable);
    case GO_TYPE_CHAIR: case GO_TYPE_BARBER_CHAIR: default:
      return lockCursor(template, usable, rules);
  }
}

/**
 * The cursor Wow.exe would show over `object`, by file name ("Attack", "UnableSpeak", a template's
 * own IconName…), or "" for the default Point. `gameObjectType` is the object's GO type (BYTES_1).
 */
export function worldObjectCursor(
  world: CursorWorld, object: WorldObjectState | undefined, gameObjectType: number, rules: CursorRules,
): string {
  if (!object) return "";
  const selfGuid = world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  if (!self || object === self) return "";
  if (object.typeId === 3 || object.typeId === 4) return unitCursor(world, self, object, rules);
  if (object.typeId === 5) return gameObjectCursor(world, self, object, gameObjectType, rules);
  return "";
}

/** The repair cursor's id, for the base cursor while the merchant's repair mode is on (0x00584600). */
export const REPAIR_CURSOR_FILE = CURSOR_FILES[C.REPAIR]!;

// ---- the pictures ---------------------------------------------------------------------------------

/** The keyword a cursor shows until (and unless) its picture arrives. */
function fallbackFor(name: string): string {
  if (name === "" || name === "Point") return "";
  return name.startsWith("Unable") ? "not-allowed" : "pointer";
}

/** Composed CSS per file name once its picture is here; the keyword before. */
const cursorCssByName = new Map<string, string>();
const requested = new Set<string>();
/** When a picture last failed: asked again only after {@link PICTURE_RETRY_MS} (a missing file, an `Unable` twin the archive lacks, must not be asked for on every hover). */
const failedAt = new Map<string, number>();
const PICTURE_RETRY_MS = 30_000;
let textureUrl: ((path: string) => string | undefined) | undefined;
let pictureListeners: (() => void)[] = [];

/** Where the pictures come from: the gateway's `/texture` route (set at world entry). */
export function useCursorPictures(url: ((path: string) => string | undefined) | undefined): void {
  textureUrl = url;
}

/** Called when a picture lands, so a stationary pointer can be redrawn with it. */
export function onCursorPicture(listener: () => void): () => void {
  pictureListeners.push(listener);
  return () => { pictureListeners = pictureListeners.filter((entry) => entry !== listener); };
}

/** The archive path of a cursor file. */
export function cursorTexturePath(name: string): string {
  return `Interface\\Cursor\\${name}.blp`;
}

/**
 * The CSS `cursor` value for a file name: the client's picture with its (0, 0) hotspot and the
 * keyword behind it, or the keyword alone while the picture is on its way (and the request goes
 * out on the first ask). "" is the stylesheet's own cursor. Cached per name: an unchanged hover
 * allocates nothing.
 */
export function cursorCss(name: string): string {
  const ready = cursorCssByName.get(name);
  if (ready !== undefined) return ready;
  requestPicture(name);
  return fallbackFor(name);
}

function requestPicture(name: string): void {
  if (name === "" || requested.has(name) || !textureUrl || typeof document === "undefined"
    || typeof fetch !== "function") return;
  const failed = failedAt.get(name);
  if (failed !== undefined && Date.now() - failed < PICTURE_RETRY_MS) return;
  const url = textureUrl(cursorTexturePath(name));
  if (!url) return;
  requested.add(name);
  void (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cursor ${name}: ${response.status}`);
    const picture = await cursorBlob(await response.blob());
    const objectUrl = URL.createObjectURL(picture);
    const fallback = fallbackFor(name) || "default";
    cursorCssByName.set(name, `url("${objectUrl}") 0 0, ${fallback}`);
    // The body-class cursors (style.css) read the same picture where their own module has not set it.
    if (name === "Cast") castCursorForBody();
    for (const listener of pictureListeners) listener();
  })().catch(() => {
    // The keyword stays; asked again after a while.
    requested.delete(name);
    failedAt.set(name, Date.now());
  });
}

/**
 * The body-class cast cursor (style.css: a spell or the wrapping paper waiting for an item) reads
 * the same picture through `--framexml-cast-cursor` wherever its own module (the trade skill
 * window) has not set one; asks for the picture when it is not here yet.
 */
export function castCursorForBody(): void {
  const css = cursorCss("Cast");
  if (!css.startsWith("url(") || typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style || root.style.getPropertyValue("--framexml-cast-cursor")) return;
  root.style.setProperty("--framexml-cast-cursor", css.replace(/, [a-z-]+$/, ", crosshair"));
}

/** 0x006160B0: a 64-pixel picture is boxed down to the 32-pixel cursor; 32 is used as it is. */
async function cursorBlob(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return blob;
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width <= 32 && bitmap.height <= 32) return blob;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return blob;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, 32, 32);
  return await new Promise<Blob>((resolve) => canvas.toBlob((scaled) => resolve(scaled ?? blob), "image/png"));
}

/** Tests: forget every picture. */
export function resetCursorPictures(): void {
  for (const css of cursorCssByName.values()) {
    const match = /^url\("([^"]+)"\)/.exec(css);
    if (match && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(match[1]!);
  }
  cursorCssByName.clear();
  requested.clear();
  failedAt.clear();
}
