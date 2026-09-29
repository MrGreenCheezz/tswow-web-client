import { MAX_PET_STABLES } from "../../world/StableProtocol.js";

/**
 * The stock MoneyFrame prices and the two service queries needed to repaint
 * those frames. Prices are previews: MailHandler, Guild::HandleSetEmblem and
 * WorldSession::HandleBuyStableSlot still validate and charge on the server.
 */

/** Guild.cpp's EMBLEM_PRICE = 10 * GOLD, in copper. */
export const TABARD_CREATION_COST_COPPER = 100_000;
/** MailHandler.cpp:119 charges 30 copper per attachment, or 30 for a plain letter. */
export const MAIL_POSTAGE_PER_ATTACHMENT_COPPER = 30;
/** `ATTACHMENTS_MAX_SEND` in the original MailFrame.lua. */
export const FRAMEXML_MAX_SEND_ATTACHMENTS = 12;

export interface FrameXmlStableService {
  /** Current stable master's GUID, established by the server's stable-list reply. */
  readonly masterGuid: bigint;
  /** `MaxStabledPets` from that reply, before purchasing the next slot. */
  readonly slotsOwned: number;
}

/** The original 3.3.5a `GetSendMailItem(slot)` result, in 1-based draft order. */
export type FrameXmlSendMailItem = readonly [
  name: string | undefined,
  texture: string | undefined,
  stackCount: number,
  quality: number | undefined,
];

export interface FrameXmlServiceSource {
  /** One snapshot of the native mail draft's attached items, in its slot order. */
  readonly sendMailItems: () => readonly FrameXmlSendMailItem[];
  /** Only a currently open, matching stable-master/list pair is an offer. */
  readonly stableService: () => FrameXmlStableService | undefined;
  /** Existing DBC catalog, row `slotsOwned + 1`; undefined until loaded. */
  readonly stableSlotPrice: (slotsOwned: number) => number | undefined;
}

export interface FrameXmlServices {
  readonly tabardCreationCost: () => number;
  readonly sendMailPrice: () => number | undefined;
  readonly sendMailItem: (slot: number) => FrameXmlSendMailItem;
  /** Server-reported slots in the current stable list; undefined before a matching list arrives. */
  readonly stableSlots: () => number | undefined;
  /** Undefined when closed, full, or when the matching DBC price is not ready. */
  readonly nextStableSlotCost: () => number | undefined;
}

const EMPTY_SEND_MAIL_ITEM: FrameXmlSendMailItem = Object.freeze([undefined, undefined, 0, undefined]);

function sendMailItems(source: FrameXmlServiceSource): readonly FrameXmlSendMailItem[] | undefined {
  const items = source.sendMailItems();
  if (!Array.isArray(items) || items.length > FRAMEXML_MAX_SEND_ATTACHMENTS) return undefined;
  return items;
}

function copper(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createFrameXmlServices(source: FrameXmlServiceSource): FrameXmlServices {
  return Object.freeze({
    tabardCreationCost: () => TABARD_CREATION_COST_COPPER,
    sendMailPrice: (): number | undefined => {
      const items = sendMailItems(source);
      return items === undefined ? undefined
        : MAIL_POSTAGE_PER_ATTACHMENT_COPPER * Math.max(1, items.length);
    },
    sendMailItem: (slot: number): FrameXmlSendMailItem => {
      const items = sendMailItems(source);
      return items && Number.isInteger(slot) && slot >= 1 && slot <= FRAMEXML_MAX_SEND_ATTACHMENTS
        ? items[slot - 1] ?? EMPTY_SEND_MAIL_ITEM : EMPTY_SEND_MAIL_ITEM;
    },
    stableSlots: (): number | undefined => {
      const service = source.stableService();
      return service && service.masterGuid !== 0n && Number.isInteger(service.slotsOwned)
        && service.slotsOwned >= 0 && service.slotsOwned <= MAX_PET_STABLES
        ? service.slotsOwned : undefined;
    },
    nextStableSlotCost: (): number | undefined => {
      const service = source.stableService();
      if (!service || service.masterGuid === 0n || !Number.isInteger(service.slotsOwned)
        || service.slotsOwned < 0 || service.slotsOwned >= MAX_PET_STABLES) return undefined;
      const price = source.stableSlotPrice(service.slotsOwned);
      return copper(price) ? price : undefined;
    },
  });
}

export type FrameXmlServiceBinding = (services: FrameXmlServices, args: readonly unknown[]) => readonly unknown[];

/**
 * Add these to `FRAMEXML_SEAM_BINDINGS` with `seam.services`. The inactive
 * stable value is deliberately a display sentinel: PetStable.lua:25 handles
 * UNIT_PET even while its frame is hidden, then calls MoneyFrame_Update at
 * line 71. Zero keeps that hidden frame's denomination arithmetic defined;
 * `nextStableSlotCost()` remains undefined, so the host must never present a
 * purchase action until an actual stable service and DBC price exist.
 */
export const FRAMEXML_SERVICE_BINDINGS: Readonly<Record<string, FrameXmlServiceBinding>> = Object.freeze({
  GetTabardCreationCost: (services) => [services.tabardCreationCost()],
  GetSendMailPrice: (services) => {
    const price = services.sendMailPrice();
    return price === undefined ? [] : [price];
  },
  GetSendMailItem: (services, args) => services.sendMailItem(Number(args[0])),
  GetNumStableSlots: (services) => [services.stableSlots() ?? 0],
  GetNextStableSlotCost: (services) => [services.nextStableSlotCost() ?? 0],
});
