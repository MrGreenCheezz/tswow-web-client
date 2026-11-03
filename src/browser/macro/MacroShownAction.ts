/**
 * 1.14: which spell an action button holding a macro stands for, as Wow.exe works it out (UIMacros.cpp, 0x00565c40 →
 * 0x005650c0, kept on the macro at +0x564). An attack in a macro lights up, an auto shot flashes, and the range and usable
 * checks read that spell (0x005a8c30 → 0x005a89f0).
 *
 * The body's lines are walked for the commands in the client's own list: SLASH_CAST, _CASTRANDOM, _CASTSEQUENCE, _USE,
 * _USERANDOM, _EQUIP and _EQUIP_TO_SLOT, each in all its spellings (0x00565cfa on), and `#show` or `#showtooltip`, which count
 * as a cast. A line with nothing after its command is passed over and the argument «none» ends the walk with nothing: that
 * is how `#showtooltip none` turns a macro's icon off. The first argument found goes through the macro options.
 */

import { evaluateMacroOptions, type MacroContext } from "./MacroOptions.js";

/** The commands' words, lowercase with their slash; `globalString` for SLASH_CAST1… in the page. */
export type MacroShownCommands = ReadonlySet<string>;

const SHOW = /^#show(?:tooltip)?(?:\s|$)/i;
/** `reset=…` before a sequence's first entry. */
const SEQUENCE_RESET = /^reset=\S+\s*/i;
/** A rank in the name: `Огненный шар(Уровень 3)`. */
const RANK = /\s*\([^)]*\)\s*$/;

/** The text after the first command in the body that shows something; undefined when none does. */
export function macroShownArgument(body: string, commands: MacroShownCommands): string | undefined {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    let argument: string | undefined;
    if (SHOW.test(line)) argument = line.replace(SHOW, "");
    else if (line.startsWith("/")) {
      const space = line.search(/\s/);
      if (space > 0 && commands.has(line.slice(0, space).toLowerCase())) argument = line.slice(space);
    }
    const text = argument?.trim();
    if (!text) continue;
    return text.toLowerCase() === "none" ? undefined : text;
  }
  return undefined;
}

/** What the argument names right now: the holding clause, its first entry, without `!` or a rank; undefined for nothing. */
export function macroShownName(argument: string, context: MacroContext): string | undefined {
  const chosen = evaluateMacroOptions(argument, context)?.text.trim();
  if (!chosen) return undefined;
  const first = chosen.replace(SEQUENCE_RESET, "").split(",")[0]!.trim().replace(/^!/, "").replace(RANK, "").trim();
  return first.length > 0 ? first : undefined;
}
