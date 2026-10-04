/**
 * Plan item 5.28 (04.10, L6): what makes an item a letter the reader shows by its own text, as Wow.exe
 * 3.3.5a 12340 decides it (read 2026-10-04, descriptions only).
 *
 * - Using an item whose template has no PageText opens the reader instead when its ITEM_FIELD_FLAGS has
 *   ITEM_FIELD_FLAG_READABLE (0x200; CGItem use 0x708c20 → 0x58a1a0). TrinityCore sets that flag (with
 *   0x40000 and 0x80000, ITEM_FLAG_MAIL_TEXT_MASK) on the copy «Make a copy» creates
 *   (HandleMailCreateTextItem, MailHandler.cpp:600) and keeps the letter's body as the item's text.
 * - Such an item is read without CMSG_READ_ITEM: the reader asks the item-text cache, which sends
 *   CMSG_ITEM_TEXT_QUERY(guid) (answered by SMSG_ITEM_TEXT_QUERY_RESPONSE, ItemHandler.cpp:1261), and
 *   raises ITEM_TEXT_BEGIN then ITEM_TEXT_READY once the text is there (0x58a1a0 → 0x589e90). Using the
 *   item that is open closes it (ITEM_TEXT_CLOSED), as for any reader.
 * - `ItemTextGetCreator` (0x58a480) is the name of the open item's ITEM_FIELD_CREATOR — the sender of a
 *   copied ordinary letter (MailHandler.cpp:597) — from the name cache, nil while it is not there; its
 *   arrival raises BEGIN and READY again (0x58a450 → 0x58a1a0).
 */

import { UPDATE_FIELDS } from "../../generated/updateFields.js";

/** ITEM_FIELD_FLAG_READABLE (ItemTemplate.h:127). */
export const ITEM_FIELD_FLAG_READABLE = 0x200;

interface ItemFields {
  readonly fields: ReadonlyMap<number, number>;
}

/** Whether the item carries its own text (a mail copy). */
export function frameXmlItemIsMailText(item: ItemFields | undefined): boolean {
  return ((item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0) & ITEM_FIELD_FLAG_READABLE) !== 0;
}

/** The item's ITEM_FIELD_CREATOR; undefined when there is none. */
export function frameXmlItemCreator(item: ItemFields | undefined): bigint | undefined {
  const offset = UPDATE_FIELDS.ITEM_FIELD_CREATOR.offset;
  const low = BigInt((item?.fields.get(offset) ?? 0) >>> 0);
  const high = BigInt((item?.fields.get(offset + 1) ?? 0) >>> 0);
  const guid = (high << 32n) | low;
  return guid === 0n ? undefined : guid;
}
