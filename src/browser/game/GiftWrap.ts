import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { playerInventory } from "../Inventory.js";
import { ITEM_FIELD_FLAG_WRAPPED, ITEM_FLAG_IS_WRAPPER } from "../../world/GiftWrapProtocol.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";

/**
 * Gift wrapping (plan item 2.05, slice E), as Wow.exe does it:
 *
 * - `Item::Use` (0x00708c20), after a pending spell has had its chance at the item: a template with
 *   ITEM_FLAG_IS_WRAPPER (0x200) — unless the item is itself a wrapped gift (ITEM_FIELD_FLAGS 0x8,
 *   which opens instead, 0x006dce70) — becomes the pending paper (0x006d67e0: its guid in
 *   `DAT_00c9ead0`, the paper locked, cursor mode 2). Nothing is sent.
 * - `PickupContainerItem` (0x005d7ff0) with an empty hand, after the repair cursor: with paper
 *   pending (0x006cefb0) the clicked item gets wrapped (0x006dcf20) — CMSG_WRAP_ITEM with the
 *   paper's and the item's bag and slot, unless the item is locked — and the paper is let go
 *   (0x006cef80). Only a bag item: PickupInventoryItem does not look.
 * - Any cursor reset (0x00519280: ClearCursor, a right click in the world 0x0051fb00, Escape
 *   0x0051fa50) lets the paper go too.
 *
 * DOM-free; one pending paper per client, bound to the world it was armed in.
 */

export interface GiftWrapPlace {
  readonly bag: number;
  readonly slot: number;
  readonly guid: bigint;
}

export interface GiftWrapWorld {
  wrapItem?(giftBag: number, giftSlot: number, itemBag: number, itemSlot: number): boolean;
  /** The world's objects: 0x006dcf20 finds the paper by its guid and takes its bag and slot now. */
  readonly state?: WorldState;
}

/** Where the paper object is now (backpack or a bag), or undefined when the client holds none. */
function paperPlace(state: WorldState | undefined, guid: bigint): GiftWrapPlace | undefined {
  if (!state?.objects.has(guid)) return undefined;
  const inventory = playerInventory(state);
  if (!inventory) return undefined;
  for (const slot of inventory.backpack) if (slot.guid === guid) return slot;
  for (const bag of inventory.bags) for (const slot of bag.slots) if (slot.guid === guid) return slot;
  return undefined;
}

let pending: { readonly world: object; readonly paper: GiftWrapPlace } | undefined;
/** 5.17: who draws the armed paper's cast cursor (Controls.ts); told on every arm and release. */
const observers = new Set<(armed: boolean) => void>();

function setPending(next: typeof pending): void {
  const was = pending !== undefined;
  pending = next;
  if (was !== (next !== undefined)) for (const observer of observers) observer(next !== undefined);
}

/** 5.17: follow the paper going up (true) and down; the returned function stops following. */
export function observeGiftWrap(observer: (armed: boolean) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** Whether a used item is wrapping paper that arms the wrap cursor rather than being used. */
export function isWrappingPaper(item: WorldObjectState | undefined, templateFlags: number | undefined): boolean {
  if (!item || templateFlags === undefined || (templateFlags & ITEM_FLAG_IS_WRAPPER) === 0) return false;
  return ((item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0) & ITEM_FIELD_FLAG_WRAPPED) === 0;
}

/** 0x006d67e0: the paper waits for the item it wraps. A paper already pending is replaced. */
export function armGiftWrap(world: object | undefined, paper: GiftWrapPlace): boolean {
  if (!world || paper.guid === 0n) return false;
  setPending({ world, paper: { bag: paper.bag, slot: paper.slot, guid: paper.guid } });
  return true;
}

/** 0x006cefb0 for this world: the pending paper, or undefined. */
export function pendingGiftWrap(world: object | undefined): GiftWrapPlace | undefined {
  if (!pending) return undefined;
  if (pending.world !== world) {
    setPending(undefined);
    return undefined;
  }
  return pending.paper;
}

/** The paper is locked while it waits (0x00513740): a container slot shows it locked. */
export function giftWrapLocks(world: object | undefined, guid: bigint): boolean {
  return guid !== 0n && pendingGiftWrap(world)?.guid === guid;
}

/**
 * 0x006cefb0 without a world: whether any paper waits. Escape (0x0051fa50) and a right click on
 * the world (0x0051fb00) ask this before they reset the cursor, which lets it go.
 */
export function giftWrapPending(): boolean {
  return pending !== undefined;
}

/** 0x006cef80: the paper is let go. True when one was pending. */
export function cancelGiftWrap(): boolean {
  const had = pending !== undefined;
  setPending(undefined);
  return had;
}

/**
 * 0x006dcf20 on the clicked bag item: CMSG_WRAP_ITEM(paper, item) and the paper let go. `locked` is
 * the item's own lock (item+0x394 bit 0: mail draft, trade, auction, socket, the paper itself) —
 * then nothing is sent and the paper stays. True when this click was the wrap's (sent or not).
 */
export function wrapWithPendingPaper(
  world: GiftWrapWorld | undefined, target: GiftWrapPlace | undefined, locked: boolean,
): boolean {
  const paper = pendingGiftWrap(world);
  if (!paper || !world || !target || target.guid === 0n) return false;
  if (locked) return true;
  // The paper's bag and slot as they are now, looked up by its guid; with no paper object the
  // click is still the wrap's, nothing is sent and the paper stays pending (0x006dcf20). A world
  // without state (a test double) keeps the place it was armed at.
  const place = world.state ? paperPlace(world.state, paper.guid) : paper;
  if (!place) return true;
  setPending(undefined);
  world.wrapItem?.(place.bag, place.slot, target.bag, target.slot);
  return true;
}
