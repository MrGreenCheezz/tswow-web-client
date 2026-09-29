// What the stock calendar (Blizzard_Calendar) reads from the client's own tables.
//
// The 3.3.5a client computes holidays from Holidays.dbc with HolidayNames/HolidayDescriptions, lists
// LFGDungeons rows in its event-icon picker (with a raid's MapDifficulty string), and names raid saves
// and resets by Map.dbc. CalendarHandler.cpp sends none of that — only the holidays the server
// re-dated — so the browser asks for it here once, on the calendar window's first open.
//
// Holidays, HolidayNames, HolidayDescriptions and MapDifficulty are not in the generated DBC_LAYOUTS;
// they are read with the fixed layouts TrinityCore's DBCfmt.h declares for build 12340 and the header
// is checked against them (measured on the tswow dataset: 26 holidays of 55 fields, 26 names and 28
// descriptions of 18, 189 MapDifficulty rows of 23).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbcFile } from "./Dbc.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const CALENDAR_CATALOG_VERSION = 1;

export interface CalendarCatalogHoliday {
  id: number;
  name: string;
  description: string;
  texture: string;
  region: number;
  looping: number;
  priority: number;
  filterType: number;
  durations: number[];
  dates: number[];
  flags: number[];
}

export interface CalendarCatalogTexture {
  id: number;
  name: string;
  texture: string;
  expansion: number;
  type: number;
  faction: number;
  difficulty: number;
  difficultyToken: string;
}

export interface CalendarCatalogRaid {
  mapId: number;
  name: string;
  difficulties: { difficulty: number; token: string; resetSeconds: number }[];
}

export interface CalendarCatalog {
  version: number;
  holidays: CalendarCatalogHoliday[];
  textures: CalendarCatalogTexture[];
  raids: CalendarCatalogRaid[];
}

/** `Holidaysfmt` (DBCfmt.h): ID, Duration[10], Date[26], Region, Looping, CalendarFlags[10], name id, description id, texture, priority, filter, flags. */
export const HOLIDAYS_LAYOUT = Object.freeze({
  fieldCount: 55, recordSize: 220,
  id: 0, durations: 1, dates: 11, region: 37, looping: 38, flags: 39, nameId: 49, descriptionId: 50,
  texture: 51, priority: 52, filterType: 53,
});
/** HolidayNames/HolidayDescriptions: ID and one 17-slot localized string. */
export const HOLIDAY_TEXT_LAYOUT = Object.freeze({ fieldCount: 18, recordSize: 72 });
/** `MapDifficultyEntryfmt`: ID, MapID, Difficulty, Message_lang[17], RaidDuration, MaxPlayers, Difficultystring. */
export const MAP_DIFFICULTY_LAYOUT = Object.freeze({
  fieldCount: 23, recordSize: 92, mapId: 1, difficulty: 2, raidDuration: 20, token: 22,
});

/** ruRU is slot 8 of the sixteen, enUS slot 0. */
const LOCALE_SLOTS = [8, 0];
/** Map.dbc InstanceType of a raid (MAP_RAID in DBCEnums.h). */
const MAP_RAID = 2;

interface RawTable {
  readonly records: number;
  word(row: number, field: number): number;
  signed(row: number, field: number): number;
  text(row: number, field: number): string;
}

async function openFixed(dbcDirectory: string, name: string, layout: { fieldCount: number; recordSize: number }): Promise<RawTable> {
  const data = await readFile(join(dbcDirectory, `${name}.dbc`));
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") throw new Error(`${name}: not a WDBC file`);
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== layout.fieldCount || recordSize !== layout.recordSize || stringsOffset + stringsSize !== data.byteLength) {
    throw new Error(`${name}: ${fields} fields of ${recordSize} bytes, expected ${layout.fieldCount} of ${layout.recordSize}`);
  }
  const at = (row: number, field: number): number => 20 + row * recordSize + field * 4;
  return {
    records,
    word: (row, field) => data.readUInt32LE(at(row, field)),
    signed: (row, field) => data.readInt32LE(at(row, field)),
    text: (row, field) => {
      const offset = data.readUInt32LE(at(row, field));
      if (offset <= 0 || offset >= stringsSize) return "";
      const start = stringsOffset + offset;
      const end = data.indexOf(0, start);
      return end < start ? "" : data.subarray(start, end).toString("utf8");
    },
  };
}

function localized(table: RawTable, row: number, first: number): string {
  for (const slot of [...LOCALE_SLOTS, ...Array.from({ length: 16 }, (_unused, index) => index)]) {
    const value = table.text(row, first + slot);
    if (value) return value;
  }
  return "";
}

async function loadHolidayTexts(dbcDirectory: string, name: string): Promise<Map<number, string>> {
  const table = await openFixed(dbcDirectory, name, HOLIDAY_TEXT_LAYOUT);
  const texts = new Map<number, string>();
  for (let row = 0; row < table.records; row++) texts.set(table.word(row, 0), localized(table, row, 1));
  return texts;
}

