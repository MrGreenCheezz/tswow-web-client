import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: MailPackets.cpp (`MailListEntry` and
// `MailAttachedItem` serialisers, `SendMail::Read` and the take/delete/return reads),
// Player.cpp `SendMailResult`, and the enums in SharedDefines.h and Mail.h.

/** `MailMessageType` in Mail.h. Only `MAIL_NORMAL` carries a player GUID as the sender. */
export const MAIL_NORMAL = 0;
export const MAIL_AUCTION = 2;
export const MAIL_CREATURE = 3;
export const MAIL_GAMEOBJECT = 4;
export const MAIL_CALENDAR = 5;

/** `MailResponseType` in SharedDefines.h. */
export const MAIL_SEND = 0;
export const MAIL_MONEY_TAKEN = 1;
export const MAIL_ITEM_TAKEN = 2;
export const MAIL_RETURNED_TO_SENDER = 3;
export const MAIL_DELETED = 4;
/** `MAIL_MADE_PERMANENT`: HandleMailCreateTextItem's result command (MailHandler.cpp:576, :613). */
export const MAIL_MADE_PERMANENT = 5;

export const MAIL_OK = 0;
export const MAIL_ERR_EQUIP_ERROR = 1;
export const MAIL_ERR_ITEM_HAS_EXPIRED = 21;
/** `MAIL_CHECK_MASK_RETURNED` in Mail.h: a returned letter cannot be returned again. */
export const MAIL_CHECK_MASK_RETURNED = 0x02;

/** `MAX_INSPECTED_ENCHANTMENT_SLOT` in ItemDefines.h. */
const ENCHANTMENT_SLOTS = 7;

export interface MailAttachment {
  position: number;
  attachId: number;
  itemId: number;
  randomPropertiesId: number;
  randomPropertiesSeed: number;
  count: number;
  charges: number;
  maxDurability: number;
  durability: number;
  unlocked: boolean;
}

export interface MailEntry {
  mailId: number;
  senderType: number;
  /** Player senders arrive as a GUID; auction, creature and calendar mail sends an id instead. */
  senderGuid: bigint;
  altSenderId: number;
  cod: number;
  packageId: number;
  stationeryId: number;
  money: number;
  /** `mail->checked`: bit 1 means the letter has been read. */
  flags: number;
  daysLeft: number;
  mailTemplateId: number;
  subject: string;
  body: string;
  attachments: MailAttachment[];
}

export interface MailList {
  /** The server caps the packet at 50 letters even when more exist. */
  totalCount: number;
  mails: MailEntry[];
}

export function parseMailListResult(payload: Uint8Array): MailList {
  const reader = new PacketReader(payload);
  const totalCount = reader.i32();
  const count = reader.u8();
  const mails: MailEntry[] = [];
  for (let index = 0; index < count; index++) {
    reader.u16(); // entry size, already implied by the fields that follow
    const mailId = reader.i32();
    const senderType = reader.u8();
    let senderGuid = 0n;
    let altSenderId = 0;
    if (senderType === MAIL_NORMAL) senderGuid = reader.u64();
    else altSenderId = reader.i32();
    const entry: MailEntry = {
      mailId,
      senderType,
      senderGuid,
      altSenderId,
      cod: reader.u32(),
      packageId: reader.i32(),
      stationeryId: reader.i32(),
      money: reader.u32(),
      flags: reader.i32(),
      daysLeft: reader.f32(),
      mailTemplateId: reader.i32(),
      subject: reader.cString(),
      body: reader.cString(),
      attachments: [],
    };
    const attachmentCount = reader.u8();
    for (let slot = 0; slot < attachmentCount; slot++) {
      const position = reader.u8();
      const attachId = reader.i32();
      const itemId = reader.i32();
      // Seven enchantment slots, each three int32 wide, are skipped whole.
      for (let enchant = 0; enchant < ENCHANTMENT_SLOTS * 3; enchant++) reader.i32();
      entry.attachments.push({
        position,
        attachId,
        itemId,
        randomPropertiesId: reader.i32(),
        randomPropertiesSeed: reader.i32(),
        count: reader.i32(),
        charges: reader.i32(),
        maxDurability: reader.u32(),
        durability: reader.i32(),
        unlocked: reader.u8() !== 0,
      });
    }
    mails.push(entry);
  }
  return { totalCount, mails };
}

export interface MailCommandResult {
  mailId: number;
  command: number;
  error: number;
  /** Present only when the error is an equip failure. */
  bagResult: number;
  /** Present only for a successful or expired item pickup. */
  attachId: number;
  quantityInInventory: number;
}

export function parseMailCommandResult(payload: Uint8Array): MailCommandResult {
  const reader = new PacketReader(payload);
  const mailId = reader.u32();
  const command = reader.u32();
  const error = reader.u32();
  const result: MailCommandResult = { mailId, command, error, bagResult: 0, attachId: 0, quantityInInventory: 0 };
  if (error === MAIL_ERR_EQUIP_ERROR && reader.remaining >= 4) result.bagResult = reader.u32();
  if (command === MAIL_ITEM_TAKEN && (error === MAIL_OK || error === MAIL_ERR_ITEM_HAS_EXPIRED) && reader.remaining >= 8) {
    result.attachId = reader.u32();
    result.quantityInInventory = reader.u32();
  }
  return result;
}

/** `SMSG_RECEIVED_MAIL` carries only the delay before the letter shows up. */
export function parseReceivedMail(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const delay = reader.f32();
  reader.assertFinished();
  return delay;
}

export function buildGetMailList(mailboxGuid: bigint): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).toUint8Array();
}

