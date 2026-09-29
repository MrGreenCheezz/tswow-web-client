import {
  GROUPTYPE_RAID,
  LOOT_METHOD_FREE_FOR_ALL, LOOT_METHOD_ROUND_ROBIN, LOOT_METHOD_MASTER,
  LOOT_METHOD_GROUP, LOOT_METHOD_NEED_BEFORE_GREED,
  type GroupState,
} from "../../world/GroupProtocol.js";

/** Tokens used by the original UnitPopup.lua UnitLootMethod table. */
export const FRAMEXML_LOOT_METHODS: Readonly<Record<number, string>> = Object.freeze({
  [LOOT_METHOD_FREE_FOR_ALL]: "freeforall",
  [LOOT_METHOD_ROUND_ROBIN]: "roundrobin",
  [LOOT_METHOD_MASTER]: "master",
  [LOOT_METHOD_GROUP]: "group",
  [LOOT_METHOD_NEED_BEFORE_GREED]: "needbeforegreed",
});

export type FrameXmlLootMethod = readonly [
  method: string, partyMaster: number | undefined, raidMaster: number | undefined,
];

export function frameXmlLootMethod(
  group: GroupState | undefined, selfGuid: bigint | undefined,
): FrameXmlLootMethod | undefined {
  // With no party, every corpse belongs to its own looter and no master index exists.
  if (!group) return ["freeforall", undefined, undefined];
  const method = FRAMEXML_LOOT_METHODS[group.lootMethod];
  if (method === undefined) return undefined;
  if (group.lootMethod !== LOOT_METHOD_MASTER) return [method, undefined, undefined];
  // The current seam exposes party1..party4 in wire order. A raid roster alias/order is not yet
  // implemented; never mislabel a group-list offset (which excludes self) as a raid unit index.
  if ((group.groupType & GROUPTYPE_RAID) !== 0) return [method, undefined, undefined];
  if (selfGuid !== undefined && group.masterLooterGuid === selfGuid) return [method, 0, undefined];
  const index = group.members.slice(0, 4).findIndex((member) => member.guid === group.masterLooterGuid);
  return [method, index >= 0 ? index + 1 : undefined, undefined];
}
