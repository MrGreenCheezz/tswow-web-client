import { globalString } from "../../generated/globalStrings.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import {
  bindEnchantWithCursor, replaceEnchantWithCursor, targetItemWithCursor, targetTradeSlotWithCursor,
  type ItemTargetOutcome,
} from "../game/SpellCursor.js";
import { notice } from "./Notices.js";
import { confirmPanel } from "./Widgets.js";

/** REPLACE_ENCHANT's words (GlobalStrings.lua), both names filled in. */
function replaceEnchantText(oldName: string, newName: string): string {
  const format = globalString("REPLACE_ENCHANT") ?? "Заменить «%s» на «%s»?";
  let index = 0;
  const names = [oldName, newName];
  return format.replace(/%s/g, () => names[index++] ?? "");
}

/**
 * An outcome told to the native interface: a refusal in the status line, the bind or replace question
 * as a confirm panel at `anchor` whose accept is `accept` — BindEnchant's for BIND_ENCHANT, which may
 * ask REPLACE_ENCHANT next (nothing without an anchor: the cursor stays).
 */
function tellOutcome(outcome: ItemTargetOutcome, anchor: HTMLElement | undefined, accept: () => ItemTargetOutcome): void {
  // 2.10: enchanting a refundable purchase — END_REFUND, whose accept is EndRefund(1), the same
  // re-run as BindEnchant's (Wow.exe 0x00523370 → 0x005210d0 answered).
  if (outcome.kind === "confirm" && outcome.event === "END_REFUND") {
    if (!anchor) return;
    confirmPanel(anchor, {
      title: globalString("END_REFUND") ?? "Это действие не позволит вернуть предмет торговцу.",
      confirm: globalString("OKAY") ?? "ОК",
      onConfirm: () => tellOutcome(bindEnchantWithCursor(), anchor, () => replaceEnchantWithCursor()),
    });
    return;
  }
  // L1 (2.05/3.22): END_BOUND_TRADEABLE — the accept is EndBoundTradeable("itemenchant"), again
  // BindEnchant's answered re-run (Wow.exe 0x005233d0 → 0x005210d0), so REPLACE_ENCHANT may follow.
  if (outcome.kind === "confirm" && outcome.event === "END_BOUND_TRADEABLE") {
    if (!anchor) return;
    confirmPanel(anchor, {
      title: globalString("END_BOUND_TRADEABLE") ?? "После выполнения этого действия вы больше не сможете передать этот предмет другому игроку.",
      confirm: globalString("OKAY") ?? "ОК",
      onConfirm: () => tellOutcome(bindEnchantWithCursor(), anchor, () => replaceEnchantWithCursor()),
    });
    return;
  }
  if (outcome.kind === "confirm" && outcome.event === "BIND_ENCHANT") {
    if (!anchor) return;
    confirmPanel(anchor, {
      title: globalString("BIND_ENCHANT") ?? "Если вы зачаруете этот предмет, он станет персональным.",
      confirm: globalString("OKAY") ?? "ОК",
      onConfirm: () => tellOutcome(bindEnchantWithCursor(), anchor, () => replaceEnchantWithCursor()),
    });
    return;
  }
  if (outcome.kind === "refused") {
    const text = globalString(outcome.error) ?? outcome.error;
    game.world?.onSpellStatus?.(text, true);
    if (!game.world?.onSpellStatus) notice(text);
  } else if (outcome.kind === "confirm" && anchor) {
    confirmPanel(anchor, {
      title: replaceEnchantText(outcome.oldName, outcome.newName),
      confirm: globalString("YES") ?? "Да",
      onConfirm: () => tellOutcome(accept(), undefined, accept),
    });
  }
}

/**
 * A native item slot's click while a spell or item waits for an item (plan item 2.05,
 * game/SpellCursor.ts): the item becomes the target instead of opening its menu, being repaired or
 * used — the client asks the spell cursor first (Wow.exe 0x005d8650, 0x005e85d0). True when the
 * cursor took the click (sent, refused with the client's message and the cursor kept, or asked
 * REPLACE_ENCHANT at `anchor`).
 */
export function clickItemTargetSlot(item: WorldObjectState | undefined, guid: bigint, anchor?: HTMLElement): boolean {
  const outcome = targetItemWithCursor(item, guid);
  if (outcome.kind === "none") return false;
  tellOutcome(outcome, anchor, () => replaceEnchantWithCursor());
  return true;
}

/**
 * The native trade window's «will not be traded» slot while a spell waits for an item: it takes the
 * trader's seventh item (TARGET_FLAG_TRADE_ITEM slot 6, as `ClickTargetTradeButton(7)`), after
 * TRADE_REPLACE_ENCHANT at `anchor` when that item is already enchanted. True when the cursor took it.
 */
export function clickTradeEnchantSlot(anchor?: HTMLElement): boolean {
  if (!game.world?.tradeOpen) return false;
  const outcome = targetTradeSlotWithCursor();
  if (outcome.kind === "none") return false;
  tellOutcome(outcome, anchor, () => targetTradeSlotWithCursor(undefined, undefined, true));
  return true;
}
