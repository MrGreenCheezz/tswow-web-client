/**
 * The stock MerchantFrame's repair (plan item 2.02): the six C functions its buttons call, the
 * repair cursor's click on a bag or paper-doll item, and UPDATE_INVENTORY_DURABILITY, which
 * MerchantRepairAllButton and MerchantGuildBankRepairButton register for (MerchantFrame.xml) to
 * enable themselves again when the wear changes.
 *
 * The rules are browser/Repair.ts's, shared with the native vendor window. The answers are the
 * client's shapes: 1 or nil (lua_pushnumber 1.0 / lua_pushnil in Wow.exe 0x005849f0, 0x005843b0,
 * 0x005cc200), and GetRepairAllCost's `cost, 1|nil` — or a lone nil without a merchant who repairs
 * (0x00585990).
 *
 * The third value of GameTooltip:SetInventoryItem and the second of SetBagItem — the `repairCost`
 * PaperDollFrame.lua:1346 and ContainerFrame.lua:775 add as «Стоимость ремонта» while InRepairMode —
 * are {@link FrameXmlRepairModel.itemRepairCost}, reached through LiveWorldSeam's
 * `inventoryItemRepairCost`/`containerItemRepairCost` and the GameTooltip adapter (glue/GlueWidgets.ts).
 */

