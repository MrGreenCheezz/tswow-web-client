import type { AreaInfo, MapInfo } from "../../gateway/AreaMetadata.js";
import type { FrameXmlMinimapZone } from "./FrameXmlWorldSeam.js";

/**
 * The zone answers of the stock minimap and zone banner: `GetMinimapZoneText`, `GetZoneText`,
 * `GetSubZoneText` and `GetZonePVPInfo`, resolved from the server's map/zone/area numbers and
 * `/dbc/areas` (version 8, which carries `AreaTable.Flags` and `FactionGroupMask`).
 *
 * `GetZonePVPInfo` follows the client's own Lua function (Wow.exe 3.3.5a 12340, 0x0051BA50, read
 * 2026-09-30); `frameXmlZonePvp` states its steps in order. The client keeps two area numbers — the
 * zone and, when the player stands in one of its sub-areas, that sub-area (the zone setter at
 * 0x005204C0, fed by 0x0078F020 from the area under the player: a row with a parent is the sub-zone
 * and the parent the zone, one level only) — and the PvP answer reads those two rows and nothing
 * above them.
 */

/** `AREA_FLAG_UNK3` in TrinityCore's DBCEnums.h; the client lets it answer a territory off PvP realms (the capitals carry it). */
export const AREA_FLAG_TERRITORY_ANY_REALM = 0x10;
/** `AREA_FLAG_ARENA`: «arena, both instanced and world arenas» — Gurubashi's ring, the arena maps. */
export const AREA_FLAG_ARENA = 0x80;
/** `AREA_FLAG_SANCTUARY`: «sanctuary area (PvP disabled)» — Shattrath and Dalaran carry it. */
export const AREA_FLAG_SANCTUARY = 0x800;
/** `AREA_FLAG_CONTESTED_AREA`: contested whatever the zone's owner. */
export const AREA_FLAG_CONTESTED_AREA = 0x40000;
/** `AREA_FLAG_WINTERGRASP`: «Wintergrasp and its subzones», the one 3.3.5 world-PvP combat zone. */
export const AREA_FLAG_WINTERGRASP = 0x01000000;

/**
 * Cfg_Configs.dbc's RealmType values (column 2) whose PlayerKillingAllowed (column 3) is set, read
 * from the dataset's 13 rows on 2026-09-30: PvP 1, RP-PvP 8 and the unnamed 3, 5, 10, 12.
 */
const PLAYER_KILLING_REALM_TYPES: ReadonlySet<number> = new Set([1, 3, 5, 8, 10, 12]);

/**
 * Whether the realm allows player killing: the answer `realmPvp` takes.
 *
 * The client decides it once on entering the world (Wow.exe 3.3.5a 12340, 0x00405540, read
 * 2026-09-30): the first Cfg_Configs row whose RealmType equals the realm-list entry's type byte
 * (TrinityCore's `realmlist.icon`, `Realm.h` RealmType) sets the flag to its PlayerKillingAllowed;
 * no matching row leaves it off. No realm (a canned seam) is off as well.
 */
export function frameXmlRealmPlayerKilling(realmType: number | undefined): boolean {
  return realmType !== undefined && PLAYER_KILLING_REALM_TYPES.has(realmType);
}

export type FrameXmlFactionTeam = "Alliance" | "Horde";

/**
 * The two faction groups of a player's side, as the race faction templates carry them
 * (FactionTemplate.dbc: Human 1 is friend 2 / enemy 12, Orc 2 is friend 4 / enemy 10 — every
 * playable race's row is one of those two pairs in this dataset).
 */
const TEAM_GROUPS: Readonly<Record<FrameXmlFactionTeam, { readonly friend: number; readonly enemy: number }>> = {
  Alliance: { friend: 2, enemy: 12 },
  Horde: { friend: 4, enemy: 10 },
};

/**
 * FactionGroup.dbc rows in table order with a non-empty name: the third value is the first of them
 * whose bit is in the zone's mask (Player 1 and Monster 8 have no name and are never chosen).
 */
const NAMED_FACTION_GROUPS: readonly { readonly bit: number; readonly team: FrameXmlFactionTeam }[] = [
  { bit: 2, team: "Alliance" },
  { bit: 4, team: "Horde" },
];

