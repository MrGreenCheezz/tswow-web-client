/**
 * The structural half every NPC-window gate shares (GossipFrame, BankFrame, TaxiFrame,
 * ItemTextFrame): named frames of the right widget type carrying the stock scripts, descending from
 * their root, rendered by the DOM host under their own identity, with the stock events registered.
 * Each gate then adds its own transactional show/probe/hide.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/** One named stock frame: its widget type and the scripts it must carry. */
export type FrameXmlNpcFrameSpec = readonly [name: string, type: string, scripts: readonly string[]];

export function frameXmlNpcDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

/** The renderer drew `frame` as itself (not a stand-in element). */
export function frameXmlNpcRendered(
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  frame: FrameXmlFrame,
): boolean {
  const element = renderer.elementFor(frame);
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

/**
 * Resolve every spec under `rootName` (the first spec must be the root, parented to UIParent and
 * hidden at gate time). Undefined on any missing frame, wrong type, missing script or a frame
 * outside the root's tree.
 */
export function frameXmlNpcFrames(
  boot: Pick<FrameXmlBoot, "bridge">,
  specs: readonly FrameXmlNpcFrameSpec[],
): Map<string, FrameXmlFrame> | undefined {
  const frames = new Map<string, FrameXmlFrame>();
  let root: FrameXmlFrame | undefined;
  for (const [name, type, scripts] of specs) {
    const frame = boot.bridge.getFrame(name);
    if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
      return undefined;
    }
    if (!root) {
      if (frame.parent?.name !== "UIParent" || frame.visible) return undefined;
      root = frame;
    } else if (!frameXmlNpcDescendsFrom(frame, root)) {
      return undefined;
    }
    frames.set(name, frame);
  }
  return frames;
}

/** Every `events` name is registered on `frame` (its OnLoad ran against this corpus). */
export function frameXmlNpcRegistered(frame: FrameXmlFrame | undefined, events: readonly string[]): boolean {
  return !!frame && events.every((event) => frame.registeredEvents.has(event));
}

/** Run a probe body and require no new Lua error or bridge diagnostic. */
export function frameXmlNpcClean<T>(
  boot: Pick<FrameXmlBoot, "bridge" | "errorCount">,
  operation: () => T,
): T | undefined {
  const errors = boot.errorCount;
  const diagnostics = boot.bridge.diagnostics.length;
  const result = operation();
  return boot.errorCount === errors && boot.bridge.diagnostics.length === diagnostics ? result : undefined;
}
