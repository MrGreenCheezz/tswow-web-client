/**
 * The model a unit wears: what the renderer and the portraits draw, whatever interface is on screen.
 */

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { unit } from "../../world/Fields.js";
import { PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM } from "../../world/CharacterStatFields.js"; // 05.10-A7a-A 6.09
import type { WorldObjectState } from "../../world/WorldState.js";
import type { CreatureModelClient, EquippedItem, UnitModel } from "../CreatureModelClient.js";
import type { ItemMetadataClient } from "../ItemMetadata.js";
import { withVirtualWeapons } from "../NpcWeapons.js"; // 05.10-A7a-B 6.02
import { wornSheathes } from "../SheathPoints.js"; // 05.10-A7a-G2 6.08
import { corpseModelFor } from "../CorpseModel.js"; // 05.10-A7a-G2 6.05
import { mirrorImageModelFor } from "../MirrorImageModel.js"; // 05.10-A7a-H 6.11б
import { mountDisplayModel } from "../RenderLookups.js"; // 22.10 ARC-2 S2b
import { UNIT_FLAG2_MIRROR_IMAGE, type MirrorImages } from "../../world/MirrorImages.js"; // 05.10-A7a-H 6.11б
import { game } from "../game/Context.js";

const VISIBLE_ITEM_FIRST = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const VISIBLE_ITEM_STRIDE = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - VISIBLE_ITEM_FIRST;
const VISIBLE_ITEM_COUNT = 19;
// 05.10-A7a-A 6.09: PLAYER_FLAGS_HIDE_HELM/CLOAK (Player.h:364-365; PLAYER_FLAGS is PUBLIC, so other
// players' bits arrive too) and the two visible-item words they hide: EQUIPMENT_SLOT_HEAD 0, BACK 14.
const VISIBLE_SLOT_HEAD = 0;
const VISIBLE_SLOT_BACK = 14;

/** 05.10-A7a-A 6.09: the hide-helm and hide-cloak bits of a player's PLAYER_FLAGS (0 for others). */
function hiddenWornFlags(object: WorldObjectState): number {
  if (object.typeId !== 4) return 0;
  return (object.fields.get(UPDATE_FIELDS.PLAYER_FLAGS.offset) ?? 0) & (PLAYER_FLAGS_HIDE_HELM | PLAYER_FLAGS_HIDE_CLOAK);
}

interface ResolvedPlayerModel {
  readonly creatureModels: CreatureModelClient;
  readonly itemMetadata: ItemMetadataClient | undefined;
  readonly creatureGeneration: number;
  readonly itemGeneration: number | undefined;
  readonly displayId: number;
  readonly nativeDisplayId: number;
  readonly bytes: number;
  readonly look: number;
  readonly look2: number;
  readonly visibleItems: Uint32Array;
  /** 05.10-A7a-A 6.09: PLAYER_FLAGS & (HIDE_HELM | HIDE_CLOAK) the look was built with. */
  readonly hiddenWorn: number;
  readonly model: UnitModel;
}

// WorldObjectState keeps its fields Map while packet updates mutate individual words. A WeakMap
// ties this memo to that exact world object without retaining units after they leave visibility.
const resolvedPlayerModels = new WeakMap<WorldObjectState, ResolvedPlayerModel>();

function visibleItemsMatch(fields: WorldObjectState["fields"], items: Uint32Array): boolean {
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    if ((fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0) !== items[slot]) return false;
  }
  return true;
}

function visibleItemsSnapshot(fields: WorldObjectState["fields"]): Uint32Array {
  const items = new Uint32Array(VISIBLE_ITEM_COUNT);
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    items[slot] = fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
  }
  return items;
}

/**
 * The model a unit wears. Creatures carry their textures in the display record; a player's body
 * and hair have to be looked up from its appearance bytes, and until that answer arrives the unit
 * keeps its stand-in rather than appearing untextured for good.
 */
export function unitModelFor(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
  mirrorImages?: MirrorImageSource, // 05.10-A7a-H 6.11б: SMSG_MIRRORIMAGE_DATA replies
): UnitModel | undefined {
  return resolveUnitModel(object, creatureModels, itemMetadata, mirrorImages, false);
}

