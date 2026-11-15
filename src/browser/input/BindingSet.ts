/**
 * Which of Wow.exe's two saved binding sets is in force (5.37): the account's (1, account-data slot 2) or
 * the character's (2, slot 3). The stock key bindings window reads it (`GetCurrentBindingSet`), switches the
 * set it shows (`LoadBindings`) and chooses where the keys are kept (`SaveBindings`, «Привязки персонажа»).
 *
 * Wow.exe 12340: after both slots have loaded, the character's set is in force when its slot held any text
 * (0x00562d60 tests the set's list, which 0x005641c0 fills from the defaults and the text whenever the slot is
 * not empty), else the account's. `SaveBindings(which)` (0x005640c0) makes `which` the set in force and copies
 * the working bindings into it; `LoadBindings(which)` copies the set into the working bindings, the account's
 * when the character's is empty (0x00562b80).
 *
 * The slot store (`BindingsSlotSync.ts`) registers itself here; without one there is one set, the account's.
 */

/** `ACCOUNT_BINDINGS` and `CHARACTER_BINDINGS` of Blizzard_BindingUI.lua. */
export type BindingSetId = 1 | 2;
export const ACCOUNT_BINDING_SET: BindingSetId = 1;
export const CHARACTER_BINDING_SET: BindingSetId = 2;

export interface BindingSetHost {
  /** The set in force. */
  current(): BindingSetId;
  /** `LoadBindings(which)`: shows that set's saved keys in the table (or, for the set in force, only says so). */
  load(which: BindingSetId): void;
  /** `SaveBindings(which)`: that set is in force from now on and keeps the table's keys. */
  save(which: BindingSetId): void;
}

let host: BindingSetHost | undefined;

/** The store's registration; undefined takes it away. */
export function setBindingSetHost(next: BindingSetHost | undefined): void {
  host = next;
}

export function currentBindingSet(): BindingSetId {
  return host?.current() ?? ACCOUNT_BINDING_SET;
}

/** A Lua `which` as a set, or undefined for anything but 1 and 2. */
export function bindingSetOf(which: unknown): BindingSetId | undefined {
  const value = Number(which);
  return value === 1 || value === 2 ? value : undefined;
}

/** `LoadBindings(1|2)` through the store; false when there is none. */
export function loadBindingSet(which: BindingSetId): boolean {
  if (!host) return false;
  host.load(which);
  return true;
}

/** `SaveBindings(1|2)` through the store; nothing without one. */
export function saveBindingSet(which: BindingSetId): void {
  host?.save(which);
}
