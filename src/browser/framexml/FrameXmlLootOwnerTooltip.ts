/**
 * Plan item 5.28 (04.10, L6): the two loot lines `GameTooltip:SetUnit` writes for a corpse SMSG_LOOT_LIST
 * named, as Wow.exe 3.3.5a 12340 does (the unit tooltip writer at 0x622220, read 2026-10-04): the unit's
 * master looter (+0xc40, accessor 0x715fc0) as `MASTER_LOOTER: <name>`, then its allowed looter (+0xc48,
 * 0x715fb0) as `LOOT: <name>` — «%s: %s» with the GlobalStrings value, white (0xffffffff at 0xad2d30),
 * after the faction and quest lines, before the threat line. A name not yet in the name cache leaves its
 * line out (the query's answer refreshes the tooltip, 0x61ddd0). Packed guids of 0 write nothing.
 *
 * The stock `SetUnit` writer (GlueWidgets.ts `setGameTooltipUnit`) reads these through the tooltip
 * adapter's `unitLootOwners`, for a dead unit, after its other lines (04.10, L4).
 */

/** SMSG_LOOT_LIST's two owners (world/LootProtocol.ts LootOwners). */
export interface FrameXmlLootOwners {
  readonly masterLooterGuid: bigint;
  readonly allowedLooterGuid: bigint;
}

/** One line: its GlobalStrings label and the name after it. */
export interface FrameXmlLootOwnerLine {
  readonly globalName: "MASTER_LOOTER" | "LOOT";
  readonly name: string;
}

/**
 * The lines for a unit's loot owners; `name` answers the name cache (undefined: not there, the caller
 * asks for it).
 */
export function frameXmlLootOwnerLines(owners: FrameXmlLootOwners | undefined,
  name: (guid: bigint) => string | undefined): FrameXmlLootOwnerLine[] {
  const lines: FrameXmlLootOwnerLine[] = [];
  if (!owners) return lines;
  const master = owners.masterLooterGuid !== 0n ? name(owners.masterLooterGuid) : undefined;
  if (master) lines.push({ globalName: "MASTER_LOOTER", name: master });
  const allowed = owners.allowedLooterGuid !== 0n ? name(owners.allowedLooterGuid) : undefined;
  if (allowed) lines.push({ globalName: "LOOT", name: allowed });
  return lines;
}

/** `«%s: %s»` (0x622260) with the label resolved; the label's own key when GlobalStrings lack it. */
export function frameXmlLootOwnerText(line: FrameXmlLootOwnerLine, globalString: (key: string) => string | undefined): string {
  return `${globalString(line.globalName) ?? line.globalName}: ${line.name}`;
}
