/**
 * `EndBoundTradeable(kind)` — the stock END_BOUND_TRADEABLE popup's accept (StaticPopup.lua:2396-2402)
 * — and the pending-spell events (plan items 2.05 and 3.22, lane L1; game/BoundTradeable.ts has the
 * question's rule).
 *
 * Wow.exe 12340 `EndBoundTradeable` (0x005233d0): the kind is compared without case and in full
 * (0x0076e780 → `_strnicmp`) with "itemenchant" — 0x005210d0 again for the item the question named,
 * answered, as `BindEnchant` does — then "gem" (0x00a02ba4) — 0x005c4ff0, AcceptSockets — then
 * "spellenchant" — 0x0080da40 with the spell 0x0080c790 stored, when one is stored. This client never
 * raises "spellenchant": it has no SPELL_ATTR0_TARGET_MAINHAND_ITEM weapon pick (0x0080c790's
 * ENCHANT_ITEM_TEMPORARY branch), so nothing is stored and that answer does nothing, as in the
 * client with nothing stored.
 */

import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { END_BOUND_TRADEABLE_GEM, END_BOUND_TRADEABLE_ITEM_ENCHANT } from "../game/BoundTradeable.js";

/** The kind as 0x005233d0 reads it: a Lua string or number, lower-cased for the case-blind compare. */
function kindOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `EndBoundTradeable(kind)`. */
export function frameXmlEndBoundTradeable(
  seam: Pick<FrameXmlWorldSeam, "bindEnchant" | "socket">, value: unknown,
): void {
  const kind = kindOf(value);
  if (kind === END_BOUND_TRADEABLE_ITEM_ENCHANT) seam.bindEnchant?.();
  else if (kind === END_BOUND_TRADEABLE_GEM) seam.socket?.accept();
}

/** What 0x0053b480 raises, in its order: 0x005a7cb0's ACTIONBAR_UPDATE_STATE, then CURRENT_SPELL_CAST_CHANGED. */
export const FRAMEXML_PENDING_SPELL_EVENTS = Object.freeze(["ACTIONBAR_UPDATE_STATE", "CURRENT_SPELL_CAST_CHANGED"] as const);

interface PendingSpellPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** A cursor that can say when it goes up (true) and down; returns the unsubscribe. */
export type FrameXmlPendingSpellSource = (observer: (armed: boolean) => void) => () => void;

/**
 * Wow.exe raises 0x0053b480 whenever the one pending spell (`DAT_00d3f4e4`) changes: armed for a target
 * (0x0080cce0), sent with the target filled (0x0080ac90 → 0x00805330) and dropped (SpellStopTargeting
 * 0x00809e30 → 0x00806200 → 0x008054f0). Stock UIParent hides BIND_ENCHANT, REPLACE_ENCHANT,
 * TRADE_REPLACE_ENCHANT, END_REFUND and END_BOUND_TRADEABLE on it (UIParent.lua:773-779), SpellBookFrame
 * repaints its selection (SpellBookFrame.lua:299). Each source is one of this client's pending-spell
 * cursors (the item-target cursor, the stock TradeSkillFrame enchant); every edge raises the pair once.
 */
export function frameXmlObservePendingSpells(
  pump: () => PendingSpellPump | undefined, sources: readonly FrameXmlPendingSpellSource[],
): () => void {
  const stops = sources.map((source) => source(() => {
    const target = pump();
    if (!target) return;
    for (const event of FRAMEXML_PENDING_SPELL_EVENTS) target.fire(event);
  }));
  return () => { for (const stop of stops) stop(); };
}
