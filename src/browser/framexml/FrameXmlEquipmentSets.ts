/**
 * The 3.3.5 equipment manager's C API — GearManagerDialog and its save popup (PaperDollFrame.lua
 * :2153-2560), the paper doll's ignore-slot flyout (:2058-2070), EquipmentManager.lua's
 * `EquipmentManager_EquipSet` and StaticPopup's two confirmations — over the equipment-set packets.
 *
 * * A set is what `SMSG_EQUIPMENT_SET_LIST` carries (Player::SendEquipmentSetList): guid, index
 *   0..9 (`MAX_EQUIPMENT_SET_INDEX`), name, icon and nineteen item guids in `PLAYER_FIELD_INV_SLOT_HEAD`
 *   order, a raw 1 where the set leaves the slot alone (its `IgnoreMask`) and 0 for a slot it empties —
 *   Constants.lua's EQUIPMENT_SET_IGNORED_SLOT and EQUIPMENT_SET_EMPTY_SLOT, which
 *   `GetEquipmentSetItemIDs` hands back in the item's place (PaperDollFrame.lua:1120-1123).
 * * `GetEquipmentSetInfo(index)` walks the sets in the client's list order, by name:
 *   name, icon, setID, isEquipped, numItems, numEquipped, numInventory, numMissing, numIgnored — a
 *   piece is equipped in its own slot, in the inventory anywhere else the character has it, or
 *   missing when the guid is nowhere in the player's items.
 * * `GetEquipmentSetLocations(name)` packs where each piece is the way EquipmentManager_UnpackLocation
 *   (EquipmentManager.lua:133-159) reads it: ITEM_INVENTORY_LOCATION_PLAYER + the paper-doll slot for
 *   a worn piece; PLAYER + BAGS with the stock bag id above ITEM_INVENTORY_BAG_BIT_OFFSET and the slot
 *   below it for a carried bag; BANK + the bank button's inventory id (BANK_CONTAINER_INVENTORY_OFFSET +
 *   slot) for the bank; BANK + BAGS with the bag id less ITEM_INVENTORY_BANK_BAG_OFFSET for a bank bag;
 *   -1 for a missing piece, which the unpacker answers with `false, false, false, 0`.
 * * `SaveEquipmentSet(name, icon)` is `CMSG_EQUIPMENT_SET_SAVE` from what is worn: the worn guid per
 *   slot, 1 for a slot ignored through EquipmentManagerIgnoreSlotForSave, 0 for an empty one — the
 *   core checks every guid against the worn item and drops the whole set on a mismatch
 *   (HandleEquipmentSetSave). `icon` is GetEquipmentSetIconInfo's index (:2463-2476): negative for a
 *   worn item's own picture (-invSlot), a macro-icon index otherwise, and past the icon list the
 *   popup's «special icon», the existing set's texture. A set of the same name is overwritten under
 *   its guid and index; a new one takes the lowest free index and gets its guid in
 *   `SMSG_EQUIPMENT_SET_SAVED`.
 * * `UseEquipmentSet(name)` is `CMSG_EQUIPMENT_SET_USE`: nineteen `{guid, bag, slot}` with each
 *   piece's current position. The core finds pieces by guid and reads the position only for its log
 *   (HandleEquipmentSetUse); a raw guid of 1 leaves the slot alone and 0 empties it, so an ignored
 *   piece goes out as 1 and so does a missing one — the set says nothing about what to wear there,
 *   and stripping the slot is not what «equip set» means. `EQUIPMENT_SWAP_FINISHED(success, name)`
 *   follows `SMSG_EQUIPMENT_SET_USE_RESULT` (0 is success; only 4, «inventory full», is ever sent).
 * * `EQUIPMENT_SETS_CHANGED` after the list, a save or a deletion changed what the sets are.
 * * `EquipmentSetContainsLockedItems` is false: this client keeps no lock state for a swap in flight.
 * * `PickupEquipmentSet(index)` lifts the set onto the cursor (FrameXmlCursor.ts, «equipmentset»),
 *   whose drop on a bar is `ACTION_BUTTON_EQUIPMENT_SET` with the set's index.
 *
 * Anything not established — no world, a name no set has — is nil.
 */
