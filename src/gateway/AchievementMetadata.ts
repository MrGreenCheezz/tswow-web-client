// The achievement catalog the stock Blizzard_AchievementUI reads through its C API.
//
// Every name, description, reward, category and criterion the achievement window shows is client
// data — `Achievement.dbc`, `Achievement_Category.dbc` and `Achievement_Criteria.dbc` — and the
// server only ever sends ids, packed dates and counters (SMSG_ALL_ACHIEVEMENT_DATA,
// SMSG_CRITERIA_UPDATE, SMSG_ACHIEVEMENT_EARNED). So the three tables are read here and sent whole,
// once, the first time the browser needs them (the window, a toast, an achievement chat line).
//
// The generated `DBC_LAYOUTS` table does not list these three, so each is read with a fixed layout
// checked against the file header — the 12340 layouts TrinityCore reads (DBCfmt.h
// `Achievementfmt`, `AchievementCriteriafmt`, DBCStructure.h), with the columns the core skips named
// from the file itself. Measured on the tswow dataset: 1,817 achievements (62 words, 248 bytes),
// 86 categories (20 words, 80 bytes), 7,655 criteria (31 words, 124 bytes).
//
// Rows travel as arrays rather than objects: measured on this dataset, the three tables are 963,245
// bytes of JSON this way and were 1,736,982 as objects, the difference repeated key names.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LOCALE, openDbcFile } from "./Dbc.js";
import { DBC_LOCALES, DBC_LOCSTRING_FIELDS, type DbcLocale } from "../generated/dbcLayouts.js";

/** The catalog's shape version; the browser asks for `?v=` this number. */
export const ACHIEVEMENT_CATALOG_VERSION = 1;

/** Word offsets of the columns read, and each table's size in words. */
export const ACHIEVEMENT_LAYOUT = Object.freeze({
  fieldCount: 62, id: 0, faction: 1, instance: 2, supercedes: 3, title: 4, description: 21, category: 38,
  points: 39, uiOrder: 40, flags: 41, icon: 42, reward: 43, minimumCriteria: 60, sharesCriteria: 61,
});
export const ACHIEVEMENT_CATEGORY_LAYOUT = Object.freeze({ fieldCount: 20, id: 0, parent: 1, name: 2, uiOrder: 19 });
export const ACHIEVEMENT_CRITERIA_LAYOUT = Object.freeze({
  fieldCount: 31, id: 0, achievement: 1, type: 2, asset: 3, quantity: 4, description: 9, flags: 26,
  timerStartEvent: 27, timerAsset: 28, timerTime: 29, uiOrder: 30,
});

/** `[id, parent, name, uiOrder]`. The statistics tree hangs under category 1. */
export type AchievementCategoryRow = [id: number, parent: number, name: string, uiOrder: number];
/**
 * `[id, faction, instance, supercedes, name, description, category, points, uiOrder, flags, icon,
 * reward, minimumCriteria, sharesCriteria]`. `faction` is -1 both, 0 Horde, 1 Alliance; `icon` is the
 * texture name under `Interface\Icons\` ("" when the SpellIcon row is missing).
 */
export type AchievementRow = [
  id: number, faction: number, instance: number, supercedes: number, name: string, description: string,
  category: number, points: number, uiOrder: number, flags: number, icon: string, reward: string,
  minimumCriteria: number, sharesCriteria: number,
];
/** `[id, achievement, type, asset, quantity, description, flags, timerStartEvent, timerAsset, timerTime, uiOrder]`. */
export type AchievementCriteriaRow = [
  id: number, achievement: number, type: number, asset: number, quantity: number, description: string,
  flags: number, timerStartEvent: number, timerAsset: number, timerTime: number, uiOrder: number,
];

export interface AchievementCatalogMetadata {
  version: number;
  categories: AchievementCategoryRow[];
  achievements: AchievementRow[];
  criteria: AchievementCriteriaRow[];
}

const ICON_PREFIX = /^interface\\icons\\/i;

interface FixedTable {
  readonly records: number;
  word(row: number, field: number): number;
  text(row: number, field: number): string;
  /** One localised column: the chosen locale, then enUS, then any filled slot. */
  locstring(row: number, field: number): string;
}

