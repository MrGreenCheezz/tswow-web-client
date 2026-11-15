import type { SpellMetadata } from "../gateway/SpellMetadata.js";

/**
 * 3.43 (15.11, names10): every spell of the dataset in one compact table — the columns the by-id spell globals answer
 * from, so that `GetSpellInfo(id)`, `GetSpellLink(id)`, `GetSpellCooldown(id)` and a `spell:<id>` link's title answer for
 * any spell from the interface's first Lua line, as Wow.exe does with Spell.dbc in memory (Script_GetSpellInfo
 * 0x00540a30 reads the record by id; there is no "not loaded yet" in the original). The long `/dbc/spells` rows
 * (descriptions, effect values, aura texts) stay on demand; this table carries no text but the name, the rank and the
 * icon path.
 *
 * Served as `/dbc/spell-info?v=<SPELL_INFO_TABLE_VERSION>` (gateway/SpellInfoTableRoute.ts), built from the same parse as
 * `/dbc/spells` (gateway/SpellMetadata.ts `loadSpellMetadata`), so the two agree field by field
 * (tests/spell-info-table.test.mjs compares them on the dataset's rows). Both halves share this module.
 *
 * Layout (little-endian): a u32 header length, the header as UTF-8 JSON, padding to 8, then the body. The header names
 * every column — `{ name, type, offset }`, `type` one of the typed-array kinds below, `offset` into the body, `rows`
 * entries long — so a reader takes each column as a typed-array view of the one buffer: nothing is copied and no
 * object is made per spell until a spell is asked for. Every integer column is stored in the narrowest kind that holds
 * its values; the id column holds each id's step from the one before (ids ascending, the reader sums them once). Strings
 * (names, ranks, icon paths) are interned once into a UTF-8 blob with a column of their byte lengths; the string
 * columns are indexes into it. The range and the cast time are indexes into small tables of the distinct
 * `[min, max, minFriendly, maxFriendly, flags]` and `[base, perLevel, minimum]` tuples in the header (SpellRange.dbc and
 * SpellCastTimes.dbc have 65 and 71 rows).
 *
 * Measured on this dataset (49,840 rows; node 22 on this machine, tests/spell-info-table.test.mjs prints it): see
 * names10's report — about 7.3 MB raw, 0.95 MB gzip, a 3 ms decode holding the one buffer.
 */

/** The route's shape; the browser asks `?v=` this. Both halves read it from here. */
export const SPELL_INFO_TABLE_VERSION = 1;
export const SPELL_INFO_TABLE_PATH = "/dbc/spell-info";
const FORMAT = 1;

/** The fields a compact row carries, all with the `/dbc/spells` row's own meaning and value. */
export const SPELL_INFO_ROW_KEYS = [
  "id", "name", "rank", "iconPath", "passive",
  "powerType", "powerCost", "powerCostPercent", "manaCostPerLevel", "manaPerSecond", "manaPerSecondPerLevel",
  "schoolMask", "spellLevel", "baseLevel", "maxLevel", "spellClassSet", "spellClassMask",
  "castTime", "castTimePerLevel", "castTimeMinimum",
  "rangeMin", "rangeMax", "rangeMinFriendly", "rangeMaxFriendly", "rangeFlags",
  "targets", "implicitTargetA", "implicitTargetB", "attributes",
  "effects", "effectAura", "effectMiscValue", "effectMiscValueB",
  "equippedItemClass", "equippedItemSubclass", "weaponSkillSpells", "shapeshiftCombatRoundTime",
  "startRecoveryTime", "startRecoveryCategory", "dmgClass",
] as const satisfies readonly (keyof SpellMetadata)[];

export type SpellInfoRowKey = typeof SPELL_INFO_ROW_KEYS[number];
/** A compact row: the `/dbc/spells` row's fields above, nothing else. A full row is one too. */
export type SpellInfoRow = Readonly<Pick<SpellMetadata, SpellInfoRowKey>>;

/** Scalar integer columns, by the row field they fill. */
const SCALARS = [
  "powerType", "powerCost", "powerCostPercent", "manaCostPerLevel", "manaPerSecond", "manaPerSecondPerLevel",
  "schoolMask", "spellLevel", "baseLevel", "maxLevel", "spellClassSet",
  "targets", "equippedItemClass", "equippedItemSubclass", "startRecoveryTime", "startRecoveryCategory", "dmgClass",
] as const;
/** Array columns, by field and width: stored as `<field>.<index>`. */
const ARRAYS = [
  ["attributes", 8], ["spellClassMask", 3], ["implicitTargetA", 3], ["implicitTargetB", 3], ["effects", 3],
  ["effectAura", 3], ["effectMiscValue", 3], ["effectMiscValueB", 3],
] as const;
/** `SPELL_ATTR0_PASSIVE`: the full row's `passive` is this bit (gateway SpellMetadata.ts). */
const ATTR0_PASSIVE = 0x40;

