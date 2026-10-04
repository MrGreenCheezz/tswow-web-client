/**
 * L17 3.14: the battlefield half of the stock map's source — what WorldMapFrame and the load-on-demand
 * Blizzard_BattlefieldMinimap read in a battleground, as Wow.exe 12340 keeps it (read-only Ghidra,
 * .runtime/re-2026-10-04/l17/g1.c-g6.c):
 *
 * * **The battlefield map** (0x00bea564) is the map of the SMSG_BATTLEFIELD_STATUS slot in progress
 *   (0x0054ae40, status 3). `GetBattlefieldMapIconScale` (0x0054c740) is that map's Map.dbc
 *   MinimapIconScale (record +0x28), 1.0 without one; Arathi Basin's is 1.25 on this dataset, every
 *   other battleground's and arena's 1. The gateway's map rows do not carry the column yet
 *   (`/dbc/areas`, gateway/AreaMetadata.ts `MapInfo`), so until a row has `minimapIconScale` this
 *   answers nothing and the map answers 1.0.
 * * **Team positions** (0x00bea180, `GetNumBattlefieldPositions`/`GetBattlefieldPosition`, 0x0054a040/
 *   0x0054c2e0) are the player part of MSG_BATTLEGROUND_PLAYER_POSITIONS (0x0054b3f0). TrinityCore
 *   always writes none (BattleGroundHandler.cpp:291), and WorldClient keeps both parts in one
 *   `flagCarriers` list, so the list is empty here and every carrier is a flag.
 * * **Flags** (0x00bea170, two slots): the carriers of that packet, read into the slots from the last
 *   down (0x0054b3f0: one carrier is slot 0; two put the packet's first — TrinityCore's Alliance carrier
 *   — in slot 1). `GetNumBattlefieldFlagPositions` (0x0054a0e0) is 2 with slot 1 taken, 1 with slot 0,
 *   else 0. `GetBattlefieldFlagPosition` (0x0054dcc0): a carrier in view at its live position, otherwise
 *   the packet's, projected onto the battlefield map (0x00544140; outside it (0, 0)); the token
 *   (0x0054d010) is the flag the carrier's side carries — the side by race (0x006d6e90, Horde 0,
 *   Alliance 1) or, out of view, the player's own when the carrier is in the player's raid (0x00549670)
 *   and the other one otherwise; `AllianceFlag`/`HordeFlag` (0x00acd310) by side, inverted on Eye of the
 *   Storm (map 566), where the one flag shows its carrier's colour.
 * * **Vehicles** (0x00be9f70, 40 at most): a unit whose Vehicle.dbc row has flag 0x10000000 is listed
 *   when it is created (0x007237f0, 0x0073fcc0 → 0x0054aba0) and dropped when it goes (0x00734fd0); the
 *   list is cleared with the world (0x00528c30 → 0x0054e330). Here: the units in view with such a vehicle
 *   kit, in the world's creation order — the same set, rebuilt when the world's state changes.
 *   `GetBattlefieldVehicleInfo` (0x0054c4d0, FrameXmlMap.ts) reads name, UNIT_FLAG_POSSESSED, the
 *   UiLocomotionType word ("Drive", "Fly", "Idle", "Airship Horde", "Airship Alliance", 0x00ad6b14),
 *   facing, whether the player rides it and whether it is alive.
 * * **Party and raid pins** (`GetPlayerMapPosition("raidN")`, 0x005444f0): a member in view at its own
 *   position; out of view the member-stats position (signed 16-bit words) on its zone's map, unless the
 *   member's status has 0x20.
 *
 * No allocation per call: the flag and vehicle answers are pooled and rebuilt only when their inputs
 * change.
 */
import type { AreaData, MapAreaInfo } from "../../gateway/AreaMetadata.js";
import { readField, unit as unitField } from "../../world/Fields.js";
import { GROUPTYPE_RAID } from "../../world/GroupProtocol.js";
import { STATUS_IN_PROGRESS } from "../../world/PvpProtocol.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import { unitVehicleGuid } from "../../world/VehicleSeatModel.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { hasMapBounds, worldMapPoint } from "../MinimapGeometry.js";
import type { FrameXmlBattlefieldVehicle, FrameXmlMapSource } from "./FrameXmlMap.js";
import { frameXmlRaceSide } from "./FrameXmlScoreboard.js";

