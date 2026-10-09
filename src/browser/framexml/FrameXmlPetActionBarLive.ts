import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_REACTION, COMMAND_ABANDON, COMMAND_ATTACK, COMMAND_FOLLOW,
  COMMAND_STAY, REACT_AGGRESSIVE, REACT_DEFENSIVE, REACT_PASSIVE,
  packPetAction, petActionOf, petActionTypeOf, petBarKind, type PetSpellEntry, type PetSpells,
} from "../../world/PetProtocol.js";
import { readField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { spellPowerCost, spellPowerPool } from "../SpellCastGuard.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import {
  FRAMEXML_CREATURE_TYPE_DEMON, FRAMEXML_PET_ACTION_EVENTS, FRAMEXML_PET_ACTION_IDLE_COOLDOWN,
  FRAMEXML_PET_ACTION_SLOTS, FRAMEXML_PET_BOOK_READY_COOLDOWN,
  frameXmlPetActionInfo, frameXmlPetAttackWord, frameXmlPetSpellWord,
  type FrameXmlPetActionBar, type FrameXmlPetActionCooldown, type FrameXmlPetActionInfo,
  type FrameXmlPetBarState, type FrameXmlPetBook, type FrameXmlPetBookSpell, type FrameXmlPetCommand,
} from "./FrameXmlPetActionBar.js";
import { frameXmlHunterPet } from "./FrameXmlStable.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/**
 * The stock pet bar over the live WorldClient: `petSpells` is the bar (its command and react state
 * kept current by WorldClient itself, since the realm answers neither), `petCooldowns` the timers,
 * `petAttackVictim` the attack button's flash.
 *
 * Only a `pet` bar (PetProtocol.ts `petBarKind`) is this bar's: a vehicle's words are slot indices,
 * not states, and a possessed unit's bar belongs to the possess layout; both stay with the native
 * `#pet-bar`, which the world mount hides only for the kind this model owns.
 *
 * The realm's cooldown packets carry a remaining time, not a start: SMSG_SPELL_COOLDOWN at the cast
 * (its duration is the whole cooldown) and SMSG_PET_SPELLS on a new bar (the time left). A timer is
 * therefore stamped when its end first appears or moves, and its sweep runs from that stamp — full
 * for a cast, full-from-now for a bar that arrived mid-cooldown, as the action bar's own fallback.
 */

/** The WorldClient surface this file reads; a structural type so tests can hand in a double. */
export type FrameXmlPetActionBarWorld =
  Pick<WorldClient, "events" | "state" | "petSpells" | "petCooldowns">
  & Partial<Pick<WorldClient, "controlledGuid" | "petAttackVictim" | "usePetSlot" | "commandPet"
    | "setPetReaction" | "togglePetAutocast" | "swapPetActionSlots" | "stopPetAttack" | "castPetSpell"
    | "setPetActionSlot" | "creatureTemplates">>;

export interface FrameXmlPetActionBarLiveContext {
  readonly world: () => FrameXmlPetActionBarWorld | undefined;
  /** `performance.now()` milliseconds: the clock `petCooldowns` is in. */
  readonly monotonic: () => number;
  /** The spell's cached row; a C-API read never fetches. */
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** The seam's unit tokens (target, focus, party1…, mouseover) to a guid. */
  readonly unitGuid: (unit: string) => bigint | undefined;
  /** Fetch spell rows outside a C-API read; `onLoaded` repaints the bar (ui/SpellNames.ts). */
  readonly prefetchSpells?: (ids: readonly number[], onLoaded: () => void) => void;
}

interface CooldownStamp {
  readonly startedAt: number;
  readonly endsAt: number;
}

const REACTIONS: Readonly<Partial<Record<FrameXmlPetCommand, number>>> = Object.freeze({
  passive: REACT_PASSIVE, defensive: REACT_DEFENSIVE, aggressive: REACT_AGGRESSIVE,
});

