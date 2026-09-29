import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DbcError } from "./Dbc.js";

// Established against TrinityCore's `BankBagSlotPricesEntry`/`StableSlotPricesEntry`
// (DBCStores.cpp) and the dataset's own files: two uint32 columns, ID then Cost.
const PRICE_FIELDS = 2;
const PRICE_RECORD_BYTES = PRICE_FIELDS * 4;
const MAX_PRICE_ROWS = 64;
const MAX_PRICE_FILE_BYTES = 20 + MAX_PRICE_ROWS * PRICE_RECORD_BYTES;

export interface SlotPriceCatalog {
  /** Row id to copper. Bank rows run past the seven buyable slots; the browser reads `bought+1`. */
  bank: Record<string, number>;
  /** Row id to copper. Stable lookup is `MaxStabledPets + 1` (NPCHandler.cpp). */
  stable: Record<string, number>;
}

async function loadPriceTable(dbcDirectory: string, file: string): Promise<Record<string, number>> {
  const path = join(dbcDirectory, file);
  let data: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_PRICE_FILE_BYTES) {
      throw new DbcError(`${file} is ${info.size} bytes, above the ${MAX_PRICE_FILE_BYTES} byte limit.`);
    }
    data = await readFile(path);
  } catch (error) {
    if (error instanceof DbcError) throw error;
    throw new DbcError(`${file} could not be read from ${dbcDirectory}: ${(error as Error).message}`);
  }
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError(`${file}: not a WDBC file`);
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  if (fields !== PRICE_FIELDS || recordSize !== PRICE_RECORD_BYTES) {
    throw new DbcError(
      `${file}: the file has ${fields} fields of ${recordSize} bytes, but 3.3.5a requires ` +
      `${PRICE_FIELDS} fields of ${PRICE_RECORD_BYTES} bytes.`);
  }
  if (records > MAX_PRICE_ROWS) {
    throw new DbcError(`${file}: ${records} rows exceeds the ${MAX_PRICE_ROWS} row limit.`);
  }
  if (20 + records * recordSize > data.byteLength) {
    throw new DbcError(`${file}: truncated WDBC data.`);
  }
  const prices: Record<string, number> = {};
  for (let row = 0; row < records; row++) {
    const offset = 20 + row * recordSize;
    const id = data.readUInt32LE(offset);
    const cost = data.readUInt32LE(offset + 4);
    if (id === 0 || Object.hasOwn(prices, String(id))) {
      if (Object.hasOwn(prices, String(id))) throw new DbcError(`${file}: duplicate price id ${id}.`);
      continue;
    }
    prices[id] = cost;
  }
  return prices;
}

/** Loads both slot-price tables once; Gateway owns the resulting process cache. */
export async function loadSlotPrices(dbcDirectory: string): Promise<SlotPriceCatalog> {
  const [bank, stable] = await Promise.all([
    loadPriceTable(dbcDirectory, "BankBagSlotPrices.dbc"),
    loadPriceTable(dbcDirectory, "StableSlotPrices.dbc"),
  ]);
  return { bank, stable };
}