/**
 * 22.10 ARC-2 S2c: what `unitModelFor` would answer right now, with nothing asked and nothing remembered — no item
 * load, no look fetched, no mirror-image question, no weapon request, no memo written (memos are read). The frame
 * loop answers the renderer's units with it before `draw` (game/RenderLookupsBuilder.ts) and runs `unitModelFor`,
 * the asking path, for the units `draw` admitted right after it. The two differ only where `unitModelFor`'s own
 * asks change its answer in the same call: an item template already on the world client is absorbed by
 * `ItemMetadataClient.load`, so that dressed look reaches the renderer a frame later.
 */
export function unitModelPeek(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
  mirrorImages?: MirrorImageSource,
): UnitModel | undefined {
  return resolveUnitModel(object, creatureModels, itemMetadata, mirrorImages, true);
}

/**
 * 22.10 ARC-2 S2c: whether `unitModelPeek`'s answer for this object can change with time alone: a creature
 * flagged as a mirror image reads `MirrorImages.awaitingAfterGet`, whose wait runs out on the clock. Every
 * other input is a field of the object or a client revision (game/RenderLookupsBuilder.ts keys on those).
 */
export function unitModelVolatile(object: WorldObjectState): boolean {
  return object.typeId !== 4 && object.typeId !== 7
    && ((object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset) ?? 0) & UNIT_FLAG2_MIRROR_IMAGE) !== 0;
}

/**
 * 22.10 ARC-2 S2c: the client identities and revisions `unitModelPeek` reads, for the table's change key.
 */
export function unitModelInputs(
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
  mirrorImages?: Pick<MirrorImages, "generation">,
): unknown[] {
  return [
    creatureModels, creatureModels?.generation, creatureModels?.npcWeapons, creatureModels?.npcWeapons.generation,
    itemMetadata, itemMetadata?.generation, mirrorImages, mirrorImages?.generation,
  ];
}

/** 05.10-A7a-H 6.11б: the mirror-image replies; 22.10 ARC-2 S2c: `peek`/`awaitingAfterGet` for the read-only path. */
export type MirrorImageSource = Pick<MirrorImages, "get" | "awaiting"> & Partial<Pick<MirrorImages, "peek" | "awaitingAfterGet">>;

