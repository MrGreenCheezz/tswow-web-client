/**
 * The offline mailbox: a scripted world for `CannedWorldSeam` and its tests, in the exact shapes
 * `SMSG_MAIL_LIST_RESULT` and `SMSG_SEND_MAIL_RESULT` parse into (MailProtocol.ts).
 *
 * Item names are this dataset's ruRU `item_template` names (the gateway's `/data/items`) and icons
 * its ItemDisplayInfo.InventoryIcon rows, both measured; the auction letters use TrinityCore's own
 * subject/body layouts (AuctionHouseMgr.cpp:949-967), so the stock invoice path runs on real text.
 * Commands only record; a test scripts the server's answer with `answer`/`deliver` and `emit`.
 */
import { EventBus, type MailStateChange } from "../../world/EventBus.js";
import {
  MAIL_AUCTION,
  MAIL_NORMAL,
  MAIL_OK,
  type MailAttachment,
  type MailCommandResult,
  type MailDraft,
  type MailEntry,
  type MailList,
} from "../../world/MailProtocol.js";
import {
  FrameXmlMailModel,
  type FrameXmlMailContext,
  type FrameXmlMailCursorItem,
  type FrameXmlMailItem,
  type FrameXmlMailWorld,
} from "./FrameXmlMail.js";

/** Measured: `/data/items` names and ItemDisplayInfo icons for the entries the fixtures use. */
export const FRAMEXML_CANNED_MAIL_ITEMS: ReadonlyMap<number, FrameXmlMailItem> = new Map([
  [13446, { name: "Огромный флакон с лечебным зельем", texture: "Interface\\Icons\\INV_Potion_54", quality: 1 }],
  [6948, { name: "Камень возвращения", texture: "Interface\\Icons\\INV_Misc_Rune_01", quality: 1 }],
  [2589, { name: "Льняной материал", texture: "Interface\\Icons\\INV_Fabric_Linen_01", quality: 1 }],
  [4306, { name: "Шелковый материал", texture: "Interface\\Icons\\INV_Fabric_Silk_01", quality: 1 }],
  [9311, { name: "Обычные письменные принадлежности", texture: "Interface\\Icons\\INV_Misc_Note_01", quality: 1 }],
]);

export const FRAMEXML_CANNED_MAILBOX_GUID = 0xf1100000000c350n;
const SENDER = 0x5001n;
const BIDDER = 0x5002n;

function attachment(position: number, attachId: number, itemId: number, count: number): MailAttachment {
  return {
    position, attachId, itemId, randomPropertiesId: 0, randomPropertiesSeed: 0, count,
    charges: 0, maxDurability: 0, durability: 0, unlocked: true,
  };
}

function letter(mailId: number, fields: Partial<MailEntry>): MailEntry {
  return {
    mailId, senderType: MAIL_NORMAL, senderGuid: 0n, altSenderId: 0, cod: 0, packageId: 0,
    stationeryId: 41, money: 0, flags: 0, daysLeft: 29.5, mailTemplateId: 0, subject: "", body: "",
    attachments: [], ...fields,
  };
}

/** Four letters: a player's gift with money, an auction win and a sale, and a read COD parcel. */
export function frameXmlCannedMailList(): MailList {
  return {
    totalCount: 4,
    mails: [
      letter(101, {
        senderGuid: SENDER, subject: "Зелья для рейда", money: 25_000, flags: 0x10,
        body: "Держи зелья и немного золота на ремонт. Увидимся в четверг!",
        attachments: [attachment(0, 9001, 13446, 5), attachment(1, 9002, 6948, 1)],
      }),
      letter(102, {
        senderType: MAIL_AUCTION, altSenderId: 2, stationeryId: 62, daysLeft: 29.9,
        // BuildAuctionMailSubject(AUCTION_WON) and BuildAuctionWonMailBody(owner, bid, buyout).
        subject: "2589:0:1:1234:20", body: `${BIDDER.toString(16).toUpperCase()}:1500:2000`,
        attachments: [attachment(0, 9003, 2589, 20)],
      }),
      letter(103, {
        senderType: MAIL_AUCTION, altSenderId: 2, stationeryId: 62, daysLeft: 29.8, money: 11_400,
        // AUCTION_SUCCESSFUL: bidder, bid, buyout, deposit, consignment.
        subject: "4306:0:2:1235:1", body: `${BIDDER.toString(16).toUpperCase()}:12000:15000:600:600`,
      }),
      letter(104, {
        senderGuid: SENDER, subject: "Шелк под оплату", cod: 50_000, flags: 0x01 | 0x10, daysLeft: 0.4,
        body: "Как договаривались.",
        attachments: [attachment(0, 9004, 4306, 10)],
      }),
    ],
  };
}