type ColumnType = "i8" | "u8" | "i16" | "u16" | "i32" | "u32";
type IntArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

interface ColumnHeader {
  readonly name: string;
  readonly type: ColumnType;
  readonly offset: number;
}

interface TableHeader {
  readonly format: number;
  readonly version: number;
  readonly rows: number;
  /** The first id; the `id` column holds each id's step from the one before (ids ascending). */
  readonly firstId: number;
  readonly columns: readonly ColumnHeader[];
  /** `count` strings: their UTF-8 byte lengths (a column of `count` entries) and the blob of their bytes, in order. */
  readonly strings: { readonly count: number; readonly lengths: ColumnHeader; readonly bytes: number; readonly length: number };
  /** Distinct `[rangeMin, rangeMax, rangeMinFriendly, rangeMaxFriendly, rangeFlags]`. */
  readonly ranges: readonly (readonly number[])[];
  /** Distinct `[castTime, castTimePerLevel, castTimeMinimum]` (SpellCastTimes.dbc's Base, PerLevel, Minimum). */
  readonly castTimes: readonly (readonly number[])[];
  /** DAT_00c9eb50 as the flagged rows' `weaponSkillSpells` spell it out, by weapon subclass; its length is theirs. */
  readonly weaponSkills: readonly number[];
}

const BYTES: Record<ColumnType, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4 };

function narrowest(values: readonly number[]): ColumnType {
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min >= 0) return max <= 0xff ? "u8" : max <= 0xffff ? "u16" : max <= 0xffffffff ? "u32" : fail(max);
  if (min >= -0x80 && max <= 0x7f) return "i8";
  if (min >= -0x8000 && max <= 0x7fff) return "i16";
  return min >= -0x80000000 && max <= 0x7fffffff ? "i32" : fail(min);
}

function fail(value: number): never {
  throw new Error(`Spell info table: ${value} fits no column`);
}

function view(type: ColumnType, buffer: ArrayBuffer, offset: number, length: number): IntArray {
  switch (type) {
    case "i8": return new Int8Array(buffer, offset, length);
    case "u8": return new Uint8Array(buffer, offset, length);
    case "i16": return new Int16Array(buffer, offset, length);
    case "u16": return new Uint16Array(buffer, offset, length);
    case "i32": return new Int32Array(buffer, offset, length);
    case "u32": return new Uint32Array(buffer, offset, length);
  }
}

const align = (value: number, to: number): number => Math.ceil(value / to) * to;

