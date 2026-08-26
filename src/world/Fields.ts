import { UPDATE_FIELDS, type UpdateFieldName } from "../generated/updateFields.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * What a declared field type reads back as. A LONG spans two update-field slots and is the only
 * one that does not fit in a number, so it is the only one that changes the shape.
 */
export type FieldValue<Name extends UpdateFieldName> =
  (typeof UPDATE_FIELDS)[Name]["type"] extends "LONG" ? bigint : number;

/** Reinterprets a slot's bits, which is what a FLOAT field is: a float32 sent as a 32-bit word. */
const scratch = new DataView(new ArrayBuffer(8));

export const fieldIndex = (name: UpdateFieldName): number => UPDATE_FIELDS[name].offset;

/** The raw slot, exactly as it arrived: an unsigned 32-bit word, or undefined if never sent. */
export function readSlot(object: WorldObjectState, index: number): number | undefined {
  return object.fields.get(index);
}

/**
 * Reads a field by name, decoded by the type the core declares for it.
 *
 * A type the header does not spell — `PLAYER_FIELD_BYTES2` is written `Type: 6` in TrinityCore's
 * own `UpdateFields.h` — is handed back as the raw word rather than guessed at.
 */
export function readField<Name extends UpdateFieldName>(
  object: WorldObjectState,
  name: Name,
): FieldValue<Name> | undefined {
  const field = UPDATE_FIELDS[name] as { offset: number; type: string };
  const raw = object.fields.get(field.offset);
  if (raw === undefined) return undefined;

  if (field.type === "FLOAT") {
    scratch.setUint32(0, raw, true);
    return scratch.getFloat32(0, true) as FieldValue<Name>;
  }
  if (field.type === "LONG") {
    const high = object.fields.get(field.offset + 1) ?? 0;
    return ((BigInt(high) << 32n) | BigInt(raw)) as FieldValue<Name>;
  }
  return raw as FieldValue<Name>;
}

/** One byte out of a packed field, counting from the low end as the core's `GetByteValue` does. */
export function readByte(object: WorldObjectState, name: UpdateFieldName, index: number): number | undefined {
  const raw = object.fields.get(UPDATE_FIELDS[name].offset);
  return raw === undefined ? undefined : (raw >>> (index * 8)) & 0xff;
}

/** The two halves of a TWO_SHORT field, low first. */
export function readShorts(object: WorldObjectState, name: UpdateFieldName): [number, number] | undefined {
  const raw = object.fields.get(UPDATE_FIELDS[name].offset);
  return raw === undefined ? undefined : [raw & 0xffff, raw >>> 16];
}

/**
 * Total melee attack power as the 3.3.5 client evaluates it.  The base field is signed, the two
 * modifier halves are signed shorts, and the multiplier is a float bit-pattern.  Reading only
 * UNIT_FIELD_ATTACK_POWER (as an unsigned word) is enough for an unbuffed character but makes
 * formula tooltips wrong as soon as an AP aura is present.
 */
export function attackPower(object: WorldObjectState): number | undefined {
  const base = readField(object, "UNIT_FIELD_ATTACK_POWER");
  if (base === undefined) return undefined;
  const halves = readShorts(object, "UNIT_FIELD_ATTACK_POWER_MODS");
  const low = halves === undefined ? 0 : (halves[0] << 16) >> 16;
  const high = halves === undefined ? 0 : (halves[1] << 16) >> 16;
  const multiplier = readField(object, "UNIT_FIELD_ATTACK_POWER_MULTIPLIER") ?? 0;
  return Math.max(0, ((base | 0) + low + high) * (1 + multiplier));
}

/** A guid held in a pair of slots at an offset from a named field, which is how the item slots run. */
export function readGuidAt(object: WorldObjectState, index: number): bigint | undefined {
  const low = object.fields.get(index);
  if (low === undefined) return undefined;
  return (BigInt(object.fields.get(index + 1) ?? 0) << 32n) | BigInt(low);
}

/**
 * Powers, in the order `UNIT_FIELD_POWER1` runs. Which one a unit shows is byte 3 of
 * `UNIT_FIELD_BYTES_0` — `UNIT_BYTES_0_OFFSET_POWER_TYPE` in the core — and reading it is the
 * difference between a warrior's rage bar and the empty blue bar this client draws for everyone.
 */
