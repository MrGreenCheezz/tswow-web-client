/**
 * Money on the cursor — the C API behind the stock CoinPickupFrame (plan item 3.09, L5c 04.10).
 *
 * The stock money frames (MoneyFrame.xml's coin buttons) open CoinPickupFrame through
 * `OpenCoinPickupFrame`; its «OK» calls the frame type's `PickupFunc` (MoneyFrame.lua:21-27 the
 * backpack's PickupPlayerMoney/DropCursorMoney, :54-60 the trade's PickupTradeMoney/AddTradeMoney).
 * Where the money is dropped decides what happens to it, always through a stock call this client
 * already answers: the trade frame (TradeFrame.lua:161-163 AddTradeMoney), the send-mail money box
 * (MailFrame.lua:1074-1083 — the sum goes into the box, the letter's own send carries it), a guild
 * vault slot (Blizzard_GuildBankUI.xml:22-25 DepositGuildBankMoney, then ClearCursor) or a bag slot
 * (ContainerFrame.lua:705 DropCursorMoney: back to the purse).
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, notes .runtime/re-2026-10-04/l5c/b1-b3):
 *
 * * `PickupPlayerMoney(amount)` 0x00522980: with the player there, a non-zero amount up to the
 *   coinage field goes on the cursor (0x00520880: the cursor is cleared, type 2 and the amount set,
 *   PLAYER_MONEY raised). The server is not told.
 * * `DropCursorMoney()` 0x00522950: with player money held, the cursor is cleared (0x00519280(1, 1):
 *   the amount is 0 again, PLAYER_MONEY, CURSOR_UPDATE) — the money never left the purse.
 * * `GetCursorMoney()` 0x00515a50: the held amount (0 when none), whichever kind holds it.
 *   `CursorHasMoney()` 0x005151c0: 1 for the player's money (type 2), nil otherwise.
 * * `PickupTradeMoney(amount)` 0x00586810: 0 < amount ≤ the offered gold → the offer drops by the
 *   amount (0x00704320: CMSG_SET_TRADE_GOLD with the new total) and the amount is held as above.
 * * `AddTradeMoney()` 0x00586d90: with an amount held, offer + amount ≤ coinage → CMSG_SET_TRADE_GOLD
 *   with the sum (0x00704220) and the cursor cleared without PLAYER_MONEY (0x00519280(1, 0)).
 *
 * Deviation, deliberate: the client sends CMSG_SET_TRADE_GOLD whatever its trade state is; here the
 * trade model sends only into an open trade the stock frame owns, and the hand changes only when the
 * offer did — money is never shown as moved when it did not move. (L5c-review: the bindings check the
 * model's `showing` — TRADE_SHOW sent for the open trade — since `setMoney` itself asks only whether a
 * trade is open, and a native-owned trade must not take a stock drop.) `PickupGuildBankMoney` (0x005a4330)
 * stays unbound: no stock money frame of the vault can pick up (MoneyTypeInfo GUILDBANK has no
 * `canPickup`).
 */

import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

const NOTHING: readonly unknown[] = Object.freeze([]);

/** The client's `(uint)ROUND(x)` of a Lua number argument; undefined for a non-number. */
function unsignedAmount(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.round(number) >>> 0 : undefined;
}

/**
 * L5c-review 3.09: the hand's coin picture (Wow.exe 0x00520880 → 0x00616510 → 0x007e7cc0): the icon
 * directory item icons use (0x00634910 row 3, as GetLFGCompletionRewardItem 0x00557f70 builds its
 * paths) and, by signed compares of the amount, INV_Misc_Coin_05 under 10 copper, _06 under 100,
 * _03 under 1 000, _04 under 10 000, _01 under 100 000, else _02.
 */
export function frameXmlCoinCursorTexture(amount: number): string {
  const coin = amount < 10 ? "05" : amount < 100 ? "06" : amount < 1_000 ? "03"
    : amount < 10_000 ? "04" : amount < 100_000 ? "01" : "02";
  return `Interface\\Icons\\INV_Misc_Coin_${coin}`;
}

/** The client's signed `ftol` of a Lua number argument (PickupTradeMoney). */
function signedAmount(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.trunc(number) | 0 : undefined;
}

export const FRAMEXML_CURSOR_MONEY_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  PickupPlayerMoney: (seam, args) => {
    const amount = unsignedAmount(args[0]);
    if (!seam.cursor || amount === undefined || amount === 0 || amount > seam.money()) return NOTHING;
    seam.cursor.pickupMoney("money", amount);
    return NOTHING;
  },
  DropCursorMoney: (seam) => {
    const held = seam.cursor?.money();
    if (held?.kind === "money" && held.amount !== 0) seam.cursor!.clear();
    return NOTHING;
  },
  GetCursorMoney: (seam) => [seam.cursor?.money()?.amount ?? 0],
  CursorHasMoney: (seam) => [seam.cursor?.money()?.kind === "money" ? 1 : undefined],
  PickupTradeMoney: (seam, args) => {
    const amount = signedAmount(args[0]);
    const trade = seam.trade;
    // L5c-review 3.09: only the trade stock TradeFrame shows (the deviation above, now enforced).
    if (!seam.cursor || !trade || trade.showing === false || amount === undefined || amount <= 0) return NOTHING;
    const offered = trade.playerMoney();
    if (amount > offered) return NOTHING;
    trade.setMoney(offered - amount);
    if (trade.playerMoney() === offered - amount) seam.cursor.pickupMoney("money", amount);
    return NOTHING;
  },
  AddTradeMoney: (seam) => {
    const held = seam.cursor?.money();
    const trade = seam.trade;
    if (!held || held.amount === 0 || !trade || trade.showing === false) return NOTHING; // L5c-review 3.09
    const total = trade.playerMoney() + held.amount;
    if (total > seam.money()) return NOTHING;
    trade.setMoney(total);
    if (trade.playerMoney() === total) seam.cursor!.dropMoneyQuietly();
    return NOTHING;
  },
});
