/**
 * `GetInventoryAlertStatus` and `UPDATE_INVENTORY_ALERTS`: the armoured figure of DurabilityFrame
 * (DurabilityFrame.lua), the paper-doll slots (PaperDollFrame.lua:1223) and the action buttons
 * (ActionButton.lua:176) listen for the event.
 *
 * What the client does (Wow.exe 3.3.5a 12340, read 2026-09-30; notes in
 * .runtime/re-2026-09-30/tails/):
 * - It keeps twelve statuses (0x00c24238, count 12 set on entering the world by 0x005eaf30). The
 *   Lua function (0x005e7fa0) answers the 1-based index's stored value, 0 outside 1..12.
 * - One recompute (0x005e90d0) asks every status afresh (0x005e8fe0); when any differs from the
 *   stored one it stores them and raises UPDATE_INVENTORY_ALERTS, and then — whether or not
 *   anything changed — UPDATE_INVENTORY_DURABILITY. It runs on entering the world and from the
 *   item-field and inventory handlers. Here the alert half runs on the seam's poll; the durability
 *   half stays FrameXmlRepair.ts's (raised there on a change of wear) and is not raised again.
 * - Indices 1..11 are the equipment slots 0, 2, 4, 5, 6, 7, 8, 9, 15, 16, 17 (table 0x00a1ce4c,
 *   DurabilityFrame's own order). An item's status: `ITEM_FIELD_FLAGS` 0x10 → 2; wrapped (0x08) or
 *   no maximum durability → 0; durability 0 → 2 (broken); durability 5 or less → 1; otherwise 0.
 *   The «low» mark is an absolute five points, not a share of the maximum.
 * - Index 12 (table entry −1) is the ammo: while `PLAYER_AMMO_ID` names an entry, 1 when 20 or
 *   fewer of it are carried, else 0.
 */

import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

export const FRAMEXML_INVENTORY_ALERTS_EVENT = "UPDATE_INVENTORY_ALERTS";
/** The client's status count: eleven equipment slots and the ammo. */
export const FRAMEXML_INVENTORY_ALERT_COUNT = 12;
/** The ammo's 1-based index. */
export const FRAMEXML_INVENTORY_ALERT_AMMO = 12;

/** `ITEM_FIELD_FLAGS` bits the status reads (TrinityCore ItemTemplate.h: UNK2 and WRAPPED). */
const ITEM_FIELD_FLAG_ALERT_BROKEN = 0x10;
const ITEM_FIELD_FLAG_WRAPPED = 0x08;
/** Durability at or below this is «low» (0x005e90b2: `cmp eax, 5; ja`). */
const LOW_DURABILITY = 5;
/** Carried ammo at or below this is «low» (0x005e902b: `mov edx, 0x14; cmp edx, eax`). */
const LOW_AMMO = 20;
/** How often the statuses are compared, in seconds of the pump's clock (FrameXmlRepair.ts' cadence). */
const POLL_SECONDS = 0.25;

/**
 * An equipped item's status (0x005e9043..0x005e90c7) from its `ITEM_FIELD_FLAGS`,
 * `ITEM_FIELD_DURABILITY` and `ITEM_FIELD_MAXDURABILITY`; an unset field reads 0, as in the client.
 */
export function frameXmlItemAlertStatus(
  flags: number | undefined, durabilityField: number | undefined, maxDurability: number | undefined,
): number {
  if (((flags ?? 0) & ITEM_FIELD_FLAG_ALERT_BROKEN) !== 0) return 2;
  if (((flags ?? 0) & ITEM_FIELD_FLAG_WRAPPED) !== 0) return 0;
  if ((maxDurability ?? 0) >>> 0 === 0) return 0;
  const durability = (durabilityField ?? 0) >>> 0;
  if (durability === 0) return 2;
  return durability <= LOW_DURABILITY ? 1 : 0;
}

/** The ammo's status (0x005e8ff2..0x005e903b): no ammo entry is 0. */
export function frameXmlAmmoAlertStatus(ammoEntry: number | undefined, carried: number): number {
  if (ammoEntry === undefined || ammoEntry <= 0) return 0;
  return carried <= LOW_AMMO ? 1 : 0;
}

export interface FrameXmlInventoryAlerts {
  attach(pump: FrameXmlSeamPump): void;
  detach(): void;
  /** Once per seam poll, before the repair model's: UPDATE_INVENTORY_ALERTS when a status changed. */
  tick(): void;
}

/**
 * The stored statuses and their edge. `status(index)` answers the current one for a 1-based index.
 * The stored array starts at zeros on attach, as the client's does on entering the world, so the
 * first poll that finds worn gear raises the event a late-mounted DurabilityFrame needs.
 */
export function createFrameXmlInventoryAlerts(status: (index: number) => number): FrameXmlInventoryAlerts {
  let pump: FrameXmlSeamPump | undefined;
  const stored = new Uint8Array(FRAMEXML_INVENTORY_ALERT_COUNT);
  let polledAt = Number.NEGATIVE_INFINITY;
  return {
    attach(next) {
      pump = next;
      stored.fill(0);
      polledAt = Number.NEGATIVE_INFINITY;
    },
    detach() {
      pump = undefined;
    },
    tick() {
      if (!pump) return;
      const now = pump.now();
      if (now - polledAt < POLL_SECONDS) return;
      polledAt = now;
      let changed = false;
      for (let index = 0; index < FRAMEXML_INVENTORY_ALERT_COUNT; index++) {
        const next = status(index + 1);
        if (next !== stored[index]) {
          stored[index] = next;
          changed = true;
        }
      }
      if (changed) pump.fire(FRAMEXML_INVENTORY_ALERTS_EVENT);
    },
  };
}
