/**
 * Stock WorldStateScoreFrame as the battleground scoreboard (3.24, 12.10): the gate and the published owner
 * that TOGGLEWORLDSTATESCORES, `/score` and the native menu ask first (FrameXmlScoreboardController.ts). The C
 * API and model are FrameXmlScoreboard.ts; WorldStateFrame.xml is in the base TOC (FrameXmlCorpus.ts).
 *
 * The frame needed no owner to appear at a match's end — it shows itself once GetBattlefieldWinner() answers
 * (WorldStateFrame.xml:1550-1556 → WorldStateScoreFrame_Update, WorldStateFrame.lua:513-516) — but the key,
 * `/score` and the menu opened the native #scoreboard-window beside it. Wow.exe's key is stock
 * ToggleWorldStateScoreFrame (Bindings.xml TOGGLEWORLDSTATESCORES; WorldStateFrame.lua:926-934): it opens the
 * board only outside an arena and while MiniMapBattlefieldFrame.status is "active", a field only
 * BattlefieldFrame_UpdateStatus writes (BattlefieldFrame.lua:204-309) on UPDATE_BATTLEFIELD_STATUS. The world
 * mount keeps that event on BattlefieldFrame only with the complete stock battleground page
 * (FrameXmlWorldMount.ts frameXmlPvpGate), so this gate asks for it as well: without it the stock key would
 * open nothing where the native board still can, and the native one stays.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBattlefieldScoreModel } from "./FrameXmlScoreboard.js";
import type { FrameXmlScoreboardOwner } from "./FrameXmlScoreboardController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** Named stock frames the board needs, with their widget type and the scripts each must carry. */
const SCOREBOARD_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["WorldStateScoreFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnUpdate"]],
  ["WorldStateScoreScrollFrame", "ScrollFrame", []],
  ["WorldStateScoreButton1", "Frame", []],
  ["WorldStateScoreFrameCloseButton", "Button", ["OnClick"]],
  ["WorldStateScoreFrameTab1", "Button", ["OnClick"]],
  ["WorldStateScoreFrameTab2", "Button", ["OnClick"]],
  ["WorldStateScoreFrameTab3", "Button", ["OnClick"]],
  ["WorldStateScoreFrameLeaveButton", "Button", ["OnClick"]],
];

/** What WorldStateScoreFrame_OnLoad registers (WorldStateFrame.lua:449-452). */
const SCOREBOARD_EVENTS = ["UPDATE_BATTLEFIELD_SCORE", "UPDATE_WORLD_STATES", "PLAYER_ENTERING_WORLD"] as const;

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

export interface FrameXmlScoreboardGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock WorldStateScoreFrame can be the scoreboard: the
 * named tree under UIParent with its scripts and OnLoad's events, the scoreboard model on the seam,
 * ToggleWorldStateScoreFrame and MiniMapBattlefieldFrame, BattlefieldFrame still hearing
 * UPDATE_BATTLEFIELD_STATUS (the status the toggle reads), and one silent ShowUIPanel/HideUIPanel pair
 * that shows and hides the board with no new Lua error or bridge diagnostic. Its OnUpdate (the score
 * request) does not run inside the probe, so nothing is sent.
 */
export function frameXmlScoreboardGate(
  seam: { readonly scoreboard?: FrameXmlBattlefieldScoreModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlScoreboardGateResult | undefined {
  try {
    if (!seam.scoreboard) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of SCOREBOARD_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const root = frames.get("WorldStateScoreFrame")!;
    if (root.parent?.name !== "UIParent" || boot.bridge.isVisible(root)) return undefined;
    for (const frame of frames.values()) if (!frameDescendsFrom(frame, root)) return undefined;
    if (!renderedFrameElement(renderer.elementFor(root), root)) return undefined;
    if (!SCOREBOARD_EVENTS.every((event) => root.registeredEvents.has(event))) return undefined;
    const minimapButton = boot.bridge.getFrame("MiniMapBattlefieldFrame");
    const battlefield = boot.bridge.getFrame("BattlefieldFrame");
    if (!minimapButton || minimapButton.type !== "Button"
      || !battlefield?.registeredEvents.has("UPDATE_BATTLEFIELD_STATUS")) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/scoreboard-gate", `
      local toggle = type(ToggleWorldStateScoreFrame) == "function" and 1 or 0
      ShowUIPanel(WorldStateScoreFrame)
      local shown = WorldStateScoreFrame:IsShown() and 1 or 0
      HideUIPanel(WorldStateScoreFrame)
      return toggle, shown, WorldStateScoreFrame:IsShown() and 1 or 0
    `, 3);
    if (!probe) return undefined;
    const [toggle, shown, stillShown] = probe.map((value) => Number(value));
    if (toggle !== 1 || shown !== 1 || stillShown !== 0 || boot.bridge.isVisible(root)
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: root };
  } catch {
    return undefined;
  }
}

/**
 * The published owner: the key is stock ToggleWorldStateScoreFrame itself (its arena and «no battleground»
 * refusals included); a close is HideUIPanel, as UIParent's CloseWindows closes a center panel.
 */
export function createFrameXmlScoreboardOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlScoreboardOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    toggle: () => {
      boot.vm.executeReported("ToggleWorldStateScoreFrame()", "@webclient/scoreboard-toggle");
    },
    hide: () => {
      if (boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(WorldStateScoreFrame)", "@webclient/scoreboard-hide");
      }
    },
  };
}