import {
  FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET, FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS,
  FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER,
} from "./FrameXmlItemActions.js";

export const FRAMEXML_EQUIPMENT_SET_EVENTS = Object.freeze({
  changed: "EQUIPMENT_SETS_CHANGED",
  swapFinished: "EQUIPMENT_SWAP_FINISHED",
});

/** `EQUIPMENT_SLOT_END`: the nineteen paper-doll slots a set names. */
export const FRAMEXML_EQUIPMENT_SET_SLOTS = 19;
/** `MAX_EQUIPMENT_SET_INDEX` (EquipmentSet.h) and stock MAX_EQUIPMENT_SETS_PER_PLAYER (PaperDollFrame.lua:107). */
export const FRAMEXML_MAX_EQUIPMENT_SETS = 10;
/** Constants.lua:240-241, in the guid's place and in GetEquipmentSetItemIDs/Locations. */
export const FRAMEXML_EQUIPMENT_SET_EMPTY_SLOT = 0;
export const FRAMEXML_EQUIPMENT_SET_IGNORED_SLOT = 1;
/** GetEquipmentSetLocations for a piece the character no longer has (EquipmentManager_UnpackLocation's `location < 0`). */
export const FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION = -1;
/** Constants.lua:191, :224, :229. */
export const FRAMEXML_ITEM_INVENTORY_LOCATION_BANK = 0x00400000;
export const FRAMEXML_ITEM_INVENTORY_BANK_BAG_OFFSET = 4;
export const FRAMEXML_BANK_CONTAINER_INVENTORY_OFFSET = 39;
/** What the native sheet saves under and what a set without a picture shows (GearManagerDialog_Update). */
export const FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";
/** The raw guid the protocol reads as «leave this slot alone» (CharacterProgressProtocol.ts EQUIPMENT_SET_IGNORED). */
const IGNORED_GUID = 1n;

export interface FrameXmlEquipmentSetRow {
  readonly guid: bigint;
  /** The server index 0..9; the action bar's `ACTION_BUTTON_EQUIPMENT_SET` value. */
  readonly setId: number;
  readonly name: string;
  readonly icon: string;
  /** Nineteen guids: 1 ignored, 0 empty. */
  readonly pieces: readonly bigint[];
}

/** Where a piece is now, by the stock addressing: paper-doll ids, stock bag ids, bank button slots. */
export type FrameXmlEquipmentSetPlace =
  | { readonly kind: "worn"; readonly slot: number }
  | { readonly kind: "bag"; readonly bagId: number; readonly slot: number }
  | { readonly kind: "bank"; readonly slot: number }
  | { readonly kind: "bankBag"; readonly bagId: number; readonly slot: number };

export interface FrameXmlEquipmentSetLocated {
  readonly place: FrameXmlEquipmentSetPlace;
  /** The position as CMSG_EQUIPMENT_SET_USE names it (the item opcodes' bag and slot). */
  readonly bag: number;
  readonly slot: number;
}

export interface FrameXmlEquipmentSetUsePiece {
  readonly guid: bigint;
  readonly bag: number;
  readonly slot: number;
}

export interface FrameXmlEquipmentSetHost {
  /** The sets as the list packet left them; undefined without a world. */
  sets(): readonly FrameXmlEquipmentSetRow[] | undefined;
  /** Where the item is now; undefined when the character no longer has it. */
  locate(guid: bigint): FrameXmlEquipmentSetLocated | undefined;
  /** The item's entry (`OBJECT_FIELD_ENTRY`); undefined for an item not in hand. */
  itemId(guid: bigint): number | undefined;
  /** The worn item's guid in a 1-based paper-doll slot; 0n for an empty one. */
  wornGuid(slot: number): bigint;
  /** `GetInventoryItemTexture("player", slot)`. */
  wornTexture(slot: number): string | undefined;
  /** `GetMacroIconInfo(index)` and `GetNumMacroIcons()`. */
  macroIcon(index: number): string | undefined;
  macroIconCount(): number;
  /** `CMSG_EQUIPMENT_SET_SAVE`. */
  save(setGuid: bigint, index: number, name: string, icon: string, pieces: readonly bigint[]): void;
  /** `CMSG_EQUIPMENT_SET_USE`; `finished` answers the use-result packet. */
  use(pieces: readonly FrameXmlEquipmentSetUsePiece[], finished: (success: boolean) => void): void;
  /** `CMSG_DELETEEQUIPMENT_SET`. */
  remove(setGuid: bigint): void;
  /** Changes identity when the world session is replaced: the compare restarts without events. */
  session?(): unknown;
}