function resolveUnitModel(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
  mirrorImages: MirrorImageSource | undefined,
  readOnly: boolean, // 22.10 ARC-2 S2c
): UnitModel | undefined {
  // 05.10-A7a-G2 6.05: a corpse (or the renderer's view of one) wears its owner's look or its bones.
  if (object.typeId === 7) return corpseModelFor(object, creatureModels, readOnly);
  const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
  const metadata = creatureModels?.get(displayId);
  if (!metadata || !creatureModels) return metadata;
  // 05.10-A7a-B 6.02: a creature's UNIT_VIRTUAL_ITEM_SLOT_ID weapons ride `held` (NpcWeapons.ts).
  if (object.typeId !== 4) {
    // 05.10-A7a-H 6.11б: a mirror image, outfit NPC or NPCBot wears the look its reply describes.
    const flags2 = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset) ?? 0;
    const worn = mirrorImages !== undefined && (flags2 & UNIT_FLAG2_MIRROR_IMAGE) !== 0
      ? (readOnly // 22.10 ARC-2 S2c: the reply and the wait as they stand after `get` would have asked
        ? mirrorImageModelFor(object, metadata, mirrorImages.peek?.(object.guid, displayId, flags2), creatureModels,
          mirrorImages.awaitingAfterGet?.(object.guid, displayId, flags2) ?? false, true)
        : mirrorImageModelFor(object, metadata, mirrorImages.get(object.guid, displayId, flags2), creatureModels,
          mirrorImages.awaiting(object.guid, displayId)))
      : metadata;
    return withVirtualWeapons(worn, object, creatureModels.npcWeapons, readOnly);
  }
  // A player who is not currently in their own body: a cat, a bear, a sheep, a ghost wolf. The
  // server writes NATIVEDISPLAYID once, in `Player::InitDisplayIds`, and moves DISPLAYID for every
  // shapeshift — the field is PUBLIC (`generated/updateFields.ts:799-806`), so the difference is
  // readable here and it is the whole test. Pasting the character's own skin, hair and worn armour
  // onto a bear's record made a bear textured as a night elf; worse, the display records the
  // gateway serves for a `Character\` model already carry a baked appearance
  // (`gateway/CreatureModelMetadata.ts:103-105` → `CharacterAppearance.forModel:941-950`), so the
  // paste also threw away the correct look for any polymorph into another race.
  const nativeDisplayId = unit.nativeDisplayId(object) ?? displayId;
  if (displayId !== nativeDisplayId) return metadata;
  // UNIT_FIELD_BYTES_0 packs race, class, gender, power type; PLAYER_BYTES packs skin, face,
  // hair style and hair colour; PLAYER_BYTES_2 starts with the facial-hair choice. Face and
  // facial hair were simply never read, which is most of why a player had no face.
  const bytes = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
  const look = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
  const look2 = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
  const hiddenWorn = hiddenWornFlags(object); // 05.10-A7a-A 6.09
  const cached = resolvedPlayerModels.get(object);
  if (cached && cached.creatureModels === creatureModels && cached.itemMetadata === itemMetadata
    && cached.creatureGeneration === creatureModels.generation
    && cached.itemGeneration === itemMetadata?.generation
    && cached.displayId === displayId && cached.nativeDisplayId === nativeDisplayId
    && cached.bytes === bytes && cached.look === look && cached.look2 === look2
    && cached.hiddenWorn === hiddenWorn // 05.10-A7a-A 6.09
    && visibleItemsMatch(object.fields, cached.visibleItems)) return cached.model;
  const equipment = visibleEquipmentFor(object, itemMetadata, readOnly);
  const appearance = (readOnly ? creatureModels.peekAppearance : creatureModels.playerAppearance).call(creatureModels,
    bytes & 0xff, (bytes >>> 16) & 0xff,
    look & 0xff, (look >>> 8) & 0xff, (look >>> 16) & 0xff, (look >>> 24) & 0xff,
    look2 & 0xff, equipment, (bytes >>> 8) & 0xff); // 05.10-A7a-A 6.10: the class, for the DK eye glow
  if (appearance === undefined) return undefined;
  const appearancePending = visibleEquipmentMetadataPendingFor(object, itemMetadata);
  const wornSheathe = wornSheathes(equipment); // 05.10-A7a-G2 6.08: where the hands' weapons stow
  const model: UnitModel = {
    ...metadata,
    appearance,
    appearancePending,
    ...(wornSheathe === undefined ? {} : { wornSheathe }), // 05.10-A7a-G2 6.08
  };
  // Pending item rows must keep the existing retry path active. Both real clients expose a
  // generation that changes when their async answers arrive; replay/test clients without one
  // continue through the ordinary resolver so a mutable mock cannot leave a stale appearance.
  if (!readOnly && !appearancePending && Number.isFinite(creatureModels.generation)
    && (itemMetadata === undefined || Number.isFinite(itemMetadata.generation))) {
    resolvedPlayerModels.set(object, {
      creatureModels, itemMetadata, creatureGeneration: creatureModels.generation,
      itemGeneration: itemMetadata?.generation, displayId, nativeDisplayId,
      bytes, look, look2, visibleItems: visibleItemsSnapshot(object.fields), hiddenWorn, model, // 05.10-A7a-A 6.09
    });
  }
  return model;
}

/** The live wrapper retains the UI's current clients; replay callers pass the captured ones. */
export function unitModel(object: WorldObjectState): UnitModel | undefined {
  return unitModelFor(object, game.creatureModels, game.itemMetadata, game.world?.mirrorImages); // 05.10-A7a-H 6.11б
}

