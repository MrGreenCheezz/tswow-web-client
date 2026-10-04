/**
 * The one FrameXML cursor: what the hand holds between a pickup and a drop, for the stock action
 * bars, the spellbook, the bags and the macro window.
 *
 * Three holders already existed before this module, each owned by its window's model — the bag and
 * paper-doll item cursor (`LiveWorldSeam.pickupContainerItem`), the macro cursor
 * (`FrameXmlMacroModel.pickup`) and the guild vault's stack (`FrameXmlGuildBank`). They stay where
 * they are: each one's drop rules belong to its own window. What they could not hold is what the
 * action bar trades in — a spell from the book, an action lifted off a slot, an item named by id —
 * and nothing could *place* a bag item on a bar. This model holds those (`held`) and answers the
 * cursor C API over all four, so `GetCursorInfo`, `CursorHasItem` and `ClearCursor` see one hand:
 *
 * * `PickupSpell(slot, bookType)` — SpellBookFrame.lua:382 and :397 (`SpellButton_OnDrag`, the
 *   button's OnDragStart and OnReceiveDrag, SpellBookFrame.xml:166-171). A passive spell is refused,
 *   as the client refuses it: it can never sit on a bar.
 * * `PickupAction(slot)` — the button's OnDragStart (ActionBarFrame.xml:18-24): the slot is emptied
 *   through CMSG_SET_ACTION_BUTTON and its action is on the cursor; with something already held it is
 *   a drop onto that slot instead.
 * * `PlaceAction(slot)` — OnReceiveDrag (ActionBarFrame.xml:25-29), and `UseAction` pressed with
 *   anything held (the C side of `SECURE_ACTIONS.action`, SecureTemplates.lua:303-312, places rather
 *   than uses). What was in the slot comes back on the cursor: the stock swap.
 * * `PickupItem(id or link)`, `PickupPetAction(index)` — SecureHandlers.lua:201, :207;
 *   PetActionBarFrame.lua:297-313.
 * * `PickupCompanion(type, index)` — CompanionButton_OnDrag (PetPaperDollFrame.lua:205-216): the
 *   companion's spell, answered as `"companion", index, type` and placed on a bar as the spell
 *   action the client's bar holds for one (FrameXmlCompanions.ts).
 *
 * The packed word is the core's: `Player.h` `ActionButtonType` — spell 0x00, equipment set 0x20,
 * macro 0x40, item 0x80 — in the high byte, `ACTION_BUTTON_ACTION` the low 24 bits
 * (`WorldSession::HandleSetActionButtonOpcode`, MiscHandler.cpp:983-994: a zero word removes the
 * button). The bar is the server's; the host's `setActionButton` sends the packet and updates the
 * local copy the next `HasAction` reads, exactly as the native bar's drop does (ui/ActionBar.ts).
 *
 * Events are the ones the stock handlers wait for: CURSOR_UPDATE on every change, and
 * ACTIONBAR_SHOWGRID/ACTIONBAR_HIDEGRID in pairs while something that can go on a bar is held
 * (ActionButton.lua:373-379 counts them in the button's `showgrid` attribute, which is what shows an
 * empty slot to drop on). ACTIONBAR_SLOT_CHANGED carries the placed slot (ActionButton.lua:358-362).
 * Like the macro model's, they go out once the Lua call that caused them has returned.
 *
 * The macro model keeps its own grid pair for a macro it holds, so this model counts only what it
 * holds itself and the item holders.
 */

import { ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } from "../../world/ActionBarProtocol.js";
import { FRAMEXML_MACRO_BINDINGS } from "./FrameXmlMacro.js";
import { FRAMEXML_PET_ACTION_EVENTS } from "./FrameXmlPetActionBar.js";
import type { FrameXmlSeamBinding, FrameXmlSeamPump, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { frameXmlDropHeldMerchantItem, frameXmlPickupMerchantItem } from "./FrameXmlMerchantCursor.js"; // L1 (3.23)
import { frameXmlCoinCursorTexture } from "./FrameXmlCursorMoney.js"; // L5c-review 3.09

/**
 * An item id or a native item hyperlink, as `FrameXmlWorldSeam.frameXmlItemEntry` reads one. Kept
 * local: the seam table imports this module's bindings, so a value import back would be a cycle.
 */
function frameXmlItemEntry(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /(?:^|\|H)item:(\d+)(?::|\||$)/.exec(value);
  const entry = match ? Number(match[1]) : undefined;
  return entry !== undefined && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
}

/** One server action slot: the action and its `ActionButtonType`. */
export interface FrameXmlActionButton {
  readonly action: number;
  readonly type: number;
}

/** What this model itself can hold; the item/macro/vault holders answer for the rest. */
export type FrameXmlCursorHeld =
  | { readonly kind: "spell"; readonly spellId: number; readonly bookType: string }
  | { readonly kind: "item"; readonly entry: number }
  /** A macro action lifted off a bar, by the store slot the button holds. */
  | { readonly kind: "macro"; readonly slot: number }
  | { readonly kind: "equipmentset"; readonly id: number }
  | { readonly kind: "petaction"; readonly index: number }
  /** A companion off the pet page: its spell, and the index and kind GetCursorInfo answers. */
  | { readonly kind: "companion"; readonly spellId: number; readonly companionType: string; readonly index: number }
  /** L1 (3.23): a merchant row (cursor type 5, Wow.exe 0x00520d30): its one-based index and item entry. */
  | { readonly kind: "merchant"; readonly index: number; readonly entry: number }
  /** L5c 3.09: money on the cursor — the player's (type 2, "money") or the guild vault's (type 0xc). */
  | { readonly kind: "money" | "guildbankmoney"; readonly amount: number };

/** The seam surface the cursor reads; the seam itself is the host. */
export type FrameXmlCursorHost = Pick<FrameXmlWorldSeam,
  "cursorInfo" | "cursorHasItem" | "clearCursor" | "spellIsPassive" | "itemInfo"
  | "macros" | "actionButton" | "setActionButton" | "spellBookSpellId" | "spellInfo" | "spellTexture"
  | "itemTexture" | "equipmentSets" | "petActions">;

/** The highest spellbook slot the stock book can address (SpellBookFrame.lua:1, `MAX_SPELLS`). */
const MAX_SPELLS = 1024;
/** `BOOKTYPE_PET` (SpellBookFrame.lua:6): the pet's spellbook. */
const PET_BOOK = "pet";

function actionSlot(value: unknown): number | undefined {
  const slot = Math.trunc(Number(value));
  // 144 server slots (ActionBarProtocol.ts ACTION_BUTTONS), numbered from 1 in Lua.
  return Number.isInteger(slot) && slot >= 1 && slot <= 144 ? slot : undefined;
}

function heldAction(held: FrameXmlCursorHeld): FrameXmlActionButton | undefined {
  switch (held.kind) {
    // A pet book spell is a pet action: the pet bar takes it (pickupPetAction), the main bars refuse it.
    case "spell": return held.bookType === PET_BOOK ? undefined : { action: held.spellId, type: ACTION_BUTTON_SPELL };
    case "item": return { action: held.entry, type: ACTION_BUTTON_ITEM };
    case "macro": return { action: held.slot, type: ACTION_BUTTON_MACRO };
    case "equipmentset": return { action: held.id, type: ACTION_BUTTON_EQUIPMENT_SET };
    // A pet action belongs on the pet bar only; the main bars refuse it.
    case "petaction": return undefined;
    // A companion on a bar is the ordinary spell action the client's bar holds for one.
    case "companion": return { action: held.spellId, type: ACTION_BUTTON_SPELL };
    // L1 (3.23): a merchant row is no action.
    case "merchant": return undefined;
    // L5c 3.09: neither is money.
    case "money": case "guildbankmoney": return undefined;
  }
}

function heldFromAction(button: FrameXmlActionButton): FrameXmlCursorHeld | undefined {
  if (!Number.isSafeInteger(button.action) || button.action <= 0) return undefined;
  switch (button.type) {
    case ACTION_BUTTON_SPELL: return { kind: "spell", spellId: button.action, bookType: "spell" };
    case ACTION_BUTTON_ITEM: return { kind: "item", entry: button.action };
    case ACTION_BUTTON_MACRO: return { kind: "macro", slot: button.action };
    case ACTION_BUTTON_EQUIPMENT_SET: return { kind: "equipmentset", id: button.action };
    default: return undefined;
  }
}

export class FrameXmlCursorModel {
  readonly #host: FrameXmlCursorHost;
  #pump: FrameXmlSeamPump | undefined;
  #held: FrameXmlCursorHeld | undefined;
  /** Whether this model's SHOWGRID is outstanding (one HIDEGRID owed). */
  #grid = false;
  /** The same for the pet bar: PET_BAR_SHOWGRID while a pet action is held (PetActionBar_ShowGrid). */
  #petGrid = false;
  #picture: string | undefined;
  #pictureKey = "";
  readonly #pictureListeners = new Set<(texture: string | undefined) => void>();
  readonly #queued: [string, ...unknown[]][] = [];

  constructor(host: FrameXmlCursorHost) {
    this.#host = host;
  }

  attach(pump: FrameXmlSeamPump): void {
    this.detach();
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
    this.#held = undefined;
    this.#grid = false;
    this.#petGrid = false;
    this.#queued.length = 0;
    this.#publishPicture(undefined, "");
  }

  #fire(event: string, ...args: unknown[]): void {
    this.#queued.push([event, ...args]);
    if (this.#queued.length > 1) return;
    queueMicrotask(() => {
      const events = this.#queued.splice(0);
      for (const [name, ...rest] of events) this.#pump?.fire(name, ...rest);
    });
  }

  /** What this model holds (not the bag, macro or vault holders). */
  held(): FrameXmlCursorHeld | undefined {
    return this.#held;
  }

  /** Anything at all on the cursor, whichever holder has it. */
  occupied(): boolean {
    return this.#held !== undefined || this.#host.cursorInfo().length > 0;
  }

  #set(next: FrameXmlCursorHeld | undefined): void {
    // One thing on the cursor: taking something up lets go of what the other holders had.
    if (next) this.#host.clearCursor();
    const previous = this.#held; // L5c 3.09
    this.#held = next;
    this.#moneyReleased(previous); // L5c 3.09
    this.#fire("CURSOR_UPDATE");
    this.sync();
  }

  /** `ClearCursor()`: every holder lets go (a lifted action is gone, a bag item stays in its bag). */
  clear(): void {
    const previous = this.#held; // L5c 3.09
    const had = this.#held !== undefined;
    this.#held = undefined;
    this.#host.clearCursor();
    this.#moneyReleased(previous); // L5c 3.09
    if (had) this.#fire("CURSOR_UPDATE");
    this.sync();
  }

  /**
   * Drop only this model's own content, leaving the other holders to the call that follows; that
   * call syncs (`reconcile` false) so the picture does not blink empty between the two.
   */
  clearOwn(reconcile = true): void {
    if (this.#held === undefined) return;
    const previous = this.#held; // L5c 3.09
    this.#held = undefined;
    this.#moneyReleased(previous); // L5c 3.09
    this.#fire("CURSOR_UPDATE");
    if (reconcile) this.sync();
  }

  // ---- L5c 3.09: money on the cursor --------------------------------------------------------------

  /**
   * Money let go of (Wow.exe 0x00519280 with its «notify» argument): the player's raises PLAYER_MONEY,
   * the vault's GUILDBANK_UPDATE_MONEY, so the money frames that subtract GetCursorMoney redraw.
   */
  #moneyReleased(previous: FrameXmlCursorHeld | undefined, notify = true): void {
    if (!notify || (previous?.kind !== "money" && previous?.kind !== "guildbankmoney")) return;
    this.#fire(previous.kind === "money" ? "PLAYER_MONEY" : "GUILDBANK_UPDATE_MONEY");
  }

  /**
   * Put money on the cursor (0x00520880 for the player's, 0x005208f0 for the vault's): whatever was
   * held goes first, then the amount is held and the same money event announces it. Nothing moves on
   * the server: the money stays the character's until a stock call puts it somewhere.
   */
  pickupMoney(kind: "money" | "guildbankmoney", amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    this.#set({ kind, amount });
    this.#fire(kind === "money" ? "PLAYER_MONEY" : "GUILDBANK_UPDATE_MONEY");
  }

  /** The money held, if any (GetCursorMoney reads one amount for both kinds, 0x00515a50). */
  money(): { readonly kind: "money" | "guildbankmoney"; readonly amount: number } | undefined {
    const held = this.#held;
    return held?.kind === "money" || held?.kind === "guildbankmoney" ? held : undefined;
  }

  /** AddTradeMoney's let-go (0x00586d90 → 0x00519280(1, 0)): CURSOR_UPDATE, but no PLAYER_MONEY. */
  dropMoneyQuietly(): void {
    if (this.money() === undefined) return;
    this.#held = undefined;
    this.#fire("CURSOR_UPDATE");
    this.sync();
  }

  // ---- pickups -----------------------------------------------------------------------------------

  /** `PickupSpell(slot, bookType)`: the spell in that book slot, never a passive one. */
  pickupSpell(slotValue: unknown, bookTypeValue: unknown): void {
    const bookType = typeof bookTypeValue === "string" ? bookTypeValue.toLowerCase() : "spell";
    const slot = Math.trunc(Number(slotValue));
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SPELLS) return;
    // The pet's book is the pet model's (FrameXmlPetActionBar.ts); its spell goes to the pet bar only.
    const petSpell = bookType === PET_BOOK ? this.#host.petActions?.bookSpell(slot) : undefined;
    const spellId = bookType === PET_BOOK ? petSpell?.spellId : this.#host.spellBookSpellId?.(slot, bookType);
    if (spellId === undefined || !Number.isSafeInteger(spellId) || spellId <= 0) return;
    if (bookType === PET_BOOK ? petSpell?.passive === true : this.#host.spellIsPassive(slot, bookType) === true) return;
    const held = this.#held;
    // SpellButton_OnDrag is both the button's OnDragStart and its OnReceiveDrag: releasing the drag
    // over the button it started on picks up the same spell again, which keeps it held.
    if (held?.kind === "spell" && held.spellId === spellId) return;
    this.#set({ kind: "spell", spellId, bookType });
  }

  /** L1 (3.23): `PickupMerchantItem(index)` puts the row on the cursor (FrameXmlMerchantCursor.ts). */
  pickupMerchantItem(index: number, entry: number): void {
    if (!Number.isInteger(index) || index < 1 || !Number.isSafeInteger(entry) || entry <= 0) return;
    this.#set({ kind: "merchant", index, entry });
  }

  /** `PickupItem(id or link)`: an item by entry, which can only be put on a bar. */
  pickupItem(value: unknown): void {
    const entry = frameXmlItemEntry(value);
    if (entry === undefined) return;
    this.#set({ kind: "item", entry });
  }

  /**
   * `PickupEquipmentSet(index)` / `PickupEquipmentSetByName(name)`: a set by its server index, which
   * a bar slot takes as `ACTION_BUTTON_EQUIPMENT_SET` (FrameXmlEquipmentSets.ts resolves the name).
   */
  pickupEquipmentSet(id: number): void {
    if (!Number.isSafeInteger(id) || id < 0) return;
    this.#set({ kind: "equipmentset", id });
  }

  /**
   * `PickupPetAction(index)`: the pet bar's pickup and drop in one call (PetActionBarFrame.lua:297-313).
   * A drop on another slot swaps the two — CMSG_PET_SET_ACTION's two-pair form, the only move the
   * protocol has (PetProtocol.ts `buildPetSwapAction`) — and a drop on its own slot lets go.
   */
  pickupPetAction(value: unknown): void {
    const index = Math.trunc(Number(value));
    if (!Number.isInteger(index) || index < 1 || index > 10) return;
    const held = this.#held;
    if (held?.kind === "petaction") {
      if (held.index !== index) this.#host.petActions?.moveAction(held.index, index);
      this.clearOwn();
      return;
    }
    // A spell off the pet's book onto this slot (CMSG_PET_SET_ACTION's one-pair form).
    if (held?.kind === "spell" && held.bookType === PET_BOOK) {
      this.#host.petActions?.placeSpell(index, held.spellId);
      this.clearOwn();
      return;
    }
    if (this.occupied()) return;
    this.#set({ kind: "petaction", index });
  }

  /**
   * `PickupCompanion(type, index)`: the companion's spell, in the shape the pet page's drag started
   * (FrameXmlCompanions.ts resolves the spell). Dropping it back on the button it came from keeps
   * it held, as the same spell picked up again does.
   */
  pickupCompanion(spellId: number, companionType: string, index: number): void {
    if (!Number.isSafeInteger(spellId) || spellId <= 0 || !Number.isInteger(index) || index < 1) return;
    const held = this.#held;
    if (held?.kind === "companion" && held.spellId === spellId) return;
    this.#set({ kind: "companion", spellId, companionType, index });
  }

  /**
   * `PickupAction(slot)`: lift the slot's action — the slot is emptied on the server — or, with
   * something already held, put that on the slot and take up what was there.
   */
  pickupAction(value: unknown): void {
    const slot = actionSlot(value);
    if (slot === undefined) return;
    if (this.occupied()) {
      this.placeAction(slot);
      return;
    }
    const button = this.#host.actionButton?.(slot);
    const held = button && heldFromAction(button);
    if (!held || !this.#host.setActionButton?.(slot, 0, 0)) return;
    this.#set(held);
    this.#fire("ACTIONBAR_SLOT_CHANGED", slot);
  }

  /**
   * `PlaceAction(slot)`, and an action button pressed with something held: the held thing goes on
   * the slot and what was there comes up. False when nothing that fits a bar is held, which leaves
   * a press to the button's own action.
   */
  placeAction(value: unknown): boolean {
    const slot = actionSlot(value);
    if (slot === undefined) return false;
    const host = this.#host;
    const own = this.#held;
    const macroSlot = own ? undefined : host.macros?.cursorSlot();
    let next: FrameXmlActionButton | undefined;
    if (own) {
      next = heldAction(own);
      // A pet action held over a main bar: the client keeps it on the cursor.
      if (!next) return own.kind === "petaction";
    } else if (macroSlot !== undefined) {
      next = { action: macroSlot, type: ACTION_BUTTON_MACRO };
    } else {
      const info = host.cursorInfo();
      const entry = info[0] === "item" ? frameXmlItemEntry(info[1]) : undefined;
      if (entry === undefined) return false;
      next = { action: entry, type: ACTION_BUTTON_ITEM };
    }
    const before = host.actionButton?.(slot);
    if (before && before.action === next.action && before.type === next.type) {
      // The same action dropped back where it is: nothing moves, the hand is empty.
      this.clear();
      return true;
    }
    if (macroSlot !== undefined) {
      // The macro model's own route (CMSG_SET_ACTION_BUTTON through its host) lets go of it.
      if (!host.macros?.placeCursor(slot)) return false;
    } else {
      if (!host.setActionButton?.(slot, next.action, next.type)) return false;
      if (own) this.#held = undefined;
      else host.clearCursor();
    }
    // The stock swap: only what really left the slot comes up.
    const after = host.actionButton?.(slot);
    const displaced = before && (after?.action !== before.action || after?.type !== before.type)
      ? heldFromAction(before) : undefined;
    if (displaced) this.#held = displaced;
    this.#fire("ACTIONBAR_SLOT_CHANGED", slot);
    this.#fire("CURSOR_UPDATE");
    this.sync();
    return true;
  }

  // ---- queries -----------------------------------------------------------------------------------

  /** The book slot of a known spell, which is what `GetCursorInfo`'s spell shape names. */
  #bookSlot(spellId: number, bookType: string): number | undefined {
    if (bookType === PET_BOOK) {
      const pet = this.#host.petActions;
      const count = pet?.book()?.count ?? 0;
      for (let slot = 1; slot <= count; slot += 1) if (pet?.bookSpell(slot)?.spellId === spellId) return slot;
      return undefined;
    }
    const resolve = this.#host.spellBookSpellId;
    if (!resolve) return undefined;
    for (let slot = 1; slot <= MAX_SPELLS; slot += 1) {
      const id = resolve.call(this.#host, slot, bookType);
      if (id === undefined) return undefined;
      if (id === spellId) return slot;
    }
    return undefined;
  }

  /** `GetCursorInfo()`: `"spell", slot, bookType` / `"item", id, link` / `"macro", index` / … */
  info(): readonly unknown[] {
    const held = this.#held;
    if (!held) return this.#host.cursorInfo();
    switch (held.kind) {
      case "spell": return ["spell", this.#bookSlot(held.spellId, held.bookType), held.bookType];
      case "item": {
        const link = this.#host.itemInfo(held.entry)?.[1];
        return link ? ["item", held.entry, link] : ["item", held.entry];
      }
      case "macro": {
        const position = this.#host.macros?.position(held.slot) ?? 0;
        return position > 0 ? ["macro", position] : ["macro"];
      }
      case "equipmentset": return ["equipmentset"];
      case "petaction": return ["petaction", held.index];
      case "companion": return ["companion", held.index, held.companionType];
      // L1 (3.23): 0x00515200 answers type 5 with "merchant" and the one-based index.
      case "merchant": return ["merchant", held.index];
      // L5c 3.09: 0x00515200 — type 2 "money", type 0xc "guildbankmoney", each with the amount.
      case "money": case "guildbankmoney": return [held.kind, held.amount];
    }
  }

  hasItem(): boolean {
    return this.#held?.kind === "item" || (this.#held === undefined && this.#host.cursorHasItem());
  }

  hasSpell(): boolean {
    return this.#held?.kind === "spell";
  }

  hasMacro(): boolean {
    return this.#held?.kind === "macro" || (this.#held === undefined && this.#host.macros?.cursorSlot() !== undefined);
  }

  /**
   * `GetActionInfo(slot)`: `"spell", bookSlot, "spell", spellId` / `"item", id` / `"macro", index`
   * (VehicleMenuBar.lua:795 reads all four). A spell outside the book keeps a nil book slot.
   */
  actionInfo(value: unknown): readonly unknown[] {
    const slot = actionSlot(value);
    const button = slot === undefined ? undefined : this.#host.actionButton?.(slot);
    if (!button || button.action <= 0) return [];
    switch (button.type) {
      case ACTION_BUTTON_SPELL: return ["spell", this.#bookSlot(button.action, "spell"), "spell", button.action];
      case ACTION_BUTTON_ITEM: return ["item", button.action];
      case ACTION_BUTTON_MACRO: {
        const position = this.#host.macros?.position(button.action) ?? 0;
        return position > 0 ? ["macro", position] : ["macro"];
      }
      case ACTION_BUTTON_EQUIPMENT_SET: return ["equipmentset"];
      default: return [];
    }
  }

  // ---- the grid and the picture -----------------------------------------------------------------

  /** The icon the hand shows, for the renderer's cursor picture. */
  picture(): string | undefined {
    return this.#picture;
  }

  /** Called with the new picture (or undefined) whenever it changes; returns the unsubscribe. */
  onPicture(listener: (texture: string | undefined) => void): () => void {
    this.#pictureListeners.add(listener);
    return () => { this.#pictureListeners.delete(listener); };
  }

  #publishPicture(texture: string | undefined, key: string): void {
    if (key === this.#pictureKey) return;
    this.#pictureKey = key;
    this.#picture = texture;
    for (const listener of [...this.#pictureListeners]) {
      try { listener(texture); } catch { /* a listener's failure never reaches the Lua call */ }
    }
  }

  #textureOf(held: FrameXmlCursorHeld): string | undefined {
    const host = this.#host;
    switch (held.kind) {
      case "spell": {
        const slot = this.#bookSlot(held.spellId, held.bookType);
        return host.spellInfo?.(held.spellId)?.[2]
          || (slot === undefined ? undefined : host.spellTexture(slot, held.bookType)) || undefined;
      }
      case "item": return host.itemTexture?.(held.entry);
      case "macro": return host.macros?.slotTexture(held.slot);
      case "equipmentset": return host.equipmentSets?.iconOf(held.id);
      case "companion": return host.spellInfo?.(held.spellId)?.[2] || undefined;
      // L1 (3.23): the row's item picture (0x00520d30 → 0x00616720).
      case "merchant": return host.itemTexture?.(held.entry);
      // L5c-review 3.09: the coins by amount (0x00616510 → 0x007e7cc0); before this the hand was empty.
      case "money": case "guildbankmoney": return frameXmlCoinCursorTexture(held.amount);
      default: return undefined;
    }
  }

  /**
   * Reconcile the grid and the picture with every holder: called after each cursor call and from
   * the seam's frame tick, so a holder that let go on its own (a moved item, a closed vault) is seen.
   */
  sync(): void {
    const own = this.#held;
    const info = own ? undefined : this.#host.cursorInfo();
    const item = info?.[0] === "item" ? frameXmlItemEntry(info[1]) : undefined;
    const macroPosition = info?.[0] === "macro" ? info[1] : undefined;
    // The macro model fires its own grid pair for its macro; everything else is counted here.
    // L1 (3.23): a merchant row shows no grid (0x00520d30 calls 0x005a7a70 for type 7 only).
    const grid = (own !== undefined && own.kind !== "petaction" && own.kind !== "merchant" && !(own.kind === "spell" && own.bookType === PET_BOOK)
      && own.kind !== "money" && own.kind !== "guildbankmoney") // L5c 3.09: money shows no grid (0x00520880)
      || item !== undefined;
    if (grid !== this.#grid) {
      this.#grid = grid;
      this.#fire(grid ? "ACTIONBAR_SHOWGRID" : "ACTIONBAR_HIDEGRID");
    }
    // A held pet action — or a spell off the pet's book — shows the pet bar's empty slots as drop
    // targets, and only the pet bar's.
    const petGrid = own?.kind === "petaction" || (own?.kind === "spell" && own.bookType === PET_BOOK);
    if (petGrid !== this.#petGrid) {
      this.#petGrid = petGrid;
      this.#fire(petGrid ? FRAMEXML_PET_ACTION_EVENTS.showGrid : FRAMEXML_PET_ACTION_EVENTS.hideGrid);
    }
    if (own) {
      this.#publishPicture(this.#textureOf(own), `own:${own.kind}:${JSON.stringify(own)}`);
    } else if (item !== undefined) {
      this.#publishPicture(this.#host.itemTexture?.(item), `item:${item}`);
    } else if (macroPosition !== undefined) {
      this.#publishPicture(this.#host.macros?.info(macroPosition)?.[1], `macro:${String(macroPosition)}`);
    } else {
      this.#publishPicture(undefined, "");
    }
  }
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function slotArg(value: unknown): number {
  const slot = Number(value);
  return Number.isFinite(slot) ? Math.trunc(slot) : 0;
}

/**
 * The cursor C API. Spread after every other table in `FRAMEXML_SEAM_BINDINGS`, so these answers
 * replace the per-holder ones; a seam without a cursor model keeps the older per-holder behaviour.
 */
export const FRAMEXML_CURSOR_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  PickupSpell: (seam, args) => { seam.cursor?.pickupSpell(args[0], args[1]); return NOTHING; },
  PickupAction: (seam, args) => { seam.cursor?.pickupAction(args[0]); return NOTHING; },
  PlaceAction: (seam, args) => {
    if (seam.cursor) seam.cursor.placeAction(args[0]);
    else seam.macros?.placeCursor(args[0]);
    return NOTHING;
  },
  PickupItem: (seam, args) => { seam.cursor?.pickupItem(args[0]); return NOTHING; },
  PickupPetAction: (seam, args) => { seam.cursor?.pickupPetAction(args[0]); return NOTHING; },
  PickupMacro: (seam, args) => {
    seam.cursor?.clearOwn(false);
    const result = FRAMEXML_MACRO_BINDINGS["PickupMacro"]!(seam, args);
    seam.cursor?.sync();
    return result;
  },
  PickupContainerItem: (seam, args) => {
    // L1 (3.23): a held merchant row is bought into the slot (0x005d7ff0 → 0x006d2ea0), before anything else.
    if (frameXmlDropHeldMerchantItem(seam, slotArg(args[0]), slotArg(args[1]))) return NOTHING;
    // Under the repair cursor (2.02) a held spell, action or set is only let go of: Wow.exe
    // 0x005d7ff0 clears the hand and neither repairs nor lifts the item.
    if (seam.cursor?.held() !== undefined && seam.repair?.inRepairMode()) {
      seam.cursor.clear();
      return NOTHING;
    }
    seam.cursor?.clearOwn(false);
    seam.pickupContainerItem(slotArg(args[0]), slotArg(args[1]));
    seam.cursor?.sync();
    return NOTHING;
  },
  PickupInventoryItem: (seam, args) => {
    // L1 (3.23): a held merchant row is bought into the paper-doll slot (0x005e85d0 → 0x006d2ea0).
    if (frameXmlDropHeldMerchantItem(seam, undefined, slotArg(args[0]))) return NOTHING;
    // Under the repair cursor a held spell, action or set keeps the paper doll's click (0x005e85d0).
    if (seam.cursor?.held() !== undefined && seam.repair?.inRepairMode()) return NOTHING;
    seam.cursor?.clearOwn(false);
    // Stock item actions take the player's slot ID (PaperDollFrame.lua), as UseInventoryItem does.
    seam.pickupInventoryItem("player", slotArg(args[0]));
    seam.cursor?.sync();
    return NOTHING;
  },
  // L1 (3.23): PickupMerchantItem (0x005853a0, FrameXmlMerchantCursor.ts) replaces the seam's no-op.
  PickupMerchantItem: (seam, args) => {
    frameXmlPickupMerchantItem(seam, args[0]);
    return NOTHING;
  },
  // L1 (3.23): UseContainerItem lets a held merchant row go first (0x005d8650 → 0x00519280); the rest is the seam's.
  UseContainerItem: (seam, args) => {
    if (seam.cursor?.held()?.kind === "merchant") seam.cursor.clearOwn();
    seam.useContainerItem(slotArg(args[0]), slotArg(args[1]));
    return NOTHING;
  },
  // The C side of SECURE_ACTIONS.action: a press with anything held places it instead of using.
  UseAction: (seam, args) => {
    if (seam.cursor?.occupied() && seam.cursor.placeAction(args[0])) return NOTHING;
    const unit = typeof args[1] === "string" ? args[1].toLowerCase() : "";
    const button = typeof args[2] === "string" ? args[2] : "";
    seam.useAction(slotArg(args[0]), unit || undefined, button || undefined);
    return NOTHING;
  },
  GetActionInfo: (seam, args) => seam.cursor?.actionInfo(args[0]) ?? NOTHING,
  GetCursorInfo: (seam) => seam.cursor?.info() ?? seam.cursorInfo(),
  CursorHasItem: (seam) => [seam.cursor ? seam.cursor.hasItem() : seam.cursorHasItem()],
  CursorHasSpell: (seam) => [seam.cursor?.hasSpell() ?? false],
  CursorHasMacro: (seam) => [seam.cursor ? seam.cursor.hasMacro() : seam.macros?.cursorSlot() !== undefined],
  ClearCursor: (seam) => {
    if (seam.cursor) seam.cursor.clear();
    else seam.clearCursor();
    return NOTHING;
  },
});
