import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * The ownership boundary between stock QuestLogFrame and the native quest log.
 *
 * The mount is the only publisher. Until a gated stock owner is published,
 * keyboard and Escape routes return `false` so their existing native fallbacks
 * remain responsible for the quest log.
 */
export interface FrameXmlQuestOwner {
  /** Whether the stock QuestLogFrame is currently visible. */
  isOpen(): boolean;
  /** The stock ToggleQuestLog/show path. */
  show(): void;
  /** The stock HideUIPanel/close path. */
  hide(): void;
  /** Release VM-local compatibility globals after teardown. */
  dispose?(): void;
  /** Demote this owner after a bridge mutation reports a runtime failure. */
  onFailure?(): void;
}

/** The structural proof required before the stock QuestLog owner can be published. */
export interface FrameXmlQuestGate {
  readonly frame: FrameXmlFrame;
  readonly watch: FrameXmlFrame;
  readonly detail: FrameXmlFrame;
}

const QUEST_READ_BINDINGS = [
  "questLogEntryCount", "questLogTitle", "selectQuestLogEntry", "questLogSelection",
  "questLogQuestText", "questLogLeaderBoardCount", "questLogLeaderBoard",
  "questLogRequiredMoney", "questLogTimeLeft", "questLogCompletionText", "questLogGroupNum",
  "questLogCurrentFailed", "questNumWatches", "questIndexForWatch", "questIsWatched",
] as const;