import { globalString } from "../../generated/globalStrings.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { RepairOutcome, RepairSession } from "../Repair.js";
import { pendingItemTarget } from "../game/SpellCursor.js";
import { frameXmlNativeTargeting } from "./FrameXmlGameMenuController.js";
import type { FrameXmlSeamBinding, FrameXmlSeamPump, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

/** The event both repair buttons register for. */
export const FRAMEXML_REPAIR_DURABILITY_EVENT = "UPDATE_INVENTORY_DURABILITY";
/** How often the wear is compared, in seconds of the pump's clock. */
const WEAR_POLL_SECONDS = 0.25;

export interface FrameXmlRepairModel {
  attach(pump: FrameXmlSeamPump): void;
  detach(): void;
  /** Once per seam poll: settle the cursor mode and raise UPDATE_INVENTORY_DURABILITY on a change. */
  tick(): void;
  canMerchantRepair(): boolean;
  /** `[cost, canRepair]`, or undefined (nil) without a merchant who repairs. */
  repairAllCost(): readonly [number, boolean] | undefined;
  canGuildBankRepair(): boolean;
  inRepairMode(): boolean;
  repairAllItems(guildBank: boolean): void;
  /** True when the mode is now on; the caller lets go of whatever the cursor holds. */
  showRepairCursor(): boolean;
  hideRepairCursor(): void;
  /**
   * A click on an item slot with nothing held (PickupContainerItem, PickupInventoryItem). True when
   * the repair cursor took it — the item is repaired (or refused for money), never picked up.
   */
  clickItem(item: WorldObjectState | undefined, guid: bigint): boolean;
  /**
   * The item's price as the tooltip setters answer it (Wow.exe 0x0062e050, 0x0062f420 → 0x00584b20):
   * merchant or not, 0 until the tables and the item's template are known.
   */
  itemRepairCost(item: WorldObjectState | undefined): number;
}

export function createFrameXmlRepair(session: RepairSession): FrameXmlRepairModel {
  let pump: FrameXmlSeamPump | undefined;
  let wear = "";
  let polledAt = Number.NEGATIVE_INFINITY;
  const refused = (outcome: RepairOutcome): void => {
    if (outcome !== "unaffordable") return;
    pump?.fire("UI_ERROR_MESSAGE", globalString("ERR_NOT_ENOUGH_MONEY") ?? "У вас недостаточно денег.");
  };
  return {
    attach(next) {
      pump = next;
      wear = session.wearSignature();
      polledAt = Number.NEGATIVE_INFINITY;
    },
    detach() {
      pump = undefined;
    },
    tick() {
      session.sync();
      if (!pump) return;
      const now = pump.now();
      if (now - polledAt < WEAR_POLL_SECONDS) return;
      polledAt = now;
      const next = session.wearSignature();
      if (next === wear) return;
      wear = next;
      pump.fire(FRAMEXML_REPAIR_DURABILITY_EVENT);
    },
    canMerchantRepair: () => session.canMerchantRepair(),
    repairAllCost() {
      const cost = session.allCost();
      return cost ? [cost.cost, cost.canRepair] : undefined;
    },
    canGuildBankRepair: () => session.canGuildBankRepair(),
    inRepairMode: () => session.active,
    repairAllItems(guildBank) {
      refused(session.repairAll(guildBank));
    },
    showRepairCursor: () => session.show(),
    hideRepairCursor() {
      session.hide();
    },
    clickItem(item, guid) {
      session.sync();
      if (!session.active) return false;
      // An empty slot under the repair cursor does nothing, as it does in the client.
      if (item && guid !== 0n) refused(session.repairItem(item, guid));
      return true;
    },
    itemRepairCost: (item) => session.priceOf(item),
  };
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE_OR_NIL = (value: boolean): readonly unknown[] => (value ? [1] : NOTHING);

/** Lua truthiness of an argument: nil and false are false, everything else (0 included) true. */
function luaTrue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function repairOf(seam: FrameXmlWorldSeam): FrameXmlRepairModel | undefined {
  return seam.repair;
}

/**
 * The stock UI's `SpellIsTargeting` (FrameXmlTradeSkill.ts, FrameXmlGlyph.ts): an enchant or a glyph
 * waiting for its item, a spell or item waiting for an item (game/SpellCursor.ts, 2.05), or the native
 * spell cursor. ShowRepairCursor does nothing meanwhile (0x00584a60 asks 0x007fd620 first);
 * RepairSession's own host only sees the ground target.
 */
function spellTargeting(seam: FrameXmlWorldSeam): boolean {
  return seam.tradeSkill?.targeting !== undefined || seam.glyphs?.targeting !== undefined
    || pendingItemTarget() !== undefined || frameXmlNativeTargeting();
}

/**
 * Spread after FRAMEXML_CURSOR_BINDINGS: a seam with a repair model answers from it; one without
 * (the canned world) keeps its own neutral answers.
 */
export const FRAMEXML_REPAIR_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  CanMerchantRepair: (seam) => {
    const repair = repairOf(seam);
    return repair ? ONE_OR_NIL(repair.canMerchantRepair()) : [seam.canMerchantRepair()];
  },
  GetRepairAllCost: (seam) => {
    const repair = repairOf(seam);
    if (!repair) return [...seam.repairAllCost()];
    const cost = repair.repairAllCost();
    if (!cost) return NOTHING;
    return cost[1] ? [cost[0], 1] : [cost[0]];
  },
  CanGuildBankRepair: (seam) => {
    const repair = repairOf(seam);
    return repair ? ONE_OR_NIL(repair.canGuildBankRepair()) : [seam.canGuildBankRepair()];
  },
  InRepairMode: (seam) => {
    const repair = repairOf(seam);
    return repair ? ONE_OR_NIL(repair.inRepairMode()) : [seam.inRepairMode()];
  },
  RepairAllItems: (seam, args) => {
    repairOf(seam)?.repairAllItems(luaTrue(args[0]));
    return NOTHING;
  },
  ShowRepairCursor: (seam) => {
    const repair = repairOf(seam);
    // The client lets go of what the cursor holds as it enters the mode (0x00519280).
    if (repair && !spellTargeting(seam) && repair.showRepairCursor()) {
      if (seam.cursor) seam.cursor.clear();
      else seam.clearCursor();
    }
    return NOTHING;
  },
  HideRepairCursor: (seam) => {
    repairOf(seam)?.hideRepairCursor();
    return NOTHING;
  },
});
