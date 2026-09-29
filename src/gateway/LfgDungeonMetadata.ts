import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbcFile } from "./Dbc.js";

/**
 * The catalog's shape version. Version 2 added the fields the stock `GetLFGDungeonInfo` answers
 * with (recommended levels, group, flags, faction, order, map size) and the `LFGDungeonGroup`
 * headers; the browser asks for `?v=` this number so a response cached from a version-1 gateway
 * is never mistaken for the new shape.
 */
export const LFG_DUNGEON_CATALOG_VERSION = 2;

export interface LfgDungeonMetadata {
  id: number;
  name: string;
  minLevel: number;
  maxLevel: number;
  type: number;
  difficulty: number;
  expansion: number;
  description: string;
  /** `TextureFilename` from the DBC (e.g. `DEADMINES`): selects `Interface\LFGFrame\UI-LFG-BACKGROUND-<name>`. */
  texture: string;
  /** `MapID` from the DBC, for future map-link affordances. */
  mapId: number;
  /** `Target_level`, `Target_level_min`, `Target_level_max`: stock `recLevel`/`minRecLevel`/`maxRecLevel`. */
  targetLevel: number;
  targetLevelMin: number;
  targetLevelMax: number;
  /** `Group_ID`: the `LFGDungeonGroup` row the stock list files this dungeon under (0 for none). */
  groupId: number;
  /** `Flags`: 0x4 is `LFG_FLAG_SEASONAL` (LFGMgr.h), the stock `isHoliday`. */
  flags: number;
  /** `Faction`: -1 both, 0 Horde, 1 Alliance (Ragefire Chasm is 0, the Stockade 1 in this dataset). */
  faction: number;
  orderIndex: number;
  /**
   * `Map.MaxPlayers` of `MapID`, verbatim: 5 or 10 for dungeons, 0 for random rows (map 0). Wrath
   * raids read 0 or 5 there — their sizes are per-difficulty MapDifficulty rows — which the stock
   * LFD list never reads (LFG_RETURN_VALUES.maxPlayers is a raid-browser field).
   */
  maxPlayers: number;
}

/** One `LFGDungeonGroup.dbc` row: a header of the stock dungeon list. */
export interface LfgDungeonGroupMetadata {
  id: number;
  name: string;
  orderIndex: number;
  parentGroupId: number;
  /** 1 dungeons, 5 heroic dungeons, 2 raids, 0 world events in this dataset. */
  typeId: number;
}

export interface LfgDungeonCatalogMetadata {
  version: number;
  dungeons: LfgDungeonMetadata[];
  groups: LfgDungeonGroupMetadata[];
}

/**
 * `LFGDungeonGroup` in build 12340: `ID`, a 17-slot `Name_lang`, `Order_index`, `Parent_group_ID`
 * and `TypeID` — 21 words, 84 bytes, which is what the dataset's header says (10 rows, measured).
 * It is read here with a fixed layout rather than through `DBC_LAYOUTS` because that generated
 * table does not list it; `tools/dbd/LFGDungeonGroup.dbd` is the hand-written definition this
 * layout follows, and tests/lfg-dungeon-metadata.test.mjs checks the two agree.
 */
export const LFG_DUNGEON_GROUP_LAYOUT = Object.freeze({
  fieldCount: 21,
  recordSize: 84,
  id: 0,
  name: 1,
  orderIndex: 72,
  parentGroupId: 76,
  typeId: 80,
});

/** ruRU is slot 8 of the sixteen, enUS slot 0 (tools/dbd.mjs `LOCALES`). */
const LOCALE_SLOTS = [8, 0];

