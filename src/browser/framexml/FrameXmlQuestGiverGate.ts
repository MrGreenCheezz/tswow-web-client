import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/** Read-only proof of the selected 3.3.5a QuestFrame/QuestInfo tree. No route is published here. */
export interface FrameXmlQuestGiverStructure {
  readonly frame: FrameXmlFrame;
  readonly greeting: FrameXmlFrame;
  readonly detail: FrameXmlFrame;
  readonly progress: FrameXmlFrame;
  readonly reward: FrameXmlFrame;
  readonly info: FrameXmlFrame;
  readonly infoRewards: FrameXmlFrame;
}

const QUEST_EVENTS = [
  "QUEST_GREETING", "QUEST_DETAIL", "QUEST_PROGRESS", "QUEST_COMPLETE",
  "QUEST_FINISHED", "QUEST_ITEM_UPDATE",
] as const;
const SCROLL_SCRIPTS = ["OnLoad", "OnScrollRangeChanged", "OnVerticalScroll", "OnMouseWheel"] as const;

/**
 * QuestInfo.xml declares this money row as a visible parentless frame, while QuestInfo.lua only
 * shows it when the current packet requires payment. Hide the idle row before the production root
 * selector runs, so it remains mounted and can later follow the authored Show/Hide lifecycle.
 */
export function hideIdleQuestRequiredMoneyFrame(boot: FrameXmlBoot): boolean {
  const frame = boot.bridge.getFrame("QuestInfoRequiredMoneyFrame");
  if (!frame || frame.parent) return false;
  if (frame.visible) boot.bridge.Hide(frame);
  return !frame.visible;
}

function rendered(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element
    && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

function descendant(element: HTMLElement, ancestor: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Require the named frame at its authored direct parent in both the VM and rendered DOM.
 * A detached or merely named compatibility frame cannot satisfy this proof.
 */
function child(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  name: string,
  type: FrameXmlFrame["type"],
  parent: FrameXmlFrame,
  scripts: readonly string[] = [],
): FrameXmlFrame | undefined {
  const frame = boot.bridge.getFrame(name);
  const parentElement = renderer.elementFor(parent);
  const element = frame ? renderer.elementFor(frame) : undefined;
  if (!frame || frame.type !== type || frame.parent !== parent
    || !rendered(parentElement, parent) || !rendered(element, frame)
    || !descendant(element, parentElement)
    || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
  return frame;
}

function root(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  name: string,
  scripts: readonly string[] = [],
): FrameXmlFrame | undefined {
  const frame = boot.bridge.getFrame(name);
  if (!frame || frame.type !== "Frame" || frame.parent
    || !rendered(renderer.elementFor(frame), frame)
    || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
  return frame;
}

/**
 * Check only the mounted stock tree and its authored event handlers. The caller must separately
 * prove packet-backed C API, command ownership, and every host helper before showing QuestFrame.
 */
export function frameXmlQuestGiverStructureGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlQuestGiverStructure | undefined {
  try {
    const ui = root(boot, renderer, "UIParent");
    const frame = ui && child(boot, renderer, "QuestFrame", "Frame", ui,
      ["OnLoad", "OnEvent", "OnShow", "OnHide"]);
    if (!frame || frame.visible || boot.bridge.isVisible(frame)
      || !QUEST_EVENTS.every((event) => frame.registeredEvents.has(event))) return undefined;

    const portrait = child(boot, renderer, "QuestFramePortrait", "Texture", frame);
    const npcName = child(boot, renderer, "QuestNpcNameFrame", "Frame", frame, ["OnLoad"]);
    if (!portrait || !npcName
      || !child(boot, renderer, "QuestFrameNpcNameText", "FontString", npcName)
      || !child(boot, renderer, "QuestFrameCloseButton", "Button", frame, ["OnClick"])) return undefined;

    const panels = [
      ["QuestFrameGreetingPanel", "QuestGreetingScrollFrame", "QuestGreetingScrollChildFrame",
        "QuestFrameGreetingGoodbyeButton"],
      ["QuestFrameDetailPanel", "QuestDetailScrollFrame", "QuestDetailScrollChildFrame",
        "QuestFrameAcceptButton"],
      ["QuestFrameProgressPanel", "QuestProgressScrollFrame", "QuestProgressScrollChildFrame",
        "QuestFrameCompleteButton"],
      ["QuestFrameRewardPanel", "QuestRewardScrollFrame", "QuestRewardScrollChildFrame",
        "QuestFrameCompleteQuestButton"],
    ] as const;
    const resolved: FrameXmlFrame[] = [];
    const scrollChildren: FrameXmlFrame[] = [];
    for (const [panelName, scrollName, scrollChildName, primaryButton] of panels) {
      const panel = child(boot, renderer, panelName, "Frame", frame, ["OnShow"]);
      if (!panel || panel.visible || boot.bridge.isVisible(panel)) return undefined;
      const scroll = child(boot, renderer, scrollName, "ScrollFrame", panel, SCROLL_SCRIPTS);
      const scrollChild = scroll && child(boot, renderer, scrollChildName, "Frame", scroll);
      const scrollBar = scroll && child(boot, renderer, `${scrollName}ScrollBar`, "Slider", scroll,
        ["OnValueChanged"]);
      if (!scroll || !scrollChild || !scrollBar
        || !child(boot, renderer, primaryButton, "Button", panel, ["OnClick"])) return undefined;
      resolved.push(panel);
      scrollChildren.push(scrollChild);
    }
    const [greeting, detail, progress, reward] = resolved;
    const [greetingChild, , progressChild] = scrollChildren;
    if (!greeting || !detail || !progress || !reward || !greetingChild || !progressChild
      || !child(boot, renderer, "QuestFrameDeclineButton", "Button", detail, ["OnClick"])
      || !child(boot, renderer, "QuestFrameGoodbyeButton", "Button", progress, ["OnClick"])
      || !child(boot, renderer, "QuestFrameCancelButton", "Button", reward, ["OnClick"])) return undefined;
    for (let index = 1; index <= 32; index += 1) {
      if (!child(boot, renderer, `QuestTitleButton${index}`, "Button", greetingChild,
        ["OnClick"])) return undefined;
    }
    for (let index = 1; index <= 6; index += 1) {
      if (!child(boot, renderer, `QuestProgressItem${index}`, "Button", progressChild,
        ["OnLoad", "OnClick", "OnEnter", "OnLeave"])) return undefined;
    }

    // QuestInfo.xml declares these as separate hidden roots, later parented by stock Lua as needed.
    const info = root(boot, renderer, "QuestInfoFrame", ["OnLoad"]);
    const infoRewards = root(boot, renderer, "QuestInfoRewardsFrame");
    const infoObjectives = root(boot, renderer, "QuestInfoObjectivesFrame");
    const requiredMoney = root(boot, renderer, "QuestInfoRequiredMoneyFrame");
    if (!info || !infoRewards || !infoObjectives || !requiredMoney
      || info.visible || infoRewards.visible || infoObjectives.visible
      || !child(boot, renderer, "QuestInfoTitleHeader", "FontString", info)
      || !child(boot, renderer, "QuestInfoDescriptionText", "FontString", info)
      || !child(boot, renderer, "QuestInfoRewardText", "FontString", info)) return undefined;
    for (let index = 1; index <= 10; index += 1) {
      if (!child(boot, renderer, `QuestInfoItem${index}`, "Button", infoRewards,
        ["OnClick", "OnEnter", "OnLeave"])) return undefined;
    }
    return { frame, greeting, detail, progress, reward, info, infoRewards };
  } catch {
    return undefined;
  }
}
