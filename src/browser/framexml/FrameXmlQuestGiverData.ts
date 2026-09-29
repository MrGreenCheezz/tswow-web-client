import type { QuestDialog } from "../../world/NpcProtocol.js";

/** A Lua C API returns zero values for no active page, rather than an invented empty string. */
export type FrameXmlQuestGiverDataValues =
  | readonly []
  | readonly [string]
  | readonly [number]
  | readonly [boolean];

type QuestGiverDataBinding = (dialog: QuestDialog | undefined) => FrameXmlQuestGiverDataValues;
const NOTHING: readonly [] = Object.freeze([]);

function value<T extends string | number | boolean>(item: T | undefined): readonly [] | readonly [T] {
  return item === undefined ? NOTHING : [item];
}

/**
 * Stock QuestFrame/QuestInfo getters whose results are present verbatim in the parsed giver
 * packets. LiveWorldSeam registers these C API names through the packet-backed adapter, while
 * the stock QuestFrame root remains hidden until its complete UI/command gate is ready. Nil is
 * retained outside the packet kind where an API has meaning.
 */
export const FRAMEXML_QUEST_GIVER_DATA_BINDINGS: Readonly<Record<
  | "GetTitleText"
  | "GetQuestText"
  | "GetObjectiveText"
  | "GetProgressText"
  | "GetRewardText"
  | "GetSuggestedGroupNum"
  | "GetQuestMoneyToGet"
  | "GetNumQuestItems"
  | "IsQuestCompletable",
  QuestGiverDataBinding
>> = Object.freeze({
  GetTitleText: (dialog) => value(dialog?.title),
  GetQuestText: (dialog) => value(dialog?.kind === "details" ? dialog.details : undefined),
  GetObjectiveText: (dialog) => value(dialog?.kind === "details" ? dialog.objectives : undefined),
  GetProgressText: (dialog) => value(dialog?.kind === "request-items" ? dialog.text : undefined),
  GetRewardText: (dialog) => value(dialog?.kind === "reward" ? dialog.text : undefined),
  GetSuggestedGroupNum: (dialog) => value(dialog?.suggestedPlayers),
  GetQuestMoneyToGet: (dialog) => value(dialog?.kind === "request-items"
    ? dialog.requiredMoney : dialog?.rewards.requiredMoney),
  GetNumQuestItems: (dialog) => value(dialog?.kind === "request-items"
    ? dialog.items.length : undefined),
  IsQuestCompletable: (dialog) => value(dialog?.kind === "request-items"
    ? dialog.canComplete : undefined),
});