/** A command the canned mailbox received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedMailCall =
  | { readonly kind: "send"; readonly draft: MailDraft }
  | { readonly kind: "takeItem"; readonly mailId: number; readonly attachId: number }
  | { readonly kind: "takeMoney" | "read" | "delete" | "copyText"; readonly mailId: number }
  | { readonly kind: "return"; readonly mailId: number; readonly senderGuid: bigint }
  | { readonly kind: "close" | "requestList" };

/** One owned item of the offline bags, by GUID, at its wire position. */
export interface FrameXmlCannedMailBagItem {
  readonly entry: number;
  readonly count: number;
  readonly bag: number;
  readonly slot: number;
}

/**
 * The canned mailbox: `WorldClient`'s `mail*` fields and commands, plus the bags and cursor the
 * draft reads. `open()` stands in for SMSG_SHOW_MAILBOX and the list that follows it.
 */
export class FrameXmlCannedMailWorld implements FrameXmlMailWorld {
  readonly events = new EventBus<{ MAIL_STATE_CHANGED: MailStateChange }>();
  readonly calls: FrameXmlCannedMailCall[] = [];
  readonly names = new Map<bigint, string>([[SENDER, "Алистра"], [BIDDER, "Торвальд"]]);
  readonly state = { selfGuid: 0x1n as bigint | undefined };
  readonly selfName = "Кэннед";
  mailboxGuid = 0n;
  mail: MailList | undefined;
  mailResult: MailCommandResult | undefined;
  mailMessage: { readonly text: string; readonly error: boolean } | undefined;
  /** The offline bags by GUID (a potion stack and a hearthstone in the backpack's first slots). */
  readonly bags = new Map<bigint, FrameXmlCannedMailBagItem>([
    [0x4000_0001n, { entry: 13446, count: 5, bag: 255, slot: 23 }],
    [0x4000_0002n, { entry: 6948, count: 1, bag: 255, slot: 24 }],
  ]);
  cursor: FrameXmlMailCursorItem | undefined;

  emit(kind: MailStateChange["kind"]): void {
    this.events.emit("MAIL_STATE_CHANGED", { kind });
  }

  /** The mailbox opens with this list already answered, as a postmaster's window would. */
  open(list: MailList = frameXmlCannedMailList()): void {
    this.mailboxGuid = FRAMEXML_CANNED_MAILBOX_GUID;
    this.mailMessage = undefined;
    this.mailResult = undefined;
    this.emit("open");
    this.mail = list;
    this.emit("list");
  }

  /** Script one SMSG_SEND_MAIL_RESULT. */
  answer(result: Omit<MailCommandResult, "bagResult" | "attachId" | "quantityInInventory">
    & Partial<MailCommandResult>, message?: string): void {
    this.mailResult = { bagResult: 0, attachId: 0, quantityInInventory: 0, ...result };
    this.mailMessage = message ? { text: message, error: result.error !== MAIL_OK } : undefined;
    this.emit("result");
  }

  /** Script one SMSG_MAIL_LIST_RESULT. */
  deliver(list: MailList): void {
    this.mail = list;
    this.emit("list");
  }

  requestName(): void {}

  sendMail(draft: MailDraft): void { this.calls.push({ kind: "send", draft }); }
  takeMailItem(mailId: number, attachId: number): void { this.calls.push({ kind: "takeItem", mailId, attachId }); }
  takeMailMoney(mailId: number): void { this.calls.push({ kind: "takeMoney", mailId }); }
  markMailRead(mailId: number): void { this.calls.push({ kind: "read", mailId }); }
  deleteMail(mailId: number): void { this.calls.push({ kind: "delete", mailId }); }
  returnMail(mailId: number, senderGuid: bigint): void { this.calls.push({ kind: "return", mailId, senderGuid }); }
  copyMailText(mailId: number): void { this.calls.push({ kind: "copyText", mailId }); }
  requestMailList(): void { this.calls.push({ kind: "requestList" }); }

  closeMailbox(): void {
    this.calls.push({ kind: "close" });
    this.mail = undefined;
    this.mailboxGuid = 0n;
    this.mailMessage = undefined;
    this.mailResult = undefined;
    this.emit("closed");
  }
}

export interface FrameXmlCannedMail {
  readonly model: FrameXmlMailModel;
  readonly world: FrameXmlCannedMailWorld;
}

/** A model over the canned mailbox; `context` may add what a test needs (a creature name, …). */
export function createCannedFrameXmlMail(context: Partial<FrameXmlMailContext> = {}): FrameXmlCannedMail {
  const world = new FrameXmlCannedMailWorld();
  const model = new FrameXmlMailModel({
    world: () => world,
    item: (entry) => FRAMEXML_CANNED_MAIL_ITEMS.get(entry),
    itemObject: (guid) => {
      const item = world.bags.get(guid);
      return item ? { entry: item.entry, count: item.count } : undefined;
    },
    cursorItem: () => world.cursor,
    clearCursor: () => { world.cursor = undefined; },
    pickupItem: (guid) => {
      const item = world.bags.get(guid);
      world.cursor = item ? { guid, bag: item.bag, slot: item.slot } : undefined;
    },
    ...context,
  });
  return { model, world };
}
