/**
 * The stock BankFrame's C API (BankFrame.lua) and the bank half of the container API, over the
 * player's own inventory fields.
 *
 * There is no bank container and no bank packet in 3.3.5: the twenty-eight slots and the seven bag
 * slots arrive in the player's private update fields as `INVENTORY_SLOT_BAG_0` slots 39..73 (the
 * native Bank.ts says the same), and `SMSG_SHOW_BANK` only grants permission. Stock addresses the
 * same places three ways, and this module is the one table between them:
 *
 * * as a container — `BANK_CONTAINER` (-1) holds the 28 generic slots, and bank bags are container
 *   ids 5..11 (`NUM_BAG_SLOTS + 1 .. + NUM_BANKBAGSLOTS`, ContainerFrame.lua / BankFrame.xml `id`);
 * * as a Lua inventory id — `BankButtonIDToInvSlotID(id[, isBag])`: server slot + 1, so the generic
 *   slots are 40..67 and the bag slots 68..74, what `GetInventoryItemTexture("player", id)` reads;
 * * as `PLAYERBANKSLOTS_CHANGED(slot)` — 1..28 for the generic slots, 29..35 for the bag slots
 *   (BankFrame_OnEvent subtracts `NUM_BANKGENERIC_SLOTS`).
 *
 * Moves stay the server's: a pickup/drop goes through the seam's one item cursor (the same one the
 * stock bags and the native bank share, FrameXmlItemCursorBridge), a right-click while the banker's
 * permission stands is `CMSG_AUTOSTORE_BANK_ITEM`/`CMSG_AUTOBANK_ITEM` as in the client, and the
 * bag-slot purchase is `CMSG_BUY_BANK_SLOT`; a refused purchase is said in UIErrorsFrame with the
 * client's own `ERR_BANKSLOT_*` line.
 */
import {
  BANK_BAG_SLOTS, BANK_ITEM_SLOTS, BANK_SLOT_BAG_START, BANK_SLOT_ITEM_START, INVENTORY_SLOT_BAG_0,
  entryOf, firstFreeSlot, slotAt, stackCount,
  type ItemSlotState, type PlayerInventoryState,
} from "../Inventory.js";
import { bankSlotResultText } from "../../world/BankProtocol.js";

/** `BANK_CONTAINER` (Constants.lua). */
export const FRAMEXML_BANK_CONTAINER = -1;
/** `NUM_BAG_SLOTS + 1`: the first bank bag's container id. */
export const FRAMEXML_FIRST_BANK_BAG = 5;
export const FRAMEXML_LAST_BANK_BAG = FRAMEXML_FIRST_BANK_BAG + BANK_BAG_SLOTS - 1;
/** Lua inventory ids of the bank: generic 40..67, bags 68..74. */
export const FRAMEXML_FIRST_BANK_INVENTORY_ID = BANK_SLOT_ITEM_START + 1;
export const FRAMEXML_LAST_BANK_INVENTORY_ID = BANK_SLOT_BAG_START + BANK_BAG_SLOTS;
/** `ITEM_CLASS_QUEST` (ItemTemplate.h). */
const ITEM_CLASS_QUEST = 12;

/**
 * `SMSG_BUY_BANK_SLOT_RESULT`'s refusals (Player.h:122-124, BankHandler.cpp:145-185) and the
 * GlobalStrings line the client shows for each: 0 all seven bought, 1 not enough money, 2 no banker.
 */
export const FRAMEXML_BANK_SLOT_ERRORS: readonly (readonly [number, string])[] = Object.freeze([
  [0, "ERR_BANKSLOT_FAILED_TOO_MANY"], [1, "ERR_BANKSLOT_INSUFFICIENT_FUNDS"], [2, "ERR_BANKSLOT_NOTBANKER"],
]);

export function frameXmlIsBankContainer(id: number): boolean {
  return id === FRAMEXML_BANK_CONTAINER || (id >= FRAMEXML_FIRST_BANK_BAG && id <= FRAMEXML_LAST_BANK_BAG);
}

/** `BankButtonIDToInvSlotID(id, isBag)`: a generic button 1..28 or a bag button 5..11. */
export function frameXmlBankButtonInventoryId(id: number, isBag: boolean): number | undefined {
  if (!Number.isInteger(id)) return undefined;
  if (isBag) {
    return id >= FRAMEXML_FIRST_BANK_BAG && id <= FRAMEXML_LAST_BANK_BAG
      ? BANK_SLOT_BAG_START + (id - FRAMEXML_FIRST_BANK_BAG) + 1 : undefined;
  }
  return id >= 1 && id <= BANK_ITEM_SLOTS ? BANK_SLOT_ITEM_START + id : undefined;
}

