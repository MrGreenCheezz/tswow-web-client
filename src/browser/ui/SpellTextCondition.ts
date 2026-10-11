import { spellTextAtoi } from "./SpellTextWowRules.js";
import type { SpellTextPlayer } from "./SpellTextPlayer.js";

/**
 * 12.10: `$?condition[then][else]` as Wow.exe 3.3.5a 12340 reads it (QuestTextParser.cpp, read
 * 2026-10-12).
 *
 * * 0x00577030 finds the brackets with strchr, never counting nesting: the first `[` after the
 *   condition, the first `]` after it; a `?` right after that `]` chains another condition
 *   (`$?a[x]?b[y][z]`), anything else and the else branch is the next `[`…`]` (so `]$[`, which one
 *   SpellDescriptionVariables row writes, still works). A missing bracket and 0x00579ba0 does
 *   nothing: the text after `$?` is printed as it stands.
 * * 0x005797f0 evaluates the condition up to its `[`: `s<id>` (0x007260e0, the player knows the
 *   spell) and `a<id>` (0x007282a0, one of the player's auras is the spell), either case; `!` negates
 *   the next term or `(` group; `&` and `|` short-circuit and take everything after them as their
 *   right-hand side; every other character is skipped — `$?$gte($pl,68)[]…` is simply false. Without
 *   an active player every term is false.
 */

/** Where a condition's brackets are: the branch taken when true, and the final else branch. */
export interface SpellConditionBrackets {
  readonly open: number;
  readonly close: number;
  /** The `?` chain's next condition, right after `]?`. */
  readonly next?: number;
  readonly elseOpen: number;
  readonly elseClose: number;
}

/** 0x00577030. */
export function spellConditionBrackets(text: string, from: number): SpellConditionBrackets | undefined {
  const open = text.indexOf("[", from);
  if (open < 0) return undefined;
  const close = text.indexOf("]", open);
  if (close < 0) return undefined;
  if (text[close + 1] === "?") {
    const chained = spellConditionBrackets(text, close + 2);
    return chained && { open, close, next: close + 2, elseOpen: chained.elseOpen, elseClose: chained.elseClose };
  }
  const elseOpen = text.indexOf("[", close);
  if (elseOpen < 0) return undefined;
  const elseClose = text.indexOf("]", elseOpen);
  return elseClose < 0 ? undefined : { open, close, elseOpen, elseClose };
}

interface Cursor { at: number }

/** 0x005796c0: one `s<id>`/`a<id>` term at the cursor (the letter, then its digits). */
function term(text: string, cursor: Cursor, player: SpellTextPlayer | undefined): boolean {
  const letter = text[cursor.at]!;
  cursor.at++;
  const digits = /^\d*/.exec(text.slice(cursor.at))![0];
  if (digits.length === 0) return false;
  cursor.at += digits.length;
  const id = spellTextAtoi(digits);
  if (!player) return false;
  return letter === "a" || letter === "A" ? player.hasAura?.(id) ?? false : player.knowsSpell?.(id) ?? false;
}

/** 0x00576ff0: past the `)` that closes the group the cursor is in, stopping at `end`. */
function skipGroup(text: string, cursor: Cursor, end: number): void {
  let depth = 1;
  if (cursor.at >= text.length) return;
  while (cursor.at < end) {
    const ch = text[cursor.at];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) { cursor.at++; return; }
    cursor.at++;
    if (cursor.at >= text.length) return;
  }
}

/** 0x005797f0, literally: the cursor moves through the condition and stops at a `)` or at `end`. */
function evaluate(text: string, cursor: Cursor, end: number, player: SpellTextPlayer | undefined): boolean {
  let result = false;
  while (cursor.at < text.length && cursor.at < end) {
    const ch = text[cursor.at]!;
    switch (ch) {
      case "!": {
        cursor.at++;
        while (cursor.at < text.length && cursor.at < end) {
          const next = text[cursor.at]!;
          if ("sSaA".includes(next)) { result = !term(text, cursor, player); break; }
          if (next === "(") {
            // The group is evaluated from its `(` — and on past its `)` to the end of this level.
            result = !evaluate(text, cursor, end, player);
            skipGroup(text, cursor, end);
            break;
          }
          cursor.at++;
        }
        break;
      }
      case "&":
        if (!result) return false;
        cursor.at++;
        result = evaluate(text, cursor, end, player);
        break;
      case "|":
        if (result) return true;
        cursor.at++;
        result = evaluate(text, cursor, end, player);
        break;
      case "(":
        cursor.at++;
        result = evaluate(text, cursor, end, player);
        skipGroup(text, cursor, end);
        break;
      case ")":
        return result;
      case "A": case "S": case "a": case "s":
        result = term(text, cursor, player);
        break;
      default:
        cursor.at++;
    }
  }
  return result;
}

/** Whether the condition from `from` up to `end` (its `[`) holds. */
export function spellConditionHolds(text: string, from: number, end: number, player: SpellTextPlayer | undefined): boolean {
  return evaluate(text, { at: from }, end, player);
}

/**
 * 0x00579ba0's choice: skip the spaces after `$?`, find the brackets, and walk the `?` chain to the
 * branch that is taken. Undefined when a bracket is missing (the caller then prints on from `at`).
 */
export function spellConditionBranch(text: string, from: number, player: SpellTextPlayer | undefined):
  { readonly at: number } | { readonly branch: string; readonly after: number } {
  let at = from;
  while (text[at] === " ") at++;
  if (at >= text.length) return { at };
  const brackets = spellConditionBrackets(text, at);
  if (!brackets) return { at };
  if (spellConditionHolds(text, at, brackets.open, player)) {
    return { branch: text.slice(brackets.open + 1, brackets.close).slice(0, 1023), after: brackets.elseClose + 1 };
  }
  if (brackets.next !== undefined) return spellConditionBranch(text, brackets.next, player);
  return { branch: text.slice(brackets.elseOpen + 1, brackets.elseClose).slice(0, 1023), after: brackets.elseClose + 1 };
}
