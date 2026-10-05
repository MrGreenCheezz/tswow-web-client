// 6.05 (line A7a, slice G2, 05.10): a player's corpse (object type 7) as the body it is, or its bones.
//
// Until this the corpse was a yellow 2D marker (`SimpleScene`). What the server sends is a whole
// look: TrinityCore `Player::CreateCorpse` (Player.cpp:4811-4862) writes
//   CORPSE_FIELD_DISPLAY_ID   the native display (the race's character model, never a form);
//   CORPSE_FIELD_BYTES_1      race << 8 | gender << 16 | skin << 24;
//   CORPSE_FIELD_BYTES_2      face | hairStyle << 8 | hairColor << 16 | facialHair << 24;
//   CORPSE_FIELD_ITEM[slot]   displayId | inventoryType << 24, one word per EQUIPMENT_SLOT;
//   CORPSE_FIELD_FLAGS        0x01 bones, 0x08 hide helm, 0x10 hide cloak (from PLAYER_FLAGS), 0x20 lootable.
//
// Wow.exe 3.3.5a 12340 reads them back in CGCorpse_C's create, 0x00705b20, and its model path,
// 0x00705670:
//  - bones (flag 0x01): `World\Generic\PassiveDoodads\DeathSkeletons\<race><sex>DeathSkeleton`, the
//    race being ChrRaces.ClientFileString and the sex "Male"/"Female" (the table at 0x00ad6628) — a
//    doodad, nothing of the character. 21 of these are in the client (the ten playable races both
//    ways and VrykulMale; no goblin);
//  - a body: the display's model, composed from the bytes above exactly as a living player's;
//  - the items, slot by slot: the ranged slot (17) is skipped outright, the head and back are
//    skipped under their hide flags, and the two hands (15, 16) are hung only through an item
//    object found by the word as its GUID (0x004d4db0 with the item type mask) — which a TrinityCore
//    word (display | type << 24) never is, so a corpse is drawn without its weapons;
//  - the pose: animation 6 (Dead), or 132 (Drowned) when a liquid surface is above it by more than a
//    threshold (0x0077f1e0). The drowned case is not done here (the renderer's dead pose plays).
//
// How it is drawn: `corpseUnitView` hands the renderer's unit path a stand-in object for the
// corpse — same GUID and position, and *only* the unit words that path needs (the display id twice
// and the scale). The corpse's own words cannot be handed over as they are: CORPSE_FIELD_ITEM runs
// over the indices a unit keeps TARGET, CHANNEL_SPELL, BYTES_0 and HEALTH in. `corpseModelFor` is
// the model the unit path asks `unitModel` for.
//
// Per-frame cost: `corpseUnitView` — a WeakMap read and three compares per corpse in range; a new
// view only when the display or the flags change. `corpseModelFor` is memoised on the corpse.

import type { EquippedItem } from "../gateway/CharacterAppearance.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "../world/WorldState.js";
import type { CreatureModelClient, UnitModel } from "./CreatureModelClient.js";

export const CORPSE_TYPE_ID = 7;
export const CORPSE_FLAG_BONES = 0x01;
export const CORPSE_FLAG_HIDE_HELM = 0x08;
export const CORPSE_FLAG_HIDE_CLOAK = 0x10;

const DISPLAY_ID = UPDATE_FIELDS.CORPSE_FIELD_DISPLAY_ID.offset;
const ITEM_FIRST = UPDATE_FIELDS.CORPSE_FIELD_ITEM.offset;
const ITEM_COUNT = 19;
const BYTES_1 = UPDATE_FIELDS.CORPSE_FIELD_BYTES_1.offset;
const BYTES_2 = UPDATE_FIELDS.CORPSE_FIELD_BYTES_2.offset;
const FLAGS = UPDATE_FIELDS.CORPSE_FIELD_FLAGS.offset;
const SLOT_HEAD = 0;
const SLOT_BACK = 14;
const SLOT_MAIN_HAND = 15;
const SLOT_OFF_HAND = 16;
const SLOT_RANGED = 17;

/**
 * ChrRaces.ClientFileString of the races the client has a DeathSkeleton for (checked against the
 * dataset by `tests/corpse-model.test.mjs`); any other race keeps the marker.
 */
