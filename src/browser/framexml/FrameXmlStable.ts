/**
 * The stock PetStableFrame's C API (PetStable.lua, PetStable.xml) over this client's stable master:
 * `MSG_LIST_STABLED_PETS` opens and refreshes it, `CMSG_STABLE_PET`, `CMSG_UNSTABLE_PET`,
 * `CMSG_STABLE_SWAP_PET` and `CMSG_BUY_STABLE_SLOT` act, `SMSG_STABLE_RESULT` answers
 * (StableProtocol.ts; WorldClient keeps the list, the master and the last answer).
 *
 * The functions stock calls, and nothing else: PetStable_Update (PetStable.lua:39-219) reads
 * `GetSelectedStablePet`, `GetPetIcon`, `GetStablePetInfo`, `ClickStablePet`, `GetNextStableSlotCost`,
 * `GetNumStableSlots`, `GetNumStablePets`, `GetPetTalentTree`, `UnitCreatureFamily("pet")`,
 * `IsAtStableMaster` and `SetPetStablePaperdoll`; the slot template's OnClick/OnDragStart call
 * `ClickStablePet`/`PickupStablePet` (PetStable.xml:42-54); the frame's OnHide calls `ClosePetStables`
 * (PetStable.xml:399); the purchase popup's OnAccept calls `BuyStableSlot` (StaticPopup.lua:2725-2731).
 * `GetStablePetFoodTypes` and `GetPetFoodTypes` stay unanswered: the diet is `CreatureFamily.PetFoodMask` over `ItemPetFood.dbc`,
 * and this client carries neither table's names — the tooltip's `%s` then reads «nil», never a guess.
 *
 * Settled against the selected TrinityCore (NPCHandler.cpp):
 *
 * * The list carries no slot index (`SendStablePet`, :354-416): the pet that is out (or the lone
 *   unslotted hunter pet) comes first with flag 1, then the stabled pets in slot order with the empty
 *   slots skipped, flag 2. Stock slot `i` (1..4) is therefore the `i`-th stabled pet listed; a pet
 *   in a later physical slot behind an empty one is drawn in the earlier button. The real client
 *   cannot know better from this packet either.
 * * The moves are the client's to choose (`HandleUnstablePet` :541: «client sends this packet instead
 *   of swap when starting from stabled slot»): a stabled pet dropped on the current-pet slot is
 *   `CMSG_UNSTABLE_PET` with its number, whether or not a pet is out; the current pet dropped on an
 *   occupied stabled slot is `CMSG_STABLE_SWAP_PET` with that slot's pet; on an empty one
 *   `CMSG_STABLE_PET`, which names no slot (the server takes the first free one, :462-486). Nothing
 *   moves a pet between two stable slots.
 * * `SMSG_STABLE_RESULT` is one byte (`StableResultCode` :50-58). The two failures whose meaning the
 *   core documents are said in UIErrorsFrame with the client's GlobalStrings — 0x01 «you don't have
 *   enough money» is `ERR_NOT_ENOUGH_MONEY`, 0x0C «unable to control exotic creatures» is
 *   `PETTAME_CANTCONTROLEXOTIC`; 0x06, «used in most fail cases», has no string and keeps the native
 *   wording. The three successes are silent: the refreshed list (WorldClient asks for it again) is
 *   the answer on screen.
 * * `IsAtStableMaster` is false for the player's own guid, which the core accepts in place of a
 *   stable master under `SPELL_AURA_OPEN_STABLE` (`CheckStableMaster`); the purchase row then hides.
 * * There is no close opcode: `ClosePetStables` forgets the master locally, as `closeNpcServices` does.
 *
 * `HasPetUI`'s second value (PetStable.lua:44-45 hides everything for a pet that is not a hunter's)
 * is the pet's `UNIT_PET_FLAG_CAN_BE_ABANDONED` (UNIT_FIELD_BYTES_2 byte 2), which the core sets for
 * hunter pets only (Pet.cpp:270, :858) — {@link frameXmlHunterPet}.
 */
