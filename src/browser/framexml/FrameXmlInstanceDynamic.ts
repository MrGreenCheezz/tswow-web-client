/**
 * Plan item 5.28 (04.10, L6): the last two values of `GetInstanceInfo` as Wow.exe 3.3.5a 12340 answers
 * them (0x51a8c0, read 2026-10-04): the sixth is the player difficulty word 0x00bd1980 (the second word
 * of SMSG_INSTANCE_DIFFICULTY, and the last byte of a group list with members; `WorldClient`'s
 * `instancePlayerDifficulty`), the seventh is Map.dbc Flags & 0x100 for the current map
 * (MAP_FLAG_DYNAMIC_DIFFICULTY, DBCEnums.h:346) as a boolean.
 *
 * The map catalog the client fetches (`/dbc/areas`) carries no Map flags, so the dynamic maps are kept
 * here as data, measured from this dataset's Map.dbc on 2026-10-04 (135 rows; Flags at field 3): 631
 * Icecrown Citadel and 724 the Ruby Sanctum, both Flags 0x11d. A TSWoW map given the flag is not seen
 * until the catalog carries the column.
 */

/** Map.dbc rows with MAP_FLAG_DYNAMIC_DIFFICULTY on this dataset. */
export const FRAMEXML_DYNAMIC_DIFFICULTY_MAPS: ReadonlySet<number> = new Set([631, 724]);

/** `GetInstanceInfo`'s seventh value for a map. */
export function frameXmlInstanceIsDynamic(mapId: number): boolean {
  return FRAMEXML_DYNAMIC_DIFFICULTY_MAPS.has(mapId);
}

/** `GetInstanceInfo`'s sixth value: the word as kept, 0 before any packet. */
export function frameXmlInstancePlayerDifficulty(world: { readonly instancePlayerDifficulty?: number } | undefined): number {
  const value = world?.instancePlayerDifficulty;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