export class FrameXmlPetActionBarLive implements FrameXmlPetActionBar {
  readonly #context: FrameXmlPetActionBarLiveContext;
  #pump: FrameXmlSeamPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #stamps = new Map<number, CooldownStamp>();
  /** The bar's shape last announced from the poll: kind, pet guid, cached rows, usability. */
  #barSignature = "";
  #usableSignature = "";

  constructor(context: FrameXmlPetActionBarLiveContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlSeamPump): void {
    if (this.#pump) this.detach();
    this.#pump = pump;
    this.#stampCooldowns();
    // PetActionBar_OnLoad reads the bar that is already there; only later edges are announced.
    this.#barSignature = this.#currentBarSignature();
    this.#usableSignature = this.#currentUsableSignature();
    this.#prefetch();
    const world = this.#context.world();
    // Older test doubles carry no bus; the models beside this one stay quiet the same way.
    if (typeof world?.events?.on !== "function") return;
    this.#unsubscribe.push(world.events.on("PET_BAR_CHANGED", () => {
      this.#stampCooldowns();
      this.#barSignature = this.#currentBarSignature();
      this.#prefetch();
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.update);
    }));
    this.#unsubscribe.push(world.events.on("PET_COOLDOWNS_CHANGED", () => {
      this.#stampCooldowns();
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.cooldown);
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.spellCooldown);
    }));
    this.#unsubscribe.push(world.events.on("PET_ATTACK_CHANGED", () => {
      if (this.#bar()) pump.fire(FRAMEXML_PET_ACTION_EVENTS.update);
    }));
  }

  detach(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#pump = undefined;
    this.#stamps.clear();
    this.#barSignature = "";
    this.#usableSignature = "";
  }

  /**
   * The seam's 60 ms poll: the kind can change with no bar packet (a control update starts or ends a
   * possession), a spell row can land from a fetch started elsewhere, and usability follows the
   * pet's power and life, which are update fields with no pet-bar edge. One object read a poll, and
   * none at all while there is no pet bar.
   */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const bar = this.#currentBarSignature();
    const usable = this.#currentUsableSignature();
    if (bar !== this.#barSignature) {
      // PetActionBar_Update re-reads every slot's usability itself; one edge covers both.
      this.#barSignature = bar;
      this.#usableSignature = usable;
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.update);
      return;
    }
    if (usable !== this.#usableSignature) {
      this.#usableSignature = usable;
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.usable);
    }
  }

  hasActionBar(): boolean {
    return this.#bar() !== undefined;
  }

  actionInfo(index: number): FrameXmlPetActionInfo | undefined {
    const bar = this.#bar();
    const word = this.#word(bar, index);
    return bar && word !== undefined ? frameXmlPetActionInfo(word, this.#state(bar), (id) => this.#context.spell(id)) : undefined;
  }

  isAttackAction(index: number): boolean {
    const word = this.#word(this.#bar(), index);
    return word !== undefined && frameXmlPetAttackWord(word);
  }

  slotUsable(index: number): boolean {
    const bar = this.#bar();
    const word = this.#word(bar, index);
    if (!bar || word === undefined) return false;
    return this.#usable(word, this.#petObject(bar));
  }

  cooldown(index: number): FrameXmlPetActionCooldown {
    const word = this.#word(this.#bar(), index);
    const pump = this.#pump;
    if (word === undefined || !pump || !frameXmlPetSpellWord(word)) return FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
    const stamp = this.#stamps.get(petActionOf(word));
    const monotonic = this.#context.monotonic();
    if (!stamp || stamp.endsAt <= monotonic) return FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
    return [pump.now() - (monotonic - stamp.startedAt) / 1000, (stamp.endsAt - stamp.startedAt) / 1000, 1];
  }

  /**
   * 11.02-IF: a word's cooldown and usability on whatever bar is open — the possess page's mirrored
   * slots read a possessed unit's bar (FrameXmlPossess.ts), which `hasActionBar` leaves to them.
   */
  wordCooldown(word: number): FrameXmlPetActionCooldown {
    const pump = this.#pump;
    if (!pump || !frameXmlPetSpellWord(word)) return FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
    const stamp = this.#stamps.get(petActionOf(word));
    const monotonic = this.#context.monotonic();
    if (!stamp || stamp.endsAt <= monotonic) return FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
    return [pump.now() - (monotonic - stamp.startedAt) / 1000, (stamp.endsAt - stamp.startedAt) / 1000, 1];
  }

  /** 11.02-IF: see `wordCooldown`. */
  wordUsable(word: number): boolean {
    const spells = this.#context.world()?.petSpells;
    return spells !== undefined && !spells.closed && this.#usable(word, this.#petObject(spells));
  }

  castAction(index: number, unit?: string): void {
    const world = this.#context.world();
    const bar = this.#bar();
    const word = this.#word(bar, index);
    if (!world || !bar || word === undefined) return;
    // An empty spell slot (action 0) has nothing to send.
    const type = petActionTypeOf(word);
    if (!frameXmlPetSpellWord(word) && type !== ACT_COMMAND && type !== ACT_REACTION) return;
    // COMMAND_ABANDON on a hunter's pet deletes it for good (`RemovePet(PET_SAVE_AS_DELETED)`); the
    // client's way to part with one is PetAbandon behind its confirmation, never a bar press.
    if (type === ACT_COMMAND && petActionOf(word) === COMMAND_ABANDON && frameXmlHunterPet(this.#petObject(bar))) return;
    world.usePetSlot?.(index - 1, this.#target(unit));
  }

  toggleAutocast(index: number): void {
    const world = this.#context.world();
    const word = this.#word(this.#bar(), index);
    if (!world || word === undefined) return;
    const type = petActionTypeOf(word);
    if (type !== ACT_ENABLED && type !== ACT_DISABLED) return;
    world.togglePetAutocast?.(petActionOf(word), type === ACT_DISABLED);
  }

  command(command: FrameXmlPetCommand, unit?: string): void {
    const world = this.#context.world();
    const spells = this.#controllable();
    if (!world || !spells) return;
    switch (command) {
      case "attack": world.commandPet?.(COMMAND_ATTACK, this.#target(unit)); return;
      case "stopattack": world.stopPetAttack?.(); return;
      case "follow": world.commandPet?.(COMMAND_FOLLOW); return;
      case "wait": world.commandPet?.(COMMAND_STAY); return;
      case "dismiss": if (this.canBeDismissed()) world.commandPet?.(COMMAND_ABANDON); return;
      default: {
        const react = REACTIONS[command];
        if (react !== undefined) world.setPetReaction?.(react);
      }
    }
  }

  canBeDismissed(): boolean {
    const spells = this.#controllable();
    const pet = spells ? this.#petObject(spells) : undefined;
    return pet !== undefined && !frameXmlHunterPet(pet);
  }

  moveAction(from: number, to: number): void {
    const world = this.#context.world();
    const bar = this.#bar();
    if (!world || !bar || from === to || this.#word(bar, from) === undefined || this.#word(bar, to) === undefined) return;
    world.swapPetActionSlots?.(from - 1, to - 1);
  }

  spellAt(index: number): number | undefined {
    const word = this.#word(this.#bar(), index);
    return word !== undefined && frameXmlPetSpellWord(word) ? petActionOf(word) : undefined;
  }

  // ---- the pet's spellbook ---------------------------------------------------------------------

  /**
   * The rows are SMSG_PET_SPELLS' spell list in the order the realm sent it — `PetSpellInitialize`
   * walks the pet's spell map and writes each learned spell with its ACT_* state — so a temporary
   * pet, whose packet has none, has no book. The tab is «Демон» for a demon (its creature template's
   * type) and «Питомец» otherwise, including while the template has not been answered yet.
   */
  book(): FrameXmlPetBook | undefined {
    const bar = this.#bar();
    const count = bar?.spells?.length ?? 0;
    if (!bar || count === 0) return undefined;
    const pet = this.#petObject(bar);
    const entry = pet ? readField(pet, "OBJECT_FIELD_ENTRY") : undefined;
    const type = entry === undefined ? undefined : this.#context.world()?.creatureTemplates?.get(entry)?.creatureType;
    return { count, token: type === FRAMEXML_CREATURE_TYPE_DEMON ? "DEMON" : "PET" };
  }

  bookSpell(index: number): FrameXmlPetBookSpell | undefined {
    const entry = this.#bookEntry(index);
    const row = entry ? this.#context.spell(entry.spellId) : undefined;
    if (!entry || !row || row.name.length === 0) return undefined;
    return {
      spellId: entry.spellId, state: entry.active, name: row.name,
      rank: row.rank ? row.rank : undefined, iconPath: row.iconPath ? row.iconPath : undefined,
      passive: row.passive === true,
    };
  }

  bookCooldown(index: number): FrameXmlPetActionCooldown {
    const entry = this.#bookEntry(index);
    const pump = this.#pump;
    const stamp = entry ? this.#stamps.get(entry.spellId) : undefined;
    if (!entry || !pump || !stamp) return FRAMEXML_PET_BOOK_READY_COOLDOWN;
    const monotonic = this.#context.monotonic();
    if (stamp.endsAt <= monotonic) return FRAMEXML_PET_BOOK_READY_COOLDOWN;
    return [pump.now() - (monotonic - stamp.startedAt) / 1000, (stamp.endsAt - stamp.startedAt) / 1000, 1];
  }

  castBookSpell(index: number): void {
    const entry = this.#bookEntry(index);
    // A passive spell is the realm's to refuse; the client does not send it (SpellInfo::IsPassive).
    if (!entry || this.#context.spell(entry.spellId)?.passive === true) return;
    this.#context.world()?.castPetSpell?.(entry.spellId, entry.active);
  }

  toggleBookAutocast(index: number): void {
    const entry = this.#bookEntry(index);
    if (!entry || (entry.active !== ACT_ENABLED && entry.active !== ACT_DISABLED)) return;
    this.#context.world()?.togglePetAutocast?.(entry.spellId, entry.active === ACT_DISABLED);
  }

  /**
   * CMSG_PET_SET_ACTION's one-pair form for a book spell dropped on the bar. A command or reaction
   * slot is not replaced — the core keeps those buttons movable but never removable — and a passive
   * spell has no button; the word carries the spell's book state, as `HandlePetSetAction` stores it.
   */
  placeSpell(index: number, spellId: number): void {
    const world = this.#context.world();
    const bar = this.#bar();
    const word = this.#word(bar, index);
    const entry = bar?.spells?.find((candidate) => candidate.spellId === spellId);
    if (!world || !bar || word === undefined || !entry) return;
    const type = petActionTypeOf(word);
    if (type === ACT_COMMAND || type === ACT_REACTION) return;
    if (this.#context.spell(spellId)?.passive === true) return;
    world.setPetActionSlot?.(index - 1, packPetAction(spellId, entry.active));
  }

  #bookEntry(index: number): PetSpellEntry | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#bar()?.spells?.[index - 1];
  }

  // ---- reads ---------------------------------------------------------------------------------

  /** The bar this model owns: a pet's or a charmed creature's (PetProtocol.ts `petBarKind`). */
  #bar(): PetSpells | undefined {
    const world = this.#context.world();
    const spells = world?.petSpells;
    return world && petBarKind(spells, world.controlledGuid, world.state.selfGuid) === "pet" ? spells : undefined;
  }

  /** A unit the commands can reach: any bar but a vehicle's, whose words are not commands. */
  #controllable(): PetSpells | undefined {
    const world = this.#context.world();
    const spells = world?.petSpells;
    const kind = world ? petBarKind(spells, world.controlledGuid, world.state.selfGuid) : undefined;
    return kind === "pet" || kind === "possess" ? spells : undefined;
  }

  #word(bar: PetSpells | undefined, index: number): number | undefined {
    if (!bar || !Number.isInteger(index) || index < 1 || index > FRAMEXML_PET_ACTION_SLOTS) return undefined;
    return bar.bar?.[index - 1]?.packed;
  }

  #state(bar: PetSpells): FrameXmlPetBarState {
    return {
      commandState: bar.commandState,
      reactState: bar.reactState,
      attacking: this.#context.world()?.petAttackVictim !== undefined,
    };
  }

  #petObject(bar: Pick<PetSpells, "guid">): WorldObjectState | undefined {
    return this.#context.world()?.state.objects.get(bar.guid);
  }

  /**
   * A command or reaction is always pressable. A spell needs a pet in view that is alive and holds
   * the spell's cost in its declared power (SpellCastGuard's own arithmetic over the pet's fields);
   * a cost this host cannot compute is left to the realm, as the player's own bar leaves it.
   */
  #usable(word: number, pet: WorldObjectState | undefined): boolean {
    if (!frameXmlPetSpellWord(word)) return true;
    if (!pet || isWorldObjectDead(pet)) return false;
    const metadata = this.#context.spell(petActionOf(word));
    if (!metadata) return true;
    const cost = spellPowerCost(metadata, pet);
    const pool = spellPowerPool(metadata, pet);
    return cost === undefined || pool === undefined || cost <= pool;
  }

  #target(unit: string | undefined): bigint | undefined {
    return unit === undefined ? undefined : this.#context.unitGuid(unit);
  }

  #currentBarSignature(): string {
    const bar = this.#bar();
    if (!bar) return "";
    let signature = `${bar.guid}`;
    for (const button of bar.bar ?? []) {
      signature += frameXmlPetSpellWord(button.packed) && this.#context.spell(button.action) === undefined ? ":?" : ":";
    }
    // The book's rows too: a row that lands repaints the pet spellbook through the same PET_BAR_UPDATE.
    signature += "|";
    for (const entry of bar.spells ?? []) signature += this.#context.spell(entry.spellId) === undefined ? "?" : ".";
    return signature;
  }

  #currentUsableSignature(): string {
    const bar = this.#bar();
    if (!bar) return "";
    const pet = this.#petObject(bar);
    let signature = "";
    for (const button of bar.bar ?? []) signature += this.#usable(button.packed, pet) ? "1" : "0";
    return signature;
  }

  #stampCooldowns(): void {
    const current = this.#context.world()?.petCooldowns;
    for (const spellId of [...this.#stamps.keys()]) {
      if (!current?.has(spellId)) this.#stamps.delete(spellId);
    }
    // No timers, no clock read: a host (or a focused test double) without a pet has no need of one.
    if (!current || current.size === 0) return;
    const now = this.#context.monotonic();
    for (const [spellId, endsAt] of current) {
      if (this.#stamps.get(spellId)?.endsAt === endsAt) continue;
      this.#stamps.set(spellId, { startedAt: Math.min(now, endsAt), endsAt });
    }
  }

  /** The bar's spell rows, fetched outside a C-API read; their arrival repaints the bar once. */
  #prefetch(): void {
    const bar = this.#bar();
    const prefetch = this.#context.prefetchSpells;
    if (!bar || !prefetch) return;
    const missing = new Set<number>();
    for (const button of bar.bar ?? []) {
      if (frameXmlPetSpellWord(button.packed) && this.#context.spell(button.action) === undefined) missing.add(button.action);
    }
    for (const entry of bar.spells ?? []) {
      if (this.#context.spell(entry.spellId) === undefined) missing.add(entry.spellId);
    }
    if (missing.size === 0) return;
    const pump = this.#pump;
    prefetch([...missing], () => {
      if (this.#pump !== pump || !pump) return;
      this.#barSignature = this.#currentBarSignature();
      pump.fire(FRAMEXML_PET_ACTION_EVENTS.update);
    });
  }
}
