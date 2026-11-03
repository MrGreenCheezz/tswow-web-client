/**
 * 1.14: the slash commands a macro's shown spell is looked for after, all their spellings from the client's strings
 * (Wow.exe 0x00565cfa on reads SLASH_CAST1… the same way).
 */

import { globalString } from "../../generated/globalStrings.js";
import type { MacroShownCommands } from "../macro/MacroShownAction.js";

const COMMANDS = ["CAST", "CASTRANDOM", "CASTSEQUENCE", "USE", "USERANDOM", "EQUIP", "EQUIP_TO_SLOT"];
/** No command in the client's strings has more spellings than this. */
const MAX_SPELLINGS = 4;
/** The English ones every locale keeps; a checkout whose strings have not been generated still reads these. */
const ENGLISH = ["/cast", "/spell", "/castrandom", "/castsequence", "/use", "/userandom", "/equip", "/eq", "/equipslot"];

let words: Set<string> | undefined;

export function macroShownCommands(): MacroShownCommands {
  if (words) return words;
  const found = new Set<string>(ENGLISH);
  for (const command of COMMANDS) {
    for (let index = 1; index <= MAX_SPELLINGS; index++) {
      const word = globalString(`SLASH_${command}${index}`);
      if (word) found.add(word.toLowerCase());
    }
  }
  words = found;
  return found;
}
