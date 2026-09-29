import {
  BANK_BAG_SLOTS, BANK_SLOT_BAG_START, BANK_SLOT_ITEM_START,
  INVENTORY_SLOT_BAG_0, INVENTORY_SLOT_BAG_START, INVENTORY_SLOT_ITEM_START,
  KEYRING_SLOT_START, KEYRING_SLOTS, type ItemSlotState,
} from "../Inventory.js";
import { registerItemTooltipExtension } from "../ui/ItemTooltipExtensions.js";
import { refreshTooltip, type TooltipLine } from "../ui/Widgets.js";
import { parseFrameXmlText } from "../ui/framexml_compat/FrameXmlText.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

/** Translate the native wire position to the 3.3.5 Lua bag/equipment APIs. */
export function frameXmlItemTooltipTarget(position: Pick<ItemSlotState, "bag" | "slot">):
  { readonly kind: "equipment" | "bag"; readonly bag: number; readonly slot: number } | undefined {
  const { bag, slot } = position;
  if (!Number.isInteger(bag) || !Number.isInteger(slot) || slot < 0) return undefined;
  if (bag === INVENTORY_SLOT_BAG_0) {
    if (slot < INVENTORY_SLOT_ITEM_START) return { kind: "equipment", bag: 0, slot: slot + 1 };
    if (slot < BANK_SLOT_ITEM_START) return { kind: "bag", bag: 0, slot: slot - INVENTORY_SLOT_ITEM_START + 1 };
    if (slot < BANK_SLOT_BAG_START) return { kind: "bag", bag: -1, slot: slot - BANK_SLOT_ITEM_START + 1 };
    if (slot >= KEYRING_SLOT_START && slot < KEYRING_SLOT_START + KEYRING_SLOTS) {
      return { kind: "bag", bag: -2, slot: slot - KEYRING_SLOT_START + 1 };
    }
    return undefined; // Bank bag containers and buyback have different tooltip methods.
  }
  if (bag >= INVENTORY_SLOT_BAG_START && bag < INVENTORY_SLOT_ITEM_START) {
    return { kind: "bag", bag: bag - INVENTORY_SLOT_BAG_START + 1, slot: slot + 1 };
  }
  if (bag >= BANK_SLOT_BAG_START && bag < BANK_SLOT_BAG_START + BANK_BAG_SLOTS) {
    return { kind: "bag", bag: bag - BANK_SLOT_BAG_START + 5, slot: slot + 1 };
  }
  return undefined;
}

/** Keep the original addon hooks and their asynchronous packet replies behind native tooltips. */
export function installFrameXmlNativeItemTooltip(
  boot: FrameXmlBoot,
  onActiveChanged?: (active: boolean) => void,
): () => void {
  const { vm, bridge } = boot;
  if (!bridge.getFrame("GameTooltip")) return () => {};
  let active = true;
  let disposing = false;
  let key: string | undefined;
  let rebuilding = false;
  let refreshQueued = false;
  let lines: TooltipLine[] = [];
  const dispatch = vm.compileFunction(`
    if kind == "hide" then GameTooltip:Hide(); return end
    GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
    if kind == "equipment" then GameTooltip:SetInventoryItem("player", slot)
    else GameTooltip:SetBagItem(bag, slot) end
  `, "@framexml-native-item-tooltip", ["kind", "bag", "slot"]);
  if (!dispatch) throw new Error("Could not compile the native item tooltip adapter");
  /** `r, g, b` from Lua as `#rrggbb`, or nothing when the caller gave none. */
  const hexOf = (values: readonly unknown[]): string | undefined =>
    values.length === 3 && values.every((value) => typeof value === "number" && Number.isFinite(value))
      ? `#${values.map((value) => Math.round(Math.max(0, Math.min(1, value as number)) * 255)
        .toString(16).padStart(2, "0")).join("")}` : undefined;
  const runsOf = (text: string, color: string | undefined): NonNullable<TooltipLine["runs"]> =>
    parseFrameXmlText(text).map((run) => ({ ...run, color: run.color ?? color }));
  const append = (runs: NonNullable<TooltipLine["runs"]>): void => {
    const text = runs.map((run) => run.text).join("");
    // `SetTooltipMoney` opens its row with `AddLine(" ")` and draws the coins over it; a blank
    // row is not a line an add-on wrote.
    if (text.trim().length === 0) return;
    lines.push({ text, runs });
    if (!rebuilding && !refreshQueued) {
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (active && key !== undefined) refreshTooltip();
      });
    }
  };
  vm.registerGlobal("__fxNativeItemTooltipLine", (args) => {
    if (!active || key === undefined || typeof args[0] !== "string" || lines.length >= 64) return [];
    append(runsOf(args[0], hexOf(args.slice(1, 4))));
    return [];
  });
  // `AddDoubleLine(left, right, lr, lg, lb, rr, rg, rb)`: AnyIDTooltip's «ItemID: 12345» row. The
  // native box has one column, so the two halves become one line with the stock gap between them.
  vm.registerGlobal("__fxNativeItemTooltipDoubleLine", (args) => {
    if (!active || key === undefined || lines.length >= 64) return [];
    const left = typeof args[0] === "string" || typeof args[0] === "number" ? String(args[0]) : undefined;
    if (left === undefined) return [];
    const right = typeof args[1] === "string" || typeof args[1] === "number" ? String(args[1]) : "";
    append([...runsOf(left, hexOf(args.slice(2, 5))),
      ...(right.length > 0 ? [{ text: "  " }, ...runsOf(right, hexOf(args.slice(5, 8)))] : [])]);
    return [];
  });
  const hooked = vm.execute(`
    local append, double = __fxNativeItemTooltipLine, __fxNativeItemTooltipDoubleLine
    hooksecurefunc(GameTooltip, "AddLine", function(self, text, r, g, b) append(text, r, g, b) end)
    hooksecurefunc(GameTooltip, "AddDoubleLine", function(self, left, right, lr, lg, lb, rr, rg, rb)
      double(left, right, lr, lg, lb, rr, rg, rb)
    end)
  `, "@framexml-native-item-tooltip-hooks");
  vm.setGlobal("__fxNativeItemTooltipLine", undefined);
  vm.setGlobal("__fxNativeItemTooltipDoubleLine", undefined);
  if (!hooked.ok) { active = false; vm.release(dispatch); throw new Error(hooked.error); }
  const hide = (): void => {
    if (key === undefined) return;
    key = undefined;
    lines = [];
    if (active) bridge.runInMutationBatch(() => {
      vm.call(dispatch, ["hide", 0, 0], 0);
      if (!disposing) onActiveChanged?.(false);
    });
  };
  const unregister = registerItemTooltipExtension({
    hide,
    decorate(slot, content) {
      const target = slot.item ? frameXmlItemTooltipTarget(slot) : undefined;
      if (!active || !target) { hide(); return content; }
      const next = `${slot.bag}:${slot.slot}:${slot.guid}`;
      if (key !== next) {
        hide();
        key = next;
        rebuilding = true;
        try { bridge.runInMutationBatch(() => {
          onActiveChanged?.(true);
          vm.call(dispatch, [target.kind, target.bag, target.slot], 0);
        }); }
        finally { rebuilding = false; }
      }
      return lines.length === 0 ? content : { ...content, lines: [...(content.lines ?? []), ...lines] };
    },
  });
  return () => {
    if (!active) return;
    disposing = true;
    unregister();
    active = false;
    vm.release(dispatch);
  };
}
