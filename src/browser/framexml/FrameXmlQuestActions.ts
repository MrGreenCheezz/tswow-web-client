import type {
  QuestDetails,
  QuestDialog,
  QuestList,
  QuestOfferReward,
  QuestRequestItems,
} from "../../world/NpcProtocol.js";

export type FrameXmlQuestActionName =
  | "AcceptQuest"
  | "CompleteQuest"
  | "GetQuestReward"
  | "DeclineQuest"
  | "CloseQuest";

export interface FrameXmlQuestActionPage {
  readonly questList: QuestList | undefined;
  readonly questDialog: QuestDialog | undefined;
}

/** The caller must recheck this page identity before invoking the WorldClient method. */
export type FrameXmlQuestCommand =
  | { readonly method: "acceptQuest"; readonly expectedDialog: QuestDetails }
  | { readonly method: "requestQuestReward"; readonly expectedDialog: QuestRequestItems }
  | { readonly method: "chooseQuestReward"; readonly expectedDialog: QuestOfferReward; readonly choice: number }
  | { readonly method: "closeQuest"; readonly expectedPage: QuestDialog | QuestList };

export type FrameXmlQuestActionResolution =
  | { readonly ok: true; readonly command: FrameXmlQuestCommand }
  | { readonly ok: false; readonly reason:
    "missing-quest-page" | "conflicting-quest-pages" | "wrong-dialog-kind"
    | "quest-not-completable" | "invalid-choice" };

/**
 * Validate stock quest C API calls against the current parsed packet page, without sending one.
 * Lua's QuestInfoFrame.itemChoice is 1-based; the TrinityCore 3.3.5a reward packet is 0-based.
 * With no choice rows, stock Lua passes 0 and the server still expects choice slot 0.
 *
 * The stock QuestFrame button shows CONFIRM_COMPLETE_EXPENSIVE_QUEST before calling
 * GetQuestReward for a paid quest; StaticPopup's OnAccept calls the same C API. Direct addon calls
 * retain the original C API behavior, with cost enforcement left to the server. This pure resolver
 * cannot attest the popup lifecycle and therefore does not claim to enforce UI confirmation.
 */
export function resolveFrameXmlQuestAction(
  api: FrameXmlQuestActionName,
  page: FrameXmlQuestActionPage,
  options: { readonly luaChoice?: unknown } = {},
): FrameXmlQuestActionResolution {
  if (page.questList && page.questDialog) return { ok: false, reason: "conflicting-quest-pages" };
  const dialog = page.questDialog;
  if (!dialog && !page.questList) return { ok: false, reason: "missing-quest-page" };

  if (api === "DeclineQuest" || api === "CloseQuest") {
    return { ok: true, command: { method: "closeQuest", expectedPage: dialog ?? page.questList! } };
  }
  if (api === "AcceptQuest") {
    return dialog?.kind === "details"
      ? { ok: true, command: { method: "acceptQuest", expectedDialog: dialog } }
      : { ok: false, reason: "wrong-dialog-kind" };
  }
  if (api === "CompleteQuest") {
    if (dialog?.kind !== "request-items") return { ok: false, reason: "wrong-dialog-kind" };
    return dialog.canComplete
      ? { ok: true, command: { method: "requestQuestReward", expectedDialog: dialog } }
      : { ok: false, reason: "quest-not-completable" };
  }

  if (dialog?.kind !== "reward") return { ok: false, reason: "wrong-dialog-kind" };
  const luaChoice = options.luaChoice;
  const choiceCount = dialog.rewards.choices.length;
  if (!Number.isInteger(luaChoice) || typeof luaChoice !== "number"
    || (choiceCount === 0 ? luaChoice !== 0 : luaChoice < 1 || luaChoice > choiceCount)
    || choiceCount > 6) return { ok: false, reason: "invalid-choice" };
  return {
    ok: true,
    command: { method: "chooseQuestReward", expectedDialog: dialog, choice: choiceCount === 0 ? 0 : luaChoice - 1 },
  };
}
