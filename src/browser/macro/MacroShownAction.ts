/**
 * 1.14: what an action button holding a macro stands for — a spell or an item — as Wow.exe works it out (UIMacros.cpp;
 * read-only Ghidra, .runtime/re-2026-11-04/m2.txt, .runtime/re-2026-11-11/fxapi/d1.c, d2.c, d3.c, d4.c, d5.c).
 *
 * 0x00565c40 parses the body into entries, kept on the macro at +0x580:
 * - Lines are split at `\n`, each at its first space into a command and the rest. A command in the client's list —
 *   SLASH_CAST and SLASH_USE (kind "cast"), _CASTRANDOM and _USERANDOM ("random"), _CASTSEQUENCE ("sequence"), _EQUIP
 *   ("equip"), _EQUIP_TO_SLOT ("equipslot"), each in all its spellings (0x00565cfa on) — or a `#show…` line ("show")
 *   gives an entry of its rest. `#showtooltip` (`#show` then `tooltip`) also marks the macro (+0x570), and so the
 *   action tooltip is the spell's or the item's rather than the macro's name (0x00630d20).
 * - A command with nothing after it is passed over; the argument «none» ends the walk with nothing.
 * - An entry is dynamic (+0x574) when it is a sequence, starts with `[`, or names a slot (a digit first; for
 *   equipslot after the slot number). The walk stops after a `#show` entry or after the first entry while nothing is
 *   dynamic; once something is, every later command line is an entry too.
 *
 * 0x005650c0 resolves them: the first entry whose options (when it starts with `[`) hold with something left;
 * a random list's first entry; a sequence's entry (0x00564900 asks the stock QueryCastSequence — here its first
 * entry); equipslot without its slot number. Then a name — an item first (0x00709de0: an `item:` link's id, else an
 * item of that name in the item cache, case aside), else, except for the equip commands, a spell (0x00540200) — or
 * slots: one number is an inventory slot 1–23, two are a bag 0–4 and a slot in it. The holding group's target is
 * kept for the range check (+0x578, 0x005a94c0).
 */

import { evaluateMacroOptions, type MacroContext } from "./MacroOptions.js";

/** The kinds of 0x00565c40's command table (types 1 to 6). */
export type MacroShownKind = "show" | "cast" | "random" | "sequence" | "equip" | "equipslot";

/** The command words, lowercase with their slash, and their kinds; `globalString` for SLASH_CAST1… in the page. */
export type MacroShownCommands = ReadonlyMap<string, MacroShownKind>;

export interface MacroShownEntry {
  readonly kind: MacroShownKind;
  readonly text: string;
}

export interface MacroShownParse {
  readonly entries: readonly MacroShownEntry[];
  /** +0x570: a `#showtooltip` line was read. */
  readonly showTooltip: boolean;
}

const SHOW = /^#show/i;
const SHOW_TOOLTIP = /^#showtooltip/i;
/** `reset=…` before a sequence's first entry. */
const SEQUENCE_RESET = /^reset=\S+\s*/i;
/** A rank in the name: `Огненный шар(Уровень 3)`. */
const RANK = /\s*\([^)]*\)\s*$/;
const DIGIT = /^[0-9]/;

function dynamicEntry(kind: MacroShownKind, text: string): boolean {
  if (kind === "sequence" || text.startsWith("[")) return true;
  return DIGIT.test(kind === "equipslot" ? text.replace(/^[0-9]*/, "").replace(/^ */, "") : text);
}

/** 0x00565c40: the body's entries and its #showtooltip mark. */
export function parseMacroShown(body: string, commands: MacroShownCommands): MacroShownParse {
  const entries: MacroShownEntry[] = [];
  let showTooltip = false;
  let dynamic = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const space = line.search(/\s/);
    const word = space < 0 ? line : line.slice(0, space);
    let kind: MacroShownKind | undefined;
    if (line.startsWith("/")) kind = commands.get(word.toLowerCase());
    else if (SHOW.test(line)) {
      kind = "show";
      if (SHOW_TOOLTIP.test(line)) showTooltip = true;
    }
    if (kind === undefined) continue;
    const text = space < 0 ? "" : line.slice(space).trim();
    if (!text) continue;
    if (text.toLowerCase() === "none") break;
    if (dynamicEntry(kind, text)) dynamic = true;
    entries.push({ kind, text });
    if (kind === "show" || !dynamic) break;
  }
  return { entries, showTooltip };
}

