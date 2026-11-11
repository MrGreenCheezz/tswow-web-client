/**
 * 1.14: the slash commands a macro's shown spell or item is looked for after, all their spellings from the client's
 * strings, with the kind Wow.exe's table gives each (0x00565cfa on reads SLASH_CAST1… the same way: CAST and USE 2,
 * CASTRANDOM and USERANDOM 3, CASTSEQUENCE 4, EQUIP 5, EQUIP_TO_SLOT 6).
 */

import { globalString } from "../../generated/globalStrings.js";
import type { MacroShownCommands, MacroShownKind } from "../macro/MacroShownAction.js";

const COMMANDS: readonly (readonly [string, MacroShownKind])[] = [
  ["CAST", "cast"], ["CASTRANDOM", "random"], ["CASTSEQUENCE", "sequence"], ["USE", "cast"], ["USERANDOM", "random"],
  ["EQUIP", "equip"], ["EQUIP_TO_SLOT", "equipslot"],
];
/** No command in the client's strings has more spellings than this. */
const MAX_SPELLINGS = 4;
/** The English ones every locale keeps; a checkout whose strings have not been generated still reads these. */
const ENGLISH: readonly (readonly [string, MacroShownKind])[] = [
  ["/cast", "cast"], ["/spell", "cast"], ["/castrandom", "random"], ["/castsequence", "sequence"], ["/use", "cast"],
  ["/userandom", "random"], ["/equip", "equip"], ["/eq", "equip"], ["/equipslot", "equipslot"],
];

let words: Map<string, MacroShownKind> | undefined;

export function macroShownCommands(): MacroShownCommands {
  if (words) return words;
  const found = new Map<string, MacroShownKind>(ENGLISH);
  for (const [command, kind] of COMMANDS) {
    for (let index = 1; index <= MAX_SPELLINGS; index++) {
      const word = globalString(`SLASH_${command}${index}`);
      if (word && !found.has(word.toLowerCase())) found.set(word.toLowerCase(), kind);
    }
  }
  words = found;
  return found;
}
