/**
 * Plan item 2.10 (04.10, L4): an item tooltip without its sell price. Wow.exe 3.3.5a 12340's item
 * writer (0x006277f0, read 2026-09-30 and again 2026-10-04) writes the price (0x0061a0d0 → the
 * tooltip's OnTooltipAddMoney) last, and only when it wrote neither the REFUND_TIME_REMAINING line
 * nor, on this very draw, sent CMSG_ITEM_REFUND_INFO for an item whose template carries
 * ITEM_FLAG_ITEM_PURCHASE_RECORD and that was not asked about before (0x007089e0, bit 2 of the item's
 * +0x394). The shared builder puts the price in the content as a `money` line; this drops it, and a
 * late redraw (`refresh`) comes back without it too.
 */
import type { TooltipContent, TooltipLine } from "../ui/Widgets.js";

function hasPrice(content: TooltipContent): boolean {
  for (const line of content.lines ?? []) if (typeof line !== "string" && line.money !== undefined) return true;
  return false;
}

export function tooltipContentWithoutPrice(content: TooltipContent): TooltipContent {
  const refresh = content.refresh;
  if (!refresh && !hasPrice(content)) return content;
  const lines = (content.lines ?? []).filter((line): line is string | TooltipLine => typeof line === "string" || line.money === undefined);
  return {
    ...content,
    lines,
    ...(refresh ? { refresh: { watch: (redraw: (next: TooltipContent) => void) => refresh.watch((next) => redraw(tooltipContentWithoutPrice(next))) } } : {}),
  };
}
