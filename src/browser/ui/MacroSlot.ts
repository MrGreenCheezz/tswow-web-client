/**
 * One account-data macro slot (4 account, 5 character) as this client's macro store keeps it (5.37).
 *
 * The slot is shared with Wow.exe on the same account and character, so it is read in either of two
 * texts and written in Wow.exe's (`MacroCacheText.ts`):
 *  - Wow.exe's macro cache text: its macros appear here, and its ids and icon names ride along, so a
 *    write gives back what Wow.exe wrote for every macro not changed here;
 *  - the JSON this client wrote before 5.37: still read, so no macro made here is lost; the next change
 *    writes it in Wow.exe's text, the only format Wow.exe reads;
 *  - anything else is not this slot's to read: `parseMacroSlot` answers undefined, and the store
 *    (`AccountStore`, keepForeign) never writes over it.
 *
 * Slots and ids. This client keeps a macro in a fixed slot, 1..36 account and 37..54 character, the
 * number its action buttons hold. Wow.exe keeps an id instead: the account set counts from 1, the
 * character set from 0x1000001, and CreateMacro takes one more than the highest id of the set
 * (0x00568020). A Wow.exe macro whose id names a slot of its set takes that slot — an account macro's
 * slot is then the same number Wow.exe's action buttons hold — and the others take the lowest free slots
 * in the text's order (by name). A macro made here is given the id its slot names when that id is free,
 * else one more than the set's highest, as Wow.exe would give it.
 *
 * DOM-free and pure.
 */

import {
  MAX_ACCOUNT_MACROS, isAccountMacro, macroIndexes, parseMacros, validMacroIcon, type Macro,
} from "./MacroModel.js";
import {
  WOW_DEFAULT_MACRO_ICON, parseWowMacroText, serialiseWowMacroText, wowMacroBase, type WowMacro,
} from "./MacroCacheText.js";

/** What Wow.exe's text said of a macro that this client's `Macro` cannot carry. */
export interface WowMacroOrigin {
  readonly id: number;
  /** The icon name exactly as read, so an icon this client cannot show is written back unchanged. */
  readonly icon: string;
}

export interface MacroSlot {
  readonly macros: readonly Macro[];
  /** Wow.exe's id and icon of each macro read from its text, by this client's slot index. */
  readonly origins: Readonly<Record<number, WowMacroOrigin>>;
  /** Wow.exe's macros this client has no slot for (a character set over 18), written back as read. */
  readonly spare: readonly WowMacro[];
}

export function emptyMacroSlot(): MacroSlot {
  return { macros: [], origins: {}, spare: [] };
}

