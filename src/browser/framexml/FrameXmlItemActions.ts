/**
 * The C side of the stock item actions: what the bags, the paper doll and the bind prompts call
 * around `UseContainerItem`, whose own binding stays in FrameXmlWorldSeam.ts and whose order is
 * `LiveWorldSeam.useContainerItem`'s (sell at a merchant, set ammo, wear gear, ask before binding, use).
 *
 * Measured before this table: a right click on a belt in the stock bags sent CMSG_USE_ITEM, which
 * `HandleUseItemOpcode` refuses for anything with an InventoryType, so gear could not be worn from
 * the bags at all; `PutItemInBag` answered false for the four carried bags, so a held item toggled
 * the bag instead of going into it; and the bind prompts' three answers were nil, so an accepted
 * EQUIP_BIND did nothing. The names here are the ones the client's own Lua calls:
 *
 * * `EquipPendingItem(slot)`, `CancelPendingEquip(slot)`, `ConfirmBindOnUse()` — the EQUIP_BIND,
 *   AUTOEQUIP_BIND and USE_BIND dialogs (StaticPopup.lua:1525-1571) that UIParent.lua:589-608 opens
 *   for the three `*_BIND_CONFIRM` events, whose argument is the slot the item would take.
 * * `PutItemInBackpack()`, `PutItemInBag(20..23)` — the bag bar with an item held
 *   (MainMenuBarBagButtons.lua:19, :53) and the equipment manager (EquipmentManager.lua:197, :210);
 *   the bank's own bag ids 68..74 stay with FrameXmlBank.ts.
 * * `SplitContainerItem(bag, slot, count)` — StackSplitFrame's Okay (ContainerFrame.lua:617, :748):
 *   the part goes on the cursor, and the next slot click sends CMSG_SPLIT_ITEM for it.
 * * `AutoEquipCursorItem()` — a click on the character model with an item held
 *   (PaperDollFrame.lua:151); `EquipCursorItem(slot)` and `EquipItemByName(item[, slot])` — the
 *   equipment manager, `/equip` and an action button's item (SecureTemplates.lua:358).
 * * `CursorCanGoInSlot(slot)` — the paper doll's highlight while an item is held
 *   (PaperDollFrame.lua:1203, EquipmentManager.lua:103).
 * * `GetInventoryItemsForSlot(slot, table)` — the paper-doll flyout (PaperDollFrame.lua:1793); the
 *   table is filled by the Lua half below, since a JS object pushed through GlueLua cannot carry
 *   numeric keys.
 * * The readers stock keeps beside them: durability, quality and ids by slot; `GetItemCount`,
 *   `GetItemSpell`, `GetItemIcon`, `IsEquippableItem`, `IsEquippedItem`, `IsUsableItem`,
 *   `IsConsumableItem`, `GetItemCooldown` by item; `GetInventoryAlertStatus`,
 *   `ContainerIDToInventoryID`, `KeyRingButtonIDToInvSlotID`.
 * * The AmmoSlot, inventory id 0 (`INVSLOT_AMMO`): arrows and bullets are not worn but named, as
 *   PLAYER_AMMO_ID, by CMSG_SET_AMMO — from a right click in the bags or a drop on the slot; the
 *   slot's readers answer that field (LiveWorldSeam, `#ammoEntry`). Measured before this: a right
 *   click on Rough Arrow sent CMSG_AUTOEQUIP_ITEM, which `Player::FindEquipSlot` has no row for.
 *
 * Every answer comes from the update fields and the session's item query cache. An item whose
 * template has not arrived is answered with nil, never with a guess, and nothing here fetches.
 */

import { KEYRING_SLOTS, KEYRING_SLOT_START } from "../Inventory.js";
import { FRAMEXML_BANK_BINDINGS, frameXmlBankButtonInventoryId } from "./FrameXmlBank.js";
import { FRAMEXML_POPUPS_BINDINGS } from "./FrameXmlPopups.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/**
 * The client's three bind prompts (UIParent.lua:589-608). The auto-equip form is a right click or a
 * click on the model, the equip form a drop on a named slot; both open the same two buttons over
 * `EquipPendingItem`/`CancelPendingEquip`, but UIParent hides one before it shows the other, so a
 * host has to fire the one the client would.
 */
export const FRAMEXML_BIND_CONFIRM_EVENTS = Object.freeze({
  autoEquip: "AUTOEQUIP_BIND_CONFIRM",
  equip: "EQUIP_BIND_CONFIRM",
  use: "USE_BIND_CONFIRM",
});

