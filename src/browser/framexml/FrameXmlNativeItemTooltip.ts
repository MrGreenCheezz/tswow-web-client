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
  vm.registerGlobal("__fxNativeItemTooltipLine", (args) => {
    if (!active || key === undefined || typeof args[0] !== "string" || lines.length >= 64) return [];
    const runs = parseFrameXmlText(args[0]);
    const color = args.slice(1, 4).every((value) => typeof value === "number" && Number.isFinite(value))
      ? `#${args.slice(1, 4).map((value) => Math.round(Math.max(0, Math.min(1, value as number)) * 255)
        .toString(16).padStart(2, "0")).join("")}` : undefined;
    lines.push({ text: runs.map((run) => run.text).join(""),
      runs: runs.map((run) => ({ ...run, color: run.color ?? color })) });
    if (!rebuilding && !refreshQueued) {
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (active && key !== undefined) refreshTooltip();
      });
    }
    return [];
  });
  const hooked = vm.execute(`
    local append = __fxNativeItemTooltipLine
    hooksecurefunc(GameTooltip, "AddLine", function(self, text, r, g, b) append(text, r, g, b) end)
  `, "@framexml-native-item-tooltip-hooks");
  vm.setGlobal("__fxNativeItemTooltipLine", undefined);
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