/** The slot a bank Lua inventory id names (40..74), as the item opcodes address it. */
export function frameXmlBankInventorySlot(
  inventory: PlayerInventoryState,
  inventoryId: number,
): ItemSlotState | undefined {
  if (!Number.isInteger(inventoryId) || inventoryId < FRAMEXML_FIRST_BANK_INVENTORY_ID
    || inventoryId > FRAMEXML_LAST_BANK_INVENTORY_ID) return undefined;
  return slotAt(inventory, INVENTORY_SLOT_BAG_0, inventoryId - 1);
}

/** The shape LiveWorldSeam's container projection answers for every stock container id. */
export interface FrameXmlBankContainer {
  readonly id: number;
  readonly slots: readonly ItemSlotState[];
  readonly name: string | undefined;
  readonly bagFamily: number | undefined;
}

export interface FrameXmlBankItemTemplate {
  readonly found: boolean;
  readonly name: string;
  readonly bagFamily: number;
  readonly itemClass: number;
  readonly startQuest: number;
}

/**
 * The bank as containers: -1 is the 28 generic slots, 5..11 the bought bank bags. A bag slot that
 * holds no bag has no container (stock reads 0 slots and opens nothing).
 */
export function frameXmlBankContainer(
  id: number,
  inventory: PlayerInventoryState,
  template?: (entry: number) => FrameXmlBankItemTemplate | undefined,
): FrameXmlBankContainer | undefined {
  if (id === FRAMEXML_BANK_CONTAINER) return { id, slots: inventory.bank, name: undefined, bagFamily: 0 };
  if (!Number.isInteger(id) || id < FRAMEXML_FIRST_BANK_BAG || id > FRAMEXML_LAST_BANK_BAG) return undefined;
  const bag = inventory.bankBags.find((candidate) => candidate.bagSlot === BANK_SLOT_BAG_START + id - FRAMEXML_FIRST_BANK_BAG);
  if (!bag) return undefined;
  const found = template?.(entryOf(bag.bag));
  return {
    id,
    slots: bag.slots,
    name: found?.found ? found.name : undefined,
    bagFamily: found?.found ? found.bagFamily : undefined,
  };
}

/** The world commands the bank sends; `WorldClient` satisfies it structurally. */
export interface FrameXmlBankWorld {
  readonly bankerGuid?: bigint | undefined;
  /** The last purchase answer, worded by `bankSlotResultText` (WorldClient `bankMessage`). */
  readonly bankMessage?: { readonly text: string; readonly error: boolean } | undefined;
  /**
   * `BANK_OPENED`: `SMSG_SHOW_BANK`, the local close, and every `SMSG_BUY_BANK_SLOT_RESULT` (raised
   * again with the same banker). Absent on a scripted world; the model then re-baselines on `reconcile`.
   */
  readonly events?: {
    on(name: "BANK_OPENED", listener: (event: { readonly bankerGuid: bigint | undefined }) => void): () => void;
  } | undefined;
  buyBankSlot(): void;
  depositToBank(bag: number, slot: number): void;
  withdrawFromBank(bag: number, slot: number): void;
  storeItemInBag(sourceBag: number, sourceSlot: number, destinationBag: number): void;
  splitItem(sourceBag: number, sourceSlot: number, destinationBag: number, destinationSlot: number, count: number): void;
}

export interface FrameXmlBankContext {
  world(): FrameXmlBankWorld | undefined;
  inventory(): PlayerInventoryState | undefined;
  itemTemplate?(entry: number): FrameXmlBankItemTemplate | undefined;
  /**
   * What a slot's button draws of an entry besides its count — the icon and the quality border, as
   * the seam's own container signature compares them. An item query landing changes it, and the
   * open bank repaints (the seam's item-query edge calls `reconcile`).
   */
  itemAppearance?(entry: number): string;
  /** A logged quest (PLAYER_QUEST_LOG), for GetContainerItemQuestInfo's `isActive`. */
  questLogged?(questId: number): boolean;
  /** The one item cursor's source, as the opcodes address it. */
  cursorSlot?(): { readonly bag: number; readonly slot: number } | undefined;
  /** The cursor's click on a bank slot (pick up, or drop/swap what the cursor holds). */
  clickBankSlot?(bag: number, slot: number): boolean;
  clearCursor?(): void;
  /** The stock container id a carried slot lives in, to resolve UseContainerItem's source. */
  containerSlot?(bagId: number, slot: number): ItemSlotState | undefined;
}

