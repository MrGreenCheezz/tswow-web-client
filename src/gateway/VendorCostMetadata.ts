import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DbcError } from "./Dbc.js";

const WDBC_HEADER_BYTES = 20;
// DBCfmt.h declares `niiiiiiiiiiiiiix`: the final uint32 is ItemPurchaseGroup.
// Trinity's loader skips that legacy field, but it remains present in every raw WDBC row.
const ITEM_EXTENDED_COST_FIELDS = 16;
const ITEM_EXTENDED_COST_RECORD_BYTES = ITEM_EXTENDED_COST_FIELDS * 4;
const MAX_COST_ROWS = 65_536;
const MAX_TURN_INS = 5;
// The table has no string columns. Permit a bounded string block for compatible datasets while
// refusing a malformed file before it can make the gateway retain an unbounded buffer.
const MAX_STRING_BLOCK_BYTES = 1024 * 1024;
const MAX_ITEM_EXTENDED_COST_FILE_BYTES =
  WDBC_HEADER_BYTES + MAX_COST_ROWS * ITEM_EXTENDED_COST_RECORD_BYTES + MAX_STRING_BLOCK_BYTES;

export interface VendorCostItem {
  entry: number;
  count: number;
}

export interface VendorCost {
  honor: number;
  arena: number;
  arenaBracket: number;
  rating: number;
  items: VendorCostItem[];
}

export interface VendorCostCatalog {
  costs: Record<string, VendorCost>;
}

/**
 * Reads the 3.3.5a ItemExtendedCost table without inventing a persistent copy of client data.
 *
 * This table has no generated layout in the current gateway assets. Its raw 16 uint32 columns
 * are checked before use against the WDBC header. Fields 0..14 are ID; HonorPoints;
 * ArenaPoints; ArenaBracket; ItemID[5]; ItemCount[5]; RequiredArenaRating. Field 15 is the
 * legacy ItemPurchaseGroup, skipped by TrinityCore and deliberately not exposed here.
 */
function parseVendorCosts(data: Buffer): VendorCostCatalog {
  if (data.byteLength < WDBC_HEADER_BYTES || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError("ItemExtendedCost: not a WDBC file");
  }

  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  if (fields !== ITEM_EXTENDED_COST_FIELDS || recordSize !== ITEM_EXTENDED_COST_RECORD_BYTES) {
    throw new DbcError(
      `ItemExtendedCost: the file has ${fields} fields of ${recordSize} bytes, but 3.3.5a requires `
      + `${ITEM_EXTENDED_COST_FIELDS} fields of ${ITEM_EXTENDED_COST_RECORD_BYTES} bytes.`,
    );
  }
  if (records > MAX_COST_ROWS) {
    throw new DbcError(`ItemExtendedCost: ${records} rows exceeds the ${MAX_COST_ROWS} row limit.`);
  }
  if (stringsSize > MAX_STRING_BLOCK_BYTES) {
    throw new DbcError(`ItemExtendedCost: ${stringsSize} string bytes exceeds the ${MAX_STRING_BLOCK_BYTES} byte limit.`);
  }

  const recordBytes = records * recordSize;
  const expectedLength = WDBC_HEADER_BYTES + recordBytes + stringsSize;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== data.byteLength) {
    throw new DbcError("ItemExtendedCost: truncated or trailing WDBC data.");
  }

  const costs: Record<string, VendorCost> = {};
  for (let row = 0; row < records; row++) {
    const offset = WDBC_HEADER_BYTES + row * recordSize;
    const word = (field: number): number => data.readUInt32LE(offset + field * 4);
    const id = word(0);
    // ExtendedCost=0 means no DBC cost, so an ID-zero sentinel cannot be referenced by a vendor.
    if (id === 0) continue;
    if (Object.hasOwn(costs, String(id))) {
      throw new DbcError(`ItemExtendedCost: duplicate cost id ${id}.`);
    }

    const items: VendorCostItem[] = [];
    for (let slot = 0; slot < MAX_TURN_INS; slot++) {
      const entry = word(4 + slot);
      const count = word(9 + slot);
      // Trinity ignores either half of an empty pair. Do not make a zero-count pseudo-cost visible.
      if (entry !== 0 && count !== 0) items.push({ entry, count });
    }

    costs[id] = {
      honor: word(1),
      arena: word(2),
      arenaBracket: word(3),
      rating: word(14),
      items,
    };
  }
  return { costs };
}

/** Loads every current ItemExtendedCost row once; Gateway owns the resulting process cache. */
export async function loadVendorCostMetadata(dbcDirectory: string): Promise<VendorCostCatalog> {
  const path = join(dbcDirectory, "ItemExtendedCost.dbc");
  let data: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_ITEM_EXTENDED_COST_FILE_BYTES) {
      throw new DbcError(
        `ItemExtendedCost.dbc is ${info.size} bytes, above the ${MAX_ITEM_EXTENDED_COST_FILE_BYTES} byte limit.`,
      );
    }
    data = await readFile(path);
  } catch (error) {
    if (error instanceof DbcError) throw error;
    throw new DbcError(`ItemExtendedCost.dbc could not be read from ${dbcDirectory}: ${(error as Error).message}`);
  }
  if (data.byteLength > MAX_ITEM_EXTENDED_COST_FILE_BYTES) {
    throw new DbcError(`ItemExtendedCost.dbc changed beyond the ${MAX_ITEM_EXTENDED_COST_FILE_BYTES} byte limit while reading.`);
  }
  return parseVendorCosts(data);
}
