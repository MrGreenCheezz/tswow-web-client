import type { ItemMetadata } from "../ItemMetadata.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import { itemTooltipContent, itemTooltipFor } from "../ui/ItemTooltip.js";
import { game } from "../game/Context.js";
import type { TooltipContent } from "../ui/Widgets.js";
import type { GameTooltipWidgetAdapter } from "../glue/GlueWidgets.js";
import type { FrameXmlActionTooltip, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

/**
 * The item identity that the stock inventory buttons own, kept separate from the five-value C API
 * tuple. The seam reads the cached item instance; the shared live tooltip may asynchronously warm
 * enchantment and gem descriptions without waiting inside the synchronous Lua method.
 */
export interface FrameXmlInventoryTooltipItem {
  readonly entry: number;
  readonly metadata?: ItemMetadata;
  readonly template?: ItemTemplate;
  readonly count?: number;
  readonly durability?: number;
  readonly enchantments?: readonly number[];
}

/** Optional, item-aware extension implemented by the world seams without widening the base seam. */
export interface FrameXmlInventoryTooltipSeam {
  readonly inventoryItemTooltip?:
    (unit: string, slot: number) => FrameXmlInventoryTooltipItem | undefined;
  readonly containerItemTooltip?:
    (bag: number, slot: number) => FrameXmlInventoryTooltipItem | undefined;
}

function contentFor(item: FrameXmlInventoryTooltipItem | undefined): TooltipContent | undefined {
  if (!item || !Number.isSafeInteger(item.entry) || item.entry <= 0) return undefined;
  const facts: {
    entry: number;
    metadata?: ItemMetadata;
    template?: ItemTemplate;
  } = { entry: item.entry };
  if (item.metadata !== undefined) facts.metadata = item.metadata;
  if (item.template !== undefined) facts.template = item.template;
  const context: { count?: number; durability?: number; enchantments?: readonly number[] } = {};
  if (item.enchantments !== undefined) context.enchantments = item.enchantments;
  if (item.count !== undefined && Number.isFinite(item.count) && item.count > 0) {
    context.count = Math.trunc(item.count);
  }
  if (item.durability !== undefined && Number.isFinite(item.durability) && item.durability >= 0) {
    context.durability = item.durability;
  }
  return game.world && item.enchantments ? itemTooltipFor(item.entry, context) : itemTooltipContent(facts, context);
}

function actionContent(action: FrameXmlActionTooltip | undefined): TooltipContent | undefined {
  if (!action || !Number.isSafeInteger(action.id) || action.id <= 0
    || !["spell", "item", "macro", "equipment"].includes(action.kind)
    || typeof action.name !== "string" || action.name.length === 0) return undefined;
  const rank = typeof action.rank === "string" && action.rank.length > 0 ? [action.rank] : undefined;
  return rank === undefined ? { title: action.name } : { title: action.name, lines: rank };
}

/** Build the common GameTooltip adapter from a live/canned item-aware seam. */
export function createFrameXmlCharacterTooltipAdapter(
  seam: FrameXmlWorldSeam | undefined,
): GameTooltipWidgetAdapter | undefined {
  const source = seam as (FrameXmlWorldSeam & FrameXmlInventoryTooltipSeam) | undefined;
  if (!source?.inventoryItemTooltip && !source?.containerItemTooltip
    && typeof source?.actionTooltip !== "function") return undefined;
  return {
    inventoryItem: (unit, slot) => contentFor(source.inventoryItemTooltip?.(unit, slot)),
    containerItem: (bag, slot) => contentFor(source.containerItemTooltip?.(bag, slot)),
    action: (slot) => actionContent(source.actionTooltip?.(slot)),
  };
}
