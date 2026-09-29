// A DBC read with the layout TrinityCore declares for build 12340, for the small tables that are
// not in the generated DBC_LAYOUTS (line A3, М2 «Новый DBC-маршрут»).
//
// The generated layouts come from `tools/dbd/*.dbd`, and adding a table there means a regenerated
// file and a licence record. A table this route family needs is usually a handful of numbers per
// row, so it is read with the format string from `shared/DataStores/DBCfmt.h` instead — and the
// header is checked against it, so a dataset built for another client fails loudly with a
// `DbcError` rather than being read at the wrong offsets. Moved here out of CharTitleMetadata.ts,
// where it was private, when the second table (AreaTrigger) needed it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DbcError } from "./Dbc.js";

/** What DBCfmt.h declares: one 4-byte field per format character, so `recordSize = 4 × fieldCount`. */
export interface FixedLayout {
  readonly fieldCount: number;
  readonly recordSize: number;
}

export interface FixedRows {
  readonly records: number;
  int(row: number, field: number): number;
  /** An `f` field: IEEE single precision, never read through `readInt32LE`. */
  float(row: number, field: number): number;
  /** The string a field's offset names; empty for a zero offset or one outside the block. */
  string(row: number, field: number): string;
}

/** Checks a WDBC image against the declared layout; throws `DbcError` on any disagreement. */
export function parseFixed(table: string, data: Buffer, layout: FixedLayout): FixedRows {
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError(`${table}: not a WDBC file`);
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== layout.fieldCount || recordSize !== layout.recordSize) {
    throw new DbcError(`${table}: the file has ${fields} fields of ${recordSize} bytes, but DBCfmt.h `
      + `declares ${layout.fieldCount} of ${layout.recordSize} for build 12340`);
  }
  if (stringsOffset + stringsSize !== data.byteLength) {
    throw new DbcError(`${table}: the string block does not reach the end of the file`);
  }
  return {
    records,
    int: (row, field) => data.readInt32LE(20 + row * recordSize + field * 4),
    float: (row, field) => data.readFloatLE(20 + row * recordSize + field * 4),
    string: (row, field) => {
      const offset = data.readUInt32LE(20 + row * recordSize + field * 4);
      if (offset === 0 || offset >= stringsSize) return "";
      const start = stringsOffset + offset;
      const end = data.indexOf(0, start);
      return end < start ? "" : data.subarray(start, end).toString("utf8");
    },
  };
}

export async function readFixed(dbcDirectory: string, table: string, layout: FixedLayout): Promise<FixedRows> {
  const data = await readFile(join(dbcDirectory, `${table}.dbc`)).catch((error: Error) => {
    throw new DbcError(`${table}.dbc could not be read from ${dbcDirectory}: ${error.message}`);
  });
  return parseFixed(table, data, layout);
}
