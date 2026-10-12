/**
 * N when an add-on replaced `ToggleTalentFrame` (9.10).
 *
 * In Wow.exe the TOGGLETALENTS binding and TalentMicroButton run the global `ToggleTalentFrame`; an
 * add-on that assigned its own (a TSWoW module such as a talent-tree replacement) is what opens on N,
 * and Blizzard_TalentUI never loads for it. This owner calls that function, whoever installed it
 * (FrameXmlStockEntryPoints.ts decides «replaced» by identity with UIParent.lua's own), and knows no
 * frame name: it learns the window from what the call itself changed on screen.
 *
 * Each call compares the visible frames before and after. Where a newly visible subtree starts — a
 * frame shown now, not before, whose parent was already on screen — is what the toggle opened; the
 * window is such a frame that can be drawn: anchored (the client draws no frame without a rectangle,
 * so an unanchored helper the add-on creates on the way is not its window) and given an element by
 * the renderer. Those frames answer `isOpen` and are what `hide` hides (Escape, the second N). When the
 * add-on's window was already open by its own means, the call closes it as N does in the client: the
 * frames it hid are learned instead, and that is not a failure. A call that shows nothing drawable —
 * and hides nothing without a Lua error — throws through the controller, which hides and demotes this
 * owner; the same key press then opens the native window (FrameXmlTalentController.ts).
 *
 * The cost is two walks over the bridge's frames per key press that opens the window; closing it is
 * the learned frames' own Hide.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlTalentOwner } from "./FrameXmlTalentController.js";
import { frameXmlEntryPointReplaced } from "./FrameXmlStockEntryPoints.js";

type AddonTalentBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;
type AddonTalentRenderer = Pick<FrameXmlDomRenderer, "elementFor">;
type AddonTalentBridge = AddonTalentBoot["bridge"];

/** Textures and font strings draw inside a frame; only a frame can be the window a toggle shows. */
function isRegion(frame: FrameXmlFrame): boolean {
  return frame.type === "Texture" || frame.type === "FontString";
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

/** Anchored, and the renderer has this frame's own element: a window the player can see. */
function drawnWindow(frame: FrameXmlFrame, renderer: AddonTalentRenderer): boolean {
  if (frame.points.length === 0) return false;
  const element = renderer.elementFor(frame);
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

function visibleFrames(bridge: AddonTalentBridge): Set<FrameXmlFrame> {
  const visible = new Set<FrameXmlFrame>();
  for (const frame of bridge.frames) {
    if (!isRegion(frame) && bridge.isVisible(frame)) visible.add(frame);
  }
  return visible;
}

/** The roots of what became visible and of what became hidden since `before`. */
function visibilityChange(
  bridge: AddonTalentBridge,
  before: ReadonlySet<FrameXmlFrame>,
): { readonly shown: readonly FrameXmlFrame[]; readonly hidden: readonly FrameXmlFrame[] } {
  const shown: FrameXmlFrame[] = [];
  const hidden: FrameXmlFrame[] = [];
  for (const frame of bridge.frames) {
    if (isRegion(frame)) continue;
    const parent = frame.parent;
    if (bridge.isVisible(frame)) {
      if (!before.has(frame) && (!parent || before.has(parent))) shown.push(frame);
    } else if (before.has(frame) && (!parent || bridge.isVisible(parent))) {
      hidden.push(frame);
    }
  }
  return { shown, hidden };
}

/**
 * The owner for N over an add-on's `ToggleTalentFrame`, or undefined while the global is still
 * UIParent.lua's own (the lazy stock owner then loads Blizzard_TalentUI). `onAcquire` closes the native
 * window before the add-on's opens; `onFailure` is the controller's demotion callback.
 */
export function createPatchedFrameXmlTalentOwner(
  boot: AddonTalentBoot,
  renderer: AddonTalentRenderer,
  onAcquire?: () => void,
  onFailure?: () => void,
): FrameXmlTalentOwner | undefined {
  if (!frameXmlEntryPointReplaced(boot, "ToggleTalentFrame")) return undefined;
  const toggle = boot.vm.globalFunction("ToggleTalentFrame");
  if (!toggle) return undefined;
  let windows: readonly FrameXmlFrame[] = [];
  let disposed = false;
  let released = false;

  const open = (): boolean => windows.some((frame) => boot.bridge.isVisible(frame));
  const callToggle = (): void => {
    // Native N/micro-button entry bypasses Lua script dispatch, unlike the slash command.
    // Publish the completed window once, rather than repainting it after every Lua setter.
    boot.bridge.runInMutationBatch(() => { boot.vm.call(toggle, [], 0); });
  };
  const release = (): void => {
    if (released) return;
    released = true;
    boot.vm.release(toggle);
  };

  return {
    isOpen: () => !disposed && open(),
    show: () => {
      if (disposed) throw new Error("the add-on talent owner is disposed");
      // Close the native fallback before the add-on's Show path; a failed call is demoted
      // synchronously and the caller then opens native again from the same key/button press.
      onAcquire?.();
      if (open()) return;
      const before = visibleFrames(boot.bridge);
      const errors = boot.errorCount;
      callToggle();
      const change = visibilityChange(boot.bridge, before);
      const shown = change.shown.filter((frame) => drawnWindow(frame, renderer));
      if (shown.length > 0) {
        windows = shown;
        return;
      }
      const closed = change.hidden.filter((frame) => drawnWindow(frame, renderer));
      if (closed.length > 0 && boot.errorCount === errors) {
        windows = closed;
        return;
      }
      // An anchored frame the renderer could not draw is a half-built window: hide it, so the add-on's
      // own state agrees with what the player sees once the native window takes the press.
      for (const frame of change.shown) {
        if (frame.points.length === 0) continue;
        try { boot.bridge.Hide(frame); } catch { /* controller demotion continues */ }
      }
      throw new Error("the add-on's ToggleTalentFrame showed no window");
    },
    hide: () => {
      for (const frame of windows) boot.bridge.Hide(frame);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const frame of windows) {
        try { boot.bridge.Hide(frame); } catch { /* VM teardown continues */ }
      }
      windows = [];
      release();
    },
    ...(onFailure ? { onFailure } : {}),
  };
}