/** Eye of the Storm (0x236): one neutral flag, shown in its carrier's colour. */
const EYE_OF_THE_STORM = 566;
const FLAG_TOKENS: readonly string[] = Object.freeze(["AllianceFlag", "HordeFlag"]);
/** The Vehicle.dbc flag that puts a vehicle on the battlefield maps (0x007237f0). */
export const FRAMEXML_BATTLEFIELD_VEHICLE_FLAG = 0x1000_0000;
export const FRAMEXML_BATTLEFIELD_VEHICLE_MAX = 40;
const VEHICLE_TYPES: readonly string[] = Object.freeze(["Drive", "Fly", "Idle", "Airship Horde", "Airship Alliance"]);
/** UNIT_FLAG_POSSESSED, bit 0 of UNIT_FIELD_FLAGS' byte 3. */
const UNIT_FLAG_POSSESSED = 0x0100_0000;
/** The member status bit 0x005444f0 skips a member for. */
const MEMBER_STATUS_UNPLACED = 0x20;
const FLAG_SLOTS = 2;
const NO_POSITIONS: readonly never[] = Object.freeze([]);

interface Carrier { readonly guid: bigint; readonly x: number; readonly y: number }

/** The part of WorldClient this reads. */
export interface FrameXmlBattlefieldMapWorld {
  readonly mapId?: number | undefined;
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
    readonly revision?: number | undefined;
  };
  readonly battlefieldQueues: ReadonlyMap<number, { readonly status: number; readonly mapId: number; readonly cleared?: boolean }>;
  readonly flagCarriers?: readonly Carrier[] | undefined;
  readonly names: { get(guid: bigint): string | undefined };
  readonly creatureTemplates?: { get(entry: number): { readonly found?: boolean; readonly name?: string } | undefined } | undefined;
  readonly group?: { readonly groupType: number; readonly members: readonly { readonly guid: bigint }[] } | undefined;
  readonly partyStats?: ReadonlyMap<bigint, {
    readonly status?: number; readonly zoneId?: number; readonly positionX?: number; readonly positionY?: number;
  }> | undefined;
}

export interface FrameXmlBattlefieldMapSourceOptions {
  readonly world: () => FrameXmlBattlefieldMapWorld | undefined;
  readonly metadata: () => Readonly<AreaData> | undefined;
  readonly vehicles: () => VehicleCatalog | undefined;
  /** A unit token's GUID (LiveWorldSeam's resolution), for the party and raid pins. */
  readonly unitGuid?: (unit: string) => bigint | undefined;
}

type FlagPin = { x: number; y: number; texture: string | undefined };
type VehiclePin = {
  location: { mapId: number; areaId: number; x: number; y: number; orientation: number };
  name: string | undefined; possessed: boolean; type: string | undefined; isPlayer: boolean; alive: boolean;
};

/** The running battlefield's map id (0x00bea564), or undefined outside one. */
export function frameXmlBattlefieldMapId(world: FrameXmlBattlefieldMapWorld | undefined): number | undefined {
  if (!world) return undefined;
  for (const queued of world.battlefieldQueues.values()) {
    if (queued.status === STATUS_IN_PROGRESS && queued.cleared !== true) return queued.mapId;
  }
  return undefined;
}

/** The battlefield map's WorldMapArea (one per battleground map on this dataset), else its area-0 row. */
function battlefieldArea(data: Readonly<AreaData> | undefined, mapId: number): MapAreaInfo | undefined {
  let fallback: MapAreaInfo | undefined;
  for (const area of data?.mapAreas ?? NO_POSITIONS) {
    if (area.mapId !== mapId || !hasMapBounds(area)) continue;
    if (area.areaId !== 0) return area;
    fallback ??= area;
  }
  return fallback;
}

const guidValues = new Map<string, bigint>();

/**
 * The seam's `UnitGUID` text ("0x" and sixteen hex digits) as a number; remembered, so the per-frame
 * raid pins parse each member once.
 */
