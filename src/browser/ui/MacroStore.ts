/**
 * The macros themselves, without a window.
 *
 * The two halves are stored in two different account-data slots, shared and per character, which
 * is why there are two stores and one merged list.
 *
 * 5.37 (11.11): the slots are Wow.exe's too. Each is read in Wow.exe's macro cache text or in the JSON
 * this client wrote before, and written in Wow.exe's text (`MacroSlot.ts`), so a character played in
 * both clients keeps one set of macros. A slot holding text that is neither is never written over
 * (keepForeign): changes then stay in this browser's mirror.
 */

import { AccountStore, characterMirrorScope } from "../AccountStore.js";
import { GLOBAL_MACROS_CACHE, PER_CHARACTER_MACROS_CACHE } from "../../world/SessionProtocol.js";
import type { FrameXmlMacroStore } from "../framexml/FrameXmlMacro.js";
import { findMacro, isAccountMacro, type Macro } from "./MacroModel.js";
import {
  emptyMacroSlot, macroIdInSlot, macroSlotOfId, parseMacroSlot, putSlotMacro, removeSlotMacro, serialiseMacroSlot,
  type MacroSlot,
} from "./MacroSlot.js";

/**
 * The store of one macro slot: Wow.exe's text or this client's JSON in, Wow.exe's text out.
 *
 * 5.37: the server's answer is the truth (an empty slot is no macros, nothing is written before the
 * answer), and the character slot's mirror is kept per realm and character. The unscoped mirror of
 * before, `webclient.macros.character.v1`, is left where it is and no longer read: it cannot tell whose
 * macros it holds, and the server's copy of each character has them if they were ever saved.
 */
export function createMacroSlotStore(slot: number, mirrorKey: string, characterSet: boolean): AccountStore<MacroSlot> {
  return new AccountStore<MacroSlot>({
    slot,
    mirrorKey,
    fallback: emptyMacroSlot,
    parse: (text) => parseMacroSlot(text, characterSet),
    serialise: (value) => serialiseMacroSlot(value, characterSet),
    keepForeign: true,
    serverIsTruth: true,
    ...(characterSet ? { mirrorScope: characterMirrorScope } : {}),
  });
}

const accountMacros = createMacroSlotStore(GLOBAL_MACROS_CACHE, "webclient.macros.account.v1", false);
const characterMacros = createMacroSlotStore(PER_CHARACTER_MACROS_CACHE, "webclient.macros.character.v1", true);

export const macroStores = [accountMacros, characterMacros];

/** 5.37: the Wow.exe id of the macro in this client's slot `index` (what an action button holds). */
export function macroIdAt(index: number): number | undefined {
  return macroIdInSlot((isAccountMacro(index) ? accountMacros : characterMacros).value, index);
}

/** 5.37: this client's slot of the macro with that Wow.exe id, in either set. */
export function macroIndexOfId(id: number): number | undefined {
  return macroSlotOfId(accountMacros.value, id) ?? macroSlotOfId(characterMacros.value, id);
}

/** 5.37: who hears every change, local or the server's (the action buttons' view, MacroButtons.ts). */
const anyChangeListeners = new Set<() => void>();

export function onAnyMacroChange(listener: () => void): () => void {
  anyChangeListeners.add(listener);
  return () => { anyChangeListeners.delete(listener); };
}

function anyMacroChange(): void {
  for (const listener of [...anyChangeListeners]) {
    try { listener(); } catch (error) { console.error("[macros] listener failed", error); }
  }
}

/** Every macro this character can see, both halves together. */
export function allMacros(): Macro[] {
  return [...accountMacros.value.macros, ...characterMacros.value.macros].sort((left, right) => left.index - right.index);
}

export function macroAt(index: number): Macro | undefined {
  return findMacro((isAccountMacro(index) ? accountMacros : characterMacros).value.macros, index);
}

function storeFor(index: number): AccountStore<MacroSlot> {
  return isAccountMacro(index) ? accountMacros : characterMacros;
}

export function saveMacro(macro: Macro): void {
  const store = storeFor(macro.index);
  store.set(putSlotMacro(store.value, macro, !isAccountMacro(macro.index)));
  anyMacroChange();
}

export function dropMacro(index: number): void {
  const store = storeFor(index);
  store.set(removeSlotMacro(store.value, index));
  anyMacroChange();
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

for (const store of macroStores) {
  store.onLoaded = () => {
    macrosChanged();
    anyMacroChange();
  };
}

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
