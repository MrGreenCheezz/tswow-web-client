/**
 * The right-click menu on a group member.
 *
 * Everything it does has been sendable for a while — promote, kick, mark, assign a role — and none
 * of it was reachable: a unit frame had a click that selected the unit and nothing else, and a
 * right-click gave the browser's own context menu. Eight of the actions here needed an outbound
 * builder written for this slice as well; the rest were senders with no caller.
 */

import { RAID_TARGET_ICON_COUNT, GROUP_ASSIGN_MAINASSIST, GROUP_ASSIGN_MAINTANK, raidTargetName } from "../../world/PartyProtocol.js";
import {
  LOOT_METHOD_FREE_FOR_ALL, LOOT_METHOD_GROUP, LOOT_METHOD_MASTER, LOOT_METHOD_NEED_BEFORE_GREED,
  LOOT_METHOD_ROUND_ROBIN, MEMBER_FLAG_ASSISTANT, MEMBER_FLAG_MAINASSIST, MEMBER_FLAG_MAINTANK,
  lootMethodName, lootThresholdName,
} from "../../world/GroupProtocol.js";
import { game } from "../game/Context.js";
import { systemLine } from "./Chat.js";
import { groupMenuItems, memberOf, subGroupOptions } from "./GroupModel.js";
import { startReadyCheck } from "./ReadyCheck.js";
import { confirmPanel, showMenu, type MenuItem } from "./Widgets.js";

const LOOT_METHODS = [
  LOOT_METHOD_FREE_FOR_ALL, LOOT_METHOD_ROUND_ROBIN, LOOT_METHOD_MASTER, LOOT_METHOD_GROUP,
  LOOT_METHOD_NEED_BEFORE_GREED,
];

/** The qualities the threshold can be set to. Below uncommon nothing is ever rolled for. */
const LOOT_THRESHOLDS = [2, 3, 4, 5];

export function openGroupMenu(guid: bigint, anchor: HTMLElement): void {
  const world = game.world;
  if (!world) return;
  const group = world.group;
  const selfGuid = world.state.selfGuid;
  const name = world.displayName(guid);
  const member = memberOf(group, guid);

  const items: MenuItem[] = groupMenuItems({ group, selfGuid, targetGuid: guid, targetName: name })
    .map((entry) => {
      const item: MenuItem = { label: entry.label, enabled: entry.enabled, danger: entry.danger };
      switch (entry.id) {
        case "whisper":
          item.run = () => systemLine(`Использование: /w ${name} текст`);
          break;
        case "invite-target":
          item.run = () => world.addFriend(name);
          break;
        case "mark":
          item.submenu = markSubmenu(guid);
          break;
        case "assistant":
          item.run = () => world.setPartyAssistant(guid, ((member?.flags ?? 0) & MEMBER_FLAG_ASSISTANT) === 0);
          break;
        case "maintank":
          item.run = () => world.assignPartyRole(
            GROUP_ASSIGN_MAINTANK, ((member?.flags ?? 0) & MEMBER_FLAG_MAINTANK) === 0, guid);
          break;
        case "mainassist":
          item.run = () => world.assignPartyRole(
            GROUP_ASSIGN_MAINASSIST, ((member?.flags ?? 0) & MEMBER_FLAG_MAINASSIST) === 0, guid);
          break;
        case "subgroup":
          item.submenu = subGroupOptions().map((subGroup) => ({
            label: `Подгруппа ${subGroup + 1}`,
            enabled: member?.subGroup !== subGroup,
            run: () => world.changeSubGroup(name, subGroup),
          }));
          break;
        case "convert":
          item.run = () => world.convertToRaid();
          break;
        case "leader":
          item.run = () => confirmPanel(anchor, {
            title: `Сделать ${name} лидером группы?`,
            lines: ["Вы потеряете право приглашать и исключать."],
            confirm: "Передать",
            onConfirm: () => world.setGroupLeader(guid),
          });
          break;
        case "loot":
          item.submenu = lootSubmenu(guid, name);
          break;
        case "readycheck":
          item.run = () => startReadyCheck();
          break;
        case "kick":
          item.run = () => confirmPanel(anchor, {
            title: `Исключить ${name} из группы?`,
            confirm: "Исключить",
            danger: true,
            onConfirm: () => world.removeFromGroup(guid),
          });
          break;
        default:
          break;
      }
      return item;
    });

  showMenu(anchor, name, items);
}

function markSubmenu(guid: bigint): MenuItem[] {
  const world = game.world;
  const items: MenuItem[] = [];
  for (let icon = 0; icon < RAID_TARGET_ICON_COUNT; icon++) {
    items.push({ label: raidTargetName(icon), run: () => world?.setRaidTarget(icon, guid) });
  }
  // A zero guid on any icon clears it, which is how the original client erases a mark.
  items.push({ label: "Убрать метку", run: () => world?.setRaidTarget(0, 0n) });
  return items;
}

/**
 * Loot rules, which cannot be changed one at a time.
 *
 * The server reads the method, the master looter and the threshold out of one packet, so every
 * entry here re-sends all three with one of them changed.
 */
function lootSubmenu(guid: bigint, name: string): MenuItem[] {
  const world = game.world;
  const group = world?.group;
  if (!world || !group) return [];
  const items: MenuItem[] = LOOT_METHODS.map((method) => ({
    label: lootMethodName(method),
    enabled: group.lootMethod !== method,
    run: () => world.setLootMethod(
      method,
      method === LOOT_METHOD_MASTER ? guid : group.masterLooterGuid,
      group.lootThreshold),
  }));
  items.push({
    label: `Ответственный: ${name}`,
    enabled: group.lootMethod === LOOT_METHOD_MASTER && group.masterLooterGuid !== guid,
    run: () => world.setLootMethod(LOOT_METHOD_MASTER, guid, group.lootThreshold),
  });
  items.push({
    label: "Порог качества",
    submenu: LOOT_THRESHOLDS.map((threshold) => ({
      label: lootThresholdName(threshold),
      enabled: group.lootThreshold !== threshold,
      run: () => world.setLootMethod(group.lootMethod, group.masterLooterGuid, threshold),
    })),
  });
  return items;
}