export interface MailDraft {
  target: string;
  subject: string;
  body: string;
  money?: number;
  cod?: number;
  /** Item GUIDs to attach, in the order they should occupy the attachment slots. */
  attachments?: bigint[];
}

/** `SendMail::Read` ends with a uint64 and a uint8 it skips without using. */
export function buildSendMail(mailboxGuid: bigint, draft: MailDraft): Uint8Array {
  const attachments = draft.attachments ?? [];
  const writer = new PacketWriter()
    .u64(mailboxGuid)
    .cString(draft.target)
    .cString(draft.subject)
    .cString(draft.body)
    .i32(41) // stationery: the default parchment
    .i32(0)
    .u8(attachments.length);
  attachments.forEach((guid, position) => writer.u8(position).u64(guid));
  return writer.i32(draft.money ?? 0).i32(draft.cod ?? 0).u64(0n).u8(0).toUint8Array();
}

export function buildMailTakeItem(mailboxGuid: bigint, mailId: number, attachId: number): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).u32(attachId).toUint8Array();
}

export function buildMailTakeMoney(mailboxGuid: bigint, mailId: number): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).toUint8Array();
}

/**
 * `CMSG_MAIL_CREATE_TEXT_ITEM` (0x24A): `MailCreateTextItem::Read` is the mailbox GUID and the mail
 * id (MailPackets.cpp:170-174). The core copies the letter into a readable item and answers with
 * `SendMailResult(mailId, MAIL_MADE_PERMANENT, …)`.
 */
export function buildMailCreateTextItem(mailboxGuid: bigint, mailId: number): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).toUint8Array();
}

export function buildMailMarkAsRead(mailboxGuid: bigint, mailId: number): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).toUint8Array();
}

export function buildMailDelete(mailboxGuid: bigint, mailId: number, deleteReason = 0): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).u32(deleteReason).toUint8Array();
}

export function buildMailReturnToSender(mailboxGuid: bigint, mailId: number, senderGuid: bigint): Uint8Array {
  return new PacketWriter().u64(mailboxGuid).u32(mailId).u64(senderGuid).toUint8Array();
}

// `MailResponseResult` in SharedDefines.h.
const MAIL_ERRORS: Record<number, string> = {
  1: "Некуда положить предмет",
  2: "Нельзя отправить самому себе",
  3: "Не хватает денег",
  4: "Получатель не найден",
  5: "Игрок из другой фракции",
  6: "Внутренняя ошибка",
  14: "Недоступно для пробного аккаунта",
  15: "У получателя переполнена почта",
  16: "Нельзя отправить наложенным платежом упакованный предмет",
  17: "Почта и чат заблокированы",
  18: "Слишком много вложений",
  19: "Недопустимое вложение",
  21: "Срок хранения предмета истёк",
};

export function mailErrorText(error: number): string {
  return MAIL_ERRORS[error] ?? `Ошибка почты (код ${error})`;
}

/** `mail->checked` bit 1: the letter has already been opened. */
export function isMailRead(entry: MailEntry): boolean {
  return (entry.flags & 0x01) !== 0;
}

export function isMailReturnable(entry: MailEntry): boolean {
  return entry.senderType === MAIL_NORMAL && entry.senderGuid !== 0n
    && (entry.flags & MAIL_CHECK_MASK_RETURNED) === 0;
}

/**
 * A mailbox asking for its window.
 *
 * The guid is the postmaster's, and it is what every other mail opcode needs — so this is not a
 * notification but the handle the whole mail window is built on. It arrives from using a mailbox
 * gameobject, and also from a Postmaster NPC, which is why the field is not called "mailbox".
 */
export function parseShowMailbox(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}
