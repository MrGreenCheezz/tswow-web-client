import { formatGlobalStringByName } from "./GlobalStringFormat.js";
import {
  RAID_INSTANCE_EXPIRED, RAID_INSTANCE_WARNING_HOURS, RAID_INSTANCE_WARNING_MIN, RAID_INSTANCE_WARNING_MIN_SOON,
  RAID_INSTANCE_WELCOME,
} from "./InstanceProtocol.js";

/**
 * 1.32: the world layer's own messages, with names where they used to print ids.
 *
 * Every function takes the name already looked up (`WorldClient.#nameOf` and friends, М-A4-4) or
 * undefined when nobody has it yet, and never writes the number: without a name the sentence is
 * reworded around the thing («Задание отклонено», «Зона атакована!»). Where GlobalStrings.lua has
 * the sentence it is taken by name (`formatGlobalStringByName`); the fallback beside it is this
 * client's own wording, used when the generated table does not carry that key (a clean checkout;
 * the generator takes the `ERR_` family and, by name in its `EXTRA_STRINGS`, the `RAID_INSTANCE_*`
 * and `INSTANCE_RESET_*` sentences and `SecondsToTime`'s unit words).
 */

/** «"Name"» for a known name, nothing for an unknown one — the shape every text below splices in. */
function quoted(name: string | undefined): string {
  return name === undefined ? "" : ` «${name}»`;
}

/**
 * `QuestFailedReason`, QuestDef.h:52-67, as `SMSG_QUESTGIVER_QUEST_INVALID` carries it
 * (Player::SendCanTakeQuestResponse, Player.cpp:17305-17311): the stock sentence for each code.
 */
const QUEST_INVALID: ReadonlyMap<number, readonly [key: string, fallback: string, args?: readonly number[]]> = new Map([
  [1, ["ERR_QUEST_FAILED_LOW_LEVEL", "Уровень слишком низок для этого задания."]],
  [6, ["ERR_QUEST_FAILED_WRONG_RACE", "Задание недоступно для вашей расы."]],
  [7, ["ERR_QUEST_ALREADY_DONE", "Это задание уже выполнено."]],
  [12, ["ERR_QUEST_ONLY_ONE_TIMED", "Одновременно можно выполнять только одно задание на время."]],
  [13, ["ERR_QUEST_ALREADY_ON", "Это задание уже взято."]],
  [16, ["ERR_QUEST_FAILED_EXPANSION", "Задание требует дополнения."]],
  [18, ["ERR_QUEST_ALREADY_ON", "Это задание уже взято."]],
  [21, ["ERR_QUEST_FAILED_MISSING_ITEMS", "Нет нужных предметов."]],
  [23, ["ERR_QUEST_FAILED_NOT_ENOUGH_MONEY", "Недостаточно денег для этого задания."]],
  // INVALIDREASON_DAILY_QUESTS_REMAINING: the core's own description names the limit, 25.
  [26, ["ERR_QUEST_FAILED_TOO_MANY_DAILY_QUESTS_I", "Сегодня выполнено предельное число ежедневных заданий: %d.", [25]]],
  [27, ["ERR_QUEST_FAILED_CAIS", "Усталость не позволяет завершать задания."]],
  [29, ["ERR_QUEST_ALREADY_DONE_DAILY", "Это ежедневное задание сегодня уже выполнено."]],
]);

/** `SMSG_QUESTGIVER_QUEST_INVALID`; 0 (INVALIDREASON_DONT_HAVE_REQ) and any unknown code say only that. */
export function questInvalidText(reason: number): string {
  const entry = QUEST_INVALID.get(reason);
  return entry ? formatGlobalStringByName(entry[0], entry[2] ?? [], entry[1]) : "Задание недоступно.";
}

/** `SMSG_QUESTLOG_FULL`. */
export function questLogFullText(): string {
  return formatGlobalStringByName("ERR_QUEST_LOG_FULL", [], "Журнал заданий заполнен.");
}