import { readByte } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import {
  MAX_PET_STABLES, STABLED_PET_ACTIVE, STABLED_PET_STABLED, STABLE_ERR_EXOTIC, STABLE_ERR_MONEY,
  STABLE_ERR_STABLE, STABLE_SUCCESS_BUY_SLOT, STABLE_SUCCESS_STABLE, STABLE_SUCCESS_UNSTABLE,
  stableResultText, type StableList, type StabledPet,
} from "../../world/StableProtocol.js";

/** `NUM_PET_STABLE_SLOTS` (PetStable.lua:1), the same four as the core's `MAX_PET_STABLES`. */
export const FRAMEXML_STABLE_SLOTS = MAX_PET_STABLES;

/** The client's own «unknown» icon, shown for a listed pet whose family is not known yet. */
export const FRAMEXML_STABLE_UNKNOWN_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";

/** `UNIT_PET_FLAG_CAN_BE_ABANDONED` (UnitDefines.h:126) in `UNIT_BYTES_2_OFFSET_PET_FLAGS` (= 2). */
const UNIT_PET_FLAG_CAN_BE_ABANDONED = 0x02;

/** HasPetUI's `isHunterPet`: only `HUNTER_PET` gets the abandon flag (Pet.cpp:270, :858). */
export function frameXmlHunterPet(pet: WorldObjectState | undefined): boolean {
  if (!pet) return false;
  return ((readByte(pet, "UNIT_FIELD_BYTES_2", 2) ?? 0) & UNIT_PET_FLAG_CAN_BE_ABANDONED) !== 0;
}

/** The result codes the core documents with a client string (NPCHandler.cpp:50-58 comments). */
export const FRAMEXML_STABLE_RESULT_STRINGS: Readonly<Record<number, string>> = Object.freeze({
  [STABLE_ERR_MONEY]: "ERR_NOT_ENOUGH_MONEY",
  [STABLE_ERR_EXOTIC]: "PETTAME_CANTCONTROLEXOTIC",
});

const STABLE_RESULT_CODES = [
  STABLE_ERR_MONEY, STABLE_ERR_STABLE, STABLE_SUCCESS_STABLE, STABLE_SUCCESS_UNSTABLE, STABLE_SUCCESS_BUY_SLOT,
  STABLE_ERR_EXOTIC,
] as const;

/** WorldClient keeps only the native wording of an answer; this matches it back to its code. */
function stableResultCode(text: string): number | undefined {
  return STABLE_RESULT_CODES.find((code) => stableResultText(code) === text);
}

