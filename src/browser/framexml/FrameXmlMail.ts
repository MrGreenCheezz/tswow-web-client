/**
 * The stock MailFrame's C API — `MailFrame.xml`/`MailFrame.lua`: InboxFrame, OpenMailFrame and
 * SendMailFrame — over this client's mailbox packets (`WorldClient.mail*`, MailProtocol.ts).
 *
 * Facts measured against the stock 3.3.5 Lua and the active TrinityCore that shape it:
 *
 * * Every inbox call takes a 1-based index into the server's list, which `SMSG_MAIL_LIST_RESULT`
 *   caps at 50 letters (`GetInboxNumItems` answers `shown, total`; InboxFrame_Update shows
 *   INBOX_TOO_MUCH_MAIL when they differ). An attachment index is the wire `position + 1`:
 *   MailListEntry numbers a letter's current items from 0 (MailPackets.cpp), so it is also what
 *   `TakeInboxItem(index, i)` names.
 * * The send draft is client memory, as it is in the client: `ClickSendMailItemButton` moves the item
 *   on the shared bag cursor into a slot, `SendMail` sends CMSG_SEND_MAIL with those GUIDs and the
 *   money or COD that `SetSendMailMoney`/`SetSendMailCOD` stored. Postage is TrinityCore's 30 copper
 *   per attachment, or 30 for a plain letter (MailHandler.cpp:119, FrameXmlServices.ts).
 * * Auction-house letters carry machine text (AuctionHouseMgr.cpp:949-967): the subject is
 *   `entry:random:response:auctionId:count` and the body `guidHex:bid:buyout[:deposit:cut[:delay:eta]]`.
 *   The client turns them into AUCTION_*_MAIL_SUBJECT and the invoice; the subject is formatted in
 *   Lua (`FRAMEXML_MAIL_PRELUDE`) because those strings are GlobalStrings.lua's.
 *
 * The model fires the stock events from `MAIL_STATE_CHANGED` (WorldClient emits it beside the native
 * window's `onMailChanged`). MAIL_SHOW — the one event that opens a window — fires only while the
 * world mount has published the stock owner (`owned`), so a failed gate never shows two windows.
 */
import type { MailStateChange } from "../../world/EventBus.js";
import { equipErrorText } from "../../world/ItemProtocol.js";
import {
  MAIL_AUCTION,
  MAIL_CHECK_MASK_RETURNED,
  MAIL_CREATURE,
  MAIL_ERR_EQUIP_ERROR,
  MAIL_NORMAL,
  MAIL_OK,
  MAIL_SEND,
  isMailRead,
  isMailReturnable,
  type MailCommandResult,
  type MailDraft,
  type MailEntry,
  type MailList,
} from "../../world/MailProtocol.js";
import { itemChatLink } from "../ui/ChatLink.js";
import { frameXmlLootCoinIcon } from "./FrameXmlLoot.js";
import {
  FRAMEXML_MAX_SEND_ATTACHMENTS,
  FRAMEXML_SERVICE_BINDINGS,
  MAIL_POSTAGE_PER_ATTACHMENT_COPPER,
  createFrameXmlServices,
  type FrameXmlSendMailItem,
  type FrameXmlServices,
} from "./FrameXmlServices.js";

/** `ATTACHMENTS_MAX_RECEIVE` (MailFrame.lua:9): OpenMailFrame asks for this many items per letter. */
export const FRAMEXML_MAIL_ATTACHMENTS_RECEIVE = 16;
/** `MAIL_CHECK_MASK_COPIED` (Mail.h:49): the letter's text was already made into an item. */
const MAIL_CHECK_MASK_COPIED = 0x04;
/** `MAIL_CHECK_MASK_HAS_BODY` (Mail.h:51). */
const MAIL_CHECK_MASK_HAS_BODY = 0x10;
/** CMSG_SEND_MAIL writes stationery 41 (MailProtocol.buildSendMail); stock selects row 1 of its list. */
const DEFAULT_STATIONERY = 41;
/** Stationery.dbc's GM row: `GetInboxHeaderInfo`'s `isGM`. */
const GM_STATIONERY = 61;
/** Player.cpp `MAX_MONEY_AMOUNT`. */
const MAX_MONEY_COPPER = 0x7fffffff;

/**
 * Stationery.dbc of this dataset (7 rows, measured): the background texture stem OpenMailFrame and
 * SendMailFrame append `1`/`2` to, and the stationery item's icon (its ItemDisplayInfo.InventoryIcon)
 * that the inbox shows for a letter without an item.
 */
const STATIONERY: ReadonlyMap<number, { readonly texture: string; readonly icon: string }> = new Map([
  [1, { texture: "STATIONERYTEST", icon: "Interface\\Icons\\INV_Scroll_01" }],
  [41, { texture: "STATIONERYTEST", icon: "Interface\\Icons\\INV_Misc_Note_01" }],
  [61, { texture: "GMSTATIONERY", icon: "Interface\\Icons\\Mail_GMIcon" }],
  [62, { texture: "AUCTIONSTATIONERY", icon: "Interface\\Icons\\INV_Scroll_03" }],
  [64, { texture: "STATIONERY_VAL", icon: "Interface\\Icons\\INV_ValentinesCard01" }],
  [65, { texture: "STATIONERY_CHR", icon: "Interface\\Icons\\INV_Misc_Note_01" }],
  [67, { texture: "Stationery_Orp", icon: "Interface\\Icons\\INV_Letter_18" }],
]);

/** AuctionHouse.dbc of this dataset (7 rows, ruRU): an auction letter's sender is its house id. */
const AUCTION_HOUSES: ReadonlyMap<number, string> = new Map([
  [1, "Аукционный дом Штормграда"],
  [2, "Аукционный дом Альянса"],
  [3, "Аукционный дом Дарнаса"],
  [4, "Аукционный дом Подгорода"],
  [5, "Аукционный дом Громового Утеса"],
  [6, "Аукционный дом Орды"],
  [7, "Аукционный дом Черноводья"],
]);

