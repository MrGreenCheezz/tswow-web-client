// Raw WDBC reader for A7a probes (no layouts): ints/floats/strings by column index.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DBC_DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";

export function openRaw(table, dir = DBC_DIR) {
  const data = readFileSync(join(dir, `${table}.dbc`));
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  const int = (row, col) => data.readInt32LE(20 + row * recordSize + col * 4);
  const uint = (row, col) => data.readUInt32LE(20 + row * recordSize + col * 4);
  const float = (row, col) => data.readFloatLE(20 + row * recordSize + col * 4);
  const str = (row, col) => {
    const off = data.readUInt32LE(20 + row * recordSize + col * 4);
    if (!off) return "";
    const start = stringsOffset + off;
    const end = data.indexOf(0, start);
    return data.subarray(start, end).toString("utf8");
  };
  return { table, records, fields, recordSize, stringsSize, int, uint, float, str };
}

export function head(t) {
  return `${t.table}: records=${t.records} fields=${t.fields} recordSize=${t.recordSize}`;
}

/** One row as `[col]=int/float` for a quick look at a shape. */
export function dump(t, row, cols = t.fields) {
  const out = [];
  for (let c = 0; c < cols; c++) {
    const i = t.int(row, c);
    const f = t.float(row, c);
    const s = i > 0 && i < t.stringsSize ? t.str(row, c) : "";
    const looksFloat = i !== 0 && Math.abs(f) > 1e-6 && Math.abs(f) < 1e6 && Math.abs(i) > 1_000_000;
    out.push(`${c}:${looksFloat ? f.toFixed(3) : i}${s && /^[\x20-\x7e]+$/.test(s) ? `"${s}"` : ""}`);
  }
  return out.join(" ");
}
