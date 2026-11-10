/**
 * 03.11: what Wow.exe's minimap is made of, measured on the real client (docs/implementation/minimap-original.ru.md).
 * Everything here is a number or a rule, no drawing state: the zoom tables, which cell of which sheet stands for what,
 * and which AreaPOI get an arrow on the rim.
 */
import { minimapBlip, type WorldPoint } from "../MinimapGeometry.js";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_REWARD,
} from "../../world/QuestProtocol.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";

export const MINIMAP_MASK_TEXTURE = "Textures\\MinimapMask.blp";
export const MINIMAP_PLAYER_ARROW_TEXTURE = "Interface\\Minimap\\MinimapArrow.blp";
export const MINIMAP_OBJECT_ICONS_TEXTURE = "Interface\\Minimap\\ObjectIcons.blp";
export const MINIMAP_PARTY_BLIPS_TEXTURE = "Interface\\Minimap\\PartyRaidBlips.blp";
export const MINIMAP_POI_ARROW_TEXTURE = "Interface\\Minimap\\Rotating-MinimapArrow.blp";
export const MINIMAP_CORPSE_ARROW_TEXTURE = "Interface\\Minimap\\Rotating-MinimapCorpseArrow.blp";
export const MINIMAP_GROUP_ARROW_TEXTURE = "Interface\\Minimap\\Rotating-MinimapGroupArrow.blp";

/** Six steps, widest first, yards across the circle: fitted against the client's own tiles to within a yard or two. */
const OUTDOOR_YARDS = [1400 / 3, 400, 1000 / 3, 800 / 3, 200, 400 / 3] as const;
/** The building's pictures: the ratios are fitted between frames, and the widest two only against each other. */
const INDOOR_YARDS = [300, 240, 180, 120, 80, 50] as const;
export const MINIMAP_ZOOM_LEVELS = 6;
/** The client's CVars on a fresh install: `minimapZoom` 0, `minimapInsideZoom` 3. */
export const MINIMAP_DEFAULT_OUTDOOR_ZOOM = 0;
export const MINIMAP_DEFAULT_INDOOR_ZOOM = 3;

export function minimapZoomIndex(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MINIMAP_ZOOM_LEVELS ? value : fallback;
}

/** Yards across the circle at this zoom. `inside`: the map under the character is a building's pictures. */
export function minimapYards(inside: boolean, zoom: number): number {
  return (inside ? INDOOR_YARDS : OUTDOOR_YARDS)[minimapZoomIndex(zoom, 0)]!;
}

/** The stock Minimap frame is 140 units across; sizes below are in those units. */
export const MINIMAP_UNITS = 140;
export const MINIMAP_ICON_UNITS = 16;
/** Fitted beside Wow.exe's frames at 720 lines: the arrow's opaque part 15 pixels tall. */
export const MINIMAP_PLAYER_ARROW_UNITS = 28;
/** Fitted to the frames: a quad of 35 px centred at 0.8 of the radius. */
export const MINIMAP_RIM_ARROW_UNITS = 37;
/** Wow.exe 0x00a34c18 (MinimapGossipPoi.ts), and where the arrows' centres were measured. */
export const MINIMAP_RIM_FRACTION = 0.8;
/** Wow.exe 0x00a41e00; measured on AreaPOI: an arrow at 690 yards, none at 720, at either end of the zoom. */
const POI_ARROW_YARDS = 694.44446;
/** The tombstone of a ghost's corpse: cell 8 of POIIcons. */
export const MINIMAP_CORPSE_POI_ICON = 8;

export interface MinimapIconCell {
  readonly column: number;
  readonly row: number;
}

/** ObjectIcons.blp is 8 by 2 cells of 32 pixels. */
export const MINIMAP_OBJECT_CELL = 32;
/** PartyRaidBlips.blp is 8 by 4 cells of 32 pixels. */
export const MINIMAP_PARTY_CELL = 32;

const QUEST_AVAILABLE: MinimapIconCell = { column: 1, row: 1 };
const QUEST_REWARD: MinimapIconCell = { column: 2, row: 1 };
const QUEST_AVAILABLE_REP: MinimapIconCell = { column: 3, row: 1 };
const TRACKED_HOSTILE: MinimapIconCell = { column: 5, row: 0 };
const TRACKED_NEUTRAL: MinimapIconCell = { column: 6, row: 0 };
const TRACKED_FRIENDLY: MinimapIconCell = { column: 7, row: 0 };
/** Town trackers and resource nodes: two cells of the sheet fit the frames equally, and they are nearly the same picture. */
export const MINIMAP_TOWN_CELL: MinimapIconCell = { column: 0, row: 1 };
/**
 * 3.13 (07.11): a flight master whose node this character does not know (the unit's taxi mark, SMSG_TAXINODE_STATUS,
 * 0x006d5fc0): Wow.exe 0x0057f7f0 puts it in list 13 after the quest marks and before creature tracking.
 */
export const MINIMAP_FLIGHT_MASTER_CELL: MinimapIconCell = { column: 5, row: 1 };

/** Wow.exe's list of an ObjectIcons blip is its cell, row by row (0x00580380 draws list k with cell k). */
export function minimapObjectList(cell: MinimapIconCell): number {
  return cell.row * 8 + cell.column;
}

