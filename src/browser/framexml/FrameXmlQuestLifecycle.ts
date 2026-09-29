import type { QuestDialog, QuestList } from "../../world/NpcProtocol.js";

/** An immutable-in-time view of the two quest-giver pages owned by WorldClient. */
export interface FrameXmlQuestSnapshot {
  readonly questList: QuestList | undefined;
  readonly questDialog: QuestDialog | undefined;
}

export type FrameXmlQuestLifecycleEvent =
  | "QUEST_GREETING"
  | "QUEST_DETAIL"
  | "QUEST_PROGRESS"
  | "QUEST_COMPLETE"
  | "QUEST_FINISHED";

/** Copy the page references before WorldClient replaces them on the next authoritative packet. */
export function captureFrameXmlQuestSnapshot(source: FrameXmlQuestSnapshot): FrameXmlQuestSnapshot {
  return { questList: source.questList, questDialog: source.questDialog };
}

/**
 * Select the event consumed by the original 3.3.5a QuestFrame_OnEvent. Each page packet creates
 * a new list/dialog object; an ordinary repaint keeps the same reference. Closing either page
 * produces QUEST_FINISHED whether the cause was cancellation, gossip close, or reward completion.
 *
 * QUEST_ITEM_UPDATE is deliberately outside this mapper. WorldClient does not expose an item
 * metadata revision in this state, and deriving one from a repeated page callback would refresh
 * the wrong panel or open a closed frame. A future item cache edge needs its own explicit source.
 */
export function frameXmlQuestLifecycleEvent(
  previous: FrameXmlQuestSnapshot | undefined,
  current: FrameXmlQuestSnapshot,
): FrameXmlQuestLifecycleEvent | undefined {
  // WorldClient's packet handlers make these mutually exclusive. Fail closed on a broken source.
  if (current.questList && current.questDialog) return undefined;
  if (current.questList) {
    return current.questList === previous?.questList && !previous?.questDialog
      ? undefined : "QUEST_GREETING";
  }
  const dialog = current.questDialog;
  if (dialog) {
    if (dialog === previous?.questDialog && !previous?.questList) return undefined;
    if (dialog.kind === "details") return "QUEST_DETAIL";
    if (dialog.kind === "request-items") return "QUEST_PROGRESS";
    return "QUEST_COMPLETE";
  }
  return previous?.questList || previous?.questDialog ? "QUEST_FINISHED" : undefined;
}
