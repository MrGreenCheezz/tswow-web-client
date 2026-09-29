import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { GlueLuaRef } from "../glue/GlueLua.js";
import type { FrameXmlMap } from "./FrameXmlMap.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/** The original UIParent.lua panel route and WorldMapFrame.lua lifecycle, after a complete gate. */
export interface FrameXmlWorldMapOwner {
  isOpen(): boolean;
  open(): void;
  toggle(): void;
  close(): void;
  onFailure?(): void;
}

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function elementDescendsFrom(element: HTMLElement, ancestor: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Publish only when the mounted stock map can draw its tiles, use its authored controls, and
 * answer its map C APIs from real DBC metadata. A partial MPQ/client patch keeps the native map.
 */
export function frameXmlWorldMapGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  map: FrameXmlMap | undefined,
  onUnavailable?: (reason: string) => void,
  onFailure?: () => void,
): FrameXmlWorldMapOwner | undefined {
  const unavailable = (reason: string): undefined => { onUnavailable?.(reason); return undefined; };
  try {
    if (!map?.ready) return unavailable("map DBC metadata has not loaded");
    const root = boot.bridge.getFrame("WorldMapFrame");
    const element = root && renderer.elementFor(root);
    if (!root || root.type !== "Frame" || !element
      || element.getAttribute("data-framexml-name") !== root.name
      || root.visible || !boot.bridge.hasScript(root, "OnLoad")
      || !boot.bridge.hasScript(root, "OnShow") || !boot.bridge.hasScript(root, "OnHide")
      || !boot.bridge.hasScript(root, "OnEvent") || !boot.bridge.hasScript(root, "OnUpdate")
      || !root.registeredEvents.has("WORLD_MAP_UPDATE")) return unavailable("WorldMapFrame lifecycle");

    const require = (name: string, type: string, parent: FrameXmlFrame, script?: string): FrameXmlFrame | undefined => {
      const frame = boot.bridge.getFrame(name);
      const rendered = frame && renderer.elementFor(frame);
      return frame?.type === type && frameDescendsFrom(frame, parent)
        && rendered?.getAttribute("data-framexml-name") === name
        && elementDescendsFrom(rendered, element)
        && (!script || boot.bridge.hasScript(frame, script)) ? frame : undefined;
    };
    const detail = require("WorldMapDetailFrame", "Frame", root);
    const button = require("WorldMapButton", "Button", root, "OnMouseUp");
    const arrow = require("PlayerArrowEffectFrame", "Frame", root);
    if (!detail || !button || !arrow || !boot.bridge.hasScript(button, "OnUpdate")
      || !arrow.children.some((child) => child.type === "Texture"
        && child.texture.toLowerCase() === "interface\\minimap\\minimaparrow")) {
      return unavailable("WorldMap detail/button/player-arrow hierarchy");
    }
    for (let index = 1; index <= 12; index++) {
      if (!require(`WorldMapDetailTile${index}`, "Texture", detail)) return unavailable("WorldMap detail tiles");
    }
    for (const [name, type, script] of [
      ["WorldMapPlayer", "Frame", "OnEnter"],
      ["WorldMapZoomOutButton", "Button", "OnClick"],
      ["WorldMapLevelUpButton", "Button", "OnClick"],
      ["WorldMapLevelDownButton", "Button", "OnClick"],
      ["WorldMapFrameCloseButton", "Button", "OnClick"],
      ["WorldMapFrameSizeDownButton", "Button", "OnClick"],
      // UIDropDownMenuTemplate creates the child buttons; WorldMapFrame_OnLoad calls
      // UIDropDownMenu_Initialize for these containers. They have no own OnLoad script.
      ["WorldMapContinentDropDown", "Frame", undefined],
      ["WorldMapZoneDropDown", "Frame", undefined],
      ["WorldMapLevelDropDown", "Frame", undefined],
      ["WorldMapQuestScrollFrame", "ScrollFrame", undefined],
      ["WorldMapQuestShowObjectives", "CheckButton", "OnClick"],
    ] as const) {
      if (!require(name, type, root, script)) return unavailable(`${name} navigation or quest widget`);
    }

    const toggle = boot.vm.getGlobal("ToggleFrame");
    const show = boot.vm.getGlobal("ShowUIPanel");
    const hide = boot.vm.getGlobal("HideUIPanel");
    if (!(toggle instanceof GlueLuaRef) || !(show instanceof GlueLuaRef)
      || !(hide instanceof GlueLuaRef)) return unavailable("UIParent map panel functions");
    const call = (fn: GlueLuaRef, expected: boolean): void => {
      const errors = boot.errorCount;
      boot.vm.call(fn, [root], 0);
      if (boot.errorCount !== errors || boot.bridge.isVisible(root) !== expected) {
        throw new Error(`stock WorldMapFrame ${expected ? "open" : "close"} did not complete`);
      }
    };
    return {
      isOpen: () => boot.bridge.isVisible(root),
      open: () => {
        if (!boot.bridge.isVisible(root)) {
          if (!map.ready) throw new Error("world map positions are still pending");
          call(show, true);
        }
      },
      toggle: () => {
        if (!boot.bridge.isVisible(root) && !map.ready) {
          throw new Error("world map positions are still pending");
        }
        call(toggle, !boot.bridge.isVisible(root));
      },
      close: () => { if (boot.bridge.isVisible(root)) call(hide, false); },
      ...(onFailure ? { onFailure } : {}),
    };
  } catch (error) {
    return unavailable(String(error));
  }
}

export const createFrameXmlWorldMapController = frameXmlWorldMapGate;