const ICON_PREFIX = "interface\\icons\\";
/** A name Wow.exe can write between the name and the line's end and read back as one token. */
const ICON_NAME = /^[^\s"]+$/;

/** Wow.exe's icon name as this client's texture path; undefined for the question mark or none. */
export function macroIconFromWow(name: string): string | undefined {
  if (name === "" || name.toLowerCase() === WOW_DEFAULT_MACRO_ICON.toLowerCase()) return undefined;
  return validMacroIcon(`Interface\\Icons\\${name}`);
}

/**
 * This client's texture path as Wow.exe's icon name. Wow.exe can keep only a texture under
 * `Interface\Icons\`; anything else, and no icon, is its question mark, the first icon of its list.
 */
export function macroIconToWow(path: string | undefined): string {
  if (path === undefined || !path.toLowerCase().startsWith(ICON_PREFIX)) return WOW_DEFAULT_MACRO_ICON;
  const name = path.slice(ICON_PREFIX.length);
  return ICON_NAME.test(name) ? name : WOW_DEFAULT_MACRO_ICON;
}

/** The slot a Wow.exe id names in its set, if it names one. */
function slotOfId(id: number, characterSet: boolean): number | undefined {
  const slot = characterSet ? id - wowMacroBase(true) + MAX_ACCOUNT_MACROS : id;
  return macroIndexes(!characterSet).includes(slot) ? slot : undefined;
}

function idOfSlot(slot: number, characterSet: boolean): number {
  return characterSet ? wowMacroBase(true) + slot - MAX_ACCOUNT_MACROS : slot;
}

/** The slot's text as this store's value; undefined for text that is neither Wow.exe's nor this client's. */
export function parseMacroSlot(text: string, characterSet: boolean): MacroSlot | undefined {
  if (text.trim() === "") return emptyMacroSlot();
  const json = parseMacros(text);
  if (json !== undefined) return withMacroIds({ macros: json, origins: {}, spare: [] }, characterSet);
  const read = parseWowMacroText(text, characterSet);
  if (read.length === 0) return undefined;
  const free = new Set(macroIndexes(!characterSet));
  const placed = new Map<WowMacro, number>();
  for (const macro of read) {
    const slot = slotOfId(macro.id, characterSet);
    if (slot !== undefined && free.has(slot)) {
      placed.set(macro, slot);
      free.delete(slot);
    }
  }
  const spare: WowMacro[] = [];
  for (const macro of read) {
    if (placed.has(macro)) continue;
    const slot = macroIndexes(!characterSet).find((index) => free.has(index));
    if (slot === undefined) {
      spare.push(macro);
      continue;
    }
    placed.set(macro, slot);
    free.delete(slot);
  }
  const macros: Macro[] = [];
  const origins: Record<number, WowMacroOrigin> = {};
  for (const [macro, index] of placed) {
    const icon = macroIconFromWow(macro.icon);
    macros.push({ index, name: macro.name, body: macro.body, ...(icon === undefined ? {} : { icon }) });
    origins[index] = { id: macro.id, icon: macro.icon };
  }
  macros.sort((left, right) => left.index - right.index);
  return { macros, origins, spare };
}

/**
 * Every macro of the slot with a Wow.exe id: its own when it was read from Wow.exe's text, else the id
 * its slot names when that is free, else one more than the set's highest, as CreateMacro gives one
 * (0x00568020). The id is what an action button holding the macro carries (`MacroButtons.ts`), so it is
 * given when the macro is put, not when the slot is written.
 */
export function withMacroIds(slot: MacroSlot, characterSet: boolean): MacroSlot {
  const used = new Set<number>(slot.spare.map((macro) => macro.id));
  for (const macro of slot.macros) {
    const origin = slot.origins[macro.index];
    if (origin !== undefined) used.add(origin.id);
  }
  let origins: Record<number, WowMacroOrigin> | undefined;
  for (const macro of [...slot.macros].sort((left, right) => left.index - right.index)) {
    if (slot.origins[macro.index] !== undefined) continue;
    const wanted = isAccountMacro(macro.index) === !characterSet ? idOfSlot(macro.index, characterSet) : undefined;
    const id = wanted !== undefined && !used.has(wanted) ? wanted : Math.max(wowMacroBase(characterSet), ...used) + 1;
    used.add(id);
    origins ??= { ...slot.origins };
    origins[macro.index] = { id, icon: macroIconToWow(macro.icon) };
  }
  return origins === undefined ? slot : { ...slot, origins };
}

/** The slot in Wow.exe's text. */
export function serialiseMacroSlot(slot: MacroSlot, characterSet: boolean): string {
  const named = withMacroIds(slot, characterSet);
  const written: WowMacro[] = [...named.spare];
  for (const macro of named.macros) {
    const origin = named.origins[macro.index]!;
    const icon = macroIconFromWow(origin.icon) === macro.icon ? origin.icon : macroIconToWow(macro.icon);
    written.push({ id: origin.id, name: macro.name, icon, body: macro.body });
  }
  return serialiseWowMacroText(written);
}

/** A slot with this macro put in; its Wow.exe origin stays with it, a new macro is given its id. */
export function putSlotMacro(slot: MacroSlot, macro: Macro, characterSet = !isAccountMacro(macro.index)): MacroSlot {
  const rest = slot.macros.filter((entry) => entry.index !== macro.index);
  return withMacroIds({ ...slot, macros: [...rest, macro].sort((left, right) => left.index - right.index) }, characterSet);
}

/** The Wow.exe id of the macro in this client's slot `index`, if the slot holds one. */
export function macroIdInSlot(slot: MacroSlot, index: number): number | undefined {
  return slot.macros.some((macro) => macro.index === index) ? slot.origins[index]?.id : undefined;
}

/** This client's slot of the macro with that Wow.exe id, if the slot holds it. */
export function macroSlotOfId(slot: MacroSlot, id: number): number | undefined {
  return slot.macros.find((macro) => slot.origins[macro.index]?.id === id)?.index;
}

/** A slot without this macro, and without its Wow.exe origin. */
export function removeSlotMacro(slot: MacroSlot, index: number): MacroSlot {
  const origins = { ...slot.origins };
  delete origins[index];
  return { ...slot, macros: slot.macros.filter((entry) => entry.index !== index), origins };
}
