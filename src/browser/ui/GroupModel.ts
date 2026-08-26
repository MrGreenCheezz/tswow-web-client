/**
 * What a group can do to one of its members, and who is allowed to ask.
 *
 * The rules are all on the server and none of them are announced: a kick that the player is not
 * allowed to make is answered with silence, so a menu that offers everything to everybody teaches
 * the player that half the interface is broken. This works the permissions out the same way the
 * core does — leader, assistant, and the two flags a raid adds — and the view draws whatever comes
 * back.
 *
 * DOM-free on purpose: this is the part with rules in it.
 */

import {
  GROUPTYPE_RAID, MEMBER_FLAG_ASSISTANT, MEMBER_FLAG_MAINASSIST, MEMBER_FLAG_MAINTANK,
  RAID_SUBGROUPS, type GroupMember, type GroupState,
} from "../../world/GroupProtocol.js";

export interface GroupMenuContext {
  group: GroupState | undefined;
  selfGuid: bigint | undefined;
  /** The member the menu was opened on. */
  targetGuid: bigint;
  targetName: string;
}

export interface GroupMenuEntry {
  id: string;
  label: string;
  /** False for a row that is shown greyed because the player is not allowed to use it. */
  enabled: boolean;
  danger?: boolean | undefined;
}

export function isRaid(group: GroupState | undefined): boolean {
  return group !== undefined && (group.groupType & GROUPTYPE_RAID) !== 0;
}

export function isLeader(group: GroupState | undefined, guid: bigint | undefined): boolean {
  return group !== undefined && guid !== undefined && group.leaderGuid === guid;
}

/**
 * Whether this character may boss the group around.
 *
 * The leader always may. In a raid an assistant may too, and the player's own flags are the only
 * place their own assistant bit is recorded — `members` does not contain the receiving player.
 */
export function mayManage(group: GroupState | undefined, selfGuid: bigint | undefined): boolean {
  if (!group) return false;
  if (isLeader(group, selfGuid)) return true;
  return isRaid(group) && (group.ownFlags & MEMBER_FLAG_ASSISTANT) !== 0;
}

/**
 * Whether the loot block was on the wire at all.
 *
 * `SMSG_GROUP_LIST` writes the loot method, the master looter and the threshold only for a group
 * with members; a solo group leaves all three at zero, which reads as "free for all, poor quality"
 * and is not what the server thinks.
 */
export function hasLootRules(group: GroupState | undefined): boolean {
  return group !== undefined && group.members.length > 0;
}

export function memberOf(group: GroupState | undefined, guid: bigint): GroupMember | undefined {
  return group?.members.find((member) => member.guid === guid);
}

/** The rows a right-click on one member offers. */
export function groupMenuItems(context: GroupMenuContext): GroupMenuEntry[] {
  const { group, selfGuid, targetGuid } = context;
  if (!group) return [];
  const manage = mayManage(group, selfGuid);
  const leader = isLeader(group, selfGuid);
  const raid = isRaid(group);
  const member = memberOf(group, targetGuid);
  const isSelf = targetGuid === selfGuid;

  const entries: GroupMenuEntry[] = [
    { id: "whisper", label: "Написать", enabled: !isSelf },
    { id: "invite-target", label: "Пригласить в друзья", enabled: !isSelf },
  ];
  if (raid) {
    entries.push({ id: "mark", label: "Метка", enabled: manage });
    entries.push({
      id: "assistant",
      label: (member?.flags ?? 0) & MEMBER_FLAG_ASSISTANT ? "Снять помощника" : "Сделать помощником",
      enabled: leader && !isSelf,
    });
    entries.push({
      id: "maintank",
      label: (member?.flags ?? 0) & MEMBER_FLAG_MAINTANK ? "Снять основного танка" : "Основной танк",
      enabled: manage,
    });
    entries.push({
      id: "mainassist",
      label: (member?.flags ?? 0) & MEMBER_FLAG_MAINASSIST ? "Снять помощника танка" : "Помощник танка",
      enabled: manage,
    });
    entries.push({ id: "subgroup", label: "Перевести в подгруппу", enabled: manage && member !== undefined });
  } else {
    entries.push({ id: "mark", label: "Метка", enabled: manage });
    entries.push({ id: "convert", label: "Превратить в рейд", enabled: leader && group.members.length >= 1 });
  }
  entries.push({ id: "leader", label: "Сделать лидером", enabled: leader && !isSelf });
  if (hasLootRules(group)) entries.push({ id: "loot", label: "Правила добычи", enabled: leader });
  entries.push({ id: "readycheck", label: "Проверка готовности", enabled: manage });
  entries.push({
    id: "kick", label: "Исключить из группы", enabled: manage && !isSelf, danger: true,
  });
  return entries;
}

/** The subgroups a raid member can be moved into, numbered as the server numbers them. */
export function subGroupOptions(): number[] {
  return Array.from({ length: RAID_SUBGROUPS }, (_, index) => index);
}

/**
 * The player's own row, which `SMSG_GROUP_LIST` leaves out.
 *
 * Everything about it is in the header fields — the subgroup, the flags, the roles — and a
 * management window that lists "the group" without it cannot show the player their own assistant
 * bit or move them between subgroups.
 */
export function selfMember(group: GroupState, selfGuid: bigint, name: string): GroupMember {
  return {
    name,
    guid: selfGuid,
    online: true,
    status: 1,
    subGroup: group.ownSubGroup,
    flags: group.ownFlags,
    roles: group.ownRoles,
  };
}

/** Everyone, the player included, in subgroup order — what a raid management list shows. */
export function allMembers(group: GroupState, selfGuid: bigint | undefined, selfName: string): GroupMember[] {
  const rows = [...group.members];
  if (selfGuid !== undefined && !rows.some((member) => member.guid === selfGuid)) {
    rows.push(selfMember(group, selfGuid, selfName));
  }
  return rows.sort((left, right) => left.subGroup - right.subGroup || left.name.localeCompare(right.name, "ru"));
}