/** `MailAuctionAnswers` (AuctionHouseMgr.h:57-66). */
const AUCTION_WON = 1;
const AUCTION_SUCCESSFUL = 2;
const AUCTION_SALE_PENDING = 6;

/** One auction letter's machine subject, `entry:random:response:auctionId:count`. */
export interface FrameXmlAuctionSubject {
  readonly entry: number;
  readonly randomPropertyId: number;
  readonly response: number;
  readonly count: number;
}

/** Parse BuildAuctionMailSubject's text; anything else is an ordinary subject. */
export function frameXmlAuctionSubject(entry: MailEntry): FrameXmlAuctionSubject | undefined {
  if (entry.senderType !== MAIL_AUCTION) return undefined;
  const parts = entry.subject.split(":");
  if (parts.length < 3 || !parts.every((part) => /^-?\d+$/.test(part))) return undefined;
  const [itemEntry, random, response, , count] = parts.map(Number);
  if (!Number.isSafeInteger(itemEntry) || itemEntry! <= 0 || response === undefined) return undefined;
  return { entry: itemEntry!, randomPropertyId: random ?? 0, response, count: count ?? 1 };
}

/** The invoice half of an auction letter: BuildAuction{Won,Sold,Invoice}MailBody's colon list. */
export interface FrameXmlAuctionInvoice {
  readonly type: "buyer" | "seller" | "seller_temp_invoice";
  readonly playerGuid: bigint;
  readonly bid: number;
  readonly buyout: number;
  readonly deposit: number;
  readonly consignment: number;
  /** `CONFIG_MAIL_DELIVERY_DELAY` in seconds, only on the temporary invoice. */
  readonly moneyDelay: number;
  /** WowTime::GetPackedTime's hour and minute fields of the funds' arrival. */
  readonly etaHour: number;
  readonly etaMinute: number;
}