export const POWER = {
  mana: 0,
  rage: 1,
  focus: 2,
  energy: 3,
  happiness: 4,
  rune: 5,
  runicPower: 6,
} as const;

export const POWER_COUNT = 7;

/**
 * Rage and runic power are stored ten times their displayed value: `Unit::GetCreatePowers` gives
 * both a maximum of 1000 for the 100 points the interface shows. Everything else is stored as it
 * reads. Happiness is 1,050,000 at full and is not a number the interface shows at all — the
 * original client draws one of three faces — so it is left alone here.
 */
export const POWER_DISPLAY_SCALE: readonly number[] = [1, 10, 1, 1, 1, 1, 10];

/** Byte positions inside `UNIT_FIELD_BYTES_0`, from the core's `UnitBytes0Offsets`. */
const BYTES_0_RACE = 0;
const BYTES_0_CLASS = 1;
const BYTES_0_GENDER = 2;
const BYTES_0_POWER_TYPE = 3;

/**
 * The fields the interface asks for by name. Everything here is `undefined` when the server has
 * not sent that field yet, which a panel has to tell apart from zero: a health of 0 is a corpse.
 */
export const unit = {
  level: (object: WorldObjectState) => readField(object, "UNIT_FIELD_LEVEL"),
  health: (object: WorldObjectState) => readField(object, "UNIT_FIELD_HEALTH"),
  maxHealth: (object: WorldObjectState) => readField(object, "UNIT_FIELD_MAXHEALTH"),
  race: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_0", BYTES_0_RACE),
  classId: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_0", BYTES_0_CLASS),
  gender: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_0", BYTES_0_GENDER),
  powerType: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_0", BYTES_0_POWER_TYPE),

  /** The power the unit actually uses, not slot 1. Undefined until its type is known. */
  power(object: WorldObjectState): number | undefined {
    const type = this.powerType(object);
    if (type === undefined || type >= POWER_COUNT) return undefined;
    return object.fields.get(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + type);
  },
  maxPower(object: WorldObjectState): number | undefined {
    const type = this.powerType(object);
    if (type === undefined || type >= POWER_COUNT) return undefined;
    return object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + type);
  },
  /** What to divide `power` by before showing it as a number. */
  powerScale(object: WorldObjectState): number {
    const type = this.powerType(object);
    return type === undefined ? 1 : POWER_DISPLAY_SCALE[type] ?? 1;
  },

  displayId: (object: WorldObjectState) => readField(object, "UNIT_FIELD_DISPLAYID"),
  nativeDisplayId: (object: WorldObjectState) => readField(object, "UNIT_FIELD_NATIVEDISPLAYID"),
  mountDisplayId: (object: WorldObjectState) => readField(object, "UNIT_FIELD_MOUNTDISPLAYID"),
  target: (object: WorldObjectState) => readField(object, "UNIT_FIELD_TARGET"),
  flags: (object: WorldObjectState) => readField(object, "UNIT_FIELD_FLAGS"),
  dynamicFlags: (object: WorldObjectState) => readField(object, "UNIT_DYNAMIC_FLAGS"),
  npcFlags: (object: WorldObjectState) => readField(object, "UNIT_NPC_FLAGS"),
  factionTemplate: (object: WorldObjectState) => readField(object, "UNIT_FIELD_FACTIONTEMPLATE"),
  boundingRadius: (object: WorldObjectState) => readField(object, "UNIT_FIELD_BOUNDINGRADIUS"),
  combatReach: (object: WorldObjectState) => readField(object, "UNIT_FIELD_COMBATREACH"),
  // Byte positions from the core's `UnitBytes1Offsets` and `UnitBytes2Offsets`.
  standState: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_1", 0),
  animationTier: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_1", 3),
  sheathState: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_2", 0),
  pvpFlags: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_2", 1),
  shapeshiftForm: (object: WorldObjectState) => readByte(object, "UNIT_FIELD_BYTES_2", 3),
};