async function openFixed(directory: string, table: string, fieldCount: number, locale: DbcLocale): Promise<FixedTable> {
  const data = await readFile(join(directory, `${table}.dbc`));
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") throw new Error(`${table}: not a WDBC file`);
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== fieldCount || recordSize !== fieldCount * 4 || stringsOffset + stringsSize !== data.byteLength) {
    throw new Error(`${table}: ${fields} fields of ${recordSize} bytes, expected ${fieldCount} of ${fieldCount * 4}`);
  }
  const word = (row: number, field: number): number => data.readInt32LE(20 + row * recordSize + field * 4);
  const at = (offset: number): string => {
    if (offset <= 0 || offset >= stringsSize) return "";
    const start = stringsOffset + offset;
    const end = data.indexOf(0, start);
    return end < start ? "" : data.subarray(start, end).toString("utf8");
  };
  const slots = [...new Set([
    (DBC_LOCALES as readonly string[]).indexOf(locale), 0,
    ...Array.from({ length: DBC_LOCSTRING_FIELDS - 1 }, (_unused, index) => index),
  ])].filter((slot) => slot >= 0);
  return {
    records,
    word,
    text: (row, field) => at(word(row, field)),
    locstring: (row, field) => {
      for (const slot of slots) {
        const value = at(word(row, field + slot));
        if (value) return value;
      }
      return "";
    },
  };
}

/** SpellIcon id → texture name under `Interface\Icons\`; an absent table answers nothing. */
async function loadIconNames(directory: string): Promise<ReadonlyMap<number, string>> {
  try {
    const table = await openDbcFile(directory, "SpellIcon");
    const names = new Map<number, string>();
    for (const row of table.rows()) {
      const path = table.string(row, "TextureFilename");
      // One path segment of printable text, or the browser could be steered outside the icon folder.
      const name = ICON_PREFIX.test(path) ? path.replace(ICON_PREFIX, "") : "";
      if (/^[\x21-\x7e][\x20-\x7e]{0,127}$/.test(name) && !/[\\/]/.test(name)) names.set(table.id(row), name);
    }
    return names;
  } catch {
    return new Map();
  }
}

/**
 * Presentation data only: whether an achievement is earned, and how far a criterion has come, is
 * the server's (the achievement packets); what either one is called is this catalog's.
 */
export async function loadAchievementCatalog(
  dbcDirectory: string,
  locale: DbcLocale = DEFAULT_LOCALE,
): Promise<AchievementCatalogMetadata> {
  const [achievementTable, categoryTable, criteriaTable, icons] = await Promise.all([
    openFixed(dbcDirectory, "Achievement", ACHIEVEMENT_LAYOUT.fieldCount, locale),
    openFixed(dbcDirectory, "Achievement_Category", ACHIEVEMENT_CATEGORY_LAYOUT.fieldCount, locale),
    openFixed(dbcDirectory, "Achievement_Criteria", ACHIEVEMENT_CRITERIA_LAYOUT.fieldCount, locale),
    loadIconNames(dbcDirectory),
  ]);
  const categories: AchievementCategoryRow[] = [];
  const C = ACHIEVEMENT_CATEGORY_LAYOUT;
  for (let row = 0; row < categoryTable.records; row += 1) {
    const id = categoryTable.word(row, C.id);
    if (id <= 0) continue;
    categories.push([id, categoryTable.word(row, C.parent), categoryTable.locstring(row, C.name), categoryTable.word(row, C.uiOrder)]);
  }
  const achievements: AchievementRow[] = [];
  const A = ACHIEVEMENT_LAYOUT;
  for (let row = 0; row < achievementTable.records; row += 1) {
    const id = achievementTable.word(row, A.id);
    if (id <= 0) continue;
    const word = (field: number): number => achievementTable.word(row, field);
    achievements.push([
      id, word(A.faction), word(A.instance), word(A.supercedes),
      achievementTable.locstring(row, A.title), achievementTable.locstring(row, A.description),
      word(A.category), word(A.points), word(A.uiOrder), word(A.flags), icons.get(word(A.icon)) ?? "",
      achievementTable.locstring(row, A.reward), word(A.minimumCriteria), word(A.sharesCriteria),
    ]);
  }
  const criteria: AchievementCriteriaRow[] = [];
  const K = ACHIEVEMENT_CRITERIA_LAYOUT;
  for (let row = 0; row < criteriaTable.records; row += 1) {
    const id = criteriaTable.word(row, K.id);
    if (id <= 0) continue;
    const word = (field: number): number => criteriaTable.word(row, field);
    criteria.push([
      id, word(K.achievement), word(K.type), word(K.asset), word(K.quantity),
      criteriaTable.locstring(row, K.description), word(K.flags), word(K.timerStartEvent),
      word(K.timerAsset), word(K.timerTime), word(K.uiOrder),
    ]);
  }
  const byId = <Row extends readonly [number, ...unknown[]]>(left: Row, right: Row): number => left[0] - right[0];
  return {
    version: ACHIEVEMENT_CATALOG_VERSION,
    categories: categories.sort(byId),
    achievements: achievements.sort(byId),
    criteria: criteria.sort(byId),
  };
}