/**
 * The model a unit is riding, when the server says it is riding one.
 *
 * `UNIT_FIELD_MOUNTDISPLAYID` is a `CreatureDisplayInfo` id like the one beside it: `Unit::Mount`
 * (`Unit.cpp:8668-8673`) writes it and `UNIT_FLAG_MOUNT` and leaves DISPLAYID alone, and
 * `WorldSession::SendDoFlight` (`TaxiHandler.cpp:121-131`) reaches the same method — so a taxi
 * gryphon and a paladin's charger arrive by one road. Until this slice the field had one reader in
 * the whole repository, `WindowBindings.ts:331`, and that one only asked whether it was zero.
 *
 * No appearance is composed and none is wanted: a mount is a creature and wears its own skin
 * variations. That is also why this is not `unitModel` reading a second field — `unitModel` exists
 * to decide whether the *player's* face belongs on the record, and a horse has no such question.
 */
export function mountModelFor(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
): UnitModel | undefined {
  // Requests are owned by the once-per-world-update pass in `ui/WorldView.ts`; this lookup stays
  // read-only so portrait/replay callers do not start network work merely by asking for a mount.
  // 22.10 ARC-2 S2b: one rule with the renderer's read of the pushed display map (RenderLookups.ts).
  return mountDisplayModel(object, creatureModels);
}

/** The live wrapper retains the UI's current creature-model client. */
export function mountModel(object: WorldObjectState): UnitModel | undefined {
  return mountModelFor(object, game.creatureModels);
}

/**
 * What a player is visibly wearing: nineteen PLAYER_VISIBLE_ITEM_N_ENTRYID fields, two words
 * apart. The item's inventory slot and display id come from the metadata the gateway already
 * serves for bags and tooltips, so the appearance request needs no new lookup — but an item that
 * has not been fetched yet is skipped rather than waited for, and appears a frame later.
 */
export function visibleEquipmentFor(
  object: WorldObjectState,
  itemMetadata: ItemMetadataClient | undefined,
  readOnly = false, // 22.10 ARC-2 S2c: the rows already here, nothing loaded
): EquippedItem[] {
  // Which word an item came from is its EQUIPMENT_SLOT, and that is not the same thing as its
  // inventory type: a one-handed weapon is INVTYPE_WEAPON whichever hand it is in.
  const worn: { slot: number; entry: number }[] = [];
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    const entry = object.fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
    if (entry > 0) worn.push({ slot, entry });
  }
  if (worn.length === 0) return [];
  if (!readOnly) void itemMetadata?.load(worn.map(({ entry }) => entry)).catch(() => undefined);

  const equipment: EquippedItem[] = [];
  const hidden = hiddenWornFlags(object); // 05.10-A7a-A 6.09
  for (const { slot, entry } of worn) {
    // 05.10-A7a-A 6.09: a helm or cloak the player hid is not worn for the look (TC's mirror image
    // does the same, SpellHandler.cpp) — still loaded above, so the pending test does not wait on it.
    if ((slot === VISIBLE_SLOT_HEAD && (hidden & PLAYER_FLAGS_HIDE_HELM) !== 0)
      || (slot === VISIBLE_SLOT_BACK && (hidden & PLAYER_FLAGS_HIDE_CLOAK) !== 0)) continue;
    const item = itemMetadata?.get(entry);
    if (item && item.displayId > 0) {
      equipment.push({
        slot, inventoryType: item.inventoryType, displayId: item.displayId,
        ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
        ...(item.sheath === undefined ? {} : { sheathe: item.sheath }), // 05.10-A7a-G2 6.08: not in the look's key
      });
    }
  }
  return equipment;
}

/** Whether the appearance request is currently based on a partial visible-item snapshot. */
export function visibleEquipmentMetadataPendingFor(
  object: WorldObjectState,
  itemMetadata: ItemMetadataClient | undefined,
): boolean {
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    const entry = object.fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
    if (entry <= 0) continue;
    const item = itemMetadata?.get(entry);
    if (!item) return true;
    // A dump row has display/inventory data but no ItemSubClass until the live item query lands.
    // Slot 17 is the only one where that missing field changes a visible action (wand vs gun).
    if (slot === 17 && item.subClass === undefined) return true;
  }
  return false;
}

/** The live wrapper retains the UI's current item-metadata client. */
export function visibleEquipment(object: WorldObjectState): EquippedItem[] {
  return visibleEquipmentFor(object, game.itemMetadata);
}