/** The two columns the PvP answer reads, plus the parent edge the pair is built from. */
export interface FrameXmlZonePvpArea {
  readonly id: number;
  readonly parentId: number;
  /** Absent from a gateway older than `/dbc/areas` version 8. */
  readonly flags?: number;
  readonly factionGroupMask?: number;
}

/**
 * `pvpType`, whether the answer came from the sub-zone's row (the client's 1-or-nil second value),
 * and the faction group named third: a side, `""` when the zone's mask names none, undefined for
 * the answers that carry no third value.
 */
export interface FrameXmlZonePvp {
  readonly pvpType: string | undefined;
  readonly isSubZonePvP: boolean;
  readonly faction: FrameXmlFactionTeam | "" | undefined;
}

/** The zone and sub-zone rows of an area: one parent step, as the client takes them. */
export function frameXmlZonePair<Area extends FrameXmlZonePvpArea>(
  areaId: number,
  lookup: (areaId: number) => Area | undefined,
): { readonly zone: Area | undefined; readonly subZone: Area | undefined } {
  const area = lookup(areaId);
  if (!area) return { zone: undefined, subZone: undefined };
  if (area.parentId === 0) return { zone: area, subZone: undefined };
  return { zone: lookup(area.parentId), subZone: area };
}

const NO_STATUS: FrameXmlZonePvp = Object.freeze({ pvpType: undefined, isSubZonePvP: false, faction: undefined });

function hasColumns(area: FrameXmlZonePvpArea | undefined): boolean {
  return area === undefined || (typeof area.flags === "number" && typeof area.factionGroupMask === "number");
}

/**
 * `GetZonePVPInfo` over the zone and sub-zone rows. Undefined when a row lacks the version-8
 * columns: an old gateway leaves the banner uncoloured rather than guessed.
 *
 * 1. The flags are the sub-zone's when there is a sub-zone row, else the zone's (else none), and
 *    the second value is set exactly when they were the sub-zone's.
 * 2. SANCTUARY 0x800 → "sanctuary"; then ARENA 0x80 → "arena"; then WINTERGRASP 0x01000000 →
 *    "combat" — these three with no third value, and the Wintergrasp one whatever the battle does.
 * 3. Otherwise the second value is always nil, and nothing at all is answered without a zone row,
 *    without a player, or off a PvP realm unless the zone's own flags carry 0x10.
 * 4. CONTESTED_AREA 0x40000 in the flags of step 1 → "contested"; else the zone's FactionGroupMask
 *    against the player's side: a friend group in it → "friendly", else an enemy group → "hostile",
 *    else "contested" (so a mask naming both sides is friendly to either, and 0 is contested).
 * 5. The third value is the first named faction group in the zone's mask, or "".
 *
 * Instances get no special case: their rows answer like any other. The player's side unknown is
 * not guessed (the client always has a faction template).
 */
export function frameXmlZonePvp(
  zone: FrameXmlZonePvpArea | undefined,
  subZone: FrameXmlZonePvpArea | undefined,
  options: { readonly realmPvp?: boolean; readonly team?: FrameXmlFactionTeam },
): FrameXmlZonePvp | undefined {
  if (!hasColumns(zone) || !hasColumns(subZone)) return undefined;
  const fromSubZone = subZone !== undefined;
  const flags = (subZone ?? zone)?.flags ?? 0;
  if ((flags & AREA_FLAG_SANCTUARY) !== 0) return { pvpType: "sanctuary", isSubZonePvP: fromSubZone, faction: undefined };
  if ((flags & AREA_FLAG_ARENA) !== 0) return { pvpType: "arena", isSubZonePvP: fromSubZone, faction: undefined };
  if ((flags & AREA_FLAG_WINTERGRASP) !== 0) return { pvpType: "combat", isSubZonePvP: fromSubZone, faction: undefined };
  if (!zone || options.team === undefined) return NO_STATUS;
  if (options.realmPvp !== true && (zone.flags! & AREA_FLAG_TERRITORY_ANY_REALM) === 0) return NO_STATUS;
  const mask = zone.factionGroupMask!;
  const groups = TEAM_GROUPS[options.team];
  const pvpType = (flags & AREA_FLAG_CONTESTED_AREA) !== 0 ? "contested"
    : (groups.friend & mask) !== 0 ? "friendly"
      : (groups.enemy & mask) !== 0 ? "hostile"
        : "contested";
  const faction = NAMED_FACTION_GROUPS.find((group) => (mask & group.bit) !== 0)?.team ?? "";
  return { pvpType, isSubZonePvP: false, faction };
}

