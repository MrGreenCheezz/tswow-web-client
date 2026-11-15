/**
 * frame10 (15.11, plan item 3.21): the stock `WorldFrame`, the frame the 3D world is drawn in, as Wow.exe 3.3.5a (12340)
 * has it (read-only Ghidra, .runtime/re-2026-11-15/frame10/d2.c … d7.c; behaviour described, no code copied).
 *
 * - Where it comes from: FrameXML.toc line 12, `WorldFrame.xml`, before `UIParent.xml`. The element `<WorldFrame>` is
 *   a widget type of its own, registered by 0x00521040 (beside GameTooltip, Cooldown, Minimap, the models and
 *   QuestPOIFrame) with the factory 0x0050f3f0 → constructor 0x004fabd0 (`CGWorldFrame`). So the global exists from
 *   the moment FrameXML loads that file, not before any Lua runs, and only in the world (GlueXML has no such file).
 * - What it answers: its type-name slot (vtable 0x009f99d8 + 0x1c) is the plain frame's 0x00492750, "Frame", so
 *   `GetObjectType` answers "Frame" and it shares Frame's method table (the census has no table of its own). Its
 *   strata is 0 (0x00491020(0) in the constructor), which `GetFrameStrata` names "UNKNOWN" (FrameXmlRuntime.ts). The
 *   constructor sets the keyboard, mouse and wheel bits (FrameXmlInputBits.ts). The XML gives it no parent and
 *   `setAllPoints`, so it covers the screen at scale 1, apart from UIParent: a frame parented to it keeps its own
 *   scale and stays shown when UIParent is hidden — the stock XML says so in its header comment.
 * - Its mouse (0x009f9a80 … 0x009f9a8c, the overrides of the frame's press handlers): the plain frame's handler runs
 *   first — OnMouseDown (0x0048fc30) and OnMouseUp (0x0048fce0) run the frame's script with the button's name and
 *   answer 0 — and then the world takes the same press (target, camera, bindings). A script never swallows the
 *   click; only a drag in progress ends the release there. Here the page's world canvas is that surface, so the
 *   scripts are run from the canvas's pointer events, before the world's own listener and without touching the event.
 *
 * Not here: an OnMouseWheel script on it takes the wheel from the camera in the original (0x0048fdb0 answers 1), and
 * OnKeyDown/OnKeyUp scripts take keys (0x0048fb80); both need the world's input layer and are left open.
 */
import { frameXmlMouseEnabled } from "./FrameXmlInputBits.js";
import type { FrameXmlFrame } from "./FrameXmlTypes.js";

/** The type name a widget answers to `GetObjectType`/`IsObjectType`: WorldFrame keeps the plain frame's slot. */
export function frameXmlObjectType(type: string): string {
  return type === "WorldFrame" ? "Frame" : type;
}

/** What the world surface needs of the bridge. */
export interface FrameXmlWorldFrameBridge {
  getFrame(name: string): FrameXmlFrame | undefined;
  isVisible(frame: FrameXmlFrame): boolean;
  fireScript(frame: FrameXmlFrame, script: string, ...args: readonly unknown[]): boolean;
}

/** `PointerEvent.buttons` bits and the names the client's scripts receive for them (0x0096f530's names). */
const BUTTONS: readonly (readonly [number, string])[] = [
  [1, "LeftButton"], [2, "RightButton"], [4, "MiddleButton"], [8, "Button4"], [16, "Button5"],
];

/** The pointer events read: the first press arrives as `pointerdown`, a chorded one as a `pointermove`. */
const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;

/**
 * Run WorldFrame's OnMouseDown/OnMouseUp for the presses the world canvas takes.
 *
 * A press counts when it lands on `surface` (the world canvas) and the frame is shown with its mouse bit set — the
 * original's mouse focus is WorldFrame exactly then. Its release goes to WorldFrame wherever the pointer is by then,
 * as a press's release goes to the frame that took it (0x004947a0). The listeners are passive and in the capture
 * phase, so they run before the world's own and never cancel or stop anything. Answers the cleanup.
 */
export function installFrameXmlWorldFrameMouse(
  bridge: FrameXmlWorldFrameBridge,
  surface: EventTarget,
  view: EventTarget,
  frameName = "WorldFrame",
): () => void {
  let seen = 0;
  let owned = 0;
  const onPointer = (event: Event): void => {
    const buttons = (event as Event & { readonly buttons?: unknown }).buttons;
    const now = event.type === "pointercancel" ? 0 : typeof buttons === "number" ? buttons : 0;
    const pressed = now & ~seen;
    const released = seen & ~now;
    seen = now;
    const frame = bridge.getFrame(frameName);
    if (event.type === "pointercancel") {
      owned = 0;
      return;
    }
    for (const [bit, name] of BUTTONS) {
      if ((released & bit) === 0 || (owned & bit) === 0) continue;
      owned &= ~bit;
      if (frame) bridge.fireScript(frame, "OnMouseUp", name);
    }
    if (pressed === 0 || event.target !== surface || !frame) return;
    if (!bridge.isVisible(frame) || !frameXmlMouseEnabled(frame)) return;
    for (const [bit, name] of BUTTONS) {
      if ((pressed & bit) === 0) continue;
      owned |= bit;
      bridge.fireScript(frame, "OnMouseDown", name);
    }
  };
  // A window that loses focus mid-press never hears the release; the next event starts from nothing.
  const forget = (): void => { seen = 0; owned = 0; };
  for (const type of POINTER_EVENTS) view.addEventListener(type, onPointer, { capture: true, passive: true });
  view.addEventListener("blur", forget);
  return () => {
    for (const type of POINTER_EVENTS) view.removeEventListener(type, onPointer, { capture: true });
    view.removeEventListener("blur", forget);
  };
}