interface FrameXmlBankPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** One owner of the bank's C API and of its two slot-change events. */
export class FrameXmlBankModel {
  readonly #context: FrameXmlBankContext;
  #pump: FrameXmlBankPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #muted = false;
  #owned = false;
  #strings: ((name: string) => string | undefined) | undefined;
  /** PLAYERBANKSLOTS_CHANGED's 35 slots, and the seven bank bags' contents, as last announced. */
  #slots: string[] = [];
  #bags = new Map<number, string>();
  /** The banker whose permission the baseline above was taken under; undefined: no bank is open. */
  #baselineFor: bigint | undefined;

  constructor(context: FrameXmlBankContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlBankPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("BANK_OPENED", ({ bankerGuid }) => this.#bankChanged(bankerGuid)));
    }
    // What the world already holds is the baseline; only later changes are edges.
    this.#rebaseline(world?.bankerGuid);
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
  }

  /**
   * Whether stock BankFrame is the bank window (the world mount publishes it). Only a published
   * frame says a refused purchase: the native window prints the same answer itself.
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) { this.#owned = owned; }

  /** The client's GlobalStrings, for the `ERR_BANKSLOT_*` wording; set by the owner once published. */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#strings = resolve;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #slotSignature(slot: ItemSlotState | undefined): string {
    if (!slot?.item) return "";
    const entry = entryOf(slot.item);
    return `${slot.guid}:${entry}:${stackCount(slot)}:${this.#context.itemAppearance?.(entry) ?? ""}`;
  }

  #measure(): { slots: string[]; bags: Map<number, string> } {
    const inventory = this.#context.inventory();
    const slots: string[] = [];
    const bags = new Map<number, string>();
    if (inventory) {
      for (let index = 0; index < BANK_ITEM_SLOTS; index += 1) slots.push(this.#slotSignature(inventory.bank[index]));
      for (let index = 0; index < BANK_BAG_SLOTS; index += 1) {
        const bagSlot = BANK_SLOT_BAG_START + index;
        const held = inventory.bankBags.find((bag) => bag.bagSlot === bagSlot);
        const entry = held ? entryOf(held.bag) : 0;
        slots.push(held ? `${held.guid}:${entry}:${this.#context.itemAppearance?.(entry) ?? ""}` : "");
        // ContainerFrame titles the bag with its name, which arrives with the bag's item query.
        if (held) {
          bags.set(FRAMEXML_FIRST_BANK_BAG + index,
            `${this.#context.itemTemplate?.(entry)?.name ?? ""}|${held.slots.map((slot) => this.#slotSignature(slot)).join(",")}`);
        }
      }
    }
    const previous = { slots: this.#slots, bags: this.#bags };
    this.#slots = slots;
    this.#bags = bags;
    return previous;
  }

  /**
   * Take what the bank holds under `bankerGuid` as the baseline, raising nothing: BankFrame_OnShow
   * paints all 35 buttons itself and an opened bank bag reads fresh. No banker: forget it.
   */
  #rebaseline(bankerGuid: bigint | undefined): void {
    this.#baselineFor = bankerGuid;
    if (bankerGuid !== undefined) this.#measure();
    else {
      this.#slots = [];
      this.#bags = new Map();
    }
  }

  /**
   * `BANK_OPENED`: a new banker's permission is a new baseline; the same banker raised again is a
   * purchase answer, and a refusal is said as the client says it (UIErrorsFrame, `ERR_BANKSLOT_*`).
   */
  #bankChanged(bankerGuid: bigint | undefined): void {
    if (bankerGuid !== this.#baselineFor) this.#rebaseline(bankerGuid);
    const message = this.#context.world()?.bankMessage;
    if (!message?.error || !this.#owned || this.#muted || bankerGuid === undefined) return;
    this.#pump?.fire("UI_ERROR_MESSAGE", this.#refusal(message.text));
  }

  /** The refusal's GlobalStrings line; the world keeps only its wording, so match that back to the code. */
  #refusal(text: string): string {
    const name = FRAMEXML_BANK_SLOT_ERRORS.find(([result]) => bankSlotResultText(result) === text)?.[1];
    return (name !== undefined ? this.#strings?.(name) : undefined) ?? text;
  }

  /**
   * One coalesced inventory mutation: PLAYERBANKSLOTS_CHANGED for each generic or bag slot that
   * moved, BAG_UPDATE for each bank bag whose contents did. Called from the seam's inventory edge,
   * which the store raises about once per rendered frame in a busy area, and from its item-query
   * edge. Only while a banker's permission stands: nothing moves in or out of the bank without one,
   * BankFrame is shown only then (BankFrame_OnShow registers PLAYERBANKSLOTS_CHANGED) and closing it
   * closes the bank bags (CloseBankBagFrames), so without a banker this answers at once.
   */
  reconcile(): void {
    const pump = this.#pump;
    if (!pump) return;
    const bankerGuid = this.#context.world()?.bankerGuid;
    if (bankerGuid === undefined || bankerGuid !== this.#baselineFor) {
      // A world with no BANK_OPENED edge (a scripted one) is re-baselined here instead.
      if (bankerGuid !== this.#baselineFor) this.#rebaseline(bankerGuid);
      return;
    }
    const previous = this.#measure();
    if (this.#slots.length === 0) return;
    for (let index = 0; index < this.#slots.length; index += 1) {
      if (previous.slots[index] !== this.#slots[index] && previous.slots.length > 0) {
        pump.fire("PLAYERBANKSLOTS_CHANGED", index + 1);
      }
    }
    for (let id = FRAMEXML_FIRST_BANK_BAG; id <= FRAMEXML_LAST_BANK_BAG; id += 1) {
      if (previous.bags.get(id) !== this.#bags.get(id) && previous.slots.length > 0) pump.fire("BAG_UPDATE", id);
    }
  }

  container(id: number): FrameXmlBankContainer | undefined {
    const inventory = this.#context.inventory();
    return inventory ? frameXmlBankContainer(id, inventory, this.#context.itemTemplate) : undefined;
  }

  /** A stock (container id, 1-based slot) pair: the bank's own, or a carried bag through the seam. */
  slot(bagId: number, slot: number): ItemSlotState | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    return frameXmlIsBankContainer(bagId)
      ? this.container(bagId)?.slots[slot - 1]
      : this.#context.containerSlot?.(bagId, slot);
  }

  inventorySlot(inventoryId: number): ItemSlotState | undefined {
    const inventory = this.#context.inventory();
    return inventory ? frameXmlBankInventorySlot(inventory, inventoryId) : undefined;
  }

  bankOpen(): boolean {
    return this.#context.world()?.bankerGuid !== undefined;
  }

  /** `GetContainerItemQuestInfo`: `isQuestItem, questId, isActive` from the item's template. */
  questInfo(slot: ItemSlotState | undefined): readonly unknown[] {
    const template = slot?.item ? this.#context.itemTemplate?.(entryOf(slot.item)) : undefined;
    if (!template?.found) return [false];
    const questId = template.startQuest > 0 ? template.startQuest : undefined;
    return [
      template.itemClass === ITEM_CLASS_QUEST, questId,
      questId === undefined ? undefined : this.#context.questLogged?.(questId) === true,
    ];
  }

  /**
   * UseContainerItem while the banker's permission stands moves the item across, as the client does:
   * out of the bank (`CMSG_AUTOSTORE_BANK_ITEM`) or into it (`CMSG_AUTOBANK_ITEM`). False leaves the
   * ordinary item use to the caller.
   */
  useContainerItem(bagId: number, slot: number): boolean {
    const world = this.#context.world();
    if (!world || world.bankerGuid === undefined) return false;
    const source = this.slot(bagId, slot);
    if (!source?.item || source.guid === 0n) return false;
    if (this.#muted) return true;
    if (frameXmlIsBankContainer(bagId)) world.withdrawFromBank(source.bag, source.slot);
    else world.depositToBank(source.bag, source.slot);
    return true;
  }

  /** `PickupBagFromSlot(inventoryId)` for a bank bag slot: the bag itself onto the item cursor. */
  pickupBag(inventoryId: number): boolean {
    if (inventoryId <= BANK_SLOT_BAG_START || inventoryId > FRAMEXML_LAST_BANK_INVENTORY_ID) return false;
    if (this.#muted) return true;
    return this.#context.clickBankSlot?.(INVENTORY_SLOT_BAG_0, inventoryId - 1) ?? false;
  }

  /**
   * `PutItemInBag(inventoryId)` for a bank bag slot. With an item on the cursor it goes into that
   * bag (`CMSG_AUTOSTORE_BAG_ITEM`), or — the slot being empty — into the slot itself, and the
   * answer is true; with nothing on the cursor the answer is false and stock opens the bag.
   */
  putItemInBag(inventoryId: number): boolean {
    if (inventoryId <= BANK_SLOT_BAG_START || inventoryId > FRAMEXML_LAST_BANK_INVENTORY_ID) return false;
    const source = this.#context.cursorSlot?.();
    if (!source) return false;
    if (this.#muted) return true;
    const world = this.#context.world();
    const bagSlot = inventoryId - 1;
    const held = this.#context.inventory()?.bankBags.find((bag) => bag.bagSlot === bagSlot);
    if (held && world?.bankerGuid !== undefined) {
      world.storeItemInBag(source.bag, source.slot, bagSlot);
      this.#context.clearCursor?.();
    } else {
      this.#context.clickBankSlot?.(INVENTORY_SLOT_BAG_0, bagSlot);
    }
    return true;
  }

  /**
   * `SplitContainerItem(bag, slot, count)`. The client would hold the split part on the cursor; this
   * host's cursor carries whole slots, so the part goes straight to the first free slot on the same
   * side (a split started in the bank must land in the bank, Inventory.ts `firstFreeSlot`).
   */
  split(source: ItemSlotState | undefined, bank: boolean, count: number): boolean {
    const world = this.#context.world();
    if (!world || !source?.item || source.guid === 0n || !Number.isInteger(count) || count < 1
      || count >= stackCount(source)) return false;
    if (bank && world.bankerGuid === undefined) return false;
    const target = firstFreeSlot(this.#context.inventory(), bank);
    if (!target) return false;
    if (!this.#muted) world.splitItem(source.bag, source.slot, target.bag, target.slot, count);
    return true;
  }

  /** `PurchaseSlot` — CONFIRM_BUY_BANK_SLOT's accept; the server checks the price and the banker. */
  purchase(): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world?.bankerGuid !== undefined) world.buyBankSlot();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlBankHost {
  readonly bank?: FrameXmlBankModel | undefined;
}

export type FrameXmlBankBinding = (host: FrameXmlBankHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

const withBank = (answer: (bank: FrameXmlBankModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlBankBinding =>
  (host, args) => host.bank ? answer(host.bank, args) : NOTHING;

/**
 * The C API the stock BankFrame and ContainerFrame call that no other binding answers.
 * `GetNumBankSlots`, `GetBankSlotCost` and `CloseBankFrame` are the seam's own (FrameXmlWorldSeam).
 * `ResetCursor` restores the *pointer image* after a merchant/repair cursor in the client; this host
 * draws no such image, so it has nothing to reset.
 */
export const FRAMEXML_BANK_BINDINGS: Readonly<Record<string, FrameXmlBankBinding>> = Object.freeze({
  BankButtonIDToInvSlotID: (_host, args) => {
    const id = frameXmlBankButtonInventoryId(integerArg(args[0]), truthy(args[1]));
    return id === undefined ? NOTHING : [id];
  },
  // ContainerFrame_Update asks this for every slot of every open bag (ContainerFrame.lua:282), so
  // the carried bags get their quest borders and «!» from the same template fields.
  GetContainerItemQuestInfo: withBank((bank, args) => bank.questInfo(bank.slot(integerArg(args[0]), integerArg(args[1])))),
  PickupBagFromSlot: withBank((bank, args) => { bank.pickupBag(integerArg(args[0])); return NOTHING; }),
  PutItemInBag: withBank((bank, args) => [bank.putItemInBag(integerArg(args[0]))]),
  // StackSplitFrame's Okay for a bank slot (BankFrame.lua:15) and for a carried bag slot
  // (ContainerFrame.lua:618/749) alike.
  SplitContainerItem: withBank((bank, args) => {
    const bagId = integerArg(args[0]);
    bank.split(bank.slot(bagId, integerArg(args[1])), frameXmlIsBankContainer(bagId), integerArg(args[2]));
    return NOTHING;
  }),
  PurchaseSlot: withBank((bank) => { bank.purchase(); return NOTHING; }),
  ResetCursor: () => NOTHING,
});