/** `ItemBondingType` (ItemTemplate.h): bound by equipping, bound by using. */
export const FRAMEXML_BIND_WHEN_EQUIPPED = 2;
export const FRAMEXML_BIND_WHEN_USE = 3;
/** `INVTYPE_NON_EQUIP`: what a potion, a recipe and a trade good have. */
export const FRAMEXML_INVTYPE_NON_EQUIP = 0;
/**
 * `INVTYPE_AMMO` (ItemTemplate.h:289): arrows and bullets, item class 6 in this realm's item_template.
 * The only type `Player::CanUseAmmo` lets `Player::SetAmmo` write into PLAYER_AMMO_ID (Player.cpp:12216-12266).
 */
export const FRAMEXML_INVTYPE_AMMO = 24;
/** `INVSLOT_AMMO` (Constants.lua:195): the paper doll's AmmoSlot, `GetInventorySlotInfo("AmmoSlot")`. */
export const FRAMEXML_INVSLOT_AMMO = 0;
/** ITEM_FIELD_FLAGS bit 0, `ITEM_FIELD_FLAG_SOULBOUND` (ItemDefines.h). */
export const FRAMEXML_ITEM_FIELD_FLAG_SOULBOUND = 0x1;
/** `ITEM_CLASS_CONSUMABLE` (ItemTemplate.h). */
export const FRAMEXML_ITEM_CLASS_CONSUMABLE = 0;

/**
 * Constants.lua:183-186, the equipment manager's packed location: a place flag, and for a bag the
 * stock container id above bit 8 with the 1-based slot below it.
 */
export const FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER = 0x00100000;
export const FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS = 0x00200000;
export const FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET = 8;

/**
 * DurabilityFrame.lua:1-12 asks `GetInventoryAlertStatus` by its own INVENTORY_ALERT_STATUS_SLOTS
 * order — head, shoulders, chest, waist, legs, feet, wrists, hands, weapon, shield, ranged — which
 * is neither the equipment order nor a contiguous run of it. These are those slots' 0-based
 * equipment indices.
 */
export const FRAMEXML_INVENTORY_ALERT_SLOTS: readonly number[] = Object.freeze([0, 2, 4, 5, 6, 7, 8, 9, 15, 16, 17]);

/** `Dual Wield` (674) and the shaman's (30798): the passives whose `SPELL_EFFECT_DUAL_WIELD` lets a one-hander into the off hand. */
export const FRAMEXML_DUAL_WIELD_SPELLS: ReadonlySet<number> = new Set([674, 30798]);

/** The four bag buttons' inventory ids (GetInventorySlotInfo "Bag0Slot".."Bag3Slot"). */
const FIRST_BAG_INVENTORY_ID = 20;
const LAST_BAG_INVENTORY_ID = 23;
const FIRST_BANK_BAG_CONTAINER = 5;
const LAST_BANK_BAG_CONTAINER = 11;
const INVENTORY_SLOT_BAG_START = 19;

/**
 * The 0-based equipment slots an `InventoryType` (ItemTemplate.h:263-293) may occupy — the lists of
 * `Player::FindEquipSlot` (Player.cpp:9784), with the four bag slots (19..22) for INVTYPE_BAG. A
 * one-hander reaches the off hand only with dual wield, which the caller reads off the known spells;
 * the realm still judges every equip, so this decides only which slot a prompt names, which button
 * highlights and whether a right click is an equip at all.
 */
