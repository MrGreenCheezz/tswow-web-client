/**
 * 3.62, 3.64: a stock window opened or closed from outside Lua, the way stock does it.
 *
 * UIParent's panel manager keeps its left, center and right slots in FramePositionDelegate, and only
 * ShowUIPanel and HideUIPanel tell it anything (UIParent.lua:1962-1991). A frame shown beside it takes
 * no slot and pushes nothing aside, so windows lie over each other. A frame hidden beside it keeps its
 * slot: HideUIPanel then returns early on a hidden frame and the slot is never freed, so the next open
 * lands one place over, and CloseWindows (:2128) answers "found" for it on every Escape, which stops
 * ToggleGameMenu before the game menu for good.
 *
 * A frame UIPanelWindows does not list goes straight to Show or Hide inside the same two calls, so both
 * are right for any frame, an add-on's included.
 */

import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

type PanelBoot = Pick<FrameXmlBoot, "vm" | "bridge">;

/** The stock function on the frame; false when this VM has none. A Lua error is logged, and the caller reads the frame. */
function callPanelFunction(boot: PanelBoot, name: "ShowUIPanel" | "HideUIPanel", frame: FrameXmlFrame): boolean {
  const stock = boot.vm.globalFunction(name);
  if (!stock) return false;
  try {
    boot.bridge.runInMutationBatch(() => { boot.vm.call(stock, [frame], 0); });
  } catch (error) {
    console.warn(`[FrameXML panels] ${name}(${frame.name ?? "?"}): ${String(error)}`);
  } finally {
    boot.vm.release(stock);
  }
  return true;
}

/** ShowUIPanel: the manager may refuse (a center panel up, or dead), and then nothing shows, as in the client. */
export function showFrameXmlPanel(boot: PanelBoot, frame: FrameXmlFrame): void {
  if (boot.bridge.isVisible(frame)) return;
  if (!callPanelFunction(boot, "ShowUIPanel", frame)) boot.bridge.Show(frame);
}

/** HideUIPanel; a frame still up afterwards, because a handler raised on the way, is hidden anyway. */
export function hideFrameXmlPanel(boot: PanelBoot, frame: FrameXmlFrame): void {
  if (frame.visible) callPanelFunction(boot, "HideUIPanel", frame);
  if (frame.visible) boot.bridge.Hide(frame);
}
