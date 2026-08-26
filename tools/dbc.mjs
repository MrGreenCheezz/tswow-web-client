// One WDBC reader, driven by the WoWDBDefs layouts.
//
// It replaces eleven hand-rolled parsers — three of them byte-identical, four of which never
// checked the field count at all — and the bare column literals that went with them. Fields are
// addressed by name, the header is checked against the definition, and a table whose shape does
// not match the build fails loudly instead of returning plausible garbage.

import "./env.mjs";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCALES, LOCSTRING_FIELDS, loadDbdLayout } from "./dbd.mjs";

export const WOTLK_BUILD = [3, 3, 5, 12340];

/** The locale the client is running, and what to fall back to. Both are 3.3.5 slots. */
export const DEFAULT_LOCALE = process.env.CLIENT_LOCALE ?? "ruRU";
const FALLBACK_LOCALE = "enUS";

export class DbcError extends Error {}

class Dbc {
  #data;
  #layout;
  #byName;
  #stringsOffset;
  #index;

  constructor(data, layout, table) {
    this.table = table;
    this.#data = data;
    this.#layout = layout;
    this.#byName = new Map(layout.fields.map((field) => [field.name, field]));

    if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
      throw new DbcError(`${table}: not a WDBC file`);
    }
    this.records = data.readUInt32LE(4);
    this.fields = data.readUInt32LE(8);
    this.recordSize = data.readUInt32LE(12);
    this.stringsSize = data.readUInt32LE(16);
    this.#stringsOffset = 20 + this.records * this.recordSize;

    if (this.fields !== layout.fieldCount || this.recordSize !== layout.recordSize) {
      throw new DbcError(
        `${table}: the file has ${this.fields} fields of ${this.recordSize} bytes, but the ` +
        `definition for this build describes ${layout.fieldCount} of ${layout.recordSize}. ` +
        `Either the dataset is from a different build or tools/dbd/${table}.dbd is out of date.`);
    }
    if (this.#stringsOffset + this.stringsSize !== data.byteLength) {
      throw new DbcError(`${table}: the string block does not reach the end of the file`);
    }
  }

  has(name) {
    return this.#byName.has(name);
  }

  #field(name, element) {
    const field = this.#byName.get(name);
    if (!field) throw new DbcError(`${this.table} has no field ${name}`);
    if (element < 0 || element >= field.arraySize) {
      throw new RangeError(`${this.table}.${name} has ${field.arraySize} element(s), asked for ${element}`);
    }
    return field;
  }

  #offset(row, field, element, slot = 0) {
    if (row < 0 || row >= this.records) throw new RangeError(`${this.table} has no row ${row}`);
    return 20 + row * this.recordSize
      + field.byteOffset
      + (element * field.stride + slot) * field.byteSize;
  }

  /** A signed or unsigned integer, honouring the width the definition declares. */
  int(row, name, element = 0) {
    const field = this.#field(name, element);
    const at = this.#offset(row, field, element);
    const unsigned = field.unsigned ?? false;
    switch (field.byteSize) {
      case 1: return unsigned ? this.#data.readUInt8(at) : this.#data.readInt8(at);
      case 2: return unsigned ? this.#data.readUInt16LE(at) : this.#data.readInt16LE(at);
      case 4: return unsigned ? this.#data.readUInt32LE(at) : this.#data.readInt32LE(at);
      case 8: return unsigned ? this.#data.readBigUInt64LE(at) : this.#data.readBigInt64LE(at);
      default: throw new DbcError(`${this.table}.${name} has an unusable width of ${field.byteSize} bytes`);
    }
  }

  float(row, name, element = 0) {
    return this.#data.readFloatLE(this.#offset(row, this.#field(name, element), element));
  }

  /** A plain string field, resolved through the string block. */
  string(row, name, element = 0) {
    const field = this.#field(name, element);
    return this.#stringAt(this.#data.readUInt32LE(this.#offset(row, field, element)));
  }

  /**
   * One locale of a localised string, falling back to enUS and then to any slot that is filled.
   * The last of the seventeen slots is a bitmask of which locales are present, not a string.
   */
  locstring(row, name, locale = DEFAULT_LOCALE) {
    const field = this.#field(name, 0);
    if (field.type !== "locstring") throw new DbcError(`${this.table}.${name} is not a localised string`);
    const read = (slot) => this.#stringAt(this.#data.readUInt32LE(this.#offset(row, field, 0, slot)));
    for (const candidate of [locale, FALLBACK_LOCALE]) {
      const slot = LOCALES.indexOf(candidate);
      if (slot < 0) continue;
      const value = read(slot);
      if (value) return value;
    }
    for (let slot = 0; slot < LOCSTRING_FIELDS - 1; slot++) {
      const value = read(slot);
      if (value) return value;
    }
    return "";
  }

  #stringAt(offset) {
    if (!offset) return "";
    const start = this.#stringsOffset + offset;
    if (start >= this.#data.byteLength) return "";
    const end = this.#data.indexOf(0, start);
    return end < start ? "" : this.#data.subarray(start, end).toString("utf8");
  }

  /** The value of the `$id$` field, which is row 0 of every table this project reads. */
  id(row) {
    const field = this.#layout.fields.find((candidate) => candidate.isId);
    if (!field) throw new DbcError(`${this.table} has no id field`);
    return this.int(row, field.name);
  }

  /** Row number for an id, or undefined. The index is built once, on first use. */
  rowOf(id) {
    if (!this.#index) {
      this.#index = new Map();
      for (let row = 0; row < this.records; row++) this.#index.set(this.id(row), row);
    }
    return this.#index.get(id);
  }

  *rows() {
    for (let row = 0; row < this.records; row++) yield row;
  }

  /** Field names, in record order. Handy when exploring a table. */
  get fieldNames() {
    return this.#layout.fields.map((field) => field.name);
  }
}

/** Opens a DBC that is already in memory. */
export async function openDbc(data, table, build = WOTLK_BUILD) {
  return new Dbc(data, await loadDbdLayout(table, build), table);
}

/** Opens `<directory>/<table>.dbc`. */
export async function openDbcFile(directory, table, build = WOTLK_BUILD) {
  let data;
  try {
    data = await readFile(join(directory, `${table}.dbc`));
  } catch (error) {
    throw new DbcError(`${table}.dbc could not be read from ${directory}: ${error.message}`);
  }
  return openDbc(data, table, build);
}
