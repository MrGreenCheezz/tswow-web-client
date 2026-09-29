import { openDbcFile } from "./Dbc.js";
import { BATTLEGROUND_RB } from "../world/PvpProtocol.js";

/** The 3.3.5 battleground type ids this client can present in its queue catalog. */
export const BATTLEGROUND_TYPE_IDS = [1, 2, 3, 7, 9, 30, 32] as const;

const BATTLEGROUND_INSTANCE_TYPE = 3;
const BATTLEGROUND_MAP_SLOTS = 8;

export interface BattlegroundMapInfo {
  id: number;
  name: string;
  /** Horde-side `MapDescription0_lang`, when the client dataset resolves it. */
  description0?: string;
  /** Alliance-side `MapDescription1_lang`, when the client dataset resolves it. */
  description1?: string;
}

export interface BattlegroundMetadata {
  /** `BattlemasterList.ID`, the value used as `bgTypeId` by the queue protocol. */
  bgTypeId: number;
  name: string;
  /** All non-zero `BattlemasterList.MapID` slots, in the order authored by the client data. */
  mapIds: number[];
  minLevel: number;
  maxLevel: number;
  maxGroupSize: number;
  groupsAllowed: number;
  /** The DBC world-state id; this is not an active-holiday boolean. */
  holidayWorldState: number;
  /** True only for `BATTLEGROUND_RB` (32), the protocol's random-battleground id. */
  random: boolean;
  /** Map names and faction descriptions resolved from `Map.dbc`; absent rows are not invented. */
  maps: BattlegroundMapInfo[];
}

/**
 * Reads the fixed 3.3.5 battleground catalog from client DBC data.
 *
 * `BattlemasterList` is authoritative for what can be queued, its limits and its map id list.
 * `Map.dbc` only enriches those ids with display text. A local dataset that cannot supply one of
 * the seven known type-3 rows is rejected rather than returning a partial catalog that could make
 * a queue button point at an invented or silently missing battleground.
 */
export async function loadBattlegroundMetadata(dbcDirectory: string): Promise<BattlegroundMetadata[]> {
  const [battlemaster, mapsTable] = await Promise.all([
    openDbcFile(dbcDirectory, "BattlemasterList"),
    openDbcFile(dbcDirectory, "Map"),
  ]);
  const allowed = new Set<number>(BATTLEGROUND_TYPE_IDS);
  const rows = new Map<number, number>();
  for (const row of battlemaster.rows()) {
    const id = battlemaster.id(row);
    if (allowed.has(id) && battlemaster.int(row, "InstanceType") === BATTLEGROUND_INSTANCE_TYPE) {
      rows.set(id, row);
    }
  }
  const missing = BATTLEGROUND_TYPE_IDS.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    throw new Error(`BattlemasterList is missing type-3 battleground rows: ${missing.join(", ")}`);
  }

  return BATTLEGROUND_TYPE_IDS.map((bgTypeId) => {
    const row = rows.get(bgTypeId)!;
    const mapIds: number[] = [];
    for (let element = 0; element < BATTLEGROUND_MAP_SLOTS; element++) {
      const mapId = battlemaster.int(row, "MapID", element);
      if (mapId > 0 && !mapIds.includes(mapId)) mapIds.push(mapId);
    }
    const maps: BattlegroundMapInfo[] = [];
    for (const id of mapIds) {
      const mapRow = mapsTable.rowOf(id);
      if (mapRow === undefined) continue;
      const name = mapsTable.locstring(mapRow, "MapName_lang");
      if (!name) continue;
      const description0 = mapsTable.locstring(mapRow, "MapDescription0_lang");
      const description1 = mapsTable.locstring(mapRow, "MapDescription1_lang");
      maps.push({
        id,
        name,
        ...(description0 ? { description0 } : {}),
        ...(description1 ? { description1 } : {}),
      });
    }
    return {
      bgTypeId,
      name: battlemaster.locstring(row, "Name_lang"),
      mapIds,
      minLevel: battlemaster.int(row, "Minlevel"),
      maxLevel: battlemaster.int(row, "Maxlevel"),
      maxGroupSize: battlemaster.int(row, "MaxGroupSize"),
      groupsAllowed: battlemaster.int(row, "GroupsAllowed"),
      holidayWorldState: battlemaster.int(row, "HolidayWorldState"),
      random: bgTypeId === BATTLEGROUND_RB,
      maps,
    };
  });
}
