/**
 * 12.10 (7.27): building minimap or terrain minimap, and which kind of group the building minimap
 * collects tiles from — Wow.exe 3.3.5a 12340, read 11.10–12.10 (`.runtime/re-2026-10-11/glue-1110/g16-g19.txt`,
 * `.runtime/re-2026-10-12/mm1210/mm1210-a…m.txt`).
 *
 * 0x007F5BA0 (the minimap's per-frame update) decides it from the group the character is in:
 *
 * - 0x007A1640 returns the `WMOAreaTable` row of that group (MOGP group id) and the row of the whole
 *   building (group −1). Root `Flags & 0x1` forces the building minimap; root `Flags & 0x18` forces it
 *   too and also asks for the whole-building tile set (below).
 * - 0x007A1480 (also the ZONE_CHANGED_INDOORS test): the group has no MOGP 0x8 — an interior.
 * - The group row's `Flags & 0x20` vetoes all of it: terrain minimap.
 * - Otherwise the building minimap is on when any of the three holds, and 0x007A18D0 finds the group.
 *   It skips exterior groups (MOGP 0x8) of an instance whose runtime flag 0x400 is set — set only by
 *   0x007B64F0, the reposition of a map object the game moves (a transport's WMO). The locator's floors
 *   are static WMOs, so that skip never applies here.
 *
 * Which tiles (0x007A17E0 → 0x007B00A0):
 *
 * - `whole`: root `Flags & 0x18` and the group has MOGP 0x8 or 0x40 — the building's own whole-building
 *   set, group number = `MOHD.nGroups`, cut over the root box (0x007AFE70). Stormwind (root 0x10) bakes
 *   81 such tiles, Dalaran (root 0x9) 30; no other WMO has one (12.10 census of md5translate).
 * - `rooms`: the portal walk from the group (0x007AFC70) over groups of the same kind — an interior group
 *   keeps groups whose `flags & 0x48` equals its own `flags & 0x40` (pure rooms with pure rooms, rooms lit
 *   as exterior with their own kind); an exterior one keeps groups with 0x8.
 *
 * Data (dataset `WMOAreaTable.dbc`, 22,550 rows): 0x1 on 5 rows, 0x8 on 3, 0x10 on 1, 0x20 on 2 — Stormwind's
 * root `61|0|-1` is the only 0x10, its Valley of Heroes group 2539 and exterior group 24611 carry 0x20,
 * Dalaran `5164|0..2|-1` carries 0x9, Trial of the Crusader 5612 and its intact floor 5686 carry 0x1. So in
 * Stormwind's streets (groups lit as exterior, 0x40, or open, 0x8) the original shows the city's own
 * whole-building bake; inside a shop (pure interior) the shop's rooms; in the Valley of Heroes the terrain.
 */

/** Root row: always the building minimap (0x007F5BA0 `local_18`). */
export const WMO_AREA_MINIMAP_ALWAYS = 0x1;
/** Root row: the building minimap with the whole-building set (0x007F5BA0 `DAT_00d39450`). */
export const WMO_AREA_MINIMAP_WHOLE = 0x18;
/** Group row: never the building minimap. */
export const WMO_AREA_MINIMAP_NEVER = 0x20;
/** MOGP: a group open to the sky (`AreaLocator.ts` `MOGP_FLAG_EXTERIOR`). */
export const MOGP_EXTERIOR = 0x8;
/** MOGP: a group lit as exterior. */
export const MOGP_EXTERIOR_LIT = 0x40;
/** MOGP/MOGI: a group the walk never enters (0x007AFC70 reads the MOGI flags' low byte as signed). */
export const MOGP_UNREACHABLE = 0x80;

export type WmoMinimapMode = "terrain" | "whole" | "rooms";

/**
 * The 0x007F5BA0 decision for a character in a static WMO group with MOGP flags `groupFlags`; the two
 * `WMOAreaTable` rows' flags, undefined when there is no row.
 */
export function wmoMinimapMode(groupFlags: number, groupRowFlags: number | undefined, rootRowFlags: number | undefined): WmoMinimapMode {
  if (groupRowFlags !== undefined && (groupRowFlags & WMO_AREA_MINIMAP_NEVER) !== 0) return "terrain";
  const interior = (groupFlags & MOGP_EXTERIOR) === 0;
  const always = rootRowFlags !== undefined && (rootRowFlags & WMO_AREA_MINIMAP_ALWAYS) !== 0;
  const whole = rootRowFlags !== undefined && (rootRowFlags & WMO_AREA_MINIMAP_WHOLE) !== 0;
  if (!always && !whole && !interior) return "terrain";
  // 0x007A17E0: the whole-building flag survives only on a group with 0x8 or 0x40.
  if (whole && (groupFlags & (MOGP_EXTERIOR | MOGP_EXTERIOR_LIT)) !== 0) return "whole";
  return "rooms";
}

/** 0x007B00A0 → 0x007AFC70: the bits of a group's MOGP flags the room walk compares… */
export function wmoMinimapKindMask(groupFlags: number): number {
  return (groupFlags & MOGP_EXTERIOR) === 0 ? MOGP_EXTERIOR | MOGP_EXTERIOR_LIT : MOGP_EXTERIOR;
}

/** …and the value they must have, both taken from the group the walk starts in. */
export function wmoMinimapKindValue(groupFlags: number): number {
  return (groupFlags & MOGP_EXTERIOR) === 0 ? groupFlags & MOGP_EXTERIOR_LIT : MOGP_EXTERIOR;
}
