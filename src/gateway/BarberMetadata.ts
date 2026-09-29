import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BARBER_TYPE_FACIAL, BARBER_TYPE_HAIR, BARBER_TYPE_SKIN } from "../world/BarberRules.js";
import { DbcError } from "./Dbc.js";

const WDBC_HEADER_BYTES = 20;
// Established against TrinityCore's `BarberShopStyleEntry` (DBCStructure.h:286-298) and the
// dataset's own file: ID, Type, DisplayName[16], DisplayName_langmask, Description[16],
// Description_langmask, CostModifier, Race, Sex, Data — forty uint32-width columns.
const BARBER_FIELDS = 40;
const BARBER_RECORD_BYTES = BARBER_FIELDS * 4;
const MAX_STYLE_ROWS = 4096;
// Sixteen locales of DisplayName plus sixteen of Description per row; the table is small and
// the block is bounded so a malformed file cannot make the gateway retain an unbounded buffer.
const MAX_STRING_BLOCK_BYTES = 1024 * 1024;
const MAX_BARBER_FILE_BYTES =
  WDBC_HEADER_BYTES + MAX_STYLE_ROWS * BARBER_RECORD_BYTES + MAX_STRING_BLOCK_BYTES;

/** DBC locale slots, in file order. ruRU is 8; enUS is 0 and the fallback. */
const LOCALE_RURU = 8;
const LOCALE_ENUS = 0;

export interface BarberStyle {
  /** `BarberShopStyle.dbc` row id — what `CMSG_ALTER_APPEARANCE` carries, not the style value. */
  id: number;
  type: number;
  race: number;
  sex: number;
  /** The `Data` column: the hair/facial/skin value the row selects. */
  data: number;
  name: string;
}

export interface BarberStyleCatalog {
  styles: BarberStyle[];
}

function readCString(data: Buffer, stringsOffset: number, offset: number): string {
  if (offset < 0) return "";
  let end = offset;
  while (stringsOffset + end < data.byteLength && data[stringsOffset + end] !== 0) end++;
  return data.subarray(stringsOffset + offset, stringsOffset + end).toString("utf8");
}

/**
 * Reads the 3.3.5a BarberShopStyle table without inventing a persistent copy of client data.
 *
 * Only the columns `HandleAlterAppearance` reads are exposed — id, type, race, sex, data —
 * plus the display name for the steppers. CostModifier and Description travel nowhere: the
 * price is the server's (`GetBarberShopCost`) and is reported back in words, not numbers.
 */
function parseBarberStyles(data: Buffer): BarberStyleCatalog {
  if (data.byteLength < WDBC_HEADER_BYTES || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError("BarberShopStyle: not a WDBC file");
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  if (fields !== BARBER_FIELDS || recordSize !== BARBER_RECORD_BYTES) {
    throw new DbcError(
      `BarberShopStyle: the file has ${fields} fields of ${recordSize} bytes, but 3.3.5a requires ` +
      `${BARBER_FIELDS} fields of ${BARBER_RECORD_BYTES} bytes.`,
    );
  }
  if (records > MAX_STYLE_ROWS) {
    throw new DbcError(`BarberShopStyle: ${records} rows exceeds the ${MAX_STYLE_ROWS} row limit.`);
  }
  if (stringsSize > MAX_STRING_BLOCK_BYTES) {
    throw new DbcError(`BarberShopStyle: ${stringsSize} string bytes exceeds the ${MAX_STRING_BLOCK_BYTES} byte limit.`);
  }
  const stringsOffset = WDBC_HEADER_BYTES + records * recordSize;
  if (stringsOffset + stringsSize !== data.byteLength) {
    throw new DbcError("BarberShopStyle: truncated or trailing WDBC data.");
  }

  const styles: BarberStyle[] = [];
  const seen = new Set<number>();
  for (let row = 0; row < records; row++) {
    const offset = WDBC_HEADER_BYTES + row * recordSize;
    const word = (field: number): number => data.readUInt32LE(offset + field * 4);
    const id = word(0);
    if (id === 0 || seen.has(id)) {
      if (seen.has(id)) throw new DbcError(`BarberShopStyle: duplicate style id ${id}.`);
      continue;
    }
    seen.add(id);
    const type = word(1);
    if (type !== BARBER_TYPE_HAIR && type !== BARBER_TYPE_FACIAL && type !== BARBER_TYPE_SKIN) continue;
    // ruRU first, enUS fallback: the dataset fills every locale slot with the same offset, so
    // either answers, and a table that is genuinely multi-locale still reads Russian first.
    const name = readCString(data, stringsOffset, word(2 + LOCALE_RURU))
      || readCString(data, stringsOffset, word(2 + LOCALE_ENUS))
      || `Стиль ${id}`;
    styles.push({ id, type, race: word(37), sex: word(38), data: word(39), name });
  }
  styles.sort((left, right) => left.type - right.type || left.data - right.data || left.id - right.id);
  return { styles };
}

/** Loads every current BarberShopStyle row once; Gateway owns the resulting process cache. */
export async function loadBarberStyles(dbcDirectory: string): Promise<BarberStyleCatalog> {
  const path = join(dbcDirectory, "BarberShopStyle.dbc");
  let data: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_BARBER_FILE_BYTES) {
      throw new DbcError(
        `BarberShopStyle.dbc is ${info.size} bytes, above the ${MAX_BARBER_FILE_BYTES} byte limit.`,
      );
    }
    data = await readFile(path);
  } catch (error) {
    if (error instanceof DbcError) throw error;
    throw new DbcError(`BarberShopStyle.dbc could not be read from ${dbcDirectory}: ${(error as Error).message}`);
  }
  if (data.byteLength > MAX_BARBER_FILE_BYTES) {
    throw new DbcError(`BarberShopStyle.dbc changed beyond the ${MAX_BARBER_FILE_BYTES} byte limit while reading.`);
  }
  return parseBarberStyles(data);
}
