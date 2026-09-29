import type { QuestList, QuestMenuEntry } from "../../world/NpcProtocol.js";
import type { QuestLogEntryView } from "../../world/QuestProtocol.js";

/** Facts available from other authoritative state, rather than from SMSG_QUESTGIVER_QUEST_LIST. */
export interface FrameXmlQuestMenuFacts {
  /** PLAYER_QUEST_LOG state can distinguish complete from incomplete for a logged quest. */
  readonly activeCompleteByQuestId?: ReadonlyMap<number, boolean>;
  /** Supply only after applying the selected client's trivial-quest rule to the player's level. */
  readonly trivialByQuestId?: ReadonlyMap<number, boolean>;
}

/**
 * `buildQuestLogView` reads its `complete` bit from PLAYER_QUEST_LOG state. Only rows actually
 * present in that authoritative log can answer GetActiveTitle's second return value; a directly
 * completable icon-4 menu row may have no log slot and therefore remains nil.
 *
 * Call this after a complete player update-field snapshot. The quest-list packet alone cannot
 * establish whether an absent log row is incomplete or still waiting for update fields.
 */
export function frameXmlQuestMenuFactsFromQuestLog(
  questLog: readonly Pick<QuestLogEntryView, "questId" | "complete">[],
): FrameXmlQuestMenuFacts {
  return { activeCompleteByQuestId: new Map(questLog.map(({ questId, complete }) => [questId, complete])) };
}

export type FrameXmlQuestMenuValues = readonly (string | number | boolean | undefined)[];
export type FrameXmlQuestMenuBinding = (
  list: QuestList | undefined,
  index?: number,
  facts?: FrameXmlQuestMenuFacts,
) => FrameXmlQuestMenuValues;

const NOTHING: readonly [] = Object.freeze([]);
/** `QUEST_FLAGS_DAILY` in the selected TrinityCore's QuestDef.h. */
const QUEST_FLAGS_DAILY = 0x00001000;

type MenuKind = "active" | "available";

/**
 * PrepareQuestMenu in the selected core emits icon 0/2 for available rows and icon 4 for active
 * or directly completable rows. Keep each group's wire order: stock QuestFrame.lua indexes the
 * two groups separately from 1, then concatenates active buttons before available buttons.
 * Unknown icons close this projection rather than being silently assigned to either group.
 */
function rows(list: QuestList | undefined, kind: MenuKind): QuestMenuEntry[] | undefined {
  if (!list) return undefined;
  const result: QuestMenuEntry[] = [];
  for (const quest of list.quests) {
    if (quest.icon !== 0 && quest.icon !== 2 && quest.icon !== 4) return undefined;
    if ((quest.icon === 4 ? "active" : "available") === kind) result.push(quest);
  }
  return result;
}

function row(list: QuestList | undefined, kind: MenuKind, index: number | undefined): QuestMenuEntry | undefined {
  if (index === undefined || !Number.isSafeInteger(index) || index < 1) return undefined;
  return rows(list, kind)?.[index - 1];
}

function value<T extends string | number | boolean>(item: T | undefined): readonly [] | readonly [T] {
  return item === undefined ? NOTHING : [item];
}

/**
 * Packet-backed answers for the C API calls made by the selected QuestFrame.lua greeting panel.
 * A missing page or invalid 1-based index yields no Lua values. A missing *tuple field* remains
 * undefined in its original position so later known fields are not shifted to the left.
 *
 * Quest-list icon 4 does not distinguish complete from incomplete in the selected core. The list
 * also contains quest level, but not player level or the client's trivial threshold. Those slots
 * stay nil until the caller supplies independently proven facts.
 */
export const FRAMEXML_QUEST_MENU_DATA_BINDINGS = Object.freeze({
  GetGreetingText: (list: QuestList | undefined) => value(list?.greeting),
  GetNumActiveQuests: (list: QuestList | undefined) => value(rows(list, "active")?.length),
  GetNumAvailableQuests: (list: QuestList | undefined) => value(rows(list, "available")?.length),
  GetActiveTitle: (list: QuestList | undefined, index?: number, facts?: FrameXmlQuestMenuFacts) => {
    const quest = row(list, "active", index);
    return quest ? [quest.title, facts?.activeCompleteByQuestId?.get(quest.id)] : NOTHING;
  },
  IsActiveQuestTrivial: (list: QuestList | undefined, index?: number, facts?: FrameXmlQuestMenuFacts) => {
    const quest = row(list, "active", index);
    return value(quest && facts?.trivialByQuestId?.get(quest.id));
  },
  GetAvailableTitle: (list: QuestList | undefined, index?: number) => value(row(list, "available", index)?.title),
  GetAvailableQuestInfo: (list: QuestList | undefined, index?: number, facts?: FrameXmlQuestMenuFacts) => {
    const quest = row(list, "available", index);
    return quest
      ? [facts?.trivialByQuestId?.get(quest.id), (quest.flags & QUEST_FLAGS_DAILY) !== 0, quest.repeatable]
      : NOTHING;
  },
}) satisfies Readonly<Record<
  | "GetGreetingText"
  | "GetNumActiveQuests"
  | "GetNumAvailableQuests"
  | "GetActiveTitle"
  | "IsActiveQuestTrivial"
  | "GetAvailableTitle"
  | "GetAvailableQuestInfo",
  FrameXmlQuestMenuBinding
>>;

/** Resolve a stock SelectActiveQuest/SelectAvailableQuest 1-based index for WorldClient.openQuest. */
export function frameXmlQuestMenuSelection(
  list: QuestList | undefined,
  kind: MenuKind,
  index: number,
): Readonly<{ guid: bigint; questId: number; completion: boolean }> | undefined {
  const quest = row(list, kind, index);
  return quest && list ? { guid: list.guid, questId: quest.id, completion: kind === "active" } : undefined;
}