export function frameXmlEquipmentSlotsForInventoryType(inventoryType: number, dualWield = false): readonly number[] {
  switch (inventoryType) {
    case 1: return [0]; // INVTYPE_HEAD
    case 2: return [1]; // INVTYPE_NECK
    case 3: return [2]; // INVTYPE_SHOULDERS
    case 4: return [3]; // INVTYPE_BODY, the shirt
    case 5: case 20: return [4]; // INVTYPE_CHEST, INVTYPE_ROBE
    case 6: return [5]; // INVTYPE_WAIST
    case 7: return [6]; // INVTYPE_LEGS
    case 8: return [7]; // INVTYPE_FEET
    case 9: return [8]; // INVTYPE_WRISTS
    case 10: return [9]; // INVTYPE_HANDS
    case 11: return [10, 11]; // INVTYPE_FINGER
    case 12: return [12, 13]; // INVTYPE_TRINKET
    case 16: return [14]; // INVTYPE_CLOAK
    case 13: return dualWield ? [15, 16] : [15]; // INVTYPE_WEAPON
    case 17: case 21: return [15]; // INVTYPE_2HWEAPON, INVTYPE_WEAPONMAINHAND
    case 14: case 22: case 23: return [16]; // INVTYPE_SHIELD, INVTYPE_WEAPONOFFHAND, INVTYPE_HOLDABLE
    case 15: case 25: case 26: case 28: return [17]; // INVTYPE_RANGED, INVTYPE_THROWN, INVTYPE_RANGEDRIGHT, INVTYPE_RELIC
    case 19: return [18]; // INVTYPE_TABARD
    // INVTYPE_BAG (Player.cpp:9898-9902) — quivers and ammo pouches too: class 11 with InventoryType
    // 18 in this realm's item_template.
    case 18: return [19, 20, 21, 22];
    // INVTYPE_NON_EQUIP (0), INVTYPE_AMMO (24) and INVTYPE_QUIVER (27, which no item here uses): no
    // case in FindEquipSlot, so NULL_SLOT and a refused CMSG_AUTOEQUIP_ITEM. Ammo is CMSG_SET_AMMO's.
    default: return [];
  }
}

/**
 * `ContainerIDToInventoryID(bagId)`: a carried bag 1..4 is the bag button 20..23, a bank bag 5..11
 * the bank's 68..74 (FrameXmlBank.ts). The backpack and the keyring are nobody's slot.
 */
