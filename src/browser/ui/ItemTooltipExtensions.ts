import type { ItemSlotState } from "../Inventory.js";
import type { TooltipContent } from "./Widgets.js";

export interface ItemTooltipExtension {
  decorate(slot: ItemSlotState, content: TooltipContent): TooltipContent;
  hide(): void;
}

let extension: ItemTooltipExtension | undefined;

/** Runtime-owned extension; existing inventory slots pick it up on their next hover. */
export function registerItemTooltipExtension(next: ItemTooltipExtension): () => void {
  extension?.hide();
  extension = next;
  return () => {
    if (extension !== next) return;
    next.hide();
    extension = undefined;
  };
}

export function extendItemTooltip(slot: ItemSlotState, content: TooltipContent): TooltipContent {
  return extension?.decorate(slot, content) ?? content;
}

export function hideItemTooltipExtension(): void {
  extension?.hide();
}
