/**
 * What the stock DurabilityFrame (FrameXML TOC line 121, plan item 3.06) needs besides its events.
 *
 * `DurabilityFrame_SetAlerts` (DurabilityFrame.lua:18-64) paints the figure's eleven parts from
 * `GetInventoryAlertStatus` (FrameXmlItemActions.ts; UPDATE_INVENTORY_ALERTS is
 * FrameXmlInventoryAlerts.ts', UPDATE_INVENTORY_DURABILITY FrameXmlRepair.ts'). Two more names:
 *
 * * `OffhandHasWeapon()` picks the off-hand weapon or the shield texture for index 10. Wow.exe
 *   3.3.5a 12340 (0x005eac10, read-only Ghidra): with the active player, it takes the item in
 *   equipment slot 16 (0-based, the off hand; 0x00754390 answers that bag slot's item) and answers 1
 *   when that item's class — the Item.dbc row of its entry, record offset 4 (0x00707220) — is 2
 *   (weapon); anything else, an empty slot included, answers nil. Here the class comes from the
 *   realm's item query cache (`ItemTemplate.itemClass`), which serves the same column: until that
 *   answer has arrived the item reads as no weapon.
 * * `VehicleSeatIndicator` — with any alert the function reads `VehicleSeatIndicator:IsShown()`
 *   without a nil check (DurabilityFrame.lua:59). The frame belongs to VehicleMenuBar.xml (TOC 142),
 *   which the world vertical loads since 11.02-F2; for a TOC without it a hidden frame of that name
 *   stands in, only while a reader of it is loaded and the name is free — and so does `VehicleMenuBar`, for the same
 *   file's other reader (`standInFrameXmlVehicleFrames` below). UIParent_ManageFramePositions
 *   (UIParent.lua:1885-1887) reads it guarded and, hidden, it moves nothing.
 */

import type { GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";

/** The client's 0-based equipment slot of the off hand (EQUIPMENT_SLOT_OFFHAND). */
export const FRAMEXML_OFFHAND_EQUIPMENT_SLOT = 16;
/** Item.dbc ClassID of a weapon (ITEM_CLASS_WEAPON). */
export const FRAMEXML_ITEM_CLASS_WEAPON = 2;

/** The part of the world seam `OffhandHasWeapon` reads. */
export interface FrameXmlDurabilityHost {
  offhandHasWeapon?(): boolean;
}

export const FRAMEXML_DURABILITY_BINDINGS: Readonly<Record<string,
  (host: FrameXmlDurabilityHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  OffhandHasWeapon: (host) => [host.offhandHasWeapon?.() ? 1 : undefined],
});

/**
 * Whether an off-hand item of this class counts as a weapon, the way 0x005eac10 compares it.
 * `undefined` — no item, or its class not known yet — is no weapon.
 */
export function frameXmlOffhandIsWeapon(itemClass: number | undefined): boolean {
  return itemClass === FRAMEXML_ITEM_CLASS_WEAPON;
}

/**
 * VehicleMenuBar.xml's two frames that stock code outside it reads unguarded, and who reads them:
 * DurabilityFrame_SetAlerts (above) and MainMenuBar_ToPlayerArt (MainMenuBar.lua:109-138: its
 * `VehicleMenuBar:Hide()` and the seat indicator's slide), which the stock MainMenuBar runs on every
 * PLAYER_ENTERING_WORLD after the first — a loading screen's (FrameXmlWorldEntry.ts).
 */
const VEHICLE_STAND_INS: readonly (readonly [string, readonly string[]])[] = Object.freeze([
  ["VehicleSeatIndicator", ["DurabilityFrame_SetAlerts", "MainMenuBar_ToPlayerArt"]],
  ["VehicleMenuBar", ["MainMenuBar_ToPlayerArt"]],
]);

/**
 * After the corpus ran: a hidden frame for each of those names that a loaded reader needs and nothing
 * else took (the real VehicleMenuBar.xml, which the world vertical loads since 11.02-F2, makes this a no-op). Returns the names
 * it created.
 */
export function standInFrameXmlVehicleFrames(vm: GlueLuaVm, bridge: FrameXmlUiBridge): string[] {
  const created: string[] = [];
  for (const [name, readers] of VEHICLE_STAND_INS) {
    // rawget: a subset boot without the readers must not count a miss for a name it never reads.
    const probe = vm.compileFunction(
      `if rawget(_G, ${JSON.stringify(name)}) ~= nil then return false end
      for _, reader in ipairs({ ${readers.map((reader) => JSON.stringify(reader)).join(", ")} }) do
        if type(rawget(_G, reader)) == "function" then return true end
      end
      return false`,
      "webclient/vehicle-stand-in", []);
    if (!probe) continue;
    let needed = false;
    try {
      needed = vm.call(probe, [], 1)[0] === true;
    } finally {
      vm.release(probe);
    }
    if (!needed) continue;
    const frame = bridge.CreateFrame("Frame", name, bridge.getFrame("UIParent"));
    if (!frame) continue;
    bridge.Hide(frame);
    created.push(name);
  }
  return created;
}
