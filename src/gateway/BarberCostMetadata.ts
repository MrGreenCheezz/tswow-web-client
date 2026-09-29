import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DbcError } from "./Dbc.js";

const WDBC_HEADER_BYTES = 20;
/**
 * `gtBarberShopCostBase.dbc`: one float per row, the base price of a haircut at level `row + 1`
 * (TrinityCore's `GtBarberShopCostBaseEntry { float Data; }`, DBCStructure.h, and its `"f"` format).
 * Measured on this dataset: 100 rows of one 4-byte field and a one-byte string block, 421 bytes.
 */
const COST_FIELDS = 1;
const COST_RECORD_BYTES = 4;
/** `GT_MAX_LEVEL` is 100; the bound keeps a malformed file from growing the served array. */
const MAX_COST_ROWS = 1024;

export interface BarberCostCatalog {
  /** The base price in copper by `level - 1`, exactly the float the core reads (`bsc->Data`). */
  costs: number[];
}

/**
 * Reads the table `Player::GetBarberShopCost` prices a haircut from. The browser applies the core's
 * own formula to it (a new style costs the base, a colour alone half of it, facial hair and skin
 * three quarters each), so the stock BarberShopFrame can show the price before the realm charges it.
 */
export function parseBarberCosts(data: Buffer): BarberCostCatalog {
  if (data.byteLength < WDBC_HEADER_BYTES || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError("gtBarberShopCostBase: not a WDBC file");
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  if (fields !== COST_FIELDS || recordSize !== COST_RECORD_BYTES) {
    throw new DbcError(
      `gtBarberShopCostBase: the file has ${fields} fields of ${recordSize} bytes, but 3.3.5a requires ` +
      `${COST_FIELDS} field of ${COST_RECORD_BYTES} bytes.`,
    );
  }
  if (records > MAX_COST_ROWS) throw new DbcError(`gtBarberShopCostBase: ${records} rows exceeds the ${MAX_COST_ROWS} row limit.`);
  if (WDBC_HEADER_BYTES + records * recordSize + stringsSize !== data.byteLength) {
    throw new DbcError("gtBarberShopCostBase: truncated or trailing WDBC data.");
  }
  const costs: number[] = [];
  for (let row = 0; row < records; row++) {
    const value = data.readFloatLE(WDBC_HEADER_BYTES + row * recordSize);
    costs.push(Number.isFinite(value) && value >= 0 ? value : 0);
  }
  return { costs };
}

export async function loadBarberCosts(dbcDirectory: string): Promise<BarberCostCatalog> {
  return parseBarberCosts(await readFile(join(dbcDirectory, "gtBarberShopCostBase.dbc")));
}