/** `SMSG_QUESTGIVER_QUEST_FAILED`: the quest's title when known, and why (`InventoryResult` words). */
export function questFailedText(title: string | undefined, detail: string): string {
  return `Задание${quoted(title)}: ${detail}`;
}

/** `SMSG_QUESTGIVER_QUEST_COMPLETE`, before the reward tail. */
export function questCompleteText(title: string | undefined): string {
  return `Задание${quoted(title)} выполнено`;
}

/**
 * `SMSG_ZONE_UNDER_ATTACK`: the area's name (AreaTable).
 *
 * Deliberately this client's own sentence, not the stock `ZONE_UNDER_ATTACK`
 * («|cffffff00|3-8(%s) нападению!|r»): its case 8 turns «Штормград» into «Штормград подвергается»
 * only through the client's DeclinedWord.dbc dictionary (`FrameXmlDeclension.ts`, a browser
 * module), and the world layer's formatter keeps the word as written — «Штормград нападению!».
 */
export function zoneUnderAttackText(area: string | undefined): string {
  return area === undefined ? "Зона атакована!" : `Зона «${area}» атакована!`;
}

const minutes = (seconds: number) => Math.round(seconds / 60);

/**
 * UIParent.lua `SecondsToTime(seconds, nil, 1)`, which RAID_INSTANCE_WELCOME is filled with: whole
 * days and hours whenever present, then minutes and seconds while fewer than two units are written,
 * in the unabbreviated `D_*` words joined by `TIME_UNIT_DELIMITER`.
 */
export function secondsToTimeText(total: number): string {
  let seconds = Math.max(0, Math.floor(total));
  const parts: string[] = [];
  const unit = (key: string, fallback: string, value: number) => parts.push(formatGlobalStringByName(key, [value], fallback));
  if (seconds >= 86400) {
    unit("D_DAYS", "%d д.", Math.floor(seconds / 86400));
    seconds %= 86400;
  }
  if (seconds >= 3600) {
    unit("D_HOURS", "%d ч.", Math.floor(seconds / 3600));
    seconds %= 3600;
  }
  if (parts.length < 2 && seconds >= 60) {
    unit("D_MINUTES", "%d мин.", Math.floor(seconds / 60));
    seconds %= 60;
  }
  if (parts.length < 2 && seconds > 0) unit("D_SECONDS", "%d с", seconds);
  return parts.join(formatGlobalStringByName("TIME_UNIT_DELIMITER", [], " "));
}

/**
 * `SMSG_RAID_INSTANCE_MESSAGE` by `InstanceResetWarningType` (Player.h:656-663): hours, minutes,
 * minutes-soon, welcome and expired, each with the map's name (Map.dbc).
 */
export function raidInstanceText(type: number, map: string | undefined, secondsLeft: number): string {
  const name = map ?? "подземелье";
  switch (type) {
    case RAID_INSTANCE_WARNING_HOURS:
      return formatGlobalStringByName("RAID_INSTANCE_WARNING_HOURS", [name, Math.round(secondsLeft / 3600)],
        "Сброс «%s» через %d ч.");
    case RAID_INSTANCE_WARNING_MIN:
      return formatGlobalStringByName("RAID_INSTANCE_WARNING_MIN", [name, minutes(secondsLeft)], "Сброс «%s» через %d мин!");
    case RAID_INSTANCE_WARNING_MIN_SOON:
      return formatGlobalStringByName("RAID_INSTANCE_WARNING_MIN_SOON", [name, minutes(secondsLeft)], "Сброс «%s» через %d мин.");
    case RAID_INSTANCE_WELCOME:
      return formatGlobalStringByName("RAID_INSTANCE_WELCOME", [name, secondsToTimeText(secondsLeft)], "«%s»: сброс через %s");
    case RAID_INSTANCE_EXPIRED:
      return formatGlobalStringByName("RAID_INSTANCE_EXPIRED", [name], "Сохранение «%s» истекло.");
    default:
      return `«${name}»: сброс через ${minutes(secondsLeft)} мин`;
  }
}

