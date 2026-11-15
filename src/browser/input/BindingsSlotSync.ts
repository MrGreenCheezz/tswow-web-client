/**
 * The key bindings in account-data slots 2 (the account's set) and 3 (the character's), in Wow.exe's own
 * bindings cache text (5.37), so a player of both clients keeps one set of keys.
 *
 * The rules, and what each guards:
 *  - both slots are asked for at world entry and nothing is applied or written before both have answered:
 *    the server's answer is the truth, and a change made while it travels (an add-on's SetBinding at load,
 *    a key set by hand) is laid over the answer rather than written over the slot;
 *  - the character's set is in force when its slot holds any text, else the account's (Wow.exe 0x00562d60);
 *    an empty slot is the default bindings, so a slot emptied in Wow.exe empties the keys here;
 *  - the text is read over this client's defaults (`BindingsCacheTable.tablesFromCacheText`) and written as
 *    the server's lines brought to the table, so lines this client does not understand survive a change;
 *  - the JSON envelope this client (and the owner's Unity client) wrote into slot 2 before 5.37 is still read,
 *    and the next change writes the slot in Wow.exe's text, the only text Wow.exe reads;
 *  - a change goes to the slot of the set in force; `SaveBindings` (`BindingSet.ts`) moves it, and saving to
 *    the account's set empties the character's slot, as Wow.exe does (0x0055f3d0 writes slot 3 through
 *    0x0055f3a0, which writes nothing for a set not in force);
 *  - while the stock window shows the set not in force (`LoadBindings`), nothing is written until it saves.
 *
 * World-free: the world, the table and the timers are handed in.
 */

import { ACCOUNT_DATA_WRITE_LIMIT, parseBindingsEnvelope, utf8Length, type BindingRow } from "./BindingsAccount.js";
import {
  chordHolders, copyTables, overlayChords, tablesFromCacheText, cacheTextFromTables, type BindingTablesView,
} from "./BindingsCacheTable.js";
import { parseBindingsCacheText, type BindingsCacheLine } from "./BindingsCacheText.js";
import { ACCOUNT_BINDING_SET, CHARACTER_BINDING_SET, setBindingSetHost, type BindingSetId } from "./BindingSet.js";
import type { AccountTimers, AccountWorld } from "./InputAccount.js";

/** `AccountDataType`: GLOBAL_BINDINGS_CACHE and PER_CHARACTER_BINDINGS_CACHE. */
export const ACCOUNT_BINDINGS_SLOT = 2;
export const CHARACTER_BINDINGS_SLOT = 3;
/** How long a change waits for its neighbours, as the other account stores wait. */
const SAVE_DELAY_MS = 1_500;

/** The binding table's side (`Bindings.ts`). */
export interface BindingsSlotHost {
  tables(): BindingTablesView;
  apply(core: Readonly<Record<string, BindingRow>>, modules: Readonly<Record<string, BindingRow>>): void;
  onChanged(listener: () => void): () => void;
}

export interface BindingsSlotSyncOptions {
  enabled?: () => boolean;
  timers?: AccountTimers;
}

const DEFAULT_TIMERS: AccountTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function slotOf(set: BindingSetId): number {
  return set === CHARACTER_BINDING_SET ? CHARACTER_BINDINGS_SLOT : ACCOUNT_BINDINGS_SLOT;
}

export class BindingsSlotSync {
  readonly #host: BindingsSlotHost;
  readonly #enabled: () => boolean;
  readonly #timers: AccountTimers;
  #world: AccountWorld | undefined;
  readonly #answered = new Set<number>();
  /** Both answers are in and the set in force has been applied. */
  #applied = false;
  /** Each slot's text as the server holds it, read into lines (the JSON envelope reads as no lines). */
  readonly #lines = new Map<number, BindingsCacheLine[]>();
  /** Slot 2's envelope of before 5.37, until the first write replaces it. */
  #legacy: ReturnType<typeof parseBindingsEnvelope>;
  #current: BindingSetId = ACCOUNT_BINDING_SET;
  /** The set the table shows: the one in force, or another the stock window loaded. */
  #viewing: BindingSetId = ACCOUNT_BINDING_SET;
  /** Chords moved before the answers were in, and where to: laid over the answer. */
  readonly #early = new Map<string, string | undefined>();
  #holders: Map<string, string>;
  #applying = false;
  #timer: unknown;