/**
 * `UNIT_DYNAMIC_FLAGS`, from `SharedDefines.h:3123-3131`.
 *
 * The field was declared three times in this client — the event name, the field-to-event table and
 * the accessor above — and read nowhere, so nothing on the screen ever said which body still held
 * anything. Four bits are named and all four are read: `LOOTABLE` and the `TAPPED` pair below,
 * and `DEAD` by `isWorldObjectDead`. The rest are in the header, including `TRACK_UNIT` (0x02),
 * which nothing here has a question for. The reference client names the same four and no others
 * (`wowee/include/game/entity.hpp:54-57`).
 *
 * `DEAD` is the standby and not the answer: health decides while there is health to read, and the
 * flags decide only when a CREATE block left the slot out altogether — which it does for a body
 * that was already dead when it came into view. `isWorldObjectDead` in `WorldState.ts` carries the
 * whole of that rule and the core reference for it.
 */
export const UNIT_DYNFLAG_LOOTABLE = 0x01;
export const UNIT_DYNFLAG_TAPPED = 0x04;
export const UNIT_DYNFLAG_TAPPED_BY_PLAYER = 0x08;
export const UNIT_DYNFLAG_DEAD = 0x20;

/**
 * Whether the server is showing this viewer the loot sparkle on a body.
 *
 * Indication only, never a gate on the click. The bit is rewritten per viewer on its way out
 * (`Unit::BuildValuesUpdate`, `Unit.cpp:14741-14755`: the core clears `LOOTABLE` for anyone
 * `isAllowedToLoot` refuses), and the server's own answer to `CMSG_LOOT` is stricter still
 * (`Player::SendLoot`, `Player.cpp:8898-8902`) — but it also *lags*. `ForceValuesUpdateAtIndex`
 * for this field stands in exactly one place in the core (`LootHandler.cpp:430`) and only in the
 * "loot not fully taken" branch, so under group round-robin the bit reaches a bystander late.
 * Gating the click on it is the mistake the reference client made and then undid, with the
 * symptom written down: a genuinely lootable corpse became permanently unclickable
 * (`wowee/src/game/combat_handler.cpp:1283-1301`).
 */
export function isLootable(object: WorldObjectState): boolean {
  return ((unit.dynamicFlags(object) ?? 0) & UNIT_DYNFLAG_LOOTABLE) !== 0;
}

/**
 * Whether somebody else claimed the kill: the grey health bar of the original client.
 *
 * Both bits are needed. `TAPPED` alone means "this creature has a loot recipient", which is true
 * for the player's own kill as well; `TAPPED_BY_PLAYER` is the half the core adds only when
 * `creature->isTappedBy(target)` (`Unit.cpp:14747-14751`), so "tapped and not by me" is the pair.
 * The same pair, in the same order, is what the reference client greys a plate on
 * (`wowee/src/ui/game_screen_hud.cpp:1025-1029`).
 */
export function isTappedByOther(object: WorldObjectState): boolean {
  const flags = unit.dynamicFlags(object) ?? 0;
  return (flags & UNIT_DYNFLAG_TAPPED) !== 0 && (flags & UNIT_DYNFLAG_TAPPED_BY_PLAYER) === 0;
}

/**
 * `PLAYER_EXPLORED_ZONES_SIZE` in Player.h: 128 words, one bit per area, and the bit is
 * `AreaTable.AreaBit` rather than the area id.
 *
 * `Player::CheckAreaExploreAndOutdoor` sets `PLAYER_EXPLORED_ZONES_1 + AreaBit / 32` to
 * `1 << (AreaBit % 32)` and nothing else ever writes it, so this is the whole of exploration as far
 * as the wire is concerned. `SMSG_EXPLORATION_EXPERIENCE` is a *consequence* and not the truth: the
 * core only sends it when the area's `ExplorationLevel` is above zero, so an area worth no
 * experience is discovered silently.
 */
export const EXPLORED_ZONES_WORDS = 128;

/**
 * The 128 words as they stand, or undefined while the character's own private block is still
 * missing entirely.
 *
 * A single absent word is a zero rather than an omission — the server does not send fields that
 * hold nothing — so "no words at all" and "nothing explored yet" are different answers and only
 * the first is undefined.
 */
export function exploredZones(object: WorldObjectState): Uint32Array | undefined {
  const base = UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset;
  const words = new Uint32Array(EXPLORED_ZONES_WORDS);
  let seen = false;
  for (let index = 0; index < EXPLORED_ZONES_WORDS; index++) {
    const word = object.fields.get(base + index);
    if (word === undefined) continue;
    words[index] = word;
    seen = true;
  }
  return seen ? words : undefined;
}