/** Builds the table from `/dbc/spells`' rows (gateway SpellMetadata.ts `loadSpellMetadata`), ids ascending. */
export function encodeSpellInfoTable(rows: Iterable<SpellMetadata>): Uint8Array {
  const spells = [...rows].filter((row) => Number.isSafeInteger(row.id) && row.id > 0).sort((a, b) => a.id - b.id);
  const strings = new Map<string, number>();
  const intern = (text: string): number => {
    let index = strings.get(text);
    if (index === undefined) strings.set(text, index = strings.size);
    return index;
  };
  const tuples = (): { index: (tuple: number[]) => number; rows: number[][] } => {
    const seen = new Map<string, number>();
    const rows: number[][] = [];
    return {
      rows,
      index: (tuple) => {
        const key = tuple.join(",");
        let index = seen.get(key);
        if (index === undefined) {
          seen.set(key, index = rows.length);
          rows.push(tuple);
        }
        return index;
      },
    };
  };
  const ranges = tuples();
  const castTimes = tuples();
  const weaponSkills: number[] = [];
  const columns = new Map<string, number[]>();
  const put = (name: string, value: number): void => {
    let column = columns.get(name);
    if (!column) columns.set(name, column = []);
    column.push(value);
  };
  let previousId = spells[0]?.id ?? 0;
  for (const spell of spells) {
    put("id", spell.id - previousId);
    previousId = spell.id;
    put("name", intern(spell.name));
    put("rank", intern(spell.rank));
    put("iconPath", intern(spell.iconPath));
    for (const key of SCALARS) put(key, spell[key] ?? 0);
    for (const [key, width] of ARRAYS) {
      for (let index = 0; index < width; index++) put(`${key}.${index}`, spell[key]?.[index] ?? 0);
    }
    put("range", ranges.index([spell.rangeMin, spell.rangeMax, spell.rangeMinFriendly ?? 0, spell.rangeMaxFriendly ?? 0,
      spell.rangeFlags]));
    put("castTime", castTimes.index([spell.castTime, spell.castTimePerLevel ?? 0, spell.castTimeMinimum ?? 0]));
    // Absent on most rows (a form spell's only, with the table): -1 keeps «absent» apart from 0.
    put("shapeshiftCombatRoundTime", spell.shapeshiftCombatRoundTime ?? -1);
    const skills = spell.weaponSkillSpells;
    put("weaponSkill", skills ? 1 : 0);
    if (skills) {
      // The gateway's table, recovered from the rows that spell it out (0 where a row's mask has no such spell).
      for (let subClass = 0; subClass < skills.length; subClass++) {
        const id = skills[subClass] ?? 0;
        if (weaponSkills.length < skills.length) weaponSkills.length = skills.length;
        if (id !== 0) weaponSkills[subClass] = id;
      }
    }
  }
  const encoder = new TextEncoder();
  const encoded = [...strings.keys()].map((text) => encoder.encode(text));
  const lengths = encoded.map((bytes) => bytes.byteLength);
  const stringBytes = lengths.reduce((sum, length) => sum + length, 0);

  const headers: ColumnHeader[] = [];
  let offset = 0;
  const place = (name: string, values: readonly number[]): ColumnHeader => {
    const type = narrowest(values);
    offset = align(offset, 4);
    const column = { name, type, offset };
    offset += values.length * BYTES[type];
    return column;
  };
  for (const [name, values] of columns) headers.push(place(name, values));
  const lengthColumn = place("stringLengths", lengths);
  const bytesAt = offset;
  offset += stringBytes;
  const header: TableHeader = {
    format: FORMAT, version: SPELL_INFO_TABLE_VERSION, rows: spells.length, firstId: spells[0]?.id ?? 0, columns: headers,
    strings: { count: encoded.length, lengths: lengthColumn, bytes: bytesAt, length: stringBytes },
    ranges: ranges.rows, castTimes: castTimes.rows,
    weaponSkills: Array.from({ length: weaponSkills.length }, (_, index) => weaponSkills[index] ?? 0),
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const bodyAt = align(4 + headerBytes.byteLength, 8);
  const out = new Uint8Array(bodyAt + offset);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);
  const body = out.buffer;
  for (const column of headers) {
    const values = columns.get(column.name)!;
    view(column.type, body, bodyAt + column.offset, values.length).set(values);
  }
  view(lengthColumn.type, body, bodyAt + lengthColumn.offset, lengths.length).set(lengths);
  let at = bodyAt + bytesAt;
  for (const bytes of encoded) {
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
}

/** The decoded table: typed-array views over the one buffer; a row object only for an id asked for. */
export class SpellInfoTable {
  readonly rows: number;
  /** The buffer's size: what the table holds in memory beside the rows asked for. */
  readonly byteLength: number;
  readonly #ids: Int32Array;
  readonly #columns: ReadonlyMap<string, IntArray>;
  readonly #ranges: readonly (readonly number[])[];
  readonly #castTimes: readonly (readonly number[])[];
  readonly #weaponSkills: readonly number[];
  readonly #stringOffsets: Uint32Array;
  readonly #stringBytes: Uint8Array;
  readonly #strings = new Map<number, string>();
  readonly #decoder = new TextDecoder("utf-8");
  readonly #made = new Map<number, SpellInfoRow>();

  private constructor(header: TableHeader, columns: ReadonlyMap<string, IntArray>, ids: Int32Array,
    stringOffsets: Uint32Array, stringBytes: Uint8Array, byteLength: number) {
    this.rows = header.rows;
    this.byteLength = byteLength;
    this.#columns = columns;
    this.#ids = ids;
    this.#ranges = header.ranges;
    this.#castTimes = header.castTimes;
    this.#weaponSkills = header.weaponSkills;
    this.#stringOffsets = stringOffsets;
    this.#stringBytes = stringBytes;
  }

  /** Reads a route answer; undefined for anything that is not this version's table (an older or newer gateway). */
  static decode(buffer: ArrayBuffer, version = SPELL_INFO_TABLE_VERSION): SpellInfoTable | undefined {
    try {
      if (buffer.byteLength < 8) return undefined;
      const headerLength = new DataView(buffer).getUint32(0, true);
      if (4 + headerLength > buffer.byteLength) return undefined;
      const header = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(buffer, 4, headerLength))) as TableHeader;
      if (header?.format !== FORMAT || header.version !== version || !Number.isSafeInteger(header.rows) || header.rows < 0
        || !Number.isSafeInteger(header.firstId) || !Array.isArray(header.columns) || !Array.isArray(header.ranges)
        || !Array.isArray(header.castTimes) || !Array.isArray(header.weaponSkills) || !header.strings) return undefined;
      const bodyAt = align(4 + headerLength, 8);
      const column = (entry: ColumnHeader, length: number): IntArray | undefined => {
        if (!(entry.type in BYTES) || !Number.isSafeInteger(entry.offset) || entry.offset % 4 !== 0
          || bodyAt + entry.offset + length * BYTES[entry.type] > buffer.byteLength) return undefined;
        return view(entry.type, buffer, bodyAt + entry.offset, length);
      };
      const columns = new Map<string, IntArray>();
      for (const entry of header.columns) {
        const values = column(entry, header.rows);
        if (!values) return undefined;
        columns.set(entry.name, values);
      }
      const required = ["id", "name", "rank", "iconPath", "range", "castTime", "shapeshiftCombatRoundTime", "weaponSkill",
        ...SCALARS, ...ARRAYS.flatMap(([key, width]) => Array.from({ length: width }, (_, index) => `${key}.${index}`))];
      if (required.some((name) => !columns.has(name))) return undefined;
      // The ids from their steps, ascending (what `row` searches).
      const steps = columns.get("id")!;
      const ids = new Int32Array(header.rows);
      let id = header.firstId;
      for (let index = 0; index < header.rows; index++) {
        id += steps[index]!;
        ids[index] = id;
        if (index > 0 && !(id > ids[index - 1]!)) return undefined;
      }
      const strings = header.strings;
      const lengths = column(strings.lengths, strings.count);
      if (!lengths || bodyAt + strings.bytes + strings.length > buffer.byteLength) return undefined;
      const offsets = new Uint32Array(strings.count + 1);
      for (let index = 0; index < strings.count; index++) offsets[index + 1] = offsets[index]! + lengths[index]!;
      if (offsets[strings.count] !== strings.length) return undefined;
      const bytes = new Uint8Array(buffer, bodyAt + strings.bytes, strings.length);
      return new SpellInfoTable(header, columns, ids, offsets, bytes, buffer.byteLength);
    } catch {
      return undefined;
    }
  }

  /** The row's index (ids ascending), or -1. */
  #index(id: number): number {
    const ids = this.#ids;
    let low = 0;
    let high = ids.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const at = ids[middle]!;
      if (at === id) return middle;
      if (at < id) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  has(id: number): boolean {
    return Number.isSafeInteger(id) && id > 0 && this.#index(id) >= 0;
  }

  #string(index: number): string {
    let text = this.#strings.get(index);
    if (text === undefined) {
      const start = this.#stringOffsets[index] ?? 0;
      const end = this.#stringOffsets[index + 1] ?? start;
      text = this.#decoder.decode(this.#stringBytes.subarray(start, end));
      this.#strings.set(index, text);
    }
    return text;
  }

  /** The spell's compact row, the same object for the same id; undefined for an id the dataset has no row for. */
  row(id: number): SpellInfoRow | undefined {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    const made = this.#made.get(id);
    if (made) return made;
    const index = this.#index(id);
    if (index < 0) return undefined;
    const value = (name: string): number => this.#columns.get(name)![index]!;
    const array = (name: string, width: number): number[] =>
      Array.from({ length: width }, (_, slot) => value(`${name}.${slot}`));
    const range = this.#ranges[value("range")] ?? [0, 0, 0, 0, 0];
    const castTime = this.#castTimes[value("castTime")] ?? [0, 0, 0];
    const attributes = array("attributes", 8);
    const row: Record<string, unknown> = {
      id,
      name: this.#string(value("name")),
      rank: this.#string(value("rank")),
      iconPath: this.#string(value("iconPath")),
      passive: ((attributes[0] ?? 0) & ATTR0_PASSIVE) !== 0,
      rangeMin: range[0] ?? 0, rangeMax: range[1] ?? 0, rangeMinFriendly: range[2] ?? 0, rangeMaxFriendly: range[3] ?? 0,
      rangeFlags: range[4] ?? 0,
      castTime: castTime[0] ?? 0, castTimePerLevel: castTime[1] ?? 0, castTimeMinimum: castTime[2] ?? 0,
    };
    for (const key of SCALARS) row[key] = value(key);
    for (const [key, width] of ARRAYS) row[key] = key === "attributes" ? attributes : array(key, width);
    const roundTime = value("shapeshiftCombatRoundTime");
    if (roundTime >= 0) row.shapeshiftCombatRoundTime = roundTime;
    if (value("weaponSkill") !== 0) {
      const mask = value("equippedItemSubclass") >>> 0;
      row.weaponSkillSpells = this.#weaponSkills.map((skill, subClass) => ((mask >>> subClass) & 1) !== 0 ? skill : 0);
    }
    const frozen = Object.freeze(row) as unknown as SpellInfoRow;
    this.#made.set(id, frozen);
    return frozen;
  }
}