export const CORPSE_RACE_FILES: Readonly<Record<number, string>> = {
  1: "Human", 2: "Orc", 3: "Dwarf", 4: "NightElf", 5: "Scourge", 6: "Tauren", 7: "Gnome", 8: "Troll",
  10: "BloodElf", 11: "Draenei",
};
/** The sex names of the table at 0x00ad6628. */
const SEX_NAMES = ["Male", "Female"] as const;

export interface CorpseLook {
  readonly displayId: number;
  readonly race: number;
  readonly sex: number;
  readonly skin: number;
  readonly face: number;
  readonly hairStyle: number;
  readonly hairColor: number;
  readonly facialHair: number;
  readonly bones: boolean;
  /** What the body wears, as `CreatureModelClient.playerAppearance` takes it. */
  readonly equipment: readonly EquippedItem[];
}

/** The look a corpse's fields describe, or undefined for anything that is not a corpse. */
export function corpseLook(object: Pick<WorldObjectState, "typeId" | "fields">): CorpseLook | undefined {
  if (object.typeId !== CORPSE_TYPE_ID) return undefined;
  const fields = object.fields;
  const flags = fields.get(FLAGS) ?? 0;
  const bytes1 = fields.get(BYTES_1) ?? 0;
  const bytes2 = fields.get(BYTES_2) ?? 0;
  const equipment: EquippedItem[] = [];
  for (let slot = 0; slot < ITEM_COUNT; slot++) {
    if (slot === SLOT_MAIN_HAND || slot === SLOT_OFF_HAND || slot === SLOT_RANGED) continue;
    if (slot === SLOT_HEAD && (flags & CORPSE_FLAG_HIDE_HELM) !== 0) continue;
    if (slot === SLOT_BACK && (flags & CORPSE_FLAG_HIDE_CLOAK) !== 0) continue;
    const word = fields.get(ITEM_FIRST + slot) ?? 0;
    const displayId = word & 0xffffff;
    if (displayId === 0) continue;
    equipment.push({ slot, inventoryType: word >>> 24, displayId });
  }
  return {
    displayId: fields.get(DISPLAY_ID) ?? 0,
    race: (bytes1 >>> 8) & 0xff, sex: (bytes1 >>> 16) & 0xff, skin: (bytes1 >>> 24) & 0xff,
    face: bytes2 & 0xff, hairStyle: (bytes2 >>> 8) & 0xff, hairColor: (bytes2 >>> 16) & 0xff,
    facialHair: (bytes2 >>> 24) & 0xff,
    bones: (flags & CORPSE_FLAG_BONES) !== 0,
    equipment,
  };
}

/** Wow.exe 0x00705670's bones model, or undefined for a race or sex without one. */
export function corpseSkeletonPath(race: number, sex: number): string | undefined {
  const file = CORPSE_RACE_FILES[race];
  const sexName = SEX_NAMES[sex as 0 | 1];
  if (file === undefined || sexName === undefined) return undefined;
  return `World\\Generic\\PassiveDoodads\\DeathSkeletons\\${file}${sexName}DeathSkeleton.m2`;
}

/** The display id the world pass asks `CreatureModelClient` for: a body's, never the bones'. */
export function corpseDisplayRequest(object: Pick<WorldObjectState, "typeId" | "fields">): number {
  if (object.typeId !== CORPSE_TYPE_ID) return 0;
  return ((object.fields.get(FLAGS) ?? 0) & CORPSE_FLAG_BONES) !== 0 ? 0 : (object.fields.get(DISPLAY_ID) ?? 0);
}

interface CorpseView {
  readonly view: WorldObjectState;
  displayId: number;
  flags: number;
  scale: number | undefined;
}

const views = new WeakMap<WorldObjectState, CorpseView>();
const owners = new WeakMap<WorldObjectState, WorldObjectState>();

/**
 * The stand-in the renderer's unit path draws for a corpse: same GUID, same position object, and
 * only the display id, the native display id and the scale among its words. Undefined without a
 * position, or for a bones corpse of a race with no skeleton (the marker stays).
 */
