/**
 * 3.35-bounds (03.10): where a SimpleHTML page's blocks sit inside the widget, so `GetBoundsRect` can
 * take them in (GlueDialog_Show sizes its HTML box from it, GlueDialog.lua:608).
 *
 * Wow.exe 3.3.5a (12340), notes .runtime/re-2026-10-03/l334 (r3.c, r4.c) and stock-small (g1.c):
 *
 * - Every block is a region of the widget (0x0096cc90: a CSimpleFontString made by 0x00485240 with
 *   the widget as its parent; 0x0096c9e0: a CSimpleTexture by 0x00484470), so the widget's bounds
 *   (virtual +0x64, CSimpleFrame's 0x004913c0, which CSimpleHTML's vtable 0x00aa07a0 keeps) take
 *   them in with its own rectangle.
 * - A text block is as wide as the widget (its SetWidth with the widget's width) and as tall as its
 *   lines. The first is anchored TOPLEFT on the widget's TOPLEFT; each next one TOPLEFT on the last
 *   text block's BOTTOMLEFT, lowered by that block's spacing (+0x2cc, set from the paragraph's +0xf8
 *   through 0x00493e00's pixel snap).
 * - A picture is anchored the same way — at the top when no text block came before it — by its
 *   `align` (LEFT: TOPLEFT, CENTER: TOP, RIGHT: TOPRIGHT); one in the flow (no explicit LEFT or
 *   RIGHT) lowers the next block by its height (+0x2cc -= height), a pinned one does not.
 * - A `<BR/>` directly inside BODY is a paragraph of "\n" (0x009e64dc) in the page's font.
 *
 * A block's lines: each `|n` starts one, and a line wider than the widget wraps at a space, or inside
 * a word longer than the widget; its height is lines × font height + (lines − 1) × spacing. The
 * BR paragraph is taken as one line [not measured on the client]. Glyph widths are the host's.
 */

import type { FrameXmlSimpleHtmlBlock } from "./FrameXmlSimpleHtml.js";
import { plainFrameXmlText } from "./FrameXmlText.js";

export type FrameXmlSimpleHtmlLevel = 0 | 1 | 2 | 3;

export interface FrameXmlSimpleHtmlMetrics {
  /** The font a block of this level draws in: its height and line spacing, in UI units. */
  font(level: FrameXmlSimpleHtmlLevel): { readonly height: number; readonly spacing: number };
  /** The width of plain text in that font, in UI units. */
  textWidth(level: FrameXmlSimpleHtmlLevel, text: string): number;
}

/** The page's extent inside the widget: y down from the widget's top, x from its left. */
export interface FrameXmlSimpleHtmlExtent {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** How many lines `text` takes at `width` (at least one). */
export function frameXmlSimpleHtmlLineCount(text: string, width: number, measure: (text: string) => number): number {
  let lines = 0;
  for (const hard of text.split("\n")) lines += wrappedLines(hard, width, measure);
  return Math.max(1, lines);
}

function wrappedLines(line: string, width: number, measure: (text: string) => number): number {
  if (line === "" || !(width > 0) || measure(line) <= width) return 1;
  let count = 0;
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate) <= width) { current = candidate; continue; }
    if (current !== "") { count += 1; current = ""; }
    // A word wider than the line is cut where it no longer fits.
    let piece = "";
    for (const character of word) {
      if (piece !== "" && measure(piece + character) > width) { count += 1; piece = ""; }
      piece += character;
    }
    current = piece;
  }
  return count + 1;
}

/** The blocks' extent inside a widget `width` wide; undefined for a page with no blocks. */
export function frameXmlSimpleHtmlExtent(
  blocks: readonly FrameXmlSimpleHtmlBlock[],
  width: number,
  metrics: FrameXmlSimpleHtmlMetrics,
): FrameXmlSimpleHtmlExtent | undefined {
  if (blocks.length === 0) return undefined;
  let anchor: number | undefined;
  let gap = 0;
  let bottom = 0;
  let left = 0;
  let right = width;
  for (const block of blocks) {
    const top = anchor === undefined ? 0 : anchor + gap;
    if (block.kind === "image") {
      bottom = Math.max(bottom, top + block.height);
      const x = block.align === "RIGHT" ? width - block.width : block.align === "CENTER" ? (width - block.width) / 2 : 0;
      left = Math.min(left, x);
      right = Math.max(right, x + block.width);
      if (!block.floating) gap += block.height;
      continue;
    }
    const level = block.empty ? 0 : block.level;
    const font = metrics.font(level);
    const lines = block.empty ? 1
      : frameXmlSimpleHtmlLineCount(plainFrameXmlText(block.text), width, (text) => metrics.textWidth(level, text));
    const height = lines * font.height + (lines - 1) * font.spacing;
    anchor = top + height;
    gap = font.spacing;
    bottom = Math.max(bottom, anchor);
  }
  return { top: 0, bottom, left, right };
}
