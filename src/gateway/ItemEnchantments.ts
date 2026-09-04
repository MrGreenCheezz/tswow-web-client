import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbcFile } from "./Dbc.js";

export interface ItemEnchantmentInfo {
  id: number;
  name: string;
  gemItemId: number;
  conditionId: number;
}

export interface GemPropertyInfo {
  id: number;
  enchantmentId: number;
  color: number;
}

export interface ItemEnchantmentData {
  enchantments: ItemEnchantmentInfo[];
  gems: GemPropertyInfo[];
}

/** 3.3.5 DBCStructure.h: SpellItemEnchantment is 38 uint32 fields, Name[16] at 14,
 * SrcItemID at 33. Gameplay DBCs come from the active dataset, including TSWoW rows. */
export function readItemEnchantments(data: Buffer): ItemEnchantmentInfo[] {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "WDBC"
    || data.readUInt32LE(8) !== 38 || data.readUInt32LE(12) !== 152) {
    throw new Error("Invalid 3.3.5 SpellItemEnchantment.dbc layout");
  }
  const count = data.readUInt32LE(4);
  const strings = 20 + count * 152;
  if (strings + data.readUInt32LE(16) !== data.length) throw new Error("Invalid enchantment string block");
  const rows: ItemEnchantmentInfo[] = [];
  for (let row = 0; row < count; row++) {
    const at = 20 + row * 152;
    const field = (index: number): number => data.readUInt32LE(at + index * 4);
    let name = "";
    // Same locale policy as the other gameplay metadata: ruRU, enUS, then any populated locale.
    for (const locale of [8, 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
      const offset = field(14 + locale);
      if (offset === 0) continue;
      const end = data.indexOf(0, strings + offset);
      if (strings + offset >= data.length || end < 0) throw new Error("Invalid enchantment name offset");
      name = data.toString("utf8", strings + offset, end);
      if (name) break;
    }
    rows.push({ id: field(0), name, gemItemId: field(33), conditionId: field(34) });
  }
  return rows;
}

export async function loadItemEnchantments(directory: string): Promise<ItemEnchantmentData> {
  const [enchants, gems] = await Promise.all([
    readFile(join(directory, "SpellItemEnchantment.dbc")), openDbcFile(directory, "GemProperties"),
  ]);
  return {
    enchantments: readItemEnchantments(enchants),
    gems: Array.from({ length: gems.records }, (_, row) => ({
      id: gems.int(row, "ID"), enchantmentId: gems.int(row, "Enchant_ID"), color: gems.int(row, "Type"),
    })),
  };
}