// QuestLogScrollFrame_OnLoad creates the complete authored pool from QuestLogTitleButtonTemplate.
// The 3.3.5a MPQ creates 22 visible rows; accepting only the first row (or a short prefix) can
// hide the native log after a partial Lua/parser failure.
const QUEST_TITLE_BUTTON_NAMES = Array.from(
  { length: 22 },
  (_unused, index) => `QuestLogScrollFrameButton${index + 1}`,
);
const QUEST_LOG_EVENTS = [
  "QUEST_LOG_UPDATE", "QUEST_ACCEPTED", "QUEST_WATCH_UPDATE", "UPDATE_FACTION",
  "UNIT_QUEST_LOG_CHANGED", "PARTY_MEMBERS_CHANGED", "PARTY_MEMBER_ENABLE",
  "PARTY_MEMBER_DISABLE", "DISPLAY_SIZE_CHANGED",
] as const;
const WATCH_EVENTS = [
  "PLAYER_ENTERING_WORLD", "QUEST_LOG_UPDATE", "TRACKED_ACHIEVEMENT_UPDATE", "ITEM_PUSH",
  "DISPLAY_SIZE_CHANGED", "ZONE_CHANGED_NEW_AREA", "WORLD_MAP_UPDATE", "QUEST_POI_UPDATE",
  "PLAYER_MONEY", "VARIABLES_LOADED",
] as const;
const QUEST_TITLE_BUTTON_EVENTS = [
  "UNIT_QUEST_LOG_CHANGED", "PARTY_MEMBERS_CHANGED", "PARTY_MEMBER_ENABLE", "PARTY_MEMBER_DISABLE",
] as const;

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function elementDescendsFrom(element: HTMLElement, ancestor: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

function renderedFrameElement(
  element: HTMLElement | undefined,
  frame: FrameXmlFrame,
): element is HTMLElement {
  return !!element
    && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

function hasScripts(
  boot: FrameXmlBoot,
  frame: FrameXmlFrame,
  scripts: readonly string[],
): boolean {
  return scripts.every((script) => boot.bridge.hasScript(frame, script));
}

function requireFrame(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  name: string,
  type: FrameXmlFrame["type"],
  parent: FrameXmlFrame,
  parentElement: HTMLElement,
  scripts: readonly string[],
): FrameXmlFrame | undefined {
  const frame = boot.bridge.getFrame(name);
  const element = frame ? renderer.elementFor(frame) : undefined;
  if (!frame || frame.type !== type || frame.parent !== parent || !frameDescendsFrom(frame, parent)
    || !renderedFrameElement(element, frame) || !elementDescendsFrom(element, parentElement)
    || !hasScripts(boot, frame, scripts)) return undefined;
  return frame;
}

/**
 * Prove that the real 3.3.5 QuestLog cluster is present and renderable.
 *
 * This is intentionally a read-only gate.  It does not hide either owner or call a seam getter;
 * publication in FrameXmlWorldMount is the only point where native visibility may change.
 */
export function frameXmlQuestGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlQuestGate | undefined {
  try {
    if (!QUEST_READ_BINDINGS.every((name) => typeof seam[name] === "function")) return undefined;

    const uiParent = boot.bridge.getFrame("UIParent");
    const quest = boot.bridge.getFrame("QuestLogFrame");
    const watch = boot.bridge.getFrame("WatchFrame");
    const detail = boot.bridge.getFrame("QuestLogDetailFrame");
    if (!uiParent || uiParent.type !== "Frame" || !quest || quest.type !== "Frame"
      || quest.parent !== uiParent || !watch || watch.type !== "Frame" || watch.parent !== uiParent
      || !detail || detail.type !== "Frame" || detail.parent !== uiParent
      || boot.bridge.isVisible(quest) || boot.bridge.isVisible(detail)) return undefined;

    const uiElement = renderer.elementFor(uiParent);
    const questElement = renderer.elementFor(quest);
    const watchElement = renderer.elementFor(watch);
    const detailElement = renderer.elementFor(detail);
    if (!renderedFrameElement(uiElement, uiParent)
      || !renderedFrameElement(questElement, quest)
      || !renderedFrameElement(watchElement, watch)
      || !renderedFrameElement(detailElement, detail)
      || !elementDescendsFrom(questElement, uiElement)
      || !elementDescendsFrom(watchElement, uiElement)
      || !elementDescendsFrom(detailElement, uiElement)) return undefined;

    if (!hasScripts(boot, quest, ["OnLoad", "OnEvent", "OnShow", "OnHide"])
      || !QUEST_LOG_EVENTS.every((event) => quest.registeredEvents.has(event))
      || !hasScripts(boot, watch, ["OnLoad", "OnEvent"])
      || !WATCH_EVENTS.every((event) => watch.registeredEvents.has(event))
      || !hasScripts(boot, detail, ["OnLoad", "OnShow", "OnHide"])) return undefined;

    const scroll = requireFrame(boot, renderer, "QuestLogScrollFrame", "ScrollFrame", quest,
      questElement, ["OnLoad"]);
    const scrollChild = scroll && requireFrame(boot, renderer, "QuestLogScrollFrameScrollChild", "Frame",
      scroll, renderer.elementFor(scroll)!, []);
    const scrollBar = scroll && requireFrame(boot, renderer, "QuestLogScrollFrameScrollBar", "Slider",
      scroll, renderer.elementFor(scroll)!, ["OnLoad", "OnValueChanged"]);
    const close = requireFrame(boot, renderer, "QuestLogFrameCloseButton", "Button", quest,
      questElement, ["OnClick"]);
    if (!scroll || !scrollChild || !scrollBar || !close) return undefined;

    for (const name of QUEST_TITLE_BUTTON_NAMES) {
      const button = boot.bridge.getFrame(name);
      if (!button || button.parent !== scrollChild) return undefined;
      const element = renderer.elementFor(button);
      if (button.type !== "Button" || button.parent !== scrollChild || !renderedFrameElement(element, button)
        || !elementDescendsFrom(element, renderer.elementFor(scrollChild)!)
        || !hasScripts(boot, button, ["OnLoad", "OnEvent", "OnClick", "OnEnter", "OnLeave"])
        || !QUEST_TITLE_BUTTON_EVENTS.every((event) => button.registeredEvents.has(event))) {
        return undefined;
      }
    }

    const detailClose = requireFrame(boot, renderer, "QuestLogDetailFrameCloseButton", "Button", detail,
      detailElement, ["OnClick"]);
    const detailScroll = requireFrame(boot, renderer, "QuestLogDetailScrollFrame", "ScrollFrame", detail,
      detailElement, ["OnLoad", "OnScrollRangeChanged", "OnVerticalScroll", "OnMouseWheel"]);
    const detailScrollElement = detailScroll ? renderer.elementFor(detailScroll) : undefined;
    const detailBar = detailScroll && detailScrollElement
      ? requireFrame(boot, renderer, "QuestLogDetailScrollFrameScrollBar", "Slider", detailScroll,
        detailScrollElement, ["OnValueChanged"])
      : undefined;
    if (!detailClose || !detailScroll || !detailBar) return undefined;

    const title = requireFrame(boot, renderer, "QuestLogTitleText", "FontString", quest,
      questElement, []);
    const count = requireFrame(boot, renderer, "QuestLogCount", "Frame", quest, questElement, []);
    const countElement = count ? renderer.elementFor(count) : undefined;
    const questCount = count && countElement
      ? requireFrame(boot, renderer, "QuestLogQuestCount", "FontString", count, countElement, [])
      : undefined;
    if (!title || !count || !questCount) return undefined;

    const watchHeader = requireFrame(boot, renderer, "WatchFrameHeader", "Button", watch,
      watchElement, ["OnLoad"]);
    const watchTitle = watchHeader && requireFrame(boot, renderer, "WatchFrameTitle", "FontString",
      watchHeader, renderer.elementFor(watchHeader)!, []);
    const collapse = requireFrame(boot, renderer, "WatchFrameCollapseExpandButton", "Button", watch,
      watchElement, ["OnClick"]);
    const lines = requireFrame(boot, renderer, "WatchFrameLines", "Frame", watch, watchElement, ["OnLoad"]);
    if (!watchHeader || !watchTitle || !collapse || !lines) return undefined;

    return { frame: quest, watch, detail };
  } catch {
    return undefined;
  }
}

let owner: FrameXmlQuestOwner | undefined;

function closeAndDispose(current: FrameXmlQuestOwner): void {
  try { current.hide(); } catch { /* teardown continues through the mount */ }
  try { current.dispose?.(); } catch { /* native fallback must remain usable */ }
}

function demote(current: FrameXmlQuestOwner): void {
  // Remove the route before cleanup/callback so a failing owner cannot remain
  // reachable while its mount restores native ownership.
  if (owner === current) owner = undefined;
  closeAndDispose(current);
  try { current.onFailure?.(); } catch { /* fail closed even if fallback cleanup fails */ }
}

function invoke(current: FrameXmlQuestOwner, action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    demote(current);
    return false;
  }
}

/** Publish one gated stock owner and return an identity-safe, idempotent cleanup. */
export function publishFrameXmlQuest(next: FrameXmlQuestOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) closeAndDispose(previous);
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    closeAndDispose(next);
    owner = undefined;
  };
}

/** Whether a gated stock quest-log owner is currently open. */
export function frameXmlQuestOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Route the quest-log action to stock when it is available. */
export function toggleFrameXmlQuest(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => {
    if (current.isOpen()) current.hide();
    else current.show();
  });
}

/** Close the stock quest log for Escape and the global window closer. */
export function closeFrameXmlQuest(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.hide());
}