/** `SMSG_INSTANCE_RESET`. */
export function instanceResetText(map: string | undefined): string {
  return formatGlobalStringByName("INSTANCE_RESET_SUCCESS", [map ?? "подземелье"], "Подземелье «%s» сброшено.");
}

/**
 * `SMSG_INSTANCE_RESET_FAILED`, `u32 reason, u32 map`: Player::SendResetInstanceFailed
 * (Player.cpp:20975-20985) — 0 players inside, 1 a party member offline, 2 and up one zoning in.
 */
export function instanceResetFailedText(reason: number, map: string | undefined): string {
  const name = map ?? "подземелье";
  if (reason === 0) return formatGlobalStringByName("INSTANCE_RESET_FAILED", [name], "Не удалось сбросить «%s»: внутри есть игроки.");
  if (reason === 1) return formatGlobalStringByName("INSTANCE_RESET_FAILED_OFFLINE", [name], "Не удалось сбросить «%s»: кто-то из группы не в сети.");
  return formatGlobalStringByName("INSTANCE_RESET_FAILED_ZONING", [name], "Не удалось сбросить «%s»: кто-то из группы входит в подземелье.");
}

/** `SMSG_ITEM_PUSH_RESULT` for this player. */
export function itemPushText(item: string | undefined, count: number): string {
  return `Получено: ${item ?? "предмет"} ×${count}`;
}

/** `SMSG_TRAINER_BUY_SUCCEEDED`. */
export function learnedSpellText(spell: string | undefined): string {
  return spell === undefined
    ? "Изучено новое заклинание."
    : formatGlobalStringByName("ERR_LEARN_SPELL_S", [spell], "Изучено заклинание «%s».");
}

/** The subject of a cast-status line: «Заклинание «Огненный шар»», or just «Заклинание». */
export function spellSubject(spell: string | undefined): string {
  return `Заклинание${quoted(spell)}`;
}

/**
 * `SMSG_GUILD_EVENT` by `GuildEvents` (Guild.h:153-175) with the strings the core broadcasts
 * (Guild.cpp `_BroadcastEvent` calls): promotion/demotion `actor, member, rank` (:1643), removal
 * `removed, remover` (:1587), leader change `old, new` (:1382, :2302), join/leave/sign on/off
 * `name`. MOTD (2) is left to the caller. Anything else is an event with no sentence of its own.
 */
export function guildEventText(type: number, params: readonly string[]): string {
  const [first = "", second = "", third = ""] = params;
  switch (type) {
    case 0: return formatGlobalStringByName("ERR_GUILD_PROMOTE_SSS", [first, second, third], "%s повышает %s до звания «%s».");
    case 1: return formatGlobalStringByName("ERR_GUILD_DEMOTE_SSS", [first, second, third], "%s понижает %s до звания «%s».");
    case 3: return formatGlobalStringByName("ERR_GUILD_JOIN_S", [first], "%s вступает в гильдию.");
    case 4: return formatGlobalStringByName("ERR_GUILD_LEAVE_S", [first], "%s выходит из гильдии.");
    case 5: return formatGlobalStringByName("ERR_GUILD_REMOVE_SS", [first, second], "%2$s исключает %1$s из гильдии.");
    case 6: return formatGlobalStringByName("ERR_GUILD_LEADER_IS_S", [first], "Глава гильдии: %s.");
    case 7: return formatGlobalStringByName("ERR_GUILD_LEADER_CHANGED_SS", [first, second], "%s передаёт главенство %s.");
    case 8: return formatGlobalStringByName("ERR_GUILD_DISBANDED", [], "Гильдия распущена.");
    case 12: return first ? `Гильдия: ${first} входит в игру.` : "Событие гильдии";
    case 13: return first ? `Гильдия: ${first} выходит из игры.` : "Событие гильдии";
    default: return "Событие гильдии";
  }
}
