/**
 * A canned ten-player raid for the Raid tab's grid (FrameXmlRaidLod.ts): framexml.html's
 * `?raidgrid=` preview and the tests put it on `CannedWorldSeam.socialWorld`, as an
 * SMSG_GROUP_LIST would replace `WorldClient.group`.
 *
 * The canned party's four (FrameXmlFriendsCanned.ts `groupList`) and the player fill group 1; five
 * guildmates of «Стражи Элвинна» fill group 2. The flags are the wire's (Group.h): Альфа assists,
 * Бета is the main tank, Хельга the main assist, Аэлинда the master looter; Дельта is offline.
 * The player (0x42) leads, so the grid's leader-only affordances show. Only the raid model reads this
 * group: CannedWorldSeam's own party answers (`IsPartyLeader`, `GetLootMethod`) stay those of its
 * fixed party, and the canned world has no `changeSubGroup`, so a drag snaps back (FrameXmlRaidLodApi.ts).
 */
import type { GroupMember, GroupState } from "../../world/GroupProtocol.js";

/** `GROUPTYPE_RAID`, `MEMBER_FLAG_ASSISTANT`/`_MAINTANK`/`_MAINASSIST` (Group.h). */
const GROUPTYPE_RAID = 0x02;
const ASSISTANT = 0x01;
const MAINTANK = 0x02;
const MAINASSIST = 0x04;
/** `LootMethod.MASTER_LOOT` (Loot.h). */
const MASTER_LOOT = 2;

/** `[guid, name, subgroup (0-based, as on the wire), flags, online]`, in wire order. */
const MEMBERS: readonly (readonly [guid: bigint, name: string, subGroup: number, flags: number, online: boolean])[] = [
  [0x501n, "Альфа", 0, ASSISTANT, true],
  [0x502n, "Бета", 0, MAINTANK, true],
  [0x503n, "Гамма", 0, 0, true],
  [0x504n, "Дельта", 0, 0, false],
  [0x101n, "Аэлинда", 1, 0, true],
  [0x303n, "Хельга", 1, MAINASSIST, true],
  [0x301n, "Ивор", 1, 0, true],
  [0x302n, "Прайм", 1, 0, true],
  [0x30an, "Сая", 1, 0, true],
];

/** The raid's listed members and the player, as `GetNumRaidMembers` counts them. */
export const FRAMEXML_CANNED_RAID_SIZE = MEMBERS.length + 1;

/** Replace the canned social world's group with the ten-player raid. */
export function frameXmlCannedRaid(world: { group: GroupState | undefined; readonly names: Map<bigint, string> }): void {
  world.group = {
    groupType: GROUPTYPE_RAID, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 0x1f0000000000002n,
    counter: (world.group?.counter ?? 0) + 1,
    members: MEMBERS.map(([guid, name, subGroup, flags, online]): GroupMember => {
      world.names.set(guid, name);
      return { name, guid, online, status: online ? 1 : 0, subGroup, flags, roles: 0 };
    }),
    leaderGuid: 0x42n, lootMethod: MASTER_LOOT, masterLooterGuid: 0x101n, lootThreshold: 2,
    dungeonDifficulty: 0, raidDifficulty: 0,
  };
}
