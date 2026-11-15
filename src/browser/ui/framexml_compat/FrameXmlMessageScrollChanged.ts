/**
 * 3.34 (widgets5, 15.11): a ScrollingMessageFrame's `OnMessageScrollChanged`, as Wow.exe 3.3.5a (12340) raises
 * it (notes .runtime/re-2026-10-03/l334/r3.c; the string at 0x00aa017c is referenced once, from 0x0096905e):
 *
 * - The handler is the frame's script slot +0x33c (0x00969040 maps the name to it; 0x00969080 copies it with the
 *   frame's other scripts). Only CSimpleMessageScrollFrame has it — a MessageFrame does not.
 * - The slot layout (0x00969fa0), which every change of the current line goes through, raises it with no
 *   arguments but self (0x0081a2c0 with 0, 0) when the new current line differs from the old one — whether or not
 *   the frame is shown or laid out (the check sits outside the layout branch), and only while the frame has lines.
 * - Its callers: AddMessage at the bottom (0x0096a9f0: the new line becomes current), the scroll calls ScrollUp,
 *   ScrollDown, PageUp, PageDown, ScrollToTop, ScrollToBottom and SetScrollOffset (0x0096a8a0 … 0x0096abd0). A
 *   call that leaves the current line where it was — a scroll at an end, a line added at the top or while
 *   scrolled up — raises nothing.
 *
 * Here "the current line" is the line object at the frame's scroll position; the runtime calls this after a move
 * with the line that was current before it. Not modelled: RemoveMessagesByAccessID (0x0096a510 rebuilds the
 * ring before its layout call, so which ring index it compares is not read) and AddMessage while scrolled up when
 * the ring overwrites the line just above the shown ones (0x0096a9f0 then scrolls down one line).
 */
import type { FrameXmlFrame, FrameXmlMessage } from "./FrameXmlTypes.js";

/** What raising the handler needs from the runtime. */
export interface FrameXmlMessageScrollHost {
  fireScript(frame: FrameXmlFrame, script: string, ...args: readonly unknown[]): boolean;
}

/** After a move of `frame`'s current line: raise `OnMessageScrollChanged` when the line at it changed. */
export function frameXmlNoteMessageCurrent(
  host: FrameXmlMessageScrollHost, frame: FrameXmlFrame, before: FrameXmlMessage | undefined,
): void {
  if (frame.type !== "ScrollingMessageFrame") return;
  const messages = frame.messageFrame.messages;
  if (messages.length === 0) return;
  if (messages[frame.scroll.verticalScroll] === before) return;
  host.fireScript(frame, "OnMessageScrollChanged");
}
