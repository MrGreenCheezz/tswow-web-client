// The two tables behind a repair price (plan item 2.02): DurabilityCosts.dbc and
// DurabilityQuality.dbc, served once per page as `/dbc/durability?v=1` (CatalogRoutes.ts).
//
// The price the stock MerchantFrame and the paper doll show is the client's own sum: nothing on the
// wire carries it. The original client works it out of these two tables and the item's fields
// (Wow.exe 0x00708540, called per item by 0x00584b20 for GetRepairAllCost, RepairAllItems and the
// repair cursor's click); the charge itself is the server's (`Item::CalculateDurabilityRepairCost`,
// Item.cpp:753), which reads the same two tables.
//
// Not in the generated DBC_LAYOUTS; read with TrinityCore's formats for build 12340
// (DBCfmt.h:52-53): `DurabilityCostsfmt = "niiiiiiiiiiiiiiiiiiiiiiiiiiiii"` — {ID = item level,
// WeaponSubClassCost[21], ArmorSubClassCost[8]} (DBCStructure.h:622), thirty fields, 120 bytes — and
// `DurabilityQualityfmt = "nf"` — {ID, Data} — two fields, eight bytes. Measured on this dataset:
// 300 cost rows (ids 1..300) and 16 quality rows (ids 1..16).

import { readFixed, type FixedRows } from "./DbcFixed.js";
import { shortestFloat } from "./AreaTriggerMetadata.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const DURABILITY_VERSION = 1;

export const DURABILITY_COSTS_LAYOUT = Object.freeze({ fieldCount: 30, recordSize: 120 });
export const DURABILITY_QUALITY_LAYOUT = Object.freeze({ fieldCount: 2, recordSize: 8 });

export interface DurabilityCatalog {
  version: number;
  /**
   * Every DurabilityCosts row in file order, each the file's thirty integers: `[id, weapon 0..20,
   * armor 0..7]`. File order and the whole row are kept because the client reads one column past a
   * row's end for an armour subclass of 8 (0x00708540 bounds it by `<= 8`), which lands on the next
   * row's id.
   */
  costs: number[][];
  /** Every DurabilityQuality row in file order, `[id, data]`; the client indexes it by row, not id. */
  quality: Array<[id: number, data: number]>;
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function durabilityCatalog(costs: FixedRows, quality: FixedRows): DurabilityCatalog {
  const costRows: number[][] = [];
  for (let row = 0; row < costs.records; row++) {
    const values: number[] = [];
    for (let field = 0; field < DURABILITY_COSTS_LAYOUT.fieldCount; field++) values.push(costs.int(row, field));
    costRows.push(values);
  }
  const qualityRows: Array<[number, number]> = [];
  for (let row = 0; row < quality.records; row++) {
    const data = quality.float(row, 1);
    // A float JSON cannot carry is kept as 0: the row stays in place, because its index is its key.
    qualityRows.push([quality.int(row, 0), Number.isFinite(data) ? shortestFloat(data) : 0]);
  }
  return { version: DURABILITY_VERSION, costs: costRows, quality: qualityRows };
}

export async function loadDurability(dbcDirectory: string): Promise<DurabilityCatalog> {
  const [costs, quality] = await Promise.all([
    readFixed(dbcDirectory, "DurabilityCosts", DURABILITY_COSTS_LAYOUT),
    readFixed(dbcDirectory, "DurabilityQuality", DURABILITY_QUALITY_LAYOUT),
  ]);
  return durabilityCatalog(costs, quality);
}