export async function loadLfgDungeonGroups(dbcDirectory: string): Promise<LfgDungeonGroupMetadata[]> {
  const data = await readFile(join(dbcDirectory, "LFGDungeonGroup.dbc"));
  const layout = LFG_DUNGEON_GROUP_LAYOUT;
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new Error("LFGDungeonGroup: not a WDBC file");
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== layout.fieldCount || recordSize !== layout.recordSize
    || stringsOffset + stringsSize !== data.byteLength) {
    throw new Error(`LFGDungeonGroup: ${fields} fields of ${recordSize} bytes, expected ${layout.fieldCount} of ${layout.recordSize}`);
  }
  const text = (offset: number): string => {
    if (offset <= 0 || offset >= stringsSize) return "";
    const start = stringsOffset + offset;
    const end = data.indexOf(0, start);
    return end < start ? "" : data.subarray(start, end).toString("utf8");
  };
  const groups: LfgDungeonGroupMetadata[] = [];
  for (let row = 0; row < records; row++) {
    const base = 20 + row * recordSize;
    const word = (byteOffset: number): number => data.readInt32LE(base + byteOffset);
    let name = "";
    for (const slot of [...LOCALE_SLOTS, ...Array.from({ length: 16 }, (_unused, index) => index)]) {
      name = text(data.readUInt32LE(base + 4 + slot * 4));
      if (name) break;
    }
    const id = word(layout.id);
    if (id <= 0) continue;
    groups.push({
      id,
      name,
      orderIndex: word(layout.orderIndex),
      parentGroupId: word(layout.parentGroupId),
      typeId: word(layout.typeId),
    });
  }
  return groups.sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
}

/** `Map.MaxPlayers` by map id; an absent Map.dbc (a synthetic test directory) answers nothing. */
async function loadMapMaxPlayers(dbcDirectory: string): Promise<ReadonlyMap<number, number>> {
  try {
    const table = await openDbcFile(dbcDirectory, "Map");
    const sizes = new Map<number, number>();
    for (const row of table.rows()) sizes.set(table.id(row), table.int(row, "MaxPlayers"));
    return sizes;
  } catch {
    return new Map();
  }
}

/** Presentation metadata only. Queue eligibility and outcomes remain server-owned. */
export async function loadLfgDungeonMetadata(dbcDirectory: string): Promise<LfgDungeonCatalogMetadata> {
  const table = await openDbcFile(dbcDirectory, "LFGDungeons");
  const [maxPlayers, groups] = await Promise.all([
    loadMapMaxPlayers(dbcDirectory),
    // A dataset without the group table still serves the version-1 fields; the browser then keeps
    // its native finder, because the stock list has no headers to file dungeons under.
    loadLfgDungeonGroups(dbcDirectory).catch(() => []),
  ]);
  const dungeons: LfgDungeonMetadata[] = [];
  for (const row of table.rows()) {
    const id = table.id(row);
    const type = table.int(row, "TypeID");
    // The wire entry reserves the high byte for type; never expose an overflowing ID.
    if (id <= 0 || id > 0x00ffffff || type < 0 || type > 0xff) continue;
    const mapId = table.int(row, "MapID");
    dungeons.push({
      id,
      name: table.locstring(row, "Name_lang"),
      minLevel: table.int(row, "MinLevel"),
      maxLevel: table.int(row, "MaxLevel"),
      type,
      difficulty: table.int(row, "Difficulty"),
      expansion: table.int(row, "ExpansionLevel"),
      description: table.locstring(row, "Description_lang"),
      texture: table.string(row, "TextureFilename"),
      mapId,
      targetLevel: table.int(row, "Target_level"),
      targetLevelMin: table.int(row, "Target_level_min"),
      targetLevelMax: table.int(row, "Target_level_max"),
      groupId: table.int(row, "Group_ID"),
      flags: table.int(row, "Flags"),
      faction: table.int(row, "Faction"),
      orderIndex: table.int(row, "Order_index"),
      maxPlayers: maxPlayers.get(mapId) ?? 0,
    });
  }
  return {
    version: LFG_DUNGEON_CATALOG_VERSION,
    dungeons: dungeons.sort((left, right) => left.id - right.id),
    groups,
  };
}
