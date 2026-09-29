/**
 * The live equipment-set model's host: WorldClient's `equipmentSets` (SMSG_EQUIPMENT_SET_LIST, with
 * every save and deletion folded in), the player's inventory for where each piece is now, the three
 * equipment-set opcodes, and the use-result packet as `EQUIPMENT_SET_USE_RESULT` on the world bus.
 * The worn textures and the macro-icon list come from the seam, which already answers both C APIs.
 */
import { readField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { entryOf, playerInventory, type ItemSlotState, type PlayerInventoryState } from "../Inventory.js";
import {
  FrameXmlEquipmentSetModel, type FrameXmlEquipmentSetLocated, type FrameXmlEquipmentSetPlace,
  type FrameXmlEquipmentSetRow,
} from "./FrameXmlEquipmentSets.js";

type EquipmentSetWorld = Pick<WorldClient,
  "state" | "equipmentSets" | "saveEquipmentSet" | "useEquipmentSet" | "deleteEquipmentSet" | "events">;

export interface LiveFrameXmlEquipmentSetHost {
  world(): EquipmentSetWorld | undefined;
  /** An item's icon by entry (the seam's `GetInventoryItemTexture` source); undefined until known. */
  itemTexture(entry: number): string | undefined;
  /** `GetMacroIconInfo(index)` and `GetNumMacroIcons()`, as the seam's macro model answers them. */
  macroIcon(index: number): string | undefined;
  macroIconCount(): number;
}

/** A carried bag's stock id from its inventory position (19..22 → 1..4), a bank bag's (67..73 → 5..11). */
const CARRIED_BAG_ID_OFFSET = 18;
const BANK_BAG_ID_OFFSET = 62;

function inventoryOf(world: EquipmentSetWorld | undefined): PlayerInventoryState | undefined {
  return world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
}

/** Where a guid is by the stock addressing, with the opcode position the slot already carries. */
export function liveFrameXmlEquipmentSetPlace(inventory: PlayerInventoryState, guid: bigint): FrameXmlEquipmentSetLocated | undefined {
  if (guid === 0n) return undefined;
  const found = (slots: readonly ItemSlotState[], place: (slot: ItemSlotState) => FrameXmlEquipmentSetPlace) => {
    const slot = slots.find((candidate) => candidate.guid === guid);
    return slot === undefined ? undefined : { place: place(slot), bag: slot.bag, slot: slot.slot };
  };
  const worn = found(inventory.equipment, (slot) => ({ kind: "worn", slot: slot.index + 1 }));
  if (worn) return worn;
  const backpack = found(inventory.backpack, (slot) => ({ kind: "bag", bagId: 0, slot: slot.index + 1 }));
  if (backpack) return backpack;
  for (const bag of inventory.bags) {
    const carried = found(bag.slots, (slot) => ({ kind: "bag", bagId: bag.bagSlot - CARRIED_BAG_ID_OFFSET, slot: slot.index + 1 }));
    if (carried) return carried;
  }
  const bank = found(inventory.bank, (slot) => ({ kind: "bank", slot: slot.index + 1 }));
  if (bank) return bank;
  for (const bag of inventory.bankBags) {
    const banked = found(bag.slots, (slot) => ({ kind: "bankBag", bagId: bag.bagSlot - BANK_BAG_ID_OFFSET, slot: slot.index + 1 }));
    if (banked) return banked;
  }
  // The keyring holds no gear, and the buyback shelf is the vendor's until bought back.
  return undefined;
}

export function createLiveFrameXmlEquipmentSets(host: LiveFrameXmlEquipmentSetHost): FrameXmlEquipmentSetModel {
  const wornSlot = (slot: number): ItemSlotState | undefined => {
    const inventory = inventoryOf(host.world());
    return inventory && slot >= 1 && slot <= inventory.equipment.length ? inventory.equipment[slot - 1] : undefined;
  };
  return new FrameXmlEquipmentSetModel({
    sets: () => {
      const world = host.world();
      if (!world || !Array.isArray(world.equipmentSets)) return undefined;
      return world.equipmentSets.map((set): FrameXmlEquipmentSetRow => ({
        guid: set.guid, setId: set.setId, name: set.name, icon: set.icon, pieces: set.pieces,
      }));
    },
    locate: (guid) => {
      const inventory = inventoryOf(host.world());
      return inventory ? liveFrameXmlEquipmentSetPlace(inventory, guid) : undefined;
    },
    itemId: (guid) => {
      const world = host.world();
      const item = world && typeof world.state.objects?.get === "function" ? world.state.objects.get(guid) : undefined;
      const entry = item ? readField(item, "OBJECT_FIELD_ENTRY") : undefined;
      return entry !== undefined && entry > 0 ? entry : undefined;
    },
    wornGuid: (slot) => wornSlot(slot)?.guid ?? 0n,
    wornTexture: (slot) => {
      const item = wornSlot(slot)?.item;
      return item ? host.itemTexture(entryOf(item)) : undefined;
    },
    macroIcon: (index) => host.macroIcon(index),
    macroIconCount: () => host.macroIconCount(),
    save: (setGuid, index, name, icon, pieces) => host.world()?.saveEquipmentSet(setGuid, index, name, icon, pieces),
    use: (pieces, finished) => {
      const world = host.world();
      if (!world) return;
      // One answer per request: the core sends exactly one SMSG_EQUIPMENT_SET_USE_RESULT for a use.
      const off = world.events.on("EQUIPMENT_SET_USE_RESULT", ({ result }) => {
        off();
        finished(result === 0);
      });
      world.useEquipmentSet(pieces);
    },
    remove: (setGuid) => host.world()?.deleteEquipmentSet(setGuid),
    session: () => host.world(),
  });
}