export function frameXmlGuidValue(text: string | undefined): bigint | undefined {
  if (!text) return undefined;
  const known = guidValues.get(text);
  if (known !== undefined) return known;
  if (!/^0x[0-9A-Fa-f]{1,16}$/.test(text)) return undefined;
  if (guidValues.size >= 256) guidValues.clear();
  const value = BigInt(text);
  guidValues.set(text, value);
  return value;
}

function signedShort(value: number): number {
  return (value << 16) >> 16;
}

/** The battlefield fields of a FrameXmlMapSource, plus the party/raid pins. */
export function frameXmlBattlefieldMapSource(
  options: FrameXmlBattlefieldMapSourceOptions,
): Required<Pick<FrameXmlMapSource, "battlefieldPositions" | "battlefieldFlagPositions" | "battlefieldVehicleCount"
  | "battlefieldVehicles" | "battlefieldMapIconScale" | "positionOfUnit">> {
  const flagPool: FlagPin[] = [];
  const flags: FlagPin[] = [];
  const vehiclePool: VehiclePin[] = [];
  const vehicles: VehiclePin[] = [];
  let vehiclesWorld: FrameXmlBattlefieldMapWorld | undefined;
  let vehiclesRevision = Number.NaN;
  let vehiclesCatalog: VehicleCatalog | undefined;
  let areaCache: { data: Readonly<AreaData> | undefined; mapId: number; area: MapAreaInfo | undefined } | undefined;
  let scaleCache: { data: Readonly<AreaData> | undefined; mapId: number; scale: number | undefined } | undefined;
  /** One answer object for positionOfUnit: the map reads it at once (per-frame raid pins). */
  const memberLocation = { mapId: 0, areaId: 0, x: 0, y: 0 };
  const place = (mapId: number, areaId: number, x: number, y: number): typeof memberLocation => {
    memberLocation.mapId = mapId;
    memberLocation.areaId = areaId;
    memberLocation.x = x;
    memberLocation.y = y;
    return memberLocation;
  };

  const areaOf = (mapId: number): MapAreaInfo | undefined => {
    const data = options.metadata();
    if (!areaCache || areaCache.data !== data || areaCache.mapId !== mapId) {
      areaCache = { data, mapId, area: battlefieldArea(data, mapId) };
    }
    return areaCache.area;
  };

  /** 0x00544140 without clamping: a point outside the battlefield map is (0, 0). */
  const project = (pin: FlagPin, area: MapAreaInfo | undefined, x: number, y: number): boolean => {
    pin.x = 0;
    pin.y = 0;
    if (!area || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const point = worldMapPoint(area, x, y);
    if (!(point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1)) return false;
    pin.x = point.u;
    pin.y = point.v;
    return pin.x !== 0 || pin.y !== 0;
  };

  const inRaid = (world: FrameXmlBattlefieldMapWorld, guid: bigint): boolean => {
    const group = world.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) === 0) return false;
    for (const member of group.members) if (member.guid === guid) return true;
    return false;
  };

  const sideOf = (object: WorldObjectState | undefined): number => frameXmlRaceSide(object ? unitField.race(object) : undefined);

  return {
    battlefieldPositions: () => (options.world() ? NO_POSITIONS : undefined),

    battlefieldFlagPositions: () => {
      const world = options.world();
      if (!world) return undefined;
      const carriers = world.flagCarriers ?? NO_POSITIONS;
      const count = Math.min(carriers.length, FLAG_SLOTS);
      flags.length = 0;
      const mapId = frameXmlBattlefieldMapId(world);
      const area = mapId === undefined ? undefined : areaOf(mapId);
      const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
      for (let slot = 0; slot < count; slot += 1) {
        const carrier = carriers[count - 1 - slot]!;
        const pin = flagPool[slot] ??= { x: 0, y: 0, texture: undefined };
        const object = world.state.objects.get(carrier.guid);
        const position = object?.position;
        if (!position || !project(pin, area, position.x, position.y)) project(pin, area, carrier.x, carrier.y);
        let side: number;
        if (object) side = sideOf(object);
        else {
          const own = sideOf(self);
          side = inRaid(world, carrier.guid) ? own : own === 0 ? 1 : 0;
        }
        pin.texture = side < 0 ? (mapId === EYE_OF_THE_STORM ? FLAG_TOKENS[1] : undefined)
          : FLAG_TOKENS[mapId === EYE_OF_THE_STORM ? (side === 0 ? 1 : 0) : side];
        flags.push(pin);
      }
      return flags;
    },

    battlefieldVehicleCount: () => (options.world() ? listVehicles()?.length : undefined),

    battlefieldVehicles: () => listVehicles(),

    battlefieldMapIconScale: () => {
      const data = options.metadata();
      const mapId = frameXmlBattlefieldMapId(options.world());
      if (mapId === undefined) return undefined;
      if (!scaleCache || scaleCache.data !== data || scaleCache.mapId !== mapId) {
        const row = data?.maps.find((entry) => entry.id === mapId) as { readonly minimapIconScale?: unknown } | undefined;
        const scale = row?.minimapIconScale;
        scaleCache = { data, mapId, scale: typeof scale === "number" && Number.isFinite(scale) ? scale : undefined };
      }
      return scaleCache.scale;
    },

    positionOfUnit: (unit) => {
      const world = options.world();
      const guid = options.unitGuid?.(unit);
      if (!world || guid === undefined || guid === 0n) return undefined;
      const object = world.state.objects.get(guid);
      if (object?.position) {
        return world.mapId === undefined ? undefined : place(world.mapId, 0, object.position.x, object.position.y);
      }
      const stats = world.partyStats?.get(guid);
      if (!stats || ((stats.status ?? 0) & MEMBER_STATUS_UNPLACED) !== 0) return undefined;
      if (stats.zoneId === undefined || stats.positionX === undefined || stats.positionY === undefined) return undefined;
      const zone = options.metadata()?.areas.find((area) => area.id === stats.zoneId);
      if (!zone) return undefined;
      return place(zone.mapId, stats.zoneId, signedShort(stats.positionX), signedShort(stats.positionY));
    },
  };

  function listVehicles(): readonly FrameXmlBattlefieldVehicle[] | undefined {
    const world = options.world();
    if (!world) return undefined;
    const catalog = options.vehicles();
    const revision = world.state.revision ?? Number.NaN;
    if (world === vehiclesWorld && catalog === vehiclesCatalog && revision === vehiclesRevision) return vehicles;
    vehiclesWorld = world;
    vehiclesCatalog = catalog;
    vehiclesRevision = revision;
    vehicles.length = 0;
    if (!catalog || world.mapId === undefined) return vehicles;
    const objects = world.state.objects;
    const ridden = world.state.selfGuid === undefined ? undefined : unitVehicleGuid(objects, world.state.selfGuid);
    for (const object of objects.values()) {
      if (vehicles.length >= FRAMEXML_BATTLEFIELD_VEHICLE_MAX) break;
      if ((object.typeId !== 3 && object.typeId !== 4) || !object.vehicleId || !object.position) continue;
      const row = catalog.vehicle(object.vehicleId);
      if (!row || (row.flags & FRAMEXML_BATTLEFIELD_VEHICLE_FLAG) === 0) continue;
      const pin = vehiclePool[vehicles.length] ??= {
        location: { mapId: 0, areaId: 0, x: 0, y: 0, orientation: 0 },
        name: undefined, possessed: false, type: undefined, isPlayer: false, alive: true,
      };
      pin.location.mapId = world.mapId;
      pin.location.x = object.position.x;
      pin.location.y = object.position.y;
      pin.location.orientation = object.position.orientation;
      pin.name = world.names.get(object.guid) ?? creatureName(world, object);
      pin.possessed = ((readField(object, "UNIT_FIELD_FLAGS") ?? 0) & UNIT_FLAG_POSSESSED) !== 0;
      pin.type = VEHICLE_TYPES[row.uiLocomotionType];
      pin.isPlayer = ridden === object.guid;
      pin.alive = !isWorldObjectDead(object);
      vehicles.push(pin);
    }
    return vehicles;
  }
}

function creatureName(world: FrameXmlBattlefieldMapWorld, object: WorldObjectState): string | undefined {
  const entry = readField(object, "OBJECT_FIELD_ENTRY");
  const creature = entry === undefined ? undefined : world.creatureTemplates?.get(entry);
  return creature?.found && creature.name ? creature.name : undefined;
}

