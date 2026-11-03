import type { QuestDialog, QuestList } from "../../world/NpcProtocol.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import {
  frameXmlQuestGiverStructureGate,
} from "./FrameXmlQuestGiverGate.js";
import type {
  FrameXmlQuestGiverOwner,
  FrameXmlQuestGiverWorld,
} from "./FrameXmlQuestGiverController.js";
import type { FrameXmlQuestLifecycleEvent } from "./FrameXmlQuestLifecycle.js";
import { hideFrameXmlPanel, showFrameXmlPanel } from "./FrameXmlPanels.js"; // 3.62

export interface FrameXmlQuestGiverMountContext {
  readonly world: FrameXmlQuestGiverWorld;
  currentWorld(): FrameXmlQuestGiverWorld | undefined;
  hideNative(): void;
  prefetch(page: QuestDialog | QuestList): void;
  onFailure(): void;
}

/**
 * Bind the selected MPQ's quest frame to its packet-backed C API and exact host helpers. The
 * authoring gate alone does not prove that the runtime can show, close or report an error.
 */
export function createFrameXmlQuestGiverMountOwner(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  seam: FrameXmlWorldSeam,
  context: FrameXmlQuestGiverMountContext,
): FrameXmlQuestGiverOwner | undefined {
  const structure = frameXmlQuestGiverStructureGate(boot, renderer);
  if (!structure || typeof seam.questGiverCall !== "function") return undefined;
  const frame = structure.frame;
  const close = boot.bridge.getFrame("QuestFrameCloseButton");
  const errors = boot.bridge.getFrame("UIErrorsFrame");
  if (!close || !errors || !errors.registeredEvents.has("UI_ERROR_MESSAGE")) return undefined;

  // UIParent.xml loads the selected UIParent.lua. Its panel manager can hide QuestFrame from the
  // QUEST_FINISHED handler; the owner also drives root visibility so panel placement delegates do
  // not decide whether a packet page opens. Bind the inherited X to that same exact root. The
  // selected StaticPopup.lua remains the paid/PvP confirmation implementation.
  let suppressClose = false;
  boot.vm.registerGlobal("CloseQuest", (args) => suppressClose
    ? [] : seam.questGiverCall("CloseQuest", args));
  const installed = boot.vm.execute(`
    assert(type(ERR_QUEST_MUST_CHOOSE) == "string" and UIErrorsFrame,
      "QuestFrame reward selection error needs its selected-client localization")
    function QuestChooseRewardError()
      UIErrorsFrame:AddMessage(ERR_QUEST_MUST_CHOOSE, 1.0, 0.1, 0.1, 1.0)
    end
  `, "@FrameXmlQuestGiverMount:reward-error");
  if (!installed.ok || !boot.bridge.SetScript(close, "OnClick", () => {
    hideFrameXmlPanel(boot, frame); // 3.62
  })) return undefined;

  const panels = {
    QUEST_GREETING: structure.greeting,
    QUEST_DETAIL: structure.detail,
    QUEST_PROGRESS: structure.progress,
    QUEST_COMPLETE: structure.reward,
  } as const;
  const render = (event: FrameXmlQuestLifecycleEvent | "QUEST_ITEM_UPDATE"): boolean => {
    // The selected client's HideUIPanel may hide the root inside QUEST_FINISHED itself. Suppress
    // CloseQuest for the entire event, including its OnHide, when the server already ended it.
    const previous = suppressClose;
    if (event === "QUEST_FINISHED") suppressClose = true;
    try {
      boot.bridge.runInMutationBatch(() => {
        if (event !== "QUEST_FINISHED" && event !== "QUEST_ITEM_UPDATE") showFrameXmlPanel(boot, frame); // 3.62
        boot.pump.fire(event);
        if (event === "QUEST_FINISHED") hideFrameXmlPanel(boot, frame); // 3.62
      });
    } finally { suppressClose = previous; }
    // Whether the page came up, and nothing else (the owner's report, 01.11): every frame registered for
    // the event runs inside this fire, add-ons' included. WCollections' row hook raising once used to hand
    // the giver's whole session to the native dialog, so quests with reward items left the stock interface
    // and the others did not. As in Wow.exe, somebody's handler failing is that handler's error.
    if (event === "QUEST_FINISHED") return !boot.bridge.isVisible(frame);
    if (!boot.bridge.isVisible(frame)) return false;
    return event === "QUEST_ITEM_UPDATE" || boot.bridge.isVisible(panels[event]);
  };
  return {
    world: context.world,
    currentWorld: context.currentWorld,
    isOpen: () => boot.bridge.isVisible(frame),
    render,
    hideNative: context.hideNative,
    prefetch: context.prefetch,
    message: (text, error) => {
      boot.pump.fire(error ? "UI_ERROR_MESSAGE" : "UI_INFO_MESSAGE", text);
    },
    close: () => { hideFrameXmlPanel(boot, frame); }, // 3.62
    dispose: () => {
      const previous = suppressClose;
      suppressClose = true;
      try { hideFrameXmlPanel(boot, frame); } finally { suppressClose = previous; } // 3.62
    },
    onFailure: context.onFailure,
  };
}