  constructor(host: BindingsSlotHost, options: BindingsSlotSyncOptions) {
    this.#host = host;
    this.#enabled = options.enabled ?? (() => true);
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#holders = chordHolders(host.tables());
    host.onChanged(() => this.#changed());
  }

  /** The set in force for this world (the account's until the answers say otherwise). */
  get current(): BindingSetId {
    return this.#current;
  }

  attach(world: AccountWorld): void {
    if (!this.#enabled()) return;
    this.#cancel();
    this.#world = world;
    this.#answered.clear();
    this.#applied = false;
    this.#lines.clear();
    this.#legacy = undefined;
    this.#current = this.#viewing = ACCOUNT_BINDING_SET;
    this.#early.clear();
    this.#holders = chordHolders(this.#host.tables());
    setBindingSetHost({
      current: () => this.#current,
      load: (which) => this.#load(which),
      save: (which) => this.#save(which),
    });
    world.requestAccountData(ACCOUNT_BINDINGS_SLOT);
    world.requestAccountData(CHARACTER_BINDINGS_SLOT);
  }

  /** Sends a pending write now and lets go of the world. */
  detach(): void {
    this.flush();
    this.#world = undefined;
    setBindingSetHost(undefined);
  }

  flush(): void {
    if (this.#timer === undefined) return;
    this.#cancel();
    this.#write(slotOf(this.#current));
  }

  /** `ACCOUNT_DATA_CHANGED`: true when it was one of the two slots (the keys may have changed). */
  accept(type: number): boolean {
    if ((type !== ACCOUNT_BINDINGS_SLOT && type !== CHARACTER_BINDINGS_SLOT) || !this.#world) return false;
    if (this.#applied) return false;
    this.#answered.add(type);
    if (this.#answered.size < 2) return false;
    this.#takeAnswers(this.#world);
    return true;
  }

  #text(world: AccountWorld, slot: number): string {
    return world.accountData.get(slot)?.text ?? "";
  }

  #takeAnswers(world: AccountWorld): void {
    const account = this.#text(world, ACCOUNT_BINDINGS_SLOT);
    const character = this.#text(world, CHARACTER_BINDINGS_SLOT);
    this.#legacy = account === "" ? undefined : parseBindingsEnvelope(account);
    this.#lines.set(ACCOUNT_BINDINGS_SLOT, this.#legacy ? [] : parseBindingsCacheText(account));
    this.#lines.set(CHARACTER_BINDINGS_SLOT, parseBindingsCacheText(character));
    // 0x00562d60: the character's set when its slot held anything.
    this.#current = this.#viewing = character === "" ? ACCOUNT_BINDING_SET : CHARACTER_BINDING_SET;
    this.#applied = true;
    this.#show(this.#current, this.#early);
    const early = this.#early.size > 0;
    this.#early.clear();
    // A change made before the answers is the player's newest; it is written once they are in.
    if (early) this.#schedule();
  }

  /** The set's saved keys into the table (the account's when the character's slot is empty), `over` laid on. */
  #show(set: BindingSetId, over: ReadonlyMap<string, string | undefined>): void {
    const character = this.#lines.get(CHARACTER_BINDINGS_SLOT) ?? [];
    const useCharacter = set === CHARACTER_BINDING_SET && character.length > 0;
    let tables;
    if (!useCharacter && this.#legacy) {
      // The envelope goes through the table's own reader (rows it does not know are ignored there).
      this.#applyTables(this.#legacy.core, this.#legacy.modules);
      tables = copyTables(this.#host.tables());
    } else {
      tables = tablesFromCacheText(useCharacter ? character : this.#lines.get(ACCOUNT_BINDINGS_SLOT) ?? []).tables;
    }
    overlayChords(tables, over);
    this.#applyTables(tables.core, tables.modules);
  }

  #applyTables(core: Readonly<Record<string, BindingRow>>, modules: Readonly<Record<string, BindingRow>>): void {
    this.#applying = true;
    try {
      this.#host.apply(core, modules);
    } finally {
      this.#applying = false;
    }
    this.#holders = chordHolders(this.#host.tables());
  }

  #changed(): void {
    if (this.#applying) return;
    const next = chordHolders(this.#host.tables());
    if (this.#world && !this.#applied) {
      for (const chord of new Set([...this.#holders.keys(), ...next.keys()])) {
        if (this.#holders.get(chord) !== next.get(chord)) this.#early.set(chord, next.get(chord));
      }
    }
    this.#holders = next;
    this.#schedule();
  }

  #schedule(): void {
    if (!this.#world || !this.#applied || this.#viewing !== this.#current) return;
    this.#cancel();
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      this.#write(slotOf(this.#current));
    }, SAVE_DELAY_MS);
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  /** The table as the slot's text, over the slot's own lines (the account's when the character's had none). */
  #write(slot: number): void {
    const world = this.#world;
    if (!world || !this.#applied) return;
    const own = this.#lines.get(slot) ?? [];
    const base = slot === CHARACTER_BINDINGS_SLOT && own.length === 0 ? this.#lines.get(ACCOUNT_BINDINGS_SLOT) ?? [] : own;
    // Review 15.11: what is reserved comes from the lines being written, not from the set the window showed last.
    const text = cacheTextFromTables(base, this.#host.tables(), tablesFromCacheText(base).reserved);
    if (utf8Length(text) > ACCOUNT_DATA_WRITE_LIMIT) return;
    if (text === this.#text(world, slot) && !(slot === ACCOUNT_BINDINGS_SLOT && this.#legacy)) return;
    this.#lines.set(slot, parseBindingsCacheText(text));
    if (slot === ACCOUNT_BINDINGS_SLOT) this.#legacy = undefined;
    void world.saveAccountData(slot, text).catch(() => {
      // A refused save costs the round trip: the table and its mirror still have the keys.
    });
  }

  /** `LoadBindings(which)`: the stock window's view of a set; the set in force is only marked shown again. */
  #load(which: BindingSetId): void {
    if (!this.#applied) return;
    if (which === this.#current) {
      this.#viewing = which;
      return;
    }
    this.#cancel();
    this.#viewing = which;
    this.#show(which, new Map());
  }

  /** `SaveBindings(which)`: the table goes to that set's slot, and the account's empties the character's. */
  #save(which: BindingSetId): void {
    if (!this.#applied || !this.#world) return;
    this.#cancel();
    const characterHad = this.#text(this.#world, CHARACTER_BINDINGS_SLOT) !== "";
    this.#current = this.#viewing = which;
    this.#write(slotOf(which));
    if (which === ACCOUNT_BINDING_SET && characterHad) {
      this.#lines.set(CHARACTER_BINDINGS_SLOT, []);
      void this.#world.saveAccountData(CHARACTER_BINDINGS_SLOT, "").catch(() => {});
    }
  }
}
