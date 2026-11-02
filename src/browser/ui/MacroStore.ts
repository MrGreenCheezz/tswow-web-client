/**
 * The macros themselves, without a window.
 *
 * The two halves are stored in two different account-data slots, shared and per character, which
 * is why there are two stores and one merged list.
 */

import { AccountStore } from "../AccountStore.js";
import { GLOBAL_MACROS_CACHE, PER_CHARACTER_MACROS_CACHE } from "../../world/SessionProtocol.js";
import type { FrameXmlMacroStore } from "../framexml/FrameXmlMacro.js";
import {
  findMacro, isAccountMacro, parseMacros, putMacro, removeMacro, serialiseMacros, type Macro,
} from "./MacroModel.js";

const accountMacros = new AccountStore<Macro[]>({
  slot: GLOBAL_MACROS_CACHE,
  mirrorKey: "webclient.macros.account.v1",
  fallback: () => [],
  parse: parseMacros,
  serialise: serialiseMacros,
});

const characterMacros = new AccountStore<Macro[]>({
  slot: PER_CHARACTER_MACROS_CACHE,
  mirrorKey: "webclient.macros.character.v1",
  fallback: () => [],
  parse: parseMacros,
  serialise: serialiseMacros,
});

export const macroStores = [accountMacros, characterMacros];

/** Every macro this character can see, both halves together. */
export function allMacros(): Macro[] {
  return [...accountMacros.value, ...characterMacros.value].sort((left, right) => left.index - right.index);
}

export function macroAt(index: number): Macro | undefined {
  return findMacro(isAccountMacro(index) ? accountMacros.value : characterMacros.value, index);
}

function storeFor(index: number): AccountStore<Macro[]> {
  return isAccountMacro(index) ? accountMacros : characterMacros;
}

export function saveMacro(macro: Macro): void {
  const store = storeFor(macro.index);
  store.set(putMacro(store.value, macro));
}

export function dropMacro(index: number): void {
  const store = storeFor(index);
  store.set(removeMacro(store.value, index));
}

/**
 * Who hears that the macros changed from somewhere other than their own writes: the server's copy
 * landing, or the other window. The stock MacroFrame's model is one (UPDATE_MACROS).
 */
const macroListeners = new Set<() => void>();

export function macrosChanged(): void {
  for (const listener of [...macroListeners]) {
    try { listener(); } catch (error) { console.error("[macros] listener failed", error); }
  }
}

for (const store of macroStores) store.onLoaded = macrosChanged;

/**
 * The same two stores for the stock macro API (FrameXmlMacro.ts): slots, names, bodies and icons
 * stay in the blobs the macro window has always written.
 */
export const frameXmlMacroStore: FrameXmlMacroStore = {
  list: allMacros,
  put: saveMacro,
  remove: dropMacro,
  subscribe: (listener) => {
    macroListeners.add(listener);
    return () => { macroListeners.delete(listener); };
  },
  flush: () => { for (const store of macroStores) store.flush(); },
};
