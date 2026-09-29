// The character-title catalog behind the stock PaperDoll title picker (PlayerTitleFrame) and
// CharacterFrame's UnitPVPName.
//
// The realm carries numbers only: `PLAYER_CHOSEN_TITLE` is a CharTitles `Mask_ID`, and the six
// words from `PLAYER__FIELD_KNOWN_TITLES` hold one bit per Mask_ID (`Player::SetTitle`:
// word MaskID / 32, bit MaskID % 32; `SMSG_TITLE_EARNED` names the same number). The words the
// picker shows — «Рядовой %s», «%s, Чемпион Наару» — and their female forms are CharTitles.dbc,
// which the browser asks for once, the first time a stock world mounts (FrameXmlTitlesLive.ts).
//
// CharTitles is not in the generated DBC_LAYOUTS; it is read with the layout TrinityCore declares
// for build 12340 (DBCfmt.h `CharTitlesEntryfmt = "nxssssssssssssssssxssssssssssssssssxi"`), and
// the header is checked against it. The field order is DBCStructure.h's CharTitlesEntry:
// {ID, ConditionID, Name[16] + language mask, Name1[16] (female) + mask, MaskID}. Measured on
// this dataset: 142 rows of 37 fields (148 bytes), only the ruRU slot filled, masks 1..142.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DBC_LOCALES, DBC_LOCSTRING_FIELDS, type DbcLocale } from "../generated/dbcLayouts.js";
import { DbcError, DEFAULT_LOCALE } from "./Dbc.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const CHAR_TITLES_VERSION = 1;

/** `CharTitlesEntryfmt`: ID, ConditionID, 16 + 1 name fields, 16 + 1 female-name fields, MaskID. */
export const CHAR_TITLES_LAYOUT = Object.freeze({ fieldCount: 37, recordSize: 148 });
const ID_FIELD = 0;
const NAME_FIELD = 2;
const NAME_FEMALE_FIELD = NAME_FIELD + DBC_LOCSTRING_FIELDS;
const MASK_FIELD = NAME_FEMALE_FIELD + DBC_LOCSTRING_FIELDS;
const FALLBACK_LOCALE: DbcLocale = "enUS";

export interface CharTitleRow {
  /** `CharTitles.ID`: what a quest or achievement reward names (`Quest::GetCharTitleId`). */
  id: number;
  /** `Mask_ID`: the bit in PLAYER__FIELD_KNOWN_TITLES and the value of PLAYER_CHOSEN_TITLE. */
  maskId: number;
  /** `Name_lang` with its `%s` player-name placeholder, as the client formats it. */
  name: string;
  /** `Name1_lang`, the declined female form; empty where the language has none. */
  nameFemale: string;
}

export interface CharTitleCatalog {
  version: number;
  /** Ascending by `maskId`. */
  titles: CharTitleRow[];
}

interface FixedRows {
  readonly records: number;
  int(row: number, field: number): number;
  /** The string a field's offset names; empty for a zero offset or one outside the block. */
  string(row: number, field: number): string;
}

async function readFixed(
  dbcDirectory: string, table: string, layout: { fieldCount: number; recordSize: number },
): Promise<FixedRows> {
  const data = await readFile(join(dbcDirectory, `${table}.dbc`)).catch((error: Error) => {
    throw new DbcError(`${table}.dbc could not be read from ${dbcDirectory}: ${error.message}`);
  });
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
    string: (row, field) => {
      const offset = data.readUInt32LE(20 + row * recordSize + field * 4);
      if (offset === 0 || offset >= stringsSize) return "";
      const start = stringsOffset + offset;
      const end = data.indexOf(0, start);
      return end < start ? "" : data.subarray(start, end).toString("utf8");
    },
  };
}

/** One locale of a localised string, then enUS, then any filled slot — as Dbc.locstring reads them. */
function locstring(rows: FixedRows, row: number, field: number, locale: DbcLocale): string {
  for (const candidate of [locale, FALLBACK_LOCALE]) {
    const slot = (DBC_LOCALES as readonly string[]).indexOf(candidate);
    if (slot < 0) continue;
    const value = rows.string(row, field + slot);
    if (value) return value;
  }
  for (let slot = 0; slot < DBC_LOCSTRING_FIELDS - 1; slot++) {
    const value = rows.string(row, field + slot);
    if (value) return value;
  }
  return "";
}

export async function loadCharTitles(dbcDirectory: string, locale: DbcLocale = DEFAULT_LOCALE): Promise<CharTitleCatalog> {
  const rows = await readFixed(dbcDirectory, "CharTitles", CHAR_TITLES_LAYOUT);
  const titles: CharTitleRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    const id = rows.int(row, ID_FIELD);
    const maskId = rows.int(row, MASK_FIELD);
    // A row without a mask has no bit to be known by and no value the chosen field could hold.
    if (id <= 0 || maskId <= 0) continue;
    titles.push({
      id,
      maskId,
      name: locstring(rows, row, NAME_FIELD, locale),
      nameFemale: locstring(rows, row, NAME_FEMALE_FIELD, locale),
    });
  }
  titles.sort((left, right) => left.maskId - right.maskId || left.id - right.id);
  return { version: CHAR_TITLES_VERSION, titles };
}