export async function loadCalendarHolidays(dbcDirectory: string): Promise<CalendarCatalogHoliday[]> {
  const [table, names, descriptions] = await Promise.all([
    openFixed(dbcDirectory, "Holidays", HOLIDAYS_LAYOUT),
    loadHolidayTexts(dbcDirectory, "HolidayNames"),
    loadHolidayTexts(dbcDirectory, "HolidayDescriptions"),
  ]);
  const layout = HOLIDAYS_LAYOUT;
  const holidays: CalendarCatalogHoliday[] = [];
  for (let row = 0; row < table.records; row++) {
    const name = names.get(table.word(row, layout.nameId)) ?? "";
    // A row the client could not name is not shown by it either.
    if (!name) continue;
    const words = (first: number, count: number): number[] =>
      Array.from({ length: count }, (_unused, index) => table.word(row, first + index));
    holidays.push({
      id: table.word(row, layout.id),
      name,
      description: descriptions.get(table.word(row, layout.descriptionId)) ?? "",
      texture: table.text(row, layout.texture),
      region: table.word(row, layout.region),
      looping: table.word(row, layout.looping),
      priority: table.word(row, layout.priority),
      filterType: table.signed(row, layout.filterType),
      durations: words(layout.durations, 10),
      dates: words(layout.dates, 26),
      flags: words(layout.flags, 10),
    });
  }
  return holidays.sort((left, right) => left.id - right.id);
}

interface MapDifficultyRow {
  readonly mapId: number;
  readonly difficulty: number;
  readonly token: string;
  readonly resetSeconds: number;
}

async function loadMapDifficulties(dbcDirectory: string): Promise<MapDifficultyRow[]> {
  const table = await openFixed(dbcDirectory, "MapDifficulty", MAP_DIFFICULTY_LAYOUT);
  const layout = MAP_DIFFICULTY_LAYOUT;
  const rows: MapDifficultyRow[] = [];
  for (let row = 0; row < table.records; row++) {
    rows.push({
      mapId: table.word(row, layout.mapId),
      difficulty: table.word(row, layout.difficulty),
      token: table.text(row, layout.token),
      resetSeconds: table.word(row, layout.raidDuration),
    });
  }
  return rows;
}

/** The icon picker's rows: LFGDungeons of TypeID 1 (dungeon) and 2 (raid), as Wow.exe filters them. */
export async function loadCalendarTextures(dbcDirectory: string, difficulties: readonly MapDifficultyRow[]): Promise<CalendarCatalogTexture[]> {
  const dungeons = await openDbcFile(dbcDirectory, "LFGDungeons");
  const tokens = new Map(difficulties.map((row) => [`${row.mapId}:${row.difficulty}`, row.token]));
  const textures: CalendarCatalogTexture[] = [];
  for (const row of dungeons.rows()) {
    const type = dungeons.int(row, "TypeID");
    if (type !== 1 && type !== 2) continue;
    const mapId = dungeons.int(row, "MapID");
    const difficulty = dungeons.int(row, "Difficulty");
    textures.push({
      id: dungeons.id(row),
      name: dungeons.locstring(row, "Name_lang"),
      texture: dungeons.string(row, "TextureFilename"),
      expansion: dungeons.int(row, "ExpansionLevel"),
      type,
      faction: dungeons.int(row, "Faction"),
      difficulty,
      difficultyToken: tokens.get(`${mapId}:${difficulty}`) ?? "",
    });
  }
  return textures.sort((left, right) => left.id - right.id);
}

export async function loadCalendarRaids(dbcDirectory: string, difficulties: readonly MapDifficultyRow[]): Promise<CalendarCatalogRaid[]> {
  const maps = await openDbcFile(dbcDirectory, "Map");
  const byMap = new Map<number, MapDifficultyRow[]>();
  for (const row of difficulties) {
    const list = byMap.get(row.mapId) ?? [];
    list.push(row);
    byMap.set(row.mapId, list);
  }
  const raids: CalendarCatalogRaid[] = [];
  for (const row of maps.rows()) {
    if (maps.int(row, "InstanceType") !== MAP_RAID) continue;
    const mapId = maps.id(row);
    raids.push({
      mapId,
      name: maps.locstring(row, "MapName_lang"),
      difficulties: (byMap.get(mapId) ?? [])
        .sort((left, right) => left.difficulty - right.difficulty)
        .map(({ difficulty, token, resetSeconds }) => ({ difficulty, token, resetSeconds })),
    });
  }
  return raids.sort((left, right) => left.mapId - right.mapId);
}

export async function loadCalendarCatalog(dbcDirectory: string): Promise<CalendarCatalog> {
  const difficulties = await loadMapDifficulties(dbcDirectory);
  const [holidays, textures, raids] = await Promise.all([
    loadCalendarHolidays(dbcDirectory),
    loadCalendarTextures(dbcDirectory, difficulties),
    loadCalendarRaids(dbcDirectory, difficulties),
  ]);
  return { version: CALENDAR_CATALOG_VERSION, holidays, textures, raids };
}