/**
 * The icon a quest giver gets. On a ring of NPCs one status each: 8, 10 and 7 mark; 6, 9, 3, 5 and 1 do not, and those
 * stay ordinary units to tracking; 2 and 4 mark only under the «low-level quests» tracker.
 */
export function minimapQuestCell(status: number, trivialTracked: boolean): MinimapIconCell | undefined {
  if (status === QUEST_STATUS_AVAILABLE) return QUEST_AVAILABLE;
  if (status === QUEST_STATUS_REWARD) return QUEST_REWARD;
  if (status === QUEST_STATUS_AVAILABLE_REP) return QUEST_AVAILABLE_REP;
  if (trivialTracked && status === QUEST_STATUS_LOW_LEVEL_AVAILABLE) return QUEST_AVAILABLE;
  if (trivialTracked && status === QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP) return QUEST_AVAILABLE_REP;
  return undefined;
}

/** A unit shown by creature tracking: red, gold or green by what it is to the player. */
export function minimapTrackedCell(reaction: number): MinimapIconCell {
  if (reaction <= REACTION_HOSTILE) return TRACKED_HOSTILE;
  return reaction >= REACTION_FRIENDLY ? TRACKED_FRIENDLY : TRACKED_NEUTRAL;
}

/** A party member's dot: the class's cell, in the order of ChrClasses; white when the class is not known. */
export function minimapPartyCell(classId: number | undefined): MinimapIconCell {
  if (classId === undefined || !(classId >= 1) || classId > 16) return { column: 4, row: 0 };
  const index = Math.trunc(classId) - 1;
  return { column: index % 8, row: Math.floor(index / 8) };
}

/**
 * What the terrain tiles are multiplied by. Their quads carry a normal and Wow.exe draws them lit, so the map dims at night
 * and turns blue in Duskwood; a building's pictures come out of their render target as they are. Fitted to the tiles of
 * eight frames, four hours of the day and five zones, against Light.dbc's bands there: the error is 0.03 of full scale.
 */
export function minimapTileTint(
  ambient: { readonly r: number; readonly g: number; readonly b: number },
  diffuse: { readonly r: number; readonly g: number; readonly b: number },
): readonly [number, number, number] {
  const channel = (a: number, d: number): number => Math.max(0, Math.min(1, 0.396 + 0.45 * a + 0.297 * d));
  return [channel(ambient.r, diffuse.r), channel(ambient.g, diffuse.g), channel(ambient.b, diffuse.b)];
}

/** The terrain tiles sit one pixel up and left of the circle's centre at 131 pixels across, at every zoom. */
export const MINIMAP_TILE_SHIFT_FRACTION = 1 / 131;

export interface MinimapRimPoi extends WorldPoint {
  readonly mapId: number;
  readonly flags: number;
  readonly worldStateId: number;
}

/**
 * The AreaPOI that can get a rim arrow. Measured in eight places on two continents: flag 0x1, whatever the zone and
 * whatever the faction (a human sees Grom'gol's). 11.11: a record bound to a world state counts only while that world
 * state's value is not 0 (Wow.exe 0x007f44a0 through 0x00548d10, which answers 0 for a state the client never got) —
 * the frames were taken on a server that sent none, so those records were out there.
 */
export function minimapRimPois<T extends MinimapRimPoi>(
  pois: readonly T[],
  mapId: number,
  worldState: (id: number) => number | undefined = () => undefined,
): T[] {
  return minimapAreaPoisOfMap(pois, mapId).filter((poi) => minimapPoiWorldStateShown(poi.worldStateId, worldState));
}

/** 11.11: the map's AreaPOI with flag 0x1, last record first is the caller's (0x007f6730); world states are per frame. */
export function minimapAreaPoisOfMap<T extends MinimapRimPoi>(pois: readonly T[], mapId: number): T[] {
  return pois.filter((poi) => poi.mapId === mapId && (poi.flags & 0x1) !== 0);
}

/** 11.11: 0x007f44a0's test of a record's world state: none, or a value other than 0. */
export function minimapPoiWorldStateShown(worldStateId: number, worldState: (id: number) => number | undefined): boolean {
  return worldStateId === 0 || (worldState(worldStateId) ?? 0) !== 0;
}

/** Whether a point past the map gets an arrow: inside 0.8 of the radius it is on the map, or nothing. */
export function minimapPastRim(player: WorldPoint, point: WorldPoint, radiusYards: number): boolean {
  return Math.hypot(point.x - player.x, point.y - player.y) > radiusYards * MINIMAP_RIM_FRACTION;
}

export function minimapPoiHasArrow(player: WorldPoint, poi: WorldPoint, radiusYards: number): boolean {
  return minimapPastRim(player, poi, radiusYards) && Math.hypot(poi.x - player.x, poi.y - player.y) <= POI_ARROW_YARDS;
}

/** Radians clockwise from up, the way the arrow's picture points. `facing`: the heading when the map turns with the player. */
export function minimapRimAngle(player: WorldPoint, point: WorldPoint, facing?: number): number {
  const direction = minimapBlip(player, point, 1, facing);
  return Math.atan2(direction.column, -direction.row);
}
