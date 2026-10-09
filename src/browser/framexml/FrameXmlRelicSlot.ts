/**
 * `UnitHasRelicSlot(unit)` and the bag portraits, `SetBagPortraitTexture(texture, bagId)`.
 *
 * Stock callers: `PaperDollFrame.lua:1094-1098` shows the relic slot instead of `AmmoSlot` when
 * `UnitHasRelicSlot("player")`; `InspectPaperDollFrame` asks for the inspected unit;
 * `ContainerFrame.lua:493, 507` draws a bag's icon into its frame's round portrait.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra), in this file's words:
 * * `UnitHasRelicSlot` (0x611330) needs a unit string, resolves it to an object and answers 1 only
 *   for a player object whose class (UNIT_FIELD_BYTES_0 byte 1) has ChrClasses.Flags bit 0x8 (record
 *   offset 0x24); anything else answers nil.
 * * `SetBagPortraitTexture` (0x5d7180) reads the texture and a number, truncates it (0x88b9c0,
 *   cvttsd2si) and takes it as a container id: 1..11 (the four carried bags, then the seven bank bags) draws that bag item's icon
 *   (`Interface\Icons\<icon>`) into the texture as a round portrait (0x619330, the drawing
 *   `SetPortraitToTexture` does); 0 or below — the backpack — does nothing; 12 and up is the error
 *   "Invalid slot in SetBagPortraitTexture"; no bag in the slot does nothing.
 *
 * ChrClasses.Flags reaches the browser with `/dbc/character-creation?v=4` (`CreationClass.flags`,
 * learned by `ui/UnitSnapshot.learnCreationNames`): this dataset's 13 HERO (0x3a) has the slot. Until
 * a gateway that serves the column has answered — the running one may predate it — the stock rows
 * are read instead: bit 0x8 is set exactly for 2 PALADIN (0x3a), 6 DEATHKNIGHT (0x7a), 7 SHAMAN
 * (0x1a) and 11 DRUID (0x0a) in `dbc_source/ChrClasses.dbc`.
 */

import { classFlags } from "../ui/UnitSnapshot.js";

/** ChrClasses.Flags bit the client reads for a relic slot. */
export const CHR_CLASS_FLAG_RELIC_SLOT = 0x8;

/** The stock classes with `CHR_CLASS_FLAG_RELIC_SLOT`: paladin, death knight, shaman, druid. */
export const FRAMEXML_RELIC_CLASSES: ReadonlySet<number> = new Set([2, 6, 7, 11]);

/** The same classes by ChrClasses.Filename, for seams that know a class only by its token. */
export const FRAMEXML_RELIC_CLASS_TOKENS: ReadonlySet<string> = new Set(["PALADIN", "DEATHKNIGHT", "SHAMAN", "DRUID"]);

/**
 * Whether a class has a relic slot: by its ChrClasses.Flags — given, else as the dataset served them —
 * and by the stock rows only while neither is known.
 */
export function frameXmlClassHasRelicSlot(classId: number | undefined, flags: number | undefined = classFlags(classId)): boolean {
  if (flags !== undefined) return (flags & CHR_CLASS_FLAG_RELIC_SLOT) !== 0;
  return classId !== undefined && FRAMEXML_RELIC_CLASSES.has(classId);
}

/** The part of the world seam the binding reads. */
export interface FrameXmlRelicSlotHost {
  unitHasRelicSlot?(unit: string): boolean;
}

export const FRAMEXML_RELIC_SLOT_BINDINGS: Readonly<Record<string,
  (host: FrameXmlRelicSlotHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  UnitHasRelicSlot: (host, args) => [
    typeof args[0] === "string" && host.unitHasRelicSlot?.(args[0]) ? 1 : undefined,
  ],
});

/**
 * Appended to FRAMEXML_SEAM_PRELUDE: `SetBagPortraitTexture` over the seam's own
 * `ContainerIDToInventoryID` and `GetInventoryItemTexture`, drawn by `SetPortraitToTexture`.
 */
export const FRAMEXML_BAG_PORTRAIT_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local tonumber, error, floor, ceil = tonumber, error, math.floor, math.ceil
  if impl ~= nil then
    impl.SetBagPortraitTexture = function(texture, slot)
      local number = tonumber(slot)
      if number == nil or number ~= number then error("Usage: SetBagPortraitTexture(texture, slot)", 2) end
      -- Truncated toward zero, as 0x88b9c0 (cvttsd2si) converts it.
      local bag = number < 0 and ceil(number) or floor(number)
      if bag < 1 then return end
      if bag > 11 then error("Invalid slot in SetBagPortraitTexture", 2) end
      local inventoryId = ContainerIDToInventoryID(bag)
      local path = inventoryId and GetInventoryItemTexture("player", inventoryId)
      if path then SetPortraitToTexture(texture, path) end
    end
  end
end
`;
