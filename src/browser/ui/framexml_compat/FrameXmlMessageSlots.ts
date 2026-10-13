/**
 * 3.34 (13.10): a ScrollingMessageFrame's slots as Wow.exe 3.3.5a 12340 lays them (CSimpleMessageScrollFrame;
 * notes .runtime/re-2026-10-03/l334/r3.c, re-2026-10-11/glue-1110/1013-q1.txt) — what `AtTop`,
 * `GetNumLinesDisplayed`, `PageUp` and `PageDown` read, and which lines the fade update counts.
 *
 * - The layout (0x00969fa0, on every current-line change): from the current line toward the oldest, each line
 *   goes into the next slot while the height left holds it — the line's string height plus the spacing
 *   (0x00483fa0, 0x00493e00) — and the first line always does. The count is +0x2cc, which
 *   `GetNumLinesDisplayed` (0x009736a0) answers; +0x2d0, «at top», which `AtTop` (0x009734d0) answers 1 or nil,
 *   is whether every line from the oldest to the current one got a slot. A frame without lines (+0x2c4 = -1)
 *   or without a laid-out rectangle lays nothing: 0 lines, not at top (the constructor's and Clear's 0x00969960
 *   values).
 * - Only the lines in slots are drawn and only they count down (0x00969e60); a line pushed out of the slots by a
 *   newer one keeps its countdowns where they were — frozen — until a layout puts it in a slot again
 *   (FrameXmlMessageFade.ts `frameXmlFreezeMessagesOutOfView`).
 *
 * The heights are the renderer's: it lends each frame's line layer (`frameXmlLendMessageGeometry`) and the
 * runtime reads it when asked — in a Lua call or a paint, never per frame. A line not drawn yet is one font
 * height. Without a lent layer (no renderer, a test) nothing is laid out, as an unlaid client frame.
 */
import type { FrameXmlMessage, FrameXmlMessageFrameState } from "./FrameXmlTypes.js";

/** What a renderer lends for one frame's line layer, read on demand. */
export interface FrameXmlMessageGeometry {
  /** The layer's inner height (px); 0 or undefined while it has none (hidden, not laid out). */
  height(): number | undefined;
  /** A drawn line's height (px); undefined for a line not drawn (yet). */
  lineHeight(message: FrameXmlMessage): number | undefined;
  /** One line of the frame's font (px), for a line not drawn yet. */
  fontHeight(): number | undefined;
}

const geometries = new WeakMap<FrameXmlMessageFrameState, FrameXmlMessageGeometry>();

export function frameXmlLendMessageGeometry(state: FrameXmlMessageFrameState, geometry: FrameXmlMessageGeometry): void {
  geometries.set(state, geometry);
}

export interface FrameXmlMessageSlots {
  /** +0x2cc: lines in slots. */
  readonly displayed: number;
  /** +0x2d0: every line from the oldest to `current` got a slot. */
  readonly atTop: boolean;
}

const NONE: FrameXmlMessageSlots = Object.freeze({ displayed: 0, atTop: false });

/** 0x00969fa0's slot walk with line `current` (0-based, oldest first) in the edge slot. */
export function frameXmlMessageSlots(state: FrameXmlMessageFrameState, current: number): FrameXmlMessageSlots {
  return frameXmlMeasuredMessageSlots(state, current) ?? NONE;
}

/**
 * The slot walk when it can be measured: undefined without lines, without a lent layer, or while the layer
 * has no height (hidden, not laid out) — where the fade keeps its older, measure-free rules.
 */
export function frameXmlMeasuredMessageSlots(state: FrameXmlMessageFrameState, current: number): FrameXmlMessageSlots | undefined {
  const count = state.messages.length;
  const geometry = geometries.get(state);
  if (count === 0 || geometry === undefined) return undefined;
  let left = geometry.height();
  if (left === undefined || !(left > 0)) return undefined;
  const last = Math.min(count - 1, Math.max(0, Math.trunc(current)));
  const font = geometry.fontHeight();
  let displayed = 0;
  for (let index = last; index >= 0; index -= 1) {
    const height = geometry.lineHeight(state.messages[index]!) ?? font ?? 0;
    if (displayed > 0 && left < height) break;
    displayed += 1;
    left -= height;
  }
  return { displayed, atTop: displayed === last + 1 };
}

/** The exactness margin of 0x00968790's guard, in UI units (the client's 2^-22 is in its screen units). */
const LINE_COUNT_TINY = 1e-4;

/**
 * A MessageFrame's slot count (0x00968790): its inset height over one line — the string height plus the
 * spacing, each snapped to whole pixels by 0x00493e00 — truncated (FNSTCW, OR 0xC00, FLDCW, FISTP at
 * 0x0096883a-0x0096884e: chop, not the FPU's rounding), plus one when the next whole count meets the height
 * within the guard (0x00968882, 0x009ea27c) — a floor with an exactness guard. The pixel snap is not modelled
 * here (UI units). Undefined without a height or a line height.
 */
export function frameXmlMessageLineCount(height: number, lineHeight: number): number | undefined {
  if (!(height > 0) || !(lineHeight > 0)) return undefined;
  let count = Math.trunc(height / lineHeight);
  if (Math.abs((count + 1) * lineHeight - height) < LINE_COUNT_TINY) count += 1;
  return count;
}

/**
 * `PageUp` (0x0096ab50) and `PageDown` (0x0096abd0) as line moves: the slots' count at the start, then one
 * line at a time toward the oldest (newest), each step laid out again and stopped — with a revive — at the
 * top (bottom); after a full page one line back the other way (so a page keeps one line), unless already at
 * that end, which revives instead. Returns the line to make current (0-based); the caller's scroll revives the
 * lines in view whether it moved or not, as both ends do. A frame with no slots laid out (0 lines) takes only
 * the last step — PageDown then goes one line up, as in the client.
 */
export function frameXmlMessagePage(
  state: FrameXmlMessageFrameState, current: number, up: boolean,
): number {
  const count = state.messages.length;
  if (count === 0) return current;
  const newest = count - 1;
  let line = Math.min(newest, Math.max(0, Math.trunc(current)));
  let steps = frameXmlMessageSlots(state, line).displayed;
  while (steps !== 0) {
    steps -= 1;
    if (up ? frameXmlMessageSlots(state, line).atTop : line >= newest) return line;
    line += up ? -1 : 1;
  }
  if (up ? line >= newest : frameXmlMessageSlots(state, line).atTop) return line;
  return line + (up ? 1 : -1);
}