/** What 0x005650c0 needs of the world. */
export interface MacroShownHost {
  readonly options: MacroContext;
  /** 0x00709de0: an item by an `item:` link or by its name in the item cache; undefined — none. */
  itemNamed(text: string): number | undefined;
  /** The player's inventory slot 0–38 (equipment, bag slots, then the backpack); undefined — empty. */
  inventoryItem(slot: number): number | undefined;
  /** Slot `slot` (from 0) of the bag worn in bag slot `bag` (0–3); undefined — empty or no such slot. */
  bagItem(bag: number, slot: number): number | undefined;
}

/** What the macro stands for right now. */
export type MacroShown =
  | { readonly item: number; readonly target?: string }
  | { readonly spell: string; readonly target?: string };

/** The equipment and bag slots 0x005650c0 takes a single number from (0–22, PLAYER_FIELD_INV_SLOT_HEAD on). */
const LAST_EQUIPPED_SLOT = 0x16;
/** The backpack's first and last inventory slot (23–38). */
const BACKPACK_FIRST = 0x17;
const BACKPACK_LAST = 0x26;

function slotItem(text: string, host: MacroShownHost): number | undefined {
  const numbers = text.trim().split(/ +/).map((part) => Number.parseInt(part, 10));
  const first = numbers[0] ?? Number.NaN;
  if (numbers.length < 2 || !Number.isFinite(numbers[1]!)) {
    const slot = first - 1;
    return slot >= 0 && slot <= LAST_EQUIPPED_SLOT ? host.inventoryItem(slot) : undefined;
  }
  const bag = first - 1;
  const slot = numbers[1]! - 1;
  if (bag === -1) {
    const at = slot + BACKPACK_FIRST;
    return slot >= 0 && at <= BACKPACK_LAST ? host.inventoryItem(at) : undefined;
  }
  return bag >= 0 && bag < 4 && slot >= 0 ? host.bagItem(bag, slot) : undefined;
}

/** 0x005650c0 over the parsed entries; undefined — the macro stands for nothing. */
export function resolveMacroShown(parse: MacroShownParse, host: MacroShownHost): MacroShown | undefined {
  for (const entry of parse.entries) {
    let text = entry.text;
    let target: string | undefined;
    if (text.startsWith("[")) {
      const chosen = evaluateMacroOptions(text, host.options);
      const clause = chosen?.text.trim();
      if (!clause) continue;
      text = clause;
      target = chosen?.target;
    }
    if (entry.kind === "random") text = text.split(",")[0]!.trim();
    else if (entry.kind === "sequence") text = text.replace(SEQUENCE_RESET, "").split(",")[0]!.trim();
    else if (entry.kind === "equipslot") text = text.replace(/^[0-9]*/, "").replace(/^ */, "");
    const aimed = target === undefined ? {} : { target };
    if (DIGIT.test(text)) {
      const item = slotItem(text, host);
      return item === undefined ? undefined : { item, ...aimed };
    }
    const item = host.itemNamed(text);
    if (item !== undefined) return { item, ...aimed };
    if (entry.kind === "equip" || entry.kind === "equipslot") return undefined;
    const spell = text.replace(/^!/, "").replace(RANK, "").trim();
    return spell ? { spell, ...aimed } : undefined;
  }
  return undefined;
}

/** Both steps, for a macro's body. */
export function macroShown(body: string, commands: MacroShownCommands, host: MacroShownHost): MacroShown | undefined {
  return resolveMacroShown(parseMacroShown(body, commands), host);
}