export function corpseUnitView(corpse: WorldObjectState): WorldObjectState | undefined {
  if (corpse.typeId !== CORPSE_TYPE_ID || corpse.position === undefined) return undefined;
  const displayId = corpse.fields.get(DISPLAY_ID) ?? 0;
  const flags = corpse.fields.get(FLAGS) ?? 0;
  const scale = corpse.fields.get(UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
  if ((flags & CORPSE_FLAG_BONES) !== 0) {
    const bytes1 = corpse.fields.get(BYTES_1) ?? 0;
    if (corpseSkeletonPath((bytes1 >>> 8) & 0xff, (bytes1 >>> 16) & 0xff) === undefined) return undefined;
  }
  let entry = views.get(corpse);
  if (entry === undefined) {
    const view: WorldObjectState = { ...corpse, fields: new Map() };
    owners.set(view, corpse);
    entry = { view, displayId: -1, flags: -1, scale: undefined };
    views.set(corpse, entry);
  }
  const view = entry.view;
  view.position = corpse.position;
  view.transport = corpse.transport; // a corpse on a ship rides it
  if (entry.displayId !== displayId || entry.flags !== flags || entry.scale !== scale) {
    entry.displayId = displayId;
    entry.flags = flags;
    entry.scale = scale;
    const fields = view.fields;
    fields.clear();
    for (let field = 0; field < UPDATE_FIELDS.OBJECT_END.offset; field++) {
      const value = corpse.fields.get(field);
      if (value !== undefined) fields.set(field, value);
    }
    fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId);
    fields.set(UPDATE_FIELDS.UNIT_FIELD_NATIVEDISPLAYID.offset, displayId);
  }
  return view;
}

/** The corpse a view stands in for, or undefined for anything else. */
export function corpseOfView(object: WorldObjectState): WorldObjectState | undefined {
  return owners.get(object);
}

interface ResolvedCorpseModel {
  readonly client: object;
  readonly generation: number;
  /** The words the look was read from: display, BYTES_1, BYTES_2, FLAGS and the 19 items. */
  readonly words: Uint32Array;
  readonly model: UnitModel;
}

const resolved = new WeakMap<WorldObjectState, ResolvedCorpseModel>();

const LOOK_WORDS = 4 + ITEM_COUNT;

function lookWord(fields: WorldObjectState["fields"], index: number): number {
  const field = index === 0 ? DISPLAY_ID : index === 1 ? BYTES_1 : index === 2 ? BYTES_2 : index === 3 ? FLAGS : ITEM_FIRST + index - 4;
  return (fields.get(field) ?? 0) >>> 0;
}

/** Whether the corpse's look words are still the ones `words` holds; no allocation. */
function sameLook(fields: WorldObjectState["fields"], words: Uint32Array): boolean {
  for (let index = 0; index < LOOK_WORDS; index++) if (lookWord(fields, index) !== words[index]) return false;
  return true;
}

/**
 * The model a corpse (or its view) wears: the bones doodad, or the display's character model with
 * the owner's look composed onto it — the same `playerAppearance` call, so a corpse and a living
 * player who look alike share one composed body. Undefined until the display record and the look
 * have arrived.
 */
export function corpseModelFor(object: WorldObjectState,
  creatureModels: Pick<CreatureModelClient, "generation" | "get" | "playerAppearance"> | undefined): UnitModel | undefined {
  const corpse = owners.get(object) ?? object;
  if (corpse.typeId !== CORPSE_TYPE_ID || !creatureModels) return undefined;
  const cached = resolved.get(corpse);
  if (cached && cached.client === creatureModels && cached.generation === creatureModels.generation
    && sameLook(corpse.fields, cached.words)) return cached.model;
  const look = corpseLook(corpse)!;
  let model: UnitModel | undefined;
  if (look.bones) {
    const path = corpseSkeletonPath(look.race, look.sex);
    if (path === undefined) return undefined;
    model = { id: look.displayId, model: path, scale: 1, collisionHeight: 0, mountHeight: 0, textures: "" };
  } else {
    const metadata = creatureModels.get(look.displayId);
    if (!metadata) return undefined;
    // A display that is not a character model (a TSWoW custom race on a creature model) is drawn as its record.
    if (!/^character\\/i.test(metadata.model)) {
      model = metadata;
    } else {
      const appearance = creatureModels.playerAppearance(look.race, look.sex, look.skin, look.face,
        look.hairStyle, look.hairColor, look.facialHair, look.equipment);
      if (appearance === undefined) return undefined;
      model = { ...metadata, appearance };
    }
  }
  if (Number.isFinite(creatureModels.generation)) {
    const words = new Uint32Array(LOOK_WORDS);
    for (let index = 0; index < LOOK_WORDS; index++) words[index] = lookWord(corpse.fields, index);
    resolved.set(corpse, { client: creatureModels, generation: creatureModels.generation, words, model });
  }
  return model;
}
