/**
 * 3.35-bounds (03.10): `Frame:GetBoundsRect()` as Wow.exe 3.3.5a (12340) answers it — notes
 * .runtime/re-2026-10-03/stock-small/g1.c and .runtime/re-2026-10-03/l334-review/r1.c.
 *
 * The method (0x0049e700, registration entry 0x00ac1570) starts from an empty box and hands it to the
 * frame's virtual +0x64; CSimpleFrame's 0x004913c0 — which CSimpleHTML's vtable 0x00aa07a0 keeps —
 * widens it by the frame's own rectangle, by every region of the frame that is shown (+0xcc & 0x10)
 * and by every child frame that is shown, through that child's own +0x64. A box that came out empty
 * (left ≥ right or bottom ≥ top) returns nothing; otherwise left, bottom, width, height, in the frame's
 * units (divided by its scale). The frame's own visibility is never asked: GlueDialog_Show measures
 * GlueDialogHTML while GlueDialog is still hidden (GlueDialog.lua:507-608).
 *
 * A SimpleHTML's blocks are regions of it (FrameXmlSimpleHtmlBounds.ts), so a page taller than the
 * widget's declared box widens it — GlueDialogHTML is declared 450 × 30 and a refusal of three lines
 * is about 55 units tall. CSimpleScrollFrame's own +0x64 (0x0096b9d0, vtable 0x00aa0420) is the same
 * walk without its scroll child (+0x2a0).
 */

import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { FRAME_XML_SIMPLE_HTML_LINK_FORMAT, parseFrameXmlSimpleHtml } from "../ui/framexml_compat/FrameXmlSimpleHtml.js";
import { frameXmlSimpleHtmlExtent, type FrameXmlSimpleHtmlLevel } from "../ui/framexml_compat/FrameXmlSimpleHtmlBounds.js";
import { frameXmlSimpleHtmlLevelFont } from "../ui/framexml_compat/FrameXmlSimpleHtmlFonts.js"; // L5 3.35

export type GlueBoundsHost = Pick<FrameXmlUiBridge, "geometry" | "effectiveScale" | "fontObjectStyle" | "measureFontText">;

/** Region widgets: everything else under a frame is a frame with bounds of its own. */
const REGION_TYPES: ReadonlySet<string> = new Set(["FontString", "Texture"]);
const MAX_DEPTH = 64;

interface Box { left: number; bottom: number; right: number; top: number }

function widen(box: Box, left: number, bottom: number, right: number, top: number): void {
  if (![left, bottom, right, top].every(Number.isFinite)) return;
  box.left = Math.min(box.left, left);
  box.bottom = Math.min(box.bottom, bottom);
  box.right = Math.max(box.right, right);
  box.top = Math.max(box.top, top);
}

/** The frame's rectangle on the screen (its units times its effective scale), bottom-origin. */
function rectOf(host: GlueBoundsHost, frame: FrameXmlFrame): Box {
  const rect = host.geometry(frame);
  const scale = host.effectiveScale(frame);
  return { left: rect.left * scale, bottom: rect.bottom * scale, right: rect.right * scale, top: rect.top * scale };
}

/** A SimpleHTML block's font: a header without a font object of its own is drawn in the page's (0x0096cc90). */
function htmlFont(host: GlueBoundsHost, frame: FrameXmlFrame, level: FrameXmlSimpleHtmlLevel): { name: string; height: number; spacing: number } {
  // L5 3.35: the block's font as the DOM draws it (FrameXmlSimpleHtmlFonts.ts) — a header's own is its
  // font object or SetFont("h1", …), with SetSpacing("h1", …); otherwise the page's.
  const font = frameXmlSimpleHtmlLevelFont(frame, level);
  const name = font.fontObject;
  const style = name ? host.fontObjectStyle(name) : undefined;
  const declaredHeight = font.height ?? Number.NaN;
  const declaredSpacing = font.spacing ?? Number.NaN;
  const height = Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight : Number(style?.height ?? 14);
  const spacing = Number.isFinite(declaredSpacing) ? declaredSpacing : Number(style?.spacing ?? 0);
  return { name, height: height > 0 ? height : 14, spacing };
}

function widenByPage(host: GlueBoundsHost, frame: FrameXmlFrame, own: Box, box: Box): void {
  if (!frame.text) return;
  const blocks = parseFrameXmlSimpleHtml(frame.text, frame.attributes["hyperlinkFormat"] ?? FRAME_XML_SIMPLE_HTML_LINK_FORMAT);
  const scale = host.effectiveScale(frame);
  const width = (own.right - own.left) / scale;
  const extent = frameXmlSimpleHtmlExtent(blocks, width, {
    font: (level) => htmlFont(host, frame, level),
    textWidth: (level, text) => host.measureFontText(htmlFont(host, frame, level).name, text),
  });
  if (!extent) return;
  widen(box, own.left + extent.left * scale, own.top - extent.bottom * scale,
    own.left + extent.right * scale, own.top - extent.top * scale);
}

/** 0x004913c0: the frame, its shown regions and its shown child frames. */
function widenByFrame(host: GlueBoundsHost, frame: FrameXmlFrame, box: Box, depth: number, seen: Set<FrameXmlFrame>): void {
  if (depth > MAX_DEPTH || seen.has(frame)) return;
  seen.add(frame);
  const own = rectOf(host, frame);
  widen(box, own.left, own.bottom, own.right, own.top);
  if (frame.type === "SimpleHTML") widenByPage(host, frame, own, box);
  for (const child of frame.children) {
    if (!child.visible || child === frame.scroll?.child) continue;
    if (REGION_TYPES.has(child.type)) {
      const rect = rectOf(host, child);
      widen(box, rect.left, rect.bottom, rect.right, rect.top);
    } else {
      widenByFrame(host, child, box, depth + 1, seen);
    }
  }
}

/** `GetBoundsRect()`: left, bottom, width, height — or nothing for an empty box. */
export function glueBoundsRect(host: GlueBoundsHost, frame: FrameXmlFrame): number[] {
  const box: Box = { left: Infinity, bottom: Infinity, right: -Infinity, top: -Infinity };
  widenByFrame(host, frame, box, 0, new Set());
  if (!(box.left < box.right) || !(box.bottom < box.top)) return [];
  const scale = host.effectiveScale(frame);
  return [box.left / scale, box.bottom / scale, (box.right - box.left) / scale, (box.top - box.bottom) / scale];
}
