/**
 * Where a party member is, for the map and the minimap, in sight or not (WORK_PLAN 4.06).
 *
 * A member in sight has a world object with an exact position. One out of sight is reported by
 * `SMSG_PARTY_MEMBER_STATS` with GROUP_UPDATE_FLAG_POSITION (0x100, Group.h): two 16-bit numbers
 * written as `uint16(player->GetPositionX())` (GroupHandler.cpp:805-809, 1019-1020) — whole yards,
 * and a negative coordinate arrives as 65536 + x. Every map's coordinates lie within ±17067
 * yards, so the signed reading is the only one that fits. The packet carries the zone and not
 * the map, so the coarse point is drawn only when the zone is on the map the player stands on
 * (the area table's `ContinentID`); otherwise there is no point rather than a wrong one.
 *
 * `Group::UpdatePlayerOutOfRange` sends these exactly for the members the client cannot see, so the
 * coarse value is the one that matters for the dots that were missing.
 */

import { GROUP_UPDATE_STATUS, type PartyMemberStats } from "../../world/PartyProtocol.js";
import { MEMBER_STATUS_ONLINE } from "../../world/GroupProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** A uint16 off the wire as the signed yard it was truncated from. */
export function int16FromWire(raw: number): number {
  const value = raw & 0xffff;
  return value >= 0x8000 ? value - 0x10000 : value;
}

export interface PartyPosition {
  readonly x: number;
  readonly y: number;
  /** False for the whole-yard position the stats packet carries for a member out of sight. */
  readonly precise: boolean;
}

/** The part of the world client this reads. */
export interface PartyPositionWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly mapId?: number | undefined;
  readonly group?: { readonly members: readonly { readonly guid: bigint; readonly online: boolean }[] } | undefined;
  readonly partyStats: ReadonlyMap<bigint, PartyMemberStats>;
}

/** A zone's map (AreaTable `ContinentID`), or undefined while the table is not known. */
export type AreaMapOf = (zoneId: number) => number | undefined;

function online(member: { readonly online: boolean }, stats: PartyMemberStats | undefined): boolean {
  // The roster's bit until a stats packet carried GROUP_UPDATE_STATUS (the seam's rule).
  return stats && (stats.flags & GROUP_UPDATE_STATUS) !== 0 && stats.status !== undefined
    ? (stats.status & MEMBER_STATUS_ONLINE) !== 0
    : member.online;
}

/** The member's position: exact in sight, coarse out of it on the same map, else nothing. */
export function partyMemberPosition(
  world: PartyPositionWorld, guid: bigint, areaMap: AreaMapOf,
): PartyPosition | undefined {
  const position = world.state.objects.get(guid)?.position;
  if (position) return { x: position.x, y: position.y, precise: true };
  const stats = world.partyStats.get(guid);
  if (!stats || stats.positionX === undefined || stats.positionY === undefined || stats.zoneId === undefined) return undefined;
  if (world.mapId === undefined || areaMap(stats.zoneId) !== world.mapId) return undefined;
  return { x: int16FromWire(stats.positionX), y: int16FromWire(stats.positionY), precise: false };
}

export interface PartyBlipMember extends PartyPosition {
  readonly guid: bigint;
}

/** Everyone in the group the map and the minimap draw: not the player, online, with a position. */
export function partyBlipMembers(world: PartyPositionWorld, areaMap: AreaMapOf): PartyBlipMember[] {
  const members = world.group?.members;
  if (!members || members.length === 0) return [];
  const self = world.state.selfGuid;
  const out: PartyBlipMember[] = [];
  for (const member of members) {
    if (member.guid === self) continue;
    // A member in sight is there whatever a stale roster bit says; one out of sight only when online.
    const inSight = world.state.objects.get(member.guid)?.position !== undefined;
    if (!inSight && !online(member, world.partyStats.get(member.guid))) continue;
    const position = partyMemberPosition(world, member.guid, areaMap);
    if (position) out.push({ guid: member.guid, ...position });
  }
  return out;
}