interface EquipmentSetPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

const NOTHING: readonly [] = Object.freeze([]);

function slotOf(value: unknown): number | undefined {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= FRAMEXML_EQUIPMENT_SET_SLOTS ? slot : undefined;
}

function nameOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A stored icon as a texture path: the native sheet and the stock client both save the full path. */
export function frameXmlEquipmentSetIcon(icon: string): string {
  if (icon.length === 0) return FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON;
  return icon.includes("\\") || icon.includes("/") ? icon : `Interface\\Icons\\${icon}`;
}

/** The packed location EquipmentManager_UnpackLocation reads (EquipmentManager.lua:133-159). */
export function frameXmlEquipmentSetLocation(place: FrameXmlEquipmentSetPlace): number {
  switch (place.kind) {
    case "worn":
      return FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + place.slot;
    case "bag":
      return FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS
        + (place.bagId << FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET) + place.slot;
    case "bank":
      return FRAMEXML_ITEM_INVENTORY_LOCATION_BANK + FRAMEXML_BANK_CONTAINER_INVENTORY_OFFSET + place.slot;
    case "bankBag":
      return FRAMEXML_ITEM_INVENTORY_LOCATION_BANK + FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS
        + ((place.bagId - FRAMEXML_ITEM_INVENTORY_BANK_BAG_OFFSET) << FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET) + place.slot;
  }
}

interface SetCounts {
  readonly isEquipped: boolean;
  readonly numItems: number;
  readonly numEquipped: number;
  readonly numInventory: number;
  readonly numMissing: number;
  readonly numIgnored: number;
}

/** One owner of the equipment-set C API, the ignore-for-save slots and the two EQUIPMENT_* events. */
export class FrameXmlEquipmentSetModel {
  readonly #host: FrameXmlEquipmentSetHost;
  #pump: EquipmentSetPump | undefined;
  /** The paper-doll slots the next save leaves alone (EquipmentManagerIgnoreSlotForSave). */
  readonly #ignored = new Set<number>();
  /** The sets as last seen, compared (not rebuilt) every tick. */
  #seen: string | undefined;
  #session: unknown;

  constructor(host: FrameXmlEquipmentSetHost) {
    this.#host = host;
  }

  attach(pump: EquipmentSetPump): void {
    this.detach();
    this.#pump = pump;
    // The baseline is the list as it stands now, so a save between attach and the first frame is an edge.
    this.tick();
  }

  detach(): void {
    this.#pump = undefined;
    this.#seen = undefined;
    this.#ignored.clear();
  }

  /** `GetNumEquipmentSets()`. */
  count(): number {
    return this.#rows().length;
  }

  /** The sets in the client's list order: by name, then by index. */
  #rows(): readonly FrameXmlEquipmentSetRow[] {
    return [...(this.#host.sets() ?? [])].sort((left, right) => left.name.localeCompare(right.name) || left.setId - right.setId);
  }

  #row(indexArg: unknown): FrameXmlEquipmentSetRow | undefined {
    const index = Number(indexArg);
    return Number.isInteger(index) && index >= 1 ? this.#rows()[index - 1] : undefined;
  }

