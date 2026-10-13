/**
 * 3.34 (13.10): the DOM renderer's side of a ScrollingMessageFrame's slot layout — the line layer and each
 * drawn line's element, lent to FrameXmlMessageSlots.ts so the runtime can walk the client's slots
 * (0x00969fa0) over the heights the browser laid out. Read only when asked (a Lua call, a scroll call, the
 * paint that just read the layer's heights), never per frame.
 */
import { frameXmlLendMessageGeometry } from "./FrameXmlMessageSlots.js";
import type { FrameXmlMessage, FrameXmlMessageFrameState } from "./FrameXmlTypes.js";

/** Each drawn line's element; a message is drawn in one frame's layer only. */
const lineElements = new WeakMap<FrameXmlMessage, HTMLElement>();

const finite = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export function noteMessageLineElement(message: FrameXmlMessage, element: HTMLElement): void {
  lineElements.set(message, element);
}

export function lendMessageLayer(state: FrameXmlMessageFrameState, layer: HTMLElement): void {
  frameXmlLendMessageGeometry(state, {
    height: () => finite(layer.clientHeight),
    lineHeight: (message) => {
      const line = lineElements.get(message);
      return line !== undefined && line.parentElement === layer ? finite(line.offsetHeight) : undefined;
    },
    fontHeight: () => {
      const px = Number.parseFloat(layer.style.fontSize);
      return px > 0 ? px : undefined;
    },
  });
}
