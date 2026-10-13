/**
 * Plan item 2.05 (13.10): the native interface's item locks around gift wrapping, as Wow.exe keeps one lock per item
 * (item+0x394 bit 0) that a mail draft's attachment, a trade slot, the auction sell slot, a socketing stage and the
 * waiting wrapping paper (0x006d67e0) all set.
 *
 * - A locked item is not wrapped: 0x006dcf20 eats the click, sends nothing, and the paper keeps waiting
 *   (game/GiftWrap.ts `wrapWithPendingPaper`). The stock seam reads its own models' locks (LiveWorldSeam
 *   `pickupContainerItem`); the native bags read these: the native mail draft (Mail.ts `mailDraftAttachments`) and
 *   this side's trade window (WorldClient `tradeOffersItem`). The native auction posts at once — no sell slot holds
 *   an item — and the native socketing window keeps no stage.
 * - The waiting paper itself is locked: a locked item is never picked up (PickupContainerItem) nor used
 *   (UseContainerItem asks the lock first, 0x005d8650), so it cannot be attached to a letter, offered in a trade or
 *   put up for auction. The native windows offer those as menu entries and pickers, which leave the paper out.
 */
import { game } from "../game/Context.js";
import { giftWrapLocks } from "../game/GiftWrap.js";

/** The native mail draft's attachments; Mail.ts registers its own (this module stays free of the page's DOM). */
let mailDraft: () => readonly bigint[] = () => [];

export function setNativeMailDraftSource(source: () => readonly bigint[]): void {
  mailDraft = source;
}

interface LockWorld {
  tradeOffersItem?(guid: bigint): boolean;
}

/** The waiting wrapping paper (0x006d67e0's lock): no letter, trade or auction takes it. */
export function nativePaperLocked(guid: bigint, world: object | undefined = game.world): boolean {
  return giftWrapLocks(world, guid);
}

/** Every native lock on a bag item: the paper, the mail draft, this side's trade window. */
export function nativeItemLocked(guid: bigint, world: (object & LockWorld) | undefined = game.world): boolean {
  if (guid === 0n || world === undefined) return false;
  return giftWrapLocks(world, guid) || mailDraft().includes(guid) || world.tradeOffersItem?.(guid) === true;
}