interface FrameXmlStableEvents {
  on(event: "STABLE_CHANGED", listener: () => void): () => void;
  on(event: "QUERY_CACHE_CHANGED", listener: () => void): () => void;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlStableWorld {
  readonly stable: StableList | undefined;
  /** The master being talked to; 0 once the service is closed. */
  stableMasterGuid: bigint;
  readonly stableMessage?: { readonly text: string; readonly error: boolean } | undefined;
  readonly state?: { readonly selfGuid?: bigint | undefined } | undefined;
  readonly events?: FrameXmlStableEvents | undefined;
  stablePet(): void;
  unstablePet(petNumber: number): void;
  swapStabledPet(petNumber: number): void;
  buyStableSlot(): void;
}

/** What the model cannot know from the packets: the pets' families and their DBC facts. */
export interface FrameXmlStableContext {
  world(): FrameXmlStableWorld | undefined;
  /** `creature_template.family` of an entry; undefined until known. */
  creatureFamily(entry: number): number | undefined;
  /** `CreatureFamily.IconFile`, as a texture the renderer can load. */
  familyIcon(family: number): string | undefined;
  /** `CreatureFamily.Name_lang`. */
  familyName(family: number): string | undefined;
  /** The pet talent tree (`TalentTab.Name_lang`) the family's `PetTalentType` opens. */
  talentTree(family: number): string | undefined;
  /** The summoned pet's creature entry, for GetPetIcon/GetPetTalentTree. */
  petEntry?(): number | undefined;
  /** `StableSlotPrices.dbc` row `slotsOwned + 1` in copper; undefined until loaded. */
  stableSlotPrice?(slotsOwned: number): number | undefined;
}

interface FrameXmlStablePump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** One pet's DBC facts, answered by a probe instead of the context. */
export interface FrameXmlStableProbeFamily {
  readonly icon: string;
  readonly family: string;
  readonly talent: string;
}

/** What the owner's gate shows: a stable list and its pets' facts. Never sent anywhere. */
export interface FrameXmlStableProbe {
  readonly list: StableList;
  readonly pets: ReadonlyMap<number, FrameXmlStableProbeFamily>;
  readonly slotPrice?: number | undefined;
}

/** `GetStablePetInfo`'s five values. */
export type FrameXmlStablePetInfo = readonly [icon: string, name: string, level: number,
  family: string | undefined, talent: string | undefined];

/** The listed pet stock slot `slot` shows: 0 the active one, 1..4 the stabled ones in list order. */
export function frameXmlStableSlotPet(list: StableList | undefined, slot: number): StabledPet | undefined {
  if (!list || !Number.isInteger(slot) || slot < 0 || slot > FRAMEXML_STABLE_SLOTS) return undefined;
  if (slot === 0) return list.pets.find((pet) => pet.flags === STABLED_PET_ACTIVE);
  return list.pets.filter((pet) => pet.flags === STABLED_PET_STABLED)[slot - 1];
}

/** One owner of the stable master's C API and of PetStableFrame's four events. */
export class FrameXmlStableModel {
  readonly #context: FrameXmlStableContext;
  #pump: FrameXmlStablePump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  #probe: FrameXmlStableProbe | undefined;
  #strings: ((name: string) => string | undefined) | undefined;
  /** The master PET_STABLE_SHOW was raised for; 0 once PET_STABLE_CLOSED was. */
  #shown = 0n;
  /** The list stock was last shown; a new one is a fresh roster. */
  #list: StableList | undefined;
  #answered: object | undefined;
  #signature = "";
  /** `GetSelectedStablePet`: -1 until PetStable_Update picks one. */
  #selected = -1;
  /** The slot `PickupStablePet` lifted, until the next `ClickStablePet` drops it. */
  #cursor: number | undefined;

  constructor(context: FrameXmlStableContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlStablePump): void {
    this.detach();
    this.#pump = pump;
    const events = this.#context.world()?.events;
    if (events && typeof events.on === "function") {
      this.#unsubscribe.push(events.on("STABLE_CHANGED", () => this.sync()));
      // A pet's creature template (its family) answered after the list was drawn.
      this.#unsubscribe.push(events.on("QUERY_CACHE_CHANGED", () => { if (this.#shown !== 0n) this.sync(); }));
    }
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
    this.#forget();
  }

  #forget(): void {
    this.#shown = 0n;
    this.#list = undefined;
    this.#signature = "";
    this.#selected = -1;
    this.#cursor = undefined;
  }

