/**
 * Plan item 3.07 over a live WorldClient (the contract and the Wow.exe facts: FrameXmlMultiCast.ts).
 *
 * The lists follow the book: rebuilt when `knownSpells` changes or when a book row's metadata arrives
 * (`tick` compares the book array and the count of resolved rows, no per-frame allocation otherwise),
 * and UPDATE_MULTI_CAST_ACTIONBAR is raised when a list changed or a spell was learned — after the
 * once-per-slot auto-fill (0x005ab9d0). The fill's CVar `autoFilledMultiCastSlots` is read and written
 * through `cvar` when the host gives one, else kept for the session.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { playerInventory } from "../Inventory.js";
import { readField } from "../../world/Fields.js";
import {
  FRAMEXML_MULTI_CAST_FIRST_ACTION, frameXmlMultiCastActionSlot, frameXmlMultiCastLists, frameXmlTotemItemServes,
  type FrameXmlMultiCastModel,
} from "./FrameXmlMultiCast.js";

const MELEE_ATTACK_SPELL = 6603;
const AUTO_FILL_CVAR = "autoFilledMultiCastSlots";
const ACTION_BUTTON_SPELL = 0;

export interface FrameXmlMultiCastLiveDeps {
  readonly world: () => WorldClient | undefined;
  readonly spell: (id: number) => SpellMetadata | undefined;
  readonly castSpell: (id: number) => void;
  /** The client CVar store (GetCVar/SetCVar), when the host has one. */
  readonly cvar?: { get(name: string): string | undefined; set(name: string, value: string): void };
}

export interface FrameXmlMultiCastPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export class FrameXmlMultiCastLive implements FrameXmlMultiCastModel {
  readonly #deps: FrameXmlMultiCastLiveDeps;
  #pump: FrameXmlMultiCastPump | undefined;
  #lists: number[][] = [[], [], [], []];
  #signature = "";
  #book: unknown = undefined;
  #resolved = -1;
  #autoFilled = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: FrameXmlMultiCastLiveDeps) {
    this.#deps = deps;
  }

  attach(pump: FrameXmlMultiCastPump): void {
    this.detach();
    this.#pump = pump;
    this.#book = undefined;
    this.#resolved = -1;
    this.#refresh(false);
    const events = this.#deps.world()?.events;
    if (events) this.#unsubscribe = events.on("SPELL_LEARNED", () => this.#refresh(true));
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
  }

  /** Per frame: only a changed book or newly resolved rows rebuild the lists. */
  tick(): void {
    const book = this.#deps.world()?.knownSpells;
    if (book === undefined) return;
    if (book === this.#book) {
      if (this.#resolved === book.length) return;
      // Rows still missing (one may never come: an id the gateway has no row for): rebuild only when
      // one more resolved, not every frame — a count, no allocation.
      let resolved = 0;
      for (const known of book) if (this.#deps.spell(known.id) !== undefined) resolved += 1;
      if (resolved === this.#resolved) return;
    }
    this.#refresh(false);
  }

  #refresh(learned: boolean): void {
    const book = this.#deps.world()?.knownSpells ?? [];
    let resolved = 0;
    const rows = book.map((known) => {
      const spell = this.#deps.spell(known.id);
      if (spell) resolved += 1;
      return spell;
    });
    this.#book = book;
    this.#resolved = resolved;
    const lists = frameXmlMultiCastLists(rows);
    const signature = lists.map((list) => list.join(",")).join("|");
    const changed = signature !== this.#signature;
    this.#lists = lists;
    this.#signature = signature;
    if ((changed || learned) && this.#pump) {
      this.#autoFill();
      this.#pump.fire("UPDATE_MULTI_CAST_ACTIONBAR");
    }
  }

  /** 0x005ab9d0: each slot once — its first spell onto the empty buttons of the three pages. */
  #autoFill(): void {
    const world = this.#deps.world();
    if (!world) return;
    const stored = this.#deps.cvar?.get(AUTO_FILL_CVAR);
    let bits = stored !== undefined ? (Number(stored) >>> 0) : this.#autoFilled;
    const before = bits;
    for (let index = 0; index < 4; index++) {
      const bit = 1 << index;
      const list = this.#lists[index]!;
      if ((bits & bit) === 0) {
        if (list.length === 0) continue;
        for (let action = FRAMEXML_MULTI_CAST_FIRST_ACTION + index; action <= FRAMEXML_MULTI_CAST_FIRST_ACTION + 11; action += 4) {
          const slot = action - 1;
          if (!world.actionButtons.some((button) => button.slot === slot)) world.setActionButton(slot, list[0]!, ACTION_BUTTON_SPELL);
        }
        bits |= bit;
      } else if (list.length === 0) {
        bits &= ~bit;
      }
    }
    if (bits !== before) {
      this.#autoFilled = bits;
      this.#deps.cvar?.set(AUTO_FILL_CVAR, String(bits));
    }
  }

  totemSpells(slot: number): readonly number[] {
    return this.#lists[(slot - 1) & 3] ?? [];
  }

  setMultiCastSpell(action: number, spellId: number): void {
    const slot = frameXmlMultiCastActionSlot(action);
    const world = this.#deps.world();
    if (slot === 0 || !world) return;
    if (spellId === 0) {
      world.setActionButton(action - 1, 0, ACTION_BUTTON_SPELL);
      return;
    }
    const mask = this.#deps.spell(spellId)?.totemSlotMask ?? 0;
    if ((mask & (1 << (slot - 1))) === 0) return;
    world.setActionButton(action - 1, spellId, ACTION_BUTTON_SPELL);
  }

  hasTotemItem(slot: number): boolean {
    const world = this.#deps.world();
    const state = world?.state;
    if (!world || !state) return false;
    const inventory = playerInventory(state);
    if (!inventory) return false;
    const carried = [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)];
    for (const entry of carried) {
      if (!entry.item) continue;
      const id = readField(entry.item, "OBJECT_FIELD_ENTRY");
      const category = id === undefined ? undefined : world.itemTemplates.get(id)?.totemCategory;
      if (category !== undefined && frameXmlTotemItemServes(category, slot)) return true;
    }
    return false;
  }

  isSpellKnown(spellId: number, pet: boolean): boolean {
    const world = this.#deps.world();
    if (!world) return false;
    if (pet) return world.petSpells?.spells.some((entry) => entry.spellId === spellId) ?? false;
    return world.knownSpells.some((known) => known.id === spellId);
  }

  castSpellById(spellId: number): void {
    if (this.isSpellKnown(spellId, false)) this.#deps.castSpell(spellId);
  }

  isCurrentSpell(spellId: number): boolean {
    const world = this.#deps.world();
    if (!world) return false;
    const self = world.state.selfGuid;
    if (self !== undefined && world.casts.get(self)?.spellId === spellId) return true;
    if (world.autoRepeatSpellId === spellId) return true;
    if (spellId === MELEE_ATTACK_SPELL) return world.attacking === true || world.attackRequested === true;
    return false;
  }
}