export function frameXmlAuctionInvoice(entry: MailEntry): FrameXmlAuctionInvoice | undefined {
  const subject = frameXmlAuctionSubject(entry);
  const type = subject?.response === AUCTION_WON ? "buyer"
    : subject?.response === AUCTION_SUCCESSFUL ? "seller"
    : subject?.response === AUCTION_SALE_PENDING ? "seller_temp_invoice" : undefined;
  if (!type) return undefined;
  const parts = entry.body.split(":");
  if (!/^[0-9A-Fa-f]{1,16}$/.test(parts[0] ?? "") || !parts.slice(1).every((part) => /^\d+$/.test(part))) return undefined;
  const numbers = parts.slice(1).map(Number);
  const needed = type === "buyer" ? 2 : type === "seller" ? 4 : 6;
  if (numbers.length < needed) return undefined;
  const eta = numbers[5] ?? 0;
  return {
    type,
    playerGuid: BigInt(`0x${parts[0]}`),
    bid: numbers[0] ?? 0,
    buyout: numbers[1] ?? 0,
    deposit: numbers[2] ?? 0,
    consignment: numbers[3] ?? 0,
    moneyDelay: numbers[4] ?? 0,
    etaHour: (eta >>> 6) & 0x1f,
    etaMinute: eta & 0x3f,
  };
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlMailWorld {
  readonly events?: {
    on(name: "MAIL_STATE_CHANGED", listener: (change: MailStateChange) => void): () => void;
  } | undefined;
  readonly mailboxGuid: bigint;
  readonly mail: MailList | undefined;
  readonly mailResult: MailCommandResult | undefined;
  readonly mailMessage: { readonly text: string; readonly error: boolean } | undefined;
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  readonly selfName?: string | undefined;
  readonly state?: { readonly selfGuid?: bigint | undefined } | undefined;
  requestName?(guid: bigint): void;
  sendMail(draft: MailDraft): void;
  takeMailItem(mailId: number, attachId: number): void;
  takeMailMoney(mailId: number): void;
  markMailRead(mailId: number): void;
  deleteMail(mailId: number): void;
  returnMail(mailId: number, senderGuid: bigint): void;
  closeMailbox(): void;
  requestMailList?(): void;
  copyMailText?(mailId: number): void;
}

export interface FrameXmlMailItem {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** The live object behind an owned item GUID. */
export interface FrameXmlMailItemObject {
  readonly entry: number;
  readonly count: number;
}

/** The item on the shared bag cursor, in wire bag/slot coordinates (LiveWorldSeam's cursor). */
export interface FrameXmlMailCursorItem {
  readonly guid: bigint;
  readonly bag: number;
  readonly slot: number;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlMailContext {
  world(): FrameXmlMailWorld | undefined;
  /** Cache-only item presentation; a C-API read never starts a fetch. */
  item(entry: number): FrameXmlMailItem | undefined;
  /** The owned item behind a draft GUID, or undefined once it left the inventory. */
  itemObject(guid: bigint): FrameXmlMailItemObject | undefined;
  /** An exact link for an owned item (the inventory's enchant/random/suffix), when the host has one. */
  itemLink?(guid: bigint): string | undefined;
  cursorItem(): FrameXmlMailCursorItem | undefined;
  clearCursor(): void;
  /** Put an owned item back on the cursor: stock picks an attachment up when its slot is clicked. */
  pickupItem?(guid: bigint): void;
  /** creature_template name for a creature sender (`MAIL_CREATURE` letters send the entry). */
  creatureName?(entry: number): string | undefined;
  /** Load item metadata outside a C-API read; `onChanged` runs once the cache moved. */
  prefetchItems?(entries: readonly number[], onChanged: () => void): void;
  /** The set of attached items changed: the bags repaint their lock state (`attached`). */
  locksChanged?(): void;
}

interface FrameXmlMailPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

/** `GetInboxHeaderInfo`'s fourteen values, in the order MailFrame.lua:154 and :447 read them. */
export type FrameXmlInboxHeader = readonly [
  packageIcon: string | undefined,
  stationeryIcon: string | undefined,
  sender: string | undefined,
  subject: string,
  money: number,
  cod: number,
  daysLeft: number,
  itemCount: number | undefined,
  wasRead: boolean,
  wasReturned: boolean,
  textCreated: boolean,
  canReply: boolean,
  isGM: boolean,
  firstItemQuantity: number | undefined,
];

const EMPTY_SEND_ITEM: FrameXmlSendMailItem = Object.freeze([undefined, undefined, 0, undefined]);

function copperArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_MONEY_COPPER ? number : undefined;
}

/**
 * One owner of the stock mail C API. Client-held state — the send draft, its money/COD, which tab
 * is showing, letters read this visit — lives here as the client keeps it; server state is read
 * from the world on every call.
 */
export class FrameXmlMailModel {
  readonly #context: FrameXmlMailContext;
  #pump: FrameXmlMailPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #owned = false;
  #muted = false;
  /** The mailbox stock was sent MAIL_SHOW for; 0n while the stock window has no mailbox. */
  #shown = 0n;
  /** Letters opened this visit: CMSG_MAIL_MARK_AS_READ changes `checked` only in the next list. */
  readonly #read = new Set<number>();
  readonly #draft: (bigint | undefined)[] = Array.from({ length: FRAMEXML_MAX_SEND_ATTACHMENTS }, () => undefined);
  #money = 0;
  #cod = 0;
  #sendShowing = false;
  #stationery = 1;
  /** The last `mailResult` seen; a result is an edge only when the world holds a new object. */
  #result: MailCommandResult | undefined;
  /** What the inbox and the draft still waited for at the last repaint (see `tick`). */
  #metadataSignature = "";
  #draftMetadataSignature = "0";
  #metadataCheckedAt = Number.NEGATIVE_INFINITY;
  readonly #prefetched = new Set<number>();

  constructor(context: FrameXmlMailContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlMailPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    // A world without an event bus (older fakes) answers the C API and simply raises no events.
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("MAIL_STATE_CHANGED", (change) => this.#onState(change));
    }
    // A result already on the world is history, not an answer to anything stock sent.
    this.#result = world?.mailResult;
    this.#shown = 0n;
    this.#metadataSignature = "";
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#owned = false;
    this.#shown = 0n;
    this.#clearDraft(false);
  }

  /**
   * Whether the stock MailFrame owns the mailbox route (set by the world mount once its owner is
   * published). Taking ownership is an edge: a mailbox already open is handed to stock with
   * MAIL_SHOW, because nothing else would open it (the server does not repeat SMSG_SHOW_MAILBOX).
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    if (!owned) {
      this.#shown = 0n;
      this.#clearDraft(false);
      return;
    }
    const world = this.#context.world();
    if (world && world.mailboxGuid !== 0n) this.#show(world);
  }

  /** Whether stock is showing a mailbox now (MAIL_SHOW sent, MAIL_CLOSED not yet). */
  get showing(): boolean { return this.#shown !== 0n; }

  /** Run a transactional probe (the mount's gate) without sending a packet or closing the mailbox. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #command(run: (world: FrameXmlMailWorld) => void): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world && world.mailboxGuid !== 0n) run(world);
  }

  /** Per rendered frame: repaint once item names/icons or sender names arrive (≤ 4 checks a second). */
  tick(): void {
    const pump = this.#pump;
    if (!pump || this.#shown === 0n) return;
    const now = pump.now();
    if (now - this.#metadataCheckedAt < 0.25) return;
    this.#metadataCheckedAt = now;
    const inbox = this.#inboxSignature();
    if (inbox !== this.#metadataSignature) {
      this.#metadataSignature = inbox;
      pump.fire("MAIL_INBOX_UPDATE");
    }
    const draft = this.#draftSignature();
    if (draft !== this.#draftMetadataSignature) {
      this.#draftMetadataSignature = draft;
      pump.fire("MAIL_SEND_INFO_UPDATE");
    }
  }

  // ---- the inbox -------------------------------------------------------------------------

  #list(): MailList | undefined {
    const world = this.#context.world();
    return world && world.mailboxGuid !== 0n ? world.mail : undefined;
  }

  #entry(index: unknown): MailEntry | undefined {
    const number = typeof index === "number" ? index : Number(index);
    if (!Number.isInteger(number) || number < 1) return undefined;
    return this.#list()?.mails[number - 1];
  }

  /** `GetInboxNumItems`: letters in the list, and how many the server holds (the 50-letter cap). */
  numItems(): readonly [shown: number, total: number] {
    const list = this.#list();
    if (!list) return [0, 0];
    return [list.mails.length, Math.max(list.mails.length, list.totalCount)];
  }

  #sender(entry: MailEntry): string | undefined {
    const world = this.#context.world();
    if (entry.senderType === MAIL_NORMAL) {
      if (entry.senderGuid === 0n) return undefined;
      return world?.names?.get(entry.senderGuid)
        ?? (entry.senderGuid === world?.state?.selfGuid ? world?.selfName : undefined);
    }
    if (entry.senderType === MAIL_AUCTION) return AUCTION_HOUSES.get(entry.altSenderId);
    if (entry.senderType === MAIL_CREATURE) return this.#context.creatureName?.(entry.altSenderId);
    return undefined;
  }

  #stationeryIcon(entry: MailEntry): string | undefined {
    return (STATIONERY.get(entry.stationeryId) ?? STATIONERY.get(DEFAULT_STATIONERY))?.icon;
  }

  #attachment(entry: MailEntry, index: unknown) {
    const number = typeof index === "number" ? index : Number(index);
    if (!Number.isInteger(number) || number < 1 || number > FRAMEXML_MAIL_ATTACHMENTS_RECEIVE) return undefined;
    return entry.attachments.find((attachment) => attachment.position === number - 1);
  }

  headerInfo(index: unknown): FrameXmlInboxHeader | undefined {
    const entry = this.#entry(index);
    if (!entry) return undefined;
    const first = [...entry.attachments].sort((left, right) => left.position - right.position)[0];
    const packageIcon = first ? this.#context.item(first.itemId)?.texture : undefined;
    return [
      packageIcon,
      this.#stationeryIcon(entry),
      this.#sender(entry),
      entry.subject,
      entry.money,
      entry.cod,
      entry.daysLeft,
      entry.attachments.length > 0 ? entry.attachments.length : undefined,
      isMailRead(entry) || this.#read.has(entry.mailId),
      (entry.flags & MAIL_CHECK_MASK_RETURNED) !== 0,
      (entry.flags & MAIL_CHECK_MASK_COPIED) !== 0,
      entry.senderType === MAIL_NORMAL && entry.senderGuid !== 0n,
      entry.stationeryId === GM_STATIONERY,
      first?.count,
    ];
  }

  /** The prelude's auction subject: the `MailAuctionAnswers` code and the item's cached name. */
  auctionSubject(index: unknown): readonly [response: number, itemName: string] | undefined {
    const entry = this.#entry(index);
    const subject = entry ? frameXmlAuctionSubject(entry) : undefined;
    const name = subject ? this.#context.item(subject.entry)?.name : undefined;
    return subject && name ? [subject.response, name] : undefined;
  }

  /**
   * `GetInboxText`: body, stationery texture stem, whether the text can be made into an item, and
   * whether it is an auction invoice. Reading a letter is what marks it read, as in the client
   * (CMSG_MAIL_MARK_AS_READ; the next list carries the flag).
   */
  text(index: unknown): readonly [body: string, texture: string, isTakeable: boolean, isInvoice: boolean] | undefined {
    const entry = this.#entry(index);
    if (!entry) return undefined;
    if (!isMailRead(entry) && !this.#read.has(entry.mailId) && !this.#muted) {
      this.#read.add(entry.mailId);
      this.#command((world) => world.markMailRead(entry.mailId));
    }
    const auction = entry.senderType === MAIL_AUCTION && frameXmlAuctionSubject(entry) !== undefined;
    const invoice = auction && this.#invoiceNames(entry) !== undefined;
    const body = auction ? "" : entry.body;
    const takeable = !auction && (body.length > 0 || entry.mailTemplateId !== 0
      || (entry.flags & MAIL_CHECK_MASK_HAS_BODY) !== 0);
    const texture = (STATIONERY.get(entry.stationeryId) ?? STATIONERY.get(DEFAULT_STATIONERY))!.texture;
    return [body, texture, takeable, invoice];
  }

  /**
   * An auction letter's invoice with the two names stock needs, or undefined until both are
   * cached. Once `playerName` is set, every invoice branch of OpenMail_Update concatenates
   * `itemName` unguarded (MailFrame.lua:481, :502, :536); measured before this, an uncached item
   * raised «attempt to concatenate nil» there on every MAIL_INBOX_UPDATE. And with `isInvoice` set
   * but no `playerName`, stock would leave OpenMailInvoiceFrame showing the previous letter's
   * invoice (its Hide is only the `not isInvoice` branch, :562), so `GetInboxText` calls the
   * letter an invoice only from here; the metadata tick repaints it when the names arrive.
   */
  #invoiceNames(entry: MailEntry): { readonly invoice: FrameXmlAuctionInvoice; readonly item: string; readonly player: string } | undefined {
    const invoice = frameXmlAuctionInvoice(entry);
    const subject = invoice ? frameXmlAuctionSubject(entry) : undefined;
    const item = subject ? this.#context.item(subject.entry)?.name : undefined;
    const player = invoice ? this.#context.world()?.names?.get(invoice.playerGuid) : undefined;
    return invoice && item && player ? { invoice, item, player } : undefined;
  }

  invoiceInfo(index: unknown): readonly unknown[] | undefined {
    const entry = this.#entry(index);
    const invoice = entry ? frameXmlAuctionInvoice(entry) : undefined;
    if (!entry || !invoice) return undefined;
    const ready = this.#invoiceNames(entry);
    // Only the type while a name is missing: OpenMailFrame_OnHide reads it to keep a pending sale.
    if (!ready) return [invoice.type];
    return [invoice.type, ready.item, ready.player, invoice.bid, invoice.buyout,
      invoice.deposit, invoice.consignment, invoice.moneyDelay, invoice.etaHour, invoice.etaMinute];
  }

  /** `GetInboxItem(index, i)`: name, texture, count, quality, canUse; nothing for an empty slot. */
  item(index: unknown, attachIndex: unknown): readonly unknown[] | undefined {
    const entry = this.#entry(index);
    const attachment = entry ? this.#attachment(entry, attachIndex) : undefined;
    if (!attachment) return undefined;
    const item = this.#context.item(attachment.itemId);
    if (!item) return undefined;
    // Usability needs class/skill/level rules this client does not model; white is stock's default.
    return [item.name, item.texture, attachment.count, item.quality ?? 1, true];
  }

  itemLink(index: unknown, attachIndex: unknown): string | undefined {
    const entry = this.#entry(index);
    const attachment = entry ? this.#attachment(entry, attachIndex) : undefined;
    const item = attachment ? this.#context.item(attachment.itemId) : undefined;
    return attachment && item
      ? itemChatLink(attachment.itemId, item.quality ?? 1, item.name, 0, attachment.randomPropertiesId) : undefined;
  }

  /**
   * `InboxItemCanDelete`: false exactly when the letter still has something to give back to a
   * player sender (stock then offers MAIL_RETURN). MailHandler.cpp refuses to delete a COD letter.
   */
  canDelete(index: unknown): boolean {
    const entry = this.#entry(index);
    if (!entry) return false;
    return !(isMailReturnable(entry) && (entry.money > 0 || entry.cod > 0 || entry.attachments.length > 0));
  }

  takeItem(index: unknown, attachIndex: unknown): void {
    const entry = this.#entry(index);
    const attachment = entry ? this.#attachment(entry, attachIndex) : undefined;
    if (entry && attachment) this.#command((world) => world.takeMailItem(entry.mailId, attachment.attachId));
  }

  takeMoney(index: unknown): void {
    const entry = this.#entry(index);
    if (entry && entry.money > 0) this.#command((world) => world.takeMailMoney(entry.mailId));
  }

  takeText(index: unknown): void {
    const entry = this.#entry(index);
    if (entry) this.#command((world) => world.copyMailText?.(entry.mailId));
  }

  /** `AutoLootMailItem`: the money and every item, each its own request as the server takes them. */
  autoLoot(index: unknown): void {
    const entry = this.#entry(index);
    if (!entry || entry.cod > 0) return;
    this.#command((world) => {
      if (entry.money > 0) world.takeMailMoney(entry.mailId);
      for (const attachment of entry.attachments) world.takeMailItem(entry.mailId, attachment.attachId);
    });
  }

  delete(index: unknown): void {
    const entry = this.#entry(index);
    if (entry) this.#command((world) => world.deleteMail(entry.mailId));
  }

  returnToSender(index: unknown): void {
    const entry = this.#entry(index);
    if (entry && isMailReturnable(entry)) this.#command((world) => world.returnMail(entry.mailId, entry.senderGuid));
  }

  /**
   * `CheckInbox`. The world already asked for the list when the mailbox opened, so this asks again
   * only for more: when the server holds letters beyond the 50 it sent (InboxGetMoreMail).
   */
  checkInbox(): void {
    const list = this.#list();
    if (list && list.totalCount > list.mails.length) this.#command((world) => world.requestMailList?.());
  }

  /** `CloseMail`: MailFrame's OnHide. The mailbox is the server's; closing it is ours. */
  close(): void {
    this.#command((world) => world.closeMailbox());
  }

  // ---- the send draft --------------------------------------------------------------------

  /** Whether the stock draft is the one GetSendMailItem/Price answer (the stock owner is published). */
  get ownsDraft(): boolean { return this.#owned; }

  #draftItem(slot: number): { readonly guid: bigint; readonly object: FrameXmlMailItemObject } | undefined {
    const guid = this.#draft[slot];
    if (guid === undefined) return undefined;
    const object = this.#context.itemObject(guid);
    return object ? { guid, object } : undefined;
  }

  /** The GUIDs still in the inventory, in slot order: what CMSG_SEND_MAIL attaches. */
  draftGuids(): bigint[] {
    const guids: bigint[] = [];
    for (let slot = 0; slot < this.#draft.length; slot += 1) {
      const item = this.#draftItem(slot);
      if (item) guids.push(item.guid);
    }
    return guids;
  }

  /** Items attached to the draft, which the bags show locked as the client does. */
  attached(guid: bigint): boolean {
    return this.#owned && this.#draft.includes(guid);
  }

  sendMailItem(slot: unknown): FrameXmlSendMailItem {
    const number = typeof slot === "number" ? slot : Number(slot);
    if (!Number.isInteger(number) || number < 1 || number > FRAMEXML_MAX_SEND_ATTACHMENTS) return EMPTY_SEND_ITEM;
    const draft = this.#draftItem(number - 1);
    if (!draft) return EMPTY_SEND_ITEM;
    const item = this.#context.item(draft.object.entry);
    return [item?.name, item?.texture, draft.object.count, item?.quality];
  }

  sendMailItemLink(slot: unknown): string | undefined {
    const number = typeof slot === "number" ? slot : Number(slot);
    if (!Number.isInteger(number) || number < 1 || number > FRAMEXML_MAX_SEND_ATTACHMENTS) return undefined;
    const draft = this.#draftItem(number - 1);
    if (!draft) return undefined;
    const exact = this.#context.itemLink?.(draft.guid);
    if (exact) return exact;
    const item = this.#context.item(draft.object.entry);
    return item ? itemChatLink(draft.object.entry, item.quality ?? 1, item.name) : undefined;
  }

  sendMailPrice(): number {
    return MAIL_POSTAGE_PER_ATTACHMENT_COPPER * Math.max(1, this.draftGuids().length);
  }

  sendMoney(): number { return this.#money; }
  sendCod(): number { return this.#cod; }

  /** `SetSendMailMoney`: stored for the next SendMail; the server refuses what the player lacks. */
  setSendMoney(value: unknown): boolean {
    const copper = copperArg(value);
    if (copper === undefined) return false;
    this.#money = copper;
    this.#pump?.fire("SEND_MAIL_MONEY_CHANGED");
    return true;
  }

  setSendCod(value: unknown): void {
    const copper = copperArg(value);
    if (copper === undefined) return;
    this.#cod = copper;
    this.#pump?.fire("SEND_MAIL_COD_CHANGED");
  }

  /** `SetSendMailShowing`: the send tab is up, so a right-clicked bag item attaches (UseContainerItem). */
  setSendShowing(showing: boolean): void {
    this.#sendShowing = showing;
  }

  get sendShowing(): boolean { return this.#sendShowing && this.#shown !== 0n; }

  /**
   * `ClickSendMailItemButton(slot, clear)`: the cursor's item goes into `slot` (the first free one
   * when stock passes none — a drop on the letter), swapping a held attachment back onto the cursor.
   * With an empty cursor the attachment is picked up again; `clear` (a right click) just removes it.
   */
  clickSendItem(slotArg: unknown, clear: boolean): void {
    if (this.#muted) return;
    const cursor = this.#context.cursorItem();
    const number = typeof slotArg === "number" ? slotArg : Number(slotArg);
    const explicit = Number.isInteger(number) && number >= 1 && number <= FRAMEXML_MAX_SEND_ATTACHMENTS
      ? number - 1 : undefined;
    if (cursor) {
      const existing = this.#draft.indexOf(cursor.guid);
      if (existing >= 0) {
        // Dropping an attachment back on the letter: the client leaves it where it is.
        this.#context.clearCursor();
        return;
      }
      const slot = explicit ?? this.#draft.findIndex((guid, index) => guid === undefined || !this.#draftItem(index));
      if (slot < 0 || slot === undefined) return;
      const previous = this.#draftItem(slot)?.guid;
      this.#draft[slot] = cursor.guid;
      this.#context.clearCursor();
      if (previous !== undefined) this.#context.pickupItem?.(previous);
      this.#pump?.fire("MAIL_SEND_INFO_UPDATE");
      this.#context.locksChanged?.();
      return;
    }
    if (explicit === undefined) return;
    const held = this.#draftItem(explicit)?.guid;
    if (held === undefined) return;
    this.#draft[explicit] = undefined;
    if (!clear) this.#context.pickupItem?.(held);
    this.#pump?.fire("MAIL_SEND_INFO_UPDATE");
    this.#context.locksChanged?.();
  }

  /** A right-clicked bag item while the send tab shows: attach it to the first free slot. */
  useItem(guid: bigint): boolean {
    if (!this.#owned || !this.sendShowing || this.#muted) return false;
    if (this.#draft.includes(guid)) return true;
    const slot = this.#draft.findIndex((held, index) => held === undefined || !this.#draftItem(index));
    if (slot < 0) return true;
    this.#draft[slot] = guid;
    this.#pump?.fire("MAIL_SEND_INFO_UPDATE");
    this.#context.locksChanged?.();
    return true;
  }

  /** `SendMail(recipient, subject, body)`: the draft's GUIDs with the stored money or COD. */
  send(recipient: unknown, subject: unknown, body: unknown): void {
    const target = typeof recipient === "string" ? recipient.trim() : "";
    if (!target) return;
    const attachments = this.draftGuids();
    const cod = attachments.length > 0 ? this.#cod : 0;
    this.#command((world) => world.sendMail({
      target,
      subject: typeof subject === "string" ? subject : "",
      body: typeof body === "string" ? body : "",
      money: this.#money,
      ...(cod > 0 ? { cod } : {}),
      attachments,
    }));
  }

  #clearDraft(fire: boolean): void {
    const attached = this.#draft.some((guid) => guid !== undefined);
    const had = attached || this.#money !== 0 || this.#cod !== 0;
    this.#draft.fill(undefined);
    this.#money = 0;
    this.#cod = 0;
    this.#sendShowing = false;
    if (fire && had) this.#pump?.fire("MAIL_SEND_INFO_UPDATE");
    if (attached) this.#context.locksChanged?.();
  }

  // ---- stationery ------------------------------------------------------------------------

  /** 3.3.5's send frame lists the free default stationery only (CMSG_SEND_MAIL writes row 41). */
  numStationeries(): number { return 1; }

  stationeryInfo(index: unknown): readonly unknown[] | undefined {
    if (Number(index) !== 1) return undefined;
    // Stationery 41 is item 9311; a missing cache entry leaves only the icon, never a made-up name.
    return [this.#context.item(9311)?.name ?? "", STATIONERY.get(DEFAULT_STATIONERY)!.icon];
  }

  selectStationery(index: unknown): void {
    if (Number(index) === 1) this.#stationery = 1;
  }

  selectedStationeryTexture(): string | undefined {
    return this.#stationery === 1 ? STATIONERY.get(DEFAULT_STATIONERY)!.texture : undefined;
  }

  // ---- events ----------------------------------------------------------------------------

  #show(world: FrameXmlMailWorld): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || world.mailboxGuid === 0n || world.mailboxGuid === this.#shown) return;
    this.#shown = world.mailboxGuid;
    this.#read.clear();
    this.#clearDraft(false);
    this.#prefetch(world);
    this.#metadataSignature = this.#inboxSignature();
    pump.fire("MAIL_SHOW");
    if (world.mail) pump.fire("MAIL_INBOX_UPDATE");
  }

  /** Item metadata for the list (attachments, auction subjects) and names for invoice players. */
  #prefetch(world: FrameXmlMailWorld): void {
    const list = world.mail;
    if (!list) return;
    const entries = new Set<number>();
    for (const entry of list.mails) {
      for (const attachment of entry.attachments) entries.add(attachment.itemId);
      const subject = frameXmlAuctionSubject(entry);
      if (subject) entries.add(subject.entry);
      const invoice = frameXmlAuctionInvoice(entry);
      if (invoice && invoice.playerGuid !== 0n && !world.names?.get(invoice.playerGuid)) {
        world.requestName?.(invoice.playerGuid);
      }
    }
    const missing = [...entries].filter((entry) => !this.#prefetched.has(entry) && !this.#context.item(entry));
    if (missing.length === 0 || !this.#context.prefetchItems) return;
    for (const entry of missing) this.#prefetched.add(entry);
    this.#context.prefetchItems(missing, () => { this.#metadataCheckedAt = Number.NEGATIVE_INFINITY; });
  }

  /**
   * What the inbox still waits for — sender names, invoice players and item names — counted, so
   * the arrival of one repaints the inbox once. The list edge itself resets it (`#onState`).
   */
  #inboxSignature(): string {
    const world = this.#context.world();
    const list = world?.mail;
    let names = 0;
    let items = 0;
    for (const entry of list?.mails ?? []) {
      if (entry.senderType === MAIL_NORMAL && this.#sender(entry) === undefined) names += 1;
      for (const attachment of entry.attachments) if (!this.#context.item(attachment.itemId)) items += 1;
      const subject = frameXmlAuctionSubject(entry);
      if (subject && !this.#context.item(subject.entry)) items += 1;
      const invoice = frameXmlAuctionInvoice(entry);
      if (invoice && !world?.names?.get(invoice.playerGuid)) names += 1;
    }
    return `${names}:${items}`;
  }

  /** Draft attachments whose item names are still missing; their arrival repaints the send tab. */
  #draftSignature(): string {
    let missing = 0;
    for (let slot = 0; slot < this.#draft.length; slot += 1) {
      const held = this.#draftItem(slot);
      if (held && !this.#context.item(held.object.entry)) missing += 1;
    }
    return String(missing);
  }

  #onState(change: MailStateChange): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    switch (change.kind) {
      case "open":
        this.#show(world);
        return;
      // A list or a result reaches stock only while it shows the mailbox. While the native window
      // owns it (before publication, or after a failed gate) the hidden MailFrame hears nothing:
      // measured before this, a refused send there fired UI_ERROR_MESSAGE and MAIL_FAILED into the
      // stock VM beside the native window's own message. `#show` sends the list with MAIL_SHOW at
      // the ownership edge.
      case "list":
        if (this.#shown === 0n) return;
        this.#prefetch(world);
        this.#metadataSignature = this.#inboxSignature();
        pump.fire("MAIL_INBOX_UPDATE");
        return;
      case "result":
        if (this.#shown === 0n) {
          // Seen, so the next result edge is judged against it and it is never replayed.
          this.#result = world.mailResult;
          return;
        }
        this.#onResult(world, pump);
        return;
      case "received":
        return;
      case "closed":
        if (this.#shown === 0n) return;
        this.#shown = 0n;
        this.#read.clear();
        this.#clearDraft(true);
        pump.fire("MAIL_CLOSED");
        return;
    }
  }

  /**
   * One SMSG_SEND_MAIL_RESULT. A sent letter clears the draft (MAIL_SEND_SUCCESS resets the stock
   * form); any success re-enables the send button and pages on (MAIL_SUCCESS); a refusal says why
   * in the error frame and re-enables the button (MAIL_FAILED). The world re-requests the list
   * after every success, so the inbox repaints from that list's MAIL_INBOX_UPDATE.
   */
  #onResult(world: FrameXmlMailWorld, pump: FrameXmlMailPump): void {
    const result = world.mailResult;
    if (!result || result === this.#result) return;
    this.#result = result;
    if (result.error === MAIL_OK) {
      if (result.command === MAIL_SEND) {
        this.#clearDraft(true);
        pump.fire("MAIL_SEND_SUCCESS");
      }
      pump.fire("MAIL_SUCCESS");
      return;
    }
    const text = result.error === MAIL_ERR_EQUIP_ERROR && result.bagResult !== 0
      ? equipErrorText({ result: result.bagResult }) : world.mailMessage?.text;
    if (text) pump.fire("UI_ERROR_MESSAGE", text);
    pump.fire("MAIL_FAILED");
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlMailHost {
  readonly mail?: FrameXmlMailModel | undefined;
  readonly services?: FrameXmlServices | undefined;
}

export type FrameXmlMailBinding = (host: FrameXmlMailHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

/**
 * `GetInboxHeaderInfo` for an index with no letter. OpenMailFrame_OnHide leaves `openMailID = 0`
 * (MailFrame.lua:359) and every later MAIL_INBOX_UPDATE runs OpenMail_Update on it, which compares
 * `CODAmount > 0` and `money == 0` unguarded (:625, :673): the client's answer carries numbers there.
 * Measured before this: «mailframe.lua:673 attempt to compare number with nil» on the first list
 * refresh after a letter was closed.
 */
const NO_LETTER: readonly unknown[] = Object.freeze([undefined, undefined, undefined, undefined, 0, 0, 0]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

/** Lua truthiness: nil and false are false. */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

const withMail = (answer: (mail: FrameXmlMailModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlMailBinding =>
  (host, args) => host.mail ? answer(host.mail, args) : NOTHING;

const command = (run: (mail: FrameXmlMailModel, args: readonly unknown[]) => void): FrameXmlMailBinding =>
  withMail((mail, args) => { run(mail, args); return NOTHING; });

const CLOSED_SERVICES = createFrameXmlServices({
  sendMailItems: () => [], stableService: () => undefined, stableSlotPrice: () => undefined,
});

/** Before the stock owner is published the native draft (FrameXmlServices) still answers. */
const draftOr = (
  stock: (mail: FrameXmlMailModel, args: readonly unknown[]) => readonly unknown[],
  name: "GetSendMailItem" | "GetSendMailPrice",
): FrameXmlMailBinding => (host, args) => host.mail?.ownsDraft
  ? stock(host.mail, args)
  : FRAMEXML_SERVICE_BINDINGS[name]!(host.services ?? CLOSED_SERVICES, args);

/**
 * The flat C API, spread into FRAMEXML_SEAM_BINDINGS after the service bindings: GetSendMailItem and
 * GetSendMailPrice move from the native draft to the stock one once the stock owner is published.
 * `WebClientMailAuctionSubject` is the prelude's flat accessor.
 */
export const FRAMEXML_MAIL_BINDINGS: Readonly<Record<string, FrameXmlMailBinding>> = Object.freeze({
  CheckInbox: command((mail) => mail.checkInbox()),
  GetInboxNumItems: (host) => host.mail ? host.mail.numItems() : [0, 0],
  GetInboxHeaderInfo: withMail((mail, args) => mail.headerInfo(args[0]) ?? NO_LETTER),
  GetInboxText: withMail((mail, args) => mail.text(args[0]) ?? NOTHING),
  GetInboxInvoiceInfo: withMail((mail, args) => mail.invoiceInfo(args[0]) ?? NOTHING),
  GetInboxItem: withMail((mail, args) => mail.item(args[0], args[1] ?? 1) ?? NOTHING),
  GetInboxItemLink: withMail((mail, args) => optional(mail.itemLink(args[0], args[1] ?? 1))),
  InboxItemCanDelete: withMail((mail, args) => [mail.canDelete(args[0])]),
  TakeInboxItem: command((mail, args) => mail.takeItem(args[0], args[1] ?? 1)),
  TakeInboxMoney: command((mail, args) => mail.takeMoney(args[0])),
  TakeInboxTextItem: command((mail, args) => mail.takeText(args[0])),
  AutoLootMailItem: command((mail, args) => mail.autoLoot(args[0])),
  DeleteInboxItem: command((mail, args) => mail.delete(args[0])),
  ReturnInboxItem: command((mail, args) => mail.returnToSender(args[0])),
  // Spam complaints (CMSG_COMPLAIN) are not wired in this client: the report button stays hidden.
  CanComplainInboxItem: () => [false],
  ComplainInboxItem: () => NOTHING,
  CloseMail: command((mail) => mail.close()),
  SendMail: command((mail, args) => mail.send(args[0], args[1], args[2])),
  SetSendMailMoney: withMail((mail, args) => [mail.setSendMoney(args[0])]),
  SetSendMailCOD: command((mail, args) => mail.setSendCod(args[0])),
  GetSendMailMoney: (host) => [host.mail?.sendMoney() ?? 0],
  GetSendMailCOD: (host) => [host.mail?.sendCod() ?? 0],
  SetSendMailShowing: command((mail, args) => mail.setSendShowing(truthy(args[0]))),
  ClickSendMailItemButton: command((mail, args) => mail.clickSendItem(args[0], truthy(args[1]))),
  GetSendMailItem: draftOr((mail, args) => mail.sendMailItem(args[0]), "GetSendMailItem"),
  GetSendMailItemLink: withMail((mail, args) => optional(mail.sendMailItemLink(args[0]))),
  GetSendMailPrice: draftOr((mail) => [mail.sendMailPrice()], "GetSendMailPrice"),
  // Refund-locked items (MAIL_LOCK_SEND_ITEMS) need the item-refund protocol this client lacks, so
  // the lock popup never opens and its answer has nothing to release.
  RespondMailLockSendItem: () => NOTHING,
  GetNumStationeries: (host) => [host.mail?.numStationeries() ?? 0],
  GetStationeryInfo: withMail((mail, args) => mail.stationeryInfo(args[0]) ?? NOTHING),
  SelectStationery: command((mail, args) => mail.selectStationery(args[0])),
  GetSelectedStationeryTexture: withMail((mail) => optional(mail.selectedStationeryTexture())),
  WebClientMailAuctionSubject: withMail((mail, args) => mail.auctionSubject(args[0]) ?? NOTHING),
  // OpenMailMoneyButton's icon (MailFrame.lua:394). The same engine table LootFrame's money slot
  // uses (FrameXmlLoot.ts); without it the money button painted as an empty slot (measured).
  GetCoinIcon: (_host, args) => {
    const copper = typeof args[0] === "number" ? args[0] : Number(args[0]);
    return Number.isFinite(copper) ? [frameXmlLootCoinIcon(copper)] : NOTHING;
  },
});

/**
 * Appended to FRAMEXML_SEAM_PRELUDE: an auction letter's subject in the client's words. The machine
 * subject (`entry:random:response:…`) becomes AUCTION_*_MAIL_SUBJECT formatted with the item name,
 * read from GlobalStrings.lua at call time; any other letter keeps its own subject.
 */
export const FRAMEXML_MAIL_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local header = rawget(_G, "__fxSeam_GetInboxHeaderInfo")
  local auction = rawget(_G, "__fxSeam_WebClientMailAuctionSubject")
  if impl ~= nil and header ~= nil and auction ~= nil then
    local SUBJECTS = {
      [0] = "AUCTION_OUTBID_MAIL_SUBJECT", [1] = "AUCTION_WON_MAIL_SUBJECT",
      [2] = "AUCTION_SOLD_MAIL_SUBJECT", [3] = "AUCTION_EXPIRED_MAIL_SUBJECT",
      [4] = "AUCTION_REMOVED_MAIL_SUBJECT", [5] = "AUCTION_REMOVED_MAIL_SUBJECT",
      [6] = "AUCTION_INVOICE_MAIL_SUBJECT",
    }
    local format, rawget, type = string.format, rawget, type
    impl.GetInboxHeaderInfo = function(index)
      local packageIcon, stationeryIcon, sender, subject, money, cod, daysLeft, itemCount, wasRead,
        wasReturned, textCreated, canReply, isGM, quantity = header(index)
      local response, itemName = auction(index)
      local key = response ~= nil and SUBJECTS[response] or nil
      local pattern = key and rawget(_G, key)
      if type(pattern) == "string" and itemName ~= nil then subject = format(pattern, itemName) end
      return packageIcon, stationeryIcon, sender, subject, money, cod, daysLeft, itemCount, wasRead,
        wasReturned, textCreated, canReply, isGM, quantity
    end
  end
end
`;
