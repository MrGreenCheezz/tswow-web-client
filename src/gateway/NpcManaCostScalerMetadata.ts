// 3.43 (15.11): gtNPCManaCostScaler, the game table Wow.exe's cost function scales a unit's cost by when the unit is
// not a player (0x008012f0 → 0x007f6990 with table 6; Ghidra 2026-11-15, .runtime/re-2026-11-15/spelltext5/r1.c):
// served once per page as `/dbc/npc-mana-cost-scaler?v=1` (CatalogRoutes.ts). The table is DBCfmt.h's "f" — one float a
// row, row = level − 1 (GT_MAX_LEVEL rows); the browser half is src/browser/NpcManaCostScalerClient.ts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharacterStatTable } from "../world/CharacterStatData.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const NPC_MANA_COST_SCALER_VERSION = 1;

export interface NpcManaCostScalerCatalog {
  version: number;
  /** gtNPCManaCostScaler: the scaler of level `row + 1`. */
  scaler: number[];
}

export async function loadNpcManaCostScaler(directory: string): Promise<NpcManaCostScalerCatalog> {
  const bytes = await readFile(join(directory, "gtNPCManaCostScaler.dbc"));
  return { version: NPC_MANA_COST_SCALER_VERSION, scaler: [...parseCharacterStatTable(bytes)] };
}