export function frameXmlContainerInventoryId(bagId: number): number | undefined {
  if (bagId >= 1 && bagId < FIRST_BANK_BAG_CONTAINER) return INVENTORY_SLOT_BAG_START + bagId;
  if (bagId >= FIRST_BANK_BAG_CONTAINER && bagId <= LAST_BANK_BAG_CONTAINER) return frameXmlBankButtonInventoryId(bagId, true);
  return undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function optionalIntegerArg(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function unitArg(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

export const FRAMEXML_ITEM_ACTION_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  EquipPendingItem: (seam, args) => {
    seam.equipPendingItem?.(optionalIntegerArg(args[0]));
    return NOTHING;
  },
  CancelPendingEquip: (seam, args) => {
    seam.cancelPendingEquip?.(optionalIntegerArg(args[0]));
    return NOTHING;
  },
  ConfirmBindOnUse: (seam) => {
    seam.confirmBindOnUse?.();
    return NOTHING;
  },
  // False with nothing held: BackpackButton_OnClick then toggles the backpack, as the client does.
  PutItemInBackpack: (seam) => {
    const stored = seam.storeCursorItemInBag?.(0) ?? false;
    if (stored) seam.cursor?.sync();
    return [stored];
  },
  PutItemInBag: (seam, args) => {
    const inventoryId = integerArg(args[0]);
    if (inventoryId < FIRST_BAG_INVENTORY_ID || inventoryId > LAST_BAG_INVENTORY_ID) {
      return FRAMEXML_BANK_BINDINGS["PutItemInBag"]!(seam, args);
    }
    const stored = seam.storeCursorItemInBag?.(inventoryId - FIRST_BAG_INVENTORY_ID + 1) ?? false;
    if (stored) seam.cursor?.sync();
    return [stored];
  },
  // A host without the split cursor keeps FrameXmlBank's route: the part straight to a free slot.
  SplitContainerItem: (seam, args) => {
    const held = seam.splitContainerItem?.(integerArg(args[0]), integerArg(args[1]), integerArg(args[2])) ?? false;
    if (!held) return FRAMEXML_BANK_BINDINGS["SplitContainerItem"]!(seam, args);
    // As PickupContainerItem: one thing on the cursor, and the picture follows at once.
    seam.cursor?.clearOwn(false);
    seam.cursor?.sync();
    return NOTHING;
  },
  // A split part is destroyed by its count; a whole stack keeps FrameXmlPopups' DELETE_ITEM route.
  DeleteCursorItem: (seam, args) => {
    if (seam.deleteSplitCursorItem?.()) {
      seam.cursor?.sync();
      return NOTHING;
    }
    return FRAMEXML_POPUPS_BINDINGS["DeleteCursorItem"]!(seam, args);
  },
  AutoEquipCursorItem: (seam) => {
    seam.autoEquipCursorItem?.();
    seam.cursor?.sync();
    return NOTHING;
  },
  EquipCursorItem: (seam, args) => {
    seam.equipCursorItem?.(integerArg(args[0]));
    seam.cursor?.sync();
    return NOTHING;
  },
  EquipItemByName: (seam, args) => {
    seam.equipItemByName?.(args[0], optionalIntegerArg(args[1]));
    return NOTHING;
  },
  CursorCanGoInSlot: (seam, args) => [seam.cursorCanGoInSlot?.(integerArg(args[0])) ?? false],
  ContainerIDToInventoryID: (_seam, args) => optional(frameXmlContainerInventoryId(integerArg(args[0]))),
  // The keyring's 32 buttons are inventory ids 87..118 (Player.h KEYRING_SLOT_START + 1).
  KeyRingButtonIDToInvSlotID: (_seam, args) => {
    const id = integerArg(args[0]);
    return id >= 1 && id <= KEYRING_SLOTS ? [KEYRING_SLOT_START + id] : NOTHING;
  },
  GetContainerItemDurability: (seam, args) =>
    [...(seam.containerItemDurability?.(integerArg(args[0]), integerArg(args[1])) ?? NOTHING)],
  GetInventoryItemDurability: (seam, args) => [...(seam.inventoryItemDurability?.(integerArg(args[0])) ?? NOTHING)],
  GetInventoryItemQuality: (seam, args) => optional(seam.inventoryItemQuality?.(unitArg(args[0]), integerArg(args[1]))),
  GetInventoryItemID: (seam, args) => optional(seam.inventoryItemId?.(unitArg(args[0]), integerArg(args[1]))),
  GetContainerItemID: (seam, args) => optional(seam.containerItemId?.(integerArg(args[0]), integerArg(args[1]))),
  // PaperDollFrame.lua:1264 asks the getter form; the seam already answers IsInventoryItemBroken.
  GetInventoryItemBroken: (seam, args) => [seam.inventoryItemBroken(unitArg(args[0]), integerArg(args[1]))],
  GetItemCount: (seam, args) => [seam.itemCount?.(args[0], truthy(args[1])) ?? 0],
  GetItemSpell: (seam, args) => [...(seam.itemSpell?.(args[0]) ?? NOTHING)],
  GetItemIcon: (seam, args) => optional(seam.itemIcon?.(args[0])),
  IsEquippableItem: (seam, args) => optional(seam.isEquippableItem?.(args[0])),
  IsEquippedItem: (seam, args) => [seam.isEquippedItem?.(args[0]) ?? false],
  IsUsableItem: (seam, args) => optional(seam.isUsableItem?.(args[0])),
  IsConsumableItem: (seam, args) => optional(seam.isConsumableItem?.(args[0])),
  GetItemCooldown: (seam, args) => [...(seam.itemCooldown?.(args[0]) ?? [0, 0, 0])],
  // One flat list (location, id, …) in a single table; the Lua half keys it into stock's table.
  GetInventoryItemsForSlot: (seam, args) => [seam.inventoryItemsForSlot?.(integerArg(args[0])) ?? []],
  GetInventoryAlertStatus: (seam, args) => [seam.inventoryAlertStatus?.(integerArg(args[0])) ?? 0],
  // The merchant's «sell» pointer image over a bag or buyback slot (ContainerFrame.lua:786,
  // MerchantFrame.lua:447): this host draws no pointer images, as with ResetCursor (FrameXmlBank.ts).
  ShowContainerSellCursor: () => NOTHING,
  ShowBuybackSellCursor: () => NOTHING,
});

/**
 * The Lua half, appended to FRAMEXML_SEAM_PRELUDE: PaperDollFrame.lua:1793 hands
 * `GetInventoryItemsForSlot` its own table and reads it back by location, so the host's flat list
 * is keyed here, in the table stock passed (or a new one when it passed none).
 */
export const FRAMEXML_ITEM_ACTIONS_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local itemsForSlot = rawget(_G, "__fxSeam_GetInventoryItemsForSlot")
  if impl ~= nil and itemsForSlot ~= nil then
    local type = type
    impl.GetInventoryItemsForSlot = function(slot, t)
      if type(t) ~= "table" then t = {} end
      local list = itemsForSlot(slot)
      if type(list) == "table" then
        for index = 1, #list, 2 do t[list[index]] = list[index + 1] end
      end
      return t
    end
  end
end
`;