/** The AreaClient reads the resolver makes. */
export interface FrameXmlZoneAreas {
  area(areaId: number): (AreaInfo & FrameXmlZonePvpArea) | undefined;
  zoneOf(areaId: number): AreaInfo | undefined;
  map(mapId: number): MapInfo | undefined;
}

export interface FrameXmlZoneInput {
  readonly mapId: number | undefined;
  /** The server's zone (`SMSG_INIT_WORLD_STATES`): the explicit parent even when terrain names the area. */
  readonly zoneId: number | undefined;
  /** The server's area, the fallback when the terrain has none. */
  readonly areaId: number | undefined;
  /** The terrain's precise area (the native minimap's cache), preferred when positive. */
  readonly terrainAreaId?: number;
  /** The player's side; unknown leaves an owned territory's status nil. */
  readonly team?: FrameXmlFactionTeam;
  /**
   * Whether the realm allows player killing (Cfg_Configs.dbc's third column for the realm's type,
   * `frameXmlRealmPlayerKilling`); the world mount passes it from `WorldClient.realmType`. Absent is
   * a PvE realm, as the client's flag is off without a matching row.
   */
  readonly realmPvp?: boolean;
  /** The localised faction name `FACTION_CONTROLLED_TERRITORY` is formatted with. */
  readonly factionName: (team: FrameXmlFactionTeam) => string;
}

/**
 * The minimap/zone-banner answer, or undefined while nothing is known. Texts that are unknown are
 * left out; the bindings answer "" for them, as the client does (FrameXmlWorldSeam.ts).
 *
 * `GetMinimapZoneText` is the most specific name — the sub-zone where there is one, as the
 * original minimap shows «Златоземье» in Goldshire (the client stores the sub-zone's name there, or
 * the zone's without one) — and `GetZoneText` the zone's.
 */
export function frameXmlResolveZone(areas: FrameXmlZoneAreas, input: FrameXmlZoneInput): FrameXmlMinimapZone | undefined {
  if (input.mapId === undefined) return undefined;
  const resolvedAreaId = input.terrainAreaId !== undefined && input.terrainAreaId > 0
    ? input.terrainAreaId
    : input.areaId !== undefined && input.areaId > 0 ? input.areaId : 0;
  const area = resolvedAreaId > 0 ? areas.area(resolvedAreaId) : undefined;
  const zone = (input.zoneId !== undefined ? areas.area(input.zoneId) : undefined)
    ?? (area ? areas.zoneOf(area.id) : undefined);
  const map = areas.map(input.mapId);
  const zoneText = zone?.name ?? map?.name;
  if (zoneText === undefined) return undefined;
  const subZoneText = area && zone && area.id !== zone.id ? area.name : undefined;
  const result: {
    minimapZoneText: string; zoneText: string; subZoneText?: string;
    pvpType?: string; isSubZonePvP?: boolean; factionName?: string;
  } = { minimapZoneText: subZoneText ?? zoneText, zoneText };
  if (subZoneText !== undefined) result.subZoneText = subZoneText;
  const pair = area
    ? frameXmlZonePair(area.id, (id) => areas.area(id))
    : { zone: zone ? areas.area(zone.id) : undefined, subZone: undefined };
  const pvp = pair.zone || pair.subZone
    ? frameXmlZonePvp(pair.zone, pair.subZone, {
      ...(input.realmPvp === undefined ? {} : { realmPvp: input.realmPvp }),
      ...(input.team ? { team: input.team } : {}),
    })
    : undefined;
  if (pvp) {
    if (pvp.pvpType !== undefined) result.pvpType = pvp.pvpType;
    result.isSubZonePvP = pvp.isSubZonePvP;
    if (pvp.faction !== undefined) result.factionName = pvp.faction === "" ? "" : input.factionName(pvp.faction);
  }
  return result;
}