  #byName(nameArg: unknown): FrameXmlEquipmentSetRow | undefined {
    const name = nameOf(nameArg);
    return name === undefined ? undefined : this.#rows().find((row) => row.name === name);
  }

  /** The set's server index at a 1-based list position, or by name — what the cursor and a bar slot carry. */
  setIdAt(indexArg: unknown): number | undefined {
    return this.#row(indexArg)?.setId;
  }

  setIdByName(nameArg: unknown): number | undefined {
    return this.#byName(nameArg)?.setId;
  }

  /** The set's picture by server index, for the cursor's hand. */
  iconOf(setId: number): string | undefined {
    const row = (this.#host.sets() ?? []).find((candidate) => candidate.setId === setId);
    return row === undefined ? undefined : frameXmlEquipmentSetIcon(row.icon);
  }

  #counts(row: FrameXmlEquipmentSetRow): SetCounts {
    let numItems = 0;
    let numEquipped = 0;
    let numInventory = 0;
    let numMissing = 0;
    let numIgnored = 0;
    for (let slot = 0; slot < FRAMEXML_EQUIPMENT_SET_SLOTS; slot++) {
      const guid = row.pieces[slot] ?? 0n;
      if (guid === IGNORED_GUID) { numIgnored += 1; continue; }
      if (guid === 0n) continue;
      numItems += 1;
      const located = this.#host.locate(guid);
      if (!located) numMissing += 1;
      else if (located.place.kind === "worn" && located.place.slot === slot + 1) numEquipped += 1;
      else numInventory += 1;
    }
    return { isEquipped: numItems > 0 && numEquipped === numItems, numItems, numEquipped, numInventory, numMissing, numIgnored };
  }

  #infoOf(row: FrameXmlEquipmentSetRow): readonly unknown[] {
    const counts = this.#counts(row);
    return [frameXmlEquipmentSetIcon(row.icon), row.setId, counts.isEquipped, counts.numItems,
      counts.numEquipped, counts.numInventory, counts.numMissing, counts.numIgnored];
  }

  /** `GetEquipmentSetInfo(index)`: name, icon, setID, isEquipped, numItems, numEquipped, numInventory, numMissing, numIgnored. */
  info(indexArg: unknown): readonly unknown[] {
    const row = this.#row(indexArg);
    return row === undefined ? NOTHING : [row.name, ...this.#infoOf(row)];
  }

  /** `GetEquipmentSetInfoByName(name)`: the same without the name; nothing for an unknown name. */
  infoByName(nameArg: unknown): readonly unknown[] {
    const row = this.#byName(nameArg);
    return row === undefined ? NOTHING : this.#infoOf(row);
  }

  /** `GetEquipmentSetItemIDs(name)`: nineteen entries — the item id, 0 empty, 1 ignored; 0 for a piece not in hand. */
  itemIds(nameArg: unknown): readonly number[] | undefined {
    const row = this.#byName(nameArg);
    if (!row) return undefined;
    return Array.from({ length: FRAMEXML_EQUIPMENT_SET_SLOTS }, (_, slot) => {
      const guid = row.pieces[slot] ?? 0n;
      if (guid === IGNORED_GUID) return FRAMEXML_EQUIPMENT_SET_IGNORED_SLOT;
      if (guid === 0n) return FRAMEXML_EQUIPMENT_SET_EMPTY_SLOT;
      return this.#host.itemId(guid) ?? FRAMEXML_EQUIPMENT_SET_EMPTY_SLOT;
    });
  }

  /** `GetEquipmentSetLocations(name)`: nineteen packed locations, 0 empty, 1 ignored, -1 missing. */
  locations(nameArg: unknown): readonly number[] | undefined {
    const row = this.#byName(nameArg);
    if (!row) return undefined;
    return Array.from({ length: FRAMEXML_EQUIPMENT_SET_SLOTS }, (_, slot) => {
      const guid = row.pieces[slot] ?? 0n;
      if (guid === IGNORED_GUID) return FRAMEXML_EQUIPMENT_SET_IGNORED_SLOT;
      if (guid === 0n) return FRAMEXML_EQUIPMENT_SET_EMPTY_SLOT;
      const located = this.#host.locate(guid);
      return located ? frameXmlEquipmentSetLocation(located.place) : FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION;
    });
  }

  /** GetEquipmentSetIconInfo's index (PaperDollFrame.lua:2463-2476) as a texture path; a path is taken as is. */
  #icon(iconArg: unknown, existing: FrameXmlEquipmentSetRow | undefined): string {
    if (typeof iconArg === "string" && iconArg.length > 0) return frameXmlEquipmentSetIcon(iconArg);
    const index = Math.trunc(Number(iconArg));
    if (Number.isInteger(index)) {
      if (index < 0) {
        const worn = this.#host.wornTexture(-index);
        if (worn) return worn;
      } else if (index >= 1 && index <= this.#host.macroIconCount()) {
        const icon = this.#host.macroIcon(index);
        if (icon) return icon;
      }
    }
    // Past both lists the popup shows the selected set's own texture (`_specialIcon`, :2411-2415).
    return existing ? frameXmlEquipmentSetIcon(existing.icon) : FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON;
  }

  /** `SaveEquipmentSet(name, icon)`: what is worn, with the ignored slots as 1 and the empty ones as 0. */
  save(nameArg: unknown, iconArg: unknown): void {
    const name = nameOf(nameArg);
    if (name === undefined || this.#host.sets() === undefined) return;
    const existing = this.#byName(nameArg);
    const index = existing?.setId ?? this.#freeIndex();
    if (index === undefined) return;
    const pieces = Array.from({ length: FRAMEXML_EQUIPMENT_SET_SLOTS }, (_, slot) =>
      this.#ignored.has(slot + 1) ? IGNORED_GUID : this.#host.wornGuid(slot + 1));
    this.#host.save(existing?.guid ?? 0n, index, name, this.#icon(iconArg, existing), pieces);
  }

  /** `ModifyEquipmentSet(oldName, newName, icon)`: the same guid, index and pieces under another name and picture. */
  modify(oldArg: unknown, newArg: unknown, iconArg: unknown): void {
    const row = this.#byName(oldArg);
    const name = nameOf(newArg);
    if (!row || name === undefined) return;
    const icon = iconArg === undefined || iconArg === null ? frameXmlEquipmentSetIcon(row.icon) : this.#icon(iconArg, row);
    this.#host.save(row.guid, row.setId, name, icon, row.pieces);
  }

  /** `DeleteEquipmentSet(name)`. */
  remove(nameArg: unknown): void {
    const row = this.#byName(nameArg);
    if (row) this.#host.remove(row.guid);
  }

  /** `UseEquipmentSet(name)`: each piece from where it is; ignored and missing ones as 1, empty ones as 0. */
  use(nameArg: unknown): void {
    const row = this.#byName(nameArg);
    if (!row) return;
    const pieces = Array.from({ length: FRAMEXML_EQUIPMENT_SET_SLOTS }, (_, slot): FrameXmlEquipmentSetUsePiece => {
      const guid = row.pieces[slot] ?? 0n;
      if (guid === IGNORED_GUID || guid === 0n) return { guid, bag: 0, slot: 0 };
      const located = this.#host.locate(guid);
      return located ? { guid, bag: located.bag, slot: located.slot } : { guid: IGNORED_GUID, bag: 0, slot: 0 };
    });
    const name = row.name;
    this.#host.use(pieces, (success) => { this.#pump?.fire(FRAMEXML_EQUIPMENT_SET_EVENTS.swapFinished, success, name); });
  }

  /** `EquipmentSetContainsLockedItems(name)`: no lock state is kept for a swap in flight. */
  containsLockedItems(): boolean {
    return false;
  }

  // ---- the slots the next save leaves alone -----------------------------------------------------

  ignoreSlot(slotArg: unknown): void {
    const slot = slotOf(slotArg);
    if (slot !== undefined) this.#ignored.add(slot);
  }

  unignoreSlot(slotArg: unknown): void {
    const slot = slotOf(slotArg);
    if (slot !== undefined) this.#ignored.delete(slot);
  }

  isSlotIgnored(slotArg: unknown): boolean {
    const slot = slotOf(slotArg);
    return slot !== undefined && this.#ignored.has(slot);
  }

  clearIgnoredSlots(): void {
    this.#ignored.clear();
  }

  /** Per-frame: the list's edges (a login list, a save folded in, a deletion) as EQUIPMENT_SETS_CHANGED. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const session = this.#host.session?.();
    const sets = this.#host.sets();
    const seen = sets === undefined ? undefined
      : sets.map((row) => `${row.guid}:${row.setId}:${row.name}:${row.icon}:${row.pieces.join(",")}`).join("|");
    const first = this.#seen === undefined || session !== this.#session;
    this.#session = session;
    const changed = seen !== this.#seen;
    this.#seen = seen;
    // The first look is the baseline (the dialog reads the list when it opens); a list that arrives later is an edge.
    if (first || !changed) return;
    pump.fire(FRAMEXML_EQUIPMENT_SET_EVENTS.changed);
  }

  /** The lowest server index no set holds; undefined at the client's ten. */
  #freeIndex(): number | undefined {
    const taken = new Set((this.#host.sets() ?? []).map((row) => row.setId));
    for (let index = 0; index < FRAMEXML_MAX_EQUIPMENT_SETS; index++) if (!taken.has(index)) return index;
    return undefined;
  }
}

export interface FrameXmlEquipmentSetSeam {
  readonly equipmentSets?: FrameXmlEquipmentSetModel | undefined;
  /** The one cursor (FrameXmlCursor.ts): a lifted set for a bar slot. */
  readonly cursor?: { pickupEquipmentSet(setId: number): void } | undefined;
  /** `CanUseEquipmentSets()`: the stock «Использовать менеджер экипировки» switch (CVar equipmentManager). */
  getCVarBool(name: string): boolean | undefined;
}

export type FrameXmlEquipmentSetBinding = (host: FrameXmlEquipmentSetSeam, args: readonly unknown[]) => readonly unknown[];

const withSets = (answer: (sets: FrameXmlEquipmentSetModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlEquipmentSetBinding =>
  (host, args) => host.equipmentSets ? answer(host.equipmentSets, args) : fallback;

/** A nineteen-entry Lua table (the bridge turns a nested array into one), or nothing for an unknown name. */
const table = (entries: readonly number[] | undefined): readonly unknown[] => (entries === undefined ? NOTHING : [entries]);

/** The flat C API, spread into FRAMEXML_SEAM_BINDINGS; a seam without the model answers as an empty manager. */
export const FRAMEXML_EQUIPMENT_SET_BINDINGS: Readonly<Record<string, FrameXmlEquipmentSetBinding>> = Object.freeze({
  GetNumEquipmentSets: withSets((sets) => [sets.count()], [0]),
  GetEquipmentSetInfo: withSets((sets, args) => sets.info(args[0])),
  GetEquipmentSetInfoByName: withSets((sets, args) => sets.infoByName(args[0])),
  GetEquipmentSetItemIDs: withSets((sets, args) => table(sets.itemIds(args[0]))),
  GetEquipmentSetLocations: withSets((sets, args) => table(sets.locations(args[0]))),
  SaveEquipmentSet: withSets((sets, args) => { sets.save(args[0], args[1]); return NOTHING; }),
  ModifyEquipmentSet: withSets((sets, args) => { sets.modify(args[0], args[1], args[2]); return NOTHING; }),
  DeleteEquipmentSet: withSets((sets, args) => { sets.remove(args[0]); return NOTHING; }),
  UseEquipmentSet: withSets((sets, args) => { sets.use(args[0]); return NOTHING; }),
  EquipmentSetContainsLockedItems: withSets((sets) => [sets.containsLockedItems()], [false]),
  PickupEquipmentSet: (host, args) => {
    const setId = host.equipmentSets?.setIdAt(args[0]);
    if (setId !== undefined) host.cursor?.pickupEquipmentSet(setId);
    return NOTHING;
  },
  PickupEquipmentSetByName: (host, args) => {
    const setId = host.equipmentSets?.setIdByName(args[0]);
    if (setId !== undefined) host.cursor?.pickupEquipmentSet(setId);
    return NOTHING;
  },
  EquipmentManagerIgnoreSlotForSave: withSets((sets, args) => { sets.ignoreSlot(args[0]); return NOTHING; }),
  EquipmentManagerUnignoreSlotForSave: withSets((sets, args) => { sets.unignoreSlot(args[0]); return NOTHING; }),
  EquipmentManagerIsSlotIgnoredForSave: withSets((sets, args) => [sets.isSlotIgnored(args[0])], [false]),
  EquipmentManagerClearIgnoredSlotsForSave: withSets((sets) => { sets.clearIgnoredSlots(); return NOTHING; }),
  CanUseEquipmentSets: (host) => [host.getCVarBool("equipmentManager") === true],
});
