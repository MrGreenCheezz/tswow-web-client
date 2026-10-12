/**
 * 12.10 7.31: «зеленая скверна стала красной магмой» — which `LiquidType` row a terrain chunk's
 * liquid is, where the map file and Wow.exe disagree.
 *
 * Outland's ADTs carry no MH2O at all: every one of its 386 tiles with liquid holds the old MCLQ
 * chunks, whose only kind is the MCNK flag (0x04 river, 0x08 ocean, 0x10 magma, 0x20 slime), and all
 * 455 of its magma chunks lie in Shadowmoon Valley (`.runtime/re-2026-10-12/p731/liquids.mjs`,
 * `mclq.mjs`). TrinityCore's map extractor writes such a chunk's `liquid_entry` as 1–4 by that flag —
 * magma is 3, "Magma", `XTextures\lava`, red. Wow.exe builds the same chunk's liquid in
 * `CMapChunk` 0x007c5690: the flag bit i (0–3) gives type i + 1, except that while the current map
 * (0x00adfbc4) is 530 the magma bit gives 0xf — row 15, "Green Lava", `XTextures\LavaGreen` — and the
 * row's LiquidMaterial follows. An MH2O instance names its own row and is not touched (the second
 * loop of 0x007c5690); no Outland tile has one.
 */

/** Map.dbc 530, Outland — the map 0x007c5690 compares against (0x212). */
export const OUTLAND_MAP = 530;
/** LiquidType 3, "Magma": what the map extractor writes for an MCLQ magma chunk. */
export const LIQUID_TYPE_MAGMA = 3;
/** LiquidType 15, "Green Lava". */
export const LIQUID_TYPE_GREEN_LAVA = 15;

/** The `LiquidType` row Wow.exe draws a terrain chunk's liquid with, from the map file's `entry`. */
export function terrainLiquidEntry(map: number, entry: number): number {
  return map === OUTLAND_MAP && entry === LIQUID_TYPE_MAGMA ? LIQUID_TYPE_GREEN_LAVA : entry;
}