/**
 * The ids a tracking mask names.
 *
 * `PLAYER_TRACK_CREATURES` and `PLAYER_TRACK_RESOURCES` hold `1 << (MiscValue - 1)` for each
 * tracking aura the character carries, so the bit is **one less** than the id it stands for: bit 0
 * is creature type 1, and reading a bit as the type itself files every beast under "none". The
 * misc value is never zero on the twenty-two creature and nine resource trackers this build ships,
 * which is what makes the minus-one safe.
 */
export function trackedTypesFromMask(mask: number | undefined): Set<number> {
  const ids = new Set<number>();
  if (!mask) return ids;
  for (let bit = 0; bit < 32; bit++) if ((mask & (1 << bit)) !== 0) ids.add(bit + 1);
  return ids;
}

/** Whether one area's bit is set. An `areaBit` outside the mask reads as unexplored, not as a crash. */
export function isAreaExplored(words: Uint32Array, areaBit: number): boolean {
  if (!Number.isInteger(areaBit) || areaBit < 0 || areaBit >= EXPLORED_ZONES_WORDS * 32) return false;
  return (words[areaBit >>> 5]! & (1 << (areaBit & 31))) !== 0;
}

/** Quest log: 25 slots of 5 words each, measured from the generated offsets (158, 163 … 278). */
export const QUEST_LOG_SLOTS = 25;
const QUEST_LOG_STRIDE =
  UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;

export interface QuestLogEntry {
  slot: number;
  questId: number;
  state: number;
  /** Two counters per word, packed as shorts: four objectives over two words. */
  counters: readonly number[];
  /** Absolute expiry for a timed quest, in the server's seconds; 0 when the quest is not timed. */
  timer: number;
}

export const player = {
  experience: (object: WorldObjectState) => readField(object, "PLAYER_XP"),
  nextLevelExperience: (object: WorldObjectState) => readField(object, "PLAYER_NEXT_LEVEL_XP"),
  money: (object: WorldObjectState) => readField(object, "PLAYER_FIELD_COINAGE"),

  /** One quest log slot, or undefined when the slot is empty. */
  questLog(object: WorldObjectState, slot: number): QuestLogEntry | undefined {
    if (slot < 0 || slot >= QUEST_LOG_SLOTS) return undefined;
    const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + slot * QUEST_LOG_STRIDE;
    const questId = object.fields.get(base);
    if (!questId) return undefined;
    const counters: number[] = [];
    for (let word = 0; word < 2; word++) {
      const packed = object.fields.get(base + 2 + word) ?? 0;
      counters.push(packed & 0xffff, packed >>> 16);
    }
    return { slot, questId, state: object.fields.get(base + 1) ?? 0, counters, timer: object.fields.get(base + 4) ?? 0 };
  },

  quests(object: WorldObjectState): QuestLogEntry[] {
    const entries: QuestLogEntry[] = [];
    for (let slot = 0; slot < QUEST_LOG_SLOTS; slot++) {
      const entry = this.questLog(object, slot);
      if (entry) entries.push(entry);
    }
    return entries;
  },
};

export const gameObject = {
  displayId: (object: WorldObjectState) => readField(object, "GAMEOBJECT_DISPLAYID"),
  flags: (object: WorldObjectState) => readField(object, "GAMEOBJECT_FLAGS"),
  /** Byte 0 of `GAMEOBJECT_BYTES_1`: closed, opened or destroyed. */
  state: (object: WorldObjectState) => readByte(object, "GAMEOBJECT_BYTES_1", 0),
  /** Byte 1: which of the object's animation states it stands in. */
  animationType: (object: WorldObjectState) => readByte(object, "GAMEOBJECT_BYTES_1", 1),
};

export const worldObject = {
  guid: (object: WorldObjectState) => readField(object, "OBJECT_FIELD_GUID"),
  entry: (object: WorldObjectState) => readField(object, "OBJECT_FIELD_ENTRY"),
  scale: (object: WorldObjectState) => readField(object, "OBJECT_FIELD_SCALE_X"),
};
