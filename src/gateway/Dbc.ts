// Reading a client database table by field name.
//
// This replaces the parsers that used to sit in SpellMetadata, CreatureModelMetadata,
// CharacterTexture and GameObjectMetadata — four near-copies of the same twenty lines, with
// column numbers written as bare integers. The layouts now come from
// src/generated/dbcLayouts.ts, which is generated from the WoWDBDefs definitions vendored under
// tools/dbd and verified against the real files by tests/dbc.test.mjs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DBC_LAYOUTS, DBC_LOCALES, DBC_LOCSTRING_FIELDS,
  type DbcLayout, type DbcLocale, type DbcTable,
} from "../generated/dbcLayouts.js";

/**
 * Measured on the tswow dataset: it writes one string offset into all sixteen locale slots, so
 * asking for a specific locale returns the same text whichever is chosen. Kept because a table
 * that is genuinely multi-locale would need it, and because falling back is the safe default.
 */
const FALLBACK_LOCALE: DbcLocale = "enUS";
export const DEFAULT_LOCALE: DbcLocale =
  (DBC_LOCALES as readonly string[]).includes(process.env["CLIENT_LOCALE"] ?? "")
    ? (process.env["CLIENT_LOCALE"] as DbcLocale)
    : "ruRU";

export class DbcError extends Error {}

export class Dbc<Table extends DbcTable> {
  readonly table: Table;
  readonly records: number;
  readonly fields: number;
  readonly recordSize: number;

  readonly #data: Buffer;
  readonly #layout: DbcLayout;
  readonly #stringsOffset: number;
  #index: Map<number, number> | undefined;

  constructor(data: Buffer, table: Table) {
    this.table = table;
    this.#data = data;
    this.#layout = DBC_LAYOUTS[table];

    if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
      throw new DbcError(`${table}: not a WDBC file`);
    }
    this.records = data.readUInt32LE(4);
    this.fields = data.readUInt32LE(8);
    this.recordSize = data.readUInt32LE(12);
    const stringsSize = data.readUInt32LE(16);
    this.#stringsOffset = 20 + this.records * this.recordSize;

    if (this.fields !== this.#layout.fieldCount || this.recordSize !== this.#layout.recordSize) {
      throw new DbcError(
        `${table}: the file has ${this.fields} fields of ${this.recordSize} bytes, but this build's ` +
        `definition describes ${this.#layout.fieldCount} of ${this.#layout.recordSize}. Either the ` +
        `dataset is from another build or tools/dbd/${table}.dbd is out of date.`);
    }
    if (this.#stringsOffset + stringsSize !== data.byteLength) {
      throw new DbcError(`${table}: the string block does not reach the end of the file`);
    }
  }

  #field(name: string, element: number) {
    const field = this.#layout.fields[name];
    if (!field) throw new DbcError(`${this.table} has no field ${name}`);
    if (element < 0 || element >= field.arraySize) {
      throw new RangeError(`${this.table}.${name} has ${field.arraySize} element(s), asked for ${element}`);
    }
    return field;
  }

  #offset(row: number, field: { byteOffset: number; byteSize: number; stride: number },
    element: number, slot = 0): number {
    if (row < 0 || row >= this.records) throw new RangeError(`${this.table} has no row ${row}`);
    return 20 + row * this.recordSize + field.byteOffset + (element * field.stride + slot) * field.byteSize;
  }

  /** A signed or unsigned integer, at the width the definition declares. */
  int(row: number, name: keyof (typeof DBC_LAYOUTS)[Table]["fields"] & string, element = 0): number {
    const field = this.#field(name, element);
    const at = this.#offset(row, field, element);
    switch (field.byteSize) {
      case 1: return field.unsigned ? this.#data.readUInt8(at) : this.#data.readInt8(at);
      case 2: return field.unsigned ? this.#data.readUInt16LE(at) : this.#data.readInt16LE(at);
      case 4: return field.unsigned ? this.#data.readUInt32LE(at) : this.#data.readInt32LE(at);
      default: throw new DbcError(`${this.table}.${name} has an unusable width of ${field.byteSize} bytes`);
    }
  }

  float(row: number, name: keyof (typeof DBC_LAYOUTS)[Table]["fields"] & string, element = 0): number {
    return this.#data.readFloatLE(this.#offset(row, this.#field(name, element), element));
  }

  string(row: number, name: keyof (typeof DBC_LAYOUTS)[Table]["fields"] & string, element = 0): string {
    const field = this.#field(name, element);
    return this.#stringAt(this.#data.readUInt32LE(this.#offset(row, field, element)));
  }

  /** One locale of a localised string, falling back to enUS and then to any filled slot. */
  locstring(row: number, name: keyof (typeof DBC_LAYOUTS)[Table]["fields"] & string,
    locale: DbcLocale = DEFAULT_LOCALE): string {
    const field = this.#field(name, 0);
    if (field.type !== "locstring") throw new DbcError(`${this.table}.${name} is not a localised string`);
    const read = (slot: number) => this.#stringAt(this.#data.readUInt32LE(this.#offset(row, field, 0, slot)));
    for (const candidate of [locale, FALLBACK_LOCALE]) {
      const slot = (DBC_LOCALES as readonly string[]).indexOf(candidate);
      if (slot < 0) continue;
      const value = read(slot);
      if (value) return value;
    }
    for (let slot = 0; slot < DBC_LOCSTRING_FIELDS - 1; slot++) {
      const value = read(slot);
      if (value) return value;
    }
    return "";
  }

  #stringAt(offset: number): string {
    if (!offset) return "";
    const start = this.#stringsOffset + offset;
    if (start >= this.#data.byteLength) return "";
    const end = this.#data.indexOf(0, start);
    return end < start ? "" : this.#data.subarray(start, end).toString("utf8");
  }

  id(row: number): number {
    return this.int(row, this.#layout.idField as never);
  }

  /** Row number for an id, or undefined. The index is built once, on first use. */
  rowOf(id: number): number | undefined {
    if (!this.#index) {
      this.#index = new Map();
      for (let row = 0; row < this.records; row++) this.#index.set(this.id(row), row);
    }
    return this.#index.get(id);
  }

  *rows(): Generator<number> {
    for (let row = 0; row < this.records; row++) yield row;
  }
}

export function openDbc<Table extends DbcTable>(data: Buffer, table: Table): Dbc<Table> {
  return new Dbc(data, table);
}

export async function openDbcFile<Table extends DbcTable>(directory: string, table: Table): Promise<Dbc<Table>> {
  let data: Buffer;
  try {
    data = await readFile(join(directory, `${table}.dbc`));
  } catch (error) {
    throw new DbcError(`${table}.dbc could not be read from ${directory}: ${(error as Error).message}`);
  }
  return new Dbc(data, table);
}