  /** Whether stock PetStableFrame is the stable; taking ownership replays an open stable. */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    this.#forget();
    if (owned) this.sync();
  }

  /** The client's GlobalStrings, for the refusals' wording; set by the owner once published. */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#strings = resolve;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer every read from `probe` for the duration of `operation`, muted and with no edge raised. */
  probe<T>(probe: FrameXmlStableProbe, operation: () => T): T {
    const previous = { probe: this.#probe, selected: this.#selected, cursor: this.#cursor };
    this.#probe = probe;
    this.#selected = -1;
    this.#cursor = undefined;
    try { return this.muted(operation); } finally {
      this.#probe = previous.probe;
      this.#selected = previous.selected;
      this.#cursor = previous.cursor;
    }
  }

  /** The list stock may show: the probe's, or the world's while it names the current master. */
  #open(): StableList | undefined {
    if (this.#probe) return this.#probe.list;
    const world = this.#context.world();
    const stable = world?.stable;
    return stable && world.stableMasterGuid !== 0n && world.stableMasterGuid === stable.npcGuid ? stable : undefined;
  }

  /** The list of the stable stock was shown, while it is still the world's. */
  #current(): StableList | undefined {
    const list = this.#open();
    if (!list) return undefined;
    return this.#probe || (this.#shown !== 0n && list.npcGuid === this.#shown) ? list : undefined;
  }

  /**
   * Raise the edge the world moved to: PET_STABLE_SHOW for a new master's list, PET_STABLE_CLOSED
   * once it is gone, PET_STABLE_UPDATE when the open roster (or a pet's family) changed; a refusal
   * that arrived since is said in UIErrorsFrame.
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const world = this.#context.world();
    const list = this.#open();
    if (list && list.npcGuid !== this.#shown) {
      this.#forget();
      this.#shown = list.npcGuid;
      this.#list = list;
      this.#answered = world?.stableMessage;
      this.#signature = this.#rosterSignature();
      pump.fire("PET_STABLE_SHOW");
      return;
    }
    if (!list) {
      if (this.#shown === 0n) return;
      this.#forget();
      pump.fire("PET_STABLE_CLOSED");
      return;
    }
    const message = world?.stableMessage;
    if (message && message !== this.#answered) {
      this.#answered = message;
      if (message.error) this.#say(message.text);
    }
    if (list !== this.#list) {
      // A fresh roster: whatever was lifted refers to the old one.
      this.#list = list;
      this.#cursor = undefined;
    }
    const signature = this.#rosterSignature();
    if (signature !== this.#signature) {
      this.#signature = signature;
      pump.fire("PET_STABLE_UPDATE");
    }
  }

  #say(text: string): void {
    const code = stableResultCode(text);
    const name = code === undefined ? undefined : FRAMEXML_STABLE_RESULT_STRINGS[code];
    this.#pump?.fire("UI_ERROR_MESSAGE", (name !== undefined ? this.#strings?.(name) : undefined) ?? text);
  }

  #rosterSignature(): string {
    const list = this.#current();
    if (!list) return "";
    const slots: unknown[] = [list.stableSlots];
    for (let slot = 0; slot <= FRAMEXML_STABLE_SLOTS; slot += 1) slots.push(this.petInfo(slot) ?? null);
    return JSON.stringify(slots);
  }

  /** Whether stock was shown a stable that is still the world's. */
  get showing(): boolean { return this.#shown !== 0n; }

  /** Whether the model answers the slot count and price: a stable shown by stock, or a probe. */
  get answering(): boolean { return this.#probe !== undefined || this.#shown !== 0n; }

  #facts(entry: number): { icon: string; family: string | undefined; talent: string | undefined } {
    const probed = this.#probe?.pets.get(entry);
    if (probed) return { icon: probed.icon, family: probed.family, talent: probed.talent };
    const family = this.#context.creatureFamily(entry);
    if (family === undefined || family <= 0) return { icon: FRAMEXML_STABLE_UNKNOWN_ICON, family: undefined, talent: undefined };
    return {
      icon: this.#context.familyIcon(family) ?? FRAMEXML_STABLE_UNKNOWN_ICON,
      family: this.#context.familyName(family),
      talent: this.#context.talentTree(family),
    };
  }

  // ---- the C API -----------------------------------------------------------------------------

  /** `GetNumStableSlots()`: the slots bought, 0 with no stable open. */
  numSlots(): number {
    const list = this.#current();
    return list ? Math.min(FRAMEXML_STABLE_SLOTS, Math.max(0, Math.trunc(list.stableSlots))) : 0;
  }

  /** `GetNextStableSlotCost()`: the DBC price of the next slot; undefined when full, closed or not loaded. */
  nextSlotCost(): number | undefined {
    if (!this.#current()) return undefined;
    const owned = this.numSlots();
    if (owned >= FRAMEXML_STABLE_SLOTS) return undefined;
    const price = this.#probe ? this.#probe.slotPrice : this.#context.stableSlotPrice?.(owned);
    return typeof price === "number" && Number.isSafeInteger(price) && price >= 0 ? price : undefined;
  }

  /** `GetNumStablePets()`: the stabled pets listed (the one that is out is slot 0, not counted). */
  numPets(): number {
    return this.#current()?.pets.filter((pet) => pet.flags === STABLED_PET_STABLED).length ?? 0;
  }

  /** `GetStablePetInfo(slot)`: icon, name, level, family, talent tree; undefined for an empty slot. */
  petInfo(slot: number): FrameXmlStablePetInfo | undefined {
    const pet = frameXmlStableSlotPet(this.#current(), slot);
    if (!pet) return undefined;
    const facts = this.#facts(pet.creatureId);
    return [facts.icon, pet.name, pet.level, facts.family, facts.talent];
  }

  /** `GetSelectedStablePet()`. */
  selected(): number {
    return this.#current() ? this.#selected : -1;
  }

  /**
   * `ClickStablePet(slot)`: drop a lifted pet here (the move's packet), else select this slot. True
   * whenever the slot is a real one of an open stable, so the CheckButtons' own toggle is repainted.
   */
  click(slot: number): boolean {
    const list = this.#current();
    if (!list || !Number.isInteger(slot) || slot < 0 || slot > FRAMEXML_STABLE_SLOTS) return false;
    const lifted = this.#cursor;
    this.#cursor = undefined;
    if (lifted !== undefined) {
      this.#move(list, lifted, slot);
      this.#selected = slot;
      return true;
    }
    if (slot > this.numSlots()) return false;
    this.#selected = slot;
    return true;
  }

  /** `PickupStablePet(slot)`: lift a listed pet for the next ClickStablePet. */
  pickup(slot: number): void {
    this.#cursor = frameXmlStableSlotPet(this.#current(), slot) ? slot : undefined;
  }

  /** The slot a pet was lifted from (tests). */
  get lifted(): number | undefined { return this.#cursor; }

  #move(list: StableList, from: number, to: number): void {
    if (from === to || this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (!world || world.stableMasterGuid !== list.npcGuid) return;
    if (from === 0 && to >= 1) {
      if (to > this.numSlots() || !frameXmlStableSlotPet(list, 0)) return;
      const occupant = frameXmlStableSlotPet(list, to);
      if (occupant) world.swapStabledPet(occupant.petNumber);
      else world.stablePet();
      return;
    }
    if (from >= 1 && to === 0) {
      const pet = frameXmlStableSlotPet(list, from);
      if (pet) world.unstablePet(pet.petNumber);
    }
  }

  /** `IsAtStableMaster()`: an NPC's stable, not the player's own under SPELL_AURA_OPEN_STABLE. */
  isAtStableMaster(): boolean {
    const list = this.#current();
    if (!list) return false;
    if (this.#probe) return true;
    const self = this.#context.world()?.state?.selfGuid;
    return self === undefined || list.npcGuid !== self;
  }

  /** `BuyStableSlot()`: only with a known price, as the popup showed one. */
  buySlot(): void {
    if (this.#muted || this.#probe || !this.#current() || this.nextSlotCost() === undefined) return;
    this.#context.world()?.buyStableSlot();
  }

  /** `ClosePetStables()` — the frame's OnHide. No opcode: the world forgets the master. */
  close(): void {
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (world && this.#shown !== 0n && world.stableMasterGuid === this.#shown) world.stableMasterGuid = 0n;
    this.sync();
  }

  /**
   * The creature `SetPetStablePaperdoll` shows: the selected slot's pet, or for slot 0 with nothing
   * listed there the summoned pet.
   */
  paperdollEntry(): number | undefined {
    const list = this.#current();
    if (!list || this.#selected < 0) return undefined;
    const pet = frameXmlStableSlotPet(list, this.#selected);
    if (pet) return pet.creatureId > 0 ? pet.creatureId : undefined;
    return this.#selected === 0 && !this.#probe ? this.#context.petEntry?.() : undefined;
  }

  #petFamily(): number | undefined {
    if (this.#probe) return undefined;
    const entry = this.#context.petEntry?.();
    const family = entry === undefined || entry <= 0 ? undefined : this.#context.creatureFamily(entry);
    return family !== undefined && family > 0 ? family : undefined;
  }

  /** `GetPetIcon()`: the summoned pet's family icon. */
  petIcon(): string | undefined {
    const family = this.#petFamily();
    return family === undefined ? undefined : this.#context.familyIcon(family);
  }

  /** `UnitCreatureFamily("pet")`: the summoned pet's family name. */
  petFamilyName(): string | undefined {
    const family = this.#petFamily();
    return family === undefined ? undefined : this.#context.familyName(family);
  }

  /** `GetPetTalentTree()`: the summoned pet's talent tree name. */
  petTalentTree(): string | undefined {
    const family = this.#petFamily();
    return family === undefined ? undefined : this.#context.talentTree(family);
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlStableHost {
  readonly stable?: FrameXmlStableModel | undefined;
  /** FrameXmlServices' stable answers, used when a seam carries no model. */
  readonly services?: {
    readonly stableSlots: () => number | undefined;
    readonly nextStableSlotCost: () => number | undefined;
  } | undefined;
}

export type FrameXmlStableBinding = (host: FrameXmlStableHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function slotArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.trunc(number) : -1;
}

const withStable = (answer: (stable: FrameXmlStableModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlStableBinding =>
  (host, args) => host.stable ? answer(host.stable, args) : NOTHING;

const optional = (value: unknown): readonly unknown[] => value === undefined ? NOTHING : [value];

/**
 * The flat C API. `GetNumStableSlots`/`GetNextStableSlotCost` are the model's while it answers (a
 * stable stock shows, or the gate's probe) and FrameXmlServices.ts's otherwise — the same world
 * list and DBC price, read before any PET_STABLE_SHOW; both keep the numeric 0 when
 * nothing is open, because PetStable_Update runs on UNIT_PET while hidden and compares them
 * (PetStable.lua:86, :204). `WebClientStablePaperdoll` is SetPetStablePaperdoll's host half
 * (FrameXmlStableOwner.ts).
 */
export const FRAMEXML_STABLE_BINDINGS: Readonly<Record<string, FrameXmlStableBinding>> = Object.freeze({
  GetNumStableSlots: (host) => [
    (host.stable?.answering ? host.stable.numSlots() : host.services?.stableSlots()) ?? 0],
  GetNextStableSlotCost: (host) => [
    (host.stable?.answering ? host.stable.nextSlotCost() : host.services?.nextStableSlotCost()) ?? 0],
  GetNumStablePets: (host) => [host.stable?.numPets() ?? 0],
  GetStablePetInfo: withStable((stable, args) => stable.petInfo(slotArg(args[0])) ?? NOTHING),
  GetSelectedStablePet: (host) => [host.stable?.selected() ?? -1],
  ClickStablePet: withStable((stable, args) => stable.click(slotArg(args[0])) ? [true] : NOTHING),
  PickupStablePet: withStable((stable, args) => { stable.pickup(slotArg(args[0])); return NOTHING; }),
  IsAtStableMaster: withStable((stable) => stable.isAtStableMaster() ? [true] : NOTHING),
  BuyStableSlot: withStable((stable) => { stable.buySlot(); return NOTHING; }),
  ClosePetStables: withStable((stable) => { stable.close(); return NOTHING; }),
  GetPetIcon: withStable((stable) => optional(stable.petIcon())),
  GetPetTalentTree: withStable((stable) => optional(stable.petTalentTree())),
  // Only the pet: every other unit keeps the neutral nil it answered before (FrameXmlNeutralApi.ts).
  UnitCreatureFamily: withStable((stable, args) =>
    typeof args[0] === "string" && args[0].toLowerCase() === "pet" ? optional(stable.petFamilyName()) : NOTHING),
  WebClientStablePaperdoll: withStable((stable) => optional(stable.paperdollEntry())),
});
